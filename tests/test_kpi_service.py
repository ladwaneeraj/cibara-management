"""
Unit tests for services/kpi_service.compute_kpis — the pure Occupancy / ADR /
RevPAR math. No Firebase/Flask needed; the function is dependency-free.

Run:  python -m pytest tests/test_kpi_service.py      (or unittest)
"""
from __future__ import annotations

import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import kpi_service  # noqa: E402


def stay(checkin, checkout, *, room_charges_total=None, price=0,
         status="completed", payment_source=None):
    return {
        "checkin_time": checkin,
        "checkout_time": checkout,
        "room_charges_total": room_charges_total,
        "room_price_per_night": price,
        "status": status,
        "payment_source": payment_source,
    }


class TestComputeKpis(unittest.TestCase):

    def test_full_occupancy_single_room_single_night(self):
        # 1 room, window = one night (Jun 1 -> Jun 1 inclusive = night of Jun 1).
        # Guest stays Jun 1 -> Jun 2 (one night), room charge 2000.
        bills = [stay("2026-06-01 12:00", "2026-06-02 10:00",
                      room_charges_total=2000)]
        k = kpi_service.compute_kpis(bills, 1, date(2026, 6, 1), date(2026, 6, 1))
        self.assertEqual(k["available_room_nights"], 1)
        self.assertEqual(k["occupied_room_nights"], 1)
        self.assertEqual(k["occupancy_pct"], 100.0)
        self.assertEqual(k["adr"], 2000.0)
        self.assertEqual(k["revpar"], 2000.0)

    def test_half_occupancy(self):
        # 2 rooms, 1 night, only 1 occupied -> 50% occupancy.
        bills = [stay("2026-06-01 12:00", "2026-06-02 10:00",
                      room_charges_total=3000)]
        k = kpi_service.compute_kpis(bills, 2, date(2026, 6, 1), date(2026, 6, 1))
        self.assertEqual(k["available_room_nights"], 2)
        self.assertEqual(k["occupied_room_nights"], 1)
        self.assertEqual(k["occupancy_pct"], 50.0)
        self.assertEqual(k["adr"], 3000.0)            # per occupied night
        self.assertEqual(k["revpar"], 1500.0)         # per available night

    def test_revpar_identity(self):
        # RevPAR == ADR * occupancy_fraction, across several stays.
        bills = [
            stay("2026-06-01 12:00", "2026-06-04 10:00", room_charges_total=6000),  # 3 nights @2000
            stay("2026-06-02 12:00", "2026-06-03 10:00", room_charges_total=2500),  # 1 night
        ]
        # 2 rooms, window Jun 1..Jun 3 inclusive = 3 nights -> 6 available.
        k = kpi_service.compute_kpis(bills, 2, date(2026, 6, 1), date(2026, 6, 3))
        # Stay1 in-window nights: Jun1,2,3 = 3 ; Stay2: Jun2 = 1 -> 4 occupied.
        self.assertEqual(k["occupied_room_nights"], 4)
        self.assertEqual(k["available_room_nights"], 6)
        self.assertAlmostEqual(k["occupancy_pct"], round(4 / 6 * 100, 1))
        # Revenue: stay1 2000*3 + stay2 2500*1 = 8500
        self.assertEqual(k["room_revenue"], 8500.0)
        self.assertAlmostEqual(k["adr"], round(8500 / 4, 2))
        self.assertAlmostEqual(k["revpar"], round(8500 / 6, 2))
        # Identity check.
        self.assertAlmostEqual(
            k["revpar"], round(k["adr"] * (k["occupied_room_nights"] /
                                           k["available_room_nights"]), 2), places=1)

    def test_boundary_apportionment(self):
        # Stay straddles the window start: only in-window nights & their share
        # of revenue should count. Stay May 30 -> Jun 3 = 4 nights, charge 8000
        # => 2000/night. Window = Jun 1..Jun 2 inclusive (2 nights).
        bills = [stay("2026-05-30 12:00", "2026-06-03 10:00",
                      room_charges_total=8000)]
        k = kpi_service.compute_kpis(bills, 1, date(2026, 6, 1), date(2026, 6, 2))
        # In-window nights: Jun1, Jun2 = 2.
        self.assertEqual(k["occupied_room_nights"], 2)
        self.assertEqual(k["room_revenue"], 4000.0)   # 2 nights * 2000
        self.assertEqual(k["available_room_nights"], 2)
        self.assertEqual(k["occupancy_pct"], 100.0)
        self.assertEqual(k["adr"], 2000.0)

    def test_in_house_draft_uses_today_and_price_fallback(self):
        # Draft (no checkout, no room_charges_total) -> count nights up to
        # `today`, value at room_price_per_night.
        bills = [stay("2026-06-01 12:00", None, price=1500, status="draft")]
        k = kpi_service.compute_kpis(
            bills, 1, date(2026, 6, 1), date(2026, 6, 3),
            today=date(2026, 6, 3),
        )
        # nights from Jun1 up to today(Jun3) exclusive = Jun1, Jun2 = 2.
        self.assertEqual(k["occupied_room_nights"], 2)
        self.assertEqual(k["room_revenue"], 3000.0)   # 2 * 1500 fallback
        self.assertEqual(k["adr"], 1500.0)

    def test_cancelled_and_voided_excluded(self):
        bills = [
            stay("2026-06-01 12:00", "2026-06-02 10:00",
                 room_charges_total=2000, status="cancelled"),
            stay("2026-06-01 12:00", "2026-06-02 10:00",
                 room_charges_total=2000, status="voided"),
        ]
        k = kpi_service.compute_kpis(bills, 1, date(2026, 6, 1), date(2026, 6, 1))
        self.assertEqual(k["occupied_room_nights"], 0)
        self.assertEqual(k["room_revenue"], 0.0)
        self.assertEqual(k["occupancy_pct"], 0.0)
        self.assertEqual(k["adr"], 0.0)

    def test_ota_exclusion(self):
        bills = [
            stay("2026-06-01 12:00", "2026-06-02 10:00",
                 room_charges_total=2000, payment_source="ota"),
            stay("2026-06-01 12:00", "2026-06-02 10:00",
                 room_charges_total=3000),
        ]
        # include_ota True -> both
        k_all = kpi_service.compute_kpis(
            bills, 2, date(2026, 6, 1), date(2026, 6, 1), include_ota=True)
        self.assertEqual(k_all["occupied_room_nights"], 2)
        self.assertEqual(k_all["room_revenue"], 5000.0)
        # include_ota False -> direct only
        k_dir = kpi_service.compute_kpis(
            bills, 2, date(2026, 6, 1), date(2026, 6, 1), include_ota=False)
        self.assertEqual(k_dir["occupied_room_nights"], 1)
        self.assertEqual(k_dir["room_revenue"], 3000.0)
        self.assertEqual(k_dir["excluded_ota"], 1)

    def test_zero_rooms_no_divide_by_zero(self):
        bills = [stay("2026-06-01 12:00", "2026-06-02 10:00",
                      room_charges_total=2000)]
        k = kpi_service.compute_kpis(bills, 0, date(2026, 6, 1), date(2026, 6, 1))
        self.assertEqual(k["available_room_nights"], 0)
        self.assertEqual(k["occupancy_pct"], 0.0)
        self.assertEqual(k["revpar"], 0.0)
        # ADR still defined (revenue / occupied nights).
        self.assertEqual(k["occupied_room_nights"], 1)
        self.assertEqual(k["adr"], 2000.0)

    def test_same_day_checkin_checkout_zero_nights(self):
        bills = [stay("2026-06-01 09:00", "2026-06-01 18:00",
                      room_charges_total=1000)]
        k = kpi_service.compute_kpis(bills, 1, date(2026, 6, 1), date(2026, 6, 1))
        self.assertEqual(k["occupied_room_nights"], 0)
        self.assertEqual(k["occupancy_pct"], 0.0)

    def test_occupancy_over_100_flag(self):
        # 3 concurrent one-night stays but only 1 room configured -> >100%.
        bills = [
            stay("2026-06-01 12:00", "2026-06-02 10:00", room_charges_total=1000),
            stay("2026-06-01 12:00", "2026-06-02 10:00", room_charges_total=1000),
            stay("2026-06-01 12:00", "2026-06-02 10:00", room_charges_total=1000),
        ]
        k = kpi_service.compute_kpis(bills, 1, date(2026, 6, 1), date(2026, 6, 1))
        self.assertEqual(k["occupied_room_nights"], 3)
        self.assertEqual(k["available_room_nights"], 1)
        self.assertEqual(k["occupancy_pct"], 300.0)
        self.assertTrue(k["occupancy_over_100"])

    def test_bad_dates_skipped(self):
        bills = [
            stay("garbage", "2026-06-02 10:00", room_charges_total=2000),
            stay(None, None, room_charges_total=2000),
            stay("2026-06-01 12:00", "2026-06-02 10:00", room_charges_total=2000),
        ]
        k = kpi_service.compute_kpis(bills, 1, date(2026, 6, 1), date(2026, 6, 1))
        self.assertEqual(k["skipped_no_dates"], 2)
        self.assertEqual(k["occupied_room_nights"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
