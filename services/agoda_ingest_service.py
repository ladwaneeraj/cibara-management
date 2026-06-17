"""
Agoda hotelier booking-confirmation Gmail ingestion.

Purpose
-------
Read Agoda "Booking Confirmation" emails from a Gmail inbox over IMAP
(read-only), parse each into a structured booking, and create a matching
booking document in Firestore so the stay shows up in the app automatically —
flagged with booking_source="agoda".

This module is a deliberate parallel of services/mmt_ingest_service.py so the
two OTA pipelines behave identically downstream (same booking shape, same
settlement core, same room auto-assignment). It reuses the pure, I/O-free
helpers from the MMT module instead of re-implementing them, so a fix to a
shared helper (date parsing, GSTIN validation, HTML flattening, IMAP body
extraction) benefits both. Agoda-specific logic (the confirmation parser,
the AC / Non-AC room-type mapping, and the rate-basis handling) lives here.

Design notes
------------
* Pure parsing is separated from I/O so it can be unit-tested offline.
  `parse_agoda_confirmation_html(html)` and `build_booking_from_agoda(parsed)`
  do not touch IMAP, Firestore, or the network.
* IMAP access is READ-ONLY (EXAMINE). De-duplication is on the Agoda booking
  id in Firestore, so ingestion is idempotent and safe to re-run.
* The two pipelines run independently (separate route/service). A parse bug in
  Agoda email handling therefore cannot break MMT ingestion, and vice-versa.

Money / rate basis  (READ THIS — it is a tax decision)
------------------------------------------------------
An Agoda confirmation in the net-rate ("Agoda Collect" / payable-by-Agoda)
model shows several figures, e.g.:

    Reference sell rate (incl. taxes & fees)   INR 3,360.00   (guest paid Agoda)
    Net rate (incl. taxes & fees)              INR 2,620.80   (hotel is paid)
    Commission                                 INR  -576.00
    TDS - Withholding tax                      INR    -3.20

Note that  sell - commission - tds  != net  (here it differs by ₹160). The
gap is Agoda's own markup, which the hotel never receives. Treating the SELL
rate as the hotel's taxable room value would therefore overstate output GST.

So the DEFAULT basis here is "net":
    ota_total_amount = net_receivable = Net rate (taken from the label, never
    derived), and no separate commission is booked against the hotel (the
    margin is Agoda's, not a deduction from the hotel's net).

Set AGODA_INVOICE_BASIS=gross to mirror MMT exactly instead (ota_total = sell
rate, commission booked as an ITC expense at settlement). Either way the raw
figures are stored on the booking (agoda_sell_rate, agoda_net_rate,
agoda_reported_commission, agoda_reported_tds) and a reconciliation mismatch
( |sell - commission - comm_gst - tcs - tds - net| > ₹1 ) stamps
needs_review=True so a human confirms the GST treatment before the invoice is
finalized. Nothing is silently mis-invoiced.

Configuration (environment variables)
-------------------------------------
    AGODA_GMAIL_USER          Gmail address that receives Agoda emails.
                              Falls back to MMT_GMAIL_USER (shared inbox).
    AGODA_GMAIL_APP_PASSWORD  Google App Password. Falls back to
                              MMT_GMAIL_APP_PASSWORD (shared inbox).
    AGODA_IMAP_HOST           default = MMT_IMAP_HOST or "imap.gmail.com"
    AGODA_IMAP_FOLDER         default = MMT_IMAP_FOLDER or "INBOX"
    AGODA_IMAP_SENDERS        comma-separated FROM filters; default "agoda.com"
    AGODA_INGEST_SECRET       shared secret for the /agoda/ingest route
                              (falls back to MMT_INGEST_SECRET in app.require_auth)
    AGODA_INGEST_LOOKBACK_DAYS  initial scan window on first run; default 14
    AGODA_INGEST_SINCE        go-live floor (YYYY-MM-DD); default 2026-06-01
    AGODA_INVOICE_BASIS       "net" (default) | "gross"  — see note above
    AGODA_AC_ROOMS            AC/Premium room block; default 200..206
    AGODA_NONAC_ROOMS         Non-AC room pool; default empty (left unassigned)
    AGODA_DOUBLE_ROOMS        rooms for <=2 adults; default 200,201,206
    AGODA_TRIPLE_ROOMS        rooms for >=3 adults; default 202,203,204,205
"""

from __future__ import annotations

import os
import re
import email
import imaplib
import logging
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime

# Reuse the pure, I/O-free helpers from the MMT module so the two pipelines
# stay consistent. These are side-effect free (no Firestore/IMAP at import).
from services.mmt_ingest_service import (
    html_to_text,
    _num,
    _validate_gstin,
    _state_from_gstin,
    _search,
    _parse_any_date,
    _decode_subject,
    _extract_html_body,
    _premium_pool,
)

logger = logging.getLogger(__name__)

# Firestore doc that stores the ingestion cursor + last-run stats.
_CURSOR_DOC = "agoda_ingest"

