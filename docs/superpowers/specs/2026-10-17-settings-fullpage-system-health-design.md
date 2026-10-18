# Design: Full-page Settings + System Health insights page (classic UI)

_Date: 2026-10-17 · Area: classic UI (`static/`, `templates/`) · Owner: Neeraj_

## Intent and why

The classic UI is the live product. Two changes:

1. **Settings is a cramped centered modal.** The owner wants it to read like a proper
   full-screen page, consistent with the Analytics/Reports screens — "professional, not a
   popup."
2. **There is no way to see system health in the classic UI.** The data exists
   (`GET /api/v2/admin/metrics`) but the only screen that renders it lives in the parked
   React SPA. The owner — a non-developer — wants a health page that gives **as many
   meaningful, decision-useful insights as possible, in plain language**, not raw dev
   metrics.

The audience is a non-technical lodge owner. Every label, number, and status must be
understandable without engineering knowledge.

## Goals

- Settings opens as a **full-screen page** (navy header bar matching the app, back arrow,
  scrollable body, section groups laid out as cards), replacing the centered modal.
- **All existing Settings behaviour is preserved unchanged**: the manager-password gate, the
  bill-generation toggle, incognito toggle, room-photo toggles, the links to Analytics &
  Reports / Invoice & payments / Expense quick-pick tiles, and multi-device instant-save.
- A new **System Health** page, reached from a new "System" card inside Settings, that reads
  `GET /api/v2/admin/metrics` live and presents plain-language insights:
  - An automatic overall status banner (healthy / needs attention, with the reason).
  - Headline tiles: time since last restart, **failed actions** count, total activity,
    and a clearly-labelled **approximate** database-cost estimate.
  - Plain-sentence insights: busiest screen, heaviest-on-database screen, slowest screen.
  - A per-screen table marking each screen **Fast / OK / Slow** with a failures count
    (not millisecond figures).
  - An honest footnote: figures are since the last app update, and the page changes no data.
- System Health auto-refreshes every ~30s while open; stops when closed.
- Admin-only, enforced by the existing `logs.view` permission (same as the SPA page).

## Non-goals

- No change to the React SPA.
- No change to the metrics backend/endpoint or what it measures. This is a presentation
  layer over the existing `GET /api/v2/admin/metrics`.
- No new bottom-navigation entry. System Health lives inside Settings (owner-approved:
  admin-only, not a daily screen, and the bottom bar is already full).
- No money/tax/billing logic touched. Preserved logic is out of scope entirely.
- No new backend endpoint, no new Firestore reads/writes, no new composite index.

## Anti-goals (would make this a failure even if it "works")

- Rebuilding the Settings toggles from scratch, or changing their IDs/handlers, such that an
  existing toggle silently stops saving. The existing wiring must keep working.
- A System Health page that shows raw millisecond/p95/reads-per-call numbers with no plain
  interpretation — that defeats the entire point.
- Showing a database-cost figure that reads as an exact/authoritative bill. It must be
  visibly marked approximate and "since last restart".
- Exposing System Health (or its data) to non-admins.

## Constraints

- Classic UI: vanilla JS in `static/*.js` (concatenated; `no-undef` is a CI hard error),
  Jinja HTML in `templates/index.html`. Writes/reads go through the existing `apiFetch`
  wrapper (attaches the access JWT, refresh-retry, duplicate-guard) — never raw `fetch`.
- Guest-controlled / dynamic strings that reach `innerHTML` must be escaped via
  `window.escHtml` (Phase 1 rule). Metrics route names are server-generated, not guest input,
  but any value rendered into `innerHTML` should still go through `escHtml` defensively.
- Must work on phone width (front-desk tablets/phones) and desktop; cards stack on narrow,
  spread into columns on wide (the mockup used `auto-fit minmax`).
- Classic-UI CSP keeps `'unsafe-inline'` for scripts but the real defence is escaping at
  sinks — follow it.
- Everything is admin-gated; the metrics endpoint already requires `logs.view`, so a
  non-admin opening the page must get a clean "not available" state, not an error dump.

## The "how" decisions (made here)

