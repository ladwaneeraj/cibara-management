"""
Daily operations insights — pure computation over audit_logs events.

What this answers
-----------------
"How many rooms were cleaned each day, how fast, by whom — and what should I
fix in the process?"  Plus per-day check-ins/check-outs, collections and
occupancy, so a single dashboard tells the whole daily story.

Data sources (all passed in by the route layer — this module is pure):
  * audit_logs events  — the append-only history written by write_log():
        room.checkout            → cleaning window STARTS
        room.cleaning.complete   → housekeeping stage done
        room.inspection.approve  → room READY (cleaning window ENDS)
        room.checkin             → check-in counter
        booking.revert           → checkout was reverted; voids the cycle
  * payments docs      — per-day collections (same classification as /reports)
  * bills docs         — occupancy/ADR/RevPAR via kpi_service (date-of-stay)

Day boundary
------------
Calendar days, IST midnight-to-midnight — identical to every other report in
the app.  All audit timestamps are IST strings ("YYYY-MM-DD HH:MM:SS") so a
day bucket is simply timestamp[:10].

Cleaning-cycle pairing
----------------------
The room document only holds the CURRENT cleaning state (nulled on approve),
so history must be reconstructed by pairing audit events per room in
chronological order:

    checkout ──▶ cleaning.complete ──▶ inspection.approve
    (start)      (stage 1, optional)   (ready — closes the cycle)

Rules:
  * an approve may arrive without a prior cleaning.complete (admin/manager
    one-step approve — metadata.skipped_housekeeping);
  * a checkout while a cycle is still open closes the old cycle as
    INCOMPLETE (data hygiene signal) and opens a new one;
  * booking.revert voids the open cycle for that room (the checkout was a
    mistake — the guest is back in the room; nothing was really cleaned);
  * events without a parseable timestamp are ignored;
  * negative durations (clock skew / bad data) are recorded as None so they
    never poison the averages.

A cycle is counted on the day it COMPLETED (ready date), which is what
"rooms cleaned that day" means operationally.  Callers should fetch events
with a couple of days of lookback before the window so cycles straddling
midnight still pair up; only cycles completing inside the window are
reported.

This module is pure (no Firestore, no Flask) — see tests/test_insights_service.py.
"""

from collections import defaultdict
from datetime import datetime, timedelta
from statistics import median

from services.kpi_service import compute_kpis

# Audit actions this module understands.
ACTION_CHECKOUT = "room.checkout"
ACTION_CLEANED = "room.cleaning.complete"
ACTION_APPROVED = "room.inspection.approve"
ACTION_CHECKIN = "room.checkin"
ACTION_REVERT = "booking.revert"

RELEVANT_ACTIONS = frozenset({
    ACTION_CHECKOUT, ACTION_CLEANED, ACTION_APPROVED,
    ACTION_CHECKIN, ACTION_REVERT,
})

# Payment `type`s that are refunds (mirrors routes/reports.py:_exclude_refunds).
_REFUND_TYPES = frozenset({
    "refund", "checkout_refund", "manual_refund", "booking_cancel_refund",
})
_NON_REVENUE_TYPES = frozenset({"expense", "discount"})

# A cleaning slower than this (minutes) is flagged in the day log + insights.
DEFAULT_SLOW_THRESHOLD_MIN = 90
# Durations beyond this are almost certainly stale/forgotten rooms, not real
# cleaning effort; they still show in the log but are excluded from averages.
_MAX_SANE_DURATION_MIN = 24 * 60


# ── small helpers ───────────────────────────────────────────────────────────

