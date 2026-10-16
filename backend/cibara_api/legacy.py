"""
The bridge to the existing Flask application.

The legacy code (config.py, services/, routes/, app.py) is imported UNCHANGED.
Nothing in those files is edited by the migration. This module:

1. Imports the Flask app (which initialises Firebase exactly as before).
2. Teaches the legacy auth layer to accept the new JWT access tokens, by
   wrapping `services.auth_service.verify_token`. Every legacy decorator
   (`@requires_permission`, `@requires_role`, the global `require_auth`
   gate, `load_current_user()` calls inside routes and services) funnels
   through that one function, so the wrap reaches all of them. Firebase ID
   tokens from the legacy UI still verify through the original function.
3. Adds a permission gate for legacy routes that have none of their own
   (security/legacy_hardening.py).
4. Exposes the Flask app as a WSGI callable for the catch-all mount, and
   `call_legacy()` for the typed /api/v2 facades to run a legacy route
   in-process.
"""
from __future__ import annotations

import logging
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterable

from .core import metrics
from .security import revocation, tokens
from .settings import REPO_ROOT, get_settings

log = logging.getLogger("cibara_api.legacy")

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

metrics.instrument_google_client()

import app as _legacy_module  # noqa: E402  (root app.py — the Flask app)
import config as legacy_config  # noqa: E402
from flask import g, jsonify, request  # noqa: E402
from services import auth_service as _auth  # noqa: E402
from services import permissions as legacy_permissions  # noqa: E402

flask_app = _legacy_module.app

# ─── 2. auth bridge ────────────────────────────────────────────────────────

_original_verify_token = _auth.verify_token


def _bridged_verify_token(token: str) -> dict:
    """Accept our HS256 access tokens; defer everything else to Firebase.

    Returns the same claims shape firebase_admin.verify_id_token returns so
    the untouched `load_current_user()` builds the identical user dict.
    """
    if token and tokens.is_our_token(token):
        try:
            user = tokens.user_from_access(token)
        except tokens.TokenError as e:
            # ValueError → legacy gate answers 401 "Session expired, retrying",
            # the SPA refreshes and retries with the same X-Op-Id.
            raise ValueError(str(e)) from e
        if revocation.is_revoked(user.auth_uid, user.iat):
            raise ValueError("token revoked")
        return {"uid": user.auth_uid, "email": user.email, "userId": user.user_id,
                "role": user.role, "name": user.name}
    return _original_verify_token(token)


_auth.verify_token = _bridged_verify_token


# ─── 3. hardening hook (runs after the legacy global auth gate) ────────────

from .security.legacy_hardening import required_permission  # noqa: E402


@flask_app.before_request
def _cibara_api_hardening():
    s = get_settings()
    if not s.LEGACY_RBAC_HARDENING:
        return None
    user = getattr(g, "current_user", None)
    if not user:
        return None  # API-key / public paths: unchanged legacy behaviour
    body = request.get_json(silent=True) if request.is_json else None
    perm = required_permission(request.method, request.path, body)
    if perm and not legacy_permissions.role_has_permission(user.get("role"), perm):
        log.info("hardening: denied %s (%s) %s %s → %s", user.get("userId"), user.get("role"),
                 request.method, request.path, perm)
        return jsonify(success=False, message=f"Forbidden: missing permission '{perm}'"), 403
    return None


# ─── 3b. no anonymous reads on Cloud Run ───────────────────────────────────
#
# Legacy require_auth has a "dev mode": with API_KEY unset, any anonymous GET
# is allowed. That is meant for localhost; on Cloud Run it would expose every
# read endpoint. This hook (registered after require_auth, so it only sees
# requests require_auth let through) closes it when running on Cloud Run.

import os as _os  # noqa: E402
import re as _re  # noqa: E402

_INGEST_PATHS = ("/mmt/ingest", "/mmt/create_test_booking", "/agoda/ingest", "/bank/settlements/ingest")


@flask_app.before_request
def _cibara_api_no_anonymous_reads():
    if not get_settings().on_cloud_run or _os.environ.get("API_KEY"):
        return None
    if getattr(g, "current_user", None):
        return None
    path = request.path
    if path in _legacy_module._PUBLIC_EXACT or path.startswith(_legacy_module._PUBLIC_PREFIXES):
        return None
    if path in _INGEST_PATHS:
        return None  # shared-secret callers; require_auth already decided
    return jsonify(success=False, message="Unauthorized"), 401


