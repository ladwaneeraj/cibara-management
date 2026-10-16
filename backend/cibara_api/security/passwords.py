"""
Password verification against Firebase Auth (Identity Toolkit REST API).

Firebase Auth stays the password store — exactly as before — so every existing
user keeps their password and nothing new is stored in Firestore. The server
calls `accounts:signInWithPassword` with the same synthetic email the old
login page used (`<userId>@cibara.internal`) and only uses the result to learn
the Firebase uid. The returned Firebase ID token is discarded.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

from ..settings import get_settings

log = logging.getLogger("cibara_api.passwords")

# Firebase error codes → (http status, user-facing message). Messages mirror
# static/login.js friendlyAuthError so operators see the same wording.
_ERRORS = {
    "INVALID_LOGIN_CREDENTIALS": (401, "Incorrect User ID or password."),
    "INVALID_PASSWORD": (401, "Incorrect User ID or password."),
    "EMAIL_NOT_FOUND": (401, "Incorrect User ID or password."),
    "INVALID_EMAIL": (401, "Incorrect User ID or password."),
    "USER_DISABLED": (403, "This account has been disabled. Contact an administrator."),
    "TOO_MANY_ATTEMPTS_TRY_LATER": (429, "Too many failed attempts. Please wait a minute and try again."),
}


class PasswordCheckError(Exception):
    def __init__(self, code: str, status: int, message: str):
        super().__init__(message)
        self.code = code
        self.status = status
        self.message = message


@dataclass
class PasswordOk:
    auth_uid: str


def _api_key() -> str:
    s = get_settings()
    if s.FIREBASE_WEB_API_KEY:
        return s.FIREBASE_WEB_API_KEY
    from config import FIREBASE_WEB_CONFIG  # legacy env toggle, unchanged
    return FIREBASE_WEB_CONFIG.get("apiKey", "")


def to_synthetic_email(user_id: str) -> str:
    # Same rule as services.auth_service.to_synthetic_email / static/login.js.
    from services.auth_service import to_synthetic_email as legacy
    return legacy(user_id)


def verify_password(user_id: str, password: str) -> PasswordOk:
    """Raise PasswordCheckError on failure. Blocking (call from a thread)."""
    s = get_settings()
    key = _api_key()
    if not key:
        raise PasswordCheckError("CONFIG", 500, "Sign-in is not configured. Contact your administrator.")
    headers = {"Content-Type": "application/json"}
    if s.PUBLIC_ORIGIN:
        headers["Referer"] = s.PUBLIC_ORIGIN.rstrip("/") + "/"
    try:
        r = httpx.post(
            f"{s.IDENTITY_TOOLKIT_URL}/accounts:signInWithPassword",
            params={"key": key},
            json={"email": to_synthetic_email(user_id), "password": password, "returnSecureToken": True},
            headers=headers, timeout=10.0,
        )
    except httpx.HTTPError as e:
        log.warning("identity toolkit unreachable: %s", e)
        raise PasswordCheckError("NETWORK", 503, "Sign-in service unreachable. Try again.") from e
    if r.status_code == 200:
        uid = r.json().get("localId")
        if not uid:
            raise PasswordCheckError("BAD_RESPONSE", 502, "Sign-in failed. Please try again.")
        return PasswordOk(auth_uid=uid)
    try:
        code = (r.json().get("error") or {}).get("message", "UNKNOWN")
    except ValueError:
        code = "UNKNOWN"
    code = code.split(" ")[0].split(":")[0]
    status, msg = _ERRORS.get(code, (401, "Sign-in failed. Please try again."))
    if code not in _ERRORS:
        log.warning("identity toolkit error %s (%s)", code, r.status_code)
    raise PasswordCheckError(code, status, msg)
