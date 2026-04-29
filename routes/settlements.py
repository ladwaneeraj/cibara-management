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
)

# settlements_ref and bills_ref defined in config
from config import settlements_ref, bills_ref

from services import payment_service

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

        settlement_doc = settlements_ref.document(settlement_id).get()
        if not settlement_doc.exists:
            return jsonify(success=False, message="Settlement not found")

        settlement = settlement_doc.to_dict()
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
                "serial_number": original_serial,
            }
            if _linked_stay_id:
                payment_service.write_payment_with_stay(_linked_stay_id, _settle_disc)
            else:
                payment_service.write_payment(_settle_disc)

        # ── Update the linked bill record ────────────────────────────────────────
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

                bills_ref.document(bill_doc.id).update(bill_update)
                logger.info(f"Bill {bill_doc.id} updated after settlement collection "
                            f"(balance now ₹{new_balance})")
                break
        except Exception as _be:
            logger.warning(f"Could not update bill for settlement {settlement_id}: {_be}")

        # ─────────────────────────────────────────────────────────────────────────

        is_full = (payment_amount == settlement.get("amount", payment_amount))
        if is_full:
            message = f"Full payment of ₹{payment_amount} collected successfully"
        else:
            message = f"Partial payment of ₹{payment_amount} collected. Remaining: ₹{settlement['amount']}"

        return jsonify(
            success=True,
            message=message,
            payment_mode=payment_mode,
            remaining=settlement.get("amount", 0),
        )

    except Exception as e:
        logger.error(f"Error collecting settlement payment: {str(e)}")
        return jsonify(success=False, message=f"Error collecting settlement payment: {str(e)}")


@settlements_bp.route("/cancel_settlement", methods=["POST"])
def cancel_settlement():
    try:
        data_json = request.json
        settlement_id = data_json["settlement_id"]
        reason = data_json.get("reason", "Cancelled by user")

        settlement_doc = settlements_ref.document(settlement_id).get()
        if not settlement_doc.exists:
            return jsonify(success=False, message="Settlement not found")

        settlement = settlement_doc.to_dict()

        guest_name = settlement["guest_name"]
        amount = settlement["amount"]

        if data_json.get("delete", False):
            settlements_ref.document(settlement_id).delete()
        else:
            settlement["status"] = "cancelled"
            settlement["cancel_date"] = datetime.now(IST).strftime("%Y-%m-%d")
            settlement["cancel_time"] = datetime.now(IST).strftime("%H:%M")
            settlement["cancel_reason"] = reason
            settlements_ref.document(settlement_id).set(settlement)

        invalidate_rooms_and_totals()

        logger.info(f"Settlement cancelled: ₹{amount} from {guest_name}, reason: {reason}")

        return jsonify(
            success=True,
            message=f"Settlement of ₹{amount} cancelled successfully",
        )

    except Exception as e:
        logger.error(f"Error cancelling settlement: {str(e)}")
        return jsonify(success=False, message=f"Error cancelling settlement: {str(e)}")
