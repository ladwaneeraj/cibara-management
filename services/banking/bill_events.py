"""
Append-only audit log for bill / stay state transitions.

Why a separate collection
-------------------------
The existing `audit_logs` collection captures user-facing actions
(checkin, checkout, discount, GST edit). Bill-state transitions in the
Banking flow are more granular — many fire from server-side trigger
logic with no direct user input — and their volume and shape don't fit
the schema there. Keeping them separate also makes "explain the history
of this bill" queryable in a single collection without filter gymnastics.

Each event is written ONCE, never updated, never deleted. Firestore
Security Rules will be tightened to enforce this at the platform level;
in the meantime the convention is documented and the writer never
exposes an update path.

Doc shape
---------
    stay_id           : str   — FK into bills collection
    event_type        : str   — BillEventType enum
    occurred_at       : str   — IST ISO8601
    actor_user_id     : str   — flask.g.current_user or "system"
    actor_role        : str
    payload           : dict  — event-specific data; small (< 4kB recommended)
    correlation_id    : str   — optional, ties multiple events together
                                (e.g. a single trigger fan-out)
"""

from __future__ import annotations

import logging
import threading
import uuid
from datetime import datetime
from typing import Optional, Any

from firebase_admin import firestore as fa_firestore

from config import IST
from .schema import COL_BILL_EVENTS, BillEventType

# Flask is optional at import time. We only need it inside _safe_actor
# to read the current request's user; outside a request (migrations,
# scheduled jobs, tests that don't stub flask) we fall back to "system".
try:
    from flask import g, has_request_context  # type: ignore
except ImportError:  # pragma: no cover
    g = None
    def has_request_context() -> bool:  # type: ignore
        return False

logger = logging.getLogger(__name__)


_db = None
_events_ref = None


def init(db) -> None:
    """Bind the Firestore client. Idempotent."""
    global _db, _events_ref
    _db = db
    _events_ref = db.collection(COL_BILL_EVENTS)
    logger.info("Banking.bill_events initialised")


# ───────────────────────── Actor lookup ──────────────────────────────

def _safe_actor() -> tuple[str, str]:
    """Returns (user_id, role) — falls back to ('system','system')."""
    if not has_request_context():
        return ("system", "system")
    try:
        user = getattr(g, "current_user", None) or {}
        return (user.get("userId") or "system",
                user.get("role") or "system")
    except Exception:
        return ("system", "system")


# ───────────────────────── Write ─────────────────────────────────────

def record(
    stay_id: str,
    event_type: str,
    *,
    payload: Optional[dict] = None,
    correlation_id: Optional[str] = None,
    txn: Any = None,
    batch: Any = None,
    sync: bool = False,
) -> Optional[str]:
    """
    Append one bill_events row.

    Parameters
    ----------
    stay_id : str
        Required. The bill this event belongs to.
    event_type : str
        Must be a member of BillEventType.ALL.
    payload : dict, optional
        Small event-specific blob. Keep under a few kB.
    correlation_id : str, optional
        Use the same value across multiple events that belong to one
        logical operation (e.g. a single trigger fan-out writes one
        TRIGGER_FIRED + N RECEIPT_ISSUED + 1 DEPOSIT_LINKED, all sharing
        a correlation_id so they can be retrieved as a group).
    txn / batch
        Optional Firestore transaction or batch to enrol the write in.
        Mutually exclusive. Caller commits.
    sync : bool
        If True and no txn/batch, the write blocks. Default False —
        fire-and-forget on a daemon thread, same as audit_log.

    Returns
    -------
    str | None
        The new event doc ID, or None if the write was dispatched async
        or failed. A return of None is not an error signal — it just
        means the ID isn't available yet.

    This function NEVER raises. Bill-event writes failing must not
    cascade into the calling business operation.
    """
    if _events_ref is None:
        logger.error("Banking.bill_events.record called before init()")
        return None
    if not stay_id or not isinstance(stay_id, str):
        logger.error(f"bill_events.record: invalid stay_id {stay_id!r}")
        return None
    if event_type not in BillEventType.ALL:
        logger.error(f"bill_events.record: unknown event_type {event_type!r}")
        return None
    if txn is not None and batch is not None:
        logger.error("bill_events.record: txn and batch are mutually exclusive")
        return None

    actor_id, actor_role = _safe_actor()
    doc = {
        "stay_id":        stay_id,
        "event_type":     event_type,
        "occurred_at":    datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
        "server_ts":      fa_firestore.SERVER_TIMESTAMP,
        "actor_user_id":  actor_id,
        "actor_role":     actor_role,
        "payload":        payload or {},
        "correlation_id": correlation_id or "",
    }

    try:
        if txn is not None:
            new_ref = _events_ref.document()
            txn.set(new_ref, doc)
            return new_ref.id
        if batch is not None:
            new_ref = _events_ref.document()
            batch.set(new_ref, doc)
            return new_ref.id
        if sync:
            _, new_ref = _events_ref.add(doc)
            return new_ref.id
        # Async — never block the caller. The doc ID is not returned
        # because it's not known synchronously.
        threading.Thread(
            target=_async_write, args=(doc,), daemon=True
        ).start()
        return None
    except Exception as e:
        logger.warning(
            f"bill_events.record({stay_id}, {event_type}) failed: {e}"
        )
        return None


def _async_write(doc: dict) -> None:
    try:
        _events_ref.add(doc)
    except Exception as e:
        logger.warning(f"bill_events async write failed: {e}")


# ───────────────────────── Read ──────────────────────────────────────

def list_for_stay(stay_id: str, *, limit: int = 200) -> list[dict]:
    """
    Return events for a single stay, newest first.
    Returns [] on error or unknown stay.
    """
    if _events_ref is None or not stay_id:
        return []
    try:
        q = (
            _events_ref
            .where(filter=fa_firestore.FieldFilter("stay_id", "==", stay_id))
            .order_by("occurred_at", direction=fa_firestore.Query.DESCENDING)
            .limit(limit)
        )
        out = []
        for snap in q.stream():
            d = snap.to_dict() or {}
            d["id"] = snap.id
            out.append(d)
        return out
    except Exception as e:
        logger.warning(f"bill_events.list_for_stay({stay_id}) failed: {e}")
        return []


def list_by_correlation(correlation_id: str, *, limit: int = 500) -> list[dict]:
    """All events sharing a correlation_id, oldest first."""
    if _events_ref is None or not correlation_id:
        return []
    try:
        q = (
            _events_ref
            .where(filter=fa_firestore.FieldFilter(
                "correlation_id", "==", correlation_id))
            .order_by("occurred_at")
            .limit(limit)
        )
        return [dict(snap.to_dict() or {}, id=snap.id) for snap in q.stream()]
    except Exception as e:
        logger.warning(
            f"bill_events.list_by_correlation({correlation_id}) failed: {e}"
        )
        return []


# --- Helpers -----------------------------------------------------------

def new_correlation_id() -> str:
    """Mint a fresh correlation ID. Use one per logical operation."""
    return uuid.uuid4().hex
