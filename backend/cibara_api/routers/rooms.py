"""
/api/v2/rooms — typed, validated facades over the legacy room routes.

Each endpoint validates its input with Pydantic, enforces the permission the
old UI enforced only in the browser, and then runs the UNCHANGED legacy route
in-process (same duplicate-submit guard, same Firestore writes, same GST/bill
code at checkout). Differences from the old browser client, all on the input
side only:

  • price / guests are sent as integers (the old form sent strings; the server
    int()-ed them — same result);
  • `isAC` is forced false outside rooms 200-206 (the old form could leave the
    hidden toggle checked after a reset — contract §4.1);
  • manual refunds are stamped with the IST date/time (the old client sent the
    UTC date, wrong between 00:00 and 05:30 IST);
  • final checkout sends no `room_data` snapshot, so the server reads the live
    room document instead of trusting the browser's copy (both are existing
    code paths in routes/rooms.py; the live read is the authoritative one).
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional, Union

from fastapi import APIRouter, Depends, File, Form, HTTPException, Path, Query, Request, UploadFile
from pydantic import BaseModel, Field, field_validator, model_validator

import threading
import time as _time

from starlette.concurrency import run_in_threadpool

from ..legacy import legacy_config
from ..security.deps import Principal, get_principal, require_permission
from ..settings import get_settings
from ._forward import forward

# Reference-data cache for GET /rooms/tariffs (see Settings.PERF_TARIFFS_CACHE).
_tariffs_cache: dict = {"payload": None, "ts": 0.0}
_tariffs_lock = threading.Lock()


def _clear_tariffs_cache() -> None:
    with _tariffs_lock:
        _tariffs_cache["payload"] = None
        _tariffs_cache["ts"] = 0.0

router = APIRouter(prefix="/api/v2", tags=["rooms"])

def RoomId():
    return Path(pattern=r"^[0-9A-Za-z_-]{1,10}$")


def _is_premium(room: str) -> bool:
    try:
        return 200 <= int(room) <= 206
    except ValueError:
        return False


class GstProfile(BaseModel):
    gstin: str = Field(pattern=r"^[0-9A-Z]{15}$")
    legal_name: str = Field(default="", max_length=200)
    trade_name: str = Field(default="", max_length=200)
    address: str = Field(default="", max_length=500)
    state: str = Field(default="", max_length=60)
    state_code: str = Field(default="", max_length=2)

    @field_validator("gstin", mode="before")
    @classmethod
    def _upper(cls, v):
        return str(v or "").strip().upper()


class CheckinIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    mobile: str = Field(pattern=r"^[0-9]{10}$")
    guests: int = Field(ge=1, le=20)
    price: int = Field(ge=1, le=100_000)
    amount_paid: int = Field(default=0, ge=0, le=1_000_000)
    payment: Literal["cash", "online", "balance"]
    is_ac: bool = False
    checkin_time: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$")
    gst_profile: Optional[GstProfile] = None
    id_type: Optional[str] = Field(default=None, max_length=40)
    id_number: Optional[str] = Field(default=None, max_length=40)
    address: Optional[str] = Field(default=None, max_length=300)
    photo_path: Optional[str] = Field(default=None, max_length=1000)

    @field_validator("name")
    @classmethod
    def _strip(cls, v):
        v = " ".join(v.split())
        if not v:
            raise ValueError("Guest name is required")
        return v

    @model_validator(mode="after")
    def _pay_later(self):
        if self.amount_paid > 0 and self.payment == "balance":
            raise ValueError("Cannot use 'Pay Later' with an amount paid. Please select Cash or Online.")
        return self


class PaymentIn(BaseModel):
    amount: int = Field(gt=0, le=1_000_000)
    mode: Literal["cash", "online"]


class CheckoutIn(BaseModel):
    settle_later: bool = False
    settlement_notes: str = Field(default="", max_length=500)
    refund_method: Optional[Literal["cash", "online"]] = None
    # object → bill to company; "personal" → explicitly personal;
    # null → keep whatever was stamped at check-in (legacy tri-state).
    gst_profile: Union[GstProfile, Literal["personal"], None] = None


class AddonIn(BaseModel):
    item: str = Field(min_length=1, max_length=80)
    unit_price: int = Field(ge=0, le=100_000)
    quantity: int = Field(default=1, ge=1, le=100)
    payment_method: Literal["cash", "online", "balance"] = "balance"
    accommodation_charge: bool = False
    applied_on_day: Optional[int] = Field(default=None, ge=1, le=400)


class RenewIn(BaseModel):
    renewal_count: int = Field(ge=1, le=400, description="Expected new renewal_count (current + 1)")


class DiscountIn(BaseModel):
    amount: int = Field(gt=0, le=1_000_000)
    reason: str = Field(default="Discount", min_length=1, max_length=200)


class HousekeepingIn(BaseModel):
    room_clean: Optional[bool] = None
    bathroom_clean: Optional[bool] = None
    notes: Optional[str] = Field(default=None, max_length=500)
    photos: Optional[dict] = None

    @model_validator(mode="after")
    def _one(self):
        if self.room_clean is None and self.bathroom_clean is None:
            raise ValueError("At least one of room_clean or bathroom_clean is required")
        return self


class CleanedIn(BaseModel):
    notes: Optional[str] = Field(default=None, max_length=500)
    photos: Optional[dict] = None


class ReadyIn(BaseModel):
    checklist: dict[str, bool] = Field(default_factory=dict)
    checklist_skipped: bool = False
    notes: Optional[str] = Field(default=None, max_length=500)
    photos: Optional[dict] = None


class TransferIn(BaseModel):
    new_room: str = Field(pattern=r"^[0-9A-Za-z_-]{1,10}$")
    new_price: Optional[int] = Field(default=None, ge=1, le=100_000)
    is_ac: Optional[bool] = None
    apply_today_diff: bool = True


def _drop_none(d: dict) -> dict:
    return {k: v for k, v in d.items() if v is not None}


# ── reads ─────────────────────────────────────────────────────────────────

@router.get("/rooms/numbers")
async def room_numbers(request: Request, p: Principal = Depends(get_principal)):
    return await forward(p, request, "GET", "/get_room_numbers")


def _default_guests(room: str) -> int:
    """Port of the check-in form default (static/script.js:5377-5391)."""
    try:
        n = int(room)
    except ValueError:
        return 1
    return 2 if (200 <= n <= 211 or n == 215 or 223 <= n <= 227 or 23 <= n <= 27) else 1


@router.get("/rooms/tariffs")
async def tariffs(p: Principal = Depends(get_principal)):
    """Standard nightly rates from config.room_base_price (the server's own
    tariff table), so the SPA never re-implements pricing. Check-in still
    accepts an operator-edited price, exactly as before."""
    def build():
        out = {}
        for rid in legacy_config.get_all_rooms().keys():
            out[rid] = {
                "category": legacy_config.room_category(rid),
                "default_guests": _default_guests(rid),
                "prices": {str(g): legacy_config.room_base_price(rid, g) for g in range(1, 7)},
                "ac_surcharge": legacy_config.AC_SURCHARGE if _is_premium(rid) else 0,
            }
        return out

    s = get_settings()
    if s.PERF_TARIFFS_CACHE:
        now = _time.monotonic()
        with _tariffs_lock:
            cached = _tariffs_cache["payload"]
            if cached is not None and (now - _tariffs_cache["ts"]) < s.PERF_TARIFFS_CACHE_TTL:
                return {"success": True, "tariffs": cached}
        payload = await run_in_threadpool(build)
        with _tariffs_lock:
            _tariffs_cache["payload"] = payload
            _tariffs_cache["ts"] = now
        return {"success": True, "tariffs": payload}

    return {"success": True, "tariffs": await run_in_threadpool(build)}


@router.get("/rooms/{room}/history")
async def stay_history(request: Request, room: str = RoomId(),
                       name: str = Query(min_length=1, max_length=120),
                       checkin_time: Optional[str] = Query(default=None, max_length=19),
                       stay_id: Optional[str] = Query(default=None, max_length=64),
                       p: Principal = Depends(require_permission("room.checkout"))):
    return await forward(p, request, "POST", "/get_history",
                         json={"room": room, "name": name, "checkin_time": checkin_time, "stay_id": stay_id})


@router.get("/rooms/{room}/payments")
async def stay_payments(request: Request, room: str = RoomId(),
                        stay_id: str = Query(min_length=1, max_length=64),
                        p: Principal = Depends(require_permission("payment.edit"))):
    return await forward(p, request, "POST", "/get_stay_payments", json={"stay_id": stay_id, "room": room})


@router.get("/customers/lookup")
async def customer_lookup(request: Request, mobile: str = Query(pattern=r"^[0-9]{10}$"),
                          p: Principal = Depends(require_permission("room.checkin"))):
    return await forward(p, request, "GET", f"/get_customer/{mobile}")


@router.get("/customers/suggest")
async def customer_suggest(request: Request, prefix: str = Query(pattern=r"^[0-9]{4,10}$"),
                           p: Principal = Depends(require_permission("room.checkin"))):
    return await forward(p, request, "POST", "/search_customers_mobile", json={"prefix": prefix})


@router.get("/bookings/availability")
async def availability(request: Request,
                       check_in_date: str = Query(pattern=r"^\d{4}-\d{2}-\d{2}$"),
                       check_out_date: str = Query(pattern=r"^\d{4}-\d{2}-\d{2}$"),
                       p: Principal = Depends(require_permission("booking.create"))):
    return await forward(p, request, "POST", "/check_availability",
                         json={"check_in_date": check_in_date, "check_out_date": check_out_date})


# ── writes ────────────────────────────────────────────────────────────────

@router.post("/rooms/{room}/checkin")
async def checkin(body: CheckinIn, request: Request, room: str = RoomId(),
                  p: Principal = Depends(require_permission("room.checkin"))):
    payload = {
        "room": room, "name": body.name, "mobile": body.mobile, "guests": body.guests,
        "price": body.price, "amountPaid": body.amount_paid, "payment": body.payment,
        "isAC": bool(body.is_ac and _is_premium(room)),
        "checkin_time": body.checkin_time,
        "gst_profile": body.gst_profile.model_dump() if body.gst_profile else None,
        "address": body.address or "", "id_type": body.id_type, "id_number": body.id_number,
        "photo_path": body.photo_path,
    }
    return await forward(p, request, "POST", "/checkin", json=_drop_none(payload) | {"gst_profile": payload["gst_profile"]})


@router.post("/rooms/{room}/payment")
async def add_payment(body: PaymentIn, request: Request, room: str = RoomId(),
                      p: Principal = Depends(require_permission("room.checkout"))):
    return await forward(p, request, "POST", "/checkout",
                         json={"room": room, "payment_mode": body.mode, "amount": body.amount, "is_refund": False})


@router.post("/rooms/{room}/refund")
async def refund(body: PaymentIn, request: Request, room: str = RoomId(),
                 p: Principal = Depends(require_permission("room.checkout"))):
    now = datetime.now(legacy_config.IST)
    return await forward(p, request, "POST", "/checkout", json={
        "room": room, "payment_mode": body.mode, "amount": body.amount,
        "is_refund": True, "process_refund": True,
        "date": now.strftime("%Y-%m-%d"), "time": now.strftime("%H:%M"),
    })


@router.post("/rooms/{room}/checkout")
async def checkout(body: CheckoutIn, request: Request, room: str = RoomId(),
                   p: Principal = Depends(require_permission("room.checkout"))):
    gst = body.gst_profile.model_dump() if isinstance(body.gst_profile, GstProfile) else body.gst_profile
    payload = {"room": room, "final_checkout": True, "settle_later": body.settle_later,
               "settlement_notes": body.settlement_notes, "refund_method": body.refund_method,
               "gst_profile": gst}
    # settle_later additionally needs settle_later.use — enforced by the
    # legacy hardening hook on /checkout (security/legacy_hardening.py).
    return await forward(p, request, "POST", "/checkout", json=payload)


@router.post("/rooms/{room}/addons")
async def add_on(body: AddonIn, request: Request, room: str = RoomId(),
                 p: Principal = Depends(require_permission("room.update"))):
    payload = {"room": room, "item": body.item, "price": body.unit_price * body.quantity,
               "unit_price": body.unit_price, "quantity": body.quantity,
               "payment_method": body.payment_method, "accommodation_charge": body.accommodation_charge}
    if body.applied_on_day is not None:
        payload["applied_on_day"] = body.applied_on_day
    return await forward(p, request, "POST", "/add_on", json=payload)


@router.post("/rooms/{room}/renew")
async def renew(body: RenewIn, request: Request, room: str = RoomId(),
                p: Principal = Depends(require_permission("room.update"))):
    return await forward(p, request, "POST", "/renew_rent", json={"room": room, "renewal_count": body.renewal_count})


@router.post("/rooms/{room}/discount")
async def discount(body: DiscountIn, request: Request, room: str = RoomId(),
                   p: Principal = Depends(require_permission("discount.apply"))):
    return await forward(p, request, "POST", "/apply_discount",
                         json={"room": room, "amount": body.amount, "reason": body.reason})


@router.post("/rooms/{room}/housekeeping")
async def housekeeping(body: HousekeepingIn, request: Request, room: str = RoomId(),
                       p: Principal = Depends(get_principal)):
    return await forward(p, request, "POST", "/toggle_housekeeping",
                         json={"room": room, **_drop_none(body.model_dump())})


@router.post("/rooms/{room}/cleaned")
async def mark_cleaned(body: CleanedIn, request: Request, room: str = RoomId(),
                       p: Principal = Depends(require_permission("room.cleaning.complete"))):
    return await forward(p, request, "POST", "/mark_room_cleaned",
                         json={"room": room, **_drop_none(body.model_dump())})


@router.post("/rooms/{room}/ready")
async def mark_ready(body: ReadyIn, request: Request, room: str = RoomId(),
                     p: Principal = Depends(require_permission("room.inspection.approve"))):
    return await forward(p, request, "POST", "/mark_room_ready_for_checkin",
                         json={"room": room, **_drop_none(body.model_dump())})


@router.post("/rooms/{room}/transfer")
async def transfer(body: TransferIn, request: Request, room: str = RoomId(),
                   p: Principal = Depends(require_permission("room.transfer"))):
    payload = {"old_room": room, "new_room": body.new_room, "apply_today_diff": body.apply_today_diff}
    if body.new_price is not None:
        payload["new_price"] = body.new_price
    if body.is_ac is not None:
        payload["is_ac"] = body.is_ac
    return await forward(p, request, "POST", "/transfer_room", json=payload)


_MAX_PHOTO = 3 * 1024 * 1024  # same guard as services/room_photos.MAX_UPLOAD_BYTES


@router.post("/rooms/{room}/photos")
async def upload_photo(request: Request, room: str = RoomId(),
                       kind: Literal["washroom", "coffee", "bed"] = Form(...),
                       context: Literal["inspection", "cleaning", "service"] = Form("inspection"),
                       photo: UploadFile = File(...), thumb: Optional[UploadFile] = File(None),
                       p: Principal = Depends(require_permission("room.cleaning.complete"))):
    """Cleaning / inspection photo (multipart) → legacy /upload_room_photo."""
    import io

    from ..core import uploads
    data = await photo.read(_MAX_PHOTO + 1)
    if len(data) > _MAX_PHOTO:
        raise HTTPException(413, "Photo too large (max 3 MB)")
    # Validate the actual bytes (magic number), not the client-declared type.
    ok, detected, err = uploads.validate_image_upload(data, max_bytes=_MAX_PHOTO)
    if not ok:
        raise HTTPException(400, err if detected == "" else "Photo must be a JPEG, PNG or WebP image")
    form = {"room": room, "kind": kind, "context": context,
            "photo": (io.BytesIO(data), photo.filename or "photo.jpg", detected)}
    if thumb is not None:
        t = await thumb.read(_MAX_PHOTO)
        form["thumb"] = (io.BytesIO(t), thumb.filename or "thumb.jpg", thumb.content_type or "image/jpeg")
    return await forward(p, request, "POST", "/upload_room_photo", data=form, content_type="multipart/form-data")
