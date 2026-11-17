"""Pure aggregation for first-party website analytics (no Firestore, no Flask)."""
from services.web_analytics_service import compute_web_analytics


def _ev(**kw):
    return kw


def test_counts_visitors_views_and_clicks():
    events = [
        _ev(type="page_view", sid="a", day="2026-11-16", page="/"),
        _ev(type="page_view", sid="a", day="2026-11-16", page="/rooms"),
        _ev(type="page_view", sid="b", day="2026-11-16", page="/"),
        _ev(type="whatsapp_click", sid="b", day="2026-11-16", room="double-room"),
        _ev(type="scroll_depth", sid="a", day="2026-11-16"),  # not a click, not a view
    ]
    out = compute_web_analytics(events, window_from="2026-11-16", window_to="2026-11-16")
    assert out["totals"] == {"events": 5, "page_views": 3, "visitors": 2, "clicks": 1,
                             "bookings": 0, "revenue": 0}
    assert out["window"] == {"from": "2026-11-16", "to": "2026-11-16"}


def test_paid_bookings_add_count_and_revenue():
    events = [_ev(type="page_view", sid="a", day="2026-11-16")]
    paid = [{"total_amount": 1800}, {"total_amount": 1200}, {"total_amount": "oops"}]
    out = compute_web_analytics(events, window_from="2026-11-16", window_to="2026-11-16", bookings=paid)
    assert out["totals"]["bookings"] == 3
    assert out["totals"]["revenue"] == 3000  # unparseable amount counts as 0


def test_top_pages_rooms_locations_and_referrers():
    events = [
        _ev(type="page_view", sid="a", day="2026-11-16", page="/", country="India", city="Harihar", device="mobile"),
        _ev(type="page_view", sid="b", day="2026-11-16", page="/", country="India", city="Bengaluru", device="desktop"),
        _ev(type="page_view", sid="c", day="2026-11-16", page="/rooms", country="India", city="Harihar", device="mobile"),
        _ev(type="room_view", sid="c", day="2026-11-16", room="premium-ac-room"),
        _ev(type="book_online_click", sid="c", day="2026-11-16", room="premium-ac-room", ref="google.com"),
    ]
    out = compute_web_analytics(events, window_from="2026-11-16", window_to="2026-11-16")
    assert out["top_pages"][0] == {"name": "/", "value": 2}
    assert out["by_room"][0] == {"name": "premium-ac-room", "value": 2}
    assert out["by_country"][0] == {"name": "India", "value": 3}
    cities = {r["name"]: r["value"] for r in out["by_city"]}
    assert cities == {"Harihar": 2, "Bengaluru": 1}
    assert {r["name"]: r["value"] for r in out["by_device"]} == {"mobile": 2, "desktop": 1}
    assert out["by_referrer"][0] == {"name": "google.com", "value": 1}


def test_daily_series_and_unique_visitors_per_day():
    events = [
        _ev(type="page_view", sid="a", day="2026-11-15"),
        _ev(type="page_view", sid="a", day="2026-11-15"),  # same visitor, 2 views
        _ev(type="page_view", sid="b", day="2026-11-16"),
    ]
    out = compute_web_analytics(events, window_from="2026-11-15", window_to="2026-11-16")
    assert out["daily"] == [
        {"day": "2026-11-15", "views": 2, "visitors": 1},
        {"day": "2026-11-16", "views": 1, "visitors": 1},
    ]


def test_empty_is_all_zero():
    out = compute_web_analytics([], window_from="2026-11-16", window_to="2026-11-16")
    assert out["totals"] == {"events": 0, "page_views": 0, "visitors": 0, "clicks": 0,
                             "bookings": 0, "revenue": 0}
    assert out["daily"] == [] and out["top_pages"] == [] and out["by_room"] == []
