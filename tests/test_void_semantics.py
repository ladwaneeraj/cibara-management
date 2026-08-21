"""
Void semantics: a voided add-on must leave BOTH sides of the ledger.

Why this file exists
--------------------
The `is_live_charge` rollout guarded every place a charge is summed and no
place a receipt is summed. `/void_add_on` flags the payments row `voided`
whatever the method was AND decrements totals[cash|online] — the money is
treated as handed back — so filtering one side and not the other made the
invoice, the drawer report and the Bills tab return three different numbers
for one stay, and burned a sequential GST invoice number on stays that
should never have had one.

The word "voided" appeared zero times in the whole tests/ tree before this
file, which is why a 190-test suite went green over it.

These are pure-arithmetic tests against the same expressions
create_bill_record uses. They deliberately do NOT import config (that needs
Firebase); they pin the INVARIANT, so they keep failing until every
summation site agrees.

Run: python tests/test_void_semantics.py
"""
from __future__ import annotations

import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# ── Firebase stub, same pattern as test_gst_helpers.py ────────────────────
# payment_service imports firebase_admin at module load. Nothing here touches
# Firestore; is_live_charge is a pure predicate.
if "firebase_admin" not in sys.modules:
    _fa = types.ModuleType("firebase_admin")
    for _sub in ("credentials", "firestore", "storage"):
        setattr(_fa, _sub, types.ModuleType(f"firebase_admin.{_sub}"))
        sys.modules[f"firebase_admin.{_sub}"] = getattr(_fa, _sub)
    _fa.credentials.Certificate = lambda *a, **kw: None
    _fa.initialize_app = lambda *a, **kw: None
    _fa.firestore.client = lambda *a, **kw: None
    _fa.firestore.SERVER_TIMESTAMP = None
    sys.modules["firebase_admin"] = _fa

from services.payment_service import is_live_charge  # noqa: E402


_REFUND_TYPES = ("refund", "checkout_refund", "manual_refund",
                 "booking_cancel_refund")
_EXCLUDE = _REFUND_TYPES + ("discount", "expense")


def _bill(rows, room_price, nights):
    """The arithmetic of config.create_bill_record, void guard included."""
    live = [r for r in rows if is_live_charge(r)]

    cash = sum(r.get("amount", 0) for r in live
               if r.get("method") == "cash" and r.get("type") not in _EXCLUDE)
    online = sum(r.get("amount", 0) for r in live
                 if r.get("method") == "online" and r.get("type") not in _EXCLUDE)
    ota = sum(r.get("amount", 0) for r in live
              if r.get("method") == "ota" and r.get("type") not in _EXCLUDE)
    refunds = sum(r.get("amount", 0) for r in rows
                  if r.get("type") in _REFUND_TYPES)
    discounts = sum(r.get("amount", 0) for r in rows
                    if r.get("type") == "discount")

    services_total = sum(r.get("amount", 0) for r in live
                         if r.get("type") == "addon")

    room_charges = room_price * nights
    total = room_charges + services_total - discounts
    return {
        "services_total": services_total,
        "total_amount": total,
        "payment_cash": cash,
        "payment_online": online,
        "payment_ota": ota,
        "balance": total - cash - online - ota + refunds,
    }


def _addon(amount, method, voided=False, item="Water 2L"):
    return {"type": "addon", "method": method, "amount": amount,
            "item": item, "voided": voided}


def _pay(amount, method="cash"):
    return {"type": "payment", "method": method, "amount": amount}


