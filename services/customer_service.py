"""
Customer Service — manages the `customers` collection.

Each customer is keyed by mobile number (the most stable guest identifier).
Stores: name, mobile, id_type, id_number, address, id_doc_urls,
        total_stays, total_spent, first_visit, last_stay_date.

Used for:
  • Auto-filling the check-in form for returning guests.
  • Customer search by name, mobile, or ID number.
  • Building a guest CRM over time.

Design:
  • Writes are fire-and-forget (daemon thread) — never block the request.
  • All functions catch exceptions internally so a bug here cannot break the app.
"""

import logging
import threading
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_customers_ref = None
_db = None


def init(db):
    """Call once at app startup to inject the Firestore client."""
    global _customers_ref, _db
    _db = db
    _customers_ref = db.collection("customers")
    logger.info("CustomerService initialised (customers collection)")


# ---------------------------------------------------------------------------
# UPSERT — create or update a customer record
# ---------------------------------------------------------------------------

def upsert_customer(guest_data: dict, amount_paid: int = 0, *, sync: bool = False):
    """
    Create a new customer or update an existing one.

    `guest_data` should contain at minimum:
        name, mobile

    Optional:
        id_type, id_number, address, photo (id_doc_url)

    If the customer already exists, we increment total_stays and total_spent,
    and update name / id fields if they were previously blank.

    Set sync=True for migration (blocking write). Default is async.
    """
    if _customers_ref is None:
        return

    mobile = _clean_mobile(guest_data.get("mobile", ""))
    if not mobile:
        return  # Can't key without mobile

    if sync:
        _upsert(mobile, guest_data, amount_paid)
    else:
        threading.Thread(
            target=_upsert,
            args=(mobile, guest_data, amount_paid),
            daemon=True,
        ).start()


def _upsert(mobile: str, guest_data: dict, amount_paid: int):
    try:
        doc_ref = _customers_ref.document(mobile)
        doc = doc_ref.get()
        now_str = datetime.now(timezone.utc).isoformat()

        name = guest_data.get("name", "")
        id_type = guest_data.get("id_type", "")
        id_number = guest_data.get("id_number", "")
        address = guest_data.get("address", "")
        id_doc_url = guest_data.get("photo", "") or guest_data.get("id_doc_url", "")

        if doc.exists:
            existing = doc.to_dict()
            updates = {
                "last_stay_date": now_str,
                "total_stays": (existing.get("total_stays", 0) + 1),
                "total_spent": (existing.get("total_spent", 0) + amount_paid),
            }
            # Fill in blanks if we have better data now
            if name and not existing.get("name"):
                updates["name"] = name
            elif name:
                updates["name"] = name  # always update name to latest
            if id_type and not existing.get("id_type"):
                updates["id_type"] = id_type
            if id_number and not existing.get("id_number"):
                updates["id_number"] = id_number
            if address and not existing.get("address"):
                updates["address"] = address
            if id_doc_url:
                # Append to list of ID doc URLs
                existing_urls = existing.get("id_doc_urls", [])
                if id_doc_url not in existing_urls:
                    existing_urls.append(id_doc_url)
                    updates["id_doc_urls"] = existing_urls

            doc_ref.update(updates)
        else:
            # New customer
            doc_ref.set({
                "name": name,
                "mobile": mobile,
                "id_type": id_type,
                "id_number": id_number,
                "address": address,
                "id_doc_urls": [id_doc_url] if id_doc_url else [],
                "total_stays": 1,
                "total_spent": amount_paid,
                "first_visit": now_str,
                "last_stay_date": now_str,
            })

        logger.info(f"CustomerService: upserted customer {mobile}")
    except Exception as e:
        logger.error(f"CustomerService upsert failed for {mobile}: {e}")


# ---------------------------------------------------------------------------
# SEARCH
# ---------------------------------------------------------------------------

def search_customers(query_str: str, limit: int = 10):
    """
    Search customers by name, mobile, or ID number.

    Firestore doesn't support full-text search natively, so we use a
    pragmatic approach:
      1. Exact mobile match (fastest).
      2. ID number exact match.
      3. Name prefix match (>= name, < name + high unicode char).

    Returns a list of customer dicts.
    """
    if _customers_ref is None:
        return []

    query_str = query_str.strip()
    if not query_str:
        return []

    results = []

    try:
        # 1. Try exact mobile match
        clean = _clean_mobile(query_str)
        if clean:
            doc = _customers_ref.document(clean).get()
            if doc.exists:
                data = doc.to_dict()
                data["_id"] = doc.id
                results.append(data)
                return results

        # 2. Try ID number exact match
        id_query = (
            _customers_ref
            .where("id_number", "==", query_str)
            .limit(limit)
        )
        for doc in id_query.stream():
            data = doc.to_dict()
            data["_id"] = doc.id
            results.append(data)
        if results:
            return results

        # 3. Name prefix search (case-sensitive — Firestore limitation)
        name_query = (
            _customers_ref
            .where("name", ">=", query_str)
            .where("name", "<", query_str + "\uf8ff")
            .limit(limit)
        )
        for doc in name_query.stream():
            data = doc.to_dict()
            data["_id"] = doc.id
            results.append(data)

        # 3b. Also try lowercase variant (common pattern)
        if query_str[0].isupper():
            lower_q = query_str[0].lower() + query_str[1:]
            lq = (
                _customers_ref
                .where("name", ">=", lower_q)
                .where("name", "<", lower_q + "\uf8ff")
                .limit(limit)
            )
            seen_ids = {r.get("_id") for r in results}
            for doc in lq.stream():
                if doc.id not in seen_ids:
                    data = doc.to_dict()
                    data["_id"] = doc.id
                    results.append(data)

        return results[:limit]

    except Exception as e:
        logger.error(f"CustomerService search failed for '{query_str}': {e}")
        return []


def get_customer(mobile: str):
    """Get a single customer by mobile number."""
    if _customers_ref is None:
        return None
    try:
        clean = _clean_mobile(mobile)
        if not clean:
            return None
        doc = _customers_ref.document(clean).get()
        if doc.exists:
            data = doc.to_dict()
            data["_id"] = doc.id
            return data
        return None
    except Exception as e:
        logger.error(f"CustomerService get_customer failed: {e}")
        return None


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------

def _clean_mobile(raw: str) -> str:
    """
    Normalise a mobile number:
      - Strip whitespace, dashes, plus signs.
      - Remove leading '91' country code if 12+ digits.
      - Return last 10 digits if Indian mobile.
      - Return empty string if invalid.
    """
    if not raw:
        return ""
    digits = "".join(c for c in str(raw) if c.isdigit())
    if len(digits) >= 12 and digits.startswith("91"):
        digits = digits[2:]
    if len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if len(digits) == 10:
        return digits
    # Return as-is if not a standard 10-digit Indian mobile
    return digits if digits else ""
