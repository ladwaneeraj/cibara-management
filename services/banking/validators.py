"""
Financial integrity checks for the Banking module.

These are the invariants the rest of the codebase relies on. Any
violation = a real bug somewhere upstream. The validators here are
designed to be cheap enough to run on every confirm() AND to be run
as a nightly batch job for the entire collection.

Invariants enforced
-------------------

1. **Deposit total = constituent sum.**

       deposit.net_paise
          ==  Σ payments.amount_paise    where cash_deposit_id = D and voided_at is null
            − Σ expenses.amount_paise    where cash_deposit_id = D and voided_at is null
            + Σ adjustments.amount_paise where cash_deposit_id = D

   Checked by `verify_deposit_totals` (drift check) and
   `run_integrity_check` (full collection scan).

2. **No cash payment has cash_deposit_id without status=confirmed/reconciled.**

   I.e. no row points at a draft or reversed deposit. Checked by
   `find_orphaned_links`.

3. **No payment has deposit_eligibility=deposited but cash_deposit_id=null.**

   The eligibility state and the FK must be consistent. Checked by
   `find_eligibility_mismatches`.

4. **Every confirmed deposit's payment_ids all share a single bank_account_id**
   (trivially true since the deposit owns the account).

5. **An invoiceable bill cannot have a pending or excluded payment.** Any
   payment on an invoiceable stay must be eligible or deposited.
"""

from __future__ import annotations

import logging
from typing import Optional, Tuple

from firebase_admin import firestore as fa_firestore

from .money import coerce_to_paise, sum_paise
from .schema import (
    COL_PAYMENTS, COL_EXPENSES, COL_CASH_DEPOSITS, COL_CASH_ADJUSTMENTS,
    COL_BILLS,
    PaymentMethod, DepositEligibility, DepositStatus,
    PAY_METHOD, PAY_AMOUNT_PAISE, PAY_CASH_DEPOSIT_ID,
    PAY_DEPOSIT_ELIGIBILITY, PAY_VOIDED_AT,
    EXP_CASH_DEPOSIT_ID, EXP_AMOUNT_PAISE, EXP_VOIDED_AT,
    BILL_INVOICEABLE,
)

logger = logging.getLogger(__name__)


_db = None
_payments_ref = None
_expenses_ref = None
_deposits_ref = None
_adjustments_ref = None
_bills_ref = None


def init(db) -> None:
    global _db, _payments_ref, _expenses_ref, _deposits_ref
    global _adjustments_ref, _bills_ref
    _db = db
    _payments_ref = db.collection(COL_PAYMENTS)
    _expenses_ref = db.collection(COL_EXPENSES)
    _deposits_ref = db.collection(COL_CASH_DEPOSITS)
    _adjustments_ref = db.collection(COL_CASH_ADJUSTMENTS)
    _bills_ref = db.collection(COL_BILLS)
    logger.info("Banking.validators initialised")


# ───────────────────────── Per-deposit drift ──────────────────────────

