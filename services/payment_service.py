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
    LEGACY writer. Prefer `write_payment_with_stay` for any payment that
    belongs to an active stay. This entry point now enforces a minimum
    referential-integrity contract:

        Every payment row MUST carry at least one foreign key out of
        (stay_id, booking_id, settlement_id). A row that has none is
        rejected -- that is the exact anti-pattern that orphans payments
        from the bill (the missing-Rs.250 class of bug).

    The intent is to keep call sites that genuinely operate before a
    stay_id exists (booking advances, OTA settlement rows) working, while
    making it impossible to silently write an unlinked mid-stay payment.

    A deprecation warning is logged on every call. New call sites should
    use `write_payment_with_stay`.

    Required fields in `payment_data`:
        room, name, amount, method, type, date, time
        AND at least one of: stay_id, booking_id, settlement_id

    Returns True on dispatch/queue, False if rejected or service is not
    initialised.
    """
    if _payments_ref is None:
        return False  # service not initialised

    # Referential-integrity gate. Empty strings count as missing.
    def _present(v):
        if v is None:
            return False
        if isinstance(v, str):
            return bool(v.strip())
        return bool(v)

    _sid    = payment_data.get("stay_id")
    _bid    = payment_data.get("booking_id")
    _setid  = payment_data.get("settlement_id")
    _srkey  = payment_data.get("stay_room_key")
    has_strong_fk = _present(_sid) or _present(_bid) or _present(_setid)
    has_weak_fk   = _present(_srkey)

    if not (has_strong_fk or has_weak_fk):
        logger.error(
            "PaymentService.write_payment REFUSED: no FK on payment "
            "(stay_id/booking_id/settlement_id/stay_room_key). "
            "type=%r room=%r amount=%r. "
            "Use write_payment_with_stay() or set booking_id on the row.",
            payment_data.get("type"),
            payment_data.get("room"),
            payment_data.get("amount"),
        )
        return False

    if not has_strong_fk:
        # Only stay_room_key is present -- this is the legacy soft-FK path
        # used by pre-migration stays whose room has no active_bill_id yet.
        # Permitted for backward compatibility, but logged loudly so the
        # remaining call sites can be migrated and the path retired.
        logger.warning(
            "PaymentService.write_payment: LEGACY SOFT-FK write "
            "(stay_room_key only, no stay_id/booking_id/settlement_id). "
            "type=%r room=%r stay_room_key=%r. "
            "Mint a draft bill via bills_service.create_draft() and switch "
            "to write_payment_with_stay() to retire this path.",
            payment_data.get("type"),
            payment_data.get("room"),
            _srkey,
        )
    else:
        logger.warning(
            "PaymentService.write_payment is deprecated; prefer "
            "write_payment_with_stay(stay_id, ...). "
            "type=%r room=%r has_stay=%s has_booking=%s has_settlement=%s",
            payment_data.get("type"),
            payment_data.get("room"),
            _present(_sid), _present(_bid), _present(_setid),
        )

    doc = _normalise(payment_data)

    if batch is not None:
        try:
            batch.set(_payments_ref.document(), doc)
            return True
        except Exception as e:
            logger.error(f"PaymentService batch-write failed: {e}")
            return False
    else:
        # Async -- never block the HTTP response
        threading.Thread(target=_write_async, args=(doc,), daemon=True).start()
        return True


def write_payment_sync(payment_data: dict) -> bool:
    """
    Blocking write -- used in migration or where ordering matters.

    Subject to the same FK gate as write_payment(): rows with no
    stay_id / booking_id / settlement_id are rejected.

    Returns True on success, False on failure.
    """
    if _payments_ref is None:
        return False
    # FK gate -- mirror write_payment().
    def _present(v):
        if v is None:
            return False
        if isinstance(v, str):
            return bool(v.strip())
        return bool(v)
    if not (
        _present(payment_data.get("stay_id"))
        or _present(payment_data.get("booking_id"))
        or _present(payment_data.get("settlement_id"))
        or _present(payment_data.get("stay_room_key"))   # transitional weak FK
    ):
        logger.error(
            "PaymentService.write_payment_sync REFUSED: no FK on payment "
            "(stay_id/booking_id/settlement_id/stay_room_key). "
            "type=%r room=%r amount=%r.",
            payment_data.get("type"),
            payment_data.get("room"),
            payment_data.get("amount"),
        )
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
        return
    # Legacy rows may still carry a stay_id — keep the room-doc stay sums
    # fresh for them too (no-op when the stay isn't live on a room).
    _sid = doc.get("stay_id")
    if _sid:
        refresh_room_stay_aggregates(_sid)


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
    # Recompute the idempotency_key now that stay_id is on the doc, so
    # the key is scoped to this stay. Without this, two stays with
    # otherwise-identical payment payloads could share a key.
    doc["idempotency_key"] = _compute_idempotency_key(doc)

    # Idempotent-write check. If a payment with this exact key was
    # written to this stay within the last 5 seconds, treat the current
    # call as a retry and skip the write. This is the write-side
    # defence that prevents duplicate payment docs from being created
    # by network retries or double-clicks. The corresponding read-side
    # tolerance lives in _dedup_payments (which preserves live-vs-live
    # collisions; this check is what stops them happening in the first
    # place).
    _existing_id = _check_idempotent_hit(stay_id, doc["idempotency_key"])
    if _existing_id:
        logger.info(
            "write_payment_with_stay: idempotent hit on stay_id=%s "
            "key=%s -> existing doc %s; skipping duplicate write",
            stay_id, doc["idempotency_key"], _existing_id,
        )
        return True

    # Pre-mint the doc reference so we know the ID *before* the write,
    # which lets us hand it to the banking trigger hook below regardless
    # of write mode (batch / sync / async).
    new_ref = _payments_ref.document()

    if batch is not None:
        try:
            batch.set(new_ref, doc)
            # NOTE: batch-write callers commit the batch themselves. The
            # banking trigger is therefore NOT fired here — firing it now
            # would query Firestore for prior cash payments that haven't
            # been flushed yet. Batch callers that want the trigger must
            # call cash_receipts.issue_receipt_for_new_payment(stay_id,
            # new_ref.id, method=...) after their commit succeeds.
            return True
        except Exception as e:
            logger.error(f"write_payment_with_stay batch-write failed: {e}")
            return False

    if sync:
        try:
            new_ref.set(doc)
            _fire_banking_hook(stay_id, new_ref.id, doc)
            # Stay-sums stamp runs in the background even on the sync path —
            # the caller wanted a blocking WRITE, not a blocking aggregate.
            threading.Thread(
                target=refresh_room_stay_aggregates,
                args=(stay_id,), daemon=True,
            ).start()
            return True
        except Exception as e:
            logger.error(f"write_payment_with_stay sync-write failed: {e}")
            return False

    # Async path. Stamp the doc + fire the banking hook on the daemon
    # thread so the HTTP response is unblocked. Banking-trigger latency
    # (one read query + one transaction) is acceptable in the background.
    threading.Thread(
        target=_write_async_with_hook,
        args=(new_ref, doc, stay_id),
        daemon=True,
    ).start()
    return True


# ---------------------------------------------------------------------------
# Room-doc stay aggregates (register fast path)
# ---------------------------------------------------------------------------
# After any payment write for an ACTIVE stay, recompute the stay's cash /
# online receipt sums and stamp them onto the room document:
#
#   stay_payment_cash / stay_payment_online — drawer sums; refunds and
#       discount/expense rows excluded (same population the register's
#       active-room rows display)
#   stay_payment_for       — the stay_id the sums belong to, so a stale
#       stamp can never leak into the next stay on the same room
#   stay_payment_synced_at — IST timestamp, for debugging
#
# The register endpoint reads these straight off the room docs it already
# fetched and skips its per-room payments query. Stays without a valid
# stamp (checked in before this deploy, or a stamp write that failed)
# transparently fall back to the live query — correctness never depends on
# the stamp existing. Recompute-and-stamp (rather than increments) keeps
# the value self-correcting: every stamp is a fresh aggregate of the
# authoritative payment rows. Checkout clears the fields and recomputes the
# final bill from the payments collection as before, so any residual drift
# on an active stay can never reach an invoice.

_STAY_AGG_EXCLUDED_TYPES = frozenset({
    "refund", "checkout_refund", "manual_refund", "booking_cancel_refund",
    "discount", "expense",
})


# ---------------------------------------------------------------------------
# VOID SEMANTICS — one definition, used everywhere money is counted
# ---------------------------------------------------------------------------

def is_live_charge(row) -> bool:
    """
    True when a payment / add-on row still counts toward money.

    A voided row is kept, not deleted: it stays in `room.add_ons` and in the
    `payments` collection so a stay's history stays complete and a mistaken
    void is recoverable. But it must contribute NOTHING to any total.

    This is the single definition. The bill, the daily folio, the balance
    preview, the payment modal and the stay aggregates all call it, so a
    voided line cannot survive in one of them and quietly vanish from
    another. If you add a new place that sums charges, call this — do not
    write `not row.get("voided")` by hand.

    Lives in payment_service because it has no dependencies, so config.py,
    routes/rooms.py and routes/billing.py can all import it without a cycle.
    """
    if not isinstance(row, dict):
        return False
    return not row.get("voided")


def refresh_room_stay_aggregates(stay_id: str) -> bool:
    """
    Recompute cash/online sums for `stay_id` and stamp them onto the room
    doc currently holding that stay (room.active_bill_id == stay_id).
    No-op when the stay isn't live on any room (already checked out).
    Never raises — safe to call from background threads.
    """
    if _db is None or not stay_id:
        return False
    try:
        room_ref = None
        room_q = (
            _db.collection("rooms")
            .where(filter=fa_firestore.FieldFilter("active_bill_id", "==", stay_id))
            .limit(1)
            .stream()
        )
        for snap in room_q:
            room_ref = snap.reference
        if room_ref is None:
            return False  # stay not live on any room — nothing to stamp

        payments = query_payments_by_stay_id(stay_id)
        cash = sum(
            p.get("amount", 0) for p in payments
            if p.get("method") == "cash"
            and p.get("type") not in _STAY_AGG_EXCLUDED_TYPES
            and is_live_charge(p)
        )
        online = sum(
            p.get("amount", 0) for p in payments
            if p.get("method") == "online"
            and p.get("type") not in _STAY_AGG_EXCLUDED_TYPES
            and is_live_charge(p)
        )

        _ist = timezone(timedelta(hours=5, minutes=30))
        # Transactional re-check: a concurrent checkout may have cleared the
        # room (active_bill_id -> None) AFTER our query matched it. Without
        # this guard a late-firing thread could re-stamp stale sums onto a
        # room that has already been checked out and possibly re-occupied.
        # The transaction re-reads active_bill_id and only stamps if the room
        # is still live on THIS stay.
        @fa_firestore.transactional
        def _stamp(txn, ref):
            snap = ref.get(transaction=txn)
            if not snap.exists:
                return False
            if (snap.to_dict() or {}).get("active_bill_id") != stay_id:
                return False  # room moved on (checked out / re-occupied)
            txn.update(ref, {
                "stay_payment_cash": cash,
                "stay_payment_online": online,
                "stay_payment_for": stay_id,
                "stay_payment_synced_at": datetime.now(_ist).strftime("%Y-%m-%d %H:%M:%S"),
            })
            return True
        if not _stamp(_db.transaction(), room_ref):
            return False  # stay no longer live on this room — skip stamp

        # The register reads rooms through config.get_all_rooms() (30s TTL);
        # bust it so fresh sums are visible on the next register load.
        # Lazy import avoids a circular dependency at module-load time.
        try:
            from config import invalidate_rooms_and_totals
            invalidate_rooms_and_totals()
        except Exception:
            pass
        return True
    except Exception as e:
        logger.warning(f"refresh_room_stay_aggregates({stay_id}) failed: {e}")
        return False


# ---------------------------------------------------------------------------
# Banking trigger hook
# ---------------------------------------------------------------------------
# These are the inflow methods that participate in the deposit / receipt-
# voucher workflow. Anything else (refund, discount, expense, balance,
# pay_later, settlement, ...) is silently ignored — the trigger only
# cares about real money coming IN.

_BANKING_CASH_METHODS = frozenset({"cash"})
_BANKING_ONLINE_METHODS = frozenset({"online", "upi", "card", "bank_transfer"})

# Mirrors the exclusion list used by config.sum_payments_for_stay so the
# trigger sees the same row population the totals computation does.
_BANKING_EXCLUDED_TYPES = frozenset({
    "refund", "checkout_refund", "manual_refund", "booking_cancel_refund",
    "discount", "expense",
})


def _fire_banking_hook(stay_id: str, payment_id: str, doc: dict) -> None:
    """
    Best-effort hook called after a successful payment write. Fires
    cash_receipts.issue_receipt_for_new_payment(...) when the payment
    is a real inflow that participates in the receipt-voucher flow.

    Never raises — banking failures must not regress payment recording.
    """
    try:
        method_raw = (doc.get("method") or "").lower().strip()
        type_raw   = (doc.get("type")   or "").lower().strip()
        if not stay_id or not payment_id:
            return
        if type_raw in _BANKING_EXCLUDED_TYPES:
            return
        # Negative amounts are also refunds-by-shape; skip them.
        try:
            if int(doc.get("amount") or 0) <= 0:
                return
        except (TypeError, ValueError):
            return
        if method_raw in _BANKING_CASH_METHODS:
            method = "cash"
        elif method_raw in _BANKING_ONLINE_METHODS:
            method = "online"
        else:
            return
        # Local import — banking package may not be initialised in some
        # legacy test paths. Falling back silently is correct here.
        from services.banking import cash_receipts
        cash_receipts.issue_receipt_for_new_payment(
            stay_id, payment_id, method=method,
        )
    except Exception as e:
        logger.warning(
            f"_fire_banking_hook({stay_id}, {payment_id}) failed: {e}"
        )


def _write_async_with_hook(new_ref, doc: dict, stay_id: str) -> None:
    """Async write that also fires the banking trigger after commit."""
    try:
        new_ref.set(doc)
    except Exception as e:
        logger.error(f"PaymentService async-write failed: {e}")
        return
    _fire_banking_hook(stay_id, new_ref.id, doc)
    # Keep the room doc's denormalized stay sums in step with the payment
    # rows (register fast path). Runs on this daemon thread — never blocks
    # the request, never raises.
    refresh_room_stay_aggregates(stay_id)


def _safe_userid_from_request() -> str:
    """
    Best-effort lookup of the current authenticated user's userId for
    attribution stamping. Returns "system" only when there genuinely is no
    human behind the write. Never raises.

    Why this reads the token and not just flask.g
    ---------------------------------------------
    `g.current_user` is populated by exactly two places: the
    @login_required and @requires_permission decorators (auth_service.py).
    Nothing sets it in a before_request hook. So on any route that carries
    neither decorator, `g.current_user` is simply absent — even though the
    request has a perfectly valid bearer token and a real logged-in user.

    Several payment-writing routes are in that position: /checkin,
    /checkout, /add_on, /renew_rent, /transfer_room and
    /collect_settlement. Every payment they wrote was stamped
    createdBy="system", and the user directory renders "system" as the
    literal name "System" — so the Transactions list showed a machine as
    the author of work a member of staff had just done.

    Falling back to load_current_user() resolves the user from the request's
    own Authorization header, which is present regardless of decorators. It
    costs one token verification on the paths that were previously losing
    attribution, and nothing at all on the decorated paths, which still hit
    the `g` fast path first.

    "system" remains the correct answer, and is still returned, for writes
    with no request at all: background threads, OTA/ingest jobs and cron.
    Those rows genuinely have no human author and must not be given a fake
    one.
    """
    try:
        from flask import g, has_request_context
        if not has_request_context():
            return "system"

        # Fast path — a decorated route already resolved the user.
        u = getattr(g, "current_user", None) or {}
        uid = u.get("userId")
        if uid:
            return uid

        # Undecorated route: resolve from the token this request carries.
        # Imported lazily to keep payment_service free of an import-time
        # dependency on the auth layer.
        try:
            from services import auth_service
            user = auth_service.load_current_user()
        except Exception:  # noqa: BLE001
            user = None
        if user and user.get("userId"):
            # Cache it so anything later in this request (audit_log's
            # _safe_user, attribution_update, a second payment write) gets
            # the same answer without verifying the token again.
            try:
                g.current_user = user
            except Exception:  # noqa: BLE001
                pass
            return user["userId"]

        return "system"
    except Exception:
        return "system"


def _compute_idempotency_key(doc: dict) -> str:
    """
    Build a stable 16-char hash that uniquely identifies a logical payment
    event. Broader than the original formula on purpose — it includes the
    foreign keys (stay_id / booking_id / settlement_id), transaction_type,
    and note so that two payments that look identical on
    (room, amount, method, time) but differ on (e.g.) "Day 2 rent renewal"
    vs "Day 3 rent renewal" do NOT collide. The HH:MM `time` field stays
    in the key so retries within the same minute still hash the same.

    The key is used two ways:
      1. Stamped onto every payment doc for forensic dedup-by-key reads.
      2. Queried by `_check_idempotent_hit` before write to prevent
         network-retry / double-click duplicates from entering the
         collection in the first place.
    """
    key_src = "|".join([
        str(doc.get("stay_id", "")),
        str(doc.get("booking_id", "")),
        str(doc.get("settlement_id", "")),
        str(doc.get("room", "")),
        str(doc.get("name", "")),
        str(doc.get("amount", 0)),
        str(doc.get("method", "")),
        str(doc.get("type", "")),
        str(doc.get("transaction_type", "")),
        str(doc.get("date", "")),
        str(doc.get("time", "")),
        str(doc.get("note", "")),
    ])
    return hashlib.md5(key_src.encode()).hexdigest()[:16]


def _check_idempotent_hit(stay_id: str, idem_key: str,
                          window_seconds: int = 5) -> str | None:
    """
    Return the Firestore doc ID of an existing payment with this
    idempotency_key on this stay_id, IF one was written within the last
    `window_seconds`. Otherwise return None.

    The window is intentionally short (default 5s) — long enough to catch
    network retries and double-clicks (which are typically sub-second to
    a couple of seconds apart) while still letting two genuinely-distinct
    same-fingerprint payments seconds apart both succeed. The SANDEP-class
    case (12s apart) sits OUTSIDE the window by design — both will write.

    Uses only equality filters on (stay_id, idempotency_key) so no
    Firestore composite index is required; created_at is filtered in
    Python. The compound (stay_id + idem_key) match set is tiny in
    practice (≤ a handful), so the in-memory filter is cheap.

    Fails open: if the lookup itself errors, returns None and lets the
    write proceed — losing a payment is worse than writing a duplicate.
    """
    if _payments_ref is None or not stay_id or not idem_key:
        return None
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=window_seconds)
        q = (
            _payments_ref
            .where(filter=fa_firestore.FieldFilter("stay_id", "==", stay_id))
            .where(filter=fa_firestore.FieldFilter(
                "idempotency_key", "==", idem_key))
            .limit(10)
        )
        for snap in q.stream():
            d = snap.to_dict() or {}
            ca = d.get("created_at")
            if not ca:
                continue
            try:
                ca_dt = datetime.fromisoformat(ca)
            except (ValueError, TypeError):
                continue
            if ca_dt.tzinfo is None:
                ca_dt = ca_dt.replace(tzinfo=timezone.utc)
            if ca_dt >= cutoff:
                return snap.id
        return None
    except Exception as e:
        # Fail open — the dedup check must never lose a payment.
        logger.warning(
            f"_check_idempotent_hit({stay_id}, {idem_key}) failed: {e}; "
            f"proceeding with write"
        )
        return None


def _normalise(data: dict) -> dict:
    """
    Ensure consistent field names and add created_at + idempotency_key.
    Copies data so the caller's dict is not mutated.

    Note: callers that add fields to the doc AFTER this returns (notably
    `write_payment_with_stay`, which stamps `stay_id` post-normalise)
    should recompute the idempotency_key via `_compute_idempotency_key`
    so the key reflects the final doc shape.
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
    # Stable idempotency key for duplicate detection. Broadened in the
    # SANDEP fix to include FK fields + transaction_type + note so that
    # logically-distinct payments don't share keys.
    if "idempotency_key" not in doc:
        doc["idempotency_key"] = _compute_idempotency_key(doc)
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

    Fingerprint: (room, name, amount, date, time, type).

    Collision semantics — ONLY collapse a fingerprint collision when at
    least one of the colliding docs is a migration artifact
    (``migrated=True``). Two live-vs-live collisions are PRESERVED (both
    docs kept) because two real payments can legitimately share the same
    HH:MM minute — e.g. a guest paying twice in quick succession via UPI.
    The minute-grained fingerprint is too coarse to distinguish those
    from accidental retries, so we let Firestore be the source of truth
    for live writes and only suppress known migration duplicates here.

      migrated vs migrated  -> keep first, drop second   (legacy dupe)
      migrated vs live      -> keep live, drop migrated  (live wins)
      live     vs migrated  -> keep live, drop migrated  (live wins)
      live     vs live      -> KEEP BOTH                 (real payments)

    Prevention of new same-minute collisions is the responsibility of the
    write-side idempotent check in ``write_payment_with_stay`` (see the
    finer-grained idempotency_key built from created_at).
    """
    # fp -> index of the first occurrence in `deduped`. Using a dict
    # (instead of a set) lets us replace in place when a live doc
    # supersedes a migrated one without rescanning the list.
    first_idx_by_fp: dict = {}
    deduped: list = []
    for p in payments:
        fp = (
            str(p.get("room", "")),
            str(p.get("name", "")),
            str(p.get("amount", "")),
            str(p.get("date", "")),
            str(p.get("time", "")),
            str(p.get("type", "")),
        )
        if fp not in first_idx_by_fp:
            first_idx_by_fp[fp] = len(deduped)
            deduped.append(p)
            continue

        # Fingerprint collision — decide based on migration flags.
        existing_idx = first_idx_by_fp[fp]
        existing = deduped[existing_idx]
        existing_is_migrated = existing.get("migrated") is True
        new_is_migrated      = p.get("migrated") is True

        if existing_is_migrated and not new_is_migrated:
            # migrated already in place, live arrived — live wins.
            deduped[existing_idx] = p
        elif not existing_is_migrated and new_is_migrated:
            # live already in place, migrated arrived — drop migrated.
            continue
        elif existing_is_migrated and new_is_migrated:
            # two migration dupes — keep the first, drop the second.
            continue
        else:
            # live vs live — both real, keep both. This is the fix for
            # the SANDEP-class bug where two genuine UPI payments inside
            # the same HH:MM minute were silently collapsed.
            deduped.append(p)
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
            # Re-query to get document references for the batch update.
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
            logger.info(
                f"PaymentService: updated {count} payment docs "
                f"room {old_room} -> {new_room}"
            )
        except Exception as e:
            logger.error(f"PaymentService update_payments_room failed: {e}")

    threading.Thread(target=_update, daemon=True).start()


# ---------------------------------------------------------------------------
# ADD-ON CORRECTIONS — edit / void a service already recorded against a stay
# ---------------------------------------------------------------------------

def find_addon_payment(stay_id: str, addon_uid: str = "", *,
                       room=None, item=None, amount=None,
                       date=None, time_str=None):
    """
    Locate the `payments` doc written alongside a room add-on.

    Why this exists, and why every add-on correction MUST use it:

    The guest's bill is built from the payments collection, NOT from
    `room.add_ons`. See create_bill_record — the `services` list that
    reaches compute_daily_folio is assembled by walking stay_payments where
    `type == "addon"`. `room.add_ons` drives the counter UI, the balance
    preview and the ₹999 snap, but not the invoice.

    So a correction that only touches `room.add_ons` changes what the
    operator SEES and nothing about what the guest is CHARGED. The two
    stores must move together or they silently disagree.

    Matching prefers `addon_uid`, the shared key stamped into both the room
    array entry and the payment doc by /add_on. Rows written before that
    field existed fall back to an exact content match on
    (room, item, amount, date, time) — the same fingerprint _dedup_payments
    uses. The fallback refuses to guess: if more than one row matches it
    returns "ambiguous" rather than picking one, because correcting the
    wrong line is worse than refusing the correction. A keyed row is never
    reachable by content match, so a legacy lookup cannot collide with a
    modern one.

    Returns (doc_id, doc_dict, reason). doc_id is None when nothing safe was
    found; reason is "" on success, else "not_found" or "ambiguous".
    """
    rows = [r for r in (query_payments_by_stay_id(stay_id) or [])
            if r.get("type") == "addon"]
    if not rows:
        return (None, None, "not_found")

    if addon_uid:
        hits = [r for r in rows if r.get("addon_uid") == addon_uid]
        if len(hits) == 1:
            return (hits[0].get("id"), hits[0], "")
        if len(hits) > 1:
            logger.error(
                f"find_addon_payment: {len(hits)} payment rows share "
                f"addon_uid={addon_uid} on stay {stay_id} — refusing to guess"
            )
            return (None, None, "ambiguous")
        # No keyed hit: fall through and try the legacy content match.

    def _s(v):
        return "" if v is None else str(v)

    def _i(v):
        try:
            return int(v or 0)
        except (TypeError, ValueError):
            return 0

    hits = [
        r for r in rows
        if not r.get("addon_uid")
        and _s(r.get("room")) == _s(room)
        and _s(r.get("item")) == _s(item)
        and _i(r.get("amount")) == _i(amount)
        and _s(r.get("date")) == _s(date)
        and _s(r.get("time")) == _s(time_str)
    ]
    if len(hits) == 1:
        return (hits[0].get("id"), hits[0], "")
    if len(hits) > 1:
        logger.warning(
            f"find_addon_payment: {len(hits)} legacy payment rows match "
            f"{item!r} ₹{amount} on stay {stay_id} — refusing to guess"
        )
        return (None, None, "ambiguous")
    return (None, None, "not_found")


def apply_addon_correction(doc_id: str, fields: dict) -> bool:
    """
    Write a correction onto one addon payment doc. SYNCHRONOUS on purpose.

    The async writer exists so that recording a payment never blocks the
    counter. A correction is the opposite situation: the caller has already
    adjusted the room balance and the daily totals inside a transaction and
    has to know this landed before it reports success. An async failure here
    would leave the bill and the balance permanently disagreeing, with no
    error surfaced to anyone.

    Returns True only if Firestore acknowledged the write.
    """
    if _payments_ref is None or not doc_id:
        return False
    try:
        _payments_ref.document(doc_id).update(fields)
        return True
    except Exception as e:  # noqa: BLE001
        logger.error(
            f"PaymentService apply_addon_correction({doc_id}) failed: {e}",
            exc_info=True,
        )
        return False


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


def relink_stay_payments(old_stay_id: str, new_stay_id: str, *,
                         room: str = "", checkin_time: str = "",
                         batch=None, max_ops: int = 400):
    """
    Re-point every payment row of a stay from ``old_stay_id`` to ``new_stay_id``.

    WHY THIS EXISTS
    ---------------
    ``BillsService.revert_to_draft`` cancels the original bill and mints a
    FRESH ``stay_id`` for the same, still-running stay. The payments already
    written for that stay keep the OLD stay_id, so the canonical foreign key
    silently stops pointing at the live stay.

    Every fast path in the app keys off that FK and short-circuits the moment
    it returns a single row:

      * ``config.create_bill_record._fetch_payments``  -> the re-issued bill
      * ``query_payments_for_stay`` (Q0 short-circuit) -> /get_history
      * ``routes.rooms.get_stay_payments`` (Q0)        -> Payment History UI
      * ``routes.billing.recalculate_bill``            -> stored aggregates

    So after a revert, the FIRST add-on written against the new stay_id makes
    Q0 non-empty, and every one of those callers returns just that one row.
    Prior rent, add-ons and receipts vanish from the UI *and* from the
    re-issued invoice. The guest gets under-billed and the books disagree.

    The fix is to restore the invariant rather than to defensively widen four
    separate read paths: payments of a stay carry that stay's current stay_id.

    WHAT IT TOUCHES
    ---------------
    Only the ``stay_id`` pointer. Amounts, methods, dates, ``addon_uid`` and
    every audit field are left exactly as written. ``restamped_from_stay_id``
    is stamped alongside so the original link stays visible in the document,
    and the cancelled predecessor bill still renders from its own stored
    ``services`` / ``payment_*`` fields.

    LOOKUP
    ------
    Two single-field equality queries, both index-free:
      * ``stay_id == old_stay_id``   -- rows written after stay_id stamping
      * ``stay_room_key == "{room}_{checkin_time}"`` -- booking advances and
        legacy rows that never got a stay_id

    Deliberately NOT the (room, name, date) heuristic: that one needs a
    composite index and fails open in production.

    Returns the number of rows queued for re-stamping (0 on any failure --
    this is best-effort and must never block a revert).
    """
    if _payments_ref is None or not old_stay_id or not new_stay_id:
        return 0
    if old_stay_id == new_stay_id:
        return 0

    refs = {}
    try:
        q0 = _payments_ref.where(
            filter=fa_firestore.FieldFilter("stay_id", "==", old_stay_id)
        )
        for snap in q0.stream():
            refs[snap.id] = snap.reference
    except Exception as e:
        logger.warning(f"relink_stay_payments: stay_id query failed: {e}")

    if room and checkin_time:
        try:
            stay_key = f"{room}_{checkin_time}"
            q2 = _payments_ref.where(
                filter=fa_firestore.FieldFilter("stay_room_key", "==", stay_key)
            )
            for snap in q2.stream():
                d = snap.to_dict() or {}
                # Never steal a row that already belongs to some OTHER stay.
                # An empty/absent stay_id is a legacy row for this stay.
                _sid = d.get("stay_id")
                if _sid and _sid not in (old_stay_id, new_stay_id):
                    continue
                refs[snap.id] = snap.reference
        except Exception as e:
            logger.warning(f"relink_stay_payments: stay_room_key query failed: {e}")

    if not refs:
        return 0

    targets = list(refs.values())
    if len(targets) > max_ops:
        # Firestore caps a batch at 500 writes and the caller's batch already
        # holds the room + bill updates. Refuse loudly rather than commit a
        # partial re-stamp that would leave the FK split across two stay_ids.
        logger.error(
            f"relink_stay_payments: {len(targets)} rows exceeds max_ops="
            f"{max_ops} for {old_stay_id}->{new_stay_id}; skipped"
        )
        return 0

    payload = {
        "stay_id": new_stay_id,
        "restamped_from_stay_id": old_stay_id,
    }
    try:
        local_batch = batch if batch is not None else _db.batch()
        for ref in targets:
            local_batch.update(ref, payload)
        if batch is None:
            local_batch.commit()
    except Exception as e:
        logger.error(
            f"relink_stay_payments({old_stay_id}->{new_stay_id}) failed: {e}",
            exc_info=True,
        )
        return 0

    logger.info(
        f"relink_stay_payments: {len(targets)} payment rows re-pointed "
        f"{old_stay_id} -> {new_stay_id}"
    )
    return len(targets)


def query_payments_by_stay_id(stay_id: str):
    """
    Fetch every payment row tagged with this stay_id (the canonical foreign
    key linking payments -> bill/stay).

    Use this for active-stay payment aggregation: it is a single equality
    query on the canonical FK, complete regardless of date corrections, and
    cheaper than the multi-query `query_payments_for_stay` helper (which
    exists for legacy stays that pre-date the stay_id migration).

    Notably this path DOES NOT run `_dedup_payments` -- every payment doc
    is returned by its own Firestore ID, so two genuinely-distinct payments
    sharing the same HH:MM fingerprint (e.g. two real UPI hits in the same
    minute) both appear in the result.

    Returns a list of payment dicts (potentially empty). Each dict carries
    the Firestore doc ID under the key "id" for downstream identification.
    """
    if _payments_ref is None or not stay_id:
        return []
    try:
        q = _payments_ref.where(
            filter=fa_firestore.FieldFilter("stay_id", "==", stay_id)
        )
        out = []
        for snap in q.stream():
            d = snap.to_dict() or {}
            d["id"] = snap.id
            out.append(d)
        return out
    except Exception as e:
        logger.error(f"query_payments_by_stay_id({stay_id}) failed: {e}")
        return []
