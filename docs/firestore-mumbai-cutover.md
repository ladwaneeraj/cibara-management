# Firestore US → Mumbai cutover (named DB `cibara-mum`)

**Status: SAFE BUILD DONE, CUTOVER NOT RUN. One blocker needs an owner decision (see below).**
Branch `infra/firestore-mumbai-migration` (diffs committed `354343d`). Phase 1 dry run: all 43
collections matched; reads 9.1× faster locally (US 922ms → Mumbai 102ms median).
Built on prod `cibara-software-61512`: `cibara-mum` DB (asia-south1) created, 5 indexes +
rules deployed to it, staging data imported, PITR + daily/weekly backups on. Server + SPA +
guest repoint committed (env-gated, default off). **Blocked:** the classic realtime UI
(`static/google_sync.js`) — the compat SDK can't reach a named DB and can't share its auth with
the modular SDK (proven below). **Held:** the full Storage object copy. US `(default)` DB +
us-central1 bucket never touched.

## Decision
Keep the project `cibara-software-61512` (Auth, users, Storage stay). Move Firestore data to a
**named** DB `cibara-mum` in asia-south1, keep the us-central1 Storage bucket OR move it too
(see §Storage). Browsers read/write Firestore **directly**, so the server AND all three
front-ends must target the named DB.

## Why this is bigger than "2 config lines"
`firebase-firestore-compat@10.13.0` (classic UI) has **no** database-id parameter — verified
from its registration factory `(app, firestoreExp) => new Firestore(...)`. So `firebase.firestore()`
can only ever return the project's **(default)** DB. The classic realtime file must move to the
modular SDK. The modular SDK (SPA, guest) takes `getFirestore(app, databaseId)` and is a one-liner.

## Rollback is env-only for server + SPA + classic; guest needs a rebuild
`CIBARA_FIRESTORE_DB` drives the server, and the SPA and classic UI read `firestoreDb` at
RUNTIME from `/api/v2/config` and `/firebase-config.js` — so for those three, rollback is just
unset the env var + redeploy, no code change. **Exception: the guest portal** bakes
`VITE_FIRESTORE_DB` at BUILD time, so rolling the guest app back is a rebuild + redeploy (unset
the build var and ship a new `guest/dist`), not an instant env flip. The US `(default)` DB and
us-central1 bucket are never written or deleted, so they remain a hot rollback target for weeks.

## Prepared diffs (applied on this branch, flag defaults to OFF)
- `config.py` — Firestore client: if `CIBARA_FIRESTORE_DB` is set, use
  `google.cloud.firestore.Client(project, credentials=cred.get_credential(), database=…)`
  (same client class firebase_admin wraps → transactions/transforms/metrics identical);
  else unchanged `firestore.client()`. firebase_admin still inits for Auth + Storage.
- `app.py` `/firebase-config.js` and `backend/.../main.py` `/api/v2/config` — emit
  `firestoreDb` from `CIBARA_FIRESTORE_DB` so browsers pick it up.
- `frontend/src/lib/realtime.ts` (SPA) — `initializeFirestore(app, settings, dbId)` /
  `getFirestore(app, dbId)` from `cfg.firebase.firestoreDb`.
- `guest/src/api.ts` — `getFirestore(app, import.meta.env.VITE_FIRESTORE_DB || undefined)`
  (Hosting serves the guest config without our field, so the id comes from the guest build env).

## BLOCKED — `static/google_sync.js` (classic realtime) needs an owner decision
~800 lines, 16 Firestore call-sites, the only classic Firestore consumer; already loaded as a
`type="module"`. It must run its listeners under the signed-in staff session so `firestore.rules`
see the role.

