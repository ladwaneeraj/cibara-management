"""
Daily Insights routes — admin-only operations analytics.

Thin HTTP layer over services/insights_service.py (pure, unit-tested).
All heavy lifting (cycle pairing, day buckets, insight rules) happens there;
this file only fetches the raw data and enforces authorization.

    GET /insights/summary?from=YYYY-MM-DD&to=YYYY-MM-DD[&fresh=1]

Gated by @requires_permission("analytics.view") — admin only (managers do
not hold this permission; see services/permissions.py).

Performance
-----------
  * The three Firestore reads (audit_logs, payments, bills) are independent
    and run CONCURRENTLY on a small thread pool — wall time is the slowest
    single read instead of the sum of all three.
  * The audit query uses a field-path projection (.select) so only the 7
    fields the service needs travel over the wire — audit docs also carry
    before/after snapshots, user agent strings etc. that we never use.
  * Responses are cached per window for _CACHE_TTL seconds, several windows
    at a time (an admin flipping Today → 7d → 30d and back should hit the
    cache, not Firestore). `fresh=1` (the dashboard refresh button) bypasses.

Data notes
----------
  * audit_logs — single-field range on the IST `timestamp` string (auto
    single-field index; no composite index needed). A 2-day lookback before
    `from` lets cleaning cycles straddling midnight pair correctly.
  * bills — checkin_time range with a 60-day lead buffer, for occupancy /
    ADR on a date-of-stay basis. Stays longer than 60 days would be missed;
    acceptable for a lodge.
  * rooms — config.get_all_rooms() (30s cached) for room count and the
    LIVE "in cleaning right now" strip.
"""

import time as _time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from threading import Lock

from flask import Blueprint, request, jsonify
from google.cloud.firestore_v1.base_query import FieldFilter

from config import db, bills_ref, IST, logger, get_all_rooms
from services import payment_service
from services import insights_service as svc
from services.auth_service import requires_permission

insights_bp = Blueprint("insights", __name__, url_prefix="/insights")

# How many days of audit events to read BEFORE the window so cycles that
# straddle midnight (checkout late night → ready next morning) still pair.
_LOOKBACK_DAYS = 2
# Longest allowed window. Guards Firestore reads and response size.
_MAX_WINDOW_DAYS = 92
# Multi-night stays: how far before the window we look for bills whose stay
# overlaps it (occupancy basis).
_BILLS_LEAD_DAYS = 60
# Hard cap on audit docs per request — safety net, not a pagination scheme.
_EVENT_SCAN_CAP = 20000

# Only the fields insights_service consumes — projection keeps the wire
# payload small (audit docs also carry before/after, ipAddress, userAgent…).
_AUDIT_FIELDS = ["action", "timestamp", "targetId",
                 "userName", "userId", "userRole", "metadata"]

# Small multi-window response cache: an admin flipping between presets
# should not re-scan Firestore every click.
_CACHE: "OrderedDict[tuple, dict]" = OrderedDict()
_CACHE_LOCK = Lock()
_CACHE_TTL = 120   # seconds
_CACHE_MAX = 8     # windows kept

# Concurrent fetches. 3 workers == the 3 independent Firestore reads.
_POOL = ThreadPoolExecutor(max_workers=3, thread_name_prefix="insights")


def _cache_get(key):
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit and (_time.time() - hit["ts"] < _CACHE_TTL):
            _CACHE.move_to_end(key)
            return hit["payload"]
        if hit:
            _CACHE.pop(key, None)
    return None


def _cache_put(key, payload):
    with _CACHE_LOCK:
        _CACHE[key] = {"payload": payload, "ts": _time.time()}
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)


def _parse_date(s):
    try:
        return datetime.strptime((s or "").strip(), "%Y-%m-%d").date()
    except ValueError:
        return None


def _fetch_audit_events(from_date, to_date):
    """Relevant audit events in [from - lookback, to] IST, capped."""
    start_str = (from_date - timedelta(days=_LOOKBACK_DAYS)).strftime("%Y-%m-%d") + " 00:00:00"
    end_str = to_date.strftime("%Y-%m-%d") + " 23:59:59"
    q = (
        db.collection("audit_logs")
        .where(filter=FieldFilter("timestamp", ">=", start_str))
        .where(filter=FieldFilter("timestamp", "<=", end_str))
        .select(_AUDIT_FIELDS)
        .limit(_EVENT_SCAN_CAP)
    )
    events = []
    scanned = 0
    for doc in q.stream():
        scanned += 1
        d = doc.to_dict() or {}
        if d.get("action") not in svc.RELEVANT_ACTIONS:
            continue
        d["metadata"] = d.get("metadata") or {}
        events.append(d)
    logger.info(f"insights: audit scan={scanned} relevant={len(events)} "
                f"window={start_str}..{end_str}")
    if scanned >= _EVENT_SCAN_CAP:
        logger.warning("insights: audit scan hit cap — window too large?")
    return events


