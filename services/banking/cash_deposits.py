"""
Bank deposit lifecycle.

A `cash_deposit` doc represents one physical trip to the bank. It owns:

    * a date and bank account
    * the set of `eligible` cash payments it consumes
    * the set of cash expenses paid during the same period
    * the set of cash adjustments (over/short/owner) within the period
    * a gross / expenses / net summary in paise (definitive)
    * a status: draft → confirmed → reconciled (or reversed)

Confirming a deposit is the moment the cash leaves staff hands. The
operation stamps `cash_deposit_id` onto every consumed payment/expense
and flips their eligibility to `deposited`. The reverse-operation
(admin-only) is also implemented but expected to be rare.

The financial integrity invariant — checked by validators.py — is:

    deposit.net_paise
       == Σ payments.amount_paise (where cash_deposit_id = D, voided_at is null)
        − Σ expenses.amount_paise (where cash_deposit_id = D, voided_at is null)
        + Σ adjustments.amount_paise (signed, where cash_deposit_id = D)

If this ever fails, validators.run_integrity_check raises and a deposit
cannot be confirmed.
"""

from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from typing import Optional, Iterable

from firebase_admin import firestore
from firebase_admin import firestore as fa_firestore

from config import IST
from services.audit_log import (
    write_log, attribution_create, attribution_update,
)

from . import bill_events, counters
from .money import (
    coerce_to_paise, paise_to_rupees_int, sum_paise, is_non_negative_paise,
)
from .schema import (
    COL_PAYMENTS, COL_EXPENSES, COL_CASH_DEPOSITS, COL_CASH_ADJUSTMENTS,
    COL_BILLS,
    PaymentMethod, DepositEligibility, DepositStatus, BillEventType,
    CounterKind,
    PAY_METHOD, PAY_AMOUNT_PAISE, PAY_DEPOSIT_ELIGIBILITY,
    PAY_CASH_DEPOSIT_ID, PAY_VOIDED_AT,
    EXP_CASH_DEPOSIT_ID, EXP_VOIDED_AT, EXP_AMOUNT_PAISE,
    BILL_FIRST_DEPOSIT_AT,
    BANKING_START_DATE,
)

logger = logging.getLogger(__name__)


_db = None
_deposits_ref = None
_payments_ref = None
_expenses_ref = None
_adjustments_ref = None
_bills_ref = None


def init(db) -> None:
    global _db, _deposits_ref, _payments_ref, _expenses_ref
    global _adjustments_ref, _bills_ref
    _db = db
    _deposits_ref = db.collection(COL_CASH_DEPOSITS)
    _payments_ref = db.collection(COL_PAYMENTS)
    _expenses_ref = db.collection(COL_EXPENSES)
    _adjustments_ref = db.collection(COL_CASH_ADJUSTMENTS)
    _bills_ref = db.collection(COL_BILLS)
    logger.info("Banking.cash_deposits initialised")


def _ist_now_iso() -> str:
    return datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")


# --- Banking epoch ---------------------------------------------------
# Cash dated before BANKING_START_DATE is invisible to every Banking
# view. _banking_cutoff() parses the configured string; _floor_start()
# clamps a query's lower date bound so callers never see pre-epoch rows.

def _banking_cutoff() -> Optional[date]:
    """The banking epoch as a date, or None when the cutoff is disabled."""
    raw = (BANKING_START_DATE or "").strip()[:10]
    if not raw:
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        logger.warning(
            f"BANKING_START_DATE {raw!r} is not a valid ISO date; "
            f"banking cutoff disabled"
        )
        return None


def _floor_start(period_start: Optional[date]) -> Optional[date]:
    """
    Clamp a query's lower date bound to the banking epoch. Returns the
    later of `period_start` and the cutoff (whichever is set). When the
    cutoff is disabled, `period_start` is returned unchanged.
    """
    cutoff = _banking_cutoff()
    if cutoff is None:
        return period_start
    if period_start is None:
        return cutoff
    return max(period_start, cutoff)


def _parallel_get(collection_ref, doc_ids):
    """
    Fetch multiple documents from a Firestore collection in PARALLEL
    using a thread pool. Returns a dict {doc_id: (data_or_None, exists)}.

    Replaces the common pattern of sequential `.get()` calls in a loop —
    which adds one network round-trip per document. With 6 rows that's
    a 6× wall-clock improvement on the typical deposit confirm/draft
    path.

    Returns an empty dict if `doc_ids` is empty. Failures on individual
    documents are reported as (None, False) — caller handles missing
    docs the same way as it would for a missing single `.get()`.
    """
    ids = list(doc_ids or [])
    if not ids:
        return {}

    def _one(doc_id):
        try:
            snap = collection_ref.document(doc_id).get()
            if snap.exists:
                return doc_id, (snap.to_dict() or {}, True)
            return doc_id, (None, False)
        except Exception as e:
            logger.warning(f"_parallel_get({doc_id}) failed: {e}")
            return doc_id, (None, False)

    # Bounded thread pool — Firestore admin SDK is thread-safe; 10
    # parallel reads is well within practical limits for the typical
    # ≤50-row deposit. The pool dies with the function.
    with ThreadPoolExecutor(max_workers=min(10, len(ids))) as ex:
        return dict(ex.map(_one, ids))


