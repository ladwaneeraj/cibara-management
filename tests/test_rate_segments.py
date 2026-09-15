"""
Unit tests for services.rate_segments: where a mid-stay price change starts.

WHAT THIS PROTECTS
------------------
An admin can change the nightly price of an active stay "from today" or
"from tomorrow". The balance is charged night by night as the stay goes on,
and the checkout folio is rebuilt from guest.pre_transfer_charges,
guest.transfer_day_offset and guest.price. If those three drift from what the
balance was actually charged, the guest is billed a different amount than the
desk has been collecting, and nothing on screen says so until someone
reconciles the bill by hand.

So besides pinning each rule, these tests replay whole stays (check-in,
renewals, room shifts, rate-raising add-ons, price changes) the way the routes
accrue rent, and require the folio to bill every night at exactly the rate
the balance charged for it.

tests/rate_change_cases.json is shared with tests/test_state_ports.js, which
runs the same cases against the JavaScript twin in static/script.js.

Run: python -m pytest tests/test_rate_segments.py
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services import rate_segments  # noqa: E402
from services.rate_segments import RateChangeError  # noqa: E402

_CASES_PATH = os.path.join(os.path.dirname(__file__), "rate_change_cases.json")
with open(_CASES_PATH, encoding="utf-8") as _f:
    CASES = json.load(_f)


def _stamp(s):
    return datetime.strptime(s, "%Y-%m-%d %H:%M")


class TestSharedCases(unittest.TestCase):
    """The cases the JavaScript twin must also pass."""

    def test_current_night(self):
        for case in CASES["current_night"]:
            with self.subTest(case["name"]):
                got = rate_segments.current_night(case["checkin_time"], _stamp(case["now"]))
                self.assertEqual(got, case["expected"])

    def test_plan(self):
        for case in CASES["plan"]:
            with self.subTest(case["name"]):
                args = (case["room"], case["guest"], case["renewal_count"],
                        case["new_price"], case["effective"], case["night"])
                if "error" in case:
                    with self.assertRaises(RateChangeError) as ctx:
                        rate_segments.plan_rate_change(*args)
                    self.assertEqual(str(ctx.exception), case["error"])
                else:
                    self.assertEqual(rate_segments.plan_rate_change(*args), case["expected"])

    def test_every_case_is_well_formed(self):
        """A typo in the shared file would silently skip an assertion."""
        for case in CASES["plan"]:
            with self.subTest(case["name"]):
                self.assertEqual(("error" in case) + ("expected" in case), 1)
                self.assertIn(case["effective"], rate_segments.EFFECTIVE_CHOICES)


class TestPlanRateChange(unittest.TestCase):
    def test_input_guest_is_not_modified(self):
        """The route writes the plan's segments; the snapshot it read from
        must not change underneath it (a retried transaction re-plans)."""
        seg = {"days": 2, "price": 400, "total": 800, "from_room": "213",
               "kind": "rate_change"}
        guest = {"price": 600, "transfer_day_offset": 2, "pre_transfer_charges": [seg]}
        rate_segments.plan_rate_change("213", guest, 1, 650, "today", 2)
        self.assertEqual(guest["pre_transfer_charges"],
                         [{"days": 2, "price": 400, "total": 800,
                           "from_room": "213", "kind": "rate_change"}])
        self.assertEqual(guest["transfer_day_offset"], 2)

    def test_room_number_type_does_not_matter(self):
        """Room ids reach the routes as strings or numbers."""
        guest = {"price": 600, "transfer_day_offset": 2,
                 "pre_transfer_charges": [{"days": 2, "price": 400, "total": 800,
                                           "from_room": "213", "kind": "rate_change"}]}
        plan = rate_segments.plan_rate_change(213, guest, 1, 600, "today", 2)
        self.assertEqual(plan["balance_delta"], 200)

    def test_unknown_effective_is_a_programming_error(self):
        with self.assertRaises(ValueError) as ctx:
            rate_segments.plan_rate_change("213", {"price": 400}, 1, 600, "whole_stay", 2)
        self.assertNotIsInstance(ctx.exception, RateChangeError)


class TestFreezeCurrentRate(unittest.TestCase):
    """The /add_on "apply to all nights" bump: every charged night keeps the
    old rate and the raised price bills from the next renewal."""

    def test_folds_every_charged_night(self):
        guest = {"price": 400}
        got = rate_segments.freeze_current_rate(guest, "213", 3, 600)
        self.assertEqual(got, {
            "price": 600,
            "pre_transfer_charges": [{"days": 3, "price": 400, "total": 1200,
                                      "from_room": "213"}],
            "transfer_day_offset": 3,
            "last_transfer_date": None,
            "transfer_day_prebilled": None,
        })

    def test_appends_after_a_room_shift_and_clears_its_date(self):
        guest = {"price": 500, "transfer_day_offset": 1,
                 "last_transfer_date": "2026-09-02",
                 "transfer_day_prebilled": "2026-09-02",
                 "pre_transfer_charges": [{"days": 1, "price": 800, "total": 800,
                                           "from_room": "101"}]}
        got = rate_segments.freeze_current_rate(guest, "213", 3, 700)
        self.assertEqual(got["pre_transfer_charges"], [
            {"days": 1, "price": 800, "total": 800, "from_room": "101"},
            {"days": 2, "price": 500, "total": 1000, "from_room": "213"},
        ])
        self.assertEqual(got["transfer_day_offset"], 3)
        self.assertIsNone(got["last_transfer_date"])
        self.assertIsNone(got["transfer_day_prebilled"])
        # The caller's snapshot is untouched.
        self.assertEqual(len(guest["pre_transfer_charges"]), 1)

    def test_nothing_new_to_freeze_writes_no_segment(self):
        guest = {"price": 600, "transfer_day_offset": 2,
                 "pre_transfer_charges": [{"days": 2, "price": 400, "total": 800,
                                           "from_room": "213"}]}
        got = rate_segments.freeze_current_rate(guest, "213", 2, 800)
        self.assertEqual(len(got["pre_transfer_charges"]), 1)
        self.assertEqual(got["transfer_day_offset"], 2)
        self.assertEqual(got["price"], 800)

    def test_offset_never_moves_backwards(self):
        """Segments ahead of the nights charged (a shift made while renewals
        were pending) keep their nights; lowering the offset under them would
        bill those nights twice."""
        guest = {"price": 500, "transfer_day_offset": 3,
                 "pre_transfer_charges": [{"days": 3, "price": 800, "total": 2400,
                                           "from_room": "101"}]}
        got = rate_segments.freeze_current_rate(guest, "213", 2, 700)
        self.assertEqual(got["transfer_day_offset"], 3)
        self.assertEqual(len(got["pre_transfer_charges"]), 1)

    def test_kind_is_stamped_only_when_given(self):
        got = rate_segments.freeze_current_rate({"price": 400}, "213", 1, 600,
                                                kind="rate_change")
        self.assertEqual(got["pre_transfer_charges"][0]["kind"], "rate_change")


# ── Whole-stay ledger ──────────────────────────────────────────────────────

class Stay:
    """One stay's rent, accrued the way the routes accrue it.

    `charged` is the rate each night was charged at onto the balance, kept
    independently of the segments so the folio can be checked against it
    night by night rather than only in total.
    """

    def __init__(self, room, price):
        self.room = room
        self.renewal_count = 0
        self.guest = {"price": price}
        self.balance = price              # night 1 is charged at check-in
        self.charged = [price]

    @property
    def accrued(self):
        return self.renewal_count + 1

    def renew(self):
        """/renew_rent: one more night at the current guest.price."""
        self.renewal_count += 1
        self.balance += self.guest["price"]
        self.charged.append(self.guest["price"])

    def change_price(self, new_price, effective, night):
        """/edit_room_price, applied from its plan."""
        plan = rate_segments.plan_rate_change(
            self.room, self.guest, self.renewal_count, new_price, effective, night)
        before = sum(self.charged)
        for i in range(plan["boundary"], self.accrued):
            self.charged[i] = new_price
        # The plan's delta must be exactly the re-pricing of those nights.
        assert sum(self.charged) - before == plan["balance_delta"], plan
        self.balance += plan["balance_delta"]
        self.guest.update(rate_segments.guest_fields(
            new_price, plan["segments"], plan["offset"]))
        return plan

    def raise_rate(self, surcharge):
        """/add_on with apply_to_all_nights (e.g. an AC upgrade). The add-on
        line itself carries today's uplift as a service on both the balance
        and the bill, so only the rent side is modelled here."""
        self.guest.update(rate_segments.freeze_current_rate(
            self.guest, self.room, self.accrued, self.guest["price"] + surcharge))

    def shift(self, new_room, new_price, completed_cycles, on_date,
              apply_today_diff=True):
        """Cross-category /transfer_room, reduced to its rent arithmetic."""
        old_price = self.guest["price"]
        offset = self.guest.get("transfer_day_offset", 0)
        old_days = rate_segments.shift_segment_days(
            self.renewal_count, offset, completed_cycles)
        if not apply_today_diff:
            fold = max(0, self.accrued - offset)
            if fold > old_days:
                old_days = fold
        segments = list(self.guest.get("pre_transfer_charges") or [])
        if old_days > 0:
            segments.append({"days": old_days, "price": old_price,
                             "total": old_price * old_days, "from_room": self.room})
        self.guest["pre_transfer_charges"] = segments
        self.guest["transfer_day_offset"] = offset + old_days
        # Provenance only. The folio counted days from this date until the
        # rate-change + shift double-bill; it does not any more, and this
        # harness leaves it set so a return of that branch fails here.
        self.guest["last_transfer_date"] = on_date
        self.guest["price"] = new_price
        # Shift-day re-rate of nights charged at the old rate but billed new.
        for i in range(offset + old_days, self.accrued):
            self.balance += new_price - self.charged[i]
            self.charged[i] = new_price
        self.room = new_room

    def folio_nights(self):
        """Rent per night as create_bill_record and compute_daily_folio bill
        it: the frozen segments, then whatever is left at the current price.

        create_bill_record calls the same helper, so a stay that shifted room
        and a stay that never moved go down one path here as they do there.
        """
        segments = self.guest.get("pre_transfer_charges") or []
        offset = self.guest.get("transfer_day_offset", 0)
        current = rate_segments.nights_at_current_price(
            self.renewal_count, offset)
        total = sum(s["total"] for s in segments) + self.guest["price"] * current
        nights = []
        for s in segments:
            nights += [s["price"]] * s["days"]
        nights += [self.guest["price"]] * current
        assert total == sum(nights), "a segment's total disagrees with its nights"
        return nights

    def assert_reconciles(self, test):
        test.assertEqual(self.folio_nights(), self.charged)
        test.assertEqual(sum(self.charged), self.balance)


class TestLedgerReconciles(unittest.TestCase):
    def test_from_tomorrow(self):
        s = Stay("213", 400)
        s.renew()                                   # night 2
        plan = s.change_price(600, "tomorrow", night=2)
        self.assertEqual(plan["balance_delta"], 0)
        s.renew()
        s.renew()
        self.assertEqual(s.charged, [400, 400, 600, 600])
        s.assert_reconciles(self)

    def test_from_today(self):
        s = Stay("213", 400)
        s.renew()
        s.change_price(600, "today", night=2)
        s.renew()
        self.assertEqual(s.charged, [400, 600, 600])
        s.assert_reconciles(self)

    def test_from_today_before_tonights_renewal(self):
        """The renewal still pending charges the new price itself."""
        s = Stay("213", 400)
        plan = s.change_price(600, "today", night=2)
        self.assertEqual(plan["balance_delta"], 0)
        s.renew()
        self.assertEqual(s.charged, [400, 600])
        s.assert_reconciles(self)

    def test_tomorrow_then_today(self):
        s = Stay("213", 400)
        s.renew()
        s.change_price(600, "tomorrow", night=2)
        s.change_price(600, "today", night=2)
        s.renew()
        self.assertEqual(s.charged, [400, 600, 600])
        s.assert_reconciles(self)

    def test_two_changes_on_different_days(self):
        s = Stay("213", 400)
        s.renew()
        s.change_price(500, "tomorrow", night=2)
        s.renew()
        s.renew()                                   # night 4
        s.change_price(650, "today", night=4)
        s.renew()
        self.assertEqual(s.charged, [400, 400, 500, 650, 650])
        s.assert_reconciles(self)

    def test_price_cut(self):
        s = Stay("213", 900)
        s.renew()
        s.renew()
        s.change_price(700, "today", night=3)
        s.renew()
        self.assertEqual(s.charged, [900, 900, 700, 700])
        s.assert_reconciles(self)

    def test_after_a_room_shift(self):
        s = Stay("101", 800)
        s.renew()                                   # night 2
        s.shift("213", 500, completed_cycles=1, on_date="2026-09-02")
        s.renew()                                   # night 3
        s.change_price(600, "tomorrow", night=3)
        s.renew()
        self.assertEqual(s.charged, [800, 500, 500, 600])
        s.assert_reconciles(self)

    def test_after_a_room_shift_that_kept_tonight_at_the_old_rate(self):
        s = Stay("101", 800)
        s.renew()
        s.shift("213", 500, completed_cycles=1, on_date="2026-09-02",
                apply_today_diff=False)
        with self.assertRaises(RateChangeError):
            s.change_price(600, "today", night=2)
        s.change_price(600, "tomorrow", night=2)
        s.renew()
        self.assertEqual(s.charged, [800, 800, 600])
        s.assert_reconciles(self)

    def test_after_an_add_on_raised_the_rate(self):
        s = Stay("213", 400)
        s.renew()
        s.raise_rate(200)                           # nights 1-2 stay at 400
        s.renew()
        s.change_price(650, "today", night=3)
        s.renew()
        self.assertEqual(s.charged, [400, 400, 650, 650])
        s.assert_reconciles(self)

    def test_add_on_raise_after_a_room_shift(self):
        """Shift on day 2, rate-raising add-on on day 3, checkout on day 4.

        The add-on used to leave last_transfer_date behind, so checkout
        counted the new room's nights by calendar date since the shift (two
        nights) on top of the segment that had just frozen them: 1,400 of
        rent billed that was never charged. Clearing the date makes checkout
        count from the renewals, which matches the balance.
        """
        s = Stay("101", 800)
        s.renew()                                   # 2026-09-02, night 2
        s.shift("213", 500, completed_cycles=1, on_date="2026-09-02")
        s.renew()                                   # 2026-09-03, night 3
        transfer_date = s.guest["last_transfer_date"]
        s.raise_rate(200)
        s.assert_reconciles(self)                   # checkout 2026-09-04
        self.assertEqual(s.balance, 1800)

        # What the calendar branch in create_bill_record would have billed
        # had the shift date survived.
        calendar_nights = (datetime(2026, 9, 4) - datetime.strptime(transfer_date, "%Y-%m-%d")).days
        old_bill = (sum(x["total"] for x in s.guest["pre_transfer_charges"])
                    + s.guest["price"] * calendar_nights)
        self.assertEqual(old_bill - s.balance, 1400)


class TestShiftAfterAPriceChange(unittest.TestCase):
    """A room shift on a stay whose price was already changed.

    /transfer_room writes guest.last_transfer_date, and create_bill_record
    used to switch on that field: nights in the current room became a count
    of calendar days since the shift, minimum one. The count knew about the
    shift and nothing else, so the night a "from tomorrow" price change had
    just frozen into a rate-change segment was billed twice — once inside the
    segment, once as the shift day's minimum.

    The folio now counts nights_at_current_price() for every stay, so these
    replay the desk's sequence and require the bill to equal what the balance
    was charged.
    """

    def test_from_tomorrow_then_a_shift_the_same_day(self):
        # Room 225, three nights charged at 900, price moved to 1,200 from
        # tomorrow, guest shifted to 226 an hour later, checks out that night.
        s = Stay("225", 900)
        s.renew()
        s.renew()                                   # night 3, 2,700 charged
        plan = s.change_price(1200, "tomorrow", night=3)
        self.assertEqual(plan["balance_delta"], 0)
        self.assertEqual(plan["offset"], 3)
        s.shift("226", 1200, completed_cycles=2, on_date="2026-09-12")
        self.assertEqual(s.guest["transfer_day_offset"], 3)
        self.assertEqual(s.charged, [900, 900, 900])
        s.assert_reconciles(self)

        # What the calendar branch billed for the same checkout: one night in
        # 226 on top of the three already frozen.
        old_bill = (sum(x["total"] for x in s.guest["pre_transfer_charges"])
                    + s.guest["price"] * 1)
        self.assertEqual(old_bill - s.balance, 1200)

    def test_from_tomorrow_then_a_shift_then_the_night_starts(self):
        s = Stay("225", 900)
        s.renew()
        s.renew()
        s.change_price(1200, "tomorrow", night=3)
        s.shift("226", 1200, completed_cycles=2, on_date="2026-09-12")
        s.renew()                                   # the new price's first night
        self.assertEqual(s.charged, [900, 900, 900, 1200])
        s.assert_reconciles(self)

    def test_from_today_then_a_shift_the_same_day(self):
        s = Stay("225", 900)
        s.renew()
        s.renew()
        plan = s.change_price(1200, "today", night=3)
        self.assertEqual(plan["offset"], 2)
        s.shift("226", 1200, completed_cycles=2, on_date="2026-09-12")
        # Tonight was re-priced, not frozen: the shift adds no segment.
        self.assertEqual(s.guest["transfer_day_offset"], 2)
        self.assertEqual(s.charged, [900, 900, 1200])
        s.assert_reconciles(self)

    def test_a_shift_never_freezes_more_nights_than_were_charged(self):
        """Renewals behind the clock: three cycles elapsed, one night paid.

        shift_segment_days caps the segment at the charged nights. Without
        the cap the segment claimed all three, transfer_day_offset ran past
        renewal_count + 1 and the folio billed 2,400 of rent against a
        balance of 800.
        """
        s = Stay("101", 800)
        s.shift("213", 500, completed_cycles=3, on_date="2026-09-04")
        self.assertEqual(s.guest["transfer_day_offset"], 1)
        self.assertEqual(s.charged, [800])
        s.assert_reconciles(self)

    def test_every_order_of_price_change_and_shift_reconciles(self):
        """The invariant, swept: nights billed == nights charged.

        Every combination of renewals so far, cycles elapsed, which way the
        price change points and whether it lands before or after the shift.
        Combinations the planner refuses (pending rent, a boundary inside a
        shift segment) are the refusals, not billing outcomes, so they are
        skipped here — TestPlanRateChange pins those.
        """
        for renewals in range(0, 5):
            for completed in range(0, 6):
                for effective in ("today", "tomorrow"):
                    for change_first in (True, False):
                        with self.subTest(renewals=renewals, completed=completed,
                                          effective=effective,
                                          change_first=change_first):
                            s = Stay("225", 900)
                            for _ in range(renewals):
                                s.renew()
                            night = completed + 1
                            try:
                                if change_first:
                                    s.change_price(1200, effective, night=night)
                                    s.shift("226", s.guest["price"],
                                            completed_cycles=completed,
                                            on_date="2026-09-12")
                                else:
                                    s.shift("226", 1200,
                                            completed_cycles=completed,
                                            on_date="2026-09-12")
                                    s.change_price(1500, effective, night=night)
                            except RateChangeError:
                                continue
                            s.assert_reconciles(self)
                            s.renew()
                            s.assert_reconciles(self)


class TestNightCounting(unittest.TestCase):
    """The two helpers create_bill_record and /transfer_room share."""

    def test_accrued_nights_counts_check_in_plus_renewals(self):
        self.assertEqual(rate_segments.accrued_nights(0), 1)
        self.assertEqual(rate_segments.accrued_nights(4), 5)
        self.assertEqual(rate_segments.accrued_nights(None), 1)

    def test_nights_at_current_price_is_charged_minus_frozen(self):
        self.assertEqual(rate_segments.nights_at_current_price(4, 2), 3)
        self.assertEqual(rate_segments.nights_at_current_price(2, 3), 0)
        self.assertEqual(rate_segments.nights_at_current_price(0, 0), 1)
        self.assertEqual(rate_segments.nights_at_current_price(3, None), 4)

    def test_a_shift_leaves_exactly_the_uncovered_nights(self):
        for renewals in range(0, 6):
            for offset in range(0, 6):
                for completed in range(0, 8):
                    with self.subTest(renewals=renewals, offset=offset,
                                      completed=completed):
                        accrued = rate_segments.accrued_nights(renewals)
                        if offset > accrued:
                            continue        # refused upstream
                        days = rate_segments.shift_segment_days(
                            renewals, offset, completed)
                        after = offset + days
                        self.assertLessEqual(after, accrued)
                        self.assertEqual(
                            after + rate_segments.nights_at_current_price(
                                renewals, after),
                            accrued)

    def test_the_folio_has_no_calendar_day_count_left(self):
        """create_bill_record must count nights from the helper, not dates.

        Source-level because create_bill_record reads Firestore and cannot be
        driven from here. The failure it guards is silent: a calendar count
        re-billed nights a rate change had frozen, and nothing on the invoice
        said which nights they were.
        """
        src = open(os.path.join(os.path.dirname(__file__), "..", "config.py"),
                   encoding="utf-8").read()
        self.assertIn("rate_segments.nights_at_current_price(", src)
        self.assertNotIn("guest.get(\"last_transfer_date\")", src)
        self.assertNotIn("guest.get(\"transfer_day_prebilled\")", src)


if __name__ == "__main__":
    unittest.main()
