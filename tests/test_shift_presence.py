"""
Attendance for staff who work day shifts, night shifts, or both.

The real roster (Sept 2026): some staff have a Day row and a Night row and
rotate, two weeks of days then two weeks of nights, working ONE shift a day.
On some days they cover both. Others work a single shift, full stop.

Counting SHIFTS answered "did they turn up" wrongly in both directions: a
rotating member read 50% of a two-shift month while never missing a day, and
anyone covering both shifts read over 100% and won "best attendance" by
arithmetic. So attendance counts DAYS and the second shift is reported as
cover. Wages still follow shifts, because a double shift is paid twice.

Run: python3 tests/test_shift_presence.py
"""
from __future__ import annotations

import os
import sys
import types
import unittest

if "firebase_admin" not in sys.modules:
    _fa = types.ModuleType("firebase_admin")
    for _sub in ("credentials", "firestore", "storage"):
        setattr(_fa, _sub, types.ModuleType(f"firebase_admin.{_sub}"))
        sys.modules[f"firebase_admin.{_sub}"] = getattr(_fa, _sub)
    _fa.firestore.SERVER_TIMESTAMP = None
    _fa.firestore.ArrayUnion = lambda v: v
    sys.modules["firebase_admin"] = _fa

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.staff_ledger import (  # noqa: E402
    attendance_summary, period_breakdown, presence_summary,
)

START, END = "2026-09-01", "2026-09-14"


def rec(day, status, shift=None):
    r = {"staff_id": "s1", "date": "2026-09-%02d" % day, "status": status}
    if shift:
        r["shift"] = shift
    return r


class TestSingleShiftStaff(unittest.TestCase):
    def test_every_day_present_is_full_attendance(self):
        rows = [rec(d, "full") for d in range(1, 15)]
        p = presence_summary(rows, START, END)
        self.assertEqual(p["days_present"], 14)
        self.assertEqual(p["shifts_worked"], 14)
        self.assertEqual(p["days_absent"], 0)
        self.assertEqual(p["double_shift_days"], 0)

    def test_a_half_day_is_a_whole_day_present(self):
        """Presence is "did he turn up", so a half day is a day he turned up.

        It used to credit 0.5 here while the salary census counted the same
        day as 1, so the same fortnight read 1.5 days present in Insights and
        2 on the salary screen. How much he worked is shifts_worked, which
        still values the half at 0.5.
        """
        rows = [rec(1, "half"), rec(2, "full"), rec(3, "absent")]
        p = presence_summary(rows, START, END)
        self.assertEqual(p["days_present"], 2)
        self.assertEqual(p["half_days_present"], 1)
        self.assertEqual(p["days_absent"], 1)
        self.assertEqual(p["shifts_worked"], 1.5)

    def test_a_half_day_on_top_of_a_full_shift_is_still_one_day(self):
        rows = [rec(1, "full", "D"), rec(1, "half", "N")]
        p = presence_summary(rows, START, END)
        self.assertEqual(p["days_present"], 1)
        self.assertEqual(p["half_days_present"], 0)
        self.assertEqual(p["double_shift_days"], 1)
        self.assertEqual(p["shifts_worked"], 1.5)
        self.assertEqual(p["extra_shifts"], 0.5)

    def test_unmarked_days_are_not_absences(self):
        # Nobody marked days 2 to 14. That is a gap in the register, not 13
        # days of absence, and it must not become one.
        p = presence_summary([rec(1, "full")], START, END)
        self.assertEqual(p["days_absent"], 0)
        self.assertEqual(p["days_marked"], 1)


class TestRotatingDayNightStaff(unittest.TestCase):
    """Two weeks of nights: one shift a day, the other shift marked absent."""

    ROWS = []
    for d in range(1, 15):
        ROWS.append(rec(d, "absent", "D"))
        ROWS.append(rec(d, "full", "N"))

    def test_one_shift_a_day_is_full_attendance(self):
        p = presence_summary(self.ROWS, START, END)
        self.assertEqual(p["days_present"], 14)     # not 7, and not 28
        self.assertEqual(p["days_absent"], 0)
        self.assertEqual(p["shifts_worked"], 14)
        self.assertEqual(p["extra_shifts"], 0)

    def test_shifts_still_count_for_wages(self):
        # attendance_summary is what wages read, and it is unchanged.
        self.assertEqual(attendance_summary(self.ROWS, START, END)["days_worked"], 14)

    def test_the_unworked_shift_is_not_an_absence(self):
        # 14 "absent" D records, zero absent days.
        self.assertEqual(attendance_summary(self.ROWS, START, END)["absent_days"], 14)
        self.assertEqual(presence_summary(self.ROWS, START, END)["days_absent"], 0)


