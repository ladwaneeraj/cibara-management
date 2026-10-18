# Register-based Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fresh, embedded React analytics page at `/analytics` whose every figure derives from the register ground-truth collections (not `bills` alone), adding channel net-profitability, booking pace (with nightly snapshots), seasonality, length-of-stay/lead-time, and a reused Customers section.

**Architecture:** Follow the existing insights pattern exactly — heavy compute lives in a Flask blueprint (`routes/analytics.py`) calling a pure, unit-tested service (`services/register_analytics_service.py`); the browser hits a thin v2 forward facade (`/api/v2/analytics/overview`). Occupancy/ADR/RevPAR reuse `kpi_service.compute_kpis` by shaping the register stay-universe into the same bill-shaped dicts it already consumes. The frontend is a dedicated lean Vite bundle reusing the `frontend/` design system, served at `/analytics`, authed with the existing access JWT.

**Tech Stack:** Python 3.11 / Flask blueprint + FastAPI facade (forward); Firestore (projected `.select()` reads, in-process cache); React 18.3 + Vite 6 + Tailwind 4 + Recharts 2.15 + TanStack Query 5 (reusing `frontend/src`).

**Spec:** `docs/superpowers/specs/2026-10-18-register-analytics-design.md`

## Global Constraints

- No money/tax logic is re-implemented or edited (CLAUDE.md §2); occupancy/ADR/RevPAR go through the existing `services/kpi_service.compute_kpis` unchanged.
- `UI_MODE` is **not** touched; classic stays the default UI. The React page is a separate bundle embedded at `/analytics`.
- Backend compute module `services/register_analytics_service.py` is **pure** — no Firestore, no Flask imports — mirroring `services/insights_service.py` and `services/kpi_service.py`.
- Server returns a **small** JSON: aggregates and chart series only. No per-bill / per-payment arrays are sent to the browser.
- All new Firestore reads use `.select()` projections and run concurrently on a thread pool (pattern: `routes/insights.py`). Overview response cached per window in-process, TTL 120s, `fresh=1` bypass.
- Endpoints gated `analytics.view` (admin). The reused Customers section calls the existing `/customer_insights` (+ `/customer_segment`), gated `customer.manage`.
- IST calendar days; dates as `YYYY-MM-DD`. Money formatted only via `frontend/src/lib/format` `money`; dates via `istDate`. Charts use `charts.PALETTE`, no animation (CLAUDE.md §9).
- The nightly snapshot writes an append-only `analytics_snapshots` collection only; it never touches money/tax docs.

## Review Focus

- **In-house stay (no `checkout_time`):** must count nights up to today and project forward for pace, never crash or drop the stay. → Task 1, Task 3 tests.
- **Cancelled / voided / reverted stays:** excluded from occupancy AND channel revenue, so no double-count with a replacement stay. → Task 1, Task 2 tests.
- **Empty window / zero rooms / zero occupied-nights:** no divide-by-zero; occupancy/ADR/RevPAR return 0. → Task 1 test.
- **Future booking with cancelled status or missing dates:** excluded from booking pace. → Task 3 test.
- **Lead-time for walk-ins:** walk-ins have no booking doc; they must appear as a separate "walk-in" bucket, not as lead-time 0 polluting the distribution. → Task 5 test.

---

## Phase 1 — Backend (ships and is testable without the frontend)

### Task 1: Stay universe + overview KPIs (pure service)

**Files:**
- Create: `services/register_analytics_service.py`
- Test: `tests/test_register_analytics_service.py`

**Interfaces:**
- Consumes: `services.kpi_service.compute_kpis(bills, room_count, window_start, window_end_inclusive, *, today=None, include_ota=True) -> dict` (returns `occupancy_pct, adr, revpar, room_revenue, occupied_room_nights, …`).
- Produces:
  - `build_stay_universe(rooms: dict, bills: list[dict], today: datetime.date) -> list[dict]` — merges live `rooms` (status `occupied` → an in-house stay, `checkout_time=None`) with completed `bills`, de-duped on the active stay id (`rooms[*].active_bill_id` vs `bill.id`/stay id), cancelled/voided/reverted excluded. Each returned dict is **bill-shaped**: `{stay_id, room, checkin_time, checkout_time, status, room_charges_total, room_price_per_night, payment_source, booking_source, ota_commission_gst, channel}` so it can be fed straight into `compute_kpis`.
  - `channel_of(stay: dict) -> str` — maps `booking_source`/`payment_source` to a label: `"Direct/Walk-in" | "MMT" | "Agoda" | "Booking.com" | "Other"`.
  - `compute_overview(stays: list[dict], payments: list[dict], room_count: int, window_from: str, window_to: str, today: datetime.date) -> dict` — KPIs via `compute_kpis(stays, …)` plus collections from `payments` (same classification as `routes/reports.py`: cash/online live charges, refunds, net).

