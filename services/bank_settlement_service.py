"""
Bank payment-advice settlement ingestion (MMT + Agoda).

Why this exists
---------------
OTA payouts (MakeMyTrip, Agoda) do NOT arrive as an OTA-formatted settlement
email with a booking-id breakdown. They arrive as a **bank payment advice**
from the hotel's bank (e.g. HDFC corporate net-banking automailer), with the
actual advice as a **password-protected PDF attachment**. Example body:

    PAYMENT FROM MAKE MY TRIP (INDIA) PRIVATE LIMITED TO CIBARA ENTERPRISE …
    Please find attached payment advice for Reference No 1698731881
    The attachment is password protected.

and the decrypted PDF contains:

    Beneficiary Account Number : 925020058888935
    Client Reference No        : SVPAUTOH018281772
    Date                       : 15/06/2026
    UTR / RRN No               : HDFCH01064621775
    Amount                     : 3393.00
    Payment Details 7          : MMT3848

Crucial limitation
------------------
The advice carries the **amount, UTR, date and a short platform reference**
(e.g. "MMT3848") — but NOT the full OTA booking id (NHxx…). So a payout cannot
be matched to a booking by id. It is matched by **amount** against the pending
OTA settlements, and ONLY auto-settled when exactly one pending booking of the
right platform matches the amount (within a small tolerance). Zero or multiple
matches are reported for manual settlement — never guessed. This keeps a wrong
booking from ever being settled automatically.

Security / config
-----------------
The PDF password is the first 6 digits of the beneficiary account number (per
the bank's instructions). The account number is read from config — never
hard-coded — and the "first 6" rule is applied in code:

    BANK_ACCOUNT_NUMBER        full beneficiary account no (password derived)
    SETTLEMENT_PDF_PASSWORDS   optional explicit comma-separated passwords to try
    BANK_SETTLEMENT_SENDERS    FROM filters; default "hdfcbank.bank.in"
    BANK_SETTLE_TOLERANCE      amount-match tolerance in ₹ (default 1)
    BANK_SETTLEMENT_SINCE      go-live floor YYYY-MM-DD (default 2026-06-01)

Mailbox credentials reuse the MMT_GMAIL_* inbox (same inbox), with optional
BANK_GMAIL_* overrides.

IMAP access is READ-ONLY. Settlement is idempotent (apply_ota_settlement skips
already-received bookings; processed UTRs are also tracked in the cursor).
"""

from __future__ import annotations

import os
import re
import email
import imaplib
import logging
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime

from services.mmt_ingest_service import (
    _num,
    _parse_ddmmyyyy,
    _decode_subject,
)

logger = logging.getLogger(__name__)

_CURSOR_DOC = "bank_settlement_ingest"


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def _env_with_fallback(primary: str, fallback: str, default: str = "") -> str:
    val = os.environ.get(primary)
    if val is None or val == "":
        val = os.environ.get(fallback, default)
    return val or default


def _pdf_password_candidates() -> list[str]:
    """
    Build the ordered list of passwords to try when opening the advice PDF.

    Priority: explicit SETTLEMENT_PDF_PASSWORDS, then values derived from
    BANK_ACCOUNT_NUMBER per the bank's rule ("first 6 digits if the account no
    is longer than 6 chars, else the whole account no"). Duplicates removed,
    blanks dropped.
    """
    cands: list[str] = []
    explicit = os.environ.get("SETTLEMENT_PDF_PASSWORDS", "")
    cands.extend(p.strip() for p in explicit.split(",") if p.strip())

    acct = (os.environ.get("BANK_ACCOUNT_NUMBER", "") or "").strip()
    if acct:
        if len(acct) > 6:
            cands.append(acct[:6])
        else:
            cands.append(acct)
        cands.append(acct)  # also try the full number, just in case

    # De-dup, preserve order.
    seen, out = set(), []
    for c in cands:
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def load_config() -> dict:
    senders = os.environ.get("BANK_SETTLEMENT_SENDERS", "hdfcbank.bank.in")
    _app_pw = _env_with_fallback("BANK_GMAIL_APP_PASSWORD", "MMT_GMAIL_APP_PASSWORD", "")
    _app_pw = "".join(_app_pw.split())
    return {
        "user":      _env_with_fallback("BANK_GMAIL_USER", "MMT_GMAIL_USER", "").strip(),
        "password":  _app_pw,
        "host":      _env_with_fallback("BANK_IMAP_HOST", "MMT_IMAP_HOST", "imap.gmail.com").strip(),
        "folder":    _env_with_fallback("BANK_IMAP_FOLDER", "MMT_IMAP_FOLDER", "INBOX").strip(),
        "senders":   [s.strip().lower() for s in senders.split(",") if s.strip()],
        "lookback_days": int(os.environ.get("BANK_INGEST_LOOKBACK_DAYS", "14") or 14),
        "since_floor": os.environ.get(
            "BANK_SETTLEMENT_SINCE", os.environ.get("MMT_INGEST_SINCE", "2026-06-01")
        ).strip(),
        "tolerance": float(os.environ.get("BANK_SETTLE_TOLERANCE", "1") or 1),
        "pdf_passwords": _pdf_password_candidates(),
    }


