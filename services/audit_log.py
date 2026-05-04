"""
Append-only audit log.

Every sensitive mutation in the app calls  write_log(...)  after the
write succeeds. Logs land in the Firestore  audit_logs  collection.

Design notes
────────────
• Append-only by convention here, enforced by Firestore Security Rules
  (no update / delete from any client).
• Failures inside write_log MUST NOT break the calling request — we
  swallow & log so a logging blip never blocks a checkout.
• "before" / "after" snapshots should hold ONLY the changed fields,
  not the whole document. Caller's responsibility.
• Collection name "audit_logs" (not "logs") to avoid clashing with the
  pre-existing `logs` collection used for transaction entries by the
  legacy ledger system.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from flask import g, request
from firebase_admin import firestore

from config import db, logger, IST


AUDIT_COLLECTION = "audit_logs"


def _ist_now_iso() -> str:
    return datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")


def _client_ip() -> Optional[str]:
    # Trust X-Forwarded-For when behind a proxy (gunicorn / nginx)
    fwd = request.headers.get("X-Forwarded-For", "")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.remote_addr


def write_log(
    action: str,
    *,
    target_collection: Optional[str] = None,
    target_id: Optional[str] = None,
    before: Any = None,
    after: Any = None,
    metadata: Optional[dict] = None,
) -> None:
    """
    Persist one audit entry. Never raises — logs internally on failure.

    Parameters
    ----------
    action : short machine-readable event key, e.g. "discount.apply".
             Use the same vocabulary as services.permissions PERMISSIONS
             where possible.
    target_collection / target_id : what got changed.
    before / after : optional partial snapshots — keep them small.
    metadata : free-form context (reason, amount, notes, …).
    """
    try:
        user = getattr(g, "current_user", None) or {}
        entry = {
            "timestamp": _ist_now_iso(),
            "server_ts": firestore.SERVER_TIMESTAMP,
            "userId": user.get("userId") or "system",
            "userName": user.get("name") or user.get("userId") or "system",
            "userRole": user.get("role") or "system",
            "action": action,
            "targetCollection": target_collection,
            "targetId": target_id,
            "before": before,
            "after": after,
            "metadata": metadata or {},
            "ipAddress": _client_ip() if request else None,
            "userAgent": (request.headers.get("User-Agent") if request else None),
        }
        db.collection(AUDIT_COLLECTION).add(entry)
    except Exception as e:
        # Never let audit failures break the caller.
        logger.warning(f"audit_log.write_log failed for action={action!r}: {e}")


# ─── Helpers for the ubiquitous "who touched this doc" pattern ────────────
def attribution_create() -> dict:
    """
    Returns  {createdBy, createdAt, lastModifiedBy, lastModifiedAt}  to
    merge into a new document. Pulls user from flask.g.
    """
    user = getattr(g, "current_user", None) or {}
    uid = user.get("userId") or "system"
    now = _ist_now_iso()
    return {
        "createdBy": uid,
        "createdAt": now,
        "lastModifiedBy": uid,
        "lastModifiedAt": now,
    }


def attribution_update() -> dict:
    """Returns just the lastModified fields for an update."""
    user = getattr(g, "current_user", None) or {}
    return {
        "lastModifiedBy": user.get("userId") or "system",
        "lastModifiedAt": _ist_now_iso(),
    }
