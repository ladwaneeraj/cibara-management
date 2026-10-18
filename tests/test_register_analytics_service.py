"""
Unit tests for services/register_analytics_service.py (pure — no Firestore,
no Flask). Register-basis stay universe, overview KPIs, channel mix, booking
pace, seasonality, LOS / lead-time, snapshots and findings.
"""
from datetime import date

from services.register_analytics_service import (
    build_stay_universe,
    channel_of,
    compute_booking_pace,
    compute_channel_mix,
    compute_overview,
)


# ── Task 1: stay universe + overview KPIs ───────────────────────────────

def test_in_house_stay_counts_nights_to_today():
    rooms = {"101": {"status": "occupied", "active_bill_id": "s1",
                     "checkin_time": "2026-10-16 12:00", "room_price_per_night": 1000}}
    stays = build_stay_universe(rooms, bills=[], today=date(2026, 10, 18))
    assert len(stays) == 1 and stays[0]["checkout_time"] is None
    ov = compute_overview(stays, payments=[], room_count=1,
                          window_from="2026-10-16", window_to="2026-10-18",
                          today=date(2026, 10, 18))
    assert ov["occupancy"]["occupied_room_nights"] == 2   # 16th, 17th


def test_cancelled_stay_excluded():
    bills = [{"id": "b1", "status": "cancelled", "checkin_time": "2026-10-10 12:00",
              "checkout_time": "2026-10-11 10:00", "room_charges_total": 1000}]
    assert build_stay_universe({}, bills, date(2026, 10, 18)) == []


def test_empty_window_no_divide_by_zero():
    ov = compute_overview([], [], room_count=0, window_from="2026-10-18",
                          window_to="2026-10-18", today=date(2026, 10, 18))
    assert ov["occupancy"]["occupancy_pct"] == 0 and ov["occupancy"]["adr"] == 0
    assert ov["occupancy"]["revpar"] == 0


def test_channel_of_known_sources():
    assert channel_of({"booking_source": "mmt"}) == "MMT"
    assert channel_of({"booking_source": "", "payment_source": ""}) == "Direct/Walk-in"


def test_channel_of_other_sources():
    assert channel_of({"booking_source": "agoda"}) == "Agoda"
    assert channel_of({"booking_source": "Booking.com"}) == "Booking.com"
    assert channel_of({"booking_source": "normal", "payment_source": "hotel"}) == "Direct/Walk-in"
    assert channel_of({"booking_source": "goibibo"}) == "Other"
    assert channel_of({"booking_source": "normal", "payment_source": "ota"}) == "Other"


def test_reverted_and_voided_stays_excluded_no_double_count():
    bills = [
        {"id": "b1", "status": "completed", "superseded_by_revert": True,
         "checkin_time": "2026-10-10 12:00", "checkout_time": "2026-10-11 10:00"},
        {"id": "b2", "status": "completed", "cancelled_by_revert": True,
         "checkin_time": "2026-10-10 12:00", "checkout_time": "2026-10-11 10:00"},
        {"id": "b3", "status": "voided",
         "checkin_time": "2026-10-10 12:00", "checkout_time": "2026-10-11 10:00"},
        {"id": "b4", "status": "completed", "room_charges_total": 900,
         "checkin_time": "2026-10-10 12:00", "checkout_time": "2026-10-11 10:00"},
    ]
    stays = build_stay_universe({}, bills, date(2026, 10, 18))
    assert [s["stay_id"] for s in stays] == ["b4"]


def test_in_house_stay_deduped_against_its_draft_bill():
    rooms = {"101": {"status": "occupied", "active_bill_id": "s1",
                     "checkin_time": "2026-10-16 12:00", "room_price_per_night": 1000}}
    bills = [{"id": "s1", "status": "draft", "checkin_time": "2026-10-16 12:00",
              "checkout_time": None, "room_price_per_night": 1000}]
    stays = build_stay_universe(rooms, bills, date(2026, 10, 18))
    assert len(stays) == 1


def test_completed_bills_and_in_house_are_unioned_with_channel():
    rooms = {"102": {"status": "occupied", "active_bill_id": "s2",
                     "checkin_time": "2026-10-17 12:00", "room_price_per_night": 800,
                     "booking_source": "mmt", "payment_source": "ota"}}
    bills = [{"id": "b9", "status": "completed", "room": "101",
              "checkin_time": "2026-10-10 12:00", "checkout_time": "2026-10-12 10:00",
              "room_charges_total": 2000}]
    stays = build_stay_universe(rooms, bills, date(2026, 10, 18))
    assert {s["stay_id"] for s in stays} == {"s2", "b9"}
    assert next(s for s in stays if s["stay_id"] == "s2")["channel"] == "MMT"


