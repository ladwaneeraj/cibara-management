"""Guest-facing web booking routes (public, CORS-enabled for the website origin).

All endpoints here live under /web/ which is in app._PUBLIC_PREFIXES, so they
need no staff auth. Never expose secrets or internal tuning knobs from here.
"""
import uuid
from datetime import datetime, timedelta

from firebase_admin import firestore
from flask import Blueprint, jsonify, request
from google.api_core import exceptions as gexc

import config
from config import get_web_config
from services import availability_service as av

web_bp = Blueprint('web', __name__)

_MAX_STAY_DAYS = 30
# Best-effort per-IP cap on /web/availability. Backed by the shared in-memory
# sliding-window limiter, so it is PER PROCESS (resets on restart, not shared
# across instances) -- fine for Phase 0; the global middleware limit still applies.
_AVAIL_LIMIT_PER_MIN = 60
# /web/hold writes state (a pending booking that blocks inventory), so it gets
# its own bucket: a guest needs one hold, not dozens.
_HOLD_LIMIT_PER_MIN = 20

_MAX_NAME_LEN = 100
_MAX_MOBILE_LEN = 20
_MAX_EMAIL_LEN = 254


def _bad(message):
    return jsonify(error=message), 400


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _client_ip():
    """Best-effort guest IP for rate limiting.

    Behind the reverse proxy ``remote_addr`` is the proxy, which would put every
    guest in one bucket. Use the left-most X-Forwarded-For entry when present.
    XFF is spoofable; that is acceptable here because the endpoint is read-only
    (no money, no state) -- the aim is to stop collapsing all guests into one
    bucket, not to be abuse-proof.
    """
    xff = request.headers.get("X-Forwarded-For", "")
    first = xff.split(",")[0].strip()
    return first or request.remote_addr or "unknown"


def _rate_limited(bucket="web_availability", limit=_AVAIL_LIMIT_PER_MIN):
    """True when this client IP has exceeded the per-minute cap for ``bucket``."""
    from cibara_api.core.ratelimit import limiter
    ok, _ = limiter.hit(f"{bucket}:{_client_ip()}", limit, 60)
    return not ok


class _Invalid(Exception):
    """Request validation failure; the message is safe to return to the guest."""


class _SoldOut(Exception):
    """No offerable room left for the requested stay."""


def _parse_stay(data):
    """Validate the stay fields shared by /web/availability and /web/hold.

    Returns ``(category, spec, days, guests, checkin_dt, now)``; raises ``_Invalid``.
    """
    category = data.get("category")
    spec = av.WEB_BOOKABLE.get(category) if isinstance(category, str) else None
    if spec is None:
        raise _Invalid("Unknown category")

    days = data.get("days")
    if not _is_int(days) or not 1 <= days <= _MAX_STAY_DAYS:
        raise _Invalid("Invalid days")

    guests = data.get("guests")
    if not _is_int(guests) or not 1 <= guests <= spec["max_guests"]:
        raise _Invalid("Invalid guests")

    date_s, time_s = data.get("check_in_date"), data.get("check_in_time")
    if not isinstance(date_s, str) or not isinstance(time_s, str):
        raise _Invalid("Invalid check-in date/time")
    day = av._parse_date(date_s)
    hm = av._parse_time(time_s)
    if day is None or hm is None:
        raise _Invalid("Invalid check-in date/time")
    # Build from the date + wall-clock time and localize (DST-free IST).
    checkin_dt = config.IST.localize(day.replace(tzinfo=None) + timedelta(hours=hm[0], minutes=hm[1]))
    now = datetime.now(config.IST)
    if checkin_dt < now:
        raise _Invalid("Check-in time is in the past")
    return category, spec, days, guests, checkin_dt, now


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

    try:
        _category, spec, days, guests, checkin_dt, now = _parse_stay(data)
    except _Invalid as e:
        return _bad(str(e))

    # 3-4. Availability and server-computed price.
    offerable = av.web_offerable_rooms(spec["pool"], checkin_dt, days, guests, now=now)
    price = av.web_quote(spec["pool"], guests, days, ac=spec["ac"])

    # 5. Never include a room.
    return jsonify(available=len(offerable) > 0, price=int(price), currency="INR")


def _clean_str(value, max_len, *, required):
    """Stripped string, or ``None`` when absent/blank and not required.

    Raises ``_Invalid`` for a non-string, a missing required value, or overlong text.
    """
    if value is None and not required:
        return None
    if not isinstance(value, str):
        raise _Invalid("Invalid guest details")
    value = value.strip()
    if not value:
        if required:
            raise _Invalid("Invalid guest details")
        return None
    if len(value) > max_len:
        raise _Invalid("Invalid guest details")
    return value