# ─── 3c. classic-UI page must not hand out the integration API key ────────
#
# templates/index.html embeds API_KEY into the page ("{{ api_key }}") and the
# page is public (it boots, then static/auth.js redirects to /login). Anyone
# could read the key from the HTML. Signed-in requests carry a Firebase or
# JWT bearer token, which require_auth checks BEFORE the API key, so the
# classic UI does not need the key. Redacted here without touching the
# template. Integrations that send X-API-Key keep working.

@flask_app.after_request
def _cibara_api_redact_api_key(resp):
    key = _os.environ.get("API_KEY", "")
    if (len(key) >= 8 and request.path == "/" and resp.mimetype == "text/html"
            and not resp.direct_passthrough):
        data = resp.get_data()
        kb = key.encode()
        if kb in data:
            resp.set_data(data.replace(kb, b""))
    return resp


# One-time nudge: the legacy integration key was historically readable from the
# classic page (CLAUDE.md §10). It is redacted now, but it should be rotated or,
# if no integration sends X-API-Key, unset entirely.
if _os.environ.get("API_KEY"):
    import logging as _logging
    _logging.getLogger("cibara_api").warning(
        "API_KEY is set (legacy integration key). It is redacted from the "
        "classic page, but rotate it (it may have been exposed historically — "
        "CLAUDE.md §10) or unset it if no integration uses the X-API-Key header."
    )


# ─── 3d. admin actions in the classic UI also end live JWT sessions ───────
#
# Legacy force-logout / reset-password / role change / deactivate revoke the
# user's Firebase refresh tokens. Our 15-minute access tokens are verified
# locally, so they also need the in-memory cutoff. Doing it here covers both
# the /api/v2 admin facades and the classic Users screen.

_USER_ACTION = _re.compile(r"^/api/users/([^/]+)(/reset-password|/force-logout)?$")


@flask_app.after_request
def _cibara_api_revoke_on_admin_action(resp):
    m = _USER_ACTION.match(request.path)
    if not m or resp.status_code >= 300:
        return resp
    suffix = m.group(2)
    if request.method == "PATCH" and not suffix:
        body = request.get_json(silent=True) or {}
        if "role" not in body and body.get("isActive") is not False:
            return resp
    elif not ((request.method == "POST" and suffix) or (request.method == "DELETE" and not suffix)):
        return resp
    try:
        out = resp.get_json(silent=True)
        if isinstance(out, dict) and out.get("success") is False:
            return resp
        snap = legacy_config.db.collection("users").document(m.group(1)).get()
        uid = (snap.to_dict() or {}).get("authUid") if snap.exists else None
        if uid:
            revocation.revoke(uid)
    except Exception as e:  # never break the legacy response
        log.warning("local revocation after %s %s failed: %s", request.method, request.path, e)
    return resp


# ─── 4a. WSGI wrapper for the catch-all mount ─────────────────────────────

_PATH_REWRITES = {"/legacy": "/", "/legacy/": "/"}


class LegacyWSGI:
    """Path rewrite (/legacy → Flask "/") plus per-request Firestore metrics."""

    def __init__(self, wsgi_app):
        self.wsgi_app = wsgi_app

    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO", "")
        if path in _PATH_REWRITES:
            environ["PATH_INFO"] = _PATH_REWRITES[path]
        counter, token = metrics.start()
        t0 = time.perf_counter()
        status_holder = {"code": 500}

        def _start_response(status, headers, exc_info=None):
            status_holder["code"] = int(status.split(" ", 1)[0])
            headers = list(headers) + [("X-Firestore-Reads", str(counter.reads)),
                                       ("X-Firestore-Writes", str(counter.writes))]
            return start_response(status, headers, exc_info)

        try:
            result = self.wsgi_app(environ, _start_response)
            # Buffer: Flask responses here are small JSON/HTML; this lets the
            # counter include reads done while the body is generated.
            body = b"".join(result)
            if hasattr(result, "close"):
                result.close()
            return [body]
        finally:
            ms = (time.perf_counter() - t0) * 1000
            # Unknown paths (scanners) would otherwise each get a registry row.
            key = "legacy 404" if status_holder["code"] == 404 else (
                "legacy " + environ.get("REQUEST_METHOD", "GET") + " " + metrics.normalise_path(path))
            metrics.record(key, ms, status_holder["code"], counter.reads, counter.writes)
            metrics.stop(token)


