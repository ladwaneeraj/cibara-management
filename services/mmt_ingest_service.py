"""
MMT (MakeMyTrip / Go-MMT / MyBiz) hotelier-voucher Gmail ingestion.

Purpose
-------
Read MakeMyTrip "Hotelier Voucher" emails from a Gmail inbox over IMAP
(read-only), parse each voucher into a structured booking, and create a
matching booking document in Firestore so the stay shows up in the app
automatically — flagged with booking_source="mmt".

Design notes
------------
* Pure parsing is separated from I/O so it can be unit-tested offline.
  `parse_voucher_html(html)` and `build_booking_from_voucher(parsed)` do
  not touch IMAP, Firestore, or the network.
* IMAP access is READ-ONLY (EXAMINE, never STORE/DELETE). We never mutate
  the mailbox; de-duplication is done on the MMT booking id in Firestore,
  not on IMAP flags. This makes ingestion idempotent and safe to re-run.
* The room TYPE on a voucher (e.g. "Premium Rooms") is not a physical room
  number, so bookings are created UNASSIGNED (room=""). The operator picks
  the real room at check-in.
* Low-confidence parses are still created but stamped needs_review=True so
  nothing is silently dropped.

Configuration (environment variables)
-------------------------------------
    MMT_GMAIL_USER          Gmail address that receives MMT vouchers
    MMT_GMAIL_APP_PASSWORD  Google App Password (NOT the account password;
                            requires 2-Step Verification to generate)
    MMT_IMAP_HOST           default "imap.gmail.com"
    MMT_IMAP_FOLDER         default "INBOX"
    MMT_IMAP_SENDERS        comma-separated FROM filters; default
                            "makemytrip.com,go-mmt.com,goibibo.com"
    MMT_INGEST_SECRET       shared secret required by the /mmt/ingest route
    MMT_INGEST_LOOKBACK_DAYS  initial scan window on first run; default 14

Nothing here imports config.py at module load time — Firestore handles are
resolved lazily inside the I/O functions so importing this module is cheap
and side-effect free (keeps it unit-testable).
"""

from __future__ import annotations

import os
import re
import html as _html
import email
import imaplib
import logging
from datetime import datetime, timedelta
from email.header import decode_header
from email.utils import parsedate_to_datetime

logger = logging.getLogger(__name__)

# Firestore doc that stores the ingestion cursor + last-run stats.
_CURSOR_DOC = "mmt_ingest"

# GSTIN format check (Rule 46(b)). Kept local so the parser has no config dep.
_GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$")

_STATE_CODE_TO_NAME = {
    "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab",
    "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi",
    "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
    "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
    "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam",
    "19": "West Bengal", "20": "Jharkhand", "21": "Odisha",
    "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
    "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra",
    "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala",
    "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman and Nicobar Islands",
    "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
}


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def load_config() -> dict:
    """Read ingestion config from the environment. No secrets are logged."""
    senders = os.environ.get(
        "MMT_IMAP_SENDERS", "makemytrip.com,go-mmt.com,goibibo.com"
    )
    # Google displays App Passwords grouped as "abcd efgh ijkl mnop"; the
    # 16-char secret itself contains no spaces, so strip ALL whitespace to
    # make a copy-pasted value work whether or not the spaces were removed.
    _app_pw = os.environ.get("MMT_GMAIL_APP_PASSWORD", "")
    _app_pw = "".join(_app_pw.split())
    return {
        "user":      os.environ.get("MMT_GMAIL_USER", "").strip(),
        "password":  _app_pw,
        "host":      os.environ.get("MMT_IMAP_HOST", "imap.gmail.com").strip(),
        "folder":    os.environ.get("MMT_IMAP_FOLDER", "INBOX").strip(),
        "senders":   [s.strip().lower() for s in senders.split(",") if s.strip()],
        "lookback_days": int(os.environ.get("MMT_INGEST_LOOKBACK_DAYS", "14") or 14),
        # Go-live floor: never scan emails dated before this (YYYY-MM-DD).
        # Stops the first fetch / a force_days sweep from churning pre-go-live
        # mail. Defaults to 2026-06-01; override with MMT_INGEST_SINCE.
        "since_floor": os.environ.get("MMT_INGEST_SINCE", "2026-06-01").strip(),
    }


def is_configured(cfg: dict | None = None) -> bool:
    cfg = cfg or load_config()
    return bool(cfg.get("user") and cfg.get("password"))


# ---------------------------------------------------------------------------
# Pure parsing helpers (no I/O — unit-testable)
# ---------------------------------------------------------------------------

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"[ \t ]+")


def html_to_text(html: str) -> str:
    """
    Strip tags and normalise whitespace to a single flat string with single
    spaces. Block-ish tags are turned into spaces so adjacent label/value
    pairs don't get glued together. Good enough for label-based regex
    extraction of the MMT voucher; we deliberately avoid a heavyweight HTML
    parser dependency.
    """
    if not html:
        return ""
    # Drop script/style blocks entirely.
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", html)
    # Turn <br>, </td>, </tr>, </p>, </div> etc. into spaces.
    text = re.sub(r"(?i)<(br|/td|/tr|/p|/div|/h\d|/span|/table)[^>]*>", " ", text)
    text = _TAG_RE.sub(" ", text)
    text = _html.unescape(text)
    text = _WS_RE.sub(" ", text)
    # Collapse repeated spaces created across former line breaks.
    text = re.sub(r"\s{2,}", " ", text)
    return text.strip()


def _num(s: str | None):
    """Parse an Indian-rupee numeric token like '1,365.0' -> 1365.0."""
    if not s:
        return None
    s = s.replace(",", "").replace("₹", "").strip()
    try:
        return float(s)
    except ValueError:
        return None


def _validate_gstin(gstin: str | None) -> bool:
    if not gstin or not isinstance(gstin, str):
        return False
    return bool(_GSTIN_RE.match(gstin.strip().upper()))


def _state_from_gstin(gstin: str | None):
    if not _validate_gstin(gstin):
        return ("", "")
    code = gstin.strip()[:2]
    return (_STATE_CODE_TO_NAME.get(code, ""), code)