- [ ] **Step 1: Write failing tests**

```python
def test_in_house_stay_counts_nights_to_today():
    rooms = {"101": {"status": "occupied", "active_bill_id": "s1",
                     "checkin_time": "2026-10-16 12:00", "room_price_per_night": 1000}}
    stays = build_stay_universe(rooms, bills=[], today=date(2026, 10, 18))
    assert len(stays) == 1 and stays[0]["checkout_time"] is None
    ov = compute_overview(stays, payments=[], room_count=1,
                          window_from="2026-10-16", window_to="2026-10-18",
                          today=date(2026, 10, 18))
    assert ov["occupancy"]["occupied_room_nights"] == 2   # 16th, 17th

def test_cancelled_stay_excluded():
    bills = [{"id": "b1", "status": "cancelled", "checkin_time": "2026-10-10 12:00",
              "checkout_time": "2026-10-11 10:00", "room_charges_total": 1000}]
    assert build_stay_universe({}, bills, date(2026, 10, 18)) == []

def test_empty_window_no_divide_by_zero():
    ov = compute_overview([], [], room_count=0, window_from="2026-10-18",
                          window_to="2026-10-18", today=date(2026, 10, 18))
    assert ov["occupancy"]["occupancy_pct"] == 0 and ov["occupancy"]["adr"] == 0

def test_channel_of_known_sources():
    assert channel_of({"booking_source": "mmt"}) == "MMT"
    assert channel_of({"booking_source": "", "payment_source": ""}) == "Direct/Walk-in"
```

- [ ] **Step 2: Run to verify they fail**

Run: `python -m pytest tests/test_register_analytics_service.py -v`
Expected: FAIL (module/functions not defined).

- [ ] **Step 3: Implement the three functions in `services/register_analytics_service.py`**

Pure module. `build_stay_universe` normalises rooms + bills to the bill-shaped dict and excludes `status in {cancelled, voided}` / `cancelled_by_revert` / `superseded_by_revert` (same markers as `routes/reports.py:revenue_report`). `compute_overview` wraps `compute_kpis` and nests its result under `"occupancy"`, and sums collections from payments (copy the classification predicate set from `routes/reports.py`, do not re-derive tax).

- [ ] **Step 4: Run to verify pass**

Run: `python -m pytest tests/test_register_analytics_service.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/register_analytics_service.py tests/test_register_analytics_service.py
git commit -m "feat(analytics): register stay-universe + overview KPIs (pure)"
```

### Task 2: Channel mix & net profitability

**Files:**
- Modify: `services/register_analytics_service.py`
- Test: `tests/test_register_analytics_service.py`

**Interfaces:**
- Consumes: `build_stay_universe`, `channel_of` (Task 1); commission expenses as `list[dict]` with `category == "booking_commission"`, `commission_platform`, `commission_amount`/`commission_gst`.
- Produces: `compute_channel_mix(stays: list[dict], commission_expenses: list[dict]) -> dict` → `{"channels": [{"channel", "gross", "commission", "net", "net_adr", "share_pct", "room_nights"}], "total_gross", "total_net"}`. Gross = room revenue per channel; commission = `ota_commission_gst` on the channel's stays + `booking_commission` expenses attributed to the matching platform; net = gross − commission.

- [ ] **Step 1: Write failing test**

