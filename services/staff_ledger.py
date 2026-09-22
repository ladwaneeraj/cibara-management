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

             Those are WORKED-DAY units, the wage base. Counting whether
             someone turned up is a different question with a different
             answer: presence_summary() and period_breakdown() both count
             whole calendar days, where a half day is one day present and a
             day covering both shifts is still one. Every screen that says
             "days present" uses that convention; every screen that says
             "shifts" or pays money uses the worked-day one.

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

repayment    Cash a staff member hands BACK against that balance, outside
             of a salary payout ("here is ₹2,000, cut it from my advance"):
                 {id, staff_id, date, amount (int ₹)}
             Positive amounts only — a repayment is never stored as a
             negative advance, so any sum over the advances list still
             means "money given". It reduces the outstanding balance the
             same way a salary deduction does, and can never exceed it.

salary payment
             One settled payout for a period:
                 {id, staff_id, period_start, period_end,
                  gross (int), adjustment (signed int),
                  advance_deducted (int), net_paid (int)}
             advance_deducted reduces the outstanding advance; whatever
             remains carries forward automatically (it is never re-entered
             anywhere — the outstanding is always derived from the raw
             advance / deduction / repayment history, so it cannot drift
             or be double-counted).

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
        if not isinstance(rec, dict):
            continue
        d = str(rec.get("date") or "")
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


def presence_summary(attendance: list, start: str, end: str) -> dict:
    """
    The same records as attendance_summary, counted per CALENDAR DAY instead
    of per shift.

    Why both exist
    --------------
    attendance_summary counts SHIFTS, because that is what wages are paid on:
    a day-and-night staff member who works both shifts is paid for two.
    Attendance is a different question — did the person turn up — and shifts
    answer it wrongly in both directions for the staff who rotate:

      * someone on two weeks of nights works ONE shift a day. Judged against
        two shifts a day they read 50% while never missing a day.
      * someone who covers both shifts on a few days read over 100%, which is
        how a night-shift manager won "best attendance" by arithmetic.

    So: attendance is measured against days, and the extra shifts are
    reported separately as what they are — cover, not attendance.

    A day counts as:
      present  when at least one shift that day was full or half. Whole days,
               never fractions: a half day is a day the person turned up, a
               full + half day is one day present and not 1.5, and a
               both-shifts day is one day present and not two.
      absent   when every shift marked that day is "absent". A day with no
               record at all is NOT an absence: nobody marked it, and
               guessing turns a data gap into a pay dispute.

    A half day counting as a whole day present is the same rule
    period_breakdown() uses for the salary census, and deliberately so: the
    two were counting the same staff member on the same dates and printing
    different numbers, 12 present on the salary screen against 11.5 in
    Insights, with nothing on either screen to say why. Presence answers "was
    he here". How MUCH he worked is days_worked / shifts_worked, which still
    values a half day at 0.5 and is what wages are paid on. half_days_present
    carries the detail so a half day is visible rather than rounded away.

    Returns
    -------
    {days_present, days_absent, days_marked, half_days_present,
     shifts_worked, double_shift_days, extra_shifts}

      days_present      int, calendar days present, the attendance numerator
      days_absent       int
      days_marked       int, days with any record (present or absent)
      half_days_present int, present days whose every worked shift was a half
      shifts_worked     float, = attendance_summary()["days_worked"]
      double_shift_days int, days where more than one shift was worked
      extra_shifts      float, shifts beyond one a day (the cover above)
    """
    by_day: dict = {}
    for rec in attendance or []:
        if not isinstance(rec, dict):
            continue
        d = str(rec.get("date") or "")
        status = rec.get("status")
        if not _valid_date(d) or status not in ATTENDANCE_STATUSES:
            continue
        if (start and d < start) or (end and d > end):
            continue
        shift = rec.get("shift") or None
        # Same last-one-wins rule as attendance_summary, so the two can never
        # disagree about which record counts.
        by_day.setdefault(d, {})[shift] = status

    days_present = 0
    days_absent = 0
    half_days_present = 0
    shifts_worked = 0.0
    double_shift_days = 0
    for statuses in by_day.values():
        worked = [s for s in statuses.values() if s != STATUS_ABSENT]
        shifts_worked += sum(_DAY_VALUE[s] for s in worked)
        if worked:
            days_present += 1
            if all(s == STATUS_HALF for s in worked):
                half_days_present += 1
            if len(worked) > 1:
                double_shift_days += 1
        else:
            days_absent += 1

    return {
        "days_present": days_present,
        "days_absent": days_absent,
        "days_marked": len(by_day),
        "half_days_present": half_days_present,
        "shifts_worked": round(shifts_worked, 2),
        "double_shift_days": double_shift_days,
        "extra_shifts": round(max(0.0, shifts_worked - days_present), 2),
    }


# ───────────────────────────────────────────────────────────────────────────
# Advances — outstanding balance & carry-forward
# ───────────────────────────────────────────────────────────────────────────

