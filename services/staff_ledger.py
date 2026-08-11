"""
Staff payroll ledger — the pure account math behind the Staff module.

No Firestore, no Flask: plain dicts in, plain dicts out (same philosophy as
services/laundry_ledger.py). services/staff_service.py owns all I/O and
calls into this module, which makes every rupee of the salary arithmetic
unit-testable in isolation (tests/test_staff_ledger.py).

Concepts
────────
attendance   One record per (staff, date), or per (staff, date, shift) for
             dual-shift staff:
                 {staff_id, date "YYYY-MM-DD", status "full"|"half"|"absent",
                  shift "D"|"N" (optional — only dual-shift staff have it)}
             Unmarked days simply have no record. A half day counts as 0.5
             worked days, a full day as 1.0, absent/unmarked as 0. A
             dual-shift staff member's day is the SUM of their D and N
             records (so a full-D + full-N day is worth 2.0 worked-day
             units) — see attendance_summary().

meals        Some staff eat at the lodge. That is a real cost to the
             business AND something the staff member does not get in cash,
             so it is modelled as a flat per-day rate on the staff record
             (`meal_rate`, ₹/day; 0 = does not eat here).

             Two separate things happen with it, deliberately kept apart:

               1. At salary time the meal charge for the period is deducted
                  from the payout, so a ₹350/day staff member on a ₹50/day
                  meal rate takes home ₹300/day in cash.
               2. Whenever the operator settles up with the kitchen (in
                  practice, at the end of the week), the meal cost for a
                  range of days is logged in one go as its own expense.

             Together the books show the true ₹350/day: ₹300 salary + ₹50
             meals. Meals are counted per CALENDAR DAY present, not per
             worked-day unit — a half day still eats, and a dual-shift
             staff member eats once, not twice.

advance      Money handed to a staff member ahead of salary:
                 {id, staff_id, date, amount (int ₹)}
             Advances accumulate into an outstanding balance.

salary payment
             One settled payout for a period:
                 {id, staff_id, period_start, period_end,
                  gross (int), adjustment (signed int),
                  advance_deducted (int), net_paid (int)}
             advance_deducted reduces the outstanding advance; whatever
             remains carries forward automatically (it is never re-entered
             anywhere — the outstanding is always derived from the raw
             advance / deduction history, so it cannot drift or be
             double-counted).

Money is whole rupees (int) throughout, matching the expenses collection.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

STATUS_FULL = "full"
STATUS_HALF = "half"
STATUS_ABSENT = "absent"
ATTENDANCE_STATUSES = (STATUS_FULL, STATUS_HALF, STATUS_ABSENT)

# Worked-day value of each attendance status.
_DAY_VALUE = {STATUS_FULL: 1.0, STATUS_HALF: 0.5, STATUS_ABSENT: 0.0}


def _to_int(v, default=0) -> int:
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return default


def _valid_date(s) -> bool:
    """Strict YYYY-MM-DD. strptime alone accepts '2026-07-1', which would
    silently break the string-ordering comparisons used throughout — so we
    require the parsed date to round-trip to the exact same string."""
    try:
        return datetime.strptime(str(s), "%Y-%m-%d").strftime("%Y-%m-%d") == str(s)
    except (TypeError, ValueError):
        return False


def day_value(status: str) -> float:
    """Worked-day value of an attendance status (unknown → 0)."""
    return _DAY_VALUE.get(status, 0.0)


# ───────────────────────────────────────────────────────────────────────────
# Attendance
# ───────────────────────────────────────────────────────────────────────────

def attendance_summary(attendance: list, start: str, end: str,
                       exclude=None) -> dict:
    """
    Summarise attendance records that fall inside [start, end] (inclusive).

    Records with a missing/malformed date or an unknown status are ignored.
    Duplicate records for the same (date, shift) keep the LAST one seen
    (the caller normally can't produce duplicates — doc id is
    staff_id__date, or staff_id__date__shift for dual-shift staff — but
    the math must not double-count if it ever happens). Single-shift
    records key on date alone (shift is absent/None); a dual-shift staff
    member's D and N records key separately, so BOTH contribute to the
    totals below — a full-D + full-N day counts as two full days.

    `exclude` (set of dates) drops those days entirely, regardless of
    shift — used to skip days an earlier salary payment already covered,
    so a mid-period payout never causes double pay OR a hard block.

    Returns {full_days, half_days, absent_days, days_worked, marked_days}.
    days_worked is a float (halves), e.g. 12 full + 3 half → 13.5. For a
    dual-shift staff member, days_worked/full_days/etc. count SHIFTS, not
    calendar days, so they can exceed the number of days in the period.
    """
    exclude = exclude or set()
    by_key: dict = {}
    for rec in attendance or []:
        d = str((rec or {}).get("date") or "")
        status = (rec or {}).get("status")
        if not _valid_date(d) or status not in ATTENDANCE_STATUSES:
            continue
        if start and d < start:
            continue
        if end and d > end:
            continue
        if d in exclude:
            continue
        shift = (rec or {}).get("shift") or None
        by_key[(d, shift)] = status

    full = sum(1 for s in by_key.values() if s == STATUS_FULL)
    half = sum(1 for s in by_key.values() if s == STATUS_HALF)
    absent = sum(1 for s in by_key.values() if s == STATUS_ABSENT)
    return {
        "full_days": full,
        "half_days": half,
        "absent_days": absent,
        "days_worked": full + 0.5 * half,
        "marked_days": len(by_key),
    }


# ───────────────────────────────────────────────────────────────────────────
# Advances — outstanding balance & carry-forward
# ───────────────────────────────────────────────────────────────────────────

def outstanding_advance(advances: list, salary_payments: list) -> int:
    """
    The advance balance still to be recovered from the staff member:

        Σ advance.amount  −  Σ payment.advance_deducted

    Derived from raw history every time — nothing is carried in a mutable
    counter, so a deleted advance or reversed payment self-corrects.
    A healthy ledger never goes negative; the (signed) value is returned
    as-is so callers can detect and refuse a state that would break the
    invariant (e.g. deleting an advance that was already deducted).
    """
    given = sum(_to_int((a or {}).get("amount")) for a in advances or [])
    recovered = sum(_to_int((p or {}).get("advance_deducted"))
                    for p in salary_payments or [])
    return given - recovered


# ───────────────────────────────────────────────────────────────────────────
# Salary computation
# ───────────────────────────────────────────────────────────────────────────

def compute_salary(daily_wage, attendance: list, start: str, end: str,
                   adjustment=0, exclude=None) -> dict:
    """
    Wages for a period: days worked × per-day wage, plus a signed manual
    adjustment (bonus / fine). Gross is rounded to whole rupees
    (e.g. 13.5 days × ₹433 → ₹5,846 (5845.5 rounds up)).

    Returns the attendance summary merged with:
        {daily_wage, gross, adjustment, payable_before_advance}
    """
    wage = _to_int(daily_wage)
    adj = _to_int(adjustment)
    summary = attendance_summary(attendance, start, end, exclude=exclude)
    gross = _to_int(summary["days_worked"] * wage)
    summary.update({
        "daily_wage": wage,
        "gross": gross,
        "adjustment": adj,
        "payable_before_advance": gross + adj,
    })
    return summary


# ───────────────────────────────────────────────────────────────────────────
# Meals
# ───────────────────────────────────────────────────────────────────────────

def present_dates(attendance: list, start: str, end: str,
                  exclude=None) -> list:
    """
    Sorted distinct calendar dates in [start, end] the staff member was
    present for at all (full OR half, either shift).

    Deliberately NOT days_worked. Meals are counted per calendar day:
      * a half day still eats one meal, so it counts as 1, not 0.5;
      * a dual-shift staff member working D and N eats once that day, so
        their two records collapse to a single date.

    `exclude` drops those dates entirely — used to skip days an earlier
    meal log already covered.
    """
    exclude = exclude or set()
    out = set()
    for rec in attendance or []:
        d = str((rec or {}).get("date") or "")
        status = (rec or {}).get("status")
        if not _valid_date(d) or status not in ATTENDANCE_STATUSES:
            continue
        if status == STATUS_ABSENT:
            continue
        if start and d < start:
            continue
        if end and d > end:
            continue
        if d in exclude:
            continue
        out.add(d)
    return sorted(out)


def compute_meals(meal_rate, attendance: list, start: str, end: str,
                  exclude=None) -> dict:
    """
    The meal charge for a period.

    Returns {meal_rate, meal_days, meal_dates, meal_total}. A meal_rate of
    0 (the default — most staff do not eat here) yields a total of 0 while
    still reporting the days, so a caller can show "0 × 6 days" rather than
    hiding the row entirely.
    """
    rate = _to_int(meal_rate)
    dates = present_dates(attendance, start, end, exclude=exclude)
    return {
        "meal_rate": rate,
        "meal_days": len(dates),
        "meal_dates": dates,
        "meal_total": rate * len(dates),
    }


def logged_meal_dates(start: str, end: str, meal_logs: list) -> set:
    """
    Days inside [start, end] that an existing meal log already covers.

    Each log stores the exact dates it charged for (`meal_dates`), so this
    is an exact set intersection rather than a range guess — a meal log for
    a week where the staff member was absent on Wednesday does NOT claim
    Wednesday, and a later log can still pick it up if attendance changes.
    """
    if not (_valid_date(start) and _valid_date(end)) or start > end:
        return set()
    out = set()
    for log in meal_logs or []:
        for d in (log or {}).get("meal_dates") or []:
            d = str(d)
            if start <= d <= end:
                out.add(d)
    return out


# ───────────────────────────────────────────────────────────────────────────
# Paid-day coverage — the double-pay guard
#
# A payment covers every day of [period_start, period_end] EXCEPT the days
# listed in its `excluded_dates` (days that were already paid by an earlier
# payment when it was made). Overlapping a new period with old ones is
# allowed — the already-covered days are simply skipped and earn nothing —
# so a mid-week one-day payout never blocks the week's settlement.
# ───────────────────────────────────────────────────────────────────────────

def periods_overlap(a_start: str, a_end: str, b_start: str, b_end: str) -> bool:
    """True when [a_start, a_end] and [b_start, b_end] share any day."""
    return a_start <= b_end and b_start <= a_end


def _dates_between(start: str, end: str):
    d = datetime.strptime(start, "%Y-%m-%d")
    stop = datetime.strptime(end, "%Y-%m-%d")
    while d <= stop:
        yield d.strftime("%Y-%m-%d")
        d += timedelta(days=1)


def payment_covers(payment: dict, date: str) -> bool:
    """True when this payment actually paid for `date`."""
    ps = (payment or {}).get("period_start")
    pe = (payment or {}).get("period_end")
    if not (_valid_date(ps) and _valid_date(pe)):
        return False
    if not (str(ps) <= date <= str(pe)):
        return False
    return date not in set(payment.get("excluded_dates") or [])


def covered_dates(start: str, end: str, salary_payments: list) -> set:
    """
    The days inside [start, end] that existing payments already paid for
    (respecting each payment's own excluded_dates). These days are skipped
    — never re-paid, never blocking.
    """
    if not (_valid_date(start) and _valid_date(end)) or start > end:
        return set()
    out = set()
    for p in salary_payments or []:
        ps = (p or {}).get("period_start")
        pe = (p or {}).get("period_end")
        if not (_valid_date(ps) and _valid_date(pe)):
            continue
        lo, hi = max(start, str(ps)), min(end, str(pe))
        if lo > hi:
            continue
        excl = set(p.get("excluded_dates") or [])
        for d in _dates_between(lo, hi):
            if d not in excl:
                out.add(d)
    return out


def date_in_paid_period(date: str, salary_payments: list) -> Optional[dict]:
    """
    Return the payment that actually paid for `date`, else None. Used to
    lock attendance edits on days that are already settled. Days a payment
    explicitly excluded are NOT locked by it.
    """
    for p in salary_payments or []:
        if payment_covers(p, date):
            return p
    return None


def suggest_period_start(salary_payments: list) -> Optional[str]:
    """
    The day after the latest settled period_end — the natural start for
    the next payout. None when the staff member has never been paid.
    """
    latest = None
    for p in salary_payments or []:
        pe = (p or {}).get("period_end")
        if _valid_date(pe) and (latest is None or str(pe) > latest):
            latest = str(pe)
    if latest is None:
        return None
    nxt = datetime.strptime(latest, "%Y-%m-%d") + timedelta(days=1)
    return nxt.strftime("%Y-%m-%d")


# ───────────────────────────────────────────────────────────────────────────
# Payment validation
# ───────────────────────────────────────────────────────────────────────────

def validate_payment(period_start: str, period_end: str, computed: dict,
                     advance_deduction, outstanding: int,
                     salary_payments: list, today: str,
                     covered=None, meal_deduction=0) -> Optional[str]:
    """
    Validate a proposed salary payout end-to-end. Returns an error message
    (str) or None when the payment is sound.

    computed: output of compute_salary() for the same period.
    """
    if not (_valid_date(period_start) and _valid_date(period_end)):
        return "Period dates must be YYYY-MM-DD."
    if period_start > period_end:
        return "Period start must be on or before period end."
    if _valid_date(today) and period_end > today:
        return "Period cannot extend into the future."

    covered = covered or set()
    if covered and all(d in covered
                       for d in _dates_between(period_start, period_end)):
        return ("Every day of {} – {} is already paid — nothing left to "
                "settle in this period.").format(period_start, period_end)

    deduction = _to_int(advance_deduction)
    if deduction < 0:
        return "Advance deduction cannot be negative."
    if deduction > max(0, _to_int(outstanding)):
        return ("Advance deduction (₹{}) exceeds the outstanding advance "
                "(₹{}).").format(deduction, max(0, _to_int(outstanding)))

    meals = _to_int(meal_deduction)
    if meals < 0:
        return "Meal deduction cannot be negative."

    payable = _to_int(computed.get("payable_before_advance"))
    if payable <= 0 and deduction <= 0 and meals <= 0:
        return ("Nothing to pay for this period — no attendance marked "
                "and no adjustment given.")
    if deduction > payable:
        return ("Advance deduction (₹{}) cannot exceed the payable amount "
                "(₹{}). Deduct the rest from a future salary — it carries "
                "forward automatically.").format(deduction, payable)
    # Meals come out after the advance. Between them they must not push the
    # payout negative — that would mean the staff member owes the lodge,
    # which this module has no way to record.
    #
    # Two distinct failures, and the message has to tell them apart: if the
    # meal charge alone exceeds what was earned, there is nothing on the
    # payout form the operator could change, so pointing at the advance
    # deduction would send them looking for a control that cannot help.
    if meals > payable:
        return ("Meals ₹{} exceed what was earned in {} – {} (₹{}). Widen "
                "the period, or correct the meal rate on the staff "
                "record.").format(meals, period_start, period_end, payable)
    if deduction + meals > payable:
        return ("Advance ₹{} + meals ₹{} exceed the payable amount (₹{}). "
                "Reduce the advance deduction — meals are a fixed per-day "
                "charge.").format(deduction, meals, payable)
    return None


def settlement(computed: dict, advance_deduction, outstanding: int,
               meal_deduction=0) -> dict:
    """
    The final numbers for a validated payout:

        net_paid            what actually leaves the till
        advance_deducted    recovered from the outstanding advance
        advance_remaining   carries forward to the next salary
        meal_deducted       withheld for meals eaten at the lodge

    net_paid = gross + adjustment − advance_deducted − meal_deducted.

    The meal deduction is NOT an expense saving: the lodge still pays for
    the food, it just pays the kitchen instead of the staff member. The
    matching cost is recorded separately by the meal log (see compute_meals),
    so the two rows together add back up to the staff member's true daily
    rate.

    Call validate_payment() first — this function trusts its inputs.
    """
    deduction = _to_int(advance_deduction)
    meals = _to_int(meal_deduction)
    payable = _to_int(computed.get("payable_before_advance"))
    return {
        "gross": _to_int(computed.get("gross")),
        "adjustment": _to_int(computed.get("adjustment")),
        "advance_deducted": deduction,
        "meal_deducted": meals,
        "net_paid": payable - deduction - meals,
        "advance_remaining": max(0, _to_int(outstanding)) - deduction,
    }
