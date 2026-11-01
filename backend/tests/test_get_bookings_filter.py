"""GET /get_bookings must hide transient web-hold states.

A `/web/hold` writes a `pending_payment` booking to reserve a room; the sweep
flips abandoned holds to `expired`. Neither is a real reservation, so the ERP's
human-facing booking views (calendar + list, fed by /get_bookings) must not show
them — only a webhook-confirmed booking should appear (design spec section 2).
Pre-existing ERP statuses (confirmed/cancelled/checked_in/checked_out) are
unaffected.
"""
from datetime import datetime, timedelta

import config


def _seed(doc_id, status, days_ahead=5):
    d = (datetime.now(config.IST) + timedelta(days=days_ahead)).strftime("%Y-%m-%d")
    co = (datetime.now(config.IST) + timedelta(days=days_ahead + 1)).strftime("%Y-%m-%d")
    config.bookings_ref.document(doc_id).set({
        "room": "201", "guest_name": "G", "guest_mobile": "9999999999",
        "check_in_date": d, "check_in_time": "12:00", "check_out_date": co,
        "status": status, "booking_source": "web", "guest_count": 2, "days": 1,
    })


def test_get_bookings_hides_pending_and_expired(client):
    _seed("b-confirmed", "confirmed")
    _seed("b-pending", "pending_payment")
    _seed("b-expired", "expired")
    _seed("b-cancelled", "cancelled")
    _seed("b-checkedout", "checked_out")

    r = client.get("/get_bookings")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("success") is True, body
    ids = {b["booking_id"] for b in body["bookings"]}

    # transient web-hold states are hidden
    assert "b-pending" not in ids
    assert "b-expired" not in ids
    # real ERP statuses still show (unchanged behaviour)
    assert "b-confirmed" in ids
    assert "b-cancelled" in ids
    assert "b-checkedout" in ids
