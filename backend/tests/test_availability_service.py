"""Shared availability service: the single source of truth for room availability."""
from datetime import datetime, timedelta

import config
from services import availability_service as av
from services import blocks_service

IST = config.IST
NOW = IST.localize(datetime(2026, 10, 20, 9, 0))


def _dt(y, m, d, h=0, mi=0):
    return IST.localize(datetime(y, m, d, h, mi))


def _booking(bid, room, ci, co, *, source="web", time="10:00", days=None, status="confirmed"):
    doc = {
        "room": room, "guest_name": "G", "guest_mobile": "9999999999",
        "check_in_date": ci, "check_in_time": time, "check_out_date": co,
        "status": status, "booking_source": source, "guest_count": 2,
    }
    if days is not None:
        doc["days"] = days
    config.bookings_ref.document(bid).set(doc)


def _occupy(room, checkin_time, renewal_count=0):
    config.rooms_ref.document(room).set({
        "status": "occupied", "checkin_time": checkin_time,
        "renewal_count": renewal_count, "guest": "Walk-in",
    })


def _set_web_config(**kw):
    config.settings_ref.document("web_config").set(kw)
    config.invalidate_web_config_cache()


def _free(category="premium", checkin=None, days=1, guests=2):
    return av.pool_free_rooms(category, checkin, days, guests, now=NOW)


def test_category_pools_reexported():
    assert av.CATEGORY_POOLS is config.CATEGORY_POOLS


def test_web_window_blocks_overlapping_web_booking():
    # Confirmed web booking 2026-10-21 10:00 -> 2026-10-22 10:00 (+gap).
    _booking("b1", "200", "2026-10-21", "2026-10-22", days=1, time="10:00")
    assert "200" not in _free(checkin=_dt(2026, 10, 21, 20, 0))
    assert "200" in _free(checkin=_dt(2026, 10, 24, 20, 0))
    # Other rooms unaffected.
    assert "201" in _free(checkin=_dt(2026, 10, 21, 20, 0))


def test_pending_payment_blocks_but_cancelled_does_not():
    _booking("b1", "200", "2026-10-21", "2026-10-22", days=1, status="pending_payment")
    _booking("b2", "201", "2026-10-21", "2026-10-22", days=1, status="cancelled")
    free = _free(checkin=_dt(2026, 10, 21, 20, 0))
    assert "200" not in free and "201" in free


def test_live_walkin_precise_same_day_turnover():
    now = _dt(2026, 10, 20, 12, 0)
    _occupy("200", "2026-10-20 08:00", renewal_count=0)  # busy until 10-21 08:00 + gap
    blocked = av.pool_free_rooms("premium", _dt(2026, 10, 20, 18, 0), 1, 2, now=now)
    assert "200" not in blocked
    free = av.pool_free_rooms("premium", _dt(2026, 10, 21, 12, 0), 1, 2, now=now)
    assert "200" in free


def test_walkin_renewal_extends_stay():
    now = _dt(2026, 10, 20, 12, 0)
    _occupy("200", "2026-10-20 08:00", renewal_count=1)  # busy until 10-22 08:00 + gap
    assert "200" not in av.pool_free_rooms("premium", _dt(2026, 10, 21, 12, 0), 1, 2, now=now)
    assert "200" in av.pool_free_rooms("premium", _dt(2026, 10, 22, 12, 0), 1, 2, now=now)


def test_walkin_outside_pool_ignored():
    now = _dt(2026, 10, 20, 12, 0)
    _occupy("101", "2026-10-20 08:00")
    assert set(av.pool_free_rooms("premium", _dt(2026, 10, 20, 18, 0), 1, 2, now=now)) == set(
        config.CATEGORY_POOLS["premium"])


def test_date_only_booking_conservative_whole_span():
    # OTA booking 10-21..10-23: whole span blocked regardless of time of day.
    _booking("b1", "200", "2026-10-21", "2026-10-23", source="mmt", time="")
    for h in (0, 6, 12, 23):
        assert "200" not in _free(checkin=_dt(2026, 10, 21, h, 30)), h
    assert "200" not in _free(checkin=_dt(2026, 10, 22, 23, 0))
    # Checkout midnight + gap: a window starting well after is free.
    assert "200" in _free(checkin=_dt(2026, 10, 23, 12, 0))
    # A window ending before the booking's check-in midnight is free.
    assert "200" in _free(checkin=_dt(2026, 10, 19, 22, 0), days=1)


