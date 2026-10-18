# Frontend report — register analytics Phase 2 (Tasks 9-17)

STATUS: DONE_WITH_CONCERNS (all 9 tasks done, tested, committed; concerns below)

## Base branch note
The worktree started on `main` (03ae7ad), which has no `frontend/`, no plan and no spec. I ran `git reset --hard feature/register-analytics` (722ae8e) on my own branch (it had no commits of its own). Commits sit on top of 722ae8e.

## Commits (one per task)
- 8346922 feat(analytics-ui): lean React bundle + /analytics route   (Task 9)
- c5da82d feat(analytics-ui): data hooks + types                      (Task 10)
- 0d4b3e7 feat(analytics-ui): overview KPI strip + range picker       (Task 11)
- 94059ca feat(analytics-ui): channel mix card                        (Task 12)
- 5f610e3 feat(analytics-ui): booking pace card                       (Task 13)
- 666e4a3 feat(analytics-ui): seasonality card                        (Task 14)
- 9ad79d9 feat(analytics-ui): LOS & lead-time card                    (Task 15)
- abbcb90 feat(analytics-ui): customers section (reused insights)     (Task 16)
- 100c358 feat(analytics-ui): assemble analytics page + findings      (Task 17)

## Final verification (on the committed tree)
- `npm test`: 21 files, 107 tests passed (43 new in `frontend/analytics/__tests__`)
- `npm run typecheck`: clean
- `npm run build`: OK (builds the SPA, then `vite build --mode analytics`)
- `npm run lint`: 0 errors (16 pre-existing/react-refresh warnings)
- `backend && pytest tests`: 252 passed, 6 xfailed (incl. 6 new tests in `backend/tests/test_analytics_static.py`)
- Browser check (demo server + a scratch stub of the overview endpoint, which is not committed): page loads at `/analytics/`, session restored via refresh cookie, all sections render, real `/customer_insights` data rendered, one overview request, no horizontal scroll at 375px, no failed requests.
- Bundle: analytics JS about 187 kB gzip (react 46, charts 114, query 12, app 16); no firebase, no router.

## What was built
- `frontend/analytics/`: `index.html`, `main.tsx`, `Root.tsx`, `App.tsx` (AuthGate + page), `api.ts` + `types.ts` (hooks: `useAnalyticsOverview`, `useRefreshOverview` (fresh=true), `useCustomerInsights`, `useCustomerSegment`, `isForbidden`), `RangePicker.tsx`/`range.ts`, `charts.tsx`, `sections/{Overview,ChannelMix,BookingPace,Seasonality,StayShape,Customers,Findings}.tsx`.
- Auth: reuses `@/lib/auth` + `@/lib/api` (bootstrap via refresh cookie; anonymous goes to classic `/login`; no `analytics.view` shows a no-access note). No new session mechanism.
- Vite: `vite.config.ts` is now mode-aware. `--mode analytics` uses root `frontend/analytics`, base `/analytics/`, output `frontend/dist/analytics/`. `analytics.css` adds `@source ../src` so Tailwind sees shared components (verified). `npm run build` runs both builds; added `build:analytics` and `dev:analytics`. `tsconfig` includes `analytics`.
- Dockerfile: no change needed. It already copies `frontend/dist`, which now contains `dist/analytics`.
- Backend mount (`backend/cibara_api/main.py`, one block placed just before the legacy catch-all, away from the `include_router` tuple): `GET /analytics` redirects to `/analytics/`, `GET /analytics/` serves the index (no-cache, 503 if not built), `GET /analytics/assets/*` serves files (immutable, path-traversal safe). Served in classic and SPA mode.
- Nav link: `<a id="profile-menu-analytics" href="/analytics/" data-perm="analytics.view">` in the classic profile menu (`templates/index.html`), hidden by existing `applyRoleGating`.

## Coordination notes for the backend agent / merge
1. **Route collision avoided:** the static mount is deliberately narrow (only `/analytics`, `/analytics/`, `/analytics/assets/*`). The Flask blueprint's `/analytics/overview` and `POST /analytics/snapshot` still fall through to the legacy app (tested). Do not add a Flask `/analytics/` root route.
2. `backend/cibara_api/main.py` will textually merge with the backend agent's edits (import line and `include_router` tuple); my hunk is separate (about line 140).
3. The page needs the real `GET /api/v2/analytics/overview` (start/end/fresh). Until it lands the page shows an error card with retry (Customers still renders).
4. `pace.horizons[h].delta` shape was unspecified. Types accept `null`, `{occupancy_pct, on_books_revenue}` or a bare number; null hides the delta. Confirm the backend shape.
5. `findings[].icon` is ignored (icon chosen from `level`: good/warn/bad/info).
6. `collections.net` is shown as "Collections" and `collections.net_revenue` as "Net revenue"; confirm those semantics.
7. Rate limiter: only `/app/assets/` is in `_SKIP_RATE`; `/analytics/assets/*` counts toward the 600/min/IP global limit (about 8 requests per page load; harmless, could add to `_SKIP_RATE`).
8. CSP: the `/analytics/` HTML gets the classic CSP (`script-src 'self' 'unsafe-inline'`), which the bundle satisfies. It works as is.

## Deviations / concerns
- Plan listed Vite "second build input"; a single Vite build has one base, so I used a second build in `--mode analytics` instead.
- Sections receive `data` as props from a single query in `App`, rather than each calling the hook (same single request, simpler tests).
- Customers hides on 403 (renders nothing); other errors show an error card with retry. Brief skeleton flash before a 403 hides it.
- Not done: no TODO stubs were needed. All sections are complete.
- `lodge.log` (tracked) was modified by test runs; restored, not committed.