def _live_totals_for_deposit(
    deposit_id: str, *, expected: Optional[dict] = None,
) -> Tuple[int, int, int]:
    """
    Returns (gross_paise, expenses_paise, adjustments_paise) summed from
    the LIVE constituent rows.

    Two query strategies, picked from the deposit's lifecycle stage:

      * If `expected` (the deposit doc) is provided and carries explicit
        `payment_ids` / `expense_ids` / `adjustment_ids` lists, sum each
        row by reading its document directly. This is the pre-confirm
        path: the deposit knows which rows it CLAIMS, but those rows
        don't yet carry `cash_deposit_id`. Each row is also screened —
        voided rows are excluded, AND any row that has been linked to a
        DIFFERENT deposit is excluded so a stale draft doesn't double-
        count rows that got assigned elsewhere.

      * Otherwise (post-confirm or a routine integrity sweep), query by
        the FK. This is the cheaper path for confirmed deposits.

    The function never trusts the deposit doc's stored gross/net.
    """
    if _payments_ref is None:
        return (0, 0, 0)

    pay_rows: list[dict] = []
    exp_rows: list[dict] = []
    adj_total = 0

    if expected and (
        expected.get("payment_ids")
        or expected.get("expense_ids")
        or expected.get("adjustment_ids")
    ):
        # Pre-confirm path: read all the claimed rows IN PARALLEL across
        # three collections. Each .get() used to be a serial round-trip;
        # at 4 cash + 1 expense that was 5 × Firestore latency. Now the
        # three lists are fanned out across a thread pool — wall-clock
        # is ~1 round-trip regardless of row count (up to the pool size).
        from concurrent.futures import ThreadPoolExecutor
        pay_ids = list(expected.get("payment_ids") or [])
        exp_ids = list(expected.get("expense_ids") or [])
        adj_ids = list(expected.get("adjustment_ids") or [])

        def _fetch(ref, doc_id):
            try:
                snap = ref.document(doc_id).get()
                return doc_id, (snap.to_dict() if snap.exists else None)
            except Exception:
                return doc_id, None

        total_ids = len(pay_ids) + len(exp_ids) + len(adj_ids)
        if total_ids:
            with ThreadPoolExecutor(
                max_workers=min(10, total_ids)
            ) as ex:
                futures = []
                for pid in pay_ids:
                    futures.append(ex.submit(_fetch, _payments_ref, pid))
                for eid in exp_ids:
                    futures.append(ex.submit(_fetch, _expenses_ref, eid))
                for aid in adj_ids:
                    futures.append(ex.submit(_fetch, _adjustments_ref, aid))
                results = {f.result()[0]: f.result()[1] for f in futures}
        else:
            results = {}

        # Apply the in-memory filters now that all docs are loaded.
        for pid in pay_ids:
            d = results.get(pid)
            if not d:
                continue
            if d.get(PAY_VOIDED_AT):
                continue
            if d.get(PAY_METHOD) != PaymentMethod.CASH:
                continue
            link = d.get(PAY_CASH_DEPOSIT_ID)
            if link and link != deposit_id:
                continue
            pay_rows.append(d)
        for eid in exp_ids:
            d = results.get(eid)
            if not d:
                continue
            if d.get(EXP_VOIDED_AT):
                continue
            link = d.get(EXP_CASH_DEPOSIT_ID)
            if link and link != deposit_id:
                continue
            exp_rows.append(d)
        for aid in adj_ids:
            d = results.get(aid)
            if not d:
                continue
            if d.get("voided_at"):
                continue
            link = d.get("cash_deposit_id")
            if link and link != deposit_id:
                continue
            try:
                adj_total += int(d.get("amount_paise") or 0)
            except (TypeError, ValueError):
                pass
    else:
        # Post-confirm path: query by the FK.
        for snap in _payments_ref.where(filter=fa_firestore.FieldFilter(
                PAY_CASH_DEPOSIT_ID, "==", deposit_id)).stream():
            d = snap.to_dict() or {}
            if d.get(PAY_VOIDED_AT):
                continue
            if d.get(PAY_METHOD) != PaymentMethod.CASH:
                continue
            pay_rows.append(d)
        for snap in _expenses_ref.where(filter=fa_firestore.FieldFilter(
                EXP_CASH_DEPOSIT_ID, "==", deposit_id)).stream():
            d = snap.to_dict() or {}
            if d.get(EXP_VOIDED_AT):
                continue
            exp_rows.append(d)
        for snap in _adjustments_ref.where(filter=fa_firestore.FieldFilter(
                "cash_deposit_id", "==", deposit_id)).stream():
            d = snap.to_dict() or {}
            if d.get("voided_at"):
                continue
            try:
                adj_total += int(d.get("amount_paise") or 0)
            except (TypeError, ValueError):
                pass

    gross = sum_paise(pay_rows, key=PAY_AMOUNT_PAISE)
    expenses = sum_paise(exp_rows, key=EXP_AMOUNT_PAISE)
    return (gross, expenses, adj_total)


