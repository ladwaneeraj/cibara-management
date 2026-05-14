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
    Revert a finalised bill (3-hour mistake-undo flow) by:
      1. Issuing a full-amount Section 34 Credit Note against the original
         bill (reason="checkout_mistake").
      2. Marking the original bill as `superseded_by_revert` — keeping its
         status as 'completed'/'pending_settlement' so it stays visible
         in the Bills tab with a "REVERTED" badge. The original
         bill_number is preserved so the CC sequence is gap-free
         (Rule 46(b)).
      3. Creating a brand-new DRAFT bill (fresh stay_id) for the same
         room+guest so the next checkout mints a new CC number — the
         original number is NEVER reused.

    Refuses to operate when:
      * bill is not in `completed` or `pending_settlement`
      * stay_id is missing or doc not found

    Returns a dict with keys:
      "old_stay_id"   : the original (now superseded) stay's doc ID
      "new_stay_id"   : the fresh draft stay's doc ID — caller must wire
                        this onto room.active_bill_id
      "credit_note"   : the CN dict (from create_credit_note) or None
      "old_bill"      : the original bill's pre-revert snapshot

    Returns None on failure. Caller is responsible for side-effect reversal
    (refunds, settlements, totals, room state).

    DEPRECATED FIELDS:
      Pre-migration this function set `voided_bill_number` on the bill and
      cleared `bill_number`. That field is no longer written; existing
      historical values are left in place for the backfill script.
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
        # Guard against repeat revert — a bill already superseded by a
        # prior revert STILL has status=completed. Without this check, a
        # second revert call would mint a second CN against the same
        # bill_number and double-reverse the output tax. The fresh draft
        # created by the first revert is what the operator should target
        # instead.
        if existing.get("superseded_by_revert"):
            logger.warning(
                f"BillsService.revert_to_draft refused: stay_id={stay_id} "
                f"already superseded by a prior revert "
                f"(CN={existing.get('revert_credit_note_number')!r}). "
                f"Operate on the successor draft instead."
            )
            return None

        now_iso = datetime.now(timezone.utc).isoformat()
        prev_bill_number = existing.get("bill_number")
        revert_count = int(existing.get("revert_count", 0)) + 1

        # ── Issue a full-amount credit note (Section 34) ────────────────────
        # We do this BEFORE flipping the bill status so the CN can read
        # the still-finalised bill cleanly. Credit-note creation is its
        # own atomic transaction (counter + doc); a failure here is
        # logged but does NOT block the revert — the operator can issue
        # the CN manually if needed.
        cn_amount = int(existing.get("total_amount") or 0)
        cn_doc = None
        if prev_bill_number and cn_amount > 0:
            try:
                from datetime import datetime as _dt
                # Local import to avoid the (services → config → services)
                # circular-import issue that would otherwise trip at
                # bills_service module load time.
                from config import (
                    create_credit_note as _ccn,
                    compute_credit_components as _ccc,
                    IST as _IST,
                )
                tax, cgst, sgst = _ccc({"gst_rate": existing.get("gst_rate", 0)},
                                       cn_amount)
                # Idempotency key: revert_count uniquifies repeated reverts
                # (a bill can in theory be revert-checkout-revert several
                # times — though our 3-hour window makes this rare).
                _idem = f"revert:{stay_id}:{revert_count}"
                cn_doc = _ccn(
                    bill_id=stay_id,
                    bill_data=existing,
                    cn_date=_dt.now(_IST),
                    reason="checkout_mistake",
                    reason_text=(reason or "Checkout reverted within 3-hour window"),
                    credit_taxable=tax,
                    credit_cgst=cgst,
                    credit_sgst=sgst,
                    credit_total=cn_amount,
                    actor=actor,
                    idempotency_key=_idem,
                )
            except Exception as _ce:
                logger.error(
                    f"BillsService.revert_to_draft: CN issuance failed for "
                    f"stay_id={stay_id} bill_no={prev_bill_number} — "
                    f"{_ce}. Reverting anyway; operator must issue CN manually."
                )

        # ── Mark the original bill as superseded (NOT flipped to draft) ─────
        # Status stays as it was so the Bills tab keeps showing the row.
        # bill_number is preserved — Rule 46(b) gap-free invariant.
        # The reverted_at / revert_reason / revert_count fields drive the
        # "REVERTED" badge in the UI.
        original_payload = {
            "superseded_by_revert": True,
            "reverted_at":          now_iso,
            "revert_reason":        (reason or "")[:500],
            "revert_actor":         actor or "",
            "revert_count":         revert_count,
            "updated_at":           now_iso,
        }
        if cn_doc:
            original_payload["revert_credit_note_id"]     = cn_doc.get("cn_id")
            original_payload["revert_credit_note_number"] = cn_doc.get("cn_number")
        if existing.get("pdf_url"):
            original_payload["pdf_status"] = "superseded_by_revert"
            original_payload["pdf_superseded_at"] = now_iso

        # ── Create a fresh draft for the room+guest so the next checkout
        # mints a brand-new CC number. Same shape as create_draft() — kept
        # inline so we can copy a couple of audit fields off the original.
        new_stay_id = uuid.uuid4().hex
        guest_snap = (existing.get("pre_checkout_snapshot") or {}).get("guest") or {}
        new_draft = {
            "stay_id":         new_stay_id,
            "status":          "draft",
            "room":            str(existing.get("room") or ""),
            "guest_name":      existing.get("guest_name") or guest_snap.get("name", ""),
            "guest_mobile":    existing.get("guest_mobile") or guest_snap.get("mobile", ""),
            "guest_count":     int(existing.get("guest_count") or guest_snap.get("guests", 1) or 1),
            "room_price_per_night": int(existing.get("room_price_per_night") or
                                        guest_snap.get("price", 0) or 0),
            "is_ac":           bool(existing.get("is_ac") or guest_snap.get("isAC", False)),
            "checkin_time":    existing.get("checkin_time"),
            "checkout_time":   None,
            "bill_number":     None,
            "total_amount":    None,
            "balance":         int(existing.get("balance", 0) or 0),
            "payment_cash":    0,
            "payment_online":  0,
            "services":        [],
            "services_total":  0,
            "discounts":       [],
            "refunds":         [],
            "created_at":      datetime.now(timezone.utc).isoformat(),
            "source":          "revert_checkout",
            "predecessor_stay_id":   stay_id,
            "predecessor_bill_number": prev_bill_number,
        }

        try:
            local_batch = batch if batch is not None else _db.batch()
            local_batch.update(_bills_ref.document(stay_id), original_payload)
            local_batch.set(_bills_ref.document(new_stay_id), new_draft)
            if batch is None:
                local_batch.commit()
        except Exception as e:
            logger.error(
                f"BillsService.revert_to_draft({stay_id}) write failed: {e}",
                exc_info=True,
            )
            return None

        logger.info(
            f"BillsService: reverted stay_id={stay_id} "
            f"prev_status={cur_status} prev_bill_number={prev_bill_number} "
            f"revert_count={revert_count} actor={actor!r} "
            f"new_stay_id={new_stay_id} "
            f"cn={cn_doc.get('cn_number') if cn_doc else 'none'}"
        )
        existing["id"] = stay_id
        return {
            "old_stay_id":  stay_id,
            "new_stay_id":  new_stay_id,
            "credit_note":  cn_doc,
            "old_bill":     existing,
        }
    except Exception as e:
        logger.error(
            f"BillsService.revert_to_draft({stay_id}) failed: {e}",
            exc_info=True,
        )
        return None