# Reconciliation tolerance (rupees) for the sell/commission/net cross-check.
_RECONCILE_TOL = 1.0


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def _env_with_fallback(primary: str, fallback: str, default: str = "") -> str:
    val = os.environ.get(primary)
    if val is None or val == "":
        val = os.environ.get(fallback, default)
    return val or default


def load_config() -> dict:
    """Read ingestion config from the environment. No secrets are logged.

    Credentials fall back to the MMT_* variables so a single shared Gmail
    inbox (the common case) needs no extra setup — only AGODA_IMAP_SENDERS
    differs by default.
    """
    senders = os.environ.get("AGODA_IMAP_SENDERS", "agoda.com")
    _app_pw = _env_with_fallback("AGODA_GMAIL_APP_PASSWORD", "MMT_GMAIL_APP_PASSWORD", "")
    _app_pw = "".join(_app_pw.split())  # strip the display spaces Google shows
    return {
        "user":      _env_with_fallback("AGODA_GMAIL_USER", "MMT_GMAIL_USER", "").strip(),
        "password":  _app_pw,
        "host":      _env_with_fallback("AGODA_IMAP_HOST", "MMT_IMAP_HOST", "imap.gmail.com").strip(),
        "folder":    _env_with_fallback("AGODA_IMAP_FOLDER", "MMT_IMAP_FOLDER", "INBOX").strip(),
        "senders":   [s.strip().lower() for s in senders.split(",") if s.strip()],
        "lookback_days": int(os.environ.get("AGODA_INGEST_LOOKBACK_DAYS", "14") or 14),
        "since_floor": os.environ.get(
            "AGODA_INGEST_SINCE", os.environ.get("MMT_INGEST_SINCE", "2026-06-01")
        ).strip(),
        "invoice_basis": (os.environ.get("AGODA_INVOICE_BASIS", "net") or "net").strip().lower(),
    }


def is_configured(cfg: dict | None = None) -> bool:
    cfg = cfg or load_config()
    return bool(cfg.get("user") and cfg.get("password"))


# ---------------------------------------------------------------------------
# Pure parsing helpers (no I/O — unit-testable)
# ---------------------------------------------------------------------------

# "INR 3,360.00" / "INR -576.00" / "Rs. 1,310.40" -> float (sign preserved).
_INR = r"(?:INR|Rs\.?|₹)\s*"


def _inr(s: str | None):
    """Parse an Agoda money token like 'INR -576.00' -> -576.0."""
    if not s:
        return None
    s = re.sub(r"(?i)\b(?:INR|Rs)\b\.?", "", s)
    return _num(s)


def _parse_agoda_date(s: str | None):
    """Parse an Agoda date token to ISO 'YYYY-MM-DD'. Returns None on failure.

    Agoda confirmations render dates as 'June 17, 2026'. We also accept the
    other common renderings via the shared _parse_any_date fallback.
    """
    if not s:
        return None
    s = s.strip().strip(",")
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%B %d %Y", "%d %B %Y", "%d %b %Y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return _parse_any_date(s)


def is_agoda_email(text: str) -> bool:
    """True if the flattened text looks like an Agoda hotelier email at all."""
    t = text or ""
    return bool(re.search(r"\bAgoda\b", t, re.IGNORECASE))


def is_agoda_settlement(text: str) -> bool:
    """Best-effort detector for an Agoda remittance / payment-advice email.

    NOTE: the exact format of Agoda's settlement email was not available when
    this was written, so this is intentionally conservative and may need the
    patterns widened once a real remittance email is supplied. Confirmation
    emails (which carry the booking) must NOT match this.
    """
    t = text or ""
    if not is_agoda_email(t):
        return False
    has_pay = bool(
        re.search(r"remittance|payment advice|paid to your account|"
                  r"settlement (?:statement|report)|amount (?:remitted|transferred)",
                  t, re.IGNORECASE)
    )
    # A booking confirmation has the booking structure; a remittance does not.
    looks_like_confirmation = bool(re.search(r"Check[\s\-]?in", t, re.IGNORECASE)
                                   and re.search(r"Room Type", t, re.IGNORECASE))
    return has_pay and not looks_like_confirmation


