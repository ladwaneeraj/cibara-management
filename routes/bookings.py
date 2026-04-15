"""Booking management routes"""
from flask import Blueprint, request, jsonify
from datetime import datetime
import uuid
from firebase_admin import firestore
from config import (
    db, bookings_ref, logs_ref, totals_ref, IST, logger,
    invalidate_rooms_and_totals,
    rooms_ref, get_next_serial_number, store_transaction_metadata, send_whatsapp_message,
    settlements_ref, ota_settlements_ref  # logs_ref kept for whatsapp_messages only
)
from services import payment_service, customer_service

bookings_bp = Blueprint('bookings', __name__)

# Fix 6: whitelist of accepted payment method values
VALID_PAYMENT_METHODS = {"cash", "upi", "card", "online", "balance", "ota", "already_paid", "bank_settlement"}

@bookings_bp.route("/get_bookings", methods=["GET"])
def get_bookings():
    try:
        bookings_stream = bookings_ref.stream()
        bookings_list = []
        for booking_doc in bookings_stream:
            booking = booking_doc.to_dict()
            booking["booking_id"] = booking_doc.id
            bookings_list.append(booking)
        bookings_list.sort(key=lambda b: b.get("check_in_date", ""), reverse=True)
        return jsonify(success=True, bookings=bookings_list)
    except Exception as e:
        logger.error(f"Error getting bookings: {str(e)}")
        return jsonify(success=False, message=f"Error getting bookings: {str(e)}")

@bookings_bp.route("/create_booking", methods=["POST"])
def create_booking():
    try:
        booking_data = request.json
        required_fields = ["room", "guest_name", "guest_mobile", "check_in_date", "check_in_time", "check_out_date", "total_amount"]
        for field in required_fields:
            if field not in booking_data:
                return jsonify(success=False, message=f"Missing required field: {field}")

        # Fix 11: require non-blank guest name
        if not str(booking_data.get("guest_name", "")).strip():
            return jsonify(success=False, message="Guest name cannot be blank")

        booking_id = str(uuid.uuid4())
        booking_source = booking_data.get("booking_source", "normal")
        is_mmt = booking_source == "mmt"

        # For MMT: total_amount = net_receivable; advance payment is not collected at hotel
        if is_mmt:
            ota_total = int(booking_data.get("ota_total_amount", 0))
            ota_commission = float(booking_data.get("ota_commission", 0))
            ota_commission_gst = float(booking_data.get("ota_commission_gst", 0))
            net_receivable = ota_total - ota_commission - ota_commission_gst
            total_amount = ota_total
            paid_amount_val = 0
        else:
            ota_total = 0
            ota_commission = 0.0
            ota_commission_gst = 0.0
            net_receivable = 0
            total_amount = int(booking_data["total_amount"])
            paid_amount_val = int(booking_data.get("paid_amount", 0))

        # Fix 5: reject negative amounts
        if total_amount < 0:
            return jsonify(success=False, message="Total amount cannot be negative")
        if paid_amount_val < 0:
            return jsonify(success=False, message="Paid amount cannot be negative")

        # Fix 6: whitelist payment method
        payment_method_input = booking_data.get("payment_method", "cash") if not is_mmt else "ota"
        if payment_method_input not in VALID_PAYMENT_METHODS:
            return jsonify(success=False, message=f"Invalid payment method: {payment_method_input}")

        booking = {
            "room": booking_data["room"],
            "guest_name": booking_data["guest_name"],
            "guest_mobile": booking_data["guest_mobile"],
            "booking_date": datetime.now(IST).strftime("%Y-%m-%d"),
            "check_in_date": booking_data["check_in_date"],
            "check_in_time": booking_data["check_in_time"],
            "check_out_date": booking_data["check_out_date"],
            "status": "confirmed",
            "booking_source": booking_source,
            "payment_source": "ota" if is_mmt else "hotel",
            "total_amount": total_amount,
            "paid_amount": paid_amount_val,
            "balance": total_amount - paid_amount_val,
            "payment_method": booking_data.get("payment_method", "cash") if not is_mmt else "ota",
            "notes": booking_data.get("notes", ""),
            "photo_path": booking_data.get("photo_path", None),
            "guest_count": int(booking_data.get("guest_count", 1)),
        }

        # MMT-specific OTA fields
        if is_mmt:
            booking.update({
                "ota_total_amount": ota_total,
                "ota_commission": ota_commission,
                "ota_commission_gst": ota_commission_gst,
                "net_receivable": net_receivable,
                "settlement_status": "pending",
                "settlement_date": None,
                "settlement_amount": None,
            })

        batch = db.batch()
        paid_amount = paid_amount_val
        if paid_amount > 0:
            payment_method = booking_data.get("payment_method", "cash")
            batch.update(totals_ref.document('current_totals'), {
                payment_method: firestore.Increment(paid_amount),
                "advance_bookings": firestore.Increment(paid_amount)
            })
        
        batch.set(bookings_ref.document(booking_id), booking)
        batch.commit()
        invalidate_rooms_and_totals()

        if paid_amount > 0:
            payment_service.write_payment({
                "room": booking["room"], "name": booking["guest_name"],
                "amount": paid_amount, "method": booking_data.get("payment_method", "cash"),
                "type": "booking_advance",
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "time": datetime.now(IST).strftime("%H:%M"),
                "booking_id": booking_id, "transaction_type": "booking_advance",
                "mobile": booking["guest_mobile"],
                # stay_checkin_date links this pre-stay payment to the actual checkin
                # date so query_payments_for_stay Q2 can find it at checkout
                "stay_checkin_date": booking.get("check_in_date", ""),
            })

        logger.info(f"Booking created: {booking_id} for {booking['guest_name']}")
        return jsonify(success=True, booking_id=booking_id, message="Booking created successfully")
        
    except Exception as e:
        logger.error(f"Error creating booking: {str(e)}")
        return jsonify(success=False, message=f"Error creating booking: {str(e)}")

