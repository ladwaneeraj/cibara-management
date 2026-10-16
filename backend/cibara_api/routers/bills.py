"""
/api/v2/bills — bill list (native, paginated) + typed facades for bill actions.

Why the list is native
──────────────────────
The old Bills tab loaded EVERY bill in the date range in one call
(/get_register_data, mode=checkout): full documents (folio, timeline,
snapshot), plus a full rooms scan and three "tally" queries no screen read.
For a month that is ~1,000 large documents per page view.

This endpoint returns one page at a time (default 50 rows) using the same
range query on `checkout_time`, the same inclusion rule (completed /
pending_settlement / legacy statuses, manual- and revert-cancelled bills
with their numbers kept) and the same tax figures (config.bill_tax_breakup —
the single authoritative tax computation the invoice itself uses). The
period tally is a separate, lazily-loaded call.

Every mutation is a facade over the unchanged legacy route.
"""
from __future__ import annotations

import logging
import re

from datetime import datetime, timedelta
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from google.cloud.firestore_v1.base_query import FieldFilter
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from ..legacy import legacy_config, legacy_context
from ..security.deps import Principal, require_permission
from ._forward import forward

log = logging.getLogger("cibara_api.bills")
router = APIRouter(prefix="/api/v2", tags=["bills"])

def BillId():
    return Path(pattern=r"^[A-Za-z0-9_-]{1,80}$")
def DateQ():
    return Query(pattern=r"^\d{4}-\d{2}-\d{2}$")

_LISTED_STATUSES = ("completed", "checked_out", "pending_settlement", "")
_MAX_SCAN = 2500

ListType = Literal["all", "b2b", "b2c", "cancelled", "settle_later", "cancel_charge", "reverted"]
PayFilter = Literal["all", "cash", "online", "split", "pending"]


# ── row building ──────────────────────────────────────────────────────────

def _is_listed(b: dict) -> bool:
    """Legacy checkout-mode inclusion (routes/billing.py) + Bills-tab rule
    (static/bills.js gstReportableEntries: a real bill number)."""
    st = b.get("status", "completed")
    listed_cancel = st == "cancelled" and (b.get("cancel_kind") == "manual" or b.get("cancelled_by_revert"))
    if st not in _LISTED_STATUSES and not listed_cancel:
        return False
    if not b.get("checkin_time") or not b.get("checkout_time"):
        return False
    bn = (b.get("bill_number") or "").strip()
    return bool(bn) and bn != "-"


def _rate_label(tb: dict) -> str:
    rates = sorted({r.get("rate") for r in (tb.get("rows") or []) if (r.get("tax") or 0) > 0})
    if not rates:
        return "Exempt"
    return f"{rates[0]:g}%" if len(rates) == 1 else "Mixed"


