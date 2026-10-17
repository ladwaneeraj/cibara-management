# CLAUDE.md — Cibara ERP (FastAPI + React migration)

This file is the working memory for anyone (human or AI) changing this repo.
Read **Preserved logic** before touching anything that moves money or tax.

---

## 1. Architecture in one picture

```
Browser ─┬─ /, /login, …  classic Flask/Jinja screens (THE UI, UI_MODE=classic, default)
         ├─ /api/v2/*     FastAPI (backend/cibara_api) ── typed facades ─┐
         ├─ /app/*        React SPA — parked; only served with UI_MODE=spa │
         └─ everything    legacy Flask app (app.py, routes/, services/)  │
            else  ◄──────────── mounted as WSGI inside FastAPI ◄─────────┘
                                         │
                                 config.py / services/*  ← ALL business logic
                                         │
                                     Firestore / Firebase Storage / Firebase Auth
```

* **One process, one container** (Cloud Run, `uvicorn cibara_api.main:app`, 1 worker).
* **UI decision (owner, Oct 2026): keep the classic screens.** `UI_MODE=classic` (default)
  serves the Flask pages at `/` and `/login`; `/app/*` redirects to `/`. The React app in
  `frontend/` is kept and still builds; `UI_MODE=spa` switches back to it without code changes.
* The Flask app is **imported unchanged** and mounted at `/` (a2wsgi). Every one of
  its ~235 routes still works at its old path: the classic UI (`/legacy`), `/static`,
  OTA ingest endpoints with their `X-Ingest-Secret`, scripts using `X-API-Key`.
* `/api/v2` endpoints are of two kinds:
  * **Facades** (most): validate input with Pydantic, enforce the permission, then run
    the *unchanged* legacy route in-process (`legacy.call_legacy`). Same handler, same
    duplicate-submit guard, same Firestore writes, same audit entries.
  * **Native** (where speed mattered): `auth/*`, `dashboard`, `bills` list/summary/detail,
    `settlements` list, `rooms/tariffs`, `admin/metrics`. They call the legacy *helpers*
    (`config.bill_tax_breakup`, `config.get_all_rooms`, `role_filters.clamp_date_range`,
    `routes.settlements._attach_bill_summary`, …) — never re-implementations.
* Strangler pattern: a module moves to native code only with a parity test (see §6).

## 2. Preserved logic — DO NOT re-implement, import

No business logic was edited by the migration: `git diff` against the pre-migration commit
shows no change under `config.py`, `services/`, `routes/`, `app.py`. The ID-document work (§3c)
later changed `services/customer_service.py`, `routes/customers.py`, `routes/utils.py` and
`services/permissions.py` — guest documents only, no money or tax path. Browser-side files changed
for the sign-in and sharing work only: `static/auth.js`, `static/login.js`, `static/bills.js`
(Share PDF), `static/sw.js` (cache version), two `<script>` tags in `templates/`, and
`scripts/regenerate_bill_pdf.py` (uses the same invoice layout as the app).

| Concern | Source of truth (unchanged) | How v2 uses it |
|---|---|---|
| GST slabs (`<₹1000→0%`, `≤₹7500→5%`, else 18%, post-discount, per night) | `config._slab_for_value`, `compute_daily_folio`, `aggregate_folio_tax`, `split_bucket_tax` | via `/checkout` (facade) |
| Bill record + numbering `CC/YYYY/MM/NNNNN` (atomic) | `config.create_bill_record`, `allocate_and_finalize_bill` | via `/checkout`, `/generate_invoice` |
| Tax breakup shown everywhere (invoice HSN table, bills list, tally) | `config.bill_tax_breakup` | called directly by `routers/bills.py` |
| GST recompute after discount / service edit | `config.recompute_bill_gst` | via `/add_bill_payment`, `/update_bill_service` |
| CGST/SGST split, place of supply KA-29, B2B/B2CL classification | `config.compute_gst_split`, `classify_invoice_type`, `/update_bill_gst` | facade |
| Credit notes `CN/YYYY/MM/NNNNN`, Section 34 window | `config.create_credit_note`, `compute_credit_components` | facades |
| Settle-later: settlement docs, customer pending flags, collection, write-off | `routes/rooms.py` (checkout), `routes/settlements.py`, `customer_service` | facades + `_attach_bill_summary` |
| Room tariffs | `config.room_base_price`, `AC_SURCHARGE`, `room_category` | `GET /api/v2/rooms/tariffs` |
| Bill PDF storage (xhtml2pdf, Storage paths, token URLs) | `services/pdf_service`, `/render_bill_pdf` | unchanged; layout swapped by `invoice/` (§3b), money untouched |
| Guest-portal QR (qrcode) | `services/guest_portal.qr_png` | facade |
| Invoice OCR (Gemini) | `services/ocr_service` | unchanged legacy endpoint (`/ocr/*`) |
| Duplicate-submit guard (`X-Op-Id`, 409 `duplicate_suspected`, `X-Force-Duplicate`) | `services/request_guard` | headers forwarded; SPA implements the same client protocol |
| Audit log schema | `services/audit_log.write_log` | new layer writes through the same function inside a Flask request context |

