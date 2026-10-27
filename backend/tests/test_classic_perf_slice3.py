"""Classic-UI perf slice 3 (2026-10-27): cut the shared full-rooms-scan cost
and make the two blind screens' reads visible in production monitoring.

Targets (measured root cause, docs/superpowers/perf/baseline-2026-10-22.md):
  * /insights/summary  — 101 cold reads, dominated by a 47-read get_all_rooms()
    scan it only needs for a room COUNT + the "cleaning now" strip.
  * /get_register_data — 81 cold reads; in CHECKOUT mode the 47-read rooms fetch
    is fetched but never consumed (dead reads).
  * Both run their reads in hand-rolled thread pools that don't propagate the
    request context, so X-Firestore-Reads / /admin/metrics report ~0 (blind) —
    the same bug the prior slice fixed for /get_data only.

Reads are measured ground-truth (the fake Firestore's _Store), independent of
the header, via the baseline harness helpers.
"""
from __future__ import annotations

import os
import uuid

import pytest

from tests.demo_server import seed
from tests.perf.harness import _bust_caches, _fake_store

S, E = "2026-10-01", "2026-10-31"  # 31-day window covering the seeded "today"


@pytest.fixture
def seeded(client):
    """Realistic seeded day + an admin auth header (admin holds analytics.view)."""
    seed(client)
    from cibara_api.core.ratelimit import limiter
    limiter.reset()
    r = client.post("/api/v2/auth/login",
                    json={"user_id": "admin", "password": "admin123"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _auth(h):
    return {**h, "X-Op-Id": uuid.uuid4().hex}


def _cold_reads(fn):
    """Ground-truth Firestore reads for one cold call (caches busted first)."""
    store = _fake_store()
    _bust_caches()
    r0 = store.read_count
    out = fn()
    return store.read_count - r0, out


_VOLATILE = ("generated_at", "generatedAt", "timestamp", "server_time",
             "elapsed_min")


def _volatile_stripped(d):
    """Drop fields that legitimately vary call-to-call — wall-clock stamps, and
    `elapsed_min` which _live_pending derives from datetime.now. Recurses into
    lists as well as dicts (so stamps inside live.pending[] are dropped too)."""
    if isinstance(d, list):
        return [_volatile_stripped(x) for x in d]
    if not isinstance(d, dict):
        return d
    return {k: _volatile_stripped(v) for k, v in d.items() if k not in _VOLATILE}


# ── Fix 1: monitoring context propagation (header must see the real reads) ──

def test_insights_pool_reads_are_counted(seeded, monkeypatch):
    # insights runs audit/payments/bills on its own _POOL. Before context
    # propagation the header saw only the on-thread rooms scan (~47) and missed
    # the pool (~54), so the true cold total (~101, full-scan mode) was blind.
    # Floor comfortably above the pre-fix 47; robust to the process-wide
    # store counter's ±1 cross-thread noise (so we assert the header, not it).
    monkeypatch.setenv("PERF_INSIGHTS_ROOMS_LIGHT", "0")  # full scan → known ~101
    _bust_caches()
    r = client_get_insights(seeded)
    assert r.status_code == 200, r.text
    header = int(r.headers.get("X-Firestore-Reads", "-1"))
    assert header >= 90, f"insights _POOL reads still blind in header: {header}"


def test_register_pool_reads_are_counted(seeded, monkeypatch):
    # register fans every fetch onto a max_workers=16 pool. Before context
    # propagation the header saw ~1 while the true cold total is ~81. Floor
    # comfortably above the pre-fix 1.
    monkeypatch.setenv("PERF_REGISTER_SKIP_ROOMS_CHECKOUT", "0")  # keep full cost
    _bust_caches()
    r = client_post_register(seeded, {"start_date": S, "end_date": E})  # checkin mode
    assert r.status_code == 200, r.text
    header = int(r.headers.get("X-Firestore-Reads", "-1"))
    assert header >= 60, f"register pool reads still blind in header: {header}"


# ── Fix 2: register CHECKOUT mode drops the unused rooms fetch ──────────────

def test_register_checkout_skips_rooms_without_changing_payload(seeded, monkeypatch):
    body = {"start_date": S, "end_date": E, "mode": "checkout"}

    monkeypatch.setenv("PERF_REGISTER_SKIP_ROOMS_CHECKOUT", "0")
    off_reads, off = _cold_reads(lambda: client_post_register(seeded, body))
    assert off.status_code == 200, off.text

    monkeypatch.setenv("PERF_REGISTER_SKIP_ROOMS_CHECKOUT", "1")
    on_reads, on = _cold_reads(lambda: client_post_register(seeded, body))
    assert on.status_code == 200, on.text

    # Checkout mode never consumes rooms_data → payload must be byte-identical.
    assert _volatile_stripped(on.json()) == _volatile_stripped(off.json())
    # And it must save roughly the whole rooms scan.
    assert on_reads <= off_reads - 30, f"expected big drop, got {off_reads}->{on_reads}"


# ── Fix 3: insights uses count() + status==cleaning instead of a full scan ──

def test_insights_rooms_light_preserves_payload(seeded, monkeypatch):
    # Put a room into 'cleaning' so the live "cleaning now" strip is non-empty
    # and the _cleaning_rooms() vs full-scan equivalence is actually exercised
    # (the demo seed otherwise leaves no room in that status).
    from config import rooms_ref
    rid = next(d.id for d in rooms_ref.stream()
               if (d.to_dict() or {}).get("status") != "occupied")
    rooms_ref.document(rid).set(
        {"status": "cleaning", "cleaning_start_time": "2026-10-27 10:00:00",
         "cleaning_status": "in_progress", "cleanedBy": "hk1"}, merge=True)

    monkeypatch.setenv("PERF_INSIGHTS_ROOMS_LIGHT", "0")
    off_reads, off = _cold_reads(lambda: client_get_insights(seeded))
    assert off.status_code == 200, off.text

    monkeypatch.setenv("PERF_INSIGHTS_ROOMS_LIGHT", "1")
    on_reads, on = _cold_reads(lambda: client_get_insights(seeded))
    assert on.status_code == 200, on.text

    # room_count (occupancy denominator) and the live "cleaning now" strip must
    # be identical whether we scan all rooms or use count() + a status query.
    # elapsed_min is wall-clock-derived, so _volatile_stripped drops it.
    off_j, on_j = _volatile_stripped(off.json()), _volatile_stripped(on.json())
    assert on_j["live"]["pending"], "seeded cleaning room should appear in the strip"
    assert on_j == off_j
    assert on_reads <= off_reads - 30, f"expected big drop, got {off_reads}->{on_reads}"


# ── thin call helpers (a stable place for the paths) ────────────────────────

_CLIENT = None


@pytest.fixture(autouse=True)
def _grab_client(client):
    global _CLIENT
    _CLIENT = client
    yield


def client_get_insights(auth):
    return _CLIENT.get("/insights/summary",
                       params={"from": S, "to": E, "fresh": "1"}, headers=_auth(auth))


def client_post_register(auth, body):
    return _CLIENT.post("/get_register_data", json=body, headers=_auth(auth))