**Proven blocker (tested in-browser, no login needed):** on this SDK setup the gstatic **compat**
build and the **modular** build keep **separate app registries**. After `firebase.initializeApp()`
(compat), the modular SDK reports `getApps().length === 0` and `getApp()` throws
`app/no-app`. So the natural port — `getFirestore(getApp(), 'cibara-mum')` to reuse the compat
auth session — **cannot work**: the modular Firestore would have no auth and every listener
would be `permission-denied`. (firestore-compat@10.13.0 also has no database-id param, so compat
itself can't reach a named DB.)

**Options (owner to choose):**
- **A — full modular port of the classic page** (auth + firestore). Replace the three
  `*-compat` scripts with modular `firebase-app/auth/firestore`, port `auth.js`/`CibaraAuth`
  (the entire §3 session system: JWT bridge, custom-token sign-in, idle logout, multi-tab) **and**
  `google_sync.js` to one modular app, then `getFirestore(app, dbId)`. Clean end state, but a
  large, high-risk change to the login path.
- **B — modular Firestore beside compat auth, shared via auth persistence.** In `google_sync.js`
  init a modular `initializeApp(window.FIREBASE_CONFIG)` (default name, its own modular registry)
  + `getAuth(app)`; Firebase Auth persistence is keyed by `apiKey + "[DEFAULT]"` in IndexedDB and
  is shared across the two SDK copies, so the modular auth restores the SAME signed-in user, then
  `getFirestore(app, dbId)` carries its token. Smaller change, but relies on shared-persistence
  timing and **must be smoke-tested with a real login** before trust.
- **C — move Cloud Run to a US region instead** (owner previously rejected): no client change at
  all, but browser→Firestore reads still cross from India (partial fix).

Either A or B still needs the per-listener modular rewrite (`db.collection(x).where(...).onSnapshot`
→ `onSnapshot(query(collection(db,x), where(...)), cb)`, `db.doc(p)` → `doc(db,p)`, `snap.exists`
→ `snap.exists()`, `enablePersistence` → `persistentLocalCache` at init) preserving listener-first,
hidden-tab pause, day-rollover, denied-notices, IST bounds, bookings horizon.

**Smoke test (owner/UAT, needs a real login — not doable from here):** sign in as each role against
`cibara-mum`; confirm each tile updates live from a change on another device; confirm
permission-denied notices for refused collections; confirm reload is cheap (IndexedDB warm).

## HELD pending owner — full Storage object copy
Creating the asia-south1 bucket and copying every object (thousands of private guest ID images +
bill PDFs) is the heaviest and most sensitive step; held so the owner approves it with the
classic-port blocker in view. It is independent of the Firestore DB move and can run once decided.

## Phase 2 build (targets, NOT cutover — run on UAT first)
1. Create Firestore DB `cibara-mum` (asia-south1, native): `gcloud firestore databases create
   --database=cibara-mum --location=asia-south1 --type=firestore-native --project cibara-software-61512`.
2. Deploy **indexes + rules to the named DB** (managed import does NOT create indexes):
   firebase multi-DB config (a `firestore` array entry with `"database":"cibara-mum"`, its own
   `rules`/`indexes`) then `firebase deploy --only firestore:indexes,firestore:rules`, OR
   `gcloud firestore indexes composite create … --database=cibara-mum` for each of the 5 indexes.
3. Storage: create asia-south1 bucket; plan `gcloud storage cp -r` of all objects preserving
   paths + metadata (content-type; id_docs private/no-token; bill PDFs), then verify object
   count + sample checksums. Signed URLs sign with the SA key → work on the new bucket. (Or
   keep the us-central1 bucket — images are app-proxied; decide separately.)
4. Re-enable PITR + daily/weekly backup schedules on `cibara-mum` (§6.1 commands, `--database=cibara-mum`).
5. Complete + smoke-test the `google_sync.js` port against `cibara-mum`.

## Cutover runbook (short low-traffic window — owner-run, after sign-off)
1. **Freeze writes:** maintenance mode on the app; `gcloud scheduler jobs pause` the ingest jobs
   (mmt/agoda/bank); tell staff to stop; guest portal effectively idle. Confirm no writer active.
2. **Final export → copy → import** into `cibara-mum` (export needs a US bucket, import needs an
   asia-south1 bucket — export→US bucket, `gcloud storage cp -r`→asia-south1 bucket, import).
3. **Re-verify** parity incl. subcollections: collection-group count `id_docs` US vs Mumbai and
   spot-check a few full docs field-by-field (timestamps, arrays, maps). No DocumentReference
   fields exist (verified), so no ref-rewrite risk.
4. **`gcloud storage rsync`** any objects written since the bulk copy (if moving the bucket).
5. **Deploy** with `CIBARA_FIRESTORE_DB=cibara-mum` (+ `VITE_FIRESTORE_DB` in the guest build,
   + `FIREBASE_STORAGE_BUCKET` if the bucket moved). Indexes + rules already on `cibara-mum`.
6. **Verify** signed in as each role: dashboards, realtime tiles, guest portal, a test check-in
   /payment/checkout, a bill PDF. Watch `/api/v2/admin/metrics` + X-Firestore-* headers.
7. **Unfreeze:** resume scheduler jobs, lift maintenance mode. **← point of no return** (first
   write lands in Mumbai).

## Rollback
- **Before unfreeze:** unset `CIBARA_FIRESTORE_DB` (+ bucket var) and redeploy — server, SPA and
  classic are back on `(default)` + old bucket immediately (never touched). The guest portal is
  NOT instant: unset `VITE_FIRESTORE_DB` and rebuild + redeploy `guest/dist` to roll it back.
- **After unfreeze:** writes have landed in Mumbai; rolling back now needs a reverse
  export `cibara-mum` → `(default)` for the window's data. Keep the window short and verify
  (step 6) before unfreezing.

## No-data-loss invariants (hold throughout)
US `(default)` DB and us-central1 bucket are NEVER written or deleted. The final export is a
point-in-time snapshot — the write freeze (step 1) guarantees nothing is written to the US
between the final export and the flip. Keep US DB + bucket intact for weeks post-cutover.