@web_bp.route("/web/hold", methods=["POST"])
def web_hold():
    """Place a short-lived ``pending_payment`` hold on one room of a category.

    The room is chosen server-side and never returned. Price is server-computed
    (any price/room/status in the request is ignored). Returns
    ``{booking_id, amount (rupees), expires_at}``; 409 when nothing is offerable.
    """
    # 1. Closed flag first: no input handling, rate-limit bookkeeping or writes when OFF.
    cfg = get_web_config()
    if not cfg.get("online_bookings_enabled"):
        return jsonify(enabled=False), 403

    if _rate_limited("web_hold", _HOLD_LIMIT_PER_MIN):
        return jsonify(error="Too many requests. Please slow down."), 429

    # 2. Validate (all failures -> 400).
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return _bad("Invalid request body")
    try:
        category, spec, days, guests, checkin_dt, now = _parse_stay(data)
        guest_name = _clean_str(data.get("guest_name"), _MAX_NAME_LEN, required=True)
        guest_mobile = _clean_str(data.get("guest_mobile"), _MAX_MOBILE_LEN, required=True)
        guest_email = _clean_str(data.get("guest_email"), _MAX_EMAIL_LEN, required=False)
    except _Invalid as e:
        return _bad(str(e))

    pool = spec["pool"]
    total = int(av.web_quote(pool, guests, days, ac=spec["ac"]))
    try:
        ttl = max(1, int(cfg.get("hold_ttl_minutes", 10)))
    except (TypeError, ValueError):
        ttl = 10
    expires_at = (now + timedelta(minutes=ttl)).isoformat()
    check_out_date = (checkin_dt + timedelta(hours=24 * days)).strftime("%Y-%m-%d")

    # 3. Race-safe hold.
    #
    # Why the sentinel: in REAL Firestore a collection query (which is how
    # web_offerable_rooms reads bookings) does NOT join the transaction's read
    # set. Without more, two concurrent holds could both see the last room free
    # and both write -> a double-book. So every hold on a pool reads AND writes
    # one per-pool doc (web_pool_locks/{pool}). Firestore's optimistic
    # concurrency then makes the second committer fail on the changed sentinel,
    # abort and retry; on retry web_offerable_rooms sees the winner's
    # just-committed pending booking and (if that was the last room) raises
    # _SoldOut. DO NOT remove the sentinel read/write: it is the only thing that
    # serialises same-pool holds in production. premium and premium_ac share
    # the "premium" pool, so they share one sentinel. set(merge=True), not
    # update(), so the very first hold on a pool (no lock doc yet) still works.
    lock_ref = config.db.collection("web_pool_locks").document(pool)
    now_iso = now.isoformat()

    @firestore.transactional
    def _hold(txn):
        # (1) read dependency on the sentinel. Must be an EAGER read: in the real
        # client ``txn.get(doc_ref)`` returns a lazy generator that performs no
        # RPC until consumed, which would silently drop the dependency.
        lock_ref.get(transaction=txn)
        # (2) re-check availability now, inside the transaction (buffer applied inside).
        free = av.web_offerable_rooms(pool, checkin_dt, days, guests, now=now)
        if not free:
            raise _SoldOut()
        room = free[0]  # (3) first offerable room, in guest-count preference order
        booking_id = uuid.uuid4().hex
        booking = {
            "room": room,
            "guest_name": guest_name,
            "guest_mobile": guest_mobile,
            "check_in_date": checkin_dt.strftime("%Y-%m-%d"),
            "check_in_time": checkin_dt.strftime("%H:%M"),
            "check_out_date": check_out_date,
            "days": days,
            "guest_count": guests,
            "status": "pending_payment",
            "booking_source": "web",
            "payment_source": "hotel",
            "is_ac": spec["ac"],
            "total_amount": total,
            "paid_amount": 0,
            "balance": total,
            "expires_at": expires_at,
            "booking_date": now.strftime("%Y-%m-%d"),
            "created_at": now_iso,
        }
        if guest_email:
            booking["guest_email"] = guest_email
        txn.set(config.bookings_ref.document(booking_id), booking)  # (4) pending booking
        txn.set(lock_ref, {"v": firestore.Increment(1), "updated_at": now_iso},
                merge=True)  # (5) bump the sentinel
        return booking_id

    try:
        booking_id = _hold(config.db.transaction())
    except _SoldOut:
        return jsonify(error="Sold out", sold_out=True), 409
    except gexc.Aborted:
        # Sustained contention on the sentinel exhausted the txn's retries; the
        # guest can simply try again. Nothing was written.
        return jsonify(error="Busy, please retry"), 503

    return jsonify(booking_id=booking_id, amount=total, expires_at=expires_at)
