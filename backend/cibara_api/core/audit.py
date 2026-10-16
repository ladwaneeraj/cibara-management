"""
Audit logging for the new endpoints.

Writes go through the legacy `services.audit_log.write_log` inside a Flask
request context carrying the acting user, client IP and user agent — so
entries written by the FastAPI layer are field-for-field identical to the ones
the Flask routes write (same `audit_logs` collection, same schema, same
background writer). Bridged legacy routes keep writing their own entries.

New actions introduced by this layer (no schema change, new values only):
  auth.login, auth.login_failed, auth.logout, auth.refresh_denied
"""
from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger("cibara_api.audit")


def write(action: str, *, user: dict | None, client_ip: str = "", user_agent: str = "",
          target_collection: str | None = None, target_id: str | None = None,
          before: Any = None, after: Any = None, metadata: dict | None = None) -> None:
    """Never raises (same contract as the legacy writer)."""
    try:
        from services.audit_log import write_log
        from ..legacy import legacy_context
        headers = {"User-Agent": user_agent, "X-Forwarded-For": client_ip}
        with legacy_context(user, headers=headers, client_ip=client_ip or "127.0.0.1"):
            write_log(action, target_collection=target_collection, target_id=target_id,
                      before=before, after=after, metadata=metadata or {})
    except Exception as e:  # pragma: no cover - defensive
        log.warning("audit write failed for %s: %s", action, e)
