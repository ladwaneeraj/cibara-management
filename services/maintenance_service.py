"""
Deep-check maintenance service.

A "deep check" is a periodic, room-by-room inspection of every physical
asset in a room (TV, AC, tubelight, kettle, washroom fittings, bucket, …)
that goes beyond the daily housekeeping clean. This module owns the whole
lifecycle: checklist template → inspection rounds → per-room inspections →
issues (defects) → fix → verification — plus the analytics rollups.

Schema (all collections are separate from the live `rooms` docs on purpose:
inspections are historical records and must never mutate operational room
state).

settings/maintenance_checklist            (single doc)
    items: [ { id, label, category, icon, active, order } ]
    updated_at, updated_by

maintenance_rounds                         (one doc per round)
    name          "July 2026 Deep Check"
    status        "open" | "closed"
    created_at    UTC iso          created_by  {userId, name}
    closed_at     UTC iso | None   closed_by   {userId, name} | None

maintenance_inspections                    (doc id = "<round_id>__<room>")
    round_id, room
    inspected_by  {userId, name}
    inspected_at  UTC iso
    items: [ { item_id, label, category, status: "ok"|"issue",
               severity: "low"|"medium"|"high"|None, note } ]
    ok_count, issue_count, score   (0-100, % of items OK)

maintenance_issues                         (one doc per defect)
    round_id       str | None   (None → logged manually, outside a round)
    inspection_id  str | None
    room, item_id, item_label, category
    severity       "low" | "medium" | "high"
    description    str
    status         "open" → "fixed" → "verified"   (reopen → "open")
    source         "inspection" | "manual"
    reported_by/at, fixed_by/at, fix_note, cost (int ₹, optional),
    verified_by/at, reopen_count

Invariants
──────────
* At most ONE round may be "open" at a time.
* One inspection per (round, room); re-submitting replaces the previous
  inspection and re-syncs its auto-created issues: still-open issues from
  the old submission are deleted and recreated from the new results, while
  issues already fixed/verified are kept untouched (they are history).
* Issues only move forward open → fixed → verified, except an explicit
  reopen (verification failed) which returns them to "open".
"""

from __future__ import annotations

import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Optional

from google.cloud.firestore_v1.base_query import FieldFilter

from config import db, IST, logger, get_all_rooms, room_category

# ─── Firestore refs (lambdas so tests can patch `db`) ─────────────────────
_rounds_ref      = lambda: db.collection("maintenance_rounds")
_inspections_ref = lambda: db.collection("maintenance_inspections")
_issues_ref      = lambda: db.collection("maintenance_issues")
_checklist_ref   = lambda: db.collection("settings").document("maintenance_checklist")

ISSUE_STATUSES = ("open", "fixed", "verified")
SEVERITIES = ("low", "medium", "high")
CATEGORIES = ("electrical", "appliances", "washroom", "furniture", "general")


def known_room_categories() -> list[str]:
    """Room-rate categories currently in use, derived from the live rooms via
    config.room_category() (single source of truth for the category map)."""
    return sorted({room_category(r) for r in get_all_rooms().keys()})

def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ist_date() -> str:
    return datetime.now(IST).strftime("%Y-%m-%d")


def _user_stamp(user: Optional[dict]) -> dict:
    user = user or {}
    return {"userId": user.get("userId", "system"), "name": user.get("name", "system")}


# ═══════════════════════════════════════════════════════════════════════════
# Checklist template
# ═══════════════════════════════════════════════════════════════════════════

def get_checklist(include_inactive: bool = False,
                  room: Optional[str] = None) -> list[dict]:
    """Return the checklist items (empty until the admin creates them).

    Items carry `room_categories`: ["all"] or a list of rate-slab slugs
    (see config.room_category). Legacy items without the field are
    normalized to ["all"]. Pass `room` to get only the items that apply
    to that room's category.
    """
    # No auto-seeding: the checklist starts empty and the admin builds it
    # from the Checklist tab.
    snap = _checklist_ref().get()
    items = (snap.to_dict() or {}).get("items", []) if snap.exists else []
    for it in items:
        if not it.get("room_categories"):
            it["room_categories"] = ["all"]
    items = sorted(items, key=lambda x: x.get("order", 0))
    if not include_inactive:
        items = [i for i in items if i.get("active", True)]
    if room is not None:
        cat = room_category(room)
        items = [
            i for i in items
            if "all" in i["room_categories"] or cat in i["room_categories"]
        ]
    return items