def verify_deposit_totals(deposit_id: str,
                          *, expected: Optional[dict] = None
                          ) -> Tuple[bool, str]:
    """
    Returns (ok, message). If `expected` is provided, compares the
    live totals against the dict's stored gross / expenses / net /
    adjustments. Otherwise loads the deposit doc and compares.

    Used by:
      * cash_deposits.confirm() before flipping draft → confirmed
      * the nightly job
    """
    if _deposits_ref is None:
        return (False, "validators not initialised")
    if expected is None:
        try:
            snap = _deposits_ref.document(deposit_id).get()
            if not snap.exists:
                return (False, "deposit not found")
            expected = snap.to_dict() or {}
        except Exception as e:
            return (False, f"deposit read failed: {e}")

    try:
        gross, expenses, adj = _live_totals_for_deposit(
            deposit_id, expected=expected,
        )
    except Exception as e:
        return (False, f"live totals query failed: {e}")

    # Refund total — read separately so we keep _live_totals_for_deposit's
    # existing 3-value signature stable. Refunds were a later addition;
    # any pre-existing deposit doc without refund_ids treats this as 0.
    refunds_live = 0
    try:
        for rfid in (expected.get("refund_ids") or []):
            snap = _payments_ref.document(rfid).get()
            if not snap.exists:
                continue
            d = snap.to_dict() or {}
            if d.get(PAY_VOIDED_AT):
                continue
            link = d.get(PAY_CASH_DEPOSIT_ID)
            if link and link != deposit_id:
                continue
            from .money import coerce_to_paise
            refunds_live += coerce_to_paise(d)
    except Exception as e:
        logger.warning(f"verify_deposit_totals: refund sum failed: {e}")

    exp_gross = int(expected.get("gross_paise") or 0)
    exp_expenses = int(expected.get("expenses_paise") or 0)
    exp_refunds = int(expected.get("refunds_paise") or 0)
    exp_adj = int(expected.get("adjustments_paise") or 0)
    exp_net = int(expected.get("net_paise") or 0)

    live_net = gross - expenses - refunds_live + adj

    drift = []
    if gross != exp_gross:
        drift.append(f"gross live={gross} stored={exp_gross}")
    if expenses != exp_expenses:
        drift.append(f"expenses live={expenses} stored={exp_expenses}")
    if refunds_live != exp_refunds:
        drift.append(f"refunds live={refunds_live} stored={exp_refunds}")
    if adj != exp_adj:
        drift.append(f"adjustments live={adj} stored={exp_adj}")
    if live_net != exp_net:
        drift.append(f"net live={live_net} stored={exp_net}")

    if drift:
        return (False, "; ".join(drift))
    return (True, "ok")


# ───────────────────────── Collection-wide scans ─────────────────────

def find_orphaned_links(*, sample_limit: int = 50) -> list[dict]:
    """
    Find rows that point at a deposit which is in DRAFT or REVERSED
    state. Indicates an aborted confirm/reverse left dangling FKs.

    Returns a list of {table, id, deposit_id, deposit_status}.
    Empty list = clean.
    """
    if _deposits_ref is None:
        return []
    bad_statuses = {DepositStatus.DRAFT, DepositStatus.REVERSED}
    # Find deposits in bad states first
    bad_deposit_ids = set()
    try:
        for snap in _deposits_ref.stream():
            d = snap.to_dict() or {}
            if d.get("status") in bad_statuses:
                bad_deposit_ids.add(snap.id)
    except Exception as e:
        logger.warning(f"find_orphaned_links: deposit scan failed: {e}")
        return []
    if not bad_deposit_ids:
        return []

    issues = []
    try:
        # Payments
        for snap in _payments_ref.stream():
            d = snap.to_dict() or {}
            link = d.get(PAY_CASH_DEPOSIT_ID)
            if link and link in bad_deposit_ids:
                issues.append({
                    "table":          COL_PAYMENTS,
                    "id":             snap.id,
                    "deposit_id":     link,
                    "deposit_status": "draft_or_reversed",
                })
                if len(issues) >= sample_limit:
                    return issues
        for snap in _expenses_ref.stream():
            d = snap.to_dict() or {}
            link = d.get(EXP_CASH_DEPOSIT_ID)
            if link and link in bad_deposit_ids:
                issues.append({
                    "table":          COL_EXPENSES,
                    "id":             snap.id,
                    "deposit_id":     link,
                    "deposit_status": "draft_or_reversed",
                })
                if len(issues) >= sample_limit:
                    return issues
    except Exception as e:
        logger.warning(f"find_orphaned_links: link scan failed: {e}")
    return issues