def is_configured(cfg: dict | None = None) -> bool:
    cfg = cfg or load_config()
    return bool(cfg.get("user") and cfg.get("password"))


# ---------------------------------------------------------------------------
# Pure parsing + matching (no I/O — unit-testable)
# ---------------------------------------------------------------------------

_WS = re.compile(r"[ \t ]+")


def _flatten(text: str) -> str:
    if not text:
        return ""
    text = text.replace("\r", "\n")
    text = re.sub(r"[ \t ]*\n[ \t ]*", " ", text)  # join wrapped lines
    return _WS.sub(" ", text).strip()


def detect_platform(text: str) -> str:
    """Identify the paying OTA from the advice text. '' if unknown."""
    t = (text or "").upper()
    if "AGODA" in t:
        return "agoda"
    if "MAKEMYTRIP" in t or "MAKE MY TRIP" in t or re.search(r"\bMMT\d", t) or "GO-MMT" in t or "GOIBIBO" in t:
        return "mmt"
    return ""


def parse_bank_advice_text(text: str, *, subject: str = "") -> dict | None:
    """
    Parse decrypted bank-advice PDF text (or, as a fallback, the email body)
    into a structured payout. Returns None if it doesn't look like a payment
    advice. Never raises.
    """
    flat = _flatten(text)
    if not flat:
        return None

    looks_like_advice = bool(
        re.search(r"Payment Advice", flat, re.IGNORECASE)
        or (re.search(r"UTR\s*/?\s*RRN", flat, re.IGNORECASE)
            and re.search(r"\bAmount\b", flat, re.IGNORECASE))
    )
    if not looks_like_advice:
        return None

    out: dict = {"subject": subject, "raw_text_len": len(flat)}

    def _grp(pattern):
        m = re.search(pattern, flat, re.IGNORECASE)
        return m.group(1) if m else None

    # Amount: the labelled "Amount : 3393.00" (require the colon + decimals so
    # "Amount in Words" and the narration "amount of 3393.00" don't false-hit).
    _amt = _grp(r"\bAmount\b\s*:\s*([\d,]+\.\d{2})")
    out["amount"] = _num(_amt) if _amt else None
    out["utr"] = _grp(r"UTR\s*/?\s*RRN\s*No\.?\s*:?\s*([A-Z0-9]{6,})")
    out["client_ref"] = _grp(r"Client Reference No\.?\s*:?\s*([A-Za-z0-9]{4,})")
    _dt = _grp(r"\bDate\b\s*:?\s*(\d{1,2}/\d{1,2}/\d{4})")
    out["txn_date"] = _parse_ddmmyyyy(_dt) if _dt else None
    out["beneficiary_account"] = _grp(r"Beneficiary Account Number\s*:?\s*(\d{6,})")

    # Platform references in the "Payment Details N : <ref>" rows (e.g.
    # "MMT3848"). The negative lookahead stops an EMPTY row from capturing the
    # next "Payment Details" label when the rows are flattened onto one line.
    refs = re.findall(
        r"Payment Details\s*\d+\s*:\s*(?!Payment\b)([A-Za-z0-9][A-Za-z0-9\-/]*)",
        flat, re.IGNORECASE)
    refs = [r for r in refs if r and r.lower() != "statement"]
    out["payment_refs"] = refs

    out["platform"] = detect_platform(flat) or detect_platform(subject)

    reasons = []
    if out["amount"] is None:
        reasons.append("no amount parsed")
    if not out["platform"]:
        reasons.append("platform not identified")
    out["needs_review"] = bool(reasons)
    out["review_reasons"] = reasons
    return out


def pick_match(amount, candidates, tolerance: float = 1.0):
    """
    Choose the single pending booking a payout settles, by amount.

    `candidates` is a list of dicts each with at least 'net_receivable' and
    'booking_id'. Returns (booking_or_None, reason). Auto-settle ONLY when
    exactly one candidate's net_receivable is within `tolerance` of `amount`.
    """
    if amount is None:
        return (None, "advice has no amount")
    matches = [
        c for c in candidates
        if c.get("net_receivable") is not None
        and abs(float(c.get("net_receivable") or 0) - float(amount)) <= tolerance
    ]
    if len(matches) == 1:
        return (matches[0], "unique amount match")
    if not matches:
        return (None, f"no pending booking with net_receivable ≈ ₹{amount}")
    ids = ", ".join(str(m.get("booking_id"))[:8] for m in matches)
    return (None, f"ambiguous: {len(matches)} pending bookings match ₹{amount} ({ids})")


