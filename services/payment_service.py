"""
Payment Service — manages the normalised `payments` collection.

Each payment is stored as an **individual Firestore document** instead of
being appended to a growing array inside a single document (the old `logs`
collection pattern).

Design principles:
  • This is an *optimisation layer* — the old `logs` collection continues to
    receive writes (dual-write) so the frontend is never broken.
  • Every public function is wrapped in try/except and logs failures without
    raising, so a payments-collection bug can never take down the app.
  • All timestamps use Asia/Kolkata (IST).
"""

import hashlib
import logging
import threading
from datetime import datetime, timedelta, timezone
from firebase_admin import firestore as fa_firestore

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Collection reference (set once from app.py at startup)
# ---------------------------------------------------------------------------
_payments_ref = None
_db = None


def init(db):
    """Call once at app startup to inject the Firestore client."""
    global _payments_ref, _db
    _db = db
    _payments_ref = db.collection("payments")
    logger.info("PaymentService initialised (payments collection)")


# ---------------------------------------------------------------------------
# WRITE — fire-and-forget in a daemon thread so it never blocks the request
# ---------------------------------------------------------------------------
def write_payment(payment_data: dict, *, batch=None) -> bool:
    """
    Write a single payment document to the `payments` collection.

    If a Firestore `batch` is supplied the write is added to that batch
    (caller must commit). Otherwise the write happens asynchronously in a
    background thread.

    Required fields in `payment_data`:
        room, name, amount, method, type, date, time

    Optional:
        serial_number, stay_room_key, item, note, booking_id,
        settlement_id, transaction_type, is_fresh_checkin, mobile,
        quantity, unit_price, payment_method, reason, ...

    Returns True if the write was dispatched/queued, False if service is not
    initialised.
    """
    if _payments_ref is None:
        return False  # service not initialised

    doc = _normalise(payment_data)

    if batch is not None:
        try:
            batch.set(_payments_ref.document(), doc)
            return True
        except Exception as e:
            logger.error(f"PaymentService batch-write failed: {e}")
            return False
    else:
        # Async — never block the HTTP response
        threading.Thread(target=_write_async, args=(doc,), daemon=True).start()
        return True


def write_payment_sync(payment_data: dict) -> bool:
    """
    Blocking write — used in migration or where ordering matters.
    Returns True on success, False on failure.
    """
    if _payments_ref is None:
        return False
    try:
        doc = _normalise(payment_data)
        _payments_ref.document().set(doc)
        return True
    except Exception as e:
        logger.error(f"PaymentService sync-write failed: {e}")
        return False


def _write_async(doc: dict):
    try:
        _payments_ref.document().set(doc)
    except Exception as e:
        logger.error(f"PaymentService async-write failed: {e}")


# ---------------------------------------------------------------------------
# STRICT WRITER — requires a stay_id (canonical foreign key). Phase-1 helper:
# call sites are migrated to this in Phase 3, replacing the legacy
# write_payment / write_payment_sync calls. Until then this lives alongside
# the legacy writers and changes nothing about their behaviour.
#
# Why a separate function: the legacy writer accepts payments without a
# foreign key to the stay (the bug we're fixing). Adding a required field
# to the legacy writer's signature would break every existing call site.
# A new function gives the migration a clean cut-over per call site.
# ---------------------------------------------------------------------------

class MissingStayIdError(ValueError):
    """Raised when a strict-mode payment write is attempted without a stay_id."""
    pass


