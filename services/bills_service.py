"""
Bills Service — manages the `bills` collection as the canonical "stay" document.

Design principles
-----------------

A single document in the `bills` collection represents the entire lifecycle of
one guest stay — from check-in through to final settlement. The document's
Firestore ID is a UUID4 generated once at check-in and never changes; this ID
is the canonical foreign key used by every payment, refund, service, and audit
record that belongs to the stay.

Status field — string, one of:

    "draft"               guest checked in, not yet checked out
    "pending_settlement"  checked out, balance unpaid
    "completed"           checked out, fully paid
    "cancelled"           stay cancelled or no-show
    "voided"              manually voided by manager (rare; accounting reversal)

Phase 1 contract
----------------

This module is *additive*. It does not replace `create_bill_record(...)` in
config.py or any existing /checkout flow. It exists alongside the legacy code
so later phases can switch over to it incrementally.

A draft bill is written at check-in (Phase 2). Subsequent phases finalize the
draft at checkout instead of creating a new bill record.

Critical invariants enforced by this module:
  * `create_draft` always generates a fresh UUID4 — never derives an ID from
    room number, check-in time, or any other mutable field.
  * `finalize` operates on an existing draft; it never creates a new doc.
  * Every public function tolerates Firestore errors and logs them rather than
    raising, so a bills-service bug cannot take down a request.
"""

import logging
import uuid
from datetime import datetime, timezone

from firebase_admin import firestore as fa_firestore

logger = logging.getLogger(__name__)


# Collection reference, injected once at app startup.
_bills_ref = None
_db = None


def init(db):
    """Call once from config.py at startup to inject the Firestore client."""
    global _bills_ref, _db
    _db = db
    _bills_ref = db.collection("bills")
    logger.info("BillsService initialised (bills collection)")


# ---------------------------------------------------------------------------
# Draft creation — called at /checkin
# ---------------------------------------------------------------------------

def create_draft(room, guest, checkin_time, *,
                 stay_id=None, booking_id=None, source="checkin",
                 txn=None, batch=None):
    """
    Create a new stay document in `draft` status. Returns the stay_id used.

    Parameters
    ----------
    room : str
        Room number (will be coerced to str).
    guest : dict
        Guest details. Expected keys: name, mobile, price, guests, payment.
    checkin_time : str
        Check-in timestamp in "YYYY-MM-DD HH:MM" format.
    stay_id : str, optional
        Pre-generated UUID4 to use as the doc ID. If omitted, one is
        generated. Pass this when the caller needs the ID before the
        write commits (e.g. inside a Firestore transaction that also
        stamps the ID onto the room doc).
    booking_id : str, optional
        Source booking ID if the stay was converted from a booking. Lets
        booking-advance payments be traced through the conversion.
    source : str
        Free-form label for audit ("checkin", "booking_conversion", etc.).
    txn : firestore.Transaction, optional
        If provided, the create is added to the transaction. Caller must
        commit. Mutually exclusive with `batch`.
    batch : firestore.WriteBatch, optional
        If provided, the create is added to the batch. Caller must commit.
        Mutually exclusive with `txn`. Without either, the create runs
        immediately.

    Returns
    -------
    str
        The stay_id (Firestore doc ID), or None on failure.
    """
    if _bills_ref is None:
        logger.error("BillsService.create_draft called before init()")
        return None

    if not stay_id:
        stay_id = uuid.uuid4().hex

    doc = {
        "stay_id":       stay_id,                # mirror the doc ID into a field for query convenience
        "status":        "draft",
        "room":          str(room),
        "guest_name":    guest.get("name", ""),
        "guest_mobile":  guest.get("mobile", ""),
        "guest_count":   int(guest.get("guests", 1)),
        "room_price_per_night": int(guest.get("price", 0)),
        "is_ac":         bool(guest.get("isAC", False)),
        "checkin_time":  checkin_time,
        "checkout_time": None,
        "bill_number":   None,                   # minted at checkout
        "total_amount":  None,                   # computed at checkout
        "balance":       int(guest.get("balance", 0)),
        "payment_cash":  0,
        "payment_online": 0,
        "services":      [],
        "services_total": 0,
        "discounts":     [],
        "refunds":       [],
        "created_at":    datetime.now(timezone.utc).isoformat(),
        "source":        source,
        "booking_id":    booking_id,
    }

    doc_ref = _bills_ref.document(stay_id)

    if txn is not None and batch is not None:
        logger.error("BillsService.create_draft: txn and batch are mutually exclusive")
        return None

    try:
        if txn is not None:
            txn.set(doc_ref, doc)
        elif batch is not None:
            batch.set(doc_ref, doc)
        else:
            doc_ref.set(doc)
        logger.info(f"BillsService: draft created stay_id={stay_id} room={room} "
                    f"guest={guest.get('name','')}")
        return stay_id
    except Exception as e:
        logger.error(f"BillsService.create_draft failed: {e}", exc_info=True)
        return None


