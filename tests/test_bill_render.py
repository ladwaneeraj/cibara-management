"""
Unit tests for the single bill renderer, routes.billing._build_bill_html.

This function is the ONLY thing that draws an invoice. The bill modal (via
GET /bill_html), Print, the PDF written to Firebase Storage and the copy a
guest receives on WhatsApp all originate here. It replaced four hand-maintained
copies of the same layout — two in JavaScript (bills.js, register.js), one in
Python, plus a client-HTML path through /render_bill_pdf — which had drifted
far enough apart that the invoice an operator printed and the invoice the guest
received were visibly different documents.

The tests below are mostly regression guards for that drift and for the four
defects the consolidation exposed. They stub Firebase so the renderer can be
exercised offline, in the same style as test_gst_helpers.py.
"""
from __future__ import annotations

import copy
import io
import os
import re
import sys
import types
import unittest

# ── Firebase / Flask stubs ────────────────────────────────────────────────
_fa = types.ModuleType("firebase_admin")
# "auth" is needed on top of test_gst_helpers' set: routes.billing pulls in
# services.auth_service for its @requires_permission decorators.
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

import config  # noqa: E402
from routes import billing  # noqa: E402


# ── Fixtures ──────────────────────────────────────────────────────────────

def _folio_night(i, *, room="210", rate=700, start=None, addons=None,
                 discount=0.0, gst_rate=0, total=None):
    return {
        "day_index": i,
        "day_start": start or f"2026-07-{28 + i:02d} 21:10",
        "room": room,
        "base_rate": rate,
        "day_total": rate if total is None else total,
        "day_gst_rate": gst_rate,
        "day_taxable": rate,
        "day_cgst": 0, "day_sgst": 0, "day_igst": 0,
        "addons": addons or [],
        "discount_allocated": discount,
    }


def _bill_8_nights():
    """8 identical add-on-free nights — fully collapsible."""
    return {
        "id": "b44",
        "bill_number": "CC/2026/08/00044",
        "guest_name": "Madani", "guest_mobile": "9025488240",
        "room": "210", "guest_count": 2,
        "checkin_time": "2026-07-29 21:10",
        "checkout_time": "2026-08-06 19:11",
        "days_stayed": 8,
        "room_price_per_night": 700, "room_charges_total": 5600,
        "gst_rate": 0, "gst_amount": 0, "total_amount": 5600,
        "services": [], "services_total": 0, "discounts": 0,
        "payment_cash": 2800, "payment_online": 2800, "balance": 0,
        "daily_folio": [_folio_night(i + 1) for i in range(8)],
    }


def _bill_1_night():
    """Single exempt night — nothing to collapse."""
    return {
        "id": "b47",
        "bill_number": "CC/2026/08/00047",
        "guest_name": "Shiva raj", "guest_mobile": "9980685112",
        "room": "227", "guest_count": 2,
        "checkin_time": "2026-08-06 21:00",
        "checkout_time": "2026-08-07 09:53",
        "days_stayed": 1,
        "room_price_per_night": 900, "room_charges_total": 900,
        "gst_rate": 0, "gst_amount": 0, "total_amount": 900,
        "services": [], "services_total": 0, "discounts": 0,
        "payment_cash": 0, "payment_online": 900, "balance": 0,
        "daily_folio": [_folio_night(1, room="227", rate=900,
                                     start="2026-08-06 21:00")],
    }


def _section(html, cls):
    """Everything after the opening of a given block — enough to compare."""
    return html.split(cls)[1] if cls in html else ""


def _grand_total(html):
    return re.search(r'GRAND TOTAL.*?([\d.]+)</td>', html, re.S).group(1)


# ── The core invariant ────────────────────────────────────────────────────

