"""FastAPI dependencies: authentication, RBAC, request context."""
from __future__ import annotations

from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request, status

from ..settings import get_settings
from . import revocation, tokens

# UI-facing labels. Internal role ids are unchanged (Firestore rules and
# custom claims depend on them): housekeeping is shown as "Staff", and the
# fourth role, "Guest", is the QR guest portal session (anonymous Firebase
# auth + room/mobile proof, enforced by firestore.rules — no JWT involved).
ROLE_LABELS = {"admin": "Admin", "manager": "Manager", "housekeeping": "Staff"}


@dataclass
class Principal:
    user: tokens.TokenUser
    token: str
    client_ip: str
    user_agent: str

    @property
    def role(self) -> str:
        return self.user.role

    def can(self, perm: str) -> bool:
        from ..legacy import role_has_permission
        return role_has_permission(self.user.role, perm)

    def legacy_headers(self, request: Request | None = None) -> dict:
        h = {"Authorization": f"Bearer {self.token}", "User-Agent": self.user_agent,
             "X-Forwarded-For": self.client_ip}
        if request is not None:
            for k in ("X-Op-Id", "X-Force-Duplicate"):
                v = request.headers.get(k)
                if v:
                    h[k] = v
        return h


def client_ip(request: Request) -> str:
    """Real client IP behind Cloud Run's front end.

    The front end appends the address it saw to X-Forwarded-For, so with
    TRUSTED_PROXY_HOPS=1 the right-most entry is trustworthy; anything to its
    left is client-supplied and ignored.
    """
    hops = max(0, get_settings().TRUSTED_PROXY_HOPS)
    xff = [p.strip() for p in request.headers.get("x-forwarded-for", "").split(",") if p.strip()]
    if hops and len(xff) >= hops:
        return xff[-hops]
    return request.client.host if request.client else "unknown"


def _unauthorized(msg: str) -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, detail=msg,
                         headers={"WWW-Authenticate": "Bearer"})


async def get_principal(request: Request) -> Principal:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise _unauthorized("Authentication required")
    token = header[7:].strip()
    try:
        user = tokens.user_from_access(token)
    except tokens.TokenError as e:
        raise _unauthorized("Session expired" if "expired" in str(e) else "Invalid token") from e
    if revocation.is_revoked(user.auth_uid, user.iat):
        raise _unauthorized("Session revoked")
    p = Principal(user=user, token=token, client_ip=client_ip(request),
                  user_agent=request.headers.get("user-agent", ""))
    request.state.principal = p
    return p


def require_permission(perm: str):
    async def dep(p: Principal = Depends(get_principal)) -> Principal:
        if not p.can(perm):
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail=f"Forbidden: missing permission '{perm}'")
        return p
    return dep


def require_any_permission(*perms: str):
    async def dep(p: Principal = Depends(get_principal)) -> Principal:
        if not any(p.can(x) for x in perms):
            raise HTTPException(status.HTTP_403_FORBIDDEN,
                                detail=f"Forbidden: needs one of {', '.join(perms)}")
        return p
    return dep


def require_role(*roles: str):
    async def dep(p: Principal = Depends(get_principal)) -> Principal:
        if p.role not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Forbidden")
        return p
    return dep
