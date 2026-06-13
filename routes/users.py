"""
Admin-only user management endpoints.

All routes here require role=admin. Every mutation writes an audit log
entry and ensures Firebase Auth + Firestore stay in sync.

Endpoints
─────────
GET    /api/users                       List all users
POST   /api/users                       Create a user
PATCH  /api/users/<user_id>             Update name / role / active flag
POST   /api/users/<user_id>/reset-password   Set a new password
POST   /api/users/<user_id>/force-logout     Revoke all refresh tokens
DELETE /api/users/<user_id>             Soft-delete (sets isActive=false)
GET    /api/audit-logs                  Recent audit log entries (admin)
"""

from __future__ import annotations

import re
from datetime import datetime

from flask import Blueprint, request, jsonify, g
from firebase_admin import auth as fb_auth

from config import db, logger, IST
from services.auth_service import (
    requires_permission,
    requires_role,
    set_user_claims,
    revoke_user_tokens,
    to_synthetic_email,
)
from services.audit_log import write_log, attribution_create, attribution_update
from services.permissions import ROLES, ROLE_ADMIN


users_bp = Blueprint("users", __name__)

USERS_COLLECTION = "users"
AUDIT_COLLECTION = "audit_logs"
ARCHIVE_COLLECTION = "audit_logs_archive"

USER_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,30}$")
MIN_PASSWORD_LEN = 6  # Firebase Auth's hard minimum is 6.


# ─── Helpers ──────────────────────────────────────────────────────────────
def _now() -> str:
    return datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")


def _validate_user_id(user_id: str) -> str:
    """Returns the normalized userId or raises ValueError."""
    if not user_id:
        raise ValueError("userId is required")
    cleaned = str(user_id).strip().lower()
    if not USER_ID_RE.match(cleaned):
        raise ValueError(
            "userId must be 2–31 chars, lowercase letters/digits/._- only, "
            "and start with a letter or digit"
        )
    return cleaned


def _validate_role(role: str) -> str:
    if role not in ROLES:
        raise ValueError(f"role must be one of {sorted(ROLES)}")
    return role


def _validate_password(pw: str) -> str:
    if not pw or len(pw) < MIN_PASSWORD_LEN:
        raise ValueError(f"password must be at least {MIN_PASSWORD_LEN} characters")
    return pw


def _user_doc_to_dict(doc) -> dict:
    d = doc.to_dict() or {}
    d["userId"] = doc.id
    # Don't echo the synthetic email — frontend never needs it
    d.pop("authEmail", None)
    return d


# ─── Routes ───────────────────────────────────────────────────────────────
@users_bp.route("/api/users", methods=["GET"])
@requires_permission("user.manage")
def list_users():
    try:
        docs = db.collection(USERS_COLLECTION).stream()
        users = [_user_doc_to_dict(d) for d in docs]
        # Newest first
        users.sort(key=lambda u: u.get("createdAt", ""), reverse=True)
        return jsonify(success=True, users=users)
    except Exception as e:
        logger.error(f"list_users failed: {e}")
        return jsonify(success=False, message="Failed to list users"), 500


