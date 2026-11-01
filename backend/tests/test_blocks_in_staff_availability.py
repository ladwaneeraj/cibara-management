"""Blocks are honoured by the existing staff availability paths (additive):
/check_availability and /create_multi_booking."""
from datetime import datetime

import config
from services import blocks_service

IST = config.IST

CI, CO = "2027-03-10", "2027-03-12"


def _dt(y, m, d, h=0, mi=0):
    return IST.localize(datetime(y, m, d, h, mi))


def _available(client, admin, ci=CI, co=CO):
    r = client.post("/check_availability", headers=admin,
                    json={"check_in_date": ci, "check_out_date": co})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True, body
    return body["available_rooms"]


def _multi_payload(rooms):
    return {
        "check_in_date": CI, "check_in_time": "12:00", "check_out_date": CO,
        "booking_source": "normal", "payment_method": "cash",
        "rooms": [{"room": r, "guest_name": f"Guest {r}", "guest_mobile": "9999999999",
                   "total_amount": 2000, "advance": 0} for r in rooms],
    }


def test_unblocked_room_unaffected(client, admin):
    """No block -> every room (all seeded rooms) is available, sorted as before."""
    got = _available(client, admin)
    all_rooms = [d.id for d in config.rooms_ref.stream()]
    assert got and sorted(got) == sorted(all_rooms)
    assert got == sorted(all_rooms, key=lambda r: (int(r) if r.isdigit() else float("inf"), r))


def test_check_availability_excludes_blocked_room(client, admin):
    baseline = _available(client, admin)
    assert "201" in baseline
    blocks_service.create_block("room", room="201", start=_dt(2027, 3, 11), end=_dt(2027, 3, 13),
                                reason="AC repair", created_by="admin")
    got = _available(client, admin)
    assert "201" not in got
    assert got == [r for r in baseline if r != "201"]
    # a window entirely outside the block is unaffected
    assert _available(client, admin, "2027-04-01", "2027-04-03") == baseline


def test_multi_booking_rejects_blocked_room(client, admin):
    blocks_service.create_block("room", room="202", start=_dt(2027, 3, 10), end=_dt(2027, 3, 13),
                                reason="renovation", created_by="admin")
    r = client.post("/create_multi_booking", headers=admin, json=_multi_payload(["201", "202"]))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is False
    assert "202" in body["message"]
    assert "201" not in body["message"]
    assert list(config.bookings_ref.stream()) == []
