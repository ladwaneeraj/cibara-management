#!/usr/bin/env python3
"""
One-time migration script: logs → payments collection + customers collection.

Safety guarantees:
  • NEVER modifies or deletes existing data in the `logs` collection.
  • Safe to re-run: idempotent — deterministic doc IDs mean re-running
    overwrites with identical data, no duplicates created.
  • Migrates ALL historical data regardless of date.
  • Runs in batches of 400 (Firestore batch limit = 500) to avoid timeouts.
  • Prints progress to stdout — redirect to a file for a permanent record.

Usage:
    python migrate_payments.py                         # defaults: service-account.json
    FIREBASE_CREDENTIALS=base64... python migrate_payments.py

Requirements:
    pip install firebase-admin
"""

import os
import sys
import json
import base64
import hashlib
import logging
from datetime import datetime, timezone
from collections import defaultdict

import firebase_admin
from firebase_admin import credentials, firestore

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BATCH_SIZE = 400                        # Firestore batch limit safety margin
DRY_RUN = "--dry-run" in sys.argv       # Pass --dry-run to preview without writing

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("migrate")

# ---------------------------------------------------------------------------
# Firebase initialisation
# ---------------------------------------------------------------------------
def init_firebase():
    try:
        if "FIREBASE_CREDENTIALS" in os.environ:
            cred_json = base64.b64decode(
                os.environ["FIREBASE_CREDENTIALS"]
            ).decode("utf-8")
            cred = credentials.Certificate(json.loads(cred_json))
        else:
            cred = credentials.Certificate("service-account.json")

        firebase_admin.initialize_app(cred)
        db = firestore.client()
        log.info("Firebase connected")
        return db
    except Exception as e:
        log.error(f"Firebase init failed: {e}")
        sys.exit(1)


# ---------------------------------------------------------------------------
# Deterministic document ID for idempotent migration (no composite index needed)
# ---------------------------------------------------------------------------
def make_doc_id(room, name, amount, date_str, time_str, log_type):
    """
    Generate a stable, deterministic document ID from the entry's key fields.
    Using a hash lets us call batch.set(doc_ref, data) and Firestore will
    silently overwrite with the same data if re-run — no duplicate check query.
    """
    raw = f"{room}|{name}|{amount}|{date_str}|{time_str}|{log_type}"
    return hashlib.sha256(raw.encode()).hexdigest()[:20]


# ---------------------------------------------------------------------------
# Map old log types to new payment types + methods
# ---------------------------------------------------------------------------
LOG_TYPE_MAP = {
    "cash":              {"method": "cash",    "type": "payment"},
    "online":            {"method": "online",  "type": "payment"},
    "balance":           {"method": "balance", "type": "balance_entry"},
    "add_ons":           {"method": "balance", "type": "addon"},
    "refunds":           {"method": "cash",    "type": "refund"},
    "renewals":          {"method": "balance", "type": "renewal"},
    "booking_payments":  {"method": "cash",    "type": "booking_payment"},
    "discounts":         {"method": "discount","type": "discount"},
    "expenses":          {"method": "cash",    "type": "expense"},
}


def _safe_int(val):
    """Convert to int, defaulting to 0 on any failure."""
    try:
        return int(val)
    except (ValueError, TypeError):
        return 0


def entry_to_payment(entry: dict, log_type: str) -> dict:
    """Convert a single old-format log entry to a payments document."""
    defaults = LOG_TYPE_MAP.get(log_type, {"method": "unknown", "type": "unknown"})

    # Determine method more precisely from entry data
    method = defaults["method"]
    if entry.get("payment_method"):
        method = entry["payment_method"]
    elif entry.get("payment_mode"):
        method = entry["payment_mode"]
    elif log_type == "refunds" and entry.get("payment_mode"):
        method = entry["payment_mode"]

    # Determine type more precisely
    ptype = defaults["type"]
    txn_type = entry.get("transaction_type", "")
    if txn_type == "fresh_checkin":
        ptype = "checkin"
    elif txn_type == "booking_conversion":
        ptype = "booking_conversion"
    elif txn_type == "rent_renewal":
        ptype = "renewal"
    elif txn_type == "service":
        ptype = "addon"
    elif txn_type in ("manual_refund", "checkout_refund"):
        ptype = txn_type
    elif txn_type == "settlement":
        ptype = "settlement"
    elif log_type == "add_ons":
        ptype = "addon"

    doc = {
        "room": str(entry.get("room", "")),
        "name": entry.get("name", entry.get("description", "")),
        "amount": _safe_int(entry.get("amount", entry.get("price", 0))),
        "method": method,
        "type": ptype,
        "date": entry.get("date", ""),
        "time": entry.get("time", ""),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "migrated": True,
        "source_log_type": log_type,
    }

    # Copy over optional fields if present
    for field in ("serial_number", "booking_id", "settlement_id",
                   "transaction_type", "is_fresh_checkin", "is_booking_conversion",
                   "item", "unit_price", "quantity", "note", "reason",
                   "category", "expense_type", "old_room", "room_shifted",
                   "guest_mobile", "mobile"):
        if field in entry and entry[field] is not None:
            doc[field] = entry[field]

    # Build stay_room_key if we have enough info
    # This is a best-effort field for migration data
    if doc["room"] and doc["date"]:
        doc["stay_room_key"] = f"{doc['room']}_{doc['date']}"

    return doc


