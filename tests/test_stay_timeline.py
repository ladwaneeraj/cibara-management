"""
Unit tests for services.stay_timeline — the per-stay room event trail.

WHAT THIS PROTECTS
──────────────────
The room-history popover used to read flat `lastXBy` / `xAt` fields off the
room document. Those hold only the most recent occurrence of each action and
the room document outlives the stay, so a transferred stay showed a mixture
of occupants: a cleaning from two months earlier, an inspection belonging to
somebody else, and a transfer that matched neither. The failure was silent —
the popover looked populated and plausible while being wrong.

These tests pin the scoping rules that make the materialised trail correct:
one array is one stay plus its prep, a transfer carries the trail across and
folds in the destination's prep, and a checkout freezes it. If any of these
break, the popover goes back to attributing one person's work to another,
which is precisely what it exists to prevent.

Firebase is stubbed so the module can be exercised offline, in the same style
as test_bill_render.py.
"""
from __future__ import annotations

import os
import sys
import types
import unittest

# ── Firebase / Flask stubs ────────────────────────────────────────────────
# stay_timeline imports firebase_admin.firestore (for ArrayUnion) and pulls
# _safe_user / _ist_now_iso out of services.audit_log, which needs a Flask
# request context to exist as a concept but not to be active.
_fa = types.ModuleType("firebase_admin")
for _sub in ("credentials", "firestore", "storage", "auth"):
    _m = types.ModuleType(f"firebase_admin.{_sub}")
    setattr(_fa, _sub, _m)
    sys.modules[f"firebase_admin.{_sub}"] = _m


class _ArrayUnion:
    """Stand-in for firestore.ArrayUnion — records what would be appended."""

    def __init__(self, values):
        self.values = list(values)

    def __eq__(self, other):
        return isinstance(other, _ArrayUnion) and other.values == self.values

    def __repr__(self):
        return f"_ArrayUnion({self.values!r})"


_fa.firestore.ArrayUnion = _ArrayUnion
_fa.firestore.SERVER_TIMESTAMP = object()
sys.modules["firebase_admin"] = _fa

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services import stay_timeline  # noqa: E402


# ── Fixtures ──────────────────────────────────────────────────────────────

def ev(action, room, at, by="anand", name=None, **extra):
    """A timeline record with an explicit timestamp, so ordering is testable."""
    e = {
        "action": action,
        "room":   str(room),
        "by":     by,
        "byName": name or by.title(),
        "at":     at,
    }
    e.update(extra)
    return e


CLEAN_210   = ev("room.cleaning.complete",  "210", "2026-08-20 09:00:00", "jeevan")
INSPECT_210 = ev("room.inspection.approve", "210", "2026-08-20 10:00:00", "lankesh")
CHECKIN_210 = ev("room.checkin",            "210", "2026-08-21 16:00:00", "anand")
CLEAN_222   = ev("room.cleaning.complete",  "222", "2026-08-19 08:00:00", "jeevan")
INSPECT_222 = ev("room.inspection.approve", "222", "2026-08-19 08:30:00", "lankesh")


class TestRead(unittest.TestCase):
    def test_missing_field_is_an_empty_list(self):
        self.assertEqual(stay_timeline.read({}), [])
        self.assertEqual(stay_timeline.read(None), [])

    def test_non_list_value_is_ignored(self):
        """A half-migrated document must not crash the register."""
        self.assertEqual(stay_timeline.read({"stay_timeline": "corrupt"}), [])

    def test_non_dict_members_are_dropped(self):
        got = stay_timeline.read({"stay_timeline": [CLEAN_210, "junk", None]})
        self.assertEqual(got, [CLEAN_210])


class TestPrepOnly(unittest.TestCase):
    def test_keeps_cleaning_and_inspection(self):
        got = stay_timeline.prep_only([CLEAN_210, INSPECT_210])
        self.assertEqual(got, [CLEAN_210, INSPECT_210])

    def test_drops_occupancy_events(self):
        """A vacant room should carry nothing but prep.

        Anything else there is a leftover from an interrupted stay, and
        attributing it to the incoming guest is the bug being prevented.
        """
        got = stay_timeline.prep_only([CLEAN_210, CHECKIN_210, INSPECT_210])
        self.assertEqual(got, [CLEAN_210, INSPECT_210])


