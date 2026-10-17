"""
Simple in-memory sliding-window rate limiter.

Good enough for ~10 users on one Cloud Run instance: no Redis, no shared
state. Limits reset when the instance restarts, and each instance keeps its
own counts if the service ever scales out — acceptable for its purpose
(stopping brute-force logins and runaway clients), not a billing control.
"""
from __future__ import annotations

import threading
import time
from collections import deque

from fastapi import HTTPException, status


class RateLimiter:
    def __init__(self, max_keys: int = 50_000):
        self._hits: dict[str, deque] = {}
        self._lock = threading.Lock()
        self._max_keys = max_keys

    def hit(self, key: str, limit: int, window_s: float) -> tuple[bool, float]:
        """Record one hit. Returns (allowed, retry_after_seconds).

        With a shared cache configured (REDIS_URL), the count is a fixed-window
        counter in Redis so the limit is enforced across instances. Without it,
        the in-process sliding window below is used (unchanged default). A Redis
        error degrades to allow (fail-open): rate limiting is best-effort, not a
        billing control."""
        from . import cache
        backend = cache.get_shared_backend()
        if backend is not None:
            try:
                count = backend.incr(f"rl:{key}", int(window_s) or 1)
                if count > limit:
                    return False, float(int(window_s) or 1)
                return True, 0.0
            except Exception:  # pragma: no cover - Redis blip → fail open
                pass

        now = time.monotonic()
        with self._lock:
            q = self._hits.get(key)
            if q is None:
                if len(self._hits) >= self._max_keys:
                    self._evict(now)
                q = self._hits[key] = deque()
            cutoff = now - window_s
            while q and q[0] <= cutoff:
                q.popleft()
            if len(q) >= limit:
                return False, max(0.0, q[0] + window_s - now)
            q.append(now)
            return True, 0.0

    def peek(self, key: str, window_s: float) -> int:
        now = time.monotonic()
        with self._lock:
            q = self._hits.get(key)
            if not q:
                return 0
            return sum(1 for t in q if t > now - window_s)

    def reset(self, key: str | None = None) -> None:
        with self._lock:
            if key is None:
                self._hits.clear()
            else:
                self._hits.pop(key, None)

    def _evict(self, now: float) -> None:
        # Drop keys whose newest hit is older than an hour.
        stale = [k for k, q in self._hits.items() if not q or q[-1] < now - 3600]
        for k in stale:
            del self._hits[k]


limiter = RateLimiter()


def enforce(key: str, limit: int, window_s: float, message: str = "Too many requests. Slow down.") -> None:
    ok, retry = limiter.hit(key, limit, window_s)
    if not ok:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS, detail=message,
            headers={"Retry-After": str(int(retry) + 1)},
        )