1. **Full-page Settings = restyle the existing overlay, do not rebuild.** `#settings-modal`
   in `templates/index.html` is already a show/hide overlay (`.show` class toggled by
   `openSettingsModal()` / `closeSettingsModal()` in `static/script.js`), with all toggles
   wired to IDs inside it. The page look is achieved by converting its inner
   `.modal-content.set-modal` from a centered card into a **full-bleed sheet**: full width
   and height, the navy header bar (icon + "Settings" title + back arrow on the left,
   "Changes save instantly…" subtitle on the right), and a scrollable body. The section
   markup (`.set-group` / `.set-list` / `.set-row`) and **all element IDs stay the same**, so
   `loadBillingConfig()`, `loadUIConfig()`, the toggle handlers, and the existing card
   links keep working with no JS changes beyond the health wiring. This is primarily a
   CSS/markup reskin — the lowest-risk path.
2. **System Health is a second full-screen sheet**, a sibling overlay to Settings, opened
   from a new "System" → "System health" `.set-row` card and closed with its own back arrow
   (returning to Settings). Reusing the same full-sheet styling keeps the two pages
   visually identical.
3. **Insights are derived client-side from the existing snapshot.** The endpoint returns
   `{ uptime_s, since, routes:[{route,count,errors,avg_ms,p50_ms,p95_ms,max_ms,reads,writes,
   reads_per_call}], totals:{requests,reads,writes} }`. From this:
   - **Status banner:** healthy when `sum(errors)==0` and no route's `p95_ms` exceeds a
     "slow" threshold; otherwise needs-attention, naming the failing/slow screens.
   - **Failed actions:** `sum(route.errors)`.
   - **Busiest:** route with max `count`. **Heaviest on DB:** route with max `reads`.
     **Slowest:** route with max `p95_ms`.
   - **Fast/OK/Slow** per screen: thresholds on `p95_ms` (builder to pick sensible cut-offs,
     e.g. Fast < 150ms, OK < 500ms, Slow ≥ 500ms — tunable, documented in code).
   - **Approximate DB cost:** `reads`/`writes` totals × Google Firestore per-operation price,
     shown with an "≈" and an "approximate, since last restart" caption. Kept (owner call).
   - **Friendly screen names:** map the normalised route strings (e.g. `/get_bills`) to
     human labels ("Bills list"). A lookup table covering the common routes; unknown routes
     fall back to the route string. Builder owns the mapping; it is presentation-only.
4. **Refresh:** a `setInterval(~30s)` that runs only while the health sheet is open and is
   cleared on close, re-calling `apiFetch('/api/v2/admin/metrics')`. (The endpoint's path is
   `/api/v2/admin/metrics`; classic `apiFetch` base path to be confirmed by the builder —
   use the same base the other `/api/v2` classic calls use.)
5. **Non-admin / error states:** on 401/403 or a non-admin principal, show a plain
   "System health is available to admins only" card. On network failure, show "Couldn't load
   right now — tap to retry", never a raw error.

## What's left to the builder

- Exact CSS for the full-sheet layout (reuse app tokens/variables; match the Analytics
  screen's header treatment and the navy brand bar).
- The friendly route→label mapping table and the Fast/OK/Slow thresholds (document the
  chosen numbers in a code comment; they are tunable).
- The precise classic `apiFetch` path/base for `/api/v2/admin/metrics` and how admin-ness is
  known client-side (reuse whatever the app already uses for admin-only UI gating).
- Where exactly to mount the second (health) sheet in `templates/index.html` and how
  open/close is wired from the new Settings card.
- The database-cost price constants (cite the Firestore price used, in a comment) and the
  rounding/format via the app's existing money formatting where sensible.
- Tests: a lightweight check that the insights-derivation (status, busiest/slowest/heaviest,
  Fast/OK/Slow bucketing, failed-actions sum) is correct given a sample snapshot. No backend
  tests needed (endpoint unchanged). Classic `no-undef` lint must stay green.

## Rollout / risk

- Presentation-only, additive. No data migration, no backend change, no new permissions.
- Main risk is the Settings reskin breaking an existing toggle — mitigated by keeping all IDs
  and handlers and only changing container markup/CSS. Verify every Settings toggle still
  saves after the change.
- Ships like any change: a branch, CI runs (Python + SPA + classic lint), merge, deploy to
  UAT, hand-verify on the UAT URL.
