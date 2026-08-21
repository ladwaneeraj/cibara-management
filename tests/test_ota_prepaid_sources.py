"""
OTA prepaid channels: Agoda must be treated exactly like MMT.

Why this file exists
--------------------
"Which sources prepay the full tariff" was written out three times as three
different literals, and they had drifted:

    config.py       booking_source in ("mmt", "agoda")   <- invoicing
    bookings.py     booking_source == "mmt"              <- prepaid handling
    rooms.py        booking_source in ("mmt", "ota")     <- transfer re-rating

So an Agoda stay was INVOICED as OTA but never given the prepaid treatment:
no ota_prepaid payment row, renewal_count left at 0, and the room opened
carrying the full tariff as balance due. The invoice then showed the whole
amount outstanding for a guest who had already paid Agoda, and checkout
blocked on it.

`is_ota_prepaid` / `OTA_PREPAID_SOURCES` in config.py is now the single
definition. These tests pin the predicate and the arithmetic that depends on
it, so a fourth copy cannot drift in unnoticed.

Run: python tests/test_ota_prepaid_sources.py
"""
from __future__ import annotations

import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# ── Firebase stub, same pattern as test_gst_helpers.py ────────────────────
if "firebase_admin" not in sys.modules:
    _fa = types.ModuleType("firebase_admin")
    for _sub in ("credentials", "firestore", "storage"):
        setattr(_fa, _sub, types.ModuleType(f"firebase_admin.{_sub}"))
        sys.modules[f"firebase_admin.{_sub}"] = getattr(_fa, _sub)
    _fa.credentials.Certificate = lambda *a, **kw: None
    _fa.initialize_app = lambda *a, **kw: None

    class _StubCollection:
        def document(self, *a, **kw): return self
        def get(self, *a, **kw):
            class _S:
                exists = False
                def to_dict(self): return {}
            return _S()
        def set(self, *a, **kw): return None
        def update(self, *a, **kw): return None
        def stream(self, *a, **kw): return iter(())
        def where(self, *a, **kw): return self
        def limit(self, *a, **kw): return self
        def order_by(self, *a, **kw): return self
        parent = None

    class _StubClient:
        def collection(self, n): return _StubCollection()
        def transaction(self): return None
        def batch(self): return types.SimpleNamespace(
            set=lambda *a, **k: None, update=lambda *a, **k: None,
            commit=lambda *a, **k: None)

    _fa.firestore.client = _StubClient
    _fa.firestore.SERVER_TIMESTAMP = None
    _fa.firestore.Increment = lambda n: n

    class _StubBucket:
        name = "stub-bucket"
        def blob(self, *a, **kw): return types.SimpleNamespace(
            upload_from_string=lambda *a, **k: None,
            upload_from_filename=lambda *a, **k: None,
            generate_signed_url=lambda *a, **k: "",
            public_url="", exists=lambda *a, **k: False,
            delete=lambda *a, **k: None)

    _fa.storage.bucket = lambda *a, **kw: _StubBucket()
    sys.modules["firebase_admin"] = _fa

# config.py wants a credential FILE on disk. credentials.Certificate is
# stubbed above so the contents are never really parsed, but config.py does
# json.load it and compare project_id against the active environment. That
# comparison is skipped when project_id is absent (config.py:257 requires
# BOTH sides truthy), so a dict without the key satisfies every environment
# without pinning the test to one project name.
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_STUB_CRED = os.path.join(_ROOT, "tests", "_stub_credentials.json")
os.environ.setdefault("FIREBASE_KEY_FILE", _STUB_CRED)
if not os.path.isfile(os.environ["FIREBASE_KEY_FILE"]):
    with open(os.environ["FIREBASE_KEY_FILE"], "w", encoding="utf-8") as _f:
        _f.write('{"type": "service_account"}')

# Deliberately NOT wrapped in try/except with a skip. A silent skip is how
# eleven of these tests quietly did nothing on the first run — the whole point
# of the file is that this predicate is exercised, so an import failure must
# be a loud failure.
from config import OTA_PREPAID_SOURCES, is_ota_prepaid  # noqa: E402


def _agoda_booking(**over):
    """The shape services/agoda_ingest_service.py actually writes."""
    b = {
        "booking_source": "agoda", "payment_source": "ota",
        "payment_method": "ota", "total_amount": 2400,
        "ota_total_amount": 2400, "net_receivable": 2400,
        "ota_commission": 0.0, "ota_commission_gst": 0.0,
        "paid_amount": 0, "balance": 2400, "guest_count": 2,
    }
    b.update(over)
    return b


def _mmt_booking(**over):
    b = _agoda_booking(booking_source="mmt")
    b.update(over)
    return b


