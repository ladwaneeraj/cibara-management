# Web Booking Phase 0 (Core Money Loop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A guest books and pays in full online; a confirmed booking lands in the ERP and shows in existing booking views, race-safe, with buffer / block / closed-flag live.

**Architecture:** New guest-facing `web_bp` blueprint (`/web/*`, public, CORS-limited) on the existing Flask ERP. One shared `services/availability_service.py` computes availability from bookings + live walk-ins + blocks as time intervals (web precise, date-only conservative, walk-in precise, +cleaning gap). Holds are a race-safe Firestore transaction serialized per pool via a sentinel lock doc. Razorpay order is server-priced; a signature-verified, idempotent webhook is the only thing that confirms a booking. A confirmed web booking is an ordinary hotel stay (`payment_source="hotel"`), so checkout/billing reuse everything.

**Tech Stack:** Python 3.10+, Flask blueprints, Firestore (firebase-admin 6.3.0), `razorpay` SDK, `flask-cors`; Next.js static export (website) with Razorpay Checkout.js.

**Spec:** `docs/superpowers/specs/2026-10-19-web-booking-razorpay-design.md`

## Global Constraints

- Python **3.10+** (suite enforces it); run ERP tests with `python -m pytest`.
- ERP integration tests use the **in-memory Firestore fake** at `backend/tests/` (real query/transaction/Increment semantics, whole stack in-process). Pure helpers may be unit-tested under `tests/`.
- **Secrets only from env / Secret Manager, never committed:** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `WEB_ALLOWED_ORIGINS` (comma-separated). The browser receives only `RAZORPAY_KEY_ID`.
- **Amounts are server-authoritative**, computed from `config.room_base_price` + `config.AC_SURCHARGE` (600) × days; Razorpay amounts in **paise** (₹ × 100). The browser never sends an amount.
- Pools (verbatim): `premium` = rooms `"200".."206"` (AC = +₹600 surcharge toggle, same pool), `deluxe` = rooms `"223".."227"`. `days` = number of 24-hour periods (the ERP `renewal_count + 1` model), **not** calendar nights.
- Web bookings: `booking_source="web"`, `payment_source="hotel"`; statuses add `pending_payment` (hold) and `expired`; confirmed = `confirmed`. All timestamps in `config.IST`.
- Settings toggles follow the `routes/billing.py` `/settings/*_config` pattern: `settings_ref.document(...).set(..., merge=True)` + cache invalidation; config read via a cached `get_*_config()` in `config.py` with defaults merged.
- `/web/*` is exempt from staff login (added to `app._PUBLIC_PREFIXES`) and protected by CORS allow-list + (webhook) signature verification + rate limiting.
- Add `razorpay` and `flask-cors` to `requirements.txt`.

## Review Focus

- **Webhook duplicate delivery (Razorpay retries):** a second delivery of the same event must confirm nothing new, write no second payment, send no second message, and return 200. → Task 9.
- **Payment captured for an already-expired/swept hold:** money was taken but the hold is gone — must re-materialize a confirmed booking and alert the owner, never silently drop it. → Task 9 (with Task 10).
- **Concurrent holds on the last offerable room:** exactly one `pending_payment` is created; the other is told sold-out. (Fake serializes, so it proves the serialized outcome; the production phantom-read guard is the per-pool sentinel doc — see Task 7 notes.) → Task 7.
- **Same-day walk-in turnover vs a web window:** a live walk-in occupying a pool room now must block an overlapping web 24h window (precise), while a date-only future booking blocks its whole span (conservative). → Task 3.
- **Hostile / malformed web input:** unknown category, `days` ≤ 0 or absurdly large, `guests` over the room's max occupancy, a check-in time in the past → rejected with 4xx, never a hold or an order. → Tasks 6 & 7.

---

### Task 1: Web settings (`web_config`), `web_bp` wiring, public `/web/config`, CORS

**Files:**
- Modify: `config.py` (add `get_web_config()` + defaults + `invalidate_web_config_cache()`, mirroring `get_ui_config`)
- Create: `routes/web.py` (`web_bp = Blueprint('web', __name__)`, `GET /web/config`)
- Modify: `routes/billing.py` (add staff `GET/POST /settings/web_config`, same shape as `/settings/ui_config`)
- Modify: `app.py` (register `web_bp`; add `"/web/"` to `_PUBLIC_PREFIXES`; init `flask_cors.CORS` on `/web/*` from `WEB_ALLOWED_ORIGINS`)
- Modify: `requirements.txt` (add `flask-cors`)
- Test: `backend/tests/test_web_config.py`

