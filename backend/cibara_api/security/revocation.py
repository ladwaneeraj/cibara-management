"""
Immediate revocation for 15-minute access tokens.

Force-logout, password reset, role change and deactivation already revoke the
user's Firebase refresh tokens (legacy behaviour, unchanged). That stops the
NEXT refresh. To also stop the access token that is still alive (≤15 min),
we remember "tokens issued before T are dead" per Firebase uid, in memory.

Scope / trade-off: this map lives in one process. With Cloud Run
max-instances=1 (see cloudbuild.yaml) that is the whole service. If you scale
out, a revoked access token can survive on another instance until it expires
(≤15 min) — the refresh check against Firebase still ends the session.
"""
from __future__ import annotations

import threading
import time

_lock = threading.Lock()
_revoked_before: dict[str, int] = {}


def _shared():
    # Shared cache backend, or None (→ the in-process map below). Imported here
    # to avoid an import cycle and so this module works without the FastAPI core.
    try:
        from ..core import cache
        return cache.get_shared_backend()
    except Exception:
        return None


def _rev_ttl() -> int:
    # A revoke mark only matters while an access token minted before it can still
    # be alive, i.e. the access-token lifetime. After that it is safe to drop.
    try:
        from ..settings import get_settings
        return int(get_settings().ACCESS_TOKEN_TTL_SECONDS)
    except Exception:
        return 15 * 60


def revoke(auth_uid: str, at: int | None = None) -> None:
    if not auth_uid:
        return
    ts = int(at if at is not None else time.time())
    backend = _shared()
    if backend is not None:
        try:
            backend.set(f"rev:{auth_uid}", str(ts), _rev_ttl())
            return
        except Exception:  # pragma: no cover - Redis blip → in-process
            pass
    with _lock:
        _revoked_before[auth_uid] = ts


def is_revoked(auth_uid: str, issued_at: int) -> bool:
    # Tokens minted in the same second as the revocation are treated as dead
    # unless minted strictly after (a fresh login right after a force-logout
    # gets a later iat once the clock ticks).
    backend = _shared()
    if backend is not None:
        try:
            v = backend.get(f"rev:{auth_uid}")
            return v is not None and issued_at <= int(v)
        except Exception:  # pragma: no cover - Redis blip → in-process (fail-open)
            pass
    with _lock:
        cutoff = _revoked_before.get(auth_uid)
    return cutoff is not None and issued_at <= cutoff


def clear() -> None:
    with _lock:
        _revoked_before.clear()
    clear_families()


# ── refresh-token families (rotation + reuse detection) ───────────────────
#
# Every login starts a "family"; each refresh rotates the cookie to a new jti
# in the same family. A jti that was already rotated away is accepted for a
# short grace period (two tabs refreshing at once share one cookie jar), and
# after that, presenting it again means the cookie was copied: the whole
# family is killed, so both the thief and the real user must sign in again.
#
# Process-local, like the map above. After a restart the state is empty and
# the first refresh of an unknown family is ADOPTED (accepted and tracked
# from then on) — otherwise every deploy would sign everyone out. The
# Firebase revocation check in /refresh is unaffected by this.

FAMILY_GRACE_SECONDS = 30
_MAX_FAMILIES = 20_000

_families: dict[str, dict[str, float | None]] = {}   # fam → {jti: grace_deadline | None}
_family_seen: dict[str, float] = {}                   # fam → last activity
_dead_families: dict[str, float] = {}                 # fam → killed at


def _prune(now: float, idle_after: float) -> None:
    if len(_family_seen) + len(_dead_families) < _MAX_FAMILIES:
        return
    for fam, seen in list(_family_seen.items()):
        if now - seen > idle_after:
            _family_seen.pop(fam, None)
            _families.pop(fam, None)
    for fam, at in list(_dead_families.items()):
        if now - at > idle_after:
            _dead_families.pop(fam, None)


def rotate(fam: str, presented_jti: str, new_jti: str, *, idle_after: float = 7 * 86400,
           now: float | None = None) -> bool:
    """Accept `presented_jti` for `fam` and register `new_jti`.

    Returns False on reuse (the family is then dead)."""
    now = time.time() if now is None else now
    with _lock:
        if fam in _dead_families:
            return False
        _prune(now, idle_after)
        valid = _families.get(fam)
        if valid is None:                        # unknown → adopt (restart / first rotation)
            valid = _families[fam] = {}
        elif presented_jti not in valid or (valid[presented_jti] is not None
                                             and now > valid[presented_jti]):  # type: ignore[operator]
            _families.pop(fam, None)
            _family_seen.pop(fam, None)
            _dead_families[fam] = now
            return False
        if valid.get(presented_jti) is None:
            valid[presented_jti] = now + FAMILY_GRACE_SECONDS
        for j, dl in list(valid.items()):        # drop rotated jtis past their grace
            if dl is not None and now > dl:
                valid.pop(j, None)
        valid[new_jti] = None
        _family_seen[fam] = now
        return True


def register_family(fam: str, jti: str) -> None:
    """Called at login for the first jti of a family."""
    with _lock:
        _families[fam] = {jti: None}
        _family_seen[fam] = time.time()


def kill_family(fam: str) -> None:
    if not fam:
        return
    with _lock:
        _families.pop(fam, None)
        _family_seen.pop(fam, None)
        _dead_families[fam] = time.time()


def family_dead(fam: str) -> bool:
    with _lock:
        return fam in _dead_families


def clear_families() -> None:
    with _lock:
        _families.clear()
        _family_seen.clear()
        _dead_families.clear()
