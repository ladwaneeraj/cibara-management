# Bookings React Island — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace only the ERP **Bookings** tab UI with a self-contained React "island" — same theme, same API contract, Razorpay/web-booking backend untouched — as the first step of an incremental Flask→React migration.

**Architecture:** A Vite + React + TypeScript app builds a single external bundle (`static/react/bookings.js` + `bookings.css`) loaded `defer` via the existing `asset_url()` helper (CSP-safe `script-src 'self'`, no inline, no nonce). It mounts once at page load into a new `<div id="bookings-react-root">` inside `#bookings-tab`, owns the tab's list/calendar/timeline + all booking modals, and talks to the **unchanged** Flask endpoints through the global `window.apiFetch` (inheriting JWT/refresh/duplicate-guard). It re-exposes three globals (`window.fetchBookings`, `window.showBookingDetails`, `window.showNewBookingModalForDate`) so the room-grid calendar (`room-calendar.js`) keeps working. The old parked SPA (`frontend/` SPA, `/app` + `UI_MODE` machinery, Dockerfile web stage) is removed and `frontend/` is rebuilt fresh for the island.

**Tech Stack:** Vite 5, React 18.3.1, TypeScript 5.6, Vitest + React Testing Library, Playwright (smoke). No runtime UI framework beyond React; styling reuses classic CSS tokens (`static/style.css`) and `.bk-*`/`.ub-*` classes (`static/booking.css`).

**Spec:** This plan's spec is the task brief in the originating conversation (the pasted "Convert the ERP Bookings tab to a React island" message) plus the repo's `CLAUDE.md`. Key verbatim constraints are copied into Global Constraints below.

## Global Constraints

- **Razorpay/web-booking stays intact.** Do NOT modify `routes/web.py`, `services/availability_service.py`, `services/razorpay_service.py`, or hold/order/webhook/sweep behavior. React only *consumes* booking APIs.
- **Other tabs untouched.** `static/booking.js` (5137 lines) exposes bare globals; only `room-calendar.js` consumes them, and only these three: `fetchBookings()`, `showBookingDetails(bookingId)`, `showNewBookingModalForDate(dateStr)` — all called behind `typeof … === "function"` guards (`static/room-calendar.js:591-688`). These three names MUST remain callable globals after the island loads.
- **API contract unchanged.** Reuse exactly: `GET /get_bookings`, `GET /get_upcoming_bookings_list`, `POST /create_booking`, `POST /create_multi_booking`, `POST /update_booking`, `POST /cancel_booking`, `POST /convert_booking_to_checkin`, `POST /check_availability`, `POST /send_booking_confirmation`, `POST /mark_ota_settlement`, `GET /get_ota_settlements`, `GET /get_mmt_unsettled`, and `POST /mmt/ingest` (Fetch Bookings). No renames; no new backend business logic. Request/response shapes are defined by `routes/bookings.py` (see Interfaces of Task 2).
- **No top KPI/stat cards** anywhere in the Bookings tab.
- **CSP:** bundle must be an external file under `/static/` (served `'self'`). No inline `<script>` blobs. No nonce needed (classic CSP is `script-src 'self' 'unsafe-inline'`, `backend/cibara_api/core/middleware.py:45`).
- **Theme:** reuse CSS variables from `static/style.css` (`--primary #4361ee`, `--success #2ec4b6`, `--warning #ff9f1c`, `--danger #e63946`, bg `#f5f7fb`, Segoe UI font stack) and the `#bookings-tab .bk-*` / `.ub-*` classes. The island must look like the rest of the ERP. Prefer reusing existing classes; add new styles only in the island's own stylesheet scoped under `#bookings-react-root`.
- **Writes** go through `window.apiFetch` only (never raw `fetch`), so the `X-Op-Id` duplicate-submit protocol and 401-refresh retry apply. Each mutating call sends a fresh `X-Op-Id` (uuid) and the same id on a single retry.
- **Transient statuses** `pending_payment` / `expired` are already hidden by `/get_bookings`; never surface them. Statuses handled by the UI: `confirmed`, `checked_in`, `checked_out`, `cancelled`, plus a new client-tracked `no_show` (see Task 16).
- **Backend test suites must stay green and unchanged**: `python -m pytest tests` (legacy, 557 tests) and `cd backend && python -m pytest tests`. The island changes no Python business logic; the only backend-adjacent edits are `main.py`/`Dockerfile` SPA removal (Task 1) and `templates/index.html` wiring (Task 4), covered by their own checks.

## Review Focus

