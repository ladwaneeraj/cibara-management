"""
A whole stay, driven through the real routes.

Why this file exists
--------------------
tests/test_rate_segments.py pins the arithmetic, and it does it against a
model of what the routes do. This file removes the model: it starts a Flask
app on the real rooms blueprint and POSTs to /renew_rent, /edit_room_price
and /transfer_room, against an in-memory Firestore. What comes back out is
the room document those routes actually wrote.

The invariant, asserted after every single step:

    rent billed by the checkout folio  ==  rent charged onto room.balance

Both sides are computed the way production computes them. The balance is
whatever the routes left on the room doc. The folio side is
pre_transfer_charges plus rate_segments.nights_at_current_price(), which is
the expression config.create_bill_record runs — tests/test_rate_segments.py
pins that it still does.

The orderings swept here are the ones that were getting the answer wrong:

  * a price change "from today" and "from tomorrow"
  * before tonight's renewal and after it
  * a room shift before the price change and after it
  * a shift on the SAME day as a "from tomorrow" change, which used to bill
    that night twice
  * renewals continuing afterwards, which is where a wrong boundary shows up
    as a rate that never takes effect

Run: python -m pytest tests/test_stay_lifecycle.py
"""
from __future__ import annotations

import os
import sys
import types
import unittest
from datetime import datetime, timedelta

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
for _p in (_REPO, _HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import test_payroll_edit                      # noqa: E402,F401  (firebase stubs)

from flask import Flask                        # noqa: E402
from firebase_admin import firestore as fa     # noqa: E402

import config                                  # noqa: E402
from routes import rooms as rooms_mod          # noqa: E402
from services import auth_service, rate_segments, stay_timeline  # noqa: E402


# ── In-memory Firestore ────────────────────────────────────────────────────
# Enough of it for these three routes: documents, dotted-path updates,
# Increment, ArrayUnion, batches and (single-threaded) transactions.

class _Inc:
    def __init__(self, amount):
        self.amount = amount


class _Union:
    def __init__(self, values):
        self.values = list(values)


def _apply(target, key, value):
    """One Firestore update entry. A dotted key addresses a nested field —
    "guest.price" sets doc["guest"]["price"] and leaves the rest of guest
    alone, which is what the price route relies on."""
    parts = key.split(".")
    node = target
    for p in parts[:-1]:
        nxt = node.get(p)
        if not isinstance(nxt, dict):
            nxt = {}
            node[p] = nxt
        node = nxt
    leaf = parts[-1]
    if isinstance(value, _Inc):
        node[leaf] = int(node.get(leaf, 0) or 0) + value.amount
    elif isinstance(value, _Union):
        cur = list(node.get(leaf) or [])
        for v in value.values:
            if v not in cur:
                cur.append(v)
        node[leaf] = cur
    else:
        node[leaf] = value


def _merge(target, data):
    for k, v in data.items():
        _apply(target, k, v)


class _Snap:
    def __init__(self, doc_id, data):
        self.id = doc_id
        self._data = data

    @property
    def exists(self):
        return self._data is not None

    def to_dict(self):
        return _deep_copy(self._data) if self._data is not None else None


def _deep_copy(v):
    if isinstance(v, dict):
        return {k: _deep_copy(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_deep_copy(x) for x in v]
    return v


class _DocRef:
    def __init__(self, store, coll, doc_id):
        self._store, self._coll, self.id = store, coll, doc_id

    def get(self, transaction=None, **_kw):
        return _Snap(self.id, self._store.data(self._coll).get(self.id))

    def set(self, data, merge=False):
        bucket = self._store.data(self._coll)
        if merge and self.id in bucket:
            _merge(bucket[self.id], data)
        else:
            fresh = {}
            _merge(fresh, data)
            bucket[self.id] = fresh

    def update(self, data):
        bucket = self._store.data(self._coll)
        bucket.setdefault(self.id, {})
        _merge(bucket[self.id], data)

    def delete(self):
        self._store.data(self._coll).pop(self.id, None)


class _CollRef:
    def __init__(self, store, coll, clauses=None, cap=None):
        self._store, self._coll = store, coll
        self._clauses, self._cap = list(clauses or []), cap

    def document(self, doc_id=None):
        if doc_id is None:
            doc_id = self._store.next_id(self._coll)
        return _DocRef(self._store, self._coll, str(doc_id))

    def where(self, filter=None, **_kw):          # noqa: A002
        return _CollRef(self._store, self._coll, self._clauses + [filter], self._cap)

    def limit(self, n):
        return _CollRef(self._store, self._coll, self._clauses, n)

    def order_by(self, *_a, **_kw):
        return self

    def stream(self, **_kw):
        rows = [_Snap(i, d) for i, d in self._store.data(self._coll).items()]
        return iter(rows[:self._cap] if self._cap else rows)


class _Batch:
    def __init__(self):
        self._ops = []

    def set(self, ref, data, merge=False):
        self._ops.append(lambda: ref.set(data, merge=merge))

    def update(self, ref, data):
        self._ops.append(lambda: ref.update(data))

    def delete(self, ref):
        self._ops.append(lambda: ref.delete())

    def commit(self):
        for op in self._ops:
            op()
        self._ops = []


class _Txn:
    """Single-threaded, so writes apply as they are staged. The routes use a
    transaction for concurrency, not for rollback on their own error paths:
    every refusal returns BEFORE the first txn.update."""

    def update(self, ref, data):
        ref.update(data)

    def set(self, ref, data, merge=False):
        ref.set(data, merge=merge)


class _DB:
    def __init__(self):
        self._data, self._seq = {}, 0

    def data(self, coll):
        return self._data.setdefault(coll, {})

    def next_id(self, coll):
        self._seq += 1
        return "%s_%d" % (coll, self._seq)

    def collection(self, name):
        return _CollRef(self, name)

    def batch(self):
        return _Batch()

    def transaction(self):
        return _Txn()


ADMIN = {"userId": "u_admin", "name": "Owner", "role": "admin"}


class StayHarness:
    """One occupied room, and the routes that move its money.

    `charged` records the rate each night was charged at, tracked here
    independently of anything the routes write, so the folio can be checked
    night by night rather than only in total.
    """

    def __init__(self, case, room="213", price=800, checkin=None):
        self.case = case
        self.room = room
        self.db = case.db
        self.checkin = checkin or datetime(2026, 9, 10, 12, 0)
        self.charged = [price]
        # Anything on the balance that is not rent: an add-on billed to the
        # room, a service. The folio checks below are the RENT ledger, so
        # these are held separately rather than smudged into it.
        self.extras = 0
        self.db.data("rooms")[room] = {
            "status": "occupied",
            "checkin_time": self.checkin.strftime("%Y-%m-%d %H:%M"),
            "renewal_count": 0,
            "balance": price,
            "add_ons": [],
            "discounts": [],
            "stay_timeline": [],
            "guest": {"name": "Ravi", "mobile": "9000000001", "price": price,
                      "guests": 1, "payment": "cash", "isAC": False},
        }
        self.db.data("totals")["current_totals"] = {"balance": price,
                                                    "expenses": 0}

    # ── the room as the routes left it ─────────────────────────────────────
    @property
    def doc(self):
        return self.db.data("rooms")[self.room]

    @property
    def guest(self):
        return self.doc["guest"]

    @property
    def balance(self):
        return int(self.doc.get("balance", 0) or 0)

    @property
    def accrued(self):
        return rate_segments.accrued_nights(self.doc.get("renewal_count", 0))

    # ── routes ─────────────────────────────────────────────────────────────
    def renew(self):
        r = self.case.client.post("/renew_rent", json={
            "room": self.room,
            "renewal_count": int(self.doc.get("renewal_count", 0) or 0) + 1})
        body = r.get_json()
        self.case.assertTrue(body.get("success"), body)
        self.charged.append(int(self.guest["price"]))
        return body

    def advance(self, days=1):
        """Move the clock on. /renew_rent allows one renewal per calendar
        day, so a stay only moves forward by moving the date."""
        self.case.at += timedelta(days=days)
        return self

    def change_price(self, new_price, effective, expect_ok=True):
        """expect_ok True/False asserts the outcome; None accepts either.

        None is for the sweep, where some orderings legitimately hit a
        refusal (pending rent). What is asserted there is not which way it
        went but that a refusal moved nothing, which assert_books_balance
        checks for both outcomes.
        """
        r = self.case.client.post("/edit_room_price", json={
            "room": self.room, "room_price_per_night": new_price,
            "effective": effective, "reason": "test"})
        body = r.get_json()
        if expect_ok is True:
            self.case.assertTrue(body.get("success"), body)
        elif expect_ok is False:
            self.case.assertFalse(body.get("success"), body)
        if body.get("success"):
            first_new = body.get("first_new_night")
            for i in range(first_new - 1, len(self.charged)):
                self.charged[i] = new_price
        return body

    def shift(self, new_room, expect_ok=True, **extra):
        self.db.data("rooms").setdefault(new_room, {"status": "vacant"})
        payload = {"old_room": self.room, "new_room": new_room}
        payload.update(extra)
        r = self.case.client.post("/transfer_room", json=payload)
        body = r.get_json()
        if expect_ok:
            self.case.assertTrue(body.get("success"), body)
            self.room = new_room
            # A same-category shift keeps the tariff and `charged` does not
            # move. A cross-category shift re-rates every night charged
            # beyond the new offset — the same nights /transfer_room applies
            # its balance adjustment to — so the ledger follows it here.
            offset = int(self.guest.get("transfer_day_offset", 0) or 0)
            price = int(self.guest["price"])
            for i in range(offset, len(self.charged)):
                self.charged[i] = price
        return body

    # ── the invariant ──────────────────────────────────────────────────────
    def folio_nights(self):
        """Rent per night, built the way config.create_bill_record builds it:
        the frozen segments, then whatever is left at the current price."""
        segments = self.guest.get("pre_transfer_charges") or []
        offset = int(self.guest.get("transfer_day_offset", 0) or 0)
        nights = []
        for s in segments:
            self.case.assertEqual(
                s.get("total"), int(s.get("price", 0)) * int(s.get("days", 0)),
                "a segment's total disagrees with its own nights: %r" % (s,))
            nights += [int(s["price"])] * int(s["days"])
        current = rate_segments.nights_at_current_price(
            self.doc.get("renewal_count", 0), offset)
        nights += [int(self.guest["price"])] * current
        return nights

    def assert_folio_lines(self, note=""):
        """Run the real per-night folio builder over the state the routes
        left, and require its line items to be the nights the balance was
        charged. compute_daily_folio is what prints the invoice and picks
        each night's GST slab from that night's own rate, so this is the
        last hop between the room document and the bill."""
        segments = self.guest.get("pre_transfer_charges") or []
        nights = self.folio_nights()
        folio = config.compute_daily_folio(
            checkin_dt=self.checkin,
            days_stayed=len(nights),
            room_price_per_night=int(self.guest["price"]),
            current_room_no=self.room,
            accommodation_services=[],
            pre_transfer_charges=segments,
            discount_on_accom=0,
            recipient_state_code="29",
        )
        self.case.assertEqual([int(e["base_rate"]) for e in folio], nights,
                              "folio line rates %s" % note)
        self.case.assertEqual(
            int(round(sum(e["day_total"] for e in folio))) + self.extras,
            self.balance, "folio total vs balance %s" % note)
        # Each night is attributed to the room it was actually slept in, which
        # is what a shift mid-stay has to get right on the printed bill.
        rooms_on_bill = [str(e["room"]) for e in folio]
        expected_rooms = []
        for seg in segments:
            expected_rooms += [str(seg.get("from_room"))] * int(seg["days"])
        expected_rooms += [str(self.room)] * (len(nights) - len(expected_rooms))
        self.case.assertEqual(rooms_on_bill, expected_rooms,
                              "folio room attribution %s" % note)
        return folio

    def assert_books_balance(self, note=""):
        nights = self.folio_nights()
        self.case.assertEqual(
            nights, self.charged,
            "folio bills %s, balance was charged %s %s"
            % (nights, self.charged, note))
        self.case.assertEqual(
            sum(nights) + self.extras, self.balance,
            "folio total %s + extras %s != room balance %s %s"
            % (sum(nights), self.extras, self.balance, note))
        self.case.assertEqual(
            self.balance,
            int(self.db.data("totals")["current_totals"]["balance"]),
            "room balance and the global counter disagree %s" % note)
        offset = int(self.guest.get("transfer_day_offset", 0) or 0)
        self.case.assertLessEqual(
            offset, self.accrued,
            "more nights are frozen into segments than were ever charged")
        self.assert_folio_lines(note)


class _LifecycleCase(unittest.TestCase):
    """A Flask app on the real rooms blueprint, wired to the fake."""

    @classmethod
    def setUpClass(cls):
        cls.app = Flask(__name__)
        cls.app.register_blueprint(rooms_mod.rooms_bp)

    def setUp(self):
        self.client = self.app.test_client()

        # Saved originals for every module attribute this case replaces. The
        # dict is snapshotted into the cleanup closure rather than read off
        # self at teardown time: a test that wants a second scenario calls
        # _new_world(), and if that went through setUp() again it would
        # rebind self._saved and the real values would be lost. They were —
        # a patched firestore.ArrayUnion escaped this file and failed
        # test_stay_timeline, which had nothing to do with any of this.
        saved = {}

        def patch(mod, name, value):
            saved.setdefault((mod, name), getattr(mod, name, None))
            setattr(mod, name, value)

        self._patch = patch
        self.addCleanup(self._restore, saved)

        self._new_world()

        patch = self._patch
        patch(rooms_mod, "get_all_rooms",
              lambda *a, **kw: _deep_copy(self.db.data("rooms")))
        patch(rooms_mod, "invalidate_rooms_and_totals", lambda *a, **kw: None)
        patch(rooms_mod, "invalidate_cache", lambda *a, **kw: None)
        patch(rooms_mod, "write_log", lambda *a, **kw: self.logs.append((a, kw)))
        patch(rooms_mod, "auto_generate_bill_pdf", lambda *a, **kw: None)
        patch(rooms_mod.payment_service, "write_payment", lambda *a, **kw: None)
        patch(rooms_mod.payment_service, "write_payment_with_stay", lambda *a, **kw: None)
        patch(config, "update_last_rent_check", lambda *a, **kw: None)

        patch(fa.firestore if hasattr(fa, "firestore") else fa, "Increment", _Inc)
        patch(rooms_mod.firestore, "Increment", _Inc)
        patch(rooms_mod.firestore, "ArrayUnion", lambda vals: _Union(vals))
        patch(rooms_mod.firestore, "transactional", lambda fn: fn)
        patch(stay_timeline.firestore, "ArrayUnion", lambda vals: _Union(vals))

        patch(auth_service, "load_current_user", lambda: dict(ADMIN))
        patch(rooms_mod, "_safe_user", lambda: dict(ADMIN))

        # datetime.now(IST) drives current_night and the renewal-day guard, so
        # the clock is the test's to set.
        real_dt = rooms_mod.datetime
        case = self

        class _Clock(real_dt):
            @classmethod
            def now(cls_, tz=None):
                return case.at
        patch(rooms_mod, "datetime", _Clock)

    def _new_world(self):
        """A fresh, empty Firestore and a clock back at the start.

        Scenario loops call this instead of setUp(): the module patches are
        process-wide and identical every time, so re-applying them would only
        overwrite the saved originals with already-patched values.
        """
        self.db = _DB()
        self.logs = []
        self.at = datetime(2026, 9, 11, 15, 0)   # "now"; tests advance it
        rooms_ref = self.db.collection("rooms")
        totals_ref = self.db.collection("totals")
        bills_ref = self.db.collection("bills")
        for mod in (rooms_mod, config):
            mod.db = self.db
            mod.rooms_ref = rooms_ref
            mod.totals_ref = totals_ref
            mod.bills_ref = bills_ref

    def _restore(self, saved):
        for (mod, name), value in saved.items():
            setattr(mod, name, value)


class TestPriceChangeAloneEndToEnd(_LifecycleCase):
    def test_from_today_before_tonights_renewal(self):
        s = StayHarness(self)                 # night 1 charged at 800
        # The clock starts inside night 2, which nobody has renewed.
        # Night 2 has not been charged, so "today" can only mean night 2 —
        # which lands on the boundary, repricing nothing.
        body = s.change_price(1000, "today")
        self.assertEqual(body["first_new_night"], 2)
        self.assertEqual(body["nights_repriced"], 0)
        s.assert_books_balance("today, pre-renewal")
        s.renew()
        self.assertEqual(s.charged, [800, 1000])
        s.assert_books_balance("after the renewal charged the new rate")

    def test_from_today_after_tonights_renewal(self):
        s = StayHarness(self)
        s.renew()                                # night 2 charged at 800
        body = s.change_price(1000, "today")
        # Night 2 is the night the clock is in and it IS charged, so it is
        # repriced and the balance moves by the difference.
        self.assertEqual(body["nights_repriced"], 1)
        self.assertEqual(s.charged, [800, 1000])
        s.assert_books_balance("today, post-renewal")

    def test_from_tomorrow_charges_nothing_now(self):
        s = StayHarness(self)
        s.renew()
        before = s.balance
        body = s.change_price(1000, "tomorrow")
        self.assertEqual(body["nights_repriced"], 0)
        self.assertEqual(s.balance, before)
        s.assert_books_balance("tomorrow, nothing repriced")
        s.advance().renew()
        self.assertEqual(s.charged, [800, 800, 1000])
        s.assert_books_balance("tomorrow, once it started")

    def test_from_tomorrow_is_refused_while_tonight_is_unrenewed(self):
        s = StayHarness(self)                    # night 2, not renewed
        body = s.change_price(1000, "tomorrow", expect_ok=False)
        self.assertIn("has not been renewed yet", body["message"])
        s.assert_books_balance("after a refusal, nothing moved")

    def test_a_second_change_the_same_day_reopens_the_first(self):
        s = StayHarness(self)
        s.renew()
        s.change_price(1000, "tomorrow")         # freezes night 2 at 800
        s.change_price(1200, "today")            # reopens it
        self.assertEqual(s.charged, [800, 1200])
        s.assert_books_balance("tomorrow then today")

    def test_the_same_price_is_refused(self):
        s = StayHarness(self)
        s.renew()
        body = s.change_price(800, "today", expect_ok=False)
        self.assertIn("already the current price", body["message"])

    def test_a_missing_effective_is_refused_rather_than_guessed(self):
        s = StayHarness(self)
        r = self.client.post("/edit_room_price", json={
            "room": s.room, "room_price_per_night": 1000})
        self.assertEqual(r.status_code, 400)
        s.assert_books_balance("after a refusal")


class TestShiftThenPriceChange(_LifecycleCase):
    def test_shift_then_change_from_tomorrow(self):
        s = StayHarness(self)
        s.renew()                                 # nights 1-2 at 800
        s.shift("214")
        s.assert_books_balance("straight after the shift")
        s.change_price(1000, "tomorrow")
        s.advance().renew()
        self.assertEqual(s.charged, [800, 800, 1000])
        s.assert_books_balance("shift then tomorrow")

    def test_shift_then_change_from_today(self):
        s = StayHarness(self)
        s.renew()
        s.shift("214")
        s.change_price(1000, "today")
        self.assertEqual(s.charged, [800, 1000])
        s.assert_books_balance("shift then today")


class TestPriceChangeThenShift(_LifecycleCase):
    """The reported bug. A "from tomorrow" change freezes tonight into a
    rate-change segment; the shift an hour later used to make the folio count
    that night AGAIN as the shift day's minimum."""

    def test_tomorrow_then_a_shift_the_same_day(self):
        s = StayHarness(self)
        s.renew()
        s.change_price(1000, "tomorrow")
        self.assertEqual(int(s.guest["transfer_day_offset"]), 2)
        s.shift("214")
        # The shift must add nothing: both charged nights are already frozen.
        self.assertEqual(int(s.guest["transfer_day_offset"]), 2)
        self.assertEqual(s.charged, [800, 800])
        s.assert_books_balance("tomorrow then a same-day shift")
        s.advance().renew()
        self.assertEqual(s.charged, [800, 800, 1000])
        s.assert_books_balance("and the new rate started once")

    def test_today_then_a_shift_the_same_day(self):
        s = StayHarness(self)
        s.renew()
        s.change_price(1000, "today")
        s.shift("214")
        self.assertEqual(s.charged, [800, 1000])
        s.assert_books_balance("today then a same-day shift")

    def test_a_shift_never_freezes_a_night_nobody_charged(self):
        """Renewals behind the clock. Four days have elapsed and one night is
        paid for; the shift may claim one night, not four."""
        s = StayHarness(self)
        s.advance(3)                              # night 5, renewal_count 0
        s.shift("214")
        self.assertLessEqual(int(s.guest["transfer_day_offset"]), s.accrued)
        s.assert_books_balance("shift with renewals behind")


class TestLongStayEveryOrder(_LifecycleCase):
    def test_a_week_of_changes_keeps_the_books_level(self):
        # 213 and 214 are both single-attach, so the shifts are physical
        # moves and the tariff carries over. Cross-category re-rating has its
        # own test below.
        s = StayHarness(self)
        s.renew()                                  # n2 @800
        s.change_price(1000, "tomorrow")
        s.advance().renew()                        # n3 @1000
        s.shift("214")
        s.assert_books_balance("mid-week shift")
        s.change_price(1200, "today")              # reprices n3
        s.advance().renew()                        # n4 @1200
        s.change_price(900, "tomorrow")
        s.advance().renew()                        # n5 @900
        # Not back to 213: /transfer_room leaves the room it emptied in
        # "cleaning", so it is not a legal destination until housekeeping
        # clears it. 212 is the same category as both.
        s.shift("212")
        s.advance().renew()                        # n6 @900
        self.assertEqual(s.charged, [800, 800, 1200, 1200, 900, 900])
        s.assert_books_balance("after a full week")

    def test_every_ordering_of_the_four_moves(self):
        """Price change (today / tomorrow) x before / after the renewal x
        shift before / after the change, each replayed end to end."""
        for effective in ("today", "tomorrow"):
            for renew_first in (True, False):
                for shift_first in (True, False):
                    with self.subTest(effective=effective,
                                      renew_first=renew_first,
                                      shift_first=shift_first):
                        self._new_world()
                        s = StayHarness(self)
                        if renew_first:
                            s.renew()
                        if shift_first:
                            s.shift("214")
                            s.assert_books_balance("after the shift")
                        body = s.change_price(1100, effective,
                                              expect_ok=None)
                        if not body.get("success"):
                            # A refusal is a valid outcome (pending rent);
                            # what matters is that it changed nothing.
                            s.assert_books_balance("after a refusal")
                            continue
                        s.assert_books_balance("after the price change")
                        if not shift_first:
                            s.shift("214")
                            s.assert_books_balance("after the later shift")
                        s.advance().renew()
                        s.assert_books_balance("after the next renewal")


class TestCrossCategoryShift(_LifecycleCase):
    """An upgrade or downgrade re-rates the stay from the shift day on.

    213 is single-attach, 225 is deluxe, so /transfer_room moves guest.price
    to the destination tariff, freezes the completed nights at the old rate
    and moves the balance by the difference on the nights already charged
    beyond that. Both halves of that have to land or the balance and the
    folio part company on the shift day itself.
    """

    def test_an_upgrade_reprices_todays_night_and_moves_the_balance(self):
        s = StayHarness(self)
        s.renew()                                   # nights 1-2 at 800
        before = s.balance
        body = s.shift("225")                       # deluxe, standard 900
        self.assertIn("Rate changed", body["message"])
        # Night 1 is a completed cycle and stays at 800; night 2 is the one
        # in progress, so it re-prices and the balance moves by the delta.
        self.assertEqual(int(s.guest["transfer_day_offset"]), 1)
        self.assertEqual(s.charged, [800, 900])
        self.assertEqual(s.balance, before + 100)
        s.assert_books_balance("cross-category upgrade")

    def test_a_downgrade_refunds_the_difference_on_the_balance(self):
        s = StayHarness(self, room="225", price=900)
        s.renew()
        before = s.balance
        s.shift("213")                              # single-attach, 450
        self.assertEqual(s.charged, [900, 450])
        self.assertEqual(s.balance, before - 450)
        s.assert_books_balance("cross-category downgrade")

    def test_keeping_today_at_the_old_rate_moves_no_money(self):
        """apply_today_diff off: the in-progress night is folded into the old
        segment, so nothing on the balance moves and the new rate starts at
        the next renewal."""
        s = StayHarness(self)
        s.renew()
        before = s.balance
        s.shift("225", apply_today_diff=False)
        self.assertEqual(s.balance, before)
        self.assertEqual(s.charged, [800, 800])
        self.assertEqual(int(s.guest["transfer_day_offset"]), 2)
        s.assert_books_balance("shift with today's difference off")
        s.advance().renew()
        self.assertEqual(s.charged, [800, 800, 900])
        s.assert_books_balance("and the new rate from the next cycle")

    def test_a_price_change_after_an_upgrade_starts_from_the_right_night(self):
        s = StayHarness(self)
        s.renew()
        s.shift("225")                              # night 2 now 900
        s.change_price(1500, "tomorrow")
        s.advance().renew()
        self.assertEqual(s.charged, [800, 900, 1500])
        s.assert_books_balance("upgrade then a tomorrow price change")

    def test_an_upgrade_into_the_party_hall_is_refused(self):
        s = StayHarness(self)
        s.renew()
        body = s.shift("228", expect_ok=False)
        self.assertFalse(body.get("success"))
        self.assertIn("no standard nightly tariff", body["message"])
        s.assert_books_balance("after a refused shift")


class TestRateRaisingAddOn(_LifecycleCase):
    """/add_on with apply_to_all_nights is the third writer of segments.

    The add-on line carries today's uplift as a service; the raised
    guest.price bills from the next renewal, and every night charged so far
    is frozen at the old rate. A price change afterwards must not be allowed
    to start inside that frozen block.
    """

    def add_on(self, price, **extra):
        payload = {"room": self.room_under_test.room, "item": "AC",
                   "price": price, "unit_price": price, "quantity": 1,
                   "payment_method": "balance",
                   "accommodation_charge": True,
                   "apply_to_all_nights": True}
        payload.update(extra)
        r = self.client.post("/add_on", json=payload)
        return r.get_json()

    def test_the_raised_rate_starts_at_the_next_renewal(self):
        s = StayHarness(self)
        self.room_under_test = s
        s.renew()                                    # nights 1-2 at 800
        body = self.add_on(400)                      # 1,200 — above the band
        self.assertTrue(body.get("success"), body)
        s.extras += 400
        self.assertEqual(int(s.guest["price"]), 1200)
        self.assertEqual(int(s.guest["transfer_day_offset"]), 2)
        # The add-on's own line is a service, not rent, so the rent ledger is
        # untouched until the next renewal.
        self.assertEqual(s.charged, [800, 800])
        s.assert_books_balance("after a rate-raising add-on")
        s.advance().renew()
        self.assertEqual(s.charged, [800, 800, 1200])
        s.assert_books_balance("and the raised rate charged once")

    def test_an_uplift_that_would_cross_1000_is_trimmed_to_stay_exempt(self):
        """The exempt-band snap, seen end to end.

        800 + 200 is a 1,000 night, which is taxable; charging 199 keeps the
        night at 999 and inside the band, so the lodge keeps more than it
        would after tax. A genuine price cut, and the invoice says 199.
        """
        s = StayHarness(self)
        self.room_under_test = s
        s.renew()
        body = self.add_on(200)
        self.assertTrue(body.get("success"), body)
        self.assertEqual(int(s.guest["price"]), 999)
        s.extras += int(s.balance) - (sum(s.charged) + s.extras)
        s.assert_books_balance("after the band snap")
        s.advance().renew()
        self.assertEqual(s.charged, [800, 800, 999])
        s.assert_books_balance("and the snapped rate charged")

    def test_a_price_change_cannot_start_inside_the_add_ons_block(self):
        s = StayHarness(self)
        self.room_under_test = s
        s.renew()
        self.add_on(400)
        s.extras += 400
        body = s.change_price(1400, "today", expect_ok=False)
        self.assertIn("add-on raised the nightly price", body["message"])
        s.assert_books_balance("after the refusal")
        # From tomorrow is the legal move and it works.
        s.change_price(1400, "tomorrow")
        s.advance().renew()
        self.assertEqual(s.charged, [800, 800, 1400])
        s.assert_books_balance("tomorrow after an add-on")


if __name__ == "__main__":
    unittest.main(verbosity=2)
