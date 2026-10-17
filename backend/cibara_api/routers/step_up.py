"""
POST /api/v2/authorize — step-up re-authentication.

The acting admin re-enters their own password to obtain a short-lived,
single-use token that clears the step-up gate (security/step_up.py) for one
money-leaving action. Every attempt is audited (success authz.step_up, failure
authz.denied) and rate-limited with the login limits.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from ..core import audit
from ..core.ratelimit import enforce
from ..security import passwords, step_up
from ..security.deps import Principal, get_principal
from ..settings import get_settings

log = logging.getLogger("cibara_api.stepup")
router = APIRouter(prefix="/api/v2", tags=["auth"])

_ACTIONS = {"cancel_bill", "credit_note", "bad_debt", "writeoff", "discount", "refund"}


class AuthorizeIn(BaseModel):
    action: str = Field(min_length=2, max_length=32)
    amount: int = Field(0, ge=0)
    password: str = Field(min_length=1, max_length=128)
    target: str = Field("", max_length=128)


@router.post("/authorize", include_in_schema=False)
async def authorize(body: AuthorizeIn, request: Request, p: Principal = Depends(get_principal)):
    s = get_settings()
    uid = p.user.user_id
    # Reuse the login limits, per user and per IP. Audited either way below.
    enforce(f"stepup-user:{uid}", s.RATE_LIMIT_LOGIN_PER_USER_PER_15MIN, 15 * 60,
            "Too many attempts. Please wait a few minutes.")
    enforce(f"stepup-ip:{p.client_ip}", s.RATE_LIMIT_LOGIN_PER_IP_PER_MIN, 60)

    action = body.action.strip().lower()
    legacy_user = p.user.as_legacy_user()

    def _deny(reason: str, code: str = "") -> None:
        audit.write("authz.denied", user=legacy_user, client_ip=p.client_ip,
                    user_agent=p.user_agent,
                    metadata={"action": action, "amount": body.amount,
                              "reason": reason, **({"code": code} if code else {})})

    if action not in _ACTIONS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown action.")

    # Step-up is admin confirmation (the gated actions are admin-only anyway).
    if p.role != "admin":
        await run_in_threadpool(_deny, "not_admin")
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only an admin can authorize this action.")

    try:
        await run_in_threadpool(passwords.verify_password, uid, body.password)
    except passwords.PasswordCheckError as e:
        await run_in_threadpool(_deny, "bad_password", e.code)
        msg = "Password is incorrect." if e.status == 401 else e.message
        raise HTTPException(e.status if e.status != 401 else 400, msg) from e

    token = step_up.store.issue(uid, action, body.amount, body.target, s.STEP_UP_TOKEN_TTL_SECONDS)
    await run_in_threadpool(
        audit.write, "authz.step_up", user=legacy_user, client_ip=p.client_ip,
        user_agent=p.user_agent,
        metadata={"action": action, "amount": body.amount, "target": body.target},
    )
    return {"success": True, "token": token, "expires_in": s.STEP_UP_TOKEN_TTL_SECONDS}