def _row(bill_id: str, b: dict) -> dict:
    tb = legacy_config.bill_tax_breakup(b) or {}
    cancelled = b.get("status") == "cancelled"
    return {
        "id": bill_id,
        "stay_id": b.get("stay_id") or bill_id,
        "bill_number": b.get("bill_number"),
        "guest_name": b.get("guest_name", "Unknown"),
        "guest_mobile": b.get("guest_mobile", ""),
        "room": str(b.get("room", "")),
        "checkin_time": b.get("checkin_time"),
        "checkout_time": b.get("checkout_time"),
        "days_stayed": b.get("days_stayed", 1),
        "guest_count": b.get("guest_count"),
        "room_rent": b.get("room_price_per_night", 0),
        "total_amount": b.get("total_amount") or 0,
        "payment_cash": b.get("payment_cash") or 0,
        "payment_online": b.get("payment_online") or 0,
        "payment_ota": b.get("payment_ota") or 0,
        "refunds": b.get("refunds") if isinstance(b.get("refunds"), (int, float)) else 0,
        "discounts": b.get("discounts") if isinstance(b.get("discounts"), (int, float)) else 0,
        "balance": b.get("balance") or 0,
        "status": b.get("status", "completed"),
        "booking_source": b.get("booking_source", "normal"),
        "payment_source": b.get("payment_source", "hotel"),
        "invoice_type": b.get("invoice_type", "B2C"),
        "recipient_gstin": b.get("recipient_gstin", ""),
        "recipient_legal_name": b.get("recipient_legal_name", ""),
        "settlement_id": b.get("settlement_id"),
        "cancel_kind": b.get("cancel_kind"),
        "cancel_reason": b.get("cancel_reason"),
        "cancelled_by_name": b.get("cancelled_by_name"),
        "cancelled_at_ist": b.get("cancelled_at_ist"),
        "superseded_by_revert": bool(b.get("superseded_by_revert")),
        "is_cancellation_charge": bool(b.get("is_cancellation_charge")),
        "linked_credit_note_ids": b.get("linked_credit_note_ids") or [],
        "invoice_generated": b.get("invoice_generated"),
        "pdf_url": b.get("pdf_url") or "",
        "activity": b.get("activity") or {},
        "last_guest_edit": b.get("last_guest_edit"),
        "gst": {
            "tax": 0 if cancelled else round(float(tb.get("tax") or 0), 2),
            "taxable": 0 if cancelled else round(float(tb.get("taxable") or 0), 2),
            "label": "-" if cancelled else _rate_label(tb),
        },
    }


def _matches(row: dict, q: str, typ: str, pay: str, source: str) -> bool:
    if q:
        ql = q.lower()
        hay = " ".join(str(row.get(k) or "") for k in ("guest_name", "bill_number", "guest_mobile", "room")).lower()
        if ql not in hay:
            return False
    if typ != "all":
        if typ == "b2b" and row["invoice_type"] != "B2B":
            return False
        if typ == "b2c" and row["invoice_type"] == "B2B":
            return False
        if typ == "cancelled" and row["status"] != "cancelled":
            return False
        if typ == "settle_later" and row["status"] != "pending_settlement":
            return False
        if typ == "cancel_charge" and not row["is_cancellation_charge"]:
            return False
        if typ == "reverted" and not row["superseded_by_revert"]:
            return False
    if pay != "all":
        cash, online = row["payment_cash"], row["payment_online"]
        if pay == "cash" and not (cash > 0 and online == 0):
            return False
        if pay == "online" and not (online > 0 and cash == 0):
            return False
        if pay == "split" and not (cash > 0 and online > 0):
            return False
        if pay == "pending" and not (row["balance"] > 0 and row["status"] != "cancelled"):
            return False
    if source != "all" and (row["booking_source"] or "normal") != source:
        return False
    return True


def _clamped_range(p: Principal, start: str, end: str) -> tuple[str, str]:
    """Same 3-day window for non-admins as every legacy register read."""
    from services.role_filters import clamp_date_range
    with legacy_context(p.user.as_legacy_user()):
        return clamp_date_range(start, end)


