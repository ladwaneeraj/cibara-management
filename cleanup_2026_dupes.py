#!/usr/bin/env python3
"""
One-time cleanup: delete migrated=True payment docs for 2026.

These are duplicates created when the migration script ran against data
that the live app had already written to the payments collection.

Safe because:
  • Only deletes docs where migrated=True (created by migration script)
  • Only deletes docs where date starts with "2026"
  • Live-written docs (migrated=False/absent) are untouched
  • 2025 and earlier migrated docs are untouched

Usage:
    python cleanup_2026_dupes.py --dry-run   # preview, no deletes
    python cleanup_2026_dupes.py             # actual delete
"""

import os
import sys
import json
import base64
import logging

import firebase_admin
from firebase_admin import credentials, firestore
from google.cloud.firestore_v1.base_query import FieldFilter

DRY_RUN = "--dry-run" in sys.argv

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("cleanup")

def init_firebase():
    if "FIREBASE_CREDENTIALS" in os.environ:
        cred_json = base64.b64decode(os.environ["FIREBASE_CREDENTIALS"]).decode("utf-8")
        cred = credentials.Certificate(json.loads(cred_json))
    else:
        cred = credentials.Certificate("service-account.json")
    firebase_admin.initialize_app(cred)
    return firestore.client()


def cleanup(db):
    payments_ref = db.collection("payments")

    log.info("Querying migrated=True docs for 2026...")

    # Query: migrated == True AND date >= 2026-01-01 AND date < 2027-01-01
    query = (
        payments_ref
        .where(filter=FieldFilter("migrated", "==", True))
        .where(filter=FieldFilter("date", ">=", "2026-01-01"))
        .where(filter=FieldFilter("date", "<",  "2027-01-01"))
    )

    docs = list(query.stream())
    log.info(f"Found {len(docs)} migrated 2026 docs to delete")

    if not docs:
        log.info("Nothing to delete — already clean.")
        return

    if DRY_RUN:
        log.info("[DRY-RUN] Would delete:")
        for doc in docs[:20]:
            d = doc.to_dict()
            log.info(f"  {doc.id} | room={d.get('room')} name={d.get('name')} "
                     f"amount={d.get('amount')} date={d.get('date')} time={d.get('time')} "
                     f"type={d.get('type')}")
        if len(docs) > 20:
            log.info(f"  ... and {len(docs) - 20} more")
        log.info(f"[DRY-RUN] Total would delete: {len(docs)}")
        return

    # Delete in batches of 400
    BATCH_SIZE = 400
    deleted = 0
    batch = db.batch()
    batch_count = 0

    for doc in docs:
        batch.delete(payments_ref.document(doc.id))
        batch_count += 1
        if batch_count >= BATCH_SIZE:
            batch.commit()
            deleted += batch_count
            log.info(f"  Deleted batch of {batch_count} (total so far: {deleted})")
            batch = db.batch()
            batch_count = 0

    if batch_count > 0:
        batch.commit()
        deleted += batch_count

    log.info(f"=== CLEANUP COMPLETE — deleted {deleted} duplicate migrated docs ===")


if __name__ == "__main__":
    if DRY_RUN:
        log.info("=== DRY RUN — no deletes will be made ===")
    db = init_firebase()
    cleanup(db)
