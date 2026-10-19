# Online Booking (Razorpay), ERP-driven — Design

**Date:** 2026-10-19
**Repos:** `cibara-comforts` (public website, Next.js static export) · `cibara-management` (ERP, Flask + Firestore — single source of truth)
**Status:** Design for approval. Nothing is built until this is approved.

---

## 1. Intent & why

Guests should be able to book and pay for a room online on the website and have
that booking appear in the ERP **instantly**, with **no overbooking** across the
website, walk-in, and OTA (MMT/Agoda) channels. "Web" is an **additive channel**,
exactly like MMT and Agoda — it must not change or endanger the existing walk-in
or OTA flows.

The ERP already owns all inventory, pricing, holds, payments, confirmations,
WhatsApp messaging, and analytics. This work adds a guest-facing booking+payment
loop on top of that machinery, reusing it rather than reinventing it.

## 2. Goals / non-goals / anti-goals

**Goals**
- A guest picks category + check-in date/time + number of 24h-days + guests, sees
  real availability, pays in full via Razorpay, and ends up with a confirmed
  booking visible in the ERP's existing booking views within seconds.
- Availability is computed by **one shared function** used by web (precisely) and,
  later, by the OTA iCal export — never a second copy.
- Three safety primitives ship in the core: a **buffer** (web can never sell the
  last room in a pool), **blocks** (owner removes rooms/categories from sale), and
  a **global closed-flag** (one click disables online booking everywhere).
- Full payment online. No refunds (one quiet line in T&C / pay step; not surfaced
  prominently).
- Race-safe: two guests racing for the last available room → exactly one succeeds.

**Non-goals (this project)**
- Retrofitting walk-in/OTA onto a 24h-rolling availability model. They keep their
  current calendar-date model untouched.
- Two-way OTA channel sync. We expose an **outbound** iCal feed only (groundwork).
- Partial payments, deposits, or pay-at-hotel online. Full prepay only.
- Online refunds / cancellations by the guest.

**Anti-goals (would make this a failure even if it "works")**
- Any overbooking, ever — including the race and the same-day walk-in collision.
- The browser influencing price or payment status. Amount and confirmation are
  server-authoritative only.
- Breaking or slowing an existing walk-in / OTA / billing path.
- Leaking Razorpay secrets to the browser or committing live keys.

## 3. Key decisions (made during brainstorming)

1. **Conservative + additive availability.** The shared availability function
   works on **time intervals**. Each occupant contributes one interval:
   - **Web bookings / holds:** precise `[checkin_dt, checkin_dt + 24h × days]`.
   - **Live walk-in stays:** precise, from the room doc —
     `[room.checkin_time, checkin_time + 24h × (renewal_count + 1)]`. Same-day
     turnover is the collision most likely to bite, so we treat it exactly.
   - **Future date-only bookings (OTA + manual advance):** conservative whole-span
     — `[check_in_date 00:00, check_out_date 00:00]` — because these carry no
     reliable check-in time. Pessimistic, never wrong.
   - Plus a **cleaning gap** (default 2h, config) appended after every occupant
     interval.
2. **Single shared availability function from day one**, even while only web calls
   it precisely, so the later iCal export reads the same source of truth.
3. **Core-first sequencing.** Ship and harden the core pipeline (availability →
   hold → Razorpay order → verified webhook → confirmed booking), *including*
   buffer, block, and closed-flag, before any other feature is layered on. Web
   bookings must land in the ERP and show in existing booking views first.
4. **Room mapping (confirmed by price + description):**
   website `premium-ac-room` (₹1,800) → ERP premium pool **200–206** with AC toggle
   (+₹600); website `premium-room` (₹1,200) → ERP premium pool **200–206** non-AC;
   website `double-room` "Double Room" (₹900) → ERP **deluxe** rooms **223–227**.
   Premium AC and Premium non-AC share the single physical pool 200–206.

## 4. Constraints (verified in code)

- Pricing is server-authoritative: `config.room_base_price(room, guests)` +
  `config.AC_SURCHARGE` (600) for premium-AC, × days. Website and ERP already
  agree (extra guest +₹300/night both sides). The browser never sends an amount.
- Bookings already store `check_in_time` (`routes/bookings.py` `create_booking`),
  so web can set a precise time with **no schema change**; existing availability
  just ignores it today.
- Booking statuses in use: `confirmed`, `cancelled`, `checked_in`, `checked_out`.
  We add **`pending_payment`** (a hold). Holds count as occupied.
- Existing overlap logic to mirror/replace with the shared function:
  `routes/bookings.py::check_availability` and
  `services/mmt_ingest_service.py::_assign_room` / `_pool_and_ac_for_type`
  (the premium pool + AC toggle live here).
