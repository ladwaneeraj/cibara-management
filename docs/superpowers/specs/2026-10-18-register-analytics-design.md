# Register-based Analytics — design

**Date:** 2026-10-18
**Owner:** Neeraj (lodge owner)
**Status:** Awaiting approval

---

## 1. Intent and the why

The current **Daily Insights** screen (classic Jinja + `static/analytics.js`, backed by
`routes/insights.py` → `services/insights_service.py` + `services/kpi_service.py`) has two
problems the owner wants fixed:

1. **Wrong data source.** Occupancy / ADR / RevPAR are derived from the **`bills`
   collection** (`insights.py:_fetch_bills`). Bills are created at checkout, so this basis
   depends on a bill doc existing per stay, can misread cancelled/reverted stays, and does not
   reflect what the **register** (the check-in ledger) actually shows. The register
   (`/get_register_data`, `routes/billing.py`) is the operator's ground truth: it merges
   `rooms` (live occupancy) + `payments` + `bills` + `bookings`, including in-house stays and
   orphan recovery. **All figures on the new screen must derive from this ground truth, not
   from `bills` alone.**

2. **Clumsy, poorly-organised UI.** The owner wants a fresh, high-quality, better-organised
   screen, built in React, that also **fetches less data from the DB / over the wire** than the
   current screens do.

Alongside the rebuild, add four decision/marketing analyses the business currently lacks:

- **(1) Channel mix & net profitability** — revenue by booking channel, net of OTA commission.
- **(4) Booking pace / forward occupancy** — how full the next N nights are, on the books.
- **(5) Day-of-week & seasonality** — occupancy/ADR/RevPAR by weekday and by month.
- **(6) Length-of-stay & lead-time** — distribution of stay length and how far ahead guests book.

The page also surfaces the **existing Customer insights** (RFM segments, repeat rate, lifetime
revenue, Pareto concentration, 12-month acquisition trend, top guests, win-back cohort) as its own
**Customers section**, so the owner has guest/CRM analytics in the same place as operations and
channel analytics.

### Why now / what success looks like
The property runs on backward-looking accounting reports. These four add the forward-looking and
channel views that actually drive **pricing and marketing-spend decisions**. Success = the owner
opens one clean screen and can answer "are we filling up next week?", "is Booking.com worth the
commission?", "which weekday/month is soft?", and "how long do guests stay?" — each in a glance,
loading quickly.

## 2. Goals, non-goals, anti-goals

**Goals**
- A new, standalone React analytics page, embedded in the classic app at its own route
  (`/analytics`), **without** flipping the whole app to `UI_MODE=spa`. Classic screens stay the UI.
- All KPIs (occupancy, ADR, RevPAR, revenue, collections) computed from the register ground-truth
  collections (`rooms` + `payments` + `bills` + `bookings`), via one lean server-side aggregation.
- The four new analyses above.
- Fewer/narrower Firestore reads than today: server does the aggregation and returns a **small**
  JSON payload (no per-bill arrays shipped to the browser); `.select()` projections everywhere;
  cached per window like the existing insights endpoint.
- Admin-only (`analytics.view`), matching the existing insights gate.

**Non-goals**
- Not touching GST / GSTR-1 / ITC / expense screens — those stay classic and stay on their
  current (correct, accounting-basis) data. The new page is decision/marketing analytics, not a
  tax filing tool.
- Not re-implementing any money/tax logic. No change to preserved logic (CLAUDE.md §2).
- Not flipping to the SPA; not rebuilding other modules in React.

**Anti-goals (would make this a failure even if it "works")**
- Occupancy numbers that disagree with what the owner sees in the register.
- A heavier page (more DB reads or a bigger payload) than the screen it replaces.
- Introducing a second auth/session mechanism — it must reuse the existing JWT session.

## 3. Constraints (from the codebase)

- **UI decision reversal is scoped.** CLAUDE.md records a firm owner decision to keep classic
  screens and park React. This design is an explicit, owner-approved **exception for the analytics
  page only** — the rest of the app stays classic. `UI_MODE` is not touched.
- **One process, one Cloud Run instance, `--max-instances=1`.** Caching is in-process (same as
  `insights.py`). No new infra required for the core feature.
- **Auth.** The page must authenticate with the existing access JWT and the `auth.js` fetch
  protocol (refresh-on-401, `X-Op-Id`), exactly as classic screens do. `analytics.view` = admin.