def save_checklist(items: list[dict], user: dict) -> list[dict]:
    """Validate + persist the full checklist array (admin only, route-gated)."""
    if not isinstance(items, list):
        raise ValueError("checklist must be a list")
    clean, seen_ids = [], set()
    for i, raw in enumerate(items):
        label = str(raw.get("label", "")).strip()
        if not label:
            raise ValueError(f"item #{i + 1}: label is required")
        item_id = str(raw.get("id") or "").strip() or uuid.uuid4().hex[:8]
        if item_id in seen_ids:
            raise ValueError(f"duplicate item id: {item_id}")
        seen_ids.add(item_id)
        category = raw.get("category", "general")
        if category not in CATEGORIES:
            category = "general"
        allowed_cats = set(known_room_categories()) | {"all", "other"}
        raw_cats = raw.get("room_categories") or ["all"]
        if not isinstance(raw_cats, list):
            raw_cats = ["all"]
        cats = [str(c) for c in raw_cats if str(c) in allowed_cats]
        if not cats or "all" in cats:
            cats = ["all"]
        clean.append({
            "id": item_id,
            "label": label[:80],
            "category": category,
            "icon": str(raw.get("icon", ""))[:8],
            "active": bool(raw.get("active", True)),
            "order": i,
            "room_categories": cats,
        })
    _checklist_ref().set({
        "items": clean,
        "updated_at": _now_utc(),
        "updated_by": _user_stamp(user),
    })
    return clean


# ═══════════════════════════════════════════════════════════════════════════
# Rounds
# ═══════════════════════════════════════════════════════════════════════════

def get_open_round() -> Optional[dict]:
    docs = list(
        _rounds_ref().where(filter=FieldFilter("status", "==", "open")).limit(2).stream()
    )
    if not docs:
        return None
    if len(docs) > 1:
        # Should never happen; log loudly but return the oldest.
        logger.error("maintenance: %d open rounds found — invariant broken", len(docs))
        docs.sort(key=lambda d: (d.to_dict() or {}).get("created_at", ""))
    d = docs[0]
    return {**(d.to_dict() or {}), "id": d.id}


def start_round(name: str, user: dict) -> dict:
    if get_open_round():
        raise ValueError("A round is already open. Close it before starting a new one.")
    name = (name or "").strip() or f"Deep Check {_ist_date()}"
    doc = {
        "name": name[:80],
        "status": "open",
        "created_at": _now_utc(),
        "created_by": _user_stamp(user),
        "closed_at": None,
        "closed_by": None,
    }
    ref = _rounds_ref().document()
    ref.set(doc)
    return {**doc, "id": ref.id}


def close_round(round_id: str, user: dict) -> dict:
    ref = _rounds_ref().document(round_id)
    snap = ref.get()
    if not snap.exists:
        raise ValueError("Round not found")
    data = snap.to_dict() or {}
    if data.get("status") != "open":
        raise ValueError("Round is already closed")
    patch = {"status": "closed", "closed_at": _now_utc(), "closed_by": _user_stamp(user)}
    ref.update(patch)
    return {**data, **patch, "id": round_id}


def list_rounds(limit: int = 12) -> list[dict]:
    """Recent rounds with coverage counts (newest first)."""
    docs = list(_rounds_ref().stream())
    rounds = [{**(d.to_dict() or {}), "id": d.id} for d in docs]
    rounds.sort(key=lambda r: r.get("created_at", ""), reverse=True)
    rounds = rounds[:limit]
    total_rooms = len(get_all_rooms())
    # One stream over all inspections instead of a query per round (N+1).
    by_round: dict[str, list[dict]] = {}
    for d in _inspections_ref().stream():
        data = d.to_dict() or {}
        by_round.setdefault(data.get("round_id"), []).append(data)
    for r in rounds:
        insp = by_round.get(r["id"], [])
        r["rooms_inspected"] = len(insp)
        r["rooms_total"] = total_rooms
        r["issues_found"] = sum(i.get("issue_count", 0) for i in insp)
    return rounds


