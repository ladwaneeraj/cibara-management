"""
Settlement routes: get_pending_settlements, collect_settlement, cancel_settlement.
"""

from flask import Blueprint, request, jsonify
from datetime import datetime
import uuid

from firebase_admin import firestore

from config import (
    db, totals_ref, IST, logger,
    invalidate_rooms_and_totals,
    create_credit_note, compute_credit_components,
    section_34_window_status,
)

# settlements_ref and bills_ref defined in config
from config import settlements_ref, bills_ref

from services import payment_service
from services.audit_log import write_log
from services.auth_service import requires_permission
from services.request_guard import guard_duplicate_submit

settlements_bp = Blueprint('settlements', __name__)


def fetch_settlements():
    settlements_stream = settlements_ref.stream()
    settlements_list = []
    for doc in settlements_stream:
        settlement_data = doc.to_dict()
        settlement_data["id"] = doc.id
        settlements_list.append(settlement_data)
    return settlements_list


def _attach_bill_summary(settlements):
    """Stamp each settlement with the invoice it belongs to.

    The settlement document records what is owed; the bill records what it
    was for. The desk needs both in one place — quoting an invoice number
    over the phone, or telling a guest which stay the money is for, was a
    second lookup in the Bills tab against a list that only showed a room and
    a date.

    The link is bills.settlement_id, the same field /collect_settlement uses
    to find the invoice it must credit. Read in chunks of 30 (Firestore's
    limit for an "in" filter) so a screen of settlements costs two or three
    queries rather than one per row.

    Missing bills are not an error: a settlement created before the invoice
    carried the link, or one whose bill was cancelled, simply shows without
    invoice details. Nothing here changes the settlement documents.
    """
    by_id = {s["id"]: s for s in settlements if s.get("id")}
    ids = list(by_id)
    linked = 0
    # Ten, not thirty. Firestore raised the "in" limit to 30 only in the 2023
    # backend; an older google-cloud-firestore rejects a longer list with
    # InvalidArgument, and because .stream() is lazy that error does not
    # surface until the rows are iterated. Ten works on every version and
    # costs one extra round trip per twenty settlements.
    for start in range(0, len(ids), 10):
        chunk = ids[start:start + 10]
        try:
            # Iterated INSIDE the try on purpose: .stream() only builds the
            # query, so a rejected filter throws here rather than at the
            # where() call, and a try wrapped around where() alone catches
            # nothing.
            rows = list(bills_ref.where(
                filter=firestore.FieldFilter("settlement_id", "in", chunk)
            ).stream())
        except Exception:
            # One bad chunk is not a reason to drop the invoices from the
            # other chunks, so this carries on rather than returning.
            logger.warning("settlements: bill lookup failed for %d ids",
                           len(chunk), exc_info=True)
            continue
        for doc in rows:
            bill = doc.to_dict() or {}
            target = by_id.get(bill.get("settlement_id"))
            if not target:
                continue
            linked += 1
            paid = (int(bill.get("payment_cash", 0) or 0)
                    + int(bill.get("payment_online", 0) or 0)
                    + int(bill.get("payment_ota", 0) or 0))
            target["bill"] = {
                "id": doc.id,
                "bill_number": bill.get("bill_number") or "",
                "status": bill.get("status") or "",
                "total_amount": int(bill.get("total_amount", 0) or 0),
                "paid": paid,
                "discounts": int(bill.get("discounts", 0) or 0),
                "days_stayed": int(bill.get("days_stayed", 0) or 0),
                "guest_count": int(bill.get("guest_count", 1) or 1),
                "checkin_time": bill.get("checkin_time") or "",
                "checkout_time": bill.get("checkout_time") or "",
                "room_price_per_night": int(
                    bill.get("room_price_per_night", 0) or 0),
                "booking_source": bill.get("booking_source") or "",
                "cancelled": bool(bill.get("cancelled")),
            }
    # One line that answers "why does every row say no invoice linked" without
    # a debugging session: it says how many settlements were read and how many
    # of them found their bill.
    logger.info("settlements: %d rows, %d linked to an invoice",
                len(settlements), linked)
    return settlements