def write_payment_with_stay(stay_id: str, payment_data: dict, *,
                             batch=None, sync: bool = False,
                             verify_exists: bool = False) -> bool:
    """
    Strict payment writer. Refuses to write unless `stay_id` is a non-empty
    string. Optionally verifies the stay_id resolves to a real bill doc
    (one extra Firestore read; off by default).

    Behaviour matches `write_payment` otherwise — async by default, batched
    if `batch` is provided, blocking if `sync=True`.

    Parameters
    ----------
    stay_id : str
        The bill doc ID this payment belongs to. REQUIRED — empty/None raises.
    payment_data : dict
        Same shape as the legacy write_payment input. The function adds
        `stay_id` to the doc; caller does not need to put it there.
    batch : firestore.WriteBatch, optional
        If provided, the write is added to the batch (caller commits).
    sync : bool
        If True, write blocks; otherwise async daemon thread.
    verify_exists : bool
        If True, performs a Firestore .exists check on the stay_id before
        writing. Adds one round-trip; use only on critical paths.

    Returns
    -------
    bool
        True on success or successful dispatch. False on Firestore error.

    Raises
    ------
    MissingStayIdError
        If `stay_id` is missing, empty, or whitespace-only.
    """
    if not stay_id or not isinstance(stay_id, str) or not stay_id.strip():
        raise MissingStayIdError(
            "write_payment_with_stay requires a non-empty stay_id. "
            "Every payment must be linked to a bill document; the stay_id "
            "is the canonical foreign key. See docs/STAY_DOC_CONTRACT.md."
        )

    if _payments_ref is None:
        return False

    if verify_exists:
        # Lazy import to avoid a circular dependency at module-load time.
        try:
            from services import bills_service
            if not bills_service.exists(stay_id):
                logger.error(
                    f"write_payment_with_stay: stay_id={stay_id} does not "
                    f"resolve to a bill doc; refusing to write orphan payment"
                )
                return False
        except Exception as e:
            # If verification itself fails (transient Firestore error), log
            # and proceed — better to write the payment than to lose it.
            logger.warning(f"write_payment_with_stay verify_exists check "
                           f"errored, proceeding anyway: {e}")

    doc = _normalise(payment_data)
    doc["stay_id"] = stay_id

    if batch is not None:
        try:
            batch.set(_payments_ref.document(), doc)
            return True
        except Exception as e:
            logger.error(f"write_payment_with_stay batch-write failed: {e}")
            return False

    if sync:
        try:
            _payments_ref.document().set(doc)
            return True
        except Exception as e:
            logger.error(f"write_payment_with_stay sync-write failed: {e}")
            return False

    threading.Thread(target=_write_async, args=(doc,), daemon=True).start()
    return True


def _safe_userid_from_request() -> str:
    """
    Best-effort lookup of the current authenticated user's userId for
    attribution stamping. Returns "system" outside a request context
    (background threads, retries, etc.). Never raises.
    """
    try:
        from flask import g, has_request_context
        if not has_request_context():
            return "system"
        u = getattr(g, "current_user", None) or {}
        return u.get("userId") or "system"
    except Exception:
        return "system"


def _normalise(data: dict) -> dict:
    """
    Ensure consistent field names and add created_at + idempotency_key.
    Copies data so the caller's dict is not mutated.
    """
    doc = dict(data)  # shallow copy
    doc.setdefault("created_at", datetime.now(timezone.utc).isoformat())
    # Attribution — who recorded this payment. Resolved from flask.g
    # at the moment write_payment is called; falls back to "system"
    # for background-thread / non-request contexts.
    if "createdBy" not in doc:
        doc["createdBy"] = _safe_userid_from_request()
    # Guarantee room is a string
    if "room" in doc:
        doc["room"] = str(doc["room"])
    # Ensure amount is int
    if "amount" in doc:
        try:
            doc["amount"] = int(doc["amount"])
        except (ValueError, TypeError):
            doc["amount"] = 0
    # Fix 16: stable idempotency key for duplicate detection/auditing
    # Key is a short hash of the fields that uniquely identify a payment event
    if "idempotency_key" not in doc:
        key_src = "|".join([
            str(doc.get("room", "")),
            str(doc.get("name", "")),
            str(doc.get("amount", 0)),
            str(doc.get("method", "")),
            str(doc.get("type", "")),
            str(doc.get("date", "")),
            str(doc.get("time", "")),
        ])
        doc["idempotency_key"] = hashlib.md5(key_src.encode()).hexdigest()[:16]
    return doc


# ---------------------------------------------------------------------------
# READ — targeted Firestore queries replacing get_all_logs() full downloads
# ---------------------------------------------------------------------------

