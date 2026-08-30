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
        # Bill — correct the guest name / mobile on an existing bill
        # (non-financial fields only; does not touch amounts or tax heads).
        # Granted to manager as well as admin. Every edit is audit-logged.
        "bill.guest.edit",
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
        # Browse expense history across ANY date range (routes/reports.py
        # /expenses/browse). Granted to manager as a narrow carve-out from
        # the normal MANAGER_VISIBLE_DAYS window (services/role_filters.py)
        # — that route returns expense line items + expense totals ONLY,
        # never revenue/cash/UPI/room-count figures, so it's safe to unlock
        # the date range for it specifically.
        "expense.view",
        # Marketing spend. Admin-only: it is absent from ROLE_MANAGER below,
        # so admin's "*" wildcard is the only thing that grants it. Made a
        # permission rather than a role check so it can be handed to a
        # manager later without touching any call site. Enforced in
        # routes/reports.py :: add_expense — the option being missing from
        # the dropdown is convenience, not the control. Changing an existing
        # expense's category is already covered by expense.manage.
        "expense.marketing",
        # Deep-check maintenance (routes/maintenance.py). Manager runs
        # inspections and logs fixes; admin additionally verifies fixes,
        # edits the checklist template and deletes/alters records.
        "maintenance.view",
        "maintenance.inspect",
        "maintenance.issue.fix",
        "maintenance.issue.verify",      # admin-only (wildcard)
        "maintenance.checklist.manage",  # admin-only (wildcard)
        "maintenance.manage",            # admin-only (wildcard) — destructive ops
        # Staff attendance & payroll (routes/staff.py). Manager marks the
        # daily attendance; everything that touches money — wages,
        # advances, salary payouts and their ₹ figures — is admin-only.
        "staff.view",                    # staff list + attendance (no ₹)
        "staff.attendance.mark",         # mark full / half / absent
        "staff.attendance.amend",        # admin-only (wildcard) — CHANGE a
                                         # mark after the day it was entered.
                                         # Managers may still back-fill a day
                                         # nobody marked; they just can't
                                         # rewrite settled history.
        "staff.manage",                  # admin-only — add/edit staff, wages,
                                         # and REVERSING advances/salaries
        "staff.payroll.view",            # see ₹ figures (manager + admin)
        "staff.advance.give",            # record advances (manager + admin)
        "staff.salary.pay",              # pay salaries (manager + admin)
        "staff.pay.account",             # admin-only — pay from bank/UPI;
                                         # managers pay from counter cash only
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
            # Correct guest name / mobile on a bill (non-financial). Amounts,
            # taxes and GST recipient details remain admin-only.
            "bill.guest.edit",
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
            # Staff — the manager on duty marks daily attendance and can
            # settle salaries / hand out advances FROM COUNTER CASH ONLY
            # (staff.pay.account, i.e. bank/UPI payouts, stays admin-only —
            # same custody principle as banking.deposit.confirm). Adding/
            # editing staff, wages, and reversing payments stay admin-only
            # via staff.manage.
            "staff.view",
            "staff.attendance.mark",
            "staff.payroll.view",
            "staff.salary.pay",
            "staff.advance.give",
            # Browse expense history across any date range (dedicated
            # expenses-only view — see routes/reports.py /expenses/browse).
            # This is the one deliberate exception to MANAGER_VISIBLE_DAYS:
            # every other manager-visible total stays clamped to the last
            # 3 days.
            "expense.view",
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