# ---------------------------------------------------------------------------
# PDF + IMAP (I/O)
# ---------------------------------------------------------------------------

def extract_pdf_text(pdf_bytes: bytes, passwords: list[str]) -> str | None:
    """
    Decrypt (if needed) and extract text from an advice PDF. Tries each
    candidate password. Returns the text, or None if it can't be opened.
    Requires pypdf (imported lazily so this module stays import-cheap and the
    pure parser/matcher remain testable without the dependency).
    """
    try:
        import io
        from pypdf import PdfReader
    except Exception as e:  # pragma: no cover - dependency missing
        logger.warning(f"bank_settlement: pypdf unavailable: {e}")
        return None
    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        if reader.is_encrypted:
            opened = False
            for pw in (passwords or []):
                try:
                    if reader.decrypt(pw):
                        opened = True
                        break
                except Exception:
                    continue
            if not opened:
                logger.warning("bank_settlement: could not decrypt advice PDF with any candidate password")
                return None
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    except Exception as e:
        logger.warning(f"bank_settlement: PDF read failed: {e}")
        return None


def _pdf_attachments(msg) -> list[bytes]:
    out = []
    for part in msg.walk():
        ctype = (part.get_content_type() or "").lower()
        fname = (part.get_filename() or "").lower()
        disp = str(part.get("Content-Disposition") or "").lower()
        if ctype == "application/pdf" or fname.endswith(".pdf") or ("attachment" in disp and fname.endswith(".pdf")):
            try:
                payload = part.get_payload(decode=True)
                if payload:
                    out.append(payload)
            except Exception:
                continue
    return out


def fetch_advices(cfg: dict, *, since_dt: datetime | None = None) -> list[dict]:
    """Read bank-sender emails (read-only), decrypt their PDF advices, and
    parse each into a payout dict. Raises on connection/login failure."""
    if not is_configured(cfg):
        raise RuntimeError(
            "Bank settlement ingestion is not configured "
            "(set MMT_GMAIL_USER / MMT_GMAIL_APP_PASSWORD, or BANK_GMAIL_*)"
        )
    if since_dt is None:
        since_dt = datetime.now() - timedelta(days=cfg.get("lookback_days", 14))

    passwords = cfg.get("pdf_passwords") or []
    results: list[dict] = []
    imap = imaplib.IMAP4_SSL(cfg["host"])
    try:
        imap.login(cfg["user"], cfg["password"])
        imap.select(cfg["folder"], readonly=True)
        since_str = since_dt.strftime("%d-%b-%Y")
        uids = set()
        for s in (cfg.get("senders") or []):
            typ, data = imap.search(None, "SINCE", since_str, "FROM", s)
            if typ == "OK" and data and data[0]:
                uids.update(data[0].split())

        for uid in sorted(uids):
            try:
                typ, msg_data = imap.fetch(uid, "(RFC822)")
                if typ != "OK" or not msg_data or not msg_data[0]:
                    continue
                msg = email.message_from_bytes(msg_data[0][1])
                subject = _decode_subject(msg.get("Subject"))
                try:
                    internaldate = parsedate_to_datetime(msg.get("Date"))
                except Exception:
                    internaldate = None

                advice = None
                for pdf in _pdf_attachments(msg):
                    text = extract_pdf_text(pdf, passwords)
                    if text:
                        advice = parse_bank_advice_text(text, subject=subject)
                        if advice:
                            break
                if advice is None:
                    continue
                advice["internaldate"] = internaldate
                advice["message_id"] = msg.get("Message-ID", "")
                results.append(advice)
            except Exception as e:
                logger.warning(f"bank_settlement: failed to handle uid {uid}: {e}")
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
# Firestore-backed ingestion
# ---------------------------------------------------------------------------

def _get_refs():
    from config import db, bookings_ref, settings_ref, IST
    return db, bookings_ref, settings_ref, IST


def read_cursor(settings_ref):
    try:
        doc = settings_ref.document(_CURSOR_DOC).get()
        return doc.to_dict() if doc.exists else {}
    except Exception:
        return {}


def _pending_candidates(bookings_ref, platform: str) -> list[dict]:
    out = []
    try:
        q = (bookings_ref
             .where("booking_source", "==", platform)
             .where("settlement_status", "==", "pending")
             .stream())
        for d in q:
            b = d.to_dict() or {}
            b["booking_id"] = d.id
            out.append(b)
    except Exception as e:
        logger.warning(f"bank_settlement: candidate query failed for {platform}: {e}")
    return out