def round_status(round_id: str, rnd: Optional[dict] = None) -> dict:
    """Per-room coverage for one round + rollup counters (dashboard payload).

    Pass `rnd` (an already-fetched round dict) to skip the extra doc read.
    The two collection queries run in parallel — Firestore latency, not
    compute, dominates this endpoint.
    """
    if rnd is None:
        snap = _rounds_ref().document(round_id).get()
        if not snap.exists:
            raise ValueError("Round not found")
        rnd = {**(snap.to_dict() or {}), "id": round_id}

    def _fetch_inspections():
        return [
            (d.to_dict() or {})
            for d in _inspections_ref()
            .where(filter=FieldFilter("round_id", "==", round_id))
            .stream()
        ]

    def _fetch_open_issues():
        return [
            (d.to_dict() or {})
            for d in _issues_ref()
            .where(filter=FieldFilter("status", "in", ["open", "fixed"]))
            .stream()
        ]

    with ThreadPoolExecutor(max_workers=2) as ex:
        f_ins = ex.submit(_fetch_inspections)
        f_iss = ex.submit(_fetch_open_issues)
        ins_list = f_ins.result()
        iss_list = f_iss.result()

    inspections = {}
    for data in ins_list:
        inspections[data.get("room")] = data

    open_by_room: dict[str, dict] = {}
    for iss in iss_list:
        room = iss.get("room")
        agg = open_by_room.setdefault(room, {"open": 0, "fixed": 0, "high": 0})
        agg[iss.get("status", "open")] = agg.get(iss.get("status", "open"), 0) + 1
        if iss.get("severity") == "high" and iss.get("status") == "open":
            agg["high"] += 1

    rooms_payload = []
    for room in sorted(get_all_rooms().keys(), key=lambda r: (len(r), r)):
        ins = inspections.get(room)
        agg = open_by_room.get(room, {})
        rooms_payload.append({
            "room": room,
            "category": room_category(room),
            "inspected": ins is not None,
            "inspected_at": (ins or {}).get("inspected_at"),
            "inspected_by": ((ins or {}).get("inspected_by") or {}).get("name"),
            "score": (ins or {}).get("score"),
            "issue_count": (ins or {}).get("issue_count", 0),
            "open_issues": agg.get("open", 0),
            "awaiting_verify": agg.get("fixed", 0),
            "high_open": agg.get("high", 0),
        })

    done = sum(1 for r in rooms_payload if r["inspected"])
    return {
        "round": rnd,
        "rooms": rooms_payload,
        "coverage": {"inspected": done, "total": len(rooms_payload)},
    }


# ═══════════════════════════════════════════════════════════════════════════
# Inspections
# ═══════════════════════════════════════════════════════════════════════════

def _inspection_doc_id(round_id: str, room: str) -> str:
    return f"{round_id}__{room}"


def get_inspection(round_id: str, room: str) -> Optional[dict]:
    snap = _inspections_ref().document(_inspection_doc_id(round_id, room)).get()
    if not snap.exists:
        return None
    return {**(snap.to_dict() or {}), "id": snap.id}


def submit_inspection(round_id: str, room: str, results: list[dict], user: dict) -> dict:
    """
    Persist one room's deep-check. `results` items:
        { item_id, status: "ok"|"issue", severity?, note? }
    Auto-creates one maintenance_issue per failed item. Re-submission
    replaces the inspection and re-syncs its still-open auto-issues.
    """
    rnd = _rounds_ref().document(round_id).get()
    if not rnd.exists or (rnd.to_dict() or {}).get("status") != "open":
        raise ValueError("Round is not open")
    if room not in get_all_rooms():
        raise ValueError(f"Unknown room: {room}")

    template = {t["id"]: t for t in get_checklist(include_inactive=True)}
    room_cat = room_category(room)
    clean_items, issues_to_create = [], []
    for raw in results or []:
        item_id = str(raw.get("item_id", ""))
        tpl = template.get(item_id)
        if not tpl:
            raise ValueError(f"Unknown checklist item: {item_id!r}")
        tpl_cats = tpl.get("room_categories") or ["all"]
        if "all" not in tpl_cats and room_cat not in tpl_cats:
            raise ValueError(
                f"{tpl['label']} does not apply to room {room} ({room_cat})"
            )
        status = raw.get("status")
        if status not in ("ok", "issue"):
            raise ValueError(f"{tpl['label']}: status must be 'ok' or 'issue'")
        severity = raw.get("severity") if status == "issue" else None
        if status == "issue" and severity not in SEVERITIES:
            severity = "medium"
        note = str(raw.get("note", "")).strip()[:300]
        entry = {
            "item_id": item_id,
            "label": tpl["label"],
            "category": tpl.get("category", "general"),
            "status": status,
            "severity": severity,
            "note": note,
        }
        clean_items.append(entry)
        if status == "issue":
            issues_to_create.append(entry)

    if not clean_items:
        raise ValueError("Inspection has no items")

    ok_count = sum(1 for i in clean_items if i["status"] == "ok")
    issue_count = len(clean_items) - ok_count
    doc_id = _inspection_doc_id(round_id, room)
    now = _now_utc()
    inspection = {
        "round_id": round_id,
        "room": room,
        "inspected_by": _user_stamp(user),
        "inspected_at": now,
        "items": clean_items,
        "ok_count": ok_count,
        "issue_count": issue_count,
        "score": round(100 * ok_count / len(clean_items)),
    }

    # Re-sync auto-issues: drop still-open ones from a previous submission
    # of this same inspection (fixed/verified are history — keep them).
    stale = (
        _issues_ref()
        .where(filter=FieldFilter("inspection_id", "==", doc_id))
        .where(filter=FieldFilter("status", "==", "open"))
        .stream()
    )
    batch = db.batch()
    for d in stale:
        batch.delete(d.reference)
    batch.set(_inspections_ref().document(doc_id), inspection)
    for entry in issues_to_create:
        ref = _issues_ref().document()
        batch.set(ref, {
            "round_id": round_id,
            "inspection_id": doc_id,
            "room": room,
            "item_id": entry["item_id"],
            "item_label": entry["label"],
            "category": entry["category"],
            "severity": entry["severity"],
            "description": entry["note"],
            "status": "open",
            "source": "inspection",
            "reported_by": _user_stamp(user),
            "reported_at": now,
            "fixed_by": None, "fixed_at": None, "fix_note": "", "cost": None,
            "verified_by": None, "verified_at": None,
            "reopen_count": 0,
        })
    batch.commit()
    return {**inspection, "id": doc_id, "issues_created": len(issues_to_create)}