@settlements_bp.route("/get_pending_settlements", methods=["GET"])
@requires_permission("settlement.collect")
def get_pending_settlements_route():
    try:
        settlements = _attach_bill_summary(fetch_settlements())
        return jsonify(success=True, settlements=settlements)
    except Exception as e:
        logger.error(f"Error fetching settlements: {str(e)}")
        return jsonify(success=False, message=f"Error fetching settlements: {str(e)}")


@settlements_bp.route("/collect_settlement", methods=["POST"])
@requires_permission("settlement.collect")
@guard_duplicate_submit()
def collect_settlement():
    try:
        data_json = request.json
        settlement_id = data_json["settlement_id"]
        payment_mode = data_json["payment_mode"]

        payment_amount = int(data_json.get("payment_amount", 0))
        discount_amount = int(data_json.get("discount_amount", 0))
        discount_reason = data_json.get("discount_reason", "")
        payment_date_in = (data_json.get("payment_date") or "").strip()

        # ── Discount classification (Goal 2 Section 15(3)/Section 34 fork) ──
        # Two valid values:
        #   "financial"   — goodwill / write-off; no GST credit, no CN issued
        #                   (the historic, default behaviour).
        #   "credit_note" — Section 15(3)(b) post-supply discount or full
        #                   Section 34 credit; we issue a CN for the
        #                   discount amount, split into taxable + CGST +
        #                   SGST at the original bill's gst_rate.
        #
        # The "credit_note" branch is allowed only when the linked bill
        # has a recipient_gstin (B2B) OR the reason_text confirms the
        # discount was agreed at/before time of supply per Section
        # 15(3)(b). Both conditions are checked below.
        discount_type   = (data_json.get("discount_type") or "financial").lower()
        is_bad_debt     = bool(data_json.get("bad_debt", False))
        ack_s34_late    = bool(data_json.get("acknowledge_section34_window", False))
        if discount_type not in ("financial", "credit_note"):
            return jsonify(success=False,
                           message="discount_type must be 'financial' or 'credit_note'"), 400

        settlement_doc = settlements_ref.document(settlement_id).get()
        if not settlement_doc.exists:
            return jsonify(success=False, message="Settlement not found")

        settlement = settlement_doc.to_dict()

        # Collecting the same balance twice is the realistic failure here:
        # the same guest is now standing at the desk checking in, so the
        # banner, the Pending Payments list and a second operator can all
        # reach this settlement at once. A settled or written-off balance
        # takes no more money.
        _cur_status = (settlement.get("status") or "").lower()
        if _cur_status == "paid":
            return jsonify(success=False, code="ALREADY_PAID", message=(
                "This balance has already been collected in full.")), 409
        if _cur_status == "cancelled":
            return jsonify(success=False, code="CANCELLED", message=(
                "This balance was cancelled and cannot be collected.")), 409

        # ── Optional backdating of the receipt date (default: today) ──────────
        # Range: checkout date .. today (no future). A date in a GST-locked
        # (filed) month is refused. The chosen date is the value date used by
        # the register/reports; created_at stays "now" for the audit trail.
        from services import gst_lock_service as _gls
        _now_dt    = datetime.now(IST)
        value_date = _now_dt.strftime("%Y-%m-%d")
        if payment_date_in:
            try:
                _vd = datetime.strptime(payment_date_in, "%Y-%m-%d")
            except ValueError:
                return jsonify(success=False, message="payment_date must be YYYY-MM-DD"), 400
            if _vd.date() > _now_dt.date():
                return jsonify(success=False, message="Receipt date cannot be in the future"), 400
            _co = (settlement.get("checkout_date") or "")[:10]
            if _co:
                try:
                    if _vd.date() < datetime.strptime(_co, "%Y-%m-%d").date():
                        return jsonify(success=False,
                                       message=f"Receipt date cannot be before checkout ({_co})"), 400
                except ValueError:
                    pass
            try:
                _per = _gls.normalize_period(payment_date_in)
                if _per and _gls.is_month_locked(_per):
                    return jsonify(success=False, month_locked=True,
                                   message=(f"GST period {_per} is locked (GSTR-1 filed) — "
                                            "choose a date in an open period or unlock "
                                            "the month first.")), 409
            except Exception:
                pass
            value_date = _vd.strftime("%Y-%m-%d")
        # A1: snapshot the settlement state for the audit log before any
        # mutation. Only the fields that this route can change.
        before_snapshot = {
            "status":           settlement.get("status"),
            "amount":           settlement.get("amount"),
            "discount_amount":  settlement.get("discount_amount", 0),
        }
        batch = db.batch()

        if discount_amount > 0:
            if discount_amount > settlement["amount"]:
                return jsonify(success=False, message=f"Discount amount (₹{discount_amount}) exceeds settlement amount (₹{settlement['amount']})")

            settlement["amount"] -= discount_amount
            settlement["discount_amount"] = discount_amount
            settlement["discount_reason"] = discount_reason

        if payment_amount <= 0:
            payment_amount = settlement["amount"]

        if payment_amount > settlement["amount"]:
            return jsonify(success=False, message=f"Payment amount (₹{payment_amount}) exceeds settlement amount (₹{settlement['amount']})")

        # Carry original check-in serial number forward so the transaction
        # log can show it alongside the settlement payment.
        original_serial = settlement.get("serial_number")

        batch.update(totals_ref.document('current_totals'), {
            payment_mode: firestore.Increment(payment_amount),
        })

        if payment_amount == settlement["amount"]:
            settlement["status"] = "paid"
            settlement["payment_date"] = value_date
            settlement["payment_time"] = datetime.now(IST).strftime("%H:%M")
            settlement["payment_mode"] = payment_mode

            # Clear the pending-settlement flag so the next check-in no
            # longer shows the balance warning. Keyed to THIS settlement:
            # the guest may owe on another stay too, and that warning has to
            # survive.
            _settle_mobile = settlement.get("guest_mobile", "")
            if _settle_mobile:
                from services import customer_service as _cs
                _cs.clear_pending_settlement(_settle_mobile,
                                             settlement_id=settlement_id)
        else:
            settlement["status"] = "partial"
            settlement["amount"] -= payment_amount

            if "payments" not in settlement:
                settlement["payments"] = []

            settlement["payments"].append({
                "amount": payment_amount,
                "date": value_date,
                "time": datetime.now(IST).strftime("%H:%M"),
                "mode": payment_mode,
            })

            # Part-paid: the check-in warning must now show what is LEFT.
            # Without this it kept quoting the original amount and the desk
            # collected it twice.
            _settle_mobile = settlement.get("guest_mobile", "")
            if _settle_mobile:
                from services import customer_service as _cs
                _cs.set_pending_settlement(
                    _settle_mobile,
                    {"id": settlement_id, "amount": settlement["amount"],
                     "checkout_date": settlement.get("checkout_date"),
                     "room": settlement.get("room")},
                    only_if_id=settlement_id)

        batch.set(settlements_ref.document(settlement_id), settlement)
        batch.commit()

        invalidate_rooms_and_totals()

        # Look up the linked bill so we can stamp stay_id (= bill doc ID)
        # onto the settlement payments. Bills with this settlement_id were
        # written at /checkout. For new stays the doc ID is the UUID; for
        # legacy stays it's {room}_{ts}. Either way we use it as stay_id.
        _linked_stay_id = None
        try:
            for _b in bills_ref.where("settlement_id", "==", settlement_id).limit(1).stream():
                _linked_stay_id = _b.id
                # Idempotent stamp on the bill so Phase-6 lookups resolve
                # without waiting for the Phase-7 backfill.
                if not _b.to_dict().get("stay_id"):
                    bills_ref.document(_b.id).update({"stay_id": _b.id})
                break
        except Exception as _e:
            logger.warning(f"collect_settlement: linked-bill lookup failed: {_e}")

        # Write settlement payment to payments collection
        _settle_pay = {
            "room": settlement["room"], "name": settlement["guest_name"],
            "amount": payment_amount, "method": payment_mode,
            "type": "settlement_payment",
            "date": value_date,
            "time": datetime.now(IST).strftime("%H:%M"),
            "settlement_id": settlement_id,
            "transaction_type": "settlement_payment",
            "serial_number": original_serial,
        }
        if _linked_stay_id:
            payment_service.write_payment_with_stay(_linked_stay_id, _settle_pay)
        else:
            payment_service.write_payment(_settle_pay)

        # Write discount to payments collection (previously missing — gap fix)
        if discount_amount > 0:
            _settle_disc = {
                "room": settlement["room"], "name": settlement["guest_name"],
                "amount": discount_amount, "method": "discount",
                "type": "discount",
                "date": value_date,
                "time": datetime.now(IST).strftime("%H:%M"),
                "settlement_id": settlement_id,
                "transaction_type": "settlement_discount",
                "reason": discount_reason,
                "discount_type": discount_type,
                "is_bad_debt": is_bad_debt and discount_type == "financial",
                "serial_number": original_serial,
            }
            if _linked_stay_id:
                payment_service.write_payment_with_stay(_linked_stay_id, _settle_disc)
            else:
                payment_service.write_payment(_settle_disc)

        # ── Update the linked bill record ────────────────────────────────────────
        # This is what "the old bill is cleared" means: the payment lands on
        # the invoice, its balance is recomputed and a fully paid bill moves
        # to completed. Anything that skips this route leaves the settlement
        # paid and the invoice still showing money due.
        cn_for_response = None
        _bill_id_updated = None
        _bill_status = None
        _bill_balance = None
        try:
            bill_q = bills_ref \
                .where("settlement_id", "==", settlement_id) \
                .limit(1).stream()
            for bill_doc in bill_q:
                bill_data   = bill_doc.to_dict()
                bill_update = {}

                # Apply payment to the correct bucket
                if payment_mode == "cash":
                    bill_update["payment_cash"] = (bill_data.get("payment_cash", 0)
                                                   + payment_amount)
                else:
                    bill_update["payment_online"] = (bill_data.get("payment_online", 0)
                                                     + payment_amount)

                # Apply discount if any
                if discount_amount > 0:
                    bill_update["discounts"] = (bill_data.get("discounts", 0)
                                                + discount_amount)

                # Recalculate remaining balance
                new_cash   = bill_update.get("payment_cash",
                                             bill_data.get("payment_cash", 0))
                new_online = bill_update.get("payment_online",
                                             bill_data.get("payment_online", 0))
                new_disc   = bill_update.get("discounts",
                                             bill_data.get("discounts", 0))
                new_balance = (bill_data.get("total_amount", 0)
                               - new_cash - new_online
                               - new_disc
                               + bill_data.get("refunds", 0))
                bill_update["balance"] = new_balance

                # If fully settled, close the bill
                if new_balance <= 0:
                    bill_update["status"] = "completed"

                    # Mark invoice_generated for UPI settlements if not already flagged
                    if (payment_mode == "online"
                            and not bill_data.get("invoice_generated")):
                        bill_update["invoice_generated"] = True

                # ── CN issuance for the discount branch ──────────────────────
                # Conditions:
                #   1. discount_type == "credit_note"
                #   2. discount_amount > 0
                #   3. either bill is B2B (recipient_gstin present) OR
                #      the operator typed a 15(3)(b) justification
                #      (discount_reason is non-empty) — we trust them but
                #      record the reason verbatim for the CA.
                if (
                    discount_type == "credit_note"
                    and discount_amount > 0
                    and bill_data.get("bill_number")
                ):
                    has_gstin = bool((bill_data.get("recipient_gstin") or "").strip())
                    if not has_gstin and not (discount_reason or "").strip():
                        return jsonify(
                            success=False,
                            message=("CN-discount requires either a B2B "
                                     "recipient with a GSTIN on the bill OR "
                                     "a discount_reason describing why the "
                                     "discount was agreed at/before time of "
                                     "supply (Section 15(3)(b))."),
                        ), 400
                    # Section 34(2) cutoff guard.
                    _inv_date = (bill_data.get("checkout_time") or "")[:10]
                    _s34 = section_34_window_status(_inv_date)
                    if _s34.get("deadline") and not _s34.get("in_window") and not ack_s34_late:
                        return jsonify(
                            success=False,
                            section34_warning=True,
                            section34_deadline=_s34["deadline"].isoformat(),
                            section34_days_overdue=abs(int(_s34.get("days_left") or 0)),
                            message=(
                                f"Bill {bill_data.get('bill_number')} ({_inv_date}) "
                                f"is past the Section 34(2) deadline "
                                f"(30 Nov {_s34['deadline'].year}). "
                                "Re-submit with acknowledge_section34_window=true "
                                "to proceed."
                            ),
                        ), 409

                    tax, cgst, sgst = compute_credit_components(
                        bill_data, discount_amount,
                    )
                    _idem = f"settlement_discount:{settlement_id}"
                    cn_for_response = create_credit_note(
                        bill_id=bill_doc.id,
                        bill_data=bill_data,
                        cn_date=datetime.now(IST),
                        reason="post_supply_discount",
                        reason_text=discount_reason or "Post-supply discount agreed at settlement",
                        credit_taxable=tax,
                        credit_cgst=cgst,
                        credit_sgst=sgst,
                        credit_total=discount_amount,
                        actor=None,
                        idempotency_key=_idem,
                    )
                    if cn_for_response:
                        try:
                            write_log(
                                "credit_note.create",
                                target_collection="credit_notes",
                                target_id=str(cn_for_response.get("cn_id") or ""),
                                metadata={
                                    "reason": "post_supply_discount",
                                    "reason_text": discount_reason,
                                    "settlement_id": settlement_id,
                                    "credit_amount_total": discount_amount,
                                    "cn_number": cn_for_response.get("cn_number"),
                                    "is_b2b": has_gstin,
                                },
                            )
                        except Exception as _le:
                            logger.warning(f"collect_settlement: CN audit-log failed: {_le}")

                _bill_id_updated = bill_doc.id
                _bill_status = bill_update.get("status", bill_data.get("status"))
                _bill_balance = new_balance
                bills_ref.document(bill_doc.id).update(bill_update)
                logger.info(f"Bill {bill_doc.id} updated after settlement collection "
                            f"(balance now Rs.{new_balance}) "
                            f"discount_type={discount_type} "
                            f"cn={cn_for_response.get('cn_number') if cn_for_response else 'none'}")
                break
        except Exception as _be:
            logger.warning(f"Could not update bill for settlement {settlement_id}: {_be}")

        is_full = (payment_amount == settlement.get("amount", payment_amount))
        if is_full:
            message = f"Full payment of Rs.{payment_amount} collected successfully"
        else:
            message = f"Partial payment of Rs.{payment_amount} collected. Remaining: Rs.{settlement['amount']}"

        # A1: audit-log the collection itself (the CN-creation branch above
        # writes its own credit_note.create entry; this captures the
        # collection event regardless of whether a CN was issued).
        write_log(
            "settlement.collect",
            target_collection="settlements",
            target_id=str(settlement_id),
            before=before_snapshot,
            after={
                "status":         settlement.get("status"),
                "amount":         settlement.get("amount"),
                "payment_mode":   settlement.get("payment_mode"),
            },
            metadata={
                "payment_amount":     payment_amount,
                "discount_amount":    discount_amount,
                "discount_type":      discount_type,
                "discount_reason":    discount_reason,
                "is_bad_debt":        bool(is_bad_debt and discount_type == "financial"),
                "credit_note_number": (cn_for_response or {}).get("cn_number"),
                "guest_mobile":       settlement.get("guest_mobile", ""),
            },
        )

        _fully_paid = settlement.get("status") == "paid"
        return jsonify(
            success=True,
            message=message,
            settlement_id=settlement_id,
            settlement_status=settlement.get("status"),
            fully_paid=_fully_paid,
            payment_mode=payment_mode,
            payment_amount=payment_amount,
            discount_amount=discount_amount,
            # 0 once it is settled: the stored amount is the invoice figure
            # and stays put, so reading it back as "remaining" told the desk
            # a paid balance was still owed.
            remaining=0 if _fully_paid else settlement.get("amount", 0),
            guest_mobile=settlement.get("guest_mobile", ""),
            bill_id=_bill_id_updated,
            bill_status=_bill_status,
            bill_balance=_bill_balance,
            credit_note_number=(cn_for_response or {}).get("cn_number"),
            credit_note_id=(cn_for_response or {}).get("cn_id"),
        )

    except Exception as e:
        logger.error(f"Error collecting settlement payment: {str(e)}")
        return jsonify(success=False, message=f"Error collecting settlement payment: {str(e)}")


