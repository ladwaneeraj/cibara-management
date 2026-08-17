"""
Unit tests for services/staff_ledger.py.

The module is pure (datetime + typing only, no Firestore), so it can be tested
directly without any app or network setup.

Focus: the payout-coverage invariants. A salary payment records the period it
settled, and covered_dates() then treats every day in that period as paid, so
whatever a payout claims to cover is permanently consumed. The rules that keep
that honest are:

  * a day already paid by an earlier payment is skipped, not re-paid;
  * a day with NO attendance marked is skipped, stays unlocked, and remains
    payable once somebody marks it.

RUN:  pytest tests/test_staff_ledger.py -q
"""

from __future__ import annotations

import pytest

from services import staff_ledger as ledger


# ── helpers ────────────────────────────────────────────────────────────────

def att(date, status="full", shift=None):
    """One attendance record."""
    rec = {"date": date, "status": status}
    if shift:
        rec["shift"] = shift
    return rec


def pay(start, end, excluded=None):
    """One salary payment doc, as pay_salary() writes it."""
    return {"period_start": start, "period_end": end,
            "excluded_dates": excluded or []}


WEEK = ("2026-08-01", "2026-08-07")


# ═══════════════════════════════════════════════════════════════════════════
# marked_dates
# ═══════════════════════════════════════════════════════════════════════════

def test_marked_dates_counts_absent_as_marked():
    # "Absent" is a decision about the day, not a missing record. It must NOT
    # be treated as unmarked, or marking someone absent would leave the day
    # open forever.
    got = ledger.marked_dates([att("2026-08-03", "absent")], *WEEK)
    assert got == {"2026-08-03"}


@pytest.mark.parametrize("status", ["full", "half", "absent"])
def test_marked_dates_accepts_every_valid_status(status):
    assert ledger.marked_dates([att("2026-08-03", status)], *WEEK) == {"2026-08-03"}


def test_marked_dates_ignores_unknown_status_and_bad_dates():
    recs = [att("2026-08-02", "holiday"), att("not-a-date"), att("", "full"),
            {"status": "full"}, None]
    assert ledger.marked_dates(recs, *WEEK) == set()


def test_marked_dates_clips_to_the_range():
    recs = [att("2026-07-31"), att("2026-08-01"), att("2026-08-08")]
    assert ledger.marked_dates(recs, *WEEK) == {"2026-08-01"}


def test_marked_dates_collapses_dual_shift_records_to_one_date():
    recs = [att("2026-08-04", "full", "D"), att("2026-08-04", "full", "N")]
    assert ledger.marked_dates(recs, *WEEK) == {"2026-08-04"}


def test_marked_dates_agrees_with_attendance_summary():
    # The two share a predicate by contract. If they drift, a day can be paid
    # for by one and skipped by the other. Any day the summary counted must be
    # marked, and therefore never unmarked.
    recs = [att("2026-08-01", "full"), att("2026-08-02", "half"),
            att("2026-08-03", "absent"), att("2026-08-04", "bogus"),
            att("bad-date", "full")]
    summary = ledger.attendance_summary(recs, *WEEK)
    marked = ledger.marked_dates(recs, *WEEK)
    assert summary["marked_days"] == len(marked) == 3
    assert not (marked & ledger.unmarked_dates(*WEEK, recs))


# ═══════════════════════════════════════════════════════════════════════════
# unmarked_dates — the fix
# ═══════════════════════════════════════════════════════════════════════════

def test_unmarked_dates_finds_the_gap_in_a_week():
    recs = [att(d) for d in ("2026-08-01", "2026-08-02", "2026-08-03",
                             "2026-08-04", "2026-08-06", "2026-08-07")]
    assert ledger.unmarked_dates(*WEEK, recs) == {"2026-08-05"}


def test_unmarked_dates_is_every_day_when_nothing_is_marked():
    assert len(ledger.unmarked_dates(*WEEK, [])) == 7


def test_unmarked_dates_is_empty_when_the_week_is_complete():
    recs = [att("2026-08-0%d" % n) for n in range(1, 8)]
    assert ledger.unmarked_dates(*WEEK, recs) == set()


def test_unmarked_dates_excludes_already_covered_days():
    # The two groups stay disjoint so each can be reported in its own words.
    covered = {"2026-08-01", "2026-08-02"}
    got = ledger.unmarked_dates(*WEEK, [att("2026-08-03")], exclude=covered)
    assert got == {"2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07"}
    assert not (got & covered)


