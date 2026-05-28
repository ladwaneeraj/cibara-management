"""
Expense Presets REST endpoints.

Routes
──────
GET    /expense_presets                     → All categories (any logged-in user).
GET    /expense_presets/<category>          → One category's items.
POST   /expense_presets/<category>          → Add an item (admin).
PUT    /expense_presets/<category>/<id>     → Update item (admin).
DELETE /expense_presets/<category>/<id>     → Delete item (admin).

The read endpoints are open to every authenticated user — operators
need the list to render tiles inside the expense modal. Write
endpoints require the new `expense.presets.manage` permission, which
is admin-only by default (see services/permissions.py).
"""

from __future__ import annotations

from flask import Blueprint, request, jsonify, g

from config import logger
from services import expense_presets_service as presets
from services.auth_service import requires_permission, login_required


expense_presets_bp = Blueprint("expense_presets", __name__)

_PERM = "expense.presets.manage"


def _actor() -> str:
    """Best-effort user id for audit trail. Falls back to 'system'."""
    try:
        user = getattr(g, "current_user", None) or {}
        return user.get("userId") or "system"
    except Exception:
        return "system"


# ---------------------------------------------------------------------------
# READ
# ---------------------------------------------------------------------------

@expense_presets_bp.route("/expense_presets", methods=["GET"])
@login_required
def list_presets():
    try:
        return jsonify(success=True, presets=presets.list_all())
    except Exception as e:
        logger.error("list_presets failed: %s", e)
        return jsonify(success=False, message=str(e)), 500


@expense_presets_bp.route("/expense_presets/<category>", methods=["GET"])
@login_required
def get_category_presets(category):
    try:
        if category not in presets.ALLOWED_CATEGORIES:
            return jsonify(success=False, message="Unknown category"), 400
        return jsonify(success=True, category=category,
                       items=presets.get_category(category))
    except Exception as e:
        logger.error("get_category_presets failed: %s", e)
        return jsonify(success=False, message=str(e)), 500


# ---------------------------------------------------------------------------
# WRITE  (admin only)
# ---------------------------------------------------------------------------

@expense_presets_bp.route("/expense_presets/<category>", methods=["POST"])
@requires_permission(_PERM)
def add_preset(category):
    try:
        body = request.get_json(silent=True) or {}
        name = body.get("name", "")
        default_amount = body.get("default_amount")

        result = presets.add_item(
            category, name,
            default_amount=default_amount,
            actor=_actor(),
        )
        status = 200 if result.get("success") else 400
        return jsonify(result), status
    except Exception as e:
        logger.error("add_preset failed: %s", e)
        return jsonify(success=False, message=str(e)), 500


@expense_presets_bp.route("/expense_presets/<category>/<item_id>", methods=["PUT"])
@requires_permission(_PERM)
def update_preset(category, item_id):
    try:
        body = request.get_json(silent=True) or {}

        # Only forward fields that were actually supplied so the service
        # knows the difference between "leave it alone" and
        # "explicitly clear it".
        kwargs = {"actor": _actor()}
        if "name" in body:
            kwargs["name"] = body.get("name")
        if "default_amount" in body:
            kwargs["default_amount"] = body.get("default_amount")

        result = presets.update_item(category, item_id, **kwargs)
        status = 200 if result.get("success") else 400
        return jsonify(result), status
    except Exception as e:
        logger.error("update_preset failed: %s", e)
        return jsonify(success=False, message=str(e)), 500


@expense_presets_bp.route("/expense_presets/<category>/<item_id>", methods=["DELETE"])
@requires_permission(_PERM)
def delete_preset(category, item_id):
    try:
        result = presets.delete_item(category, item_id, actor=_actor())
        status = 200 if result.get("success") else 400
        return jsonify(result), status
    except Exception as e:
        logger.error("delete_preset failed: %s", e)
        return jsonify(success=False, message=str(e)), 500
