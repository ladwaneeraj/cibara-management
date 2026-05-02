#!/usr/bin/env python3
"""
reset_bill_numbers.py — reset the bill-numbering system to a fresh state.

WHAT THIS SCRIPT DOES (when run with --apply)
---------------------------------------------
1. Dumps the entire `bills` Firestore collection to a timestamped JSON file
   under ./backups/ (skip with --no-backup).
2. Updates every document in `bills` to clear:
       bill_number       → "-"
       pdf_url           → ""
       versions          → []
       invoice_generated → False
   Document IDs and all other fields (room, guest, payments, etc.) are
   preserved — this is a field-level reset, not a doc-level wipe.
3. Deletes every blob under the `bills/` prefix in Firebase Storage.
4. Deletes every doc in `daily_counters` whose ID starts with `bill_`
   (e.g. bill_2026_04). The next checkout that warrants a bill will
   therefore allocate CC/YYYY/MM/00001 fresh.

WHAT THIS SCRIPT DOES NOT TOUCH
-------------------------------
• Daily check-in serial counters (other docs in `daily_counters`).
• The `payments`, `rooms`, `bookings`, `transaction_metadata`, `expenses`,
  `settlements`, `ota_settlements`, `settings`, or `customers` collections.
• Anything in Storage outside the `bills/` prefix.
• Bill documents are NOT deleted — they remain queryable; only the bill-
  number-related fields are cleared.

USAGE
-----
    # Dry-run (default) — prints counts of what would change, no writes:
    python scripts/reset_bill_numbers.py

    # Apply for real (interactive confirmation):
    python scripts/reset_bill_numbers.py --apply

    # Apply non-interactively (e.g. from another script):
    python scripts/reset_bill_numbers.py --apply --yes

    # Apply without writing a backup file:
    python scripts/reset_bill_numbers.py --apply --no-backup

The script reuses the same Firebase credentials the Flask app uses
(env var FIREBASE_CREDENTIALS, or ./service-account.json fallback).
Run it from the project root with the same Python interpreter that has
firebase-admin installed.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import logging
import os
import sys
from pathlib import Path
from typing import Iterable

# ── Bootstrap path so we can import the app's Firebase init ─────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

# Importing config.py is what initialises Firebase Admin and gives us `db`,
# `bucket`, `bills_ref`, `counters_ref`. Side effects: registers services,
# starts a logger. That's fine for a one-off script.
try:
    from config import db, bucket, bills_ref, counters_ref  # noqa: E402
except Exception as _e:
    print(f"FATAL: could not import config: {_e}", file=sys.stderr)
    print("Make sure firebase-admin is installed and credentials are set.",
          file=sys.stderr)
    raise


# ── Logging ──────────────────────────────────────────────────────────────────
def _setup_logger(timestamp: str) -> logging.Logger:
    """Attach a file handler under ./logs/. Caller logs to stdout via print()
    and to the file via the returned logger."""
    log_dir = PROJECT_ROOT / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / f"reset_bill_numbers_{timestamp}.log"

    logger = logging.getLogger("reset_bill_numbers")
    logger.setLevel(logging.INFO)
    # Avoid duplicating handlers if module is re-imported in a long-running
    # interpreter (unlikely for a CLI script, but cheap to guard).
    logger.handlers.clear()

    fh = logging.FileHandler(log_path, encoding="utf-8")
    fh.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    ))
    logger.addHandler(fh)
    logger.propagate = False
    print(f"Log file: {log_path}")
    return logger


# ── Counting (used by dry-run AND as the pre-apply summary) ─────────────────
def _count_state() -> dict:
    """Return counts of everything the script would touch.

    Reads but does not modify anything. Slightly slow on a big bills
    collection because we stream every doc — that's the point: report
    accurate totals.
    """
    bills_total = 0
    bills_with_number = 0
    bills_with_pdf = 0
    bills_with_versions = 0

    for snap in bills_ref.stream():
        d = snap.to_dict() or {}
        bills_total += 1
        bn = d.get("bill_number")
        if bn and bn != "-":
            bills_with_number += 1
        if d.get("pdf_url"):
            bills_with_pdf += 1
        if d.get("versions"):
            bills_with_versions += 1

    bill_counter_docs = 0
    for snap in counters_ref.stream():
        if str(snap.id).startswith("bill_"):
            bill_counter_docs += 1

    # PDF blobs under bills/ prefix.
    pdf_blob_count = 0
    try:
        for _ in bucket.list_blobs(prefix="bills/"):
            pdf_blob_count += 1
    except Exception as e:
        # Don't fail the whole dry-run if Storage listing has an issue —
        # report it inline and continue.
        print(f"WARNING: could not list Storage blobs: {e}")

    return {
        "bills_total":          bills_total,
        "bills_with_number":    bills_with_number,
        "bills_with_pdf":       bills_with_pdf,
        "bills_with_versions":  bills_with_versions,
        "bill_counter_docs":    bill_counter_docs,
        "pdf_blob_count":       pdf_blob_count,
    }


def _print_summary(counts: dict, *, header: str) -> None:
    print()
    print(f"── {header} ──")
    print(f"  Bills total                      : {counts['bills_total']:>6}")
    print(f"  Bills with bill_number set       : {counts['bills_with_number']:>6}")
    print(f"  Bills with pdf_url set           : {counts['bills_with_pdf']:>6}")
    print(f"  Bills with versions array        : {counts['bills_with_versions']:>6}")
    print(f"  bill_* counter docs              : {counts['bill_counter_docs']:>6}")
    print(f"  PDF blobs under storage 'bills/' : {counts['pdf_blob_count']:>6}")
    print()


# ── Backup ──────────────────────────────────────────────────────────────────
def _backup_bills(timestamp: str, logger: logging.Logger) -> Path:
    """Dump every bill doc (id + data) to a JSON file. Returns the path.

    Uses Firestore's default JSON-incompatible types (DatetimeWithNanoseconds,
    GeoPoint, Reference) coerced via a custom serialiser. We never round-trip
    these back into Firestore — the file is for human inspection / forensic
    recovery only.
    """
    backup_dir = PROJECT_ROOT / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    out_path = backup_dir / f"bills_{timestamp}.json"

    def _default(o):
        # Best-effort serialiser. Datetime → ISO string. Anything else → repr.
        if hasattr(o, "isoformat"):
            try:
                return o.isoformat()
            except Exception:
                pass
        return repr(o)

    count = 0
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("[\n")
        first = True
        for snap in bills_ref.stream():
            entry = {"id": snap.id, "data": snap.to_dict() or {}}
            if not first:
                f.write(",\n")
            json.dump(entry, f, ensure_ascii=False, default=_default)
            first = False
            count += 1
        f.write("\n]\n")

    logger.info(f"Backup written: {out_path} ({count} bills)")
    print(f"Backup: {out_path} ({count} bills)")
    return out_path


# ── Bills update (Firestore batch, 500-op limit per batch) ──────────────────
_BATCH_LIMIT = 450  # leave headroom under Firestore's 500-op cap


def _chunked(seq: Iterable, n: int):
    chunk = []
    for item in seq:
        chunk.append(item)
        if len(chunk) >= n:
            yield chunk
            chunk = []
    if chunk:
        yield chunk


def _reset_bill_docs(logger: logging.Logger) -> int:
    """Set bill_number='-', pdf_url='', versions=[], invoice_generated=False
    on every doc in `bills`. Returns the number of docs updated.

    Uses Firestore batched writes for throughput. We DO NOT delete any docs.
    """
    updates = {
        "bill_number":       "-",
        "pdf_url":           "",
        "versions":          [],
        "invoice_generated": False,
    }

    total = 0
    failed = 0

    # Stream IDs first so we can chunk into batches without holding the
    # whole snapshot list in memory.
    all_ids = [snap.id for snap in bills_ref.stream()]
    logger.info(f"Resetting fields on {len(all_ids)} bill docs")

    for chunk in _chunked(all_ids, _BATCH_LIMIT):
        batch = db.batch()
        for doc_id in chunk:
            batch.update(bills_ref.document(doc_id), updates)
        try:
            batch.commit()
            total += len(chunk)
            print(f"  reset {total}/{len(all_ids)} bills")
        except Exception as e:
            # If a whole batch fails (e.g. a doc was deleted concurrently),
            # fall back to per-doc updates so the rest of the chunk can
            # still succeed.
            logger.warning(f"Batch commit failed ({e}); retrying per-doc")
            for doc_id in chunk:
                try:
                    bills_ref.document(doc_id).update(updates)
                    total += 1
                except Exception as e2:
                    failed += 1
                    logger.error(f"  could not reset bill {doc_id}: {e2}")

    if failed:
        print(f"WARNING: {failed} bill docs could not be reset (see log).")
    logger.info(f"Bill docs reset: {total} ok, {failed} failed")
    return total


# ── Storage cleanup ─────────────────────────────────────────────────────────
def _delete_all_bill_pdfs(logger: logging.Logger) -> int:
    """Delete every blob under the 'bills/' prefix. Returns count deleted."""
    deleted = 0
    failed = 0
    try:
        blobs = list(bucket.list_blobs(prefix="bills/"))
    except Exception as e:
        logger.error(f"Could not list bills/ blobs: {e}")
        print(f"ERROR: could not list bills/ blobs: {e}")
        return 0

    logger.info(f"Deleting {len(blobs)} blobs under bills/")
    for blob in blobs:
        try:
            blob.delete()
            deleted += 1
            if deleted % 50 == 0:
                print(f"  deleted {deleted}/{len(blobs)} PDFs")
        except Exception as e:
            failed += 1
            logger.error(f"  could not delete {blob.name}: {e}")

    if failed:
        print(f"WARNING: {failed} PDF blobs could not be deleted (see log).")
    print(f"  deleted {deleted}/{len(blobs)} PDFs (final)")
    logger.info(f"PDF blobs deleted: {deleted} ok, {failed} failed")
    return deleted


# ── Counter cleanup ─────────────────────────────────────────────────────────
def _reset_bill_counters(logger: logging.Logger) -> int:
    """Delete every doc in daily_counters whose ID starts with 'bill_'.

    Note: we delete rather than zero out. If the doc doesn't exist on the
    next call, generate_sequential_bill_number() correctly initialises it
    to 1 (see config.py: `(snap.get("count") + 1) if snap.exists else 1`).
    """
    deleted = 0
    failed = 0
    for snap in counters_ref.stream():
        if not str(snap.id).startswith("bill_"):
            continue
        try:
            counters_ref.document(snap.id).delete()
            deleted += 1
            logger.info(f"  deleted counter: {snap.id}")
        except Exception as e:
            failed += 1
            logger.error(f"  could not delete counter {snap.id}: {e}")

    if failed:
        print(f"WARNING: {failed} bill counters could not be deleted (see log).")
    logger.info(f"Bill counters deleted: {deleted} ok, {failed} failed")
    return deleted


# ── Main ────────────────────────────────────────────────────────────────────
def main() -> int:
    parser = argparse.ArgumentParser(
        description="Reset bill numbers, delete bill PDFs, reset bill counters.",
    )
    parser.add_argument(
        "--apply", action="store_true",
        help="Actually perform changes. Without this flag, the script "
             "runs in dry-run mode and only prints counts.",
    )
    parser.add_argument(
        "--yes", action="store_true",
        help="Skip the interactive 'type YES to continue' prompt. "
             "Useful for non-interactive runs. Implies --apply.",
    )
    parser.add_argument(
        "--no-backup", action="store_true",
        help="Skip the JSON backup of the bills collection. "
             "Only valid with --apply.",
    )
    args = parser.parse_args()

    if args.yes and not args.apply:
        # --yes implies --apply (otherwise it's meaningless).
        args.apply = True

    timestamp = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    logger = _setup_logger(timestamp)

    # Always count first — useful as both the dry-run output and the
    # pre-apply preview.
    print("Counting current state (this reads every bill doc — may take a moment)…")
    counts = _count_state()
    _print_summary(counts, header=("DRY RUN — nothing will change"
                                    if not args.apply else
                                    "PRE-APPLY PREVIEW"))
    logger.info(f"Counts: {counts}")

    if not args.apply:
        print("Dry run complete. Re-run with --apply to make changes.")
        return 0

    # Confirmation guard.
    if not args.yes:
        print("This is irreversible. The script will:")
        print("  • Back up bills to ./backups/ (unless --no-backup)")
        print("  • Reset bill_number / pdf_url / versions / invoice_generated on every bill")
        print("  • Delete every PDF under bills/ in Firebase Storage")
        print("  • Delete every bill_* counter so numbering restarts at 1")
        print()
        print("IMPORTANT: do not run this while checkouts are in progress.")
        print("A concurrent /checkout could re-create a counter that the")
        print("counter-delete step then wipes, producing inconsistent numbers.")
        print()
        try:
            confirm = input("Type YES (uppercase) to proceed: ").strip()
        except (EOFError, KeyboardInterrupt):
            confirm = ""
        if confirm != "YES":
            print("Aborted. No changes made.")
            return 1

    # Backup (unless skipped).
    if not args.no_backup:
        try:
            _backup_bills(timestamp, logger)
        except Exception as e:
            logger.error(f"Backup failed: {e}")
            print(f"FATAL: backup failed ({e}). Aborting before any writes.")
            return 2
    else:
        print("Skipping backup (--no-backup).")
        logger.warning("Backup skipped at user request")

    # 1. Reset bill docs.
    print()
    print("Step 1/3 — resetting bill_number / pdf_url / versions / invoice_generated …")
    reset_count = _reset_bill_docs(logger)

    # 2. Delete PDFs.
    print()
    print("Step 2/3 — deleting PDFs from Firebase Storage …")
    pdf_count = _delete_all_bill_pdfs(logger)

    # 3. Delete counters.
    print()
    print("Step 3/3 — deleting bill_* counters …")
    counter_count = _reset_bill_counters(logger)

    # Done.
    print()
    print("── Done ──")
    print(f"  Bill docs reset           : {reset_count}")
    print(f"  PDFs deleted from Storage : {pdf_count}")
    print(f"  Counters deleted          : {counter_count}")
    print()
    print("Next checkout that warrants a bill will be CC/YYYY/MM/00001.")
    logger.info("Reset complete: "
                f"bills={reset_count} pdfs={pdf_count} counters={counter_count}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