def outstanding_advance(advances: list, salary_payments: list,
                        repayments: list = None) -> int:
    """
    The advance balance still to be recovered from the staff member:

        Σ advance.amount  −  Σ payment.advance_deducted  −  Σ repayment.amount

    Derived from raw history every time — nothing is carried in a mutable
    counter, so a deleted advance, reversed payment or deleted repayment
    self-corrects. A healthy ledger never goes negative; the (signed) value
    is returned as-is so callers can detect and refuse a state that would
    break the invariant (e.g. deleting an advance that was already
    deducted or repaid).
    """
    given = sum(_to_int((a or {}).get("amount")) for a in advances or [])
    recovered = sum(_to_int((p or {}).get("advance_deducted"))
                    for p in salary_payments or [])
    repaid = sum(_to_int((r or {}).get("amount")) for r in repayments or [])
    return given - recovered - repaid


def validate_repayment(amount, outstanding: int, date: str,
                       today: str) -> Optional[str]:
    """
    Validate a cash repayment against an advance. Returns an error message
    (str) or None when the repayment is sound.

    The only money rule: it must be positive and must not exceed what is
    outstanding — a staff member cannot "repay" more than they owe, because
    the ledger has no way to hold money the lodge owes them.
    """
    if not _valid_date(date):
        return "Date must be YYYY-MM-DD."
    if _valid_date(today) and date > today:
        return "A repayment cannot be dated in the future."
    amt = _to_int(amount)
    if amt <= 0:
        return "Repayment amount must be above zero."
    due = max(0, _to_int(outstanding))
    if due <= 0:
        return "No advance is outstanding — nothing to repay."
    if amt > due:
        return ("Repayment (₹{}) exceeds the outstanding advance "
                "(₹{}).").format(amt, due)
    return None


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

def marked_dates(attendance: list, start: str, end: str) -> set:
    """
    Calendar dates in [start, end] that carry at least one usable attendance
    record — full, half OR absent. "Absent" counts as marked: someone made a
    decision about that day.

    The predicate here is deliberately IDENTICAL to the one in
    attendance_summary() (valid date, known status, inside the range). If the
    two ever disagree, a day could be paid for by one and skipped by the
    other, which is exactly the class of bug this function exists to prevent.
    Change them together.

    Date-level, not shift-level, because everything that consumes this —
    payment_covers, covered_dates, date_in_paid_period — reasons in whole
    calendar days. A dual-shift staff member with only their D shift marked
    counts as marked for that date; adding the missing N shift afterwards is
    an attendance correction, not an unpaid day. That matches the existing
    locking model rather than inventing a second one.
    """
    out = set()
    for rec in attendance or []:
        d = str((rec or {}).get("date") or "")
        status = (rec or {}).get("status")
        if not _valid_date(d) or status not in ATTENDANCE_STATUSES:
            continue
        if start and d < start:
            continue
        if end and d > end:
            continue
        out.add(d)
    return out


def unmarked_dates(start: str, end: str, attendance: list,
                   exclude=None) -> set:
    """
    Days in [start, end] with NO attendance record at all, minus `exclude`.

    Why this matters: a salary payment records the period it settled, and
    covered_dates() then treats EVERY day in that period as paid. Pay a week
    where one day was never marked and that day is silently consumed — it
    earned ₹0 (no attendance, no wage), attendance edits on it are locked by
    date_in_paid_period(), and a later payment skips it as already covered.
    The staff member is never paid for it and nothing surfaces the loss.

    So unmarked days are treated exactly like already-paid days: listed in the
    payment's excluded_dates, worth ₹0, NOT locked, and still payable once
    somebody marks them.

    `exclude` is normally the already-covered set, so the two categories stay
    disjoint and each can be reported to the operator in its own words.
    """
    if not (_valid_date(start) and _valid_date(end)) or start > end:
        return set()
    exclude = exclude or set()
    marked = marked_dates(attendance, start, end)
    return {d for d in _dates_between(start, end)
            if d not in marked and d not in exclude}


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


def period_breakdown(attendance: list, start: str, end: str,
                     covered=None, unmarked=None) -> dict:
    """
    Calendar-day census of [start, end] for the ledger caption.

    Every day in the period lands in exactly one bucket and the four counts
    always sum to `days`:

        present   marked full or half on at least one shift
        absent    marked, and absent on every shift
        carried   already settled by an EARLIER payment, so not this row's
        unmarked  nobody marked attendance at all

    Counts are CALENDAR DAYS, never worked-day units. A half day is one
    present day, not half of one, and a dual-shift member who worked both D
    and N was present once. That is deliberate: this answers "how many days
    was he here", which is not the wage base. `days_worked` stays the wage
    number and is reported separately.

    `carried` is tested first, so a day that is both marked and already paid
    counts once, on the row that actually paid it. Without that precedence
    the same day would appear as present on two ledger rows.

    Returns {days, present, absent, carried, unmarked}.
    """
    empty = {"days": 0, "present": 0, "absent": 0, "carried": 0, "unmarked": 0}
    if not (_valid_date(start) and _valid_date(end)) or start > end:
        return empty

    covered = set(covered or ())
    present = set(present_dates(attendance, start, end))
    marked = marked_dates(attendance, start, end)
    # `unmarked` is normally passed in already disjoint from `covered`, but
    # deriving it from `marked` gives the same answer and keeps the census
    # correct when the caller has nothing to pass.
    unmarked = set(unmarked or ()) | {
        d for d in _dates_between(start, end) if d not in marked
    }

    out = dict(empty)
    for d in _dates_between(start, end):
        out["days"] += 1
        if d in covered:
            out["carried"] += 1
        elif d in unmarked:
            out["unmarked"] += 1
        elif d in present:
            out["present"] += 1
        else:
            out["absent"] += 1
    return out


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
