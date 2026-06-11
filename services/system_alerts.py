"""
System alerts — persistent, admin-visible operational alerts.

Purpose: events that MUST reach the admin even if nobody is watching the
logs (e.g. a checkout blocked because the bill could not be created, or a
sequential number consumed without a document behind it). Cloud Run logs
rotate away; these documents do not.

Collection: system_alerts/{auto-id}
    kind         str   — machine key, e.g. "bill.create.blocked"
    severity     str   — "critical" | "warning"
    message      str   — human-readable, shown verbatim in the admin UI
    context      dict  — structured details (room, stay_id, bill_number, ...)
    created_at   str   — "YYYY-MM-DD HH:MM:SS" IST
    resolved     bool
    resolved_by  str | None
    resolved_at  str | None

Design notes:
  * Writers must NEVER let alert persistence break the calling flow — a
    failed alert write degrades to an ERROR log, nothing else.
  * No init(db) dance: config is imported lazily inside each function to
    avoid a circular import (config imports other services at module load).
"""

from __future__ import annotations

import logging
from datetime import datetime

logger = logging.getLogger(__name__)

VALID_SEVERITIES = ("critical", "warning")


def _col():
    from config import db  # lazy — avoids circular import with config.py
    return db.collection("system_alerts")


def _now_ist() -> str:
    from config import IST
    return datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")


def record_alert(kind: str, message: str, *,
                 severity: str = "critical",
                 context: dict | None = None) -> str | None:
    """
    Persist an alert. Returns the alert doc id, or None if the write failed.
    Never raises — alerting must not break the flow that triggered it.
    """
    if severity not in VALID_SEVERITIES:
        severity = "critical"
    try:
        doc = {
            "kind":        str(kind),
            "severity":    severity,
            "message":     str(message),
            "context":     dict(context or {}),
            "created_at":  _now_ist(),
            "resolved":    False,
            "resolved_by": None,
            "resolved_at": None,
        }
        ref = _col().document()
        ref.set(doc)
        logger.error(f"[ALERT:{severity}] {kind}: {message} (id={ref.id})")
        return ref.id
    except Exception as e:  # noqa: BLE001 — deliberate catch-all, see docstring
        logger.error(f"system_alerts.record_alert FAILED for {kind!r}: {e}",
                     exc_info=True)
        return None


def list_alerts(*, unresolved_only: bool = True, limit: int = 50) -> list[dict]:
    """Newest first. Read-only."""
    try:
        q = _col()
        if unresolved_only:
            q = q.where("resolved", "==", False)
        rows = []
        for snap in q.stream():
            d = snap.to_dict() or {}
            d["id"] = snap.id
            rows.append(d)
        rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
        return rows[: max(1, int(limit))]
    except Exception as e:  # noqa: BLE001
        logger.error(f"system_alerts.list_alerts failed: {e}", exc_info=True)
        return []


def resolve_alert(alert_id: str, actor: str) -> bool:
    """Mark an alert resolved. Returns False if it doesn't exist / write fails."""
    if not alert_id:
        return False
    try:
        ref = _col().document(alert_id)
        if not ref.get().exists:
            return False
        ref.update({
            "resolved":    True,
            "resolved_by": str(actor or "unknown"),
            "resolved_at": _now_ist(),
        })
        return True
    except Exception as e:  # noqa: BLE001
        logger.error(f"system_alerts.resolve_alert({alert_id}) failed: {e}",
                     exc_info=True)
        return False


def unresolved_count() -> int:
    """Cheap badge count for the UI. Returns 0 on failure (fail quiet)."""
    try:
        return sum(1 for _ in _col().where("resolved", "==", False).stream())
    except Exception:  # noqa: BLE001
        return 0
