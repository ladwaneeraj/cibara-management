"""
End-to-end scenario matrix for billing and GST.

Where test_bill_render.py guards the LAYOUT of the invoice, this file guards
the MONEY. It drives whole stays through config.compute_daily_folio and
config.bill_tax_breakup and asserts, for every realistic booking shape, that:

  * the invoice foots — line items, tax summary and grand total agree;
  * Taxable x Rate == tax on every rate-wise row, which is what the GSTN
    offline utility recomputes and what rejects a return when it disagrees;
  * the tax the guest is shown is the tax that will be filed;
  * the two view modes are money-identical.

Scenarios: walk-in cash, OTA/MMT prepaid, advance booking with deposit,
room transfer mid-stay, rate change mid-stay, slab-crossing stays, add-ons,
on-invoice discounts, partial and full refunds, overpayment, balance due,
B2B / B2CL / B2C, out-of-state recipients, exempt-only stays, long stays,
legacy pre-folio bills, and zero/degenerate inputs.

Firebase is stubbed, as in test_gst_helpers.py — nothing here touches
Firestore.
"""
from __future__ import annotations

import os
import re
import sys
import types
import unittest
from datetime import datetime

# ── Firebase / Flask stubs ────────────────────────────────────────────────
_fa = types.ModuleType("firebase_admin")
for _sub in ("credentials", "firestore", "storage", "auth"):
    setattr(_fa, _sub, types.ModuleType(f"firebase_admin.{_sub}"))
    sys.modules[f"firebase_admin.{_sub}"] = getattr(_fa, _sub)
_fa.credentials.Certificate = lambda *a, **kw: None
_fa.initialize_app = lambda *a, **kw: None
_fa.auth.verify_id_token = lambda *a, **kw: {}


class _StubCollection:
    def document(self, *a, **kw): return self
    def get(self, *a, **kw):
        class _S:
            exists = False
            def to_dict(self): return {}
            def get(self, k, **kw): return None
        return _S()
    def set(self, *a, **kw): return None
    def update(self, *a, **kw): return None
    def stream(self, *a, **kw): return iter(())
    def where(self, *a, **kw): return self
    def limit(self, *a, **kw): return self
    def order_by(self, *a, **kw): return self
    parent = None


class _StubBatch:
    def set(self, *a, **kw): return None
    def update(self, *a, **kw): return None
    def commit(self, *a, **kw): return None


class _StubClient:
    def collection(self, n): return _StubCollection()
    def transaction(self): return None
    def batch(self): return _StubBatch()


_fa.firestore.client = _StubClient
_fa.firestore.transactional = lambda fn: fn
_fa.firestore.SERVER_TIMESTAMP = "STUB"
_fa.firestore.Increment = lambda v: v


class _FF:
    def __init__(self, *a, **kw): pass


_fa.firestore.FieldFilter = _FF
_fa.firestore.ArrayUnion = lambda v: v
_fa.storage.bucket = lambda: types.SimpleNamespace(name="stub", blob=lambda p: None)
sys.modules["firebase_admin"] = _fa

_gcf = types.ModuleType("google.cloud.firestore_v1.base_query")
_gcf.FieldFilter = _FF
sys.modules.setdefault("google", types.ModuleType("google"))
sys.modules.setdefault("google.cloud", types.ModuleType("google.cloud"))
sys.modules.setdefault("google.cloud.firestore_v1", types.ModuleType("google.cloud.firestore_v1"))
sys.modules["google.cloud.firestore_v1.base_query"] = _gcf

os.environ.setdefault("CIBARA_ENV", "UAT")
os.environ.setdefault("FIREBASE_KEY_FILE", "cibara-dev.json")

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

import config                      # noqa: E402
from routes import billing         # noqa: E402


CHECKIN = datetime(2026, 8, 1, 14, 0)


# ══════════════════════════════════════════════════════════════════════════
# Builder — assembles a bill the way create_bill_record does, so the tests
# exercise the real folio rather than hand-written per-night figures.
# ══════════════════════════════════════════════════════════════════════════