@users_bp.route("/api/users", methods=["POST"])
@requires_permission("user.manage")
def create_user():
    data = request.get_json(silent=True) or {}
    try:
        user_id = _validate_user_id(data.get("userId"))
        name = (data.get("name") or user_id).strip()
        role = _validate_role(data.get("role"))
        password = _validate_password(data.get("password"))
    except ValueError as ve:
        return jsonify(success=False, message=str(ve)), 400

    # Prevent duplicate username
    existing = db.collection(USERS_COLLECTION).document(user_id).get()
    if existing.exists:
        return jsonify(success=False, message="userId already exists"), 409

    synthetic_email = to_synthetic_email(user_id)

    # Step 1: create the Firebase Auth user (or recover if it already exists).
    try:
        try:
            fb_user = fb_auth.create_user(
                email=synthetic_email,
                password=password,
                display_name=name,
            )
        except fb_auth.EmailAlreadyExistsError:
            # Auth account exists but no Firestore doc — recover it
            fb_user = fb_auth.get_user_by_email(synthetic_email)
            fb_auth.update_user(fb_user.uid, password=password, display_name=name)
    except Exception as e:
        logger.error(f"create_user (auth) failed for {user_id}: {e}")
        return jsonify(success=False, message="Failed to create auth user"), 500

    # Step 2: stamp role/userId/name into custom claims so ID tokens carry them.
    try:
        set_user_claims(fb_user.uid, user_id=user_id, name=name, role=role)
    except Exception as e:
        logger.error(f"create_user (claims) failed for {user_id}: {e}")
        # Roll back the auth user so we don't leave an orphan
        try:
            fb_auth.delete_user(fb_user.uid)
        except Exception:
            pass
        return jsonify(success=False, message="Failed to set user claims"), 500

    # Step 3: write the Firestore profile doc.
    try:
        doc = {
            "userId": user_id,
            "name": name,
            "role": role,
            "isActive": True,
            "authUid": fb_user.uid,
            **attribution_create(),
            "lastLoginAt": None,
        }
        db.collection(USERS_COLLECTION).document(user_id).set(doc)
    except Exception as e:
        logger.error(f"create_user (firestore) failed for {user_id}: {e}")
        return jsonify(success=False, message="Failed to save user profile"), 500

    write_log(
        "user.create",
        target_collection=USERS_COLLECTION,
        target_id=user_id,
        after={"userId": user_id, "name": name, "role": role},
    )
    return jsonify(success=True, userId=user_id), 201


@users_bp.route("/api/users/<user_id>", methods=["PATCH"])
@requires_permission("user.manage")
def update_user(user_id: str):
    data = request.get_json(silent=True) or {}
    try:
        user_id = _validate_user_id(user_id)
    except ValueError as ve:
        return jsonify(success=False, message=str(ve)), 400

    doc_ref = db.collection(USERS_COLLECTION).document(user_id)
    snap = doc_ref.get()
    if not snap.exists:
        return jsonify(success=False, message="User not found"), 404
    current = snap.to_dict() or {}

    updates: dict = {}
    if "name" in data:
        new_name = (data["name"] or "").strip()
        if not new_name:
            return jsonify(success=False, message="name cannot be empty"), 400
        updates["name"] = new_name
    if "role" in data:
        try:
            updates["role"] = _validate_role(data["role"])
        except ValueError as ve:
            return jsonify(success=False, message=str(ve)), 400
    if "isActive" in data:
        updates["isActive"] = bool(data["isActive"])

    if not updates:
        return jsonify(success=False, message="Nothing to update"), 400

    # Guardrails: don't let an admin demote / disable the last remaining admin.
    if (
        current.get("role") == ROLE_ADMIN
        and (
            updates.get("role", ROLE_ADMIN) != ROLE_ADMIN
            or updates.get("isActive", current.get("isActive", True)) is False
        )
    ):
        admin_count = sum(
            1
            for d in db.collection(USERS_COLLECTION)
            .where("role", "==", ROLE_ADMIN)
            .where("isActive", "==", True)
            .stream()
        )
        if admin_count <= 1:
            return (
                jsonify(
                    success=False,
                    message="Cannot demote or disable the last active admin",
                ),
                400,
            )

    auth_uid = current.get("authUid")

    # Apply Auth-side changes first (rollback Firestore write if these fail)
    try:
        if "isActive" in updates and auth_uid:
            fb_auth.update_user(auth_uid, disabled=not updates["isActive"])
        # Re-stamp claims if name or role changed
        if ("name" in updates or "role" in updates) and auth_uid:
            set_user_claims(
                auth_uid,
                user_id=user_id,
                name=updates.get("name", current.get("name", user_id)),
                role=updates.get("role", current.get("role")),
            )
            # If role changed, force-logout so the new role takes effect now
            if "role" in updates and updates["role"] != current.get("role"):
                revoke_user_tokens(auth_uid)
    except Exception as e:
        logger.error(f"update_user (auth) failed for {user_id}: {e}")
        return jsonify(success=False, message="Failed to update auth user"), 500

    updates.update(attribution_update())
    try:
        doc_ref.update(updates)
    except Exception as e:
        logger.error(f"update_user (firestore) failed for {user_id}: {e}")
        return jsonify(success=False, message="Failed to update user profile"), 500

    write_log(
        "user.update",
        target_collection=USERS_COLLECTION,
        target_id=user_id,
        before={k: current.get(k) for k in updates if k in current},
        after={k: v for k, v in updates.items() if k != "lastModifiedAt"},
    )
    return jsonify(success=True)