**Interfaces:**
- Produces: `config.get_web_config() -> dict` with keys `online_bookings_enabled` (bool, default **False**), `buffer` (int, default **1**), `cleaning_gap_minutes` (int, default **120**), `hold_ttl_minutes` (int, default **10**); `config.invalidate_web_config_cache()`. Public `GET /web/config` → `{online_bookings_enabled, cleaning_gap_minutes}` (no secrets, no buffer internals beyond what the UI needs).
- Produces: `config.CATEGORY_POOLS: dict[str, list[str]]` = `{"premium": ["200".."206"], "deluxe": ["223".."227"]}` — defined here in `config.py` so both `blocks_service` (Task 2) and `availability_service` (Task 3) import it without a cycle.

- [ ] **Step 1: Write failing test** `test_web_config.py`: `test_web_config_defaults_closed` (fresh fake DB → `get_web_config()["online_bookings_enabled"] is False`, `buffer == 1`, `cleaning_gap_minutes == 120`, `hold_ttl_minutes == 10`); `test_get_web_config_endpoint_public` (`GET /web/config` returns 200 with `online_bookings_enabled: false`, and an `Access-Control-Allow-Origin` header for an allowed origin); `test_toggle_web_config_persists` (`POST /settings/web_config {online_bookings_enabled: true}` → subsequent `GET /web/config` shows `true`).
- [ ] **Step 2: Run tests, verify they fail** — `python -m pytest backend/tests/test_web_config.py -v` → FAIL (no `get_web_config` / route).
- [ ] **Step 3: Implement** `get_web_config()` / `invalidate_web_config_cache()` + `CATEGORY_POOLS` in `config.py` (copy the `get_ui_config` cached-with-defaults pattern, `settings/web_config` doc); `web_bp` + `GET /web/config` in `routes/web.py`; staff `GET/POST /settings/web_config` in `routes/billing.py` (copy `ui_config` endpoint, `set(merge=True)` + invalidate); register `web_bp`, extend `_PUBLIC_PREFIXES` with `"/web/"`, wire `CORS(app, resources={r"/web/*": {"origins": _origins_from_env()}})` in `app.py`; add `flask-cors` to `requirements.txt`.
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Add the ERP settings-UI toggle** for `online_bookings_enabled` wired to `POST /settings/web_config`, following the existing settings controls in the ERP frontend (`static/script.js` + the settings template — builder locates the matching `ui_config`/`billing_config` toggle and mirrors it). Verify manually: toggling it in the ERP changes what `GET /web/config` returns.
- [ ] **Step 6: Commit** — `feat(web): web_config settings + closed-flag toggle, /web/config, web_bp + CORS`.

---

### Task 2: Blocks — model, service, staff CRUD endpoints

**Files:**
- Create: `services/blocks_service.py`
- Modify: `routes/web.py` is **not** used (blocks are staff-auth) → add to an existing staff blueprint: `routes/rooms.py` (endpoints `POST /blocks`, `GET /blocks`, `DELETE /blocks/<block_id>`)
- Test: `backend/tests/test_blocks.py`

**Interfaces:**
- Produces: `blocks_service.create_block(scope, *, room=None, category=None, start, end=None, reason, created_by) -> block_id`; `list_blocks(now=None) -> list[dict]`; `delete_block(block_id)`; `active_blocked_rooms(window_start, window_end, *, now=None) -> set[str]` — returns the set of concrete room numbers blocked at any point in `[window_start, window_end]`, expanding `scope=="category"` to its pool via `config.CATEGORY_POOLS` (Task 1 — avoids a cycle with `availability_service`). A block with `end=None` is open-ended (blocks from `start` onward).
- Block doc fields: `{scope, room?, category?, start (ISO), end (ISO|None), reason, created_by, created_at}` in collection `blocks`.