def make_bill(*, nights=1, rate=900, room="101", services=None, discount=0,
              cash=0, online=0, ota=0, refunds=0, refund_cash=0,
              refund_online=0, segments=None, invoice_type="B2C",
              recipient_gstin="", recipient_state="Karnataka",
              recipient_state_code="29", bill_number="CC/2026/08/00001",
              guest="Test Guest", folio=True):
    """Build a bill record with a real daily_folio."""
    services = services or []
    accom_services = [s for s in services if s.get("accommodation_charge")]

    daily_folio = []
    if folio:
        daily_folio = config.compute_daily_folio(
            checkin_dt=CHECKIN,
            days_stayed=nights,
            room_price_per_night=rate,
            current_room_no=room,
            accommodation_services=accom_services,
            pre_transfer_charges=segments or [],
            discount_on_accom=discount,
            recipient_state_code=recipient_state_code,
        )

    room_charges_total = (sum(s.get("total", 0) for s in (segments or []))
                          + rate * (nights - sum(s.get("days", 0)
                                                 for s in (segments or []))))
    services_total = sum(s.get("price", 0) for s in services)
    accom_total = sum(e["day_total"] for e in daily_folio) if daily_folio else \
        room_charges_total - discount
    non_accom = sum(s.get("price", 0) for s in services
                    if not s.get("accommodation_charge"))
    total_amount = round(accom_total + non_accom, 2)

    gst_amount = round(sum(e["day_gst_amount"] for e in daily_folio), 2) if daily_folio else 0
    accommodation_taxable = round(sum(e["day_taxable"] for e in daily_folio), 2) if daily_folio else 0
    rates = {e["day_gst_rate"] for e in daily_folio} if daily_folio else {0}

    return {
        "id": "test", "bill_number": bill_number,
        "guest_name": guest, "guest_mobile": "9999999999",
        "room": room, "guest_count": 2,
        "checkin_time": CHECKIN.strftime("%Y-%m-%d %H:%M"),
        "checkout_time": "2026-08-%02d 11:00" % min(1 + nights, 28),
        "days_stayed": nights,
        "room_price_per_night": rate,
        "room_charges_total": room_charges_total,
        "room_segments": segments or [],
        "services": services, "services_total": services_total,
        "non_accommodation_total": non_accom,
        "discounts": discount,
        "gst_rate": max(rates) if rates else 0,
        "gst_amount": gst_amount,
        "accommodation_taxable": accommodation_taxable,
        "total_amount": total_amount,
        "payment_cash": cash, "payment_online": online, "payment_ota": ota,
        "refunds": refunds, "refund_cash": refund_cash,
        "refund_online": refund_online,
        "balance": round(total_amount - cash - online - ota + refunds, 2),
        "invoice_type": invoice_type,
        "recipient_gstin": recipient_gstin,
        "recipient_legal_name": "Acme Pvt Ltd" if recipient_gstin else "",
        "recipient_state": recipient_state,
        "recipient_state_code": recipient_state_code,
        "daily_folio": daily_folio,
    }


# ══════════════════════════════════════════════════════════════════════════
# Shared assertions — every scenario runs through these
# ══════════════════════════════════════════════════════════════════════════

class BillAssertions(unittest.TestCase):

    def assert_rows_self_consistent(self, bill, label=""):
        """Taxable x Rate must equal the tax on every rate-wise row.

        This is the check the GSTN offline utility performs. A row that fails
        it materially is a row that gets rejected or silently restated.

        Tolerance scales with the number of rounding events. Each night is its
        own supply and its tax is rounded to the paisa when the folio is
        written, so a row aggregating N nights can differ from
        taxable x rate by up to half a paisa per night. That drift is
        unavoidable while per-night rounding is correct, and it is the right
        trade: the HARD invariant is that taxable + tax equals the amount
        actually charged (assert_invoice_reconciles), because that is the
        number the guest pays. Recomputing tax as taxable x rate would fix
        this row check and break that one.
        """
        bt = config.bill_tax_breakup(bill)
        nights = max(len(bill.get("daily_folio") or []), 1)
        tolerance = max(0.02, 0.005 * nights + 0.01)
        for r in bt["rows"]:
            expected = round(r["taxable"] * r["rate"] / 100.0, 2)
            actual = round(r["cgst"] + r["sgst"] + r["igst"], 2)
            self.assertAlmostEqual(
                expected, actual, delta=tolerance,
                msg=(f"{label}: row {r['hsn']} @ {r['rate']}% — "
                     f"taxable {r['taxable']} x {r['rate']}% = {expected}, "
                     f"but tax is {actual} (tolerance {tolerance:.2f} "
                     f"for {nights} night(s))"))

    def assert_totals_match_rows(self, bill, label=""):
        """Printed totals must equal the sum of the printed rows."""
        bt = config.bill_tax_breakup(bill)
        for key in ("taxable", "cgst", "sgst", "igst", "tax"):
            self.assertAlmostEqual(
                bt[key], round(sum(r[key if key != "tax" else "tax"]
                                   for r in bt["rows"]), 2), delta=0.02,
                msg=f"{label}: total {key} does not equal the sum of its rows")

    def assert_no_igst(self, bill, label=""):
        """A lodge is never an inter-state supplier — Section 12(3)(b)."""
        bt = config.bill_tax_breakup(bill)
        self.assertEqual(bt["igst"], 0.0,
                         f"{label}: IGST charged on a local supply")

    def assert_invoice_reconciles(self, bill, label=""):
        """Accommodation taxable + tax must equal the accommodation charged."""
        folio = bill.get("daily_folio") or []
        if not folio:
            return
        bt = config.bill_tax_breakup(bill)
        accom_rows = [r for r in bt["rows"] if r["category"] == "accommodation"]
        gross_from_rows = round(sum(r["taxable"] + r["cgst"] + r["sgst"] + r["igst"]
                                    for r in accom_rows), 2)
        gross_from_folio = round(sum(e["day_total"] for e in folio), 2)
        # HARD invariant, no scaling tolerance: the tax summary must account
        # for exactly the accommodation that was charged. This is the number
        # the guest pays.
        self.assertAlmostEqual(
            gross_from_rows, gross_from_folio, delta=0.01,
            msg=(f"{label}: tax summary accounts for {gross_from_rows} of "
                 f"accommodation but the folio charged {gross_from_folio}"))

    def assert_views_identical(self, bill, label=""):
        c = billing._build_bill_html(bill, view="consolidated")
        d = billing._build_bill_html(bill, view="detailed")
        gt = lambda h: re.search(r'GRAND TOTAL.*?([\d.]+)</td>', h, re.S).group(1)
        self.assertEqual(gt(c), gt(d), f"{label}: grand total differs by view")
        self.assertEqual(c.split("b-tax-summary")[1:], d.split("b-tax-summary")[1:],
                         f"{label}: tax summary differs by view")

    def assert_renders(self, bill, label=""):
        for view in ("consolidated", "detailed"):
            html = billing._build_bill_html(bill, view=view)
            self.assertIn("TAX INVOICE", html, f"{label}/{view}: no invoice")
            self.assertIn("GRAND TOTAL", html)
            self.assertIn("Karnataka (29)", html)

    def check(self, bill, label):
        """Run the whole battery against one bill."""
        self.assert_rows_self_consistent(bill, label)
        self.assert_totals_match_rows(bill, label)
        self.assert_no_igst(bill, label)
        self.assert_invoice_reconciles(bill, label)
        self.assert_views_identical(bill, label)
        self.assert_renders(bill, label)