# ═══════════════════════════════════════════════════════════════════════════
# Issues
# ═══════════════════════════════════════════════════════════════════════════

def list_issues(status: Optional[str] = None, room: Optional[str] = None,
                round_id: Optional[str] = None, limit: int = 300) -> list[dict]:
    q = _issues_ref()
    # Single-field filters only (no composite indexes needed); the rest is
    # filtered/sorted in Python — collections here are small (hundreds).
    if status in ISSUE_STATUSES:
        q = q.where(filter=FieldFilter("status", "==", status))
    elif room:
        q = q.where(filter=FieldFilter("room", "==", room))
    elif round_id:
        q = q.where(filter=FieldFilter("round_id", "==", round_id))
    issues = [{**(d.to_dict() or {}), "id": d.id} for d in q.stream()]
    if status in ISSUE_STATUSES:
        if room:
            issues = [i for i in issues if i.get("room") == room]
        if round_id:
            issues = [i for i in issues if i.get("round_id") == round_id]
    _sev_rank = {"high": 0, "medium": 1, "low": 2}
    issues.sort(key=lambda i: (_sev_rank.get(i.get("severity"), 3),
                               i.get("reported_at", "")), reverse=False)
    return issues[:limit]


def create_manual_issue(room: str, item_label: str, severity: str,
                        description: str, user: dict,
                        category: str = "general") -> dict:
    if room not in get_all_rooms():
        raise ValueError(f"Unknown room: {room}")
    item_label = (item_label or "").strip()
    if not item_label:
        raise ValueError("What is broken? (item label required)")
    if severity not in SEVERITIES:
        severity = "medium"
    if category not in CATEGORIES:
        category = "general"
    doc = {
        "round_id": None, "inspection_id": None,
        "room": room, "item_id": None,
        "item_label": item_label[:80],
        "category": category,
        "severity": severity,
        "description": (description or "").strip()[:300],
        "status": "open", "source": "manual",
        "reported_by": _user_stamp(user), "reported_at": _now_utc(),
        "fixed_by": None, "fixed_at": None, "fix_note": "", "cost": None,
        "verified_by": None, "verified_at": None,
        "reopen_count": 0,
    }
    ref = _issues_ref().document()
    ref.set(doc)
    return {**doc, "id": ref.id}


def _get_issue_or_raise(issue_id: str):
    ref = _issues_ref().document(issue_id)
    snap = ref.get()
    if not snap.exists:
        raise ValueError("Issue not found")
    return ref, (snap.to_dict() or {})


def fix_issue(issue_id: str, note: str, cost, user: dict) -> dict:
    ref, data = _get_issue_or_raise(issue_id)
    if data.get("status") != "open":
        raise ValueError(f"Only open issues can be fixed (status={data.get('status')})")
    cost_val = None
    if cost not in (None, ""):
        try:
            cost_val = max(0, int(cost))
        except (TypeError, ValueError):
            raise ValueError("Cost must be a whole number (₹)")
    patch = {
        "status": "fixed",
        "fixed_by": _user_stamp(user),
        "fixed_at": _now_utc(),
        "fix_note": (note or "").strip()[:300],
        "cost": cost_val,
    }
    ref.update(patch)
    return {**data, **patch, "id": issue_id}