- [ ] **Step 1: Write failing test** `test_blocks.py`: `test_create_and_list_block`; `test_delete_block`; `test_active_blocked_rooms_specific_room` (a room block inside the window → room in the set, a block outside the window → not); `test_active_blocked_rooms_category_expands_pool` (`scope="category", category="premium"` → all of 200–206 blocked); `test_open_ended_block_blocks_future` (`end=None`, window far in the future → still blocked).
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement** `blocks_service.py` (Firestore `blocks` collection; interval-overlap against `[window_start, window_end]`; `config.CATEGORY_POOLS` category→pool expansion) and the three staff endpoints in `routes/rooms.py` (reuse `requires_permission` / attribution like neighbouring routes).
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Add the ERP room-grid UI** — a "Block now" quick action on each room card (POST a `scope="room"` block from now, open-ended) and a date-range block form (room or whole category, start/end, reason), plus an unblock control that lists active blocks and DELETEs them. Follow the existing room-grid action patterns in `static/script.js` (builder locates). Verify manually: a blocked room is visibly blocked in the grid and disappears from `/web/availability`.
- [ ] **Step 6: Commit** — `feat(web): blocks service + staff block/unblock endpoints + room-grid UI`.

---

### Task 3: Shared availability service (the SSOT)

**Files:**
- Create: `services/availability_service.py`
- Test: `backend/tests/test_availability_service.py`

