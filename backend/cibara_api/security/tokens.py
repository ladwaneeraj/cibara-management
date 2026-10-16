"""
Access / refresh token minting and verification (HS256, PyJWT).

Access token  — 15 min, sent as `Authorization: Bearer …`, kept in memory by
                the SPA (never in localStorage).
Refresh token — 7 days, HttpOnly + SameSite=Strict cookie scoped to
                /api/v2/auth, rotated on every use.

Claims carry what the legacy `load_current_user()` needs (userId, role, name,
Firebase uid) so neither the new endpoints nor the bridged Flask routes ever
need a network round-trip to authenticate a request. That round-trip
(`verify_id_token(check_revoked=True)`, run up to 4× per legacy request) was
one of the biggest sources of latency in the old stack.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass

import jwt

from ..settings import get_settings

ACCESS = "access"
REFRESH = "refresh"
ALGORITHM = "HS256"


class TokenError(Exception):
    """Raised for any invalid / expired / wrong-type token."""


@dataclass(frozen=True)
class TokenUser:
    user_id: str      # app userId (e.g. "neeraj")
    auth_uid: str     # Firebase Auth uid
    role: str
    name: str
    iat: int = 0

    @property
    def email(self) -> str:
        return f"{self.user_id}@cibara.internal"

    def as_legacy_user(self) -> dict:
        """Same shape services.auth_service.load_current_user() returns."""
        return {"userId": self.user_id, "name": self.name, "role": self.role,
                "authUid": self.auth_uid, "email": self.email}


def _now() -> int:
    return int(time.time())


def mint_access(user: TokenUser) -> tuple[str, int]:
    s = get_settings()
    now = _now()
    exp = now + s.ACCESS_TOKEN_TTL_SECONDS
    payload = {
        "iss": s.JWT_ISSUER, "typ": ACCESS, "sub": user.auth_uid,
        "uid": user.user_id, "role": user.role, "name": user.name,
        "iat": now, "nbf": now - 5, "exp": exp, "jti": uuid.uuid4().hex,
    }
    return jwt.encode(payload, s.JWT_SECRET, algorithm=ALGORITHM), s.ACCESS_TOKEN_TTL_SECONDS


def mint_refresh(user: TokenUser, family: str | None = None,
                 auth_time: int | None = None) -> tuple[str, dict]:
    """`auth_time` is when the family's password sign-in happened; it is
    carried through every rotation so SESSION_MAX_DAYS can cap the family."""
    s = get_settings()
    now = _now()
    payload = {
        "iss": s.JWT_ISSUER, "typ": REFRESH, "sub": user.auth_uid, "uid": user.user_id,
        "iat": now, "exp": now + s.REFRESH_TOKEN_TTL_SECONDS,
        "jti": uuid.uuid4().hex, "fam": family or uuid.uuid4().hex,
        "auth_time": int(auth_time if auth_time is not None else now),
    }
    return jwt.encode(payload, s.JWT_SECRET, algorithm=ALGORITHM), payload


def is_our_token(token: str) -> bool:
    """Cheap header check: HS256 tokens are ours; Firebase ID tokens are RS256."""
    try:
        return jwt.get_unverified_header(token).get("alg") == ALGORITHM
    except jwt.PyJWTError:
        return False


def decode(token: str, expected_type: str) -> dict:
    s = get_settings()
    try:
        claims = jwt.decode(
            token, s.JWT_SECRET, algorithms=[ALGORITHM], issuer=s.JWT_ISSUER,
            options={"require": ["exp", "iat", "sub", "typ", "jti"]}, leeway=10,
        )
    except jwt.ExpiredSignatureError as e:
        raise TokenError("token expired") from e
    except jwt.PyJWTError as e:
        raise TokenError(f"invalid token: {e}") from e
    if claims.get("typ") != expected_type:
        raise TokenError("wrong token type")
    return claims


def user_from_access(token: str) -> TokenUser:
    c = decode(token, ACCESS)
    if not c.get("uid") or not c.get("role"):
        raise TokenError("token missing claims")
    return TokenUser(user_id=c["uid"], auth_uid=c["sub"], role=c["role"],
                     name=c.get("name") or c["uid"], iat=int(c["iat"]))