# ───────────────────────── Unofficial cash (off-deposit) ─────────────

def list_unofficial_payments(
    *,
    limit: int = 500,
    property_id: str = "",
    period_start: Optional[date] = None,
    period_end: Optional[date] = None,
) -> list[dict]:
    """
    Return every cash payment that has been classified as off-deposit
    (`deposit_eligibility = "excluded"`), newest first. Optional date
    range filter on the payment `date` field.

    These are payments that came in on stays which finished with no
    bill_number (invoice toggle was off). They are never depositable
    via the Banking screens; this list exists so the operator can still
    see / audit them.
    """
    if _payments_ref is None:
        return []
    try:
        period_start = _floor_start(period_start)
        q = (
            _payments_ref
            .where(filter=fa_firestore.FieldFilter(
                PAY_METHOD, "==", PaymentMethod.CASH))
            .where(filter=fa_firestore.FieldFilter(
                "deposit_eligibility", "==", DepositEligibility.EXCLUDED))
        )
        rows = []
        for snap in q.stream():
            d = snap.to_dict() or {}
            if d.get(PAY_VOIDED_AT):
                continue
            if property_id and d.get("property_id", "") != property_id:
                continue
            dt = (d.get("date") or d.get("created_at") or "")[:10]
            if period_start and dt and dt < period_start.isoformat():
                continue
            if period_end and dt and dt > period_end.isoformat():
                continue
            d["id"] = snap.id
            rows.append(d)
            if len(rows) >= limit:
                break
        # Newest first (by payment date then doc id for stability)
        rows.sort(
            key=lambda r: (r.get("date") or "", r.get("id") or ""),
            reverse=True,
        )
        return rows
    except Exception as e:
        logger.warning(f"list_unofficial_payments failed: {e}")
        return []


# ───────────────────────── Draft / build ────────────────────────────

def list_eligible_payments(
    *,
    period_start: Optional[date] = None,
    period_end: Optional[date] = None,
    property_id: str = "",
) -> list[dict]:
    """
    Return every cash payment that could be included in a fresh deposit:
      method = cash
      deposit_eligibility = eligible
      cash_deposit_id is null
      voided_at is null
      officialized_at falls inside [period_start, period_end] inclusive
        (when bounds provided)

    Ordered by officialized_at ascending so older cash is shown first.
    """
    if _payments_ref is None:
        return []
    try:
        period_start = _floor_start(period_start)
        q = (
            _payments_ref
            .where(filter=fa_firestore.FieldFilter(
                PAY_METHOD, "==", PaymentMethod.CASH))
            .where(filter=fa_firestore.FieldFilter(
                PAY_DEPOSIT_ELIGIBILITY, "==", DepositEligibility.ELIGIBLE))
        )
        rows = []
        for snap in q.stream():
            d = snap.to_dict() or {}
            if d.get(PAY_VOIDED_AT):
                continue
            if d.get(PAY_CASH_DEPOSIT_ID):
                continue
            if property_id and d.get("property_id", "") != property_id:
                continue
            off = d.get("officialized_at") or ""
            if period_start and off and off[:10] < period_start.isoformat():
                continue
            if period_end and off and off[:10] > period_end.isoformat():
                continue
            d["id"] = snap.id
            rows.append(d)
        rows.sort(key=lambda r: (r.get("officialized_at") or "", r.get("id")))
        return rows
    except Exception as e:
        logger.warning(f"list_eligible_payments failed: {e}")
        return []