def parse_agoda_confirmation_html(html: str, *, subject: str = "", received_dt=None) -> dict | None:
    """
    Parse an Agoda hotelier booking-confirmation email body into a structured
    dict. Returns None if the body is clearly not an Agoda confirmation.

    Never raises on malformed input — unparsable fields are left None and the
    record is stamped needs_review.
    """
    text = html_to_text(html)
    if not text:
        return None
    if is_agoda_settlement(text):
        return None  # handled elsewhere; never create a booking from a remittance

    # Require the confirmation structure, not merely the word "Agoda", so
    # marketing / reminder mails don't create junk rows.
    is_conf = bool(
        re.search(r"\bBooking ID\b", text, re.IGNORECASE)
        and (re.search(r"Check[\s\-]?in", text, re.IGNORECASE)
             or re.search(r"Room Type", text, re.IGNORECASE))
    )
    if not is_conf:
        return None

    parsed: dict = {"subject": subject, "raw_text_len": len(text)}

    # ── Identifiers ──────────────────────────────────────────────────────
    parsed["agoda_booking_id"] = _search(r"Booking ID\s*([0-9]{6,})", text)
    parsed["property_id"] = _search(r"Property ID\s*([A-Z0-9]{4,})", text)

    # ── Guest ────────────────────────────────────────────────────────────
    first = _search(r"Customer First Name\s+([A-Za-z][A-Za-z.\-']*)", text)
    last = _search(r"Customer Last Name\s+([A-Za-z][A-Za-z.\-']*)", text)
    name = " ".join(p for p in (first, last) if p).strip()
    parsed["guest_name"] = name or None
    parsed["country_of_residence"] = _search(
        r"Country of Residence\s+([A-Za-z][A-Za-z .]+?)\s+(?:Check|Other|Room|No\.)", text)

    # ── Stay dates ───────────────────────────────────────────────────────
    parsed["check_in_date"] = _parse_agoda_date(
        _search(r"Check[\s\-]?in\s+([A-Za-z]+ \d{1,2}, \d{4})", text))
    parsed["check_out_date"] = _parse_agoda_date(
        _search(r"Check[\s\-]?out\s+([A-Za-z]+ \d{1,2}, \d{4})", text))
    parsed["check_in_time"] = "12:00"
    parsed["check_out_time"] = "12:00"

    # ── Occupancy / rooms / room type ────────────────────────────────────
    # Adults drive room assignment, so parse defensively across Agoda's
    # layout variants: "Occupancy : 2 Adults", "Occupancy 2 Adults", or a
    # bare "2 Adults" elsewhere in the body. The earlier `Occupancy\s+`
    # pattern silently failed when a colon followed the label and defaulted
    # the count to 1.
    adults = (
        _search(r"Occupancy\s*[:\-]?\s*(\d+)\s*Adult", text)
        or _search(r"(\d+)\s*Adults?\b", text)
        or _search(r"Adults?\s*[:\-]?\s*(\d+)", text)
    )
    parsed["guest_count"] = int(adults) if adults else 1
    rooms_n = _search(r"No\.?\s*of\s*Rooms\s*[:\-]?\s*(\d+)", text)
    parsed["room_qty"] = int(rooms_n) if rooms_n else 1
    # Room type. In some Agoda confirmations the type sits right after the
    # "Room Type" label; in others the section is a TABLE whose header row
    # ("Room Type  No. of Rooms  Occupancy  No. of Extra Bed") is separate from
    # the value row ("Premium  1  2 Adults  0"), so the label is NOT adjacent to
    # its value. Try label-adjacency first, then fall back to matching a known
    # product name (Premium / Premium AC / AC / Non AC) directly — robust to
    # either layout. Without this, the table layout left the type blank and the
    # booking was created with no room assigned. Order the alternation so
    # "Premium AC" wins over "Premium" and "Non AC" over "AC".
    _KNOWN_TYPE = r"(Premium\s*AC|Non[\s\-]?AC|Premium|AC)"
    rtype = _search(
        r"Room Type\s+([A-Za-z][A-Za-z /\-]*?)\s+(?:No\.?\s*of Rooms|Occupancy|Rate Plan|Benefits|Special)",
        text)
    # Reject a capture that grabbed a neighbouring label instead of a value.
    if (not rtype) or re.search(r"\bno\.?\b|occupancy|rate\s*plan", rtype, re.IGNORECASE):
        rtype = (
            _search(r"Room Type.*?\b" + _KNOWN_TYPE + r"\b", text)
            or _search(r"\b" + _KNOWN_TYPE + r"\b", text)
        )
    if rtype:
        rtype = re.sub(r"\s{2,}", " ", rtype).strip()
    parsed["room_type"] = rtype
    parsed["rate_plan"] = _search(r"Rate Plan name:?\s*(.+?)\s+(?:Benefits|Special|Cancellation|Room)", text)

    # ── GST (B2B only if a company GSTIN is present) ─────────────────────
    parsed["property_gstin"] = _search(r"(?:Property\s*GST(?:N|IN)?)\s*[:\-]?\s*([0-9A-Z]{15})", text)
    parsed["customer_gstin"] = _search(r"(?:Company|Customer)\s*GST(?:N|IN)?\s*[:\-]?\s*([0-9A-Z]{15})", text)
    parsed["customer_name"] = _search(r"Company Name\s+(.+?)\s+(?:Company Address|Company GST)", text)
    parsed["customer_address"] = _search(r"Company Address\s+(.+?)\s+Company GST", text)

    # ── Money ────────────────────────────────────────────────────────────
    parsed["agoda_sell_rate"] = _inr(_search(
        r"Reference sell rate[^A-Za-z0-9]*\(?[^)]*\)?\s*(" + _INR + r"-?[\d,]+\.?\d*)", text)
        or _search(r"Reference sell rate.{0,40}?(" + _INR + r"-?[\d,]+\.?\d*)", text))
    parsed["agoda_net_rate"] = _inr(_search(
        r"Net rate[^A-Za-z0-9]*\(?[^)]*\)?\s*(" + _INR + r"-?[\d,]+\.?\d*)", text)
        or _search(r"\bNet rate\b.{0,40}?(" + _INR + r"-?[\d,]+\.?\d*)", text))
    # Commission / TDS / TCS may carry descriptive words between the label and
    # the amount (e.g. "TDS - Withholding tax INR -3.20"), so allow any chars
    # (lazily, capped) between the label and the currency token.
    _comm = _inr(_search(r"Commission.{0,30}?(" + _INR + r"-?[\d,]+\.?\d*)", text))
    parsed["agoda_reported_commission"] = abs(_comm) if _comm is not None else None
    _tds = _inr(_search(r"\bTDS\b.{0,40}?(" + _INR + r"-?[\d,]+\.?\d*)", text))
    parsed["agoda_reported_tds"] = abs(_tds) if _tds is not None else None
    _tcs = _inr(_search(r"\bTCS\b.{0,40}?(" + _INR + r"-?[\d,]+\.?\d*)", text))
    parsed["agoda_reported_tcs"] = abs(_tcs) if _tcs is not None else None

    # ── Confidence / review flags ────────────────────────────────────────
    reasons = []
    if not parsed.get("agoda_booking_id"):
        reasons.append("missing booking id")
    if not parsed.get("guest_name"):
        reasons.append("missing guest name")
    if not parsed.get("check_in_date"):
        reasons.append("unparsable check-in date")
    if not parsed.get("check_out_date"):
        reasons.append("unparsable check-out date")
    if parsed.get("agoda_net_rate") is None:
        reasons.append("missing net rate")
    parsed["needs_review"] = bool(reasons)
    parsed["review_reasons"] = reasons
    return parsed


