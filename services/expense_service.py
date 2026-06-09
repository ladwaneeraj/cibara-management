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

# ---------------------------------------------------------------------------
# Split-payment support
#
# A split-payment expense (part cash from the counter, part UPI from the
# account) is stored as TWO linked single-method documents rather than one
# multi-method document. Each leg is a fully-valid expense in its own right:
#
#   cash leg : payment_method="cash"   expense_type="transaction"  (counter)
#   upi  leg : payment_method="online" expense_type="report"       (account)
#
# This keeps every existing read path — counter totals, reports, GST/ITC,
# the transaction log — working unchanged, because each document still has
# exactly one payment_method and one expense_type. The two legs are joined
# by a shared `split_group_id` so edit/delete can operate on the group.
#
# The helpers below expose the collection at a low level so the route can
# assemble a single atomic Firestore batch spanning both legs and the
# counter increment. The route owns the batch because the counter lives in
# a different collection (totals/current_totals) that this service does not
# manage.
# ---------------------------------------------------------------------------

def new_doc_ref():
    """
    Return a fresh auto-ID DocumentReference in the `expenses` collection
    WITHOUT writing anything. Lets a caller stage a multi-document atomic
    batch (used by split-payment creation). Returns None if uninitialised.
    """
    if _expenses_ref is None:
        return None
    return _expenses_ref.document()


def doc_ref(doc_id: str):
    """Return the DocumentReference for an existing id (for batched ops)."""
    if _expenses_ref is None or not doc_id:
        return None
    return _expenses_ref.document(doc_id)


def normalise(data: dict) -> dict:
    """
    Public wrapper over the internal _normalise() so callers assembling
    their own batch write store documents with the same type coercion and
    created_at stamp the single-doc write path applies.
    """
    return _normalise(data)


def query_split_group(group_id: str) -> list:
    """
    Return every expense document belonging to a split group, each with its
    '_doc_id'. Empty list on any failure or unknown group.
    """
    if _expenses_ref is None or not group_id:
        return []
    try:
        query = _expenses_ref.where(
            filter=fa_firestore.FieldFilter("split_group_id", "==", group_id)
        )
        results = []
        for doc in query.stream():
            d = doc.to_dict()
            d["_doc_id"] = doc.id
            results.append(d)
        return results
    except Exception as e:
        logger.error(f"ExpenseService query_split_group({group_id}) failed: {e}")
        return []



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


def get_expense(doc_id: str) -> dict | None:
    """
    Fetch a single expense document by id. Returns None if the doc
    doesn't exist or the service hasn't been initialised. The returned
    dict includes '_doc_id' so callers can pass it back into update /
    delete without juggling parallel state.
    """
    if _expenses_ref is None or not doc_id:
        return None
    try:
        snap = _expenses_ref.document(doc_id).get()
        if not snap.exists:
            return None
        data = snap.to_dict() or {}
        data["_doc_id"] = snap.id
        return data
    except Exception as e:
        logger.error(f"ExpenseService get_expense({doc_id}) failed: {e}")
        return None


def update_expense(doc_id: str, fields: dict) -> bool:
    """
    Partial update of an expense document. Caller is responsible for
    sanitising / validating the field set before calling — this function
    is intentionally a thin wrapper so the route can run business logic
    (counter adjustment, audit trail) alongside the write.

    Returns True on success, False on any failure.
    """
    if _expenses_ref is None or not doc_id or not isinstance(fields, dict):
        return False
    try:
        # Re-normalise numeric fields so the stored document is consistent
        # regardless of how the client sent them. This mirrors _normalise()
        # used on create.
        clean = dict(fields)
        if "amount" in clean:
            try:
                clean["amount"] = int(clean["amount"])
            except (ValueError, TypeError):
                return False
        for f in ("taxable_amount", "gst_amount", "gst_rate"):
            if f in clean:
                try:
                    clean[f] = float(clean[f])
                except (ValueError, TypeError):
                    clean[f] = 0.0
        clean["updated_at"] = datetime.now(timezone.utc).isoformat()
        _expenses_ref.document(doc_id).update(clean)
        return True
    except Exception as e:
        logger.error(f"ExpenseService update_expense({doc_id}) failed: {e}")
        return False


def delete_expense(doc_id: str) -> bool:
    """Hard-delete an expense document by id."""
    if _expenses_ref is None or not doc_id:
        return False
    try:
        _expenses_ref.document(doc_id).delete()
        return True
    except Exception as e:
        logger.error(f"ExpenseService delete_expense({doc_id}) failed: {e}")
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