def list_eligible_expenses(
    *,
    period_start: Optional[date] = None,
    period_end: Optional[date] = None,
    property_id: str = "",
    limit: int = 500,
) -> list[dict]:
    """
    Cash expenses that haven't been bundled into a deposit yet.

    Performance
    -----------
    Pushes the `payment_method == "cash"` and `date >= period_start`
    filters into Firestore so the wire only carries candidate rows
    (instead of every expense ever). The remaining client-side filters
    (voided / already linked / property scope / upper date bound) are
    cheap because they apply to a small candidate set.

    The first time these compound filters run, Firestore will ask for
    a composite index on (payment_method, date) — the dev console
    will print a link to auto-create it. Until then the query falls
    back to the legacy full-collection scan; see the except branch.
    """
    if _expenses_ref is None:
        return []

    period_start = _floor_start(period_start)

    def _post_filter(snap_iter):
        out = []
        for snap in snap_iter:
            d = snap.to_dict() or {}
            if d.get(EXP_VOIDED_AT):
                continue
            if d.get(EXP_CASH_DEPOSIT_ID):
                continue
            # Only DAILY (transaction-type) expenses are deposit-eligible.
            # Report-type expenses are paid from off-deposit cash and
            # surface in the Unofficial tab instead. Treat missing
            # `expense_type` as "transaction" so legacy expenses from
            # before this distinction existed still get bundled.
            etype = (d.get("expense_type") or "transaction").lower()
            if etype != "transaction":
                continue
            # Defensive: if the Firestore filter wasn't applied, re-check
            # method here so the function still returns correct rows.
            pm = (d.get("payment_method") or d.get(PAY_METHOD)
                  or "cash").lower()
            if pm != PaymentMethod.CASH:
                continue
            if property_id and d.get("property_id", "") != property_id:
                continue
            dt = (d.get("expense_date") or d.get("date") or "")[:10]
            if period_start and dt and dt < period_start.isoformat():
                continue
            if period_end and dt and dt > period_end.isoformat():
                continue
            d["id"] = snap.id
            out.append(d)
            if len(out) >= limit:
                break
        return out

    # ---- Indexed path: ask Firestore to do the heavy lifting --------
    try:
        q = _expenses_ref.where(
            filter=fa_firestore.FieldFilter("payment_method", "==",
                                            PaymentMethod.CASH)
        )
        if period_start:
            q = q.where(
                filter=fa_firestore.FieldFilter(
                    "date", ">=", period_start.isoformat())
            )
        rows = _post_filter(q.stream())
        rows.sort(
            key=lambda r: (r.get("expense_date") or r.get("date") or "",
                           r.get("id"))
        )
        return rows
    except Exception as e:
        # Firestore raises FailedPrecondition when a required composite
        # index doesn't exist. Fall back to the legacy full-scan path
        # so the UI still works (slowly) until the operator creates
        # the index.
        logger.warning(
            f"list_eligible_expenses indexed query failed ({e}); "
            f"falling back to full scan. Create the suggested composite "
            f"index from the Firestore console to speed this up."
        )
        try:
            rows = _post_filter(_expenses_ref.stream())
            rows.sort(
                key=lambda r: (r.get("expense_date") or r.get("date") or "",
                               r.get("id"))
            )
            return rows
        except Exception as e2:
            logger.warning(f"list_eligible_expenses fallback failed: {e2}")
            return []


# ───────────────────────── Cash on hand ─────────────────────────────

# Cash refunds appear as `payments` docs with these `type` values. They
# are outflows from the cash drawer — a guest got money back — and must
# reduce cash-on-hand. The existing payment writer never sets these as
# eligible for deposit (the trigger / banking hook explicitly skips
# them), so they live in `payments` without ever touching a deposit FK.
_CASH_REFUND_TYPES = frozenset({
    "refund", "checkout_refund", "manual_refund", "booking_cancel_refund",
})


# ---- Cash-on-hand cache --------------------------------------------------
# Short-TTL in-memory cache so the live COH banner doesn't recompute on
# every page render. Recomputing requires scanning eligible payments +
# expenses + adjustments + refunds — under 1s on a small property, but
# painful when the operator clicks Banking → New Deposit a few times in
# a row. 30s TTL is short enough that operator never sees stale numbers
# in practice, and the write paths below invalidate it explicitly when
# they make a cash drawer change.
_COH_CACHE_TTL_SEC = 30
_coh_cache = {}            # property_id -> (paise, expires_at)
_coh_cache_lock = threading.Lock()


def _coh_cache_get(property_id):
    with _coh_cache_lock:
        entry = _coh_cache.get(property_id)
        if not entry:
            return None
        paise, expires_at = entry
        if time.monotonic() > expires_at:
            _coh_cache.pop(property_id, None)
            return None
        return paise


def _coh_cache_set(property_id, paise):
    with _coh_cache_lock:
        _coh_cache[property_id] = (paise, time.monotonic() + _COH_CACHE_TTL_SEC)


def invalidate_cash_on_hand_cache(property_id=None):
    """
    Drop the cached COH for one property (or all if property_id is None).
    Called by every write path that mutates cash-drawer state — confirm,
    reverse, create_draft, create_adjustment, etc. Without these calls
    the operator could see stale COH numbers for up to TTL seconds after
    a deposit.
    """
    with _coh_cache_lock:
        if property_id is None:
            _coh_cache.clear()
        else:
            _coh_cache.pop(property_id, None)


