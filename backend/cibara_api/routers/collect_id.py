"""
Guest self-service ID upload — the link a guest gets in their WhatsApp booking
confirmation, so they can upload their own ID before arrival.

Two public, token-gated routes (no app session) plus two staff routes:

  GET  /collect-id/{token}              public page the guest opens
  POST /api/v2/collect-id/{token}/upload  public — stores the photo (rate-limited)
  POST /api/v2/collect-id/links         staff — signed links for booking(s)
  POST /api/v2/bookings/parse-guest-list staff — OCR a guest list into rows

The link's only authorisation is a short-lived HS256 token (typ "id_collect",
signed with JWT_SECRET) carrying the guest's mobile, room and booking id. The
photo is stored through the existing private, audited id-docs pipeline
(services/id_docs.py) under that mobile — no money/tax logic here.
"""
from __future__ import annotations

import logging
import secrets
import time
from datetime import datetime, timezone, timedelta

import jwt
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .. import collect_id_page as page
from ..core import audit
from ..core.ratelimit import limiter
from ..security.deps import Principal, require_permission
from ..settings import get_settings

log = logging.getLogger("cibara_api.collect_id")
router = APIRouter(tags=["collect-id"])

TOKEN_TYP = "id_collect"
_DEFAULT_TTL_DAYS = 14
_MAX_TTL_DAYS = 45
_SHORT_COLLECTION = "collect_id_links"  # short code -> signed token (for tidy links)
IST = timezone(timedelta(hours=5, minutes=30))


# ── token ────────────────────────────────────────────────────────────────

def _sign(*, mobile: str, name: str, room: str, booking_id: str, exp_ts: int) -> str:
    s = get_settings()
    payload = {"typ": TOKEN_TYP, "iss": s.JWT_ISSUER, "m": mobile, "n": name[:80],
               "r": str(room)[:12], "b": booking_id, "iat": int(time.time()), "exp": exp_ts}
    return jwt.encode(payload, s.JWT_SECRET, algorithm="HS256")


def _verify(token: str) -> dict:
    s = get_settings()
    try:
        data = jwt.decode(token, s.JWT_SECRET, algorithms=["HS256"], issuer=s.JWT_ISSUER)
    except jwt.ExpiredSignatureError as e:
        raise HTTPException(410, "This link has expired.") from e
    except jwt.InvalidTokenError as e:
        raise HTTPException(400, "This link is not valid.") from e
    if data.get("typ") != TOKEN_TYP or not data.get("m"):
        raise HTTPException(400, "This link is not valid.")
    return data


def _checkout_exp(check_out_date: str | None) -> int:
    """Token lives until ~2 days after checkout (grace for a late upload), capped.

    shortcut: fixed 14-day fallback when the date is unparseable; revisit only if
    bookings start carrying non-ISO dates.
    """
    now = int(time.time())
    cap = now + _MAX_TTL_DAYS * 86400
    try:
        d = datetime.strptime((check_out_date or "")[:10], "%Y-%m-%d").replace(tzinfo=IST)
        return min(cap, max(now + 2 * 86400, int(d.timestamp()) + 2 * 86400))
    except ValueError:
        return now + _DEFAULT_TTL_DAYS * 86400


# ── shared helpers ─────────────────────────────────────────────────────────

def _db():
    from config import db
    return db


def _clean_mobile(raw) -> str:
    from services import id_docs
    return id_docs.clean_mobile(raw)


def _already_uploaded(mobile: str) -> bool:
    if not mobile:
        return False
    try:
        snap = _db().collection("customers").document(mobile).get()
        return int((snap.to_dict() or {}).get("id_doc_count") or 0) > 0 if snap.exists else False
    except Exception:
        return False


def _base_url(request: Request) -> str:
    s = get_settings()
    return (s.PUBLIC_ORIGIN or str(request.base_url)).rstrip("/")


