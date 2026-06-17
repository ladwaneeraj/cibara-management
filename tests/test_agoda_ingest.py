"""
Unit tests for services/agoda_ingest_service.py pure functions.

These exercise the offline, I/O-free path only — parsing an Agoda
booking-confirmation email body and mapping it into a booking document. No
IMAP, Firestore, or network access is touched, so the tests run anywhere.

The HTML fixture mirrors the sample Agoda hotelier confirmation (booking
2022773610, Cibara Comforts) including the net-rate / sell-rate / commission /
TDS figures, so the financial mapping and the reconciliation safety-net are
locked in.
"""
from __future__ import annotations

import os
import sys
import unittest

# Make the repo root importable regardless of where pytest is invoked from.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import agoda_ingest_service as agoda  # noqa: E402


def _confirmation_html(room_type: str = "Premium", *, company_gstin: str | None = None) -> str:
    """Build an Agoda-confirmation-shaped HTML body for the given room type."""
    company_block = ""
    if company_gstin:
        company_block = (
            f"<tr><td>Company Name</td><td>GOGREEN WAREHOUSES PVT LTD</td></tr>"
            f"<tr><td>Company Address</td><td>NELAMANGALA, KARNATAKA</td></tr>"
            f"<tr><td>Company GST</td><td>{company_gstin}</td></tr>"
        )
    return f"""
    <html><body>
      <div>Agoda — Booking confirmation</div>
      <table>
        <tr><td>Booking ID</td><td>2022773610</td><td>PREPAID</td></tr>
        <tr><td>Cibara Comforts (Property ID C2910367)</td></tr>
        <tr><td>Customer First Name</td><td>Yogish</td></tr>
        <tr><td>Customer Last Name</td><td>Amin</td></tr>
        <tr><td>Country of Residence</td><td>India</td></tr>
        <tr><td>Check-in</td><td>June 17, 2026</td></tr>
        <tr><td>Check-out</td><td>June 19, 2026</td></tr>
        <tr>
          <td>Room Type</td><td>{room_type}</td>
          <td>No. of Rooms</td><td>1</td>
          <td>Occupancy</td><td>2 Adults</td>
          <td>No. of Extra Bed</td><td>0</td>
        </tr>
        <tr><td>Rate Plan name: Room Only (Room Only)</td></tr>
        <tr><td>Benefits Included</td><td>Parking, Free WiFi</td></tr>
        {company_block}
        <tr><td>June 17, 2026</td><td>INR 1,310.40</td></tr>
        <tr><td>June 18, 2026</td><td>INR 1,310.40</td></tr>
        <tr><td>Reference sell rate (incl. taxes &amp; fees)</td><td>INR 3,360.00</td></tr>
        <tr><td>Compensation</td></tr>
        <tr><td>Commission</td><td>INR -576.00</td></tr>
        <tr><td>TDS - Withholding tax</td><td>INR -3.20</td></tr>
        <tr><td>Net rate (incl. taxes &amp; fees)</td><td>INR 2,620.80</td></tr>
      </table>
    </body></html>
    """