# ══════════════════════════════════════════════════════════════════════════
# Booking-type scenarios
# ══════════════════════════════════════════════════════════════════════════

class TestWalkIn(BillAssertions):

    def test_walk_in_cash_one_night_exempt(self):
        b = make_bill(nights=1, rate=900, cash=900)
        self.check(b, "walk-in exempt")
        self.assertEqual(b["balance"], 0)
        self.assertEqual(config.bill_tax_breakup(b)["tax"], 0.0)

    def test_walk_in_cash_one_night_taxable(self):
        b = make_bill(nights=1, rate=2000, cash=2000)
        self.check(b, "walk-in 5%")
        bt = config.bill_tax_breakup(b)
        self.assertEqual(bt["rows"][0]["rate"], 5)
        self.assertAlmostEqual(bt["tax"], 95.24, delta=0.02)

    def test_walk_in_luxury_18_percent(self):
        b = make_bill(nights=1, rate=9000, online=9000)
        self.check(b, "walk-in 18%")
        bt = config.bill_tax_breakup(b)
        self.assertEqual(bt["rows"][0]["rate"], 18)
        self.assertAlmostEqual(bt["tax"], 1372.88, delta=0.02)

    def test_walk_in_split_payment(self):
        b = make_bill(nights=2, rate=1200, cash=1000, online=1400)
        self.check(b, "walk-in split payment")
        self.assertEqual(b["balance"], 0)
        html = billing._build_bill_html(b)
        self.assertIn("Cash Paid", html)
        self.assertIn("Online / UPI Paid", html)

    def test_walk_in_with_balance_due(self):
        b = make_bill(nights=2, rate=1200, cash=1000)
        self.check(b, "walk-in balance due")
        self.assertGreater(b["balance"], 0)
        self.assertIn("Balance Due", billing._build_bill_html(b))


class TestOTA(BillAssertions):
    """MMT / Booking.com: the channel collects the room charge up front."""

    def test_ota_fully_prepaid(self):
        b = make_bill(nights=3, rate=1500, ota=4500)
        self.check(b, "OTA prepaid")
        self.assertEqual(b["balance"], 0)
        html = billing._build_bill_html(b)
        self.assertIn("Paid via MMT (OTA)", html)
        # The payment block must foot: cash + online + OTA == Total Paid.
        pay = html.split("b-pay-section")[1]
        total = re.search(r'Total Paid</td><td[^>]*>[^\d]*([\d.]+)', pay).group(1)
        self.assertEqual(total, "4500.00")

    def test_ota_prepaid_room_plus_cash_extras(self):
        """Room prepaid to the OTA, incidentals settled at the desk."""
        b = make_bill(nights=2, rate=1500, ota=3000, cash=140,
                      services=[
                          {"item": "Water 1L", "quantity": 2,
                           "unit_price": 20, "price": 40},
                          {"item": "Laundry", "quantity": 1,
                           "unit_price": 100, "price": 100},
                      ])
        self.check(b, "OTA + desk extras")
        self.assertEqual(b["balance"], 0)
        bt = config.bill_tax_breakup(b)
        hsns = {r["hsn"] for r in bt["rows"]}
        self.assertIn("2201", hsns, "water not taxed")
        self.assertIn("999721", hsns, "laundry not taxed")

    def test_ota_tax_is_charged_even_though_guest_paid_channel(self):
        """GST is on the supply, not on who collected the money."""
        b = make_bill(nights=2, rate=2000, ota=4000)
        self.assertGreater(config.bill_tax_breakup(b)["tax"], 0)

    def test_ota_does_not_appear_when_zero(self):
        b = make_bill(nights=1, rate=900, cash=900)
        self.assertNotIn("Paid via MMT (OTA)", billing._build_bill_html(b))