```python
def test_channel_mix_nets_ota_commission():
    stays = [
        {"channel": "MMT", "room_charges_total": 10000, "ota_commission_gst": 1500,
         "checkin_time": "2026-10-10 12:00", "checkout_time": "2026-10-12 10:00"},
        {"channel": "Direct/Walk-in", "room_charges_total": 5000, "ota_commission_gst": 0,
         "checkin_time": "2026-10-10 12:00", "checkout_time": "2026-10-11 10:00"},
    ]
    mix = compute_channel_mix(stays, commission_expenses=[])
    mmt = next(c for c in mix["channels"] if c["channel"] == "MMT")
    assert mmt["gross"] == 10000 and mmt["commission"] == 1500 and mmt["net"] == 8500
    assert mix["total_net"] == 13500
```

- [ ] **Step 2: Run to verify it fails** — `python -m pytest tests/test_register_analytics_service.py::test_channel_mix_nets_ota_commission -v` → FAIL.
- [ ] **Step 3: Implement `compute_channel_mix(...)`** in the service. Attribute `booking_commission` expenses to a channel via `commission_platform` (e.g. `"booking.com" → "Booking.com"`); unmatched platforms fold into their own channel row.
- [ ] **Step 4: Run to verify pass** — same command → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(analytics): channel mix & net profitability"`.

### Task 3: Booking pace / forward occupancy

**Files:**
- Modify: `services/register_analytics_service.py`
- Test: `tests/test_register_analytics_service.py`

**Interfaces:**
- Consumes: in-house stays (Task 1, `checkout_time is None`), future bookings `list[dict]` with `check_in_date`, `check_out_date`, `status`, `room`, `total_amount`.
- Produces: `compute_booking_pace(stays: list[dict], future_bookings: list[dict], room_count: int, today: datetime.date, horizons=(7, 14, 30)) -> dict` → `{"horizons": {7: {"occupied_room_nights", "available_room_nights", "occupancy_pct", "on_books_revenue"}, 14: {...}, 30: {...}}}`. Occupied forward nights = in-house stays projected to their expected checkout + confirmed future bookings' nights that fall inside `[today, today+h)`. Bookings with `status in {cancelled}` or unparseable dates are skipped.

- [ ] **Step 1: Write failing test**

```python
def test_pace_counts_future_bookings_excludes_cancelled():
    future = [
        {"check_in_date": "2026-10-19", "check_out_date": "2026-10-21",
         "status": "confirmed", "room": "101", "total_amount": 2000},
        {"check_in_date": "2026-10-20", "check_out_date": "2026-10-22",
         "status": "cancelled", "room": "102", "total_amount": 2000},
    ]
    pace = compute_booking_pace(stays=[], future_bookings=future, room_count=5,
                                today=date(2026, 10, 18), horizons=(7,))
    assert pace["horizons"][7]["occupied_room_nights"] == 2   # 19th,20th only
    assert pace["horizons"][7]["on_books_revenue"] == 2000
```

- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement `compute_booking_pace(...)`.** Reuse the night-overlap arithmetic style from `kpi_service` (`[start, end)` half-open) for the `[today, today+h)` window.
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(analytics): forward booking pace"`.

### Task 4: Seasonality — weekday + 12-month

**Files:**
- Modify: `services/register_analytics_service.py`
- Test: `tests/test_register_analytics_service.py`

**Interfaces:**
- Consumes: `compute_kpis` (per bucket), stay universe.
- Produces: `compute_seasonality(stays: list[dict], room_count: int, window_from: str, window_to: str, today: datetime.date) -> dict` → `{"weekday": [{"weekday": "Monday", "occupancy_pct", "adr", "revpar"}, …7], "months": [{"month": "2026-10", "occupancy_pct", "adr", "revpar"}, …last 12]}`. Each weekday value aggregates that weekday's dates across the window; months cover the trailing 12 months regardless of the window.

- [ ] **Step 1: Write failing test** — assert `len(weekday) == 7`, `len(months) == 12`, and a seeded 100%-occupancy Monday reports `occupancy_pct == 100.0`.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement `compute_seasonality(...)`** by calling `compute_kpis` per weekday-set and per month and reading `occupancy_pct/adr/revpar`.
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(analytics): weekday & monthly seasonality"`.

### Task 5: Length-of-stay & lead-time

**Files:**
- Modify: `services/register_analytics_service.py`
- Test: `tests/test_register_analytics_service.py`

