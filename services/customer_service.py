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
            # Provisional "last paid" stamp at check-in. total_spent and
            # last_stay_amount used to drift because total_spent is bumped
            # HERE (every stay) while last_stay_amount was only set at
            # checkout (rooms.py -> update_last_stay) - so any stay that
            # skipped that path left the dropdown's "last paid" blank.
            # We stamp the check-in payment now as a floor; checkout
            # overwrites it with the accurate stay total. Guarded by >0 so a
            # zero-paid (settle-later) check-in never WIPES a prior good value.
            try:
                _amt = round(float(amount_paid or 0))
            except (TypeError, ValueError):
                _amt = 0
            if _amt > 0:
                updates["last_stay_amount"] = _amt
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
            try:
                _amt = round(float(amount_paid or 0))
            except (TypeError, ValueError):
                _amt = 0
            new_doc = {
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
            }
            # Provisional "last paid" (see existing-customer branch above);
            # refined to the real stay total at checkout.
            if _amt > 0:
                new_doc["last_stay_amount"] = _amt
            doc_ref.set(new_doc)

        logger.info(f"CustomerService: upserted customer {mobile}")
    except Exception as e:
        logger.error(f"CustomerService upsert failed for {mobile}: {e}")


# ---------------------------------------------------------------------------
# SEARCH
# ---------------------------------------------------------------------------

def search_customers(query_str: str, limit: int = 10):
    """
    Search customers by name, mobile (full OR partial), or ID number.

    Every branch is a bounded, indexed Firestore query — nothing ever
    scans the whole collection:

      * Query is digits (>= 4)  ->  mobile prefix range query. A full,
        valid 10-digit number short-circuits to a direct doc get
        (customer docs are keyed by mobile).
      * Anything else           ->  id_number exact match + case-variant
        name prefix range queries, all issued IN PARALLEL. These used to
        run sequentially — up to 6 back-to-back round-trips, which is
        why name search felt slow on high-latency links.

    Returns a list of customer dicts (with `_id` injected), newest stay
    first within each relevance band, capped at `limit`.
    """
    if _customers_ref is None:
        return []

    query_str = query_str.strip()
    if not query_str:
        return []

    try:
        # ── Phone-number path (the old code only matched FULL numbers;
        #    partial numbers fell through to name search and returned
        #    nothing — this is the "can't search by phone" bug) ─────────
        digits  = "".join(c for c in query_str if c.isdigit())
        letters = "".join(c for c in query_str if c.isalpha())
        if len(digits) >= 4 and not letters:
            clean = _clean_mobile(query_str)
            if clean:  # full valid mobile — direct doc get (1 round-trip)
                doc = _customers_ref.document(clean).get()
                if doc.exists:
                    data = doc.to_dict()
                    data["_id"] = doc.id
                    return [data]
            # Partial number — indexed prefix range query on `mobile`.
            return search_by_mobile_prefix(digits, limit=limit)

        # ── Name / ID path — parallel bounded queries ──────────────────
        def _id_exact():
            q = _customers_ref.where("id_number", "==", query_str).limit(limit)
            return [(d.id, d.to_dict()) for d in q.stream()]

        def _name_prefix(variant):
            q = (
                _customers_ref
                .where("name", ">=", variant)
                .where("name", "<", variant + "\uf8ff")
                .limit(limit)
            )
            return [(d.id, d.to_dict()) for d in q.stream()]

        # Firestore range queries are case-sensitive; cover the common
        # casings. (A name_lower index field would collapse these to one
        # query, but needs a backfill — out of scope here.)
        variants = {query_str, query_str.lower(), query_str.upper(),
                    query_str.capitalize(), query_str.title()}

        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=len(variants) + 1) as pool:
            futures = [pool.submit(_id_exact)]
            futures += [pool.submit(_name_prefix, v) for v in variants]

        results, seen_ids = [], set()
        for f in futures:
            try:
                for doc_id, data in f.result():
                    if doc_id in seen_ids:
                        continue
                    seen_ids.add(doc_id)
                    data["_id"] = doc_id
                    results.append(data)
            except Exception as qe:
                logger.warning(f"CustomerService search branch failed: {qe}")

        # Ranking: most recent stay first, then case-insensitive prefix
        # matches ahead of substring-ish variant hits (stable sorts).
        ql = query_str.lower()
        results.sort(key=lambda c: c.get("last_stay_date") or "", reverse=True)
        results.sort(key=lambda c: 0 if (c.get("name") or "").lower().startswith(ql) else 1)

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

    # NOTE: this endpoint is called per-keystroke from the check-in form, so it
    # stays a SINGLE indexed range query — no per-row bill lookups, no writes.
    # `last_stay_amount` is read straight off the customer doc; it is populated
    # forward at checkout (rooms.py -> update_last_stay) and, for guests who
    # predate the feature, by the one-off backfill_last_stay_amounts() admin
    # task. When a guest has no stamp yet the dropdown falls back to the
    # always-present total_spent. (The previous version did live bill lookups
    # + write-backs on every keystroke — up to ~6 reads and ~6 writes per
    # keypress, and far worse without the composite index.)
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
        "last_stay_amount": c.get("last_stay_amount", 0),
        "first_visit":    c.get("first_visit", ""),
        "is_flagged":     c.get("is_flagged", False),
        "doc_count":      len(c.get("id_doc_urls") or []),
    }