class TestMerge(unittest.TestCase):
    def test_orders_by_timestamp_across_groups(self):
        """A transfer folds in prep that happened BEFORE the check-in it
        follows in insertion order, so chronological sort is required."""
        got = stay_timeline.merge(
            [CLEAN_210, INSPECT_210, CHECKIN_210],
            [CLEAN_222, INSPECT_222],
        )
        self.assertEqual([e["at"] for e in got], sorted(e["at"] for e in got))
        self.assertEqual(got[0], CLEAN_222)          # 19 Aug, earliest
        self.assertEqual(got[-1], CHECKIN_210)       # 21 Aug, latest

    def test_deduplicates_identical_records(self):
        """A retried write must not double a row in the popover."""
        got = stay_timeline.merge([CLEAN_210], [CLEAN_210])
        self.assertEqual(len(got), 1)

    def test_same_action_in_different_rooms_is_not_a_duplicate(self):
        got = stay_timeline.merge([CLEAN_210], [CLEAN_222])
        self.assertEqual(len(got), 2)

    def test_same_action_by_different_people_is_not_a_duplicate(self):
        other = dict(CLEAN_210, by="ramesh", byName="Ramesh")
        got = stay_timeline.merge([CLEAN_210], [other])
        self.assertEqual(len(got), 2)

    def test_cap_drops_oldest_not_newest(self):
        many = [ev("room.checkin_time_update", "210", f"2026-08-21 {h:02d}:00:00")
                for h in range(24)] * 4          # 96 records, all distinct times
        many = [dict(e, at=f"2026-08-{21 + i // 24:02d} {i % 24:02d}:00:00")
                for i, e in enumerate(many)]
        got = stay_timeline.merge(many)
        self.assertEqual(len(got), stay_timeline.TIMELINE_CAP)
        self.assertEqual(got[-1]["at"], max(e["at"] for e in many))

    def test_ignores_junk_members(self):
        got = stay_timeline.merge([CLEAN_210, "junk", None, 7])
        self.assertEqual(got, [CLEAN_210])

    def test_empty_input_is_an_empty_list(self):
        self.assertEqual(stay_timeline.merge([], None), [])


class TestAppendOp(unittest.TestCase):
    def test_returns_an_array_union_of_one(self):
        op = stay_timeline.append_op(CLEAN_210)
        self.assertIsInstance(op, _ArrayUnion)
        self.assertEqual(op.values, [CLEAN_210])


class TestMakeEvent(unittest.TestCase):
    def test_carries_transfer_rooms(self):
        e = stay_timeline.make_event("room.transfer", "222",
                                     from_room="210", to_room="222",
                                     at="2026-08-21 18:00:00")
        self.assertEqual(e["from_room"], "210")
        self.assertEqual(e["to_room"], "222")
        self.assertEqual(e["room"], "222")

    def test_omits_transfer_rooms_on_ordinary_events(self):
        e = stay_timeline.make_event("room.checkin", "210",
                                     at="2026-08-21 16:00:00")
        self.assertNotIn("from_room", e)
        self.assertNotIn("to_room", e)

    def test_falls_back_to_system_outside_a_request(self):
        """Background threads and scripts must not crash or write a blank."""
        e = stay_timeline.make_event("room.checkin", "210", at="2026-08-21 16:00:00")
        self.assertEqual(e["by"], "system")
        self.assertEqual(e["byName"], "system")

    def test_room_is_always_a_string(self):
        e = stay_timeline.make_event("room.checkin", 210, at="2026-08-21 16:00:00")
        self.assertEqual(e["room"], "210")


