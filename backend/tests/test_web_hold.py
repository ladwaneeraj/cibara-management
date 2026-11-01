"""POST /web/hold: race-safe pending_payment booking (no overbooking)."""
from datetime import datetime, timedelta

import pytest

import config
from cibara_api.core.ratelimit import limiter
from services import availability_service as av


@pytest.fixture(autouse=True)
def _web_on():
    """Closed-flag defaults to False; open it with a known buffer and hold TTL."""
    config.settings_ref.document("web_config").set(
        {"online_bookings_enabled": True, "buffer": 1, "cleaning_gap_minutes": 120,
         "hold_ttl_minutes": 10})
    config.invalidate_web_config_cache()
    yield
    config.invalidate_web_config_cache()


def _future(days_ahead=10, hour=14):
    d = datetime.now(config.IST) + timedelta(days=days_ahead)
    return d.strftime("%Y-%m-%d"), f"{hour:02d}:00"


def _body(**kw):
    date, time_ = _future()
    body = {"category": "premium", "check_in_date": date, "check_in_time": time_,
            "days": 2, "guests": 2, "guest_name": "Asha Rao", "guest_mobile": "9876543210"}
    body.update(kw)
    return body


def _book(room, date, days=1):
    co = (datetime.strptime(date, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")
    config.bookings_ref.document(f"b-{room}-{date}").set({
        "room": room, "guest_name": "G", "guest_mobile": "9999999999",
        "check_in_date": date, "check_in_time": "00:00", "check_out_date": co,
        "status": "confirmed", "booking_source": "web", "guest_count": 2, "days": days + 1,
    })


def _pending():
    return [d for d in config.bookings_ref.stream()
            if (d.to_dict() or {}).get("status") == "pending_payment"]


def test_hold_creates_pending_payment(client):
    body = _body(category="premium_ac", guests=3, days=2, guest_email="a@example.com")
    r = client.post("/web/hold", json=body)
    assert r.status_code == 200, r.text
    out = r.json()
    assert set(out) == {"booking_id", "amount", "expires_at"}
    expected = av.web_quote("premium", 3, 2, ac=True)
    assert out["amount"] == expected and isinstance(out["amount"], int)

    doc = config.bookings_ref.document(out["booking_id"]).get()
    assert doc.exists
    b = doc.to_dict()
    assert b["status"] == "pending_payment"
    assert b["booking_source"] == "web"
    assert b["payment_source"] == "hotel"
    assert b["room"] in config.CATEGORY_POOLS["premium"]
    assert b["guest_name"] == "Asha Rao" and b["guest_mobile"] == "9876543210"
    assert b["guest_email"] == "a@example.com"
    assert b["check_in_date"] == body["check_in_date"]
    assert b["check_in_time"] == body["check_in_time"]
    assert b["days"] == 2 and b["guest_count"] == 3
    assert b["is_ac"] is True
    assert b["total_amount"] == expected and b["paid_amount"] == 0 and b["balance"] == expected
    # Defense-in-depth: the derived check-out date is always persisted.
    co = (datetime.strptime(body["check_in_date"], "%Y-%m-%d") + timedelta(days=2)).strftime("%Y-%m-%d")
    assert b["check_out_date"] == co
    assert b["booking_date"] and b["created_at"]
    # expires_at is ~hold_ttl_minutes ahead and matches the response.
    assert b["expires_at"] == out["expires_at"]
    exp = datetime.fromisoformat(b["expires_at"])
    delta = exp - datetime.now(config.IST)
    assert timedelta(minutes=9) < delta <= timedelta(minutes=10)


def test_hold_omits_blank_email(client):
    r = client.post("/web/hold", json=_body())
    b = config.bookings_ref.document(r.json()["booking_id"]).get().to_dict()
    assert "guest_email" not in b
    assert b["is_ac"] is False


def test_hold_bumps_pool_sentinel(client):
    """The per-pool lock doc is created (merge) and bumped on every hold."""
    lock = config.db.collection("web_pool_locks").document("premium")
    assert not lock.get().exists
    assert client.post("/web/hold", json=_body()).status_code == 200
    assert lock.get().to_dict()["v"] == 1
    assert client.post("/web/hold", json=_body()).status_code == 200
    assert lock.get().to_dict()["v"] == 2


def test_premium_and_premium_ac_share_one_sentinel(client):
    client.post("/web/hold", json=_body(category="premium"))
    client.post("/web/hold", json=_body(category="premium_ac"))
    assert config.db.collection("web_pool_locks").document("premium").get().to_dict()["v"] == 2


def test_hold_respects_buffer(client):
    date, _ = _future()
    # deluxe pool = 5 rooms, buffer 1 -> 4 offerable. Book 4 -> only the buffer room is left.
    for room in config.CATEGORY_POOLS["deluxe"][:4]:
        _book(room, date, days=3)
    r = client.post("/web/hold", json=_body(category="deluxe", guests=2))
    assert r.status_code == 409, r.text
    assert _pending() == []


def test_second_hold_on_last_room_sold_out(client):
    date, _ = _future()
    # deluxe: 5 rooms, buffer 1; booking 3 leaves exactly ONE offerable room.
    for room in config.CATEGORY_POOLS["deluxe"][:3]:
        _book(room, date, days=3)
    first = client.post("/web/hold", json=_body(category="deluxe", guests=2))
    assert first.status_code == 200, first.text
    second = client.post("/web/hold", json=_body(category="deluxe", guests=2))
    assert second.status_code == 409, second.text
    assert len(_pending()) == 1


def test_pending_hold_counts_as_occupied(client):
    date, _ = _future()
    for room in config.CATEGORY_POOLS["deluxe"][:2]:
        _book(room, date, days=3)
    # 5 rooms - 2 booked - buffer 1 = 2 offerable: two holds succeed...
    assert client.post("/web/hold", json=_body(category="deluxe", guests=2)).status_code == 200
    # ...so exactly one is left; a held room is busy for the overlapping window.
    avail = {"category": "deluxe", "check_in_date": date, "check_in_time": "14:00",
             "days": 2, "guests": 2}
    assert client.post("/web/availability", json=avail).json()["available"] is True
    assert client.post("/web/hold", json=_body(category="deluxe", guests=2)).status_code == 200
    assert client.post("/web/availability", json=avail).json()["available"] is False


def test_hold_rejected_when_closed(client):
    config.settings_ref.document("web_config").set({"online_bookings_enabled": False})
    config.invalidate_web_config_cache()
    r = client.post("/web/hold", json=_body())
    assert r.status_code == 403
    assert r.json() == {"enabled": False}
    assert _pending() == []
    # Closed gate precedes validation: junk gets the 403, not a 400.
    assert client.post("/web/hold", json={"category": "x"}).status_code == 403


def test_hold_rejects_bad_input(client):
    past = datetime.now(config.IST) - timedelta(days=1)
    cases = {
        "unknown category": _body(category="suite"),
        "missing category": {k: v for k, v in _body().items() if k != "category"},
        "days zero": _body(days=0),
        "days negative": _body(days=-3),
        "days absurd": _body(days=31),
        "days string": _body(days="2"),
        "days bool": _body(days=True),
        "guests zero": _body(guests=0),
        "guests over premium max": _body(category="premium", guests=5),
        "guests over deluxe max": _body(category="deluxe", guests=4),
        "bad date": _body(check_in_date="not-a-date"),
        "bad time": _body(check_in_time="25:99"),
        "past check-in": _body(check_in_date=past.strftime("%Y-%m-%d"),
                               check_in_time=past.strftime("%H:%M")),
        "blank name": _body(guest_name="   "),
        "missing name": {k: v for k, v in _body().items() if k != "guest_name"},
        "non-string name": _body(guest_name=123),
        "blank mobile": _body(guest_mobile=""),
        "missing mobile": {k: v for k, v in _body().items() if k != "guest_mobile"},
        "non-string email": _body(guest_email=5),
    }
    for name, body in cases.items():
        r = client.post("/web/hold", json=body)
        assert r.status_code == 400, f"{name}: {r.status_code} {r.text}"
    assert client.post("/web/hold", json=[1, 2]).status_code == 400
    assert _pending() == []


def test_hold_ignores_client_supplied_price_and_room(client):
    r = client.post("/web/hold", json=_body(amount=1, total_amount=1, price=1, room="200",
                                            status="confirmed", paid_amount=999))
    assert r.status_code == 200
    b = config.bookings_ref.document(r.json()["booking_id"]).get().to_dict()
    assert b["total_amount"] == av.web_quote("premium", 2, 2, ac=False)
    assert b["status"] == "pending_payment" and b["paid_amount"] == 0


def test_hold_rate_limited_per_ip(client):
    try:
        codes = [client.post("/web/hold", json=_body(guest_name=" ")).status_code
                 for _ in range(21)]
        assert codes[:20] == [400] * 20
        assert codes[20] == 429
    finally:
        limiter.reset()