class TestAdvanceBooking(BillAssertions):

    def test_booking_with_advance_then_balance_on_arrival(self):
        b = make_bill(nights=4, rate=1800, online=3000, cash=4200)
        self.check(b, "advance booking")
        self.assertEqual(b["balance"], 0)

    def test_booking_overpaid_refund_due(self):
        b = make_bill(nights=1, rate=1500, online=2000)
        self.check(b, "overpaid booking")
        self.assertIn("OVERPAID", billing._build_bill_html(b))

    def test_booking_with_partial_refund(self):
        b = make_bill(nights=3, rate=1500, online=4500,
                      refunds=1500, refund_online=1500)
        self.check(b, "booking partial refund")
        html = billing._build_bill_html(b)
        self.assertIn("Refund Given (UPI)", html)
        self.assertIn("Net Collected", html)


# ══════════════════════════════════════════════════════════════════════════
# Stay shapes that break naive tax math
# ══════════════════════════════════════════════════════════════════════════

class TestRoomTransfer(BillAssertions):

    def test_transfer_to_dearer_room_midstay(self):
        """Two nights at 1,000 then one at 8,000. Naive rate x days would
        bill 24,000 at 18%; the real supply is 10,000 across two slabs."""
        b = make_bill(nights=3, rate=8000, room="205",
                      segments=[{"from_room": "101", "days": 2,
                                 "price": 1000, "total": 2000}],
                      cash=10000)
        self.check(b, "room transfer")
        bt = config.bill_tax_breakup(b)
        rates = sorted(r["rate"] for r in bt["rows"])
        self.assertEqual(rates, [5, 18], "transfer must produce two rate rows")
        gross = sum(r["taxable"] + r["cgst"] + r["sgst"] for r in bt["rows"])
        self.assertAlmostEqual(gross, 10000, delta=0.05)

    def test_transfer_keeps_both_rooms_on_the_invoice(self):
        b = make_bill(nights=3, rate=8000, room="205",
                      segments=[{"from_room": "101", "days": 2,
                                 "price": 1000, "total": 2000}])
        html = billing._build_bill_html(b, view="detailed")
        self.assertIn("Rm 101", html)
        self.assertIn("Rm 205", html)


class TestSlabBoundaries(BillAssertions):

    def test_exactly_1000_is_taxable(self):
        self.assertEqual(config._slab_for_value(1000), 5)

    def test_just_below_1000_is_exempt(self):
        self.assertEqual(config._slab_for_value(999.99), 0)

    def test_exactly_7500_is_five_percent(self):
        self.assertEqual(config._slab_for_value(7500), 5)

    def test_just_above_7500_is_eighteen(self):
        self.assertEqual(config._slab_for_value(7500.01), 18)

    def test_stay_crossing_a_slab_produces_two_rows(self):
        """The defect that made GSTR-1 rows fail Taxable x Rate: an add-on
        pushes Day 1 over the threshold while Day 2 stays exempt."""
        b = make_bill(nights=2, rate=950, cash=2100,
                      services=[{"item": "AC Charge", "quantity": 1,
                                 "unit_price": 200, "price": 200,
                                 "accommodation_charge": True,
                                 "applied_on_day": 1}])
        self.check(b, "slab-crossing stay")
        bt = config.bill_tax_breakup(b)
        rates = sorted(r["rate"] for r in bt["rows"]
                       if r["category"] == "accommodation")
        self.assertEqual(rates, [0, 5],
                         "exempt night must not be filed at 5%")
        five = next(r for r in bt["rows"] if r["rate"] == 5)
        self.assertAlmostEqual(five["taxable"] * 0.05,
                               five["cgst"] + five["sgst"], delta=0.05)

    def test_addon_pushes_exempt_night_into_tax(self):
        """900 room + 300 extra bed = 1,200 value of supply -> 5%,
        not exempt-because-the-room-was-900."""
        b = make_bill(nights=1, rate=900, cash=1200,
                      services=[{"item": "Extra Bed", "quantity": 1,
                                 "unit_price": 300, "price": 300,
                                 "accommodation_charge": True,
                                 "applied_on_day": 1}])
        self.check(b, "addon crosses threshold")
        bt = config.bill_tax_breakup(b)
        self.assertEqual(bt["rows"][0]["rate"], 5)
        self.assertAlmostEqual(bt["tax"], 57.14, delta=0.05)


class TestDiscounts(BillAssertions):

    def test_discount_reduces_taxable_value(self):
        """Section 15(3)(a): an on-invoice discount is out of the value."""
        full = make_bill(nights=1, rate=2000, cash=2000)
        disc = make_bill(nights=1, rate=2000, discount=500, cash=1500)
        self.check(disc, "discounted")
        self.assertLess(config.bill_tax_breakup(disc)["tax"],
                        config.bill_tax_breakup(full)["tax"])

    def test_discount_across_the_threshold_makes_it_exempt(self):
        """1,200 room less a 400 discount = 800 value of supply -> exempt."""
        b = make_bill(nights=1, rate=1200, discount=400, cash=800)
        self.check(b, "discount to exempt")
        self.assertEqual(config.bill_tax_breakup(b)["tax"], 0.0)

    def test_full_waiver_is_exempt_not_negative(self):
        b = make_bill(nights=1, rate=1200, discount=1200)
        self.check(b, "full waiver")
        bt = config.bill_tax_breakup(b)
        self.assertEqual(bt["tax"], 0.0)
        self.assertGreaterEqual(bt["taxable"], 0.0)

    def test_discount_shown_once_on_a_folio_bill(self):
        b = make_bill(nights=2, rate=1500, discount=300, cash=2700)
        html = billing._build_bill_html(b)
        self.assertEqual(html.count("Discount"), html.count("Less: Discount"),
                         "bill-level discount row duplicates the per-day rows")