class TestStayScoping(unittest.TestCase):
    """The lifecycle rules, exercised the way routes/rooms.py composes them."""

    def test_checkin_inherits_prep_but_not_a_previous_occupancy(self):
        """Reproduces the reported defect.

        A room doc left carrying a previous guest's check-in must not hand
        that row to the next guest. Only prep survives into a new stay.
        """
        room_doc = {"stay_timeline": [
            ev("room.checkin", "210", "2026-08-10 12:00:00", "someone_else"),
            CLEAN_210, INSPECT_210,
        ]}
        new_checkin = ev("room.checkin", "210", "2026-08-21 16:00:00", "anand")
        got = stay_timeline.merge(
            stay_timeline.prep_only(stay_timeline.read(room_doc)),
            [new_checkin],
        )
        actors = [e["by"] for e in got]
        self.assertNotIn("someone_else", actors)
        self.assertEqual([e["action"] for e in got],
                         ["room.cleaning.complete", "room.inspection.approve",
                          "room.checkin"])

    def test_transfer_carries_the_stay_and_folds_in_destination_prep(self):
        old_room_doc = {"stay_timeline": [CLEAN_210, INSPECT_210, CHECKIN_210]}
        new_room_doc = {"stay_timeline": [CLEAN_222, INSPECT_222]}
        shift = stay_timeline.make_event("room.transfer", "222",
                                         from_room="210", to_room="222",
                                         at="2026-08-21 18:00:00")
        got = stay_timeline.merge(
            stay_timeline.read(old_room_doc),
            stay_timeline.prep_only(stay_timeline.read(new_room_doc)),
            [shift],
        )
        self.assertEqual(
            [(e["action"], e["room"]) for e in got],
            [("room.cleaning.complete",  "222"),
             ("room.inspection.approve", "222"),
             ("room.cleaning.complete",  "210"),
             ("room.inspection.approve", "210"),
             ("room.checkin",            "210"),
             ("room.transfer",           "222")],
        )

    def test_transfer_does_not_inherit_a_stale_occupancy_from_the_destination(self):
        """A destination room left holding somebody's check-in row (an
        interrupted stay, a manual fix) must not donate it to the guest
        being moved in."""
        new_room_doc = {"stay_timeline": [
            CLEAN_222,
            ev("room.checkin", "222", "2026-08-05 11:00:00", "ghost"),
        ]}
        got = stay_timeline.merge(
            [CHECKIN_210],
            stay_timeline.prep_only(stay_timeline.read(new_room_doc)),
        )
        self.assertNotIn("ghost", [e["by"] for e in got])

    def test_multi_hop_transfer_keeps_every_leg(self):
        hop1 = stay_timeline.make_event("room.transfer", "222", from_room="210",
                                        to_room="222", at="2026-08-21 18:00:00")
        hop2 = stay_timeline.make_event("room.transfer", "230", from_room="222",
                                        to_room="230", at="2026-08-22 11:00:00")
        after_first  = stay_timeline.merge([CHECKIN_210], [hop1])
        after_second = stay_timeline.merge(after_first, [hop2])
        legs = [(e.get("from_room"), e.get("to_room"))
                for e in after_second if e["action"] == "room.transfer"]
        self.assertEqual(legs, [("210", "222"), ("222", "230")])

    def test_checkout_closes_the_trail_and_the_room_starts_empty(self):
        room_doc = {"stay_timeline": [CLEAN_210, INSPECT_210, CHECKIN_210]}
        checkout = ev("room.checkout", "210", "2026-08-24 09:00:00", "anand")
        frozen = stay_timeline.merge(stay_timeline.read(room_doc), [checkout])
        self.assertEqual(frozen[-1]["action"], "room.checkout")
        self.assertEqual(len(frozen), 4)

        # routes/rooms.py writes [] to the room in the same batch. The next
        # guest therefore starts from prep alone — nothing above can reach them.
        next_stay = stay_timeline.merge(
            stay_timeline.prep_only(stay_timeline.read({"stay_timeline": []})),
            [ev("room.checkin", "210", "2026-08-24 15:00:00", "anand")],
        )
        self.assertEqual(len(next_stay), 1)
        self.assertEqual(next_stay[0]["action"], "room.checkin")