def list_unofficial_cash_expenses(
    *,
    period_start: Optional[date] = None,
    period_end: Optional[date] = None,
    property_id: str = "",
    limit: int = 500,
) -> list[dict]:
    """
    Cash expenses marked as `expense_type == "report"` — these are paid
    out of off-deposit (unofficial) cash and never participate in the
    deposit flow. They surface in the Unofficial tab so the operator
    can audit them. Newest first.
    """
    if _expenses_ref is None:
        return []
    try:
        period_start = _floor_start(period_start)
        # Push the cash-method filter into Firestore so the wire
        # carries only cash expenses instead of every expense ever
        # recorded. A single-field equality filter is covered by
        # Firestore's automatic per-field index — it needs no
        # composite index and cannot raise FailedPrecondition. The
        # post-filter below still re-checks the method, so the result
        # set can only narrow, never gain a wrong row. Mirrors the
        # filter list_eligible_expenses already uses.
        q = _expenses_ref.where(
            filter=fa_firestore.FieldFilter(
                "payment_method", "==", PaymentMethod.CASH)
        )
        rows = []
        for snap in q.stream():
            d = snap.to_dict() or {}
            if d.get(EXP_VOIDED_AT):
                continue
            etype = (d.get("expense_type") or "transaction").lower()
            if etype != "report":
                continue
            pm = (d.get("payment_method") or d.get(PAY_METHOD)
                  or "cash").lower()
            if pm != PaymentMethod.CASH:
                continue
            if property_id and d.get("property_id", "") != property_id:
                continue
            dt = (d.get("expense_date") or d.get("date") or "")[:10]
            if period_start and dt and dt < period_start.isoformat():
                continue
            if period_end and dt and dt > period_end.isoformat():
                continue
            d["id"] = snap.id
            rows.append(d)
            if len(rows) >= limit:
                break
        rows.sort(
            key=lambda r: (r.get("date") or r.get("expense_date") or "",
                           r.get("id") or ""),
            reverse=True,
        )
        return rows
    except Exception as e:
        logger.warning(f"list_unofficial_cash_expenses failed: {e}")
        return []


def list_undeposited_cash_refunds(
    *,
    period_start: Optional[date] = None,
    period_end: Optional[date] = None,
    property_id: str = "",
    limit: int = 500,
) -> list[dict]:
    """
    Return cash refund payments that haven't been bundled into a deposit.

    These are cash that physically left the drawer to repay a guest —
    visible in the New Deposit screen as informational ("here's what
    came out of the drawer before today's bank trip"). They reduce
    cash-on-hand via `cash_on_hand_paise`.

    Newest first. Optional date range filter on payment `date`.
    """
    if _payments_ref is None:
        return []
    try:
        period_start = _floor_start(period_start)
        q = _payments_ref.where(
            filter=fa_firestore.FieldFilter(PAY_METHOD, "==",
                                            PaymentMethod.CASH)
        )
        rows = []
        for snap in q.stream():
            d = snap.to_dict() or {}
            if d.get(PAY_VOIDED_AT):
                continue
            if d.get(PAY_CASH_DEPOSIT_ID):
                continue
            t = (d.get("type") or "").lower().strip()
            if t not in _CASH_REFUND_TYPES:
                continue
            if property_id and d.get("property_id", "") != property_id:
                continue
            dt = (d.get("date") or d.get("created_at") or "")[:10]
            if period_start and dt and dt < period_start.isoformat():
                continue
            if period_end and dt and dt > period_end.isoformat():
                continue
            d["id"] = snap.id
            rows.append(d)
            if len(rows) >= limit:
                break
        rows.sort(
            key=lambda r: (r.get("date") or "", r.get("id") or ""),
            reverse=True,
        )
        return rows
    except Exception as e:
        logger.warning(f"list_undeposited_cash_refunds failed: {e}")
        return []


def _undeposited_cash_refunds_paise(*, property_id: str = "") -> int:
    """
    Sum of cash refunds (paise) that haven't been bundled into a deposit
    yet — i.e. cash that physically left the drawer to repay a guest.
    Subtracted from cash-on-hand in `cash_on_hand_paise`.
    """
    rows = list_undeposited_cash_refunds(property_id=property_id, limit=10000)
    total = 0
    for r in rows:
        total += coerce_to_paise(r)
    return total