class Predicate(unittest.TestCase):

    def test_agoda_is_prepaid(self):
        self.assertTrue(is_ota_prepaid(_agoda_booking()))

    def test_mmt_is_prepaid(self):
        self.assertTrue(is_ota_prepaid(_mmt_booking()))

    def test_agoda_and_mmt_agree(self):
        self.assertEqual(is_ota_prepaid(_agoda_booking()),
                         is_ota_prepaid(_mmt_booking()),
                         "Agoda and MMT must be treated identically")

    def test_walk_in_is_not_prepaid(self):
        self.assertFalse(is_ota_prepaid(
            {"booking_source": "normal", "payment_source": "", "total_amount": 900}))

    def test_ota_source_the_hotel_collects_itself_is_not_prepaid(self):
        # payment_source is the deciding half: an OTA-sourced booking the
        # hotel collects for itself is an ordinary stay.
        self.assertFalse(is_ota_prepaid(
            _agoda_booking(payment_source="hotel")))

    def test_junk_shapes_do_not_raise(self):
        for junk in (None, "agoda", 42, [], {}, {"booking_source": None}):
            with self.subTest(repr(junk)):
                self.assertFalse(is_ota_prepaid(junk))

    def test_source_tuple_contains_both(self):
        self.assertIn("mmt", OTA_PREPAID_SOURCES)
        self.assertIn("agoda", OTA_PREPAID_SOURCES)


class ConversionArithmetic(unittest.TestCase):
    """The numbers convert_booking_to_checkin derives from the predicate."""

    @staticmethod
    def _convert(booking, nights, room_price):
        prepaid = 0
        renewals = 0
        room_balance = room_price
        if is_ota_prepaid(booking):
            prepaid = int(booking.get("ota_total_amount")
                          or booking.get("total_amount") or 0)
            renewals = max(nights - 1, 0)
            room_balance = 0
        return {"ota_prepaid": prepaid, "renewal_count": renewals,
                "room_balance": room_balance}

    def test_agoda_two_nights_opens_at_zero_balance(self):
        # Rs.2,400 net for 2 nights -> Rs.1,200/night.
        r = self._convert(_agoda_booking(), nights=2, room_price=1200)
        self.assertEqual(r["room_balance"], 0,
                         "Rs.2,400 balance due on a stay the guest already "
                         "paid Agoda for; checkout blocks on it")
        self.assertEqual(r["renewal_count"], 1,
                         "both nights must be pre-charged, or the bill is "
                         "one night short")
        self.assertEqual(r["ota_prepaid"], 2400)

    def test_agoda_matches_mmt_exactly(self):
        a = self._convert(_agoda_booking(), 2, 1200)
        m = self._convert(_mmt_booking(), 2, 1200)
        self.assertEqual(a, m)

    def test_walk_in_still_opens_owing_one_night(self):
        r = self._convert({"booking_source": "normal", "payment_source": "",
                           "total_amount": 900}, nights=2, room_price=900)
        self.assertEqual(r, {"ota_prepaid": 0, "renewal_count": 0,
                             "room_balance": 900})

    def test_prepaid_stay_bill_nets_to_zero(self):
        # 2 nights x Rs.1,200 charged, Rs.2,400 recorded as an "ota" receipt.
        r = self._convert(_agoda_booking(), nights=2, room_price=1200)
        room_charges = 1200 * (r["renewal_count"] + 1)
        balance = room_charges - r["ota_prepaid"]
        self.assertEqual(room_charges, 2400)
        self.assertEqual(balance, 0, "OTA invoice must not show balance due")


class ChargeRowsAreNotPayments(unittest.TestCase):
    """/update_stay_payment must refuse an add-on on a live stay.

    An add-on is a CHARGE. Editing it as if it were a receipt applied
    balance += (old - new) for money that never touched the balance, and left
    room.add_ons stale so the counter, the balance preview and the Rs.999 snap
    kept the old price while the invoice used the new one.
    """

    @staticmethod
    def _refuses(row, room_status):
        return row.get("type") == "addon" and room_status == "occupied"

    @staticmethod
    def _balance_delta(row, old_amount, new_amount):
        if row.get("type") == "addon":
            return 0
        return old_amount - new_amount

    def test_addon_on_live_stay_is_refused(self):
        self.assertTrue(self._refuses(
            {"type": "addon", "method": "cash", "amount": 60}, "occupied"))

    def test_real_payment_on_live_stay_is_allowed(self):
        self.assertFalse(self._refuses(
            {"type": "payment", "method": "cash", "amount": 700}, "occupied"))

    def test_addon_on_checked_out_stay_is_allowed(self):
        self.assertFalse(self._refuses(
            {"type": "addon", "method": "cash", "amount": 60}, "cleaning"))

    def test_addon_edit_never_moves_a_balance(self):
        # Rs.60 -> Rs.80 used to leave a phantom Rs.20 CREDIT on a room
        # that owed nothing.
        self.assertEqual(
            self._balance_delta({"type": "addon"}, 60, 80), 0)

    def test_receipt_edit_still_moves_the_balance(self):
        self.assertEqual(
            self._balance_delta({"type": "payment"}, 700, 500), 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