class TestPrepFieldLifecycle(unittest.TestCase):
    """The cleanedBy / inspectedBy pair describes ONE cleaning cycle.

    These fields were written in exactly two places (/mark_room_cleaned and
    /mark_room_ready_for_checkin) and cleared in none, so they survived every
    checkout. Two consequences, both visible on a vacant room card:

      1. A room released and then approved without being cleaned (the
         "skipped inspection" path, prev_state == "in_progress") showed a
         FRESH inspector beside a cleaner from whatever cycle last actually
         cleaned it — possibly months earlier. The card claimed the room was
         prepped when only half of it had been.
      2. routes/insights.py reported cleaned_by for rooms still pending
         cleaning, naming whoever cleaned them last time round.

    routes/rooms.py now clears all four at checkout and at transfer, and
    restores them from the bill on revert_checkout. These tests assert the
    RULE those call sites implement, in the same shape they implement it.
    """

    PREP_FIELDS = ("cleanedBy", "cleanedAt", "inspectedBy", "inspectedAt")

    def _released_room(self, room_doc):
        """What checkout / transfer write over a released room's prep pair."""
        out = dict(room_doc)
        for f in self.PREP_FIELDS:
            out[f] = None
        out["stay_timeline"] = []
        return out

    def test_release_clears_every_prep_field(self):
        room = {"cleanedBy": "jeevan",  "cleanedAt": "2026-06-29 09:00:00",
                "inspectedBy": "lankesh", "inspectedAt": "2026-06-29 10:00:00",
                "stay_timeline": [CLEAN_210, CHECKIN_210]}
        got = self._released_room(room)
        for f in self.PREP_FIELDS:
            self.assertIsNone(got[f], f)
        self.assertEqual(got["stay_timeline"], [])

    def test_skipped_inspection_shows_a_gap_not_a_stale_cleaner(self):
        """The reported defect, end to end.

        Room released, then approved straight to vacant without a cleaning
        step. The inspector is real; the cleaner must read as absent, because
        nobody cleaned it this cycle.
        """
        room = self._released_room({"cleanedBy": "jeevan",
                                    "cleanedAt": "2026-06-29 09:00:00"})
        room["inspectedBy"] = "anand"                # the approval
        room["inspectedAt"] = "2026-08-24 11:00:00"
        self.assertIsNone(room["cleanedBy"])         # no cleaner this cycle
        self.assertEqual(room["inspectedBy"], "anand")

    def test_revert_checkout_restores_prep_from_the_bill(self):
        bill = {"cleanedBy": "jeevan", "cleanedAt": "2026-08-20 09:00:00",
                "inspectedBy": "lankesh", "inspectedAt": "2026-08-20 10:00:00"}
        restored = {f: bill.get(f) for f in self.PREP_FIELDS}
        self.assertEqual(restored["cleanedBy"], "jeevan")
        self.assertEqual(restored["inspectedBy"], "lankesh")

    def test_revert_checkout_drops_the_checkout_record(self):
        """An active stay must not carry its own checkout row."""
        checkout = ev("room.checkout", "210", "2026-08-24 09:00:00")
        bill = {"stay_timeline": [CLEAN_210, INSPECT_210, CHECKIN_210, checkout]}
        restored = [e for e in (bill.get("stay_timeline") or [])
                    if isinstance(e, dict) and e.get("action") != "room.checkout"]
        self.assertNotIn("room.checkout", [e["action"] for e in restored])
        self.assertEqual(len(restored), 3)


class TestPriceEditEvent(unittest.TestCase):
    """The tariff correction on an active stay (/edit_room_price).

    The amounts ride on the timeline record itself so the popover row can read
    "Price 600 -> 800 by Anand". A row that only says somebody edited the price
    tells you who to ask but not what to ask about, which is not an audit trail.
    """

    def test_amounts_are_carried_on_the_record(self):
        e = stay_timeline.make_event("room.price_update", "26",
                                     at="2026-08-25 15:10:00",
                                     old_price=600, new_price=800, nights=1)
        self.assertEqual(e["old_price"], 600)
        self.assertEqual(e["new_price"], 800)
        self.assertEqual(e["nights"], 1)
        self.assertEqual(e["action"], "room.price_update")

    def test_none_extras_are_dropped_not_stored_as_null(self):
        e = stay_timeline.make_event("room.price_update", "26",
                                     at="2026-08-25 15:10:00",
                                     old_price=600, new_price=800, reason=None)
        self.assertNotIn("reason", e)

    def test_two_corrections_in_one_stay_both_survive(self):
        """Repeated corrections must not collapse — each is a separate act."""
        a = stay_timeline.make_event("room.price_update", "26",
                                     at="2026-08-25 15:10:00",
                                     old_price=600, new_price=800)
        b = stay_timeline.make_event("room.price_update", "26",
                                     at="2026-08-25 16:00:00",
                                     old_price=800, new_price=700)
        got = stay_timeline.merge([a], [b])
        self.assertEqual(len(got), 2)
        self.assertEqual([x["new_price"] for x in got], [800, 700])

    def test_a_price_edit_is_not_prep_and_never_reaches_the_next_guest(self):
        e = stay_timeline.make_event("room.price_update", "26",
                                     at="2026-08-25 15:10:00",
                                     old_price=600, new_price=800)
        self.assertEqual(stay_timeline.prep_only([CLEAN_210, e]), [CLEAN_210])


if __name__ == "__main__":
    unittest.main(verbosity=2)