def test_non_occupied_room_and_orphan_draft_are_ignored():
    rooms = {"101": {"status": "vacant", "active_bill_id": "old",
                     "checkin_time": "2026-10-16 12:00"}}
    bills = [{"id": "orphan", "status": "draft", "checkin_time": "2026-10-01 12:00",
              "checkout_time": None}]
    assert build_stay_universe(rooms, bills, date(2026, 10, 18)) == []


def test_is_live_matches_payment_service():
    from services.payment_service import is_live_charge
    from services.register_analytics_service import _is_live
    for row in ({}, {"voided": True}, {"voided": False}, None, "x"):
        assert _is_live(row) == is_live_charge(row)


def test_overview_collections_use_register_classification():
    payments = [
        {"method": "cash", "type": "checkin", "amount": 1000},
        {"method": "online", "type": "addon", "amount": 200},
        {"method": "cash", "type": "addon", "amount": 300, "voided": True},
        {"method": "cash", "type": "discount", "amount": 50},
        {"method": "cash", "type": "checkout_refund", "amount": 100},
    ]
    ov = compute_overview([], payments, room_count=1, window_from="2026-10-18",
                          window_to="2026-10-18", today=date(2026, 10, 18))
    c = ov["collections"]
    assert (c["cash"], c["online"], c["refunds"], c["net"]) == (1000, 200, 100, 1100)


# ── Task 2: channel mix & net profitability ─────────────────────────────

def test_channel_mix_nets_ota_commission():
    stays = [
        {"channel": "MMT", "room_charges_total": 10000, "ota_commission_gst": 1500,
         "checkin_time": "2026-10-10 12:00", "checkout_time": "2026-10-12 10:00"},
        {"channel": "Direct/Walk-in", "room_charges_total": 5000, "ota_commission_gst": 0,
         "checkin_time": "2026-10-10 12:00", "checkout_time": "2026-10-11 10:00"},
    ]
    mix = compute_channel_mix(stays, commission_expenses=[])
    mmt = next(c for c in mix["channels"] if c["channel"] == "MMT")
    assert mmt["gross"] == 10000 and mmt["commission"] == 1500 and mmt["net"] == 8500
    assert mix["total_net"] == 13500


def test_channel_mix_net_adr_share_and_room_nights():
    stays = [
        {"channel": "MMT", "room_charges_total": 10000, "ota_commission": 1000,
         "ota_commission_gst": 500,
         "checkin_time": "2026-10-10 12:00", "checkout_time": "2026-10-12 10:00"},
        {"channel": "Direct/Walk-in", "room_charges_total": 5000,
         "checkin_time": "2026-10-10 12:00", "checkout_time": "2026-10-11 10:00"},
    ]
    mix = compute_channel_mix(stays, [])
    mmt = next(c for c in mix["channels"] if c["channel"] == "MMT")
    assert mmt["commission"] == 1500          # commission + GST on it
    assert mmt["room_nights"] == 2 and mmt["net_adr"] == 4250.0
    assert mmt["share_pct"] == 66.7           # 10000 / 15000
    assert mix["total_gross"] == 15000


def test_channel_mix_attributes_booking_commission_expenses():
    stays = [{"channel": "Booking.com", "room_charges_total": 4000,
              "checkin_time": "2026-10-10 12:00", "checkout_time": "2026-10-12 10:00"}]
    exp = [
        {"category": "booking_commission", "commission_platform": "booking.com",
         "commission_amount": 400, "commission_gst": 72},
        # settlement-generated mirror of a bill's own commission (has booking_id)
        {"category": "booking_commission", "commission_platform": "booking.com",
         "commission_amount": 999, "commission_gst": 1, "booking_id": "bk1"},
        {"category": "salary", "amount": 5000},
    ]
    mix = compute_channel_mix(stays, exp)
    bk = next(c for c in mix["channels"] if c["channel"] == "Booking.com")
    assert bk["commission"] == 472 and bk["net"] == 3528


def test_channel_mix_unmatched_platform_gets_own_row_and_empty_is_safe():
    exp = [{"category": "booking_commission", "commission_platform": "goibibo",
            "commission_amount": 100, "commission_gst": 18}]
    mix = compute_channel_mix([], exp)
    row = next(c for c in mix["channels"] if c["channel"] == "Other")
    assert row["commission"] == 118 and row["gross"] == 0 and row["net_adr"] == 0
    assert row["share_pct"] == 0
    empty = compute_channel_mix([], [])
    assert empty == {"channels": [], "total_gross": 0, "total_net": 0}


