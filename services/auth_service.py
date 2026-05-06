"""
Authentication & authorization for the Flask backend.

Replaces the old PIN + manager-password system with Firebase ID-token
verification and role-based permission checks.

How it fits together:
  • Frontend obtains an ID token from Firebase Auth (sign-in with synthetic
    email like  "<userId>@cibara.internal").
  • Frontend attaches the token as  "Authorization: Bearer <token>"  on
    every API call.
  • verify_token() decodes & verifies the token using firebase_admin.auth.
  • The decoded token carries our custom claims  role  +  userId  +  name,
    set by  set_user_claims()  whenever a user is created or has their
    role changed.
  • @login_required and @requires_permission(perm) gate routes.

We intentionally do NOT store password hashes ourselves — Firebase Auth
holds them. That keeps the attack surface tiny.
"""

from __future__ import annotations

from functools import wraps
from typing import Optional, Callable

from flask import request, g, jsonify
from firebase_admin import auth as fb_auth

from config import logger
from services.permissions import role_has_permission, ROLES


# ─── Synthetic email helpers ──────────────────────────────────────────────
# Firebase Auth requires an email-shaped identifier. We never expose this
# to the user — the login form takes a username and we map to/from this
# domain transparently.
SYNTHETIC_EMAIL_DOMAIN = "cibara.internal"


def to_synthetic_email(user_id: str) -> str:
    """username → username@cibara.internal, lowercased & trimmed."""
    if not user_id:
        raise ValueError("user_id required")
    cleaned = str(user_id).strip().lower()
    if "@" in cleaned:
        # Caller already passed an email — assume synthetic and return as-is
        return cleaned
    return f"{cleaned}@{SYNTHETIC_EMAIL_DOMAIN}"


def from_synthetic_email(email: str) -> str:
    """Reverse mapping — returns the userId portion."""
    if not email:
        return ""
    return email.split("@", 1)[0].lower()


# ─── Token verification ───────────────────────────────────────────────────
def _extract_bearer_token() -> Optional[str]:
    """Pull the ID token from Authorization header or X-Auth-Token fallback."""
    header = request.headers.get("Authorization", "")
    if header.startswith("Bearer "):
        return header[7:].strip() or None
    # Fallback header for clients that can't set Authorization
    alt = request.headers.get("X-Auth-Token", "").strip()
    return alt or None


import re as _re
import time as _time

# Maximum clock skew (seconds) we'll tolerate before giving up.
# Beyond this, the user really does need to fix their clock.
_MAX_CLOCK_SKEW_SEC = 10
_SKEW_RE = _re.compile(r'(\d+)\s*<\s*(\d+)')


def verify_token(token: str) -> dict:
    """
    Verify the Firebase ID token and return the decoded claims dict.

    Raises ValueError on any failure — callers should catch and 401.

    Clock-skew tolerance:
      Firebase rejects tokens whose `iat` (issued-at) is in the future
      relative to the verifying server's clock. If the local clock is
      behind by a few seconds, EVERY request fails with "Token used too
      early" and the user is bounced to /login. We catch this specific
      error, sleep just long enough to let the local clock catch up
      (capped at 10 s), and retry ONCE. The dev gets a clear warning
      to sync their NTP.
    """
    if not token:
        raise ValueError("missing token")
    return _verify_with_skew_retry(token, allow_retry=True)


def _verify_with_skew_retry(token: str, allow_retry: bool) -> dict:
    try:
        return fb_auth.verify_id_token(token, check_revoked=True)
    except fb_auth.RevokedIdTokenError:
        logger.info("verify_token: token revoked (admin force-logout effect)")
        raise ValueError("token revoked")
    except fb_auth.ExpiredIdTokenError:
        logger.info("verify_token: token expired")
        raise ValueError("token expired")
    except fb_auth.InvalidIdTokenError as e:
        msg = str(e)
        # Clock-skew handling: format "Token used too early, NOW < IAT"
        if allow_retry and "Token used too early" in msg:
            m = _SKEW_RE.search(msg)
            if m:
                now_ts, iat_ts = int(m.group(1)), int(m.group(2))
                skew = iat_ts - now_ts + 1   # +1 second buffer
                if 0 < skew <= _MAX_CLOCK_SKEW_SEC:
                    logger.warning(
                        f"verify_token: clock skew detected — server is "
                        f"{skew}s behind Firebase. Sleeping and retrying. "
                        f"Please run 'w32tm /resync' (Windows) or "
                        f"'sudo ntpdate -s pool.ntp.org' (Linux) to "
                        f"sync the system clock and avoid this delay."
                    )
                    _time.sleep(skew)
                    return _verify_with_skew_retry(token, allow_retry=False)
                logger.warning(
                    f"verify_token: clock skew {skew}s exceeds max "
                    f"{_MAX_CLOCK_SKEW_SEC}s — fix the system clock"
                )
        logger.warning(f"verify_token: invalid token: {msg}")
        raise ValueError(f"invalid token: {msg}")
    except Exception as e:
        logger.warning(
            f"verify_token: unexpected {type(e).__name__}: {e}"
        )
        raise ValueError("token verification failed")