class TestCoveringBothShifts(unittest.TestCase):
    def test_both_shifts_is_one_day_present_and_one_double(self):
        rows = [rec(1, "full", "D"), rec(1, "full", "N")]
        p = presence_summary(rows, START, END)
        self.assertEqual(p["days_present"], 1)      # not 2
        self.assertEqual(p["shifts_worked"], 2)     # paid for two
        self.assertEqual(p["double_shift_days"], 1)
        self.assertEqual(p["extra_shifts"], 1)

    def test_a_real_fortnight_adds_up(self):
        # Days 1-10 nights only, 11-12 both shifts, 13 off, 14 day only.
        rows = []
        for d in range(1, 11):
            rows += [rec(d, "absent", "D"), rec(d, "full", "N")]
        for d in (11, 12):
            rows += [rec(d, "full", "D"), rec(d, "full", "N")]
        rows += [rec(13, "absent", "D"), rec(13, "absent", "N")]
        rows += [rec(14, "full", "D"), rec(14, "absent", "N")]
        p = presence_summary(rows, START, END)
        self.assertEqual(p["days_present"], 13)     # 13 of 14 days
        self.assertEqual(p["days_absent"], 1)
        self.assertEqual(p["shifts_worked"], 15)    # 13 + 2 cover
        self.assertEqual(p["double_shift_days"], 2)
        self.assertEqual(p["extra_shifts"], 2)
        # Wages follow shifts.
        self.assertEqual(attendance_summary(rows, START, END)["days_worked"], 15)

    def test_a_half_second_shift_still_caps_the_day_at_one(self):
        rows = [rec(1, "full", "D"), rec(1, "half", "N")]
        p = presence_summary(rows, START, END)
        self.assertEqual(p["days_present"], 1)
        self.assertEqual(p["shifts_worked"], 1.5)
        self.assertEqual(p["double_shift_days"], 1)


class TestBounds(unittest.TestCase):
    def test_records_outside_the_period_are_ignored(self):
        rows = [rec(1, "full"), {"date": "2026-08-31", "status": "full"},
                {"date": "2026-09-20", "status": "full"}]
        self.assertEqual(presence_summary(rows, START, END)["days_present"], 1)

    def test_junk_records_are_ignored(self):
        rows = [rec(1, "full"), {"date": "oops", "status": "full"},
                {"date": "2026-09-02", "status": "sick"}, None, "junk"]
        p = presence_summary(rows, START, END)
        self.assertEqual((p["days_present"], p["days_marked"]), (1, 1))

    def test_empty(self):
        p = presence_summary([], START, END)
        self.assertEqual(p, {"days_present": 0, "days_absent": 0, "days_marked": 0,
                             "half_days_present": 0, "shifts_worked": 0,
                             "double_shift_days": 0, "extra_shifts": 0})


class TestInsightsAgreesWithTheSalaryScreen(unittest.TestCase):
    """The same days, counted by both screens, must give the same number.

    Insights reads presence_summary(); the salary ledger caption reads
    period_breakdown(). They were built for different screens and disagreed
    about one thing: a half day. Insights credited 0.5 of a day, the census
    counted a whole one, and a fortnight with two half days showed 11 days
    present in one place and 12 in the other. Whichever a manager looked at
    first was the one they thought was broken.

    Presence is a calendar-day question on both screens now. This pins that:
    it fails the moment either side starts weighting a status again.
    """

    ROSTERS = {
        "single shift, some halves": [
            rec(1, "full"), rec(2, "half"), rec(3, "full"), rec(4, "absent"),
            rec(5, "half"), rec(6, "full"),
        ],
        "rotating day/night": [
            rec(d, "full", "N") for d in range(1, 8)
        ] + [rec(d, "absent", "D") for d in range(1, 8)],
        "covering both shifts": [
            rec(1, "full", "D"), rec(1, "full", "N"),
            rec(2, "full", "D"), rec(2, "half", "N"),
            rec(3, "half", "D"), rec(3, "half", "N"),
            rec(4, "absent", "D"), rec(4, "absent", "N"),
        ],
        "nothing marked": [],
        "every kind of gap": [
            rec(2, "half"), rec(5, "absent"), rec(9, "full"), rec(13, "half"),
        ],
    }

    def test_days_present_matches_the_census(self):
        for label, rows in self.ROSTERS.items():
            with self.subTest(roster=label):
                self.assertEqual(
                    presence_summary(rows, START, END)["days_present"],
                    period_breakdown(rows, START, END)["present"])

    def test_absences_match_the_census(self):
        for label, rows in self.ROSTERS.items():
            with self.subTest(roster=label):
                self.assertEqual(
                    presence_summary(rows, START, END)["days_absent"],
                    period_breakdown(rows, START, END)["absent"])

    def test_the_census_still_partitions_the_period(self):
        for label, rows in self.ROSTERS.items():
            with self.subTest(roster=label):
                b = period_breakdown(rows, START, END)
                self.assertEqual(
                    b["present"] + b["absent"] + b["carried"] + b["unmarked"],
                    b["days"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
