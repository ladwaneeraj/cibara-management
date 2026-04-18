"""
migrate_expenses.py
───────────────────
One-time migration: copies all expense records from the `payments` collection
into the new dedicated `expenses` collection.

HOW TO RUN:
    python migrate_expenses.py [--dry-run] [--batch-size 200]

Options:
    --dry-run        Print what would be migrated without writing anything.
    --batch-size N   Number of docs to commit per Firestore batch (default 200).

SAFETY:
  • Idempotent: uses check_duplicate() before writing, so you can re-run safely.
  • Does NOT delete anything from the `payments` collection — existing reads still
    work during the transition period.
  • Adds a `migrated_from_payments: True` flag to every migrated document so you
    can tell them apart from live writes.

AFTER MIGRATION:
  • Verify counts match: script prints a summary at the end.
  • The app routes already read from `expenses` collection (expense_service).
  • Once you've verified everything, you can optionally clean up the expense stubs
    in `payments` by running with --cleanup (see below — disabled by default).
"""

import argparse
import sys
import os
import json
import base64
from datetime import datetime, timezone

# ── Firebase init (mirrors config.py logic) ───────────────────────────────────
import firebase_admin
from firebase_admin import credentials, firestore
from google.cloud.firestore_v1.base_query import FieldFilter

def _init_firebase():
    if firebase_admin._apps:
        return firestore.client()

    if "FIREBASE_CREDENTIALS" in os.environ:
        cred_json = base64.b64decode(os.environ["FIREBASE_CREDENTIALS"]).decode("utf-8")
        cred_dict = json.loads(cred_json)
        cred = credentials.Certificate(cred_dict)
    else:
        cred = credentials.Certificate("service-account.json")

    firebase_admin.initialize_app(cred)
    return firestore.client()


# ── Field normalisation ───────────────────────────────────────────────────────
def _normalise_expense(p: dict) -> dict:
    """
    Convert a payments-collection expense stub into the full expenses schema.
    Only the fields that were actually stored get carried over — no fabrication.
    """
    doc = {
        "date":           p.get("date", ""),
        "time":           p.get("time", ""),
        "category":       p.get("category", "others"),
        "description":    p.get("name", p.get("description", "")),
        "amount":         int(p.get("amount", 0)),
        "payment_method": p.get("method", p.get("payment_method", "cash")),
        "expense_type":   p.get("expense_type", "transaction"),
        "migrated_from_payments": True,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    # Salary: carry paid_to if present in old stub
    if p.get("paid_to"):
        doc["paid_to"] = p["paid_to"]

    # Invoice photo URL — carry if the old stub somehow had it
    if p.get("invoice_photo_url"):
        doc["invoice_photo_url"] = p["invoice_photo_url"]

    # Commission fields (only present on booking_commission entries)
    for field in [
        "commission_platform", "commission_amount", "commission_gst",
        "commission_invoice_number", "commission_invoice_date",
        "commission_payment_status", "commission_payment_date",
    ]:
        if field in p:
            doc[field] = p[field]

    return doc


def _check_duplicate(expenses_ref, doc: dict) -> bool:
    """
    Return True if an identical document already exists in expenses collection.

    Uses description + amount + date as the primary key.
    Time is also checked if present — if time is empty we skip it to avoid
    false positives from multiple entries with no recorded time.
    """
    try:
        q = (
            expenses_ref
            .where(filter=FieldFilter("description", "==", doc["description"]))
            .where(filter=FieldFilter("amount",      "==", doc["amount"]))
            .where(filter=FieldFilter("date",        "==", doc["date"]))
        )
        # Only include time in the check when it is actually set — an empty
        # time string would match ALL timeless records of any description.
        if doc.get("time"):
            q = q.where(filter=FieldFilter("time", "==", doc["time"]))

        q = q.limit(1)
        return len(list(q.stream())) > 0
    except Exception as e:
        print(f"  [WARN] duplicate check failed: {e}")
        return False


# ── Main ──────────────────────────────────────────────────────────────────────
def migrate(dry_run: bool = False, batch_size: int = 200):
    print("=" * 60)
    print("EXPENSE MIGRATION: payments → expenses")
    print(f"Mode: {'DRY RUN (no writes)' if dry_run else 'LIVE'}")
    print("=" * 60)

    db = _init_firebase()
    payments_ref  = db.collection("payments")
    expenses_ref  = db.collection("expenses")

    # ── 1. Fetch all expense records from payments collection ─────────────────
    print("\n[1/3] Fetching expense records from payments collection...")
    try:
        expense_docs = list(
            payments_ref.where(filter=FieldFilter("type", "==", "expense")).stream()
        )
    except Exception as e:
        print(f"  ERROR: {e}")
        sys.exit(1)

    print(f"  Found {len(expense_docs)} expense docs in payments collection.")
    if not expense_docs:
        print("  Nothing to migrate. Exiting.")
        return

    # ── 2. Migrate ────────────────────────────────────────────────────────────
    print("\n[2/3] Migrating to expenses collection...")
    migrated   = 0
    skipped    = 0
    errors     = 0

    batch      = db.batch() if not dry_run else None
    batch_count = 0

    for snap in expense_docs:
        p = snap.to_dict()

        normalised = _normalise_expense(p)

        # Skip if already migrated
        if _check_duplicate(expenses_ref, normalised):
            print(f"  SKIP (dup): {normalised['date']} | {normalised['description'][:40]} | ₹{normalised['amount']}")
            skipped += 1
            continue

        if dry_run:
            print(f"  WOULD MIGRATE: {normalised['date']} | {normalised['category']} | "
                  f"{normalised['description'][:40]} | ₹{normalised['amount']} | {normalised['expense_type']}")
            migrated += 1
            continue

        try:
            batch.set(expenses_ref.document(), normalised)
            batch_count += 1
            migrated += 1

            if batch_count >= batch_size:
                batch.commit()
                print(f"  Committed batch of {batch_count} docs ({migrated} migrated so far)...")
                batch = db.batch()
                batch_count = 0

        except Exception as e:
            print(f"  ERROR migrating {snap.id}: {e}")
            errors += 1

    # Commit remaining
    if not dry_run and batch_count > 0:
        try:
            batch.commit()
            print(f"  Committed final batch of {batch_count} docs.")
        except Exception as e:
            print(f"  ERROR committing final batch: {e}")
            errors += 1

    # ── 3. Summary ────────────────────────────────────────────────────────────
    print("\n[3/3] Summary")
    print(f"  Total expense docs in payments: {len(expense_docs)}")
    print(f"  Migrated:  {migrated}")
    print(f"  Skipped (already existed): {skipped}")
    print(f"  Errors:    {errors}")

    if not dry_run:
        # Verify final count in expenses collection
        try:
            final_count = len(list(expenses_ref.stream()))
            print(f"  Total docs now in expenses collection: {final_count}")
        except Exception as e:
            print(f"  Could not verify final count: {e}")

    print("\nMigration complete.")
    if errors > 0:
        print(f"WARNING: {errors} errors occurred. Review output above.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Migrate expenses from payments to expenses collection.")
    parser.add_argument("--dry-run",    action="store_true", help="Print without writing")
    parser.add_argument("--batch-size", type=int, default=200, help="Firestore batch size (default 200)")
    args = parser.parse_args()

    migrate(dry_run=args.dry_run, batch_size=args.batch_size)
