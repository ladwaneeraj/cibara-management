"""
Archive old audit_logs entries to audit_logs_archive.

Why
───
The `audit_logs` collection is append-only and grows forever. After a year
or two it gets large enough to slow down reads and cost more in Firestore
storage than necessary. This script moves entries older than RETENTION_DAYS
(default 365) into a separate `audit_logs_archive` collection.

The archive collection uses the same schema, so the audit-logs UI can opt-in
to query it via  ?include_archive=1.  Cold storage is the right next step
after this — say, exporting archive entries older than 5 years to Cloud
Storage as JSONL — but that is out of scope here.

Operation
─────────
Idempotent. Re-running on the same day is a no-op (entries already moved).

Batched at 400 ops per commit (Firestore limit is 500; we leave headroom
for retries). Each "move" is a write to archive + delete from source in the
same batch, so a crash mid-run leaves the data in a consistent state.

Scheduling
──────────
Run daily or weekly. Three good options:

  1. cron on a small VM:
        0 3 * * *  /usr/bin/python -m scripts.archive_audit_logs

  2. Cloud Scheduler → Cloud Function (Python runtime):
        Trigger: HTTP, Header X-CloudScheduler. The function imports
        archive_old_logs() and calls it.

  3. Cloud Run Job:
        Build the project as a container, set entrypoint to
        `python -m scripts.archive_audit_logs`. Schedule via Cloud Scheduler.

Usage
─────
    python -m scripts.archive_audit_logs
    python -m scripts.archive_audit_logs --retention-days 365 --dry-run
    python -m scripts.archive_audit_logs --retention-days 30 --max-batches 5
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta

# Side effect: initialises firebase_admin via service-account.json.
import config  # noqa: F401
from config import db, logger, IST  # noqa: E402


SOURCE_COLLECTION = "audit_logs"
ARCHIVE_COLLECTION = "audit_logs_archive"

DEFAULT_RETENTION_DAYS = 365
BATCH_SIZE = 400  # Firestore limit is 500; leave headroom for safety
MAX_BATCHES_DEFAULT = 50  # Cap a single run so it never spins forever


def _cutoff_iso(retention_days: int) -> str:
    """All entries with timestamp < this string are eligible to archive."""
    cutoff_dt = datetime.now(IST) - timedelta(days=retention_days)
    # Use the same format the writer uses: "YYYY-MM-DD HH:MM:SS"
    return cutoff_dt.strftime("%Y-%m-%d %H:%M:%S")


def archive_old_logs(
    retention_days: int = DEFAULT_RETENTION_DAYS,
    dry_run: bool = False,
    max_batches: int = MAX_BATCHES_DEFAULT,
) -> dict:
    """
    Move audit_logs entries older than retention_days to audit_logs_archive.

    Returns a summary dict:
        {
          "cutoff": "<ISO ts>",
          "scanned": <int>,
          "archived": <int>,
          "batches": <int>,
          "dry_run": <bool>,
        }
    """
    cutoff = _cutoff_iso(retention_days)
    logger.info(
        f"archive_audit_logs: cutoff={cutoff} retention={retention_days}d "
        f"dry_run={dry_run}"
    )

    src_ref = db.collection(SOURCE_COLLECTION)
    archived_total = 0
    scanned_total = 0
    batches_run = 0

    # Page through using `timestamp <` so the query stays under Firestore's
    # single-batch limit.  We DON'T order_by so Firestore can pick its own
    # most efficient index (typically the auto-index on timestamp).
    while batches_run < max_batches:
        snap_iter = (
            src_ref
            .where("timestamp", "<", cutoff)
            .limit(BATCH_SIZE)
            .stream()
        )

        batch = db.batch()
        in_batch = 0

        for doc in snap_iter:
            scanned_total += 1
            data = doc.to_dict() or {}
            if not dry_run:
                # Write archive copy first, then delete source. Same-batch
                # write+delete is atomic in Firestore.
                archive_ref = db.collection(ARCHIVE_COLLECTION).document(doc.id)
                # Stamp when the archival happened so we can audit the audit log.
                data["archived_at"] = datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")
                batch.set(archive_ref, data)
                batch.delete(doc.reference)
            in_batch += 1

        if in_batch == 0:
            break  # nothing left to archive

        if not dry_run:
            batch.commit()
        archived_total += in_batch
        batches_run += 1
        logger.info(
            f"archive_audit_logs: batch {batches_run} → "
            f"{in_batch} entries (total {archived_total})"
        )

    summary = {
        "cutoff": cutoff,
        "scanned": scanned_total,
        "archived": archived_total if not dry_run else 0,
        "batches": batches_run,
        "dry_run": dry_run,
    }
    logger.info(f"archive_audit_logs: done {summary}")
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Archive old audit_logs entries to audit_logs_archive."
    )
    parser.add_argument(
        "--retention-days",
        type=int,
        default=DEFAULT_RETENTION_DAYS,
        help=f"Entries older than this many days are archived (default {DEFAULT_RETENTION_DAYS}).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Scan and report counts without moving anything.",
    )
    parser.add_argument(
        "--max-batches",
        type=int,
        default=MAX_BATCHES_DEFAULT,
        help=f"Cap on number of {BATCH_SIZE}-doc batches per run (default {MAX_BATCHES_DEFAULT}).",
    )
    args = parser.parse_args()

    if args.retention_days < 1:
        print("ERROR: --retention-days must be >= 1", file=sys.stderr)
        return 2

    try:
        result = archive_old_logs(
            retention_days=args.retention_days,
            dry_run=args.dry_run,
            max_batches=args.max_batches,
        )
    except Exception as e:
        logger.error(f"archive_audit_logs failed: {e}")
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    print()
    print("─" * 60)
    print("  audit_logs archival summary")
    print("─" * 60)
    print(f"  cutoff      : {result['cutoff']}")
    print(f"  scanned     : {result['scanned']}")
    print(f"  archived    : {result['archived']}")
    print(f"  batches     : {result['batches']}")
    print(f"  dry_run     : {result['dry_run']}")
    print("─" * 60)
    if result["batches"] >= MAX_BATCHES_DEFAULT and not args.dry_run:
        print("  NOTE: hit max-batches cap. Re-run to archive the rest.")
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