legacy_wsgi = LegacyWSGI(flask_app.wsgi_app)


# ─── 5. invoice layout v2 (presentation only; INVOICE_LAYOUT=legacy to undo) ──

from .invoice import install as _install_invoice  # noqa: E402

_install_invoice()


# ─── 4b. in-process call for typed facades ────────────────────────────────

@dataclass
class LegacyResponse:
    status: int
    json: Any
    body: bytes
    headers: dict

    @property
    def ok(self) -> bool:
        if self.status >= 400:
            return False
        if isinstance(self.json, dict) and self.json.get("success") is False:
            return False
        return True


_FORWARD_HEADERS = ("Authorization", "X-Op-Id", "X-Force-Duplicate", "User-Agent", "X-Forwarded-For")


def call_legacy(method: str, path: str, *, headers: dict | None = None, json: Any = None,
                query: dict | None = None, data: Any = None, content_type: str | None = None,
                client_ip: str = "127.0.0.1") -> LegacyResponse:
    """Run one legacy route in-process (blocking — call via a thread).

    Goes through the full Flask stack: global auth gate (our JWT via the
    bridge), hardening hook, decorators, duplicate-submit guard, handler.
    """
    fwd = {k: v for k, v in (headers or {}).items() if k in _FORWARD_HEADERS and v}
    client = flask_app.test_client()
    kwargs: dict = {"headers": fwd, "query_string": query or None,
                    "environ_base": {"REMOTE_ADDR": client_ip}}
    if json is not None:
        kwargs["json"] = json
    if data is not None:
        kwargs["data"] = data
        if content_type:
            kwargs["content_type"] = content_type
    resp = client.open(path, method=method.upper(), **kwargs)
    body = resp.get_data()
    parsed = None
    if resp.mimetype == "application/json":
        try:
            parsed = resp.get_json(silent=True)
        except Exception:  # pragma: no cover
            parsed = None
    return LegacyResponse(resp.status_code, parsed, body, dict(resp.headers))


@contextmanager
def legacy_context(user: dict | None, *, path: str = "/", headers: dict | None = None,
                   client_ip: str = "127.0.0.1"):
    """Push a Flask request context with g.current_user set.

    Lets native endpoints call legacy helpers that read flask.g / request
    (role_filters.clamp_date_range, audit_log.write_log, attribution_update…)
    and get exactly the attribution they would inside a legacy route.
    """
    hdrs = {k: v for k, v in (headers or {}).items() if k in ("User-Agent", "X-Forwarded-For") and v}
    with flask_app.test_request_context(path, headers=hdrs, environ_base={"REMOTE_ADDR": client_ip}):
        g.current_user = user
        yield


def permissions_for_role(role: str) -> list[str]:
    return sorted(legacy_permissions.permissions_for_role(role))


def role_has_permission(role: str, perm: str) -> bool:
    return legacy_permissions.role_has_permission(role, perm)


ROLES: Iterable[str] = legacy_permissions.ROLES


# ─── 6. startup check: is the Storage bucket there? ───────────────────────
# Invoice PDFs, room photos and ID documents are uploaded to the default
# Firebase Storage bucket. If it was never created (new project), every
# upload fails with "404 The specified bucket does not exist" deep inside a
# checkout. Say so once, clearly, at startup.

def _check_storage_bucket() -> None:
    try:
        from firebase_admin import storage as _fb_storage
        bucket = _fb_storage.bucket()
        exists = getattr(bucket, "exists", None)
        if callable(exists) and not exists():
            log.error("Storage bucket %r does not exist — invoice PDFs and photos cannot be saved. "
                      "Create it in Firebase console → Storage → Get started (or set "
                      "FIREBASE_STORAGE_BUCKET to the right name).", bucket.name)
    except Exception as e:  # permission / network: informational only
        log.info("storage bucket check skipped: %s", e)


import threading as _threading  # noqa: E402

_threading.Thread(target=_check_storage_bucket, name="storage-check", daemon=True).start()
