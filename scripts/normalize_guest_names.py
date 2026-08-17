"""
One-time backfill: standardize guest-name casing across the register.

What it touches
───────────────
  * customers  — the `name` field (doc key is the mobile, never touched)
  * bills      — the `guest_name` field, NON-DRAFT bills only

What it deliberately does NOT touch, and why
────────────────────────────────────────────
  * DRAFT bills and occupied-room docs (active stays). Legacy read paths
    still match payments to a stay by (room, guest name, check-in);
    renaming a guest mid-stay could unhook their payments. Active stays
    are left alone — walk-in check-in now standardizes names at the
    source, so stays that begin after this deploy are already clean.
  * payments, bookings, settlements, staff. Payments and bookings carry
    names as denormalized copies used by those same legacy joins (e.g.
    old booking advances are matched by name when the booking_id relink
    ever failed); settlements join bills by settlement_id, never name.
    Renaming any of them buys nothing and risks those joins.

Billing impact of what IS touched: none. guest_name on a completed bill
is display-only — GSTR-1 carries no B2C guest names, and B2B invoices
use the company legal name from the GST profile. Stored invoice PDFs
keep their old casing until regenerated; new renders use the new one.

Safety rails
────────────
  * DRY RUN by default; --apply is required to write anything.
  * --apply prints the TARGET FIREBASE PROJECT and requires you to type
    "yes" (skip the prompt in automation with --yes).
  * Two-phase apply: ALL changes are collected and written to a rollback
    CSV first; only then are the writes committed in batches. If the
    apply dies midway, the CSV still holds every old value.
  * --restore <csv> writes the old values back, same confirmation gate.
  * Idempotent: re-running skips records that are already standard.

The normalization function is imported from services.customer_service —
the SAME function walk-in check-in applies — so history and new records
can never disagree on the standard.

USAGE (from repo root, same env as the app):
    python -m scripts.normalize_guest_names                    # DRY RUN, dev
    python -m scripts.normalize_guest_names --apply            # write, dev
    CIBARA_ENV=PROD python -m scripts.normalize_guest_names            # dry run, live
    CIBARA_ENV=PROD python -m scripts.normalize_guest_names --apply    # write, live
    python -m scripts.normalize_guest_names --restore name_backup_20260817_153000.csv
"""

from __future__ import annotations

import argparse
import csv
import sys
from datetime import datetime

BATCH_LIMIT = 400          # Firestore hard cap is 500 writes per batch

# Which field is renamed in each collection this script may touch.
FIELD_BY_COLLECTION = {"customers": "name", "bills": "guest_name"}


# ─────────────────────────────────────────────────────────────────────────────
# Pure helpers (no Firebase — unit-testable)
# ─────────────────────────────────────────────────────────────────────────────

def write_backup(path, rows):
    """rows: [(collection, doc_id, field, old, new)] → CSV on disk."""
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["collection", "doc_id", "field", "old", "new"])
        w.writerows(rows)


def read_backup(path):
    """CSV → [(collection, doc_id, field, old, new)], validated."""
    out = []
    with open(path, newline="", encoding="utf-8") as fh:
        r = csv.reader(fh)
        header = next(r, None)
        if header != ["collection", "doc_id", "field", "old", "new"]:
            raise ValueError(f"{path} is not a backup written by this script "
                             f"(unexpected header: {header})")
        for i, row in enumerate(r, start=2):
            if len(row) != 5:
                raise ValueError(f"{path}:{i}: expected 5 columns, got {len(row)}")
            coll, doc_id, field, old, new = row
            if FIELD_BY_COLLECTION.get(coll) != field:
                raise ValueError(f"{path}:{i}: refusing unexpected target "
                                 f"{coll}.{field}")
            out.append((coll, doc_id, field, old, new))
    return out


def confirm_or_abort(action, project, assume_yes):
    print(f"\n  About to {action} on Firebase project: {project!r}")
    if assume_yes:
        print("  --yes given; proceeding.")
        return
    answer = input("  Type 'yes' to proceed: ").strip().lower()
    if answer != "yes":
        print("  Aborted. Nothing was written.")
        sys.exit(1)


# ─────────────────────────────────────────────────────────────────────────────
# Collection scans (read-only)
# ─────────────────────────────────────────────────────────────────────────────

