"""
Marketing is an admin-only expense category.

The <option> is hidden and disabled for non-admins in static/expense.js, but
that is convenience. /add_expense accepts whatever category the client posts,
so the control is the server-side check in routes/reports.py. These tests
cover the permission wiring that check depends on; they need no Firestore.
"""

import pytest

from services.permissions import (
    PERMISSIONS,
    ROLE_ADMIN,
    ROLE_HOUSEKEEPING,
    ROLE_MANAGER,
    ROLE_PERMISSIONS,
    role_has_permission,
)

PERM = "expense.marketing"


class TestPermissionExists:
    def test_it_is_a_known_permission(self):
        # A typo here would make role_has_permission fall through silently
        # rather than raise, so the whole gate would quietly stop working.
        assert PERM in PERMISSIONS


class TestWhoGetsIt:
    def test_admin_has_it_through_the_wildcard(self):
        assert role_has_permission(ROLE_ADMIN, PERM)

    def test_manager_does_not(self):
        assert not role_has_permission(ROLE_MANAGER, PERM)

    def test_housekeeping_does_not(self):
        assert not role_has_permission(ROLE_HOUSEKEEPING, PERM)

    def test_it_is_absent_from_every_non_admin_role(self):
        for role, perms in ROLE_PERMISSIONS.items():
            if role == ROLE_ADMIN:
                continue
            assert PERM not in perms, f"{role} was granted {PERM}"

    @pytest.mark.parametrize("role", ["", None, "unknown", "owner", "staff"])
    def test_an_unrecognised_or_missing_role_is_denied(self, role):
        # add_expense passes `_actor.get("role") or ""` — an unauthenticated
        # or malformed actor must fail closed, not fall through to allowed.
        assert not role_has_permission(role, PERM)


class TestRouteWiring:
    def test_the_route_maps_marketing_to_this_permission(self):
        from routes.reports import _RESTRICTED_CATEGORIES

        assert _RESTRICTED_CATEGORIES["marketing"] == PERM

    def test_every_restricted_category_names_a_real_permission(self):
        from routes.reports import _RESTRICTED_CATEGORIES

        for category, perm in _RESTRICTED_CATEGORIES.items():
            assert perm in PERMISSIONS, f"{category} -> unknown permission {perm}"

    def test_no_non_admin_role_can_reach_any_restricted_category(self):
        from routes.reports import _RESTRICTED_CATEGORIES

        for role in ROLE_PERMISSIONS:
            if role == ROLE_ADMIN:
                continue
            for category, perm in _RESTRICTED_CATEGORIES.items():
                assert not role_has_permission(role, perm), (
                    f"{role} can file a '{category}' expense"
                )


class TestPresetsWhitelist:
    def test_marketing_is_accepted_by_the_presets_service(self):
        # Otherwise an admin could file Marketing expenses but never configure
        # quick-pick tiles for them, unlike every other category.
        from services.expense_presets_service import ALLOWED_CATEGORIES

        assert "marketing" in ALLOWED_CATEGORIES
