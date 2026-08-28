"""Per-stay room event timeline.

WHY THIS EXISTS
───────────────
The room-history popover used to read flat ``lastXBy`` / ``xAt`` fields off
the room document. Each of those holds only the MOST RECENT occurrence of
its action, and the room document outlives the stay. A stay that had been
transferred therefore showed a mixture of its own events and other guests':
a cleaning from two months earlier, an inspection belonging to the previous
occupant, and a transfer that belonged to neither.

The audit log holds the correct data, and ``/api/audit-logs/stay-history``
reconstructs a stay from it properly. But that costs a 500-document scan per
room per transfer hop. At this property's read volume that is the wrong
price for opening a popover, so the audit log stays an audit tool and the
timeline is materialised as it happens instead.

Each lifecycle action appends one compact record to ``stay_timeline`` on the
ROOM document. The array is emptied when a room is released at checkout,
accumulates the cleaning and inspection that prep it for the next guest,
carries that guest's check-in, time edits and transfers, and is frozen onto
the bill document at checkout. The register already loads both documents, so
the popover costs no extra reads.

SCOPE RULES
───────────
* One array is one stay plus the prep that preceded it. Nothing from before
  the previous checkout can appear, because the array was emptied there.
* A transfer MOVES the array to the destination room and folds in that
  room's own prep events, so the chain reads "210 cleaned → 222 cleaned →
  checked in → shifted 210 → 222 → checked out", each row naming its room.
* At checkout the array is snapshotted onto the bill and the room's copy is
  reset, so a completed stay's history can never change afterwards.

This module is deliberately storage-only. It decides what a record contains
and how records merge; it does not decide how they are worded. The popover
owns the labels.
"""

import logging

from firebase_admin import firestore

logger = logging.getLogger(__name__)


def _actor_and_now():
    """Current request's user and an IST timestamp.

    Imported lazily rather than at module load: services.audit_log pulls in
    config, which initialises Firebase on import. Deferring it keeps this
    module a pure data helper that can be exercised without a live project,
    and keeps the import graph acyclic. The fallback covers background
    threads and scripts, where there is no request and no flask.g.
    """
    try:
        from services.audit_log import _safe_user, _ist_now_iso
        return (_safe_user() or {}), _ist_now_iso()
    except Exception:
        from datetime import datetime, timedelta, timezone
        ist = timezone(timedelta(hours=5, minutes=30))
        return {}, datetime.now(ist).strftime("%Y-%m-%d %H:%M:%S")

# Hard cap on stored records. A normal stay produces five to fifteen. The cap
# exists so a pathological loop (a room cleaned in a retry storm, a transfer
# bounced back and forth) cannot grow the room document without bound. When
# the cap is hit the OLDEST records are dropped: the recent end of a stay is
# the part an operator is asking about.
TIMELINE_CAP = 60

# Actions that prep a vacant room for its next guest. These are the only
# records allowed to survive a checkout reset, and the only ones folded in
# from a transfer destination.
PREP_ACTIONS = ("room.cleaning.complete", "room.inspection.approve")


def make_event(action, room, *, from_room=None, to_room=None, at=None, **extra):
    """One timeline record, attributed to the current request's user.

    ``byName`` is stored alongside ``by`` on purpose. Accountability wants
    the name as it stood when the action happened, and storing it means the
    popover renders without a users-collection lookup.

    ``extra`` carries whatever a specific action needs the trail to remember
    — old_price / new_price on a tariff correction, for instance — so a row
    can say what changed instead of only that somebody changed something.
    None values are dropped so an absent detail never becomes a stored null
    that the de-duplication key then has to reason about.
    """
    user, now = _actor_and_now()
    ev = {
        "action": action,
        "room":   str(room or ""),
        "by":     user.get("userId") or "system",
        "byName": user.get("name") or user.get("userId") or "system",
        "at":     at or now,
    }
    if from_room:
        ev["from_room"] = str(from_room)
    if to_room:
        ev["to_room"] = str(to_room)
    for k, v in (extra or {}).items():
        if v is not None:
            ev[k] = v
    return ev


def append_op(event):
    """Firestore update value that appends one record with no prior read.

    ArrayUnion is safe here despite its de-duplicating semantics: every
    record carries a timestamp and an actor, so two genuine events are never
    byte-identical, while a retried write of the SAME event collapses to one
    — which is the behaviour we want from a retry.

    The cap is not enforced on this path (it would need a read). It is
    enforced by :func:`merge`, which runs at check-in and at transfer, so the
    array is trimmed at every point it could meaningfully have grown.
    """
    return firestore.ArrayUnion([event])


def read(doc_data):
    """The timeline stored on a room or bill document, always a list."""
    tl = (doc_data or {}).get("stay_timeline")
    return [e for e in tl if isinstance(e, dict)] if isinstance(tl, list) else []


def prep_only(timeline):
    """Just the cleaning/inspection records from a timeline.

    Used when a stay transfers into a room: that room's array holds only the
    prep done for its next guest, which is this guest. Anything else in there
    would be a leftover from an interrupted stay and is dropped rather than
    attributed to somebody who never occupied the room.
    """
    return [e for e in timeline if e.get("action") in PREP_ACTIONS]


def merge(*groups):
    """Combine record groups into one chronological, de-duplicated, capped list.

    Sorted by ``at`` because a transfer folds in the destination room's prep,
    which happened earlier in wall-clock time than the check-in it follows in
    insertion order. Ties keep their relative order, so a clean and an
    inspection recorded in the same second still read in the order they were
    appended.
    """
    out, seen = [], set()
    for g in groups:
        for e in (g or []):
            if not isinstance(e, dict):
                continue
            k = (e.get("action"), e.get("room"), e.get("at"), e.get("by"))
            if k in seen:
                continue
            seen.add(k)
            out.append(e)
    out.sort(key=lambda e: str(e.get("at") or ""))
    return out[-TIMELINE_CAP:]