class TestServices(BillAssertions):

    def test_each_service_class_gets_its_own_rate(self):
        b = make_bill(nights=1, rate=900, cash=1290, services=[
            {"item": "Water 1L", "quantity": 2, "unit_price": 20, "price": 40},
            {"item": "Coke", "quantity": 1, "unit_price": 50, "price": 50},
            {"item": "Laundry", "quantity": 1, "unit_price": 300, "price": 300},
        ])
        self.check(b, "mixed services")
        bt = config.bill_tax_breakup(b)
        by_hsn = {r["hsn"]: r["rate"] for r in bt["rows"]}
        self.assertEqual(by_hsn.get("2201"), 5)     # water
        self.assertEqual(by_hsn.get("2202"), 12)    # cold drink
        self.assertEqual(by_hsn.get("999721"), 18)  # laundry

    def test_explicit_hsn_on_the_record_wins_over_keywords(self):
        b = make_bill(nights=1, rate=900, services=[
            {"item": "Water 1L", "quantity": 1, "unit_price": 20, "price": 20,
             "hsn_or_sac": "9999", "gst_rate": 28, "tax_category": "goods"},
        ])
        bt = config.bill_tax_breakup(b)
        self.assertIn(("9999", 28),
                      [(r["hsn"], r["rate"]) for r in bt["rows"]])

    def test_uncategorised_service_is_exempt_not_guessed(self):
        b = make_bill(nights=1, rate=900, services=[
            {"item": "Security Deposit", "quantity": 1,
             "unit_price": 500, "price": 500},
        ])
        self.check(b, "uncategorised service")
        bt = config.bill_tax_breakup(b)
        self.assertNotIn("Security Deposit",
                         [r["description"] for r in bt["rows"] if r["rate"] > 0])
        self.assertGreaterEqual(bt["exempt_value"], 500)

    def test_repeat_sales_merge_into_one_row(self):
        b = make_bill(nights=1, rate=900, services=[
            {"item": "Water 1L", "quantity": 1, "unit_price": 20, "price": 20},
            {"item": "Water 1L", "quantity": 1, "unit_price": 20, "price": 20},
        ])
        bt = config.bill_tax_breakup(b)
        water = [r for r in bt["rows"] if r["hsn"] == "2201"]
        self.assertEqual(len(water), 1)
        self.assertAlmostEqual(water[0]["taxable"] + water[0]["tax"], 40, delta=0.02)


# ══════════════════════════════════════════════════════════════════════════
# Recipient classification and place of supply
# ══════════════════════════════════════════════════════════════════════════

class TestRecipientTypes(BillAssertions):

    def test_b2c_local(self):
        b = make_bill(nights=1, rate=2000, cash=2000)
        self.check(b, "B2C")
        self.assertNotIn("BILL TO", billing._build_bill_html(b))

    def test_b2b_local_shows_recipient_block(self):
        b = make_bill(nights=1, rate=2000, cash=2000, invoice_type="B2B",
                      recipient_gstin="29AAAAA0000A1Z5")
        self.check(b, "B2B local")
        html = billing._build_bill_html(b)
        self.assertIn("BILL TO (Recipient", html)
        self.assertIn("29AAAAA0000A1Z5", html)

    def test_b2b_out_of_state_still_cgst_sgst(self):
        """Section 12(3)(b): place of supply is the property. Charging IGST
        here would contradict the stored bill and break the guest's ITC."""
        b = make_bill(nights=1, rate=2000, cash=2000, invoice_type="B2B",
                      recipient_gstin="27AAAAA0000A1Z5",
                      recipient_state="Maharashtra", recipient_state_code="27")
        self.check(b, "B2B Maharashtra")
        html = billing._build_bill_html(b)
        self.assertIn("Karnataka (29) &ndash; CGST+SGST", html)
        self.assertNotIn("IGST @", html)
        self.assertIn("Maharashtra (27)", html)   # in BILL TO only

    def test_b2cl_out_of_state_still_cgst_sgst(self):
        b = make_bill(nights=1, rate=9000, cash=9000, invoice_type="B2CL",
                      recipient_state="Kerala", recipient_state_code="32")
        self.check(b, "B2CL Kerala")
        self.assertNotIn("IGST @", billing._build_bill_html(b))


# ══════════════════════════════════════════════════════════════════════════
# Long stays, legacy records and degenerate input
# ══════════════════════════════════════════════════════════════════════════