class TestAgodaHelpers(unittest.TestCase):
    def test_inr_parsing(self):
        self.assertEqual(agoda._inr("INR 3,360.00"), 3360.0)
        self.assertEqual(agoda._inr("INR -576.00"), -576.0)
        self.assertEqual(agoda._inr("Rs. 1,310.40"), 1310.4)
        self.assertIsNone(agoda._inr(None))

    def test_date_parsing(self):
        self.assertEqual(agoda._parse_agoda_date("June 17, 2026"), "2026-06-17")
        self.assertEqual(agoda._parse_agoda_date("17 June 2026"), "2026-06-17")
        self.assertIsNone(agoda._parse_agoda_date("not a date"))

    def test_room_type_pool_mapping(self):
        # "Premium" is the NORMAL (non-AC) product; "Premium AC" is AC. Both
        # draw from the same 200..206 block.
        prem_pool, prem_is_ac = agoda._pool_and_ac_for_agoda_type("Premium")
        self.assertFalse(prem_is_ac)
        self.assertIn("200", prem_pool)

        ac_pool, ac_is_ac = agoda._pool_and_ac_for_agoda_type("Premium AC")
        self.assertTrue(ac_is_ac)
        self.assertIn("202", ac_pool)

        bare_ac_pool, bare_ac = agoda._pool_and_ac_for_agoda_type("AC")
        self.assertTrue(bare_ac)
        self.assertIn("200", bare_ac_pool)

        nonac_pool, nonac_is_ac = agoda._pool_and_ac_for_agoda_type("Non AC")
        self.assertFalse(nonac_is_ac)
        self.assertEqual(nonac_pool, [])  # unconfigured by default → unassigned

    def test_room_split_by_adults(self):
        self.assertEqual(agoda._agoda_preferred_rooms(1), ["200", "201", "206"])
        self.assertEqual(agoda._agoda_preferred_rooms(2), ["200", "201", "206"])
        self.assertEqual(agoda._agoda_preferred_rooms(3), ["202", "203", "204", "205"])
        self.assertEqual(agoda._agoda_preferred_rooms(5), ["202", "203", "204", "205"])

        pool = ["200", "201", "202", "203", "204", "205", "206"]
        # 2 adults → 200/201/206 first, then the rest as overflow.
        self.assertEqual(
            agoda._agoda_ordered_candidates(pool, 2),
            ["200", "201", "206", "202", "203", "204", "205"])
        # 3 adults → 202..205 first, then 200/201/206 as overflow.
        self.assertEqual(
            agoda._agoda_ordered_candidates(pool, 3),
            ["202", "203", "204", "205", "200", "201", "206"])

    def test_occupancy_colon_variant(self):
        html = _confirmation_html("Premium AC").replace(
            "<td>Occupancy</td><td>2 Adults</td>",
            "<td>Occupancy</td><td>: 3 Adults</td>")
        p = agoda.parse_agoda_confirmation_html(html)
        self.assertEqual(p["guest_count"], 3)

    def test_nonac_pool_env_override(self):
        os.environ["AGODA_NONAC_ROOMS"] = "3,4,5"
        try:
            pool, is_ac = agoda._pool_and_ac_for_agoda_type("Non AC")
            self.assertFalse(is_ac)
            self.assertEqual(pool, ["3", "4", "5"])
        finally:
            del os.environ["AGODA_NONAC_ROOMS"]


class TestAgodaParse(unittest.TestCase):
    def setUp(self):
        self.parsed = agoda.parse_agoda_confirmation_html(_confirmation_html("Premium"))

    def test_returns_dict(self):
        self.assertIsNotNone(self.parsed)

    def test_identifiers_and_guest(self):
        self.assertEqual(self.parsed["agoda_booking_id"], "2022773610")
        self.assertEqual(self.parsed["property_id"], "C2910367")
        self.assertEqual(self.parsed["guest_name"], "Yogish Amin")

    def test_stay_and_occupancy(self):
        self.assertEqual(self.parsed["check_in_date"], "2026-06-17")
        self.assertEqual(self.parsed["check_out_date"], "2026-06-19")
        self.assertEqual(self.parsed["guest_count"], 2)
        self.assertEqual(self.parsed["room_qty"], 1)
        self.assertEqual(self.parsed["room_type"], "Premium")

    def test_money_fields(self):
        self.assertEqual(self.parsed["agoda_sell_rate"], 3360.0)
        self.assertEqual(self.parsed["agoda_net_rate"], 2620.80)
        self.assertEqual(self.parsed["agoda_reported_commission"], 576.0)
        self.assertEqual(self.parsed["agoda_reported_tds"], 3.20)

    def test_non_agoda_email_rejected(self):
        self.assertIsNone(agoda.parse_agoda_confirmation_html(
            "<html><body>Your newsletter from somewhere</body></html>"))

    def test_settlement_email_not_a_confirmation(self):
        body = ("<html><body>Agoda remittance advice: amount remitted to your "
                "account INR 2,620.80</body></html>")
        self.assertIsNone(agoda.parse_agoda_confirmation_html(body))

    def test_room_type_table_layout(self):
        # Real Agoda confirmations render Room Type / No. of Rooms / Occupancy
        # as a TABLE — the header row is separate from the value row, so the
        # type value does not sit right after the "Room Type" label. This is
        # what left the room blank / unassigned before the fallback parser.
        html = """
        <html><body>Agoda — Booking confirmation
          <table>
            <tr><td>Booking ID</td><td>2022773610</td></tr>
            <tr><td>Customer First Name</td><td>Yogish</td></tr>
            <tr><td>Customer Last Name</td><td>Amin</td></tr>
            <tr><td>Check-in</td><td>June 17, 2026</td></tr>
            <tr><td>Check-out</td><td>June 19, 2026</td></tr>
            <tr><td>Room Type</td><td>No. of Rooms</td><td>Occupancy</td><td>No. of Extra Bed</td></tr>
            <tr><td>Premium</td><td>1</td><td>2 Adults</td><td>0</td></tr>
            <tr><td>Net rate (incl. taxes &amp; fees)</td><td>INR 2,620.80</td></tr>
          </table>
        </body></html>"""
        p = agoda.parse_agoda_confirmation_html(html)
        self.assertEqual(p["room_type"], "Premium")
        self.assertEqual(p["guest_count"], 2)
        pool, is_ac = agoda._pool_and_ac_for_agoda_type(p["room_type"])
        self.assertIn("200", pool)       # maps to the AC block → gets a room
        self.assertFalse(is_ac)          # plain Premium = non-AC

    def test_room_type_table_layout_premium_ac(self):
        html = """
        <html><body>Agoda
          <table>
            <tr><td>Booking ID</td><td>3022773611</td></tr>
            <tr><td>Customer First Name</td><td>A</td></tr>
            <tr><td>Customer Last Name</td><td>B</td></tr>
            <tr><td>Check-in</td><td>June 17, 2026</td></tr>
            <tr><td>Check-out</td><td>June 19, 2026</td></tr>
            <tr><td>Room Type</td><td>No. of Rooms</td><td>Occupancy</td><td>No. of Extra Bed</td></tr>
            <tr><td>Premium AC</td><td>1</td><td>3 Adults</td><td>0</td></tr>
            <tr><td>Net rate (incl. taxes &amp; fees)</td><td>INR 2,620.80</td></tr>
          </table>
        </body></html>"""
        p = agoda.parse_agoda_confirmation_html(html)
        self.assertEqual(p["room_type"], "Premium AC")
        self.assertEqual(p["guest_count"], 3)
        pool, is_ac = agoda._pool_and_ac_for_agoda_type(p["room_type"])
        self.assertTrue(is_ac)
        # 3 adults → preferred 202-205
        self.assertEqual(agoda._agoda_ordered_candidates(pool, 3)[0], "202")