**Interfaces:**
- Produces: `compute_los_leadtime(stays: list[dict], bookings: list[dict]) -> dict` → `{"los": [{"bucket": "1"|"2"|"3"|"4-6"|"7+", "count"}], "lead_time": [{"bucket": "walk-in"|"0-1"|"2-7"|"8-30"|"30+", "count"}]}`. LOS from `checkout − checkin` nights per stay. Lead-time = `check_in_date − booking_created` for `bookings` rows only; stays with no matching booking doc are counted in the **"walk-in"** bucket.

- [ ] **Step 1: Write failing test** — a 2-night stay lands in LOS `"2"`; a stay with no booking doc lands in lead-time `"walk-in"`, not `"0-1"`.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement `compute_los_leadtime(...)`.**
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(analytics): length-of-stay & lead-time distributions"`.

### Task 6: Snapshot builder + pace-vs-prior merge

**Files:**
- Modify: `services/register_analytics_service.py`
- Test: `tests/test_register_analytics_service.py`

**Interfaces:**
- Produces:
  - `build_snapshot(stays: list[dict], future_bookings: list[dict], room_count: int, today: datetime.date, horizons=(7,14,30)) -> dict` → `{"date": "YYYY-MM-DD", "horizons": {7: {"occupancy_pct", "on_books_revenue"}, …}}` (reuses `compute_booking_pace`).
  - `pace_vs_prior(current: dict, snapshots: list[dict], today: datetime.date) -> dict` → adds a `"delta"` per horizon = current occupancy/revenue minus the snapshot nearest 7 days ago; `None` when no comparable snapshot exists yet.

- [ ] **Step 1: Write failing test** — `build_snapshot` returns the date + per-horizon dict; `pace_vs_prior` yields `delta=None` with an empty snapshot list and a numeric delta against a 7-day-old snapshot.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement both functions.**
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(analytics): snapshot builder + pace-vs-prior"`.

### Task 7: Compose entry + Flask blueprint endpoint

**Files:**
- Modify: `services/register_analytics_service.py` (compose fn)
- Create: `routes/analytics.py`
- Modify: `app.py` (import + `register_blueprint(analytics_bp)` after `insights_bp`, ~line 318)
- Test: `tests/test_register_analytics_service.py` (compose), `tests/test_analytics_route.py` (route wiring via fakes)

**Interfaces:**
- Consumes: all `compute_*` + `build_stay_universe` + `pace_vs_prior`; `config.get_all_rooms`, `bills_ref`, `services.payment_service.query_payments_by_date_range`, `services.expense_service.query_expenses_by_date_range`, `db.collection("bookings")`, `db.collection("analytics_snapshots")`.
- Produces:
  - `compute_findings(overview: dict, channel_mix: dict, pace: dict) -> list[dict]` — a few conservative, plain-language rules (same shape as `insights_service.generate_insights`: `{"level","icon","text"}`), e.g. a channel whose net ADR trails direct by a wide margin, or forward 7-night occupancy below a floor. Fires only when the sample is meaningful.
  - `compute_analytics_overview(*, rooms, bills, payments, bookings, commission_expenses, snapshots, room_count, window_from, window_to, now) -> dict` → `{"success": True, "window", "overview", "channel_mix", "pace", "seasonality", "los_leadtime", "findings", "generated_at"}` (where `findings = compute_findings(...)`).
  - `GET /analytics/overview?from=YYYY-MM-DD&to=YYYY-MM-DD[&fresh=1]` (blueprint `analytics_bp`, `url_prefix="/analytics"`), `@requires_permission("analytics.view")`, concurrent projected fetches + per-window cache — **structure copied from `routes/insights.py`** (`_CACHE`, `_POOL`, `_parse_date`, `_MAX_WINDOW_DAYS`).