class TestLongStays(BillAssertions):

    def test_thirty_night_stay(self):
        b = make_bill(nights=30, rate=1200, cash=36000)
        self.check(b, "30 nights")
        bt = config.bill_tax_breakup(b)
        gross = sum(r["taxable"] + r["cgst"] + r["sgst"] for r in bt["rows"])
        self.assertAlmostEqual(gross, 36000, delta=0.5)

    def test_long_stay_consolidates_to_one_block(self):
        b = make_bill(nights=30, rate=1200)
        html = billing._build_bill_html(b, view="consolidated")
        self.assertIn("30 nights", html)
        self.assertEqual(html.count("b-day-header"), 1)

    def test_rounding_drift_stays_within_a_paisa_per_night(self):
        b = make_bill(nights=30, rate=1111, cash=33330)
        bt = config.bill_tax_breakup(b)
        gross = sum(r["taxable"] + r["cgst"] + r["sgst"] for r in bt["rows"])
        self.assertAlmostEqual(gross, 33330, delta=0.30)


class TestLegacyBills(BillAssertions):

    def test_pre_folio_bill_uses_stored_aggregates(self):
        b = make_bill(nights=2, rate=2000, cash=4000, folio=False)
        b["accommodation_taxable"] = 3809.52
        b["gst_amount"] = 190.48
        b["gst_rate"] = 5
        bt = config.bill_tax_breakup(b)
        self.assertEqual(bt["source"], "aggregate")
        self.assert_rows_self_consistent(b, "legacy aggregate")
        self.assert_no_igst(b, "legacy aggregate")

    def test_bill_with_nothing_stored_recomputes(self):
        b = make_bill(nights=2, rate=2000, cash=4000, folio=False)
        b["accommodation_taxable"] = 0
        b["gst_amount"] = 0
        bt = config.bill_tax_breakup(b)
        self.assertEqual(bt["source"], "legacy")
        self.assertEqual(bt["rows"][0]["rate"], 5)
        self.assert_rows_self_consistent(b, "legacy recompute")

    def test_legacy_recompute_nets_the_discount_before_picking_the_slab(self):
        b = make_bill(nights=1, rate=1200, discount=400, folio=False)
        b["accommodation_taxable"] = 0
        b["gst_amount"] = 0
        bt = config.bill_tax_breakup(b)
        self.assertEqual(bt["tax"], 0.0, "post-discount value 800 is exempt")


class TestDegenerateInput(BillAssertions):

    def test_empty_bill(self):
        bt = config.bill_tax_breakup({})
        self.assertEqual(bt["rows"], [])
        self.assertEqual(bt["tax"], 0.0)
        self.assertIn("TAX INVOICE", billing._build_bill_html({}))

    def test_none_bill(self):
        self.assertEqual(config.bill_tax_breakup(None)["tax"], 0.0)

    def test_zero_night_stay(self):
        b = make_bill(nights=0, rate=1000)
        self.assertIn("TAX INVOICE", billing._build_bill_html(b))

    def test_zero_rate_stay(self):
        b = make_bill(nights=2, rate=0)
        self.check(b, "zero rate")
        self.assertEqual(config.bill_tax_breakup(b)["tax"], 0.0)

    def test_garbage_numeric_fields_do_not_raise(self):
        b = make_bill(nights=1, rate=1000)
        b["gst_amount"] = "not-a-number"
        b["accommodation_taxable"] = None
        config.bill_tax_breakup(b)
        billing._build_bill_html(b)

    def test_service_with_no_price(self):
        b = make_bill(nights=1, rate=900, services=[
            {"item": "Water 1L", "quantity": 1},
        ])
        self.check(b, "priceless service")


# ══════════════════════════════════════════════════════════════════════════
# Cross-surface consistency: invoice == what the client is told
# ══════════════════════════════════════════════════════════════════════════

class TestInvoiceMatchesRegisterPayload(BillAssertions):
    """The register payload and the invoice must be the same numbers.

    They are produced by the same call, so this is really a guard that nobody
    reintroduces a second computation later.
    """

    SCENARIOS = [
        ("walk-in exempt",   dict(nights=1, rate=900, cash=900)),
        ("walk-in 5%",       dict(nights=2, rate=2000, cash=4000)),
        ("walk-in 18%",      dict(nights=1, rate=9000, cash=9000)),
        ("OTA prepaid",      dict(nights=3, rate=1500, ota=4500)),
        ("discounted",       dict(nights=2, rate=2000, discount=500, cash=3500)),
        ("with services",    dict(nights=1, rate=900, cash=1240, services=[
            {"item": "Water 1L", "quantity": 2, "unit_price": 20, "price": 40},
            {"item": "Laundry", "quantity": 1, "unit_price": 300, "price": 300},
        ])),
        ("room transfer",    dict(nights=3, rate=8000, room="205",
                                  segments=[{"from_room": "101", "days": 2,
                                             "price": 1000, "total": 2000}])),
    ]

    def test_every_scenario_agrees_and_reconciles(self):
        for label, kwargs in self.SCENARIOS:
            with self.subTest(scenario=label):
                bill = make_bill(**kwargs)
                self.check(bill, label)

                # The figures the invoice prints come from the same breakup
                # the register payload ships.
                bt = config.bill_tax_breakup(bill)
                html = billing._build_bill_html(bill)
                if bt["tax"] > 0:
                    self.assertIn(f"{bt['tax']:.2f}", html,
                                  f"{label}: total tax not printed on invoice")
                for r in bt["rows"]:
                    self.assertIn(r["hsn"], html,
                                  f"{label}: {r['hsn']} missing from invoice")

    def test_breakup_is_deterministic(self):
        b = make_bill(nights=3, rate=1500, cash=4500)
        self.assertEqual(config.bill_tax_breakup(b),
                         config.bill_tax_breakup(b))