def build_booking_from_agoda(parsed: dict, *, now=None) -> dict:
    """
    Map a parsed Agoda confirmation into a Firestore booking document with the
    same shape as an MMT-ingested booking (booking_source="agoda"). Room is
    left UNASSIGNED here; the ingest pass auto-assigns from the type's pool.

    See the module docstring for the rate-basis rationale.
    """
    now = now or datetime.now()
    basis = (parsed.get("_invoice_basis") or "net").lower()

    sell = parsed.get("agoda_sell_rate")
    net = parsed.get("agoda_net_rate")
    reported_comm = float(parsed.get("agoda_reported_commission") or 0.0)
    reported_tds = float(parsed.get("agoda_reported_tds") or 0.0)
    reported_tcs = float(parsed.get("agoda_reported_tcs") or 0.0)

    # net_receivable: always the labelled Net rate (what hits the bank). Fall
    # back to sell rate only if the net rate failed to parse.
    net_receivable = round(float(net if net is not None else (sell or 0)), 2)

    if basis == "gross":
        # Mirror MMT: room invoice on the gross sell rate; book commission as
        # an ITC expense at settlement.
        ota_total = int(round(sell if sell is not None else (net or 0)))
        commission = reported_comm
        tcs = reported_tcs
        tds = reported_tds
    else:
        # Default "net": the hotel's taxable room value is the net rate it
        # actually earns; Agoda's markup is its own supply, not the hotel's.
        # No commission is deducted from the hotel's books in this model.
        ota_total = int(round(net if net is not None else (sell or 0)))
        commission = 0.0
        tcs = 0.0
        tds = reported_tds  # TDS is on the hotel's income — keep for reference

    review_reasons = list(parsed.get("review_reasons") or [])
    needs_review = bool(parsed.get("needs_review"))

    # Reconciliation cross-check: sell - commission - comm_gst - tcs - tds
    # should equal net. A mismatch (Agoda markup) is surfaced for confirmation.
    reconcile_diff = None
    if sell is not None and net is not None:
        reconcile_diff = round(sell - reported_comm - reported_tcs - reported_tds - net, 2)
        if abs(reconcile_diff) > _RECONCILE_TOL:
            needs_review = True
            review_reasons.append(
                f"rate reconciliation Δ₹{reconcile_diff} "
                f"(sell {sell} − comm {reported_comm} − tds {reported_tds} ≠ net {net}); "
                f"verify Agoda rate basis/GST"
            )

    cust_gstin = (parsed.get("customer_gstin") or "").strip().upper()
    is_b2b = _validate_gstin(cust_gstin)
    state_name, state_code = _state_from_gstin(cust_gstin) if is_b2b else ("", "")

    booking = {
        # ── Core booking fields (mirror create_booking / MMT) ─────────────
        "room": "",
        "room_assigned": False,
        "guest_name": (parsed.get("guest_name") or "Agoda Guest").strip(),
        "guest_mobile": "",
        "booking_date": now.strftime("%Y-%m-%d"),
        "check_in_date": parsed.get("check_in_date") or "",
        "check_in_time": parsed.get("check_in_time") or "12:00",
        "check_out_date": parsed.get("check_out_date") or "",
        "status": "confirmed",
        "booking_source": "agoda",
        "payment_source": "ota",
        "total_amount": ota_total,
        "paid_amount": 0,
        "balance": ota_total,
        "is_ac": False,
        "rate_per_night": None,
        "payment_method": "ota",
        "notes": _compose_notes(parsed),
        "photo_path": None,
        "guest_count": int(parsed.get("guest_count") or 1),

        # ── OTA settlement fields ─────────────────────────────────────────
        "ota_total_amount": ota_total,
        "ota_commission": commission,
        "ota_commission_gst": 0.0,
        "net_receivable": net_receivable,
        "tcs_amount": tcs,
        "tds_amount": tds,
        "settlement_status": "pending",
        "settlement_date": None,
        "settlement_amount": None,

        # ── Agoda identifiers / provenance ────────────────────────────────
        "agoda_booking_id": parsed.get("agoda_booking_id") or "",
        "agoda_property_id": parsed.get("property_id") or "",
        "room_type": parsed.get("room_type") or "",
        "property_gstin": parsed.get("property_gstin") or "",
        "ingest_source": "gmail",
        "invoice_basis": basis,
        # Raw figures kept verbatim for audit / re-mapping if the basis changes.
        "agoda_sell_rate": sell,
        "agoda_net_rate": net,
        "agoda_reported_commission": reported_comm,
        "agoda_reported_tds": reported_tds,
        "agoda_reported_tcs": reported_tcs,
        "agoda_reconcile_diff": reconcile_diff,
        "needs_review": needs_review,
        "review_reasons": review_reasons,

        # ── B2B recipient (pre-filled for GSTR-1) ─────────────────────────
        "recipient_gstin": cust_gstin if is_b2b else "",
        "recipient_legal_name": (parsed.get("customer_name") or "").strip() if is_b2b else "",
        "recipient_trade_name": (parsed.get("customer_name") or "").strip() if is_b2b else "",
        "recipient_address": (parsed.get("customer_address") or "").strip() if is_b2b else "",
        "recipient_state": state_name or "Karnataka",
        "recipient_state_code": state_code or "29",
        "invoice_type": "B2B" if is_b2b else "B2C",
    }
    return booking


