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

        # 3. Name prefix search — try multiple case variants to work around
        #    Firestore's case-sensitive range queries.
        #    Variants: original, all-lowercase, all-uppercase, title-case.
        variants = {query_str}
        variants.add(query_str.lower())
        variants.add(query_str.upper())
        variants.add(query_str.capitalize())    # first char upper, rest lower
        variants.add(query_str.title())         # each word capitalised

        seen_ids = set()
        for variant in variants:
            try:
                name_query = (
                    _customers_ref
                    .where("name", ">=", variant)
                    .where("name", "<", variant + "\uf8ff")
                    .limit(limit)
                )
                for doc in name_query.stream():
                    if doc.id not in seen_ids:
                        seen_ids.add(doc.id)
                        data = doc.to_dict()
                        data["_id"] = doc.id
                        results.append(data)
            except Exception:
                pass  # one variant failing shouldn't abort all others

        return results[:limit]

    except Exception as e:
        logger.error(f"CustomerService search failed for '{query_str}': {e}")
        return []


def search_by_mobile_prefix(prefix: str, limit: int = 6) -> list:
    """
    Return customers whose mobile number starts with `prefix`.

    Uses a Firestore range query on the `mobile` field (single-field index,
    no composite index required).  Requires at least 4 digits to avoid
    returning the whole collection.

    Returns a list of customer dicts (with `_id` injected).
    """
    if _customers_ref is None:
        return []

    prefix = "".join(c for c in str(prefix) if c.isdigit())
    if len(prefix) < 4:
        return []

    results = []
    try:
        query = (
            _customers_ref
            .where("mobile", ">=", prefix)
            .where("mobile", "<", prefix + "\uf8ff")
            .limit(limit)
        )
        for doc in query.stream():
            data = doc.to_dict()
            data["_id"] = doc.id
            results.append(data)
    except Exception as e:
        logger.warning(f"CustomerService: mobile prefix search failed - {e}")
    return results


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

# ---------------------------------------------------------------------------
# DOCUMENT UPLOAD
# ---------------------------------------------------------------------------

def upload_document(mobile: str, image_bytes: bytes, filename: str) -> str:
    """
    Upload a document image and append its URL to the customer's id_doc_urls.

    Tries Firebase Storage first; falls back to local file serving if Storage
    is not configured or fails.  Enforces a hard cap of 3 documents per customer.

    Returns the public URL on success, or an empty string on failure.
    """
    if _customers_ref is None:
        return ""

    clean = _clean_mobile(mobile)
    if not clean:
        return ""

    try:
        # ── Check cap BEFORE uploading to avoid orphaned Storage files ──────
        doc_ref = _customers_ref.document(clean)
        doc     = doc_ref.get()
        existing_urls = []

        if doc.exists:
            existing_urls = doc.to_dict().get("id_doc_urls", [])
            if len(existing_urls) >= 3:
                logger.warning(f"CustomerService: {clean} already has max (3) docs, aborting upload")
                return ""   # caller gets "" → route returns success=False

        # ── Now safe to upload ───────────────────────────────────────────────
        url = _store_image(clean, filename, image_bytes)
        if not url:
            return ""

        if doc.exists:
            if url not in existing_urls:
                existing_urls.append(url)
                doc_ref.update({"id_doc_urls": existing_urls})
        else:
            # Minimal stub record – will be enriched on first check-in
            doc_ref.set({
                "mobile": clean,
                "name": "",
                "address": "",
                "id_doc_urls": [url],
                "total_stays": 0,
                "total_spent": 0,
                "first_visit": datetime.now(timezone.utc).isoformat(),
                "last_stay_date": "",
            })

        logger.info(f"CustomerService: document stored for {clean} -> {url}")
        return url

    except Exception as e:
        logger.error(f"CustomerService upload_document failed for {mobile}: {e}")
        return ""


def _store_image(mobile_clean: str, filename: str, image_bytes: bytes) -> str:
    """
    Internal helper: upload bytes to Firebase Storage or local disk.
    Returns a URL string, or empty string on failure.

    Uses Firebase token-based download URLs (same format as Firebase JS SDK)
    instead of make_public() / ACLs — works even when the GCS bucket has
    uniform bucket-level access enabled.
    """
    # ── Try Firebase Storage ───────────────────────────────────────────────
    try:
        import urllib.parse
        import uuid as _uuid
        from firebase_admin import storage as _fb_storage

        bucket = _fb_storage.bucket()
        # bucket.name containing the placeholder means Storage isn't configured
        if bucket and "your-project-id" not in (bucket.name or ""):
            blob_path = f"customer_docs/{mobile_clean}/{filename}"
            blob = bucket.blob(blob_path)

            # Upload the file first
            blob.upload_from_string(
                image_bytes,
                content_type="image/jpeg",
            )

            # Generate a download token and commit it to GCS metadata.
            # Firebase Storage checks custom metadata key "firebaseStorageDownloadTokens"
            # (flat string value) when validating ?token= download URLs.
            # blob.patch() is required to persist — assigning blob.metadata alone
            # does NOT write to the server.
            download_token = str(_uuid.uuid4())
            blob.metadata  = {"firebaseStorageDownloadTokens": download_token}
            blob.patch()   # ← writes metadata to Firebase Storage

            # Construct the Firebase Storage download URL
            encoded_path = urllib.parse.quote(blob_path, safe="")
            url = (
                f"https://firebasestorage.googleapis.com/v0/b/"
                f"{bucket.name}/o/{encoded_path}"
                f"?alt=media&token={download_token}"
            )
            return url
    except Exception as storage_err:
        logger.warning(f"Firebase Storage unavailable, using local fallback: {storage_err}")

    # ── Local fallback ─────────────────────────────────────────────────────
    try:
        import os
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        upload_dir = os.path.join(base_dir, "uploads", "customer_docs")
        os.makedirs(upload_dir, exist_ok=True)
        file_path = os.path.join(upload_dir, filename)
        with open(file_path, "wb") as f:
            f.write(image_bytes)
        return f"/uploads/customer_docs/{filename}"
    except Exception as local_err:
        logger.error(f"Local file save also failed: {local_err}")
        return ""


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
