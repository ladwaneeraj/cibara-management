"""Unit tests for the polled owner-alert timing helpers in routes/web.py.

Only the pure date math is covered here (the part most likely to be wrong);
Firebase is stubbed by tests/conftest.py so importing routes.web is safe. The
renewal rule must match getRoomRenewalStatus() in static/script.js: the next
day's rent is due at check-in + (renewal_count + 1) days.
"""
from datetime import datetime, timedelta

from routes.web import _parse_ist_naive, _renewal_due_at, _OVERSTAY_GRACE


def test_parse_ist_naive_accepts_both_formats():
    assert _parse_ist_naive("2026-11-14 10:00") == datetime(2026, 11, 14, 10, 0)
    assert _parse_ist_naive("2026-11-14 10:00:30") == datetime(2026, 11, 14, 10, 0, 30)
    assert _parse_ist_naive("2026-11-14T10:00") == datetime(2026, 11, 14, 10, 0)
    assert _parse_ist_naive("") is None
    assert _parse_ist_naive("garbage") is None


def test_renewal_due_is_checkin_plus_daynumber():
    ci = "2026-11-14 10:00"
    # Day 1 (no renewals yet): due 24h after check-in.
    assert _renewal_due_at(ci, 0) == datetime(2026, 11, 15, 10, 0)
    # After two renewals: due at check-in + 3 days.
    assert _renewal_due_at(ci, 2) == datetime(2026, 11, 17, 10, 0)
    # Bad count defaults to 0; unparseable check-in yields None.
    assert _renewal_due_at(ci, None) == datetime(2026, 11, 15, 10, 0)
    assert _renewal_due_at("bad", 0) is None


def test_overstay_fires_one_hour_after_due():
    due = _renewal_due_at("2026-11-14 10:00", 0)
    assert due + _OVERSTAY_GRACE == datetime(2026, 11, 15, 11, 0)
