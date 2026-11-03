# Firestore US → Mumbai cutover (named DB `cibara-mum`)

**Status: PREPARED, NOT EXECUTED. Owner sign-off required before Phase 2 build and cutover.**
Branch `infra/firestore-mumbai-migration`. Phase 1 dry run verified: all 43 collections
matched exactly; reads 9.1× faster from a local laptop (US 922ms → Mumbai 102ms median).

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

## Rollback is env-only (no code edit)
A single env var `CIBARA_FIRESTORE_DB` drives everything. Empty / `(default)` = the exact
pre-migration code path. Rollback = unset it (+ unset `VITE_FIRESTORE_DB` for the guest build),
redeploy. The US `(default)` DB and us-central1 bucket are never written or deleted, so they
remain a hot rollback target for weeks.

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

## OUTSTANDING — `static/google_sync.js` modular port (THE risky item, NOT done)
726 lines, 16 Firestore call-sites, the only classic Firestore consumer. It shares the
compat app that `auth.js`/`CibaraAuth` signs in so listeners run under `firestore.rules` with
the user's role. Required change, to be done and smoke-tested against a real `cibara-mum`:
1. Load the modular Firestore SDK on the classic page and obtain the named DB bound to the
   **same** app the compat auth signed in: modular `getApp()` returns the default app compat
   initialised (shared registry), so `getFirestore(getApp(), window.FIREBASE_CONFIG.firestoreDb)`
   shares the auth/custom-token session → rules still pass. (Keep auth on compat; only Firestore
   moves to modular.)
2. Rewrite each listener to the functional modular API: `db.collection(x).where(...).onSnapshot(cb)`
   → `onSnapshot(query(collection(db,x), where(...)), cb)`; `db.doc(p).onSnapshot` →
   `onSnapshot(doc(db,p), cb)`; `db.enablePersistence({synchronizeTabs:true})` →
   `initializeFirestore(app,{localCache:persistentLocalCache({tabManager:persistentMultipleTabManager()})},dbId)`.
3. Preserve every behaviour: listener-first mode, hidden-tab pause/detach, day-rollover reload,
   `onListenerError` permission-denied notices, IST date bounds, bookings horizon.
**Verification (needs `cibara-mum` to exist — Phase 2):** on a UAT/named-DB run, sign in as each
role and confirm each tile updates live from a change made on another device; confirm
permission-denied notices still fire for refused collections; confirm reload is cheap (IndexedDB
cache warm). This cannot be exercised on the in-memory demo or until the named DB exists.
> This port is the dominant cost/risk of the named-DB route. If the owner would rather avoid it,
> moving Cloud Run to a US region removes the server round-trip but leaves browser→Firestore
> reads crossing from India — a partial fix only.

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
- **Before unfreeze:** unset `CIBARA_FIRESTORE_DB` (+ `VITE_FIRESTORE_DB`, + bucket var),
  redeploy. App is back on `(default)` + old bucket, which were never touched.
- **After unfreeze:** writes have landed in Mumbai; rolling back now needs a reverse
  export `cibara-mum` → `(default)` for the window's data. Keep the window short and verify
  (step 6) before unfreezing.

## No-data-loss invariants (hold throughout)
US `(default)` DB and us-central1 bucket are NEVER written or deleted. The final export is a
point-in-time snapshot — the write freeze (step 1) guarantees nothing is written to the US
between the final export and the flip. Keep US DB + bucket intact for weeks post-cutover.
