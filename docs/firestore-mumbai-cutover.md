# Firestore US → Mumbai cutover (named DB `cibara-mum`)

**Status: SAFE BUILD DONE, CUTOVER NOT RUN. One blocker needs an owner decision (see below).**
Branch `infra/firestore-mumbai-migration` (diffs committed `354343d`). Phase 1 dry run: all 43
collections matched; reads 9.1× faster locally (US 922ms → Mumbai 102ms median).
Built on prod `cibara-software-61512`: `cibara-mum` DB (asia-south1) created, 5 indexes +
rules deployed to it, staging data imported, PITR + daily/weekly backups on. Server + SPA +
guest repoint committed (env-gated, default off). Classic realtime (`static/google_sync.js`)
ported to modular option B (owner chose B) — verified short of a staff login; the authenticated
end-to-end test is the one open item. Storage objects being copied to the asia-south1 bucket
`cibara-software-61512-mum` (owner-approved). US `(default)` DB + us-central1 bucket never touched.

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

## DONE — `static/google_sync.js` ported to option B (owner chose B)
The classic realtime file (the only classic Firestore consumer, already a `type="module"`) now
runs Firestore on a **modular** app while auth stays on compat. `auth.js`/`CibaraAuth` are
untouched.

Why B over the obvious port: gstatic's **compat** and **modular** SDKs keep **separate app
registries** — after `firebase.initializeApp()` (compat), the modular `getApps().length === 0`
and `getApp()` throws `app/no-app` (tested in-browser). So `getFirestore(getApp(), …)` can't reuse
the compat app. B instead does a modular `initializeApp(window.FIREBASE_CONFIG)` (same config/name,
its own registry) + `getAuth()`; Firebase-Auth persistence (IndexedDB, keyed by `apiKey + appName`)
is shared across the two SDK copies, so the modular app restores the SAME signed-in user and its
`getFirestore(app, dbId)` carries the token. (firestore-compat@10.13.0 has no database-id param, so
compat itself can't reach a named DB at all.)

What changed in the file: added the modular imports; built `_mApp`/`_mAuth` + a `_modularAuthReady`
promise; `db` is now `initializeFirestore(_mApp, {localCache: persistentLocalCache({tabManager:
persistentMultipleTabManager()})}, _dbId)` (replacing `enablePersistence`); subscriptions gate on
`Promise.all([CibaraAuth.ready(), _modularAuthReady])`; every listener rewritten to the functional
API (`onSnapshot(query(collection(db,x), where(...)), cb, err)`, `onSnapshot(doc(db,a,b), …)`) and
`snap.exists` → `snap.exists()`. Listener-first mode, hidden-tab pause, day-rollover, denied
notices, IST bounds and the bookings horizon are all preserved.

**Verified here (short of a real login):**
- session inheritance — a modular app inherits the compat sign-in (anonymous test:
  `compatUid === modularUid`), and a named-DB Firestore builds on it;
- the ported module passes `node --check`;
- all 10 listener query shapes execute against `cibara-mum` with no missing-index error.

**Still owner/UAT — the authenticated end-to-end smoke test (CANNOT be done from here: it needs a
real staff password, which this session is not permitted to enter):** with `CIBARA_FIRESTORE_DB=
cibara-mum` set, sign in as each role (admin / manager / housekeeping) on a UAT/staging deploy and
confirm — each tile updates live from a change made on another device; the housekeeping role still
gets the permission-denied notice for refused collections; a reload is cheap (IndexedDB cache warm);
and the day-rollover reload still fires. Do this before the production cutover.

> Rollback note: this port switches the classic page from compat to modular Firestore for BOTH the
> named DB and the default DB (flag off). A full rollback of the classic realtime is therefore a
> `git revert` of this commit, not just the env flag (the env flag still fully covers server + SPA).

## Storage object copy (owner-approved, running)
asia-south1 bucket `cibara-software-61512-mum` created; `gcloud storage rsync -r` is copying every
object from `cibara-software-61512.firebasestorage.app` (read-only on the source) preserving paths
+ content-type. At cutover, rsync again to catch anything written since, then deploy with
`FIREBASE_STORAGE_BUCKET=cibara-software-61512-mum`. Signed URLs sign with the SA key → work on the
new bucket unchanged. Verify object count + a few checksums before the flip. The us-central1 source
bucket is never modified, so it stays a rollback target.

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
