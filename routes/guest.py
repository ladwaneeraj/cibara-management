"""
Guest portal (QR room service): staff HTTP endpoints.

The guest's phone never calls these; it talks to Firestore directly under
firestore.rules. These routes are what the ERP dashboard uses:

    GET   /api/guest-portal/settings           guest_request.handle  read settings
    PATCH /api/guest-portal/settings           guest_portal.manage   update settings
    GET   /api/guest-portal/qr.png             guest_portal.manage   the printable QR
    GET   /api/guest-requests                  guest_request.handle  active requests
    GET   /api/guest-requests/history?days=7   guest_request.handle  done + open, who/when
    POST  /api/guest-requests/<id>/acknowledge guest_request.handle
    POST  /api/guest-requests/<id>/done        guest_request.handle

Housekeeping holds guest_request.handle but is limited to its own team's
requests here AND in the rules, so the limit cannot be bypassed from either
side.
"""

from __future__ import annotations

from flask import Blueprint, request, jsonify, g, Response

from config import logger
from services import guest_portal as svc
from services.auth_service import requires_permission

guest_bp = Blueprint("guest", __name__, url_prefix="/api")


def _fail(message, code=400):
    return jsonify(success=False, message=str(message)), code


def _team_limit() -> str | None:
    return svc.team_for_role((g.current_user or {}).get("role"))


# ─── Settings + QR ─────────────────────────────────────────────────────────

@guest_bp.route("/guest-portal/settings", methods=["GET"])
@requires_permission("guest_request.handle")
def get_portal_settings():
    try:
        settings = svc.get_settings()
        # The Wi-Fi password is for the guest's phone and the admin form,
        # not for every staff screen that opens the requests panel.
        if not g.current_user or g.current_user.get("role") != "admin":
            settings.pop("wifiPassword", None)
        return jsonify(success=True, settings=settings)
    except Exception as e:
        logger.exception("guest-portal/settings GET failed")
        return _fail(e, 500)


@guest_bp.route("/guest-portal/settings", methods=["PATCH", "POST"])
@requires_permission("guest_portal.manage")
def update_portal_settings():
    try:
        settings = svc.save_settings(request.json or {}, g.current_user)
        return jsonify(success=True, settings=settings)
    except ValueError as ve:
        return _fail(ve)
    except Exception as e:
        logger.exception("guest-portal/settings PATCH failed")
        return _fail(e, 500)


@guest_bp.route("/guest-portal/qr.png", methods=["GET"])
@requires_permission("guest_portal.manage")
def portal_qr():
    try:
        png = svc.qr_png(svc.portal_url())
    except ImportError:
        return _fail("QR generation needs the 'qrcode[pil]' package "
                     "(see requirements.txt)", 503)
    except Exception as e:
        logger.exception("guest-portal/qr.png failed")
        return _fail(e, 500)
    return Response(png, mimetype="image/png",
                    headers={"Cache-Control": "no-store"})


# ─── Requests ─────────────────────────────────────────────────────────────

@guest_bp.route("/guest-requests", methods=["GET"])
@requires_permission("guest_request.handle")
def list_requests():
    try:
        return jsonify(success=True, requests=svc.list_active_requests(_team_limit()))
    except Exception as e:
        logger.exception("guest-requests GET failed")
        return _fail(e, 500)


@guest_bp.route("/guest-requests/history", methods=["GET"])
@requires_permission("guest_request.handle")
def request_history():
    try:
        days = int(request.args.get("days") or 7)
    except ValueError:
        return _fail("days must be a number")
    try:
        return jsonify(success=True, **svc.request_history(days, _team_limit()))
    except Exception as e:
        logger.exception("guest-requests/history GET failed")
        return _fail(e, 500)


def _transition(request_id: str, status: str):
    try:
        updated = svc.set_request_status(request_id, status, g.current_user, _team_limit())
        return jsonify(success=True, request=updated)
    except LookupError as le:
        return _fail(le, 404)
    except PermissionError as pe:
        return _fail(pe, 403)
    except ValueError as ve:
        return _fail(ve, 409)
    except Exception as e:
        logger.exception(f"guest-requests/{request_id}/{status} failed")
        return _fail(e, 500)


@guest_bp.route("/guest-requests/<request_id>/acknowledge", methods=["POST"])
@requires_permission("guest_request.handle")
def acknowledge_request(request_id):
    return _transition(request_id, "acknowledged")


@guest_bp.route("/guest-requests/<request_id>/done", methods=["POST"])
@requires_permission("guest_request.handle")
def complete_request(request_id):
    return _transition(request_id, "done")