- Atomic-claim precedent: `routes/rooms.py::_claim_room` (Firestore
  `@firestore.transactional`). Our hold is the pool-level analog.
- Reuse: `payment_service.write_payment` (now requires one FK of
  `stay_id`/`booking_id`/`settlement_id` — holds give `booking_id`),
  `config.send_whatsapp_message` (Twilio) and
  `routes/bookings.py::send_booking_confirmation` (WhatsApp confirmation text),
  owner **ntfy** alert (recent commit `b4faa30`), `services/id_docs.py` +
  guest portal (`routes/guest.py`, `services/guest_portal.py`),
  `services/insights_service.py` + `services/kpi_service.py` and the
  `insights_bp` / `analytics_bp` dashboards, `config.IST`.
- Routing/wiring: blueprints register in `app.py` with `url_prefix`. There is a
  staff-login guard with `_PUBLIC_PREFIXES`; **`/web/*` endpoints must be public**
  (guest-facing) and are protected instead by CORS allow-list + Razorpay signature
  verification + rate limiting. Settings toggles follow the
  `/settings/{billing,ui}_config` GET/POST pattern (`routes/billing.py`),
  `settings_ref.document(...).set(merge=True)` + cache invalidation.
- Deploy target: Cloud Run (`CIBARA_ENV` PROD/UAT, refuses to start without it).
  Secrets via env vars / Secret Manager.

## 5. Core architecture

All new guest-facing endpoints live under a new `web_bp` blueprint
(`routes/web.py`), `url_prefix="/web"`, added to `_PUBLIC_PREFIXES`. The shared
availability logic lives in a new **`services/availability_service.py`** so web,
walk-in checks, and the future iCal export all import it.

### 5.1 Shared availability function (SSOT)

```
services/availability_service.py

CATEGORY_POOLS = {
    "premium": ["200".."206"],   # premium AC + non-AC share this pool
    "deluxe":  ["223".."227"],
}

def occupied_intervals(pool_rooms, window_start, window_end, *, now, exclude_booking_id=None)
    -> dict[room -> list[(start, end, source)]]
    # Gathers, per pool room, the busy intervals that overlap the window:
    #   - bookings (status in confirmed/pending_payment) for pool rooms:
    #       web/precise  → [check_in_dt(from check_in_date+check_in_time), +24h*days]
    #       date-only    → [check_in_date 00:00, check_out_date 00:00]   (OTA + manual)
    #     ("web/precise" iff booking_source == "web" AND a usable check_in_time)
    #   - live walk-ins (room.status == occupied):
    #       [room.checkin_time, +24h*(renewal_count+1)]
    #   - blocks (see 5.5) covering the room or its whole category
    #   each interval is extended by CLEANING_GAP (default 2h) at its end.

def pool_free_rooms(category, checkin_dt, days, guests, *, now, exclude_booking_id=None)
    -> list[room]
    # window = [checkin_dt, checkin_dt + 24h*days]
    # returns pool rooms with NO occupied interval overlapping the window,
    # ordered by the existing _ordered_candidates preference.

def web_offerable_count(category, ...) -> int
    # = max(0, len(pool_free_rooms(...)) - BUFFER)   (see 5.4)
```

The 24h-day count (`days`) is the guest's number of rolling 24-hour periods,
matching the ERP's `renewal_count + 1` billing model — not calendar nights.

### 5.2 `POST /web/availability`

Input: `{category, check_in_date, check_in_time, days, guests}`.
Server computes the window, calls `web_offerable_count`, returns
`{available: bool, price: <server-computed>, currency: "INR"}`. Rejected when the
closed-flag is OFF (see 5.6). No room number is revealed to the guest (the pool is
internal). Rate-limited.

Price = `room_base_price(sample_pool_room, guests) (+ AC_SURCHARGE if premium-AC)
× days`, computed server-side only.

### 5.3 `POST /web/hold` — race-safe Firestore transaction

A hold both **re-checks availability** and **writes a `pending_payment` booking**
atomically, so the availability a guest saw can't go stale between check and pay.

Race-safety mechanism (the important part): Firestore transactions do **not**
protect against phantom reads from collection queries, so we serialize holds per
pool through a single sentinel doc `web_pool_locks/{category}`. Every hold
transaction **reads and writes that one doc**, which forces two concurrent holds on
the same pool to conflict → Firestore retries the loser → on retry it re-reads
availability and sees the winner's just-written `pending_payment` booking. Pattern
is the pool-level analog of `_claim_room`.