# ---------------------------------------------------------------------------
# Migrate payments
# ---------------------------------------------------------------------------
def migrate_payments(db):
    payments_ref = db.collection("payments")
    logs_ref = db.collection("logs")

    log_types = list(LOG_TYPE_MAP.keys())
    total_migrated = 0
    total_skipped = 0
    total_errors = 0

    for log_type in log_types:
        log.info(f"--- Processing log type: {log_type} ---")

        try:
            doc = logs_ref.document(log_type).get()
            if not doc.exists:
                log.info(f"  No document for {log_type}, skipping")
                continue

            entries = doc.to_dict().get("entries", [])
            log.info(f"  Found {len(entries)} entries in logs")

            batch = db.batch()
            batch_count = 0
            type_would_write = 0
            type_would_skip  = 0

            for i, entry in enumerate(entries):
                try:
                    payment_doc = entry_to_payment(entry, log_type)

                    # Skip zero-amount entries except for events that are
                    # legitimately ₹0 (fresh checkin with no advance,
                    # booking fully paid before conversion).
                    # room_shift is audit-only — no financial value, skip it.
                    if (payment_doc["amount"] == 0
                            and payment_doc["type"] not in (
                                "checkin", "booking_conversion")):
                        total_skipped += 1
                        type_would_skip += 1
                        continue

                    if DRY_RUN:
                        total_migrated += 1
                        type_would_write += 1
                        continue

                    # Deterministic doc ID — re-running overwrites with same
                    # data (idempotent), no expensive query needed.
                    doc_id = make_doc_id(
                        payment_doc["room"], payment_doc["name"],
                        payment_doc["amount"], payment_doc["date"],
                        payment_doc["time"], log_type,
                    )

                    batch.set(payments_ref.document(doc_id), payment_doc)
                    batch_count += 1

                    if batch_count >= BATCH_SIZE:
                        batch.commit()
                        log.info(f"  Committed batch of {batch_count}")
                        total_migrated += batch_count
                        batch = db.batch()
                        batch_count = 0

                except Exception as e:
                    log.error(f"  Error processing entry {i}: {e}")
                    total_errors += 1

            # Commit remaining
            if batch_count > 0 and not DRY_RUN:
                batch.commit()
                total_migrated += batch_count
                log.info(f"  Committed final batch of {batch_count}")

            if DRY_RUN:
                log.info(f"  [DRY-RUN] would write {type_would_write}, "
                         f"skip {type_would_skip} (of {len(entries)} entries)")

        except Exception as e:
            log.error(f"Error processing {log_type}: {e}")
            total_errors += 1

    log.info(f"=== PAYMENTS MIGRATION COMPLETE ===")
    log.info(f"  Migrated: {total_migrated}")
    log.info(f"  Skipped (dupes/zero): {total_skipped}")
    log.info(f"  Errors: {total_errors}")


