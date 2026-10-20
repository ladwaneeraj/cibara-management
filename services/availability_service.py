"""
Shared room availability: the single source of truth for web booking.

Pure functions (no endpoints). A room is free for a window iff no occupant
interval overlaps it; occupants are:

  1. Bookings (status confirmed / pending_payment) on a pool room.
       - web + parseable check-in time + valid days -> PRECISE:
             [check_in_date + check_in_time, + 24h * days]
       - everything else (OTA, manual, or web with unusable time/days)
         -> DATE-ONLY / CONSERVATIVE:
             [check_in_date 00:00, check_out_date 00:00]
  2. Live walk-ins: ``rooms`` docs with status == "occupied":
             [checkin_time, + 24h * (renewal_count + 1)]
  3. Blocks: rooms from ``blocks_service.active_blocked_rooms`` are excluded
     for the whole window (no cleaning gap).

The cleaning gap (``get_web_config()["cleaning_gap_minutes"]``) is appended to
the END of every interval from (1) and (2). Overlap is half-open:
``a_start < b_end and a_end > b_start``. All datetimes are IST-aware; naive
inputs and stored strings are localized to IST, never compared naive-vs-aware.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Optional

import config
from config import CATEGORY_POOLS  # noqa: F401  (re-exported for callers)
from services import blocks_service
from services.mmt_ingest_service import _ordered_candidates

_BUSY_STATUSES = {"confirmed", "pending_payment"}
_DEFAULT_GAP_MINUTES = 120


# --------------------------------------------------------------------- helpers
def _aware(value: datetime) -> datetime:
    """datetime -> IST-aware datetime (naive is interpreted as IST)."""
    if value.tzinfo is None:
        return config.IST.localize(value)
    return value.astimezone(config.IST)


def _parse_date(value) -> Optional[datetime]:
    """"%Y-%m-%d" -> IST-aware midnight, or None."""
    try:
        return config.IST.localize(datetime.strptime(str(value).strip(), "%Y-%m-%d"))
    except (TypeError, ValueError):
        return None


def _parse_time(value) -> Optional[tuple]:
    """"HH:MM" or "HH:MM:SS" -> (hour, minute), or None."""
    s = str(value or "").strip()
    for fmt in ("%H:%M", "%H:%M:%S"):
        try:
            t = datetime.strptime(s, fmt)
            return (t.hour, t.minute)
        except ValueError:
            continue
    return None


def _parse_days(value) -> Optional[int]:
    if isinstance(value, bool):
        return None
    try:
        d = int(value)
    except (TypeError, ValueError):
        return None
    return d if d >= 1 else None


def _gap_minutes() -> int:
    try:
        return int(config.get_web_config().get("cleaning_gap_minutes", _DEFAULT_GAP_MINUTES))
    except (TypeError, ValueError):
        return _DEFAULT_GAP_MINUTES


def _overlaps(a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime) -> bool:
    """Half-open interval overlap."""
    return a_start < b_end and a_end > b_start


def _booking_interval(b: dict) -> Optional[tuple]:
    """(start, end, kind) for a booking, before the cleaning gap; None if undatable."""
    ci = _parse_date(b.get("check_in_date"))
    if ci is None:
        return None
    if b.get("booking_source") == "web":
        hm = _parse_time(b.get("check_in_time"))
        days = _parse_days(b.get("days"))
        if hm is not None and days is not None:
            start = ci.replace(hour=hm[0], minute=hm[1])
            return (start, start + timedelta(hours=24 * days), "web")
    co = _parse_date(b.get("check_out_date"))
    if co is None or co <= ci:
        # No usable check-out: assume at least a one-night span rather than
        # dropping the booking (dropping it risks an overbooking).
        co = ci + timedelta(days=1)
    return (ci, co, "date_only")


def _walkin_interval(r: dict, window_start: datetime, window_end: datetime) -> tuple:
    """(start, end, kind) for an occupied room doc, before the cleaning gap."""
    try:
        start = _aware(datetime.strptime(str(r.get("checkin_time")).strip(), "%Y-%m-%d %H:%M"))
    except (TypeError, ValueError):
        # Occupied but undatable: treat as busy for the whole window.
        return (window_start, window_end, "walkin")
    try:
        renewals = int(r.get("renewal_count") or 0)
    except (TypeError, ValueError):
        renewals = 0
    return (start, start + timedelta(hours=24 * (renewals + 1)), "walkin")


# ------------------------------------------------------------------ public API
def occupied_intervals(pool_rooms, window_start: datetime, window_end: datetime, *,
                       now: datetime, exclude_booking_id=None) -> dict:
    """Busy intervals overlapping the window, per pool room.

    Returns ``{room: [(start, end, kind), ...]}`` for every room in
    ``pool_rooms`` (empty list when free). For kind in {"web", "date_only",
    "walkin"} ``end`` already includes the cleaning gap; a block is reported as
    ``(window_start, window_end, "block")`` with no gap.
    """
    pool = [str(r) for r in pool_rooms]
    pool_set = set(pool)
    ws, we = _aware(window_start), _aware(window_end)
    now = _aware(now)
    gap = timedelta(minutes=_gap_minutes())
    out = {r: [] for r in pool}

    # 1. Bookings. Single-inequality query (cheap); precise overlap in Python.
    #    One day of slack on the lower bound: a precise web interval can run past
    #    its stored check_out_date by a few hours.
    query_from = (ws - timedelta(days=1)).strftime("%Y-%m-%d")
    for doc in config.bookings_ref.where("check_out_date", ">=", query_from).stream():
        if exclude_booking_id is not None and doc.id == exclude_booking_id:
            continue
        b = doc.to_dict() or {}
        room = str(b.get("room", ""))
        if room not in pool_set or b.get("status") not in _BUSY_STATUSES:
            continue
        iv = _booking_interval(b)
        if iv is None:
            continue
        start, end, kind = iv
        end = end + gap
        if _overlaps(start, end, ws, we):
            out[room].append((start, end, kind))

    # 2. Live walk-ins.
    for doc in config.rooms_ref.where("status", "==", "occupied").stream():
        room = str(doc.id)
        if room not in pool_set:
            continue
        start, end, kind = _walkin_interval(doc.to_dict() or {}, ws, we)
        # A guest who has overstayed is still physically in the room.
        end = max(end, now) + gap
        if _overlaps(start, end, ws, we):
            out[room].append((start, end, kind))

    # 3. Blocks: whole-window exclusion, no cleaning gap.
    for room in blocks_service.active_blocked_rooms(ws, we, now=now):
        room = str(room)
        if room in pool_set:
            out[room].append((ws, we, "block"))

    for room in out:
        out[room].sort(key=lambda t: (t[0], t[1]))
    return out


def pool_free_rooms(category, checkin_dt: datetime, days: int, guests, *, now: datetime,
                    exclude_booking_id=None) -> list:
    """Pool rooms with no overlapping occupant for [checkin, checkin + 24h*days],
    in guest-count preference order."""
    pool = list(CATEGORY_POOLS.get(category, []))
    if not pool:
        return []
    ws = _aware(checkin_dt)
    we = ws + timedelta(hours=24 * int(days))
    busy = occupied_intervals(pool, ws, we, now=now, exclude_booking_id=exclude_booking_id)
    return [r for r in _ordered_candidates(pool, guests) if not busy.get(r)]


def web_offerable_rooms(category, checkin_dt: datetime, days: int, guests, *, now: datetime,
                        exclude_booking_id=None) -> list:
    """Free rooms minus the last ``buffer`` rooms (kept back for walk-ins/OTAs)."""
    free = pool_free_rooms(category, checkin_dt, days, guests, now=now,
                           exclude_booking_id=exclude_booking_id)
    try:
        buffer = max(0, int(config.get_web_config().get("buffer", 0)))
    except (TypeError, ValueError):
        buffer = 0
    return free[:max(0, len(free) - buffer)]