def cash_on_hand_paise(*, property_id: str = "",
                       force_fresh: bool = False) -> int:
    """
    Live "money in the drawer" — sum of every payment / expense /
    refund / adjustment that is OFFICIAL (invoiceable) but UNDEPOSITED.

    Formula:
       Σ eligible cash payments      (inflows)
     − Σ undeposited cash expenses   (outflows)
     − Σ undeposited cash refunds    (outflows — money given back)
     + Σ adjustments with cash_deposit_id is null (signed)

    Cached for 30s per property (see _coh_cache above). Write paths
    that change cash-drawer state call invalidate_cash_on_hand_cache().
    Pass force_fresh=True to bypass the cache (e.g. after a manual
    backfill that touched lots of rows).
    """
    if _payments_ref is None:
        return 0
    if not force_fresh:
        cached = _coh_cache_get(property_id)
        if cached is not None:
            return cached
    try:
        # cash_in, cash_out, cash_refunds and the adjustments scan are
        # four independent Firestore reads. Run them concurrently so a
        # cold cash-on-hand recompute (e.g. the first New Deposit open
        # after the 30s cache expires) costs the slowest single read,
        # not the sum of all four. Each task only reads; the admin SDK
        # is thread-safe.
        _adj_cutoff = _banking_cutoff()

        def _adjustments_total() -> int:
            # Adjustments (signed) without a deposit. Pre-cutoff
            # adjustments are excluded so COH matches the deposit
            # picker's adjustments.
            total = 0
            for snap in _adjustments_ref.stream():
                d = snap.to_dict() or {}
                if d.get("cash_deposit_id"):
                    continue
                if property_id and d.get("property_id", "") != property_id:
                    continue
                if _adj_cutoff and (d.get("adjustment_date") or "")[:10] \
                        < _adj_cutoff.isoformat():
                    continue
                try:
                    total += int(d.get("amount_paise") or 0)
                except (TypeError, ValueError):
                    pass
            return total

        with ThreadPoolExecutor(max_workers=4) as _ex:
            _f_in = _ex.submit(list_eligible_payments,
                               property_id=property_id)
            _f_out = _ex.submit(list_eligible_expenses,
                                property_id=property_id)
            _f_ref = _ex.submit(_undeposited_cash_refunds_paise,
                                property_id=property_id)
            _f_adj = _ex.submit(_adjustments_total)
        cash_in = sum_paise(_f_in.result(), key=PAY_AMOUNT_PAISE)
        cash_out = sum_paise(_f_out.result(), key=EXP_AMOUNT_PAISE)
        cash_refunds = _f_ref.result()
        adj_total = _f_adj.result()
        result = cash_in - cash_out - cash_refunds + adj_total
        _coh_cache_set(property_id, result)
        return result
    except Exception as e:
        logger.warning(f"cash_on_hand_paise failed: {e}")
        return 0


# ───────────────────────── Create draft ─────────────────────────────