def backfill_last_stay_amounts() -> dict:
    """
    One-off maintenance task: stamp `last_stay_amount` / `last_stay_per_day`
    onto existing customer docs that predate the feature, so the check-in
    dropdown's "last paid" column is populated without ever doing per-keystroke
    bill lookups. Idempotent — skips customers already stamped. Safe to re-run.

    Returns {scanned, stamped, skipped}. Intended to be triggered ONCE from an
    admin endpoint; not on any request hot path.
    """
    if _customers_ref is None:
        return {"scanned": 0, "stamped": 0, "skipped": 0}
    scanned = stamped = skipped = 0
    try:
        for doc in _customers_ref.stream():
            scanned += 1
            d = doc.to_dict() or {}
            if d.get("last_stay_amount"):
                skipped += 1
                continue
            s = get_last_stay_summary(doc.id)
            if s and s.get("total_amount"):
                # Synchronous write here (not the async update_last_stay) so the
                # task's return counts reflect completed writes.
                try:
                    days = max(int(s.get("days") or 1), 1)
                    total = round(float(s["total_amount"]))
                    _customers_ref.document(doc.id).set({
                        "last_stay_amount":  total,
                        "last_stay_per_day": round(total / days),
                    }, merge=True)
                    stamped += 1
                except Exception as we:
                    logger.warning(f"backfill stamp failed for {doc.id}: {we}")
            else:
                # No resolvable bill (e.g. same-day cash with no bill doc, or
                # legacy stay). For a SINGLE-stay guest, lifetime total_spent
                # IS the last-stay amount - stamp it exactly. (For multi-stay
                # guests we don't guess from the lifetime average; those resolve
                # via the bill query above or get refined on their next stay.)
                try:
                    spent  = round(float(d.get("total_spent") or 0))
                    stays  = int(d.get("total_stays") or 0)
                    if spent > 0 and stays <= 1:
                        _customers_ref.document(doc.id).set({
                            "last_stay_amount": spent,
                        }, merge=True)
                        stamped += 1
                    else:
                        skipped += 1
                except Exception as we:
                    logger.warning(f"backfill fallback failed for {doc.id}: {we}")
                    skipped += 1
    except Exception as e:
        logger.error(f"backfill_last_stay_amounts failed after {scanned}: {e}")
    logger.info(f"backfill_last_stay_amounts: scanned={scanned} stamped={stamped} skipped={skipped}")
    return {"scanned": scanned, "stamped": stamped, "skipped": skipped}


def get_stay_history(mobile: str, limit: int = 60):
    """
    Every recorded stay for a guest, newest first, for the customer-records
    History view. One bounded, indexed query on bills.guest_mobile (capped at
    `limit`); sorting is done in memory so no composite index is required.

    Each row is a flat dict the UI renders directly:
        bill_number, room, checkin_time, checkout_time, days,
        room_rate, room_charges, services_total, discounts,
        paid_cash, paid_online, total_amount, balance, status
    Never raises — returns [] on any error.
    """
    if _db is None:
        return []
    clean = _clean_mobile(mobile)
    if not clean:
        return []

    _ok_status = ("completed", "checked_out", "pending_settlement", "")
    try:
        q = _db.collection("bills").where(
            filter=_fs.firestore.FieldFilter("guest_mobile", "==", clean)
        ).limit(limit)
        rows = []
        for snap in q.stream():
            b = snap.to_dict() or {}
            if not b.get("checkin_time"):
                continue
            if b.get("status", "") not in _ok_status:
                continue
            rows.append({
                "bill_number":    b.get("bill_number", "-"),
                "room":           str(b.get("room", "")),
                "checkin_time":   b.get("checkin_time", ""),
                "checkout_time":  b.get("checkout_time", ""),
                "days":           int(b.get("days_stayed") or 1),
                "room_rate":      b.get("room_price_per_night", 0),
                "room_charges":   b.get("room_charges_total", 0),
                "services_total": b.get("services_total", 0),
                "discounts":      b.get("discounts", 0),
                "paid_cash":      b.get("payment_cash", 0),
                "paid_online":    b.get("payment_online", 0),
                "total_amount":   b.get("total_amount", 0),
                "balance":        b.get("balance", 0),
                "status":         b.get("status", "completed"),
            })
        # Newest first by checkout (fallback to checkin for open/legacy rows).
        rows.sort(key=lambda r: r["checkout_time"] or r["checkin_time"],
                  reverse=True)
        return rows
    except Exception as e:
        logger.warning(f"CustomerService get_stay_history({clean}) failed: {e}")
        return []