@users_bp.route("/api/users/<user_id>/reset-password", methods=["POST"])
@requires_permission("user.manage")
def reset_password(user_id: str):
    data = request.get_json(silent=True) or {}
    try:
        user_id = _validate_user_id(user_id)
        new_pw = _validate_password(data.get("password"))
    except ValueError as ve:
        return jsonify(success=False, message=str(ve)), 400

    snap = db.collection(USERS_COLLECTION).document(user_id).get()
    if not snap.exists:
        return jsonify(success=False, message="User not found"), 404
    auth_uid = (snap.to_dict() or {}).get("authUid")
    if not auth_uid:
        return jsonify(success=False, message="User has no auth account"), 500

    try:
        fb_auth.update_user(auth_uid, password=new_pw)
        # Force re-login so the new password is required immediately
        revoke_user_tokens(auth_uid)
    except Exception as e:
        logger.error(f"reset_password failed for {user_id}: {e}")
        return jsonify(success=False, message="Failed to reset password"), 500

    write_log(
        "user.reset_password",
        target_collection=USERS_COLLECTION,
        target_id=user_id,
    )
    return jsonify(success=True)


@users_bp.route("/api/users/<user_id>/force-logout", methods=["POST"])
@requires_permission("user.manage")
def force_logout(user_id: str):
    try:
        user_id = _validate_user_id(user_id)
    except ValueError as ve:
        return jsonify(success=False, message=str(ve)), 400

    snap = db.collection(USERS_COLLECTION).document(user_id).get()
    if not snap.exists:
        return jsonify(success=False, message="User not found"), 404
    auth_uid = (snap.to_dict() or {}).get("authUid")
    if not auth_uid:
        return jsonify(success=False, message="User has no auth account"), 500

    try:
        revoke_user_tokens(auth_uid)
    except Exception as e:
        logger.error(f"force_logout failed for {user_id}: {e}")
        return jsonify(success=False, message="Failed to revoke tokens"), 500

    write_log(
        "user.force_logout",
        target_collection=USERS_COLLECTION,
        target_id=user_id,
    )
    return jsonify(success=True)


@users_bp.route("/api/users/<user_id>", methods=["DELETE"])
@requires_permission("user.manage")
def deactivate_user(user_id: str):
    """Soft-delete: sets isActive=false and disables the Auth account.
    We don't hard-delete so audit logs remain meaningful."""
    try:
        user_id = _validate_user_id(user_id)
    except ValueError as ve:
        return jsonify(success=False, message=str(ve)), 400

    doc_ref = db.collection(USERS_COLLECTION).document(user_id)
    snap = doc_ref.get()
    if not snap.exists:
        return jsonify(success=False, message="User not found"), 404
    current = snap.to_dict() or {}

    if current.get("role") == ROLE_ADMIN:
        # Same last-admin guard as update_user
        admin_count = sum(
            1
            for d in db.collection(USERS_COLLECTION)
            .where("role", "==", ROLE_ADMIN)
            .where("isActive", "==", True)
            .stream()
        )
        if admin_count <= 1:
            return (
                jsonify(success=False, message="Cannot deactivate the last active admin"),
                400,
            )

    auth_uid = current.get("authUid")
    try:
        if auth_uid:
            fb_auth.update_user(auth_uid, disabled=True)
            revoke_user_tokens(auth_uid)
        doc_ref.update({"isActive": False, **attribution_update()})
    except Exception as e:
        logger.error(f"deactivate_user failed for {user_id}: {e}")
        return jsonify(success=False, message="Failed to deactivate user"), 500

    write_log(
        "user.deactivate",
        target_collection=USERS_COLLECTION,
        target_id=user_id,
    )
    return jsonify(success=True)