# ---------------------------------------------------------------------------
# In-stay updates — additive, never replaces fields wholesale
# ---------------------------------------------------------------------------

def update(stay_id, fields, *, batch=None):
    """
    Apply a partial update to a stay document.

    Caller is responsible for passing only fields that should change.
    Will not modify `stay_id`, `created_at`, or `bill_number` (those are
    set exactly once and immutable thereafter).
    """
    if _bills_ref is None or not stay_id:
        return False

    # Strip immutable fields if they slip in
    safe_fields = {k: v for k, v in fields.items()
                   if k not in {"stay_id", "created_at"}}
    safe_fields["updated_at"] = datetime.now(timezone.utc).isoformat()

    try:
        if batch is not None:
            batch.update(_bills_ref.document(stay_id), safe_fields)
        else:
            _bills_ref.document(stay_id).update(safe_fields)
        return True
    except Exception as e:
        logger.error(f"BillsService.update({stay_id}) failed: {e}")
        return False


# ---------------------------------------------------------------------------
# Finalize — called at /checkout to flip draft -> completed/pending
# ---------------------------------------------------------------------------

def finalize(stay_id, checkout_fields, *, batch=None):
    """
    Promote a draft to checked-out. Mints `checkout_time`, totals, and
    optionally `bill_number`. Caller computes the totals and bill number;
    this helper only writes them.

    `checkout_fields` should include at minimum:
        checkout_time, total_amount, status (completed | pending_settlement),
        bill_number (if applicable).

    Refuses to flip status to "draft" — once finalized, a stay never returns
    to draft.
    """
    if _bills_ref is None or not stay_id:
        return False

    new_status = checkout_fields.get("status")
    if new_status == "draft":
        logger.warning(f"BillsService.finalize refused: cannot revert "
                       f"stay_id={stay_id} to draft status")
        return False

    payload = dict(checkout_fields)
    payload.setdefault("finalized_at", datetime.now(timezone.utc).isoformat())
    payload["updated_at"] = datetime.now(timezone.utc).isoformat()

    try:
        if batch is not None:
            batch.update(_bills_ref.document(stay_id), payload)
        else:
            _bills_ref.document(stay_id).update(payload)
        logger.info(f"BillsService: finalized stay_id={stay_id} status={new_status} "
                    f"bill_number={payload.get('bill_number')}")
        return True
    except Exception as e:
        logger.error(f"BillsService.finalize({stay_id}) failed: {e}", exc_info=True)
        return False