**Rule:** if a number on an invoice could change, the change belongs in the legacy module
with its existing tests (`tests/`), not in `backend/`.

### Parity evidence (run on every change)
`backend/tests/test_parity.py` drives six desk scenarios twice on an identical fresh
database — once with the **old browser payloads to the old paths with a Firebase token**,
once through **/api/v2 with the new JWT** — and asserts identical bills (every money, GST,
CGST/SGST, folio, service, segment field and the tax breakup), room state, running totals,
payment ledger and settlements:

1. walk-in ₹1,200 + water (5%) 2. ₹900 pay-later + accommodation extra bed (exempt→5% slab)
3. 3 nights, renewals, discount, part payment, **settle later** 4. overpay → refund
5. ₹8,200 AC night (**18%**) 6. company **B2B** bill with GSTIN.

Plus golden figures: ₹1,200 → taxable 1,142.86, GST 57.14 (28.57 + 28.57), IGST 0.
The legacy suite (`tests/`, 557 tests) still passes unchanged.

## 3. Auth, sessions, roles

* **Passwords stay in Firebase Auth.** `POST /api/v2/auth/login` checks them with the
  Identity Toolkit REST API (`accounts:signInWithPassword`, synthetic email
  `<userId>@cibara.internal` — same as the old login page), then:
  * access JWT (HS256, 15 min) in the response body — kept in memory by the SPA;
  * refresh JWT (7 days) in an `HttpOnly; SameSite=Strict; Path=/api/v2/auth` cookie, rotated on use;
  * a Firebase **custom token** so the SPA can attach Firestore listeners under the existing
    `firestore.rules` (role claim comes from the user's existing custom claims).
* **Refresh** re-checks Firebase on every rotation (≤ once per 15 min per user): disabled
  user, `tokens_valid_after` (force-logout / password reset / role change), `users/{id}.isActive`,
  and re-reads the role claim (role changes apply within 15 min, or immediately — see below).
  * **Families:** each login is a refresh-token family (`fam` claim). Rotation is tracked in
    memory; a rotated cookie is accepted for 30 s (two tabs refreshing together), after that
    presenting it again = theft → the whole family is killed (audit `auth.refresh_denied`,
    reason "refresh token reuse"). Logout kills the family. After a restart the state is empty
    and an unknown family is *adopted* (otherwise every deploy would sign everyone out).
  * **Absolute cap:** `auth_time` (password sign-in time) is carried through rotations;
    refresh is refused after `SESSION_MAX_DAYS` (default 30).
  * **Outage ≠ logout:** if Firebase is unreachable, refresh answers **503 and keeps the
    cookie**; the SPA keeps the session and retries (`RefreshResult = 'unavailable'`). Only
    401/403 (`'denied'`) sign the user out. A deleted Firebase user is 401.
* **Immediate revocation:** force-logout, reset password, role change, deactivate and
  self-service password change also add the user to an in-memory "issued-before" list
  (`security/revocation.py`) so live access tokens die at once. Single instance ⇒ exact.
  This is a Flask `after_request` hook in `legacy.py`, so it fires for the classic Users
  screen as well as the `/api/v2/admin` facades.
* **Classic screens use the same JWT sessions** (`static/login.js`, `static/auth.js`):
  * login page → `POST /api/v2/auth/login` (server-side password check, attempt limits, refresh cookie);
  * every page load → `POST /api/v2/auth/refresh?firebase=true` restores the session from the
    cookie, then the Firebase compat SDK signs in with the returned custom token so
    `google_sync.js` listeners run under `firestore.rules` exactly as before
    (`CibaraAuth.ready()` resolves after that);
  * the fetch wrapper attaches the 15-min access JWT, refreshes once on 401 (single flight, same
    `X-Op-Id` on retry), and treats 503/offline as "keep the session, retry" — only a server
    denial signs out; the duplicate-write guard, idle timeout and role gating are unchanged;
  * sign-out → `POST /api/v2/auth/logout` + Firebase sign-out + a `BroadcastChannel`/`storage`
    event so every open tab leaves; a sign-in in another tab makes open tabs refresh at once
    and reload if the user changed (shared front-desk PCs);
  * change password → `POST /api/v2/auth/password` (verifies, updates, ends all sessions, audits);
  * `auth.js`/`login.js` are referenced through `asset_url()` and the service-worker cache
    version was bumped, so no browser keeps running the old Firebase-only sign-in.
  * First deploy: everyone signs in once (there is no refresh cookie yet).
* (UI_MODE=spa only) `/login` redirects to `/app/login?signout=1` so a classic sign-out also
  ends the SPA session.
* **Legacy routes accept the new JWT**: `legacy.py` wraps `services.auth_service.verify_token`;
  HS256 tokens are ours, anything else (the classic UI's Firebase ID tokens) goes to the
  original Firebase verification. Every legacy decorator funnels through that function.
* **Roles are unchanged** (`admin`, `manager`, `housekeeping`) and so is the permission map
  (`services/permissions.py`). UI labels: housekeeping is shown as **Staff**. **Guest** is the
  QR guest-portal session (anonymous Firebase auth + room/mobile proof enforced by
  `firestore.rules`; the `guest/` app is unchanged and never calls this API).
* **Hardening** (`security/legacy_hardening.py`, `LEGACY_RBAC_HARDENING=true`): legacy routes
  that only required a login now require the permission the old UI already checked:
  `/checkin`→room.checkin, `/checkout`→room.checkout (+`settle_later.use` when settling later),
  `/add_on` & `/renew_rent`→room.update, `/reports` `/revenue_report` `/reports/gstr1_summary`
  →analytics.view, `/render_bill_pdf`→register.view, `/get_ota_settlements`→settlement.manage.
  API-key callers are unaffected. Set the flag to `false` to restore the old behaviour.
* Rate limits (in memory): 600 req/min/IP, 120 writes/min/user, login 20/min/IP (front desks
  share one NAT IP) and 8 failures/15 min/account (keyed by the Firebase identity, reset on
  success), password change 5/15 min.
* **Legacy bridge safety nets** (`legacy.py`, no legacy file edited):
  * On Cloud Run with `API_KEY` unset, the legacy "dev mode" (anonymous GETs allowed) is
    closed: anonymous requests to non-public, non-ingest paths get 401. Local dev unchanged.
  * The classic page (`/`, also `/legacy`) no longer exposes `API_KEY`: it is redacted from
    the rendered HTML (the classic UI authenticates with its access token, which
    `require_auth` checks before the API key). Integrations sending `X-API-Key` still work.
  * Legacy 404s are recorded under one metrics row (`legacy 404`); the per-route registry is
    capped at 400 rows (overflow → `other`).
* Audit: new actions `auth.login`, `auth.login_failed`, `auth.logout`, `auth.refresh_denied`
  (same `audit_logs` schema).

## 3b. Invoice layout v2 (GST) and PDF sharing

* `backend/cibara_api/invoice/render.py` replaces `routes.billing._build_bill_html` at startup
  (`INVOICE_LAYOUT=v2`, default; `legacy` restores the old renderer — the legacy function stays
  in `routes/billing.py` untouched). Every surface uses it: bill modal, Print, PDF stored at
  checkout, `/render_bill_pdf`, `scripts/regenerate_bill_pdf.py`, the WhatsApp/share copy.
  Credit notes keep their legacy renderer.
* **Presentation only.** Payable total = stored `total_amount`; tax table =
  `config.bill_tax_breakup` (what GSTR-1 files); particulars = stored folio/services, grouped
  with the legacy `_group_folio` / `_resolve_view_mode`. `tests/test_invoice.py` asserts the
  v2 total equals the legacy GRAND TOTAL for 12 scenarios × both views, and that particulars
  net to the total. A service discount larger than the accommodation share shows as
  "Less: discount on other items" in the summary (the breakup's service rows are pre-discount).
* Rule 46 fields are mapped in the module docstring (supplier/GSTIN, serial ≤16 chars, date,
  recipient + GSTIN/address/state, HSN/SAC, qty, rate, taxable value after discount, CGST/SGST
  rate+amount, place of supply, reverse charge, signature). Also: amount in words, "Original
  for recipient", rupee glyph in the PDF (vendored DejaVu Sans, `invoice/fonts/`), page x of y.
* **Document title:** `INVOICE_TITLE_RULE=by_supply` gives BILL OF SUPPLY (all exempt) /
  INVOICE-CUM-BILL OF SUPPLY (taxable + exempt to an unregistered guest, Rule 46A) / TAX
  INVOICE, but **only for bills checked out on/after `INVOICE_TITLE_BY_SUPPLY_FROM`**
  (empty = off = always TAX INVOICE). Regenerating a PDF overwrites it at the same link, so an
  already-issued invoice must never change type. Owner + CA to confirm before setting the date.
* **Branding is set in the app:** Settings → **Invoice & payments** (`static/invoice-settings.js`,
  admins only, `settings.update`) → `/api/v2/settings/invoice`. Logo, signature and a static
  UPI QR image (PNG/JPEG ≤ 2 MB, re-encoded to PNG, downscaled) go to Storage
  `branding/<kind>.png`; text fields (UPI ID + payee, e-mail, website, signatory label,
  thank-you line, terms) to the new doc `settings/invoice_branding`. Every change is audited
  (`settings.invoice_update` / `settings.invoice_image`). Precedence: settings doc > env
  (`UPI_VPA`, `UPI_PAYEE_NAME`) > `invoice/brand/branding.json` (+ optional files there).
  Cached 5 min, cleared on save. With a UPI ID, a bill with a balance due prints a QR for that
  exact amount; without one, the uploaded QR image is printed with the amount under it.
* **Windows/PDF:** the DejaVu font is registered with ReportLab directly — CSS `@font-face`
  makes xhtml2pdf re-open a temp copy, which Windows refuses ("Permission denied … .ttf").
* **304 + gzip:** conditional requests skip gzip (`core/middleware.py`); Starlette's gzip
  otherwise adds a trailer to the empty 304 and uvicorn aborts the response.
* **Sharing the PDF file:** `GET /api/v2/bills/{id}/pdf-file` (register.view) streams the stored
  PDF same-origin (the server resolves `pdf_url`; only `bills/`/`credit_notes/` objects in our
  bucket; no token in URLs/logs). The classic WhatsApp modal has **Share PDF** (native share
  sheet with the file attached: phones, tablets, Chrome/Edge on Windows with WhatsApp installed)
  and falls back to downloading the PDF + opening the guest's chat; **Send link** keeps the old
  link message. The PDF is pre-loaded when the modal opens because browsers only allow sharing
  straight from a tap.

## 3c. Guest ID documents (Aadhaar) — private, audited

* **Storage:** `customer_docs/{mobile}/{doc_id}.jpg` with **no download token** (private), one
  record per image in `customers/{mobile}/id_docs/{doc_id}` (side front/back/other, status
  active/archived/removed, source auto_scan/manual/upload/legacy, `captured_by`, context
  check-in/checkout/room, append-only `history`, `views`, `last_viewed_by`). The customer doc
  only gets `id_doc_count` / `has_id_docs` (merge). Logic: `services/id_docs.py`.
* **API:** `/api/v2/customers/{mobile}/id-docs` (`routers/customer_docs.py`): list, upload,
  `/{id}/image?variant=thumb|view|original`, `/{id}/remove`, `/restore`, `/side`. `view` is
  watermarked with the viewer's name + time; images are `no-store`. Audit actions
  `customer_doc.capture|view|download|remove|restore|relabel`.
* **Permissions:** `customer_doc.capture` + `customer_doc.view` = admin, manager;
  `customer_doc.download` + `customer_doc.remove` = admin. Housekeeping: none.
* **Remove is soft** — the file is kept and an admin can restore it. A new front/back
  archives the previous one; nothing is ever auto-deleted.
* **Legacy photos:** `id_doc_urls` entries are adopted lazily (record `legacy-<hash>` pointing
  at the same object) and the array is never rewritten. `scripts/migrate_id_docs.py --adopt`
  does everyone; `--revoke-tokens` then switches off the old public links (files kept).
  `/get_customer` etc. now return `id_doc_urls: []` + `id_doc_count`.
* **Classic UI unchanged** (owner decision): the old camera modal / auto-scan and photo viewer
  in `static/customer-docs.js`, the register ID popup and customer manager. `/get_customer`
  returns `id_doc_urls` as in-app links (only for `customer_doc.view`) plus `id_doc_meta`
  (who captured, when); the screens load them with `window.CibaraSecureImg` (apiFetch → blob
  URL) and the viewer caption shows "Captured by … · date". Classic uploads are side "other"
  (never archive each other; beyond 6 the oldest are archived, not deleted).
* **Bugs fixed (docs went missing):** background "trim to 3" deleted new scans of returning
  guests; first-time check-in `set()` wiped the parallel upload (now `create()`); check-in and
  checkout shared one photo tray; the tray was cleared after upload (lost the next guest's
  photos); delete rewrote the whole list; `/admin/cleanup_dead_doc_urls` and
  `/admin/repair_doc_tokens` were open to any user (now admin; repair retired, 410);
  Firestore rules let browsers write `customers` (now `write: if false` — deploy rules).
* Tests: `backend/tests/test_customer_docs.py`.

## 4. Firestore usage

* The biggest latency fix is auth: the old stack called
  `verify_id_token(check_revoked=True)` — a network round trip — up to 4× per request.
  New-client requests verify a local HS256 signature instead.
* Bills list: keyset-paginated (50/page, cursor `checkout_time|docId`) instead of loading the
  whole range plus a full rooms scan and three unused tally queries. The period tally is a
  separate lazy call.
* Settle later: status filter runs in Firestore (`status in [pending, partial]`), bill lookups
  only for returned rows. (A settlement doc with no `status` field shows only under "All".)
* Dashboard: one call (legacy `/get_data` + arrivals + ui_config in parallel, legacy caches
  reused); room changes stream via a Firestore listener with IndexedDB cache, so a reload
  only pays for changed documents. Polling fallback 15 s if Firebase is unreachable.
* **No new composite indexes are required**: every new query is a single-field range/`in`.
  `firestore.indexes.json` is unchanged.
* **Monitoring:** every response carries `X-Firestore-Reads`, `X-Firestore-Writes` and
  `Server-Timing`; `GET /api/v2/admin/metrics` (Admin → System health) shows per-route calls,
  p50/p95 latency and reads per call since the last restart. Counting wraps the GAPIC client
  (`core/metrics.py`) and is guarded so it can never break a Firestore call.

## 5. Running it

```bash
# backend (Python 3.11)
python -m venv .venv && . .venv/bin/activate
pip install -r backend/requirements-dev.txt
# real Firebase (same env vars as before) + JWT_SECRET:
export CIBARA_ENV=UAT JWT_SECRET=$(python -c "import secrets;print(secrets.token_urlsafe(48))")
PYTHONPATH=.:backend uvicorn cibara_api.main:app --reload --port 8080

# or: everything in memory, no credentials, seeded demo data
cd backend && python -m tests.demo_server      # http://localhost:8080/  admin/admin123 manager/manager123 staff/staff123

# frontend
cd frontend && npm ci && npm run dev            # http://localhost:5173/app/ (proxies /api to :8080)
npm run build                                   # → frontend/dist, served by FastAPI at /app
```

Tests:
```bash
cd backend && python -m pytest tests --cov=cibara_api     # new layer (fakes, no network)
python -m pytest tests                                     # from repo root: legacy suite, unchanged
cd frontend && npm test && npm run typecheck               # Vitest + RTL, tsc strict
npm run e2e        # Playwright smoke against a running server (demo_server or real)
```
`backend/tests/fakes/fake_firestore.py` is an in-memory Firestore (transactions, transforms,
cursors, preconditions) used because the emulator cannot be downloaded in some sandboxes.

## 6. Deploying (Cloud Run, unchanged pipeline)

`cloudbuild.yaml` still runs `gcloud run deploy lodge-management --source=.`; the root
`Dockerfile` is now the two-stage FastAPI + React image. Before the first deploy:

1. Bind **`JWT_SECRET`** (32+ random chars) in the Cloud Run console → Variables & Secrets.
   The service refuses to start on Cloud Run without it. Existing vars (`CIBARA_ENV`,
   `FIREBASE_CREDENTIALS`, `GEMINI_API_KEY`, ingest secrets, …) stay as they are.
2. Optional `PUBLIC_ORIGIN=https://<host>` if the Firebase web API key has HTTP-referrer
   restrictions (the server-side password check then sends that Referer).
3. `--max-instances=1` is set on purpose (in-memory rate limits, revocation, legacy caches).
4. Cloud Scheduler jobs hitting `/mmt/ingest`, `/agoda/ingest`, `/bank/settlements/ingest`
   keep working (same paths, same `X-Ingest-Secret`).

**Rollback:** `Dockerfile.flask` is the previous image byte-for-byte — copy it over
`Dockerfile` (or deploy the previous revision in the console). No data migration exists to undo.

### 6.1 Reliability & observability (Phase 0 safety net)

All GCP commands below are scoped to **cibara-dev**. NEVER run them against prod
(`cibara-software-61512`) — always pass `--project cibara-dev`.

**CI gate** — `.github/workflows/ci.yml` runs on every PR: Python (legacy `tests/` +
FastAPI `backend/tests`), SPA (ESLint + `tsc` typecheck + Vitest), and the classic-UI
ESLint (`no-undef` is a hard error — it catches the init-bug class in the concatenated
`static/*.js`). To actually block merge, enable these jobs as **required status checks** in
the branch protection rules (GitHub → Settings → Branches — owner action). Mirror the lint
half locally: `pip install pre-commit && pre-commit install`.

**Error monitoring (Sentry)** — off unless `SENTRY_DSN` is set (bind it in Cloud Run →
Variables & Secrets; `SENTRY_ENVIRONMENT`/`SENTRY_RELEASE`/`SENTRY_TRACES_SAMPLE_RATE`
optional). Captures FastAPI + legacy-Flask unhandled errors and browser errors (classic UI
`static/error-monitor.js` + SPA `src/lib/errorMonitor.ts` → `POST /api/v2/client-errors`).
PII (Aadhaar / mobile / e-mail / bodies / cookies / credentials) is scrubbed in
`core/observability.py` (`send_default_pii=False`, `before_send` fails closed). Set the
error-rate alert inside Sentry (not GCP) once the DSN is provisioned.

**Firestore backups + PITR** (enabled on cibara-dev 2026-10-16; mirror on prod when ready):
```bash
gcloud firestore databases update --database="(default)" --enable-pitr --project cibara-dev
gcloud firestore backups schedules create --database="(default)" --recurrence=daily  --retention=7d  --project cibara-dev
gcloud firestore backups schedules create --database="(default)" --recurrence=weekly --day-of-week=MON --retention=14w --project cibara-dev
gcloud firestore backups schedules list --database="(default)" --project cibara-dev
gcloud firestore backups list --project cibara-dev
```
PITR = 7 days of per-minute history; daily backups kept 7 days; weekly kept 14 weeks.

**Firebase Storage versioning + lifecycle** (bucket `cibara-dev.firebasestorage.app`):
```bash
gcloud storage buckets update gs://cibara-dev.firebasestorage.app --versioning --project cibara-dev
gcloud storage buckets update gs://cibara-dev.firebasestorage.app --lifecycle-file=ops/storage-lifecycle.json --project cibara-dev
```
`ops/storage-lifecycle.json` deletes **noncurrent** versions only (age ≥30d or >5 newer) —
live objects are never touched.

**Restore runbook (DR drill).** Always restore into a NEW throwaway database and verify;
never overwrite `(default)`. A separate scratch project is NOT required.
```bash
gcloud firestore backups list --project cibara-dev --format="value(name,state,snapshotTime)"   # 1. pick a COMPLETED backup
TOKEN=$(gcloud auth print-access-token)                                                          # 2. restore into a temp DB
curl -s -X POST "https://firestore.googleapis.com/v1/projects/cibara-dev/databases:restore" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"databaseId":"restore-test","backup":"<BACKUP RESOURCE NAME>"}'
# 3. poll the returned operation; spot-check a known doc in the "restore-test" database
gcloud firestore databases delete --database="restore-test" --project cibara-dev               # 4. tear down
```
> **DRILL STATUS (2026-10-16):** PITR + schedules are enabled, but the first scheduled
> backup had not yet materialised and this workstation's gcloud SDK has no
> `firestore databases restore/clone` subcommand, so the restore was **not yet validated
> end-to-end**. Validate once the first daily backup lands (≈24h) via the REST call above,
> or update the gcloud SDK, or grant export IAM to run an export→import drill immediately.

**Uptime + alerting (Cloud Monitoring).** Uptime check on the UAT health endpoint plus two
alert policies (service down, 5xx spike) notifying an e-mail channel:
```bash
gcloud monitoring uptime create "Cibara UAT health" --resource-type=uptime-url \
  --resource-labels=host=lodge-management-uat-afe5xbwddq-el.a.run.app \
  --protocol=https --path=/api/v2/health --port=443 --period=5 --project cibara-dev
```
The notification channel and alert policies were created via the Monitoring REST API
(`v3/projects/cibara-dev/notificationChannels` and `.../alertPolicies`) because this host's
SDK lacks the `alpha` component. Alert recipient defaults to `cibaracomforts@gmail.com` —
change it in Monitoring → Alerting → Notification channels.

**Deferred (need a decision):** a GCS daily *export* (for BigQuery / §12 reporting) needs an
IAM grant to the Firestore service agent + an export bucket — not done; the managed scheduled
backups above already cover disaster recovery.

### 6.2 Security hardening (Phase 1)

**Response headers / CSP** (`core/middleware.py`). The SPA (`/app`) keeps its strict
`script-src 'self'` CSP. Classic Jinja pages now get their own CSP (HTML documents only),
pinning every origin the classic UI loads (firebase SDK, chart.js, leaflet + OSM tiles,
font-awesome, Google Fonts) with `object-src 'none'`, `base-uri 'self'`, `frame-ancestors
'self'`. It keeps `'unsafe-inline'` for scripts (legacy inline blocks/handlers), so the real
XSS defence is escaping at the sinks. Mode switch: `CLASSIC_CSP=enforce` (default) |
`report-only` (vet a policy change without breaking the page) | `off`. HSTS
(`Strict-Transport-Security`) is sent on Cloud Run (HTTPS). `X-Content-Type-Options`,
`Referrer-Policy`, `X-Frame-Options` are on every response.

**DOM-XSS.** Guest-controlled values (name, free-text reason) were interpolated raw into
`innerHTML` in 16 places; all now escaped via `static/security.js`'s `window.escHtml`
(loaded first in `index.html`). Use `escHtml(...)` for any guest value that reaches
`innerHTML`; not for `textContent`, WhatsApp/plain-text, or URL components.

**JWT_SECRET → Secret Manager.** The app reads `JWT_SECRET` from the env, or — new — from a
file via `JWT_SECRET_FILE` (the Secret Manager *mounted-volume* pattern; keeps the secret
out of the environment). Setup + rotation (scope to `--project cibara-dev`; never prod):
```bash
printf '%s' "$(python -c 'import secrets;print(secrets.token_urlsafe(48))')" \
  | gcloud secrets create jwt-secret --data-file=- --project cibara-dev          # create (or: versions add)
# Grant the Cloud Run runtime service account access (IAM — owner action):
gcloud secrets add-iam-policy-binding jwt-secret --project cibara-dev \
  --member="serviceAccount:<RUNTIME_SA>" --role=roles/secretmanager.secretAccessor
gcloud run services update lodge-management-uat --project cibara-dev \
  --update-secrets=JWT_SECRET=jwt-secret:latest     # or mount a volume + set JWT_SECRET_FILE
# Rotate: add a new version, then redeploy to pick up :latest. A new JWT_SECRET
# invalidates all live access/refresh tokens (everyone signs in once) — expected.
gcloud secrets versions add jwt-secret --data-file=- --project cibara-dev
```

**Legacy API_KEY (§10).** Redacted from the classic page (bridge) and now covered by a test;
a startup warning fires when it is set. Rotate it, or unset it if no integration sends
`X-API-Key`: `gcloud run services update lodge-management-uat --project cibara-dev
--update-env-vars=API_KEY=<new>` (or `--remove-env-vars=API_KEY`).

**Dependency/vuln scanning.** `.github/dependabot.yml` (weekly pip + npm + actions) and
`.github/workflows/security-scan.yml` (pip-audit + npm audit, advisory). Enable Dependabot
alerts + security updates in GitHub repo settings (owner). Fixed now: `pyjwt` 2.10.1→2.15.0,
`python-multipart` 0.0.20→0.0.31. Open (Dependabot, breaking/coordinated): `starlette`
(pinned by `fastapi` — needs a fastapi bump), `firebase`/`@firebase/firestore` (high),
`react-router` v6→v7 (moderate, major).

**Not done this phase:** admin MFA + login-anomaly audit (original item 8) — deferred; and
the CI gate only blocks merges once the jobs are set as required status checks (owner).

### 6.3 RBAC / step-up re-auth (Phase 2)

**Step-up RE-AUTH, not two-person approval.** This is a solo/small-desk lodge, so the acting
admin re-enters their OWN password to confirm a money-leaving action — it confirms intent and
protects an unattended, signed-in session. It is named honestly as such everywhere (UI copy,
audit, docs); the gated actions are already admin-only, so initiator == authorizer.

**Flow.** A gated request returns `428 {code:"step_up_required", action, amount}`. The client
(classic `static/step-up.js` via the `auth.js` fetch wrapper; SPA `StepUpHost` via the
`lib/api` `stepUp` hook) prompts for the password, calls `POST /api/v2/authorize` (rate-limited
with the login limits, admin-only, verifies the caller's own password), and replays the SAME
request (same `X-Op-Id` — the blocked request never ran) with `X-Step-Up-Token`. Every attempt
is audited: `authz.step_up` (success), `authz.denied` (bad password / not admin), `authz.blocked`
(gate hit without a token).

**Where it lives (no money/tax logic touched):** `security/step_up.py` (pure action mapper +
in-memory single-use token store + per-(user, action, target) grace window — single instance,
like the rate limiter), `routers/step_up.py` (`/api/v2/authorize`), and a `before_request` gate
in `legacy.py` that covers the classic UI and facade paths alike.

**Gated now (body-detectable):** `/cancel_bill`, `/issue_credit_note` always;
`/add_bill_payment` bad-debt/credit-note always + discount ≥ threshold; `/collect_settlement`
write-off/credit-note always; `/checkout` manual refund ≥ threshold. **Deferred (documented):**
checkout OVERPAY refunds (amount is computed server-side, not in the body) and staff BANK payouts
(dynamic `/staff/<id>` paths; already admin-only via `staff.pay.account`).

**Settings (env-overridable):** `STEP_UP_AUTH` (master kill-switch, **default on**),
`STEP_UP_REFUND_MIN=1000`, `STEP_UP_DISCOUNT_MIN=2000` (DEFAULTS — confirm the numbers),
`STEP_UP_GRACE_SECONDS=180`, `STEP_UP_TOKEN_TTL_SECONDS=120`.
> **DEPLOY/SEQUENCING:** keep `STEP_UP_AUTH=false` in a running environment until the client
> prompt is deployed, else gated actions 428 with no way to confirm. The whole FastAPI stack is
> not in prod yet, so once all Phase 2 PRs merge, default-on is safe at deploy time.

**Permission splits:** `payment.refund` (out of `payment.edit`) and `settlement.writeoff` (out
of `settlement.manage`) are registered (admin-only) so money-OUT is distinct and can be
delegated later without editing route handlers. `LEGACY_RBAC_HARDENING` stays **default-on**.

### 6.4 Scaling: shared cache + CDN (Phase 3)

**Shared cache (off-process state), feature-flagged.** `core/cache.py` defines a
`CacheBackend` (get/set/getdel/incr) with a MemoryBackend and a RedisBackend;
`get_shared_backend()` returns the Redis backend only when `REDIS_URL` is set AND reachable,
else `None` → the existing in-process state. So the **default (one Cloud Run instance) is
unchanged**; set `REDIS_URL` (e.g. Memorystore) to run `>1` instance safely, and unset it to
revert. A Redis error degrades to the in-process path (fail-open — the Firebase refresh check
stays the security backstop).

Moved to the shared cache when `REDIS_URL` is set:
* rate-limit counters (`core/ratelimit.py`) — a fixed-window counter shared across instances;
* access-token revocation marks (`security/revocation.py`) — TTL = the access-token lifetime.

Still process-local **by design** (follow-ups, not yet moved):
* step-up tokens + grace (`security/step_up.py`) — a one-file wiring to `core/cache`, blocked
  until the Phase 2 branch merges (step_up.py isn't on the Phase 3 base);
* refresh-token families rotation/reuse detection (needs atomic multi-key semantics);
* the legacy duplicate-submit guard.

Enabling Memorystore on cibara-dev (owner — VPC connector = networking/billing; `--project
cibara-dev`, never prod):
```bash
gcloud redis instances create cibara-cache --region=asia-south1 --size=1 --tier=basic --project cibara-dev
# create a Serverless VPC Access connector in asia-south1, then:
gcloud run services update lodge-management-uat --project cibara-dev \
  --vpc-connector=<connector> --set-env-vars=REDIS_URL=redis://<host>:6379
# only now may --max-instances be raised above 1. Unset REDIS_URL to revert.
```

**Cloud CDN for /static.** `/static` responses now carry CDN-friendly `Cache-Control`
(`immutable` for versioned `?v=` URLs, `max-age=3600` otherwise; `core/middleware.py`); dynamic
routes stay `no-store`/`no-cache`. Putting Cloud CDN in front (owner — external HTTPS LB =
billing/networking):
```bash
gcloud compute network-endpoint-groups create cibara-neg --region=asia-south1 \
  --network-endpoint-type=serverless --cloud-run-service=lodge-management-uat --project cibara-dev
gcloud compute backend-services create cibara-be --global --enable-cdn \
  --cache-mode=USE_ORIGIN_HEADERS --project cibara-dev
gcloud compute backend-services add-backend cibara-be --global \
  --network-endpoint-group=cibara-neg --network-endpoint-group-region=asia-south1 --project cibara-dev
# + URL map, target HTTPS proxy, managed cert and a global forwarding rule (static IP).
```
Cloud CDN then caches `/static` at the edge per those headers; everything else passes through.

## 7. Migration status

The classic screens are the UI (§1). The table below describes the parked React app
(`UI_MODE=spa`); its `/api/v2` endpoints remain available and tested either way.

| Area | New UI (/app) | API |
|---|---|---|
| Login, password change, sessions | ✅ | native |
| Front desk: room grid, check-in, payments, refunds, add-ons, renewals, discount, room shift, housekeeping requests, checkout (incl. settle later, company billing) | ✅ | facades |
| Cleaning / inspection with checklist and photos | ✅ | facades |
| Bills: list, search, filters, invoice preview, print, PDF, WhatsApp, guest/GST edits, collect, cancel, activity, credit notes | ✅ | list native, actions facades |
| Reports: overview, GSTR-1 summary, operations insights, transactions, settle later, expenses (basic) | ✅ | facades (+ native settlements) |
| Guest requests (staff side) + portal settings + QR | ✅ | facades |
| Admin: users, audit log, settings, alerts, metrics | ✅ | facades (+ native metrics) |
| Bookings & calendar, Register, Banking, Staff & payroll, Laundry, Maintenance, expense OCR/advances/split, customer ID documents, stay-time edits, checkout revert, manual bill, GSTR-1/3B Excel workbook, GST month locks UI | classic screens (`/legacy`) | legacy routes work with the new JWT |

Next modules to port, in order of daily use: Bookings → Register → Staff → Banking.
For each: write the facade, add a parity test, then build the screen.

## 8. Known issues found in the legacy code (NOT changed — logic preserved)

Fixing these changes accounting behaviour; each needs an owner decision and its own test.

1. `/collect_settlement`: the Section-34 credit-note check runs **after** the payment,
   totals and settlement are committed; the client's "acknowledge & retry" then gets
   `ALREADY_PAID`, so the bill is never updated and no credit note is issued. (The new UI
   shows the warning and does not retry.)
2. `config.create_credit_note` routes tax to **IGST** when `recipient_state_code != "29"`,
   unlike every other path (always CGST+SGST, place of supply KA-29).
3. Total credit across several credit notes on one invoice is not capped at the invoice value.
4. `/add_bill_payment` with `discount_type="credit_note"` both rewrites the bill's GST and
   issues a credit note for the same amount, and skips the month-lock check; its
   "needs GSTIN or reason" check runs after the writes.
5. `recompute_bill_gst` and `/edit_bill_room_price` read `bill.pre_transfer_charges`, which
   checkout never writes top-level → transferred stays re-price all nights at the final rate.
6. `/reports`: `checkins` counts only rooms occupied *now*; `renewals` can double count.
7. `/list_advances` calls `payment_service.query_payments_by_booking_id`, which doesn't exist.
8. `GET /api/audit-logs` without a user/action/target filter scans an arbitrary ≤2000-doc window.
9. Guest app hard-codes a 24 h session while rules cap it at `sessionHours`; setting
   `sessionHours < 24` refuses every guest login (the settings form now warns).
10. The classic page renders the server `API_KEY` into `index.html` to anonymous visitors.
    The bridge now redacts it (see §3), but **rotate `API_KEY`** if it was ever deployed —
    it was readable by anyone who loaded `/`. If no integration uses it, unset it.
11. Legacy client bugs avoided by the new UI (server untouched): `bad_debt` vs `is_bad_debt`
    (**behaviour change — owner sign-off needed:** the new Bills screen's "bad debt" option
    sends `is_bad_debt`, which the server actually reads, so it now takes effect; in the
    classic UI it was silently ignored),
    check-in `photoPath` vs `photo_path`, AC toggle left on for room 207, manual refund dated
    in UTC, two competing checkout handlers with different payloads.

## 9. Conventions

* Backend: `backend/cibara_api/` — `routers/` (one file per area), `security/`, `core/`.
  Facades use `routers/_forward.forward(...)`; never import Flask `request`/`g` in routers —
  use `legacy.legacy_context(user)` when a legacy helper needs them.
* Every error is `{"success": false, "message": ...}` (legacy routes may return HTTP 200 with
  `success:false`; the SPA treats that as an error).
* Frontend: `src/lib` (api client, auth store, realtime, formatting), `src/components/ui`
  (design system), `src/features/<area>`. Server state = TanStack Query; session/UI = Zustand.
  Money is formatted only with `lib/format.money`; dates are IST business days (`istDate`).
* **Visual system** (`src/index.css` tokens + `components/ui`): cobalt `brand-*` for actions
  and occupied rooms, saffron `accent-*` (its complement) only for the brand mark, active-nav
  marker and highlights, navy `ink-*` for the sidebar and dark mode, grey `canvas` page
  background with white cards. Status colours are fixed app-wide: emerald = vacant/paid,
  brand blue = occupied, amber = cleaning, sky = ready to inspect, rose = due/danger. Radii are
  tightened globally in `@theme` (rounded-xl = 8 px). KPI tiles = `StatCard` (coloured left
  rule); tables use the `.table-erp` look (grey header strip, uppercase 11 px labels). Charts
  use `charts.PALETTE` and no animation. Use tokens, not raw hex, in components.
* Writes from the SPA always go through `lib/api.api()` (X-Op-Id, refresh-retry, duplicate
  protocol). Never call `fetch` directly for a write except multipart uploads.
