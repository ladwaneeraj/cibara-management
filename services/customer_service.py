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
from firebase_admin import firestore as _fs

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


def list_customers_page(page_size: int = 50, cursor: str = "", search: str = "") -> dict:
    """
    Cursor-based paginated listing of customers (lightweight — no image URLs).

    Args:
        page_size : max records to return (capped at 100).
        cursor    : last seen mobile from previous page (empty = first page).
        search    : if set, falls back to search_customers (no cursor support).

    Returns dict:
        {
          "customers": [ {name, mobile, total_stays, total_spent,
                          last_stay_date, is_flagged, doc_count}, ... ],
          "next_cursor": "<mobile of last row>" | None,
          "has_more": bool
        }
    """
    if _customers_ref is None:
        return {"customers": [], "next_cursor": None, "has_more": False}

    page_size = min(max(page_size, 1), 100)

    try:
        if search and search.strip():
            raw = search_customers(search.strip(), limit=page_size)
            return {
                "customers": [_slim(c) for c in raw],
                "next_cursor": None,
                "has_more": False,
            }

        query = _customers_ref.order_by("name").limit(page_size + 1)
        if cursor:
            # start_after requires a DocumentSnapshot; fetch it first
            snap = _customers_ref.document(cursor).get()
            if snap.exists:
                query = _customers_ref.order_by("name").start_after(snap).limit(page_size + 1)

        rows = []
        for doc in query.stream():
            d = doc.to_dict()
            d["_id"] = doc.id
            rows.append(d)

        has_more = len(rows) > page_size
        if has_more:
            rows = rows[:page_size]

        slimmed     = [_slim(r) for r in rows]
        next_cursor = rows[-1]["_id"] if (rows and has_more) else None

        return {"customers": slimmed, "next_cursor": next_cursor, "has_more": has_more}

    except Exception as e:
        logger.error(f"CustomerService list_customers_page failed: {e}")
        return {"customers": [], "next_cursor": None, "has_more": False}


def _slim(c: dict) -> dict:
    """Lightweight customer row — no image URLs, just counts."""
    return {
        "name":           c.get("name", ""),
        "mobile":         c.get("mobile", "") or c.get("_id", ""),
        "total_stays":    c.get("total_stays", 0),
        "total_spent":    c.get("total_spent", 0),
        "last_stay_date": c.get("last_stay_date", ""),
        "first_visit":    c.get("first_visit", ""),
        "is_flagged":     c.get("is_flagged", False),
        "doc_count":      len(c.get("id_doc_urls") or []),
    }


def update_customer(mobile: str, updates: dict) -> bool:
    """
    Update allowed fields on a customer record.
    Allowed: name, address, id_type, id_number.
    Mobile (the doc key) cannot be changed.
    Returns True on success, False on failure.
    """
    if _customers_ref is None:
        return False
    clean = _clean_mobile(mobile)
    if not clean:
        return False

    allowed = {"name", "address", "id_type", "id_number"}
    safe = {k: v for k, v in updates.items() if k in allowed}
    if not safe:
        return False
    try:
        _customers_ref.document(clean).update(safe)
        logger.info(f"CustomerService: updated customer {clean} fields={list(safe.keys())}")
        return True
    except Exception as e:
        logger.error(f"CustomerService update_customer failed for {clean}: {e}")
        return False


def add_customer(data: dict) -> bool:
    """
    Manually add a new customer (without a booking).
    Requires at minimum: name + mobile.
    Returns True on success, False on failure.
    """
    if _customers_ref is None:
        return False
    mobile = _clean_mobile(data.get("mobile", ""))
    if not mobile:
        return False
    try:
        doc_ref = _customers_ref.document(mobile)
        if doc_ref.get().exists:
            # Already exists — just update provided fields instead
            return update_customer(mobile, data)
        now_str = datetime.now(timezone.utc).isoformat()
        doc_ref.set({
            "name":         data.get("name", ""),
            "mobile":       mobile,
            "id_type":      data.get("id_type", ""),
            "id_number":    data.get("id_number", ""),
            "address":      data.get("address", ""),
            "id_doc_urls":  [],
            "total_stays":  0,
            "total_spent":  0,
            "first_visit":  now_str,
            "last_stay_date": "",
        })
        logger.info(f"CustomerService: manually added customer {mobile}")
        return True
    except Exception as e:
        logger.error(f"CustomerService add_customer failed: {e}")
        return False


# ---------------------------------------------------------------------------
# FLAG
# ---------------------------------------------------------------------------