# ---------------------------------------------------------------------------
# Migrate customers (March 2026 only, from rooms + logs)
# ---------------------------------------------------------------------------
def migrate_customers(db):
    """
    Build customer records from ALL existing data:
      1. Currently occupied rooms (have guest data with mobile).
      2. Bills collection (has guest_name + guest_mobile).
      3. Bookings collection (has guest_name + guest_mobile).
      4. Log entries with mobile numbers (booking_payments, room_shifts).

    Keyed by mobile number. Upserts (updates if exists, creates if not).
    """
    customers_ref = db.collection("customers")
    rooms_ref = db.collection("rooms")
    bills_ref = db.collection("bills")
    bookings_ref = db.collection("bookings")
    logs_ref = db.collection("logs")

    # Collect all guest data: mobile -> merged info
    guests = {}  # mobile -> dict

    def add_guest(mobile, name="", checkin_date="", amount=0,
                  id_type="", id_number="", address="", photo=""):
        mobile = _clean_mobile(mobile)
        if not mobile:
            return
        if mobile not in guests:
            guests[mobile] = {
                "name": name,
                "mobile": mobile,
                "id_type": id_type,
                "id_number": id_number,
                "address": address,
                "id_doc_urls": [],
                "total_stays": 0,
                "total_spent": 0,
                "first_visit": checkin_date,
                "last_stay_date": checkin_date,
                "dates_seen": set(),
            }
        g = guests[mobile]
        if name:
            g["name"] = name
        if id_type:
            g["id_type"] = id_type
        if id_number:
            g["id_number"] = id_number
        if address:
            g["address"] = address
        if photo and photo not in g["id_doc_urls"]:
            g["id_doc_urls"].append(photo)
        g["total_spent"] += amount
        if checkin_date:
            g["dates_seen"].add(checkin_date)
            if not g["first_visit"] or checkin_date < g["first_visit"]:
                g["first_visit"] = checkin_date
            if not g["last_stay_date"] or checkin_date > g["last_stay_date"]:
                g["last_stay_date"] = checkin_date

    # 1. Rooms (currently occupied)
    log.info("Scanning rooms for guest data...")
    for room_doc in rooms_ref.stream():
        rd = room_doc.to_dict()
        guest = rd.get("guest")
        if guest and guest.get("mobile"):
            checkin_time = rd.get("checkin_time", "")
            checkin_date = checkin_time.split(" ")[0] if checkin_time else ""
            add_guest(
                guest["mobile"], guest.get("name", ""),
                checkin_date, 0,
                photo=guest.get("photo", ""),
            )

    # 2. Bills (completed stays)
    log.info("Scanning bills for guest data...")
    for bill_doc in bills_ref.stream():
        bd = bill_doc.to_dict()
        mobile = bd.get("guest_mobile", "")
        checkin = bd.get("checkin_time", "")
        checkin_date = checkin.split(" ")[0] if checkin else ""
        if mobile:
            total = bd.get("payment_cash", 0) + bd.get("payment_online", 0)
            add_guest(mobile, bd.get("guest_name", ""), checkin_date, total)

    # 3. Bookings
    log.info("Scanning bookings for guest data...")
    for booking_doc in bookings_ref.stream():
        bk = booking_doc.to_dict()
        mobile = bk.get("guest_mobile", "")
        check_in = bk.get("check_in_date", "")
        if mobile:
            add_guest(mobile, bk.get("guest_name", ""), check_in,
                      bk.get("paid_amount", 0))

    # 4. Log entries with mobile info (room_shifts have guest_mobile)
    log.info("Scanning log entries for mobile numbers...")
    for lt in ("room_shifts", "booking_payments"):
        try:
            doc = logs_ref.document(lt).get()
            if doc.exists:
                for entry in doc.to_dict().get("entries", []):
                    mobile = entry.get("guest_mobile", "") or entry.get("mobile", "")
                    date = entry.get("date", "")
                    if mobile:
                        add_guest(mobile, entry.get("name", ""), date)
        except Exception as e:
            log.warning(f"Error scanning {lt}: {e}")

    # Calculate total_stays from unique dates
    for g in guests.values():
        g["total_stays"] = max(1, len(g["dates_seen"]))
        del g["dates_seen"]

    log.info(f"Found {len(guests)} unique customers to migrate")

    # Write to Firestore
    migrated = 0
    skipped = 0

    batch = db.batch()
    batch_count = 0

    for mobile, data in guests.items():
        try:
            # Skip records with no usable name — not worth storing
            if not data.get("name", "").strip():
                log.debug(f"  Skipping customer {mobile}: no name")
                continue

            doc_ref = customers_ref.document(mobile)

            # Check if already exists — merge, don't overwrite
            existing = doc_ref.get()
            if existing.exists:
                # Update totals only
                ex_data = existing.to_dict()
                updates = {
                    "total_stays": max(data["total_stays"],
                                       ex_data.get("total_stays", 0)),
                    "total_spent": max(data["total_spent"],
                                       ex_data.get("total_spent", 0)),
                    "last_stay_date": max(data["last_stay_date"],
                                          ex_data.get("last_stay_date", "")),
                }
                if data["name"] and not ex_data.get("name"):
                    updates["name"] = data["name"]
                if data["id_type"] and not ex_data.get("id_type"):
                    updates["id_type"] = data["id_type"]
                if data["id_number"] and not ex_data.get("id_number"):
                    updates["id_number"] = data["id_number"]

                if not DRY_RUN:
                    batch.update(doc_ref, updates)
                    batch_count += 1
                skipped += 1
            else:
                if not DRY_RUN:
                    batch.set(doc_ref, data)
                    batch_count += 1
                migrated += 1

            if batch_count >= BATCH_SIZE:
                if not DRY_RUN:
                    batch.commit()
                batch = db.batch()
                batch_count = 0

        except Exception as e:
            log.error(f"Error migrating customer {mobile}: {e}")

    if batch_count > 0 and not DRY_RUN:
        batch.commit()

    log.info(f"=== CUSTOMER MIGRATION COMPLETE ===")
    log.info(f"  Created: {migrated}")
    log.info(f"  Updated/skipped: {skipped}")


