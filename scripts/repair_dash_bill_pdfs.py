"""
Repair bills whose PDF link 403s because it points to the shared bills/-/ folder.

ROOT CAUSE (fixed in services/pdf_service.py):
    Bills with the placeholder bill_number "-" (no-bill cash stays, pure MMT
    OTA stays, deferred-number checkouts) all uploaded their PDF to the SAME
    Storage path bills/-/v{n}.pdf. Every new upload overwrote the object and
    minted a fresh download token, invalidating every previously saved URL —
    customers got {"error": {"code": 403, "message": "Permission denied."}}.

WHAT THIS SCRIPT DOES:
    1. Finds bills whose pdf_url points into bills/-/ (prefix range query on
       pdf_url — no full-collection scan).
    2. For each (with --apply): clears the dead pdf_url and regenerates the
       PDF server-side via routes.billing.auto_generate_bill_pdf, which now
       uploads to a unique folder (real bill_number, else the bill's doc id).
       The old `versions` entries are kept for audit; the new upload simply
       becomes the next version.

    DRY-RUN BY DEFAULT — prints what it would repair. Pass --apply to write.

USAGE (from repo root, same env as the app; set CIBARA_ENV=PROD for live):
    python -m scripts.repair_dash_bill_pdfs                # dry run, list only
    python -m scripts.repair_dash_bill_pdfs --apply        # repair everything
    python -m scripts.repair_dash_bill_pdfs --apply --bill-id <docId>   # one bill
"""

from __future__ import annotations

import argparse
import sys
import time


def _find_broken(bills_ref, bucket_name: str):
    """Bills whose stored pdf_url points into the shared bills/-/ folder.

    All poisoned URLs share the literal prefix
    https://firebasestorage.googleapis.com/v0/b/{bucket}/o/bills%2F-%2F
    so a lexicographic range query on pdf_url finds them without scanning
    the whole collection.
    """
    prefix = (
        f"https://firebasestorage.googleapis.com/v0/b/"
        f"{bucket_name}/o/bills%2F-%2F"
    )
    return [
        (d.id, d.to_dict() or {})
        for d in (bills_ref
                  .where("pdf_url", ">=", prefix)
                  .where("pdf_url", "<=", prefix + "")
                  .stream())
    ]


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Regenerate bill PDFs whose URL points to the shared bills/-/ folder.")
    ap.add_argument("--apply", action="store_true",
                    help="actually repair (default is a read-only dry run)")
    ap.add_argument("--bill-id", default="",
                    help="repair only this Firestore bill document id")
    ap.add_argument("--sleep", type=float, default=0.5,
                    help="seconds to pause between regenerations (default 0.5)")
    args = ap.parse_args()

    # Importing config initialises Firebase (env chosen via CIBARA_ENV).
    from config import db, bills_ref  # noqa: WPS433
    from firebase_admin import storage as _fb_storage
    from services import pdf_service

    pdf_service.init(db)  # scripts don't run app startup; inject the client
    bucket_name = _fb_storage.bucket().name

    if args.bill_id:
        snap = bills_ref.document(args.bill_id).get()
        if not snap.exists:
            print(f"bill {args.bill_id} not found"); return 1
        targets = [(args.bill_id, snap.to_dict() or {})]
    else:
        targets = _find_broken(bills_ref, bucket_name)

    print(f"bucket={bucket_name}  broken bills found: {len(targets)}")
    for doc_id, b in targets:
        print(f"  id={doc_id}  bill_number={b.get('bill_number')!r} "
              f"guest={b.get('guest_name')!r} checkout={b.get('checkout_time')!r} "
              f"url=...{(b.get('pdf_url') or '')[-40:]}")

    if not args.apply:
        print("\nDRY RUN — nothing written. Re-run with --apply to repair.")
        return 0

    from routes.billing import auto_generate_bill_pdf  # noqa: WPS433

    ok = failed = 0
    for doc_id, b in targets:
        try:
            # Clear the dead URL so auto_generate_bill_pdf's "pdf_url already
            # exists" guard doesn't skip the bill. versions[] is kept as an
            # audit trail; the regeneration becomes the next version.
            bills_ref.document(doc_id).update({
                "pdf_url": "",
                "pdf_status": "repair_dash_folder",
            })
            record = dict(b)
            record["id"] = doc_id
            auto_generate_bill_pdf(doc_id, record)   # logs its own errors

            new_url = (bills_ref.document(doc_id).get().to_dict() or {}).get("pdf_url") or ""
            if new_url and "bills%2F-%2F" not in new_url:
                ok += 1
                print(f"  REPAIRED {doc_id} -> ...{new_url[-50:]}")
            else:
                failed += 1
                print(f"  FAILED   {doc_id} (pdf_url={new_url!r}) — see app logs")
        except Exception as e:  # keep going; report at the end
            failed += 1
            print(f"  ERROR    {doc_id}: {type(e).__name__}: {e}")
        time.sleep(max(args.sleep, 0))

    print(f"\ndone: {ok} repaired, {failed} failed of {len(targets)}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