- **Stack already present in `frontend/`:** React 18.3, Vite 6, Tailwind 4, Recharts 2.15,
  TanStack Query 5, Zustand 5, lucide-react. The design system (`src/index.css` tokens,
  `src/components/ui`, `charts.PALETTE`) is reused — this is where "high quality UI" comes from.
- **Data that exists:** `rooms` (live status, 30s cached via `get_all_rooms`), `payments`
  (date-ranged), `bills` (checkin/checkout ranges, `booking_source`, `payment_source`,
  `ota_commission_gst`, `room_charges_total`, GST fields), `bookings` (future reservations:
  `check_in_date`, `check_out_date`, `status`, `booking_source`, `paid_amount`, `total_amount`,
  `room`), `expenses` (`booking_commission` category for OTA commission paid).

## 4. The parts of "how" that are decided

### 4a. Backend — one lean aggregation endpoint + a pure service
- **New pure module `services/register_analytics_service.py`** (no Firestore, no Flask — unit
  tested, mirroring `insights_service.py` / `kpi_service.py`). It receives already-fetched,
  projected rows and computes the whole payload: overview KPIs, channel mix, booking pace,
  day-of-week + month seasonality, LOS + lead-time distributions. Occupancy/ADR/RevPAR reuse
  `kpi_service.compute_kpis` so the metric definitions stay single-sourced.
- **"Register basis" for stays:** the stay universe is built the way the register builds it —
  live `rooms` (in-house, counted to "today") unioned with `bills`/completed stays for the
  window, de-duplicated on the active stay id, cancelled/voided excluded. This is the ground
  truth the owner trusts, and it fixes the bills-only blind spot.
- **New route `GET /api/v2/analytics/overview?from=&to=`** (native FastAPI router
  `backend/cibara_api/routers/analytics.py`), `@requires_permission("analytics.view")`.
  - Fetches the ground-truth collections **concurrently** (thread pool, like `insights.py`), each
    with a `.select()` projection of only the fields the service needs.
  - Caches the computed payload per window in-process (TTL ~120s, `fresh=1` bypass) — same pattern
    as `insights.py`.
  - Returns a **small** JSON: aggregates and chart series only. **No per-bill / per-payment arrays
    are sent to the browser** (that is the "less data from DB / over the wire" win vs the current
    screens, which ship full log arrays).
- A classic-friendly twin (`/analytics_overview` on the Flask side) is **not** added; the page
  calls the v2 endpoint through the shared fetch wrapper, which already accepts the JWT.
- **Customer insights are NOT re-aggregated** — the Customers section calls the existing
  `/customer_insights` (+ `/customer_segment`) endpoints as-is. Note the permission difference:
  customer insights are gated by `customer.manage`, the overview by `analytics.view` (both
  admin-only today). The Customers section renders only for a user holding `customer.manage`;
  otherwise it's hidden with the rest of the page intact.

### 4b. Frontend — a dedicated lean React bundle at `/analytics`
- **A separate, small Vite entry** (`frontend/analytics/`, its own `index.html` + `main.tsx`,
  Vite `base: '/analytics/'`, built to its own `dist`), **reusing** the shared design system from
  `frontend/src` via the `@` path alias (tokens, `components/ui`, `charts.PALETTE`, `lib/api`,
  `lib/format`, the auth store). This gives a high-end React UI **without** pulling in the whole
  SPA router/screens, so the bundle the browser loads is small.
  - *Design call:* a dedicated bundle (not `UI_MODE=spa`, not a new `/app/analytics` route that
    loads the full SPA) — it is the smallest thing that satisfies "embedded new React page, high
    quality UI, less loaded".
- **Served by FastAPI** at `/analytics` (static index that boots the bundle), and in the classic
  Flask app a nav link to `/analytics` is added for users with `analytics.view`. Dev: Vite proxy
  already forwards `/api`, `/legacy`, `/static` to uvicorn.
- **Auth:** reuses the access JWT via `lib/api.api()` (refresh-on-401, `X-Op-Id`), so no new
  session mechanism. On a hard 401/denied it bounces to the classic login, same as the SPA.
- **Data layer:** TanStack Query against the single `/api/v2/analytics/overview` endpoint; the
  date-range picker (Today / 7d / 30d / this month / custom) drives one query. One request per
  window; cache + `fresh` refresh button.
