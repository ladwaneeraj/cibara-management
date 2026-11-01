"""
Room / category blocks.

A block removes a room, or a whole category's pool, from sale for a time
range (maintenance, owner use). It is counted as occupied by the shared
availability function and honoured by staff availability.

Collection ``blocks`` (doc id = random hex):
    scope       "room" | "category"
    room        str   (scope == "room")      e.g. "201"
    category    str   (scope == "category")  key of config.CATEGORY_POOLS
    start       ISO-8601, IST offset
    end         ISO-8601 | None   (None = open-ended: blocks from start onward)
    reason      str
    created_by  str   userId
    created_at  ISO-8601, IST offset

All datetimes are IST-aware. Naive inputs are interpreted as IST; ISO strings
are parsed to aware datetimes before any comparison.

Blocks are few (a handful live at once), so the collection is streamed and
filtered in Python — no composite index needed.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional, Union

import config

_COLLECTION = "blocks"
SCOPES = ("room", "category")

DT = Union[datetime, str]


def _coll():
    return config.db.collection(_COLLECTION)


def _aware(value: DT) -> datetime:
    """datetime | ISO string -> IST-aware datetime (naive is taken as IST)."""
    if isinstance(value, str):
        value = datetime.fromisoformat(value.strip())
    if value.tzinfo is None:
        return config.IST.localize(value)
    return value.astimezone(config.IST)


def _now(now: Optional[DT]) -> datetime:
    return _aware(now) if now is not None else datetime.now(config.IST)


def create_block(scope: str, *, room: Optional[str] = None, category: Optional[str] = None,
                 start: DT, end: Optional[DT] = None, reason: str, created_by: str) -> str:
    """Create a block and return its id. Raises ValueError on bad input."""
    if scope not in SCOPES:
        raise ValueError(f"scope must be one of {SCOPES}")
    doc = {"scope": scope}
    if scope == "room":
        room = str(room or "").strip()
        if not room:
            raise ValueError("room is required for a room block")
        doc["room"] = room
    else:
        category = str(category or "").strip()
        if category not in config.CATEGORY_POOLS:
            raise ValueError(f"category must be one of {sorted(config.CATEGORY_POOLS)}")
        doc["category"] = category

    start_dt = _aware(start)
    end_dt = _aware(end) if end not in (None, "") else None
    if end_dt is not None and end_dt <= start_dt:
        raise ValueError("end must be after start")

    doc.update({
        "start": start_dt.isoformat(),
        "end": end_dt.isoformat() if end_dt else None,
        "reason": str(reason or "").strip(),
        "created_by": created_by or "system",
        "created_at": datetime.now(config.IST).isoformat(),
    })
    block_id = uuid.uuid4().hex
    _coll().document(block_id).set(doc)
    return block_id


def _all():
    return [{**d.to_dict(), "id": d.id} for d in _coll().stream()]


def _is_over(block: dict, now: datetime) -> bool:
    return bool(block.get("end")) and _aware(block["end"]) <= now


def list_blocks(now: Optional[DT] = None) -> list:
    """Blocks that are current or upcoming (not yet ended), soonest first."""
    now_dt = _now(now)
    live = [b for b in _all() if not _is_over(b, now_dt)]
    live.sort(key=lambda b: (_aware(b["start"]), b["id"]))
    return live


def delete_block(block_id: str) -> bool:
    """Delete a block. Returns False if it did not exist."""
    ref = _coll().document(block_id)
    if not ref.get().exists:
        return False
    ref.delete()
    return True


def _rooms_of(block: dict) -> list:
    """Concrete room numbers a block covers (category -> its pool)."""
    if block.get("scope") == "category":
        return list(config.CATEGORY_POOLS.get(block.get("category"), []))
    return [str(block["room"])] if block.get("room") else []


def _overlaps(block: dict, ws: datetime, we: datetime) -> bool:
    """Block [start, end) overlaps window [ws, we]; end=None is open-ended."""
    start = _aware(block["start"])
    end = _aware(block["end"]) if block.get("end") else None
    return start <= we and (end is None or end > ws)


def active_blocked_rooms(window_start: DT, window_end: DT, *, now: Optional[DT] = None) -> set:
    """Concrete room numbers blocked at any point overlapping the window.

    ``scope == "category"`` expands to ``config.CATEGORY_POOLS[category]``.
    A block with ``end=None`` is open-ended (blocks from ``start`` onward).
    ``now`` is accepted for signature parity with list_blocks; a block that
    overlaps the window counts whether or not it has "started" yet.
    """
    ws, we = _aware(window_start), _aware(window_end)
    blocked: set = set()
    for b in _all():
        if _overlaps(b, ws, we):
            blocked.update(_rooms_of(b))
    return blocked


def blocked_now_map(now: Optional[DT] = None) -> dict:
    """{room number: block id} for blocks in force at ``now`` (for the grid)."""
    at = _now(now)
    out: dict = {}
    for b in _all():
        if _overlaps(b, at, at):
            for r in _rooms_of(b):
                out.setdefault(r, b["id"])
    return out
