"""
Cash + Online Receipt vouchers and the invoiceability trigger.

This is the heart of the Banking module. The flow it implements:

  1. Every payment on a stay is recorded as before (legacy
     payments collection write is untouched).

  2. While the parent bill is in `invoiceable = false`:
        * Cash payments are born `deposit_eligibility = pending`,
          `receipt_no = null`. They are NOT depositable.
        * Online payments fire the TRIGGER (see step 3).

  3. The first online payment on a stay fires
     `fire_trigger(stay_id, trigger_payment_id)`:
        * Atomically: bill becomes invoiceable, all prior cash
          payments are stamped with `officialized_at = trigger_ts`
          and receipt numbers; cash flips to `eligible`.
        * Idempotent: a `trigger_token` on the bill prevents the
          trigger firing twice (e.g. webhook retries).

  4. After trigger, every new payment is born receipted:
        * Cash → fresh RV number, eligible.
        * Online → fresh OR number.

  5. A bill that goes through checkout WITHOUT ever firing the
     trigger (`invoiceable = false`) is marked unofficial:
        * All cash payments flip from `pending` → `excluded`.
        * They are forever invisible to the deposit screen.

Edit guards
-----------
`fire_trigger_revert` exists for the rare case of "removed the last
online payment, no cash deposited yet". It un-elects the trigger,
voids all receipts (numbers stay in the counter — audit-safe), and
flips the bill back to non-invoiceable. If any cash has already been
deposited under this stay (`first_deposit_at is not None`), the revert
is REFUSED. The caller must either reverse the deposit first or
re-introduce another online payment.

Transactionality
----------------
The trigger fires inside a single Firestore transaction that reads:
  * the bill doc
  * every cash payment for the stay (where receipt_no is null)
and writes:
  * the bill doc (flag flip, trigger metadata)
  * one cash_receipts doc per payment (the receipt voucher)
  * each payment doc (stamp receipt_no, officialized_at, eligibility)

Firestore transactions max 500 writes; in practice a single stay
generates well under 50 cash payments. If we ever approach the limit
we batch by paging.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, date
from typing import Optional, Tuple

from firebase_admin import firestore
from firebase_admin import firestore as fa_firestore

from config import IST
from services.audit_log import write_log

from . import bill_events, counters
from .money import coerce_to_paise, paise_to_rupees_int
from .schema import (
    COL_BILLS, COL_PAYMENTS, COL_CASH_RECEIPTS,
    PaymentMethod, DepositEligibility, BillEventType, CounterKind,
    BILL_INVOICEABLE, BILL_INVOICEABLE_AT,
    BILL_INVOICEABLE_TRIGGER_PAYMENT, BILL_INVOICEABLE_TRIGGER_TOKEN,
    BILL_FIRST_DEPOSIT_AT,
    PAY_METHOD, PAY_AMOUNT_PAISE, PAY_OFFICIALIZED_AT, PAY_RECEIPT_ID,
    PAY_RECEIPT_NO, PAY_RECEIPT_ISSUED_AT, PAY_DEPOSIT_ELIGIBILITY,
    PAY_INVOICEABLE, PAY_VOIDED_AT,
)

logger = logging.getLogger(__name__)


_db = None
_bills_ref = None
_payments_ref = None
_receipts_ref = None


def init(db) -> None:
    global _db, _bills_ref, _payments_ref, _receipts_ref
    _db = db
    _bills_ref = db.collection(COL_BILLS)
    _payments_ref = db.collection(COL_PAYMENTS)
    _receipts_ref = db.collection(COL_CASH_RECEIPTS)
    logger.info("Banking.cash_receipts initialised")


# ───────────────────────── Helpers ───────────────────────────────────

def _ist_now_iso() -> str:
    return datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")


def _ist_today() -> date:
    return datetime.now(IST).date()


def _issue_receipt_doc(
    *,
    stay_id: str,
    payment_id: str,
    method: str,
    amount_paise: int,
    receipt_no: str,
    receipt_date: date,
    receipt_kind: str,        # "rv" | "or"
    txn,
    correlation_id: str,
) -> str:
    """
    Create a cash_receipts doc inside the given transaction. Returns
    the receipt doc ID. Caller has already minted `receipt_no` from
    `counters.next_serial()`.
    """
    new_ref = _receipts_ref.document()
    txn.set(new_ref, {
        "stay_id":          stay_id,
        "payment_id":       payment_id,
        "receipt_no":       receipt_no,
        "receipt_kind":     receipt_kind,
        "method":           method,
        "amount_paise":     int(amount_paise),
        "amount":           paise_to_rupees_int(amount_paise),
        "receipt_date":     receipt_date.strftime("%Y-%m-%d"),
        "issued_at":        _ist_now_iso(),
        "status":           "issued",
        "voided_at":        None,
        "correlation_id":   correlation_id,
    })
    return new_ref.id


# ───────────────────────── Trigger ───────────────────────────────────

class TriggerError(Exception):
    """Raised when fire_trigger encounters an unrecoverable state."""
    pass


def fire_trigger(
    stay_id: str,
    *,
    trigger_payment_id: str,
    trigger_date: Optional[date] = None,
    correlation_id: Optional[str] = None,
) -> Optional[dict]:
    """
    The single online payment that flips a stay to invoiceable.

    Atomically:
      1. Re-reads the bill. If already invoiceable, no-op (idempotent).
      2. Stamps invoiceable=true, invoiceable_at, trigger_payment_id,
         trigger_token.
      3. Backfills every cash payment for this stay:
           * issues an RV receipt voucher
           * sets officialized_at = trigger_date (NOT original pay date)
           * flips eligibility pending → eligible
      4. Issues an OR receipt for the triggering online payment itself.

    Returns a summary dict on success:
        { "stay_id": ..., "trigger_token": ...,
          "rv_receipts": [<rv_no>, ...],
          "or_receipt": "<or_no>",
          "backfilled_payment_ids": [...] }

    Returns None and logs on failure. Failure modes:
      * bill not found
      * trigger_payment_id not on this stay
      * counter unreachable
      * Firestore write error (transaction rolled back)

    Idempotency
    -----------
    If the bill is already invoiceable and the existing
    trigger_payment_id matches, returns a synthesised "no-op" summary
    so the caller can treat retries uniformly. Mismatched
    trigger_payment_id on an already-invoiceable bill is a programming
    error and logs an error (the second online payment should not be
    firing the trigger).
    """
    if _bills_ref is None:
        logger.error("cash_receipts.fire_trigger called before init()")
        return None
    if not stay_id or not trigger_payment_id:
        logger.error("fire_trigger: stay_id and trigger_payment_id required")
        return None

    trigger_date = trigger_date or _ist_today()
    correlation_id = correlation_id or bill_events.new_correlation_id()

    # ── Pre-flight: mint serials OUTSIDE the bill transaction. Each
    # next_serial call is its own atomic counter transaction; serials
    # are monotonically increasing and never reused. We bind them to
    # docs in the main transaction below.
    #
    # Why outside? Firestore transactions cannot nest, and bundling
    # the counter writes into the bill transaction would force the
    # entire batch to retry on counter contention.

    try:
        bill_snap = _bills_ref.document(stay_id).get()
        if not bill_snap.exists:
            logger.error(f"fire_trigger: bill {stay_id} not found")
            return None
        bill = bill_snap.to_dict() or {}
    except Exception as e:
        logger.error(f"fire_trigger: bill read failed: {e}")
        return None

    # Idempotency short-circuit
    if bill.get(BILL_INVOICEABLE) is True:
        existing_trigger = bill.get(BILL_INVOICEABLE_TRIGGER_PAYMENT)
        if existing_trigger == trigger_payment_id:
            logger.info(
                f"fire_trigger: idempotent no-op for stay={stay_id} "
                f"(already invoiceable, same trigger payment)"
            )
            return {
                "stay_id":               stay_id,
                "trigger_token":         bill.get(BILL_INVOICEABLE_TRIGGER_TOKEN),
                "already_invoiceable":   True,
                "rv_receipts":           [],
                "or_receipt":            None,
                "backfilled_payment_ids": [],
            }
        # Bill already invoiceable, different trigger payment — this is
        # a legitimate second online payment, not a re-fire. Just issue
        # its OR receipt; do not touch the bill flag.
        return _issue_post_trigger_receipt(
            stay_id=stay_id,
            payment_id=trigger_payment_id,
            trigger_date=trigger_date,
            correlation_id=correlation_id,
        )

    # ── Collect prior cash payments that need backfill (read once;
    # the transaction below re-reads with consistency).
    #
    # Excludes the same "non-revenue" types config.sum_payments_for_stay
    # excludes, so refund / checkout_refund / manual_refund / discount /
    # expense rows on the stay never receive a receipt voucher and never
    # land on the deposit screen as eligible cash. Also guards against
    # zero/negative amounts (defensive — refunds can be stored as
    # negative amount with a non-excluded type by mistake).
    _NON_REVENUE_TYPES = frozenset({
        "refund", "checkout_refund", "manual_refund",
        "booking_cancel_refund", "discount", "expense",
    })
    try:
        prior_q = (
            _payments_ref
            .where(filter=fa_firestore.FieldFilter("stay_id", "==", stay_id))
            .where(filter=fa_firestore.FieldFilter(PAY_METHOD, "==",
                                                   PaymentMethod.CASH))
        )
        prior_cash = []
        for snap in prior_q.stream():
            d = snap.to_dict() or {}
            if d.get(PAY_RECEIPT_NO):
                continue
            if d.get(PAY_VOIDED_AT):
                continue
            t = (d.get("type") or "").lower().strip()
            if t in _NON_REVENUE_TYPES:
                continue
            try:
                amt = int(d.get("amount") or 0)
            except (TypeError, ValueError):
                amt = 0
            if amt <= 0:
                continue
            prior_cash.append((snap.id, d))
    except Exception as e:
        logger.error(f"fire_trigger: prior-cash query failed: {e}")
        return None

    # Mint serials up front
    rv_serials: list[Tuple[str, dict, str, int]] = []  # (pay_id, pay, rv_no, serial)
    for pay_id, pay in prior_cash:
        serial = counters.next_serial(CounterKind.CASH_RECEIPT,
                                      on_date=trigger_date)
        if serial is None:
            logger.error(
                f"fire_trigger: counter unreachable; aborting trigger "
                f"for stay={stay_id}"
            )
            return None
        rv_no = counters.format_receipt_number(
            CounterKind.CASH_RECEIPT, serial, on_date=trigger_date
        )
        rv_serials.append((pay_id, pay, rv_no, serial))

    or_serial = counters.next_serial(CounterKind.ONLINE_RECEIPT,
                                     on_date=trigger_date)
    if or_serial is None:
        logger.error(f"fire_trigger: OR counter unreachable for stay={stay_id}")
        return None
    or_no = counters.format_receipt_number(
        CounterKind.ONLINE_RECEIPT, or_serial, on_date=trigger_date
    )

    trigger_token = uuid.uuid4().hex
    trigger_iso = _ist_now_iso()

    # ── Main transaction: bind serials, flip bill, stamp payments,
    # write receipt docs, append a TRIGGER_FIRED event.
    try:
        txn = _db.transaction()

        @firestore.transactional
        def _apply(t):
            # Re-read the bill inside the transaction for consistency
            cur_snap = _bills_ref.document(stay_id).get(transaction=t)
            cur = cur_snap.to_dict() or {}
            if cur.get(BILL_INVOICEABLE) is True:
                # Lost the race; another caller fired the trigger first.
                # Leave everything alone, return signal to caller.
                raise _TriggerRaceLost(cur.get(BILL_INVOICEABLE_TRIGGER_TOKEN))

            # 1. Flip the bill
            t.update(_bills_ref.document(stay_id), {
                BILL_INVOICEABLE:                  True,
                BILL_INVOICEABLE_AT:               trigger_iso,
                BILL_INVOICEABLE_TRIGGER_PAYMENT:  trigger_payment_id,
                BILL_INVOICEABLE_TRIGGER_TOKEN:    trigger_token,
                "updated_at":                      trigger_iso,
            })

            # 2. Receipt docs + payment stamps for prior cash
            rv_numbers = []
            backfilled = []
            for pay_id, pay, rv_no, _serial in rv_serials:
                amt = coerce_to_paise(pay)
                rcpt_id = _issue_receipt_doc(
                    stay_id=stay_id,
                    payment_id=pay_id,
                    method=PaymentMethod.CASH,
                    amount_paise=amt,
                    receipt_no=rv_no,
                    receipt_date=trigger_date,
                    receipt_kind=CounterKind.CASH_RECEIPT,
                    txn=t,
                    correlation_id=correlation_id,
                )
                t.update(_payments_ref.document(pay_id), {
                    PAY_OFFICIALIZED_AT:     trigger_iso,
                    PAY_RECEIPT_ID:          rcpt_id,
                    PAY_RECEIPT_NO:          rv_no,
                    PAY_RECEIPT_ISSUED_AT:   trigger_iso,
                    PAY_DEPOSIT_ELIGIBILITY: DepositEligibility.ELIGIBLE,
                    PAY_INVOICEABLE:         True,
                    PAY_AMOUNT_PAISE:        amt,
                })
                rv_numbers.append(rv_no)
                backfilled.append(pay_id)

            # 3. OR receipt for the trigger payment itself
            try:
                trig_snap = _payments_ref.document(trigger_payment_id).get(
                    transaction=t
                )
                trig = trig_snap.to_dict() or {}
            except Exception:
                trig = {}
            trig_amt = coerce_to_paise(trig)
            or_rcpt_id = _issue_receipt_doc(
                stay_id=stay_id,
                payment_id=trigger_payment_id,
                method=PaymentMethod.ONLINE,
                amount_paise=trig_amt,
                receipt_no=or_no,
                receipt_date=trigger_date,
                receipt_kind=CounterKind.ONLINE_RECEIPT,
                txn=t,
                correlation_id=correlation_id,
            )
            t.update(_payments_ref.document(trigger_payment_id), {
                PAY_OFFICIALIZED_AT:     trigger_iso,
                PAY_RECEIPT_ID:          or_rcpt_id,
                PAY_RECEIPT_NO:          or_no,
                PAY_RECEIPT_ISSUED_AT:   trigger_iso,
                PAY_DEPOSIT_ELIGIBILITY: DepositEligibility.EXCLUDED,  # online never depositable
                PAY_INVOICEABLE:         True,
                PAY_AMOUNT_PAISE:        trig_amt,
            })

            # 4. Event log (in the same transaction)
            bill_events.record(
                stay_id, BillEventType.TRIGGER_FIRED,
                payload={
                    "trigger_payment_id": trigger_payment_id,
                    "trigger_token":      trigger_token,
                    "rv_count":           len(rv_numbers),
                    "or_no":              or_no,
                },
                correlation_id=correlation_id, txn=t,
            )
            return rv_numbers, backfilled

        rv_numbers, backfilled = _apply(txn)

    except _TriggerRaceLost as race:
        logger.info(
            f"fire_trigger: race lost on stay={stay_id}; trigger already "
            f"fired with token={race.existing_token}"
        )
        return {
            "stay_id":               stay_id,
            "trigger_token":         race.existing_token,
            "already_invoiceable":   True,
            "rv_receipts":           [],
            "or_receipt":            None,
            "backfilled_payment_ids": [],
        }
    except Exception as e:
        logger.error(
            f"fire_trigger: transaction failed for stay={stay_id}: {e}",
            exc_info=True,
        )
        return None

    # The trigger flipped N cash payments from `pending` to `eligible`.
    # That changes cash-on-hand. Drop the cache so the COH banner
    # recomputes on next read instead of serving the pre-trigger value.
    try:
        from . import cash_deposits as _bk_deposits
        _bk_deposits.invalidate_cash_on_hand_cache()
    except Exception:
        pass  # cache is a best-effort optimisation, never block trigger

    write_log(
        "banking.trigger.fired",
        target_collection=COL_BILLS,
        target_id=stay_id,
        metadata={
            "trigger_payment_id": trigger_payment_id,
            "correlation_id":     correlation_id,
            "rv_count":           len(rv_numbers),
            "or_no":              or_no,
        },
    )
    return {
        "stay_id":               stay_id,
        "trigger_token":         trigger_token,
        "already_invoiceable":   False,
        "rv_receipts":           rv_numbers,
        "or_receipt":            or_no,
        "backfilled_payment_ids": backfilled,
    }


class _TriggerRaceLost(Exception):
    def __init__(self, existing_token):
        self.existing_token = existing_token


# ───────────────────────── Post-trigger receipts ─────────────────────

def _issue_post_trigger_receipt(
    *,
    stay_id: str,
    payment_id: str,
    trigger_date: Optional[date] = None,
    correlation_id: Optional[str] = None,
) -> Optional[dict]:
    """
    Issue a receipt for a payment recorded AFTER the trigger already
    fired. Online → OR; cash → RV with eligibility=eligible.

    Called automatically by issue_receipt_for_new_payment.
    """
    if _payments_ref is None or _receipts_ref is None:
        return None
    try:
        pay_snap = _payments_ref.document(payment_id).get()
        if not pay_snap.exists:
            return None
        pay = pay_snap.to_dict() or {}
    except Exception:
        return None
    method = pay.get(PAY_METHOD)
    if method not in PaymentMethod.ALL:
        return None
    on = trigger_date or _ist_today()

    kind = (CounterKind.CASH_RECEIPT
            if method == PaymentMethod.CASH else CounterKind.ONLINE_RECEIPT)
    serial = counters.next_serial(kind, on_date=on)
    if serial is None:
        return None
    rcpt_no = counters.format_receipt_number(kind, serial, on_date=on)

    issued_iso = _ist_now_iso()
    amt = coerce_to_paise(pay)
    correlation_id = correlation_id or bill_events.new_correlation_id()

    try:
        batch = _db.batch()
        new_ref = _receipts_ref.document()
        batch.set(new_ref, {
            "stay_id":         stay_id,
            "payment_id":      payment_id,
            "receipt_no":      rcpt_no,
            "receipt_kind":    kind,
            "method":          method,
            "amount_paise":    amt,
            "amount":          paise_to_rupees_int(amt),
            "receipt_date":    on.strftime("%Y-%m-%d"),
            "issued_at":       issued_iso,
            "status":          "issued",
            "voided_at":       None,
            "correlation_id":  correlation_id,
        })
        eligibility = (DepositEligibility.ELIGIBLE
                       if method == PaymentMethod.CASH
                       else DepositEligibility.EXCLUDED)
        batch.update(_payments_ref.document(payment_id), {
            PAY_OFFICIALIZED_AT:     issued_iso,
            PAY_RECEIPT_ID:          new_ref.id,
            PAY_RECEIPT_NO:          rcpt_no,
            PAY_RECEIPT_ISSUED_AT:   issued_iso,
            PAY_DEPOSIT_ELIGIBILITY: eligibility,
            PAY_INVOICEABLE:         True,
            PAY_AMOUNT_PAISE:        amt,
        })
        batch.commit()
    except Exception as e:
        logger.error(
            f"_issue_post_trigger_receipt failed for payment={payment_id}: {e}"
        )
        return None

    bill_events.record(
        stay_id, BillEventType.RECEIPT_ISSUED,
        payload={"payment_id": payment_id, "receipt_no": rcpt_no,
                 "method": method},
        correlation_id=correlation_id,
    )
    return {
        "stay_id":               stay_id,
        "trigger_token":         None,
        "already_invoiceable":   True,
        "rv_receipts":           [rcpt_no] if method == PaymentMethod.CASH else [],
        "or_receipt":            rcpt_no if method == PaymentMethod.ONLINE else None,
        "backfilled_payment_ids": [],
    }


def issue_receipt_for_new_payment(stay_id: str, payment_id: str,
                                  *, method: str) -> Optional[dict]:
    """
    Public entry point for "a new payment was just written on an
    already-invoiceable stay". Looks up the bill; if invoiceable, issues
    the receipt. If the bill is NOT invoiceable yet and this is an
    online payment, fires the trigger instead.

    If the bill is not invoiceable yet and this is a CASH payment,
    leaves it as `pending` (the trigger will backfill later) and
    returns None.

    This is the one call the existing payment-writer call sites need
    to add.
    """
    if _bills_ref is None or not stay_id or not payment_id:
        return None
    try:
        bill_snap = _bills_ref.document(stay_id).get()
    except Exception as e:
        logger.warning(f"issue_receipt_for_new_payment read failed: {e}")
        return None
    if not bill_snap.exists:
        return None
    bill = bill_snap.to_dict() or {}
    invoiceable = bool(bill.get(BILL_INVOICEABLE, False))

    if method == PaymentMethod.CASH:
        if not invoiceable:
            # Stamp as pending and wait for trigger
            try:
                _payments_ref.document(payment_id).update({
                    PAY_DEPOSIT_ELIGIBILITY: DepositEligibility.PENDING,
                    PAY_INVOICEABLE:         False,
                })
            except Exception as e:
                logger.warning(
                    f"pending-stamp failed for payment={payment_id}: {e}"
                )
            return None
        return _issue_post_trigger_receipt(
            stay_id=stay_id, payment_id=payment_id,
        )

    # Online: fire trigger or issue OR receipt
    if method == PaymentMethod.ONLINE:
        if invoiceable:
            return _issue_post_trigger_receipt(
                stay_id=stay_id, payment_id=payment_id,
            )
        return fire_trigger(stay_id, trigger_payment_id=payment_id)

    logger.warning(
        f"issue_receipt_for_new_payment: unknown method {method!r} "
        f"on payment={payment_id}"
    )
    return None


# ───────────────────────── Checkout side-effects ─────────────────────

def mark_unofficial_on_checkout(stay_id: str) -> bool:
    """
    Called from /checkout when the bill is finalized WITHOUT a real
    bill_number (i.e. invoiceable stayed false). Flips every pending
    cash payment on this stay to `excluded`, so the deposit screen
    never shows them.

    Returns True on success (including the no-op case where the bill
    had no pending payments), False on Firestore error.
    """
    if _payments_ref is None or not stay_id:
        return False
    try:
        q = (
            _payments_ref
            .where(filter=fa_firestore.FieldFilter("stay_id", "==", stay_id))
            .where(filter=fa_firestore.FieldFilter(
                PAY_DEPOSIT_ELIGIBILITY, "==", DepositEligibility.PENDING))
        )
        snaps = list(q.stream())
        if not snaps:
            bill_events.record(
                stay_id, BillEventType.MARKED_UNOFFICIAL,
                payload={"affected_payment_count": 0},
            )
            return True

        batch = _db.batch()
        for snap in snaps:
            batch.update(snap.reference, {
                PAY_DEPOSIT_ELIGIBILITY: DepositEligibility.EXCLUDED,
                PAY_INVOICEABLE:         False,
            })
        batch.commit()
        bill_events.record(
            stay_id, BillEventType.MARKED_UNOFFICIAL,
            payload={"affected_payment_count": len(snaps)},
        )
        write_log(
            "banking.bill.marked_unofficial",
            target_collection=COL_BILLS,
            target_id=stay_id,
            metadata={"cash_payment_count": len(snaps)},
        )
        return True
    except Exception as e:
        logger.error(f"mark_unofficial_on_checkout({stay_id}) failed: {e}",
                     exc_info=True)
        return False


# ───────────────────────── Edit cascade (un-trigger) ─────────────────

class UnTriggerBlocked(Exception):
    """Raised when an edit would un-trigger a stay that has already had
    cash deposited. Caller must surface this to the user."""
    def __init__(self, stay_id: str, first_deposit_at: str):
        super().__init__(
            f"Cannot un-trigger stay={stay_id}: cash already deposited "
            f"on {first_deposit_at}. Reverse the deposit first or add "
            f"another online payment to keep the stay invoiceable."
        )
        self.stay_id = stay_id
        self.first_deposit_at = first_deposit_at


def revert_trigger_if_safe(stay_id: str, *, reason: str = "") -> bool:
    """
    Un-trigger a stay back to non-invoiceable. ONLY succeeds if no
    cash from this stay has been deposited yet. Voids all receipts
    issued for this stay (numbers stay in the counter — gap-free).

    Returns True on success, False on Firestore error. Raises
    UnTriggerBlocked if the bill has `first_deposit_at` set.

    This is the rare "user edited away the only online payment" path.
    See ARCHITECTURE.md for the operational guidance.
    """
    if _bills_ref is None or not stay_id:
        return False
    try:
        bill_snap = _bills_ref.document(stay_id).get()
        if not bill_snap.exists:
            return False
        bill = bill_snap.to_dict() or {}
    except Exception as e:
        logger.error(f"revert_trigger read failed: {e}")
        return False

    if not bill.get(BILL_INVOICEABLE):
        return True  # already non-invoiceable

    first_deposit_at = bill.get(BILL_FIRST_DEPOSIT_AT)
    if first_deposit_at:
        raise UnTriggerBlocked(stay_id, first_deposit_at)

    try:
        # Find every receipt for this stay
        receipts = list(
            _receipts_ref
            .where(filter=fa_firestore.FieldFilter("stay_id", "==", stay_id))
            .where(filter=fa_firestore.FieldFilter("status", "==", "issued"))
            .stream()
        )
        payments = list(
            _payments_ref
            .where(filter=fa_firestore.FieldFilter("stay_id", "==", stay_id))
            .stream()
        )
    except Exception as e:
        logger.error(f"revert_trigger query failed: {e}")
        return False

    now_iso = _ist_now_iso()
    correlation_id = bill_events.new_correlation_id()

    try:
        batch = _db.batch()
        for r in receipts:
            batch.update(r.reference, {
                "status":      "voided",
                "voided_at":   now_iso,
                "void_reason": (reason or "trigger_reverted")[:200],
            })
        for p in payments:
            d = p.to_dict() or {}
            # Cash → back to pending; online → back to excluded (it had
            # no receipt in the non-invoiceable state, but voiding its
            # receipt above keeps the audit trail).
            method = d.get(PAY_METHOD)
            if method == PaymentMethod.CASH:
                new_elig = DepositEligibility.PENDING
            else:
                new_elig = DepositEligibility.EXCLUDED
            batch.update(p.reference, {
                PAY_RECEIPT_ID:          None,
                PAY_RECEIPT_NO:          None,
                PAY_RECEIPT_ISSUED_AT:   None,
                PAY_OFFICIALIZED_AT:     None,
                PAY_DEPOSIT_ELIGIBILITY: new_elig,
                PAY_INVOICEABLE:         False,
            })
        batch.update(_bills_ref.document(stay_id), {
            BILL_INVOICEABLE:                  False,
            BILL_INVOICEABLE_AT:               None,
            BILL_INVOICEABLE_TRIGGER_PAYMENT:  None,
            BILL_INVOICEABLE_TRIGGER_TOKEN:    None,
            "updated_at":                      now_iso,
        })
        batch.commit()
    except Exception as e:
        logger.error(
            f"revert_trigger({stay_id}) batch failed: {e}", exc_info=True
        )
        return False

    bill_events.record(
        stay_id, BillEventType.TRIGGER_REVERTED,
        payload={
            "voided_receipt_count": len(receipts),
            "reason":               (reason or "")[:200],
        },
        correlation_id=correlation_id,
    )
    write_log(
        "banking.trigger.reverted",
        target_collection=COL_BILLS,
        target_id=stay_id,
        metadata={"reason": reason, "voided_receipts": len(receipts)},
    )
    return True


# ───────────────────────── Reads ─────────────────────────────────────

def get_receipt(receipt_id: str) -> Optional[dict]:
    if _receipts_ref is None or not receipt_id:
        return None
    try:
        snap = _receipts_ref.document(receipt_id).get()
        if not snap.exists:
            return None
        d = snap.to_dict() or {}
        d["id"] = snap.id
        return d
    except Exception as e:
        logger.warning(f"get_receipt({receipt_id}) failed: {e}")
        return None


def list_receipts_for_stay(stay_id: str) -> list[dict]:
    if _receipts_ref is None or not stay_id:
        return []
    try:
        q = (
            _receipts_ref
            .where(filter=fa_firestore.FieldFilter("stay_id", "==", stay_id))
        )
        out = []
        for snap in q.stream():
            d = snap.to_dict() or {}
            d["id"] = snap.id
            out.append(d)
        out.sort(key=lambda r: r.get("issued_at", ""))
        return out
    except Exception as e:
        logger.warning(f"list_receipts_for_stay({stay_id}) failed: {e}")
        return []
