/* ─────────────────────────────────────────────────────────────────────────
 * Frontend mirror of services/permissions.py.
 *
 * Frontend permission checks are UX-only — they hide buttons and routes
 * the user can't use. The actual security boundary is the Flask backend
 * (see @requires_permission) and Firestore Security Rules.
 *
 * Keep this file IN SYNC with services/permissions.py. If you add a new
 * key, add it in both places.
 * ──────────────────────────────────────────────────────────────────── */

(function (global) {
  "use strict";

  const ROLE_ADMIN = "admin";
  const ROLE_MANAGER = "manager";
  const ROLE_HOUSEKEEPING = "housekeeping";

  const ROLES = Object.freeze([ROLE_ADMIN, ROLE_MANAGER, ROLE_HOUSEKEEPING]);

  // Role → permissions. "*" is a wildcard for admin.
  const ROLE_PERMISSIONS = Object.freeze({
    [ROLE_ADMIN]: Object.freeze(["*"]),
    [ROLE_MANAGER]: Object.freeze([
      "app.access",
      "booking.create",
      "booking.update",
      "booking.cancel",
      "room.view",
      "room.checkin",
      "room.checkout",
      "room.update",
      // Same-category physical moves only. Cross-category transfers
      // (upgrade/downgrade, permission "room.transfer.cross_category")
      // are admin-only via the wildcard — do NOT add them here.
      "room.transfer",
      "room.cleaning.view",
      "room.cleaning.complete",
      "room.inspection.approve",
      "register.view",
      // Correct guest name / mobile on a bill (non-financial only). Amounts,
      // taxes and GST recipient details stay admin-only.
      "bill.guest.edit",
      // Banking — manager can view + assemble drafts; cannot confirm,
      // reconcile, reverse, create adjustments, or manage accounts.
      "banking.view",
      "banking.deposit.create",
      // Deep-check maintenance — manager inspects and marks fixed;
      // verify / checklist edit / delete stay admin-only.
      "maintenance.view",
      "maintenance.inspect",
      "maintenance.issue.fix",
      // Manager does NOT get: settings.view, discount.apply,
      // settlement.manage, transaction.history.full, payment.edit,
      // data.export, customer.manage, booking.revert, revenue.view,
      // analytics.view, laundry.price.edit, settle_later.use,
      // logs.view, user.manage, quick_actions.use,
      // banking.deposit.confirm, banking.deposit.reconcile,
      // banking.deposit.reverse, banking.adjustment.create,
      // banking.account.manage,
      // expense.presets.manage,
      // expense.manage,
      // gst.lock.manage (GST month locking — admin-only),
      // maintenance.issue.verify, maintenance.checklist.manage,
      // maintenance.manage (deep-check admin ops — admin-only).
    ]),
    [ROLE_HOUSEKEEPING]: Object.freeze([
      "app.access",
      "room.cleaning.view",
      "room.cleaning.complete",
    ]),
  });

  function roleHasPermission(role, permission) {
    if (!role) return false;
    const grants = ROLE_PERMISSIONS[role];
    if (!grants) return false;
    if (grants.indexOf("*") !== -1) return true;
    return grants.indexOf(permission) !== -1;
  }

  global.CibaraPermissions = Object.freeze({
    ROLES,
    ROLE_ADMIN,
    ROLE_MANAGER,
    ROLE_HOUSEKEEPING,
    ROLE_PERMISSIONS,
    roleHasPermission,
  });
})(window);