def query_payments_for_stay(room, guest_name, checkin_dt, stay_id=None):
    """
    Return all payment docs for a specific room stay.

    Strategy — four queries merged and deduplicated, run in PARALLEL:
      Q0. stay_id == X                                       (canonical foreign key,
          single-field equality, fastest. Skipped if stay_id is None.)
      Q1. room == X AND name == Y AND date >= checkin_date   (normal payments)
      Q2. stay_room_key == "{room}_{checkin_datetime}"       (booking advances
          paid pre-checkin; linked at conversion via stay_room_key)
      Q3. room == X AND type == "booking_advance"            (legacy fallback for
          unlinked booking advances; Python-filtered by guest+date)

    The four queries each take 0.5–1.5s against Firestore; running them
    sequentially was the 5s bottleneck on /get_history. ThreadPoolExecutor
    issues them concurrently — wall-clock collapses to roughly the slowest
    single query.

    Falls back to empty list on any error.
    """
    if _payments_ref is None:
        return []

    checkin_date_str = checkin_dt.strftime("%Y-%m-%d")
    checkin_dt_str   = checkin_dt.strftime("%Y-%m-%d %H:%M")
    room_str = str(room)

    # ─── Query callables (each returns list of (doc_id, doc_dict)) ────────
    def _run_q0():
        if not stay_id:
            return []
        try:
            q = _payments_ref.where(
                filter=fa_firestore.FieldFilter("stay_id", "==", stay_id)
            )
            return [(d.id, d.to_dict()) for d in q.stream()]
        except Exception as e:
            logger.warning(f"PaymentService query_payments_for_stay Q0 failed: {e}")
            return []

    def _run_q1():
        try:
            q = (
                _payments_ref
                .where(filter=fa_firestore.FieldFilter("room", "==", room_str))
                .where(filter=fa_firestore.FieldFilter("name", "==", guest_name))
                .where(filter=fa_firestore.FieldFilter("date", ">=", checkin_date_str))
            )
            return [(d.id, d.to_dict()) for d in q.stream()]
        except Exception as e:
            logger.error(f"PaymentService query_payments_for_stay Q1 failed: {e}")
            return []

    def _run_q2():
        try:
            stay_key = f"{room_str}_{checkin_dt_str}"
            q = _payments_ref.where(
                filter=fa_firestore.FieldFilter("stay_room_key", "==", stay_key)
            )
            return [(d.id, d.to_dict()) for d in q.stream()]
        except Exception as e:
            logger.warning(f"PaymentService query_payments_for_stay Q2 failed: {e}")
            return []

    def _run_q3():
        # Legacy fallback for booking advances NOT linked via stay_room_key.
        # We Python-filter by guest_name + date < checkin_date so older stays'
        # advances don't leak in.
        try:
            q = (
                _payments_ref
                .where(filter=fa_firestore.FieldFilter("room", "==", room_str))
                .where(filter=fa_firestore.FieldFilter("type",  "==", "booking_advance"))
            )
            out = []
            backfill_targets = []
            for doc in q.stream():
                pdata = doc.to_dict()
                if (pdata.get("name") == guest_name
                        and pdata.get("date", "9999-99-99") < checkin_date_str):
                    out.append((doc.id, pdata))
                    # Don't run the backfill .update() inline — that's a
                    # write per stale row and extends the request. Capture
                    # the refs so we can fire-and-forget them after the
                    # response is dispatched.
                    backfill_targets.append(doc.reference)
            # Backfill stay_room_key in a daemon thread so future Q2 calls
            # find these advances directly. Failure is silent — Q3 keeps
            # working as the safety net.
            if backfill_targets:
                _bg_backfill_stay_room_key(
                    backfill_targets, room_str, checkin_dt_str, checkin_date_str
                )
            return out
        except Exception as e:
            logger.warning(f"PaymentService query_payments_for_stay Q3 failed: {e}")
            return []

    # ─── Fast path: stay_id Q0 short-circuit ──────────────────────────────
    # When the caller has the canonical foreign key (the case for every
    # stay created post Phase-2), Q0 alone returns the full set in a
    # single-field equality query — typically 200–400ms. Q1/Q2/Q3 are
    # legacy safety nets only — they exist to catch payments written
    # before stay_id stamping, or booking advances paid pre-checkin and
    # never linked. If Q0 returns ANY row, those fallbacks would only
    # add duplicates that the dedup step already drops; running them
    # adds round-trips for no signal. Skip and return.
    if stay_id:
        q0_hits = _run_q0()
        if q0_hits:
            seen_ids = set()
            results = []
            for doc_id, doc_dict in q0_hits:
                if doc_id in seen_ids:
                    continue
                seen_ids.add(doc_id)
                results.append(doc_dict)
            return _dedup_payments(results)

    # ─── Slow path: legacy/incomplete data — run Q1/Q2/Q3 in parallel ──
    # Either no stay_id was provided, or the stay predates Phase-2 and
    # has no payments stamped with stay_id yet. We need the legacy
    # heuristics. Parallelize so wall-clock = slowest single query.
    from concurrent.futures import ThreadPoolExecutor
    seen_ids = set()
    results = []
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(fn) for fn in (_run_q1, _run_q2, _run_q3)]
        for fut in futures:
            for doc_id, doc_dict in fut.result():
                if doc_id in seen_ids:
                    continue
                seen_ids.add(doc_id)
                results.append(doc_dict)

    return _dedup_payments(results)