```
@firestore.transactional
def _hold(txn):
    lock = lock_ref.get(transaction=txn)            # forces conflict on same pool
    free = pool_free_rooms(..., now)                 # reads bookings/rooms/blocks
    offerable = free[:-BUFFER] or []                 # buffer applied
    if not offerable: raise SoldOut
    room = offerable[0]
    booking = {... status:"pending_payment",
               booking_source:"web", check_in_time:..., guest_count:...,
               expires_at: now + HOLD_TTL (10 min), total_amount: <server price>,
               paid_amount:0, balance:<price>, group_booking_id?:...}
    txn.set(bookings_ref.document(booking_id), booking)
    txn.update(lock_ref, {"v": Increment(1), "updated_at": now})
```

Group booking (phase 9) loops the pool selection for N rooms inside the **same**
transaction and shares one `group_booking_id`, reusing `create_multi_booking`'s
per-room-document semantics.

Returns `{booking_id, amount, expires_at}`. Rejected if closed-flag OFF.

### 5.4 Buffer

`settings/web_config.buffer` (int, default 1). Applied in
`web_offerable_count` / the hold's `free[:-BUFFER]`, per pool (200–206 combined;
223–227 separately). The website is offered `pool_size − buffer`, so it can never
sell the last room. Buffer of 0 disables it.

### 5.5 Blocks

New `blocks` collection. A block = `{scope: "room"|"category", room?, category?,
start, end, reason, created_by, created_at}`. Counted as an occupied interval by
`occupied_intervals` for any pool room it covers. ERP UI:
- **"Block now"** quick action on the room grid (block that room from now to an
  end time / open-ended).
- **Date-range block form** (room or whole category, start/end, reason).
- **Unblock** deletes the block doc.
Endpoints: `POST /blocks`, `GET /blocks`, `DELETE /blocks/<id>` (staff-auth, not
under `/web`).

**Blocks apply to every channel, not just web** (a blocked room must not be
walk-in bookable either). The shared function honours them; additionally, the
existing `check_availability` / `create_multi_booking` staff paths get a small
**additive** block-subtraction (remove blocked rooms from the returned set) — no
other change to their logic, so existing flows are untouched. *(Author's call,
builder-check: this is the only intentional touch to an existing availability
path, and it is additive.)*

### 5.6 Closed-flag (kill switch)

`settings/web_config.online_bookings_enabled` (bool, default — **see open
questions**). ERP toggle in the UI (same pattern as `/settings/ui_config`). When
OFF: `/web/availability` and `/web/hold` reject server-side
(`{enabled: false}` / 403), and the website hides the pay flow and shows
"Online booking paused — message us on WhatsApp". The website reads the flag via a
public `GET /web/config`.

### 5.7 Razorpay order