class TestAgodaBuildBooking(unittest.TestCase):
    def _build(self, basis):
        parsed = agoda.parse_agoda_confirmation_html(_confirmation_html("AC"))
        parsed["_invoice_basis"] = basis
        return agoda.build_booking_from_agoda(parsed)

    def test_net_basis_default(self):
        b = self._build("net")
        self.assertEqual(b["booking_source"], "agoda")
        self.assertEqual(b["payment_source"], "ota")
        self.assertEqual(b["invoice_type"], "B2C")
        # net basis: room value == net rate, no hotel commission deducted
        self.assertEqual(b["net_receivable"], 2620.80)
        self.assertEqual(b["ota_total_amount"], 2621)  # int rupees
        self.assertEqual(b["ota_commission"], 0.0)
        self.assertEqual(b["tds_amount"], 3.20)
        # reconciliation surfaces the ₹160 Agoda markup gap for confirmation
        self.assertEqual(b["agoda_reconcile_diff"], 160.0)
        self.assertTrue(b["needs_review"])
        self.assertTrue(any("reconciliation" in r for r in b["review_reasons"]))

    def test_gross_basis(self):
        b = self._build("gross")
        # gross basis mirrors MMT: room value == sell rate, commission booked
        self.assertEqual(b["ota_total_amount"], 3360)
        self.assertEqual(b["ota_commission"], 576.0)
        self.assertEqual(b["net_receivable"], 2620.80)

    def test_b2b_recipient_prefilled(self):
        parsed = agoda.parse_agoda_confirmation_html(
            _confirmation_html("AC", company_gstin="29AACCF7185N1ZW"))
        b = agoda.build_booking_from_agoda(parsed)
        self.assertEqual(b["invoice_type"], "B2B")
        self.assertEqual(b["recipient_gstin"], "29AACCF7185N1ZW")
        self.assertEqual(b["recipient_state_code"], "29")

    def test_room_left_unassigned_by_builder(self):
        b = self._build("net")
        self.assertEqual(b["room"], "")
        self.assertFalse(b["room_assigned"])


if __name__ == "__main__":
    unittest.main()
