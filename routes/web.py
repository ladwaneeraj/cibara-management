"""Guest-facing web booking routes (public, CORS-enabled for the website origin).

All endpoints here live under /web/ which is in app._PUBLIC_PREFIXES, so they
need no staff auth. Never expose secrets or internal tuning knobs from here.
"""
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request

import config
from config import get_web_config
from services import availability_service as av

web_bp = Blueprint('web', __name__)

_MAX_STAY_DAYS = 30
# Best-effort per-IP cap on /web/availability. Backed by the shared in-memory
# sliding-window limiter, so it is PER PROCESS (resets on restart, not shared
# across instances) -- fine for Phase 0; the global middleware limit still applies.
_AVAIL_LIMIT_PER_MIN = 60


def _bad(message):
    return jsonify(error=message), 400


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _rate_limited():
    """True when this client IP has exceeded the per-minute cap."""
    from cibara_api.core.ratelimit import limiter
    ok, _ = limiter.hit(f"web_availability:{request.remote_addr or 'unknown'}",
                        _AVAIL_LIMIT_PER_MIN, 60)
    return not ok


@web_bp.route("/web/config", methods=["GET"])
def web_config():
    """Public flags the website needs to decide whether to show booking."""
    cfg = get_web_config()
    return jsonify(
        online_bookings_enabled=bool(cfg["online_bookings_enabled"]),
        cleaning_gap_minutes=int(cfg["cleaning_gap_minutes"]),
    )


@web_bp.route("/web/availability", methods=["POST"])
def web_availability():
    """Is a category offerable for a stay, and what does it cost.

    Returns only {available, price, currency}: the pool is internal, so no room
    number is ever exposed. The price is computed here; any price in the request
    is ignored.
    """
    # 1. Closed flag first: no input handling or availability work when OFF.
    if not get_web_config().get("online_bookings_enabled"):
        return jsonify(enabled=False), 403

    if _rate_limited():
        return jsonify(error="Too many requests. Please slow down."), 429

    # 2. Validate (all failures -> 400).
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return _bad("Invalid request body")

    category = data.get("category")
    spec = av.WEB_BOOKABLE.get(category) if isinstance(category, str) else None
    if spec is None:
        return _bad("Unknown category")

    days = data.get("days")
    if not _is_int(days) or not 1 <= days <= _MAX_STAY_DAYS:
        return _bad("Invalid days")

    guests = data.get("guests")
    if not _is_int(guests) or not 1 <= guests <= spec["max_guests"]:
        return _bad("Invalid guests")

    date_s, time_s = data.get("check_in_date"), data.get("check_in_time")
    if not isinstance(date_s, str) or not isinstance(time_s, str):
        return _bad("Invalid check-in date/time")
    day = av._parse_date(date_s)
    hm = av._parse_time(time_s)
    if day is None or hm is None:
        return _bad("Invalid check-in date/time")
    # Build from the date + wall-clock time and localize (DST-free IST).
    checkin_dt = config.IST.localize(day.replace(tzinfo=None) + timedelta(hours=hm[0], minutes=hm[1]))
    now = datetime.now(config.IST)
    if checkin_dt < now:
        return _bad("Check-in time is in the past")

    # 3-4. Availability and server-computed price.
    offerable = av.web_offerable_rooms(spec["pool"], checkin_dt, days, guests, now=now)
    price = av.web_quote(spec["pool"], guests, days, ac=spec["ac"])

    # 5. Never include a room.
    return jsonify(available=len(offerable) > 0, price=int(price), currency="INR")