class TestViewsAreMoneyEquivalent(unittest.TestCase):
    """Detailed and Consolidated are presentation only.

    They regroup rows; they must never change a number. If this fails, the
    invoice a guest receives depends on a UI toggle, which is exactly the
    class of bug the single renderer exists to prevent.
    """

    def _assert_equivalent(self, bill):
        c = billing._build_bill_html(bill, view="consolidated")
        d = billing._build_bill_html(bill, view="detailed")
        self.assertEqual(_grand_total(c), _grand_total(d))
        self.assertEqual(_section(c, "b-tax-summary"), _section(d, "b-tax-summary"))
        self.assertEqual(_section(c, "b-pay-section"), _section(d, "b-pay-section"))

    def test_eight_identical_nights(self):
        self._assert_equivalent(_bill_8_nights())

    def test_single_night(self):
        self._assert_equivalent(_bill_1_night())

    def test_mixed_stay_with_addons_services_and_discount(self):
        b = _bill_8_nights()
        b["daily_folio"][2]["addons"] = [
            {"item": "Extra Bed", "quantity": 1, "unit_price": 150, "price": 150}]
        b["daily_folio"][2]["day_total"] = 850
        b["daily_folio"][4]["discount_allocated"] = 50
        b["daily_folio"][4]["day_total"] = 650
        b["services"] = [
            {"item": "Water 1L", "quantity": 2, "unit_price": 20, "price": 40},
            {"item": "Laundry", "quantity": 1, "unit_price": 100, "price": 100},
        ]
        b["services_total"] = 140
        b["total_amount"] = 5740
        self._assert_equivalent(b)


class TestConsolidation(unittest.TestCase):
    def test_run_of_identical_nights_collapses(self):
        html = billing._build_bill_html(_bill_8_nights(), view="consolidated")
        self.assertIn("8 nights", html)
        self.assertIn("Room Charges (8 nights) Total (incl. GST)", html)
        self.assertEqual(html.count("b-day-header"), 1)

    def test_detailed_itemises_every_night(self):
        html = billing._build_bill_html(_bill_8_nights(), view="detailed")
        self.assertEqual(html.count("b-day-header"), 8)
        self.assertNotIn("8 nights", html)

    def test_night_with_addons_breaks_the_run(self):
        b = _bill_8_nights()
        b["daily_folio"][2]["addons"] = [
            {"item": "Extra Bed", "quantity": 1, "unit_price": 150, "price": 150}]
        html = billing._build_bill_html(b, view="consolidated")
        # run(1-2) + day(3) + run(4-8)
        self.assertEqual(html.count("b-day-header"), 3)
        self.assertIn("Extra Bed", html)

    def test_rate_change_breaks_the_run(self):
        b = _bill_8_nights()
        for e in b["daily_folio"][4:]:
            e["base_rate"] = 800
        html = billing._build_bill_html(b, view="consolidated")
        self.assertEqual(html.count("b-day-header"), 2)

    def test_room_transfer_breaks_the_run(self):
        b = _bill_8_nights()
        for e in b["daily_folio"][4:]:
            e["room"] = "211"
        html = billing._build_bill_html(b, view="consolidated")
        self.assertEqual(html.count("b-day-header"), 2)

    def test_auto_prefers_consolidated_only_when_collapsible(self):
        self.assertEqual(billing._resolve_view_mode(_bill_8_nights()), "consolidated")
        self.assertEqual(billing._resolve_view_mode(_bill_1_night()), "detailed")

    def test_explicit_view_overrides_auto(self):
        b = _bill_8_nights()
        self.assertEqual(billing._resolve_view_mode(b, "detailed"), "detailed")
        self.assertEqual(billing._resolve_view_mode(_bill_1_night(), "consolidated"),
                         "consolidated")


# ── Regression guards for the four defects ────────────────────────────────

class TestPaymentBlockFoots(unittest.TestCase):
    def test_ota_prepayment_is_rendered_and_counted(self):
        """payment_ota used to be dropped: Total Paid was short by the OTA
        amount while Balance Due (read from storage) correctly showed zero,
        so the Payment Details block did not foot on any MMT bill."""
        b = _bill_1_night()
        b.update(payment_cash=0, payment_online=0, payment_ota=900, balance=0)
        html = billing._build_bill_html(b)
        pay = _section(html, "b-pay-section")
        self.assertIn("Paid via MMT (OTA)", pay)
        self.assertIn("900.00", pay)
        # Total Paid must equal cash + online + ota.
        total = re.search(r'Total Paid</td><td[^>]*>[^\d]*([\d.]+)', pay).group(1)
        self.assertEqual(total, "900.00")

    def test_ota_absent_when_zero(self):
        html = billing._build_bill_html(_bill_1_night())
        self.assertNotIn("Paid via MMT (OTA)", html)

    def test_overpaid_row_appears(self):
        b = _bill_1_night()
        b["payment_cash"] = 200           # 1100 paid against a 900 bill
        html = billing._build_bill_html(b)
        self.assertIn("OVERPAID", html)

    def test_no_overpaid_row_when_settled_exactly(self):
        self.assertNotIn("OVERPAID", billing._build_bill_html(_bill_1_night()))

    def test_no_paid_in_full_line(self):
        """A cleanly settled bill prints nothing extra."""
        html = billing._build_bill_html(_bill_1_night())
        self.assertNotIn("PAID IN FULL", html)
        self.assertNotIn("Balance Due", html)