def test_web_booking_without_days_falls_back_to_whole_span():
    _booking("b1", "200", "2026-10-21", "2026-10-23", source="web", time="10:00")  # no days
    assert "200" not in _free(checkin=_dt(2026, 10, 22, 20, 0))


def test_web_booking_with_unparseable_time_falls_back_to_whole_span():
    _booking("b1", "200", "2026-10-21", "2026-10-23", source="web", time="soon", days=1)
    assert "200" not in _free(checkin=_dt(2026, 10, 22, 20, 0))


def test_premium_ac_and_nonac_share_pool():
    # A booking on a room in the 200-206 pool reduces availability whether the
    # booking was AC or non-AC; the query is category-based, not AC-based.
    _booking("b1", "204", "2026-10-21", "2026-10-22", source="normal", time="14:00")
    before = set(config.CATEGORY_POOLS["premium"])
    free = _free(category="premium", checkin=_dt(2026, 10, 21, 15, 0))
    assert "204" not in free
    assert len(free) == len(before) - 1


def test_deluxe_pool_independent_of_premium():
    for i, room in enumerate(config.CATEGORY_POOLS["premium"]):
        _booking(f"p{i}", room, "2026-10-21", "2026-10-22", days=1)
    ci = _dt(2026, 10, 21, 12, 0)
    assert _free(category="premium", checkin=ci) == []
    assert set(_free(category="deluxe", checkin=ci)) == set(config.CATEGORY_POOLS["deluxe"])


def test_cleaning_gap_applied():
    # Occupant ends 2026-10-22 10:00; gap 120 min -> room reusable from 12:00.
    _booking("b1", "200", "2026-10-21", "2026-10-22", days=1, time="10:00")
    assert "200" not in _free(checkin=_dt(2026, 10, 22, 10, 0))
    assert "200" not in _free(checkin=_dt(2026, 10, 22, 11, 59))
    assert "200" in _free(checkin=_dt(2026, 10, 22, 12, 0))   # half-open: touching is free
    assert "200" in _free(checkin=_dt(2026, 10, 22, 12, 1))


def test_cleaning_gap_follows_config():
    _set_web_config(cleaning_gap_minutes=30)
    _booking("b1", "200", "2026-10-21", "2026-10-22", days=1, time="10:00")
    assert "200" not in _free(checkin=_dt(2026, 10, 22, 10, 29))
    assert "200" in _free(checkin=_dt(2026, 10, 22, 10, 30))


def test_window_end_touching_next_booking_start_is_free():
    # Next booking starts 10-23 10:00; our window [10-22 10:00, 10-23 10:00] ends
    # exactly then -> half-open, no conflict.
    _booking("b1", "200", "2026-10-23", "2026-10-24", days=1, time="10:00")
    assert "200" in _free(checkin=_dt(2026, 10, 22, 10, 0))
    assert "200" not in _free(checkin=_dt(2026, 10, 22, 10, 1))


def test_multi_day_window_spans_24h_periods():
    _booking("b1", "200", "2026-10-23", "2026-10-24", days=1, time="10:00")
    # 3 x 24h from 10-21 10:00 ends 10-24 10:00 -> overlaps; 2 days ends 10-23 10:00 -> free.
    assert "200" not in _free(checkin=_dt(2026, 10, 21, 10, 0), days=3)
    assert "200" in _free(checkin=_dt(2026, 10, 21, 10, 0), days=2)


def test_buffer_reduces_offerable():
    ci = _dt(2026, 10, 25, 12, 0)
    pool_n = len(config.CATEGORY_POOLS["premium"])
    config.invalidate_web_config_cache()
    assert len(av.web_offerable_rooms("premium", ci, 1, 2, now=NOW)) == pool_n - 1  # default buffer 1
    _set_web_config(buffer=3)
    offer = av.web_offerable_rooms("premium", ci, 1, 2, now=NOW)
    free = av.pool_free_rooms("premium", ci, 1, 2, now=NOW)
    assert len(offer) == pool_n - 3
    assert offer == free[:pool_n - 3]  # the LAST rooms in preference order are held back
    _set_web_config(buffer=0)
    assert av.web_offerable_rooms("premium", ci, 1, 2, now=NOW) == free


def test_buffer_larger_than_free_returns_empty():
    _set_web_config(buffer=50)
    assert av.web_offerable_rooms("premium", _dt(2026, 10, 25, 12), 1, 2, now=NOW) == []


def test_block_removes_room():
    blocks_service.create_block("room", room="202", start=_dt(2026, 10, 21), end=_dt(2026, 10, 23),
                                reason="repair", created_by="a")
    assert "202" not in _free(checkin=_dt(2026, 10, 22, 12, 0))
    assert "202" in _free(checkin=_dt(2026, 10, 26, 12, 0))