def ingest(*, dry_run: bool = False, force_days: int | None = None) -> dict:
    """
    Scan bank payment-advice emails and auto-settle the matching OTA booking
    (MMT / Agoda) by amount. Idempotent. Returns a JSON-serialisable summary.
    """
    cfg = load_config()
    summary = {
        "source": "bank_advice",
        "configured": is_configured(cfg),
        "scanned": 0, "settled": 0, "settle_skipped": 0,
        "settle_unmatched": 0, "settle_ambiguous": 0, "errors": 0,
        "messages": [], "dry_run": dry_run,
    }
    if not summary["configured"]:
        summary["messages"].append(
            "Not configured: set MMT_GMAIL_USER / MMT_GMAIL_APP_PASSWORD "
            "(shared inbox) and BANK_ACCOUNT_NUMBER for the PDF password."
        )
        return summary
    if not cfg.get("pdf_passwords"):
        summary["messages"].append(
            "No PDF password configured: set BANK_ACCOUNT_NUMBER (advice PDFs "
            "are encrypted; password = first 6 digits of the account number)."
        )

    try:
        db, bookings_ref, settings_ref, IST = _get_refs()
    except Exception as e:
        summary["errors"] += 1
        summary["messages"].append(f"Firestore unavailable: {e}")
        return summary

    cursor = read_cursor(settings_ref)
    processed_utrs = set(cursor.get("processed_utrs") or [])

    since_dt = None
    if force_days and force_days > 0:
        since_dt = datetime.now() - timedelta(days=int(force_days))
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
        except ValueError:
            pass

    try:
        advices = fetch_advices(cfg, since_dt=since_dt)
    except Exception as e:
        summary["errors"] += 1
        summary["messages"].append(f"IMAP error: {e}")
        return summary

    summary["scanned"] = len(advices)
    latest_email_dt = cursor.get("last_email_dt")
    today = datetime.now(IST).strftime("%Y-%m-%d")

    from routes.bookings import apply_ota_settlement

    for adv in advices:
        if adv.get("internaldate"):
            iso = adv["internaldate"].astimezone().replace(tzinfo=None).isoformat()
            if latest_email_dt is None or iso > latest_email_dt:
                latest_email_dt = iso

        utr = adv.get("utr") or ""
        amount = adv.get("amount")
        platform = adv.get("platform")
        sdate = adv.get("txn_date") or today

        if utr and utr in processed_utrs:
            summary["settle_skipped"] += 1
            continue
        if not platform:
            summary["settle_unmatched"] += 1
            summary["messages"].append(
                f"Advice (UTR {utr or '?'}, ₹{amount}): platform not identified")
            continue

        candidates = _pending_candidates(bookings_ref, platform)
        booking, reason = pick_match(amount, candidates, cfg.get("tolerance", 1.0))

        if booking is None:
            if "ambiguous" in reason:
                summary["settle_ambiguous"] += 1
            else:
                summary["settle_unmatched"] += 1
            summary["messages"].append(
                f"{platform.upper()} payout ₹{amount} (UTR {utr or '?'}): {reason} — settle manually")
            continue

        if dry_run:
            summary["settled"] += 1
            summary["messages"].append(
                f"(dry-run) would settle {platform.upper()} booking "
                f"{str(booking['booking_id'])[:8]} ₹{amount} on {sdate} (UTR {utr})")
            if utr:
                processed_utrs.add(utr)
            continue

        res = apply_ota_settlement(booking["booking_id"], sdate, amount, utr=utr, source="bank_pdf")
        if res.get("ok") and not res.get("already"):
            summary["settled"] += 1
            if utr:
                processed_utrs.add(utr)
        elif res.get("already"):
            summary["settle_skipped"] += 1
            if utr:
                processed_utrs.add(utr)
        else:
            summary["errors"] += 1
            summary["messages"].append(
                f"{platform.upper()} ₹{amount} (UTR {utr}): settle failed: {res.get('message')}")

    if not dry_run:
        try:
            settings_ref.document(_CURSOR_DOC).set({
                "last_email_dt": latest_email_dt,
                "last_run_at": datetime.now(IST).isoformat(),
                # Cap the stored UTR list so the cursor doc can't grow forever.
                "processed_utrs": list(processed_utrs)[-500:],
                "last_run_summary": {
                    k: summary[k] for k in
                    ("scanned", "settled", "settle_skipped", "settle_unmatched",
                     "settle_ambiguous", "errors")
                },
            }, merge=True)
        except Exception as e:
            logger.warning(f"bank_settlement: failed to persist cursor: {e}")

    if not dry_run and summary["settled"] > 0:
        try:
            from config import invalidate_rooms_and_totals
            invalidate_rooms_and_totals()
        except Exception:
            pass

    return summary