def update_flag(mobile: str, is_flagged: bool, flag_notes: str = "", *, sync: bool = False):
    """
    Set or clear the flag on a customer record.

    Args:
        mobile      – 10-digit mobile number (customer key)
        is_flagged  – True to flag, False to unflag
        flag_notes  – Free-text reason / notes (stored even when unflagging,
                      so history isn't lost — pass "" to clear notes explicitly)
        sync        – If True, blocks until Firestore write completes.
                      Default False (fire-and-forget daemon thread).
    """
    if _customers_ref is None:
        return

    clean = _clean_mobile(mobile)
    if not clean:
        return

    if sync:
        _write_flag(clean, is_flagged, flag_notes)
    else:
        threading.Thread(
            target=_write_flag,
            args=(clean, is_flagged, flag_notes),
            daemon=True,
        ).start()


def _write_flag(mobile: str, is_flagged: bool, flag_notes: str):
    try:
        now_str = datetime.now(timezone.utc).isoformat()
        doc_ref = _customers_ref.document(mobile)

        updates = {
            "is_flagged": bool(is_flagged),
            "flag_notes": flag_notes.strip() if flag_notes else "",
            "flag_updated_at": now_str,
        }
        # Set flagged_at only the first time a flag is turned ON.
        # Works whether the document already exists or not.
        if is_flagged:
            snap = doc_ref.get()
            if not snap.exists or not snap.to_dict().get("flagged_at"):
                updates["flagged_at"] = now_str

        doc_ref.set(updates, merge=True)
        logger.info(
            f"CustomerService: flag updated for {mobile} → is_flagged={is_flagged}"
        )
    except Exception as e:
        logger.error(f"CustomerService update_flag failed for {mobile}: {e}")


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

    Uses a Firestore transaction to atomically check the cap and append the URL,
    preventing TOCTOU races when concurrent uploads happen.  If the transaction
    detects the cap was hit after the Storage upload already completed, the
    orphaned blob is deleted from Storage.

    Returns the public URL on success, or an empty string on failure.
    """
    if _customers_ref is None:
        return ""

    clean = _clean_mobile(mobile)
    if not clean:
        return ""

    try:
        # No pre-flight Firestore read here — the route already ran get_customer()
        # and enforced the cap before calling upload_document().  The transaction
        # below provides the final atomic safety net against concurrent uploads.
        doc_ref = _customers_ref.document(clean)

        # ── Upload to Storage ─────────────────────────────────────────────────
        url = _store_image(clean, filename, image_bytes)
        if not url:
            return ""

        # ── Atomic Firestore transaction: append URL or clean up orphan ───────
        @_fs.transactional
        def _append_url(transaction, d_ref, new_url):
            snap = d_ref.get(transaction=transaction)
            if snap.exists:
                urls = list(snap.to_dict().get("id_doc_urls", []) or [])
                if len(urls) >= 3:
                    raise RuntimeError("cap_hit")
                if new_url not in urls:
                    transaction.update(d_ref, {"id_doc_urls": _fs.ArrayUnion([new_url])})
            else:
                # Minimal stub — enriched on first check-in
                transaction.set(d_ref, {
                    "mobile": clean,
                    "name": "",
                    "address": "",
                    "id_doc_urls": [new_url],
                    "total_stays": 0,
                    "total_spent": 0,
                    "first_visit": datetime.now(timezone.utc).isoformat(),
                    "last_stay_date": "",
                })

        try:
            _append_url(_db.transaction(), doc_ref, url)
        except RuntimeError as cap_err:
            if "cap_hit" in str(cap_err):
                # Concurrent upload reached the cap first — delete the orphan
                _delete_storage_url(url)
                logger.warning(
                    f"CustomerService: cap hit in transaction for {clean}; orphan deleted"
                )
                return ""
            raise

        logger.info(f"CustomerService: document stored for {clean} -> {url}")
        return url

    except Exception as e:
        logger.error(f"CustomerService upload_document failed for {mobile}: {e}")
        return ""


# ---------------------------------------------------------------------------
# PENDING SETTLEMENT FLAG — set / clear automatically during checkout flow
# ---------------------------------------------------------------------------

def set_pending_settlement(mobile: str, settlement_data: dict):
    """
    Flag a customer as having a pending (unpaid) settlement from their last checkout.
    Called automatically when a guest is checked out with 'settle_later=True'.
    Runs in a background thread so it never blocks the checkout response.
    """
    if _customers_ref is None:
        return
    clean = _clean_mobile(mobile)
    if not clean:
        return
    threading.Thread(
        target=_set_pending_settlement,
        args=(clean, settlement_data),
        daemon=True,
    ).start()


def _set_pending_settlement(mobile: str, settlement_data: dict):
    try:
        _customers_ref.document(mobile).set({
            "has_pending_settlement": True,
            "pending_settlement_id":     settlement_data.get("id"),
            "pending_settlement_amount": settlement_data.get("amount"),
            "pending_settlement_date":   settlement_data.get("checkout_date"),
            "pending_settlement_room":   settlement_data.get("room"),
        }, merge=True)
        logger.info(f"CustomerService: pending settlement flagged for {mobile}, "
                    f"₹{settlement_data.get('amount')}")
    except Exception as e:
        logger.error(f"CustomerService set_pending_settlement failed for {mobile}: {e}")


def clear_pending_settlement(mobile: str):
    """
    Remove the pending settlement flag after it has been fully paid.
    Called automatically from collect_settlement when status becomes 'paid'.
    Runs in a background thread.
    """
    if _customers_ref is None:
        return
    clean = _clean_mobile(mobile)
    if not clean:
        return
    threading.Thread(
        target=_clear_pending_settlement,
        args=(clean,),
        daemon=True,
    ).start()


def _clear_pending_settlement(mobile: str):
    try:
        _customers_ref.document(mobile).update({
            "has_pending_settlement":    False,
            "pending_settlement_id":     None,
            "pending_settlement_amount": None,
            "pending_settlement_date":   None,
            "pending_settlement_room":   None,
        })
        logger.info(f"CustomerService: pending settlement cleared for {mobile}")
    except Exception as e:
        logger.error(f"CustomerService clear_pending_settlement failed for {mobile}: {e}")


def _delete_storage_url(url: str):
    """Delete a Firebase Storage blob by its download URL. Silently ignores errors."""
    if not url.startswith("https://firebasestorage.googleapis.com"):
        return
    try:
        import urllib.parse
        from firebase_admin import storage as _fb_storage
        path_encoded = url.split("/o/")[1].split("?")[0]
        blob_path = urllib.parse.unquote(path_encoded)
        _fb_storage.bucket().blob(blob_path).delete()
        logger.info(f"CustomerService: orphan blob deleted: {blob_path}")
    except Exception as e:
        logger.warning(f"CustomerService: orphan blob delete failed: {e}")


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

            # Set the download token BEFORE upload so it is included in the
            # single multipart upload request.  This avoids a separate
            # blob.patch() call (which is a second HTTP round-trip and was
            # the step most likely to fail, causing silent fallback to local).
            download_token = str(_uuid.uuid4())
            blob.metadata  = {"firebaseStorageDownloadTokens": download_token}

            blob.upload_from_string(
                image_bytes,
                content_type="image/jpeg",
            )

            # Construct the Firebase Storage download URL
            encoded_path = urllib.parse.quote(blob_path, safe="")
            url = (
                f"https://firebasestorage.googleapis.com/v0/b/"
                f"{bucket.name}/o/{encoded_path}"
                f"?alt=media&token={download_token}"
            )
            logger.info(f"Firebase Storage upload OK: {blob_path}")
            return url
    except Exception as storage_err:
        # Log the full exception so the server admin can see exactly why
        # Firebase Storage is failing (permissions, bucket name, network, etc.)
        logger.error(
            f"Firebase Storage upload FAILED for {mobile_clean}/{filename} — "
            f"error type: {type(storage_err).__name__} — "
            f"detail: {storage_err!r}",
            exc_info=True,
        )
        # Do NOT fall back to local disk storage:
        # • On cloud platforms (Heroku, Railway, Cloud Run) the local file
        #   system is ephemeral — files survive only until the next dyno
        #   restart or scale-out, after which /uploads/* URLs return 404.
        # • Silently returning a local URL stores a broken URL in Firestore
        #   that can never be reliably served.
        # Returning "" signals failure to the caller, which returns an error
        # response to the client so the issue is visible immediately.
        return ""


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# GUEST DEMOGRAPHICS — pincode + DOB extracted from ID documents
# ---------------------------------------------------------------------------
#
# Storage model (per customer doc):
#   guest_demographics : [ {source_url, name, dob, birth_year, pincode,
#                           extracted_at}, ... ]   one entry per ID document
#   pincode, dob       : convenience top-level copies of the FIRST known value,
#                        set only when blank so manual edits are never clobbered.
#
# Age is deliberately NEVER stored — it is computed from dob / birth_year at
# read time so it can't go stale.

def apply_id_extraction(mobile: str, extraction: dict, source_url: str = "",
                        *, sync: bool = False):
    """
    Merge an ID-OCR extraction into a customer's demographics.

    `extraction` is the dict returned by ocr_service.extract_id_fields()['fields']:
        {name, dob, birth_year, pincode, doc_kind}

    Idempotent: re-extracting the same source_url replaces that entry instead
    of appending a duplicate (so the backfill script can be re-run safely).

    Fire-and-forget by default; pass sync=True to block (used by the backfill
    script so failures surface).
    """
    if _customers_ref is None:
        return
    clean = _clean_mobile(mobile)
    if not clean:
        return
    if not isinstance(extraction, dict):
        return
    # Nothing useful extracted → skip the write entirely.
    if not (extraction.get("dob") or extraction.get("birth_year")
            or extraction.get("pincode")):
        return

    if sync:
        _apply_id_extraction(clean, extraction, source_url)
    else:
        threading.Thread(
            target=_apply_id_extraction,
            args=(clean, extraction, source_url),
            daemon=True,
        ).start()


def _apply_id_extraction(mobile: str, extraction: dict, source_url: str):
    try:
        entry = {
            "source_url":   source_url or "",
            "name":         extraction.get("name") or "",
            "dob":          extraction.get("dob"),          # "YYYY-MM-DD" | None
            "birth_year":   extraction.get("birth_year"),   # int | None
            "pincode":      extraction.get("pincode"),      # "6-digit" | None
            "doc_kind":     extraction.get("doc_kind") or "",
            "extracted_at": datetime.now(timezone.utc).isoformat(),
        }

        doc_ref = _customers_ref.document(mobile)

        @_fs.transactional
        def _txn(transaction, d_ref):
            snap = d_ref.get(transaction=transaction)
            data = snap.to_dict() if snap.exists else {}
            demographics = list(data.get("guest_demographics", []) or [])

            # Replace an entry with the same source_url (idempotent), else append.
            replaced = False
            if source_url:
                for i, e in enumerate(demographics):
                    if e.get("source_url") == source_url:
                        demographics[i] = entry
                        replaced = True
                        break
            if not replaced:
                demographics.append(entry)

            updates = {"guest_demographics": demographics}

            # Set top-level convenience copies only when currently blank.
            if entry["pincode"] and not data.get("pincode"):
                updates["pincode"] = entry["pincode"]
            if entry["dob"] and not data.get("dob"):
                updates["dob"] = entry["dob"]

            if snap.exists:
                transaction.update(d_ref, updates)
            else:
                # Minimal stub so a demographics-only write doesn't create a
                # half-formed customer; check-in enriches the rest later.
                base = {
                    "mobile": mobile, "name": entry["name"], "address": "",
                    "id_doc_urls": [source_url] if source_url else [],
                    "total_stays": 0, "total_spent": 0,
                    "first_visit": entry["extracted_at"], "last_stay_date": "",
                }
                base.update(updates)
                transaction.set(d_ref, base)

        _txn(_db.transaction(), doc_ref)
        logger.info(f"CustomerService: demographics applied for {mobile} "
                    f"(pincode={entry['pincode']}, dob={entry['dob']}, "
                    f"birth_year={entry['birth_year']})")
    except Exception as e:
        logger.error(f"CustomerService apply_id_extraction failed for {mobile}: {e}")


# ── Age helpers ─────────────────────────────────────────────────────────────

def _age_from(dob, birth_year, today):
    """
    Compute age in whole years. Prefers a precise dob; falls back to
    birth_year. Returns an int in [0, 120], or None if neither is usable.
    """
    if dob:
        try:
            d = datetime.strptime(str(dob), "%Y-%m-%d").date()
            age = today.year - d.year - ((today.month, today.day) < (d.month, d.day))
            if 0 <= age <= 120:
                return age
        except (ValueError, TypeError):
            pass
    if birth_year:
        try:
            age = today.year - int(birth_year)
            if 0 <= age <= 120:
                return age
        except (TypeError, ValueError):
            pass
    return None


# Age buckets, in display order. (label, lower_inclusive, upper_inclusive)
_AGE_BUCKETS = [
    ("<18", 0, 17), ("18-25", 18, 25), ("26-35", 26, 35),
    ("36-45", 36, 45), ("46-55", 46, 55), ("56-65", 56, 65),
    ("65+", 66, 120),
]


def _bucket_for(age: int) -> str:
    for label, lo, hi in _AGE_BUCKETS:
        if lo <= age <= hi:
            return label
    return "65+"


# Module-level TTL cache for the aggregate — a full collection scan is the
# expensive part, and analytics is read far more often than demographics change.
_AGG_CACHE = {"data": None, "ts": 0.0}
_AGG_TTL_SECONDS = 300  # 5 minutes


def get_demographics_aggregate(force: bool = False) -> dict:
    """
    Scan the customers collection and aggregate guest demographics for the
    analytics dashboard.

    Returns:
        {
          "age": {
            "buckets":   [{"label": "26-35", "count": N}, ...],
            "average":   float | None,
            "count":     int,          # guests with a known age
          },
          "pincodes": [
            {"pincode": "560001", "guests": N, "visits": M}, ...  # sorted desc
          ],
          "totals": {
            "customers_scanned": int,
            "with_demographics": int,
            "generated_at":      iso8601,
          }
        }

    A 5-minute in-process cache avoids rescanning on every dashboard load.
    """
    import time as _time
    now_ts = _time.time()
    if (not force and _AGG_CACHE["data"] is not None
            and (now_ts - _AGG_CACHE["ts"]) < _AGG_TTL_SECONDS):
        return _AGG_CACHE["data"]

    empty = {
        "age": {"buckets": [{"label": l, "count": 0} for l, _, _ in _AGE_BUCKETS],
                "average": None, "count": 0},
        "pincodes": [],
        "totals": {"customers_scanned": 0, "with_demographics": 0,
                   "generated_at": datetime.now(timezone.utc).isoformat()},
    }
    if _customers_ref is None:
        return empty

    try:
        today = datetime.now(timezone.utc).date()
        bucket_counts = {label: 0 for label, _, _ in _AGE_BUCKETS}
        age_sum = 0
        age_n = 0
        pin_guests = {}   # pincode -> guest count (per demographic entry)
        pin_visits = {}   # pincode -> visit count (total_stays, once per customer)
        scanned = 0
        with_demo = 0

        # Pull only the fields we need (saves bandwidth; read count is the same).
        query = _customers_ref.select(
            ["guest_demographics", "pincode", "dob", "total_stays"]
        )
        for snap in query.stream():
            scanned += 1
            d = snap.to_dict() or {}
            entries = list(d.get("guest_demographics", []) or [])

            # Back-compat: if no list yet but a top-level pincode/dob exists,
            # treat that as a single implicit entry.
            if not entries and (d.get("pincode") or d.get("dob")):
                entries = [{"pincode": d.get("pincode"), "dob": d.get("dob"),
                            "birth_year": None}]

            if not entries:
                continue
            with_demo += 1

            stays = d.get("total_stays") or 0
            primary_pin_done = False
            for e in entries:
                # Age → buckets + running average
                age = _age_from(e.get("dob"), e.get("birth_year"), today)
                if age is not None:
                    bucket_counts[_bucket_for(age)] += 1
                    age_sum += age
                    age_n += 1
                # Pincode → guest count (each entry) + visit weight (once)
                pin = e.get("pincode")
                if pin:
                    pin_guests[pin] = pin_guests.get(pin, 0) + 1
                    if not primary_pin_done:
                        pin_visits[pin] = pin_visits.get(pin, 0) + max(stays, 1)
                        primary_pin_done = True

        pincodes = sorted(
            ({"pincode": p, "guests": g, "visits": pin_visits.get(p, g)}
             for p, g in pin_guests.items()),
            key=lambda x: (-x["guests"], -x["visits"], x["pincode"]),
        )

        result = {
            "age": {
                "buckets": [{"label": l, "count": bucket_counts[l]}
                            for l, _, _ in _AGE_BUCKETS],
                "average": round(age_sum / age_n, 1) if age_n else None,
                "count": age_n,
            },
            "pincodes": pincodes,
            "totals": {
                "customers_scanned": scanned,
                "with_demographics": with_demo,
                "generated_at": datetime.now(timezone.utc).isoformat(),
            },
        }
        _AGG_CACHE["data"] = result
        _AGG_CACHE["ts"] = now_ts
        return result
    except Exception as e:
        logger.error(f"CustomerService get_demographics_aggregate failed: {e}")
        return empty


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
    # Non-10-digit after normalisation is not a valid Indian mobile
    return ""