def create_draft(
    *,
    deposit_date: date,
    bank_account_id: str,
    payment_ids: Iterable[str],
    expense_ids: Iterable[str] = (),
    adjustment_ids: Iterable[str] = (),
    slip_number: str = "",
    notes: str = "",
    period_start: Optional[date] = None,
    period_end: Optional[date] = None,
    property_id: str = "",
) -> Optional[dict]:
    """
    Build a draft deposit. Does NOT mutate any payment/expense yet —
    that happens in `confirm()`. Returns the deposit doc on success,
    None on validation failure.

    The draft snapshots gross / expenses / net at creation time so a
    later edit to a constituent row can be detected as drift.
    """
    if _deposits_ref is None:
        return None
    if not bank_account_id:
        logger.error("create_draft: bank_account_id required")
        return None
    payment_ids = list(payment_ids)
    expense_ids = list(expense_ids)
    adjustment_ids = list(adjustment_ids)
    if not payment_ids and not expense_ids and not adjustment_ids:
        logger.error("create_draft: at least one row required")
        return None

    # Fetch ALL constituent rows in parallel — replaces the 3 serial
    # loops that previously did one network round-trip per document.
    # Validation runs in-memory after the reads return.
    gross_paise = 0
    expense_paise = 0
    adj_paise = 0
    try:
        pays_map = _parallel_get(_payments_ref, payment_ids)
        exps_map = _parallel_get(_expenses_ref, expense_ids)
        adjs_map = _parallel_get(_adjustments_ref, adjustment_ids)

        for pid in payment_ids:
            pd, exists = pays_map.get(pid, (None, False))
            if not exists:
                logger.error(f"create_draft: payment {pid} not found")
                return None
            if pd.get(PAY_METHOD) != PaymentMethod.CASH:
                logger.error(f"create_draft: payment {pid} is not cash")
                return None
            if pd.get(PAY_DEPOSIT_ELIGIBILITY) != DepositEligibility.ELIGIBLE:
                logger.error(
                    f"create_draft: payment {pid} eligibility = "
                    f"{pd.get(PAY_DEPOSIT_ELIGIBILITY)!r}, expected eligible"
                )
                return None
            if pd.get(PAY_CASH_DEPOSIT_ID):
                logger.error(
                    f"create_draft: payment {pid} already deposited "
                    f"under {pd.get(PAY_CASH_DEPOSIT_ID)}"
                )
                return None
            if pd.get(PAY_VOIDED_AT):
                logger.error(f"create_draft: payment {pid} is voided")
                return None
            gross_paise += coerce_to_paise(pd)

        for eid in expense_ids:
            ed, exists = exps_map.get(eid, (None, False))
            if not exists:
                logger.error(f"create_draft: expense {eid} not found")
                return None
            if ed.get(EXP_CASH_DEPOSIT_ID):
                logger.error(f"create_draft: expense {eid} already linked")
                return None
            if ed.get(EXP_VOIDED_AT):
                logger.error(f"create_draft: expense {eid} is voided")
                return None
            expense_paise += coerce_to_paise(
                ed, paise_key=EXP_AMOUNT_PAISE, rupee_key="amount",
            )

        for aid in adjustment_ids:
            ad, exists = adjs_map.get(aid, (None, False))
            if not exists:
                logger.error(f"create_draft: adjustment {aid} not found")
                return None
            if ad.get("cash_deposit_id"):
                logger.error(f"create_draft: adjustment {aid} already linked")
                return None
            adj_paise += int(ad.get("amount_paise") or 0)

    except Exception as e:
        logger.error(f"create_draft validation failed: {e}", exc_info=True)
        return None

    # Auto-include cash refunds in the deposit's period. Refunds aren't
    # selectable by the operator (cash already left the drawer), but
    # they must be "closed out" by SOMETHING — otherwise they reappear
    # in the next deposit's picker indefinitely. The deposit doc gets
    # a `refund_ids` field listing every refund accounted for; confirm
    # stamps cash_deposit_id on each, reverse unlinks them.
    refund_ids = []
    refund_paise = 0
    try:
        refund_rows = list_undeposited_cash_refunds(
            period_start=period_start, period_end=period_end,
            property_id=property_id,
        )
        for r in refund_rows:
            refund_ids.append(r["id"])
            refund_paise += coerce_to_paise(r)
    except Exception as e:
        logger.warning(f"create_draft: refund query failed: {e}")

    net_paise = gross_paise - expense_paise - refund_paise + adj_paise
    if net_paise < 0:
        logger.error(
            f"create_draft: negative net ₹{net_paise/100:.2f} — refused. "
            f"Reduce expenses or adjustments selected, or fix data first."
        )
        return None

    serial = counters.next_serial(CounterKind.DEPOSIT, on_date=deposit_date)
    if serial is None:
        return None
    deposit_ref = counters.format_deposit_ref(serial, on_date=deposit_date)

    doc = {
        "deposit_date":   deposit_date.strftime("%Y-%m-%d"),
        "bank_account_id": bank_account_id,
        "period_start":   period_start.isoformat() if period_start else "",
        "period_end":     period_end.isoformat() if period_end else "",
        "payment_ids":    list(payment_ids),
        "expense_ids":    list(expense_ids),
        "adjustment_ids": list(adjustment_ids),
        "refund_ids":     refund_ids,
        "gross_paise":    int(gross_paise),
        "expenses_paise": int(expense_paise),
        "refunds_paise":  int(refund_paise),
        "adjustments_paise": int(adj_paise),
        "net_paise":      int(net_paise),
        "gross":          paise_to_rupees_int(gross_paise),
        "expenses":       paise_to_rupees_int(expense_paise),
        "refunds":        paise_to_rupees_int(refund_paise),
        "net":            paise_to_rupees_int(net_paise),
        "slip_number":    slip_number.strip(),
        "slip_image_url": "",
        "notes":          notes,
        "status":         DepositStatus.DRAFT,
        "deposit_ref":    deposit_ref,
        "property_id":    property_id or "",
        "confirmed_at":   None,
        "confirmed_by":   None,
        "reconciled_at":  None,
        "reconciled_by":  None,
        "reversed_at":    None,
        "reversed_by":    None,
        "reversal_reason": "",
    }
    doc.update(attribution_create())

    try:
        new_ref = _deposits_ref.document()
        new_ref.set(doc)
    except Exception as e:
        logger.error(f"create_draft write failed: {e}", exc_info=True)
        return None

    doc["id"] = new_ref.id
    write_log(
        "banking.deposit.draft",
        target_collection=COL_CASH_DEPOSITS,
        target_id=new_ref.id,
        metadata={
            "gross_paise": gross_paise, "expenses_paise": expense_paise,
            "net_paise": net_paise, "rows": len(payment_ids) + len(expense_ids),
        },
    )
    return doc


# ───────────────────────── Confirm ──────────────────────────────────

class DepositIntegrityError(Exception):
    """Raised when a deposit's stored totals don't match its constituent rows."""
    pass