class TestPdfForEveryScenario(BillAssertions):
    """Every scenario must convert to PDF without an unrenderable glyph."""

    _SAFE = set(range(0xA0, 0x100)) | {
        0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x2122}

    def test_all_scenarios_produce_a_clean_pdf(self):
        try:
            from xhtml2pdf import pisa
        except ImportError:
            self.skipTest("xhtml2pdf not installed")
        import io
        for label, kwargs in TestInvoiceMatchesRegisterPayload.SCENARIOS:
            with self.subTest(scenario=label):
                bill = make_bill(**kwargs)
                full = billing._build_pdf_html(
                    billing._build_bill_html(bill, view="consolidated"))
                self.assertNotIn("₹", full)
                text = re.sub(r"<[^>]+>", "", full)
                bad = sorted({c for c in text
                              if ord(c) > 0x7F and ord(c) not in self._SAFE})
                self.assertEqual(bad, [], f"{label}: unrenderable {bad}")
                buf = io.BytesIO()
                self.assertFalse(pisa.CreatePDF(full, dest=buf).err)
                self.assertGreater(len(buf.getvalue()), 1000)


class TestCreditNote(BillAssertions):

    def _cn(self, **over):
        cn = {
            "cn_number": "CN/2026/08/0001", "cn_date": "2026-08-10",
            "against_bill_number": "CC/2026/08/00001",
            "against_invoice_date": "2026-08-03",
            "guest_name": "Test Guest", "room": "101",
            "reason": "post_sale_discount",
            "credit_amount_taxable": 1904.76,
            "credit_amount_cgst": 47.62, "credit_amount_sgst": 47.62,
            "credit_amount_igst": 0.0, "credit_amount_total": 2000.0,
            "gst_rate": 5, "sac_or_hsn": "9963",
        }
        cn.update(over)
        return cn

    def test_credit_note_renders(self):
        html = billing._build_credit_note_html(self._cn())
        self.assertIn("CREDIT NOTE", html)
        self.assertIn("CN/2026/08/0001", html)
        self.assertIn("TOTAL CREDIT", html)

    def test_credit_note_shares_the_invoice_letterhead(self):
        """The two documents used to carry separate copies of the supplier
        block, and the credit note's had already lost the phone line."""
        inv = billing._build_bill_html(make_bill(nights=1, rate=900))
        cn = billing._build_credit_note_html(self._cn())
        for marker in ("CIBARA COMFORTS", "A Unit of Cibara Enterprise",
                       "Ph: +91 9482831381", "GSTIN: 29AAWFC1962B1Z9"):
            self.assertIn(marker, inv)
            self.assertIn(marker, cn, f"credit note missing {marker!r}")

    def test_credit_note_uses_the_rupee_glyph_like_the_invoice(self):
        self.assertIn("₹", billing._build_credit_note_html(self._cn()))

    def test_credit_note_never_charges_igst(self):
        cn = self._cn(recipient_state="Maharashtra", recipient_state_code="27")
        html = billing._build_credit_note_html(cn)
        self.assertIn("CGST", html)
        self.assertNotIn("IGST @", html)
        self.assertIn("Karnataka (29) &ndash; CGST+SGST", html)

    def test_legacy_igst_credit_note_is_folded_back(self):
        """A CN written while the renderer still branched on recipient state
        can carry IGST the original invoice never charged."""
        cn = self._cn(credit_amount_cgst=0, credit_amount_sgst=0,
                      credit_amount_igst=95.24)
        html = billing._build_credit_note_html(cn)
        self.assertIn("47.62", html)          # split back into halves
        self.assertNotIn("IGST @", html)

    def test_credit_note_pdf_is_clean(self):
        try:
            from xhtml2pdf import pisa
        except ImportError:
            self.skipTest("xhtml2pdf not installed")
        import io
        full = billing._build_pdf_html(billing._build_credit_note_html(self._cn()))
        self.assertNotIn("₹", full)
        buf = io.BytesIO()
        self.assertFalse(pisa.CreatePDF(full, dest=buf).err)