class TestDiscountShownOnce(unittest.TestCase):
    def test_folio_discount_not_repeated_at_bill_level(self):
        """Folio blocks print their own 'Less: Discount allocated to ...'
        line, so the trailing bill-level Discount row would state the same
        reduction a second time immediately above GRAND TOTAL."""
        b = _bill_1_night()
        b["discounts"] = 100
        b["total_amount"] = 800
        b["daily_folio"][0]["discount_allocated"] = 100
        b["daily_folio"][0]["day_total"] = 800
        html = billing._build_bill_html(b)
        self.assertEqual(html.count("Discount"), 1)
        self.assertIn("Less: Discount allocated to Day 1", html)

    def test_legacy_bill_without_folio_still_shows_discount(self):
        b = _bill_1_night()
        del b["daily_folio"]
        b["discounts"] = 100
        b["total_amount"] = 800
        self.assertIn("Discount", billing._build_bill_html(b))


class TestPdfGlyphSafety(unittest.TestCase):
    """xhtml2pdf renders Helvetica in WinAnsi. A character outside that
    encoding comes out as a filled black box. bills.js used to wrap folio
    headers in U+2500 box-drawing characters, so every folio PDF sent to a
    guest carried visible boxes."""

    # Latin-1 plus the punctuation ReportLab maps cleanly.
    _SAFE_ABOVE_ASCII = set(range(0xA0, 0x100)) | {
        0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2026, 0x2122,
    }

    def _offending_chars(self, bill, view):
        full = billing._build_pdf_html(billing._build_bill_html(bill, view=view))
        text = re.sub(r"<[^>]+>", "", full)
        return sorted({c for c in text
                       if ord(c) > 0x7F and ord(c) not in self._SAFE_ABOVE_ASCII})

    def test_no_unrenderable_characters_reach_the_pdf(self):
        for bill in (_bill_8_nights(), _bill_1_night()):
            for view in ("consolidated", "detailed"):
                self.assertEqual(self._offending_chars(bill, view), [],
                                 f"non-WinAnsi glyph in {bill['bill_number']} / {view}")

    def test_rupee_glyph_is_substituted_for_the_pdf(self):
        """The renderer emits ₹ so the browser shows it; _build_pdf_html
        swaps in 'Rs.' because xhtml2pdf cannot draw U+20B9."""
        bill = _bill_1_night()
        self.assertIn("₹", billing._build_bill_html(bill))
        self.assertNotIn("₹", billing._build_pdf_html(
            billing._build_bill_html(bill)))


