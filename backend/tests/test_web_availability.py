"""POST /web/availability: public, server-priced, never leaks a room number."""
from datetime import datetime, timedelta

import pytest

import config
from cibara_api.core.ratelimit import limiter
from services import availability_service as av

ORIGIN = "https://cibaracomforts.test"


@pytest.fixture(autouse=True)
def _web_on():
    """Closed-flag defaults to False; open it with a known buffer for these tests."""
    config.settings_ref.document("web_config").set(
        {"online_bookings_enabled": True, "buffer": 1, "cleaning_gap_minutes": 120})
    config.invalidate_web_config_cache()
    yield
    config.invalidate_web_config_cache()


def _future(days_ahead=10, hour=14):
    d = (datetime.now(config.IST) + timedelta(days=days_ahead))
    return d.strftime("%Y-%m-%d"), f"{hour:02d}:00"


def _body(**kw):
    date, time_ = _future()
    body = {"category": "premium", "check_in_date": date, "check_in_time": time_,
            "days": 2, "guests": 2}
    body.update(kw)
    return body


def _book(room, date, days=1):
    co = (datetime.strptime(date, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")
    config.bookings_ref.document(f"b-{room}-{date}").set({
        "room": room, "guest_name": "G", "guest_mobile": "9999999999",
        "check_in_date": date, "check_in_time": "00:00", "check_out_date": co,
        "status": "confirmed", "booking_source": "web", "guest_count": 2, "days": days + 1,
    })


def test_availability_available_when_free(client):
    r = client.post("/web/availability", json=_body(), headers={"Origin": ORIGIN})
    assert r.status_code == 200, r.text
    assert r.json()["available"] is True
    assert r.json()["currency"] == "INR"
    assert r.headers.get("access-control-allow-origin") == ORIGIN


def test_availability_full_when_pool_exhausted_within_buffer(client):
    date, _ = _future()
    # deluxe pool = 5 rooms, buffer 1 -> 4 offerable. Book 4 -> nothing left to offer.
    for room in config.CATEGORY_POOLS["deluxe"][:4]:
        _book(room, date, days=3)
    r = client.post("/web/availability", json=_body(category="deluxe", guests=2))
    assert r.status_code == 200, r.text
    assert r.json()["available"] is False
    # One fewer booking leaves exactly one offerable room.
    config.bookings_ref.document(f"b-{config.CATEGORY_POOLS['deluxe'][3]}-{date}").delete()
    r = client.post("/web/availability", json=_body(category="deluxe", guests=2))
    assert r.json()["available"] is True


def test_availability_rejected_when_closed(client):
    config.settings_ref.document("web_config").set({"online_bookings_enabled": False})
    config.invalidate_web_config_cache()
    r = client.post("/web/availability", json=_body())
    assert r.status_code == 403
    assert r.json() == {"enabled": False}
    # Closed gate precedes validation: even junk gets the 403, not a 400.
    assert client.post("/web/availability", json={"category": "x"}).status_code == 403


@pytest.mark.parametrize("category,ac,guests,days", [
    ("premium", False, 2, 2), ("premium_ac", True, 3, 1), ("deluxe", False, 3, 4)])
def test_price_is_server_computed(client, category, ac, guests, days):
    pool = av.WEB_BOOKABLE[category]["pool"]
    expected = av.web_quote(pool, guests, days, ac=ac)
    r = client.post("/web/availability",
                    json=_body(category=category, guests=guests, days=days,
                               price=1, amount=1, total=1))
    assert r.status_code == 200, r.text
    assert r.json()["price"] == expected
    assert isinstance(r.json()["price"], int)


def test_premium_ac_costs_more_than_premium(client):
    ac = client.post("/web/availability", json=_body(category="premium_ac")).json()["price"]
    plain = client.post("/web/availability", json=_body(category="premium")).json()["price"]
    assert ac == plain + config.AC_SURCHARGE * 2


def test_no_room_number_leaked(client):
    r = client.post("/web/availability", json=_body())
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"available", "price", "currency"}
    text = r.text
    for room in config.CATEGORY_POOLS["premium"] + config.CATEGORY_POOLS["deluxe"]:
        assert f'"{room}"' not in text
    assert "room" not in text.lower()


def test_rejects_bad_input(client):
    past = (datetime.now(config.IST) - timedelta(days=1))
    cases = {
        "unknown category": _body(category="suite"),
        "missing category": {k: v for k, v in _body().items() if k != "category"},
        "days zero": _body(days=0),
        "days negative": _body(days=-3),
        "days absurd": _body(days=31),
        "days string": _body(days="2"),
        "days bool": _body(days=True),
        "days float": _body(days=1.5),
        "guests zero": _body(guests=0),
        "guests over premium max": _body(category="premium", guests=5),
        "guests over deluxe max": _body(category="deluxe", guests=4),
        "guests string": _body(guests="2"),
        "bad date": _body(check_in_date="not-a-date"),
        "bad time": _body(check_in_time="25:99"),
        "missing time": {k: v for k, v in _body().items() if k != "check_in_time"},
        "past check-in": _body(check_in_date=past.strftime("%Y-%m-%d"),
                               check_in_time=past.strftime("%H:%M")),
    }
    for name, body in cases.items():
        r = client.post("/web/availability", json=body)
        assert r.status_code == 400, f"{name}: {r.status_code} {r.text}"
    # Non-object / non-JSON bodies are rejected too.
    assert client.post("/web/availability", json=[1, 2]).status_code == 400
    assert client.post("/web/availability", content="nope",
                       headers={"Content-Type": "application/json"}).status_code == 400


def test_rate_limited_per_ip(client):
    for _ in range(60):
        assert client.post("/web/availability", json=_body()).status_code == 200
    r = client.post("/web/availability", json=_body())
    assert r.status_code == 429
    limiter.reset()