# ── short code <-> token (so the WhatsApp link is tidy, e.g. /d/Ab3xK9pq) ──
# The token stays the real authorisation; the code is just a lookup, so a stale
# or guessed code still fails at token verify. One tiny Firestore doc per link.
def _make_short(token: str, exp_ts: int) -> str:
    code = secrets.token_urlsafe(6)  # ~8 chars; collision chance is negligible
    try:
        _db().collection(_SHORT_COLLECTION).document(code).set(
            {"token": token, "exp": exp_ts, "created": int(time.time())})
        return code
    except Exception as e:  # fall back to the long link rather than fail the send
        log.warning("collect_id: short-code store failed: %s", e)
        return ""


def _resolve_short(code: str) -> str | None:
    if not code or len(code) > 24:
        return None
    try:
        snap = _db().collection(_SHORT_COLLECTION).document(code).get()
        return (snap.to_dict() or {}).get("token") if snap.exists else None
    except Exception:
        return None


def _page_for_token(token: str):
    from fastapi.responses import HTMLResponse
    try:
        data = _verify(token)
    except HTTPException as e:
        return HTMLResponse(page.render_error(e.detail), status_code=e.status_code)
    already = _already_uploaded(data["m"])
    booking, info, portal, hotel = {}, {}, "", "Cibara Comforts"
    # Booking summary + hotel info are a nicety — never let them break the page.
    try:
        db = _db()
        bid = data.get("b")
        if bid:
            snap = db.collection("bookings").document(bid).get()
            if snap.exists:
                b = snap.to_dict() or {}
                booking = {"check_in_date": b.get("check_in_date"),
                           "check_in_time": b.get("check_in_time"),
                           "check_out_date": b.get("check_out_date"),
                           "status": b.get("status")}
    except Exception as e:  # pragma: no cover - best effort
        log.warning("collect_id: booking summary load failed: %s", e)
    try:
        from services import guest_portal
        s = guest_portal.get_settings()
        info = {"reception_phone": s.get("receptionPhone"), "wifi_name": s.get("wifiName"),
                "wifi_password": s.get("wifiPassword"), "house_rules": s.get("houseRules"),
                "checkout_time": s.get("checkoutTime")}
        hotel = s.get("hotelName") or hotel
        portal = guest_portal.portal_url(s)
    except Exception as e:  # pragma: no cover - best effort
        log.warning("collect_id: portal settings load failed: %s", e)
    return HTMLResponse(page.render_page(
        token=token, guest_name=data.get("n") or "Guest", room=data.get("r") or "",
        already=already, booking=booking, info=info, portal_url=portal, hotel=hotel))


# ── staff: generate links for a booking (or a whole group) ─────────────────

class LinksIn(BaseModel):
    booking_ids: list[str] = Field(..., min_length=1, max_length=50)


@router.post("/api/v2/collect-id/links")
async def collect_id_links(body: LinksIn, request: Request,
                           p: Principal = Depends(require_permission("customer_doc.capture"))):
    base = _base_url(request)

    def _do():
        db = _db()
        out = []
        for bid in body.booking_ids:
            if not isinstance(bid, str) or not bid:
                continue
            snap = db.collection("bookings").document(bid).get()
            if not snap.exists:
                out.append({"booking_id": bid, "error": "not_found"})
                continue
            b = snap.to_dict() or {}
            mobile = _clean_mobile(b.get("guest_mobile"))
            name = str(b.get("guest_name") or "Guest")
            room = str(b.get("room") or "")
            row = {"booking_id": bid, "room": room, "name": name, "mobile": mobile,
                   "already_uploaded": _already_uploaded(mobile), "url": None}
            if mobile:
                exp_ts = _checkout_exp(b.get("check_out_date"))
                token = _sign(mobile=mobile, name=name, room=room, booking_id=bid, exp_ts=exp_ts)
                code = _make_short(token, exp_ts)
                row["url"] = f"{base}/d/{code}" if code else f"{base}/collect-id/{token}"
            out.append(row)
        return out

    links = await run_in_threadpool(_do)
    return {"success": True, "links": links}


# ── public: the guest page ─────────────────────────────────────────────────

@router.get("/collect-id/{token}", response_class=HTMLResponse, include_in_schema=False)
async def collect_id_view(token: str):
    return await run_in_threadpool(_page_for_token, token)


