"""
Collecting a guest's pending settle-later balance.

Why this file exists
--------------------
The balance from a previous stay is shown at the next check-in, and until
now there was no way to take it from there: the operator had to leave the
modal, find the Pending Payments list and collect it there, or take the cash
and fix the books afterwards, which is how an invoice ends up settled in the
drawer and still "due" in the register.

The collection itself has exactly one implementation (/collect_settlement,
which applies the money to the linked bill and closes it). What is pinned
here is the part around it that can silently go wrong:

  * who may collect, and who may write a balance off: different acts,
    different permissions;
  * the customer's pending flag after a part payment must say what is LEFT,
    not what was owed at checkout, or the desk collects it twice;
  * that flag is per settlement, so a guest who owes on two stays does not
    have both warnings cleared by paying one.

Firebase is stubbed at import, in the style of the other service tests.
"""
from __future__ import annotations

import os
import sys
import types
import unittest

# ── Firebase stub (customer_service imports firebase_admin.firestore) ──
if "firebase_admin" not in sys.modules:
    _fa = types.ModuleType("firebase_admin")
    for _sub in ("credentials", "firestore", "storage"):
        setattr(_fa, _sub, types.ModuleType(f"firebase_admin.{_sub}"))
        sys.modules[f"firebase_admin.{_sub}"] = getattr(_fa, _sub)
    _fa.firestore.SERVER_TIMESTAMP = None
    sys.modules["firebase_admin"] = _fa

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import customer_service as cs          # noqa: E402
from services.permissions import (                    # noqa: E402
    ROLE_ADMIN, ROLE_HOUSEKEEPING, ROLE_MANAGER,
    PERMISSIONS, role_has_permission,
)


class TestWhoMayCollect(unittest.TestCase):
    def test_collect_is_a_permission_of_its_own(self):
        self.assertIn("settlement.collect", PERMISSIONS)

    def test_manager_may_collect_at_the_desk(self):
        # The guest who owes it is standing in front of them at check-in.
        self.assertTrue(role_has_permission(ROLE_MANAGER, "settlement.collect"))

    def test_manager_may_not_grant_or_write_off_credit(self):
        # Money in is a front-desk act; giving credit and cancelling a debt
        # are not.
        self.assertFalse(role_has_permission(ROLE_MANAGER, "settle_later.use"))
        self.assertFalse(role_has_permission(ROLE_MANAGER, "settlement.manage"))

    def test_admin_may_do_all_three(self):
        for perm in ("settlement.collect", "settlement.manage", "settle_later.use"):
            self.assertTrue(role_has_permission(ROLE_ADMIN, perm), perm)

    def test_housekeeping_may_not_touch_money(self):
        self.assertFalse(role_has_permission(ROLE_HOUSEKEEPING, "settlement.collect"))


class _Doc:
    """Just enough Firestore document for the pending-flag writers."""

    def __init__(self, store, doc_id):
        self.store, self.id = store, doc_id

    def get(self):
        data = self.store.get(self.id)
        return types.SimpleNamespace(
            exists=data is not None,
            to_dict=lambda: dict(data) if data is not None else None,
        )

    def set(self, data, merge=False):
        cur = self.store.setdefault(self.id, {}) if merge else {}
        cur.update(data)
        self.store[self.id] = cur

    def update(self, data):
        self.store.setdefault(self.id, {}).update(data)


class _Coll:
    def __init__(self, store):
        self.store = store

    def document(self, doc_id):
        return _Doc(self.store, doc_id)


class TestPendingFlagAfterCollection(unittest.TestCase):
    """The flag is what the check-in banner reads, so it has to track the
    settlement it names."""

    SETTLED = {"id": "s-july", "amount": 20, "checkout_date": "2026-07-25",
               "room": "223"}

    def setUp(self):
        self.store = {"9876543210": {
            "has_pending_settlement": True,
            "pending_settlement_id": "s-july",
            "pending_settlement_amount": 20,
            "pending_settlement_date": "2026-07-25",
            "pending_settlement_room": "223",
        }}
        self._saved = cs._customers_ref
        cs._customers_ref = _Coll(self.store)

    def tearDown(self):
        cs._customers_ref = self._saved

    def row(self):
        return self.store["9876543210"]

    def test_part_payment_leaves_the_remaining_amount_on_the_flag(self):
        cs._set_pending_settlement(
            "9876543210", dict(self.SETTLED, amount=8), only_if_id="s-july")
        self.assertEqual(self.row()["pending_settlement_amount"], 8)
        self.assertTrue(self.row()["has_pending_settlement"])

    def test_full_payment_clears_the_flag(self):
        cs._clear_pending_settlement("9876543210", "s-july")
        self.assertFalse(self.row()["has_pending_settlement"])
        self.assertIsNone(self.row()["pending_settlement_id"])

    def test_another_stays_balance_is_left_alone(self):
        # The guest also owes on a later stay; the flag now names that one.
        self.row()["pending_settlement_id"] = "s-august"
        self.row()["pending_settlement_amount"] = 500
        cs._set_pending_settlement(
            "9876543210", dict(self.SETTLED, amount=8), only_if_id="s-july")
        self.assertEqual(self.row()["pending_settlement_amount"], 500)
        cs._clear_pending_settlement("9876543210", "s-july")
        self.assertTrue(self.row()["has_pending_settlement"])
        self.assertEqual(self.row()["pending_settlement_id"], "s-august")

    def test_without_an_id_the_writers_keep_their_old_behaviour(self):
        cs._set_pending_settlement("9876543210", dict(self.SETTLED, amount=8))
        self.assertEqual(self.row()["pending_settlement_amount"], 8)
        cs._clear_pending_settlement("9876543210")
        self.assertFalse(self.row()["has_pending_settlement"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