- **401 mid-session on a write** — `window.apiFetch` refreshes and retries once with the same `X-Op-Id`; the island must not double-submit nor show a spurious error. Pinned in Task 3.
- **Duplicate-submit (double-click New Booking / Collect payment)** — second click must reuse the in-flight op or be blocked, yielding one booking/payment, not two. Pinned in Task 3 + Task 12.
- **Overlapping/overbooked dates** — `/check_availability` and `/create_multi_booking` reject conflicts; the availability-first New Booking and timeline must reflect server truth and warn, never silently book a taken room. Pinned in Task 13 + Task 15.
- **Malformed/missing `check_in_time` or non-ISO dates** — list/calendar/timeline must not crash or mis-sort (backend already tolerates; client parsing must match `booking.js` fallbacks: time→`"14:00"` display default, sort default `"00:00"`/`"23:59"`). Pinned in Task 6.
- **OTA (mmt/agoda) bookings** — prepaid, no hotel balance, settlement fields; cards/drawer/actions must show OTA state and not offer "Collect payment" the way a walk-in does. Pinned in Task 7 + Task 11.

---

## File Structure

**Removed:** NOTHING. (Superseded by owner ruling 2026-11-01: `frontend/` builds the live `/analytics` bundle served in classic/prod, so it stays. The parked `/app` SPA + `UI_MODE` + Dockerfile frontend stage are left untouched.)

**Created — island app (self-contained, new dir `web/`):**
- `frontend/package.json`, `frontend/package-lock.json`, `frontend/tsconfig.json`, `frontend/vite.config.ts`, `frontend/.eslintrc.cjs`, `frontend/vitest.setup.ts`
- `frontend/src/main.tsx` — mount + global bridge
- `frontend/src/theme/tokens.ts` — CSS-var mirror (foundation for later tabs)
- `frontend/src/theme/island.css` — scoped styles under `#bookings-react-root`
- `frontend/src/api/client.ts` — typed `apiFetch` wrapper
- `frontend/src/api/bookings.ts` — typed endpoint functions
- `frontend/src/types/booking.ts` — `Booking`, enums, request/response types
- `frontend/src/lib/format.ts` — date/time/money helpers (parity with `booking.js`)
- `frontend/src/lib/bookingFilters.ts` — filter/sort/search/group pure functions
- `frontend/src/state/useBookings.ts` — data hook (fetch/refresh/cache)
- `frontend/src/BookingsApp.tsx` — tab shell (toolbar, filters, view switch)
- `frontend/src/views/ListView.tsx`, `CalendarView.tsx`, `TimelineView.tsx`
- `frontend/src/components/BookingCard.tsx`, `BookingDrawer.tsx`, `QuickActions.tsx`, `SearchSortBar.tsx`, `FilterBar.tsx`, `EmptyState.tsx`, `Toast.tsx`
- `frontend/src/modals/NewBookingModal.tsx`, `MultiBookingModal.tsx`, `UpdateBookingModal.tsx`, `CancelModal.tsx`, `ConvertCheckinModal.tsx`, `PaymentModal.tsx`, `OtaSettlementsModal.tsx`, `ArrivalsSheet.tsx`
- `frontend/src/lib/whatsapp.ts`, `frontend/src/lib/exportCsv.ts`
- Tests colocated as `*.test.ts(x)` beside each unit; `frontend/e2e/bookings.spec.ts`

**Modified:**
- `templates/index.html` — add `#bookings-react-root`, bundle `<link>`+`<script>` (Task 4); neutralize `booking.js` tab rendering (Task 5)
- `static/booking.js` — remove bookings-tab rendering + modal ownership; keep nothing the island replaces except what room-calendar needs, which the island now provides (Task 5)
- `Dockerfile` — web stage builds island → copies into `static/react/` (Task 1)
- `.github/workflows/ci.yml` — point SPA job at new `frontend/` (Task 18)

---

## Task 1: Remove old SPA, scaffold fresh island tooling, wire the build

**Files:**
- Delete: `frontend/` (entire old SPA tree)
- Create: `frontend/package.json`, `frontend/package-lock.json`, `frontend/tsconfig.json`, `frontend/vite.config.ts`, `frontend/.eslintrc.cjs`, `frontend/src/main.tsx` (stub), `frontend/index-dev.html` (dev harness only, not shipped)
- Modify: `backend/cibara_api/main.py` (remove `/app`+`UI_MODE` block, ~lines 105-168), `backend/cibara_api/core/config.py` or settings module (remove `UI_MODE`), `Dockerfile` (lines 11-16, 38)
- Test: `frontend/src/main.test.tsx` (smoke), manual build-output assertion

**Interfaces:**
- Produces: a working `npm run build` in `frontend/` that emits exactly `static/react/bookings.js` and `static/react/bookings.css` (fixed names; `asset_url` adds `?v=mtime` for cache-busting — chosen over hashed filenames so the template reference is stable). `npm run dev` serves a standalone harness at `:5173` proxying `/`→`:8080` for island development. `npm test` runs Vitest; `npm run typecheck` runs `tsc --noEmit`; `npm run lint` runs ESLint.

