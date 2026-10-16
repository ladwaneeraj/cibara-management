"""
Shared cache backend (Phase 3) — off-process state for multi-instance safety.

OFF by default: with no REDIS_URL the whole app keeps its current in-memory
behaviour (the intended single Cloud Run instance), and get_shared_backend()
returns None so each consumer uses its existing in-process store. Set REDIS_URL
to move the rate-limit counters, access-token revocation marks and step-up
tokens into Redis, so the service is safe to run with >1 instance. Reversible:
unset REDIS_URL and the in-memory paths take over again.

Still process-local by design (documented follow-ups, not moved here): the
refresh-token FAMILIES rotation/reuse detection (needs atomic multi-key
semantics) and the legacy duplicate-submit guard. A Redis blip never hard-fails
a request: callers treat backend errors as "degrade to the in-process path /
allow", since the Firebase refresh check remains the security backstop.
"""
from __future__ import annotations

import logging
import threading
import time
from functools import lru_cache
from typing import Protocol

log = logging.getLogger("cibara_api.cache")


class CacheBackend(Protocol):
    def get(self, key: str) -> str | None: ...
    def set(self, key: str, value: str, ttl_s: int) -> None: ...
    def getdel(self, key: str) -> str | None: ...
    def delete(self, key: str) -> None: ...
    def incr(self, key: str, ttl_s: int) -> int: ...
    def healthy(self) -> bool: ...


class MemoryBackend:
    """In-process KV + counters with per-key expiry. The reference implementation
    the Redis backend mirrors; used in tests and as a safe fallback."""

    def __init__(self) -> None:
        self._kv: dict[str, tuple[str, float]] = {}        # key -> (value, expiry)
        self._ctr: dict[str, tuple[int, float]] = {}       # key -> (count, expiry)
        self._lock = threading.Lock()

    @staticmethod
    def _dead(exp: float) -> bool:
        return time.monotonic() > exp

    def get(self, key: str) -> str | None:
        with self._lock:
            rec = self._kv.get(key)
            if rec is None:
                return None
            if self._dead(rec[1]):
                self._kv.pop(key, None)
                return None
            return rec[0]

    def set(self, key: str, value: str, ttl_s: int) -> None:
        with self._lock:
            self._kv[key] = (value, time.monotonic() + max(1, ttl_s))

    def getdel(self, key: str) -> str | None:
        with self._lock:
            rec = self._kv.pop(key, None)
            if rec is None or self._dead(rec[1]):
                return None
            return rec[0]

    def delete(self, key: str) -> None:
        with self._lock:
            self._kv.pop(key, None)

    def incr(self, key: str, ttl_s: int) -> int:
        with self._lock:
            rec = self._ctr.get(key)
            if rec is None or self._dead(rec[1]):
                self._ctr[key] = (1, time.monotonic() + max(1, ttl_s))
                return 1
            cnt = rec[0] + 1
            self._ctr[key] = (cnt, rec[1])
            return cnt

    def healthy(self) -> bool:
        return True


class RedisBackend:
    """redis-py wrapper. `client` is injectable for tests (e.g. fakeredis)."""

    def __init__(self, url: str, client=None) -> None:
        if client is not None:
            self._r = client
        else:
            import redis  # lazy: only needed when REDIS_URL is set
            self._r = redis.Redis.from_url(
                url, decode_responses=True,
                socket_timeout=0.5, socket_connect_timeout=0.5, retry_on_timeout=False,
            )

    def get(self, key: str) -> str | None:
        return self._r.get(key)

    def set(self, key: str, value: str, ttl_s: int) -> None:
        self._r.set(key, value, ex=max(1, int(ttl_s)))

    def getdel(self, key: str) -> str | None:
        try:
            return self._r.getdel(key)  # redis-py 4.1+ / server 6.2+
        except Exception:
            pipe = self._r.pipeline()
            pipe.get(key)
            pipe.delete(key)
            return pipe.execute()[0]

    def delete(self, key: str) -> None:
        self._r.delete(key)

    def incr(self, key: str, ttl_s: int) -> int:
        # Fixed window: INCR, and set the TTL on the first hit of the window.
        v = int(self._r.incr(key))
        if v == 1:
            self._r.expire(key, max(1, int(ttl_s)))
        return v

    def healthy(self) -> bool:
        try:
            return bool(self._r.ping())
        except Exception:
            return False


@lru_cache(maxsize=1)
def get_shared_backend() -> CacheBackend | None:
    """Redis backend when REDIS_URL is set and reachable, else None (→ in-memory)."""
    from ..settings import get_settings
    url = (get_settings().REDIS_URL or "").strip()
    if not url:
        return None
    try:
        backend = RedisBackend(url)
        if backend.healthy():
            log.info("shared cache: Redis backend active")
            return backend
        log.warning("REDIS_URL is set but Redis did not respond; using in-process state")
    except Exception:
        log.exception("REDIS_URL is set but the Redis backend failed to init; using in-process state")
    return None


def reset_backend_cache() -> None:
    """Tests: forget the memoised backend selection."""
    get_shared_backend.cache_clear()
