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
    "cancelled"           stay cancelled or no-show, checkout reverted
                          (cancelled_by_revert), or invoice cancelled by an
                          admin (cancel_kind="manual", /cancel_bill)
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
                 invoiceable=False,
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
    invoiceable : bool, optional (default False)
        When True, the bill is born already officialised — `invoiceable=true`
        is stamped, with `invoiceable_at` set to now and
        `invoiceable_source = source` for audit. No `trigger_payment_id`
        is set because no online payment fired the trigger. Use this
        when the parent flow has its own officialisation guarantee
        (e.g. a confirmed booking conversion — the operator has already
        committed to the stay being official, so cash from the booking
        advance should be depositable on day one rather than waiting
        for an online payment or checkout). When False (default), the
        bill follows the original lifecycle: pending until trigger
        fires or checkout flips it.
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

    _now_iso = datetime.now(timezone.utc).isoformat()
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
        "created_at":    _now_iso,
        "source":        source,
        "booking_id":    booking_id,
    }
    # Optional birth-as-invoiceable for flows that have their own
    # officialisation guarantee (e.g. booking conversions). When set,
    # downstream banking hooks (issue_receipt_for_new_payment, etc.)
    # see invoiceable=true on the bill and route cash payments
    # straight to "eligible" (with an RV) instead of "pending".
    if invoiceable:
        doc["invoiceable"]        = True
        doc["invoiceable_at"]     = _now_iso
        doc["invoiceable_source"] = source
        # NB: invoiceable_trigger_payment_id stays unset by design —
        # there is no online payment that fired the trigger here.
        # Bill validators that look for the trigger token treat the
        # absence as a known "pre-officialised" sentinel; see
        # validators.py find_invoiceable_bills_with_non_official_payments.

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

    # GST month lock: refuse to mint a bill INTO a month whose GSTR-1 is
    # already filed — the filed return would no longer match the books.
    # Normal checkouts are unaffected (the current month can never be
    # locked, enforced in gst_lock_service.set_lock); this guards repair /
    # backfill scripts finalizing stays in past months. Unlock the month
    # first if a late bill genuinely has to be added, then re-file/amend.
    _co_time = checkout_fields.get("checkout_time") or ""
    try:
        from services.gst_lock_service import is_month_locked
        if _co_time and is_month_locked(_co_time):
            logger.error(
                f"BillsService.finalize refused: GST period "
                f"{_co_time[:7]} is locked (GSTR-1 filed); stay_id={stay_id}. "
                f"Unlock the month before finalizing late bills into it."
            )
            return False
    except ImportError:
        pass  # lock service absent (very old deploys) — proceed as before

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
      1. Marking the original bill as cancelled (status="cancelled").
         No Credit Note is issued: the revert window is short enough that
         the invoice has not yet been reported in a filed GSTR-1, so the
         bill can simply be cancelled. The original bill_number is kept,
         so the CC sequence stays gap-free (Rule 46(b)) — the number
         remains assigned to the cancelled bill and is never reused.
         The bill keeps `superseded_by_revert` too, so it still shows in
         the Bills tab (with a CANCELLED badge).
      2. Creating a brand-new DRAFT bill (fresh stay_id) for the same
         room+guest so the next checkout mints a new CC number — the
         original number is NEVER reused.

    Refuses to operate when:
      * bill is not in `completed` or `pending_settlement`
      * stay_id is missing or doc not found

    Returns a dict with keys:
      "old_stay_id"   : the original (now superseded) stay's doc ID
      "new_stay_id"   : the fresh draft stay's doc ID — caller must wire
                        this onto room.active_bill_id
      "credit_note"   : always None — revert no longer issues a Credit Note
                        (kept in the return shape for caller compatibility)
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

        # ── Mark the original bill as CANCELLED (no Credit Note) ────────────
        # The revert happens inside a short window (REVERT_CHECKOUT_WINDOW_HOURS)
        # — well before the GSTR-1 for that period is filed — so the invoice can
        # simply be cancelled rather than reversed with a Section 34 Credit Note.
        # NO CN is issued.
        #
        # The bill_number is PRESERVED (Rule 46(b) gap-free invariant): the
        # number stays assigned to this cancelled bill and is never reused.
        # The cancelled bill stays visible in the Bills tab with a CANCELLED
        # badge and is reported in the GST export as cancelled / zero value.
        # `superseded_by_revert` is kept so the repeat-revert guard above and
        # existing UI both still recognise it.
        #
        # IMPORTANT: this is correct ONLY while the invoice has not yet been
        # reported in a filed GSTR-1. If a revert is ever permitted after the
        # period is filed, a Section 34 Credit Note (see BillsService.cancel)
        # would be required instead.
        cn_doc = None  # no CN on revert — kept for return-shape compatibility
        original_payload = {
            "status":                "cancelled",
            "cancelled_at":          now_iso,
            "cancel_reason":         (reason or "")[:500],
            "cancelled_by_revert":   True,
            "superseded_by_revert":  True,
            "reverted_at":           now_iso,
            "revert_reason":         (reason or "")[:500],
            "revert_actor":          actor or "",
            "revert_count":          revert_count,
            "updated_at":            now_iso,
        }
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
            # Pass the WHOLE bill, not a synthetic {"gst_rate": ...} stub.
            # compute_credit_components blends the reversal off the invoice's
            # real tax breakup (the folio), and a stub carries no folio — so
            # the stub reversed zero tax on every cancellation.
            tax, cgst, sgst = _ccc(existing, cn_amount)
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
# Manual cancellation (/cancel_bill): the decision, kept free of I/O
# ---------------------------------------------------------------------------