def find_eligibility_mismatches(*, sample_limit: int = 50) -> list[dict]:
    """
    Detect rows where:
      * eligibility = 'deposited' but cash_deposit_id is null, OR
      * eligibility = 'eligible' but cash_deposit_id is set, OR
      * eligibility = 'pending' but receipt_no is set.
    """
    if _payments_ref is None:
        return []
    issues = []
    try:
        for snap in _payments_ref.stream():
            d = snap.to_dict() or {}
            if d.get(PAY_METHOD) != PaymentMethod.CASH:
                continue
            elig = d.get(PAY_DEPOSIT_ELIGIBILITY)
            link = d.get(PAY_CASH_DEPOSIT_ID)
            rno = d.get("receipt_no")
            problem = None
            if elig == DepositEligibility.DEPOSITED and not link:
                problem = "deposited_without_link"
            elif elig == DepositEligibility.ELIGIBLE and link:
                problem = "eligible_but_linked"
            elif elig == DepositEligibility.PENDING and rno:
                problem = "pending_but_receipted"
            if problem:
                issues.append({
                    "id":             snap.id,
                    "problem":        problem,
                    "elig":           elig,
                    "cash_deposit_id": link,
                    "receipt_no":     rno,
                })
                if len(issues) >= sample_limit:
                    return issues
    except Exception as e:
        logger.warning(f"find_eligibility_mismatches failed: {e}")
    return issues


def find_invoiceable_bills_with_non_official_payments(
    *, sample_limit: int = 50
) -> list[dict]:
    """
    Surface bills marked invoiceable=true that still have a payment in
    PENDING / EXCLUDED state. Shouldn't exist after the trigger fires.
    """
    if _bills_ref is None:
        return []
    issues = []
    try:
        bills_q = _bills_ref.where(
            filter=fa_firestore.FieldFilter(BILL_INVOICEABLE, "==", True)
        )
        for bsnap in bills_q.stream():
            sid = bsnap.id
            pays = _payments_ref.where(
                filter=fa_firestore.FieldFilter("stay_id", "==", sid)
            )
            for psnap in pays.stream():
                pd = psnap.to_dict() or {}
                if pd.get(PAY_VOIDED_AT):
                    continue
                if pd.get(PAY_METHOD) != PaymentMethod.CASH:
                    continue
                elig = pd.get(PAY_DEPOSIT_ELIGIBILITY)
                if elig in (DepositEligibility.PENDING,
                            DepositEligibility.EXCLUDED):
                    issues.append({
                        "stay_id":    sid,
                        "payment_id": psnap.id,
                        "elig":       elig,
                    })
                    if len(issues) >= sample_limit:
                        return issues
    except Exception as e:
        logger.warning(
            "find_invoiceable_bills_with_non_official_payments failed: " + str(e)
        )
    return issues


# --- Full sweep ----------------------------------------------------------

def run_integrity_check(*, sample_limit: int = 50) -> dict:
    """
    One call that runs every check. Suitable for a nightly cron.

    Returns a dict:
        {
          "orphaned_links":          [...],
          "eligibility_mismatches":  [...],
          "stuck_pending_on_invoiceable": [...],
          "drifting_deposits":       [{deposit_id, message}, ...],
          "checked_at":              "<IST iso>",
        }
    """
    from datetime import datetime
    from config import IST

    out = {
        "checked_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
        "orphaned_links":         find_orphaned_links(
            sample_limit=sample_limit),
        "eligibility_mismatches": find_eligibility_mismatches(
            sample_limit=sample_limit),
        "stuck_pending_on_invoiceable":
            find_invoiceable_bills_with_non_official_payments(
                sample_limit=sample_limit),
        "drifting_deposits":      [],
    }

    if _deposits_ref is None:
        return out
    try:
        for snap in _deposits_ref.stream():
            d = snap.to_dict() or {}
            if d.get("status") not in (DepositStatus.CONFIRMED,
                                       DepositStatus.RECONCILED):
                continue
            ok, msg = verify_deposit_totals(snap.id, expected=d)
            if not ok:
                out["drifting_deposits"].append({
                    "deposit_id": snap.id,
                    "message":    msg,
                })
                if len(out["drifting_deposits"]) >= sample_limit:
                    break
    except Exception as e:
        logger.warning("run_integrity_check: deposit sweep failed: " + str(e))
    return out