# ---------------------------------------------------------------------------
# Tally: compare logs entries vs payments documents
# ---------------------------------------------------------------------------
def tally(db):
    """
    Print a side-by-side count of every log type vs the payments collection.

    For each log type:
      • LOGS  — count of entries[] in that document
      • PMTS  — count of payments docs whose source_log_type matches
                (migrated docs) OR whose type/method maps to that log type

    Also prints overall totals and the delta.
    Run with:  python migrate_payments.py --tally
    """
    logs_ref     = db.collection("logs")
    payments_ref = db.collection("payments")

    log_types = list(LOG_TYPE_MAP.keys())

    # --- Count logs entries per type ---
    logs_counts = {}
    logs_total  = 0
    for lt in log_types:
        try:
            doc = logs_ref.document(lt).get()
            if doc.exists:
                n = len(doc.to_dict().get("entries", []))
            else:
                n = 0
        except Exception as e:
            log.warning(f"Could not read logs/{lt}: {e}")
            n = 0
        logs_counts[lt] = n
        logs_total += n

    # --- Count payments docs per source_log_type ---
    pmts_by_source = defaultdict(int)
    pmts_total = 0
    try:
        for doc in payments_ref.stream():
            pmts_total += 1
            src = doc.to_dict().get("source_log_type", "__live__")
            pmts_by_source[src] += 1
    except Exception as e:
        log.error(f"Could not stream payments: {e}")

    # --- Print table ---
    col_w = 20
    print()
    print("=" * 62)
    print(f"  {'LOG TYPE':<{col_w}} {'LOGS entries':>14} {'PMTS docs':>12} {'DELTA':>10}")
    print("=" * 62)
    for lt in log_types:
        lc  = logs_counts[lt]
        pc  = pmts_by_source.get(lt, 0)
        delta = pc - lc
        flag = "  ✓" if delta >= 0 else "  ✗ MISSING"
        print(f"  {lt:<{col_w}} {lc:>14,} {pc:>12,} {delta:>+10,}{flag}")

    # Live (non-migrated) payments written directly by the app
    live = pmts_by_source.get("__live__", 0)
    if live:
        print(f"  {'(live writes)':<{col_w}} {'—':>14} {live:>12,}")

    print("-" * 62)
    migrated_pmts = pmts_total - live
    overall_delta = migrated_pmts - logs_total
    flag = "✓ covered" if overall_delta >= 0 else "✗ SHORTFALL"
    print(f"  {'TOTAL':<{col_w}} {logs_total:>14,} {migrated_pmts:>12,} {overall_delta:>+10,}  {flag}")
    print(f"  {'TOTAL incl live':<{col_w}} {'':>14} {pmts_total:>12,}")
    print("=" * 62)
    print()

    if overall_delta < 0:
        print(f"  ⚠  {abs(overall_delta):,} log entries have no matching payment doc.")
        print("     Run the migration (without --tally) to fill the gap.")
    else:
        print(f"  ✓  All log entries are covered in the payments collection.")
        if live:
            print(f"  +  {live:,} additional live-write docs (from app activity).")
    print()


def _clean_mobile(raw):
    """Normalise mobile number to 10 digits."""
    if not raw:
        return ""
    digits = "".join(c for c in str(raw) if c.isdigit())
    if len(digits) >= 12 and digits.startswith("91"):
        digits = digits[2:]
    if len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if len(digits) == 10:
        return digits
    return digits if digits else ""


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    # --tally: just print counts, no writes
    if "--tally" in sys.argv:
        db = init_firebase()
        tally(db)
        return

    if DRY_RUN:
        log.info("=== DRY RUN MODE — no writes will be made ===")

    db = init_firebase()

    log.info("Starting payments migration...")
    migrate_payments(db)

    log.info("")
    log.info("Starting customers migration...")
    migrate_customers(db)

    log.info("")
    log.info("All migrations complete.")

    # Always print tally after a real run so you can see the result immediately
    if not DRY_RUN:
        log.info("")
        log.info("=== POST-MIGRATION TALLY ===")
        tally(db)


if __name__ == "__main__":
    main()