def _rupees(v):
    v = v or 0
    return f"{int(v)}" if float(v).is_integer() else f"{v:.2f}"


def cancel_eligibility(bill, receipts, settlement=None, month_locked=False):
    """
    Decide whether /cancel_bill may cancel a checked-out invoice.
    Returns (ok, code, message). Pure, so every branch is unit-tested; the
    route gathers the inputs and performs the writes.

      bill          the bill document
      receipts      payment_service.receipt_totals() over the stay's ledger
      settlement    the settle-later doc named by bill.settlement_id, or None
      month_locked  whether the bill's GST period (its checkout month) is
                    locked, i.e. that month's GSTR-1 has been filed

    Codes: OK; ALREADY_CANCELLED, also ok=True because the requested end
    state already holds, so a repeated click succeeds without writing; and
    the refusals CANCELLED_BY_REVERT, BAD_STATUS, REVERTED, HAS_CREDIT_NOTE,
    MONTH_LOCKED, SETTLEMENT_COLLECTED, HAS_RECEIPTS.

    GST position: a cancelled invoice keeps its number (Rule 46 allows no
    gap and no reuse) and is reported in GSTR-1 Table 13 as cancelled, at
    zero value. That is only lawful while the invoice is not in a filed
    return. After filing, the correction is a Section 34 credit note dated
    today, so a locked month is refused rather than rewritten.
    """
    b = bill or {}
    status = b.get("status") or ""
    bill_no = b.get("bill_number") or "-"

    if status == "cancelled":
        if b.get("cancel_kind") == "manual":
            return True, "ALREADY_CANCELLED", f"Bill {bill_no} is already cancelled."
        if b.get("cancelled_by_revert"):
            return False, "CANCELLED_BY_REVERT", (
                f"Bill {bill_no} was already cancelled when its checkout was "
                f"reverted; the stay continues on a new bill.")
        return False, "BAD_STATUS", f"Bill {bill_no} is already cancelled."
    if status not in ("completed", "pending_settlement"):
        return False, "BAD_STATUS", (
            f"Only a checked-out bill can be cancelled (bill {bill_no} is "
            f"'{status or 'unknown'}').")

    # Legacy revert (before revert switched to cancelling): the bill kept
    # status "completed" and a credit note already reversed it. Cancelling
    # it too would take the same value out of GSTR-1 twice.
    if b.get("superseded_by_revert"):
        return False, "REVERTED", (
            f"Bill {bill_no} was reverted and a credit note reversed it; it "
            f"cannot also be cancelled.")
    # Same double reversal: the credit note already reduces output tax, and
    # a cancelled invoice would drop out of the return on top of that.
    if b.get("linked_credit_note_id") or b.get("linked_credit_note_ids"):
        return False, "HAS_CREDIT_NOTE", (
            f"A credit note has already been issued against bill {bill_no}. "
            f"Cancelling the bill as well would reverse that amount twice in "
            f"GSTR-1; issue a credit note for the remaining value instead.")

    if month_locked:
        period = (b.get("checkout_time") or "")[:7]
        return False, "MONTH_LOCKED", (
            f"GST period {period} is locked because its GSTR-1 has been filed, "
            f"so bill {bill_no} can no longer be cancelled. Correct it with a "
            f"GST credit note dated today (Section 34): Bills tab, Collect "
            f"Payment, Discount, 'GST credit note'.")

    s_status = ((settlement or {}).get("status") or "").lower()
    if s_status in ("paid", "partial"):
        return False, "SETTLEMENT_COLLECTED", (
            f"The settle-later balance of bill {bill_no} has already been "
            f"{'collected' if s_status == 'paid' else 'partly collected'}, so "
            f"money has moved against it. Refund the guest and issue a GST "
            f"credit note instead of cancelling.")

    r = receipts or {}
    cash, online, ota, refunds = (r.get(k, 0) or 0
                                  for k in ("cash", "online", "ota", "refunds"))
    net = cash + online + ota - refunds
    if net != 0:
        return False, "HAS_RECEIPTS", (
            f"Money is still recorded against this stay: cash ₹{_rupees(cash)} "
            f"+ online ₹{_rupees(online)} + OTA ₹{_rupees(ota)} - refunds "
            f"₹{_rupees(refunds)} = ₹{_rupees(net)}. A bill can only be "
            f"cancelled when this is zero. If no money was actually received "
            f"for this bill (a duplicate entry), tick 'No money was received' "
            f"to remove these entries and cancel. Otherwise refund the guest "
            f"first.")

    return True, "OK", ""


