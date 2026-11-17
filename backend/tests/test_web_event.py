"""Public POST /web/event ingest and the authed GET /analytics/web over it."""
from datetime import datetime

import config


def _today():
    return datetime.now(config.IST).strftime("%Y-%m-%d")


def _post(client, **body):
    return client.post("/web/event", json=body)


def _overview(client, headers, day=None):
    day = day or _today()
    # fresh=true bypasses the per-window cache, which is module-level and would
    # otherwise leak between tests sharing the session-scoped client.
    return client.get("/api/v2/analytics/web",
                      params={"start": day, "end": day, "fresh": "true"}, headers=headers)


def test_event_ingest_is_public_and_returns_204(client):
    assert _post(client, type="page_view", page="/", sid="s1").status_code == 204


def test_non_dict_body_is_dropped(client):
    assert client.post("/web/event", json=["not", "a", "dict"]).status_code == 204


def test_unknown_event_type_is_not_stored(client, admin):
    assert _post(client, type="evil_inject", page="/", sid="s1").status_code == 204
    assert _overview(client, admin).json()["totals"]["events"] == 0


def test_events_flow_through_to_overview(client, admin):
    _post(client, type="page_view", page="/", sid="a", country="India", city="Harihar", device="mobile")
    _post(client, type="page_view", page="/rooms/premium-ac-room", sid="a", room="premium-ac-room")
    _post(client, type="page_view", page="/", sid="b")
    _post(client, type="whatsapp_click", sid="b", room="double-room")

    body = _overview(client, admin).json()
    assert body["totals"] == {"events": 4, "page_views": 3, "visitors": 2, "clicks": 1,
                              "bookings": 0, "revenue": 0}
    assert body["top_pages"][0] == {"name": "/", "value": 2}
    assert {"name": "premium-ac-room", "value": 1} in body["by_room"]


def test_paid_web_bookings_count_toward_totals(client, admin):
    today = _today()
    base = _overview(client, admin).json()["totals"]

    # One confirmed web booking (counts), plus a pending web one and a confirmed
    # walk-in (both ignored) to prove the source/status filter.
    config.bookings_ref.document("wa_paid").set({
        "booking_source": "web", "status": "confirmed", "total_amount": 1800, "booking_date": today})
    config.bookings_ref.document("wa_pending").set({
        "booking_source": "web", "status": "pending_payment", "total_amount": 999, "booking_date": today})
    config.bookings_ref.document("wa_walkin").set({
        "booking_source": "walkin", "status": "confirmed", "total_amount": 500, "booking_date": today})

    after = _overview(client, admin).json()["totals"]
    assert after["bookings"] == base["bookings"] + 1
    assert after["revenue"] == base["revenue"] + 1800


def test_overview_requires_analytics_permission(client, staff):
    day = _today()
    assert client.get("/api/v2/analytics/web", params={"start": day, "end": day}).status_code == 401
    assert client.get("/api/v2/analytics/web", params={"start": day, "end": day},
                      headers=staff).status_code == 403


def test_overview_rejects_reversed_window(client, admin):
    r = client.get("/api/v2/analytics/web",
                   params={"start": "2026-11-16", "end": "2026-11-15"}, headers=admin)
    assert r.status_code == 400