@bookings_bp.route("/update_booking", methods=["POST"])
def update_booking():
    try:
        booking_data = request.json
        booking_id = booking_data.get("booking_id")
        
        booking_doc = bookings_ref.document(booking_id).get()
        if not booking_doc.exists:
            return jsonify(success=False, message="Invalid booking ID")
        
        booking = booking_doc.to_dict()
        batch = db.batch()
        
        new_payment_amount = int(booking_data.get("new_payment", 0))
        # Fix 5: reject negative payment
        if new_payment_amount < 0:
            return jsonify(success=False, message="Payment amount cannot be negative")
        if new_payment_amount > 0:
            payment_method = booking_data.get("payment_method", "cash")
            # Fix 6: whitelist payment method
            if payment_method not in VALID_PAYMENT_METHODS:
                return jsonify(success=False, message=f"Invalid payment method: {payment_method}")
            batch.update(totals_ref.document('current_totals'), {
                payment_method: firestore.Increment(new_payment_amount),
                "advance_bookings": firestore.Increment(new_payment_amount)
            })
            booking["paid_amount"] += new_payment_amount
            booking["balance"] = booking["total_amount"] - booking["paid_amount"]
        
        updatable_fields = [
            "guest_name", "guest_mobile", "check_in_date", "check_in_time", "check_out_date",
            "room", "notes", "guest_count", "total_amount", "status"
        ]
        
        for field in updatable_fields:
            if field in booking_data:
                booking[field] = booking_data[field]
        
        if "total_amount" in booking_data:
            booking["total_amount"] = int(booking_data["total_amount"])
            booking["balance"] = booking["total_amount"] - booking["paid_amount"]
            
        batch.set(bookings_ref.document(booking_id), booking)
        batch.commit()
        invalidate_rooms_and_totals()

        if new_payment_amount > 0:
            payment_service.write_payment({
                "room": booking["room"], "name": booking["guest_name"],
                "amount": new_payment_amount,
                "method": booking_data.get("payment_method", "cash"),
                "type": "booking_payment",
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "time": datetime.now(IST).strftime("%H:%M"),
                "booking_id": booking_id, "transaction_type": "booking_payment",
                "stay_checkin_date": booking.get("check_in_date", ""),
            })

        logger.info(f"Booking updated: {booking_id}")
        return jsonify(success=True, booking=booking, message="Booking updated successfully")
        
    except Exception as e:
        logger.error(f"Error updating booking: {str(e)}")
        return jsonify(success=False, message=f"Error updating booking: {str(e)}")

