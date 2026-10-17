"""Phase 2 RBAC: the finer money-OUT permissions split out of payment.edit /
settlement.manage. They are registered and admin-only (the step-up re-auth gate
keys on them); managers and housekeeping never hold them."""
from services import permissions as p


def test_new_money_out_permissions_are_registered():
    for key in ("payment.refund", "settlement.writeoff"):
        p.assert_known_permission(key)  # raises if missing


def test_money_out_permissions_are_admin_only():
    for key in ("payment.refund", "settlement.writeoff"):
        assert p.role_has_permission(p.ROLE_ADMIN, key) is True
        assert p.role_has_permission(p.ROLE_MANAGER, key) is False
        assert p.role_has_permission(p.ROLE_HOUSEKEEPING, key) is False
