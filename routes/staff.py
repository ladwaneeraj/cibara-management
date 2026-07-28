"""
Staff attendance & payroll routes.

Thin HTTP layer over services/staff_service.py. All authorization is
enforced here via @requires_permission; see services/permissions.py:

    staff.view             manager + admin   staff list & attendance (no ₹)
    staff.attendance.mark  manager + admin   mark full / half / absent
    staff.manage           admin             add/edit staff, wages, REVERSALS
    staff.payroll.view     manager + admin   wages, advances, salary figures
    staff.advance.give     manager + admin   record advances
    staff.salary.pay       manager + admin   pay salaries
    staff.pay.account      admin             pay from bank/UPI — managers are
                                             limited to counter cash (enforced
                                             in give_advance / pay_salary)

Every mutation writes an audit_log entry. Advances and salary payouts
write linked rows into the `expenses` collection atomically (see
services/staff_service.py) so daily cash totals stay correct.
"""

from flask import Blueprint, request, jsonify, g

from services import staff_service as svc
from services.auth_service import requires_permission
from services.audit_log import write_log
from config import logger, invalidate_rooms_and_totals

staff_bp = Blueprint("staff", __name__, url_prefix="/staff")


def _fail(message, code=400):
    return jsonify(success=False, message=str(message)), code


def _can_pay_from_account() -> bool:
    """Server-side custody gate: only roles with staff.pay.account (admin)
    may move money from the bank/UPI. Managers settle from counter cash."""
    try:
        from services.permissions import role_has_permission
        user = getattr(g, "current_user", None) or {}
        return role_has_permission(user.get("role", ""), "staff.pay.account")
    except Exception:
        return False


def _reject_account_source(data) -> bool:
    """True when this request tries to pay from the account without the
    permission — the caller returns a 403."""
    from_account = (data.get("expense_type", "transaction") != "transaction"
                    or data.get("payment_method", "cash") != "cash")
    return from_account and not _can_pay_from_account()


_ACCOUNT_403 = ("Paying from the bank account / UPI is admin-only — "
                "managers pay from the cash counter.")


def _has_payroll_view() -> bool:
    """UX-trim helper: does the current user get to see ₹ figures?"""
    try:
        from services.permissions import role_has_permission
        user = getattr(g, "current_user", None) or {}
        return role_has_permission(user.get("role", ""), "staff.payroll.view")
    except Exception:
        return False


# ─── Directory ─────────────────────────────────────────────────────────────

@staff_bp.route("/list", methods=["GET"])
@requires_permission("staff.view")
def list_staff():
    """Staff cards. Wage / advance / paid-until figures are included only
    for roles with staff.payroll.view — server-side, not just hidden."""
    try:
        include_inactive = request.args.get("all") == "1"
        rows = svc.staff_overview(
            include_inactive=include_inactive,
            include_payroll=_has_payroll_view(),
        )
        return jsonify(success=True, staff=rows,
                       payroll_visible=_has_payroll_view())
    except Exception as e:
        logger.exception("staff/list failed")
        return _fail(e, 500)


@staff_bp.route("/create", methods=["POST"])
@requires_permission("staff.manage")
def create_staff():
    try:
        s = svc.create_staff(request.json or {}, g.current_user)
        write_log("staff.create", target_collection="staff", target_id=s["id"],
                  after={"name": s["name"], "daily_wage": s["daily_wage"]})
        return jsonify(success=True, staff=s)
    except ValueError as ve:
        return _fail(ve)
    except Exception as e:
        logger.exception("staff/create failed")
        return _fail(e, 500)


@staff_bp.route("/<staff_id>", methods=["PATCH"])
@requires_permission("staff.manage")
def update_staff(staff_id):
    try:
        before = svc.get_staff(staff_id) or {}
        s = svc.update_staff(staff_id, request.json or {}, g.current_user)
        changed = {k: before.get(k) for k in (request.json or {})
                   if k in ("name", "daily_wage", "active", "designation")}
        write_log("staff.update", target_collection="staff",
                  target_id=staff_id, before=changed,
                  metadata={"fields": sorted((request.json or {}).keys())})
        return jsonify(success=True, staff=s)
    except ValueError as ve:
        return _fail(ve)
    except Exception as e:
        logger.exception("staff PATCH failed")
        return _fail(e, 500)


# ─── Attendance ────────────────────────────────────────────────────────────