- **Layout (fresh, organised):**
  - A compact KPI strip (StatCard style): Occupancy %, ADR, RevPAR, Net revenue, Collections,
    On-the-books next 7 nights.
  - **Channel mix** card: stacked bar / donut of revenue by channel + a table with gross, OTA
    commission, **net revenue**, net ADR, and share %.
  - **Booking pace** card: forward occupancy % for the next 7/14/30 nights (line/area), with
    on-the-books revenue.
  - **Seasonality** card: occupancy/ADR/RevPAR by weekday, and a 12-month month-over-month line.
  - **Length-of-stay & lead-time** card: two histograms.
  - **Customers section** (separate, clearly delimited): reuses the existing
    `GET /customer_insights` endpoint (`services/customer_service.get_customer_insights` — already
    one bounded `.select()` scan, 5-min cached, so **no backend rework**). Shows the KPI tiles
    (base size, repeat rate, lifetime revenue, avg spend/stays, active base, dues, Pareto share),
    the RFM segment bars (loyalty / value / recency), the 12-month acquisition line, and top guests
    by spend / stays. Segment bars drill through via the existing `/customer_segment` endpoint.
    Rendered with the same React design system as the rest of the page.
  - A short "What to look at" rules strip (reuse the `generate_insights` idea: plain-language
    findings) — extended with channel/pace rules.

### 4c. The four analyses — definitions
- **(1) Channel mix & net profitability.** Bucket stays by channel (derived from
  `booking_source` / `payment_source`: Direct/Walk-in, MMT, Agoda, Booking.com, …). Per channel:
  gross room revenue, OTA commission (`ota_commission_gst` on bills + `booking_commission`
  expenses attributed to that platform), **net revenue = gross − commission**, net ADR, and share
  of total. Plus a direct-share-over-time line.
- **(4) Booking pace / forward occupancy.** For the next 7/14/30 nights from today: occupied
  room-nights = in-house stays projected forward (their expected checkout) + confirmed future
  `bookings`, over available room-nights. Shows forward occupancy % and on-the-books revenue.
  **Decided:** ship this forward view now AND add a small **nightly snapshot job** (one tiny doc
  per night: date + on-the-books occupancy/revenue for the next horizon) so real pace/pickup
  "vs prior" works going forward. The snapshot is a scheduled write (Cloud Scheduler → a new
  ingest-style endpoint, or the existing scheduled-task infra); a new `analytics_snapshots`
  collection, append-only, never touches money/tax data. Pace-vs-prior charts read these
  snapshots once they accumulate.
- **(5) Day-of-week & seasonality.** Run `compute_kpis` per weekday bucket (Mon–Sun) across the
  window, and per calendar month across the last 12 months. Surfaces soft weekdays/months for
  pricing & staffing.
- **(6) Length-of-stay & lead-time.** LOS = `checkout − checkin` nights, bucketed (1, 2, 3, 4–6,
  7+). Lead-time = `check_in_date − booking_created` for `bookings` rows (walk-ins are lead 0 and
  shown as a separate "walk-in" bar, since only booked stays have meaningful lead time).

### 4d. Tests
- `services/register_analytics_service.py` gets a pure unit-test suite (`tests/`), golden figures
  for each analysis, mirroring `tests/test_insights_service.py` and `tests/test_customer_insights.py`.
- A parity-style check: occupancy/ADR/RevPAR from the register basis is asserted against
  `kpi_service` on a shared fixture, so the rebuild can't silently drift from the defined metrics.
- Frontend: Vitest + RTL for the cards' render + formatting; `tsc` strict; ESLint.

## 5. What's left to the builder
- Exact `booking_source` / `payment_source` value set and how each maps to a channel label
  (derive from the data + `mmt_ingest`/`agoda_ingest` services; minor).
- Where precisely the `/analytics` link sits in the classic nav and its icon.
- Projection field lists for each `.select()` and the concurrent-fetch wiring (follow
  `insights.py`).
- The lean Vite entry wiring (second `index.html`/`main.tsx`, build output path, FastAPI static
  mount) and the Dockerfile build step for the extra bundle.
- Chart choices within the agreed cards (Recharts), copy for the findings rules.

## 6. Owner decisions (resolved 2026-10-18)

- **A. Booking pace — snapshots: YES.** Ship the forward on-the-books view now AND add the nightly
  snapshot job so pace/pickup-vs-prior works going forward (see analysis (4) above). A new
  append-only `analytics_snapshots` collection; no money/tax data involved.
- **B. Rollout — alongside.** The new `/analytics` page ships as a new screen; the existing classic
  Daily Insights tab stays in place until the owner is happy with the new one, then it can be
  retired in a later change. Nothing is removed in this work.