class TestSingleSlabDefinition(unittest.TestCase):
    """The slab table was written out seven times across three files."""

    def test_billing_uses_the_config_definition(self):
        src = open(os.path.join(_REPO, "routes", "billing.py"),
                   encoding="utf8").read()
        self.assertNotIn("if price < 1000:", src,
                         "routes/billing.py re-implements the slab table")

    def test_javascript_no_longer_computes_tax(self):
        src = open(os.path.join(_REPO, "static", "bills.js"),
                   encoding="utf8").read()
        for banned in ("function gstAmounts", "function accomGst",
                       "function waterGst", "function accomTaxFromEntry"):
            self.assertNotIn(banned, src,
                             f"bills.js still defines {banned}")

    def test_config_has_exactly_one_slab_definition(self):
        src = open(os.path.join(_REPO, "config.py"), encoding="utf8").read()
        self.assertEqual(src.count("if v <= 7500:"), 1)
        self.assertEqual(src.count("elif price <= 7500:"), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestCancelledBills(BillAssertions):
    """Reverting a bill keeps its figures for audit but zeroes its liability."""

    def test_cancelled_bill_reports_no_tax(self):
        b = make_bill(nights=2, rate=2000, cash=4000)
        self.assertGreater(config.bill_tax_breakup(b)["tax"], 0)
        b["status"] = "cancelled"
        bt = config.bill_tax_breakup(b)
        self.assertEqual(bt["tax"], 0.0)
        self.assertEqual(bt["rows"], [])
        self.assertEqual(bt["source"], "cancelled")

    def test_cancelled_bill_keeps_its_stored_figures_for_audit(self):
        b = make_bill(nights=2, rate=2000, cash=4000)
        b["status"] = "cancelled"
        self.assertGreater(b["gst_amount"], 0)
        self.assertTrue(b["daily_folio"])


class TestTaxHeadSplit(BillAssertions):
    """CGST and SGST must be equal halves on an intra-state supply.

    Caught by mutation testing: setting `day_cgst = day_gst` (instead of half)
    leaves CGST+SGST unchanged, so every total still reconciled and the whole
    suite passed — while the invoice showed CGST 95.24 / SGST 0.00. GSTR-1
    requires the two heads to be equal for an intra-state supply, so that would
    have filed wrong while looking right.
    """

    def _assert_halves(self, bill, label):
        bt = config.bill_tax_breakup(bill)
        for r in bt["rows"]:
            if r["rate"] <= 0:
                continue
            self.assertAlmostEqual(
                r["cgst"], r["sgst"], delta=0.01,
                msg=(f"{label}: {r['hsn']} @ {r['rate']}% has CGST {r['cgst']} "
                     f"but SGST {r['sgst']} — heads must be equal halves"))
            self.assertGreater(r["cgst"], 0, f"{label}: rated row with zero CGST")
        self.assertAlmostEqual(bt["cgst"], bt["sgst"], delta=0.02,
                               msg=f"{label}: total CGST != total SGST")

    def test_single_night(self):
        self._assert_halves(make_bill(nights=1, rate=2000, cash=2000), "1 night 5%")

    def test_long_stay(self):
        self._assert_halves(make_bill(nights=10, rate=2000, cash=20000), "10 nights")

    def test_luxury_slab(self):
        self._assert_halves(make_bill(nights=2, rate=9000, cash=18000), "18% slab")

    def test_with_taxed_services(self):
        b = make_bill(nights=1, rate=2000, cash=2340, services=[
            {"item": "Water 1L", "quantity": 2, "unit_price": 20, "price": 40},
            {"item": "Laundry", "quantity": 1, "unit_price": 300, "price": 300},
        ])
        self._assert_halves(b, "with services")

    def test_per_night_folio_splits_evenly(self):
        folio = config.compute_daily_folio(
            checkin_dt=CHECKIN, days_stayed=5, room_price_per_night=2000,
            current_room_no="101", accommodation_services=[],
            pre_transfer_charges=[], discount_on_accom=0,
            recipient_state_code="29")
        for e in folio:
            self.assertAlmostEqual(e["day_cgst"], e["day_sgst"], delta=0.01,
                                   msg=f"day {e['day_index']} heads unequal")
            self.assertAlmostEqual(e["day_cgst"] + e["day_sgst"],
                                   e["day_gst_amount"], delta=0.01,
                                   msg=f"day {e['day_index']} heads != total tax")


class TestPdfUsesConsolidated(BillAssertions):
    """Every path that writes a PDF to Storage must pin the Consolidated view.

    Caught by mutation testing: flipping /render_bill_pdf to "detailed" changed
    nothing any money assertion could see — the two views are deliberately
    money-identical — but it silently changed the document the guest receives,
    and made a bill's stored PDF depend on which code path generated it.
    """

    def _pdf_writers(self):
        import re
        out = []
        for path in ("routes/billing.py", "scripts/regenerate_bill_pdf.py"):
            src = open(os.path.join(_REPO, path), encoding="utf8").read()
            for m in re.finditer(r"(def\s+)?_build_bill_html\(([^)]*)\)", src):
                if m.group(1):
                    continue          # the definition itself
                args = m.group(2).strip()
                if "view=view" in args:
                    continue          # GET /bill_html — the modal, not a PDF
                out.append((path, args))
        return out

    def test_every_pdf_writer_pins_consolidated(self):
        writers = self._pdf_writers()
        self.assertGreaterEqual(len(writers), 3,
                                "expected the checkout, endpoint and script writers")
        for path, args in writers:
            self.assertIn('view="consolidated"', args,
                          f"{path}: _build_bill_html({args}) does not pin Consolidated")

    def test_collapsible_bill_renders_as_a_run_in_the_pdf(self):
        """The layout actually reaching the PDF, not just the argument."""
        bill = make_bill(nights=8, rate=700, cash=5600)
        html = billing._build_bill_html(bill, view="consolidated")
        self.assertIn("8 nights", html)
        self.assertEqual(html.count("b-day-header"), 1)
        # ...and the detailed variant is genuinely different, so the assertion
        # above is meaningful rather than vacuous.
        detailed = billing._build_bill_html(bill, view="detailed")
        self.assertNotIn("8 nights", detailed)
        self.assertEqual(detailed.count("b-day-header"), 8)