**Interfaces:**
- Consumes: `config.room_category`/pools, `blocks_service.active_blocked_rooms` (Task 2), `config.IST`, bookings + rooms collections.
- Produces:
  - re-exports `CATEGORY_POOLS` from `config` (Task 1) for callers that import it from here.
  - `occupied_intervals(pool_rooms, window_start: datetime, window_end: datetime, *, now: datetime, exclude_booking_id=None) -> dict[str, list[tuple[datetime, datetime, str]]]` — per room, busy intervals overlapping the window from: bookings with `status in {"confirmed","pending_payment"}` for pool rooms (web/precise iff `booking_source=="web"` and a parseable `check_in_time`: `[check_in_dt, +24h×days]`, where `days` is the booking's stored day-count; else date-only conservative `[check_in_date 00:00, check_out_date 00:00]`); live walk-ins (`rooms` doc `status=="occupied"`: `[checkin_time, +24h×(renewal_count+1)]`); blocks (via `active_blocked_rooms`). Each interval's end is extended by `cleaning_gap_minutes` (from `get_web_config`).
  - `pool_free_rooms(category, checkin_dt, days, guests, *, now, exclude_booking_id=None) -> list[str]` — window `[checkin_dt, checkin_dt + 24h×days]`; pool rooms with no overlapping occupied interval, ordered by `mmt_ingest_service._ordered_candidates` preference.
  - `web_offerable_rooms(category, checkin_dt, days, guests, *, now, exclude_booking_id=None) -> list[str]` = `pool_free_rooms(...)` minus the last `buffer` rooms (buffer from `get_web_config`).

- [ ] **Step 1: Write failing tests** `test_availability_service.py` (seed the fake DB per case):
  - `test_web_window_blocks_overlapping_web_booking` — a confirmed web booking `[10:00, +24h]` makes the room busy for a web window starting 20:00 same day; a window starting 3 days later is free.
  - `test_live_walkin_precise_same_day_turnover` — a room `occupied` with `checkin_time` today 08:00, `renewal_count=0` (busy until tomorrow 08:00 + gap); a web window today 18:00 is blocked, a window tomorrow 12:00 is free.
  - `test_date_only_booking_conservative_whole_span` — an OTA booking (`booking_source="mmt"`) check_in..check_out dates block the entire span regardless of time-of-day of the web window.
  - `test_premium_ac_and_nonac_share_pool` — a non-AC premium booking reduces availability for an AC premium query (same 200–206 pool).
  - `test_deluxe_pool_independent_of_premium` — blocking all premium leaves deluxe fully available.
  - `test_cleaning_gap_applied` — a web window starting within `cleaning_gap_minutes` after an occupant's end is blocked; just after the gap is free.
  - `test_buffer_reduces_offerable` — pool of N free → `web_offerable_rooms` returns N − buffer.
  - `test_block_removes_room` — an active block on a pool room removes it from `pool_free_rooms`.
  - `test_naive_and_aware_datetimes_consistent` — all comparisons use IST-aware datetimes; a stored naive string is localized, not compared naive-vs-aware (guards the Review-Focus clock item).
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement** `availability_service.py`. Parse booking/room timestamps into IST-aware datetimes; interval overlap is `start < other_end and end > other_start`; reuse `_ordered_candidates` for ordering. No endpoint here — pure functions.
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit** — `feat(web): shared availability service (SSOT) with 24h-overlap matrix`.

---

### Task 4: Honour blocks in the existing staff availability (additive)

**Files:**
- Modify: `routes/bookings.py` (`check_availability` ~line 1337; `create_multi_booking` conflict set ~line 457)
- Test: `backend/tests/test_blocks_in_staff_availability.py`

**Interfaces:**
- Consumes: `blocks_service.active_blocked_rooms` (Task 2).

- [ ] **Step 1: Write failing test**: `test_check_availability_excludes_blocked_room` (`POST /check_availability` for a date range with a room blocked → that room absent from `available_rooms`, all others present); `test_multi_booking_rejects_blocked_room` (`POST /create_multi_booking` including a blocked room → rejected naming it); `test_unblocked_room_unaffected` (no block → list identical to pre-change baseline).
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement** — subtract `active_blocked_rooms(window)` from the computed sets in both functions. **No other logic change** (this is the only intentional touch to an existing availability path; keep it additive).
- [ ] **Step 4: Run tests, verify they pass** (and `python -m pytest backend/tests/ -q` stays green — no regression in existing booking tests).
- [ ] **Step 5: Commit** — `feat(web): honour blocks in staff availability (additive)`.

---

### Task 5: Server-authoritative web pricing

**Files:**
- Modify: `services/availability_service.py` (add `web_quote`) **or** new `services/web_pricing.py` — builder picks; keep it next to availability.
- Test: `backend/tests/test_web_pricing.py`

**Interfaces:**
- Produces: `web_quote(category, guests, days, *, ac=False) -> int` — rupees. `premium` non-AC = `room_base_price("200", guests) × days`; `premium` AC = `(room_base_price("200", guests) + AC_SURCHARGE) × days`; `deluxe` = `room_base_price("223", guests) × days`. Also `to_paise(rupees) -> int`.

- [ ] **Step 1: Write failing test**: `test_premium_nonac_price` (2 guests, 2 days → `1200×2`), `test_premium_ac_price` (`(1200+600)×2`), `test_deluxe_price` (2 guests, 1 day → `900`), `test_extra_guest_surcharge` (3 guests premium → `(1200+300)×days`), `test_to_paise` (`900 → 90000`).
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement** `web_quote` / `to_paise` using `config.room_base_price` + `config.AC_SURCHARGE`.
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit** — `feat(web): server-authoritative web pricing`.

---

### Task 6: `POST /web/availability`

**Files:**
- Modify: `routes/web.py`
- Test: `backend/tests/test_web_availability.py`

**Interfaces:**
- Consumes: `availability_service.web_offerable_rooms`, `web_quote` (Task 5), `get_web_config`.
- Produces: `POST /web/availability {category, check_in_date, check_in_time, days, guests}` → `{available: bool, price: int, currency: "INR"}`. **Never returns a room number.** 403 `{enabled:false}` when closed-flag OFF. 4xx on bad input.

- [ ] **Step 1: Write failing tests**: `test_availability_available_when_free`; `test_availability_full_when_pool_exhausted_within_buffer`; `test_availability_rejected_when_closed` (flag OFF → 403); `test_price_is_server_computed` (matches `web_quote`, ignores any price the body sends); `test_no_room_number_leaked` (response has no room field); `test_rejects_bad_input` (unknown category, `days<=0`, `guests` over max occupancy, past `check_in_time` → 4xx).
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement** the endpoint: closed-flag gate first, validate+parse input (reject the Review-Focus hostile cases), build the window, call `web_offerable_rooms`, price via `web_quote`. Add a lightweight rate-limit (reuse an existing limiter if present, else a simple per-IP guard).
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit** — `feat(web): /web/availability endpoint`.

---

### Task 7: `POST /web/hold` — race-safe pending booking

**Files:**
- Modify: `routes/web.py`
- Test: `backend/tests/test_web_hold.py`

**Interfaces:**
- Consumes: `availability_service.web_offerable_rooms`, `web_quote`, `get_web_config`.
- Produces: `POST /web/hold {category, check_in_date, check_in_time, days, guests, guest_name, guest_mobile, guest_email?}` → `{booking_id, amount, expires_at}`. Writes a booking: `status="pending_payment"`, `booking_source="web"`, `payment_source="hotel"`, `room`, `check_in_date`, `check_in_time`, `check_out_date` (derived), `days`, `guest_count`, `total_amount` (= `web_quote`), `paid_amount=0`, `balance=total_amount`, `is_ac`, `expires_at = now + hold_ttl_minutes`. 403 when closed.
- Race mechanism: `@firestore.transactional` `_hold(txn)` that (1) `txn.get(web_pool_locks/{category})` — the sentinel that forces same-pool conflicts, (2) recomputes `web_offerable_rooms` inside the txn, (3) picks the first offerable room, (4) `txn.set` the pending booking, (5) `txn.update` the lock doc (`v = Increment(1)`, `updated_at = now`).

- [ ] **Step 1: Write failing tests**: `test_hold_creates_pending_payment` (booking doc with the fields above, `expires_at` set); `test_hold_respects_buffer` (last room within buffer → `SoldOut`/409); `test_second_hold_on_last_room_sold_out` (seed so exactly one offerable room; two sequential hold calls → first 200, second 409; exactly one `pending_payment` exists); `test_pending_hold_counts_as_occupied` (a prior pending hold blocks a subsequent `/web/availability` for the overlapping window); `test_hold_rejected_when_closed`; `test_hold_rejects_bad_input` (as Task 6).
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement** the transactional hold. **Note for the implementer and reviewer:** the fake `@transactional` serializes under a global lock, so `test_second_hold_on_last_room_sold_out` proves the *re-check-inside-txn → one winner* logic; the per-pool sentinel `web_pool_locks/{category}` is what makes this hold against real Firestore's phantom reads (two concurrent holds both read+write the same lock doc → the loser aborts and retries, re-reading the winner's booking). Do not remove the sentinel even though the fake passes without it.
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit** — `feat(web): race-safe /web/hold with per-pool sentinel lock`.