def receipt_removal_check(removable, receipts, is_month_locked):
    """
    May /cancel_bill remove a stay's receipts because the operator declared
    that no money was received for this bill? Returns (ok, code, message).

    The case it exists for: a guest checked in to two rooms by mistake with
    the same advance typed into both (Rs.500 online on 225 and again on 226).
    The second bill cannot be cancelled while it shows Rs.500 received, and
    that Rs.500 never existed. Removing the entry is what makes the books
    true again, so it is done in the same batch as the cancellation.

      removable        payment_service.receipt_rows() of the stay
      receipts         payment_service.receipt_totals() of the same rows
      is_month_locked  callable(period) -> bool, the GST month lock

    Only cash and online receipts are removed. Everything else means money
    really moved or is owed by someone else, and stays a manual decision:
      * OTA-settled amounts are paid by the OTA, not typed in at the desk;
      * a refund already paid money out, so removing the receipt alone would
        leave the stay negative;
      * a receipt inside a bank deposit has physically left the drawer;
      * a receipt dated in a filed (locked) month is in that month's books.
    """
    r = receipts or {}
    if r.get("ota") or r.get("refunds"):
        return False, "RECEIPTS_NOT_REMOVABLE", (
            "This stay has an OTA-settled amount or a refund, so its payments "
            "cannot be removed here. Settle those first, then cancel.")
    if not removable:
        return False, "RECEIPTS_NOT_REMOVABLE", (
            "The payment entries for this stay could not be read, so nothing "
            "can be removed. Reopen the bill and try again.")
    for p in removable:
        label = (f"₹{_rupees(p.get('amount', 0) or 0)} {p.get('method')} "
                 f"on {p.get('date') or 'an unknown date'}")
        if not p.get("id"):
            return False, "RECEIPTS_NOT_REMOVABLE", (
                f"The payment {label} has no record id, so it cannot be "
                f"removed safely.")
        if p.get("cash_deposit_id"):
            return False, "RECEIPTS_NOT_REMOVABLE", (
                f"The payment {label} is already in bank deposit "
                f"{p.get('cash_deposit_id')}. Reverse that deposit first "
                f"(Banking, History, Reverse), then cancel.")
        period = str(p.get("date") or "")[:7]
        if period and is_month_locked(period):
            return False, "RECEIPTS_NOT_REMOVABLE", (
                f"The payment {label} is in GST period {period}, which is "
                f"locked (GSTR-1 filed). It cannot be removed.")
    return True, "OK", ""


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
