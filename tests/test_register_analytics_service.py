"""
Unit tests for services/register_analytics_service.py (pure — no Firestore,
no Flask). Register-basis stay universe, overview KPIs, channel mix, booking
pace, seasonality, LOS / lead-time, snapshots and findings.
"""
from datetime import date

from services.register_analytics_service import (
    build_stay_universe,
    channel_of,
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
