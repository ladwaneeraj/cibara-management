"""
Banking routes — cash receipts, deposits, adjustments, bank accounts.

This blueprint sits alongside the existing /settlements blueprint. The
two are intentionally separate: /settlements handles checkout-time
payment recording (cash vs online split, GST allocation); /banking
handles what happens to the cash AFTER checkout (deposit to bank,
EOD reconciliation, off-deposit unofficial cash).

Auth: every route is gated by an RBAC permission (see schema.py for
the key list). The /banking.view permission is granted to manager and
admin; deposit confirmation and reversal are admin-only.

Date / amount conventions on the wire
-------------------------------------
Inputs:
  * dates as "YYYY-MM-DD" strings
  * amounts as INT rupees in the body (frontend convenience). The
    server converts to paise via money.rupees_to_paise.

Outputs:
  * paise as `amount_paise` (int) AND `amount` (int rupees, truncated)
    so older frontend code keeps working during transition.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from flask import Blueprint, jsonify, request, g

from config import IST, logger

from services.auth_service import requires_permission
from services.banking import (
    bank_accounts, cash_receipts, cash_deposits,
    cash_adjustments, validators, bill_events,
)
from services.banking.money import rupees_to_paise, paise_to_rupees_int
from services.banking.schema import (
    PERM_BANKING_VIEW, PERM_BANKING_DEPOSIT_CREATE,
    PERM_BANKING_DEPOSIT_CONFIRM, PERM_BANKING_DEPOSIT_RECONCILE,
    PERM_BANKING_DEPOSIT_REVERSE, PERM_BANKING_ADJUSTMENT_CREATE,
    PERM_BANKING_ACCOUNT_MANAGE,
    DEFAULT_UNDEPOSITED_THRESHOLD_PAISE,
    AdjustmentReason,
)
from services.banking.cash_receipts import UnTriggerBlocked


banking_bp = Blueprint("banking", __name__, url_prefix="/banking")


# ───────────────────────── Helpers ────────────────────────────────────

def _parse_iso_date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return datetime.strptime(s.strip()[:10], "%Y-%m-%d").date()
    except (ValueError, TypeError):
        return None


def _today_ist() -> date:
    return datetime.now(IST).date()


def _ok(**payload):
    return jsonify(success=True, **payload)


def _err(msg, code=400):
    return jsonify(success=False, message=msg), code


# ───────────────────────── Cash on hand ───────────────────────────────

@banking_bp.route("/cash_on_hand", methods=["GET"])
@requires_permission(PERM_BANKING_VIEW)
def cash_on_hand_route():
    """
    Live "money in the drawer" plus the threshold-alert flag.
    """
    try:
        property_id = request.args.get("property_id", "") or ""
        amt = cash_deposits.cash_on_hand_paise(property_id=property_id)
        return _ok(
            amount_paise=amt,
            amount=paise_to_rupees_int(amt),
            threshold_paise=DEFAULT_UNDEPOSITED_THRESHOLD_PAISE,
            threshold_breached=amt >= DEFAULT_UNDEPOSITED_THRESHOLD_PAISE,
        )
    except Exception as e:
        logger.error(f"/banking/cash_on_hand failed: {e}")
        return _err(f"failed: {e}", 500)


# ───────────────────────── Deposit assembly ──────────────────────────

@banking_bp.route("/eligible_rows", methods=["GET"])
@requires_permission(PERM_BANKING_VIEW)
def eligible_rows():
    """
    Returns the cash payments and expenses that COULD go into a fresh
    deposit, filtered by an optional [period_start, period_end] range.
    Used by the "New Deposit" screen to populate the picker.
    """
    try:
        period_start = _parse_iso_date(request.args.get("period_start"))
        period_end   = _parse_iso_date(request.args.get("period_end"))
        property_id  = request.args.get("property_id", "") or ""

        # The four reads below are independent Firestore queries; run
        # them concurrently so wall time is the slowest single query
        # rather than their sum. The Firestore admin SDK is thread-
        # safe and each helper only reads, so there is no shared-state
        # hazard. Refunds are informational (not selectable, already
        # subtracted from cash-on-hand); we surface the list so the
        # operator can SEE what cash left the drawer before the bank run.
        with ThreadPoolExecutor(max_workers=4) as _ex:
            _f_pays = _ex.submit(
                cash_deposits.list_eligible_payments,
                period_start=period_start, period_end=period_end,
                property_id=property_id,
            )
            _f_exps = _ex.submit(
                cash_deposits.list_eligible_expenses,
                period_start=period_start, period_end=period_end,
                property_id=property_id,
            )
            _f_adjs = _ex.submit(
                cash_adjustments.list_undeposited,
                property_id=property_id,
            )
            _f_refs = _ex.submit(
                cash_deposits.list_undeposited_cash_refunds,
                period_start=period_start, period_end=period_end,
                property_id=property_id,
            )
        pays = _f_pays.result()
        exps = _f_exps.result()
        adjs = _f_adjs.result()
        refs = _f_refs.result()
        return _ok(payments=pays, expenses=exps,
                   adjustments=adjs, refunds=refs)
    except Exception as e:
        logger.error(f"/banking/eligible_rows failed: {e}")
        return _err(f"failed: {e}", 500)


@banking_bp.route("/deposit/draft", methods=["POST"])
@requires_permission(PERM_BANKING_DEPOSIT_CREATE)
def create_draft_route():
    """
    Body:
      {
        "deposit_date": "YYYY-MM-DD",     // optional, defaults to today
        "bank_account_id": "...",         // required
        "payment_ids": [...],             // at least one of these three lists
        "expense_ids": [...],
        "adjustment_ids": [...],
        "slip_number": "....",
        "notes": "...",
        "period_start": "YYYY-MM-DD",     // optional, for display only
        "period_end":   "YYYY-MM-DD",
        "property_id":  ""
      }
    """
    try:
        data = request.get_json(force=True, silent=True) or {}
        dep = cash_deposits.create_draft(
            deposit_date=(_parse_iso_date(data.get("deposit_date"))
                          or _today_ist()),
            bank_account_id=data.get("bank_account_id", ""),
            payment_ids=data.get("payment_ids") or [],
            expense_ids=data.get("expense_ids") or [],
            adjustment_ids=data.get("adjustment_ids") or [],
            slip_number=data.get("slip_number", ""),
            notes=data.get("notes", ""),
            period_start=_parse_iso_date(data.get("period_start")),
            period_end=_parse_iso_date(data.get("period_end")),
            property_id=data.get("property_id", ""),
        )
        if not dep:
            return _err(
                "deposit draft failed — check rows are eligible and not "
                "already linked",
                400,
            )
        return _ok(deposit=dep)
    except Exception as e:
        logger.error(f"/banking/deposit/draft failed: {e}", exc_info=True)
        return _err(f"failed: {e}", 500)


@banking_bp.route("/deposit/<deposit_id>/confirm", methods=["POST"])
@requires_permission(PERM_BANKING_DEPOSIT_CONFIRM)
def confirm_route(deposit_id: str):
    """
    Body (all optional):
      {
        "slip_number":    "...",
        "slip_image_url": "https://..."
      }
    """
    try:
        data = request.get_json(force=True, silent=True) or {}
        actor = (getattr(g, "current_user", {}) or {}).get("userId")
        ok = cash_deposits.confirm(
            deposit_id,
            slip_number=data.get("slip_number"),
            slip_image_url=data.get("slip_image_url"),
            actor_user_id=actor,
        )
        if not ok:
            return _err(
                "confirm failed — see server logs (likely an integrity "
                "drift or status mismatch)",
                400,
            )
        return _ok(deposit=cash_deposits.get(deposit_id))
    except Exception as e:
        logger.error(f"/banking/deposit/confirm failed: {e}", exc_info=True)
        return _err(f"failed: {e}", 500)


@banking_bp.route("/deposit/<deposit_id>/reconcile", methods=["POST"])
@requires_permission(PERM_BANKING_DEPOSIT_RECONCILE)
def reconcile_route(deposit_id: str):
    try:
        data = request.get_json(force=True, silent=True) or {}
        ok = cash_deposits.reconcile(
            deposit_id,
            bank_statement_ref=data.get("bank_statement_ref", ""),
        )
        if not ok:
            return _err("reconcile failed", 400)
        return _ok(deposit=cash_deposits.get(deposit_id))
    except Exception as e:
        logger.error(f"/banking/deposit/reconcile failed: {e}")
        return _err(f"failed: {e}", 500)


@banking_bp.route("/deposit/<deposit_id>/reverse", methods=["POST"])
@requires_permission(PERM_BANKING_DEPOSIT_REVERSE)
def reverse_route(deposit_id: str):
    try:
        data = request.get_json(force=True, silent=True) or {}
        reason = (data.get("reason") or "").strip()
        if not reason:
            return _err("reason required", 400)
        ok = cash_deposits.reverse(deposit_id, reason=reason)
        if not ok:
            return _err("reverse failed", 400)
        return _ok(deposit=cash_deposits.get(deposit_id))
    except Exception as e:
        logger.error(f"/banking/deposit/reverse failed: {e}")
        return _err(f"failed: {e}", 500)


@banking_bp.route("/deposit/<deposit_id>", methods=["GET"])
@requires_permission(PERM_BANKING_VIEW)
def get_deposit_route(deposit_id: str):
    try:
        d = cash_deposits.get(deposit_id)
        if not d:
            return _err("not found", 404)
        return _ok(deposit=d)
    except Exception as e:
        return _err(f"failed: {e}", 500)


@banking_bp.route("/deposit/history", methods=["GET"])
@requires_permission(PERM_BANKING_VIEW)
def deposit_history_route():
    try:
        status = request.args.get("status") or None
        limit = int(request.args.get("limit", "100"))
        period_start = _parse_iso_date(request.args.get("period_start"))
        period_end   = _parse_iso_date(request.args.get("period_end"))
        rows = cash_deposits.list_history(
            status=status,
            limit=min(limit, 500),
            period_start=period_start,
            period_end=period_end,
        )
        # Aggregate totals across the filtered set. Exclude reversed
        # deposits from the sums — they represent cancelled trips
        # that didn't move money.
        gross = 0
        expenses = 0
        net = 0
        counted = 0
        for r in rows:
            if r.get("status") == "reversed":
                continue
            try:
                gross    += int(r.get("gross_paise") or 0)
                expenses += int(r.get("expenses_paise") or 0)
                net      += int(r.get("net_paise") or 0)
                counted  += 1
            except (TypeError, ValueError):
                pass
        return _ok(deposits=rows, totals={
            "count":          counted,
            "gross_paise":    gross,
            "expenses_paise": expenses,
            "net_paise":      net,
        })
    except Exception as e:
        return _err(f"failed: {e}", 500)


# ───────────────────────── Unofficial cash ────────────────────────────

@banking_bp.route("/_diag/expenses", methods=["GET"])
@requires_permission(PERM_BANKING_VIEW)
def diag_expenses_route():
    """
    Diagnostic: shows what list_eligible_expenses sees and why each
    row was kept or rejected. Use during setup / debugging only.
    """
    try:
        from firebase_admin import firestore as fa_firestore  # noqa
        from services.banking.schema import (
            COL_EXPENSES, EXP_VOIDED_AT, EXP_CASH_DEPOSIT_ID,
            PAY_METHOD, PaymentMethod,
        )
        period_start = _parse_iso_date(request.args.get("period_start"))
        period_end = _parse_iso_date(request.args.get("period_end"))
        property_id = request.args.get("property_id", "") or ""

        from config import db as _db
        ref = _db.collection(COL_EXPENSES)
        rows = []
        kept = 0
        for snap in ref.stream():
            d = snap.to_dict() or {}
            reason = "kept"
            if d.get(EXP_VOIDED_AT):
                reason = "voided"
            elif d.get(EXP_CASH_DEPOSIT_ID):
                reason = "already_linked"
            else:
                pm = (d.get("payment_method") or d.get(PAY_METHOD)
                      or "cash").lower()
                if pm != PaymentMethod.CASH:
                    reason = f"non-cash:method={pm!r}"
                else:
                    dt = (d.get("expense_date") or d.get("date") or "")[:10]
                    if period_start and dt and dt < period_start.isoformat():
                        reason = (
                            f"before_period:date={dt!r} "
                            f"start={period_start.isoformat()!r}"
                        )
                    elif period_end and dt and dt > period_end.isoformat():
                        reason = (
                            f"after_period:date={dt!r} "
                            f"end={period_end.isoformat()!r}"
                        )
                    elif (property_id
                          and d.get("property_id", "") != property_id):
                        reason = (
                            f"property_id mismatch: have="
                            f"{d.get('property_id','')!r} "
                            f"want={property_id!r}"
                        )
                    else:
                        kept += 1
            rows.append({
                "id":              snap.id,
                "date":            d.get("date") or d.get("expense_date"),
                "amount":          d.get("amount"),
                "amount_paise":    d.get("amount_paise"),
                "payment_method":  d.get("payment_method") or d.get(PAY_METHOD),
                "category":        d.get("category"),
                "voided_at":       d.get(EXP_VOIDED_AT),
                "cash_deposit_id": d.get(EXP_CASH_DEPOSIT_ID),
                "property_id":     d.get("property_id", ""),
                "verdict":         reason,
            })
        return _ok(total_seen=len(rows), kept=kept, rows=rows)
    except Exception as e:
        logger.error(f"/banking/_diag/expenses failed: {e}", exc_info=True)
        return _err(f"failed: {e}", 500)


# ───────────────────────── Unofficial cash ────────────────────────────

@banking_bp.route("/unofficial", methods=["GET"])
@requires_permission(PERM_BANKING_VIEW)
def unofficial_route():
    """
    Cash payments classified as excluded (parent stay closed with no
    bill_number). These are not deposit-eligible; this list is for audit
    and visibility only.
    """
    try:
        limit = int(request.args.get("limit", "200"))
        property_id = request.args.get("property_id", "") or ""
        period_start = _parse_iso_date(request.args.get("period_start"))
        period_end   = _parse_iso_date(request.args.get("period_end"))
        # Two independent Firestore reads — run them concurrently so
        # wall time is the slower of the two, not their sum. Report-
        # type cash expenses are the same logical pool as the
        # unofficial payments: paid out of off-deposit cash.
        with ThreadPoolExecutor(max_workers=2) as _ex:
            _f_rows = _ex.submit(
                cash_deposits.list_unofficial_payments,
                limit=min(limit, 1000), property_id=property_id,
                period_start=period_start, period_end=period_end,
            )
            _f_exps = _ex.submit(
                cash_deposits.list_unofficial_cash_expenses,
                limit=min(limit, 1000), property_id=property_id,
                period_start=period_start, period_end=period_end,
            )
        rows = _f_rows.result()
        exps = _f_exps.result()
        # Aggregate for the header summary. Payments are inflows;
        # expenses are outflows. Net unofficial cash held = inflows − outflows.
        total_in = 0
        for r in rows:
            try:
                total_in += int(r.get("amount_paise") or
                                (r.get("amount") or 0) * 100)
            except (TypeError, ValueError):
                pass
        total_out = 0
        for e in exps:
            try:
                total_out += int(e.get("amount_paise") or
                                 (e.get("amount") or 0) * 100)
            except (TypeError, ValueError):
                pass
        return _ok(
            payments=rows,
            expenses=exps,
            total_paise=total_in - total_out,
            inflows_paise=total_in,
            outflows_paise=total_out,
        )
    except Exception as e:
        return _err(f"failed: {e}", 500)


# ───────────────────────── Adjustments ───────────────────────────────

@banking_bp.route("/adjustment", methods=["POST"])
@requires_permission(PERM_BANKING_ADJUSTMENT_CREATE)
def create_adjustment_route():
    """
    Body:
      {
        "adjustment_date": "YYYY-MM-DD",
        "amount":          <signed int/float rupees>,
        "reason":          one of AdjustmentReason.ALL,
        "notes":           "...",
        "property_id":     ""
      }
    """
    try:
        data = request.get_json(force=True, silent=True) or {}
        amt = data.get("amount")
        if amt is None:
            return _err("amount required", 400)
        reason = (data.get("reason") or "").strip()
        if reason not in AdjustmentReason.ALL:
            return _err(f"reason must be one of {sorted(AdjustmentReason.ALL)}",
                       400)

        adj_id = cash_adjustments.create_from_rupees(
            adjustment_date=(_parse_iso_date(data.get("adjustment_date"))
                             or _today_ist()),
            amount_rupees=amt,
            reason=reason,
            notes=data.get("notes", ""),
            property_id=data.get("property_id", ""),
        )
        if not adj_id:
            return _err("create failed", 400)
        return _ok(adjustment_id=adj_id)
    except Exception as e:
        logger.error(f"/banking/adjustment failed: {e}")
        return _err(f"failed: {e}", 500)


@banking_bp.route("/adjustment/<adj_id>/void", methods=["POST"])
@requires_permission(PERM_BANKING_ADJUSTMENT_CREATE)
def void_adjustment_route(adj_id: str):
    try:
        data = request.get_json(force=True, silent=True) or {}
        reason = (data.get("reason") or "").strip()
        if not reason:
            return _err("reason required", 400)
        ok = cash_adjustments.void(adj_id, reason=reason)
        if not ok:
            return _err("void failed (linked to confirmed deposit?)", 400)
        return _ok()
    except Exception as e:
        return _err(f"failed: {e}", 500)


@banking_bp.route("/adjustment/list", methods=["GET"])
@requires_permission(PERM_BANKING_VIEW)
def list_adjustments_route():
    try:
        limit = int(request.args.get("limit", "100"))
        property_id = request.args.get("property_id", "") or ""
        rows = cash_adjustments.list_recent(
            limit=min(limit, 500), property_id=property_id,
        )
        return _ok(adjustments=rows)
    except Exception as e:
        return _err(f"failed: {e}", 500)


# ───────────────────────── Bank accounts ─────────────────────────────

@banking_bp.route("/bank_accounts", methods=["GET"])
@requires_permission(PERM_BANKING_VIEW)
def list_accounts_route():
    try:
        property_id = request.args.get("property_id", "") or ""
        return _ok(accounts=bank_accounts.list_active(property_id=property_id))
    except Exception as e:
        return _err(f"failed: {e}", 500)


@banking_bp.route("/bank_accounts", methods=["POST"])
@requires_permission(PERM_BANKING_ACCOUNT_MANAGE)
def create_account_route():
    try:
        data = request.get_json(force=True, silent=True) or {}
        new_id = bank_accounts.create(
            name=data.get("name", "").strip(),
            bank=data.get("bank", "").strip(),
            account_number=data.get("account_number", "").strip(),
            ifsc=data.get("ifsc", ""),
            branch=data.get("branch", ""),
            property_id=data.get("property_id", ""),
            is_default=bool(data.get("is_default", False)),
        )
        if not new_id:
            return _err("create failed (missing fields?)", 400)
        return _ok(id=new_id, account=bank_accounts.get(new_id))
    except Exception as e:
        return _err(f"failed: {e}", 500)


@banking_bp.route("/bank_accounts/<account_id>", methods=["PATCH"])
@requires_permission(PERM_BANKING_ACCOUNT_MANAGE)
def update_account_route(account_id: str):
    try:
        data = request.get_json(force=True, silent=True) or {}
        ok = bank_accounts.update(account_id, data)
        if not ok:
            return _err("update failed", 400)
        return _ok(account=bank_accounts.get(account_id))
    except Exception as e:
        return _err(f"failed: {e}", 500)


@banking_bp.route("/bank_accounts/<account_id>/archive", methods=["POST"])
@requires_permission(PERM_BANKING_ACCOUNT_MANAGE)
def archive_account_route(account_id: str):
    try:
        ok = bank_accounts.archive(account_id)
        if not ok:
            return _err("archive failed", 400)
        return _ok()
    except Exception as e:
        return _err(f"failed: {e}", 500)


# ───────────────────────── Trigger / receipts ────────────────────────

@banking_bp.route("/trigger/<stay_id>/revert", methods=["POST"])
@requires_permission(PERM_BANKING_DEPOSIT_REVERSE)
def revert_trigger_route(stay_id: str):
    """
    Admin-only un-trigger. Refused if any cash from the stay has been
    deposited (server returns 409 in that case).
    """
    try:
        data = request.get_json(force=True, silent=True) or {}
        reason = (data.get("reason") or "").strip()
        try:
            ok = cash_receipts.revert_trigger_if_safe(stay_id, reason=reason)
        except UnTriggerBlocked as e:
            return jsonify(
                success=False,
                code="DEPOSIT_PRESENT",
                message=str(e),
                first_deposit_at=e.first_deposit_at,
            ), 409
        if not ok:
            return _err("revert failed", 400)
        return _ok()
    except Exception as e:
        logger.error(f"/banking/trigger/revert failed: {e}", exc_info=True)
        return _err(f"failed: {e}", 500)


@banking_bp.route("/receipts/stay/<stay_id>", methods=["GET"])
@requires_permission(PERM_BANKING_VIEW)
def receipts_for_stay_route(stay_id: str):
    try:
        return _ok(receipts=cash_receipts.list_receipts_for_stay(stay_id))
    except Exception as e:
        return _err(f"failed: {e}", 500)


# ───────────────────────── Bill events ───────────────────────────────

@banking_bp.route("/events/stay/<stay_id>", methods=["GET"])
@requires_permission(PERM_BANKING_VIEW)
def events_for_stay_route(stay_id: str):
    try:
        return _ok(events=bill_events.list_for_stay(stay_id, limit=200))
    except Exception as e:
        return _err(f"failed: {e}", 500)


# ───────────────────────── Integrity ─────────────────────────────────

@banking_bp.route("/backfill", methods=["POST"])
@requires_permission(PERM_BANKING_DEPOSIT_CONFIRM)
def backfill_route():
    """
    Classify legacy data so cash-on-hand and the deposit screen have
    something to show without requiring an out-of-band migration run.

    For every existing bill / payment / expense:
      * sets invoiceable=true on bills that already have a real bill_number
      * sets deposit_eligibility on cash payments based on the parent
        bill's invoiceable state (eligible / excluded / pending)
      * stamps amount_paise from legacy rupee `amount`

    Idempotent — re-running is a no-op for rows already marked
    `_banking_migrated_at`. Returns counts.

    This is the same logic as migrations/banking_schema_v1.py, exposed
    as an HTTP route so it can be triggered from the Banking UI without
    shell access to the server.
    """
    try:
        # Local import to avoid heavyweight migration code load at module init.
        from migrations.banking_schema_v1 import (
            _bootstrap, _migrate_bills, _migrate_payments, _migrate_expenses,
        )
        from datetime import datetime as _dt
        ctx = _bootstrap()
        ctx["now_iso"] = _dt.now(ctx["IST"]).strftime("%Y-%m-%d %H:%M:%S")
        bills_result = _migrate_bills(False, ctx)
        index = bills_result.pop("index", {})
        pay_result = _migrate_payments(False, ctx, index)
        exp_result = _migrate_expenses(False, ctx)
        return _ok(
            bills=bills_result,
            payments=pay_result,
            expenses=exp_result,
        )
    except Exception as e:
        logger.error(f"/banking/backfill failed: {e}", exc_info=True)
        return _err(f"backfill failed: {e}", 500)


@banking_bp.route("/integrity_check", methods=["GET"])
@requires_permission(PERM_BANKING_DEPOSIT_CONFIRM)
def integrity_check_route():
    """
    Manager+ can run the integrity sweep on demand. Heavier than other
    routes — runs collection-wide scans. Suitable for an admin button
    or a daily cron job.
    """
    try:
        return _ok(report=validators.run_integrity_check(sample_limit=100))
    except Exception as e:
        logger.error(f"/banking/integrity_check failed: {e}", exc_info=True)
        return _err(f"failed: {e}", 500)