def _fetch_bills(from_date, to_date):
    """Bills whose stay may overlap the window (checkin within lead buffer)."""
    lead_str = (from_date - timedelta(days=_BILLS_LEAD_DAYS)).strftime("%Y-%m-%d")
    end_str = (to_date + timedelta(days=1)).strftime("%Y-%m-%d")
    q = (
        bills_ref
        .where(filter=FieldFilter("checkin_time", ">=", lead_str))
        .where(filter=FieldFilter("checkin_time", "<", end_str))
        .select(["checkin_time", "checkout_time", "status",
                 "room_charges_total", "room_price_per_night", "payment_source"])
    )
    return [doc.to_dict() or {} for doc in q.stream()]


def _live_pending(rooms):
    """Rooms in `cleaning` status right now, with elapsed minutes."""
    now_naive = datetime.now(IST).replace(tzinfo=None)
    pending = []
    for num, r in (rooms or {}).items():
        if (r or {}).get("status") != "cleaning":
            continue
        started = r.get("cleaning_start_time")
        elapsed = None
        try:
            start_dt = datetime.strptime(str(started), "%Y-%m-%d %H:%M:%S")
            elapsed = max(round((now_naive - start_dt).total_seconds() / 60.0), 0)
        except (TypeError, ValueError):
            pass
        pending.append({
            "room": str(num),
            "stage": r.get("cleaning_status") or "in_progress",
            "since": started,
            "elapsed_min": elapsed,
            "cleaned_by": r.get("cleanedBy"),
        })
    pending.sort(key=lambda p: -(p["elapsed_min"] or 0))
    return pending


@insights_bp.route("/summary", methods=["GET"])
@requires_permission("analytics.view")
def insights_summary():
    from_date = _parse_date(request.args.get("from"))
    to_date = _parse_date(request.args.get("to"))
    if from_date is None or to_date is None:
        return jsonify(success=False,
                       message="from and to (YYYY-MM-DD) are required"), 400
    if to_date < from_date:
        return jsonify(success=False, message="to must be >= from"), 400
    if (to_date - from_date).days + 1 > _MAX_WINDOW_DAYS:
        return jsonify(success=False,
                       message=f"Window too large (max {_MAX_WINDOW_DAYS} days)"), 400

    today = datetime.now(IST).date()
    if to_date > today:
        to_date = today  # never report the future
        if to_date < from_date:
            from_date = to_date

    cache_key = (from_date.isoformat(), to_date.isoformat())
    fresh = request.args.get("fresh") in ("1", "true", "yes")
    if not fresh:
        cached = _cache_get(cache_key)
        if cached is not None:
            return jsonify(cached)

    try:
        from_str, to_str = cache_key
        t0 = _time.time()

        # The three Firestore reads are independent — run them concurrently.
        f_events = _POOL.submit(_fetch_audit_events, from_date, to_date)
        f_payments = _POOL.submit(
            payment_service.query_payments_by_date_range,
            from_str, (to_date + timedelta(days=1)).strftime("%Y-%m-%d"),
        )
        f_bills = _POOL.submit(_fetch_bills, from_date, to_date)
        rooms = get_all_rooms() or {}   # 30s-cached, usually instant

        events = f_events.result()
        payments = f_payments.result() or []
        bills = f_bills.result()

        payload = svc.compute_daily_insights(
            events, from_str, to_str,
            payments=payments,
            bills=bills,
            room_count=len(rooms),
            now=datetime.now(IST).replace(tzinfo=None),
        )
        payload["success"] = True
        payload["live"] = {"pending": _live_pending(rooms)}
        payload["generated_at"] = datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")

        logger.info(f"insights: window={cache_key} built in "
                    f"{(_time.time() - t0) * 1000:.0f}ms")
        _cache_put(cache_key, payload)
        return jsonify(payload)
    except Exception as e:
        logger.error(f"insights_summary failed: {e}", exc_info=True)
        return jsonify(success=False, message="Failed to compute insights"), 500