@bookings_bp.route("/cancel_booking", methods=["POST"])
def cancel_booking():
    try:
        booking_data = request.json
        booking_id = booking_data.get("booking_id")
        
        booking_doc = bookings_ref.document(booking_id).get()
        if not booking_doc.exists:
            return jsonify(success=False, message="Invalid booking ID")
        
        booking = booking_doc.to_dict()
        batch = db.batch()
        
        refund_amount = int(booking_data.get("refund_amount", 0))
        # Fix 5: reject negative refund
        if refund_amount < 0:
            return jsonify(success=False, message="Refund amount cannot be negative")
        if refund_amount > 0:
            refund_method = booking_data.get("refund_method", "cash")
            # Fix 6: whitelist refund method
            if refund_method not in VALID_PAYMENT_METHODS:
                return jsonify(success=False, message=f"Invalid refund method: {refund_method}")
            batch.update(totals_ref.document('current_totals'), {"refunds": firestore.Increment(refund_amount)})
            booking["paid_amount"] -= refund_amount
            booking["balance"] = booking["total_amount"] - booking["paid_amount"]
        
        booking["status"] = "cancelled"
        booking["cancellation_date"] = datetime.now(IST).strftime("%Y-%m-%d")
        booking["cancellation_reason"] = booking_data.get("reason", "")
        
        batch.set(bookings_ref.document(booking_id), booking)
        batch.commit()
        invalidate_rooms_and_totals()

        if refund_amount > 0:
            payment_service.write_payment({
                "room": booking["room"], "name": booking["guest_name"],
                "amount": refund_amount,
                "method": booking_data.get("refund_method", "cash"),
                "type": "booking_cancel_refund",
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "time": datetime.now(IST).strftime("%H:%M"),
                "booking_id": booking_id, "transaction_type": "booking_cancel_refund",
            })

        logger.info(f"Booking cancelled: {booking_id}")
        return jsonify(success=True, message="Booking cancelled successfully")
        
    except Exception as e:
        logger.error(f"Error cancelling booking: {str(e)}")
        return jsonify(success=False, message=f"Error cancelling booking: {str(e)}")