- [ ] **Step 1: Write failing tests** — compose test asserts all top-level keys present on a seeded dataset (including a non-empty `findings` when a seeded rule condition holds); route test (using `backend/tests/fakes/fake_firestore.py` or the legacy `tests/conftest.py` fakes) asserts `200` + `success` and that **no** raw `bills`/`payments` arrays appear in the response.
- [ ] **Step 2: Run to verify they fail** → FAIL.
- [ ] **Step 3: Implement `compute_findings`, `compute_analytics_overview` and `routes/analytics.py`; register the blueprint in `app.py`.** Projections: bills `.select(["id","status","checkin_time","checkout_time","room_charges_total","room_price_per_night","payment_source","booking_source","ota_commission_gst","total_amount","cancelled_by_revert","superseded_by_revert"])`; bookings `.select(["check_in_date","check_out_date","status","room","total_amount","booking_source","booking_created"])`; expenses filtered to `category == "booking_commission"`.
- [ ] **Step 4: Run to verify pass** → PASS; also `python -m pytest tests -q` (legacy suite unaffected).
- [ ] **Step 5: Commit** — `git commit -m "feat(analytics): /analytics/overview endpoint + compose"`.

### Task 8: Nightly snapshot ingest route + native v2 facades

**Files:**
- Modify: `routes/analytics.py` (`POST /analytics/snapshot`, `X-Ingest-Secret` like other ingest routes)
- Create: `backend/cibara_api/routers/analytics.py`
- Modify: `backend/cibara_api/main.py` (add `analytics.router` to the `include_router` tuple, ~line 96)
- Test: `tests/test_analytics_route.py`

**Interfaces:**
- Produces:
  - `POST /analytics/snapshot` — computes `build_snapshot` from current ground truth and appends one doc to `analytics_snapshots` (id = date); idempotent (overwrite same date). Secret-gated, no JWT.
  - `GET /api/v2/analytics/overview?start=&end=&fresh=` forwarding to `/analytics/overview` (`require_permission("analytics.view")`), mirroring `report_insights` in `backend/cibara_api/routers/reports.py`.

- [ ] **Step 1: Write failing test** — posting to `/analytics/snapshot` with the secret writes one `analytics_snapshots` doc for today; wrong/absent secret → 401/403.
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement the snapshot route + the v2 facade; register the router.**
- [ ] **Step 4: Run to verify pass** → PASS; `cd backend && python -m pytest tests -q`.
- [ ] **Step 5: Commit** — `git commit -m "feat(analytics): nightly snapshot ingest + v2 facade"`.

> **Deploy note (owner):** add a Cloud Scheduler job hitting `POST /analytics/snapshot` nightly with `X-Ingest-Secret` (same pattern as the MMT/Agoda ingest jobs, CLAUDE.md §6). Not run from here.

---

## Phase 2 — Frontend (dedicated lean React bundle at `/analytics`)

### Task 9: Lean Vite entry, build wiring, route + nav link

**Files:**
- Create: `frontend/analytics/index.html`, `frontend/analytics/main.tsx`, `frontend/analytics/App.tsx`
- Modify: `frontend/vite.config.ts` (second build input / base `/analytics/`), `Dockerfile` (build + copy the bundle), `backend/cibara_api/main.py` (static mount `/analytics`)
- Modify: `app.py` or the classic nav template (link to `/analytics` shown when the user holds `analytics.view`)
- Test: `frontend/analytics/__tests__/App.test.tsx` (renders shell + nav)

**Interfaces:**
- Consumes: `frontend/src` design system via the `@` alias (tokens, `components/ui`, `lib/api`, `lib/format`, `charts.PALETTE`), the existing JWT auth store.
- Produces: a booted React app at `/analytics` that signs in via the shared fetch wrapper and renders the section shell.

- [ ] **Step 1: Write a failing render test** — `App` renders the page title and the five section headers (Overview, Channel, Pace, Seasonality, Customers) with a mocked query.
- [ ] **Step 2: Run to verify it fails** — `cd frontend && npm test` → FAIL.
- [ ] **Step 3: Implement the entry, Vite input, static mount, nav link.** Reuse `lib/api` for auth; no new session logic.
- [ ] **Step 4: Verify** — `npm run build && npm run typecheck && npm test` pass.
- [ ] **Step 5: Commit** — `git commit -m "feat(analytics-ui): lean React bundle + /analytics route"`.

### Task 10: Data hooks + types

**Files:**
- Create: `frontend/analytics/api.ts`, `frontend/analytics/types.ts`
- Test: `frontend/analytics/__tests__/api.test.ts`

**Interfaces:**
- Produces: `useAnalyticsOverview(from: string, to: string)` and `useCustomerInsights()` (TanStack Query) hitting `/api/v2/analytics/overview` and `/customer_insights`; TS types matching the compose payload (Task 7) and `get_customer_insights` (`services/customer_service.py`).

