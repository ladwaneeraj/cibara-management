"""Sweep of expired web holds: pending_payment past expires_at -> "expired"."""
from datetime import datetime, timedelta

import pytest

import config
from routes import web
from services import availability_service as av

TOKEN = "sweep-test-token-123"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("WEB_SWEEP_TOKEN", TOKEN)
    config.settings_ref.document("web_config").set(
        {"online_bookings_enabled": True, "buffer": 1, "cleaning_gap_minutes": 120,
         "hold_ttl_minutes": 10})
    config.invalidate_web_config_cache()
    yield
    config.invalidate_web_config_cache()


def _stay():
    d = datetime.now(config.IST) + timedelta(days=20)
    return d.strftime("%Y-%m-%d"), "14:00"


def _hold(bid, room, expires_delta_min, status="pending_payment", **extra):
    date, time_ = _stay()
    doc = {
        "room": room, "guest_name": "Asha", "guest_mobile": "9876543210",
        "check_in_date": date, "check_in_time": time_,
        "check_out_date": (datetime.strptime(date, "%Y-%m-%d") + timedelta(days=2)).strftime("%Y-%m-%d"),
        "days": 2, "guest_count": 2, "status": status, "booking_source": "web",
        "total_amount": 4500, "paid_amount": 0, "balance": 4500,
        "expires_at": (datetime.now(config.IST) + timedelta(minutes=expires_delta_min)).isoformat(),
    }
    doc.update(extra)
    config.bookings_ref.document(bid).set(doc)
    return bid


def _status(bid):
    return config.bookings_ref.document(bid).get().to_dict()["status"]


def test_sweep_expires_old_hold():
    _hold("old", "101", -5)
    assert web.sweep_expired_holds() == 1
    assert _status("old") == "expired"


def test_sweep_leaves_unexpired():
    _hold("fresh", "101", +5)
    assert web.sweep_expired_holds() == 0
    assert _status("fresh") == "pending_payment"


def test_sweep_leaves_confirmed():
    _hold("paid", "101", -5, status="confirmed")
    assert web.sweep_expired_holds() == 0
    assert _status("paid") == "confirmed"


def test_sweep_idempotent():
    _hold("old", "101", -5)
    assert web.sweep_expired_holds() == 1
    assert web.sweep_expired_holds() == 0
    assert _status("old") == "expired"


def test_sweep_explicit_now_and_naive_expiry():
    _hold("a", "101", +5)
    later = datetime.now(config.IST) + timedelta(minutes=30)
    assert web.sweep_expired_holds(now=later) == 1
    # A naive (no tz) expires_at is read as IST.
    naive = (datetime.now(config.IST) - timedelta(minutes=3)).replace(tzinfo=None).isoformat()
    _hold("b", "102", 0, expires_at=naive)
    assert web.sweep_expired_holds() == 1
    assert _status("b") == "expired"


@pytest.mark.parametrize("bad", ["garbage", "", None, 12345])
def test_sweep_leaves_malformed_expiry(bad):
    _hold("weird", "101", 0, expires_at=bad)
    assert web.sweep_expired_holds() == 0
    assert _status("weird") == "pending_payment"


def test_sweep_missing_expiry_left():
    _hold("noexp", "101", 0)
    config.bookings_ref.document("noexp").update({"expires_at": config.firestore.DELETE_FIELD}) \
        if hasattr(config, "firestore") else None
    from firebase_admin import firestore
    config.bookings_ref.document("noexp").update({"expires_at": firestore.DELETE_FIELD})
    assert web.sweep_expired_holds() == 0
    assert _status("noexp") == "pending_payment"


def test_swept_room_becomes_available():
    date, time_ = _stay()
    checkin = config.IST.localize(datetime.strptime(f"{date} {time_}", "%Y-%m-%d %H:%M"))
    pool = list(config.CATEGORY_POOLS["premium"])
    now = datetime.now(config.IST)
    # Hold every room of the pool with an already-expired hold: nothing offerable.
    for i, room in enumerate(pool):
        _hold(f"h{i}", room, -5)
    assert av.web_offerable_rooms("premium", checkin, 2, 2, now=now) == []
    assert web.sweep_expired_holds() == len(pool)
    assert av.web_offerable_rooms("premium", checkin, 2, 2, now=now) != []


def test_swept_room_available_via_endpoint(client):
    date, time_ = _stay()
    for i, room in enumerate(config.CATEGORY_POOLS["premium"]):
        _hold(f"h{i}", room, -5)
    body = {"category": "premium", "check_in_date": date, "check_in_time": time_,
            "days": 2, "guests": 2}
    assert client.post("/web/availability", json=body).json()["available"] is False
    assert client.post("/web/sweep", headers={"X-Sweep-Token": TOKEN}).status_code == 200
    assert client.post("/web/availability", json=body).json()["available"] is True


def test_sweep_endpoint_requires_token(client):
    _hold("old", "101", -5)
    assert client.post("/web/sweep").status_code == 403
    assert client.post("/web/sweep", headers={"X-Sweep-Token": "wrong"}).status_code == 403
    assert _status("old") == "pending_payment"


def test_sweep_endpoint_forbidden_when_env_unset(client, monkeypatch):
    monkeypatch.delenv("WEB_SWEEP_TOKEN", raising=False)
    _hold("old", "101", -5)
    assert client.post("/web/sweep", headers={"X-Sweep-Token": ""}).status_code == 403
    assert client.post("/web/sweep", headers={"X-Sweep-Token": "anything"}).status_code == 403
    assert _status("old") == "pending_payment"


def test_sweep_endpoint_ok(client):
    _hold("old", "101", -5)
    _hold("fresh", "102", +5)
    r = client.post("/web/sweep", headers={"X-Sweep-Token": TOKEN})
    assert r.status_code == 200, r.text
    # The sweep also runs the owner-alert poll, so the body carries a `notified`
    # count alongside `swept`; assert on the swept value, not the whole dict.
    assert r.json()["swept"] == 1
    assert _status("old") == "expired" and _status("fresh") == "pending_payment"
    assert client.post("/web/sweep", headers={"X-Sweep-Token": TOKEN}).json()["swept"] == 0
