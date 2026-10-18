"""
Register-basis analytics — pure compute (no Firestore, no Flask).

Why this exists
---------------
The Daily Insights screen derives occupancy / ADR / RevPAR from the `bills`
collection alone. Bills are written at checkout, so in-house guests, orphaned
drafts and reverted stays make that basis drift from what the owner sees in the
register. This module builds the *stay universe* the way the register does —
live `rooms` (in-house) unioned with completed `bills`, de-duplicated on the
active stay id, cancelled / voided / reverted stays excluded — and computes the
analytics payload from it.

Money / tax discipline
----------------------
Nothing here re-implements money or tax logic. Occupancy, ADR and RevPAR go
through services.kpi_service.compute_kpis unchanged (the stay universe is
shaped into the same bill-shaped dicts it already consumes). Collections use the
same payment classification as routes/reports.get_reports.

The route layer (routes/analytics.py) fetches the projected rows and passes
them in, which keeps everything here unit-testable.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

from services.kpi_service import compute_kpis, _parse_stay_date

# ── Channel labels ──────────────────────────────────────────────────────
CH_DIRECT = "Direct/Walk-in"
CH_MMT = "MMT"
CH_AGODA = "Agoda"
CH_BOOKING = "Booking.com"
CH_OTHER = "Other"

# Markers that take a stay out of every figure (same set routes/reports.py
# revenue_report uses): the replacement stay carries the real revenue.
_EXCLUDED_STATUSES = frozenset({"cancelled", "voided"})

# Payment types treated as refunds / non-receipts — copied verbatim from
# routes/reports.get_reports (do not re-derive).
_REFUND_TYPES = ("refund", "checkout_refund", "manual_refund",
                 "booking_cancel_refund")
_NON_RECEIPT_TYPES = ("expense", "discount")


# ── helpers ─────────────────────────────────────────────────────────────

def _is_live(row) -> bool:
    """Mirror of payment_service.is_live_charge (voided rows count for nothing).

    Re-stated here only because payment_service imports firebase_admin and this
    module must stay pure; tests/test_register_analytics_service.py asserts the
    two never diverge.
    """
    return isinstance(row, dict) and not row.get("voided")


def _to_date(value) -> date | None:
    """'YYYY-MM-DD[ HH:MM]' / date / datetime → date (None if unparseable)."""
    return _parse_stay_date(value)


def _num(value, default=0.0) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return float(default)


def _r2(x: float) -> float:
    return round(float(x), 2)


def _is_excluded_stay(doc: dict) -> bool:
    status = (doc.get("status") or "").strip().lower()
    return (status in _EXCLUDED_STATUSES
            or bool(doc.get("superseded_by_revert"))
            or bool(doc.get("cancelled_by_revert")))


def _source_channel(source) -> str | None:
    """Map one raw source string to a channel label (None if unknown/blank)."""
    s = str(source or "").strip().lower().replace("_", ".").replace(" ", "")
    if not s:
        return None
    if s == "mmt" or "makemytrip" in s:
        return CH_MMT
    if s == "agoda":
        return CH_AGODA
    if s in ("booking.com", "bookingcom", "booking"):
        return CH_BOOKING
    if s in ("normal", "direct", "walkin", "walk-in", "walk.in", "hotel"):
        return CH_DIRECT
    return CH_OTHER


def channel_of(stay: dict) -> str:
    """
    Booking channel of a stay: "Direct/Walk-in" | "MMT" | "Agoda" |
    "Booking.com" | "Other".

    booking_source wins. When it is blank/"normal" an OTA-paid stay
    (payment_source == "ota") is still an OTA stay we cannot name → "Other",
    never silently Direct.
    """
    ch = _source_channel(stay.get("booking_source"))
    if ch and ch != CH_DIRECT:
        return ch
    pay = str(stay.get("payment_source") or "").strip().lower()
    if pay in ("mmt", "agoda"):
        return CH_MMT if pay == "mmt" else CH_AGODA
    if pay == "ota":
        return CH_OTHER
    return CH_DIRECT


# ── stay universe ───────────────────────────────────────────────────────

def _stay_shape(stay_id, room, doc, checkout_time) -> dict:
    stay = {
        "stay_id": stay_id,
        "room": str(room) if room is not None else "",
        "checkin_time": doc.get("checkin_time"),
        "checkout_time": checkout_time,
        "status": doc.get("status"),
        "room_charges_total": _num(doc.get("room_charges_total")),
        "room_price_per_night": _num(doc.get("room_price_per_night")),
        "payment_source": doc.get("payment_source") or "",
        "booking_source": doc.get("booking_source") or "",
        # Hotel-side cost of the OTA booking: commission + GST on it.
        "ota_commission": _num(doc.get("ota_commission")),
        "ota_commission_gst": _num(doc.get("ota_commission_gst")),
    }
    stay["channel"] = channel_of(stay)
    return stay


def build_stay_universe(rooms: dict, bills: list, today: date) -> list:
    """
    Register-basis stays: in-house rooms + completed bills, de-duplicated.

    * A room with status "occupied" is an in-house stay (checkout_time=None,
      status "draft" so kpi_service counts it up to `today`).
    * Its draft bill (bill id == room.active_bill_id) is the SAME stay → the
      bill is skipped in favour of the live room.
    * Cancelled / voided / reverted bills are dropped (no double count with a
      replacement stay).
    * A "draft" bill with no checkout that no occupied room points at is an
      orphan, not occupancy → dropped.

    Each returned dict is bill-shaped so it can go straight into compute_kpis.
    """
    stays: list = []
    active_ids: set = set()

    for num, room in (rooms or {}).items():
        room = room or {}
        if (room.get("status") or "").strip().lower() != "occupied":
            continue
        if _to_date(room.get("checkin_time")) is None:
            continue
        stay_id = room.get("active_bill_id") or f"{num}_{room.get('checkin_time')}"
        active_ids.add(stay_id)
        guest = room.get("guest") or {}
        price = room.get("room_price_per_night") or guest.get("price")
        shaped = _stay_shape(stay_id, num, {**room, "room_price_per_night": price}, None)
        shaped["status"] = "draft"
        stays.append(shaped)

    for b in (bills or []):
        b = b or {}
        if _is_excluded_stay(b):
            continue
        stay_id = b.get("id") or b.get("stay_id")
        if stay_id and stay_id in active_ids:
            continue
        status = (b.get("status") or "").strip().lower()
        if status == "draft" and not b.get("checkout_time"):
            continue   # orphan draft — no occupied room owns it
        stays.append(_stay_shape(stay_id, b.get("room"), b, b.get("checkout_time") or None))

    return stays


# ── overview ────────────────────────────────────────────────────────────

def _collections(payments: list) -> dict:
    """cash / online / refunds / net — routes/reports.get_reports classification."""
    cash = online = refunds = 0.0
    for p in (payments or []):
        ptype = p.get("type")
        amt = _num(p.get("amount"))
        if ptype in _REFUND_TYPES:
            refunds += amt
            continue
        if ptype in _NON_RECEIPT_TYPES or not _is_live(p):
            continue
        method = p.get("method")
        if method == "cash":
            cash += amt
        elif method == "online":
            online += amt
    return {"cash": _r2(cash), "online": _r2(online), "refunds": _r2(refunds),
            "net": _r2(cash + online - refunds)}


def compute_overview(stays: list, payments: list, room_count: int,
                     window_from: str, window_to: str, today: date) -> dict:
    """KPIs (via kpi_service.compute_kpis) + register collections."""
    w_from = _to_date(window_from) or today
    w_to = _to_date(window_to) or today
    kpis = compute_kpis(stays, room_count, w_from, w_to, today=today)
    return {"occupancy": kpis, "collections": _collections(payments)}


# ── channel mix & net profitability ─────────────────────────────────────

def _stay_span_end(stay: dict, today: date):
    """Last occupied night of the stay (inclusive); in-house → through last night."""
    co = _to_date(stay.get("checkout_time")) or today
    return co - timedelta(days=1)


def _stay_nights_in(stay: dict, ws: date, we: date, today: date):
    """(in_window_nights, in_window_room_revenue, total_nights) via compute_kpis."""
    ci = _to_date(stay.get("checkin_time"))
    if ci is None:
        return 0, 0.0, 0
    whole = compute_kpis([stay], 1, ci, max(_stay_span_end(stay, today), ci - timedelta(days=1)),
                         today=today)
    part = compute_kpis([stay], 1, ws, we, today=today)
    return part["occupied_room_nights"], part["room_revenue"], whole["occupied_room_nights"]


def compute_channel_mix(stays: list, commission_expenses: list, *,
                        window_from=None, window_to=None, today: date | None = None) -> dict:
    """
    Revenue by booking channel, net of OTA commission.

        gross      = room revenue of the channel's stays (kpi_service basis);
                     apportioned night-by-night onto [window_from, window_to]
                     when a window is given, else the whole stay.
        commission = (ota_commission + ota_commission_gst) on those stays,
                     prorated by the in-window share of nights,
                     + booking_commission expenses for the matching platform.
        net        = gross - commission;  net_adr = net / room_nights.

    Expenses that carry a booking_id are the bank-settlement mirror of a
    commission already recorded on the bill, so they are not added again.
    """
    today = today or date.today()
    ws = _to_date(window_from)
    we = _to_date(window_to)
    rows: dict = {}

    def row(ch):
        return rows.setdefault(ch, {"gross": 0.0, "commission": 0.0, "room_nights": 0})

    for s in (stays or []):
        ci = _to_date(s.get("checkin_time"))
        if ci is None:
            continue
        ch = s.get("channel") or channel_of(s)
        a, b = (ws, we) if (ws and we) else (ci, max(_stay_span_end(s, today), ci))
        nights, revenue, total = _stay_nights_in(s, a, b, today)
        r = row(ch)
        r["gross"] += revenue
        r["room_nights"] += nights
        comm = _num(s.get("ota_commission")) + _num(s.get("ota_commission_gst"))
        if comm and total > 0:
            r["commission"] += comm * (nights / total)

    for e in (commission_expenses or []):
        if e.get("category") != "booking_commission" or e.get("booking_id"):
            continue
        ch = _source_channel(e.get("commission_platform")) or CH_OTHER
        if ch == CH_DIRECT:
            ch = CH_OTHER
        row(ch)["commission"] += _num(e.get("commission_amount")) + _num(e.get("commission_gst"))

    total_gross = sum(r["gross"] for r in rows.values())
    channels = []
    for ch, r in rows.items():
        net = r["gross"] - r["commission"]
        channels.append({
            "channel": ch,
            "gross": _r2(r["gross"]),
            "commission": _r2(r["commission"]),
            "net": _r2(net),
            "net_adr": _r2(net / r["room_nights"]) if r["room_nights"] > 0 else 0,
            "share_pct": round(r["gross"] / total_gross * 100.0, 1) if total_gross > 0 else 0,
            "room_nights": r["room_nights"],
        })
    channels.sort(key=lambda c: (-c["gross"], c["channel"]))
    return {"channels": channels,
            "total_gross": _r2(sum(c["gross"] for c in channels)),
            "total_net": _r2(sum(c["net"] for c in channels))}


# ── booking pace / forward occupancy ────────────────────────────────────

DEFAULT_HORIZONS = (7, 14, 30)
# A booking in any of these states is not "future business on the books":
# cancelled / no-show never happen; checked_in & later are already a stay
# (in-house or billed), so counting them again would double the nights.
_NON_PACE_BOOKING_STATUSES = frozenset({
    "cancelled", "canceled", "no_show", "noshow", "checked_in", "checked_out",
    "completed",
})


def _overlap_nights(start: date, end_excl: date, w_start: date, w_end_excl: date) -> int:
    """Nights of [start, end_excl) that fall in [w_start, w_end_excl)."""
    return max((min(end_excl, w_end_excl) - max(start, w_start)).days, 0)


def compute_booking_pace(stays: list, future_bookings: list, room_count: int,
                         today: date, horizons=DEFAULT_HORIZONS) -> dict:
    """
    Forward occupancy for the next N nights (window [today, today + N)).

    Occupied forward nights =
      * in-house stays (checkout_time is None) projected to their
        `expected_checkout` — or tonight only when none is known; an overdue
        expected checkout still holds tonight;
      * + confirmed future bookings' nights inside the window.

    on_books_revenue: in-house nights x room_price_per_night, plus each
    booking's total_amount prorated by the share of its nights in the window.
    Cancelled bookings and bookings with missing / unparseable / inverted dates
    are skipped.
    """
    room_count = max(int(room_count or 0), 0)

    in_house = []
    for s in (stays or []):
        if s.get("checkout_time"):
            continue
        ci = _to_date(s.get("checkin_time"))
        if ci is None:
            continue
        exp = _to_date(s.get("expected_checkout"))
        end = exp if (exp and exp > today) else today + timedelta(days=1)
        in_house.append((max(ci, today), end, _num(s.get("room_price_per_night"))))

    bookings = []
    for b in (future_bookings or []):
        if (b.get("status") or "").strip().lower() in _NON_PACE_BOOKING_STATUSES:
            continue
        ci = _to_date(b.get("check_in_date"))
        co = _to_date(b.get("check_out_date"))
        if ci is None or co is None or co <= ci:
            continue
        bookings.append((ci, co, _num(b.get("total_amount"))))

    out = {}
    for h in horizons:
        w_start, w_end = today, today + timedelta(days=int(h))
        nights = 0
        revenue = 0.0
        for start, end, rate in in_house:
            n = _overlap_nights(start, end, w_start, w_end)
            nights += n
            revenue += n * rate
        for ci, co, total in bookings:
            n = _overlap_nights(ci, co, w_start, w_end)
            if n:
                nights += n
                revenue += total * n / (co - ci).days
        available = room_count * int(h)
        out[h] = {
            "occupied_room_nights": nights,
            "available_room_nights": available,
            "occupancy_pct": round(nights / available * 100.0, 1) if available > 0 else 0,
            "on_books_revenue": _r2(revenue),
        }
    return {"horizons": out}


# ── seasonality ─────────────────────────────────────────────────────────

_WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
             "Saturday", "Sunday")


def _month_start(d: date) -> date:
    return d.replace(day=1)


def _add_months(d: date, n: int) -> date:
    idx = d.year * 12 + (d.month - 1) + n
    return date(idx // 12, idx % 12 + 1, 1)


def _overlapping(stays: list, ws: date, we_incl: date, today: date) -> list:
    """Stays whose nights could touch [ws, we_incl] (cheap prefilter)."""
    out = []
    for s in stays:
        ci = _to_date(s.get("checkin_time"))
        if ci is None or ci > we_incl:
            continue
        co = _to_date(s.get("checkout_time")) or today
        if co <= ws:
            continue
        out.append(s)
    return out


def _kpi_triplet(occupied: int, available: int, revenue: float) -> dict:
    return {
        "occupancy_pct": round(occupied / available * 100.0, 1) if available > 0 else 0,
        "adr": round(revenue / occupied, 2) if occupied > 0 else 0,
        "revpar": round(revenue / available, 2) if available > 0 else 0,
    }


def compute_seasonality(stays: list, room_count: int, window_from: str,
                        window_to: str, today: date) -> dict:
    """
    Occupancy / ADR / RevPAR by weekday (over the window) and by calendar
    month (trailing 12 months, regardless of the window).

    Every figure is kpi_service.compute_kpis on a one-day (weekday) or
    month-long window; weekday values are pooled (sum of nights and revenue
    over that weekday's dates, then re-divided) rather than averaged, so a
    weekday with more dates in the window weighs correctly. The window and the
    current month are capped at `today` — the future is never "empty".
    """
    ws = _to_date(window_from) or today
    we = min(_to_date(window_to) or today, today)

    pool = [[0, 0, 0.0] for _ in range(7)]   # occupied, available, revenue
    near = _overlapping(stays or [], ws, we, today)
    d = ws
    while d <= we:
        k = compute_kpis(near, room_count, d, d, today=today)
        p = pool[d.weekday()]
        p[0] += k["occupied_room_nights"]
        p[1] += k["available_room_nights"]
        p[2] += k["room_revenue"]
        d += timedelta(days=1)
    weekday = [{"weekday": name, **_kpi_triplet(*pool[i])}
               for i, name in enumerate(_WEEKDAYS)]

    this_month = _month_start(today)
    months = []
    for back in range(11, -1, -1):
        m0 = _add_months(this_month, -back)
        m_end = min(_add_months(m0, 1) - timedelta(days=1), today)
        k = compute_kpis(_overlapping(stays or [], m0, m_end, today),
                         room_count, m0, m_end, today=today)
        months.append({"month": m0.strftime("%Y-%m"), "occupancy_pct": k["occupancy_pct"],
                       "adr": k["adr"], "revpar": k["revpar"]})
    return {"weekday": weekday, "months": months}