@bookings_bp.route("/convert_booking_to_checkin", methods=["POST"])
def convert_booking_to_checkin():
    try:
        booking_data = request.json
        booking_id = booking_data.get("booking_id")
        
        booking_doc = bookings_ref.document(booking_id).get()
        if not booking_doc.exists:
            return jsonify(success=False, message="Invalid booking ID")
        
        booking = booking_doc.to_dict()
        room_number = booking["room"]
        room_doc = rooms_ref.document(room_number).get()
        
        if not room_doc.exists:
            return jsonify(success=False, message=f"Room {room_number} does not exist")
        
        room_data = room_doc.to_dict()
        
        if room_data["status"] != "vacant":
            return jsonify(success=False, message=f"Room {room_number} is not vacant")
        
        remaining_payment = int(booking_data.get("remaining_payment", 0))
        payment_method = booking_data.get("payment_method", "cash")
        balance_after_payment = booking["balance"] - remaining_payment
        
        current_date = datetime.now(IST).strftime("%Y-%m-%d")
        current_time = datetime.now(IST).strftime("%H:%M")
        serial_number = get_next_serial_number(current_date)
        
        expected_time = booking.get("check_in_time", "14:00")
        expected_datetime_str = f"{current_date} {expected_time}"
        current_datetime = datetime.now(IST)
        
        try:
            expected_datetime = IST.localize(datetime.strptime(expected_datetime_str, "%Y-%m-%d %H:%M"))

            if current_datetime < expected_datetime:
                checkin_datetime_str = expected_datetime_str
                logger.info(f"Guest arriving early. Using expected check-in time: {expected_datetime_str}")
            else:
                checkin_datetime_str = current_datetime.strftime("%Y-%m-%d %H:%M")
                logger.info(f"Guest arriving on time or late. Using current time: {checkin_datetime_str}")
        except Exception as e:
            logger.error(f"Error parsing expected time, using current time: {str(e)}")
            checkin_datetime_str = current_datetime.strftime("%Y-%m-%d %H:%M")
        
        batch = db.batch()
        totals_update = {}

        if remaining_payment > 0:
            totals_update[payment_method] = firestore.Increment(remaining_payment)
        
        room_price = int(booking_data.get("room_price", booking["total_amount"]))
        is_ac = False
        
        if room_number in ["202", "203", "204", "205"]:
            if "is_ac" in booking:
                is_ac = booking["is_ac"]
            else:
                is_ac = True
        
        guest = {
            "name": booking["guest_name"],
            "mobile": booking["guest_mobile"],
            "price": room_price,
            "guests": booking["guest_count"],
            "payment": payment_method,
            "balance": balance_after_payment if balance_after_payment > 0 else 0,
            "photo": booking.get("photo_path"),
            "isAC": is_ac
        }
        
        batch.update(rooms_ref.document(room_number), {
            "status": "occupied",
            "guest": guest,
            "checkin_time": checkin_datetime_str,
            "balance": balance_after_payment if balance_after_payment > 0 else 0,
            "add_ons": [],
            "renewal_count": 0,
            "last_renewal_time": None
        })
        
        if balance_after_payment > 0:
            totals_update["balance"] = firestore.Increment(balance_after_payment)

        booking["status"] = "checked_in"
        booking["check_in_time"] = checkin_datetime_str
        booking["actual_checkin_time"] = current_datetime.strftime("%Y-%m-%d %H:%M")

        batch.set(bookings_ref.document(booking_id), booking)
        if totals_update:
            batch.update(totals_ref.document('current_totals'), totals_update)
        batch.commit()

        # Fix 4: store_transaction_metadata AFTER batch commit
        store_transaction_metadata(room_number, current_date, serial_number, "booking_conversion")

        invalidate_rooms_and_totals()

        stay_key = f"{room_number}_{checkin_datetime_str}"
        if remaining_payment > 0:
            payment_service.write_payment({
                "room": room_number, "name": booking["guest_name"],
                "amount": remaining_payment, "method": payment_method,
                "type": "booking_conversion",
                "date": current_date, "time": current_time,
                "serial_number": serial_number, "booking_id": booking_id,
                "stay_room_key": stay_key,
                "transaction_type": "booking_conversion",
                "is_booking_conversion": True,
                "mobile": booking["guest_mobile"],
            })
        else:
            payment_service.write_payment({
                "room": room_number, "name": booking["guest_name"],
                "amount": 0, "method": "already_paid",
                "type": "booking_conversion",
                "date": current_date, "time": current_time,
                "serial_number": serial_number, "booking_id": booking_id,
                "stay_room_key": stay_key,
                "transaction_type": "booking_conversion",
                "is_booking_conversion": True,
                "mobile": booking["guest_mobile"],
            })
        if balance_after_payment > 0:
            payment_service.write_payment({
                "room": room_number, "name": booking["guest_name"],
                "amount": balance_after_payment, "method": "balance",
                "type": "booking_balance",
                "date": current_date, "time": current_time,
                "serial_number": serial_number, "booking_id": booking_id,
                "stay_room_key": stay_key,
                "transaction_type": "booking_conversion",
            })

        # --- Link prior booking advance payments to this stay ---
        # The advance was paid on booking date (before checkin_date), so
        # query_payments_for_stay(date >= checkin_date) misses it.
        # Update those docs to add stay_room_key so they appear in history/bills.
        try:
            from google.cloud.firestore_v1.base_query import FieldFilter as _FF
            payments_ref = db.collection("payments")
            prior_q = (
                payments_ref
                .where(filter=_FF("booking_id", "==", booking_id))
            )
            for pdoc in prior_q.stream():
                pdata = pdoc.to_dict()
                if pdata.get("type") in ("booking_advance", "booking_payment"):
                    pdoc.reference.update({
                        "stay_room_key": stay_key,
                        "stay_checkin_date": current_date,
                    })
                    logger.info(f"Linked booking advance {pdoc.id} to stay {stay_key}")
        except Exception as e:
            logger.warning(f"Failed to link booking advances to stay: {e}")

        # Fix 7: sync=True so errors surface in logs rather than dying silently
        customer_service.upsert_customer({
            "name": booking["guest_name"],
            "mobile": booking["guest_mobile"],
        }, amount_paid=remaining_payment, sync=True)

        arrival_status = "early" if current_datetime < expected_datetime else "on time"

        logger.info(
            f"Booking {booking_id} converted to check-in for room {room_number} "
            f"with serial #{serial_number}. Guest arrived {arrival_status}. "
            f"Check-in time: {checkin_datetime_str}"
        )
        
        return jsonify(
            success=True,
            message=f"Guest checked in to Room {room_number}",
            serial_number=serial_number,
            checkin_time=checkin_datetime_str,
            arrival_status=arrival_status
        )
        
    except Exception as e:
        logger.error(f"Error converting booking to check-in: {str(e)}", exc_info=True)
        return jsonify(success=False, message=f"Error converting booking to check-in: {str(e)}")