def test_unmarked_dates_rejects_a_bad_range():
    assert ledger.unmarked_dates("2026-08-07", "2026-08-01", []) == set()
    assert ledger.unmarked_dates("nope", "2026-08-07", []) == set()


def test_unmarked_dates_handles_a_single_day_period():
    assert ledger.unmarked_dates("2026-08-05", "2026-08-05", []) == {"2026-08-05"}
    assert ledger.unmarked_dates(
        "2026-08-05", "2026-08-05", [att("2026-08-05", "absent")]) == set()


# ═══════════════════════════════════════════════════════════════════════════
# The regression this all exists to prevent
# ═══════════════════════════════════════════════════════════════════════════

def test_unmarked_day_is_not_locked_by_the_payment_that_skipped_it():
    # BEFORE the fix: paying 1-7 Aug with 5 Aug unmarked wrote
    # excluded_dates=[] and the payment claimed to cover 5 Aug. Attendance on
    # it was locked and a later payout skipped it as already paid, so the day
    # was worth ₹0 forever.
    recs = [att(d) for d in ("2026-08-01", "2026-08-02", "2026-08-03",
                             "2026-08-04", "2026-08-06", "2026-08-07")]
    unmarked = ledger.unmarked_dates(*WEEK, recs)
    payment = pay(*WEEK, excluded=sorted(unmarked))

    assert ledger.payment_covers(payment, "2026-08-04") is True
    assert ledger.payment_covers(payment, "2026-08-05") is False
    assert ledger.date_in_paid_period("2026-08-05", [payment]) is None
    assert "2026-08-05" not in ledger.covered_dates(*WEEK, [payment])


def test_the_skipped_day_is_payable_once_attendance_is_marked():
    # Continue the story: 5 Aug gets marked the next day, and a second payout
    # over the same week pays for exactly that one day and nothing else.
    first = pay(*WEEK, excluded=["2026-08-05"])
    recs = [att(d) for d in ("2026-08-01", "2026-08-02", "2026-08-03",
                             "2026-08-04", "2026-08-05", "2026-08-06",
                             "2026-08-07")]

    covered = ledger.covered_dates(*WEEK, [first])
    assert "2026-08-05" not in covered

    unmarked = ledger.unmarked_dates(*WEEK, recs, exclude=covered)
    assert unmarked == set()          # nothing missing any more

    computed = ledger.compute_salary(500, recs, *WEEK, exclude=covered | unmarked)
    assert computed["days_worked"] == 1
    assert computed["gross"] == 500   # exactly the one recovered day


def test_a_payout_over_an_entirely_unmarked_week_consumes_nothing():
    unmarked = ledger.unmarked_dates(*WEEK, [])
    payment = pay(*WEEK, excluded=sorted(unmarked))
    assert ledger.covered_dates(*WEEK, [payment]) == set()
    for day in ledger._dates_between(*WEEK):
        assert ledger.date_in_paid_period(day, [payment]) is None


def test_wages_are_unchanged_by_the_fix():
    # Excluding unmarked days must not move any number: they had no
    # attendance record, so they contributed nothing either way. The fix is
    # about what the payment CLAIMS to cover, not about the arithmetic.
    recs = [att("2026-08-01", "full"), att("2026-08-02", "half"),
            att("2026-08-03", "absent")]
    before = ledger.compute_salary(400, recs, *WEEK, exclude=set())
    unmarked = ledger.unmarked_dates(*WEEK, recs)
    after = ledger.compute_salary(400, recs, *WEEK, exclude=unmarked)
    assert before == after
    assert after["days_worked"] == 1.5
    assert after["gross"] == 600


def test_meals_are_unchanged_by_the_fix():
    recs = [att("2026-08-01", "full"), att("2026-08-02", "half"),
            att("2026-08-03", "absent")]
    unmarked = ledger.unmarked_dates(*WEEK, recs)
    before = ledger.compute_meals(50, recs, *WEEK, exclude=set())
    after = ledger.compute_meals(50, recs, *WEEK, exclude=unmarked)
    assert before == after
    assert after["meal_days"] == 2      # full + half eat; absent does not


def test_an_all_unmarked_period_still_fails_validation_with_no_adjustment():
    # The operator gets a clear refusal rather than a ₹0 payout record.
    computed = ledger.compute_salary(500, [], *WEEK)
    err = ledger.validate_payment(*WEEK, computed, 0, 0, [], "2026-08-10",
                                  covered=set(), meal_deduction=0)
    assert err is not None
    assert "no attendance marked" in err