def _bg_backfill_stay_room_key(refs, room_str, checkin_dt_str, checkin_date_str):
    """Fire-and-forget backfill for legacy booking-advance docs.

    Q3 runs only when a pre-checkin advance hasn't yet been stamped with
    stay_room_key. Once we've identified those docs we stamp them so Q2
    finds them next time and Q3 is no longer needed for this stay.
    """
    def _do():
        for ref in refs:
            try:
                ref.update({
                    "stay_room_key":     f"{room_str}_{checkin_dt_str}",
                    "stay_checkin_date": checkin_date_str,
                })
            except Exception:
                pass
    threading.Thread(target=_do, daemon=True).start()


def _dedup_payments(payments: list) -> list:
    """
    Remove duplicate payment docs that arise when migration + live writes
    both exist for the same transaction (different doc IDs, same content).

    Deduplicates by (room, name, amount, date, time, type).
    When a duplicate is found, the live-written doc (migrated != True)
    is preferred over the migrated copy.
    """
    seen_fps = set()
    deduped = []
    for p in payments:
        fp = (
            str(p.get("room", "")),
            str(p.get("name", "")),
            str(p.get("amount", "")),
            str(p.get("date", "")),
            str(p.get("time", "")),
            str(p.get("type", "")),
        )
        if fp not in seen_fps:
            seen_fps.add(fp)
            deduped.append(p)
        elif p.get("migrated") is not True:
            # Replace the previously added migrated doc with the live one
            for i, existing in enumerate(deduped):
                efp = (
                    str(existing.get("room", "")),
                    str(existing.get("name", "")),
                    str(existing.get("amount", "")),
                    str(existing.get("date", "")),
                    str(existing.get("time", "")),
                    str(existing.get("type", "")),
                )
                if efp == fp and existing.get("migrated") is True:
                    deduped[i] = p
                    break
    return deduped


def query_payments_by_date_range(start_date: str, end_date: str,
                                  method: str = None):
    """
    Return payments within [start_date, end_date) (ISO strings).
    Optionally filter by method (cash / online / balance / ...).
    """
    if _payments_ref is None:
        return []
    try:
        query = (
            _payments_ref
            .where(filter=fa_firestore.FieldFilter("date", ">=", start_date))
            .where(filter=fa_firestore.FieldFilter("date", "<", end_date))
        )
        if method:
            query = query.where(
                filter=fa_firestore.FieldFilter("method", "==", method)
            )
        return _dedup_payments([doc.to_dict() for doc in query.stream()])
    except Exception as e:
        logger.error(f"PaymentService query_payments_by_date_range failed: {e}")
        return []


def query_payments_by_room_date(room: str, date_str: str):
    """
    Return all payments for a room on a specific date.
    Useful for serial-number lookups.
    """
    if _payments_ref is None:
        return []
    try:
        query = (
            _payments_ref
            .where(filter=fa_firestore.FieldFilter("room", "==", str(room)))
            .where(filter=fa_firestore.FieldFilter("date", "==", date_str))
        )
        return [doc.to_dict() for doc in query.stream()]
    except Exception as e:
        logger.error(f"PaymentService query_payments_by_room_date failed: {e}")
        return []


def find_serial_number(room, guest_name, checkin_dt):
    """
    Find the serial number for a check-in from the payments collection.

    Search order:
      1. Exact date match with serial_number present
      2. Any payment from the stay period with serial_number

    Returns int or None.
    """
    if _payments_ref is None:
        return None
    try:
        room_str = str(room)
        checkin_date = checkin_dt.strftime("%Y-%m-%d")

        # 1. Exact date match — most reliable
        docs = query_payments_by_room_date(room_str, checkin_date)
        for doc in docs:
            if doc.get("name") == guest_name:
                sn = doc.get("serial_number")
                if sn and sn != 0:
                    return int(sn)

        # 2. Broader: any payment from stay
        stay_docs = query_payments_for_stay(room_str, guest_name, checkin_dt)
        for doc in stay_docs:
            sn = doc.get("serial_number")
            if sn and sn != 0:
                return int(sn)

        return None
    except Exception as e:
        logger.error(f"PaymentService find_serial_number failed: {e}")
        return None


