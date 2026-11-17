"""
Pure aggregation for first-party website analytics.

routes/analytics.py fetches the raw `web_events` rows (ingested by
routes/web.py's POST /web/event); this turns them into the dashboard payload.
No Firestore, no Flask — unit tested in tests/test_web_analytics_service.py.

An event row is a dict with any of: type, page, room, sid, device, country,
city, ref, day. Only `type` is relied on; everything else is best effort
(the browser omits what it does not have).
"""
from __future__ import annotations

from collections import Counter, defaultdict

# Events that are not a "click" worth counting as engagement.
_NON_CLICK = frozenset({"page_view", "scroll_depth"})


def _ranked(counter, limit):
    return [{"name": name, "value": value} for name, value in counter.most_common(limit)]


def compute_web_analytics(events, *, window_from, window_to, bookings=None):
    """Aggregate raw event rows into the website-analytics dashboard payload.

    `bookings`, when given, is the list of PAID web bookings in the window
    (already filtered to confirmed + booking_source == "web" by the caller);
    their count and ₹ total become the `bookings` / `revenue` totals, so the
    owner sees how the traffic converted.
    """
    page_views = 0
    visitors = set()
    visitor_by_day: dict[str, set] = defaultdict(set)
    views_by_day: dict[str, int] = defaultdict(int)
    pages = Counter()
    rooms = Counter()
    event_types = Counter()
    countries = Counter()
    cities = Counter()
    devices = Counter()
    referrers = Counter()

    for e in events:
        etype = e.get("type")
        if not etype:
            continue
        event_types[etype] += 1
        sid, day = e.get("sid"), e.get("day")
        if sid:
            visitors.add(sid)
            if day:
                visitor_by_day[day].add(sid)
        if etype == "page_view":
            page_views += 1
            if day:
                views_by_day[day] += 1
            if e.get("page"):
                pages[e["page"]] += 1
        if e.get("room"):
            rooms[e["room"]] += 1
        if e.get("country"):
            countries[e["country"]] += 1
        if e.get("city"):
            cities[e["city"]] += 1
        if e.get("device"):
            devices[e["device"]] += 1
        if e.get("ref"):
            referrers[e["ref"]] += 1

    clicks = sum(v for k, v in event_types.items() if k not in _NON_CLICK)

    paid = bookings or []
    def _amount(b):
        try:
            return int(b.get("total_amount") or 0)
        except (TypeError, ValueError):
            return 0
    revenue = sum(_amount(b) for b in paid)

    days = sorted(set(views_by_day) | set(visitor_by_day))
    daily = [{"day": d, "views": views_by_day.get(d, 0),
              "visitors": len(visitor_by_day.get(d, ()))} for d in days]

    return {
        "window": {"from": window_from, "to": window_to},
        "totals": {
            "events": len(events),
            "page_views": page_views,
            "visitors": len(visitors),
            "clicks": clicks,
            "bookings": len(paid),
            "revenue": revenue,
        },
        "daily": daily,
        "top_pages": _ranked(pages, 15),
        "by_room": _ranked(rooms, 10),
        "by_event": _ranked(event_types, 20),
        "by_country": _ranked(countries, 10),
        "by_city": _ranked(cities, 12),
        "by_device": _ranked(devices, 5),
        "by_referrer": _ranked(referrers, 10),
    }
