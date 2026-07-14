"""
Deep-check maintenance routes.

Thin HTTP layer over services/maintenance_service.py. All authorization is
enforced here via @requires_permission; see services/permissions.py for
which role gets what:

    maintenance.view              manager + admin   read everything
    maintenance.inspect           manager + admin   rounds + inspections + manual issues
    maintenance.issue.fix         manager + admin   mark an issue fixed
    maintenance.issue.verify      admin             verify / reopen a fix
    maintenance.checklist.manage  admin             edit the checklist template
    maintenance.manage            admin             destructive ops (delete issues)

Every mutation writes an audit_log entry.
"""

import time as _time
from concurrent.futures import ThreadPoolExecutor

from flask import Blueprint, request, jsonify, g

from services import maintenance_service as svc
from services.auth_service import requires_permission
from services.audit_log import write_log
from config import logger

maintenance_bp = Blueprint("maintenance", __name__, url_prefix="/maintenance")

# ── /overview short-lived cache ─────────────────────────────────────────────
# The dashboard payload costs several sequential Firestore round-trips;
# a 15s per-process cache (same pattern as rooms.py's /get_data cache)
# makes repeat opens instant. Every mutation below busts it.
_OVERVIEW_CACHE: dict = {"payload": None, "ts": 0.0}
_OVERVIEW_TTL = 15  # seconds


def _invalidate_overview():
    _OVERVIEW_CACHE["payload"] = None
    _OVERVIEW_CACHE["ts"] = 0.0


def _fail(message, code=400):
    return jsonify(success=False, message=str(message)), code


# ─── Checklist template ────────────────────────────────────────────────────

@maintenance_bp.route("/checklist", methods=["GET"])
@requires_permission("maintenance.view")
def get_checklist():
    try:
        include_inactive = request.args.get("all") == "1"
        room = request.args.get("room") or None
        return jsonify(
            success=True,
            items=svc.get_checklist(include_inactive=include_inactive, room=room),
            categories=svc.known_room_categories(),
        )
    except Exception as e:
        logger.exception("maintenance/checklist GET failed")
        return _fail(e, 500)


@maintenance_bp.route("/checklist", methods=["POST"])
@requires_permission("maintenance.checklist.manage")
def save_checklist():
    try:
        items = (request.json or {}).get("items")
        saved = svc.save_checklist(items, g.current_user)
        _invalidate_overview()
        write_log("maintenance.checklist.update",
                  target_collection="settings", target_id="maintenance_checklist",
                  metadata={"item_count": len(saved)})
        return jsonify(success=True, items=saved)
    except ValueError as ve:
        return _fail(ve)
    except Exception as e:
        logger.exception("maintenance/checklist POST failed")
        return _fail(e, 500)


# ─── Rounds ────────────────────────────────────────────────────────────────

@maintenance_bp.route("/rounds", methods=["GET"])
@requires_permission("maintenance.view")
def list_rounds():
    try:
        return jsonify(success=True, rounds=svc.list_rounds())
    except Exception as e:
        logger.exception("maintenance/rounds GET failed")
        return _fail(e, 500)


@maintenance_bp.route("/rounds/start", methods=["POST"])
@requires_permission("maintenance.inspect")
def start_round():
    try:
        name = (request.json or {}).get("name", "")
        rnd = svc.start_round(name, g.current_user)
        _invalidate_overview()
        write_log("maintenance.round.start",
                  target_collection="maintenance_rounds", target_id=rnd["id"],
                  metadata={"name": rnd["name"]})
        return jsonify(success=True, round=rnd)
    except ValueError as ve:
        return _fail(ve)
    except Exception as e:
        logger.exception("maintenance/rounds/start failed")
        return _fail(e, 500)


@maintenance_bp.route("/rounds/<round_id>/close", methods=["POST"])
@requires_permission("maintenance.inspect")
def close_round(round_id):
    try:
        rnd = svc.close_round(round_id, g.current_user)
        _invalidate_overview()
        write_log("maintenance.round.close",
                  target_collection="maintenance_rounds", target_id=round_id)
        return jsonify(success=True, round=rnd)
    except ValueError as ve:
        return _fail(ve)
    except Exception as e:
        logger.exception("maintenance/rounds/close failed")
        return _fail(e, 500)


@maintenance_bp.route("/rounds/<round_id>/status", methods=["GET"])
@requires_permission("maintenance.view")
def round_status(round_id):
    try:
        return jsonify(success=True, **svc.round_status(round_id))
    except ValueError as ve:
        return _fail(ve, 404)
    except Exception as e:
        logger.exception("maintenance/rounds/status failed")
        return _fail(e, 500)


@maintenance_bp.route("/overview", methods=["GET"])
@requires_permission("maintenance.view")
def overview():
    """Single dashboard payload: open round (+coverage) & checklist.

    Cached for _OVERVIEW_TTL seconds; independent Firestore reads run in
    parallel on a miss (latency, not compute, dominates here).
    """
    try:
        cached = _OVERVIEW_CACHE["payload"]
        if cached is not None and _time.time() - _OVERVIEW_CACHE["ts"] < _OVERVIEW_TTL:
            return jsonify(success=True, **cached)

        with ThreadPoolExecutor(max_workers=3) as ex:
            f_checklist = ex.submit(svc.get_checklist)
            f_cats = ex.submit(svc.known_room_categories)
            f_round = ex.submit(svc.get_open_round)
            open_round = f_round.result()
            f_status = (
                ex.submit(svc.round_status, open_round["id"], open_round)
                if open_round else None
            )
            payload = {
                "checklist": f_checklist.result(),
                "categories": f_cats.result(),
                "open_round": open_round,
                "status": f_status.result() if f_status else None,
            }
        _OVERVIEW_CACHE["payload"] = payload
        _OVERVIEW_CACHE["ts"] = _time.time()
        return jsonify(success=True, **payload)
    except Exception as e:
        logger.exception("maintenance/overview failed")
        return _fail(e, 500)