# ─── Audit log read endpoint ──────────────────────────────────────────────
# Supports filtering by:
#   ?from=YYYY-MM-DD          (inclusive, IST date)
#   ?to=YYYY-MM-DD            (inclusive, IST date)
#   ?userId=<userId>
#   ?action=<action key>      (exact match)
#   ?targetCollection=<name>
#   ?targetId=<id>
#   ?q=<free text>            (post-filter substring match on action/target/user)
#   ?limit=<n>                (1..1000, default 200)
#   ?include_archive=1        (also search audit_logs_archive)
#
# Composite indices required (auto-created by Firestore on first miss; see
# audit_logs_indexes.md). Filters are applied in this order so the most
# selective constraint runs first.
@users_bp.route("/api/audit-logs", methods=["GET"])
@requires_permission("logs.view")
def list_audit_logs():
    from datetime import datetime as _dt, timedelta as _td

    try:
        limit = max(1, min(int(request.args.get("limit", 200)), 1000))
    except (TypeError, ValueError):
        limit = 200

    from_date = (request.args.get("from") or "").strip()
    to_date = (request.args.get("to") or "").strip()
    user_id_filter = (request.args.get("userId") or "").strip().lower()
    action_filter = (request.args.get("action") or "").strip()
    coll_filter = (request.args.get("targetCollection") or "").strip()
    target_id_filter = (request.args.get("targetId") or "").strip()
    free_text = (request.args.get("q") or "").strip().lower()
    include_archive = request.args.get("include_archive") in ("1", "true", "yes")

    # Strategy: at most ONE Firestore-side equality filter (userId OR
    # action OR targetCollection OR targetId), plus order_by(server_ts DESC).
    # Date range and free-text are applied in Python after the stream.
    # This avoids needing any new composite Firestore indices — the auto
    # single-field index on server_ts is sufficient.
    #
    # We over-fetch (limit * 5, capped at 1000) so post-filter trimming
    # still has enough results to satisfy the requested `limit`.
    # No Firestore-side ordering means we can't be selective server-side.
    # Pull a broader window and trim/sort in Python. For a small hotel
    # this is a few hundred docs at most — well within Firestore's free tier.
    PYTHON_FILTER_OVERFETCH = max(limit * 10, 500)
    OVERFETCH_CAP = 2000

    def _build_query(coll_name: str):
        # Robust strategy: pull entries without ANY Firestore-side ordering.
        # Some audit entries written by older code paths might be missing
        # the `timestamp` field — Firestore's order_by silently excludes
        # those, which looked like an empty result set in the UI.
        # We sort in Python after the stream instead.
        q = db.collection(coll_name)
        # One optional equality filter for cheap narrowing on huge collections.
        if target_id_filter:
            q = q.where("targetId", "==", target_id_filter)
        elif user_id_filter:
            q = q.where("userId", "==", user_id_filter)
        elif action_filter:
            q = q.where("action", "==", action_filter)
        elif coll_filter:
            q = q.where("targetCollection", "==", coll_filter)
        return q.limit(min(PYTHON_FILTER_OVERFETCH, OVERFETCH_CAP))

    # Date range is "YYYY-MM-DD HH:MM:SS" lexicographic compare against
    # the entry's `timestamp` string. Both ends inclusive.
    from_str = (from_date + " 00:00:00") if from_date else None
    to_str = (to_date + " 23:59:59") if to_date else None

    def _matches_python_filters(d: dict) -> bool:
        # Apply any filters NOT used in the Firestore narrow (so multiple
        # equality filters all work even though Firestore only got one).
        if user_id_filter and d.get("userId") != user_id_filter:
            return False
        if action_filter and d.get("action") != action_filter:
            return False
        if coll_filter and d.get("targetCollection") != coll_filter:
            return False
        if target_id_filter and d.get("targetId") != target_id_filter:
            return False
        ts = d.get("timestamp") or ""
        if from_str and ts < from_str:
            return False
        if to_str and ts > to_str:
            return False
        if free_text:
            blob = " ".join(
                str(d.get(k, "")) for k in (
                    "action", "userId", "userName", "targetCollection",
                    "targetId",
                )
            ).lower()
            if free_text not in blob:
                return False
        return True

    def _stream(coll_name: str):
        out = []
        scanned = 0
        try:
            for doc in _build_query(coll_name).stream():
                scanned += 1
                d = doc.to_dict() or {}
                d["id"] = doc.id
                d.pop("server_ts", None)
                if not _matches_python_filters(d):
                    continue
                if include_archive and coll_name == ARCHIVE_COLLECTION:
                    d["archived"] = True
                out.append(d)
        except Exception as inner:
            logger.error(
                f"list_audit_logs: stream of {coll_name} failed: {inner!r}",
                exc_info=True,
            )
        logger.info(
            f"list_audit_logs: scanned={scanned} matched={len(out)} from {coll_name}"
        )
        # Sort newest-first by timestamp string. Entries without a timestamp
        # land at the bottom (treated as "" which sorts before any real ts).
        out.sort(key=lambda e: e.get("timestamp") or "", reverse=True)
        # Trim to requested limit AFTER sorting, so we always show the most
        # recent matches even when scanning more than `limit` underlying docs.
        return out[:limit]

    try:
        entries = _stream(AUDIT_COLLECTION)
        if include_archive:
            entries.extend(_stream(ARCHIVE_COLLECTION))
            # Re-sort the merged list by timestamp DESC and re-cap to limit
            entries.sort(key=lambda e: e.get("timestamp", ""), reverse=True)
            entries = entries[:limit]
        return jsonify(success=True, entries=entries, count=len(entries))
    except Exception as e:
        logger.error(f"list_audit_logs failed: {e}")
        return jsonify(success=False, message="Failed to load audit logs"), 500