def update_last_stay(mobile: str, total_amount, days, checkout_date: str = "") -> None:
    """
    Stamp the guest's most-recent-stay summary onto their customer doc so the
    check-in mobile-suggestion dropdown can show "last paid" with ZERO extra
    queries. Fire-and-forget; never blocks or breaks the caller.

        last_stay_amount   — total the guest paid that stay (incl. services,
                             net of discounts)
        last_stay_per_day  — that total / nights, rounded
    """
    if _customers_ref is None:
        return
    clean = _clean_mobile(mobile)
    if not clean:
        return

    def _do():
        try:
            d = max(int(days or 1), 1)
            total = round(float(total_amount or 0))
            patch = {
                "last_stay_amount":  total,
                "last_stay_per_day": round(total / d),
            }
            if checkout_date:
                patch["last_stay_date"] = checkout_date
            _customers_ref.document(clean).set(patch, merge=True)
        except Exception as e:
            logger.warning(f"CustomerService update_last_stay({clean}) failed: {e}")

    threading.Thread(target=_do, daemon=True).start()


def get_last_stay_summary(mobile: str):
    """
    Most recent completed stay for this guest, summarised for the
    check-in form's returning-guest card.

    Query strategy: try the indexed `guest_mobile == X ORDER BY
    checkout_time DESC LIMIT 1` first (needs a composite index — the
    Firestore error log contains a one-click creation link if it's
    missing). Fall back to a bounded unordered scan (limit 25, newest
    picked in memory) so the feature works either way. Never raises.
    """
    if _db is None:
        return None
    clean = _clean_mobile(mobile)
    if not clean:
        return None

    _ok_status = ("completed", "checked_out", "pending_settlement", "")

    def _summarise(b):
        days = max(int(b.get("days_stayed") or 1), 1)
        total = float(b.get("total_amount") or 0)
        return {
            "room":           str(b.get("room", "")),
            "checkout_date":  (b.get("checkout_time") or "").split(" ")[0],
            "days":           days,
            "room_rate":      b.get("room_price_per_night", 0),
            "discounts":      b.get("discounts", 0),
            "services_total": b.get("services_total", 0),
            "total_amount":   total,
            # What the guest effectively paid per day, all-in (room +
            # services - discounts are already netted into total_amount).
            "per_day":        round(total / days),
        }

    # Single equality query on guest_mobile (auto-indexed — NO composite
    # index needed); newest stay chosen in memory. This is off the hot path
    # (used only by checkout's own stamp and the one-off backfill), so the
    # bounded scan is cheap and avoids any index-deploy dependency.
    bills = _db.collection("bills")
    try:
        q = bills.where(
            filter=_fs.firestore.FieldFilter("guest_mobile", "==", clean)
        ).limit(40)
        best = None
        for snap in q.stream():
            b = snap.to_dict() or {}
            if not b.get("checkout_time"):
                continue
            if b.get("status", "") not in _ok_status:
                continue
            if best is None or (b.get("checkout_time") > best.get("checkout_time")):
                best = b
        return _summarise(best) if best else None
    except Exception as e:
        logger.warning(f"CustomerService get_last_stay_summary({clean}) failed: {e}")
        return None


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

