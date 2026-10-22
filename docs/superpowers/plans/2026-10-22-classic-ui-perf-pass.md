# Classic-UI Performance Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make heavily-used classic (Flask/Jinja) screens faster by cutting redundant Firestore reads and routing screens to existing native `/api/v2` endpoints, with every change test-gated, flag-guarded, and proven by an exact before/after read-count table — at zero added cloud cost.

**Architecture:** Measurement-first. (1) Make local read/write counts observable by teaching the test-only fake Firestore to feed the existing `metrics` counter. (2) Build a deterministic baseline harness that drives each candidate classic-screen endpoint against `demo_server` and ranks them by Firestore reads (primary) and local latency (secondary). (3) Fix only the baseline-confirmed top offenders, lowest-risk first (rewire classic JS → existing native endpoint > batch/parallelize/keyset > read-through cache for reference data), each behind a per-screen env flag with instant revert.

**Tech Stack:** Python 3.11, FastAPI + Flask (a2wsgi bridge), pydantic-settings, `backend/tests/fakes/fake_firestore.py`, pytest, classic UI `static/*.js`, TanStack-Query React SPA (shares the same `/api/v2`).

**Spec:** The pasted performance-engineer brief (2026-10-22). User decisions: **(a) local read/write counts are the enforced budget** (latency local-only, relative); **(b) first slice** — baseline all heavily-used classic screens, fix only the top offenders, then iterate.

## Two findings that reshape this plan (read before executing)

1. **The brief's named suspects are already optimized.** `/get_data` (routes/rooms.py:4591) already runs 4 parallel queries, a 30s cache, and today-only payments; `/get_history` already skips the room-doc read via body fields and uses a single-field equality fast path; `services.customer_service.get_customer` is a single doc read and the per-keystroke search is a single indexed range query. So the fix targets are **whatever the baseline ranks highest**, not these three by assumption. Task 3 confirms-or-exonerates them.
2. **Local read-counts are zero until we instrument the fake.** `core/metrics.py` counts at the real GAPIC client; `demo_server` uses `fake_firestore.py`, which never calls `count_reads`/`count_writes`. Task 1 adds a test-only shim so the counter sees fake reads with the same billing semantics. No production code path changes.

## Global Constraints

- **Preserved logic (§2): no change to money/tax/GST/booking math or any stored value.** If a change could alter a number on an invoice, STOP and ask. `backend/tests/test_parity.py` must stay byte-identical. No edits under `config.py`, `services/` money paths, or the GST/bill routes.
- **Prefer rewiring classic JS → existing `/api/v2` over editing legacy Python routes.** Legacy routes stay untouched where possible (§2). A legacy read route may only be touched behind a flag and only for non-money read aggregation.
- **API is a dual-consumer contract.** Native `/api/v2` endpoints are consumed by BOTH classic JS and the React SPA. Do not change a response shape without adapting both callers. Keep `UI_MODE=spa` building.
- **No new Firestore composite indexes (§4).** Every query stays a single-field range/`in`. `firestore.indexes.json` unchanged.
- **Every behavioural change behind a per-screen env flag** (new field on `cibara_api/settings.py::Settings`, read via `get_settings()`), default OFF, instant revert by unsetting the env var. Small, reviewable commits.
- **Zero added cloud spend:** code-only; no CPU/instance/Redis/index changes.

## Review Focus

- **Stale-money via caching:** any new/extended read-through cache must never serve stale balances/totals/tax. Test: a write invalidates the cache before the next read (reference-data only: tariffs, settings, ui_config — never bills/totals).
- **Dual-consumer shape drift:** if a classic screen is rewired to a native endpoint, the native payload must carry every field the classic JS reads. Test: field-presence assertion against the classic consumer's expectations.
- **Flag-off is a true revert:** with the flag unset, the screen behaves byte-identically to today. Test: endpoint/JS path with flag off == baseline behaviour.
- **Empty/missing documents:** endpoints must not read extra docs or error on a guest/room/customer with missing optional fields. Test: fake seeded with a minimal doc.
- **Counting semantics parity:** the fake's read count for a known query equals the real GAPIC semantics (1/doc, 1 for empty query, 0 for aggregation, writes = len(mutations)). Test in Task 1.

---

## File Structure

- Create: `backend/tests/fakes/_fscount.py` — tiny helper calling `metrics.count_reads/writes` with guarded import (no hard dep on the app package). Keeps the fake importable standalone.
- Modify: `backend/tests/fakes/fake_firestore.py` — call the helper at each read/write point (`DocumentReference.get`, `Query.stream`/`get`, `_CountQuery`, `FakeClient.get_all`, batch `commit`).
- Create: `backend/tests/perf/__init__.py`, `backend/tests/perf/harness.py` — drives candidate endpoints against an in-process app over the fake, captures `X-Firestore-Reads`/`-Writes` + wall-ms, emits a ranked table.
- Create: `backend/tests/perf/test_harness.py` — proves the shim + harness measure non-zero reads end-to-end.
- Create: `docs/superpowers/perf/baseline-2026-10-22.md` — the ranked baseline table + per-screen budgets (Task 3 output).
- Modify (Stage B, per confirmed offender, baseline-gated): `cibara_api/settings.py` (+flag), the specific `static/*.js` or native router, plus its test.

---

## Stage A — Measurement (fully specified; low-risk, no money/tax code)

### Task 1: Teach the fake Firestore to feed the metrics counter

**Files:**
- Create: `backend/tests/fakes/_fscount.py`
- Modify: `backend/tests/fakes/fake_firestore.py` (read points at `DocumentReference.get`, `Query.stream`, `Query.get`, `_CountQuery`, `FakeClient.get_all`; write point `commit`)
- Test: `backend/tests/perf/test_harness.py::test_fake_counts_match_gapic_semantics`

