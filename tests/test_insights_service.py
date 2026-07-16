"""
Unit tests for services/insights_service.py (pure — no Firestore, no Flask).

Covers the cleaning-cycle pairing state machine, day bucketing, staff and
revenue aggregation, and a couple of the rule-based insights.
"""

import pytest

from services.insights_service import (
    compute_daily_insights,
    generate_insights,
    pair_cleaning_cycles,
)


def _ev(action, room, ts, user="Asha", role="housekeeping", meta=None):
    return {
        "action": action,
        "targetId": str(room),
        "timestamp": ts,
        "userName": user,
        "userRole": role,
        "metadata": meta or {},
    }


def _checkout(room, ts, guest="Guest"):
    return _ev("room.checkout", room, ts, user="Ravi", role="manager",
               meta={"guest": guest})


def _cleaned(room, ts, user="Asha"):
    return _ev("room.cleaning.complete", room, ts, user=user)


def _approved(room, ts, user="Ravi", skipped=False):
    return _ev("room.inspection.approve", room, ts, user=user, role="manager",
               meta={"skipped_housekeeping": skipped})


# ── pairing ─────────────────────────────────────────────────────────────────

class TestPairing:
    def test_full_three_stage_cycle(self):
        cycles = pair_cleaning_cycles([
            _checkout("101", "2026-07-10 10:00:00"),
            _cleaned("101", "2026-07-10 10:40:00"),
            _approved("101", "2026-07-10 10:55:00"),
        ])
        assert len(cycles) == 1
        c = cycles[0]
        assert c["complete"] and not c["voided"] and not c["incomplete"]
        assert c["total_min"] == 55.0
        assert c["clean_min"] == 40.0
        assert c["inspect_wait_min"] == 15.0
        assert c["cleaned_by"] == "Asha"
        assert c["inspected_by"] == "Ravi"
        assert c["skipped_housekeeping"] is False

    def test_one_step_approve_marks_skipped(self):
        cycles = pair_cleaning_cycles([
            _checkout("102", "2026-07-10 09:00:00"),
            _approved("102", "2026-07-10 09:30:00", skipped=True),
        ])
        assert len(cycles) == 1
        assert cycles[0]["complete"]
        assert cycles[0]["skipped_housekeeping"] is True
        assert cycles[0]["total_min"] == 30.0
        assert cycles[0]["clean_min"] is None

    def test_revert_voids_open_cycle(self):
        cycles = pair_cleaning_cycles([
            _checkout("103", "2026-07-10 12:00:00"),
            _ev("booking.revert", "103", "2026-07-10 12:20:00"),
        ])
        assert len(cycles) == 1
        assert cycles[0]["voided"] is True

    def test_revert_shortly_after_approve_voids_last_cycle(self):
        cycles = pair_cleaning_cycles([
            _checkout("103", "2026-07-10 12:00:00"),
            _approved("103", "2026-07-10 12:30:00"),
            _ev("booking.revert", "103", "2026-07-10 13:00:00"),
        ])
        assert len(cycles) == 1
        assert cycles[0]["voided"] is True

    def test_double_checkout_closes_first_as_incomplete(self):
        cycles = pair_cleaning_cycles([
            _checkout("104", "2026-07-10 08:00:00"),
            _checkout("104", "2026-07-10 14:00:00"),
            _approved("104", "2026-07-10 14:45:00"),
        ])
        assert len(cycles) == 2
        assert cycles[0]["incomplete"] is True
        assert cycles[1]["complete"] is True
        assert cycles[1]["total_min"] == 45.0

    def test_orphan_approve_counts_without_duration(self):
        cycles = pair_cleaning_cycles([
            _approved("105", "2026-07-10 11:00:00"),
        ])
        assert len(cycles) == 1
        assert cycles[0]["complete"] is True
        assert cycles[0]["total_min"] is None

    def test_negative_duration_is_none(self):
        cycles = pair_cleaning_cycles([
            # ready BEFORE checkout — bad clock / bad data
            _checkout("106", "2026-07-10 12:00:00"),
            _approved("106", "2026-07-10 11:00:00"),
        ])
        # approve arrives first chronologically → orphan complete cycle,
        # then the checkout stays open. Either way no negative duration.
        for c in cycles:
            assert c["total_min"] is None or c["total_min"] >= 0

    def test_stale_duration_excluded_from_stats(self):
        cycles = pair_cleaning_cycles([
            _checkout("107", "2026-07-08 10:00:00"),
            _approved("107", "2026-07-10 10:00:00"),  # 48h later
        ])
        assert cycles[0]["excluded_from_stats"] is True

    def test_exact_duplicate_events_deduped(self):
        # A double-tap race used to write two identical audit docs.
        cycles = pair_cleaning_cycles([
            _checkout("210", "2026-07-15 09:00:00"),
            _approved("210", "2026-07-15 09:30:00"),
            _approved("210", "2026-07-15 09:30:00"),   # exact duplicate doc
        ])
        assert len(cycles) == 1

    def test_replayed_approve_seconds_later_not_double_counted(self):
        # Duplicate approve lands a couple of seconds after the first
        # (request retry) — must NOT create a second orphan cycle.
        cycles = pair_cleaning_cycles([
            _checkout("211", "2026-07-15 09:00:00"),
            _approved("211", "2026-07-15 09:30:00"),
            _approved("211", "2026-07-15 09:30:02"),
        ])
        complete = [c for c in cycles if c["complete"]]
        assert len(complete) == 1
        assert complete[0]["total_min"] == 30.0

    def test_duplicate_checkout_events_deduped_in_counters(self):
        out = compute_daily_insights([
            _checkout("212", "2026-07-15 10:00:00"),
            _checkout("212", "2026-07-15 10:00:00"),   # exact duplicate doc
        ], "2026-07-15", "2026-07-15")
        assert out["days"][0]["checkouts"] == 1

    def test_unparseable_timestamp_ignored(self):
        cycles = pair_cleaning_cycles([
            _checkout("108", "not-a-date"),
            _approved("108", "2026-07-10 10:00:00"),
        ])
        assert len(cycles) == 1
        assert cycles[0]["checkout_ts"] is None  # orphan approve


