"""
Atomic Financial-Year counters for receipt and deposit serials.

Why a separate module
---------------------
config.py already has `generate_sequential_bill_number` / `generate_…
_credit_note_number`. Both use the same atomic-Firestore-transaction
pattern, but the docs they target live in the `daily_counters`
collection keyed by calendar month. The Banking package needs a
slightly different shape:

  * Financial year, not calendar month (Indian FY = Apr-1 to Mar-31).
  * A counter kind (rv / or / dep) so we don't collide with bill /
    credit-note counters.
  * Format helper that produces the user-facing serial string.

Same atomicity guarantees: every increment runs inside
`@firestore.transactional`, so concurrent receipts on different
threads can never share a number.

Counter doc shape (in `daily_counters` collection):
    id: "<kind>_FY<YY>-<YY>"          e.g.  "rv_FY26-27"
    data: { count: <int> }            int, monotonic, never decreases
"""

from __future__ import annotations

import logging
from datetime import date, datetime
from typing import Optional

from firebase_admin import firestore

from .schema import (
    COL_COUNTERS,
    CounterKind,
    RECEIPT_NO_FORMAT,
    RECEIPT_SERIAL_PAD,
    DEPOSIT_REF_FORMAT,
    DEPOSIT_SERIAL_PAD,
)

logger = logging.getLogger(__name__)


_db = None
_counters_ref = None


def init(db) -> None:
    """Bind the Firestore client. Idempotent."""
    global _db, _counters_ref
    _db = db
    _counters_ref = db.collection(COL_COUNTERS)
    logger.info("Banking.counters initialised")


# ───────────────────────── FY helpers ────────────────────────────────

def fy_short_for(d: Optional[date] = None) -> str:
    """
    Return the Indian financial-year tag in compact form, e.g. "26-27"
    for any date between 2026-04-01 and 2027-03-31.

    Tagging convention chosen to match GST return filings.
    """
    if d is None:
        d = date.today()
    if isinstance(d, datetime):
        d = d.date()
    if d.month >= 4:
        start = d.year
    else:
        start = d.year - 1
    end = start + 1
    return f"{start % 100:02d}-{end % 100:02d}"


def counter_doc_id(kind: str, fy_short: str) -> str:
    """
    Build the daily_counters doc ID for a given counter kind + FY.
    e.g. counter_doc_id('rv', '26-27') -> 'rv_FY26-27'
    """
    if kind not in CounterKind.ALL:
        raise ValueError(f"unknown counter kind: {kind!r}")
    return f"{kind}_FY{fy_short}"


# ───────────────────────── Atomic increment ──────────────────────────

def next_serial(kind: str, *, on_date: Optional[date] = None) -> Optional[int]:
    """
    Atomically increment the FY-scoped counter for `kind` and return
    the new serial (1, 2, 3, ...).

    Returns None on Firestore error. The caller decides what to do —
    typically: refuse to issue the document rather than reusing an
    older serial.

    Concurrency
    -----------
    Runs inside @firestore.transactional. Two callers racing on the
    same counter both succeed and receive distinct serials; Firestore
    serialises the transaction internally. There is no scenario where
    two receipts share a number.
    """
    if _counters_ref is None:
        logger.error("Banking.counters.next_serial called before init()")
        return None
    if kind not in CounterKind.ALL:
        logger.error(f"Banking.counters.next_serial: unknown kind {kind!r}")
        return None
    try:
        fy = fy_short_for(on_date)
        ref = _counters_ref.document(counter_doc_id(kind, fy))
        txn = _db.transaction()

        @firestore.transactional
        def _inc(t, doc_ref):
            snap = doc_ref.get(transaction=t)
            current = 0
            if snap.exists:
                try:
                    current = int(snap.get("count") or 0)
                except (KeyError, TypeError, ValueError):
                    current = 0
            new_val = current + 1
            t.set(doc_ref, {"count": new_val}, merge=True)
            return new_val

        return _inc(txn, ref)
    except Exception as e:
        logger.error(f"Banking.counters.next_serial({kind}) failed: {e}",
                     exc_info=True)
        return None


# ───────────────────────── Format helpers ────────────────────────────

def format_receipt_number(kind: str, serial: int,
                          *, on_date: Optional[date] = None) -> str:
    """
    Build the human-facing receipt voucher number string.

    Example: format_receipt_number('rv', 42, on_date=2026-05-16)
             -> "RV/FY26-27/00042"

    `kind` must be CounterKind.CASH_RECEIPT or CounterKind.ONLINE_RECEIPT.
    Deposit refs use `format_deposit_ref` instead.
    """
    if kind == CounterKind.CASH_RECEIPT:
        prefix = "RV"
    elif kind == CounterKind.ONLINE_RECEIPT:
        prefix = "OR"
    else:
        raise ValueError(
            f"format_receipt_number expects 'rv' or 'or', got {kind!r}"
        )
    return RECEIPT_NO_FORMAT.format(
        prefix=prefix,
        fy_short=fy_short_for(on_date),
        serial=str(serial).zfill(RECEIPT_SERIAL_PAD),
    )


def format_deposit_ref(serial: int,
                       *, on_date: Optional[date] = None) -> str:
    """
    Build the internal cash_deposit reference, e.g. "DEP/FY26-27/00007".

    This is *not* a tax document number — just a short, human-friendly
    handle for staff to refer to a deposit. The actual bank slip
    number entered by the operator lives on the deposit doc as
    `slip_number`.
    """
    return DEPOSIT_REF_FORMAT.format(
        fy_short=fy_short_for(on_date),
        serial=str(serial).zfill(DEPOSIT_SERIAL_PAD),
    )


# ───────────────────────── Diagnostics ───────────────────────────────

def peek(kind: str, *, on_date: Optional[date] = None) -> int:
    """
    Read the current counter value without incrementing. Returns 0 if
    the counter doc doesn't exist yet. For diagnostics only — never use
    the returned value to mint a serial (use next_serial instead).
    """
    if _counters_ref is None:
        return 0
    try:
        ref = _counters_ref.document(counter_doc_id(kind, fy_short_for(on_date)))
        snap = ref.get()
        if not snap.exists:
            return 0
        return int(snap.get("count") or 0)
    except Exception as e:
        logger.warning(f"Banking.counters.peek({kind}) failed: {e}")
        return 0