@bookings_bp.route("/check_availability", methods=["POST"])
def check_availability():
    try:
        request_data = request.json
        check_in_date = request_data.get("check_in_date")
        check_out_date = request_data.get("check_out_date")
        
        if not check_in_date or not check_out_date:
            return jsonify(success=False, message="Check-in and check-out dates are required")
        
        try:
            check_in = datetime.strptime(check_in_date, "%Y-%m-%d")
            check_out = datetime.strptime(check_out_date, "%Y-%m-%d")
        except ValueError:
            return jsonify(success=False, message="Invalid date format. Use YYYY-MM-DD")
        
        bookings_stream = bookings_ref.stream()
        booked_rooms = set()
        
        for booking_doc in bookings_stream:
            booking = booking_doc.to_dict()
            
            if booking.get("status") in ["cancelled", "checked_in"]:
                continue
                
            booking_check_in = datetime.strptime(booking["check_in_date"], "%Y-%m-%d")
            booking_check_out = datetime.strptime(booking["check_out_date"], "%Y-%m-%d")
            
            if (check_in < booking_check_out and check_out > booking_check_in):
                booked_rooms.add(booking["room"])
        
        today = datetime.now(IST).replace(hour=0, minute=0, second=0, microsecond=0)
        
        if check_in.date() == today.date():
            rooms_stream = rooms_ref.stream()
            
            for room_doc in rooms_stream:
                room_data = room_doc.to_dict()
                if room_data["status"] == "occupied":
                    booked_rooms.add(room_doc.id)
        
        all_rooms_stream = rooms_ref.stream()
        all_rooms = [room_doc.id for room_doc in all_rooms_stream]
        
        available_rooms = [room for room in all_rooms if room not in booked_rooms]
        available_rooms.sort(key=lambda r: (int(r) if r.isdigit() else float('inf'), r))
        
        return jsonify(success=True, available_rooms=available_rooms)
        
    except Exception as e:
        logger.error(f"Error checking availability: {str(e)}")
        return jsonify(success=False, message=f"Error checking availability: {str(e)}")

@bookings_bp.route("/send_booking_confirmation", methods=["POST"])
def send_booking_confirmation():
    try:
        data_json = request.json
        booking_id = data_json.get("booking_id")
        phone_number = data_json.get("phone_number")
        
        if not booking_id or not phone_number:
            return jsonify(success=False, message="Booking ID and phone number are required")
        
        booking_doc = bookings_ref.document(booking_id).get()
        if not booking_doc.exists:
            return jsonify(success=False, message="Invalid booking ID")
        
        booking = booking_doc.to_dict()
        
        phone_number = phone_number.strip()
        if phone_number.startswith('0'):
            phone_number = phone_number[1:]
        
        if not phone_number.startswith('91'):
            phone_number = f"91{phone_number}"
        
        maps_link = "https://maps.app.goo.gl/Mz5rTrvC3ctyMmUt5"
        
        check_in = datetime.strptime(booking["check_in_date"], "%Y-%m-%d")
        check_out = datetime.strptime(booking["check_out_date"], "%Y-%m-%d")
        nights = (check_out - check_in).days
        
        formatted_check_in = check_in.strftime("%d %b %Y")
        formatted_check_out = check_out.strftime("%d %b %Y")
        
        message = f"""🏨 *BOOKING CONFIRMATION*

Hello {booking['guest_name']},

Your booking at our lodge has been confirmed!

📋 *Booking Details:*
• Booking ID: {booking_id[:8].upper()}
• Room: {booking['room']}
• Check-in: {formatted_check_in}
• Check-out: {formatted_check_out}
• Duration: {nights} night{'s' if nights != 1 else ''}
• Guests: {booking['guest_count']}

💰 *Payment Status:*
• Total Amount: ₹{booking['total_amount']}
• Paid: ₹{booking['paid_amount']}
• Balance Due: ₹{booking['balance']}

📍 *Location:*
{maps_link}

If you have any questions, please feel free to contact us.

Thank you for choosing us! 🙏"""

        success = send_whatsapp_message(phone_number, message)
        
        if success:
            log_entry = {
                "booking_id": booking_id,
                "guest_name": booking["guest_name"],
                "phone_number": phone_number,
                "message_type": "booking_confirmation",
                "status": "sent",
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "time": datetime.now(IST).strftime("%H:%M")
            }
            
            whatsapp_log = logs_ref.document("whatsapp_messages").get()
            if whatsapp_log.exists:
                logs_ref.document("whatsapp_messages").update({
                    "entries": firestore.ArrayUnion([log_entry])
                })
            else:
                logs_ref.document("whatsapp_messages").set({
                    "entries": [log_entry]
                })
            
            logger.info(f"WhatsApp confirmation sent for booking {booking_id} to {phone_number}")
            return jsonify(success=True, message="Confirmation message sent successfully")
        else:
            return jsonify(success=False, message="Failed to send WhatsApp message. Please check API configuration.")
            
    except Exception as e:
        logger.error(f"Error sending booking confirmation: {str(e)}")
        return jsonify(success=False, message=f"Error sending confirmation: {str(e)}")