def _compose_notes(parsed: dict) -> str:
    bits = []
    if parsed.get("agoda_booking_id"):
        bits.append(f"Agoda {parsed['agoda_booking_id']}")
    if parsed.get("room_type"):
        bits.append(f"{parsed.get('room_qty', 1)} x {parsed['room_type']}")
    if parsed.get("rate_plan"):
        bits.append(str(parsed["rate_plan"]))
    return " | ".join(bits)


# ---------------------------------------------------------------------------
# Room auto-assignment from the Agoda room TYPE + guest count
# ---------------------------------------------------------------------------
# AC / Premium bookings draw from the AC-capable block (default 200..206) with
# is_ac=True — every room in this block is AC. Within that block the physical
# room is chosen by adult count:
#   • <=2 adults  → 200, 201, 206   (AGODA_DOUBLE_ROOMS)
#   • >=3 adults  → 202, 203, 204, 205   (AGODA_TRIPLE_ROOMS)
# The non-preferred rooms remain usable as overflow when the preferred set is
# full. Non-AC bookings draw from AGODA_NONAC_ROOMS; that pool is EMPTY by
# default, so a Non-AC booking is left unassigned (operator picks at check-in)
# until the non-AC room numbers are configured — avoids guessing / double-book.

def _ac_pool() -> list[str]:
    raw = os.environ.get("AGODA_AC_ROOMS")
    if raw:
        return [r.strip() for r in raw.split(",") if r.strip()]
    return _premium_pool()  # default = MMT's 200..206


def _nonac_pool() -> list[str]:
    raw = os.environ.get("AGODA_NONAC_ROOMS", "")
    return [r.strip() for r in raw.split(",") if r.strip()]


_AGODA_TRIPLE_THRESHOLD = 3


def _agoda_preferred_rooms(guest_count) -> list[str]:
    """Preferred room set by adult count (env-overridable):
    <=2 adults → 200,201,206 ; >=3 adults → 202,203,204,205."""
    try:
        gc = int(guest_count or 0)
    except (TypeError, ValueError):
        gc = 0
    if gc >= _AGODA_TRIPLE_THRESHOLD:
        raw = os.environ.get("AGODA_TRIPLE_ROOMS", "202,203,204,205")
    else:
        raw = os.environ.get("AGODA_DOUBLE_ROOMS", "200,201,206")
    return [r.strip() for r in raw.split(",") if r.strip()]


def _agoda_ordered_candidates(pool: list[str], guest_count) -> list[str]:
    """Preferred rooms (by adult count) first, then the rest of the pool as
    overflow. Only rooms present in `pool` are returned, so a stale preference
    entry can never invent a non-existent room."""
    pref = _agoda_preferred_rooms(guest_count)
    ordered: list[str] = []
    seen: set[str] = set()
    for r in pref:
        if r in pool and r not in seen:
            ordered.append(r)
            seen.add(r)
    for r in pool:
        if r not in seen:
            ordered.append(r)
            seen.add(r)
    return ordered


