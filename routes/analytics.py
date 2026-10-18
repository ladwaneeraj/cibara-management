"""
Register-based analytics routes — admin-only decision/marketing analytics.

Thin HTTP layer over services/register_analytics_service.py (pure, unit-tested).
This file only fetches the ground-truth rows (rooms + bills + payments +
bookings + commission expenses + snapshots), enforces authorization and caches.

    GET /analytics/overview?from=YYYY-MM-DD&to=YYYY-MM-DD[&fresh=1]

Gated by @requires_permission("analytics.view") — admin only, like
/insights/summary. The structure deliberately mirrors routes/insights.py.

Performance
-----------
  * The independent Firestore reads run CONCURRENTLY on a small thread pool.
  * Every read is a field-path projection (.select) — only the fields the
    service consumes cross the wire. No composite index is needed: each query
    is a single-field range (expense category is filtered in Python).
  * The response is aggregates and chart series only. No per-bill or
    per-payment array ever reaches the browser.
  * Responses are cached per window for _CACHE_TTL seconds; `fresh=1` bypasses.

Data notes
----------
  * rooms    — config.get_all_rooms() (30s cached): live occupancy + room count.
  * bills    — checkin_time range. Wide on purpose: the 12-month seasonality
               line needs the trailing year, plus a 60-day lead buffer so a long
               stay that began before the range still apportions its nights.
  * payments — the window only (collections), de-duplicated the way the
               register does (payment_service._dedup_payments).
  * bookings — check_in_date range (window, plus 30 days ahead for pace and a
               look-back to link in-house stays to their planned checkout).
  * expenses — date range; only category == booking_commission is kept.
  * analytics_snapshots — the last two weeks of nightly pace snapshots.
"""

import time as _time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from threading import Lock

from flask import Blueprint, request, jsonify
from google.cloud.firestore_v1.base_query import FieldFilter

from config import db, bills_ref, bookings_ref, expenses_ref, IST, logger, get_all_rooms
from services import payment_service
from services import register_analytics_service as svc
from services.auth_service import requires_permission

analytics_bp = Blueprint("analytics", __name__, url_prefix="/analytics")

payments_ref = db.collection("payments")
snapshots_ref = db.collection("analytics_snapshots")

# Longest allowed window (guards Firestore reads and response size).
_MAX_WINDOW_DAYS = 92
# Bills that began before the range but still overlap it.
_BILLS_LEAD_DAYS = 60
# Months of history the seasonality line needs (trailing, incl. current).
_SEASON_MONTHS = 12
# Bookings: look back this far to link in-house stays; look ahead for pace.
_BOOKINGS_LOOKBACK_DAYS = 45
_BOOKINGS_LOOKAHEAD_DAYS = max(svc.DEFAULT_HORIZONS)
# Pace snapshots read for the "vs a week ago" comparison.
_SNAPSHOT_LOOKBACK_DAYS = 14

# Only the fields register_analytics_service consumes.
_BILL_FIELDS = ["id", "status", "room", "stay_id", "checkin_time", "checkout_time",
                "room_charges_total", "room_price_per_night", "payment_source",
                "booking_source", "ota_commission", "ota_commission_gst",
                "total_amount", "cancelled_by_revert", "superseded_by_revert"]
_PAYMENT_FIELDS = ["date", "method", "type", "amount", "voided",
                   # fingerprint fields payment_service._dedup_payments reads
                   "room", "name", "time", "migrated"]
_BOOKING_FIELDS = ["check_in_date", "check_out_date", "status", "room", "total_amount",
                   "booking_source", "booking_created", "booking_date", "createdAt",
                   "stay_id"]
_EXPENSE_FIELDS = ["category", "date", "commission_platform", "commission_amount",
                   "commission_gst", "booking_id"]
_SNAPSHOT_FIELDS = ["date", "horizons"]

# Small multi-window response cache (an admin flipping presets should not
# re-scan Firestore every click).
_CACHE: "OrderedDict[tuple, dict]" = OrderedDict()
_CACHE_LOCK = Lock()
_CACHE_TTL = 120   # seconds
_CACHE_MAX = 8     # windows kept

# 5 workers == the 5 independent Firestore reads.
_POOL = ThreadPoolExecutor(max_workers=5, thread_name_prefix="analytics")


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