def test_channel_mix_windowed_apportions_revenue_and_commission():
    stays = [{"channel": "MMT", "room_charges_total": 4000, "ota_commission_gst": 400,
              "checkin_time": "2026-10-10 12:00", "checkout_time": "2026-10-14 10:00"}]
    # 4 nights at 1000; only the nights of the 12th and 13th fall in window.
    mix = compute_channel_mix(stays, [], window_from="2026-10-12",
                              window_to="2026-10-13", today=date(2026, 10, 18))
    mmt = mix["channels"][0]
    assert mmt["gross"] == 2000 and mmt["room_nights"] == 2 and mmt["commission"] == 200


# ── Task 3: booking pace / forward occupancy ────────────────────────────

def test_pace_counts_future_bookings_excludes_cancelled():
    future = [
        {"check_in_date": "2026-10-19", "check_out_date": "2026-10-21",
         "status": "confirmed", "room": "101", "total_amount": 2000},
        {"check_in_date": "2026-10-20", "check_out_date": "2026-10-22",
         "status": "cancelled", "room": "102", "total_amount": 2000},
    ]
    pace = compute_booking_pace(stays=[], future_bookings=future, room_count=5,
                                today=date(2026, 10, 18), horizons=(7,))
    assert pace["horizons"][7]["occupied_room_nights"] == 2   # 19th,20th only
    assert pace["horizons"][7]["on_books_revenue"] == 2000
    assert pace["horizons"][7]["available_room_nights"] == 35
    assert pace["horizons"][7]["occupancy_pct"] == round(2 / 35 * 100, 1)


def test_pace_booking_straddling_horizon_is_prorated():
    future = [{"check_in_date": "2026-10-24", "check_out_date": "2026-10-28",
               "status": "confirmed", "room": "101", "total_amount": 4000}]
    # horizon 7 = nights of 18th..24th → only the 24th falls inside.
    pace = compute_booking_pace([], future, 5, date(2026, 10, 18), horizons=(7, 14))
    assert pace["horizons"][7]["occupied_room_nights"] == 1
    assert pace["horizons"][7]["on_books_revenue"] == 1000
    assert pace["horizons"][14]["occupied_room_nights"] == 4
    assert pace["horizons"][14]["on_books_revenue"] == 4000


def test_pace_skips_missing_or_bad_dates_and_inverted_ranges():
    future = [
        {"check_in_date": "", "check_out_date": "2026-10-21", "status": "confirmed",
         "total_amount": 500},
        {"check_in_date": "2026-10-19", "check_out_date": "garbage", "status": "confirmed",
         "total_amount": 500},
        {"check_in_date": "2026-10-21", "check_out_date": "2026-10-19", "status": "confirmed",
         "total_amount": 500},
        {"status": "confirmed"},
    ]
    pace = compute_booking_pace([], future, 5, date(2026, 10, 18), horizons=(7,))
    assert pace["horizons"][7]["occupied_room_nights"] == 0
    assert pace["horizons"][7]["on_books_revenue"] == 0


def test_pace_skips_already_checked_in_bookings():
    # A checked-in booking is the in-house stay; counting both would double it.
    future = [{"check_in_date": "2026-10-18", "check_out_date": "2026-10-20",
               "status": "checked_in", "room": "101", "total_amount": 2000}]
    pace = compute_booking_pace([], future, 5, date(2026, 10, 18), horizons=(7,))
    assert pace["horizons"][7]["occupied_room_nights"] == 0


def test_pace_in_house_stay_projects_to_expected_checkout_or_tonight():
    today = date(2026, 10, 18)
    stays = [
        {"stay_id": "a", "checkin_time": "2026-10-16 12:00", "checkout_time": None,
         "room_price_per_night": 1000, "expected_checkout": "2026-10-21"},
        {"stay_id": "b", "checkin_time": "2026-10-17 12:00", "checkout_time": None,
         "room_price_per_night": 500},                       # no expected checkout
        {"stay_id": "c", "checkin_time": "2026-10-10 12:00", "checkout_time": "2026-10-12 10:00",
         "room_price_per_night": 900},                       # already checked out
    ]
    pace = compute_booking_pace(stays, [], 5, today, horizons=(7,))
    h = pace["horizons"][7]
    assert h["occupied_room_nights"] == 4        # a: 18,19,20  b: tonight only
    assert h["on_books_revenue"] == 3500         # 3*1000 + 1*500


def test_pace_overdue_expected_checkout_still_counts_tonight():
    stays = [{"stay_id": "a", "checkin_time": "2026-10-10 12:00", "checkout_time": None,
              "room_price_per_night": 1000, "expected_checkout": "2026-10-15"}]
    pace = compute_booking_pace(stays, [], 5, date(2026, 10, 18), horizons=(7,))
    assert pace["horizons"][7]["occupied_room_nights"] == 1


def test_pace_zero_rooms_no_divide_by_zero():
    pace = compute_booking_pace([], [], 0, date(2026, 10, 18))
    assert set(pace["horizons"]) == {7, 14, 30}
    assert pace["horizons"][30]["occupancy_pct"] == 0
