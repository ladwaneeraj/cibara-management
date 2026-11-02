# Bookings React Island — Regression Fix + Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the blunt CSS rule that hides legacy content in `#bookings-tab`, restore the online-bookings toggle and Block Rooms access as island-toolbar controls, and redesign the Bookings UI to be denser, clearer and genuinely mobile-friendly — with zero change to backend behaviour or web-booking (Razorpay) parity.

**Architecture:** The Bookings tab is a React island (`web/` → `static/react/bookings.js|css`) mounted at `#bookings-react-root` inside the classic `#bookings-tab`. The island already reimplements the toolbar, filters, search/sort/export, three views, drawer and modals. We (1) replace the catch-all `#bookings-tab > :not(#bookings-react-root)` hide rule with a direct-child, element-specific carve-out (so the island's own nested copies of `.bk-*`/`#bookings-list` are untouched and future direct children aren't blindly hidden); (2) add two toolbar controls — an **Online bookings** switch wired to `GET/POST /settings/web_config` (optimistic+revert, gated on `settings.update` which the POST enforces) and a **Block Rooms** button that opens the existing, legacy-wired `#blocks-modal` via `window.openBlocksModal()` (gated on `room.update`); (3) restyle card/toolbar/drawer/states in `island.css` + component markup using the classic ERP CSS tokens.

**Tech Stack:** Vite + React 18 + TypeScript (strict), Vitest + RTL, ESLint. Styling via classic CSS custom properties (`var(--primary)` etc., mirrored in `web/src/theme/tokens.ts`). API via `web/src/api/client.ts` → `window.apiFetch`.

**Spec:** This plan (owner opted out of a separate design doc; decisions captured inline). Prior context: `docs/superpowers/plans/2026-11-01-bookings-react-island.md`, `docs/superpowers/specs/2026-10-19-web-booking-razorpay-design.md`.

## Global Constraints

- No backend file changes. No change to money/tax/booking logic. Endpoints unchanged.
- Block Rooms reuses the existing legacy modal + JS (`openBlocksModal`, `#blocks-modal`) — do **not** reimplement its form/submit in React (keeps parity + avoids `rooms` global duplication).
- Every island selector stays scoped under `#bookings-react-root` (or `.bki-portal` for portaled nodes), except the single intentional `#bookings-tab > …` carve-out.
- Colours come from CSS tokens (`var(--primary|--success|--danger|--warning|--border|--surface|--text-secondary|--light)`), not raw hex, in new CSS.
- `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` all pass. 99 existing tests must stay green.
- Permission gating uses `window.CibaraAuth.hasPermission(perm)`; absent gate (dev harness) → show.

## Review Focus

- **Duplicate-ID collision** (`#bookings-list` exists both legacy + island): the carve-out must use `>` direct-child so only the legacy copy hides. → Task 1 test asserts island's list still renders while legacy hidden.
- **Toggle POST failure** (network / 403): must revert the switch to its prior state and not leave a false "on". → Task 2 test: rejected POST reverts checkbox.
- **Toggle without permission**: control hidden when `settings.update` absent (POST would 403). → Task 2 test.
- **Block button when `openBlocksModal` undefined** (legacy JS not yet loaded): must no-op safely, not throw. → Task 3 test.
- **Bridge globals after redesign**: `fetchBookings`/`showBookingDetails`/`showNewBookingModalForDate` still installed. → covered by existing BookingsApp test; keep it green.

---

## Task 1: Surgical CSS carve-out for the legacy `#bookings-tab` content

**Files:**
- Modify: `web/src/theme/island.css:7-16`
- Test: `web/src/theme/island.carveout.test.ts` (create) — string assertion on the compiled rule shape

**Interfaces:**
- Produces: nothing importable; a CSS rule. Later tasks rely on the island toolbar being visible.

- [ ] **Step 1:** Write a failing test that imports the raw `island.css` text (via `?raw`) and asserts it (a) no longer contains `:not(#bookings-react-root)`, and (b) contains direct-child hides for `#bookings-tab > #bookings-list`, `#bookings-tab > #bookings-calendar-view`, and the three legacy `.bk-*` wrappers.
- [ ] **Step 2:** Run it, confirm it fails (old rule present).
- [ ] **Step 3:** Replace lines 7-16 with:
  ```css
  /* Carve-out: hide ONLY the legacy booking.js-rendered direct children of
     #bookings-tab that the island replaces. Direct-child (>) so the island's
     own nested .bk-* / #bookings-list copies inside #bookings-react-root are
     untouched; naming each element (not :not(root)) keeps #day-details-modal
     and any future direct child working. */
  #bookings-tab > .bk-section-title,
  #bookings-tab > .bk-filter-row,
  #bookings-tab > .bk-view-selector,
  #bookings-tab > #bookings-list,
  #bookings-tab > #bookings-calendar-view {
    display: none !important;
  }
  ```
- [ ] **Step 4:** Run the test → PASS.
- [ ] **Step 5:** Commit.

## Task 2: Online-bookings toggle in the island toolbar

**Files:**
- Create: `web/src/api/webConfig.ts` — `getWebConfig()`, `setOnlineBookings(enabled)`
- Create: `web/src/components/OnlineBookingsToggle.tsx`
- Create: `web/src/components/OnlineBookingsToggle.test.tsx`
- Modify: `web/src/BookingsApp.tsx` (render in toolbar), `web/src/theme/island.css` (switch styles)