# ─── Latest audit entry for a single document ─────────────────────────────
# Used by the inline "last action" footer on bill / room / booking detail
# views. Cheap to call — single composite-index lookup, capped at 1 doc.
@users_bp.route("/api/audit-logs/doc/<collection>/<doc_id>", methods=["GET"])
@requires_role("admin", "manager", "housekeeping")
def latest_audit_for_doc(collection: str, doc_id: str):
    """
    Return the most recent audit log entry for a single target document.
    Used by the "last action by ..." footer that decorates bill / room /
    booking modals via static/attribution.js.

    Fails OPEN: if the underlying Firestore query errors (most commonly a
    missing composite index on (targetCollection, targetId, server_ts)),
    we return HTTP 200 with `entry=None` rather than HTTP 500. The
    decoration is non-critical UX — it hides itself when there is no
    entry — so a 500 here was needlessly breaking the user's network
    console and making the bill / payment modal look like it had errored
    when in fact the modal itself loaded fine. The index URL is still
    logged on the server side so an admin can create the index when
    convenient; once the index exists, this endpoint returns entries
    normally with no caller changes required.
    """
    if not collection or not doc_id:
        return jsonify(success=False, message="collection and doc_id required"), 400
    try:
        q = (
            db.collection(AUDIT_COLLECTION)
            .where("targetCollection", "==", collection)
            .where("targetId", "==", str(doc_id))
            .order_by("server_ts", direction="DESCENDING")
            .limit(1)
        )
        entry = None
        for doc in q.stream():
            d = doc.to_dict() or {}
            d["id"] = doc.id
            d.pop("server_ts", None)
            entry = {
                "action": d.get("action"),
                "userId": d.get("userId"),
                "userName": d.get("userName"),
                "userRole": d.get("userRole"),
                "timestamp": d.get("timestamp"),
            }
            break
        return jsonify(success=True, entry=entry)
    except Exception as e:
        # Most common cause: missing composite index on
        # (targetCollection, targetId, server_ts). Firestore returns an
        # actionable error message containing the URL that auto-creates
        # the index when followed. Log it (warning, not error) so an
        # admin can act on it without the endpoint surfacing as a 500
        # to every consumer.
        logger.warning(
            f"latest_audit_for_doc({collection}/{doc_id}) "
            f"falling back to entry=None due to: {e}"
        )
        return jsonify(success=True, entry=None,
                       degraded=True,
                       message="audit lookup unavailable (index missing or error)")


