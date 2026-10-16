"""
Move existing guest ID photos onto private, audited storage records.

Two separate steps. Nothing is ever deleted — not a file, not a URL.

  python -m scripts.migrate_id_docs                     # dry run: counts only
  python -m scripts.migrate_id_docs --adopt             # step 1
  python -m scripts.migrate_id_docs --revoke-tokens     # step 2 (after checking)
  python -m scripts.migrate_id_docs --adopt --only 9876543210

Step 1 — adopt
  For every customer with `id_doc_urls`, creates a record per photo under
  customers/{mobile}/id_docs (side "unknown", captured by "Before audit trail")
  pointing at the SAME Storage object, and sets id_doc_count. The app does
  this lazily the first time a guest's documents are opened; this step just
  does it for everyone at once. Idempotent.

Step 2 — revoke tokens
  Removes the `firebaseStorageDownloadTokens` metadata from every adopted
  object, so the old public links stop working. The files stay in place and
  remain viewable in the app (served by the API with the signed-in session).
  Run it only after you have opened a few old guests' documents in the new
  viewer and they display correctly. The `id_doc_urls` array is left as is
  (as a record of what existed); the app no longer sends it to browsers.

Run against UAT first (CIBARA_ENV=UAT).
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--adopt", action="store_true", help="create secure records for old photos")
    ap.add_argument("--revoke-tokens", action="store_true",
                    help="switch off the old public links (files are kept)")
    ap.add_argument("--only", default="", help="a single 10-digit mobile")
    args = ap.parse_args()

    import config  # noqa: F401  (initialises Firebase from the usual env vars)
    from config import db
    from firebase_admin import storage
    from services import id_docs

    print(f"Environment: {os.environ.get('CIBARA_ENV', '?')}  bucket: {storage.bucket().name}")
    if args.only:
        snaps = [db.collection("customers").document(id_docs.clean_mobile(args.only)).get()]
    else:
        snaps = list(db.collection("customers").stream())

    customers = photos = adopted = revoked = missing = 0
    for snap in snaps:
        if not snap.exists:
            continue
        data = snap.to_dict() or {}
        urls = [u for u in (data.get("id_doc_urls") or []) if isinstance(u, str)]
        paths = [id_docs.storage_path_from_url(u) for u in urls]
        paths = [p for p in paths if p.startswith(id_docs.STORAGE_PREFIX)]
        if not paths:
            continue
        customers += 1
        photos += len(paths)

        if args.adopt:
            adopted += id_docs.adopt_legacy(snap.id, data)

        if args.revoke_tokens:
            for path in paths:
                rec = (db.collection("customers").document(snap.id)
                       .collection(id_docs.SUBCOLLECTION).document(id_docs.legacy_doc_id(path)).get())
                if not rec.exists:
                    print(f"  {snap.id}: {path} not adopted yet — run --adopt first; token kept")
                    continue
                blob = storage.bucket().get_blob(path)
                if blob is None:
                    missing += 1
                    continue
                meta = dict(blob.metadata or {})
                if "firebaseStorageDownloadTokens" in meta:
                    # GCS removes a custom metadata key when it is patched to None.
                    meta["firebaseStorageDownloadTokens"] = None
                    blob.metadata = meta
                    blob.patch()
                    revoked += 1

    print(f"Customers with old photos: {customers}  photos: {photos}")
    if args.adopt:
        print(f"Adopted now: {adopted} (already adopted photos are skipped)")
    if args.revoke_tokens:
        print(f"Public links switched off: {revoked}  files not found: {missing}")
    if not (args.adopt or args.revoke_tokens):
        print("Dry run. Use --adopt, then --revoke-tokens.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