def confirm(deposit_id: str, *,
            slip_number: Optional[str] = None,
            slip_image_url: Optional[str] = None,
            actor_user_id: Optional[str] = None) -> bool:
    """
    Flip a draft → confirmed. Stamps cash_deposit_id onto every
    constituent payment / expense / adjustment, flips payments to
    `deposited` eligibility, sets `first_deposit_at` on each stay (only
    if not already set — this is a one-way lock).

    Returns False on validation/write failure. The integrity check
    (validators.py) runs as the first step; a drift between the stored
    totals and the live sum aborts the confirm.
    """
    if _deposits_ref is None or not deposit_id:
        return False

    # Import here to avoid a cycle (validators imports cash_deposits).
    from . import validators

    try:
        snap = _deposits_ref.document(deposit_id).get()
        if not snap.exists:
            logger.error(f"confirm: deposit {deposit_id} not found")
            return False
        dep = snap.to_dict() or {}
    except Exception as e:
        logger.error(f"confirm: read failed: {e}")
        return False

    if dep.get("status") != DepositStatus.DRAFT:
        logger.error(
            f"confirm: deposit {deposit_id} status={dep.get('status')!r}, "
            f"expected draft"
        )
        return False

    # Drift check
    try:
        ok, msg = validators.verify_deposit_totals(deposit_id, expected=dep)
        if not ok:
            logger.error(f"confirm: drift detected on {deposit_id}: {msg}")
            return False
    except DepositIntegrityError as e:
        logger.error(f"confirm: integrity violation: {e}")
        return False

    now_iso = _ist_now_iso()
    if slip_number is not None or slip_image_url is not None:
        # Patch the draft first
        patch = {}
        if slip_number is not None:
            patch["slip_number"] = slip_number.strip()
        if slip_image_url is not None:
            patch["slip_image_url"] = slip_image_url.strip()
        try:
            _deposits_ref.document(deposit_id).update(patch)
            dep.update(patch)
        except Exception as e:
            logger.warning(f"confirm: pre-confirm patch failed: {e}")

    # Stamp all rows + flip status in one batch
    try:
        batch = _db.batch()
        stays_to_lock = set()
        for pid in dep.get("payment_ids", []):
            batch.update(_payments_ref.document(pid), {
                PAY_CASH_DEPOSIT_ID:     deposit_id,
                PAY_DEPOSIT_ELIGIBILITY: DepositEligibility.DEPOSITED,
            })
            # We need the stay_id of this payment to set first_deposit_at
            try:
                p = _payments_ref.document(pid).get()
                if p.exists:
                    sid = (p.to_dict() or {}).get("stay_id")
                    if sid:
                        stays_to_lock.add(sid)
            except Exception:
                pass
        for eid in dep.get("expense_ids", []):
            batch.update(_expenses_ref.document(eid), {
                EXP_CASH_DEPOSIT_ID: deposit_id,
            })
        for aid in dep.get("adjustment_ids", []):
            batch.update(_adjustments_ref.document(aid), {
                "cash_deposit_id": deposit_id,
            })
        # Refunds: mark them as accounted-for by this deposit so they
        # disappear from the next picker. Their `deposit_eligibility`
        # stays "excluded" (refunds are never depositable inflows) —
        # only the FK is stamped.
        for rfid in dep.get("refund_ids", []):
            batch.update(_payments_ref.document(rfid), {
                PAY_CASH_DEPOSIT_ID: deposit_id,
            })
        batch.update(_deposits_ref.document(deposit_id), {
            "status":       DepositStatus.CONFIRMED,
            "confirmed_at": now_iso,
            "confirmed_by": actor_user_id or "system",
            **attribution_update(),
        })
        batch.commit()
    except Exception as e:
        logger.error(f"confirm: batch failed: {e}", exc_info=True)
        return False

    # Set first_deposit_at on each affected stay (idempotent — only if null).
    # Done outside the batch because Firestore can't conditional-update
    # across docs in one batch. Race: two concurrent deposits on the
    # same stay both call this — both succeed but only the first
    # actually changes the value (we read then conditionally write).
    for sid in stays_to_lock:
        try:
            sb_snap = _bills_ref.document(sid).get()
            if not sb_snap.exists:
                continue
            if (sb_snap.to_dict() or {}).get(BILL_FIRST_DEPOSIT_AT):
                continue
            _bills_ref.document(sid).update({
                BILL_FIRST_DEPOSIT_AT: now_iso,
                "updated_at":          now_iso,
            })
            bill_events.record(
                sid, BillEventType.DEPOSIT_LINKED,
                payload={"deposit_id": deposit_id},
            )
        except Exception as e:
            logger.warning(f"first_deposit_at stamp failed for stay={sid}: {e}")

    # Cash on hand just changed — drop the cache so the next read
    # recomputes. Without this, the COH banner could stay stale for up
    # to 30 seconds after a confirm.
    invalidate_cash_on_hand_cache(dep.get("property_id", ""))

    write_log(
        "banking.deposit.confirm",
        target_collection=COL_CASH_DEPOSITS,
        target_id=deposit_id,
        metadata={"net_paise": dep.get("net_paise", 0)},
    )
    return True


# ───────────────────────── Reconcile ────────────────────────────────

def reconcile(deposit_id: str, *, bank_statement_ref: str = "") -> bool:
    """
    Mark a confirmed deposit as reconciled with the bank statement.
    Idempotent. Refuses to reconcile a non-confirmed deposit.
    """
    if _deposits_ref is None or not deposit_id:
        return False
    try:
        snap = _deposits_ref.document(deposit_id).get()
        if not snap.exists:
            return False
        d = snap.to_dict() or {}
    except Exception:
        return False
    if d.get("status") not in (DepositStatus.CONFIRMED,
                               DepositStatus.RECONCILED):
        logger.error(
            f"reconcile: status={d.get('status')!r}, expected confirmed"
        )
        return False
    try:
        _deposits_ref.document(deposit_id).update({
            "status":              DepositStatus.RECONCILED,
            "reconciled_at":       _ist_now_iso(),
            "bank_statement_ref":  bank_statement_ref,
            **attribution_update(),
        })
    except Exception as e:
        logger.error(f"reconcile: write failed: {e}")
        return False
    write_log(
        "banking.deposit.reconcile",
        target_collection=COL_CASH_DEPOSITS,
        target_id=deposit_id,
        metadata={"bank_statement_ref": bank_statement_ref},
    )
    return True


