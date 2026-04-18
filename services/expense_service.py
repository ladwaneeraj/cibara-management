"""
Expense Service — manages the dedicated `expenses` Firestore collection.

Separating expenses from the `payments` collection keeps payment queries
clean and allows richer GST/invoice fields without polluting the payments schema.

Design:
  • Write path: add_expense route writes here (primary) + a minimal stub
    to payments collection (for backward-compat during transition).
  • Read path: all routes read expenses from this collection.
  • Migration: migrate_expenses.py backfills existing payment-collection
    expense docs into this collection.
"""

import logging
import threading
from datetime import datetime, timezone

from firebase_admin import firestore as fa_firestore

logger = logging.getLogger(__name__)

_expenses_ref = None
_db = None


def init(db):
    """Call once at app startup to inject the Firestore client."""
    global _expenses_ref, _db
    _db = db
    _expenses_ref = db.collection("expenses")
    logger.info("ExpenseService initialised (expenses collection)")


# ---------------------------------------------------------------------------
# WRITE
# ---------------------------------------------------------------------------

def write_expense(expense_data: dict, *, sync: bool = False) -> bool:
    """
    Write a single expense document to the `expenses` collection.

    sync=True  → blocking write (use in migration / tests)
    sync=False → async background write (default, never blocks HTTP response)
    """
    if _expenses_ref is None:
        return False

    doc = _normalise(expense_data)

    if sync:
        try:
            _expenses_ref.document().set(doc)
            return True
        except Exception as e:
            logger.error(f"ExpenseService sync-write failed: {e}")
            return False
    else:
        threading.Thread(target=_write_async, args=(doc,), daemon=True).start()
        return True


def _write_async(doc: dict):
    try:
        _expenses_ref.document().set(doc)
    except Exception as e:
        logger.error(f"ExpenseService async-write failed: {e}")


def _normalise(data: dict) -> dict:
    """Ensure consistent types and add created_at."""
    doc = dict(data)
    doc.setdefault("created_at", datetime.now(timezone.utc).isoformat())
    if "amount" in doc:
        try:
            doc["amount"] = int(doc["amount"])
        except (ValueError, TypeError):
            doc["amount"] = 0
    if "taxable_amount" in doc:
        try:
            doc["taxable_amount"] = float(doc["taxable_amount"])
        except (ValueError, TypeError):
            doc["taxable_amount"] = 0.0
    if "gst_amount" in doc:
        try:
            doc["gst_amount"] = float(doc["gst_amount"])
        except (ValueError, TypeError):
            doc["gst_amount"] = 0.0
    if "gst_rate" in doc:
        try:
            doc["gst_rate"] = float(doc["gst_rate"])
        except (ValueError, TypeError):
            doc["gst_rate"] = 0.0
    return doc


# ---------------------------------------------------------------------------
# READ
# ---------------------------------------------------------------------------

def query_expenses_by_date_range(start_date: str, end_date: str) -> list:
    """
    Return expenses within [start_date, end_date) — ISO date strings.
    end_date is exclusive (pass tomorrow's date for a single-day query).
    Each dict includes '_doc_id' so the frontend can reference the document.
    """
    if _expenses_ref is None:
        return []
    try:
        query = (
            _expenses_ref
            .where(filter=fa_firestore.FieldFilter("date", ">=", start_date))
            .where(filter=fa_firestore.FieldFilter("date", "<", end_date))
        )
        results = []
        for doc in query.stream():
            d = doc.to_dict()
            d["_doc_id"] = doc.id
            results.append(d)
        return results
    except Exception as e:
        logger.error(f"ExpenseService query_by_date_range failed: {e}")
        return []


def query_expenses_for_today(today_str: str) -> list:
    """
    Return all expenses for today (convenience wrapper).
    today_str: 'YYYY-MM-DD'
    """
    from datetime import datetime, timedelta
    try:
        tomorrow = (
            datetime.strptime(today_str, "%Y-%m-%d") + timedelta(days=1)
        ).strftime("%Y-%m-%d")
        return query_expenses_by_date_range(today_str, tomorrow)
    except Exception as e:
        logger.error(f"ExpenseService query_for_today failed: {e}")
        return []


def update_photo(doc_id: str, photo_url: str) -> bool:
    """Attach or replace the invoice_photo_url on an existing expense document."""
    if _expenses_ref is None or not doc_id:
        return False
    try:
        _expenses_ref.document(doc_id).update({"invoice_photo_url": photo_url})
        return True
    except Exception as e:
        logger.error(f"ExpenseService update_photo failed for {doc_id}: {e}")
        return False


def check_duplicate(description: str, amount: int, date: str, time_str: str) -> bool:
    """
    Check if an identical expense already exists (migration idempotency).
    """
    if _expenses_ref is None:
        return False
    try:
        query = (
            _expenses_ref
            .where(filter=fa_firestore.FieldFilter("description", "==", description))
            .where(filter=fa_firestore.FieldFilter("amount",      "==", int(amount)))
            .where(filter=fa_firestore.FieldFilter("date",        "==", date))
            .where(filter=fa_firestore.FieldFilter("time",        "==", time_str))
            .limit(1)
        )
        return len(list(query.stream())) > 0
    except Exception as e:
        logger.error(f"ExpenseService check_duplicate failed: {e}")
        return False