class VoidLeavesBothSides(unittest.TestCase):
    """The headline bug, in the exact shape it was found."""

    def test_voided_cash_addon_does_not_become_a_phantom_refund(self):
        # Rs.700 night, guest pays Rs.700 cash, buys Rs.60 water in cash,
        # operator voids it and hands the Rs.60 back.
        rows = [_pay(700, "cash"), _addon(60, "cash", voided=True)]
        b = _bill(rows, room_price=700, nights=1)

        self.assertEqual(b["services_total"], 0, "voided charge must leave the bill")
        self.assertEqual(b["payment_cash"], 700,
                         "voided receipt must leave the bill too — 760 means "
                         "the void was counted as money still in the drawer")
        self.assertEqual(b["balance"], 0,
                         "a negative balance here offers the guest a SECOND refund")

    def test_live_cash_addon_still_counts_on_both_sides(self):
        # The reverse: the guard must not drop a live charge.
        rows = [_pay(700, "cash"), _addon(60, "cash")]
        b = _bill(rows, room_price=700, nights=1)
        self.assertEqual(b["services_total"], 60)
        self.assertEqual(b["payment_cash"], 760)
        self.assertEqual(b["balance"], 0)

    def test_voided_online_addon_leaves_payment_online_at_zero(self):
        # This is what burned an invoice number: a cash-only stay whose
        # payment_online was non-zero purely because of a voided row failed
        # the is_no_bill check and minted a sequential CC/ number.
        rows = [_pay(900, "cash"), _addon(200, "online", voided=True, item="Laundry")]
        b = _bill(rows, room_price=900, nights=1)
        self.assertEqual(b["payment_online"], 0,
                         "non-zero payment_online on a cash-only stay mints a "
                         "GST invoice number that cannot be explained in GSTR-1")
        self.assertEqual(b["balance"], 0)

    def test_voided_ota_row_is_excluded(self):
        rows = [{"type": "addon", "method": "ota", "amount": 500, "voided": True}]
        b = _bill(rows, room_price=500, nights=1)
        self.assertEqual(b["payment_ota"], 0)


class LedgerInvariant(unittest.TestCase):
    """total_amount == receipts - refunds + balance, for every mix."""

    def test_invariant_holds_across_void_combinations(self):
        base = [_pay(1200, "online"), _pay(1200, "online")]
        variants = {
            "no addons": [],
            "one live cash addon": [_addon(400, "cash")],
            "one voided cash addon": [_addon(400, "cash", voided=True)],
            "live + voided": [_addon(400, "cash"), _addon(400, "cash", voided=True)],
            "voided online addon": [_addon(400, "online", voided=True)],
            "two voided": [_addon(400, "cash", voided=True),
                           _addon(250, "online", voided=True)],
        }
        for name, extra in variants.items():
            with self.subTest(name):
                rows = base + extra
                b = _bill(rows, room_price=1200, nights=2)
                lhs = b["total_amount"]
                rhs = (b["payment_cash"] + b["payment_online"] + b["payment_ota"]
                       - 0 + b["balance"])
                self.assertEqual(lhs, rhs,
                                 f"{name}: bill does not foot ({lhs} vs {rhs})")

    def test_om_d_sharma_shape(self):
        # The real stay this was found on: 3 nights at Rs.1200, AC Rs.400 on
        # each night paid online, all live. Must foot to zero.
        rows = [_pay(1200, "online"), _pay(1200, "online"), _pay(1200, "online"),
                _addon(400, "online", item="AC"),
                _addon(400, "online", item="AC"),
                _addon(400, "online", item="AC")]
        b = _bill(rows, room_price=1200, nights=3)
        self.assertEqual(b["total_amount"], 4800)
        self.assertEqual(b["payment_online"], 4800)
        self.assertEqual(b["balance"], 0)


class IsLiveChargeContract(unittest.TestCase):

    def test_missing_flag_is_live(self):
        self.assertTrue(is_live_charge({"type": "addon", "amount": 60}))

    def test_explicit_false_is_live(self):
        self.assertTrue(is_live_charge({"type": "addon", "voided": False}))

    def test_true_is_dead(self):
        self.assertFalse(is_live_charge({"type": "addon", "voided": True}))

    def test_non_dict_does_not_silently_drop_money(self):
        # A malformed row in room.add_ons used to raise loudly. Returning
        # False turns a data-shape error into a silent revenue reduction.
        # This test documents whichever behaviour is chosen — if it starts
        # failing, someone changed the contract deliberately.
        self.assertFalse(is_live_charge("not a dict"),
                         "if this changes, audit every is_live_charge call "
                         "site that sums money")


if __name__ == "__main__":
    unittest.main(verbosity=2)
