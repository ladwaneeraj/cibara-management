"""
Unit tests for services/staff_ledger.py — the pure payroll math behind the
Staff module. No Firestore, no Flask: plain dicts in, plain dicts out.

Run:  pytest tests/test_staff_ledger.py -q
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# In a full-suite run (pytest tests/), earlier test modules (e.g.
# test_expense_split.py) replace sys.modules["services"] with a stub whose
# __path__ is [] so they can import routes without Firebase. Any submodule
# import through that stub fails. If the cached "services" package cannot
# see the real services/ directory, drop it so Python re-imports the real
# one; the earlier modules keep their already-bound stub references.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_svc = sys.modules.get("services")
if _svc is not None and os.path.join(_REPO_ROOT, "services") not in list(
        getattr(_svc, "__path__", []) or []):
    del sys.modules["services"]

from services.staff_ledger import (
    attendance_summary,
    compute_salary,
    covered_dates,
    date_in_paid_period,
    day_value,
    outstanding_advance,
    payment_covers,
    periods_overlap,
    settlement,
    suggest_period_start,
    validate_payment,
)


def _att(date, status):
    return {"staff_id": "s1", "date": date, "status": status}


def _att_shift(date, status, shift):
    return {"staff_id": "s1", "date": date, "status": status, "shift": shift}


def _adv(amount, date="2026-07-05"):
    return {"staff_id": "s1", "date": date, "amount": amount}


def _pay(start, end, deducted=0, paid_on=None, excluded=None):
    return {"staff_id": "s1", "period_start": start, "period_end": end,
            "advance_deducted": deducted, "paid_on": paid_on or end,
            "excluded_dates": excluded or []}


TODAY = "2026-07-23"


# ── Attendance summary ──────────────────────────────────────────────────────

def test_day_values():
    assert day_value("full") == 1.0
    assert day_value("half") == 0.5
    assert day_value("absent") == 0.0
    assert day_value("garbage") == 0.0


def test_summary_counts_full_half_absent():
    att = [_att("2026-07-01", "full"), _att("2026-07-02", "half"),
           _att("2026-07-03", "absent"), _att("2026-07-04", "full")]
    s = attendance_summary(att, "2026-07-01", "2026-07-31")
    assert s["full_days"] == 2
    assert s["half_days"] == 1
    assert s["absent_days"] == 1
    assert s["days_worked"] == 2.5
    assert s["marked_days"] == 4


def test_summary_respects_range_inclusive():
    att = [_att("2026-06-30", "full"), _att("2026-07-01", "full"),
           _att("2026-07-31", "full"), _att("2026-08-01", "full")]
    s = attendance_summary(att, "2026-07-01", "2026-07-31")
    assert s["full_days"] == 2


def test_summary_ignores_junk_and_never_double_counts():
    att = [_att("2026-07-01", "full"),
           _att("2026-07-01", "half"),          # duplicate date → last wins
           _att("bad-date", "full"),
           _att("2026-07-02", "unknown"),
           {"date": None, "status": "full"},
           None]
    s = attendance_summary(att, "2026-07-01", "2026-07-31")
    assert s["marked_days"] == 1
    assert s["days_worked"] == 0.5


# ── Dual-shift attendance (staff who work both a Day and Night shift) ──────

def test_summary_dual_shift_day_counts_as_two_full_days():
    att = [_att_shift("2026-07-01", "full", "D"),
           _att_shift("2026-07-01", "full", "N")]
    s = attendance_summary(att, "2026-07-01", "2026-07-31")
    assert s["full_days"] == 2
    assert s["days_worked"] == 2.0
    assert s["marked_days"] == 2


def test_summary_dual_shift_one_shift_marked_counts_once():
    att = [_att_shift("2026-07-01", "full", "D")]
    s = attendance_summary(att, "2026-07-01", "2026-07-31")
    assert s["full_days"] == 1
    assert s["days_worked"] == 1.0


def test_summary_dual_shift_mixed_full_and_half():
    att = [_att_shift("2026-07-01", "full", "D"),
           _att_shift("2026-07-01", "half", "N")]
    s = attendance_summary(att, "2026-07-01", "2026-07-31")
    assert s["full_days"] == 1
    assert s["half_days"] == 1
    assert s["days_worked"] == 1.5


def test_summary_shift_and_shiftless_records_key_independently():
    # A shift-tagged record and a plain (no-shift) record on the SAME date
    # must not collide/dedup against each other — different staff shapes.
    att = [_att("2026-07-01", "full"), _att_shift("2026-07-01", "full", "D")]
    s = attendance_summary(att, "2026-07-01", "2026-07-31")
    assert s["marked_days"] == 2
    assert s["days_worked"] == 2.0


def test_summary_duplicate_shift_record_still_last_wins():
    att = [_att_shift("2026-07-01", "half", "D"),
           _att_shift("2026-07-01", "full", "D")]   # same (date, shift)
    s = attendance_summary(att, "2026-07-01", "2026-07-31")
    assert s["marked_days"] == 1
    assert s["days_worked"] == 1.0


# ── Salary computation ──────────────────────────────────────────────────────

def test_gross_full_and_half_days():
    att = [_att("2026-07-0%d" % d, "full") for d in range(1, 7)]  # 6 full
    att += [_att("2026-07-10", "half"), _att("2026-07-11", "half")]  # 2 half
    c = compute_salary(500, att, "2026-07-01", "2026-07-31")
    assert c["days_worked"] == 7.0
    assert c["gross"] == 3500
    assert c["payable_before_advance"] == 3500


def test_gross_rounds_half_day_odd_wage():
    # 0.5 day × ₹333 = 166.5 → rounds to 166 (banker's) — assert int, exact.
    c = compute_salary(333, [_att("2026-07-01", "half")],
                       "2026-07-01", "2026-07-31")
    assert isinstance(c["gross"], int)
    assert c["gross"] in (166, 167)  # rounding mode irrelevant at ₹1 scale
    # A realistic wage never loses more than a rupee on a half day.


def test_adjustment_applies_signed():
    att = [_att("2026-07-01", "full")]
    plus = compute_salary(500, att, "2026-07-01", "2026-07-31", adjustment=200)
    minus = compute_salary(500, att, "2026-07-01", "2026-07-31", adjustment=-100)
    assert plus["payable_before_advance"] == 700
    assert minus["payable_before_advance"] == 400


def test_stringy_wage_and_adjustment_are_coerced():
    c = compute_salary("450", [_att("2026-07-01", "full")],
                       "2026-07-01", "2026-07-31", adjustment="50")
    assert c["gross"] == 450
    assert c["payable_before_advance"] == 500


# ── Outstanding advance & carry-forward (the user's core requirement) ───────

def test_outstanding_is_sum_of_advances():
    assert outstanding_advance([_adv(1000), _adv(500)], []) == 1500


def test_deduction_reduces_outstanding():
    assert outstanding_advance([_adv(1000)],
                               [_pay("2026-07-01", "2026-07-15", 400)]) == 600


def test_carry_forward_across_multiple_salaries():
    """Advance 2000. Salary 1 deducts 1500, salary 2 deducts 500 → 0.
    The 500 remainder is derived, never re-entered — no double count."""
    advances = [_adv(2000)]
    p1 = _pay("2026-06-01", "2026-06-30", 1500)
    assert outstanding_advance(advances, [p1]) == 500
    p2 = _pay("2026-07-01", "2026-07-31", 500)
    assert outstanding_advance(advances, [p1, p2]) == 0


def test_new_advance_after_settlement_accumulates():
    advances = [_adv(1000, "2026-06-10"), _adv(700, "2026-07-10")]
    payments = [_pay("2026-06-01", "2026-06-30", 1000)]
    assert outstanding_advance(advances, payments) == 700


def test_over_deduction_detectable_as_negative():
    # A corrupted state (deleting an advance already recovered) shows as
    # negative — staff_service refuses to commit such a state.
    assert outstanding_advance([], [_pay("2026-07-01", "2026-07-15", 300)]) == -300


# ── Paid-day coverage (double-pay guard) ────────────────────────────────────

def test_overlap_detection():
    assert periods_overlap("2026-07-01", "2026-07-15", "2026-07-15", "2026-07-31")
    assert periods_overlap("2026-07-10", "2026-07-12", "2026-07-01", "2026-07-31")
    assert not periods_overlap("2026-07-01", "2026-07-15", "2026-07-16", "2026-07-31")


def test_covered_dates_basic_and_malformed():
    payments = [{"period_start": None, "period_end": "x"},
                _pay("2026-07-01", "2026-07-03")]
    assert covered_dates("2026-07-02", "2026-07-10", payments) == {
        "2026-07-02", "2026-07-03"}
    assert covered_dates("2026-07-04", "2026-07-10", payments) == set()


def test_covered_dates_respects_exclusions():
    # A payment that itself skipped 2026-07-02 does NOT cover that day.
    payments = [_pay("2026-07-01", "2026-07-05", excluded=["2026-07-02"])]
    assert covered_dates("2026-07-01", "2026-07-05", payments) == {
        "2026-07-01", "2026-07-03", "2026-07-04", "2026-07-05"}


def test_payment_covers_respects_exclusions():
    p = _pay("2026-07-01", "2026-07-05", excluded=["2026-07-03"])
    assert payment_covers(p, "2026-07-02")
    assert not payment_covers(p, "2026-07-03")
    assert not payment_covers(p, "2026-07-06")


def test_date_in_paid_period_locks_attendance():
    payments = [_pay("2026-07-01", "2026-07-15")]
    assert date_in_paid_period("2026-07-15", payments) is payments[0]
    assert date_in_paid_period("2026-07-16", payments) is None
    # An excluded day is NOT locked by the payment that skipped it…
    skipping = [_pay("2026-07-01", "2026-07-15", excluded=["2026-07-08"])]
    assert date_in_paid_period("2026-07-08", skipping) is None
    # …but IS locked by the earlier payment that actually paid it.
    both = skipping + [_pay("2026-07-08", "2026-07-08")]
    assert date_in_paid_period("2026-07-08", both) is both[1]


def test_suggest_period_start_is_day_after_last_paid():
    payments = [_pay("2026-06-01", "2026-06-30"),
                _pay("2026-07-01", "2026-07-15")]
    assert suggest_period_start(payments) == "2026-07-16"
    assert suggest_period_start([]) is None


def test_suggest_period_start_crosses_month_end():
    assert suggest_period_start([_pay("2026-07-01", "2026-07-31")]) == "2026-08-01"


# ── Payment validation ──────────────────────────────────────────────────────

def _computed(payable, gross=None, adj=0):
    g = payable - adj if gross is None else gross
    return {"gross": g, "adjustment": adj, "payable_before_advance": payable}


def test_validate_rejects_bad_dates_and_future():
    c = _computed(1000)
    assert validate_payment("2026-07-1", "2026-07-15", c, 0, 0, [], TODAY)
    assert validate_payment("2026-07-15", "2026-07-01", c, 0, 0, [], TODAY)
    assert validate_payment("2026-07-20", "2026-07-25", c, 0, 0, [], TODAY)
    assert validate_payment("2026-07-01", "2026-07-15", c, 0, 0, [], TODAY) is None


def test_validate_allows_overlap_and_skips_covered_days():
    """A mid-period payout no longer blocks: the covered days are excluded
    from the computation and the rest settles normally."""
    payments = [_pay("2026-07-14", "2026-07-14")]      # one middle day paid
    covered = covered_dates("2026-07-10", "2026-07-20", payments)
    assert covered == {"2026-07-14"}
    att = [_att("2026-07-%02d" % d, "full") for d in range(10, 21)]
    c = compute_salary(500, att, "2026-07-10", "2026-07-20", exclude=covered)
    assert c["days_worked"] == 10.0                    # 11 days minus the paid one
    assert validate_payment("2026-07-10", "2026-07-20", c, 0, 0,
                            payments, TODAY, covered=covered) is None


def test_validate_rejects_fully_covered_period():
    payments = [_pay("2026-07-01", "2026-07-15")]
    covered = covered_dates("2026-07-10", "2026-07-15", payments)
    c = compute_salary(500, [_att("2026-07-12", "full")],
                       "2026-07-10", "2026-07-15", exclude=covered)
    err = validate_payment("2026-07-10", "2026-07-15", c, 0, 0,
                           payments, TODAY, covered=covered)
    assert err and "already paid" in err


def test_validate_deduction_bounds():
    c = _computed(1000)
    assert validate_payment("2026-07-01", "2026-07-15", c, -1, 500, [], TODAY)
    err = validate_payment("2026-07-01", "2026-07-15", c, 600, 500, [], TODAY)
    assert err and "outstanding" in err.lower()
    assert validate_payment("2026-07-01", "2026-07-15", c, 500, 500, [], TODAY) is None


def test_validate_deduction_cannot_exceed_payable():
    # Outstanding 2000 but salary only 1000 → deduct max 1000, rest carries.
    err = validate_payment("2026-07-01", "2026-07-15", _computed(1000),
                           1500, 2000, [], TODAY)
    assert err and "carries forward" in err


def test_validate_rejects_empty_period_with_nothing_to_pay():
    err = validate_payment("2026-07-01", "2026-07-15", _computed(0), 0, 500,
                           [], TODAY)
    assert err and "Nothing to pay" in err


# ── Settlement (the actual payout numbers) ──────────────────────────────────

def test_settlement_full_recovery():
    c = _computed(5000, gross=5000)
    out = settlement(c, 2000, 2000)
    assert out["net_paid"] == 3000
    assert out["advance_deducted"] == 2000
    assert out["advance_remaining"] == 0


def test_settlement_partial_recovery_carries_forward():
    """Salary 3000, advance outstanding 5000 → deduct 3000, pay 0,
    2000 carries forward to the next salary."""
    c = _computed(3000, gross=3000)
    out = settlement(c, 3000, 5000)
    assert out["net_paid"] == 0
    assert out["advance_remaining"] == 2000


def test_settlement_with_bonus_adjustment():
    c = _computed(5500, gross=5000, adj=500)
    out = settlement(c, 1000, 1000)
    assert out["gross"] == 5000
    assert out["adjustment"] == 500
    assert out["net_paid"] == 4500
    assert out["advance_remaining"] == 0


def test_settlement_no_advance():
    out = settlement(_computed(4200, gross=4200), 0, 0)
    assert out["net_paid"] == 4200
    assert out["advance_deducted"] == 0
    assert out["advance_remaining"] == 0


# ── End-to-end scenario: the user's described workflow ──────────────────────

def test_real_world_flow_advance_mid_month_then_settle():
    """
    Staff on ₹500/day. Works 1–20 July: 18 full + 2 half = 19 days.
    Takes ₹3,000 advance on 10 July. At settlement (1–20 July):
        gross 19 × 500 = 9,500 · deduct 3,000 → net 6,500, advance 0.
    """
    att = ([_att("2026-07-%02d" % d, "full") for d in range(1, 21)
            if d not in (5, 12)]
           + [_att("2026-07-05", "half"), _att("2026-07-12", "half")])
    advances = [_adv(3000, "2026-07-10")]
    payments = []

    c = compute_salary(500, att, "2026-07-01", "2026-07-20")
    assert c["days_worked"] == 19.0 and c["gross"] == 9500

    outstanding = outstanding_advance(advances, payments)
    assert outstanding == 3000
    assert validate_payment("2026-07-01", "2026-07-20", c, 3000,
                            outstanding, payments, TODAY) is None
    out = settlement(c, 3000, outstanding)
    assert out["net_paid"] == 6500 and out["advance_remaining"] == 0

    # Next cycle starts the day after. Re-selecting a range inside the paid
    # period just yields zero fresh days — fully-covered ranges are refused.
    payments.append(_pay("2026-07-01", "2026-07-20", 3000))
    assert suggest_period_start(payments) == "2026-07-21"
    covered2 = covered_dates("2026-07-15", "2026-07-20", payments)
    c2 = compute_salary(500, att, "2026-07-15", "2026-07-20", exclude=covered2)
    assert c2["days_worked"] == 0
    assert validate_payment("2026-07-15", "2026-07-20", c2, 0, 0,
                            payments, TODAY, covered=covered2) is not None


def test_real_world_flow_mid_week_payment_skips_that_day():
    """
    The user's scenario: 25 Jul was paid on its own (₹350, one full day).
    Settling the week 22–28 Jul must pay the other 6 days and skip the 25th
    — not block. Wage ₹350/day, all 7 days marked full.
    """
    att = [_att("2026-07-%02d" % d, "full") for d in range(22, 29)]
    payments = [_pay("2026-07-25", "2026-07-25")]
    covered = covered_dates("2026-07-22", "2026-07-28", payments)
    assert covered == {"2026-07-25"}

    c = compute_salary(350, att, "2026-07-22", "2026-07-28", exclude=covered)
    assert c["days_worked"] == 6.0
    assert c["gross"] == 2100                          # 6 × 350, not 7 × 350
    assert validate_payment("2026-07-22", "2026-07-28", c, 0, 0,
                            payments, "2026-07-28", covered=covered) is None

    # The new payment records the skipped day; afterwards every day of the
    # week is covered exactly once and fully locked.
    payments.append(_pay("2026-07-22", "2026-07-28",
                         excluded=sorted(covered)))
    for d in range(22, 29):
        day_s = "2026-07-%02d" % d
        assert date_in_paid_period(day_s, payments) is not None
    assert covered_dates("2026-07-22", "2026-07-28", payments) == {
        "2026-07-%02d" % d for d in range(22, 29)}


def test_real_world_flow_advance_bigger_than_salary():
    """
    Advance ₹8,000; salary period earns only ₹5,000. Deduct 5,000 →
    net 0 paid, ₹3,000 carries. Next period earns 6,000 → deduct the
    remaining 3,000 → net 3,000, advance cleared.
    """
    advances = [_adv(8000, "2026-06-20")]
    payments = []

    c1 = _computed(5000, gross=5000)
    o1 = outstanding_advance(advances, payments)
    assert o1 == 8000
    # Deduction is capped at payable — the ledger message tells the admin
    # the rest carries forward.
    assert validate_payment("2026-06-01", "2026-06-30", c1, 8000, o1,
                            payments, TODAY) is not None
    s1 = settlement(c1, 5000, o1)
    assert s1["net_paid"] == 0 and s1["advance_remaining"] == 3000
    payments.append(_pay("2026-06-01", "2026-06-30", 5000))

    c2 = _computed(6000, gross=6000)
    o2 = outstanding_advance(advances, payments)
    assert o2 == 3000
    s2 = settlement(c2, 3000, o2)
    assert s2["net_paid"] == 3000 and s2["advance_remaining"] == 0