`POST /web/order` (or folded into `/web/hold`'s response): server creates the
Razorpay order with `amount` from the **ERP** (the held booking's `total_amount`,
in paise), `receipt = booking_id`, and returns `{order_id, key_id, amount}` to the
browser. `key_id` is the publishable id; the **key secret never leaves the server**.
The browser opens Razorpay Checkout with the order.

### 5.8 `POST /web/razorpay_webhook` — verified, idempotent confirm

1. **Verify** the `X-Razorpay-Signature` HMAC-SHA256 over the raw body with the
   webhook secret. Reject on mismatch (no DB touch).
2. **Idempotency:** key on the Razorpay payment/event id in a
   `processed_webhooks` collection (or a field on the booking). A retry (Razorpay
   retries) is a no-op that returns 200.
3. On `payment.captured` for our order: load the `pending_payment` booking by
   `receipt`/`booking_id`, in a transaction flip `status → "confirmed"`, set
   `paid_amount = total_amount`, `balance = 0`, stamp `razorpay_payment_id` /
   `razorpay_order_id`, clear `expires_at`.
4. `payment_service.write_payment({... type:"booking_advance" / "web_prepaid",
   method:"online", booking_id, booking_source:"web" ...})` so the money is in the
   ledger and the booking appears in existing views.
5. Send WhatsApp confirmation (reuse `send_booking_confirmation` logic /
   `send_whatsapp_message`) + owner **ntfy** alert.
All of 3–5 are idempotent: a second delivery confirms nothing new and re-sends
nothing. Event: key on the Razorpay payment id; `payment.captured` (or
`order.paid`) — builder picks one and ignores the rest.

**A confirmed web booking is an ordinary hotel stay, not OTA-prepaid.** It is
written with `booking_source="web"`, `payment_source="hotel"` (the money is the
hotel's, collected via Razorpay and settling to the hotel's bank — unlike MMT/
Agoda `payment_source="ota"`). So at arrival/checkout it flows through the normal
walk-in check-in → billing → checkout paths with a full online advance already
recorded; **no new billing branch is needed** and `is_ota_prepaid()` stays false
for it. The `booking_source="web"` tag is what analytics (phase 10) reads for
channel mix.

### 5.9 Sweep job

Release expired holds: find `status == "pending_payment"` with
`expires_at < now` and flip to `status = "expired"` (or delete) so the pool frees
up. Mechanism = whichever the ERP already uses for periodic jobs (a `/web/sweep`
endpoint hit by Cloud Scheduler, or the existing background-thread pattern) —
**builder picks**, idempotent, safe to run every minute. A late webhook for a
swept hold is handled: if the booking is gone/expired but payment captured, the
webhook re-materializes a confirmed booking (money was taken; we honour it) and
alerts the owner.

## 6. Website changes (`cibara-comforts`)

- New client booking components: category (Premium AC / Premium / Deluxe only) +
  date + time + days + guests → call `POST /web/availability` → Razorpay Checkout →
  success screen. The ERP base URL comes from a new env var
  **`NEXT_PUBLIC_API_BASE`**.
- Respect the closed-flag (`GET /web/config`): hide pay flow, show the WhatsApp
  fallback message. Keep the **existing WhatsApp enquiry flow** as the fallback for
  non-bookable rooms and when closed.
- One small no-refund line in the T&C / final pay step only (not prominent).
- Static export stays static; the booking UI is client-side and talks to the ERP
  directly (CORS-allowed origin).

## 7. Security / correctness (must)

- Razorpay **signature verification** on the webhook; **idempotent** webhook (it
  retries); **amount computed server-side** from ERP pricing only; keys in
  env/Secret Manager (never in the browser, never committed);
  **CORS allow-list** limited to the website origin(s) for `/web/*`.
- ERP stays the single source of truth; the browser never marks a booking paid —
  only the verified webhook does.
- Rate-limit `/web/availability` and `/web/hold`.
- `/web/*` is exempt from staff login but guarded as above.

## 8. Tests (ERP `tests/` + `backend/tests/`)

- **Availability 24h-overlap:** precise web window vs live walk-in (same-day
  turnover), conservative whole-span for date-only OTA/manual, cleaning gap
  honoured, premium AC+non-AC share pool 200–206, deluxe 223–227 separate.
- **Hold race / no collision:** concurrent holds on the last offerable room →
  exactly one `pending_payment`; the other gets sold-out.
- **Buffer:** pool of N offers N−buffer; last room never sold to web.
- **Webhook confirm + idempotency:** valid signature confirms once; duplicate
  delivery is a no-op; bad signature rejected; payment recorded in ledger once.
- **Block honoured:** room/category block removes rooms from web availability.
- **Closed-flag honoured:** OFF → `/web/availability` and `/web/hold` rejected
  server-side.

## 9. Phasing

**Phase 0 (core, ship first):** shared availability service · `/web/config` ·
`/web/availability` · `/web/hold` (race-safe) · `/web/order` ·
`/web/razorpay_webhook` (verified, idempotent) · sweep · buffer · blocks (+ ERP UI)
· closed-flag (+ ERP toggle) · website booking UI + Razorpay checkout + no-refund
line · the test suite above. **Done = a web booking lands in the ERP and shows in
existing booking views, race-safe, with the three safety primitives live.**

**Then, layered on (each its own slice):** (5) dynamic per-date rate overrides
read by availability+pricing · (10) analytics: occupancy %, ADR, RevPAR, channel
mix (web/walk-in/OTA), web conversion · (7) auto review-request WhatsApp after
checkout (delay) · (8) pre-arrival self check-in / ID upload via guest portal +
`id_docs` · (9) online group booking (multi-room, one payment) · (6) OTA iCal
outbound feed per pool reading the shared availability.

## 10. Prerequisites & open questions (need the owner)

1. **Razorpay account + keys.** Need test `key_id`/`key_secret` + webhook secret to
   build against test mode. **Live keys and the production webhook URL are
   deferred** — the owner provides them at go-live (ask-before-irreversible).
2. **Website production origin(s)** for the CORS allow-list (apex + any `www`/
   preview origins).
3. **Closed-flag default on first deploy** — OFF (online booking paused until the
   owner flips it on) is the safe default; confirm.
4. **Cleaning gap** default 2h and **hold TTL** 10min and **buffer** 1 — confirm or
   adjust.
5. **Guest fields collected at booking:** name + mobile (needed for WhatsApp) are
   assumed required; email optional. Confirm.

## 11. Left to the builder

- Exact sweep mechanism (scheduler endpoint vs background thread) per existing ERP
  convention.
- Whether `/web/order` is a separate call or folded into `/web/hold`'s response.
- Rate-limiter choice (existing dependency if present, else a lightweight one).
- Precise placement of the ERP block UI on the room grid, and the toggle's place in
  the settings screen, matching existing UI conventions.
- Test file layout within `tests/` vs `backend/tests/` per existing structure.

---

*Reviewer note: this document was self-checked against the two repos before
hand-off. Calls made by the author (not the owner) are marked in §10/§11.*
