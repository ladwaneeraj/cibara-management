"""
GST month locking — freeze a month's bills after GSTR-1 is filed.

Once GSTR-1 for a month is filed, the books for that month must match the
return forever. This service is the single authority on whether a month is
locked; route handlers call assert_unlocked() before any mutation that
would change a filed figure.

Collection: gst_month_locks/{YYYY-MM}
    locked      bool
    locked_by   str
    locked_at   str  "YYYY-MM-DD HH:MM:SS" IST
    note        str  (e.g. "GSTR-1 filed 2026-06-11, ARN AA290626...")
    history     list of {action, by, at, note} — full lock/unlock trail

What a lock blocks (server-side, in the routes that call this module):
  * /update_bill_service      — changes taxable value of a filed invoice
  * /update_bill_gst          — changes B2B/B2C classification
  * /add_bill_payment         — ONLY the "financial" blind-subtract discount
                                (it rewrites total_amount); plain payment
                                collection stays allowed — receiving money
                                later does not change the filed supply.
  * /update_stay_payment      — editing a payment row (method/date/amount)
                                dated in a locked month, or moving one into
                                a locked month: it rewrites the filed
                                month's Cash/UPI books and the invoice PDF.
  * /recalculate_bill         — rewrites payment fields + regenerates the
                                PDF of a filed invoice.
  * /revert_checkout          — voids a filed invoice
  * bills_service.finalize    — minting a bill INTO a locked month (repair
                                scripts); the GSTR-1 would no longer match.

What a lock deliberately does NOT block:
  * Issuing a credit note against a locked-month bill. CNs always carry
    today's date (never backdated, enforced in routes/billing.py) and are
    reported in the CURRENT month's GSTR-1 — that is the lawful correction
    mechanism after filing (Section 34).
  * Collecting a pending settlement — payment, not a supply change.

Locking the CURRENT or a FUTURE month is refused: it would block every
ongoing checkout (bills_service.finalize checks the lock).
"""

from __future__ import annotations

import logging
import re
from datetime import datetime

logger = logging.getLogger(__name__)

_PERIOD_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


class MonthLockedError(Exception):
    """Raised when a mutation targets a bill in a GST-locked month."""

    def __init__(self, period: str, action: str):
        self.period = period
        self.action = action
        super().__init__(
            f"GST period {period} is locked (GSTR-1 filed) — {action} is not "
            f"allowed. If a correction is genuinely needed, issue a credit "
            f"note (Section 34), or an admin must unlock the month first — "
            f"which means the filed return no longer matches the books."
        )


def _col():
    from config import db  # lazy — avoids circular import
    return db.collection("gst_month_locks")


def _now_ist() -> str:
    from config import IST
    return datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")


def _current_period() -> str:
    from config import IST
    return datetime.now(IST).strftime("%Y-%m")


def normalize_period(value: str) -> str | None:
    """
    Accepts "YYYY-MM", or any string starting with "YYYY-MM-..." (a bill's
    checkout_time works directly). Returns "YYYY-MM" or None if unparseable.
    """
    if not value or not isinstance(value, str):
        return None
    candidate = value.strip()[:7]
    return candidate if _PERIOD_RE.match(candidate) else None


def is_month_locked(period_or_date: str) -> bool:
    """
    True if the month is locked. Fails CLOSED for malformed input on the
    bill (None period → not locked is wrong-side-safe? No: a bill with a
    broken checkout_time cannot be attributed to a filed period, and
    blocking ALL mutations on malformed data would brick legitimate fixes
    of corrupt docs — so unparseable input returns False and is logged).
    Firestore read errors fail CLOSED (treated as locked) — never allow a
    mutation just because the lock could not be read.
    """
    period = normalize_period(period_or_date)
    if period is None:
        logger.warning(
            f"gst_lock: unparseable period {period_or_date!r} — treating as "
            f"unlocked (document needs manual review)"
        )
        return False
    try:
        snap = _col().document(period).get()
        return bool(snap.exists and (snap.to_dict() or {}).get("locked"))
    except Exception as e:  # noqa: BLE001
        logger.error(f"gst_lock: read failed for {period}: {e} — failing "
                     f"CLOSED (treated as locked)", exc_info=True)
        return True


def assert_unlocked(period_or_date: str, action: str) -> None:
    """Raise MonthLockedError if the month containing the date is locked."""
    period = normalize_period(period_or_date)
    if period and is_month_locked(period):
        raise MonthLockedError(period, action)


def set_lock(period: str, locked: bool, actor: str, note: str = "") -> dict:
    """
    Lock or unlock a month. Returns the resulting doc.
    Raises ValueError for malformed periods or locking current/future months.
    """
    norm = normalize_period(period)
    if norm is None:
        raise ValueError(f"period must be YYYY-MM, got {period!r}")
    if locked and norm >= _current_period():
        raise ValueError(
            f"cannot lock {norm}: only completed months can be locked "
            f"(locking the running month would block every checkout)"
        )

    ref = _col().document(norm)
    snap = ref.get()
    existing = snap.to_dict() if snap.exists else {}
    history = list(existing.get("history") or [])
    history.append({
        "action": "lock" if locked else "unlock",
        "by":     str(actor or "unknown"),
        "at":     _now_ist(),
        "note":   str(note or ""),
    })
    doc = {
        "locked":    bool(locked),
        "locked_by": str(actor or "unknown"),
        "locked_at": _now_ist(),
        "note":      str(note or ""),
        "history":   history[-50:],  # bounded trail
    }
    ref.set(doc)
    logger.info(f"gst_lock: {norm} {'LOCKED' if locked else 'UNLOCKED'} "
                f"by {actor} ({note!r})")
    return {"period": norm, **doc}


def list_locks(months_back: int = 18) -> list[dict]:
    """
    Last N months (newest first), each with its lock state — including
    months that have no lock doc yet (locked=False), so the UI can render
    a complete picker without client-side date math.
    """
    from config import IST
    months_back = max(1, min(int(months_back), 60))

    periods = []
    y, m = datetime.now(IST).year, datetime.now(IST).month
    for _ in range(months_back):
        periods.append(f"{y}-{m:02d}")
        m -= 1
        if m == 0:
            y, m = y - 1, 12

    docs = {}
    try:
        for snap in _col().stream():
            docs[snap.id] = snap.to_dict() or {}
    except Exception as e:  # noqa: BLE001
        logger.error(f"gst_lock: list failed: {e}", exc_info=True)

    out = []
    current = _current_period()
    for p in periods:
        d = docs.get(p, {})
        out.append({
            "period":     p,
            "locked":     bool(d.get("locked")),
            "locked_by":  d.get("locked_by"),
            "locked_at":  d.get("locked_at"),
            "note":       d.get("note") or "",
            "is_current": p == current,
        })
    return out