# ─── Inspections ───────────────────────────────────────────────────────────

@maintenance_bp.route("/inspect", methods=["POST"])
@requires_permission("maintenance.inspect")
def submit_inspection():
    try:
        data = request.json or {}
        ins = svc.submit_inspection(
            data.get("round_id", ""), str(data.get("room", "")),
            data.get("items", []), g.current_user,
        )
        _invalidate_overview()
        write_log("maintenance.inspect",
                  target_collection="maintenance_inspections", target_id=ins["id"],
                  metadata={"room": ins["room"], "score": ins["score"],
                            "issues_created": ins["issues_created"]})
        return jsonify(success=True, inspection=ins)
    except ValueError as ve:
        return _fail(ve)
    except Exception as e:
        logger.exception("maintenance/inspect failed")
        return _fail(e, 500)


@maintenance_bp.route("/inspections/<round_id>/<room>", methods=["GET"])
@requires_permission("maintenance.view")
def get_inspection(round_id, room):
    try:
        ins = svc.get_inspection(round_id, room)
        return jsonify(success=True, inspection=ins)
    except Exception as e:
        logger.exception("maintenance/inspections GET failed")
        return _fail(e, 500)


# ─── Issues ────────────────────────────────────────────────────────────────

@maintenance_bp.route("/issues", methods=["GET"])
@requires_permission("maintenance.view")
def list_issues():
    try:
        return jsonify(success=True, issues=svc.list_issues(
            status=request.args.get("status"),
            room=request.args.get("room"),
            round_id=request.args.get("round_id"),
        ))
    except Exception as e:
        logger.exception("maintenance/issues GET failed")
        return _fail(e, 500)


@maintenance_bp.route("/issues", methods=["POST"])
@requires_permission("maintenance.inspect")
def create_issue():
    try:
        data = request.json or {}
        iss = svc.create_manual_issue(
            room=str(data.get("room", "")),
            item_label=data.get("item_label", ""),
            severity=data.get("severity", "medium"),
            description=data.get("description", ""),
            category=data.get("category", "general"),
            user=g.current_user,
        )
        _invalidate_overview()
        write_log("maintenance.issue.create",
                  target_collection="maintenance_issues", target_id=iss["id"],
                  metadata={"room": iss["room"], "item": iss["item_label"]})
        return jsonify(success=True, issue=iss)
    except ValueError as ve:
        return _fail(ve)
    except Exception as e:
        logger.exception("maintenance/issues POST failed")
        return _fail(e, 500)


@maintenance_bp.route("/issues/<issue_id>/fix", methods=["POST"])
@requires_permission("maintenance.issue.fix")
def fix_issue(issue_id):
    try:
        data = request.json or {}
        iss = svc.fix_issue(issue_id, data.get("note", ""), data.get("cost"),
                            g.current_user)
        _invalidate_overview()
        write_log("maintenance.issue.fix",
                  target_collection="maintenance_issues", target_id=issue_id,
                  metadata={"room": iss.get("room"), "cost": iss.get("cost")})
        return jsonify(success=True, issue=iss)
    except ValueError as ve:
        return _fail(ve)
    except Exception as e:
        logger.exception("maintenance/issues/fix failed")
        return _fail(e, 500)


@maintenance_bp.route("/issues/<issue_id>/verify", methods=["POST"])
@requires_permission("maintenance.issue.verify")
def verify_issue(issue_id):
    try:
        iss = svc.verify_issue(issue_id, g.current_user)
        _invalidate_overview()
        write_log("maintenance.issue.verify",
                  target_collection="maintenance_issues", target_id=issue_id,
                  metadata={"room": iss.get("room")})
        return jsonify(success=True, issue=iss)
    except ValueError as ve:
        return _fail(ve)
    except Exception as e:
        logger.exception("maintenance/issues/verify failed")
        return _fail(e, 500)


@maintenance_bp.route("/issues/<issue_id>/reopen", methods=["POST"])
@requires_permission("maintenance.issue.verify")
def reopen_issue(issue_id):
    try:
        reason = (request.json or {}).get("reason", "")
        iss = svc.reopen_issue(issue_id, reason, g.current_user)
        _invalidate_overview()
        write_log("maintenance.issue.reopen",
                  target_collection="maintenance_issues", target_id=issue_id,
                  metadata={"room": iss.get("room"), "reason": reason[:100]})
        return jsonify(success=True, issue=iss)
    except ValueError as ve:
        return _fail(ve)
    except Exception as e:
        logger.exception("maintenance/issues/reopen failed")
        return _fail(e, 500)


@maintenance_bp.route("/issues/<issue_id>", methods=["DELETE"])
@requires_permission("maintenance.manage")
def delete_issue(issue_id):
    try:
        iss = svc.delete_issue(issue_id)
        _invalidate_overview()
        write_log("maintenance.issue.delete",
                  target_collection="maintenance_issues", target_id=issue_id,
                  before={"room": iss.get("room"), "item": iss.get("item_label"),
                          "status": iss.get("status")})
        return jsonify(success=True)
    except ValueError as ve:
        return _fail(ve, 404)
    except Exception as e:
        logger.exception("maintenance/issues DELETE failed")
        return _fail(e, 500)


# ─── Analytics ─────────────────────────────────────────────────────────────

@maintenance_bp.route("/analytics", methods=["GET"])
@requires_permission("maintenance.view")
def get_analytics():
    try:
        return jsonify(success=True, analytics=svc.analytics())
    except Exception as e:
        logger.exception("maintenance/analytics failed")
        return _fail(e, 500)