# ───────────────────────── Reverse ──────────────────────────────────

def reverse(deposit_id: str, *, reason: str) -> bool:
    """
    Admin-only. Unlinks every payment / expense / adjustment from this
    deposit and flips it to `reversed`. Cash payments return to
    `eligible`. Does NOT clear `first_deposit_at` on the bill — that's
    a one-way lock by design (the cash was deposited at some point;
    reversing the deposit doesn't change that historical fact).

    Use this when a bank rejects a deposit slip or a slip was mis-entered.
    For a "wrong rows" scenario, reverse + create a fresh draft.
    """
    if _deposits_ref is None or not deposit_id:
        return False
    try:
        snap = _deposits_ref.document(deposit_id).get()
        if not snap.exists:
            return False
        d = snap.to_dict() or {}
    except Exception:
        return False
    if d.get("status") in (DepositStatus.REVERSED, DepositStatus.DRAFT):
        logger.error(
            f"reverse: deposit {deposit_id} status={d.get('status')!r}; "
            f"only confirmed/reconciled can be reversed"
        )
        return False

    now_iso = _ist_now_iso()
    try:
        batch = _db.batch()
        for pid in d.get("payment_ids", []):
            batch.update(_payments_ref.document(pid), {
                PAY_CASH_DEPOSIT_ID:     None,
                PAY_DEPOSIT_ELIGIBILITY: DepositEligibility.ELIGIBLE,
            })
        for eid in d.get("expense_ids", []):
            batch.update(_expenses_ref.document(eid), {
                EXP_CASH_DEPOSIT_ID: None,
            })
        for aid in d.get("adjustment_ids", []):
            batch.update(_adjustments_ref.document(aid), {
                "cash_deposit_id": None,
            })
        # Refunds: unlink them so they re-appear in the next eligible-
        # rows query. Eligibility was already "excluded" and stays so —
        # refunds are never depositable, only "accounted for" by a
        # specific deposit doc.
        for rfid in d.get("refund_ids", []):
            batch.update(_payments_ref.document(rfid), {
                PAY_CASH_DEPOSIT_ID: None,
            })
        batch.update(_deposits_ref.document(deposit_id), {
            "status":          DepositStatus.REVERSED,
            "reversed_at":     now_iso,
            "reversal_reason": (reason or "")[:500],
            **attribution_update(),
        })
        batch.commit()
    except Exception as e:
        logger.error(f"reverse: batch failed: {e}", exc_info=True)
        return False

    # Cash on hand just changed (rows returned to eligible) — drop the cache.
    invalidate_cash_on_hand_cache(d.get("property_id", ""))

    write_log(
        "banking.deposit.reverse",
        target_collection=COL_CASH_DEPOSITS,
        target_id=deposit_id,
        metadata={"reason": reason, "net_paise": d.get("net_paise", 0)},
    )
    return True


# ───────────────────────── Reads ────────────────────────────────────

def get(deposit_id: str) -> Optional[dict]:
    if _deposits_ref is None or not deposit_id:
        return None
    try:
        snap = _deposits_ref.document(deposit_id).get()
        if not snap.exists:
            return None
        d = snap.to_dict() or {}
        d["id"] = snap.id
        return d
    except Exception as e:
        logger.warning(f"cash_deposits.get failed: {e}")
        return None


def list_history(*, limit: int = 100,
                 status: Optional[str] = None,
                 period_start: Optional[date] = None,
                 period_end: Optional[date] = None) -> list[dict]:
    """Recent deposits, newest first. Optional date-range filter on
    `deposit_date` (inclusive at both ends, ISO `YYYY-MM-DD` strings)."""
    if _deposits_ref is None:
        return []
    try:
        q = _deposits_ref
        if status:
            q = q.where(filter=fa_firestore.FieldFilter(
                "status", "==", status))
        if period_start:
            q = q.where(filter=fa_firestore.FieldFilter(
                "deposit_date", ">=", period_start.isoformat()))
        if period_end:
            q = q.where(filter=fa_firestore.FieldFilter(
                "deposit_date", "<=", period_end.isoformat()))
        q = q.order_by("deposit_date",
                       direction=fa_firestore.Query.DESCENDING).limit(limit)
        out = []
        for snap in q.stream():
            d = snap.to_dict() or {}
            d["id"] = snap.id
            out.append(d)
        return out
    except Exception as e:
        logger.warning(f"list_history failed: {e}")
        return []