@bookings_bp.route("/mark_ota_settlement", methods=["POST"])
def mark_ota_settlement():
    """Mark an MMT booking's settlement as received."""
    try:
        data = request.json
        booking_id = data.get("booking_id")
        settlement_date = data.get("settlement_date")
        settlement_amount = float(data.get("settlement_amount", 0))

        if not booking_id or not settlement_date or settlement_amount <= 0:
            return jsonify(success=False, message="booking_id, settlement_date and settlement_amount are required")

        booking_doc = bookings_ref.document(booking_id).get()
        if not booking_doc.exists:
            return jsonify(success=False, message="Booking not found")

        booking = booking_doc.to_dict()
        if booking.get("booking_source") != "mmt":
            return jsonify(success=False, message="Settlement is only applicable to MMT bookings")
        if booking.get("settlement_status") == "received":
            return jsonify(success=False, message="Settlement already marked as received")

        # Update booking doc
        bookings_ref.document(booking_id).update({
            "settlement_status": "received",
            "settlement_date": settlement_date,
            "settlement_amount": settlement_amount,
        })

        # Write to ota_settlements collection (separate from hotel-side settle-later)
        settlement_entry = {
            "booking_id": booking_id,
            "platform": "mmt",
            "type": "bank_settlement",
            "room": booking.get("room", ""),
            "guest_name": booking.get("guest_name", ""),
            "net_receivable": booking.get("net_receivable", 0),
            "settlement_amount": settlement_amount,
            "settlement_date": settlement_date,
            "created_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M"),
        }
        ota_settlements_ref.add(settlement_entry)

        # Also write to payments collection for traceability (method="bank_settlement")
        payment_service.write_payment({
            "room": booking.get("room", ""),
            "name": booking.get("guest_name", ""),
            "amount": settlement_amount,
            "method": "bank_settlement",
            "type": "bank_settlement",
            "date": settlement_date,
            "time": datetime.now(IST).strftime("%H:%M"),
            "booking_id": booking_id,
            "transaction_type": "bank_settlement",
            "platform": "mmt",
        })

        logger.info(f"OTA settlement received for booking {booking_id}: ₹{settlement_amount} on {settlement_date}")
        return jsonify(success=True, message=f"Settlement of ₹{settlement_amount} marked as received")

    except Exception as e:
        logger.error(f"Error marking OTA settlement: {str(e)}")
        return jsonify(success=False, message=f"Error: {str(e)}")


@bookings_bp.route("/get_ota_settlements", methods=["GET"])
def get_ota_settlements():
    """
    Return all OTA (MMT / Booking.com) bank settlements.
    Reads from ota_settlements collection — completely separate from
    hotel-side 'settle later' records in the settlements collection.
    """
    try:
        docs = ota_settlements_ref.order_by("settlement_date", direction="DESCENDING").stream()
        settlements = []
        for doc in docs:
            entry = doc.to_dict()
            entry["id"] = doc.id
            settlements.append(entry)
        return jsonify(success=True, settlements=settlements)
    except Exception as e:
        logger.error(f"Error fetching OTA settlements: {str(e)}")
        return jsonify(success=False, message=f"Error: {str(e)}")


@bookings_bp.route("/get_mmt_unsettled", methods=["GET"])
def get_mmt_unsettled():
    """
    Return all MMT bookings where settlement has NOT been received yet.
    Queries bookings collection for booking_source=mmt AND settlement_status=pending.
    Sorted by check-in date descending (most recent first).
    """
    try:
        docs = (
            bookings_ref
            .where("booking_source", "==", "mmt")
            .where("settlement_status", "==", "pending")
            .stream()
        )
        unsettled = []
        for doc in docs:
            b = doc.to_dict()
            b["booking_id"] = doc.id
            unsettled.append(b)

        # Sort by check_in_date descending (string sort works for YYYY-MM-DD)
        unsettled.sort(key=lambda x: x.get("check_in_date", ""), reverse=True)

        return jsonify(success=True, unsettled=unsettled)
    except Exception as e:
        logger.error(f"Error fetching unsettled MMT bookings: {str(e)}")
        return jsonify(success=False, message=f"Error: {str(e)}")
