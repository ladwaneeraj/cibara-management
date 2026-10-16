"""
/api/v2/dashboard — one round trip for the whole front-desk screen.

The old page made three calls on load (/get_data, /get_transaction_metadata,
/get_upcoming_bookings) plus /settings/ui_config. This endpoint runs the same
legacy handlers in parallel in-process (their caches, bucketing and business
rules unchanged) and returns one role-shaped payload:

  • housekeeping never receives revenue totals or payment logs (the old API
    sent them to every role and relied on the UI to hide them);
  • room-state counters and "renewal due" are computed server-side with the
    exact rule from static/script.js (getRoomRenewalStatus / updateStats), so
    phones and desktops agree regardless of the device clock.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Request

from ..legacy import legacy_config
from ..security.deps import Principal, get_principal
from ._forward import legacy

router = APIRouter(prefix="/api/v2", tags=["dashboard"])

_REFUND_TYPES = ("refund", "checkout_refund", "manual_refund", "booking_cancel_refund")


def _room_sort_key(rid: str):
    try:
        return (0, int(rid), rid)
    except ValueError:
        return (1, 0, rid)


def _parse_ist(ts: str | None):
    if not ts:
        return None
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(ts[:19] if fmt.endswith("%S") else ts[:16], fmt)
        except ValueError:
            continue
    return None


def renewal_status(room: dict, now_ist: datetime) -> dict:
    """Port of static/script.js getRoomRenewalStatus (server clock, IST)."""
    if room.get("status") != "occupied" or not room.get("guest"):
        return {"day": 0, "due": False, "next_renewal": None, "minutes_left": None}
    checkin = _parse_ist(room.get("checkin_time"))
    if checkin is None:
        return {"day": 1, "due": False, "next_renewal": None, "minutes_left": None}
    day = int(room.get("renewal_count") or 0) + 1
    nxt = checkin + timedelta(days=day)
    left = (nxt - now_ist).total_seconds() / 60
    return {"day": day, "due": left <= 0, "next_renewal": nxt.strftime("%Y-%m-%d %H:%M"),
            "minutes_left": int(left)}


def is_mmt_prepaid(room: dict) -> bool:
    g = room.get("guest") or {}
    return g.get("payment") == "ota" and (room.get("balance") or 0) <= 0


def compute_stats(rooms: list[dict], now_ist: datetime) -> dict:
    """Port of static/script.js updateStats."""
    vacant = occupied = cleaning = renewals_due = 0
    balances_total = balances_count = 0
    for r in rooms:
        st = r.get("status")
        sc = r.get("service_cleaning") or {}
        if st == "vacant":
            vacant += 1
        elif st == "occupied":
            occupied += 1
            if sc.get("room") or sc.get("bathroom"):
                cleaning += 1
            bal = r.get("balance") or 0
            if bal > 0 and not is_mmt_prepaid(r):
                balances_total += bal
                balances_count += 1
            if r["_renewal"]["due"]:
                renewals_due += 1
        elif st == "cleaning":
            cleaning += 1
    return {"vacant": vacant, "occupied": occupied, "cleaning": cleaning,
            "balances_total": balances_total, "balances_count": balances_count,
            "renewals_due": renewals_due, "total": len(rooms)}


def today_summary(logs: dict) -> dict:
    def live(rows):
        return [x for x in rows or [] if not x.get("voided")]
    cash = sum(int(x.get("amount") or 0) for x in live(logs.get("cash")) if x.get("method") == "cash")
    online = sum(int(x.get("amount") or 0) for x in live(logs.get("online")))
    refunds = sum(int(x.get("amount") or 0) for x in live(logs.get("refunds")))
    exp_rows = logs.get("expenses") or []
    daily_exp = sum(int(x.get("amount") or 0) for x in exp_rows if (x.get("expense_type") or "transaction") == "transaction")
    serials = {(x.get("room"), x.get("serial_number")) for x in live(logs.get("cash")) + live(logs.get("online"))
               if x.get("transaction_type") == "fresh_checkin" or x.get("is_fresh_checkin")}
    return {"cash": cash, "online": online, "refunds": refunds, "expenses": daily_exp,
            "net": cash + online - refunds, "checkins": len(serials),
            "transactions": len(live(logs.get("cash"))) + len(live(logs.get("online")))}


@router.get("/dashboard")
async def dashboard(request: Request, fresh: bool = False, p: Principal = Depends(get_principal)):
    full = p.role != "housekeeping"
    q = {"fresh": "1"} if fresh else None
    calls = [legacy(p, request, "GET", "/get_data", query=q),
             legacy(p, request, "GET", "/settings/ui_config")]
    if full:
        calls.append(legacy(p, request, "GET", "/get_upcoming_bookings"))
    results = await asyncio.gather(*calls)
    data = results[0].json or {}
    if data.get("success") is False:
        return {"success": False, "message": data.get("message", "Could not load rooms")}
    ui = (results[1].json or {}).get("config", {})
    upcoming = ((results[2].json or {}).get("upcoming") or {}) if full else {}

    now_ist = datetime.now(legacy_config.IST).replace(tzinfo=None)
    rooms = []
    for rid in sorted((data.get("rooms") or {}).keys(), key=_room_sort_key):
        doc = dict(data["rooms"][rid])
        doc["id"] = rid
        doc["category"] = legacy_config.room_category(rid)
        doc["_renewal"] = renewal_status(doc, now_ist)
        doc["_mmt_prepaid"] = is_mmt_prepaid(doc)
        rooms.append(doc)

    out = {
        "success": True,
        "server_time": now_ist.strftime("%Y-%m-%d %H:%M:%S"),
        "today": now_ist.strftime("%Y-%m-%d"),
        "rooms": rooms,
        "stats": compute_stats(rooms, now_ist),
        "upcoming": upcoming,
        "ui_config": ui,
    }
    if full:
        out["totals"] = data.get("totals") or {}
        out["today_summary"] = today_summary(data.get("logs") or {})
        out["logs"] = data.get("logs") or {}
    return out
