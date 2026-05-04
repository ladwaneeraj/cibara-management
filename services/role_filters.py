"""
Role-based read-time filters.

Manager-role users may view transactions / register / bills only for the
last MANAGER_VISIBLE_DAYS days. Admin sees everything; housekeeping
shouldn't be hitting these endpoints in the first place (their UI hides
the corresponding tabs), but if they do, they get the same window as
manager.

The clamp lives on the backend so it cannot be bypassed by tampering
with the client's date inputs.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Tuple

from flask import g

from config import IST


# Window in days. Tweak here if the policy changes.
MANAGER_VISIBLE_DAYS = 3


def _current_role() -> str:
    user = getattr(g, "current_user", None) or {}
    return user.get("role") or ""


def clamp_date_range(start_date: str, end_date: str) -> Tuple[str, str]:
    """
    For non-admin users, clamp [start_date, end_date] to the last
    MANAGER_VISIBLE_DAYS calendar days (today inclusive).

    Inputs and outputs are "YYYY-MM-DD" strings. If the caller's range
    falls entirely outside the allowed window, the result is empty
    (start > end), which downstream queries treat as an empty result set.

    Admin users get their range unchanged.
    """
    role = _current_role()
    if role == "admin":
        return start_date, end_date

    today_ist = datetime.now(IST).date()
    earliest_allowed = today_ist - timedelta(days=MANAGER_VISIBLE_DAYS - 1)
    latest_allowed = today_ist

    try:
        s = datetime.strptime(start_date, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        s = earliest_allowed
    try:
        e = datetime.strptime(end_date, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        e = latest_allowed

    s = max(s, earliest_allowed)
    e = min(e, latest_allowed)

    return s.strftime("%Y-%m-%d"), e.strftime("%Y-%m-%d")


def visible_window_start() -> str:
    """Earliest date the current user is permitted to read.
    Returns 'YYYY-MM-DD'. For admin returns a far-past sentinel."""
    role = _current_role()
    if role == "admin":
        return "1970-01-01"
    today_ist = datetime.now(IST).date()
    return (today_ist - timedelta(days=MANAGER_VISIBLE_DAYS - 1)).strftime("%Y-%m-%d")