@settlements_bp.route("/cancel_settlement", methods=["POST"])
@requires_permission("settlement.manage")
def cancel_settlement():
    """
    Cancel a pending settlement (e.g. operator created one in error, or the
    guest paid through another channel).

    A2: This route no longer supports hard-delete. Settlement docs are
    append-only: a cancellation flips status to "cancelled" and stamps
    reason + actor + timestamps. Every call writes an audit_logs entry with
    the before/after settlement state — even if the original doc is later
    edited, the audit log is the source of truth for "who cancelled what,
    when, and why".
    """
    try:
        data_json = request.json or {}
        settlement_id = data_json.get("settlement_id")
        reason = (data_json.get("reason") or "").strip() or "Cancelled by user"

        if not settlement_id:
            return jsonify(success=False, message="settlement_id is required"), 400

        settlement_doc = settlements_ref.document(settlement_id).get()
        if not settlement_doc.exists:
            return jsonify(success=False, message="Settlement not found")

        settlement = settlement_doc.to_dict()
        cur_status = (settlement.get("status") or "").lower()

        # Refuse to cancel a settlement that has already been (fully or
        # partially) collected — the money has moved and we can't roll it
        # back from here. The operator should issue a refund instead.
        if cur_status in ("paid", "partial"):
            return jsonify(
                success=False,
                message=(f"Settlement is already {cur_status!r} and cannot be "
                         "cancelled. Issue a refund through the bill instead."),
            ), 409

        # Idempotency: a second click on Cancel should be a no-op.
        if cur_status == "cancelled":
            return jsonify(
                success=True,
                message="Settlement was already cancelled",
            )

        guest_name = settlement.get("guest_name", "")
        amount = settlement.get("amount", 0)
        before_snapshot = {
            "status":  settlement.get("status"),
            "amount":  amount,
            "room":    settlement.get("room"),
        }

        now_d = datetime.now(IST).strftime("%Y-%m-%d")
        now_t = datetime.now(IST).strftime("%H:%M")
        cancel_update = {
            "status":        "cancelled",
            "cancel_date":   now_d,
            "cancel_time":   now_t,
            "cancel_reason": reason,
        }
        settlements_ref.document(settlement_id).update(cancel_update)

        invalidate_rooms_and_totals()

        write_log(
            "settlement.cancel",
            target_collection="settlements",
            target_id=str(settlement_id),
            before=before_snapshot,
            after={
                "status":        "cancelled",
                "cancel_reason": reason,
            },
            metadata={
                "guest_name": guest_name,
                "amount":     amount,
            },
        )

        logger.info(f"Settlement cancelled: Rs.{amount} from {guest_name}, reason: {reason}")

        return jsonify(
            success=True,
            message=f"Settlement of Rs.{amount} cancelled successfully",
        )

    except Exception as e:
        logger.error(f"Error cancelling settlement: {str(e)}")
        return jsonify(success=False, message=f"Error cancelling settlement: {str(e)}")