def _pool_and_ac_for_agoda_type(room_type: str):
    """
    Return (pool, is_ac) for an Agoda room type.

    The property sells two Premium products on Agoda:
      • "Premium"     → normal (NON-AC) → is_ac=False
      • "Premium AC"  → AC              → is_ac=True
    Both occupy the same physical block (default 200..206); the adult count
    then picks the room within it (see _agoda_ordered_candidates). An explicit
    "Non AC" type draws from AGODA_NONAC_ROOMS instead.
    """
    t = (room_type or "").lower()
    has_non = "non-ac" in t or "non ac" in t or "nonac" in t
    if has_non:
        return (_nonac_pool(), False)
    # AC only when the type actually says "AC" (e.g. "Premium AC"). A plain
    # "Premium" is the normal, non-AC product.
    is_ac = bool(re.search(r"\bac\b", t))
    if "premium" in t or is_ac:
        return (_ac_pool(), is_ac)
    # Unknown type → no auto-assign.
    return ([], False)


def _assign_room(bookings_ref, rooms_ref, check_in_date, check_out_date,
                 room_type, today_str, guest_count=1):
    """
    Pick an available physical room for an Agoda booking from its type's pool.

    Mirrors mmt_ingest_service._assign_room (same half-open overlap rule and
    same-day walk-in exclusion) but uses the Agoda AC/Non-AC pool mapping.
    Returns (room, is_ac, reason); room="" when nothing could be assigned.
    """
    from datetime import datetime as _dt
    pool, is_ac = _pool_and_ac_for_agoda_type(room_type)
    if not pool:
        # No pool for this type (unknown, or Non-AC pool not configured) →
        # leave unassigned. Flag only when we recognised the type but have no
        # pool to draw from, so the operator knows to assign manually.
        reason = ""
        if (room_type or "").strip():
            reason = f"auto-assign skipped: no room pool for type {room_type!r}"
        return ("", is_ac, reason)
    if not check_in_date or not check_out_date:
        return ("", is_ac, "auto-assign skipped: missing stay dates")
    try:
        ci = _dt.strptime(check_in_date, "%Y-%m-%d")
        co = _dt.strptime(check_out_date, "%Y-%m-%d")
    except ValueError:
        return ("", is_ac, "auto-assign skipped: unparsable stay dates")

    booked: set[str] = set()
    try:
        q = bookings_ref.where("check_out_date", ">=", check_in_date).stream()
        for d in q:
            b = d.to_dict() or {}
            if b.get("status") in ("cancelled", "checked_in", "checked_out"):
                continue
            try:
                bci = _dt.strptime(b.get("check_in_date", ""), "%Y-%m-%d")
                bco = _dt.strptime(b.get("check_out_date", ""), "%Y-%m-%d")
            except ValueError:
                continue
            if ci < bco and co > bci:  # half-open overlap
                booked.add(str(b.get("room", "")))
    except Exception as e:
        logger.warning(f"agoda_ingest: availability query failed: {e}")
        return ("", is_ac, "auto-assign skipped: availability check failed")

    if check_in_date == today_str:
        for room in pool:
            if room in booked:
                continue
            try:
                snap = rooms_ref.document(room).get()
                if snap.exists and (snap.to_dict() or {}).get("status") == "occupied":
                    booked.add(room)
            except Exception:
                pass

    for room in _agoda_ordered_candidates(pool, guest_count):
        if room not in booked:
            return (room, is_ac, "")
    return ("", is_ac, f"no {'AC' if is_ac else 'Non-AC'} room free "
                       f"({check_in_date}→{check_out_date})")


def _booking_exists_for(bookings_ref, agoda_booking_id: str) -> bool:
    if not agoda_booking_id:
        return False
    try:
        q = bookings_ref.where("agoda_booking_id", "==", agoda_booking_id).limit(1).stream()
        return any(True for _ in q)
    except Exception as e:
        logger.warning(f"agoda_ingest: dedupe query failed for {agoda_booking_id}: {e}")
        return False


# ---------------------------------------------------------------------------
# IMAP fetch (read-only)
# ---------------------------------------------------------------------------