def test_category_block_removes_whole_pool():
    blocks_service.create_block("category", category="deluxe", start=_dt(2026, 10, 21),
                                end=_dt(2026, 10, 23), reason="owner", created_by="a")
    assert _free(category="deluxe", checkin=_dt(2026, 10, 22, 12, 0)) == []
    assert _free(category="premium", checkin=_dt(2026, 10, 22, 12, 0)) != []


def test_block_has_no_cleaning_gap():
    # Block ends 10-23 00:00; a window starting 10-23 00:30 is free (no gap on blocks).
    blocks_service.create_block("room", room="202", start=_dt(2026, 10, 21), end=_dt(2026, 10, 23),
                                reason="repair", created_by="a")
    assert "202" in _free(checkin=_dt(2026, 10, 23, 0, 30))


def test_naive_and_aware_datetimes_consistent():
    # Naive walk-in string + naive window + aware window all agree (stored naive = IST).
    _occupy("200", "2026-10-20 08:00")
    now = _dt(2026, 10, 20, 12, 0)
    aware = av.pool_free_rooms("premium", _dt(2026, 10, 20, 18, 0), 1, 2, now=now)
    naive = av.pool_free_rooms("premium", datetime(2026, 10, 20, 18, 0), 1, 2,
                               now=datetime(2026, 10, 20, 12, 0))
    assert aware == naive and "200" not in aware
    # A different tz expressing the same instant gives the same answer.
    import pytz
    utc = pytz.utc.normalize(_dt(2026, 10, 20, 18, 0).astimezone(pytz.utc))
    assert av.pool_free_rooms("premium", utc, 1, 2, now=now) == aware
    # And the intervals returned are all IST-aware.
    busy = av.occupied_intervals(["200"], _dt(2026, 10, 20, 18), _dt(2026, 10, 21, 18), now=now)
    for s, e, _kind in busy["200"]:
        assert s.tzinfo is not None and e.tzinfo is not None


def test_exclude_booking_id_ignores_own_hold():
    _booking("hold1", "200", "2026-10-21", "2026-10-22", days=1, status="pending_payment")
    ci = _dt(2026, 10, 21, 10, 0)
    assert "200" not in av.pool_free_rooms("premium", ci, 1, 2, now=NOW)
    assert "200" in av.pool_free_rooms("premium", ci, 1, 2, now=NOW, exclude_booking_id="hold1")
    assert "200" not in av.pool_free_rooms("premium", ci, 1, 2, now=NOW, exclude_booking_id="other")


def test_ordered_by_guest_preference():
    ci = _dt(2026, 10, 25, 12, 0)
    assert av.pool_free_rooms("premium", ci, 1, 2, now=NOW)[:3] == ["200", "201", "206"]
    assert av.pool_free_rooms("premium", ci, 1, 4, now=NOW)[:3] == ["203", "204", "205"]


def test_occupied_intervals_shape_and_kinds():
    _booking("b1", "200", "2026-10-21", "2026-10-22", days=1, time="10:00")
    _booking("b2", "201", "2026-10-21", "2026-10-23", source="mmt", time="")
    ws, we = _dt(2026, 10, 21, 12), _dt(2026, 10, 22, 12)
    busy = av.occupied_intervals(["200", "201", "202"], ws, we, now=NOW)
    assert set(busy) == {"200", "201", "202"}
    assert busy["202"] == []
    s, e, kind = busy["200"][0]
    assert kind == "web"
    assert s == _dt(2026, 10, 21, 10) and e == _dt(2026, 10, 22, 12)  # +24h +120min gap
    s, e, kind = busy["201"][0]
    assert kind == "date_only"
    assert s == _dt(2026, 10, 21) and e == _dt(2026, 10, 23, 2)


def test_unknown_category_returns_empty():
    assert av.pool_free_rooms("suite", _dt(2026, 10, 25, 12), 1, 2, now=NOW) == []


def test_overstaying_walkin_still_blocks_now():
    # Walk-in nominally ended yesterday 08:00 but is still occupied: busy until now (+gap).
    now = _dt(2026, 10, 20, 12, 0)
    _occupy("200", "2026-10-19 08:00")
    assert "200" not in av.pool_free_rooms("premium", _dt(2026, 10, 20, 13, 0), 1, 2, now=now)
    assert "200" in av.pool_free_rooms("premium", _dt(2026, 10, 20, 14, 0), 1, 2, now=now)
