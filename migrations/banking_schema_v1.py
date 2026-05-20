"""
Banking schema v1 backfill.

What this does
--------------
1. Adds the new Banking fields to every existing `bills`, `payments`,
   and `expenses` doc so the new code paths have a consistent shape to
   query against from day one.

2. Reclassifies every historical CASH payment as either `eligible`
   (if its parent bill was invoiceable, i.e. has a bill_number that is
   not "-"/null) or `excluded` (no bill number issued). This mirrors the
   future state the trigger flow produces.

3. Computes `amount_paise` from the legacy rupee `amount` so the new
   integer-paise arithmetic works on existing data.

4. Sets `invoiceable=true / invoiceable_at=finalized_at` on every
   already-finalized bill that has a bill_number.

5. Does NOT generate receipt_no for historical payments. They lived
   under the old regime where receipts weren't issued. We tag them as
   `legacy_pre_banking=true` and leave receipt_no=null — the deposit
   flow still finds them via `deposit_eligibility=eligible`.

Safety
------
* `--dry-run` flag prints what WOULD change without writing.
* Idempotent: re-running is a no-op for docs already migrated. The
  marker `_banking_migrated_at` on each doc is the gate.
* Batched writes (max 400 per batch — under Firestore's 500 limit).
* Logs every error and continues. The full report at the end shows
  successes vs failures.

Run
---
    python -m migrations.banking_schema_v1            # dry run by default
    python -m migrations.banking_schema_v1 --commit   # apply changes
    python -m migrations.banking_schema_v1 --commit --collection bills
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime
from typing import Iterator

logger = logging.getLogger("banking_migration")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)


# ─── Import surface ─────────────────────────────────────────────────────
# Imported here (not at top level of the module) so `python -m
# migrations.banking_schema_v1 --help` works even if Firestore can't
# reach the network from a developer machine.
def _bootstrap():
    from config import db, IST
    from services.banking.schema import (
        BILL_INVOICEABLE, BILL_INVOICEABLE_AT,
        BILL_INVOICEABLE_TRIGGER_PAYMENT, BILL_INVOICEABLE_TRIGGER_TOKEN,
        BILL_FIRST_DEPOSIT_AT,
        PAY_AMOUNT_PAISE, PAY_OFFICIALIZED_AT, PAY_RECEIPT_ID,
        PAY_RECEIPT_NO, PAY_RECEIPT_ISSUED_AT, PAY_DEPOSIT_ELIGIBILITY,
        PAY_CASH_DEPOSIT_ID, PAY_INVOICEABLE, PAY_VOIDED_AT, PAY_METHOD,
        EXP_CASH_DEPOSIT_ID, EXP_AMOUNT_PAISE, EXP_VOIDED_AT,
        PaymentMethod, DepositEligibility,
    )
    from services.banking.money import rupees_to_paise
    return locals()


# ─── Per-doc transformers ───────────────────────────────────────────────

def _bill_payload(b: dict, ctx) -> dict | None:
    """Return the partial update for a single bill doc, or None if no change."""
    if b.get("_banking_migrated_at"):
        return None
    out: dict = {}
    # invoiceable inference: a bill is invoiceable iff it already has a
    # real bill_number (not null, not "-").
    bn = b.get("bill_number")
    is_invoiceable = bool(bn) and bn != "-"
    out[ctx["BILL_INVOICEABLE"]] = is_invoiceable
    out[ctx["BILL_INVOICEABLE_AT"]] = (
        b.get("finalized_at") or b.get("checkout_time")
        if is_invoiceable else None
    )
    out[ctx["BILL_INVOICEABLE_TRIGGER_PAYMENT"]] = None  # unknown for legacy
    out[ctx["BILL_INVOICEABLE_TRIGGER_TOKEN"]] = None
    out[ctx["BILL_FIRST_DEPOSIT_AT"]] = None
    out["_banking_migrated_at"] = ctx["now_iso"]
    return out


def _payment_payload(p: dict, parent_invoiceable: bool | None, ctx) -> dict | None:
    if p.get("_banking_migrated_at"):
        return None
    out: dict = {}
    out[ctx["PAY_AMOUNT_PAISE"]] = ctx["rupees_to_paise"](p.get("amount"))
    out[ctx["PAY_OFFICIALIZED_AT"]] = None
    out[ctx["PAY_RECEIPT_ID"]] = None
    out[ctx["PAY_RECEIPT_NO"]] = None
    out[ctx["PAY_RECEIPT_ISSUED_AT"]] = None
    out[ctx["PAY_CASH_DEPOSIT_ID"]] = None
    out[ctx["PAY_VOIDED_AT"]] = p.get("voided_at")  # preserve if already set
    out["legacy_pre_banking"] = True
    out["_banking_migrated_at"] = ctx["now_iso"]

    method = (p.get(ctx["PAY_METHOD"]) or "").lower()
    if method == ctx["PaymentMethod"].CASH:
        if parent_invoiceable is True:
            out[ctx["PAY_DEPOSIT_ELIGIBILITY"]] = ctx["DepositEligibility"].ELIGIBLE
            out[ctx["PAY_INVOICEABLE"]] = True
        elif parent_invoiceable is False:
            out[ctx["PAY_DEPOSIT_ELIGIBILITY"]] = ctx["DepositEligibility"].EXCLUDED
            out[ctx["PAY_INVOICEABLE"]] = False
        else:
            # Orphan payment with no parent bill — leave pending so
            # ops can audit later. Validators.find_eligibility_mismatches
            # will surface it.
            out[ctx["PAY_DEPOSIT_ELIGIBILITY"]] = ctx["DepositEligibility"].PENDING
            out[ctx["PAY_INVOICEABLE"]] = False
    else:
        # Online / unknown methods don't go into the deposit flow.
        out[ctx["PAY_DEPOSIT_ELIGIBILITY"]] = ctx["DepositEligibility"].EXCLUDED
        out[ctx["PAY_INVOICEABLE"]] = bool(parent_invoiceable)
    return out


def _expense_payload(e: dict, ctx) -> dict | None:
    if e.get("_banking_migrated_at"):
        return None
    out: dict = {}
    out[ctx["EXP_AMOUNT_PAISE"]] = ctx["rupees_to_paise"](e.get("amount"))
    out[ctx["EXP_CASH_DEPOSIT_ID"]] = None
    out[ctx["EXP_VOIDED_AT"]] = e.get("voided_at")
    out["legacy_pre_banking"] = True
    out["_banking_migrated_at"] = ctx["now_iso"]
    return out


# ─── Batching helper ────────────────────────────────────────────────────

def _commit_in_chunks(
    db, updates: list[tuple], dry_run: bool, label: str
) -> int:
    """
    updates: list of (DocumentReference, partial-update-dict). Returns
    the count of successfully-written docs.
    """
    if dry_run:
        logger.info(f"[{label}] dry-run: would write {len(updates)} docs")
        return 0
    written = 0
    while updates:
        chunk, updates = updates[:400], updates[400:]
        try:
            batch = db.batch()
            for ref, payload in chunk:
                batch.update(ref, payload)
            batch.commit()
            written += len(chunk)
            logger.info(f"[{label}] committed batch of {len(chunk)} "
                        f"(running total {written})")
        except Exception as e:
            logger.error(f"[{label}] batch commit failed: {e}", exc_info=True)
            # Skip this chunk, continue with the rest.
    return written


# ─── Per-collection workers ─────────────────────────────────────────────

def _migrate_bills(dry_run: bool, ctx) -> dict:
    db = ctx["db"]
    bills_ref = db.collection("bills")
    pending = []
    invoiceable_index: dict[str, bool] = {}
    seen = 0
    for snap in bills_ref.stream():
        seen += 1
        b = snap.to_dict() or {}
        # Index for the payments pass.
        bn = b.get("bill_number")
        invoiceable_index[snap.id] = bool(bn) and bn != "-"
        payload = _bill_payload(b, ctx)
        if payload is None:
            continue
        pending.append((snap.reference, payload))
    written = _commit_in_chunks(db, pending, dry_run, "bills")
    return {"seen": seen, "to_update": len(pending), "written": written,
            "index": invoiceable_index}


def _migrate_payments(dry_run: bool, ctx, invoiceable_index: dict) -> dict:
    db = ctx["db"]
    ref = db.collection("payments")
    pending = []
    seen = 0
    skipped = 0
    for snap in ref.stream():
        seen += 1
        p = snap.to_dict() or {}
        stay_id = p.get("stay_id") or ""
        parent_inv = invoiceable_index.get(stay_id) if stay_id else None
        payload = _payment_payload(p, parent_inv, ctx)
        if payload is None:
            skipped += 1
            continue
        pending.append((snap.reference, payload))
    written = _commit_in_chunks(db, pending, dry_run, "payments")
    return {"seen": seen, "to_update": len(pending),
            "written": written, "already_migrated": skipped}


def _migrate_expenses(dry_run: bool, ctx) -> dict:
    db = ctx["db"]
    ref = db.collection("expenses")
    pending = []
    seen = 0
    for snap in ref.stream():
        seen += 1
        e = snap.to_dict() or {}
        payload = _expense_payload(e, ctx)
        if payload is None:
            continue
        pending.append((snap.reference, payload))
    written = _commit_in_chunks(db, pending, dry_run, "expenses")
    return {"seen": seen, "to_update": len(pending), "written": written}


# ─── Entry point ────────────────────────────────────────────────────────

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Backfill Banking schema fields on existing collections."
    )
    parser.add_argument(
        "--commit", action="store_true",
        help="Apply changes. Without this flag, runs in dry-run mode.",
    )
    parser.add_argument(
        "--collection", choices=("bills", "payments", "expenses", "all"),
        default="all",
    )
    args = parser.parse_args(argv)
    dry_run = not args.commit

    ctx = _bootstrap()
    ctx["now_iso"] = datetime.now(ctx["IST"]).strftime("%Y-%m-%d %H:%M:%S")

    logger.info(
        f"Banking schema v1 migration — dry_run={dry_run} "
        f"scope={args.collection}"
    )

    # Bills first (their invoiceable status drives payment eligibility).
    invoiceable_index: dict = {}
    if args.collection in ("bills", "all"):
        result = _migrate_bills(dry_run, ctx)
        invoiceable_index = result.pop("index", {})
        logger.info(f"bills:    {result}")
    else:
        # When migrating payments without bills, build the index anyway
        # so eligibility classification is correct.
        for snap in ctx["db"].collection("bills").stream():
            b = snap.to_dict() or {}
            bn = b.get("bill_number")
            invoiceable_index[snap.id] = bool(bn) and bn != "-"

    if args.collection in ("payments", "all"):
        result = _migrate_payments(dry_run, ctx, invoiceable_index)
        logger.info(f"payments: {result}")

    if args.collection in ("expenses", "all"):
        result = _migrate_expenses(dry_run, ctx)
        logger.info(f"expenses: {result}")

    logger.info("Migration complete." + ("" if not dry_run else " (dry run)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