# ── day bucketing & aggregation ────────────────────────────────────────────

class TestDailyBuckets:
    def test_cycle_counted_on_ready_day_midnight_straddle(self):
        events = [
            _checkout("101", "2026-07-09 23:50:00"),
            _approved("101", "2026-07-10 00:40:00"),
        ]
        out = compute_daily_insights(events, "2026-07-10", "2026-07-10")
        day = out["days"][0]
        assert day["cleanings"] == 1
        assert day["checkouts"] == 0          # checkout was on the 9th
        assert day["turnaround"]["avg_min"] == 50.0
        assert day["hourly"]["readies"][0] == 1

    def test_lookback_events_only_used_for_pairing(self):
        events = [
            _checkout("101", "2026-07-09 10:00:00"),
            _approved("101", "2026-07-09 10:30:00"),
        ]
        out = compute_daily_insights(events, "2026-07-10", "2026-07-10")
        assert out["days"][0]["cleanings"] == 0
        assert out["totals"]["cleanings"] == 0

    def test_counts_checkins_checkouts_and_hourly(self):
        events = [
            _ev("room.checkin", "201", "2026-07-10 13:05:00"),
            _ev("room.checkin", "202", "2026-07-10 13:45:00"),
            _checkout("203", "2026-07-10 10:15:00"),
        ]
        out = compute_daily_insights(events, "2026-07-10", "2026-07-10")
        day = out["days"][0]
        assert day["checkins"] == 2
        assert day["checkouts"] == 1
        assert day["hourly"]["checkins"][13] == 2
        assert day["hourly"]["checkouts"][10] == 1

    def test_staff_aggregation(self):
        events = [
            _checkout("101", "2026-07-10 09:00:00"),
            _cleaned("101", "2026-07-10 09:30:00", user="Asha"),
            _approved("101", "2026-07-10 09:40:00", user="Ravi"),
            _checkout("102", "2026-07-10 10:00:00"),
            _cleaned("102", "2026-07-10 10:50:00", user="Asha"),
            _approved("102", "2026-07-10 11:00:00", user="Ravi"),
        ]
        out = compute_daily_insights(events, "2026-07-10", "2026-07-10")
        staff = out["days"][0]["staff"]
        asha = next(s for s in staff if s["name"] == "Asha")
        ravi = next(s for s in staff if s["name"] == "Ravi")
        assert asha["cleaned"] == 2
        assert asha["avg_clean_min"] == 40.0   # (30 + 50) / 2
        assert ravi["inspected"] == 2

    def test_revenue_classification_mirrors_reports(self):
        payments = [
            {"date": "2026-07-10", "amount": 1000, "method": "cash", "type": "regular_payment"},
            {"date": "2026-07-10", "amount": 500, "method": "online", "type": "renewal"},
            {"date": "2026-07-10", "amount": 200, "method": "cash", "type": "refund"},
            {"date": "2026-07-10", "amount": 300, "method": "cash", "type": "expense"},
            {"date": "2026-07-11", "amount": 999, "method": "cash", "type": "regular_payment"},
        ]
        out = compute_daily_insights([], "2026-07-10", "2026-07-10",
                                     payments=payments)
        rev = out["days"][0]["revenue"]
        assert rev["cash"] == 1000
        assert rev["online"] == 500
        assert rev["refunds"] == 200
        assert rev["net"] == 1300              # expense/discount ignored
        # 2026-07-11 payment is outside the window
        assert out["totals"]["revenue_net"] == 1300

    def test_occupancy_via_kpi_service(self):
        bills = [{
            "checkin_time": "2026-07-09 14:00",
            "checkout_time": "2026-07-11 10:00",
            "status": "completed",
            "room_charges_total": 2000,       # 2 nights → ₹1000/night
        }]
        out = compute_daily_insights([], "2026-07-10", "2026-07-10",
                                     bills=bills, room_count=10)
        occ = out["days"][0]["occupancy"]
        assert occ["occupied_room_nights"] == 1
        assert occ["occupancy_pct"] == 10.0
        assert occ["adr"] == 1000.0

    def test_window_totals(self):
        events = [
            _checkout("101", "2026-07-10 09:00:00"),
            _approved("101", "2026-07-10 09:30:00"),
            _checkout("102", "2026-07-11 09:00:00"),
            _approved("102", "2026-07-11 10:45:00"),
        ]
        out = compute_daily_insights(events, "2026-07-10", "2026-07-11")
        t = out["totals"]
        assert t["cleanings"] == 2
        assert t["checkouts"] == 2
        assert t["avg_turnaround_min"] == 67.5  # (30 + 105) / 2
        assert t["slow_cleanings"] == 1         # 105 > 90 default threshold
        assert t["best_day"]["cleanings"] == 1


