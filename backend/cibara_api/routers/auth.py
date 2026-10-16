"""
/api/v2/auth — login, refresh, logout, me, password change.

Flow
────
login    : rate-limit → Firebase password check (Identity Toolkit) → read the
           Firebase user (disabled flag, role claims) → users/{id}.isActive →
           mint access JWT (body) + refresh JWT (HttpOnly cookie) + a Firebase
           custom token so the SPA can attach Firestore realtime listeners
           under the existing security rules.
refresh  : cookie → family alive + absolute cap (SESSION_MAX_DAYS) → Firebase
           user re-check (disabled / revoked since the refresh token was
           issued / role claims) → rotate cookie (reuse of a rotated cookie
           kills the family), new access. A Firebase outage answers 503 and
           keeps the cookie; only a real denial clears it.
logout   : clear cookie + kill the family (+ audit). Firebase client
           sign-out happens in the SPA.
password : verify current → update in Firebase → revoke all sessions.
"""
from __future__ import annotations

import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from firebase_admin import auth as fb_auth
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from ..core import audit
from ..core.ratelimit import enforce
from ..legacy import legacy_config, permissions_for_role
from ..security import passwords, revocation, tokens
from ..security.deps import ROLE_LABELS, Principal, client_ip, get_principal
from ..settings import get_settings

log = logging.getLogger("cibara_api.auth")
router = APIRouter(prefix="/api/v2/auth", tags=["auth"])


class LoginIn(BaseModel):
    user_id: str = Field(min_length=2, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class PasswordIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=6, max_length=128)


class SessionOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: dict
    permissions: list[str]
    firebase_custom_token: str | None = None


# ── helpers ───────────────────────────────────────────────────────────────

def _users_doc(user_id: str) -> dict | None:
    snap = legacy_config.db.collection("users").document(user_id).get()
    return snap.to_dict() if snap.exists else None


def _ist_now() -> str:
    return datetime.now(legacy_config.IST).strftime("%Y-%m-%d %H:%M:%S")


def _resolve_identity(auth_uid: str) -> tuple[tokens.TokenUser, object]:
    """Firebase user → TokenUser. Raises HTTPException when not allowed in."""
    try:
        rec = fb_auth.get_user(auth_uid)
    except fb_auth.UserNotFoundError as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "This account no longer exists.") from e
    except Exception as e:
        # Network / Firebase outage: NOT a reason to end the session. 503 →
        # the SPA keeps its cookie and retries instead of signing out.
        log.warning("get_user(%s) failed: %s", auth_uid, e)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                            "Sign-in service is unreachable. Please try again.") from e
    if getattr(rec, "disabled", False):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This account has been disabled. Contact an administrator.")
    claims = getattr(rec, "custom_claims", None) or {}
    role = claims.get("role")
    from services.auth_service import from_synthetic_email
    user_id = claims.get("userId") or from_synthetic_email(getattr(rec, "email", "") or "") or auth_uid
    if not role or role not in ROLE_LABELS:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Your account is not configured. Contact an administrator.")
    name = claims.get("name") or getattr(rec, "display_name", None) or user_id
    return tokens.TokenUser(user_id=user_id, auth_uid=auth_uid, role=role, name=name), rec


def _user_payload(u: tokens.TokenUser) -> dict:
    return {"userId": u.user_id, "name": u.name, "role": u.role,
            "roleLabel": ROLE_LABELS.get(u.role, u.role), "authUid": u.auth_uid}


def _set_refresh_cookie(resp: Response, token: str) -> None:
    s = get_settings()
    resp.set_cookie(
        s.REFRESH_COOKIE_NAME, token, max_age=s.REFRESH_TOKEN_TTL_SECONDS,
        httponly=True, secure=s.cookie_secure, samesite=s.REFRESH_COOKIE_SAMESITE,
        path=s.REFRESH_COOKIE_PATH,
    )


def _clear_refresh_cookie(resp: Response) -> None:
    s = get_settings()
    resp.delete_cookie(s.REFRESH_COOKIE_NAME, path=s.REFRESH_COOKIE_PATH,
                       secure=s.cookie_secure, httponly=True, samesite=s.REFRESH_COOKIE_SAMESITE)


def _custom_token(auth_uid: str) -> str | None:
    try:
        tok = fb_auth.create_custom_token(auth_uid)
        return tok.decode() if isinstance(tok, bytes) else str(tok)
    except Exception as e:  # realtime is an enhancement; never block login on it
        log.warning("create_custom_token failed: %s", e)
        return None