# ─── Per-stay history ─────────────────────────────────────────────────────
# Returns the audit trail for a single stay, scoped to the room and the
# stay's time window. The audit log is the source of truth — querying it
# directly avoids every "no history yet" edge case caused by stale
# snapshot fields on the bill row (cleaning / inspection events that
# happen after checkout never make it back onto the bill doc).
#
# Inputs (query params):
#   room          required. Room number, matches audit_logs.targetId.
#   checkin       required. "YYYY-MM-DD HH:MM:SS" — lower bound of window.
#   checkout      optional. Upper bound; if absent, window runs to "now".
#   status        optional. "completed" extends the upper bound by 24h
#                 to capture post-stay housekeeping / inspection events.
#
# Why query params and not a bill_id path: active stays in the register
# carry a synthetic id ("active_<room>_<ts>") that doesn't resolve to a
# bills doc, and legacy stays may lack stay_id entirely. Reading the
# inputs the caller already has on hand makes the endpoint work for
# every row, regardless of stay phase.
#
# Allowed roles: anyone with register.view (admin + manager). The
# popover is reachable from the Register tab — same gate.
_STAY_RELEVANT_ACTIONS = frozenset({
    "room.checkin",
    "room.checkin_time_update",
    "room.checkout",
    "room.cleaning.complete",
    "room.inspection.approve",
    # Transfers carry attribution metadata.from_room → metadata.to_room so
    # the popover can show "Transferred from 210 to 217 by …". Including
    # them is also how stay_history discovers the previous room and
    # gathers events stamped against the old room id.
    "room.transfer",
})


def _normalise_ts(ts: str) -> str:
    """Pad short timestamps so string-compare is correct.

    Some bill rows store check-in as "YYYY-MM-DD HH:MM" (no seconds).
    Audit-log entries always have seconds. Right-pad with ":00" so range
    comparison doesn't accidentally include/exclude the boundary minute.
    """
    ts = (ts or "").strip()
    if not ts:
        return ts
    # 16 chars = "YYYY-MM-DD HH:MM"
    if len(ts) == 16 and ts[10] == " " and ts[13] == ":":
        return ts + ":00"
    return ts