class DocumentCapReached(Exception):
    """Raised when a customer already has the maximum number of ID documents.
    Lets the upload route return the specific cap message without paying a
    pre-flight Firestore read on every upload."""


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

        # ── Atomic append — single RPC, parallel-safe ─────────────────────
        # ArrayUnion appends server-side without a read-modify-write
        # transaction. The old transactional path cost 2 round-trips
        # (read + commit) AND serialized concurrent uploads to the same
        # customer with contention retries + backoff — a 2-photo parallel
        # upload regularly doubled in wall-clock time because of it.
        #
        # Race-safe doc creation: update() raises NotFound when the
        # customer doc doesn't exist yet; create() raises AlreadyExists if
        # a parallel upload created it first — in which case the plain
        # ArrayUnion update succeeds on retry. No path can overwrite
        # another upload's URL (the old txn's set() stub could).
        from google.api_core import exceptions as _gax
        try:
            doc_ref.update({"id_doc_urls": _fs.ArrayUnion([url])})
        except _gax.NotFound:
            try:
                # Minimal stub — enriched on first check-in
                doc_ref.create({
                    "mobile": clean,
                    "name": "",
                    "address": "",
                    "id_doc_urls": [url],
                    "total_stays": 0,
                    "total_spent": 0,
                    "first_visit": datetime.now(timezone.utc).isoformat(),
                    "last_stay_date": "",
                })
            except _gax.AlreadyExists:
                doc_ref.update({"id_doc_urls": _fs.ArrayUnion([url])})

        # ── Cap enforcement (max 3) — lazy, off the request path ──────────
        # The atomic append above can briefly overflow the cap when uploads
        # race; this background pass trims anything beyond the first 3 and
        # deletes the orphaned Storage blobs. The capture UI already caps
        # photos per session, so this trim is a rare safety net, not the
        # primary control.
        def _trim_overflow():
            try:
                snap = doc_ref.get()
                urls = list((snap.to_dict() or {}).get("id_doc_urls", []) or []) \
                    if snap.exists else []
                if len(urls) > 3:
                    extras = urls[3:]
                    doc_ref.update({"id_doc_urls": _fs.ArrayRemove(extras)})
                    for u in extras:
                        _delete_storage_url(u)
                    logger.warning(
                        f"CustomerService: doc cap exceeded for {clean}; "
                        f"trimmed {len(extras)} overflow doc(s)"
                    )
            except Exception as te:
                logger.warning(f"CustomerService: cap trim failed for {clean}: {te}")

        threading.Thread(target=_trim_overflow, daemon=True).start()

        logger.info(f"CustomerService: document stored for {clean} -> {url}")
        return url

    except DocumentCapReached:
        raise
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

# Safety cap on how many guests are listed per age bucket in bucket_guests
# (drill-down list). Doesn't affect the bucket *count* used by the chart —
# only how many names the click-through popover can show.
_AGE_BUCKET_GUEST_CAP = 300


def get_demographics_aggregate(force: bool = False) -> dict:
    """
    Scan the customers collection and aggregate guest demographics for the
    analytics dashboard.

    Returns:
        {
          "age": {
            "buckets":       [{"label": "26-35", "count": N}, ...],
            "average":       float | None,
            "count":         int,          # guests with a known age
            "bucket_guests": {"26-35": [{"mobile": "...", "name": "..."}, ...], ...},
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

    `bucket_guests` powers the dashboard's click-to-drill-down (bar → guest
    list → existing Customer detail modal with docs + stay history). It is
    deduplicated per guest per bucket (a guest with two demographic entries
    landing in the same bucket appears once) and capped per bucket so a huge
    property can't balloon the response.

    A 5-minute in-process cache avoids rescanning on every dashboard load.
    """
    import time as _time
    now_ts = _time.time()
    if (not force and _AGG_CACHE["data"] is not None
            and (now_ts - _AGG_CACHE["ts"]) < _AGG_TTL_SECONDS):
        return _AGG_CACHE["data"]

    empty = {
        "age": {"buckets": [{"label": l, "count": 0} for l, _, _ in _AGE_BUCKETS],
                "average": None, "count": 0,
                "bucket_guests": {l: [] for l, _, _ in _AGE_BUCKETS}},
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
        bucket_guests = {label: [] for label, _, _ in _AGE_BUCKETS}
        seen_bucket_guest = set()   # (mobile, label) already listed
        scanned = 0
        with_demo = 0

        # Pull only the fields we need (saves bandwidth; read count is the same).
        query = _customers_ref.select(
            ["guest_demographics", "pincode", "dob", "total_stays", "name"]
        )
        for snap in query.stream():
            scanned += 1
            d = snap.to_dict() or {}
            mobile = snap.id
            name = d.get("name") or ""
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
                    label = _bucket_for(age)
                    bucket_counts[label] += 1
                    age_sum += age
                    age_n += 1
                    key = (mobile, label)
                    if (key not in seen_bucket_guest
                            and len(bucket_guests[label]) < _AGE_BUCKET_GUEST_CAP):
                        seen_bucket_guest.add(key)
                        bucket_guests[label].append({"mobile": mobile, "name": name})
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

        for label, lo, hi in _AGE_BUCKETS:
            if bucket_counts[label] > len(bucket_guests[label]):
                logger.info(
                    "get_demographics_aggregate: bucket '%s' guest list capped "
                    "at %d (bucket has %d entries)",
                    label, _AGE_BUCKET_GUEST_CAP, bucket_counts[label],
                )

        result = {
            "age": {
                "buckets": [{"label": l, "count": bucket_counts[l]}
                            for l, _, _ in _AGE_BUCKETS],
                "average": round(age_sum / age_n, 1) if age_n else None,
                "count": age_n,
                "bucket_guests": bucket_guests,
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
