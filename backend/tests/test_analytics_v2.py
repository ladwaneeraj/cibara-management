"""
/api/v2/analytics/overview (forward facade) and the nightly snapshot ingest,
driven end to end — FastAPI -> legacy Flask blueprint -> in-memory Firestore.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta

import config
import pytest

from tests.conftest import DB


def _d(offset: int) -> str:
    return (datetime.now(config.IST).date() + timedelta(days=offset)).isoformat()


@pytest.fixture(autouse=True)
def _fresh_cache():
    from routes import analytics as an
    an._CACHE.clear()
    yield
    an._CACHE.clear()


def _seed_register():
    DB.collection("bills").document("b1").set({
        "status": "completed", "room": "101", "booking_source": "normal",
        "payment_source": "hotel", "checkin_time": f"{_d(-5)} 12:00",
        "checkout_time": f"{_d(-3)} 10:00", "room_charges_total": 3000})
    DB.collection("bills").document("b2").set({
        "status": "cancelled", "room": "102", "checkin_time": f"{_d(-5)} 12:00",
        "checkout_time": f"{_d(-4)} 10:00", "room_charges_total": 9999})
    DB.collection("bookings").document("bk1").set({
        "check_in_date": _d(2), "check_out_date": _d(4), "status": "confirmed",
        "room": "102", "total_amount": 2000, "booking_date": _d(-3)})


def test_overview_via_v2_facade(client, admin):
    _seed_register()
    r = client.get(f"/api/v2/analytics/overview?start={_d(-6)}&end={_d(0)}", headers=admin)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    assert body["window"] == {"from": _d(-6), "to": _d(0)}
    for k in ("overview", "channel_mix", "pace", "seasonality", "los_leadtime", "findings"):
        assert k in body
    # b1 = 2 nights counted; the cancelled b2 contributes nothing.
    assert body["overview"]["occupancy"]["occupied_room_nights"] >= 2
    assert body["overview"]["occupancy"]["counted_stays"] >= 1
    assert body["pace"]["horizons"]["7"]["occupied_room_nights"] >= 2   # the confirmed booking
    blob = json.dumps(body)
    assert '"b1"' not in blob and '"checkin_time"' not in blob     # aggregates only


def test_overview_permissions(client, admin, manager, staff):
    url = f"/api/v2/analytics/overview?start={_d(-1)}&end={_d(0)}"
    assert client.get(url, headers=admin).status_code == 200
    assert client.get(url, headers=manager).status_code == 403
    assert client.get(url, headers=staff).status_code == 403
    assert client.get(url).status_code == 401


def test_overview_rejects_bad_ranges(client, admin):
    assert client.get(f"/api/v2/analytics/overview?start={_d(0)}&end={_d(-1)}",
                      headers=admin).status_code == 400
    assert client.get("/api/v2/analytics/overview?start=x&end=y",
                      headers=admin).status_code == 422


def test_snapshot_ingest_with_secret_writes_one_doc(client, monkeypatch):
    monkeypatch.setenv("ANALYTICS_INGEST_SECRET", "snap-secret")
    _seed_register()
    r = client.post("/analytics/snapshot", headers={"X-Ingest-Secret": "snap-secret"})
    assert r.status_code == 200, r.text
    docs = DB.dump("analytics_snapshots")
    assert len(docs) == 1
    doc = next(iter(docs.values())) if isinstance(docs, dict) else docs[0]
    assert doc["date"] == _d(0) and set(doc["horizons"]) == {"7", "14", "30"}
    # again -> same date, still one doc
    assert client.post("/analytics/snapshot",
                       headers={"X-Ingest-Secret": "snap-secret"}).status_code == 200
    assert len(DB.dump("analytics_snapshots")) == 1


@pytest.mark.parametrize("headers", [{}, {"X-Ingest-Secret": "nope"}])
def test_snapshot_ingest_rejects_without_valid_secret(client, monkeypatch, headers):
    monkeypatch.setenv("ANALYTICS_INGEST_SECRET", "snap-secret")
    r = client.post("/analytics/snapshot", headers=headers)
    assert r.status_code in (401, 403)
    assert not DB.dump("analytics_snapshots")