def load_current_user() -> Optional[dict]:
    """
    Inspect the current request, verify the token, and return a normalized
    user dict:  {userId, name, role, authUid, email}.  Returns None if no
    valid token is present.

    Diagnostic logging is intentionally verbose at INFO level — it's the
    only way to see WHY a route returned 401 without firing up the
    debugger. Reduce to DEBUG once auth is rock-solid.
    """
    token = _extract_bearer_token()
    if not token:
        # No header at all — common for /health, dev-mode GETs.
        return None
    try:
        claims = verify_token(token)
    except ValueError as ve:
        logger.info(f"load_current_user: token rejected ({ve})")
        return None

    # Pull userId from custom claim, then fall back to email prefix
    user_id = (
        claims.get("userId")
        or from_synthetic_email(claims.get("email", ""))
        or claims.get("uid")
    )
    role = claims.get("role")
    name = claims.get("name") or user_id

    if not user_id or not role:
        # Token is valid but missing our custom claims. The user account
        # exists in Firebase Auth but their custom claims (role, userId,
        # name) were never set, or got cleared. Most common cause:
        # someone manually edited the user in Firebase Console.
        # Recovery: re-run scripts/seed_admin or re-create the user
        # via the Admin Console (which calls set_user_claims).
        logger.warning(
            f"load_current_user: token valid but missing claims "
            f"(uid={claims.get('uid')!r} email={claims.get('email')!r} "
            f"userId={user_id!r} role={role!r}). "
            f"User exists in Firebase Auth but has no role custom claim. "
            f"Run scripts/seed_admin or re-stamp via /api/users."
        )
        return None
    if role not in ROLES:
        logger.warning(f"load_current_user: unknown role {role!r} for {user_id}")
        return None

    return {
        "userId": user_id,
        "name": name,
        "role": role,
        "authUid": claims.get("uid"),
        "email": claims.get("email"),
    }


# ─── Decorators ───────────────────────────────────────────────────────────
def login_required(fn: Callable) -> Callable:
    """Reject (401) if no valid token. Stashes user on  flask.g.current_user."""

    @wraps(fn)
    def wrapper(*args, **kwargs):
        user = load_current_user()
        if not user:
            return jsonify(success=False, message="Authentication required"), 401
        g.current_user = user
        return fn(*args, **kwargs)

    return wrapper


def requires_permission(permission: str) -> Callable:
    """
    Block the route unless the current user's role grants  permission.
    Returns 401 if not logged in, 403 if logged in but unauthorized.
    """

    def decorator(fn: Callable) -> Callable:
        @wraps(fn)
        def wrapper(*args, **kwargs):
            user = load_current_user()
            if not user:
                return jsonify(success=False, message="Authentication required"), 401
            if not role_has_permission(user["role"], permission):
                logger.info(
                    f"requires_permission: denied {user['userId']} ({user['role']}) "
                    f"→ {permission}"
                )
                return (
                    jsonify(
                        success=False,
                        message=f"Forbidden: missing permission '{permission}'",
                    ),
                    403,
                )
            g.current_user = user
            return fn(*args, **kwargs)

        return wrapper

    return decorator


def requires_role(*allowed_roles: str) -> Callable:
    """Coarser gate when the action maps cleanly to a role rather than a perm."""

    def decorator(fn: Callable) -> Callable:
        @wraps(fn)
        def wrapper(*args, **kwargs):
            user = load_current_user()
            if not user:
                return jsonify(success=False, message="Authentication required"), 401
            if user["role"] not in allowed_roles:
                return jsonify(success=False, message="Forbidden"), 403
            g.current_user = user
            return fn(*args, **kwargs)

        return wrapper

    return decorator


# ─── Custom-claims management ─────────────────────────────────────────────
def set_user_claims(auth_uid: str, *, user_id: str, name: str, role: str) -> None:
    """
    Set role / userId / name custom claims on a Firebase Auth user.

    These claims are baked into every ID token the user is issued, so the
    backend can read the role with zero Firestore lookups.

    NOTE: Existing tokens keep the old claims until they expire (≤1 h) or
    until the user is force-logged-out via revoke_user_tokens().
    """
    if role not in ROLES:
        raise ValueError(f"invalid role: {role!r}")
    fb_auth.set_custom_user_claims(
        auth_uid,
        {"role": role, "userId": user_id, "name": name},
    )


def revoke_user_tokens(auth_uid: str) -> None:
    """Force-logout: existing ID tokens become invalid on next verify call."""
    fb_auth.revoke_refresh_tokens(auth_uid)