**Decisions (plan author's calls):**
- Vite `build.outDir='dist'` (inside `frontend/`), `rollupOptions.output.entryFileNames='bookings.js'`, `assetFileNames='bookings.css'`, `manualChunks:undefined` (single chunk). A `postbuild` npm script copies `dist/*` → `../static/react/` cross-platform (via a tiny `scripts/copy-dist.mjs` using `node:fs`). Docker web stage copies `/web/dist` → `/app/static/react`.
- Pin exact versions: `react@18.3.1`, `react-dom@18.3.1`, `vite@5.4.10`, `typescript@5.6.3`, `@vitejs/plugin-react@4.3.3`, `vitest@2.1.4`, `@testing-library/react@16.0.1`, `@testing-library/jest-dom@6.6.3`, `jsdom@25.0.1`, `@playwright/test@1.48.2`, `eslint@9.13.0` + `typescript-eslint@8.11.0`.

- [ ] **Step 1:** Delete the old `frontend/` tree. Verify nothing outside `frontend/` imports it: `grep -rn "frontend/src" backend templates static` returns no runtime references (only `main.py`/`Dockerfile` serve `frontend/dist`, handled below).
- [ ] **Step 2:** Create `frontend/package.json` with scripts (`dev`,`build`,`postbuild`,`preview`,`test`,`typecheck`,`lint`,`e2e`) and the pinned deps above; `npm install` to generate `package-lock.json`.
- [ ] **Step 3:** Create `vite.config.ts`, `tsconfig.json` (strict), `.eslintrc.cjs`, `vitest.setup.ts` (imports `@testing-library/jest-dom`), and `frontend/src/main.tsx` stub that renders `<div>island</div>` into `#bookings-react-root` if present.
- [ ] **Step 4:** Write `frontend/src/main.test.tsx` asserting the stub mounts into a provided root element. Run `npm test` → PASS.
- [ ] **Step 5:** Run `npm run build` and assert `static/react/bookings.js` exists and is non-empty (and `bookings.css` if any CSS imported). Expected: files present.
- [ ] **Step 6:** Edit `backend/cibara_api/main.py` — remove the `UI_MODE`/`/app`/`_spa`/`_spa_off` block; keep the legacy WSGI mount (`app.mount("/", …)`) and `/api/v2`. Remove `UI_MODE` from settings. Run `cd backend && python -m pytest tests -q` → PASS (no test asserts `/app`; if one does, update it to expect the route absent).
- [ ] **Step 7:** Rewrite `Dockerfile` web stage: `COPY frontend/package.json frontend/package-lock.json`, `npm ci`, `COPY frontend/`, `npm run build`; stage 2 replaces `COPY --from=web /web/dist ./frontend/dist` with `COPY --from=web /web/dist ./static/react`. Build check: `docker build .` succeeds OR (if Docker unavailable) a documented note that the `COPY` path matches the Vite output.
- [ ] **Step 8:** Commit. `git commit -m "chore(bookings): remove parked SPA, scaffold React island tooling"`

## Task 2: Booking types + typed API layer

**Files:**
- Create: `frontend/src/types/booking.ts`, `frontend/src/api/client.ts`, `frontend/src/api/bookings.ts`
- Test: `frontend/src/api/bookings.test.ts`, `frontend/src/api/client.test.ts`

**Interfaces:**
- Produces:
  - `type BookingStatus = 'confirmed'|'checked_in'|'checked_out'|'cancelled'|'no_show'`
  - `type BookingSource = 'normal'|'mmt'|'agoda'|'walk_in'|string`
  - `interface Booking { booking_id:string; room:string; guest_name:string; guest_mobile:string; check_in_date:string; check_in_time?:string; check_out_date:string; status:BookingStatus; booking_source:BookingSource; guest_count?:number; total_amount:number; paid_amount:number; balance:number; is_ac?:boolean; rate_per_night?:number|null; notes?:string; group_booking_id?:string; stay_id?:string; razorpay_order_id?:string; receipt?:string; created_at?:string; settlement_status?:'pending'|'received'; net_receivable?:number; ota_total_amount?:number; cancellation_reason?:string; no_show?:boolean }` (optional fields reflect that `/get_bookings` returns raw docs; see `routes/bookings.py:31-57`).
  - `api.getBookings(): Promise<Booking[]>`, `getUpcomingList()`, `createBooking(payload)`, `createMultiBooking(payload)`, `updateBooking(payload)`, `cancelBooking(payload)`, `convertToCheckin(payload)`, `checkAvailability({check_in_date,check_out_date}): Promise<string[]>`, `sendConfirmation(payload)`, `getOtaSettlements()`, `getMmtUnsettled()`, `markOtaSettlement(payload)`, `fetchFromMmt()`. Each returns parsed data or throws `ApiError{message}` when `success:false`.
  - `client.apiFetch(path, init?)` — thin wrapper over `window.apiFetch` (falls back to `window.fetch`), JSON-encodes bodies, sets `Content-Type: application/json`, attaches a fresh `X-Op-Id` (uuid v4) on mutating methods, parses `{success,message,...}` and throws on `success===false` or non-2xx.
- Consumes: `window.apiFetch` (global from `static/auth.js:871`).

- [ ] **Step 1:** Write `client.test.ts`: (a) GET parses `{success:true,bookings:[…]}`; (b) `{success:false,message:'x'}` throws `ApiError('x')`; (c) a mutating POST sets an `X-Op-Id` header; (d) uses `window.apiFetch` when present, else `window.fetch`. Mock `window.apiFetch`.
- [ ] **Step 2:** Run `npm test src/api/client.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `types/booking.ts` and `api/client.ts` per Interfaces.
- [ ] **Step 4:** Write `bookings.test.ts`: assert `getBookings()` returns `Booking[]` from a mocked response and `checkAvailability()` returns `available_rooms`. Implement `api/bookings.ts`.
- [ ] **Step 5:** Run `npm test src/api` → PASS. `npm run typecheck` → PASS.
- [ ] **Step 6:** Commit. `git commit -m "feat(bookings): typed booking model + API layer over apiFetch"`

## Task 3: Theme tokens + apiFetch resilience (refresh/duplicate) harness

**Files:**
- Create: `frontend/src/theme/tokens.ts`, `frontend/src/theme/island.css`
- Modify: `frontend/src/api/client.ts` (retry semantics already in `window.apiFetch`; the wrapper must NOT add its own retry — it must pass through so the single-flight refresh+same-`X-Op-Id` retry in `auth.js` governs)
- Test: `frontend/src/api/client.retry.test.ts`

**Interfaces:**
- Produces: `tokens` object mirroring CSS vars (`primary`, `success`, `warning`, `danger`, `bg`, status colors) as TS constants for inline/JS use; `island.css` importing nothing external, all selectors prefixed `#bookings-react-root`. Review-Focus items "401 retry" and "duplicate-submit" are pinned here.

- [ ] **Step 1:** Write `client.retry.test.ts`: when `window.apiFetch` itself performs the retry (simulate a stub that returns 401 then 200 for the same call), the wrapper resolves once with the 200 body and issues exactly one logical call from the island's perspective (no second `X-Op-Id` generated by the wrapper). Assert the wrapper does not re-invoke on non-ok without `window.apiFetch`'s involvement.
- [ ] **Step 2:** Run → FAIL. 
- [ ] **Step 3:** Ensure `client.apiFetch` delegates the whole request to `window.apiFetch` (one call) and only maps the final response; generate `X-Op-Id` once per logical mutation and let the caller reuse it (expose `opId` option so a retry-by-caller, if ever needed, reuses it).
- [ ] **Step 4:** Run → PASS. Create `tokens.ts` + `island.css` (values copied verbatim from `static/style.css`).
- [ ] **Step 5:** Commit. `git commit -m "feat(bookings): theme tokens + apiFetch resilience passthrough"`

## Task 4: Mount point + bundle wiring in the classic template

**Files:**
- Modify: `templates/index.html` (`#bookings-tab` at line 1743; asset block near 6279; stylesheet block near 58)
- Test: a Python template-render assertion in `backend/tests/` OR a documented manual check (the island mounts when `/legacy` loads)

**Interfaces:**
- Produces: inside `#bookings-tab`, a single `<div id="bookings-react-root"></div>` placed before the legacy `#bookings-list`/`#bookings-calendar-view` containers (which Task 5 hides). New `<link rel="stylesheet" href="{{ asset_url('react/bookings.css') }}">` and `<script defer src="{{ asset_url('react/bookings.js') }}"></script>` (loaded after `auth.js` so `window.apiFetch` exists; `defer` preserves order).

- [ ] **Step 1:** Confirm `asset_url('react/bookings.js')` resolves a subpath (it wraps `url_for('static', filename=…)`). If it does not handle subpaths, fall back to flat names `static/bookings-react.js` and adjust Vite output + Dockerfile copy accordingly. Verify by hitting the built URL once the bundle exists.
- [ ] **Step 2:** Add `#bookings-react-root` and the `<link>`/`<script>` tags.
- [ ] **Step 3:** Build island (`npm run build`), start the server (`python -m backend.tests.demo_server` or real), load `/legacy`, open Bookings — assert the React root renders (stub content) and no CSP violation appears in the console.
- [ ] **Step 4:** Commit. `git commit -m "feat(bookings): mount React island into classic Bookings tab"`

## Task 5: Carve out booking.js; provide compatibility globals

**Files:**
- Modify: `static/booking.js` (remove the tab-open `fetchBookings()` wiring at `:21-45`; remove `renderBookings`/`renderCalendar` DOM writes; stop owning the booking modals the island replaces), `static/booking.css` (keep — theme reuse), `templates/index.html` (legacy `#bookings-list`/`#bookings-calendar-view` get `hidden` or removed)
- Create: `frontend/src/bridge.ts` (the three globals)
- Test: `frontend/src/bridge.test.ts`; manual room-grid calendar check

**Interfaces:**
- Produces on `window`: `fetchBookings(): Promise<void>` (triggers the island's `useBookings` refresh), `showBookingDetails(bookingId: string): void` (opens the island drawer as a body portal), `showNewBookingModalForDate(dateStr: string): void` (opens the island New Booking modal prefilled with the date). These replace `booking.js`'s versions so `room-calendar.js:591-688` keeps working.
- Decision: because `room-calendar.js` needs these from any tab, the island mounts **once at load** (not on tab open) and renders drawer/modals as portals to `document.body`; list/calendar/timeline render inside `#bookings-react-root`.

- [ ] **Step 1:** Write `bridge.test.ts`: after `installBridge(controller)`, calling `window.showBookingDetails('x')` invokes `controller.openDrawer('x')`; `window.showNewBookingModalForDate('2026-11-05')` invokes `controller.openNewBooking({date:'2026-11-05'})`; `window.fetchBookings()` invokes `controller.refresh()` and resolves.
- [ ] **Step 2:** Run → FAIL. Implement `bridge.ts` + an event-bus/controller the app registers in `main.tsx`.
- [ ] **Step 3:** Run → PASS.
- [ ] **Step 4:** Edit `static/booking.js`: delete the `nav-item[data-tab="bookings"]` click→`fetchBookings` wiring and the `renderBookings`/`renderCalendar`/filter/view-button handlers and the modal-opening buttons it owns (`new-booking-btn`, `mmt-settlements-btn`, `fetch-mmt-btn` now handled by the island). Remove the now-dead render/modal functions. Keep any pure helper the island does not reimplement only if still referenced; otherwise remove. Ensure `booking.js` no longer defines `fetchBookings`/`showBookingDetails`/`showNewBookingModalForDate` (the island owns these). Load order: `booking.js` stays but is now near-empty or deleted from the template if fully empty.
- [ ] **Step 5:** Run classic ESLint (`no-undef` hard error, per `CLAUDE.md §6.1`) over `static/*.js` → PASS (no reference to a now-undefined global).
- [ ] **Step 6:** Manually verify the **Rooms** tab calendar still opens booking details and new-booking-for-date via the island globals.
- [ ] **Step 7:** Commit. `git commit -m "refactor(bookings): hand Bookings-tab rendering to the island, keep room-calendar globals"`

---
## Slice 1 complete: list parity. Slices below add features.
---

## Task 6: Data hook + filter/sort pure functions (list parity)

**Files:** Create `frontend/src/state/useBookings.ts`, `frontend/src/lib/bookingFilters.ts`, `frontend/src/lib/format.ts`; Test alongside.

**Interfaces:**
- Produces: `useBookings()` → `{ bookings, loading, error, refresh, lastUpdated }`; `applyFilter(bookings, filter)`, `sortBookings(list, filter)`, `searchBookings(list, query)`, `buildBookingGroupIndex(bookings)`; `formatDate`, `formatTime`, `formatMoney`.
- Parity source of truth: `static/booking.js:1281-1352` (filter + sort). Replicate exactly:
  - `cancelled` status hidden unless filter=`cancelled`; `checked_in` hidden unless filter=`completed`; `upcoming`=confirmed & check-in≥today; `today`=confirmed & check-in==today; `all`=everything.
  - sort: completed/cancelled → date desc then time desc (missing time→`"23:59"`); else date asc then time asc (missing time→`"00:00"`).

- [ ] **Step 1:** Write `bookingFilters.test.ts` with fixtures covering every filter + the two sort branches + missing-time fallbacks + a non-ISO date that must not throw (Review Focus). Assertions mirror the branch table above.
- [ ] **Step 2:** Run → FAIL. Implement `bookingFilters.ts` + `format.ts` (format parity: time default display `"14:00"`, `booking.js:1376`).
- [ ] **Step 3:** Run → PASS.
- [ ] **Step 4:** Write `useBookings.test.ts`: mocks `api.getBookings`, asserts `refresh()` repopulates and `error` set on throw. Implement the hook (keeps last good data on refresh error).
- [ ] **Step 5:** Run → PASS. Commit `feat(bookings): data hook + parity filter/sort/search`.

## Task 7: BookingCard + ListView (visual + status parity, incl. OTA)

**Files:** Create `frontend/src/components/BookingCard.tsx`, `EmptyState.tsx`, `frontend/src/views/ListView.tsx`; Test alongside.

**Interfaces:**
- Consumes: `Booking`, `format.ts`, `bookingFilters`. Produces `<ListView bookings filter query sort onOpen onAction/>`.
- Card parity source: `static/booking.js:1364-1592` (fields shown: guest, room, dates, time, nights, guests, source badge, amount/paid/balance, status pill). OTA cards show source badge (MMT/Agoda), `net_receivable`, settlement state, and no walk-in "Collect payment" affordance (Review Focus).

- [ ] **Step 1:** Write `BookingCard.test.tsx`: renders guest/room/dates; shows a `MMT` badge and hides "Collect payment" when `booking_source==='mmt'`; shows balance-due styling when `balance>0`. 
- [ ] **Step 2:** Run → FAIL. Implement `BookingCard.tsx` using `.bk-*` classes/tokens.
- [ ] **Step 3:** Write `ListView.test.tsx`: given fixtures + filter `upcoming`, renders only matching cards in sorted order; empty filter → `EmptyState` with "No upcoming bookings found" (`booking.js:1357`). Implement.
- [ ] **Step 4:** Run → PASS. Commit `feat(bookings): booking card + list view parity`.

## Task 8: BookingsApp shell — toolbar, filters, view switch; replace legacy chrome

**Files:** Create `frontend/src/BookingsApp.tsx`, `components/FilterBar.tsx`, `components/ViewSwitch` (in shell); wire `main.tsx` to mount `BookingsApp` + `installBridge`. Test `BookingsApp.test.tsx`.

**Interfaces:**
- Produces `<BookingsApp/>` owning: toolbar (Arrivals Sheet, Fetch Bookings, OTA Settlements [perm `settlement.manage`], New Booking), filter pills (`upcoming/today/all/completed/cancelled` — labels per `index.html:1780-1792`, "Checked In"=`completed`), view switch (`list`/`calendar`/`timeline`). No top stat cards.
- Consumes bridge controller; registers `refresh/openDrawer/openNewBooking`.

- [ ] **Step 1:** Write test: renders 5 filter pills + 3 view buttons + 4 toolbar buttons; clicking a pill updates the list; OTA Settlements button hidden without `settlement.manage` (read perms from `window.CibaraAuth`/`data-perm`, mock it).
- [ ] **Step 2:** Run → FAIL. Implement shell; mount in `main.tsx`.
- [ ] **Step 3:** Run → PASS. Build + manual: Bookings tab shows the island shell with working filters/list; other tabs unaffected.
- [ ] **Step 4:** Commit `feat(bookings): island shell with toolbar/filters/views`.

## Task 9: CalendarView parity (month grid)

**Files:** Create `frontend/src/views/CalendarView.tsx` (+ day cell, day-details popover). Test alongside.
**Interfaces:** Parity source `static/booking.js:2107-2437` (`renderCalendar`, `createDayElement`, `showDayDetails`, `getCurrentMonthBookings`). Produces `<CalendarView bookings month onMonthChange onOpen/>` with prev/next/Today, legend, per-day booking bars colored by status.

- [ ] **Step 1:** Test: given bookings in a month, renders day cells with correct counts; clicking a day lists that day's bookings; month nav changes the visible range. 
- [ ] **Step 2:** FAIL → implement → PASS.
- [ ] **Step 3:** Commit `feat(bookings): calendar view parity`.

---
## Slice 2: search/sort/filters/drawer
---

## Task 10: SearchSortBar — instant search + sort controls

**Files:** Create `components/SearchSortBar.tsx`; extend `bookingFilters` with `sortBy: 'checkin'|'amount'|'balance'|'recent'`. Test alongside.
**Interfaces:** `<SearchSortBar query onQuery sortBy onSort/>`; `searchBookings` matches guest name / phone / room (case-insensitive substring). Sort options map to comparators; default per current filter (Task 6).

- [ ] **Step 1:** Test: typing "99" filters to matching phone/room; switching sort to `balance` orders by `balance` desc. 
- [ ] **Step 2:** FAIL → implement → PASS. Wire into shell. Commit `feat(bookings): instant search + sort`.

## Task 11: BookingDrawer (replaces details modal) + QuickActions

**Files:** Create `components/BookingDrawer.tsx`, `components/QuickActions.tsx`. Test alongside.
**Interfaces:** `<BookingDrawer bookingId … />` side-drawer (portal to body) showing full booking + payment history + activity; inline quick actions per card and in drawer: Check-in (→ConvertCheckinModal), Check-out (confirmed→ via convert then room flow is out-of-scope; here Check-out applies only to a stay — show only when `status==='checked_in'` and defer to legacy checkout by navigating to Rooms, documented), Cancel (→CancelModal), Collect payment (→PaymentModal; hidden for OTA prepaid), WhatsApp (→`lib/whatsapp.ts`). Source of truth for details content: `static/booking.js` `showBookingDetails`/`showOtaSettlementModal` regions.

- [ ] **Step 1:** Test: drawer opens for a booking id (via `window.showBookingDetails`), shows guest/dates/payments; QuickActions renders Cancel+WhatsApp always, Collect-payment only for non-OTA with balance>0, Check-in only for `confirmed`.
- [ ] **Step 2:** FAIL → implement drawer+actions → PASS.
- [ ] **Step 3:** Manual: open from a card and from the room-grid calendar (bridge). Commit `feat(bookings): detail side-drawer + quick actions`.

## Task 12: PaymentModal + UpdateBookingModal + CancelModal + ConvertCheckinModal

**Files:** Create the four modals under `frontend/src/modals/`. Test each.
**Interfaces:** Each posts via `api` with one `X-Op-Id`; on success calls `refresh()` + toast; on `success:false` shows the server message. Payloads match `routes/bookings.py`:
- Payment → `update_booking` with `{booking_id,new_payment,payment_method}` (`:609-688`).
- Update → `update_booking` updatable fields (`:638-660`).
- Cancel → `cancel_booking` `{booking_id,refund_amount,refund_method,reason,retain_as_charge}` (`:690-838`); surface returned `charge_bill_number`.
- Convert → `convert_booking_to_checkin` `{booking_id,remaining_payment,payment_method,room_price?}` with the Pay-Later rule (`balance`+amount rejected, `:875-880`).

- [ ] **Step 1:** For PaymentModal: test a successful payment calls `api.updateBooking` once with a `new_payment` and triggers refresh; double-submit guarded (button disabled while in-flight → one call) [Review Focus].
- [ ] **Step 2:** FAIL → implement → PASS. Repeat Steps for the other three modals (cancel: test refund>paid rejected client-side mirrors server; convert: test Pay-Later+amount blocked).
- [ ] **Step 3:** Commit per modal or one `feat(bookings): booking action modals (pay/update/cancel/convert)`.

---
## Slice 3: timeline + availability-first New Booking
---

## Task 13: NewBookingModal (availability-first) + MultiBookingModal

**Files:** Create `modals/NewBookingModal.tsx`, `modals/MultiBookingModal.tsx`, `frontend/src/lib/availability.ts`. Test alongside.
**Interfaces:** Flow: pick dates → `api.checkAvailability` → choose from free rooms → fill guest/amount → `api.createBooking` (single) or `api.createMultiBooking` (≥2 rooms, `rooms[]` shape from `routes/bookings.py:359-448`). OTA (mmt/agoda) source shows OTA fields and uses single-create only (multi rejects OTA server-side, `:392`). Opened for a prefilled date via `window.showNewBookingModalForDate`.

- [ ] **Step 1:** Test: selecting dates calls `checkAvailability` and lists only returned `available_rooms`; booking a listed room posts `create_booking` once; a conflicting/empty availability shows a warning and offers no room [Review Focus overbooking].
- [ ] **Step 2:** FAIL → implement single flow → PASS.
- [ ] **Step 3:** Test MultiBookingModal: ≥2 rooms, per-room validation (advance≤total), posts `create_multi_booking`; OTA source disabled. Implement → PASS.
- [ ] **Step 4:** Commit `feat(bookings): availability-first new booking + multi-room`.

## Task 14: ArrivalsSheet + Fetch Bookings + OtaSettlementsModal

**Files:** Create `modals/ArrivalsSheet.tsx`, `modals/OtaSettlementsModal.tsx`; toolbar handlers. Test alongside.
**Interfaces:** Arrivals → `api.getUpcomingList()` printable sheet (parity `print-arrivals-btn`). Fetch Bookings → `api.fetchFromMmt()` (`POST /mmt/ingest`) then `refresh()`. OTA Settlements → `getOtaSettlements` + `getMmtUnsettled` + `markOtaSettlement` (perm `settlement.manage`).

- [ ] **Step 1:** Test: OTA modal lists unsettled OTA bookings and marking one calls `markOtaSettlement` then refresh; Fetch calls ingest then refresh. 
- [ ] **Step 2:** FAIL → implement → PASS. Commit `feat(bookings): arrivals sheet, OTA fetch + settlements`.

## Task 15: TimelineView (rooms × dates grid, 3rd view) + overbooking warning

**Files:** Create `frontend/src/views/TimelineView.tsx`, `frontend/src/lib/timeline.ts`. Test alongside.
**Interfaces:** `buildTimeline(bookings, rooms, rangeStart, days)` → per-room lanes of booking spans; overlapping spans on one room flagged `conflict`. Renders a horizontally scrollable grid; clicking a span opens the drawer; clicking an empty cell opens New Booking prefilled (room+date).

- [ ] **Step 1:** Test `buildTimeline`: two bookings overlapping the same room produce a `conflict` marker; non-overlapping do not [Review Focus]. 
- [ ] **Step 2:** FAIL → implement lib → PASS. Implement view; add as 3rd view button (Task 8).
- [ ] **Step 3:** Commit `feat(bookings): reservation timeline view + overbooking warning`.

---
## Slice 4: payments/statuses/group
---

## Task 16: Payment tracking panel + no-show status

**Files:** Modify `BookingDrawer.tsx` (payment history, balance, due-at-check-in); add no-show action. Create `frontend/src/lib/noshow.ts`. Test alongside.
**Interfaces:** No-show: mark via `api.updateBooking({booking_id,status:'no_show'})` (uses the existing `status` updatable field, `routes/bookings.py:640`) — minimal backend use, no new endpoint. Drawer shows partial payments, balance, and "due at check-in". No-show bookings are hidden from `upcoming`/`today` (treat like cancelled for those filters) — extend `bookingFilters` and its tests.

- [ ] **Step 1:** Test: marking no-show posts `update_booking` with `status:'no_show'` and the booking leaves the `upcoming` list; payment panel sums `paid_amount`/`balance`. 
- [ ] **Step 2:** FAIL → implement → PASS. Commit `feat(bookings): payment tracking + no-show status`.

## Task 17: Group booking management (grouped view + group check-in)

**Files:** Modify `ListView.tsx`/`BookingCard.tsx` for grouped rendering by `group_booking_id`; add group actions. Test alongside.
**Interfaces:** `buildBookingGroupIndex` (Task 6) groups by `group_booking_id`; grouped cards show member rooms; "Group check-in" iterates members through `convertToCheckin` (sequential, each its own `X-Op-Id`), reporting per-room success/failure.

- [ ] **Step 1:** Test: three bookings sharing a `group_booking_id` render as one group; group check-in calls `convertToCheckin` per member and reports results. 
- [ ] **Step 2:** FAIL → implement → PASS. Commit `feat(bookings): group booking view + group check-in`.

---
## Slice 5: nice-to-haves
---

## Task 18: Nice-to-haves + CI + e2e + final verification

**Files:** Create `lib/exportCsv.ts`, repeat-guest badge (derive from bookings by mobile), notes/special-requests display, bulk-select toolbar (print/message/export), deep-link (`?booking=<id>` opens drawer), loading/error states polish; `frontend/e2e/bookings.spec.ts`; modify `.github/workflows/ci.yml` SPA job to target the new `frontend/`.

**Interfaces:** `exportCsv(bookings): string`; bulk selection state in shell; deep-link read on mount via `URLSearchParams`.

- [ ] **Step 1:** Test `exportCsv` emits a header + one row per booking with escaped fields; deep-link `?booking=x` calls `openDrawer('x')` on mount; repeat-guest badge appears when a mobile recurs. 
- [ ] **Step 2:** FAIL → implement each → PASS.
- [ ] **Step 3:** Update `.github/workflows/ci.yml`: SPA job runs `cd frontend && npm ci && npm run lint && npm run typecheck && npm test`. Classic-UI ESLint still runs over `static/*.js` (`no-undef` hard error).
- [ ] **Step 4:** Write `frontend/e2e/bookings.spec.ts` (Playwright smoke against demo_server): Bookings tab loads island, list renders, open New Booking, switch to Calendar + Timeline, open a drawer; verify Rooms tab still opens booking details via the bridge.
- [ ] **Step 5 (verification-before-completion):** Run and paste output: `cd frontend && npm run typecheck && npm test && npm run build`; `npm run e2e`; `cd backend && python -m pytest tests -q`; `python -m pytest tests -q` (repo root legacy); classic ESLint. All green.
- [ ] **Step 6:** Commit `feat(bookings): exports, deep-link, bulk actions, CI + e2e`.

## Task 19: Open PR (base `prod`), do NOT deploy

- [ ] **Step 1:** Push `feat/bookings-react`. Open a PR with base `prod` summarizing slices, the parity evidence (tests), the Razorpay-untouched guarantee, and the SPA removal. State explicitly: **owner deploys after review — do not deploy.**
- [ ] **Step 2:** Bind the PR, read CI, offer Auto-fix. Leave for owner review.

---

## Self-Review notes
- **Spec coverage:** every brief feature maps to a task — Core (search/sort T10, drawer T11, quick actions T11, source/room-type/date filters T6/T8/T10) ; High-value (availability-first T13, timeline T15, payments T16, no-show T16, overbooking T15, group T17); Nice-to-have (T18). Foundation (tooling T1, theme T3, API T2, types T2). Removal of old SPA T1. Compatibility with room-calendar T5.
- **Type consistency:** `Booking`, `api.*` names fixed in T2 and reused verbatim downstream; bridge global names fixed in T5.
- **Review Focus** items are each pinned to a task's tests (T3, T6, T7, T12, T13, T15).
- **Proportion:** code bodies are omitted in favor of signatures, parity source anchors (`file:line`), and test names; React component internals are left to the implementer who follows the cited classic functions.