def _iso(d):
    return d.strftime("%Y-%m-%d")


def _range(ref, field, lo, hi_exclusive, fields):
    """Single-field string range [lo, hi_exclusive) with a projection."""
    q = (ref.where(filter=FieldFilter(field, ">=", lo))
         .where(filter=FieldFilter(field, "<", hi_exclusive))
         .select(fields))
    out = []
    for doc in q.stream():
        d = doc.to_dict() or {}
        d.setdefault("id", doc.id)
        out.append(d)
    return out


# ── fetchers (each one projected; each runs on the pool) ────────────────

def _season_start(today):
    """First day of the month _SEASON_MONTHS-1 months before today's month."""
    idx = today.year * 12 + (today.month - 1) - (_SEASON_MONTHS - 1)
    return today.replace(year=idx // 12, month=idx % 12 + 1, day=1)


def _fetch_bills(from_date, to_date):
    """Bills whose stay may overlap the window OR the trailing-12-month line."""
    today = datetime.now(IST).date()
    lo = min(from_date, _season_start(today)) - timedelta(days=_BILLS_LEAD_DAYS)
    return _range(bills_ref, "checkin_time", _iso(lo), _iso(to_date + timedelta(days=1)),
                  _BILL_FIELDS)


def _fetch_payments(from_date, to_date):
    rows = _range(payments_ref, "date", _iso(from_date), _iso(to_date + timedelta(days=1)),
                  _PAYMENT_FIELDS)
    return payment_service._dedup_payments(rows)


def _fetch_bookings(from_date, to_date):
    today = datetime.now(IST).date()
    lo = min(from_date, today - timedelta(days=_BOOKINGS_LOOKBACK_DAYS))
    hi = max(to_date, today) + timedelta(days=_BOOKINGS_LOOKAHEAD_DAYS + 1)
    return _range(bookings_ref, "check_in_date", _iso(lo), _iso(hi), _BOOKING_FIELDS)


def _fetch_commission_expenses(from_date, to_date):
    rows = _range(expenses_ref, "date", _iso(from_date), _iso(to_date + timedelta(days=1)),
                  _EXPENSE_FIELDS)
    # Category is filtered here, not in the query: equality + range on two
    # fields would need a composite index (CLAUDE.md §4: none are added).
    return [r for r in rows if r.get("category") == "booking_commission"]


def _fetch_snapshots(today):
    lo = _iso(today - timedelta(days=_SNAPSHOT_LOOKBACK_DAYS))
    q = (snapshots_ref.where(filter=FieldFilter("date", ">=", lo)).select(_SNAPSHOT_FIELDS))
    return [doc.to_dict() or {} for doc in q.stream()]


# ── GET /analytics/overview ─────────────────────────────────────────────

@analytics_bp.route("/overview", methods=["GET"])
@requires_permission("analytics.view")
def analytics_overview():
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

    now = datetime.now(IST).replace(tzinfo=None)
    today = now.date()
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
        t0 = _time.time()
        f_bills = _POOL.submit(_fetch_bills, from_date, to_date)
        f_payments = _POOL.submit(_fetch_payments, from_date, to_date)
        f_bookings = _POOL.submit(_fetch_bookings, from_date, to_date)
        f_expenses = _POOL.submit(_fetch_commission_expenses, from_date, to_date)
        f_snaps = _POOL.submit(_fetch_snapshots, today)
        rooms = get_all_rooms() or {}   # 30s-cached, usually instant

        payload = svc.compute_analytics_overview(
            rooms=rooms,
            bills=f_bills.result(),
            payments=f_payments.result() or [],
            bookings=f_bookings.result(),
            commission_expenses=f_expenses.result(),
            snapshots=f_snaps.result(),
            room_count=len(rooms),
            window_from=cache_key[0],
            window_to=cache_key[1],
            now=now,
        )
        logger.info(f"analytics: window={cache_key} built in "
                    f"{(_time.time() - t0) * 1000:.0f}ms")
        _cache_put(cache_key, payload)
        return jsonify(payload)
    except Exception as e:
        logger.error(f"analytics_overview failed: {e}", exc_info=True)
        return jsonify(success=False, message="Failed to compute analytics"), 500