---

### Task 8: `POST /web/order` — Razorpay order (server-priced)

**Files:**
- Modify: `routes/web.py`; `requirements.txt` (add `razorpay`)
- Create: `services/razorpay_service.py` (thin wrapper: `create_order(amount_paise, receipt) -> dict`, `verify_webhook_signature(body: bytes, signature: str) -> bool`, reads keys from env)
- Test: `backend/tests/test_web_order.py` (mock the Razorpay client)

**Interfaces:**
- Consumes: the held booking (Task 7).
- Produces: `POST /web/order {booking_id}` → `{order_id, key_id, amount}` where `amount` (paise) is taken from the **held booking's** `total_amount` (never the request body); `key_id` = `RAZORPAY_KEY_ID`; **key secret is never returned**. 404 if the hold is missing/expired; 409 if already confirmed.

- [ ] **Step 1: Write failing tests**: `test_order_amount_from_booking` (mock `create_order`; amount = `to_paise(booking.total_amount)`, ignores any body amount); `test_order_returns_key_id_not_secret` (response contains `key_id`, never the secret); `test_order_404_for_missing_hold`; `test_order_409_if_already_confirmed`.
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement** `razorpay_service.create_order` (SDK, keys from env) and the endpoint; patch the SDK client in tests.
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit** — `feat(web): /web/order Razorpay order (server-priced)`.

---

### Task 9: `POST /web/razorpay_webhook` — verify, idempotent confirm, pay, notify

**Files:**
- Modify: `routes/web.py`; `services/razorpay_service.py` (signature verify)
- Test: `backend/tests/test_web_webhook.py`

**Interfaces:**
- Consumes: `razorpay_service.verify_webhook_signature`, `payment_service.write_payment`, `config.send_whatsapp_message` + the `send_booking_confirmation` message body, the owner **ntfy** alert helper (from commit `b4faa30`), the held booking.
- Produces: `POST /web/razorpay_webhook` (raw body) — verifies `X-Razorpay-Signature`; idempotency via a `processed_webhooks/{razorpay_payment_id}` doc; on captured payment for our receipt, in a transaction flips the booking `status→"confirmed"`, `paid_amount=total_amount`, `balance=0`, stamps `razorpay_order_id`/`razorpay_payment_id`, clears `expires_at`; then `write_payment({type:"booking_advance", method:"online", booking_id, booking_source:"web", mobile, ...})`; then WhatsApp confirmation + owner ntfy. Always 200 on an already-processed event.