def _session(resp: Response, u: tokens.TokenUser, *, firebase: bool,
             presented: dict | None = None) -> SessionOut | None:
    """Mint access + rotated refresh. `presented` = claims of the refresh
    token being rotated (None at login). Returns None on refresh-token reuse."""
    access, ttl = tokens.mint_access(u)
    if presented is None:
        refresh, payload = tokens.mint_refresh(u)
        revocation.register_family(payload["fam"], payload["jti"])
    else:
        fam = presented.get("fam") or ""
        refresh, payload = tokens.mint_refresh(u, family=fam or None,
                                               auth_time=presented.get("auth_time", presented["iat"]))
        if fam and not revocation.rotate(fam, presented["jti"], payload["jti"],
                                         idle_after=get_settings().REFRESH_TOKEN_TTL_SECONDS):
            return None
    _set_refresh_cookie(resp, refresh)
    resp.headers["Cache-Control"] = "no-store"
    return SessionOut(access_token=access, expires_in=ttl, user=_user_payload(u),
                      permissions=permissions_for_role(u.role),
                      firebase_custom_token=_custom_token(u.auth_uid) if firebase else None)


# ── routes ────────────────────────────────────────────────────────────────

@router.post("/login", response_model=SessionOut)
async def login(body: LoginIn, request: Request, response: Response):
    s = get_settings()
    ip = client_ip(request)
    ua = request.headers.get("user-agent", "")
    uid_key = body.user_id.strip().lower()
    # Bucket by the Firebase identity, so "neeraj" and "neeraj@cibara.internal"
    # share one failed-attempt counter.
    lock_key = passwords.to_synthetic_email(uid_key)
    enforce(f"login-ip:{ip}", s.RATE_LIMIT_LOGIN_PER_IP_PER_MIN, 60,
            "Too many sign-in attempts. Please wait a minute and try again.")
    enforce(f"login-user:{lock_key}", s.RATE_LIMIT_LOGIN_PER_USER_PER_15MIN, 15 * 60,
            "Too many failed attempts for this account. Please wait 15 minutes.")
    if len(body.password) < 6:  # same short-circuit as static/login.js
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Incorrect User ID or password.")
    try:
        ok = await run_in_threadpool(passwords.verify_password, uid_key, body.password)
    except passwords.PasswordCheckError as e:
        await run_in_threadpool(audit.write, "auth.login_failed", user=None, client_ip=ip, user_agent=ua,
                                target_collection="users", target_id=uid_key, metadata={"code": e.code})
        raise HTTPException(e.status, e.message) from e

    u, _rec = await run_in_threadpool(_resolve_identity, ok.auth_uid)
    profile = await run_in_threadpool(_users_doc, u.user_id)
    if profile is not None and profile.get("isActive") is False:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "This account has been disabled. Contact an administrator.")

    def _stamp():
        try:
            if profile is not None:
                legacy_config.db.collection("users").document(u.user_id).update({"lastLoginAt": _ist_now()})
        except Exception as e:  # same best-effort as /api/auth/me
            log.info("lastLoginAt stamp failed: %s", e)
    await run_in_threadpool(_stamp)
    # A successful sign-in clears this account's failed-attempt window.
    from ..core.ratelimit import limiter
    limiter.reset(f"login-user:{lock_key}")
    out = _session(response, u, firebase=True)
    await run_in_threadpool(audit.write, "auth.login", user=u.as_legacy_user(), client_ip=ip,
                            user_agent=ua, target_collection="users", target_id=u.user_id)
    return out


def _deny(code: int, message: str) -> JSONResponse:
    resp = JSONResponse({"success": False, "message": message}, status_code=code)
    _clear_refresh_cookie(resp)
    resp.headers["Cache-Control"] = "no-store"
    return resp


