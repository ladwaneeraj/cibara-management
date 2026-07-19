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
        # GST month locking — freeze a filed month against bill mutations
        # (see services/gst_lock_service.py). Admin-only (wildcard).
        "gst.lock.manage",
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
        # Cross-category transfer (upgrade/downgrade — re-rates the stay).
        # Admin-only (wildcard); manager's room.transfer covers only
        # same-category physical moves.
        "room.transfer.cross_category",
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
        # Laundry data locking — freeze past months/dates in the laundry
        # grid against edits. Admin-only (wildcard).
        "laundry.lock.manage",
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
        # Banking — cash deposits, receipt vouchers, adjustments,
        # bank account directory. See services/banking/schema.py for
        # the canonical PERM_* constants; the strings here must match.
        "banking.view",
        "banking.deposit.create",
        "banking.deposit.confirm",
        "banking.deposit.reconcile",
        "banking.deposit.reverse",
        "banking.adjustment.create",
        "banking.account.manage",
        # Expense presets — admin-curated quick-pick tiles per category.
        # Read is open to every authenticated user (so operators can render
        # tiles in the expense modal); editing requires this permission.
        "expense.presets.manage",
        # Editing / deleting an existing expense. Distinct from "creating"
        # an expense (everyone with banking.adjustment.create / write
        # access to the transaction tab can create). Admin-only by default.
        "expense.manage",
        # Deep-check maintenance (routes/maintenance.py). Manager runs
        # inspections and logs fixes; admin additionally verifies fixes,
        # edits the checklist template and deletes/alters records.
        "maintenance.view",
        "maintenance.inspect",
        "maintenance.issue.fix",
        "maintenance.issue.verify",      # admin-only (wildcard)
        "maintenance.checklist.manage",  # admin-only (wildcard)
        "maintenance.manage",            # admin-only (wildcard) — destructive ops
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
            # Same-category physical moves only — cross-category
            # (room.transfer.cross_category) stays admin-only.
            "room.transfer",
            "room.cleaning.view",
            "room.cleaning.complete",
            "room.inspection.approve",
            "register.view",
            # Banking — manager can VIEW the deposit screens and
            # ASSEMBLE a draft deposit, but CANNOT confirm/reconcile/
            # reverse a deposit or create cash adjustments. Those are
            # admin-only because they involve money leaving the
            # operator's custody.
            "banking.view",
            "banking.deposit.create",
            # Deep-check maintenance — manager inspects rooms and marks
            # issues fixed; verification, checklist editing and deletion
            # stay admin-only.
            "maintenance.view",
            "maintenance.inspect",
            "maintenance.issue.fix",
            # Manager DOES NOT get: settings.view, discount.apply,
            # settlement.manage, transaction.history.full, payment.edit,
            # data.export, customer.manage, booking.revert, revenue.view,
            # analytics.view, laundry.price.edit, settle_later.use,
            # logs.view, user.manage,
            # banking.deposit.confirm, banking.deposit.reconcile,
            # banking.deposit.reverse, banking.adjustment.create,
            # banking.account.manage.
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