**Interfaces:**
- Produces:
  - `getWebConfig(): Promise<{ online_bookings_enabled: boolean }>` → GET `/settings/web_config`, returns `config`.
  - `setOnlineBookings(enabled: boolean): Promise<{ online_bookings_enabled: boolean }>` → POST `/settings/web_config` `{online_bookings_enabled}`, returns `config`.
  - `<OnlineBookingsToggle />` — self-contained; loads config on mount, optimistic toggle with revert on error; renders nothing when `!hasPerm('settings.update')`.

- [ ] **Step 1:** Write failing tests in `OnlineBookingsToggle.test.tsx` (mock `../api/webConfig`, set `window.CibaraAuth`):
  - renders a switch reflecting loaded `online_bookings_enabled`;
  - clicking calls `setOnlineBookings(true)` and shows ON;
  - when `setOnlineBookings` rejects, the switch reverts to OFF;
  - renders nothing without `settings.update`.
- [ ] **Step 2:** Run → FAIL (module/components missing).
- [ ] **Step 3:** Implement `webConfig.ts` (mirror legacy `toggleOnlineBookings` semantics via `apiFetch`) and `OnlineBookingsToggle.tsx` (checkbox styled as a pill switch; `aria-label="Online bookings"`; disabled while saving).
- [ ] **Step 4:** Render `<OnlineBookingsToggle />` in the `.bki-toolbar` (left of Arrivals, or its own toolbar group). Run tests → PASS.
- [ ] **Step 5:** Commit.

## Task 3: Block Rooms toolbar action

**Files:**
- Modify: `web/src/BookingsApp.tsx`, `web/src/globals.d.ts` (add `openBlocksModal?: () => void`)
- Test: add to `BookingsApp.test.tsx`

**Interfaces:**
- Consumes: `window.openBlocksModal` (legacy, static/script.js). Produces: a toolbar button gated on `room.update`.

- [ ] **Step 1:** Write failing tests: button labelled `Block Rooms` is shown with `room.update`, hidden without it; clicking calls `window.openBlocksModal`; clicking is safe (no throw) when `window.openBlocksModal` is undefined.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Add `openBlocksModal?: () => void` to `Window`; add a `bk-tool-btn` button `onClick={() => window.openBlocksModal?.()}`, gated `hasPerm('room.update')`.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit.

## Task 4: Redesign — card, toolbar/search row, drawer, states (mobile-first)

**Files:**
- Modify: `web/src/components/BookingCard.tsx`, `web/src/components/EmptyState.tsx`, `web/src/BookingsApp.tsx`, `web/src/theme/island.css`
- Tests: keep `BookingCard.test.tsx` green; extend for any new testable text.

**Interfaces:** presentation only; props unchanged. All existing features (badges, group/repeat chips, AC, OTA, balance due, amount) preserved.

- [ ] **Step 1:** Restyle in `island.css` (scoped under `#bookings-react-root`), not by overloading classic classes: a `.bki-card` grid (room + status row; guest name prominent; stay line with icons; footer payment chip + amount right-aligned), with a coloured left status rule (emerald/blue/amber/sky/rose per ERP status colours). Toolbar: wrap, consistent `bk-tool-btn` sizing. Search/sort/export row: search grows, sort + Export CSV fixed, no odd span; stacks on mobile. Drawer: already portaled — tighten spacing/headers. Empty/loading/error: consistent `.bki-state` block with icon + message; error uses `--danger`.
- [ ] **Step 2:** Update `BookingCard`/`EmptyState`/toolbar markup to the new class names where needed (keep `data-id`, roles, aria).
- [ ] **Step 3:** Verify at phone width (375px) via the browser preview; no horizontal scroll; tap targets ≥ 40px.
- [ ] **Step 4:** Run full `npm test` → all green. Commit.

## Task 5: Verify & ship

- [ ] `cd web && npm ci && npm run lint && npm run typecheck && npm test && npm run build`.
- [ ] Confirm `static/react/bookings.js|css` rebuilt; confirm no change under `routes/`, `services/`, `config.py`, `web/src/api/bookings.ts` endpoint paths (web-booking/Razorpay untouched).
- [ ] Open PR to `prod`.
- [ ] Deploy to UAT only (`lodge-management-uat`, project `cibara-dev`, asia-south1). Do **not** deploy prod.

## Self-Review

1. **Spec coverage:** Regression fix → T1. Toggle → T2. Block Rooms → T3. Bridge globals → existing test (kept green, T3/T4 note). Redesign → T4. Ship → T5. ✓
2. **Step scan:** Each step one action; CSS block + endpoint semantics are the only fixed bodies (copy/behaviour the implementer can't invent). ✓
3. **Type consistency:** `getWebConfig`/`setOnlineBookings` names reused T2→BookingsApp; `openBlocksModal` typed once T3. ✓
4. **Review Focus:** duplicate-ID, toggle-failure-revert, perm-gating, undefined-global, bridge — each mapped to a task test. ✓
5. **Proportion:** plan is short vs. the touched code; bodies only where fixed. ✓