def _parse_ts(value):
    """Parse an IST audit timestamp string. Returns datetime or None."""
    if isinstance(value, datetime):
        return value
    s = str(value or "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _minutes_between(start_dt, end_dt):
    """Minutes from start to end; None if either missing or negative."""
    if start_dt is None or end_dt is None:
        return None
    delta = (end_dt - start_dt).total_seconds() / 60.0
    if delta < 0:
        return None
    return round(delta, 1)


def _day_list(window_from, window_to):
    """Inclusive list of YYYY-MM-DD strings."""
    start = datetime.strptime(window_from, "%Y-%m-%d").date()
    end = datetime.strptime(window_to, "%Y-%m-%d").date()
    out = []
    d = start
    while d <= end:
        out.append(d.strftime("%Y-%m-%d"))
        d += timedelta(days=1)
    return out


def _fmt_min(minutes):
    """Human duration: 95 → '1h 35m', 40 → '40m'."""
    if minutes is None:
        return "—"
    m = int(round(minutes))
    if m < 60:
        return f"{m}m"
    return f"{m // 60}h {m % 60:02d}m"


def _avg(values):
    vals = [v for v in values if v is not None]
    return round(sum(vals) / len(vals), 1) if vals else None


def _dedupe_events(events):
    """
    Drop exact duplicate audit entries: same (action, room, timestamp).
    A frontend double-tap used to race two identical requests past the
    endpoint's status check, writing two audit docs for one human action.
    The endpoint is transactional now, but history still contains dupes.
    """
    seen = set()
    out = []
    for ev in (events or []):
        key = (ev.get("action"), str(ev.get("targetId")),
               str(ev.get("timestamp")))
        if key in seen:
            continue
        seen.add(key)
        out.append(ev)
    return out


# ── cycle pairing ───────────────────────────────────────────────────────────

def _new_cycle(room):
    return {
        "room": str(room),
        "guest": None,
        "checkout_ts": None, "checkout_by": None,
        "cleaned_ts": None, "cleaned_by": None, "cleaned_by_role": None,
        "ready_ts": None, "inspected_by": None,
        "skipped_housekeeping": False,
        "voided": False,        # checkout reverted — not a real cleaning
        "complete": False,      # reached ready state
        "incomplete": False,    # superseded by a newer checkout before ready
        "total_min": None,      # checkout → ready
        "clean_min": None,      # checkout → cleaned (housekeeping response)
        "inspect_wait_min": None,  # cleaned → ready (inspection lag)
        "excluded_from_stats": False,  # insane duration (stale room)
    }


def _finalise_durations(cycle):
    co = _parse_ts(cycle["checkout_ts"])
    cl = _parse_ts(cycle["cleaned_ts"])
    rd = _parse_ts(cycle["ready_ts"])
    cycle["total_min"] = _minutes_between(co, rd)
    cycle["clean_min"] = _minutes_between(co, cl)
    cycle["inspect_wait_min"] = _minutes_between(cl, rd)
    if cycle["total_min"] is not None and cycle["total_min"] > _MAX_SANE_DURATION_MIN:
        cycle["excluded_from_stats"] = True
    return cycle


def pair_cleaning_cycles(events):
    """
    Reconstruct cleaning cycles from audit events (any order; any actions —
    irrelevant ones are skipped).  Returns a list of cycle dicts.
    """
    by_room = defaultdict(list)
    for ev in _dedupe_events(events):
        action = ev.get("action")
        if action not in (ACTION_CHECKOUT, ACTION_CLEANED, ACTION_APPROVED,
                          ACTION_REVERT):
            continue
        ts = _parse_ts(ev.get("timestamp"))
        if ts is None:
            continue
        room = str(ev.get("targetId") or "").strip()
        if not room:
            continue
        by_room[room].append((ts, ev))

    cycles = []
    for room, evs in by_room.items():
        evs.sort(key=lambda pair: pair[0])
        open_cycle = None
        room_completed = False  # room already had a completed cycle in stream

        for ts, ev in evs:
            action = ev.get("action")
            user = ev.get("userName") or ev.get("userId") or "unknown"
            role = ev.get("userRole") or ""
            meta = ev.get("metadata") or {}

            if action == ACTION_CHECKOUT:
                if open_cycle is not None:
                    # New checkout before the previous cycle finished —
                    # the old one never reached "ready".
                    open_cycle["incomplete"] = True
                    cycles.append(_finalise_durations(open_cycle))
                open_cycle = _new_cycle(room)
                open_cycle["checkout_ts"] = ev.get("timestamp")
                open_cycle["checkout_by"] = user
                open_cycle["guest"] = meta.get("guest")

            elif action == ACTION_CLEANED:
                if open_cycle is None:
                    # Stage-1 without a visible checkout (window edge or
                    # legacy data) — open an orphan cycle so a following
                    # approve still pairs and counts as a completion.
                    open_cycle = _new_cycle(room)
                if open_cycle["cleaned_ts"] is None:
                    open_cycle["cleaned_ts"] = ev.get("timestamp")
                    open_cycle["cleaned_by"] = user
                    open_cycle["cleaned_by_role"] = role

            elif action == ACTION_APPROVED:
                if open_cycle is None:
                    # An approve for an already-vacant room (no checkout in
                    # between) is a duplicate/replayed request — counting it
                    # would double the day's cleanings. Only treat it as an
                    # orphan completion when this is the room's FIRST
                    # sighting in the stream (checkout predates the fetch
                    # window, or its audit write was lost).
                    if room_completed:
                        continue
                    open_cycle = _new_cycle(room)
                open_cycle["ready_ts"] = ev.get("timestamp")
                open_cycle["inspected_by"] = user
                open_cycle["skipped_housekeeping"] = bool(
                    meta.get("skipped_housekeeping")
                ) or open_cycle["cleaned_ts"] is None
                open_cycle["complete"] = True
                cycles.append(_finalise_durations(open_cycle))
                open_cycle = None
                room_completed = True

            elif action == ACTION_REVERT:
                # Checkout reverted → the cleaning cycle never really
                # happened (guest restored to the room).
                if open_cycle is not None:
                    open_cycle["voided"] = True
                    cycles.append(_finalise_durations(open_cycle))
                    open_cycle = None
                elif cycles:
                    # Revert can land shortly after an (erroneous) approve.
                    last = cycles[-1]
                    last_ready = _parse_ts(last.get("ready_ts"))
                    if (last["room"] == room and last_ready is not None
                            and 0 <= (ts - last_ready).total_seconds() <= 3 * 3600):
                        last["voided"] = True

        if open_cycle is not None:
            # Still open at the end of the event stream — either the room is
            # in cleaning RIGHT NOW or it was forgotten. The caller decides
            # (live pending comes from the rooms collection, not from here).
            cycles.append(_finalise_durations(open_cycle))

    return cycles


# ── per-day aggregation ─────────────────────────────────────────────────────

def _empty_day(date_str):
    weekday = datetime.strptime(date_str, "%Y-%m-%d").strftime("%A")
    return {
        "date": date_str,
        "weekday": weekday,
        "cleanings": 0,                # cycles completed (ready) this day
        "checkouts": 0,
        "checkins": 0,
        "reverts": 0,
        "skipped_housekeeping": 0,     # one-step approves
        "slow_cleanings": 0,           # over threshold
        "turnaround": {
            "avg_min": None, "median_min": None,
            "min_min": None, "max_min": None, "max_room": None,
            "samples": 0,
        },
        "stages": {"avg_clean_min": None, "avg_inspect_wait_min": None},
        "hourly": {
            "checkouts": [0] * 24,
            "readies": [0] * 24,
            "checkins": [0] * 24,
        },
        "staff": [],                   # [{name, role, cleaned, inspected, avg_clean_min}]
        "cycles": [],                  # per-cleaning log rows
        "revenue": {"cash": 0, "online": 0, "refunds": 0, "net": 0, "txns": 0},
        "occupancy": None,             # filled when bills provided
    }


def _cycle_log_row(cycle, slow_threshold_min):
    total = cycle["total_min"]
    return {
        "room": cycle["room"],
        "guest": cycle["guest"],
        "checkout_ts": cycle["checkout_ts"],
        "cleaned_ts": cycle["cleaned_ts"],
        "ready_ts": cycle["ready_ts"],
        "total_min": total,
        "total_label": _fmt_min(total),
        "clean_min": cycle["clean_min"],
        "inspect_wait_min": cycle["inspect_wait_min"],
        "cleaned_by": cycle["cleaned_by"],
        "inspected_by": cycle["inspected_by"],
        "skipped_housekeeping": cycle["skipped_housekeeping"],
        "slow": (total is not None and total >= slow_threshold_min
                 and not cycle["excluded_from_stats"]),
        "stale": cycle["excluded_from_stats"],
    }


def compute_daily_insights(events, window_from, window_to, *,
                           payments=(), bills=(), room_count=0,
                           now=None, slow_threshold_min=DEFAULT_SLOW_THRESHOLD_MIN):
    """
    Build the full insights payload for an inclusive [window_from, window_to]
    date window (YYYY-MM-DD strings, IST calendar days).

    `events` may (and should) include a few days of lookback BEFORE
    window_from so cleaning cycles straddling midnight pair correctly.

    Returns a JSON-serialisable dict — see the route for the wire format.
    """
    if now is None:
        now = datetime.now()

    # Collapse exact duplicate audit entries (double-tap races) so raw
    # counters (checkouts, check-ins, hourly) aren't inflated either.
    events = _dedupe_events(events)

    day_index = {d: _empty_day(d) for d in _day_list(window_from, window_to)}

    # ── raw event counters (checkouts / checkins / reverts + hourly) ──────
    for ev in (events or []):
        action = ev.get("action")
        ts = _parse_ts(ev.get("timestamp"))
        if ts is None:
            continue
        day = day_index.get(ts.strftime("%Y-%m-%d"))
        if day is None:
            continue  # lookback event — pairing only
        if action == ACTION_CHECKOUT:
            day["checkouts"] += 1
            day["hourly"]["checkouts"][ts.hour] += 1
        elif action == ACTION_CHECKIN:
            day["checkins"] += 1
            day["hourly"]["checkins"][ts.hour] += 1
        elif action == ACTION_REVERT:
            day["reverts"] += 1

    # ── cleaning cycles ────────────────────────────────────────────────────
    cycles = pair_cleaning_cycles(events)
    window_cycles = []  # completed, non-void cycles inside the window
    incomplete_in_window = 0

    for cyc in cycles:
        if cyc["voided"]:
            continue
        if cyc["incomplete"]:
            co = _parse_ts(cyc["checkout_ts"])
            if co is not None and co.strftime("%Y-%m-%d") in day_index:
                incomplete_in_window += 1
            continue
        if not cyc["complete"]:
            continue  # still open (live pending handled by the route)
        rd = _parse_ts(cyc["ready_ts"])
        day = day_index.get(rd.strftime("%Y-%m-%d")) if rd else None
        if day is None:
            continue
        window_cycles.append(cyc)
        day["cleanings"] += 1
        day["hourly"]["readies"][rd.hour] += 1
        if cyc["skipped_housekeeping"]:
            day["skipped_housekeeping"] += 1
        row = _cycle_log_row(cyc, slow_threshold_min)
        if row["slow"]:
            day["slow_cleanings"] += 1
        day["cycles"].append(row)

    # per-day turnaround stats + staff
    for day in day_index.values():
        durations = [c["total_min"] for c in day["cycles"]
                     if c["total_min"] is not None and not c["stale"]]
        t = day["turnaround"]
        t["samples"] = len(durations)
        if durations:
            t["avg_min"] = _avg(durations)
            t["median_min"] = round(median(durations), 1)
            t["min_min"] = min(durations)
            t["max_min"] = max(durations)
            t["max_room"] = next(
                (c["room"] for c in day["cycles"] if c["total_min"] == t["max_min"]),
                None,
            )
        day["stages"]["avg_clean_min"] = _avg(
            [c["clean_min"] for c in day["cycles"] if not c["stale"]]
        )
        day["stages"]["avg_inspect_wait_min"] = _avg(
            [c["inspect_wait_min"] for c in day["cycles"] if not c["stale"]]
        )

        staff = {}
        for c in day["cycles"]:
            if c["cleaned_by"]:
                s = staff.setdefault(c["cleaned_by"], {
                    "name": c["cleaned_by"], "cleaned": 0, "inspected": 0,
                    "_clean_mins": [],
                })
                s["cleaned"] += 1
                if c["clean_min"] is not None and not c["stale"]:
                    s["_clean_mins"].append(c["clean_min"])
            if c["inspected_by"]:
                s = staff.setdefault(c["inspected_by"], {
                    "name": c["inspected_by"], "cleaned": 0, "inspected": 0,
                    "_clean_mins": [],
                })
                s["inspected"] += 1
        day["staff"] = sorted(
            ({
                "name": s["name"], "cleaned": s["cleaned"],
                "inspected": s["inspected"],
                "avg_clean_min": _avg(s["_clean_mins"]),
            } for s in staff.values()),
            key=lambda s: (-s["cleaned"], -s["inspected"], s["name"]),
        )
        day["cycles"].sort(key=lambda c: c["ready_ts"] or "")

    # ── revenue per day (payments basis, same rules as /reports) ──────────
    for p in (payments or []):
        day = day_index.get(str(p.get("date") or "")[:10])
        if day is None:
            continue
        try:
            amount = float(p.get("amount") or 0)
        except (TypeError, ValueError):
            continue
        ptype = (p.get("type") or "").strip()
        method = (p.get("method") or "").strip().lower()
        rev = day["revenue"]
        if ptype in _REFUND_TYPES:
            rev["refunds"] += amount
        elif ptype in _NON_REVENUE_TYPES:
            continue
        elif method == "cash":
            rev["cash"] += amount
            rev["txns"] += 1
        elif method == "online":
            rev["online"] += amount
            rev["txns"] += 1
    for day in day_index.values():
        rev = day["revenue"]
        rev["net"] = round(rev["cash"] + rev["online"] - rev["refunds"], 2)
        rev["cash"] = round(rev["cash"], 2)
        rev["online"] = round(rev["online"], 2)
        rev["refunds"] = round(rev["refunds"], 2)

    # ── occupancy per day (date-of-stay basis via kpi_service) ─────────────
    if bills and room_count:
        for date_str, day in day_index.items():
            d = datetime.strptime(date_str, "%Y-%m-%d").date()
            k = compute_kpis(bills, room_count, d, d, today=now.date())
            day["occupancy"] = {
                "occupancy_pct": k["occupancy_pct"],
                "adr": k["adr"],
                "revpar": k["revpar"],
                "occupied_room_nights": k["occupied_room_nights"],
            }

    days = [day_index[d] for d in sorted(day_index)]
    totals = _window_totals(days, window_cycles, incomplete_in_window)
    insights = generate_insights(
        days, window_cycles, totals,
        incomplete_in_window=incomplete_in_window,
        slow_threshold_min=slow_threshold_min,
    )

    return {
        "window": {"from": window_from, "to": window_to, "days": len(days)},
        "days": days,
        "totals": totals,
        "insights": insights,
        "slow_threshold_min": slow_threshold_min,
    }


def _window_totals(days, window_cycles, incomplete_in_window):
    durations = [c["total_min"] for c in window_cycles
                 if c["total_min"] is not None and not c["excluded_from_stats"]]
    cleanings = sum(d["cleanings"] for d in days)
    active_days = [d for d in days if d["cleanings"] > 0]
    best = max(active_days, key=lambda d: d["cleanings"], default=None)

    # busiest weekday by average checkouts (only over weekdays present)
    wd_counts = defaultdict(list)
    for d in days:
        wd_counts[d["weekday"]].append(d["checkouts"])
    busiest_weekday = None
    if any(sum(v) for v in wd_counts.values()):
        busiest_weekday = max(wd_counts, key=lambda w: sum(wd_counts[w]) / len(wd_counts[w]))

    return {
        "cleanings": cleanings,
        "checkouts": sum(d["checkouts"] for d in days),
        "checkins": sum(d["checkins"] for d in days),
        "reverts": sum(d["reverts"] for d in days),
        "skipped_housekeeping": sum(d["skipped_housekeeping"] for d in days),
        "slow_cleanings": sum(d["slow_cleanings"] for d in days),
        "incomplete_cycles": incomplete_in_window,
        "avg_turnaround_min": _avg(durations),
        "median_turnaround_min": round(median(durations), 1) if durations else None,
        "revenue_net": round(sum(d["revenue"]["net"] for d in days), 2),
        "avg_occupancy_pct": _avg(
            [d["occupancy"]["occupancy_pct"] for d in days if d["occupancy"]]
        ),
        "best_day": {"date": best["date"], "cleanings": best["cleanings"]} if best else None,
        "busiest_weekday": busiest_weekday,
        "avg_cleanings_per_day": round(cleanings / len(days), 1) if days else 0,
    }


# ── rule-based insights ─────────────────────────────────────────────────────

def generate_insights(days, window_cycles, totals, *,
                      incomplete_in_window=0,
                      slow_threshold_min=DEFAULT_SLOW_THRESHOLD_MIN):
    """
    Turn the aggregates into short, actionable, plain-language findings.
    Each: {"level": "good"|"warn"|"info", "icon": <fa name>, "text": str}.
    Rules are deliberately conservative — an insight only fires when the
    sample is big enough to mean something.
    """
    out = []
    add = lambda level, icon, text: out.append(
        {"level": level, "icon": icon, "text": text}
    )

    stats_cycles = [c for c in window_cycles
                    if c["total_min"] is not None and not c["excluded_from_stats"]]
    med = totals.get("median_turnaround_min")

    # 1. Turnaround trend — second half of the window vs first half.
    if len(days) >= 6:
        half = len(days) // 2
        first = [d["turnaround"]["avg_min"] for d in days[:half]
                 if d["turnaround"]["avg_min"] is not None]
        second = [d["turnaround"]["avg_min"] for d in days[half:]
                  if d["turnaround"]["avg_min"] is not None]
        if len(first) >= 2 and len(second) >= 2:
            a, b = _avg(first), _avg(second)
            if a and b:
                change = (b - a) / a * 100
                if change >= 20:
                    add("warn", "arrow-trend-up",
                        f"Cleaning turnaround is getting slower: avg "
                        f"{_fmt_min(a)} in the first half of this period vs "
                        f"{_fmt_min(b)} recently ({change:+.0f}%).")
                elif change <= -20:
                    add("good", "arrow-trend-down",
                        f"Cleaning turnaround improved from {_fmt_min(a)} to "
                        f"{_fmt_min(b)} ({change:+.0f}%). Keep it up.")

    # 2. Peak checkout hour → when to schedule housekeeping.
    hourly_co = [0] * 24
    for d in days:
        for h, n in enumerate(d["hourly"]["checkouts"]):
            hourly_co[h] += n
    total_co = sum(hourly_co)
    if total_co >= 10:
        peak = max(range(24), key=lambda h: hourly_co[h])
        share = hourly_co[peak] / total_co * 100
        if share >= 15:
            add("info", "clock",
                f"Most checkouts happen around {peak:02d}:00–{(peak + 1) % 24:02d}:00 "
                f"({hourly_co[peak]} of {total_co}). Having housekeeping ready "
                f"just before this window shortens room downtime the most.")

    # 3. Repeat slow rooms — same room slow on multiple days.
    slow_by_room = defaultdict(int)
    for c in stats_cycles:
        if c["total_min"] >= slow_threshold_min:
            slow_by_room[c["room"]] += 1
    repeat = sorted((r for r, n in slow_by_room.items() if n >= 2),
                    key=lambda r: -slow_by_room[r])
    if repeat:
        top = ", ".join(f"Room {r} ({slow_by_room[r]}×)" for r in repeat[:3])
        add("warn", "triangle-exclamation",
            f"Repeatedly slow turnarounds (>{_fmt_min(slow_threshold_min)}): {top}. "
            f"Check supplies, access or workload for these rooms.")

    # 4. Inspection lag — rooms sit cleaned but not approved (not sellable).
    waits = [c["inspect_wait_min"] for c in stats_cycles
             if c["inspect_wait_min"] is not None and not c["skipped_housekeeping"]]
    if len(waits) >= 5:
        avg_wait = _avg(waits)
        if avg_wait and avg_wait >= 30:
            add("warn", "magnifying-glass",
                f"Cleaned rooms wait an average of {_fmt_min(avg_wait)} for "
                f"inspection before becoming bookable. Faster approvals put "
                f"rooms back on sale sooner.")

    # 5. Skipped housekeeping stage share.
    if totals["cleanings"] >= 10:
        share = totals["skipped_housekeeping"] / totals["cleanings"] * 100
        if share >= 30:
            add("info", "forward",
                f"{share:.0f}% of cleanings were approved in one step without "
                f"the housekeeping 'cleaned' stage. If that's not intentional, "
                f"per-staff cleaning stats will undercount.")

    # 6. Staff workload imbalance.
    by_cleaner = defaultdict(int)
    for c in window_cycles:
        if c["cleaned_by"]:
            by_cleaner[c["cleaned_by"]] += 1
    total_cleaned = sum(by_cleaner.values())
    if total_cleaned >= 10 and len(by_cleaner) >= 2:
        top_name = max(by_cleaner, key=by_cleaner.get)
        share = by_cleaner[top_name] / total_cleaned * 100
        if share >= 60:
            add("info", "user-group",
                f"{top_name} handled {share:.0f}% of all cleanings "
                f"({by_cleaner[top_name]} of {total_cleaned}). Consider "
                f"rebalancing shifts if this isn't by design.")

    # 7. Cycles that never reached "ready" (forgotten rooms / data hygiene).
    if incomplete_in_window:
        add("warn", "circle-question",
            f"{incomplete_in_window} checkout(s) were never marked ready "
            f"before the next checkout of the same room — rooms may have "
            f"been re-let without a recorded cleaning.")

    # 8. Fast overall performance — positive signal.
    if med is not None and med <= 45 and totals["cleanings"] >= 10:
        add("good", "bolt",
            f"Median turnaround is {_fmt_min(med)} across "
            f"{totals['cleanings']} cleanings — rooms are returning to sale "
            f"quickly.")

    # 9. Occupancy pressure vs turnaround.
    occ_days = [d for d in days
                if d["occupancy"] and d["turnaround"]["avg_min"] is not None]
    if len(occ_days) >= 6:
        hi = [d["turnaround"]["avg_min"] for d in occ_days
              if d["occupancy"]["occupancy_pct"] >= 80]
        lo = [d["turnaround"]["avg_min"] for d in occ_days
              if d["occupancy"]["occupancy_pct"] < 80]
        if len(hi) >= 2 and len(lo) >= 2:
            ah, al = _avg(hi), _avg(lo)
            if ah and al and al > 0 and (ah - al) / al >= 0.3:
                add("warn", "gauge-high",
                    f"On busy days (≥80% occupancy) turnaround averages "
                    f"{_fmt_min(ah)} vs {_fmt_min(al)} on quieter days. "
                    f"Extra housekeeping cover on peak days would recover "
                    f"sellable hours.")

    if not out:
        add("info", "circle-info",
            "Not enough activity in this period for pattern-level insights. "
            "Totals and the daily log above are still exact.")
    return out