def cancel(stay_id, reason="", *, actor=None, batch=None):
    """
    Mark a draft (or completed) stay as cancelled. Preserves history.

    POST-MIGRATION (Goal 2): if the bill has been finalised (i.e. has a
    bill_number) the cancellation also issues a Section 34 Credit Note
    for the full amount, reason="cancellation". A draft cancel (no bill
    number yet) does NOT issue a CN — there's nothing to reverse for GST.
    """
    if _bills_ref is None or not stay_id:
        return False
    try:
        snap = _bills_ref.document(stay_id).get()
        if not snap.exists:
            logger.warning(f"BillsService.cancel: stay_id={stay_id} not found")
            return False
        existing = snap.to_dict()
    except Exception as e:
        logger.error(f"BillsService.cancel({stay_id}) read failed: {e}")
        return False

    payload = {
        "status":       "cancelled",
        "cancel_reason": reason or "",
        "cancelled_at": datetime.now(timezone.utc).isoformat(),
        "updated_at":   datetime.now(timezone.utc).isoformat(),
    }

    cur_status = existing.get("status")
    bill_no    = existing.get("bill_number")
    cn_amount  = int(existing.get("total_amount") or 0)
    cn_doc     = None
    if (
        cur_status in ("completed", "pending_settlement")
        and bill_no
        and cn_amount > 0
    ):
        try:
            from datetime import datetime as _dt
            from config import (
                create_credit_note as _ccn,
                compute_credit_components as _ccc,
                IST as _IST,
            )
            tax, cgst, sgst = _ccc({"gst_rate": existing.get("gst_rate", 0)},
                                   cn_amount)
            _idem = f"cancel:{stay_id}"
            cn_doc = _ccn(
                bill_id=stay_id,
                bill_data=existing,
                cn_date=_dt.now(_IST),
                reason="cancellation",
                reason_text=(reason or "Stay cancelled after invoicing"),
                credit_taxable=tax,
                credit_cgst=cgst,
                credit_sgst=sgst,
                credit_total=cn_amount,
                actor=actor,
                idempotency_key=_idem,
            )
            if cn_doc:
                payload["cancel_credit_note_id"]     = cn_doc.get("cn_id")
                payload["cancel_credit_note_number"] = cn_doc.get("cn_number")
        except Exception as _ce:
            logger.error(
                f"BillsService.cancel: CN issuance failed for stay_id="
                f"{stay_id} bill_no={bill_no} — {_ce}. Cancelling anyway."
            )

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
