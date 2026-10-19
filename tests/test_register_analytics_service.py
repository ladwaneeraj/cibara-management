"""
Unit tests for services/register_analytics_service.py (pure — no Firestore,
no Flask). Register-basis stay universe, overview KPIs, channel mix, booking
pace, seasonality, LOS / lead-time, snapshots and findings.
"""
from datetime import date, datetime

from services.register_analytics_service import (
    attach_expected_checkout,
    build_snapshot,
    build_stay_universe,
    channel_of,
    compute_analytics_overview,
    compute_booking_pace,
    compute_channel_mix,
    compute_findings,
    compute_los_leadtime,
    compute_overview,
    compute_seasonality,
    pace_vs_prior,
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


# ── Task 4: seasonality ─────────────────────────────────────────────────

def _stay(ci, co, total=1000, **kw):
    d = {"checkin_time": f"{ci} 12:00", "checkout_time": f"{co} 10:00" if co else None,
         "room_charges_total": total, "status": "completed" if co else "draft"}
    d.update(kw)
    return d


def test_seasonality_shape_and_full_monday():
    # Mon 12 Oct 2026, 1 room, 1 night at 1000 -> that Monday is 100% occupied.
    stays = [_stay("2026-10-12", "2026-10-13", 1000)]
    s = compute_seasonality(stays, room_count=1, window_from="2026-10-12",
                            window_to="2026-10-18", today=date(2026, 10, 18))
    assert len(s["weekday"]) == 7 and len(s["months"]) == 12
    assert [w["weekday"] for w in s["weekday"]] == [
        "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    mon = s["weekday"][0]
    assert mon["occupancy_pct"] == 100.0 and mon["adr"] == 1000.0 and mon["revpar"] == 1000.0
    assert s["weekday"][1]["occupancy_pct"] == 0           # Tuesday: nobody


def test_seasonality_weekday_aggregates_every_date_in_window():
    # Two Mondays in the window (5th, 12th); only the 12th is occupied -> 50%.
    stays = [_stay("2026-10-12", "2026-10-13", 1000)]
    s = compute_seasonality(stays, 1, "2026-10-05", "2026-10-18", date(2026, 10, 18))
    assert s["weekday"][0]["occupancy_pct"] == 50.0


def test_seasonality_months_are_trailing_12_ending_current_month():
    stays = [_stay("2026-10-12", "2026-10-13", 1000), _stay("2025-11-03", "2025-11-04", 700)]
    s = compute_seasonality(stays, 1, "2026-10-12", "2026-10-18", date(2026, 10, 18))
    keys = [m["month"] for m in s["months"]]
    assert keys[0] == "2025-11" and keys[-1] == "2026-10" and len(set(keys)) == 12
    nov = s["months"][0]
    assert nov["adr"] == 700.0 and nov["occupancy_pct"] == round(1 / 30 * 100, 1)
    # Current month is capped at today (18 nights), not the full 31.
    assert s["months"][-1]["occupancy_pct"] == round(1 / 18 * 100, 1)


def test_seasonality_empty_and_zero_rooms_safe():
    s = compute_seasonality([], 0, "2026-10-18", "2026-10-18", date(2026, 10, 18))
    assert all(w["occupancy_pct"] == 0 and w["adr"] == 0 and w["revpar"] == 0
               for w in s["weekday"])
    assert len(s["months"]) == 12


def test_seasonality_in_house_stay_counted_to_today():
    stays = [_stay("2026-10-16", None, 0, room_price_per_night=1000)]
    s = compute_seasonality(stays, 1, "2026-10-16", "2026-10-18", date(2026, 10, 18))
    sat = next(w for w in s["weekday"] if w["weekday"] == "Saturday")   # 17th
    assert sat["occupancy_pct"] == 100.0


# ── Task 5: length of stay & lead time ──────────────────────────────────

def _bucket(rows, name):
    return next(r["count"] for r in rows if r["bucket"] == name)


def test_los_two_night_stay_and_walkin_leadtime():
    out = compute_los_leadtime([_stay("2026-10-10", "2026-10-12", stay_id="s1", room="101")], [])
    assert _bucket(out["los"], "2") == 1
    assert _bucket(out["lead_time"], "walk-in") == 1
    assert _bucket(out["lead_time"], "0-1") == 0     # walk-ins must NOT pollute 0-1


def test_los_and_leadtime_buckets_are_always_present_in_order():
    out = compute_los_leadtime([], [])
    assert [r["bucket"] for r in out["los"]] == ["1", "2", "3", "4-6", "7+"]
    assert [r["bucket"] for r in out["lead_time"]] == ["walk-in", "0-1", "2-7", "8-30", "30+"]
    assert all(r["count"] == 0 for r in out["los"] + out["lead_time"])


def test_los_bucket_edges_and_in_house_to_today():
    mk = lambda n: _stay("2026-10-01", f"2026-10-{1 + n:02d}", stay_id=f"s{n}")
    out = compute_los_leadtime([mk(1), mk(3), mk(4), mk(6), mk(7), mk(9)], [])
    assert [_bucket(out["los"], b) for b in ("1", "2", "3", "4-6", "7+")] == [1, 0, 1, 2, 2]
    # in-house: nights counted up to today
    inh = compute_los_leadtime([_stay("2026-10-15", None, stay_id="x")], [],
                               today=date(2026, 10, 18))
    assert _bucket(inh["los"], "3") == 1


def test_same_day_stay_is_one_night_bucket():
    out = compute_los_leadtime([_stay("2026-10-10", "2026-10-10", stay_id="s")], [])
    assert _bucket(out["los"], "1") == 1


def test_leadtime_from_booking_created_to_check_in():
    bookings = [
        {"stay_id": "s1", "check_in_date": "2026-10-10", "booking_date": "2026-10-10", "status": "checked_in"},
        {"stay_id": "s2", "check_in_date": "2026-10-10", "booking_date": "2026-10-05", "status": "checked_in"},
        {"check_in_date": "2026-10-20", "booking_date": "2026-10-01", "status": "confirmed"},   # 19 -> 8-30
        {"check_in_date": "2026-10-20", "booking_created": "2026-08-01 10:00", "status": "confirmed"},  # 30+
        {"check_in_date": "2026-10-20", "booking_date": "2026-10-01", "status": "cancelled"},
        {"check_in_date": "2026-10-20", "booking_date": ""},                                    # no created date
    ]
    stays = [_stay("2026-10-10", "2026-10-11", stay_id="s1"),
             _stay("2026-10-10", "2026-10-11", stay_id="s2"),
             _stay("2026-10-10", "2026-10-11", stay_id="s3", room="9")]   # walk-in
    out = compute_los_leadtime(stays, bookings)
    lt = out["lead_time"]
    assert _bucket(lt, "walk-in") == 1
    assert _bucket(lt, "0-1") == 1 and _bucket(lt, "2-7") == 1
    assert _bucket(lt, "8-30") == 1 and _bucket(lt, "30+") == 1


def test_stay_matched_by_room_and_checkin_date_is_not_walkin():
    stays = [_stay("2026-10-10", "2026-10-11", stay_id="s1", room="101")]
    bookings = [{"room": "101", "check_in_date": "2026-10-10", "booking_date": "2026-10-09",
                 "status": "checked_in"}]
    out = compute_los_leadtime(stays, bookings)
    assert _bucket(out["lead_time"], "walk-in") == 0
    assert _bucket(out["lead_time"], "0-1") == 1


# ── Task 6: snapshot + pace-vs-prior ────────────────────────────────────

def _future(ci, co, amt=2000, status="confirmed"):
    return {"check_in_date": ci, "check_out_date": co, "status": status,
            "room": "101", "total_amount": amt}


def test_build_snapshot_shape():
    snap = build_snapshot([], [_future("2026-10-19", "2026-10-21")], 5, date(2026, 10, 18))
    assert snap["date"] == "2026-10-18"
    assert set(snap["horizons"]) == {7, 14, 30}
    assert snap["horizons"][7] == {"occupancy_pct": round(2 / 35 * 100, 1),
                                   "on_books_revenue": 2000}


def test_pace_vs_prior_none_without_snapshots():
    cur = compute_booking_pace([], [_future("2026-10-19", "2026-10-21")], 5, date(2026, 10, 18))
    out = pace_vs_prior(cur, [], date(2026, 10, 18))
    assert all(out["horizons"][h]["delta"] is None for h in (7, 14, 30))
    assert out["compared_to"] is None


def test_pace_vs_prior_delta_against_week_old_snapshot():
    today = date(2026, 10, 18)
    cur = compute_booking_pace([], [_future("2026-10-19", "2026-10-21", 2000)], 5, today)
    old = build_snapshot([], [_future("2026-10-14", "2026-10-15", 1000)], 5, date(2026, 10, 11))
    out = pace_vs_prior(cur, [old], today)
    d = out["horizons"][7]["delta"]
    assert d["on_books_revenue"] == 1000
    assert d["occupancy_pct"] == round(round(2 / 35 * 100, 1) - round(1 / 35 * 100, 1), 1)
    assert d["vs_date"] == "2026-10-11"
    assert out["compared_to"] == "2026-10-11"
    # the current figures are preserved alongside the delta
    assert out["horizons"][7]["on_books_revenue"] == 2000


def test_pace_vs_prior_picks_nearest_to_seven_days_ago_and_ignores_far_or_today():
    today = date(2026, 10, 18)
    cur = compute_booking_pace([], [], 5, today)
    mk = lambda d: {"date": d, "horizons": {7: {"occupancy_pct": 10.0, "on_books_revenue": 100}}}
    out = pace_vs_prior(cur, [mk("2026-10-18"), mk("2026-10-13"), mk("2026-10-10"),
                              mk("2026-09-01")], today)
    assert out["compared_to"] == "2026-10-10"          # 8 days ago is nearer to 7 than 5 days ago
    far = pace_vs_prior(cur, [mk("2026-09-01"), mk("2026-10-18")], today)
    assert far["compared_to"] is None


def test_pace_vs_prior_accepts_string_horizon_keys_from_firestore():
    today = date(2026, 10, 18)
    cur = compute_booking_pace([], [], 5, today, horizons=(7,))
    snap = {"date": "2026-10-11",
            "horizons": {"7": {"occupancy_pct": 10.0, "on_books_revenue": 100}}}
    d = pace_vs_prior(cur, [snap], today)["horizons"][7]["delta"]
    assert d["occupancy_pct"] == -10.0 and d["on_books_revenue"] == -100


def test_pace_vs_prior_horizon_missing_in_snapshot_is_none():
    today = date(2026, 10, 18)
    cur = compute_booking_pace([], [], 5, today, horizons=(7, 14))
    snap = {"date": "2026-10-11", "horizons": {7: {"occupancy_pct": 0, "on_books_revenue": 0}}}
    out = pace_vs_prior(cur, [snap], today)
    assert out["horizons"][7]["delta"] is not None and out["horizons"][14]["delta"] is None


# ── Task 7: findings + compose ──────────────────────────────────────────

def _seed_compose(**over):
    """A small, fully-seeded register: 4 rooms, one in-house MMT guest, a
    completed direct stay and a completed (pricey-commission) MMT stay."""
    rooms = {
        "101": {"status": "occupied", "active_bill_id": "s1",
                "checkin_time": "2026-10-17 12:00", "room_price_per_night": 1000,
                "booking_source": "mmt", "payment_source": "ota"},
        "102": {"status": "vacant"}, "103": {"status": "vacant"}, "104": {"status": "vacant"},
    }
    bills = [
        {"id": "b1", "status": "completed", "room": "102", "booking_source": "normal",
         "payment_source": "hotel", "checkin_time": "2026-10-10 12:00",
         "checkout_time": "2026-10-16 10:00", "room_charges_total": 12000},
        {"id": "b2", "status": "completed", "room": "103", "booking_source": "mmt",
         "payment_source": "ota", "checkin_time": "2026-10-10 12:00",
         "checkout_time": "2026-10-16 10:00", "room_charges_total": 12000,
         "ota_commission": 4000, "ota_commission_gst": 720},
        {"id": "s1", "status": "draft", "room": "101", "checkin_time": "2026-10-17 12:00",
         "checkout_time": None, "room_price_per_night": 1000},   # the in-house draft
    ]
    kw = dict(
        rooms=rooms, bills=bills,
        payments=[{"method": "cash", "type": "checkin", "amount": 5000, "date": "2026-10-17"}],
        bookings=[
            {"stay_id": "s1", "room": "101", "status": "checked_in",
             "check_in_date": "2026-10-17", "check_out_date": "2026-10-20",
             "booking_date": "2026-10-10"},
            {"room": "102", "status": "confirmed", "check_in_date": "2026-10-19",
             "check_out_date": "2026-10-21", "total_amount": 3000, "booking_date": "2026-10-01"},
        ],
        commission_expenses=[], snapshots=[], room_count=4,
        window_from="2026-10-10", window_to="2026-10-18",
        now=datetime(2026, 10, 18, 9, 30),
    )
    kw.update(over)
    return compute_analytics_overview(**kw)


def test_compose_has_all_top_level_keys_and_register_numbers():
    out = _seed_compose()
    assert out["success"] is True
    for k in ("window", "overview", "channel_mix", "pace", "seasonality",
              "los_leadtime", "findings", "generated_at"):
        assert k in out
    assert out["window"] == {"from": "2026-10-10", "to": "2026-10-18", "days": 9}
    # b1 6 nights + b2 6 nights + in-house s1 (17th) 1 night; the draft b9 is
    # the same stay as s1 and must not be counted twice.
    assert out["overview"]["occupancy"]["occupied_room_nights"] == 13
    assert out["overview"]["occupancy"]["counted_stays"] == 3
    assert out["overview"]["collections"]["cash"] == 5000
    # Fields the analytics Overview section dereferences directly: if the
    # backend stops emitting them the page crashes to its error boundary, so
    # assert them here (the frontend fixtures mock them and cannot catch it).
    assert "net_revenue" in out["overview"]["collections"]
    assert set(out["overview"]["on_books_next7"]) >= {"occupancy_pct", "on_books_revenue"}
    assert out["generated_at"] == "2026-10-18 09:30:00"


def test_compose_in_house_projected_to_linked_booking_checkout():
    out = _seed_compose()
    h7 = out["pace"]["horizons"][7]
    # s1: 18th,19th (checkout 20th) + confirmed booking 19th,20th = 4
    assert h7["occupied_room_nights"] == 4
    assert h7["on_books_revenue"] == 2000 + 3000
    assert h7["delta"] is None


def test_compose_channel_mix_nets_commission_and_includes_findings():
    out = _seed_compose()
    mmt = next(c for c in out["channel_mix"]["channels"] if c["channel"] == "MMT")
    assert mmt["commission"] > 0 and mmt["net"] < mmt["gross"]
    assert isinstance(out["findings"], list) and out["findings"]
    f = out["findings"][0]
    assert set(f) == {"level", "icon", "text"}
    # MMT nets far below Direct per night -> the channel finding fires.
    assert any("MMT" in x["text"] for x in out["findings"])


def test_compose_los_leadtime_only_counts_window_checkins():
    out = _seed_compose()
    los = {r["bucket"]: r["count"] for r in out["los_leadtime"]["los"]}
    assert sum(los.values()) == 3          # b1, b2, s1 (draft of s1 deduped)
    lt = {r["bucket"]: r["count"] for r in out["los_leadtime"]["lead_time"]}
    assert lt["walk-in"] == 2              # b1, b2 have no booking doc
    assert lt["2-7"] == 1                  # s1's booking: made 7 days ahead
    assert sum(lt.values()) == 3           # the 19th booking is outside the window


def test_compose_response_is_small_no_raw_rows():
    import json
    out = _seed_compose()
    blob = json.dumps(out, default=str)
    for raw in ('"b1"', '"b2"', '"s1"', '"stay_id"', '"checkin_time"', '"checkout_time"',
                '"room_charges_total"', '"guest_name"', '"payments"', '"bills"'):
        assert raw not in blob


def test_compose_empty_everything_does_not_crash():
    out = compute_analytics_overview(
        rooms={}, bills=[], payments=[], bookings=[], commission_expenses=[],
        snapshots=[], room_count=0, window_from="2026-10-18", window_to="2026-10-18",
        now=datetime(2026, 10, 18, 9, 30))
    assert out["success"] is True
    assert out["overview"]["occupancy"]["occupancy_pct"] == 0


def test_findings_low_forward_occupancy_fires():
    ov = {"occupancy": {"occupancy_over_100": False}}
    pace = {"horizons": {7: {"occupancy_pct": 10.0, "available_room_nights": 35,
                             "delta": None}}}
    out = compute_findings(ov, {"channels": []}, pace)
    assert any("next 7 nights" in f["text"] for f in out)


def test_findings_silent_on_small_samples_and_healthy_pace():
    ov = {"occupancy": {"occupancy_over_100": False}}
    mix = {"channels": [
        {"channel": "Direct/Walk-in", "net_adr": 1000, "room_nights": 2},
        {"channel": "MMT", "net_adr": 100, "room_nights": 2}]}     # too few nights
    pace = {"horizons": {7: {"occupancy_pct": 80.0, "available_room_nights": 35, "delta": None}}}
    assert compute_findings(ov, mix, pace) == []


def test_findings_pace_delta_and_over_capacity():
    ov = {"occupancy": {"occupancy_over_100": True}}
    pace = {"horizons": {7: {"occupancy_pct": 60.0, "available_room_nights": 35,
                             "delta": {"occupancy_pct": -15.0, "on_books_revenue": -500,
                                       "vs_date": "2026-10-11"}}}}
    texts = " ".join(f["text"] for f in compute_findings(ov, {"channels": []}, pace))
    assert "behind" in texts and "room count" in texts


def test_attach_expected_checkout_links_by_stay_id_only_for_in_house():
    stays = [{"stay_id": "s1", "checkout_time": None},
             {"stay_id": "s2", "checkout_time": "2026-10-12 10:00"}]
    bookings = [{"stay_id": "s1", "check_out_date": "2026-10-21"},
                {"stay_id": "s2", "check_out_date": "2026-10-13"}]
    attach_expected_checkout(stays, bookings)
    assert stays[0]["expected_checkout"] == "2026-10-21"
    assert "expected_checkout" not in stays[1]


def test_pace_zero_rooms_no_divide_by_zero():
    pace = compute_booking_pace([], [], 0, date(2026, 10, 18))
    assert set(pace["horizons"]) == {7, 14, 30}
    assert pace["horizons"][30]["occupancy_pct"] == 0
