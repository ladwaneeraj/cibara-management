"""
Per-request Firestore read/write counting and latency stats.

Counts are taken at the lowest level of the Google client (the GAPIC
FirestoreClient calls batch_get_documents / run_query / run_aggregation_query /
commit), so every path — new endpoints, bridged legacy routes, services — is
measured the same way. Billing semantics are approximated: one read per
document returned, one read for an empty query, one write per mutation.

Exposed through:
  • response headers  X-Firestore-Reads / X-Firestore-Writes / Server-Timing
  • GET /api/v2/admin/metrics (admin) — per-route totals since process start
"""
from __future__ import annotations

import contextvars
import functools
import re
import threading
import time
from collections import deque
from dataclasses import dataclass, field

_current: contextvars.ContextVar["Counter | None"] = contextvars.ContextVar("fs_counter", default=None)


@dataclass
class Counter:
    reads: int = 0
    writes: int = 0


def start() -> tuple[Counter, contextvars.Token]:
    c = Counter()
    return c, _current.set(c)


def stop(token: contextvars.Token) -> None:
    try:
        _current.reset(token)
    except ValueError:
        # Token created in another context (thread) — just clear.
        _current.set(None)


def current() -> Counter | None:
    return _current.get()


def count_reads(n: int) -> None:
    c = _current.get()
    if c is not None:
        c.reads += n


def count_writes(n: int) -> None:
    c = _current.get()
    if c is not None:
        c.writes += n


# ── registry ──────────────────────────────────────────────────────────────

@dataclass
class _RouteStats:
    count: int = 0
    errors: int = 0
    total_ms: float = 0.0
    max_ms: float = 0.0
    reads: int = 0
    writes: int = 0
    samples: deque = field(default_factory=lambda: deque(maxlen=200))


_lock = threading.Lock()
_routes: dict[str, _RouteStats] = {}
_started = time.time()

_ID_SEG = re.compile(r"^(?:[0-9a-f]{12,}|[0-9]+|[A-Za-z0-9_-]{20,}|CC_.*|CN_.*)$")


def normalise_path(path: str) -> str:
    return "/".join(":id" if _ID_SEG.match(seg or "-") and seg else seg for seg in path.split("/"))


_MAX_ROUTES = 400


def record(route: str, ms: float, status: int, reads: int, writes: int) -> None:
    with _lock:
        s = _routes.get(route)
        if s is None:
            if len(_routes) >= _MAX_ROUTES:
                route = "other"
                s = _routes.get(route)
            if s is None:
                s = _routes[route] = _RouteStats()
        s.count += 1
        s.errors += 1 if status >= 500 else 0
        s.total_ms += ms
        s.max_ms = max(s.max_ms, ms)
        s.reads += reads
        s.writes += writes
        s.samples.append(ms)


def snapshot() -> dict:
    with _lock:
        out = []
        for route, s in _routes.items():
            samples = sorted(s.samples)
            p95 = samples[int(len(samples) * 0.95) - 1] if samples else 0
            p50 = samples[len(samples) // 2] if samples else 0
            out.append({
                "route": route, "count": s.count, "errors": s.errors,
                "avg_ms": round(s.total_ms / s.count, 1) if s.count else 0,
                "p50_ms": round(p50, 1), "p95_ms": round(p95, 1), "max_ms": round(s.max_ms, 1),
                "reads": s.reads, "writes": s.writes,
                "reads_per_call": round(s.reads / s.count, 1) if s.count else 0,
            })
    out.sort(key=lambda r: r["reads"], reverse=True)
    return {"since": _started, "uptime_s": int(time.time() - _started), "routes": out,
            "totals": {"requests": sum(r["count"] for r in out),
                       "reads": sum(r["reads"] for r in out),
                       "writes": sum(r["writes"] for r in out)}}


def reset() -> None:
    with _lock:
        _routes.clear()


# ── instrumentation of the real Google client ─────────────────────────────

_installed = False


def _instrument(C) -> None:
    """Wrap a GAPIC-style client class. Counting can never break a call:
    every metrics step is guarded, and results/exceptions pass through."""

    def _wrap_stream(name, per_item):
        orig = getattr(C, name)

        @functools.wraps(orig)
        def wrapper(self, *a, **kw):
            it = orig(self, *a, **kw)

            def gen():
                n = 0
                for resp in it:
                    try:
                        k = per_item(resp)
                        if k:
                            n += k
                            count_reads(k)  # counted as it streams (doc gets call next() once)
                    except Exception:  # pragma: no cover - defensive
                        pass
                    yield resp
                if n == 0:
                    count_reads(1)  # Firestore bills one read for an empty result
            return gen()
        setattr(C, name, wrapper)

    def _doc(resp):
        doc = getattr(resp, "document", None)
        return 1 if doc is not None and getattr(doc, "name", "") else 0

    _wrap_stream("batch_get_documents", lambda r: 1)
    _wrap_stream("run_query", _doc)
    _wrap_stream("run_aggregation_query", lambda r: 0)

    orig_commit = C.commit

    @functools.wraps(orig_commit)
    def commit(self, *a, **kw):
        try:
            req = kw.get("request") if "request" in kw else (a[0] if a else None)
            writes = getattr(req, "writes", None)
            if writes is None and isinstance(req, dict):
                writes = req.get("writes")
            count_writes(len(writes or []) or 1)
        except Exception:  # pragma: no cover - defensive
            pass
        return orig_commit(self, *a, **kw)
    C.commit = commit


def instrument_google_client() -> None:
    """Wrap the real GAPIC Firestore client once. Safe to call repeatedly."""
    global _installed
    if _installed:
        return
    try:
        from google.cloud.firestore_v1.services.firestore import client as gapic
    except Exception:  # pragma: no cover - library layout changed
        return
    _instrument(gapic.FirestoreClient)
    _installed = True