def sum_payments_for_stay(room, guest_name, checkin_dt, method=None):
    """
    Sum payment amounts for a specific stay.
    If method is specified (e.g. 'cash'), only sum that method.
    """
    docs = query_payments_for_stay(str(room), guest_name, checkin_dt)
    total = 0
    for doc in docs:
        if method and doc.get("method") != method:
            continue
        # Exclude refunds, settlements-negative, etc. from positive sums
        ptype = doc.get("type", "")
        if ptype in ("refund", "checkout_refund", "manual_refund", "booking_cancel_refund"):
            continue
        total += doc.get("amount", 0)
    return total


def get_stay_services(room, checkin_dt):
    """
    Return add-on/service payments for a room stay.
    """
    if _payments_ref is None:
        return []
    try:
        checkin_date_str = checkin_dt.strftime("%Y-%m-%d")
        query = (
            _payments_ref
            .where(filter=fa_firestore.FieldFilter("room", "==", str(room)))
            .where(filter=fa_firestore.FieldFilter("type", "==", "addon"))
            .where(filter=fa_firestore.FieldFilter("date", ">=", checkin_date_str))
        )
        return [doc.to_dict() for doc in query.stream()]
    except Exception as e:
        logger.error(f"PaymentService get_stay_services failed: {e}")
        return []


def get_stay_refunds(room, guest_name, checkin_dt):
    """Return refund payments for a specific stay."""
    docs = query_payments_for_stay(str(room), guest_name, checkin_dt)
    return [
        d for d in docs
        if d.get("type") in ("refund", "checkout_refund", "manual_refund",
                              "booking_cancel_refund")
    ]


def update_payments_room(old_room, new_room, guest_name, checkin_dt):
    """
    Update room number in payments when a guest is transferred.
    Runs in background to not block the transfer.
    """
    if _payments_ref is None:
        return

    def _update():
        try:
            docs = query_payments_for_stay(str(old_room), guest_name, checkin_dt)
            if not docs:
                return
            # Re-query to get document references
            checkin_date_str = checkin_dt.strftime("%Y-%m-%d")
            query = (
                _payments_ref
                .where(filter=fa_firestore.FieldFilter("room", "==", str(old_room)))
                .where(filter=fa_firestore.FieldFilter("name", "==", guest_name))
                .where(filter=fa_firestore.FieldFilter("date", ">=", checkin_date_str))
            )
            batch = _db.batch()
            count = 0
            for doc_snap in query.stream():
                batch.update(doc_snap.reference, {
                    "room": str(new_room),
                    "old_room": str(old_room),
                    "room_shifted": True,
                })
                count += 1
                if count >= 400:
                    batch.commit()
                    batch = _db.batch()
            if count % 400 != 0:
                batch.commit()
            logger.info(f"PaymentService: updated {count} payment docs "
                        f"room {old_room} -> {new_room}")
        except Exception as e:
            logger.error(f"PaymentService update_payments_room failed: {e}")

    threading.Thread(target=_update, daemon=True).start()


def check_duplicate(room, name, amount, date, time_str, txn_type):
    """
    Check if a payment already exists (for migration idempotency).
    Returns True if a matching document exists.
    """
    if _payments_ref is None:
        return False
    try:
        query = (
            _payments_ref
            .where(filter=fa_firestore.FieldFilter("room", "==", str(room)))
            .where(filter=fa_firestore.FieldFilter("name", "==", name))
            .where(filter=fa_firestore.FieldFilter("amount", "==", int(amount)))
            .where(filter=fa_firestore.FieldFilter("date", "==", date))
            .where(filter=fa_firestore.FieldFilter("time", "==", time_str))
            .limit(1)
        )
        return len(list(query.stream())) > 0
    except Exception as e:
        logger.error(f"PaymentService check_duplicate failed: {e}")
        return False