@users_bp.route("/api/audit-logs/stay-history", methods=["GET"])
@requires_permission("register.view")
def stay_history():
    room = (request.args.get("room") or "").strip()
    checkin_time = _normalise_ts(request.args.get("checkin") or "")
    checkout_time = _normalise_ts(request.args.get("checkout") or "")
    status = (request.args.get("status") or "").strip().lower()

    if not room or not checkin_time:
        return jsonify(
            success=False,
            message="room and checkin query parameters are required",
        ), 400

    try:
        from datetime import datetime as _dt
        now_str = _dt.now(IST).strftime("%Y-%m-%d %H:%M:%S")

        # ─── Local helper: query relevant events for one room in a window ──
        # Single Firestore equality on targetId. A room's audit volume is
        # bounded over its lifetime, so a 500-doc cap with a Python-side
        # window filter is cheap and avoids new composite indices.
        def _query_room_events(target_room, lower_ts, upper_ts):
            q = (
                db.collection(AUDIT_COLLECTION)
                .where("targetCollection", "==", "rooms")
                .where("targetId", "==", target_room)
                .limit(500)
            )
            out = []
            for doc in q.stream():
                d = doc.to_dict() or {}
                ts = d.get("timestamp") or ""
                action = d.get("action") or ""
                if action not in _STAY_RELEVANT_ACTIONS:
                    continue
                if not ts or ts < lower_ts or ts > upper_ts:
                    continue
                out.append({
                    "action":    action,
                    "userId":    d.get("userId"),
                    "userName":  d.get("userName"),
                    "userRole":  d.get("userRole"),
                    "timestamp": ts,
                    # metadata is needed to follow the transfer chain
                    # (from_room / to_room) and to label the row.
                    "metadata":  d.get("metadata") or {},
                    "_room":     target_room,
                })
            return out

        # ─── Walk transfer chain backwards ──────────────────────────────
        # Transfers stamp ONE audit entry against the destination room
        # (target_id = new_room) carrying metadata.from_room. To gather
        # events that happened on prior rooms during this stay, follow
        # the chain back via from_room until either:
        #   - we hit a room with no transfer-in inside this stay's window
        #     (the original check-in room), or
        #   - we exceed a safety cap (defensive — protects against
        #     audit-log corruption forming a cycle).
        #
        # For each room we keep an upper-bound = the timestamp the stay
        # transferred OUT of that room (i.e. the transfer-in time on the
        # next room in the chain). For the current room the upper bound
        # is "now". The lower bound is always the stay's checkin time.
        all_events = []
        room_upper = now_str        # upper bound for the current room
        cur_room = room
        seen_rooms = set()
        TRANSFER_CHAIN_CAP = 5      # arbitrary; transfers are rare

        for _hop in range(TRANSFER_CHAIN_CAP):
            if cur_room in seen_rooms:
                break  # cycle guard
            seen_rooms.add(cur_room)

            # No lower bound on the query: the origin room's room-prep events
            # (cleaning / inspection) happen BEFORE this stay's check-in, so
            # we must look earlier than checkin_time to surface "Cleaned by"
            # and "Inspected by". The per-room trimming below removes anything
            # that belongs to a previous occupant.
            room_events = _query_room_events(cur_room, "", room_upper)

            # Look for a transfer INTO this room (target_id == cur_room and
            # action == room.transfer). The earliest such event in the
            # window is this stay's transfer-in. Events on cur_room before
            # that timestamp belong to whoever was here before us — drop
            # them. Events at or after belong to us.
            transfer_in = None
            for e in sorted(room_events, key=lambda x: x["timestamp"]):
                if (e["action"] == "room.transfer"
                        and e["timestamp"] >= checkin_time):
                    transfer_in = e
                    break

            if transfer_in:
                # Trim earlier events on cur_room (prior occupants).
                room_events = [e for e in room_events
                               if e["timestamp"] >= transfer_in["timestamp"]]
                all_events.extend(room_events)

                from_room = (transfer_in.get("metadata") or {}).get("from_room")
                if not from_room:
                    break
                # Recurse: query the previous room with upper = transfer-in ts.
                cur_room = str(from_room)
                room_upper = transfer_in["timestamp"]
            else:
                # ── Origin room — scope to THIS stay ──────────────────────
                # Window for this stay on its origin room:
                #   lower = the previous occupant's checkout (EXCLUSIVE) so we
                #           include the cleaning/inspection that prepped the
                #           room for THIS guest but NOT the prior checkout;
                #   start = this stay's check-in (the checkin_time param).
                # The previous checkout is the latest room.checkout strictly
                # before this stay's check-in.
                prev_checkout_ts = ""
                for e in room_events:
                    if (e["action"] == "room.checkout"
                            and e["timestamp"] < checkin_time
                            and e["timestamp"] > prev_checkout_ts):
                        prev_checkout_ts = e["timestamp"]
                room_events = [e for e in room_events
                               if e["timestamp"] > prev_checkout_ts]
                all_events.extend(room_events)
                break

        # ─── Build THIS stay's chain deterministically ─────────────────────
        # Final shape (oldest→newest), each at most once for prep:
        #   Cleaned → Inspected → Checked in → Time edited(*) → Shifted(*) →
        #   Checked out.  (*) time-edit and shift may legitimately repeat.
        #
        # The window is bounded on BOTH sides so neither the previous nor the
        # next stay can leak in:
        #   • anchor  = this stay's check-in (the first room.checkin at/after
        #               the checkin_time param).
        #   • end     = this stay's check-out (first room.checkout at/after the
        #               anchor); for an active stay, "now".
        #   • prep    = cleaning/inspection BEFORE the anchor. Only the LAST of
        #               each is kept — a room cleaned several times while idle
        #               must not produce duplicate "Cleaned by" rows, and the
        #               NEXT guest's prep (which happens AFTER this checkout)
        #               is excluded because we stop at `end`.
        all_events.sort(key=lambda e: e["timestamp"])

        anchor_ts = None
        for e in all_events:
            if e["action"] == "room.checkin" and e["timestamp"] >= checkin_time:
                anchor_ts = e["timestamp"]
                break
        if anchor_ts is None:
            anchor_ts = checkin_time

        end_ts = now_str
        for e in all_events:
            if e["action"] == "room.checkout" and e["timestamp"] >= anchor_ts:
                end_ts = e["timestamp"]
                break

        _CHAIN_ACTIONS = ("room.checkin", "room.checkin_time_update",
                          "room.transfer", "room.checkout")
        last_clean = None
        last_inspect = None
        chain = []
        for e in all_events:
            ts = e["timestamp"]
            act = e["action"]
            if ts < anchor_ts:
                # Prep window — keep only the most recent of each.
                if act == "room.cleaning.complete":
                    last_clean = e
                elif act == "room.inspection.approve":
                    last_inspect = e
            elif anchor_ts <= ts <= end_ts:
                if act == "room.checkin" and ts != anchor_ts:
                    break  # a different stay's check-in — stop
                if act in _CHAIN_ACTIONS:
                    chain.append(e)
                if act == "room.checkout" and ts == end_ts:
                    break  # this stay ends here; nothing after belongs to it

        entries = []
        if last_clean:
            entries.append(last_clean)
        if last_inspect:
            entries.append(last_inspect)
        entries.extend(chain)

        # Drop the internal `_room` helper field and return only the
        # public shape. metadata stays so the frontend can label
        # transfer rows with from_room / to_room.
        for e in entries:
            e.pop("_room", None)

        return jsonify(success=True, entries=entries)
    except Exception as e:
        logger.warning(
            f"stay_history(room={room!r}, checkin={checkin_time!r}) failed: {e}"
        )
        return jsonify(success=False, message="Failed to load stay history"), 500