def revert_to_draft(stay_id, *, reason="", actor="manager", batch=None):
    """
    Revert a finalized bill back to `draft` status.

    This is the ONLY supported path for breaking the "no revert to draft"
    invariant. It exists for the 3-hour mistake-checkout undo flow. Every
    revert is stamped with audit fields (`reverted_at`, `revert_reason`,
    `revert_actor`, `revert_count`) so the history is fully reconstructible.

    Refuses to operate when:
      * bill is not in `completed` or `pending_settlement`
      * stay_id is missing or doc not found

    The bill_number is preserved on the document under `voided_bill_number`
    and cleared from `bill_number` so the next checkout mints a fresh number.
    Numbering gaps are normal accounting practice; the audit trail explains
    them.

    Returns the pre-revert bill snapshot (dict) on success, or None on
    failure. Caller is responsible for any side-effect reversal (refunds,
    settlements, totals, room state) -- this function only flips the bill.
    """
    if _bills_ref is None or not stay_id:
        logger.error("BillsService.revert_to_draft called with no init / no stay_id")
        return None

    try:
        snap = _bills_ref.document(stay_id).get()
        if not snap.exists:
            logger.warning(f"BillsService.revert_to_draft: stay_id={stay_id} not found")
            return None

        existing = snap.to_dict()
        cur_status = existing.get("status")
        if cur_status not in ("completed", "pending_settlement"):
            logger.warning(
                f"BillsService.revert_to_draft refused: stay_id={stay_id} "
                f"current status={cur_status!r} "
                f"(must be completed or pending_settlement)"
            )
            return None

        now_iso = datetime.now(timezone.utc).isoformat()
        prev_bill_number = existing.get("bill_number")
        revert_count = int(existing.get("revert_count", 0)) + 1

        payload = {
            "status":              "draft",
            "voided_bill_number":  prev_bill_number,
            "bill_number":         None,
            "checkout_time":       None,
            "total_amount":        None,
            "finalized_at":        None,
            "reverted_at":         now_iso,
            "revert_reason":       (reason or "")[:500],
            "revert_actor":        actor or "",
            "revert_count":        revert_count,
            "updated_at":          now_iso,
            "pre_revert_snapshot": {
                "status":         cur_status,
                "bill_number":    prev_bill_number,
                "checkout_time":  existing.get("checkout_time"),
                "total_amount":   existing.get("total_amount"),
                "finalized_at":   existing.get("finalized_at"),
                "balance":        existing.get("balance"),
                "payment_cash":   existing.get("payment_cash"),
                "payment_online": existing.get("payment_online"),
                "refunds":        existing.get("refunds"),
                "settlement_id":  existing.get("settlement_id"),
            },
        }

        # Mark any previously-generated PDF as superseded so the bills UI
        # doesn't keep serving it as the canonical bill for this stay.
        if existing.get("pdf_url"):
            payload["pdf_status"] = "superseded_by_revert"
            payload["pdf_superseded_at"] = now_iso

        try:
            if batch is not None:
                batch.update(_bills_ref.document(stay_id), payload)
            else:
                _bills_ref.document(stay_id).update(payload)
        except Exception as e:
            logger.error(
                f"BillsService.revert_to_draft({stay_id}) write failed: {e}",
                exc_info=True,
            )
            return None

        logger.info(
            f"BillsService: reverted stay_id={stay_id} "
            f"prev_status={cur_status} prev_bill_number={prev_bill_number} "
            f"revert_count={revert_count} actor={actor!r}"
        )
        existing["id"] = stay_id
        return existing
    except Exception as e:
        logger.error(
            f"BillsService.revert_to_draft({stay_id}) failed: {e}",
            exc_info=True,
        )
        return None


def cancel(stay_id, reason="", *, batch=None):
    """Mark a draft (or completed) stay as cancelled. Preserves history."""
    if _bills_ref is None or not stay_id:
        return False
    payload = {
        "status":       "cancelled",
        "cancel_reason": reason or "",
        "cancelled_at": datetime.now(timezone.utc).isoformat(),
        "updated_at":   datetime.now(timezone.utc).isoformat(),
    }
    try:
        if batch is not None:
            batch.update(_bills_ref.document(stay_id), payload)
        else:
            _bills_ref.document(stay_id).update(payload)
        return True
    except Exception as e:
        logger.error(f"BillsService.cancel({stay_id}) failed: {e}")
        return False


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------

def get(stay_id):
    """Fetch a single stay doc by its ID. Returns dict or None."""
    if _bills_ref is None or not stay_id:
        return None
    try:
        snap = _bills_ref.document(stay_id).get()
        if not snap.exists:
            return None
        d = snap.to_dict()
        d["id"] = snap.id
        return d
    except Exception as e:
        logger.error(f"BillsService.get({stay_id}) failed: {e}")
        return None


def get_active_for_room(room):
    """
    Return the single draft (active) bill for a room, or None.

    Used during Phase 2-4 transition: when a payment write needs the
    active stay_id, this is the lookup.
    """
    if _bills_ref is None:
        return None
    try:
        q = (
            _bills_ref
            .where(filter=fa_firestore.FieldFilter("room",   "==", str(room)))
            .where(filter=fa_firestore.FieldFilter("status", "==", "draft"))
            .limit(1)
        )
        for snap in q.stream():
            d = snap.to_dict()
            d["id"] = snap.id
            return d
        return None
    except Exception as e:
        logger.error(f"BillsService.get_active_for_room({room}) failed: {e}")
        return None


def exists(stay_id):
    """Cheap existence check — used by the strict payment writer."""
    if _bills_ref is None or not stay_id:
        return False
    try:
        return _bills_ref.document(stay_id).get().exists
    except Exception as e:
        logger.warning(f"BillsService.exists({stay_id}) failed: {e}")
        return False
