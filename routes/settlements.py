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

# settlements_ref defined in config but import it
from config import settlements_ref

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

        # Write settlement payment to payments collection
        payment_service.write_payment({
            "room": settlement["room"], "name": settlement["guest_name"],
            "amount": payment_amount, "method": payment_mode,
            "type": "settlement_payment",
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "time": datetime.now(IST).strftime("%H:%M"),
            "settlement_id": settlement_id,
            "transaction_type": "settlement_payment",
            "serial_number": original_serial,
        })

        # Write discount to payments collection (previously missing — gap fix)
        if discount_amount > 0:
            payment_service.write_payment({
                "room": settlement["room"], "name": settlement["guest_name"],
                "amount": discount_amount, "method": "discount",
                "type": "discount",
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "time": datetime.now(IST).strftime("%H:%M"),
                "settlement_id": settlement_id,
                "transaction_type": "settlement_discount",
                "reason": discount_reason,
                "serial_number": original_serial,
            })

        if payment_amount == settlement["amount"]:
            message = f"Full payment of ₹{payment_amount} collected successfully"
        else:
            message = f"Partial payment of ₹{payment_amount} collected. Remaining: ₹{settlement['amount']}"

        return jsonify(
            success=True,
            message=message,
            payment_mode=payment_mode,
            remaining=settlement["amount"],
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