@staff_bp.route("/attendance", methods=["GET"])
@requires_permission("staff.view")
def get_attendance():
    """Attendance records for a date range (inclusive).
    Query: start=YYYY-MM-DD & end=YYYY-MM-DD [& staff_id=…]"""
    try:
        start = (request.args.get("start") or "").strip()
        end = (request.args.get("end") or "").strip()
        if not start or not end:
            return _fail("start and end are required (YYYY-MM-DD).")
        records = svc.attendance_range(start, end,
                                       request.args.get("staff_id") or None)
        # Paid-period locks (per staff) so the grid can mark settled days
        # read-only. One collection scan covers every row at once.
        locks = svc.paid_periods_by_staff()
        if request.args.get("staff_id"):
            sid = request.args["staff_id"]
            locks = {sid: locks.get(sid, [])}
        return jsonify(success=True, attendance=records, paid_periods=locks)
    except Exception as e:
        logger.exception("staff/attendance GET failed")
        return _fail(e, 500)


@staff_bp.route("/attendance/mark", methods=["POST"])
@requires_permission("staff.attendance.mark")
def mark_attendance():
    """Body: { staff_id, date, status: full|half|absent|clear }"""
    try:
        data = request.json or {}
        rec = svc.mark_attendance(
            data.get("staff_id", ""), str(data.get("date", "")).strip(),
            data.get("status", ""), g.current_user)
        write_log("staff.attendance.mark",
                  target_collection="staff_attendance",
                  target_id="{}__{}".format(data.get("staff_id"),
                                            data.get("date")),
                  metadata={"status": data.get("status")})
        return jsonify(success=True, record=rec)
    except ValueError as ve:
        return _fail(ve, 409 if "already paid" in str(ve) else 400)
    except Exception as e:
        logger.exception("staff/attendance/mark failed")
        return _fail(e, 500)


@staff_bp.route("/attendance/mark_all", methods=["POST"])
@requires_permission("staff.attendance.mark")
def mark_all_present():
    """Body: { date }. Marks every active staff member without a record on
    that date as Full, in one batch. Already-marked staff are untouched;
    paid-period days are skipped (reported back, not an error)."""
    try:
        date = str((request.json or {}).get("date", "")).strip()
        out = svc.mark_all_present(date, g.current_user)
        write_log("staff.attendance.mark_all",
                  target_collection="staff_attendance", target_id=date,
                  metadata={"marked": len(out["marked"]),
                            "already_marked": out["already_marked"],
                            "skipped_locked": out["skipped_locked"]})
        return jsonify(success=True, **out)
    except ValueError as ve:
        return _fail(ve)
    except Exception as e:
        logger.exception("staff/attendance/mark_all failed")
        return _fail(e, 500)


# ─── Analytics & register ──────────────────────────────────────────────────

@staff_bp.route("/analytics", methods=["GET"])
@requires_permission("analytics.view")   # Insights = analytics → admin-only
def analytics():
    """Insights payload: monthly cash-out trend, totals, per-staff stats.
    Query: months=N (default 6, max 24)."""
    try:
        try:
            months = int(request.args.get("months", 6) or 6)
        except ValueError:
            months = 6
        return jsonify(success=True, **svc.payroll_analytics(months))
    except Exception as e:
        logger.exception("staff/analytics failed")
        return _fail(e, 500)


@staff_bp.route("/register", methods=["GET"])
@requires_permission("analytics.view")   # register export is admin-only too
def register():
    """Monthly payroll register rows. Query: month=YYYY-MM."""
    try:
        month = (request.args.get("month") or "").strip()
        return jsonify(success=True, **svc.month_register(month))
    except ValueError as ve:
        return _fail(ve)
    except Exception as e:
        logger.exception("staff/register failed")
        return _fail(e, 500)


# ─── Ledger detail ─────────────────────────────────────────────────────────

@staff_bp.route("/<staff_id>/detail", methods=["GET"])
@requires_permission("staff.payroll.view")
def staff_detail(staff_id):
    try:
        return jsonify(success=True, **svc.staff_detail(staff_id))
    except ValueError as ve:
        return _fail(ve, 404)
    except Exception as e:
        logger.exception("staff/detail failed")
        return _fail(e, 500)


# ─── Advances ──────────────────────────────────────────────────────────────

@staff_bp.route("/advance", methods=["POST"])
@requires_permission("staff.advance.give")
def give_advance():
    """
    Body: { staff_id, amount, date?, payment_method: cash|online,
            expense_type: transaction|report, note? }

    Writes the advance + its expense row atomically. The response echoes
    the expense row (with _doc_id) so the transaction log can
    smooth-insert it, mirroring /add_expense.
    """
    try:
        data = request.json or {}
        if _reject_account_source(data):
            return _fail(_ACCOUNT_403, 403)
        out = svc.create_advance(
            data.get("staff_id", ""), data.get("amount"),
            data.get("date", ""), data.get("payment_method", "cash"),
            data.get("expense_type", "transaction"),
            data.get("note", ""), g.current_user)
        invalidate_rooms_and_totals()
        adv = out["advance"]
        write_log("staff.advance.give",
                  target_collection="staff_advances", target_id=adv["id"],
                  metadata={"staff": adv["staff_name"],
                            "amount": adv["amount"],
                            "expense_doc_id": adv["expense_doc_id"]})
        return jsonify(success=True,
                       message="Advance of ₹{} given to {}".format(
                           adv["amount"], adv["staff_name"]),
                       advance=adv, expense=out["expense"])
    except ValueError as ve:
        return _fail(ve)
    except Exception as e:
        logger.exception("staff/advance failed")
        return _fail(e, 500)