def _parse_mmt_date(date_str: str | None):
    """'31 May '26' -> '2026-05-31' (ISO). Returns None on failure."""
    if not date_str:
        return None
    s = date_str.strip().replace("’", "'")  # normalise curly apostrophe
    for fmt in ("%d %b '%y", "%d %b %Y", "%d %b'%y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return None


def _parse_mmt_time(time_str: str | None):
    """'12:00 PM' -> '12:00' (24h HH:MM). Returns None on failure."""
    if not time_str:
        return None
    s = time_str.strip().upper().replace(".", "")
    for fmt in ("%I:%M %p", "%I:%M%p", "%H:%M"):
        try:
            return datetime.strptime(s, fmt).strftime("%H:%M")
        except ValueError:
            continue
    return None


def _search(pattern: str, text: str, group: int = 1, flags=re.IGNORECASE):
    m = re.search(pattern, text, flags)
    if not m:
        return None
    try:
        return m.group(group).strip()
    except IndexError:
        return None


def is_settlement_email(text: str) -> bool:
    """True if the flattened text looks like an MMT payment/settlement email."""
    t = text or ""
    return bool(
        re.search(r"transferred into your bank account", t, re.IGNORECASE)
        or re.search(r"Transferred Details", t, re.IGNORECASE)
        or (re.search(r"Payable Details", t, re.IGNORECASE)
            and re.search(r"Total Amount Transferred", t, re.IGNORECASE))
    )


def _parse_ddmmyyyy(s: str | None):
    """'14/05/2026' -> '2026-05-14' (ISO). Returns None on failure."""
    if not s:
        return None
    try:
        return datetime.strptime(s.strip(), "%d/%m/%Y").strftime("%Y-%m-%d")
    except ValueError:
        return None


def _parse_any_date(s: str | None):
    """Parse a date token in any of the formats MMT uses; ISO out, else None."""
    if not s:
        return None
    s = s.strip().replace("’", "'")
    for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d", "%d %b %Y", "%d %B %Y",
                "%d-%b-%Y", "%d %b '%y", "%d %b'%y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    # Last resort: pull a dd/mm/yyyy substring out of a longer string.
    m = re.search(r"\d{1,2}/\d{1,2}/\d{4}", s)
    if m:
        try:
            return datetime.strptime(m.group(), "%d/%m/%Y").strftime("%Y-%m-%d")
        except ValueError:
            pass
    return None


def parse_settlement_email_html(html: str, *, subject: str = "", received_dt=None) -> dict | None:
    """
    Parse an MMT payment/settlement email into:
        {
          utr, txn_date (ISO), total_transferred, beneficiary, account_number,
          rows: [{mmt_booking_id, pnr, check_in, check_out, original_cost, payable}],
          needs_review, review_reasons
        }
    Returns None if the body is not a settlement email. One settlement email
    can pay out MULTIPLE bookings (the Payable Details table), so `rows` is a
    list. We settle by booking id + payable amount — the bank account shown in
    the email is irrelevant to matching (so a changed bank account is fine).
    Never raises.
    """
    text = html_to_text(html)
    if not text or not is_settlement_email(text):
        return None

    out: dict = {"subject": subject, "raw_text_len": len(text)}
    # Case-sensitive: a UTR is an uppercase alphanumeric ref (e.g.
    # HDFCH00999704706); matching case-insensitively can grab a stray word
    # like the bank name when the label is absent.
    out["utr"] = _search(r"Transaction No\.?\s*([A-Z0-9]{6,})", text, flags=0)
    out["txn_date"] = _parse_any_date(
        _search(r"Transaction Date\s+(.+?)\s+Transaction No", text)
        or _search(r"Transaction Date\s*([0-9A-Za-z/'\- ]{6,18})", text)
    )
    out["total_transferred"] = _num(
        _search(r"payment of\s*Rs\.?\s*([\d,]+\.?\d*)", text)
        or _search(r"Total Amount Transferred[^0-9]*([\d,]+\.?\d*)", text)
    )
    out["beneficiary"] = _search(r"Beneficiary Name\s+([A-Z][A-Za-z .]+?)\s+Account", text)
    out["account_number"] = _search(r"Account Number\s+(\d{6,})", text)

    # Per-booking rows from the Payable Details table. After the booking id +
    # PNR come the client/hotel/city (variable), then check-in, check-out, the
    # original cost and the payable amount. We capture the two trailing
    # amounts; the payable (what actually hit the bank for that booking) is the
    # SECOND one.
    # Booking ids are a 2-letter prefix + digits (NH = MakeMyTrip,
    # GH = Goibibo, etc.), so match the prefix generically.
    rows = []
    for m in re.finditer(
        r"([A-Z]{2}\d{6,})\s+(\d{4,})\s+.+?\s+"
        r"(\d{1,2}/\d{1,2}/\d{4})\s+(\d{1,2}/\d{1,2}/\d{4})\s+"
        r"([\d,]+\.\d{1,2})\s+([\d,]+\.\d{1,2})",
        text,
    ):
        rows.append({
            "mmt_booking_id": m.group(1),
            "pnr": m.group(2),
            "check_in": _parse_ddmmyyyy(m.group(3)),
            "check_out": _parse_ddmmyyyy(m.group(4)),
            "original_cost": _num(m.group(5)),
            "payable": _num(m.group(6)),
        })

    # Fallback: a single-booking email where the row regex didn't match but we
    # have exactly one booking id and a total — settle that one with the total.
    if not rows:
        ids = list(dict.fromkeys(re.findall(r"[A-Z]{2}\d{6,}", text)))
        if len(ids) == 1 and out.get("total_transferred"):
            rows.append({"mmt_booking_id": ids[0], "payable": out["total_transferred"]})

    out["rows"] = rows
    reasons = []
    if not rows:
        reasons.append("no booking rows parsed")
    if not out.get("txn_date"):
        reasons.append("no transaction date")
    out["needs_review"] = bool(reasons)
    out["review_reasons"] = reasons
    return out


def parse_voucher_html(html: str, *, subject: str = "", received_dt=None) -> dict | None:
    """
    Parse an MMT hotelier-voucher email body into a structured dict.

    Returns None if the body is clearly not an MMT voucher (no booking id
    AND no 'Hotelier Voucher' marker). Otherwise returns a dict with all
    fields it could extract, plus:
        needs_review : bool   — True when a critical field failed to parse
        review_reasons : list[str]
    Never raises on malformed input — unparsable fields are left None.
    """
    text = html_to_text(html)
    if not text:
        return None

    # A payment/settlement email ALSO contains "Booking ID", so it would
    # otherwise be mistaken for a voucher and create a junk booking. Reject
    # it here — settlement emails are handled by parse_settlement_email_html.
    if is_settlement_email(text):
        return None

    # Require the actual voucher structure, not just the words "Booking ID"
    # — otherwise waiver-request / reminder / promo emails (which mention a
    # booking id) get mistaken for vouchers and create junk rows.
    is_voucher = bool(
        re.search(r"Hotelier Voucher", text, re.IGNORECASE)
        or (re.search(r"\bBOOKING ID\b", text, re.IGNORECASE)
            and (re.search(r"CHECK[\s\-]?IN", text, re.IGNORECASE)
                 or re.search(r"PRIMARY GUEST", text, re.IGNORECASE)))
    )
    if not is_voucher:
        return None

    parsed: dict = {
        "subject": subject,
        "raw_text_len": len(text),
    }

    parsed["mmt_booking_id"] = _search(r"BOOKING ID\s*([A-Z]{2}\d{6,})", text)
    parsed["pnr"] = _search(r"\bPNR\b\s*([A-Z0-9]{6,})", text)

    # Guest name sits immediately after the section header. Capture the
    # name tokens up to the next known label keyword or the first digit —
    # robust to the variable DOM order of the surrounding voucher columns
    # (BOOKING ID / BOOKED ON / CHECK-IN can appear in different order in
    # the flattened text).
    guest = _search(
        r"PRIMARY GUEST DETAILS\s+([A-Z][A-Za-z.\-' ]+?)\s+"
        r"(?:CHECK|BOOKING|BOOKED|PNR|TOTAL|GUEST|PAYMENT|\d)",
        text,
    )
    if guest:
        guest = re.sub(r"\s{2,}", " ", guest).strip()
    parsed["guest_name"] = guest

    # MMT hotelier vouchers mask the guest phone; capture if ever present.
    parsed["guest_mobile"] = _search(r"(?:Mobile|Phone|Contact)\D{0,12}(\+?\d[\d\s\-]{7,13}\d)", text)

    # Check-in / check-out date + time.
    #
    # The dates appear in one of two layouts depending on the email's table
    # rendering: label-adjacent ("CHECK-IN <date> CHECK-OUT <date>") or
    # grouped ("CHECK-IN CHECK-OUT <date> <date>"). Relying on label
    # adjacency breaks the grouped layout (the check-out regex grabs the
    # check-in date). So instead we collect every "DD Mon 'YY" date token in
    # document order and drop the BOOKED ON one — the remaining two are
    # check-in then check-out. Other dates in the voucher (the cancellation
    # policy uses ISO "YYYY-MM-DD"; the room breakup uses "Mon DD, YYYY")
    # are in different formats and don't match this token, so they're ignored.
    _date_tok = r"\d{1,2}\s+[A-Za-z]{3}\s+['’]?\d{2}"
    _time_tok = r"\d{1,2}:\d{2}\s*[AP]M"

    all_dates = re.findall(_date_tok, text, re.IGNORECASE)
    booked_on_date = _search(r"BOOKED ON\s+(" + _date_tok + r")", text)
    stay_dates = list(all_dates)
    if booked_on_date and booked_on_date in stay_dates:
        stay_dates.remove(booked_on_date)
    ci_date = stay_dates[0] if len(stay_dates) >= 1 else None
    co_date = stay_dates[1] if len(stay_dates) >= 2 else None

    all_times = re.findall(_time_tok, text, re.IGNORECASE)
    booked_on_time = _search(
        r"BOOKED ON\s+" + _date_tok + r"\s+(" + _time_tok + r")", text)
    stay_times = list(all_times)
    if booked_on_time and booked_on_time in stay_times:
        stay_times.remove(booked_on_time)
    ci_time = stay_times[0] if len(stay_times) >= 1 else None
    co_time = stay_times[1] if len(stay_times) >= 2 else None

    nights = _search(r"\((\d+)\s*Night", text)

    parsed["check_in_date"] = _parse_mmt_date(ci_date)
    parsed["check_in_time"] = _parse_mmt_time(ci_time) or "12:00"
    parsed["check_out_date"] = _parse_mmt_date(co_date)
    parsed["check_out_time"] = _parse_mmt_time(co_time) or "12:00"
    parsed["nights"] = int(nights) if nights else None

    # Guest count ("1 Adult").
    adults = _search(r"TOTAL NO\.?\s*OF GUEST\(?S?\)?\s+(\d+)\s*Adult", text)
    parsed["guest_count"] = int(adults) if adults else 1

    # Room type ("1 x Premium Rooms").
    qty = _search(r"(\d+)\s*[xX]\s*[A-Za-z][A-Za-z ]*Rooms?", text)
    rtype = _search(r"\d+\s*[xX]\s*([A-Za-z][A-Za-z ]*Rooms?)", text)
    parsed["room_qty"] = int(qty) if qty else 1
    parsed["room_type"] = rtype.strip() if rtype else None

    parsed["booked_via"] = _search(r"BOOKED VIA\s+([A-Za-z]+)", text)
    parsed["booking_status"] = _search(r"BOOKING STATUS\s+([A-Za-z]+)", text)
    parsed["payment_status"] = _search(r"PAYMENT STATUS\s+([A-Za-z ]+?)\s+BOOKED", text)

    # Layout-independent cancellation flag. A two-column voucher can render
    # as "LABEL value LABEL value" OR "LABEL LABEL value value" once flattened
    # to text, so relying on booking_status alone can miss a cancel. A cancelled
    # voucher uniquely carries a "CANCELLED ON <date>" field (never present on a
    # confirmed one) — match that too, plus the adjacent-token form.
    _up = (text or "").upper()
    parsed["is_cancelled"] = bool(
        (parsed.get("booking_status") or "").strip().upper() == "CANCELLED"
        or re.search(r"CANCELLED\s+ON\s", _up)
        or re.search(r"BOOKING\s+STATUS\s+CANCELLED", _up)
    )

    # ── GST: property + customer (B2B) ────────────────────────────────────
    parsed["property_gstin"] = _search(r"PROPERTY GSTN\s*([0-9A-Z]{15})", text)
    parsed["customer_gstin"] = _search(r"COMPANY GSTN\s*([0-9A-Z]{15})", text)
    parsed["customer_name"] = _search(r"COMPANY NAME\s+(.+?)\s+COMPANY ADDRESS", text)
    parsed["customer_address"] = _search(r"COMPANY ADDRESS\s+(.+?)\s+COMPANY GSTN", text)

    # ── Money ─────────────────────────────────────────────────────────────
    parsed["invoice_amount"] = _num(_search(r"INVOICE AMOUNT\s*₹?\s*([\d,]+\.?\d*)", text))
    parsed["room_charges"] = _num(_search(r"Room Charges\D{0,6}₹?\s*([\d,]+\.?\d*)", text))
    parsed["property_taxes"] = _num(_search(r"Property Taxes\D{0,6}₹?\s*([\d,]+\.?\d*)", text))
    parsed["payable_to_property"] = _num(_search(r"Payable to Property\s*\(?[A-Z0-9\-+ ]*\)?\s*₹?\s*([\d,]+\.?\d*)", text))
    parsed["property_gross_charges"] = _num(_search(r"Property Gross Charges\s*₹?\s*([\d,]+\.?\d*)", text))

    # Commission (incl GST) from the "(B)" summary line; GST-on-commission
    # from its own line. Commission-excl-GST is derived.
    comm_incl = _num(_search(r"Go-?MMT Commission \(including GST\)[^₹]*₹?\s*([\d,]+\.?\d*)", text))
    comm_gst = _num(_search(r"GST on Commission[^₹]*₹?\s*([\d,]+\.?\d*)", text))
    if comm_incl is None:
        # Fall back to the room-wise breakup "Commission (...inclusive...)" column.
        comm_incl = _num(_search(r"Commission\s*\(\*?inclusive of\s*taxes\)\s*\(C\)\D*([\d,]+\.?\d*)", text))
    parsed["commission_incl_gst"] = comm_incl
    parsed["commission_gst"] = comm_gst
    if comm_incl is not None and comm_gst is not None:
        parsed["commission"] = round(comm_incl - comm_gst, 2)
    else:
        parsed["commission"] = _num(_search(r"Go-?MMT Commission\b(?!\s*\(|\s*@)\D*₹?\s*([\d,]+\.?\d*)", text))

    parsed["tcs_amount"] = _num(_search(r"\bTCS\b[^₹]*₹?\s*([\d,]+\.?\d*)", text))
    parsed["tds_amount"] = _num(_search(r"\bTDS\b[^₹]*₹?\s*([\d,]+\.?\d*)", text))

    # ── Confidence / review flags ─────────────────────────────────────────
    reasons = []
    if not parsed.get("mmt_booking_id"):
        reasons.append("missing booking id")
    if not parsed.get("guest_name"):
        reasons.append("missing guest name")
    if not parsed.get("check_in_date"):
        reasons.append("unparsable check-in date")
    if not parsed.get("check_out_date"):
        reasons.append("unparsable check-out date")
    if parsed.get("invoice_amount") is None and parsed.get("property_gross_charges") is None:
        reasons.append("missing invoice amount")
    parsed["needs_review"] = bool(reasons)
    parsed["review_reasons"] = reasons
    return parsed


def build_booking_from_voucher(parsed: dict, *, now=None) -> dict:
    """
    Map a parsed voucher into a Firestore booking document matching the
    shape produced by routes.bookings.create_booking, plus MMT/OTA/B2B
    fields. Room is left UNASSIGNED — the operator picks it at check-in.

    The B2B recipient fields are pre-populated from the voucher's customer
    GSTIN so the checkout tax invoice is correctly classified for GSTR-1
    without manual data entry.
    """
    now = now or datetime.now()

    ota_total = int(round(parsed.get("invoice_amount")
                          or parsed.get("property_gross_charges") or 0))
    commission = float(parsed.get("commission") or 0.0)
    commission_gst = float(parsed.get("commission_gst") or 0.0)
    tcs = float(parsed.get("tcs_amount") or 0.0)
    tds = float(parsed.get("tds_amount") or 0.0)

    # net_receivable = what actually lands in the hotel's bank.
    # Prefer the voucher's "Payable to Property" (already net of commission,
    # commission-GST, TCS and TDS). Fall back to the arithmetic if absent.
    payable = parsed.get("payable_to_property")
    if payable is not None:
        net_receivable = round(float(payable), 2)
    else:
        net_receivable = round(ota_total - commission - commission_gst - tcs - tds, 2)

    cust_gstin = (parsed.get("customer_gstin") or "").strip().upper()
    is_b2b = _validate_gstin(cust_gstin)
    state_name, state_code = _state_from_gstin(cust_gstin) if is_b2b else ("", "")

    booking = {
        # ── Core booking fields (mirror create_booking) ──────────────────
        "room": "",                       # UNASSIGNED until check-in
        "room_assigned": False,
        "guest_name": (parsed.get("guest_name") or "MMT Guest").strip(),
        "guest_mobile": (parsed.get("guest_mobile") or "").strip(),
        "booking_date": now.strftime("%Y-%m-%d"),
        "check_in_date": parsed.get("check_in_date") or "",
        "check_in_time": parsed.get("check_in_time") or "12:00",
        "check_out_date": parsed.get("check_out_date") or "",
        "status": "confirmed",
        "booking_source": "mmt",
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

        # ── OTA settlement fields ────────────────────────────────────────
        "ota_total_amount": ota_total,
        "ota_commission": commission,
        "ota_commission_gst": commission_gst,
        "net_receivable": net_receivable,
        "tcs_amount": tcs,
        "tds_amount": tds,
        "settlement_status": "pending",
        "settlement_date": None,
        "settlement_amount": None,

        # ── MMT identifiers / provenance ─────────────────────────────────
        "mmt_booking_id": parsed.get("mmt_booking_id") or "",
        "pnr": parsed.get("pnr") or "",
        "room_type": parsed.get("room_type") or "",
        "property_gstin": parsed.get("property_gstin") or "",
        "ingest_source": "gmail",
        "needs_review": bool(parsed.get("needs_review")),
        "review_reasons": parsed.get("review_reasons") or [],

        # ── B2B recipient (pre-filled for GSTR-1) ────────────────────────
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
    if parsed.get("mmt_booking_id"):
        bits.append(f"MMT {parsed['mmt_booking_id']}")
    if parsed.get("pnr"):
        bits.append(f"PNR {parsed['pnr']}")
    if parsed.get("room_type"):
        bits.append(f"{parsed.get('room_qty', 1)} x {parsed['room_type']}")
    if parsed.get("booked_via"):
        bits.append(f"via {parsed['booked_via']}")
    if parsed.get("nights"):
        bits.append(f"{parsed['nights']} night(s)")
    return " | ".join(bits)


# ---------------------------------------------------------------------------
# IMAP fetch (read-only)
# ---------------------------------------------------------------------------

def _decode_subject(raw) -> str:
    if not raw:
        return ""
    try:
        parts = decode_header(raw)
        out = ""
        for txt, enc in parts:
            if isinstance(txt, bytes):
                out += txt.decode(enc or "utf-8", errors="replace")
            else:
                out += txt
        return out
    except Exception:
        return str(raw)


def _extract_html_body(msg) -> str:
    """Return the text/html part (preferred) or text/plain fallback."""
    html_body, text_body = "", ""
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            disp = str(part.get("Content-Disposition") or "")
            if "attachment" in disp.lower():
                continue
            try:
                payload = part.get_payload(decode=True)
                if payload is None:
                    continue
                charset = part.get_content_charset() or "utf-8"
                decoded = payload.decode(charset, errors="replace")
            except Exception:
                continue
            if ctype == "text/html":
                html_body += decoded
            elif ctype == "text/plain":
                text_body += decoded
    else:
        try:
            payload = msg.get_payload(decode=True)
            charset = msg.get_content_charset() or "utf-8"
            decoded = payload.decode(charset, errors="replace") if payload else ""
        except Exception:
            decoded = ""
        if msg.get_content_type() == "text/html":
            html_body = decoded
        else:
            text_body = decoded
    return html_body or text_body


def fetch_vouchers(cfg: dict, *, since_dt: datetime | None = None) -> list[dict]:
    """
    Connect to IMAP (read-only), find candidate MMT emails since `since_dt`,
    and return a list of {parsed, internaldate, message_id, subject}.

    Raises on connection/login failure so the caller can surface it.
    """
    if not is_configured(cfg):
        raise RuntimeError("MMT Gmail ingestion is not configured (set MMT_GMAIL_USER / MMT_GMAIL_APP_PASSWORD)")

    if since_dt is None:
        since_dt = datetime.now() - timedelta(days=cfg.get("lookback_days", 14))

    results: list[dict] = []
    imap = imaplib.IMAP4_SSL(cfg["host"])
    try:
        imap.login(cfg["user"], cfg["password"])
        # EXAMINE = read-only select; never marks mail as read.
        imap.select(cfg["folder"], readonly=True)

        since_str = since_dt.strftime("%d-%b-%Y")
        # Build an OR-of-senders SINCE query. IMAP SEARCH OR is binary, so
        # nest for >2 senders. Fall back to a plain SINCE if no senders.
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
                # Classify: settlement email first (it also contains "Booking
                # ID" and must not be parsed as a voucher), then voucher.
                settlement = parse_settlement_email_html(
                    html_body, subject=subject, received_dt=internaldate)
                if settlement is not None:
                    results.append({
                        "kind": "settlement",
                        "settlement": settlement,
                        "internaldate": internaldate,
                        "message_id": msg.get("Message-ID", ""),
                        "subject": subject,
                    })
                    continue
                parsed = parse_voucher_html(html_body, subject=subject, received_dt=internaldate)
                if parsed is None:
                    continue
                results.append({
                    "kind": "voucher",
                    "parsed": parsed,
                    "internaldate": internaldate,
                    "message_id": msg.get("Message-ID", ""),
                    "subject": subject,
                })
            except Exception as e:
                logger.warning(f"mmt_ingest: failed to parse uid {uid}: {e}")
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
    """Lazily resolve Firestore handles from config (avoids import cycles)."""
    from config import (db, bookings_ref, settings_ref, rooms_ref, IST,
                        logger as cfg_logger)
    return db, bookings_ref, settings_ref, rooms_ref, IST, cfg_logger


# ---------------------------------------------------------------------------
# Room auto-assignment from the voucher's room TYPE
# ---------------------------------------------------------------------------
# An MMT voucher carries a room TYPE (e.g. "Premium Rooms" / "Premium AC
# Rooms"), not a physical room number. Both Premium variants draw from the
# AC-capable block 200–206; the "AC" variant simply turns is_ac on. We pick
# the lowest-numbered room in the block that is free for the stay dates, and
# leave the booking unassigned (flagged for review) if the whole block is
# taken — so an MMT booking can never silently double-book a room.
#
# Override the pool with MMT_PREMIUM_ROOMS (comma-separated) if the room
# numbering changes.

def _premium_pool() -> list[str]:
    raw = os.environ.get("MMT_PREMIUM_ROOMS", "200,201,202,203,204,205,206")
    return [r.strip() for r in raw.split(",") if r.strip()]


# Guest-count-based room preference. Doubles (<=2 guests) are steered to one
# set of rooms, triples-and-larger (>=3) to another, so families/groups land
# in the bigger rooms and couples in the smaller ones. Both are overridable by
# env so the numbering can change without a code edit:
#   $env:MMT_DOUBLE_ROOMS = "200,201,206"
#   $env:MMT_TRIPLE_ROOMS = "203,204,205"
# Any pool room not listed in the matching set (e.g. 202) is still usable — it
# just comes AFTER the preferred set, as overflow ("think and assign").
_TRIPLE_GUEST_THRESHOLD = 3


def _preferred_rooms(guest_count) -> list[str]:
    try:
        gc = int(guest_count or 0)
    except (TypeError, ValueError):
        gc = 0
    if gc >= _TRIPLE_GUEST_THRESHOLD:
        raw = os.environ.get("MMT_TRIPLE_ROOMS", "203,204,205")
    else:
        # <=2 guests (and unknown/1) are treated as a double.
        raw = os.environ.get("MMT_DOUBLE_ROOMS", "200,201,206")
    return [r.strip() for r in raw.split(",") if r.strip()]


def _ordered_candidates(pool: list[str], guest_count) -> list[str]:
    """
    Reorder the room pool by guest-count preference: the preferred rooms first
    (in their configured order), then every other pool room as overflow. Only
    rooms actually present in `pool` are returned, so a stale preference entry
    can never invent a non-existent room.
    """
    pref = _preferred_rooms(guest_count)
    ordered: list[str] = []
    seen: set[str] = set()
    for r in pref:
        if r in pool and r not in seen:
            ordered.append(r)
            seen.add(r)
    for r in pool:                      # remaining pool rooms = overflow
        if r not in seen:
            ordered.append(r)
            seen.add(r)
    return ordered


def _pool_and_ac_for_type(room_type: str):
    """
    Return (pool, is_ac) for a voucher room type, or ([], False).

    Rooms 200–206 are the hotel's AC-capable block, sold on MMT as both
    "Premium Rooms" and "AC Room" (and "Premium AC"). All of these draw from
    that block; the AC variants flip is_ac on. An explicit "Non-AC" type is
    NOT auto-assigned (left for the operator). Override the pool with
    MMT_PREMIUM_ROOMS.
    """
    t = (room_type or "").lower()
    has_non = "non-ac" in t or "non ac" in t
    is_ac = bool(re.search(r"\bac\b", t)) and not has_non
    if "premium" in t or is_ac:
        return (_premium_pool(), is_ac)
    return ([], False)


def _assign_room(bookings_ref, rooms_ref, check_in_date, check_out_date,
                 room_type, today_str, guest_count=1):
    """
    Pick an available physical room for an MMT booking from its type's pool.

    Rooms are tried in guest-count preference order (see _ordered_candidates):
    doubles (<=2 guests) prefer 200/201/206, triples-and-up (>=3) prefer
    203/204/205, then any remaining pool room as overflow. So a group lands in
    a larger room when one is free, but the booking is still auto-assigned from
    the overflow rather than left unassigned when the preferred set is full.

    Returns (room, is_ac, reason). `room` is "" when nothing could be
    assigned (no pool for the type, missing/invalid dates, or the whole pool
    is booked) — `reason` then explains why. Availability mirrors the
    /check_availability overlap rule: a pool room is unavailable if a
    non-cancelled booking overlaps [check_in, check_out), or (only when the
    stay starts today) the room is currently occupied by a walk-in.
    """
    from datetime import datetime as _dt
    pool, is_ac = _pool_and_ac_for_type(room_type)
    if not pool:
        return ("", is_ac, "")  # not a premium type — leave unassigned, no flag
    if not check_in_date or not check_out_date:
        return ("", is_ac, "auto-assign skipped: missing stay dates")
    try:
        ci = _dt.strptime(check_in_date, "%Y-%m-%d")
        co = _dt.strptime(check_out_date, "%Y-%m-%d")
    except ValueError:
        return ("", is_ac, "auto-assign skipped: unparsable stay dates")

    booked: set[str] = set()
    try:
        # Single inequality (check_out_date >= our check_in) keeps the query
        # index-simple; the precise overlap is filtered in Python.
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
        logger.warning(f"mmt_ingest: availability query failed: {e}")
        return ("", is_ac, "auto-assign skipped: availability check failed")

    # Same-day arrival: also exclude pool rooms occupied right now by a
    # walk-in (which has no future booking to catch above).
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

    for room in _ordered_candidates(pool, guest_count):
        if room not in booked:
            return (room, is_ac, "")
    return ("", is_ac, f"no {'Premium AC' if is_ac else 'Premium'} room free "
                       f"({check_in_date}→{check_out_date})")


def _booking_exists_for(bookings_ref, mmt_booking_id: str) -> bool:
    if not mmt_booking_id:
        return False
    try:
        q = bookings_ref.where("mmt_booking_id", "==", mmt_booking_id).limit(1).stream()
        return any(True for _ in q)
    except Exception as e:
        logger.warning(f"mmt_ingest: dedupe query failed for {mmt_booking_id}: {e}")
        return False


def _cancel_bookings_for(bookings_ref, mmt_booking_id: str, *, dry_run: bool = False) -> int:
    """
    Flip every app booking matching this MMT id to status='cancelled', UNLESS it
    was already cancelled or already consumed (checked_in / checked_out — a stay
    that already started is never silently undone here; a human handles that).

    A cancelled booking stops blocking room availability automatically (the
    overlap / room-assignment checks already skip status='cancelled'), so the
    held room frees up for those dates with no extra work.

    Returns the number of bookings actually cancelled.
    """
    if not mmt_booking_id:
        return 0
    n = 0
    try:
        for d in bookings_ref.where("mmt_booking_id", "==", mmt_booking_id).stream():
            data = d.to_dict() or {}
            st = (data.get("status") or "").strip().lower()
            if st in ("cancelled", "checked_in", "checked_out"):
                continue  # already cancelled, or the stay was already consumed
            if dry_run:
                n += 1
                continue
            _now = datetime.now(IST).isoformat()
            d.reference.update({
                "status": "cancelled",
                "cancelled_at": _now,
                "cancel_reason": "MMT cancellation (auto-ingest)",
                "cancelledBy": "mmt-gmail-ingest",
                "lastModifiedBy": "mmt-gmail-ingest",
                "lastModifiedAt": _now,
            })
            n += 1
            logger.info(f"mmt_ingest: cancelled app booking {d.id} for MMT {mmt_booking_id}")
    except Exception as e:
        logger.warning(f"mmt_ingest: cancel query failed for {mmt_booking_id}: {e}")
    return n


def read_cursor(settings_ref):
    try:
        doc = settings_ref.document(_CURSOR_DOC).get()
        return doc.to_dict() if doc.exists else {}
    except Exception:
        return {}


def _process_settlement(settlement, bookings_ref, summary, dry_run, seen_ids=None):
    """
    Auto-settle each booking row in a parsed MMT settlement email by matching
    on mmt_booking_id and calling apply_ota_settlement (the same core the
    manual route uses) with the row's payable amount. Idempotent: bookings
    already marked received are skipped. Matching is by booking id only, so a
    changed bank account on the email is irrelevant.
    """
    # Lazy import to avoid an import cycle (routes.bookings imports config,
    # which imports services). Safe at call time.
    from routes.bookings import apply_ota_settlement

    rows = settlement.get("rows") or []
    txn_date = settlement.get("txn_date")
    utr = settlement.get("utr") or ""
    if not rows:
        summary["settle_errors"] += 1
        summary["messages"].append(
            f"Settlement email (UTR {utr or '?'}): no booking rows parsed"
        )
        return

    from datetime import datetime as _dt
    _today = _dt.now().strftime("%Y-%m-%d")

    for r in rows:
        mmt_id = r.get("mmt_booking_id")
        payable = r.get("payable")
        if not mmt_id or not payable:
            summary["settle_errors"] += 1
            continue

        # Settlement date priority: the email's parsed transaction date →
        # this booking's check-out date (close to the actual payout, and
        # always present since the row parsed) → today as a last resort.
        # Never silently stamp "today" on a historical payout.
        sdate = txn_date or r.get("check_out") or _today

        doc_id, bk = None, None
        try:
            for d in bookings_ref.where("mmt_booking_id", "==", mmt_id).limit(1).stream():
                doc_id, bk = d.id, d.to_dict()
        except Exception as e:
            summary["settle_errors"] += 1
            summary["messages"].append(f"{mmt_id}: settlement lookup failed: {e}")
            continue

        if not doc_id:
            # In a dry-run no bookings were written, so a voucher seen earlier
            # in this same run won't be in the DB yet — treat it as matchable
            # for an accurate preview.
            if dry_run and seen_ids and mmt_id in seen_ids:
                summary["settled"] += 1
                summary["messages"].append(
                    f"(dry-run) would settle {mmt_id} ₹{payable} on {sdate}"
                )
                continue
            summary["settle_unmatched"] += 1
            summary["messages"].append(
                f"{mmt_id}: no matching booking to settle (₹{payable}) — "
                f"voucher may not be ingested yet"
            )
            continue
        if bk and bk.get("settlement_status") == "received":
            summary["settle_skipped"] += 1
            continue
        if dry_run:
            summary["settled"] += 1
            summary["messages"].append(
                f"(dry-run) would settle {mmt_id} ₹{payable} on {sdate}"
            )
            continue

        res = apply_ota_settlement(doc_id, sdate, payable, utr=utr, source="email")
        if res.get("ok") and not res.get("already"):
            summary["settled"] += 1
        elif res.get("already"):
            summary["settle_skipped"] += 1
        else:
            summary["settle_errors"] += 1
            summary["messages"].append(f"{mmt_id}: settle failed: {res.get('message')}")


def ingest(*, dry_run: bool = False, force_days: int | None = None) -> dict:
    """
    Main entry point used by the route + scheduler.

    force_days : when given, scan the last N days of mail and IGNORE the stored
        cursor watermark. Use this to re-scan older mail (e.g. to pick up a
        settlement email that predates the last processed voucher, or to
        recover a missed one). Idempotent, so re-scanning is always safe.

    Steps:
      1. Load config; bail clearly if not configured.
      2. Determine `since` from the stored cursor (or lookback window).
      3. Fetch + parse candidate vouchers over IMAP.
      4. For each parsed voucher with a booking id not already in Firestore,
         create a booking (source=mmt, room unassigned). Idempotent.
      5. Persist a new cursor + run stats.

    Returns a summary dict (safe to JSON-serialise).
    """
    import uuid
    cfg = load_config()
    summary = {
        "configured": is_configured(cfg),
        "created": 0, "cancelled": 0, "skipped_existing": 0, "skipped_past": 0, "needs_review": 0,
        "errors": 0, "scanned": 0, "created_ids": [], "messages": [],
        # Settlement-email outcomes (separate from booking creation).
        "settled": 0, "settle_skipped": 0, "settle_unmatched": 0,
        "settle_errors": 0,
        "dry_run": dry_run,
    }
    if not summary["configured"]:
        summary["messages"].append(
            "Not configured: set MMT_GMAIL_USER and MMT_GMAIL_APP_PASSWORD."
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
        # Explicit re-scan window — ignore the cursor entirely.
        since_dt = datetime.now() - timedelta(days=int(force_days))
        summary["messages"].append(f"Force re-scan: last {int(force_days)} day(s), cursor ignored")
    elif cursor.get("last_email_dt"):
        try:
            since_dt = datetime.fromisoformat(cursor["last_email_dt"])
            # Re-scan a small overlap so a same-second arrival isn't missed.
            since_dt = since_dt - timedelta(days=1)
        except Exception:
            since_dt = None

    # Clamp the scan window to the go-live floor (default 2026-06-01): never
    # look at mail older than this, so pre-go-live emails are ignored entirely
    # (no old vouchers/settlements churned). Applies to first-run lookback AND
    # a force_days sweep.
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
        vouchers = fetch_vouchers(cfg, since_dt=since_dt)
    except Exception as e:
        summary["errors"] += 1
        summary["messages"].append(f"IMAP error: {e}")
        return summary

    summary["scanned"] = len(vouchers)
    latest_email_dt = cursor.get("last_email_dt")

    def _track_cursor(v):
        nonlocal latest_email_dt
        if v.get("internaldate"):
            iso = v["internaldate"].astimezone().replace(tzinfo=None).isoformat()
            if latest_email_dt is None or iso > latest_email_dt:
                latest_email_dt = iso

    # Two passes so settlements always run AFTER bookings exist: create the
    # vouchers' bookings first, then process settlement emails — otherwise a
    # settlement that appears earlier in the mailbox than its voucher would
    # report "unmatched" within the same run.
    voucher_items = [v for v in vouchers if v.get("kind") != "settlement"]
    settlement_items = [v for v in vouchers if v.get("kind") == "settlement"]
    seen_ids: set[str] = set()  # in-run dedup (amendment/reminder re-sends)

    for v in voucher_items:
        _track_cursor(v)

        parsed = v["parsed"]
        mmt_id = parsed.get("mmt_booking_id")
        if not mmt_id:
            summary["needs_review"] += 1
            summary["messages"].append(f"Skipped (no booking id): {v.get('subject','')[:60]}")
            continue

        # In-run dedup: the same booking can arrive via multiple emails
        # (original + amendment + reminder). Process the first, skip repeats —
        # belt-and-braces alongside the Firestore existence check (which can
        # lag on read-after-write within a single batch).
        if mmt_id in seen_ids:
            summary["skipped_existing"] += 1
            continue
        seen_ids.add(mmt_id)

        try:
            # ── MMT cancellation ─────────────────────────────────────────
            # A cancelled voucher (BOOKING STATUS: CANCELLED) must flip the
            # matching app booking to cancelled, NOT be skipped as "existing".
            _bstatus = (parsed.get("booking_status") or "").strip().lower()
            if parsed.get("is_cancelled") or _bstatus in ("cancelled", "canceled"):
                _cn = _cancel_bookings_for(bookings_ref, mmt_id, dry_run=dry_run)
                if _cn:
                    summary["cancelled"] = summary.get("cancelled", 0) + _cn
                    summary["messages"].append(
                        f"{mmt_id}: cancelled {_cn} booking(s) in app (MMT cancellation)"
                    )
                else:
                    # Nothing to cancel (never ingested, already cancelled, or
                    # the stay was already checked in/out).
                    summary["skipped_existing"] += 1
                continue

            if _booking_exists_for(bookings_ref, mmt_id):
                summary["skipped_existing"] += 1
                continue

            booking = build_booking_from_voucher(parsed, now=datetime.now(IST))

            # Only ingest CURRENT/FUTURE bookings — skip vouchers whose
            # check-in is already in the past (today is included). A voucher
            # for a stay that already happened shouldn't become an "upcoming"
            # booking; this also stops a force_days backlog sweep from pulling
            # in historical test/old vouchers. Bookings with an unparsable
            # date (check_in_date == "") are NOT skipped — they're let through
            # flagged so nothing is silently dropped.
            _ci = booking.get("check_in_date") or ""
            if _ci and _ci < today_str:
                summary["skipped_past"] += 1
                continue

            # Auto-assign a physical room from the type's pool (Premium /
            # Premium AC → 200–206) based on availability for the stay dates.
            # Leaves the booking unassigned + flagged if the block is full.
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
            elif assign_reason:
                booking["needs_review"] = True
                booking.setdefault("review_reasons", []).append(assign_reason)

            if booking.get("needs_review"):
                summary["needs_review"] += 1
                # Surface WHICH critical fields failed to parse so the
                # operator (and we) can see exactly what to fix, plus a peek
                # at the values that DID parse for quick diagnosis.
                summary["messages"].append(
                    f"{mmt_id} needs review: "
                    f"{', '.join(booking.get('review_reasons') or [])} "
                    f"| guest={parsed.get('guest_name')!r} "
                    f"ci={parsed.get('check_in_date')!r} "
                    f"co={parsed.get('check_out_date')!r} "
                    f"inv={parsed.get('invoice_amount')!r} "
                    f"gstin={parsed.get('customer_gstin')!r}"
                )

            _room_label = (
                f"room {booking['room']}{' AC' if booking.get('is_ac') else ''}"
                if booking.get("room_assigned") else "unassigned"
            )
            if dry_run:
                summary["created_ids"].append(
                    f"(dry-run) {mmt_id} → {_room_label} "
                    f"[{parsed.get('room_type') or '?'}]"
                )
                summary["created"] += 1
                continue

            booking_id = str(uuid.uuid4())
            booking["createdAt"] = datetime.now(IST).isoformat()
            booking["bookedBy"] = "mmt-gmail-ingest"
            booking["createdBy"] = "mmt-gmail-ingest"
            bookings_ref.document(booking_id).set(booking)
            summary["created"] += 1
            summary["created_ids"].append(booking_id)
            logger.info(
                f"mmt_ingest: created booking {booking_id} for MMT {mmt_id} "
                f"({booking['guest_name']}, {booking['check_in_date']}, "
                f"review={booking['needs_review']})"
            )
        except Exception as e:
            summary["errors"] += 1
            summary["messages"].append(f"Create failed for {mmt_id}: {e}")
            logger.error(f"mmt_ingest: create failed for {mmt_id}: {e}", exc_info=True)

    # ── Second pass: settlement emails (bookings now exist) ─────────────────
    for v in settlement_items:
        _track_cursor(v)
        _process_settlement(v["settlement"], bookings_ref, summary, dry_run,
                            seen_ids=seen_ids)

    # Persist cursor + stats (best-effort).
    if not dry_run:
        try:
            settings_ref.document(_CURSOR_DOC).set({
                "last_email_dt": latest_email_dt,
                "last_run_at": datetime.now(IST).isoformat(),
                "last_run_summary": {
                    k: summary[k] for k in
                    ("created", "skipped_existing", "skipped_past", "needs_review",
                     "errors", "scanned", "settled", "settle_skipped",
                     "settle_unmatched", "settle_errors")
                },
            }, merge=True)
        except Exception as e:
            logger.warning(f"mmt_ingest: failed to persist cursor: {e}")

    # Invalidate the rooms/totals cache so new bookings / settlements show.
    if not dry_run and (summary["created"] > 0 or summary["settled"] > 0):
        try:
            from config import invalidate_rooms_and_totals
            invalidate_rooms_and_totals()
        except Exception:
            pass

    return summary