@router.post("/refresh", response_model=SessionOut)
async def refresh(request: Request, response: Response, firebase: bool = False):
    s = get_settings()
    raw = request.cookies.get(s.REFRESH_COOKIE_NAME)
    if not raw:
        return _deny(401, "Not signed in")
    try:
        claims = tokens.decode(raw, tokens.REFRESH)
    except tokens.TokenError:
        return _deny(401, "Session expired. Please sign in again.")
    auth_uid, iat = claims["sub"], int(claims["iat"])
    fam = claims.get("fam") or ""
    if fam and revocation.family_dead(fam):
        return _deny(401, "Your session was ended. Please sign in again.")
    auth_time = int(claims.get("auth_time", iat))
    if tokens._now() - auth_time > s.SESSION_MAX_DAYS * 86400:
        return _deny(401, "Your session has expired. Please sign in again.")

    def _check():
        u, rec = _resolve_identity(auth_uid)
        valid_after_ms = getattr(rec, "tokens_valid_after_timestamp", 0) or 0
        if valid_after_ms and iat * 1000 < valid_after_ms:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Your session was ended. Please sign in again.")
        profile = _users_doc(u.user_id)
        if profile is not None and profile.get("isActive") is False:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Your account has been disabled.")
        return u
    try:
        u = await run_in_threadpool(_check)
    except HTTPException as e:
        if e.status_code >= 500:
            # Transient: keep the cookie, let the SPA retry.
            return JSONResponse({"success": False, "message": e.detail}, status_code=e.status_code,
                                headers={"Cache-Control": "no-store", "Retry-After": "5"})
        await run_in_threadpool(audit.write, "auth.refresh_denied", user=None, client_ip=client_ip(request),
                                user_agent=request.headers.get("user-agent", ""),
                                target_collection="users", metadata={"authUid": auth_uid, "reason": e.detail})
        return _deny(e.status_code, e.detail)
    if revocation.is_revoked(auth_uid, iat):
        return _deny(401, "Your session was ended. Please sign in again.")
    out = _session(response, u, firebase=firebase, presented=claims)
    if out is None:
        log.warning("refresh-token reuse detected for %s (family %s) — family revoked", u.user_id, fam)
        await run_in_threadpool(audit.write, "auth.refresh_denied", user=None, client_ip=client_ip(request),
                                user_agent=request.headers.get("user-agent", ""), target_collection="users",
                                metadata={"authUid": auth_uid, "reason": "refresh token reuse"})
        return _deny(401, "Your session was ended. Please sign in again.")
    return out


@router.post("/logout")
async def logout(request: Request, response: Response):
    s = get_settings()
    raw = request.cookies.get(s.REFRESH_COOKIE_NAME)
    _clear_refresh_cookie(response)
    if raw:
        try:
            c = tokens.decode(raw, tokens.REFRESH)
            revocation.kill_family(c.get("fam") or "")
            await run_in_threadpool(
                audit.write, "auth.logout",
                user={"userId": c.get("uid"), "name": c.get("uid"), "role": None},
                client_ip=client_ip(request), user_agent=request.headers.get("user-agent", ""),
                target_collection="users", target_id=c.get("uid"))
        except tokens.TokenError:
            pass
    return {"success": True}


@router.get("/me")
async def me(p: Principal = Depends(get_principal)):
    return {"success": True, "user": _user_payload(p.user), "permissions": permissions_for_role(p.role)}


@router.get("/firebase-token")
async def firebase_token(p: Principal = Depends(get_principal)):
    tok = await run_in_threadpool(_custom_token, p.user.auth_uid)
    if not tok:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Realtime sign-in unavailable")
    return {"success": True, "firebase_custom_token": tok}


@router.post("/password")
async def change_password(body: PasswordIn, request: Request, response: Response,
                          p: Principal = Depends(get_principal)):
    enforce(f"pw-change:{p.user.user_id}", 5, 15 * 60, "Too many attempts. Please wait 15 minutes.")
    if body.new_password == body.current_password:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "New password must be different.")
    try:
        await run_in_threadpool(passwords.verify_password, p.user.user_id, body.current_password)
    except passwords.PasswordCheckError as e:
        msg = "Current password is incorrect." if e.status == 401 else e.message
        raise HTTPException(e.status if e.status != 401 else 400, msg) from e

    def _apply():
        fb_auth.update_user(p.user.auth_uid, password=body.new_password)
        fb_auth.revoke_refresh_tokens(p.user.auth_uid)
    await run_in_threadpool(_apply)
    revocation.revoke(p.user.auth_uid)
    _clear_refresh_cookie(response)
    # Same action + metadata the legacy self-service flow writes.
    await run_in_threadpool(audit.write, "auth.password_change", user=p.user.as_legacy_user(),
                            client_ip=p.client_ip, user_agent=p.user_agent,
                            target_collection="users", target_id=p.user.user_id,
                            metadata={"self_service": True})
    return {"success": True, "message": "Password changed. Please sign in with your new password."}