# ── insights rules ──────────────────────────────────────────────────────────

class TestInsights:
    def test_repeat_slow_room_fires(self):
        events = []
        for day in ("2026-07-08", "2026-07-09", "2026-07-10"):
            events.append(_checkout("224", f"{day} 09:00:00"))
            events.append(_approved("224", f"{day} 12:00:00"))  # 3h — slow
        out = compute_daily_insights(events, "2026-07-08", "2026-07-10")
        texts = " ".join(i["text"] for i in out["insights"])
        assert "Room 224" in texts

    def test_empty_window_yields_fallback_insight(self):
        out = compute_daily_insights([], "2026-07-10", "2026-07-10")
        assert len(out["insights"]) == 1
        assert out["insights"][0]["level"] == "info"

    def test_incomplete_cycles_insight(self):
        days = compute_daily_insights([
            _checkout("101", "2026-07-10 08:00:00"),
            _checkout("101", "2026-07-10 14:00:00"),
            _approved("101", "2026-07-10 15:00:00"),
        ], "2026-07-10", "2026-07-10")
        assert days["totals"]["incomplete_cycles"] == 1
        texts = " ".join(i["text"] for i in days["insights"])
        assert "never marked ready" in texts

    def test_all_insights_have_required_shape(self):
        out = generate_insights([], [], {
            "cleanings": 0, "skipped_housekeeping": 0,
            "median_turnaround_min": None,
        })
        for ins in out:
            assert ins["level"] in ("good", "warn", "info")
            assert isinstance(ins["text"], str) and ins["text"]