- [ ] **Step 1: Write failing test** — the hook calls the right URL with `start`/`end` and returns typed data (mock fetch).
- [ ] **Step 2: Run to verify it fails** → FAIL.
- [ ] **Step 3: Implement hooks + types.**
- [ ] **Step 4: Verify** — `npm test && npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat(analytics-ui): data hooks + types"`.

### Task 11: Overview KPI strip + date-range picker

**Files:** Create `frontend/analytics/sections/Overview.tsx`, `frontend/analytics/RangePicker.tsx`; Test `__tests__/Overview.test.tsx`

**Interfaces:** Consumes `useAnalyticsOverview` (Task 10); reuses `StatCard`, `lib/format.money`.

- [ ] **Step 1: Failing test** — given a mocked payload, the strip shows Occupancy %, ADR, RevPAR, Net revenue, next-7-night on-books, each formatted.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement the StatCard strip + range presets (Today/7d/30d/This month/Custom) driving one query.**
- [ ] **Step 4: Verify** — `npm test && npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat(analytics-ui): overview KPI strip + range picker"`.

### Task 12: Channel mix card

**Files:** Create `frontend/analytics/sections/ChannelMix.tsx`; Test `__tests__/ChannelMix.test.tsx`

- [ ] **Step 1: Failing test** — renders a row per channel with gross, commission, **net**, net ADR, share %; a donut/bar from `charts.PALETTE`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement (Recharts, no animation).**
- [ ] **Step 4: Verify** — `npm test && npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat(analytics-ui): channel mix card"`.

### Task 13: Booking pace card

**Files:** Create `frontend/analytics/sections/BookingPace.tsx`; Test `__tests__/BookingPace.test.tsx`

- [ ] **Step 1: Failing test** — shows forward occupancy % and on-books revenue for 7/14/30 horizons; renders the pace-vs-prior delta when present and hides it when `null`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — `npm test && npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat(analytics-ui): booking pace card"`.

### Task 14: Seasonality card

**Files:** Create `frontend/analytics/sections/Seasonality.tsx`; Test `__tests__/Seasonality.test.tsx`

- [ ] **Step 1: Failing test** — a weekday bar (7 bars) and a 12-point month line for occupancy/ADR/RevPAR.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — `npm test && npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat(analytics-ui): seasonality card"`.

### Task 15: Length-of-stay & lead-time card

**Files:** Create `frontend/analytics/sections/StayShape.tsx`; Test `__tests__/StayShape.test.tsx`

- [ ] **Step 1: Failing test** — two histograms; the lead-time chart shows a distinct "walk-in" bucket.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — `npm test && npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat(analytics-ui): LOS & lead-time card"`.

### Task 16: Customers section (reused insights)

**Files:** Create `frontend/analytics/sections/Customers.tsx`; Test `__tests__/Customers.test.tsx`

**Interfaces:** Consumes `useCustomerInsights` (Task 10); drill-through via `/customer_segment?dimension=&key=`.

- [ ] **Step 1: Failing test** — KPI tiles (repeat rate, lifetime revenue, avg spend/stays, dues, Pareto share), RFM segment bars (loyalty/value/recency), 12-month acquisition line, top guests; the whole section is hidden when the viewer lacks `customer.manage` (mock a 403).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement as its own clearly-delimited section.**
- [ ] **Step 4: Verify** — `npm test && npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat(analytics-ui): customers section (reused insights)"`.

### Task 17: Findings strip + page assembly + verify in browser

**Files:** Modify `frontend/analytics/App.tsx` (compose all sections + findings strip); Test `__tests__/App.test.tsx`

- [ ] **Step 1: Failing test** — `App` renders every section in order plus the plain-language findings strip from `overview.findings`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Assemble the page; wire the findings strip.**
- [ ] **Step 4: Verify** — `npm run build && npm run typecheck && npm test`; then run the app (`python -m tests.demo_server` or dev server), open `/analytics`, confirm the sections render against seeded data and the payload carries no raw bill/payment arrays (network tab).
- [ ] **Step 5: Commit** — `git commit -m "feat(analytics-ui): assemble analytics page + findings"`.
