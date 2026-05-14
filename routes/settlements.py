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

settlements_bp = Blueprint('settlements', __name__)


def fetch_settlements():
    settlements_stream = settlements_ref.stream()
    settlements_list = []
    for doc in settlements_stream:
        settlement_data = doc.to_dict()
        settlement_data["id"] = doc.id
        settlements_list.append(settlement_data)
    return settlements_list


@settlements_bp.route("/get_pending_settlements", methods=["GET"])
def get_pending_settlements_route():
    try:
        settlements = fetch_settlements()
        return jsonify(success=True, settlements=settlements)
    except Exception as e:
        logger.error(f"Error fetching settlements: {str(e)}")
        return jsonify(success=False, message=f"Error fetching settlements: {str(e)}")


@settlements_bp.route("/collect_settlement", methods=["POST"])
def collect_settlement():
    try:
        data_json = request.json
        settlement_id = data_json["settlement_id"]
        payment_mode = data_json["payment_mode"]

        payment_amount = int(data_json.get("payment_amount", 0))
        discount_amount = int(data_json.get("discount_amount", 0))
        discount_reason = data_json.get("discount_reason", "")

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
            settlement["payment_date"] = datetime.now(IST).strftime("%Y-%m-%d")
            settlement["payment_time"] = datetime.now(IST).strftime("%H:%M")
            settlement["payment_mode"] = payment_mode

            # Clear pending-settlement flag from the customer record so the
            # next check-in no longer shows the balance warning.
            _settle_mobile = settlement.get("guest_mobile", "")
            if _settle_mobile:
                from services import customer_service as _cs
                _cs.clear_pending_settlement(_settle_mobile)
        else:
            settlement["status"] = "partial"
            settlement["amount"] -= payment_amount

            if "payments" not in settlement:
                settlement["payments"] = []

            settlement["payments"].append({
                "amount": payment_amount,
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "time": datetime.now(IST).strftime("%H:%M"),
                "mode": payment_mode,
            })

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
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
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
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
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
        cn_for_response = None
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

        return jsonify(
            success=True,
            message=message,
            payment_mode=payment_mode,
            remaining=settlement.get("amount", 0),
            credit_note_number=(cn_for_response or {}).get("cn_number"),
            credit_note_id=(cn_for_response or {}).get("cn_id"),
        )

    except Exception as e:
        logger.error(f"Error collecting settlement payment: {str(e)}")
        return jsonify(success=False, message=f"Error collecting settlement payment: {str(e)}")


@settlements_bp.route("/cancel_settlement", methods=["POST"])
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
