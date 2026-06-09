"""
KPI service — Occupancy %, ADR, and RevPAR on a *date-of-stay* basis.

Why date-of-stay (and not checkout basis)
-----------------------------------------
The existing /revenue_report recognises revenue on the day a guest checks
OUT. That is correct for cash/GST accounting, but it is the WRONG basis for
the three core hotel performance metrics, because a single stay's nights can
straddle the reporting window. Occupancy, ADR (Average Daily Rate) and RevPAR
(Revenue Per Available Room) are, by industry definition, measured per night
of stay against the dates those nights actually fall on.

This module therefore apportions every stay night-by-night onto the calendar
and only counts the nights that land inside the requested window. In-house
(not-yet-checked-out) stays are included up to "today", so a current-month
report reflects guests still in the building.

Definitions implemented
------------------------
    available_room_nights = room_count * nights_in_window
    occupied_room_nights  = Σ (stay nights that fall inside the window)
    room_revenue          = Σ (per-night room rate * those in-window nights)

    occupancy_pct = occupied_room_nights / available_room_nights * 100
    adr           = room_revenue / occupied_room_nights
    revpar        = room_revenue / available_room_nights      (= adr * occupancy)

Scope / deliberate exclusions
-----------------------------
  * "Room revenue" is ROOM charges only (room_charges_total), never services,
    F&B, or laundry — ADR/RevPAR are accommodation metrics.
  * Cancelled / voided stays are excluded entirely.
  * GST is NOT stripped here. room_charges_total is used as stored; if the
    property wants tax-exclusive ADR that is a follow-up, called out in the
    response via `revenue_basis`.

This module is pure (no Firestore, no Flask). The route layer fetches the
bills and the room count and passes them in, which keeps the math unit-testable.
"""

from datetime import date, datetime, timedelta

# Stay statuses that represent a real, sellable occupancy.
# draft               = guest currently in-house (not checked out yet)
# completed           = checked out, fully paid
# pending_settlement  = checked out, balance unpaid
_COUNTED_STATUSES = frozenset({"draft", "completed", "pending_settlement"})
# Never counted — no occupancy, no revenue.
_EXCLUDED_STATUSES = frozenset({"cancelled", "voided"})


def _parse_stay_date(value):
    """
    Parse a stay timestamp ("YYYY-MM-DD HH:MM" or "YYYY-MM-DD") into a date.
    Returns None if it can't be parsed. Only the date part matters for nights.
    """
    if not value:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    s = str(value).strip()
    if not s:
        return None
    head = s.split(" ")[0]  # drop the HH:MM if present
    try:
        return datetime.strptime(head, "%Y-%m-%d").date()
    except ValueError:
        return None


def _nightly_rate(room_charges_total, total_stay_nights, room_price_per_night):
    """
    Best per-night room rate for a stay.

    Prefer the finalised room_charges_total spread across the stay's nights
    (this captures multi-night, multi-rate, and discounted stays accurately).
    Fall back to the declared per-night tariff when the total isn't available
    yet — i.e. for in-house drafts whose bill hasn't been computed at checkout.
    """
    try:
        rct = float(room_charges_total or 0)
    except (TypeError, ValueError):
        rct = 0.0
    if rct > 0 and total_stay_nights > 0:
        return rct / total_stay_nights
    try:
        return float(room_price_per_night or 0)
    except (TypeError, ValueError):
        return 0.0


def compute_kpis(bills, room_count, window_start, window_end_inclusive,
                 *, today=None, include_ota=True):
    """
    Compute occupancy / ADR / RevPAR for a date window.

    Parameters
    ----------
    bills : iterable of dict
        Each stay doc. Fields used: checkin_time, checkout_time, status,
        room_charges_total, room_price_per_night, payment_source.
    room_count : int
        Number of sellable rooms (the capacity baseline). See caveat in the
        route: this is current inventory, used for all historical windows too.
    window_start : datetime.date
        First night of the window (inclusive).
    window_end_inclusive : datetime.date
        Last night of the window (inclusive). A single-day report passes
        window_start == window_end_inclusive and measures one night.
    today : datetime.date, optional
        "Now" for capping in-house stays. Defaults to date.today().
    include_ota : bool
        When False, stays with payment_source == "ota" are excluded (lets the
        caller measure direct-business performance separately).

    Returns
    -------
    dict — KPIs plus the supporting counts that produced them, so the numbers
    are auditable rather than opaque.
    """
    if today is None:
        today = date.today()

    # Window as a half-open [start, end_exclusive) range of nights.
    window_end_exclusive = window_end_inclusive + timedelta(days=1)
    nights_in_window = max((window_end_exclusive - window_start).days, 0)

    room_count = max(int(room_count or 0), 0)
    available_room_nights = room_count * nights_in_window

    occupied_room_nights = 0
    room_revenue = 0.0
    counted_stays = 0
    skipped_no_dates = 0
    excluded_ota = 0

    for b in (bills or []):
        status = (b.get("status") or "").strip().lower()
        if status in _EXCLUDED_STATUSES:
            continue
        # Unknown statuses are treated conservatively as not-counted, except
        # the explicit counted set. This avoids a future status silently
        # inflating occupancy.
        if status and status not in _COUNTED_STATUSES:
            continue

        if not include_ota and (b.get("payment_source") == "ota"):
            excluded_ota += 1
            continue

        checkin_d = _parse_stay_date(b.get("checkin_time"))
        if checkin_d is None:
            skipped_no_dates += 1
            continue

        checkout_d = _parse_stay_date(b.get("checkout_time"))
        if checkout_d is None:
            # In-house: count nights already slept, i.e. up to today.
            checkout_d = today
        # A guest who checks in and out on the same calendar day occupies the
        # room for billing but contributes 0 *nights*; clamp so we never go
        # negative on bad data (checkout before checkin).
        total_stay_nights = max((checkout_d - checkin_d).days, 0)

        # Overlap of [checkin, checkout) with [window_start, window_end_excl).
        overlap_start = max(checkin_d, window_start)
        overlap_end = min(checkout_d, window_end_exclusive)
        in_window_nights = max((overlap_end - overlap_start).days, 0)
        if in_window_nights <= 0:
            continue

        rate = _nightly_rate(
            b.get("room_charges_total"),
            total_stay_nights,
            b.get("room_price_per_night"),
        )

        occupied_room_nights += in_window_nights
        room_revenue += rate * in_window_nights
        counted_stays += 1

    occupancy_pct = (
        (occupied_room_nights / available_room_nights * 100.0)
        if available_room_nights > 0 else 0.0
    )
    adr = (room_revenue / occupied_room_nights) if occupied_room_nights > 0 else 0.0
    revpar = (
        (room_revenue / available_room_nights)
        if available_room_nights > 0 else 0.0
    )

    return {
        "occupancy_pct": round(occupancy_pct, 1),
        "adr": round(adr, 2),
        "revpar": round(revpar, 2),
        "room_revenue": round(room_revenue, 2),
        "occupied_room_nights": occupied_room_nights,
        "available_room_nights": available_room_nights,
        "room_count": room_count,
        "nights_in_window": nights_in_window,
        "counted_stays": counted_stays,
        "skipped_no_dates": skipped_no_dates,
        "excluded_ota": excluded_ota,
        "include_ota": include_ota,
        "revenue_basis": "room_charges_total (GST-inclusive as stored)",
        # Flag obviously-impossible occupancy so the UI / caller can warn that
        # room_count is probably wrong rather than silently trusting it.
        "occupancy_over_100": occupancy_pct > 100.0,
    }
