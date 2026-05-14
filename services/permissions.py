"""
Single source of truth for the role → permission map.

The frontend mirrors this file in  static/permissions.js  — keep them
in sync. A frontend-only check is UX; the backend check (via the
@requires_permission decorator) is the actual security boundary.

Roles
─────
admin         Full access. Wildcard "*".
manager       Day-to-day operations: bookings, rooms, customers, basic
              billing. Cannot view analytics, apply discounts, edit
              payments, revert checkouts, change settings, edit laundry
              prices, use settle-later, view full transaction history,
              or view masked revenue figures. Cannot manage users.
housekeeping  Sees only the Rooms tab, only rooms tagged for cleaning,
              only the "Mark as Clean" action.
"""

from __future__ import annotations

from typing import FrozenSet, Iterable

# ─── Role identifiers ─────────────────────────────────────────────────────
ROLE_ADMIN = "admin"
ROLE_MANAGER = "manager"
ROLE_HOUSEKEEPING = "housekeeping"

ROLES = frozenset({ROLE_ADMIN, ROLE_MANAGER, ROLE_HOUSEKEEPING})


# ─── Permission keys ──────────────────────────────────────────────────────
# Convention: <module>.<action>.  Keep them flat — no hierarchies — so the
# map stays grep-able. A new key here MUST be mirrored in
# static/permissions.js.
PERMISSIONS = frozenset(
    {
        # App access
        "app.access",
        # Analytics / reports / revenue
        "analytics.view",
        "revenue.view",
        # Discounts / payments
        "discount.apply",
        "payment.edit",
        # Bill — GST recipient details (B2B GSTIN/legal name) editing
        # and Section 34 credit-note issuance. Admin-only by default.
        "bill.gst.edit",
        "credit_note.issue",
        # Bookings
        "booking.create",
        "booking.update",
        "booking.cancel",
        "booking.revert",
        # Rooms — general
        "room.view",
        "room.checkin",
        "room.checkout",
        "room.update",
        "room.transfer",
        # Rooms — housekeeping
        "room.cleaning.view",
        "room.cleaning.complete",
        # Two-stage cleaning: housekeeping marks "ready_to_inspect"
        # then admin / manager approves "ready for check-in".
        "room.inspection.approve",
        # Settings & config
        "settings.view",
        "settings.update",
        "laundry.price.edit",
        # Settle-later / OTA settlements
        "settle_later.use",
        "settlement.manage",
        # Transaction / register
        "transaction.history.full",
        "register.view",
        # Logs & user management
        "logs.view",
        "user.manage",
        # Exports & customer records & quick-actions UI
        "data.export",
        "customer.manage",
        "quick_actions.use",
    }
)


# ─── Role → permissions map ───────────────────────────────────────────────
# "*" is the wildcard — granted to admin only.
ROLE_PERMISSIONS: dict[str, FrozenSet[str]] = {
    ROLE_ADMIN: frozenset({"*"}),
    ROLE_MANAGER: frozenset(
        {
            "app.access",
            "booking.create",
            "booking.update",
            "booking.cancel",
            "room.view",
            "room.checkin",
            "room.checkout",
            "room.update",
            "room.transfer",
            "room.cleaning.view",
            "room.cleaning.complete",
            "room.inspection.approve",
            "register.view",
            # Manager DOES NOT get: settings.view, discount.apply,
            # settlement.manage, transaction.history.full, payment.edit,
            # data.export, customer.manage, booking.revert, revenue.view,
            # analytics.view, laundry.price.edit, settle_later.use,
            # logs.view, user.manage.
        }
    ),
    ROLE_HOUSEKEEPING: frozenset(
        {
            "app.access",
            "room.cleaning.view",
            "room.cleaning.complete",
        }
    ),
}


def role_has_permission(role: str, permission: str) -> bool:
    """True if the role grants the permission. Wildcard "*" matches anything."""
    if not role or role not in ROLE_PERMISSIONS:
        return False
    grants = ROLE_PERMISSIONS[role]
    return "*" in grants or permission in grants


def assert_known_permission(permission: str) -> None:
    """Sanity check used in tests / startup — never in hot paths."""
    if permission not in PERMISSIONS and permission != "*":
        raise ValueError(f"unknown permission: {permission!r}")


def permissions_for_role(role: str) -> Iterable[str]:
    """Return the explicit permission set (expands "*" to the full set)."""
    grants = ROLE_PERMISSIONS.get(role, frozenset())
    if "*" in grants:
        return PERMISSIONS
    return grants