class TestInvoiceContent(unittest.TestCase):
    """Fields Rule 46 requires, and the ones that went missing in the copy
    that was actually producing PDFs."""

    def test_required_blocks_present(self):
        html = billing._build_bill_html(_bill_1_night())
        for needle in ("TAX INVOICE", "GSTIN: 29AAWFC1962B1Z9",
                       "Place of Supply:", "Reverse Charge:",
                       "SAC: 996311", "b-tax-summary",
                       "HSN/SAC", "GRAND TOTAL", "Authorised Signatory"):
            self.assertIn(needle, html, f"missing {needle!r}")

    def test_tax_summary_totals_match_folio(self):
        html = billing._build_bill_html(_bill_8_nights())
        summary = _section(html, "b-tax-summary")
        self.assertIn("5600.00", summary)

    def test_b2b_recipient_block(self):
        b = _bill_1_night()
        b.update(invoice_type="B2B", recipient_gstin="29AAAAA0000A1Z5",
                 recipient_legal_name="Acme Pvt Ltd")
        html = billing._build_bill_html(b)
        self.assertIn("BILL TO (Recipient — Registered)", html)
        self.assertIn("29AAAAA0000A1Z5", html)

    def _out_of_state_b2b(self):
        b = _bill_1_night()
        b.update(invoice_type="B2B", recipient_gstin="27AAAAA0000A1Z5",
                 recipient_legal_name="Acme Pvt Ltd",
                 recipient_state="Maharashtra", recipient_state_code="27",
                 room_price_per_night=2000, room_charges_total=2000,
                 total_amount=2000, gst_rate=5)
        b["daily_folio"] = [_folio_night(1, room="227", rate=2000,
                                         start="2026-08-06 21:00", gst_rate=5)]
        b["daily_folio"][0].update(day_taxable=1904.76, day_cgst=47.62,
                                   day_sgst=47.62)
        return b

    def test_out_of_state_recipient_still_gets_cgst_sgst(self):
        """Section 12(3)(b) IGST Act: place of supply for accommodation is the
        property's location, not the recipient's state. The renderer used to
        print IGST for an out-of-state B2B guest while every storage path
        recorded CGST+SGST, so the guest's invoice contradicted both the bill
        record and the GSTR-1 filing and their ITC claim could not match."""
        html = billing._build_bill_html(self._out_of_state_b2b())
        self.assertIn("CGST", html)
        self.assertIn("SGST", html)
        self.assertNotIn("IGST @", html)      # no IGST line item
        self.assertIn("Karnataka (29) &ndash; CGST+SGST", html)

    def test_place_of_supply_is_always_the_property_state(self):
        b = _bill_1_night()
        b.update(recipient_state="Maharashtra", recipient_state_code="27")
        html = billing._build_bill_html(b)
        self.assertIn("Karnataka (29)", html)
        self.assertNotIn("Place of Supply:</span> Maharashtra", html)

    def test_recipient_state_still_shown_in_bill_to(self):
        """The recipient's own state belongs in BILL TO and in the GSTR-1
        recipient details — it just must not move the tax heads."""
        html = billing._build_bill_html(self._out_of_state_b2b())
        self.assertIn("Maharashtra (27)", html)

    def test_igst_column_present_but_zero(self):
        """GSTR-1 expects the column to exist; a lodge never fills it."""
        html = billing._build_bill_html(self._out_of_state_b2b())
        self.assertIn("IGST", html)                      # column header
        breakup = config.bill_tax_breakup(self._out_of_state_b2b())
        self.assertEqual(breakup["igst"], 0.0)


class TestPdfConversion(unittest.TestCase):
    def test_pdf_renders_without_error(self):
        try:
            from xhtml2pdf import pisa
        except ImportError:
            self.skipTest("xhtml2pdf not installed")
        for bill in (_bill_8_nights(), _bill_1_night()):
            full = billing._build_pdf_html(
                billing._build_bill_html(bill, view="consolidated"))
            buf = io.BytesIO()
            result = pisa.CreatePDF(full, dest=buf)
            self.assertFalse(result.err, f"pisa error for {bill['bill_number']}")
            self.assertGreater(len(buf.getvalue()), 1000)


class TestLegacyBillsStillRender(unittest.TestCase):
    """Bills predating the folio migration must not regress."""

    def test_no_folio_single_room(self):
        b = _bill_1_night()
        del b["daily_folio"]
        html = billing._build_bill_html(b)
        self.assertIn("Room Rent", html)
        self.assertIn("GRAND TOTAL", html)

    def test_no_folio_with_room_segments(self):
        b = _bill_8_nights()
        del b["daily_folio"]
        b["room_segments"] = [
            {"room": "210", "nights": 4, "rate": 700, "total": 2800},
            {"room": "211", "nights": 4, "rate": 700, "total": 2800},
        ]
        html = billing._build_bill_html(b)
        self.assertIn("Rm 210", html)
        self.assertIn("Rm 211", html)

    def test_empty_bill_does_not_raise(self):
        self.assertIn("TAX INVOICE", billing._build_bill_html({}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