def fetch_confirmations(cfg: dict, *, since_dt: datetime | None = None) -> list[dict]:
    """
    Connect to IMAP (read-only), find candidate Agoda emails since `since_dt`,
    and return a list of {kind, parsed/settlement, internaldate, message_id,
    subject}. Raises on connection/login failure so the caller can surface it.
    """
    if not is_configured(cfg):
        raise RuntimeError(
            "Agoda Gmail ingestion is not configured "
            "(set AGODA_GMAIL_USER / AGODA_GMAIL_APP_PASSWORD, "
            "or share the MMT inbox via MMT_GMAIL_*)"
        )

    if since_dt is None:
        since_dt = datetime.now() - timedelta(days=cfg.get("lookback_days", 14))

    results: list[dict] = []
    imap = imaplib.IMAP4_SSL(cfg["host"])
    try:
        imap.login(cfg["user"], cfg["password"])
        imap.select(cfg["folder"], readonly=True)

        since_str = since_dt.strftime("%d-%b-%Y")
        uids = set()
        senders = cfg.get("senders") or []
        if senders:
            for s in senders:
                typ, data = imap.search(None, "SINCE", since_str, "FROM", s)
                if typ == "OK" and data and data[0]:
                    uids.update(data[0].split())
        else:
            typ, data = imap.search(None, "SINCE", since_str)
            if typ == "OK" and data and data[0]:
                uids.update(data[0].split())

        basis = cfg.get("invoice_basis", "net")
        for uid in sorted(uids):
            try:
                typ, msg_data = imap.fetch(uid, "(RFC822)")
                if typ != "OK" or not msg_data or not msg_data[0]:
                    continue
                raw = msg_data[0][1]
                msg = email.message_from_bytes(raw)
                subject = _decode_subject(msg.get("Subject"))
                try:
                    internaldate = parsedate_to_datetime(msg.get("Date"))
                except Exception:
                    internaldate = None
                html_body = _extract_html_body(msg)

                text = html_to_text(html_body)
                if is_agoda_settlement(text):
                    results.append({
                        "kind": "settlement",
                        "settlement": {"subject": subject, "raw_text_len": len(text)},
                        "internaldate": internaldate,
                        "message_id": msg.get("Message-ID", ""),
                        "subject": subject,
                    })
                    continue
                parsed = parse_agoda_confirmation_html(
                    html_body, subject=subject, received_dt=internaldate)
                if parsed is None:
                    continue
                parsed["_invoice_basis"] = basis
                results.append({
                    "kind": "confirmation",
                    "parsed": parsed,
                    "internaldate": internaldate,
                    "message_id": msg.get("Message-ID", ""),
                    "subject": subject,
                })
            except Exception as e:
                logger.warning(f"agoda_ingest: failed to parse uid {uid}: {e}")
                continue
    finally:
        try:
            imap.close()
        except Exception:
            pass
        try:
            imap.logout()
        except Exception:
            pass
    return results


# ---------------------------------------------------------------------------
# Firestore-backed ingestion (idempotent)
# ---------------------------------------------------------------------------

def _get_refs():
    from config import (db, bookings_ref, settings_ref, rooms_ref, IST,
                        logger as cfg_logger)
    return db, bookings_ref, settings_ref, rooms_ref, IST, cfg_logger


def read_cursor(settings_ref):
    try:
        doc = settings_ref.document(_CURSOR_DOC).get()
        return doc.to_dict() if doc.exists else {}
    except Exception:
        return {}