# ─── Self-service password change — audit endpoint ────────────────────────
# The actual password update happens client-side via Firebase Auth
# (reauthenticate + updatePassword). The frontend POSTs here after success
# so the change is captured in audit_logs. Anyone signed in can call this
# for THEIR OWN account; the userId is taken from the verified token.
@users_bp.route("/api/auth/log-password-change", methods=["POST"])
@requires_role("admin", "manager", "housekeeping")
def log_password_change():
    user = g.current_user
    write_log(
        "auth.password_change",
        target_collection=USERS_COLLECTION,
        target_id=user["userId"],
        metadata={"self_service": True},
    )
    return jsonify(success=True)


# ─── User directory ────────────────────────────────────────────────────────
# Lightweight {userId: name, role, isActive} listing accessible to ALL roles.
# Used by the frontend attribution helpers to resolve userIds to display
# names on room cards, modals, register rows, etc. No PII beyond name + role
# (which staff already see on each other in the chip / dropdown).
#
# Distinct from /api/users which:
#   - is admin-only,
#   - returns full profile docs (timestamps, authUid, lastLoginAt, ...),
#   - is used by the admin console for management.
@users_bp.route("/api/user-directory", methods=["GET"])
@requires_role("admin", "manager", "housekeeping")
def user_directory():
    try:
        out = {}
        for doc in db.collection(USERS_COLLECTION).stream():
            d = doc.to_dict() or {}
            uid = doc.id
            out[uid] = {
                "name": d.get("name") or uid,
                "role": d.get("role") or "",
                "isActive": d.get("isActive", True),
            }
        return jsonify(success=True, users=out)
    except Exception as e:
        logger.error(f"user_directory failed: {e}")
        return jsonify(success=False, message="Failed to load user directory"), 500


# ─── "Who am I" — used by the frontend after login ────────────────────────
@users_bp.route("/api/auth/me", methods=["GET"])
@requires_role("admin", "manager", "housekeeping")
def whoami():
    """
    Returns the authenticated user's profile. Also stamps lastLoginAt.
    Frontend calls this once after sign-in to get the canonical role/name.
    """
    user = g.current_user
    try:
        doc_ref = db.collection(USERS_COLLECTION).document(user["userId"])
        snap = doc_ref.get()
        if not snap.exists:
            return jsonify(success=False, message="User profile missing"), 404
        profile = snap.to_dict() or {}
        if profile.get("isActive") is False:
            return jsonify(success=False, message="Account disabled"), 403
        # Best-effort lastLoginAt update — don't fail the request if it errors
        try:
            doc_ref.update({"lastLoginAt": _now()})
        except Exception:
            pass
        return jsonify(
            success=True,
            user={
                "userId": user["userId"],
                "name": profile.get("name", user["userId"]),
                "role": user["role"],
                "isActive": profile.get("isActive", True),
            },
        )
    except Exception as e:
        logger.error(f"whoami failed: {e}")
        return jsonify(success=False, message="Failed to load profile"), 500