def collect_changes(db, bills_ref, standardize_name, which):
    """Scan and return ([(collection, doc_id, field, old, new)], stats)."""
    changes, stats = [], {}

    if which in ("customers", "both"):
        scanned = blank = 0
        for doc in db.collection("customers").stream():
            scanned += 1
            if scanned % 1000 == 0:
                print(f"    …customers scanned: {scanned}")
            old = (doc.to_dict() or {}).get("name")
            if not old or not str(old).strip():
                blank += 1
                continue
            new = standardize_name(old)
            if new != old:
                changes.append(("customers", doc.id, "name", old, new))
        stats["customers"] = {"scanned": scanned, "blank": blank}

    if which in ("bills", "both"):
        scanned = drafts = blank = 0
        for doc in bills_ref.stream():
            scanned += 1
            if scanned % 1000 == 0:
                print(f"    …bills scanned: {scanned}")
            data = doc.to_dict() or {}
            if data.get("status") == "draft":
                drafts += 1            # active stay — left alone on purpose
                continue
            old = data.get("guest_name")
            if not old or not str(old).strip():
                blank += 1
                continue
            new = standardize_name(old)
            if new != old:
                changes.append(("bills", doc.id, "guest_name", old, new))
        stats["bills"] = {"scanned": scanned, "drafts_skipped": drafts,
                          "blank": blank}

    return changes, stats


def apply_writes(db, rows, value_index):
    """Write rows[value_index] (3=old for restore, 4=new for apply) in
    batches. Returns the number of docs written."""
    written = 0
    batch, pending = db.batch(), 0
    for coll, doc_id, field, *vals in rows:
        batch.update(db.collection(coll).document(doc_id),
                     {field: vals[value_index - 3]})
        pending += 1
        written += 1
        if pending >= BATCH_LIMIT:
            batch.commit()
            print(f"    …committed {written}")
            batch, pending = db.batch(), 0
    if pending:
        batch.commit()
    return written


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(
        description="Standardize guest-name casing in customers and "
                    "completed bills. Dry run unless --apply is given.")
    ap.add_argument("--apply", action="store_true",
                    help="Write the standardized names (after confirmation).")
    ap.add_argument("--restore", metavar="CSV", default="",
                    help="Roll back using a backup CSV this script wrote.")
    ap.add_argument("--collection", choices=("customers", "bills", "both"),
                    default="both", help="Which collection(s) to process.")
    ap.add_argument("--sample", type=int, default=25,
                    help="How many example changes to print (default 25).")
    ap.add_argument("--yes", action="store_true",
                    help="Skip the interactive confirmation (automation).")
    args = ap.parse_args()

    # Importing config initialises Firebase (project chosen via CIBARA_ENV).
    from config import db, bills_ref, logger  # noqa: WPS433
    from services.customer_service import standardize_name  # noqa: WPS433

    project = getattr(db, "project", "unknown")

    # ── Restore mode ────────────────────────────────────────────────────────
    if args.restore:
        rows = read_backup(args.restore)
        print(f"Restore from {args.restore}: {len(rows)} record(s)")
        for coll, doc_id, field, old, new in rows[:args.sample]:
            print(f"    {coll}/{doc_id}: {new!r} -> {old!r}")
        if not rows:
            return 0
        confirm_or_abort(f"RESTORE {len(rows)} old name(s)", project, args.yes)
        written = apply_writes(db, rows, value_index=3)   # write OLD back
        print(f"Restored {written} record(s).")
        logger.info(f"normalize_guest_names: restored {written} from "
                    f"{args.restore}")
        return 0

    # ── Scan ────────────────────────────────────────────────────────────────
    mode = "APPLY" if args.apply else "DRY RUN — nothing will be written"
    print(f"Guest-name standardization — {mode}")
    print(f"Firebase project: {project!r}")
    print("=" * 72)

    changes, stats = collect_changes(db, bills_ref, standardize_name,
                                     args.collection)

    for coll, s in stats.items():
        extra = "".join(f", {k.replace('_', ' ')} {v}" for k, v in s.items()
                        if k != "scanned")
        n = sum(1 for c in changes if c[0] == coll)
        print(f"\n{coll}: scanned {s['scanned']}{extra} — "
              f"{'changing' if args.apply else 'would change'} {n}")
        shown = 0
        for c, doc_id, _f, old, new in changes:
            if c != coll or shown >= args.sample:
                continue
            shown += 1
            print(f"    {doc_id}:  {old!r}  ->  {new!r}")

    print("\n" + "=" * 72)
    if not changes:
        print("Everything is already standard. Nothing to do.")
        return 0
    if not args.apply:
        print(f"{len(changes)} record(s) would change. "
              f"Re-run with --apply to write.")
        return 0

    # ── Apply: backup FIRST, then write ─────────────────────────────────────
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = f"name_backup_{stamp}.csv"
    write_backup(backup_path, changes)
    print(f"Rollback file written: {backup_path} "
          f"(restore with --restore {backup_path})")

    confirm_or_abort(f"WRITE {len(changes)} standardized name(s)",
                     project, args.yes)
    written = apply_writes(db, changes, value_index=4)    # write NEW
    print(f"Done. {written} record(s) updated. Keep {backup_path} until "
          f"you're satisfied.")
    logger.info(f"normalize_guest_names: {written} records updated "
                f"(backup: {backup_path})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