def ingest(*, dry_run: bool = False, force_days: int | None = None) -> dict:
    """
    Main entry point used by the /agoda/ingest route + scheduler.

    Mirrors mmt_ingest_service.ingest: idempotent creation of Agoda bookings
    (source=agoda) for confirmation emails whose booking id is not already in
    Firestore, with room auto-assignment and a persisted cursor. Settlement
    emails are detected and counted but auto-settlement is deferred until the
    Agoda remittance-email format is supplied (see is_agoda_settlement).
    """
    import uuid
    cfg = load_config()
    summary = {
        "ota": "agoda",
        "configured": is_configured(cfg),
        "created": 0, "skipped_existing": 0, "skipped_past": 0, "needs_review": 0,
        "errors": 0, "scanned": 0, "created_ids": [], "messages": [],
        "settled": 0, "settle_skipped": 0, "settle_unmatched": 0, "settle_errors": 0,
        "settlement_emails_seen": 0,
        "dry_run": dry_run,
    }
    if not summary["configured"]:
        summary["messages"].append(
            "Not configured: set AGODA_GMAIL_USER/AGODA_GMAIL_APP_PASSWORD "
            "(or share the MMT inbox)."
        )
        return summary

    try:
        db, bookings_ref, settings_ref, rooms_ref, IST, _ = _get_refs()
    except Exception as e:
        summary["errors"] += 1
        summary["messages"].append(f"Firestore unavailable: {e}")
        return summary
    today_str = datetime.now(IST).strftime("%Y-%m-%d")

    cursor = read_cursor(settings_ref)
    since_dt = None
    if force_days and force_days > 0:
        since_dt = datetime.now() - timedelta(days=int(force_days))
        summary["messages"].append(f"Force re-scan: last {int(force_days)} day(s), cursor ignored")
    elif cursor.get("last_email_dt"):
        try:
            since_dt = datetime.fromisoformat(cursor["last_email_dt"]) - timedelta(days=1)
        except Exception:
            since_dt = None

    _floor = cfg.get("since_floor")
    if _floor:
        try:
            _floor_dt = datetime.strptime(_floor, "%Y-%m-%d")
            if since_dt is None or since_dt < _floor_dt:
                since_dt = _floor_dt
            summary["messages"].append(f"Scan floor: {_floor} (pre-go-live mail ignored)")
        except ValueError:
            pass

    try:
        items = fetch_confirmations(cfg, since_dt=since_dt)
    except Exception as e:
        summary["errors"] += 1
        summary["messages"].append(f"IMAP error: {e}")
        return summary

    summary["scanned"] = len(items)
    latest_email_dt = cursor.get("last_email_dt")

    def _track_cursor(v):
        nonlocal latest_email_dt
        if v.get("internaldate"):
            iso = v["internaldate"].astimezone().replace(tzinfo=None).isoformat()
            if latest_email_dt is None or iso > latest_email_dt:
                latest_email_dt = iso

    confirmations = [v for v in items if v.get("kind") == "confirmation"]
    settlements = [v for v in items if v.get("kind") == "settlement"]
    summary["settlement_emails_seen"] = len(settlements)
    seen_ids: set[str] = set()

    for v in confirmations:
        _track_cursor(v)
        parsed = v["parsed"]
        agoda_id = parsed.get("agoda_booking_id")
        if not agoda_id:
            summary["needs_review"] += 1
            summary["messages"].append(f"Skipped (no booking id): {v.get('subject','')[:60]}")
            continue
        if agoda_id in seen_ids:
            summary["skipped_existing"] += 1
            continue
        seen_ids.add(agoda_id)

        try:
            if _booking_exists_for(bookings_ref, agoda_id):
                summary["skipped_existing"] += 1
                continue

            booking = build_booking_from_agoda(parsed, now=datetime.now(IST))

            _ci = booking.get("check_in_date") or ""
            if _ci and _ci < today_str:
                summary["skipped_past"] += 1
                continue

            room, is_ac, assign_reason = _assign_room(
                bookings_ref, rooms_ref,
                booking.get("check_in_date"), booking.get("check_out_date"),
                booking.get("room_type", ""), today_str,
                booking.get("guest_count", 1),
            )
            if room:
                booking["room"] = room
                booking["is_ac"] = is_ac
                booking["room_assigned"] = True
            else:
                # Carry is_ac from the type even when unassigned (AC vs Non-AC).
                booking["is_ac"] = is_ac
                if assign_reason:
                    booking["needs_review"] = True
                    booking.setdefault("review_reasons", []).append(assign_reason)

            if booking.get("needs_review"):
                summary["needs_review"] += 1
                summary["messages"].append(
                    f"{agoda_id} needs review: "
                    f"{', '.join(booking.get('review_reasons') or [])} "
                    f"| guest={parsed.get('guest_name')!r} "
                    f"ci={parsed.get('check_in_date')!r} co={parsed.get('check_out_date')!r} "
                    f"net={parsed.get('agoda_net_rate')!r} sell={parsed.get('agoda_sell_rate')!r}"
                )

            _room_label = (
                f"room {booking['room']}{' AC' if booking.get('is_ac') else ''}"
                if booking.get("room_assigned") else "unassigned"
            )
            if dry_run:
                summary["created_ids"].append(
                    f"(dry-run) {agoda_id} → {_room_label} [{parsed.get('room_type') or '?'}]"
                )
                summary["created"] += 1
                continue

            booking_id = str(uuid.uuid4())
            booking["createdAt"] = datetime.now(IST).isoformat()
            booking["bookedBy"] = "agoda-gmail-ingest"
            booking["createdBy"] = "agoda-gmail-ingest"
            bookings_ref.document(booking_id).set(booking)
            summary["created"] += 1
            summary["created_ids"].append(booking_id)
            logger.info(
                f"agoda_ingest: created booking {booking_id} for Agoda {agoda_id} "
                f"({booking['guest_name']}, {booking['check_in_date']}, "
                f"review={booking['needs_review']})"
            )
        except Exception as e:
            summary["errors"] += 1
            summary["messages"].append(f"Create failed for {agoda_id}: {e}")
            logger.error(f"agoda_ingest: create failed for {agoda_id}: {e}", exc_info=True)

    if settlements:
        summary["messages"].append(
            f"{len(settlements)} Agoda settlement email(s) detected — auto-settle "
            f"not yet enabled (share a remittance email to enable). Use OTA "
            f"Settlements to mark these manually."
        )

    if not dry_run:
        try:
            settings_ref.document(_CURSOR_DOC).set({
                "last_email_dt": latest_email_dt,
                "last_run_at": datetime.now(IST).isoformat(),
                "last_run_summary": {
                    k: summary[k] for k in
                    ("created", "skipped_existing", "skipped_past", "needs_review",
                     "errors", "scanned", "settlement_emails_seen")
                },
            }, merge=True)
        except Exception as e:
            logger.warning(f"agoda_ingest: failed to persist cursor: {e}")

    if not dry_run and summary["created"] > 0:
        try:
            from config import invalidate_rooms_and_totals
            invalidate_rooms_and_totals()
        except Exception:
            pass

    return summary