def verify_issue(issue_id: str, user: dict) -> dict:
    ref, data = _get_issue_or_raise(issue_id)
    if data.get("status") != "fixed":
        raise ValueError("Only fixed issues can be verified")
    patch = {"status": "verified", "verified_by": _user_stamp(user),
             "verified_at": _now_utc()}
    ref.update(patch)
    return {**data, **patch, "id": issue_id}


def reopen_issue(issue_id: str, reason: str, user: dict) -> dict:
    ref, data = _get_issue_or_raise(issue_id)
    if data.get("status") not in ("fixed", "verified"):
        raise ValueError("Only fixed/verified issues can be reopened")
    note = (reason or "").strip()[:300]
    patch = {
        "status": "open",
        "reopen_count": int(data.get("reopen_count", 0)) + 1,
        "fixed_by": None, "fixed_at": None,
        "verified_by": None, "verified_at": None,
        "description": (data.get("description", "") +
                        (f"\n[reopened] {note}" if note else "\n[reopened]")).strip()[:600],
    }
    ref.update(patch)
    return {**data, **patch, "id": issue_id}


def delete_issue(issue_id: str) -> dict:
    ref, data = _get_issue_or_raise(issue_id)
    ref.delete()
    return {**data, "id": issue_id}


# ═══════════════════════════════════════════════════════════════════════════
# Analytics
# ═══════════════════════════════════════════════════════════════════════════

def _hours_between(a: Optional[str], b: Optional[str]) -> Optional[float]:
    try:
        return (datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds() / 3600.0
    except (TypeError, ValueError):
        return None


def analytics() -> dict:
    """
    Full-collection rollup. Fine at lodge scale (≤ a few thousand docs);
    revisit with aggregation queries if the collections ever grow large.
    """
    issues = [{**(d.to_dict() or {}), "id": d.id} for d in _issues_ref().stream()]
    inspections = [(d.to_dict() or {}) for d in _inspections_ref().stream()]

    # Per-room rollup
    rooms: dict[str, dict] = {}
    for room in get_all_rooms().keys():
        rooms[room] = {"room": room, "open": 0, "fixed": 0, "verified": 0,
                       "high_open": 0, "total_issues": 0, "cost": 0,
                       "last_score": None, "last_inspected_at": None}
    for iss in issues:
        r = rooms.get(iss.get("room"))
        if r is None:
            continue  # room deleted since
        st = iss.get("status", "open")
        r[st] = r.get(st, 0) + 1
        r["total_issues"] += 1
        if st == "open" and iss.get("severity") == "high":
            r["high_open"] += 1
        if isinstance(iss.get("cost"), int):
            r["cost"] += iss["cost"]
    for ins in inspections:
        r = rooms.get(ins.get("room"))
        if r is None:
            continue
        at = ins.get("inspected_at") or ""
        if at > (r["last_inspected_at"] or ""):
            r["last_inspected_at"] = at
            r["last_score"] = ins.get("score")

    # Item failure leaderboard + category breakdown
    item_fail: dict[str, dict] = {}
    cat_fail: dict[str, int] = {}
    for iss in issues:
        key = iss.get("item_label", "Other")
        agg = item_fail.setdefault(key, {"label": key, "count": 0, "open": 0})
        agg["count"] += 1
        if iss.get("status") == "open":
            agg["open"] += 1
        cat = iss.get("category", "general")
        cat_fail[cat] = cat_fail.get(cat, 0) + 1
    top_items = sorted(item_fail.values(), key=lambda x: -x["count"])[:10]

    # Resolution time (reported → fixed) over resolved issues
    durations = [
        h for h in (
            _hours_between(i.get("reported_at"), i.get("fixed_at"))
            for i in issues if i.get("status") in ("fixed", "verified")
        ) if h is not None and h >= 0
    ]
    avg_fix_hours = round(sum(durations) / len(durations), 1) if durations else None

    counts = {s: sum(1 for i in issues if i.get("status") == s) for s in ISSUE_STATUSES}
    total_cost = sum(i["cost"] for i in issues if isinstance(i.get("cost"), int))

    room_list = sorted(rooms.values(), key=lambda r: (-r["high_open"], -r["open"], r["room"]))
    return {
        "counts": counts,
        "avg_fix_hours": avg_fix_hours,
        "total_cost": total_cost,
        "rooms": room_list,
        "top_failing_items": top_items,
        "category_breakdown": cat_fail,
        "total_inspections": len(inspections),
    }