- [ ] **Step 1: Write failing tests** (mock Razorpay verify + WhatsApp + ntfy): `test_valid_signature_confirms_booking` (status → confirmed, paid=total, balance 0, payment row written once, WhatsApp+ntfy called once); `test_duplicate_delivery_is_noop` (same event twice → one confirm, one payment, one message, both 200); `test_bad_signature_rejected` (400, no DB write); `test_webhook_for_expired_or_swept_hold_rematerializes` (hold already `expired`/absent but payment captured → a `confirmed` web booking exists afterwards and an owner alert fired); `test_payment_recorded_as_web_online` (ledger row `method="online"`, `booking_source="web"`).
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement** signature verification (HMAC-SHA256 with `RAZORPAY_WEBHOOK_SECRET` over the raw body — read `request.get_data()` before JSON parsing), the idempotency doc, the transactional confirm, payment write, and notifications. Re-materialize path: if the booking is gone/expired, recreate it as `confirmed` from the Razorpay order notes/receipt and alert the owner.
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit** — `feat(web): verified idempotent Razorpay webhook → confirm + pay + notify`.

---

### Task 10: Sweep expired holds

**Files:**
- Modify: `routes/web.py` (add `POST /web/sweep`, callable by Cloud Scheduler) — or the existing background-job pattern if one is already used; builder picks per convention.
- Test: `backend/tests/test_web_sweep.py`

**Interfaces:**
- Produces: `sweep_expired_holds(now=None) -> int` — flips `status=="pending_payment"` with `expires_at < now` to `"expired"`; returns count. Idempotent.

- [ ] **Step 1: Write failing tests**: `test_sweep_expires_old_hold`; `test_sweep_leaves_unexpired`; `test_sweep_leaves_confirmed`; `test_sweep_idempotent` (second run returns 0); `test_swept_room_becomes_available` (after sweep the pool room is offerable again).
- [ ] **Step 2: Run tests, verify they fail.**
- [ ] **Step 3: Implement** `sweep_expired_holds` + the endpoint.
- [ ] **Step 4: Run tests, verify they pass.**
- [ ] **Step 5: Commit** — `feat(web): sweep expired holds`.

---

### Task 11: Website booking UI + Razorpay checkout (cibara-comforts)

**Files (repo `cibara-comforts`):**
- Create: `src/components/booking/*` (client components: category + date + time + days + guests → availability → pay), a small API client reading `process.env.NEXT_PUBLIC_API_BASE`.
- Modify: a bookable surface (e.g. `src/app/rooms/[slug]/page.tsx` and/or a new `/book` route) to mount the booking widget for `premium-ac-room`, `premium-room`, `double-room` only; keep the existing WhatsApp enquiry as fallback.
- Modify: `.env` example / docs to document `NEXT_PUBLIC_API_BASE`.
- Add the single no-refund line to the T&C / final pay step.

**Interfaces:**
- Consumes: `GET /web/config`, `POST /web/availability`, `POST /web/hold`, `POST /web/order`; Razorpay Checkout.js with `key_id` + `order_id` from `/web/order`.

- [ ] **Step 1: Gate on the closed-flag** — on load, fetch `GET /web/config`; when `online_bookings_enabled` is false, render "Online booking paused — message us on WhatsApp" and the existing enquiry CTA; otherwise render the booking widget. (Verify: `npm run typecheck && npm run lint`, and a manual check via `preview_start` with the ERP flag both OFF and ON.)
- [ ] **Step 2: Availability + price** — category/date/time/days/guests → `POST /web/availability`; show the server `price`; disable pay when `available:false`. (Verify: typecheck/lint + manual.)
- [ ] **Step 3: Hold → order → Razorpay Checkout** — on "Pay", `POST /web/hold` then `POST /web/order`, open Razorpay Checkout with the returned `order_id`/`key_id`; on dismissal, let the hold expire (no client-side confirm). Confirmation screen states the booking is confirmed only after the success callback; the booking's truth is the ERP. Add the no-refund line here. (Verify: typecheck/lint + manual end-to-end against ERP test keys.)
- [ ] **Step 4: Commit** — `feat(booking): website booking widget + Razorpay checkout`.

> Website correctness lives in the ERP tests above; the website is verified by typecheck, lint, and a manual end-to-end pass (ERP in test mode, Razorpay test keys). A confirmed booking must appear in the ERP's existing booking views — that is the Phase 0 done-check.

---

## Done-check for Phase 0

A guest completes the website flow with Razorpay **test** keys; the ERP shows a `confirmed`, `booking_source="web"` booking in its existing booking views with the payment in the ledger; the owner gets WhatsApp + ntfy; a second webhook delivery changes nothing; a blocked room and the closed-flag are both honoured; and `python -m pytest backend/tests/ -q` is green.
