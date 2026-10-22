"""Deterministic Firestore-read baseline harness for classic-UI screens.

Drives each screen's load endpoint(s) in-process through the FastAPI app (over
the in-memory fake Firestore) and records, per screen:

  * ``reads`` / ``writes`` — the GROUND-TRUTH Firestore operation count for a
    COLD load (server caches busted first), taken from the fake's thread-safe
    ``_Store`` totals. Thread-complete, so it captures reads that happen inside
    ``/get_data``'s ThreadPoolExecutor — which the per-request contextvar
    counter (and hence the production ``X-Firestore-Reads`` header) misses.
  * ``header_reads`` — what the production ``X-Firestore-Reads`` header reports
    for the same cold call. A gap vs ``reads`` flags an endpoint whose reads
    happen off the request thread (under-reported in prod monitoring).
  * ``p50_ms`` / ``p95_ms`` — local wall-clock latency over ``repeats`` calls as
    the app actually serves them (warm where the screen caches). Relative only:
    the fake has no network, so absolute ms are NOT production figures.

Reads are the enforced budget (deterministic, backend-independent, maps to
cloud cost); latency is a secondary, relative signal.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass
class Screen:
    """A classic screen's load, expressed as one HTTP call to the app."""
    name: str
    method: str
    path: str
    params: dict | None = None
    json: dict | None = None
    note: str = ""


@dataclass
class Row:
    screen: str
    route: str
    status: int
    reads: int          # ground-truth cold reads (fake _Store delta)
    writes: int
    header_reads: int   # production-reported reads (X-Firestore-Reads) on the cold call
    p50_ms: float
    p95_ms: float
    n: int
    note: str = ""


def _fake_store():
    """The _Store backing the app's Firestore client (same object the app reads
    through). Returns None if the fakes are not installed."""
    try:
        from tests.fakes import fake_firebase as F
        return F.FAKE_DB._store
    except Exception:  # pragma: no cover - defensive
        return None


def _bust_caches() -> None:
    """Clear the in-process read caches so a measured call reads Firestore cold.
    Each clear is independent and best-effort."""
    try:
        import config
        config.invalidate_cache()
    except Exception:
        pass
    try:
        from routes import rooms as legacy_rooms
        legacy_rooms._invalidate_get_data_cache()
    except Exception:
        pass


def _call(client, auth, s: Screen):
    return client.request(s.method, s.path, params=s.params, json=s.json, headers=auth)


def run_baseline(client, auth, screens, repeats: int = 30) -> list[Row]:
    """Measure each screen and return rows sorted by ground-truth reads desc."""
    store = _fake_store()
    rows: list[Row] = []
    for s in screens:
        _bust_caches()
        r0 = store.read_count if store else 0
        w0 = store.write_count if store else 0
        resp = _call(client, auth, s)  # cold
        reads = (store.read_count - r0) if store else -1
        writes = (store.write_count - w0) if store else -1
        try:
            header_reads = int(resp.headers.get("X-Firestore-Reads", "-1"))
        except (TypeError, ValueError):
            header_reads = -1

        times: list[float] = []
        for _ in range(repeats):
            t = time.perf_counter()
            _call(client, auth, s)
            times.append((time.perf_counter() - t) * 1000.0)
        times.sort()
        p50 = times[len(times) // 2] if times else 0.0
        p95 = times[max(0, int(len(times) * 0.95) - 1)] if times else 0.0

        rows.append(Row(
            screen=s.name, route=f"{s.method} {s.path}", status=resp.status_code,
            reads=reads, writes=writes, header_reads=header_reads,
            p50_ms=round(p50, 2), p95_ms=round(p95, 2), n=repeats, note=s.note,
        ))
    rows.sort(key=lambda r: r.reads, reverse=True)
    return rows


# Candidate heavily-used classic screens and their primary load endpoint.
# Paths are verified / extended in the Task 3 baseline run; some screens need
# seeded volume (bills, customers, occupied rooms) to reveal N+1 behaviour.
CANDIDATE_SCREENS: list[Screen] = [
    Screen("front_desk_legacy", "GET", "/get_data", params={"fresh": "1"},
           note="classic rooms/transactions page load"),
]