@router.get("/d/{code}", response_class=HTMLResponse, include_in_schema=False)
async def collect_id_short(code: str):
    token = await run_in_threadpool(_resolve_short, code)
    if not token:
        return HTMLResponse(page.render_error("This link is not valid or has expired."),
                            status_code=404)
    return await run_in_threadpool(_page_for_token, token)


# ── public: receive the photo(s) ───────────────────────────────────────────

@router.post("/api/v2/collect-id/{token}/upload")
async def collect_id_upload(token: str, request: Request,
                            file: UploadFile = File(...),
                            file2: UploadFile | None = File(None),
                            file3: UploadFile | None = File(None),
                            file4: UploadFile | None = File(None),
                            name: str = Form("", max_length=80)):
    data = _verify(token)
    mobile, booking_id, room = data["m"], data.get("b") or "", data.get("r") or ""

    # Tight per-guest cap on top of the global IP limit — a leaked link can't be
    # used to flood storage.
    ok, retry = limiter.hit(f"collectid:{mobile}", 20, 3600)
    if not ok:
        raise HTTPException(429, "Too many uploads. Please try again later.",
                            headers={"Retry-After": str(int(retry) + 1)})

    from services import id_docs
    # Up to 4 photos: 1st = front, 2nd = back, the rest = other.
    raws = []
    for uf, side in ((file, "front"), (file2, "back"), (file3, "other"), (file4, "other")):
        if uf is None:
            continue
        b = await uf.read(id_docs.MAX_UPLOAD_BYTES + 1)
        if b:
            raws.append((b, side))
    guest = (name or data.get("n") or "Guest").strip()[:80]
    client_ip = request.client.host if request.client else "unknown"
    user = {"userId": "guest", "name": f"{guest} (self-upload)", "role": "guest"}

    def _do():
        stored = []
        for raw, side in raws:
            rec = id_docs.add_document(mobile, raw, user=user, side=side, source="upload",
                                       context={"kind": "checkin", "room": room})
            stored.append(rec["id"])
        if not stored:
            raise id_docs.IdDocError("No photo received.")
        db = _db()
        # Flag the booking so the desk sees "ID ✓"; keep the guest's confirmed
        # name on the booking + customer (best-effort, never fails the upload).
        try:
            upd = {"id_collected": True, "id_collected_at": id_docs.now_iso()}
            if guest and guest.lower() != "guest":
                upd["guest_name"] = guest
            if booking_id:
                db.collection("bookings").document(booking_id).set(upd, merge=True)
            if guest and guest.lower() != "guest":
                db.collection("customers").document(mobile).set({"name": guest}, merge=True)
        except Exception as e:  # pragma: no cover - best effort
            log.warning("collect_id: post-upload booking/customer update failed: %s", e)
        audit.write("customer_doc.capture", user=user, client_ip=client_ip,
                    user_agent=request.headers.get("user-agent", ""),
                    target_collection="customers", target_id=mobile,
                    metadata={"source": "guest_self_upload", "room": room,
                              "booking_id": booking_id, "docs": stored})
        return stored

    try:
        stored = await run_in_threadpool(_do)
    except id_docs.IdDocError as e:
        raise HTTPException(getattr(e, "status", 400), str(e)) from e
    return {"success": True, "stored": len(stored)}


# ── staff: OCR a guest list (photo) into rows ──────────────────────────────

@router.post("/api/v2/bookings/parse-guest-list")
async def parse_guest_list(file: UploadFile = File(...),
                           p: Principal = Depends(require_permission("customer_doc.capture"))):
    from services import ocr_service
    raw = await file.read(12 * 1024 * 1024 + 1)
    if len(raw) > 12 * 1024 * 1024:
        raise HTTPException(413, "Image is too large (max 12 MB).")
    res = await run_in_threadpool(ocr_service.extract_guest_list, raw,
                                  (file.content_type or "image/jpeg").lower())
    if not res.get("success"):
        reason = res.get("reason")
        if reason == "ocr_disabled":
            raise HTTPException(503, "Photo scanning is not configured. Please type the list.")
        raise HTTPException(422, res.get("message") or "Could not read the list.")
    return {"success": True, "guests": res.get("guests", [])}