@staff_bp.route("/advance/<advance_id>", methods=["DELETE"])
@requires_permission("staff.manage")   # reversals stay admin-only
def delete_advance(advance_id):
    try:
        adv = svc.delete_advance(advance_id)
        invalidate_rooms_and_totals()
        write_log("staff.advance.delete",
                  target_collection="staff_advances", target_id=advance_id,
                  before={"staff": adv.get("staff_name"),
                          "amount": adv.get("amount"),
                          "date": adv.get("date")})
        return jsonify(success=True, message="Advance deleted")
    except ValueError as ve:
        return _fail(ve, 409 if "already deducted" in str(ve) else 400)
    except Exception as e:
        logger.exception("staff/advance DELETE failed")
        return _fail(e, 500)


# ─── Salary ────────────────────────────────────────────────────────────────

@staff_bp.route("/<staff_id>/salary_preview", methods=["GET"])
@requires_permission("staff.payroll.view")
def salary_preview(staff_id):
    """Query: start & end (YYYY-MM-DD) [& adjustment=int]. Computes the
    payout without writing anything — powers the Pay Salary screen."""
    try:
        try:
            adjustment = int(request.args.get("adjustment", 0) or 0)
        except ValueError:
            adjustment = 0
        return jsonify(success=True, **svc.salary_preview(
            staff_id, (request.args.get("start") or "").strip(),
            (request.args.get("end") or "").strip(), adjustment))
    except ValueError as ve:
        return _fail(ve)
    except Exception as e:
        logger.exception("staff/salary_preview failed")
        return _fail(e, 500)


@staff_bp.route("/<staff_id>/pay_salary", methods=["POST"])
@requires_permission("staff.salary.pay")
def pay_salary(staff_id):
    """
    Body: { period_start, period_end, advance_deduction, adjustment,
            adjustment_note?, payment_method: cash|online,
            expense_type: transaction|report }

    The server recomputes everything from attendance — the client's
    preview numbers are never trusted.
    """
    try:
        data = request.json or {}
        if _reject_account_source(data):
            return _fail(_ACCOUNT_403, 403)
        out = svc.pay_salary(
            staff_id,
            str(data.get("period_start", "")).strip(),
            str(data.get("period_end", "")).strip(),
            data.get("advance_deduction", 0),
            data.get("adjustment", 0),
            data.get("adjustment_note", ""),
            data.get("payment_method", "cash"),
            data.get("expense_type", "transaction"),
            g.current_user)
        invalidate_rooms_and_totals()
        pay = out["payment"]
        write_log("staff.salary.pay",
                  target_collection="staff_salary_payments",
                  target_id=pay["id"],
                  metadata={"staff": pay["staff_name"],
                            "period": "{}..{}".format(pay["period_start"],
                                                      pay["period_end"]),
                            "days": pay["days_worked"],
                            "gross": pay["gross"],
                            "advance_deducted": pay["advance_deducted"],
                            "net_paid": pay["net_paid"]})
        msg = "Salary settled for {}: ₹{} paid".format(
            pay["staff_name"], pay["net_paid"])
        if out["advance_remaining"] > 0:
            msg += " · ₹{} advance carries forward".format(
                out["advance_remaining"])
        return jsonify(success=True, message=msg, payment=pay,
                       expense=out["expense"],
                       advance_remaining=out["advance_remaining"])
    except ValueError as ve:
        return _fail(ve, 409 if "already paid" in str(ve) else 400)
    except Exception as e:
        logger.exception("staff/pay_salary failed")
        return _fail(e, 500)


@staff_bp.route("/salary/<payment_id>", methods=["DELETE"])
@requires_permission("staff.manage")   # reversals stay admin-only
def delete_salary_payment(payment_id):
    try:
        pay = svc.delete_salary_payment(payment_id)
        invalidate_rooms_and_totals()
        write_log("staff.salary.delete",
                  target_collection="staff_salary_payments",
                  target_id=payment_id,
                  before={"staff": pay.get("staff_name"),
                          "period": "{}..{}".format(pay.get("period_start"),
                                                    pay.get("period_end")),
                          "net_paid": pay.get("net_paid"),
                          "advance_deducted": pay.get("advance_deducted")})
        return jsonify(success=True,
                       message="Salary payment reversed — the period is "
                               "open again and any deducted advance is "
                               "outstanding once more")
    except ValueError as ve:
        return _fail(ve, 404)
    except Exception as e:
        logger.exception("staff/salary DELETE failed")
        return _fail(e, 500)