def _range_query(start: str, end: str, upper: Optional[str] = None):
    end_excl = (datetime.strptime(end, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d") + " 00:00"
    q = legacy_config.bills_ref.where(filter=FieldFilter("checkout_time", ">=", f"{start} 00:00"))
    if upper is not None:
        q = q.where(filter=FieldFilter("checkout_time", "<=", upper))
    else:
        q = q.where(filter=FieldFilter("checkout_time", "<", end_excl))
    return q.order_by("checkout_time", direction="DESCENDING"), end_excl


def _list_page(p: Principal, start: str, end: str, limit: int, cursor: Optional[str],
               q: str, typ: str, pay: str, source: str) -> dict:
    """Keyset pagination on (checkout_time DESC, doc id DESC).

    Firestore orders ties on checkout_time by document id in the same
    direction, so the cursor "<checkout_time>|<id>" resumes exactly after the
    last row returned. Filters are applied in Python over the range, so a page
    may need several small batches; scanning stops after _MAX_SCAN documents
    and returns a cursor so the client can keep going.
    """
    start, end = _clamped_range(p, start, end)
    if start > end:
        return {"success": True, "bills": [], "next_cursor": None, "range": {"from": start, "to": end}}
    cur_ct: Optional[str] = None
    cur_id: Optional[str] = None
    if cursor:
        cur_ct, _, cur_id = cursor.partition("|")
        cur_id = cur_id or None
    rows: list[dict] = []
    scanned = 0
    batch = min(max(limit * 2, 50), 200)
    exhausted = False
    while len(rows) < limit and scanned < _MAX_SCAN:
        query, end_excl = _range_query(start, end, upper=cur_ct)
        snaps = query.limit(batch).get()
        fresh = 0
        for s in snaps:
            b = s.to_dict() or {}
            ct = b.get("checkout_time") or ""
            if ct >= end_excl:
                continue
            if cur_ct is not None and (ct > cur_ct or (ct == cur_ct and cur_id is not None and s.id >= cur_id)):
                continue  # already returned on an earlier page / batch
            fresh += 1
            scanned += 1
            cur_ct, cur_id = ct, s.id
            if _is_listed(b):
                row = _row(s.id, b)
                if _matches(row, q, typ, pay, source):
                    rows.append(row)
                    if len(rows) >= limit:
                        break
        if len(rows) >= limit:
            break
        if len(snaps) < batch:
            exhausted = True
            break
        if fresh == 0:
            if batch >= 1000:  # >1000 bills with one identical minute: give up safely
                exhausted = True
                break
            batch = min(batch * 4, 1000)
    next_cursor = None if exhausted or cur_ct is None else f"{cur_ct}|{cur_id}"
    return {"success": True, "bills": rows, "next_cursor": next_cursor,
            "range": {"from": start, "to": end}, "scanned": scanned}


def _summary(p: Principal, start: str, end: str) -> dict:
    start, end = _clamped_range(p, start, end)
    out = {"cash": 0, "online": 0, "revenue": 0, "invoices": 0, "pending_count": 0,
           "pending_amount": 0, "gst": 0.0, "gst_accommodation": 0.0, "gst_services": 0.0,
           "cancelled": 0, "b2b": 0}
    if start > end:
        return {"success": True, "summary": out, "range": {"from": start, "to": end}}
    query, end_excl = _range_query(start, end)
    for s in query.stream():
        b = s.to_dict() or {}
        if (b.get("checkout_time") or "") >= end_excl or not _is_listed(b):
            continue
        if b.get("status") == "cancelled":
            out["cancelled"] += 1
            continue
        cash, online = b.get("payment_cash") or 0, b.get("payment_online") or 0
        # Same rule as static/bills.js renderTally: bills with a balance still
        # due are excluded from the Cash/UPI collection figures.
        if (b.get("balance") or 0) <= 0:
            out["cash"] += cash
            out["online"] += online
            out["revenue"] += cash + online
        else:
            out["pending_count"] += 1
            out["pending_amount"] += b.get("balance") or 0
        out["invoices"] += 1
        if b.get("invoice_type") == "B2B":
            out["b2b"] += 1
        tb = legacy_config.bill_tax_breakup(b) or {}
        for r in tb.get("rows") or []:
            t = float(r.get("tax") or 0)
            if r.get("category") == "accommodation":
                out["gst_accommodation"] += t
            else:
                out["gst_services"] += t
        out["gst"] += float(tb.get("tax") or 0)
    for k in ("gst", "gst_accommodation", "gst_services"):
        out[k] = round(out[k], 2)
    return {"success": True, "summary": out, "range": {"from": start, "to": end}}


# ── list / detail ─────────────────────────────────────────────────────────

@router.get("/bills")
async def list_bills(start: str = DateQ(), end: str = DateQ(),
                     q: str = Query(default="", max_length=60),
                     type: ListType = "all", payment: PayFilter = "all",
                     source: str = Query(default="all", pattern=r"^[a-z.]{2,20}$"),
                     limit: int = Query(default=50, ge=1, le=200),
                     cursor: Optional[str] = Query(default=None, max_length=120),
                     p: Principal = Depends(require_permission("register.view"))):
    if start > end:
        raise HTTPException(400, "start must be on or before end")
    return await run_in_threadpool(_list_page, p, start, end, limit, cursor, q.strip(), type, payment, source)


@router.get("/bills/summary")
async def bills_summary(start: str = DateQ(), end: str = DateQ(),
                        p: Principal = Depends(require_permission("register.view"))):
    if start > end:
        raise HTTPException(400, "start must be on or before end")
    return await run_in_threadpool(_summary, p, start, end)


def _detail(bill_id: str) -> dict | None:
    snap = legacy_config.bills_ref.document(bill_id).get()
    if not snap.exists:
        return None
    b = snap.to_dict() or {}
    b["id"] = snap.id
    b["tax_breakup"] = legacy_config.bill_tax_breakup(b)
    b.pop("pre_checkout_snapshot", None)
    return b


@router.get("/bills/{bill_id}")
async def get_bill(bill_id: str = BillId(), p: Principal = Depends(require_permission("register.view"))):
    b = await run_in_threadpool(_detail, bill_id)
    if b is None:
        raise HTTPException(404, "Bill not found")
    return {"success": True, "bill": b}


@router.get("/bills/{bill_id}/html")
async def bill_html(request: Request, bill_id: str = BillId(),
                    view: Optional[Literal["detailed", "consolidated"]] = None,
                    p: Principal = Depends(require_permission("register.view"))):
    return await forward(p, request, "GET", f"/bill_html/{bill_id}", query={"view": view})


class PdfIn(BaseModel):
    force: bool = False


@router.post("/bills/{bill_id}/pdf")
async def bill_pdf(body: PdfIn, request: Request, bill_id: str = BillId(),
                   p: Principal = Depends(require_permission("register.view"))):
    return await forward(p, request, "POST", "/render_bill_pdf", json={"bill_id": bill_id, "force": body.force})


class GuestEditIn(BaseModel):
    guest_name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    guest_mobile: Optional[str] = Field(default=None, pattern=r"^([0-9]{10})?$")


@router.patch("/bills/{bill_id}/guest")
async def edit_guest(body: GuestEditIn, request: Request, bill_id: str = BillId(),
                     p: Principal = Depends(require_permission("bill.guest.edit"))):
    payload = {"bill_id": bill_id, **body.model_dump(exclude_none=True)}
    if len(payload) == 1:
        raise HTTPException(400, "Nothing to update")
    return await forward(p, request, "POST", "/update_bill_guest", json=payload)


class GstEditIn(BaseModel):
    clear: bool = False
    recipient_gstin: Optional[str] = Field(default=None, pattern=r"^[0-9A-Za-z]{15}$")
    recipient_legal_name: Optional[str] = Field(default=None, max_length=200)
    recipient_trade_name: Optional[str] = Field(default=None, max_length=200)
    recipient_address: Optional[str] = Field(default=None, max_length=500)
    recipient_state_code: Optional[str] = Field(default=None, pattern=r"^[0-9]{2}$")


@router.patch("/bills/{bill_id}/gst")
async def edit_gst(body: GstEditIn, request: Request, bill_id: str = BillId(),
                   p: Principal = Depends(require_permission("bill.gst.edit"))):
    if body.clear:
        payload = {"bill_id": bill_id, "clear": True}
    else:
        payload = {"bill_id": bill_id, **body.model_dump(exclude_none=True, exclude={"clear"})}
        if "recipient_gstin" in payload:
            payload["recipient_gstin"] = payload["recipient_gstin"].upper()
    return await forward(p, request, "POST", "/update_bill_gst", json=payload)


class CancelIn(BaseModel):
    reason: str = Field(min_length=10, max_length=500)
    confirm: Literal[True]
    remove_receipts: bool = False


@router.post("/bills/{bill_id}/cancel")
async def cancel_bill(body: CancelIn, request: Request, bill_id: str = BillId(),
                      p: Principal = Depends(require_permission("bill.cancel"))):
    return await forward(p, request, "POST", "/cancel_bill", json={
        "bill_id": bill_id, "reason": body.reason.strip(), "confirm": True,
        "remove_receipts": body.remove_receipts})


class BillPaymentIn(BaseModel):
    payment_mode: Literal["cash", "online"] = "cash"
    payment_date: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    amount: int = Field(default=0, ge=0, le=10_000_000)
    discount: int = Field(default=0, ge=0, le=10_000_000)
    discount_type: Literal["financial", "credit_note"] = "financial"
    discount_reason: str = Field(default="", max_length=300)
    bad_debt: bool = False


@router.post("/bills/{bill_id}/payments")
async def bill_payment(body: BillPaymentIn, request: Request, bill_id: str = BillId(),
                       p: Principal = Depends(require_permission("payment.edit"))):
    if body.amount <= 0 and body.discount <= 0:
        raise HTTPException(400, "Enter a payment amount or a discount")
    payload = body.model_dump()
    # The old client sent `bad_debt`; the route reads `is_bad_debt` (contract
    # §2.25), so the flag was silently dropped. Send the key the route reads.
    payload["is_bad_debt"] = payload.pop("bad_debt")
    payload["bill_id"] = bill_id
    return await forward(p, request, "POST", "/add_bill_payment", json=payload)


class ActivityIn(BaseModel):
    kind: Literal["print", "whatsapp"]
    to: str = Field(default="", pattern=r"^([0-9]{10})?$")


@router.post("/bills/{bill_id}/activity")
async def bill_activity(body: ActivityIn, request: Request, bill_id: str = BillId(),
                        p: Principal = Depends(require_permission("app.access"))):
    return await forward(p, request, "POST", "/log_bill_activity",
                         json={"bill_id": bill_id, "kind": body.kind, "to": body.to})


@router.get("/bills/{bill_id}/audit")
async def bill_audit(request: Request, bill_id: str = BillId(),
                     p: Principal = Depends(require_permission("register.view"))):
    return await forward(p, request, "GET", f"/api/audit-logs/doc/bills/{bill_id}/all", query={"limit": "25"})


@router.post("/bills/{bill_id}/invoice")
async def generate_invoice(request: Request, bill_id: str = BillId(),
                           p: Principal = Depends(require_permission("bill.gst.edit"))):
    return await forward(p, request, "POST", f"/generate_invoice/{bill_id}", json={})


class RoomPriceIn(BaseModel):
    room_price_per_night: int = Field(ge=1, le=100_000)
    reason: str = Field(min_length=3, max_length=300)
    segment_prices: Optional[list[int]] = None


@router.patch("/bills/{bill_id}/room-price")
async def edit_room_price(body: RoomPriceIn, request: Request, bill_id: str = BillId(),
                          p: Principal = Depends(require_permission("payment.edit"))):
    return await forward(p, request, "POST", "/edit_bill_room_price",
                         json={"bill_id": bill_id, **body.model_dump(exclude_none=True)})


# ── credit notes, GST helpers ─────────────────────────────────────────────

@router.get("/credit-notes")
async def credit_notes(request: Request, start: str = DateQ(), end: str = DateQ(),
                       p: Principal = Depends(require_permission("register.view"))):
    return await forward(p, request, "POST", "/list_credit_notes", json={"start_date": start, "end_date": end})


@router.post("/credit-notes/{cn_id}/pdf")
async def credit_note_pdf(body: PdfIn, request: Request, cn_id: str = BillId(),
                          p: Principal = Depends(require_permission("credit_note.issue"))):
    return await forward(p, request, "POST", "/render_credit_note_pdf", json={"cn_id": cn_id, "force": body.force})


@router.get("/gst/recipients")
async def gst_recipients(request: Request, p: Principal = Depends(require_permission("bill.gst.edit"))):
    return await forward(p, request, "GET", "/gst_recipients")


@router.get("/gst/locks")
async def gst_locks(request: Request, p: Principal = Depends(require_permission("gst.lock.manage"))):
    return await forward(p, request, "GET", "/gst_locks")


class LockIn(BaseModel):
    period: str = Field(pattern=r"^\d{4}-\d{2}$")
    locked: bool
    note: str = Field(default="", max_length=500)


@router.post("/gst/locks")
async def set_gst_lock(body: LockIn, request: Request, p: Principal = Depends(require_permission("gst.lock.manage"))):
    return await forward(p, request, "POST", "/gst_locks/set", json=body.model_dump())


# ── stored PDF as a file (for sharing the document itself, not a link) ────

_STORAGE_HOST = "firebasestorage.googleapis.com"
_STORAGE_PATH = re.compile(r"^/v0/b/([^/]+)/o/([^/]+)$")
_ALLOWED_OBJECT = re.compile(r"^(bills|credit_notes)/[A-Za-z0-9_./-]+\.pdf$")


def _storage_object(url: str) -> str:
    """Firebase download URL → object path, only for our bucket's bill / CN PDFs."""
    from urllib.parse import unquote, urlsplit
    from firebase_admin import storage as fb_storage
    u = urlsplit(url or "")
    m = _STORAGE_PATH.match(u.path or "")
    if u.scheme != "https" or u.hostname != _STORAGE_HOST or not m:
        raise HTTPException(400, "Not a stored invoice link")
    bucket, obj = m.group(1), unquote(m.group(2))
    if bucket != fb_storage.bucket().name or ".." in obj or not _ALLOWED_OBJECT.match(obj):
        raise HTTPException(400, "Not a stored invoice link")
    return obj


@router.get("/bills/{bill_id}/pdf-file")
async def bill_pdf_file(bill_id: str = BillId(),
                        p: Principal = Depends(require_permission("register.view"))):
    """The bill's stored invoice PDF as a file, same-origin.

    The browser cannot fetch Firebase Storage objects cross-origin without a
    bucket CORS policy, and the share sheet needs the bytes to attach the PDF
    itself to WhatsApp instead of a link. The stored `pdf_url` is resolved on
    the server, so no download token ever appears in a request URL or log.
    Only bill / credit-note PDFs in this project's bucket are served.
    """
    from fastapi.responses import Response
    from firebase_admin import storage as fb_storage

    def _read() -> tuple[bytes | None, str]:
        snap = legacy_config.db.collection("bills").document(bill_id).get()
        if not snap.exists:
            raise HTTPException(404, "Bill not found")
        b = snap.to_dict() or {}
        url = b.get("pdf_url") or ""
        if not url:
            raise HTTPException(404, "No PDF saved for this bill yet. Generate it first.")
        obj = _storage_object(url)
        try:
            return fb_storage.bucket().blob(obj).download_as_bytes(), (b.get("bill_number") or bill_id)
        except Exception as e:  # NotFound or transient
            log.info("bill_pdf_file: %s unavailable: %s", obj, e)
            return None, ""
    data, number = await run_in_threadpool(_read)
    if not data:
        raise HTTPException(404, "PDF not found. Regenerate it and try again.")
    name = "Invoice-" + (re.sub(r"[^A-Za-z0-9_.-]+", "_", number).strip("._") or "bill") + ".pdf"
    return Response(data, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="{name}"',
                             "Cache-Control": "no-store"})
