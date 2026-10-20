"""Blocks: remove a room (or a category's whole pool) from sale for a time range."""
from datetime import datetime, timedelta

import pytest

import config
from services import blocks_service

IST = config.IST


def _dt(y, m, d, h=0, mi=0):
    return IST.localize(datetime(y, m, d, h, mi))


NOW = _dt(2026, 10, 20, 12)


def test_create_and_list_block():
    bid = blocks_service.create_block(
        "room", room="201", start=_dt(2026, 10, 21), end=_dt(2026, 10, 23),
        reason="AC repair", created_by="admin")
    assert bid
    blocks = blocks_service.list_blocks(now=NOW)
    assert len(blocks) == 1
    b = blocks[0]
    assert b["id"] == bid
    assert b["scope"] == "room" and b["room"] == "201"
    assert b["reason"] == "AC repair" and b["created_by"] == "admin"
    assert b["start"].startswith("2026-10-21") and b["end"].startswith("2026-10-23")
    assert b["created_at"]


def test_create_block_validation():
    with pytest.raises(ValueError):
        blocks_service.create_block("room", start=NOW, reason="x", created_by="a")  # no room
    with pytest.raises(ValueError):
        blocks_service.create_block("category", category="suite", start=NOW, reason="x", created_by="a")
    with pytest.raises(ValueError):
        blocks_service.create_block("galaxy", room="201", start=NOW, reason="x", created_by="a")
    with pytest.raises(ValueError):  # end before start
        blocks_service.create_block("room", room="201", start=_dt(2026, 10, 23),
                                    end=_dt(2026, 10, 21), reason="x", created_by="a")


def test_list_blocks_hides_expired():
    blocks_service.create_block("room", room="201", start=_dt(2026, 10, 1), end=_dt(2026, 10, 5),
                                reason="old", created_by="a")
    blocks_service.create_block("room", room="202", start=_dt(2026, 10, 1), end=None,
                                reason="open", created_by="a")
    reasons = {b["reason"] for b in blocks_service.list_blocks(now=NOW)}
    assert reasons == {"open"}


def test_delete_block():
    bid = blocks_service.create_block("room", room="201", start=NOW, reason="x", created_by="a")
    blocks_service.delete_block(bid)
    assert blocks_service.list_blocks(now=NOW) == []
    assert blocks_service.active_blocked_rooms(NOW, NOW + timedelta(days=1), now=NOW) == set()


def test_active_blocked_rooms_specific_room():
    blocks_service.create_block("room", room="201", start=_dt(2026, 10, 21), end=_dt(2026, 10, 23),
                                reason="inside", created_by="a")
    blocks_service.create_block("room", room="202", start=_dt(2026, 11, 1), end=_dt(2026, 11, 3),
                                reason="outside", created_by="a")
    got = blocks_service.active_blocked_rooms(_dt(2026, 10, 22), _dt(2026, 10, 24), now=NOW)
    assert got == {"201"}
    # window entirely before / after the block
    assert blocks_service.active_blocked_rooms(_dt(2026, 10, 24), _dt(2026, 10, 25), now=NOW) == set()
    assert blocks_service.active_blocked_rooms(_dt(2026, 10, 19), _dt(2026, 10, 20), now=NOW) == set()


def test_active_blocked_rooms_category_expands_pool():
    blocks_service.create_block("category", category="premium", start=_dt(2026, 10, 21),
                                end=_dt(2026, 10, 23), reason="renovation", created_by="a")
    got = blocks_service.active_blocked_rooms(_dt(2026, 10, 22), _dt(2026, 10, 22, 6), now=NOW)
    assert got == set(config.CATEGORY_POOLS["premium"])
    assert got == {str(n) for n in range(200, 207)}


def test_open_ended_block_blocks_future():
    blocks_service.create_block("room", room="224", start=NOW, end=None, reason="owner", created_by="a")
    far = _dt(2027, 6, 1)
    assert blocks_service.active_blocked_rooms(far, far + timedelta(days=2), now=NOW) == {"224"}
    # but not before it starts
    assert blocks_service.active_blocked_rooms(_dt(2026, 10, 1), _dt(2026, 10, 2), now=NOW) == set()


def test_accepts_iso_strings_and_naive_as_ist():
    blocks_service.create_block("room", room="201", start="2026-10-21T00:00:00+05:30",
                                end="2026-10-23T00:00:00", reason="x", created_by="a")
    got = blocks_service.active_blocked_rooms("2026-10-22T10:00:00", "2026-10-22T12:00:00", now=NOW)
    assert got == {"201"}


def test_blocked_now_map_for_grid():
    bid = blocks_service.create_block("category", category="deluxe", start=_dt(2026, 10, 20),
                                      end=None, reason="x", created_by="a")
    rid = blocks_service.create_block("room", room="201", start=_dt(2026, 10, 25),
                                      end=_dt(2026, 10, 26), reason="future", created_by="a")
    m = blocks_service.blocked_now_map(now=NOW)
    assert m == {r: bid for r in config.CATEGORY_POOLS["deluxe"]}
    assert rid not in m.values()


# ── staff endpoints ──────────────────────────────────────────────────────────
def test_block_endpoints_roundtrip(client, admin):
    r = client.post("/blocks", headers=admin, json={
        "scope": "room", "room": "203", "start": "2026-10-01T00:00:00", "end": None, "reason": "maintenance"})
    assert r.status_code == 200, r.text
    bid = r.json()["block_id"]
    assert r.json()["success"] is True

    r = client.get("/blocks", headers=admin)
    assert r.status_code == 200
    got = r.json()["blocks"]
    assert [b["id"] for b in got] == [bid]
    assert got[0]["created_by"] == "admin"
    assert r.json()["blocked_now"] == {"203": bid}

    r = client.delete(f"/blocks/{bid}", headers=admin)
    assert r.status_code == 200 and r.json()["success"] is True
    assert client.get("/blocks", headers=admin).json()["blocks"] == []


def test_block_endpoint_rejects_bad_input(client, admin):
    r = client.post("/blocks", headers=admin, json={"scope": "room", "start": "2026-10-21T00:00:00",
                                                    "reason": "x"})
    assert r.status_code == 400
    r = client.post("/blocks", headers=admin, json={"scope": "category", "category": "premium",
                                                    "start": "not-a-date", "reason": "x"})
    assert r.status_code == 400
    r = client.delete("/blocks/does-not-exist", headers=admin)
    assert r.status_code == 404


def test_block_endpoints_require_auth_and_permission(client, staff):
    body = {"scope": "room", "room": "203", "start": "2026-10-21T00:00:00", "reason": "x"}
    assert client.post("/blocks", json=body).status_code == 401
    assert client.get("/blocks").status_code == 401
    assert client.post("/blocks", headers=staff, json=body).status_code == 403
    assert client.delete("/blocks/abc", headers=staff).status_code == 403
