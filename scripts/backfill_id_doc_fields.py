"""
Backfill ID-doc fields (type / number / DOB) on id_docs records from OCR.

The ID viewer modal reads customers/{mobile}/id_docs/{doc_id}.{id_type,
id_number, dob, birth_year}. Photos captured before OCR-prefill existed have
these blank (they show "—"). This OCRs each ACTIVE id-doc image and fills the
BLANK fields via id_docs.set_ocr_fields (never overwrites a human / earlier
value, writes no history — provenance is the capture entry).

  python -m scripts.backfill_id_doc_fields                 # dry run, all
  python -m scripts.backfill_id_doc_fields --commit        # actually write
  python -m scripts.backfill_id_doc_fields --commit --only 9972785159
  python -m scripts.backfill_id_doc_fields --commit --limit 20
  python -m scripts.backfill_id_doc_fields --count         # count only, no OCR

Safety / behaviour:
  • Idempotent — a record that already has id_type + id_number + a DOB/year is
    skipped, and set_ocr_fields fills blanks only. Safe to re-run / resume.
  • Rate-limited (default 1.2s between OCR calls).
  • Requires GEMINI_API_KEY + Firebase creds (same as the app). Run on UAT first.
  • Dry run by default. --count enumerates WITHOUT any OCR (free).
  • Sends each ID image to Google's Gemini API — cost + privacy. Scope with
    --only / --limit when testing.

Exit code 0 = completed, 2 = aborted (OCR disabled).
"""
from __future__ import annotations
import argparse
import sys
import time


def _targets(db, only: str):
    """(mobile, doc_id, data) for id-doc records, newest query is cheap (metadata)."""
    out = []
    if only:
        clean = "".join(c for c in only if c.isdigit())
        for d in db.collection("customers").document(clean).collection("id_docs").stream():
            out.append((clean, d.id, d.to_dict() or {}))
    else:
        for d in db.collection_group("id_docs").stream():
            parent = d.reference.parent.parent
            if parent:
                out.append((parent.id, d.id, d.to_dict() or {}))
    return out


def _needs_fill(rec: dict) -> bool:
    if rec.get("status") not in (None, "active"):
        return False
    has_all = rec.get("id_type") and rec.get("id_number") and (rec.get("dob") or rec.get("birth_year"))
    return not has_all


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--commit", action="store_true", help="Actually write (default: dry run).")
    ap.add_argument("--count", action="store_true", help="Only count records needing fill; no OCR.")
    ap.add_argument("--limit", type=int, default=0, help="Process at most N records (0 = all).")
    ap.add_argument("--only", type=str, default="", help="One mobile number only.")
    ap.add_argument("--sleep", type=float, default=1.2, help="Seconds between OCR calls.")
    args = ap.parse_args()

    from config import db  # noqa: F401  (side-effect: init Firebase)
    from services import ocr_service, id_docs
    from firebase_admin import storage

    print("Loading id-doc records…")
    targets = _targets(db, args.only)
    need = [(m, i, r) for (m, i, r) in targets if _needs_fill(r)]
    # Newest uploads first: the most recent check-ins matter most, and a run that
    # stops early has filled the records staff are most likely to open.
    need.sort(key=lambda t: t[2].get("captured_at") or "", reverse=True)
    print(f"Records: {len(targets)} total · {len(need)} active and missing fields.")

    if args.count:
        return 0

    if not ocr_service.id_ocr_enabled():
        print("ABORT: ID-OCR disabled. Set GEMINI_API_KEY. Nothing changed.")
        return 2

    mode = "COMMIT" if args.commit else "DRY-RUN"
    print(f"mode={mode}, sleep={args.sleep}s")
    print("=" * 72)

    bucket = storage.bucket()
    stats = {"ocr": 0, "ok": 0, "empty": 0, "written": 0, "errors": 0, "nopath": 0}
    billing_streak = 0

    for mobile, doc_id, rec in need:
        if args.limit and stats["ocr"] >= args.limit:
            break
        path = rec.get("path")
        if not path:
            stats["nopath"] += 1
            continue
        try:
            img = bucket.blob(path).download_as_bytes()
        except Exception as e:
            stats["errors"] += 1
            print(f"  [{mobile}/{doc_id}] download failed: {e}")
            continue

        stats["ocr"] += 1
        res = ocr_service.extract_id_fields(img, "image/jpeg")
        time.sleep(args.sleep)

        if not res.get("success"):
            stats["errors"] += 1
            msg = str(res.get("message", res.get("reason")))
            print(f"  [{mobile}/{doc_id}] OCR error: {msg}")
            if any(k in msg.lower() for k in
                   ("billing", "quota", "resource_exhausted", "rate limit", "credits are depleted")):
                billing_streak += 1
                if billing_streak >= 3:
                    print("\n*** Stopping: Gemini billing/quota wall. Add credits / switch "
                          "tier, then re-run — filled records are skipped. ***")
                    break
            continue
        billing_streak = 0

        fields = res.get("fields") or {}
        if not (fields.get("doc_kind") or fields.get("id_number")
                or fields.get("dob") or fields.get("birth_year")):
            stats["empty"] += 1
            print(f"  [{mobile}/{doc_id}] nothing extractable")
            continue

        stats["ok"] += 1
        # Never print the ID number itself (PII) — just whether one was found.
        print(f"  [{mobile}/{doc_id}] kind={fields.get('doc_kind')} "
              f"number={'yes' if fields.get('id_number') else 'no'} "
              f"dob={fields.get('dob')} year={fields.get('birth_year')}")

        if args.commit:
            id_docs.set_ocr_fields(mobile, doc_id, fields)
            stats["written"] += 1

    print("=" * 72)
    print(f"OCR'd      : {stats['ocr']}")
    print(f"With data  : {stats['ok']}")
    print(f"Empty      : {stats['empty']}")
    print(f"No path    : {stats['nopath']}")
    print(f"Errors     : {stats['errors']}")
    print(f"Written    : {stats['written']}" + ("" if args.commit else "  (dry run)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