**Interfaces:**
- Produces: `_fscount.reads(n: int) -> None`, `_fscount.writes(n: int) -> None` — forward to `cibara_api.core.metrics.count_reads/count_writes` when importable, else no-op.

- [ ] **Step 1: Write the failing test** — seed the fake with 3 docs in a collection; run a `stream()` inside `metrics.start()`; assert `counter.reads == 3`. Empty query → `reads == 1`. `document(id).get()` on an existing doc → `+1`; on a missing doc → `+1`. Aggregation `count().get()` → `+0`. A `commit` of 2 writes → `writes == 2`.
- [ ] **Step 2: Run to verify it fails** — `python -m pytest tests/perf/test_harness.py::test_fake_counts_match_gapic_semantics -v` (from backend/) → FAIL (reads stay 0).
- [ ] **Step 3: Implement** — add `_fscount.py` (guarded import), then call `_fscount.reads(...)`/`_fscount.writes(...)` at each fake read/write point, matching `metrics.py` semantics exactly (1 per returned doc; 1 for an empty stream; 1 per `get_all` doc; 0 for aggregation; `len(writes) or 1` per commit). Counting must never change returned data.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Run the existing fake-backed suite to prove no behavioural change** — `python -m pytest tests -q` (from backend/) → unchanged pass count.
- [ ] **Step 6: Commit** — `test(perf): count reads/writes in fake Firestore for local baselines`.

### Task 2: Baseline harness

**Files:**
- Create: `backend/tests/perf/harness.py`, `backend/tests/perf/__init__.py`
- Test: `backend/tests/perf/test_harness.py::test_harness_reports_reads`

**Interfaces:**
- Produces: `run_baseline(screens: list[Screen]) -> list[Row]` where `Row = {screen, route, reads, writes, p50_ms, p95_ms, n}`; `Screen` names a classic screen and the ordered endpoint call(s) that load it (method, path, body). Driven in-process via `fastapi.testclient.TestClient` over the fake + a seeded dataset (reuse `demo_server` seeding), each endpoint hit N times (default 30) for p50/p95 of local ms; reads/writes read from the response headers.

- [ ] **Step 1: Write the failing test** — build 1 `Screen` for the front desk (`GET /get_data`), run `run_baseline`, assert the row has `reads >= 1` and `n == 30`.
- [ ] **Step 2: Run to verify it fails** (module/function missing).
- [ ] **Step 3: Implement** `run_baseline` + the `Screen`/`Row` dataclasses + a `CANDIDATE_SCREENS` list enumerating the heavily-used classic screens and their load endpoints (front desk `/get_data`; bills list + period tally; reports overview + GSTR-1 summary; register/history `/get_history`; customer manager list + `get_customer`; settle-later list; banking; staff). Sort rows by `reads` desc.
- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `test(perf): add classic-screen Firestore read baseline harness`.

### Task 3: Capture baseline, set budgets, pick targets (decision gate)

**Files:** Create `docs/superpowers/perf/baseline-2026-10-22.md`.

- [ ] **Step 1:** Run the harness; write the ranked table (screen, route, reads, writes, p50/p95 local-ms, n).
- [ ] **Step 2:** Set an explicit per-screen budget: reads primary (e.g. interactive load `< 6` reads), local-ms secondary/relative. Mark each screen pass/over-budget.
- [ ] **Step 3:** List the top offenders by reads and whether `/get_data`, `/get_history`, `get_customer` are confirmed or exonerated. Add a usage-frequency estimate column (labelled as estimate) for a frequency×reads priority.
- [ ] **Step 4: STOP — report the table to the user and confirm the top offenders** before writing any Stage-B fix task.

---

## Stage B — Fixes (baseline-gated; concretized after Task 3)

Do **not** pre-write these tasks. After Task 3 confirms the top offenders, append one task per offender, each in the TDD step style above, choosing the lowest-risk applicable fix:

1. **Rewire classic JS → existing native `/api/v2` endpoint** if one already returns what the screen needs. Flag: a server-rendered per-screen bool the classic JS reads; default OFF. Test: native payload carries every field the classic JS consumes; read-count drops; flag-off unchanged.
2. **If no native endpoint exists:** write a native facade **with a parity test** (§6), then rewire.
3. **Kill N+1s:** batch doc reads (`get_all`), parallelize independent reads, add keyset pagination to unbounded lists. Test: read-count drop on a seeded multi-row dataset.
4. **Read-through cache (reference data only):** tariffs, settings, ui_config — explicit TTL + invalidation on write via `core/cache.py`. Never bills/totals/tax. Test: write invalidates before next read.

Each fix task ends by re-running the harness for that screen and recording before/after reads + local-ms. A change that doesn't beat its budget is reverted, not kept.

> **PDF-on-checkout:** the brief's method floats deferring bill-PDF render, but its own "ALREADY OPTIMAL — do not fix" note says the checkout PDF is a deliberate daemon-thread async job. Out of scope unless the user reopens it.

---

## Stage C — Verify & report

- [ ] Run all regression gates and paste output: `python -m pytest tests` (legacy, 557); `cd backend && python -m pytest tests --cov=cibara_api`; `backend/tests/test_parity.py`; `cd frontend && npm test && npm run typecheck`; classic-UI ESLint on `static/*.js`.
- [ ] Browser-preview proof per changed screen: Server-Timing improved + `X-Firestore-Reads` reduced.
- [ ] One before/after table covering every screen touched.
- [ ] superpowers:verification-before-completion: run the gates, paste evidence, THEN report done.
