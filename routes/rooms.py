"""
Room management routes: checkin, checkout, add_on, renew_rent, update_checkin_time,
add_room, transfer_room, mark_room_cleaned, apply_discount, get_rooms_only, get_data,
get_history, get_totals_only
"""

from flask import Blueprint, request, jsonify
from datetime import datetime, timedelta
import logging
import uuid

from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from config import (
    db, rooms_ref, totals_ref, bookings_ref, metadata_ref,
    counters_ref, bills_ref, IST, logger, invalidate_cache,
    invalidate_rooms_and_totals, get_all_rooms,
    get_totals, is_log_from_current_stay, get_next_serial_number,
    store_transaction_metadata, create_bill_record,
    find_serial_number_for_checkin, _build_active_entry_fast, _find_serial_fast,
    _batch_fill_serials
)
from services import payment_service, customer_service

rooms_bp = Blueprint('rooms', __name__)

@rooms_bp.route("/checkin", methods=["POST"])
def checkin():
    try:
        data_json = request.json
        room = data_json["room"]
        amount_paid = int(data_json.get("amountPaid", 0))
        price = int(data_json["price"])
        balance = price - amount_paid
        payment = data_json["payment"]
        is_ac = data_json.get("isAC", False)

        if amount_paid > 0 and payment == "balance":
            return jsonify(success=False, message="Cannot use 'Pay Later' with an amount paid. Please select Cash or Online.")

        guest = {
            "name": data_json["name"],
            "mobile": data_json["mobile"],
            "price": price,
            "guests": int(data_json["guests"]),
            "payment": payment,
            "balance": balance,
            "isAC": is_ac
        }

        current_time = datetime.now(IST).strftime("%Y-%m-%d %H:%M")
        current_date = datetime.now(IST).strftime("%Y-%m-%d")

        serial_number = get_next_serial_number(current_date)

        # ── Fix 2: Atomically claim the room — prevents double check-in ──────
        room_ref = rooms_ref.document(room)

        @firestore.transactional
        def _claim_room(txn, r_ref):
            snap = r_ref.get(transaction=txn)
            if not snap.exists:
                raise ValueError(f"Room {room} does not exist")
            if snap.to_dict().get("status") != "vacant":
                raise ValueError(f"Room {room} is already occupied")
            txn.update(r_ref, {
                "status": "occupied",
                "guest": guest,
                "checkin_time": current_time,
                "balance": balance,
                "add_ons": [],
                "renewal_count": 0,
                "last_renewal_time": None,
            })

        try:
            _claim_room(db.transaction(), room_ref)
        except ValueError as ve:
            return jsonify(success=False, message=str(ve))

        # Room is now atomically claimed — write logs and totals in a batch
        batch = db.batch()

        # Build atomic update for totals
        totals_update = {}

        if payment != "balance":
            if amount_paid > 0:
                totals_update[payment] = firestore.Increment(amount_paid)

        if balance > 0:
            totals_update["balance"] = firestore.Increment(balance)

        if totals_update:
            batch.update(totals_ref.document('current_totals'), totals_update)
        batch.commit()

        # Fix 4: store_transaction_metadata AFTER batch commit so serial is
        # only persisted if the batch succeeded
        store_transaction_metadata(room, current_date, serial_number, "fresh_checkin")

        invalidate_rooms_and_totals()

        # --- Dual-write: payments collection ---
        stay_key = f"{room}_{current_time}"
        if payment != "balance" and amount_paid > 0:
            payment_service.write_payment({
                "room": room, "name": guest["name"], "amount": amount_paid,
                "method": payment, "type": "checkin", "date": current_date,
                "time": datetime.now(IST).strftime("%H:%M"),
                "serial_number": serial_number, "stay_room_key": stay_key,
                "transaction_type": "fresh_checkin", "is_fresh_checkin": True,
                "mobile": data_json.get("mobile", ""),
            })
        elif payment == "balance":
            payment_service.write_payment({
                "room": room, "name": guest["name"], "amount": 0,
                "method": "pay_later", "type": "checkin", "date": current_date,
                "time": datetime.now(IST).strftime("%H:%M"),
                "serial_number": serial_number, "stay_room_key": stay_key,
                "transaction_type": "fresh_checkin", "is_fresh_checkin": True,
                "mobile": data_json.get("mobile", ""),
            })
        if balance > 0:
            payment_service.write_payment({
                "room": room, "name": guest["name"], "amount": balance,
                "method": "balance", "type": "checkin_balance",
                "date": current_date, "time": datetime.now(IST).strftime("%H:%M"),
                "serial_number": serial_number, "stay_room_key": stay_key,
                "transaction_type": "fresh_checkin",
            })

        # Fix 7: sync=True so customer record errors are visible and logged
        # rather than silently swallowed in a daemon thread
        customer_service.upsert_customer({
            "name": guest["name"],
            "mobile": data_json.get("mobile", ""),
            "id_type": data_json.get("id_type", ""),
            "id_number": data_json.get("id_number", ""),
            "address": data_json.get("address", ""),
            "photo": data_json.get("photo_path", ""),
        }, amount_paid=amount_paid, sync=True)

        logger.info(f"Check-in successful for room {room}, guest: {guest['name']}, serial: {serial_number}")
        return jsonify(
            success=True,
            message=f"Check-in successful for {guest['name']} (#{serial_number})",
            serial_number=serial_number
        )
    except Exception as e:
        logger.error(f"Error during check-in: {str(e)}")
        return jsonify(success=False, message=f"Error during check-in: {str(e)}")

@rooms_bp.route("/checkout", methods=["POST"])
def checkout():
    try:
        data_json = request.json
        room = data_json["room"]
        payment_mode = data_json.get("payment_mode")
        amount = int(data_json.get("amount", 0))
        is_refund = data_json.get("is_refund", False)
        is_final_checkout = data_json.get("final_checkout", False)
        process_refund = data_json.get("process_refund", False)
        settle_later = data_json.get("settle_later", False)

        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found")

        room_data = room_doc.to_dict()
        batch = db.batch()

        # Handle payment additions (not final checkout)
        if amount > 0 and payment_mode and not is_refund and not process_refund:
            current_balance = room_data["balance"]

            is_renewal_payment = False
            if room_data["guest"] and room_data["checkin_time"]:
                try:
                    checkin_date = datetime.strptime(room_data["checkin_time"].split()[0], "%Y-%m-%d")
                    current_date = datetime.now(IST).date()
                    days_since_checkin = (current_date - checkin_date.date()).days
                    is_renewal_payment = days_since_checkin >= 1
                except:
                    is_renewal_payment = False

            # Build atomic update for totals
            totals_update = {payment_mode: firestore.Increment(amount)}

            if current_balance > 0:
                if amount >= current_balance:
                    totals_update["balance"] = firestore.Increment(-current_balance)
                    overpayment = amount - current_balance

                    if overpayment > 0:
                        new_balance = -overpayment
                        message = f"Payment of ₹{amount} received. Balance cleared. Overpayment: ₹{overpayment}"
                    else:
                        new_balance = 0
                        message = f"Payment of ₹{amount} received. Balance cleared."
                else:
                    new_balance = current_balance - amount
                    totals_update["balance"] = firestore.Increment(-amount)
                    message = "Payment recorded successfully."
            else:
                new_balance = current_balance - amount
                message = "Payment recorded successfully."

            batch.update(rooms_ref.document(room), {"balance": new_balance})
            batch.update(totals_ref.document('current_totals'), totals_update)
            batch.commit()

            invalidate_rooms_and_totals()

            # --- Dual-write: payments collection ---
            payment_service.write_payment({
                "room": room, "name": room_data["guest"]["name"],
                "amount": amount, "method": payment_mode,
                "type": "renewal" if is_renewal_payment else "payment",
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "time": datetime.now(IST).strftime("%H:%M"),
                "transaction_type": "renewal_payment" if is_renewal_payment else "regular_payment",
                "stay_room_key": f"{room}_{room_data.get('checkin_time', '')}",
            })

            logger.info(f"Payment of ₹{amount} recorded for room {room}")
            return jsonify(success=True, message=message)

        # Handle refund processing
        elif process_refund and is_refund and amount > 0:
            current_balance = room_data["balance"]

            if abs(current_balance) < amount:
                return jsonify(
                    success=False,
                    message=f"Refund amount (₹{amount}) exceeds available balance (₹{abs(current_balance)})"
                )

            refund_method = payment_mode or "cash"
            guest_name = room_data["guest"]["name"]

            new_balance = current_balance + amount
            batch.update(rooms_ref.document(room), {"balance": new_balance})

            batch.update(totals_ref.document('current_totals'), {"refunds": firestore.Increment(amount)})
            batch.commit()

            invalidate_rooms_and_totals()

            # --- Dual-write: payments collection ---
            payment_service.write_payment({
                "room": room, "name": guest_name, "amount": amount,
                "method": refund_method, "type": "manual_refund",
                "date": data_json.get("date", datetime.now(IST).strftime("%Y-%m-%d")),
                "time": data_json.get("time", datetime.now(IST).strftime("%H:%M")),
                "transaction_type": "manual_refund",
                "stay_room_key": f"{room}_{room_data.get('checkin_time', '')}",
            })

            logger.info(f"Manual refund of ₹{amount} processed for room {room}")
            return jsonify(success=True, message=f"Refund of ₹{amount} processed successfully")

        # Handle final checkout
        elif is_final_checkout:
            balance = room_data["balance"]
            guest_info = room_data["guest"]
            guest_name = guest_info["name"] if guest_info else "Unknown"

            # Build atomic update for totals
            totals_update = {}

            # Handle settle later
            if balance > 0 and settle_later:
                settlement_id = str(uuid.uuid4())
                settlement_amount = balance

                # Look up the original check-in serial number so it can be
                # shown in the transaction log when the settlement is collected.
                checkin_dt_str = room_data.get("checkin_time", "")
                _checkin_serial = None
                try:
                    if checkin_dt_str:
                        import re as _re
                        _d = datetime.strptime(checkin_dt_str.split()[0], "%Y-%m-%d")
                        _checkin_serial = payment_service.find_serial_number(
                            room, guest_info["name"], _d
                        )
                except Exception:
                    pass

                settlement = {
                    "id": settlement_id,
                    "guest_name": guest_info["name"],
                    "guest_mobile": guest_info["mobile"],
                    "room": room,
                    "amount": settlement_amount,
                    "checkout_date": datetime.now(IST).strftime("%Y-%m-%d"),
                    "checkout_time": datetime.now(IST).strftime("%H:%M"),
                    "status": "pending",
                    "notes": data_json.get("settlement_notes", ""),
                    "photo": guest_info.get("photo"),
                    "serial_number": _checkin_serial,  # original check-in serial
                    "checkin_time": checkin_dt_str,     # for future lookups
                }

                from config import settlements_ref
                batch.set(settlements_ref.document(settlement_id), settlement)
                totals_update["balance"] = firestore.Increment(-settlement_amount)

                logger.info(f"Settlement created for room {room}, amount: ₹{settlement_amount}")

            elif balance > 0 and not settle_later:
                return jsonify(success=False, message="Please clear the balance before checkout")

            # Handle refund for negative balance
            refund_processed = False
            if balance < 0 and data_json.get("refund_method"):
                refund_amount = abs(balance)
                refund_method = data_json.get("refund_method", "cash")

                totals_update["refunds"] = firestore.Increment(refund_amount)
                refund_processed = True

                # --- Dual-write: checkout refund to payments ---
                payment_service.write_payment({
                    "room": room, "name": guest_name, "amount": refund_amount,
                    "method": refund_method, "type": "checkout_refund",
                    "date": datetime.now(IST).strftime("%Y-%m-%d"),
                    "time": datetime.now(IST).strftime("%H:%M"),
                    "transaction_type": "checkout_refund",
                    "stay_room_key": f"{room}_{room_data.get('checkin_time', '')}",
                })
                logger.info(f"Checkout refund of ₹{refund_amount} processed for room {room}")

            # --- Dual-write: settlement to payments ---
            if balance > 0 and settle_later:
                payment_service.write_payment({
                    "room": room, "name": guest_info["name"],
                    "amount": -balance, "method": "settlement",
                    "type": "settlement", "date": datetime.now(IST).strftime("%Y-%m-%d"),
                    "time": datetime.now(IST).strftime("%H:%M"),
                    "transaction_type": "settlement",
                    "settlement_id": settlement_id,
                    "stay_room_key": f"{room}_{room_data.get('checkin_time', '')}",
                })

            # Save to bills collection
            checkout_time = datetime.now(IST).strftime("%Y-%m-%d %H:%M")
            bill_id = f"{room}_{int(datetime.now(IST).timestamp())}"
            bill_record = create_bill_record(room, room_data, checkout_time, batch)

            if bill_record:
                batch.set(bills_ref.document(bill_id), bill_record)
                logger.info(f"Bill saved for room {room}: {bill_record.get('bill_number')}")

            # Mark room as cleaning
            batch.update(rooms_ref.document(room), {
                "status": "cleaning",
                "guest": None,
                "checkin_time": None,
                "balance": 0,
                "add_ons": [],
                "discounts": [],
                "renewal_count": 0,
                "last_renewal_time": None,
                "cleaning_status": "in_progress",
                "cleaning_start_time": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")
            })

            if totals_update:
                batch.update(totals_ref.document('current_totals'), totals_update)
            batch.commit()

            invalidate_rooms_and_totals()

            if refund_processed:
                refund_amount = abs(balance)
                message = f"Checkout successful. Refund of ₹{refund_amount} processed."
            else:
                message = "Checkout successful"

            logger.info(f"Room {room} checked out. Guest: {guest_name}")
            return jsonify(success=True, message=message)

        return jsonify(success=False, message="Invalid request parameters")

    except Exception as e:
        logger.error(f"Error during checkout: {str(e)}")
        return jsonify(success=False, message=f"Error during checkout: {str(e)}")

@rooms_bp.route("/add_on", methods=["POST"])
def add_on():
    try:
        data_json = request.json
        room = data_json["room"]
        item = data_json["item"]
        price = int(data_json["price"])
        payment_method = data_json.get("payment_method", "balance")

        unit_price = data_json.get("unit_price", price)
        quantity = data_json.get("quantity", 1)

        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found")

        room_data = room_doc.to_dict()
        batch = db.batch()

        add_on_entry = {
            "room": room,
            "item": item,
            "price": price,
            "unit_price": unit_price,
            "quantity": quantity,
            "time": datetime.now(IST).strftime("%H:%M"),
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "payment_method": payment_method,
            "transaction_type": "service"
        }

        # Build atomic update for totals
        totals_update = {}

        if payment_method in ["cash", "online"]:
            totals_update[payment_method] = firestore.Increment(price)
        else:
            new_balance = room_data["balance"] + price
            batch.update(rooms_ref.document(room), {"balance": new_balance})
            totals_update["balance"] = firestore.Increment(price)

        batch.update(rooms_ref.document(room), {
            "add_ons": firestore.ArrayUnion([add_on_entry])
        })

        batch.update(totals_ref.document('current_totals'), totals_update)
        batch.commit()

        invalidate_rooms_and_totals()

        # --- Dual-write: payments collection ---
        payment_service.write_payment({
            "room": room, "name": room_data["guest"]["name"],
            "amount": price, "method": payment_method, "type": "addon",
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "time": datetime.now(IST).strftime("%H:%M"),
            "item": item, "unit_price": unit_price, "quantity": quantity,
            "transaction_type": "service",
            "stay_room_key": f"{room}_{room_data.get('checkin_time', '')}",
        })

        logger.info(f"Add-on '{item}' added to room {room}, price: ₹{price}, payment: {payment_method}")

        if payment_method == "balance":
            return jsonify(success=True, message=f"Added {item} (₹{price}) to room {room} balance")
        else:
            return jsonify(success=True, message=f"Added {item} (₹{price}) to room {room}, paid by {payment_method}")
    except Exception as e:
        logger.error(f"Error adding add-on: {str(e)}")
        return jsonify(success=False, message=f"Error adding add-on: {str(e)}")

@rooms_bp.route("/renew_rent", methods=["POST"])
def renew_rent():
    try:
        data_json = request.json
        room = data_json["room"]

        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found")

        room_data = room_doc.to_dict()

        if room_data["status"] != "occupied" or not room_data["guest"]:
            return jsonify(success=False, message="Room not occupied.")

        guest = room_data["guest"]
        price = guest["price"]

        new_balance = room_data["balance"] + price
        renewal_count = data_json.get("renewal_count", 0)

        batch = db.batch()

        batch.update(rooms_ref.document(room), {
            "balance": new_balance,
            "renewal_count": renewal_count
        })

        batch.update(totals_ref.document('current_totals'), {"balance": firestore.Increment(price)})

        batch.commit()
        invalidate_rooms_and_totals()

        from config import update_last_rent_check
        update_last_rent_check()

        # --- Dual-write: payments collection ---
        payment_service.write_payment({
            "room": room, "name": guest["name"], "amount": price,
            "method": "balance", "type": "renewal",
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "time": datetime.now(IST).strftime("%H:%M"),
            "transaction_type": "rent_renewal",
            "note": f"Day {renewal_count + 1} rent renewal",
            "stay_room_key": f"{room}_{room_data.get('checkin_time', '')}",
        })

        logger.info(f"Rent renewed for Room {room}, Day {renewal_count + 1}")
        return jsonify(success=True, message=f"Rent renewed for Room {room}")
    except Exception as e:
        logger.error(f"Error renewing rent: {str(e)}")
        return jsonify(success=False, message=f"Error renewing rent: {str(e)}")

@rooms_bp.route("/update_checkin_time", methods=["POST"])
def update_checkin_time():
    try:
        data_json = request.json
        room = data_json["room"]
        new_checkin_time = data_json["checkin_time"]

        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found")

        room_data = room_doc.to_dict()

        if room_data["status"] != "occupied":
            return jsonify(success=False, message="Room not occupied.")

        new_checkin_dt = datetime.strptime(new_checkin_time, "%Y-%m-%d %H:%M")
        old_checkin_time = room_data.get("checkin_time", "")
        guest_name = room_data.get("guest", {}).get("name", "")

        # Check if the DATE portion changed (not just the time)
        old_date = old_checkin_time.split(" ")[0] if old_checkin_time else ""
        new_date = new_checkin_time.split(" ")[0]
        date_changed = old_date != new_date

        new_serial = None
        if date_changed and guest_name:
            # Assign a new serial number for the new date
            new_serial = get_next_serial_number(new_date)
            logger.info(
                f"Checkin date changed for room {room}: {old_date} -> {new_date}. "
                f"New serial: #{new_serial}"
            )

            # Update transaction metadata
            store_transaction_metadata(room, new_date, new_serial, "date_correction")

            # --- Update payments collection: move checkin payment to new date ---
            try:
                from firebase_admin import firestore as _fs
                from google.cloud.firestore_v1.base_query import FieldFilter as _FF
                payments_ref = db.collection("payments")
                # Find the checkin payment(s) for this room on the old date
                pq = (
                    payments_ref
                    .where(filter=_FF("room", "==", str(room)))
                    .where(filter=_FF("date", "==", old_date))
                )
                new_time_str = new_checkin_dt.strftime("%H:%M")
                old_payment_serial = None
                for pdoc in pq.stream():
                    pdata = pdoc.to_dict()
                    # Only update the first checkin/booking_conversion payment
                    if (pdata.get("name") == guest_name and
                            pdata.get("transaction_type") in
                            ("fresh_checkin", "booking_conversion")):
                        old_payment_serial = pdata.get("serial_number")
                        pdoc.reference.update({
                            "date": new_date,
                            "time": new_time_str,
                            "serial_number": new_serial,
                            "original_date": old_date,
                        })
                        logger.info(f"Updated payments doc {pdoc.id}: date {old_date} -> {new_date}, time -> {new_time_str}, serial #{new_serial}")

                # Fix 3: release the old date's counter slot only if it was the
                # last serial issued that day.  This lets the next check-in on
                # old_date reuse the number instead of skipping it.
                # If it was NOT the last (other guests checked in after), we leave
                # the counter alone to avoid creating a duplicate serial.
                if old_payment_serial is not None:
                    old_counter_ref = counters_ref.document(old_date)

                    @firestore.transactional
                    def _release_if_last(txn, cref, released_serial):
                        snap = cref.get(transaction=txn)
                        if snap.exists and snap.get('count') == released_serial:
                            txn.update(cref, {'count': _fs.Increment(-1)})
                            return True
                        return False

                    was_released = _release_if_last(
                        db.transaction(), old_counter_ref, old_payment_serial
                    )
                    if was_released:
                        logger.info(
                            f"Released serial #{old_payment_serial} from {old_date} "
                            f"counter — next check-in on {old_date} will reuse it"
                        )
                    else:
                        logger.info(
                            f"Serial #{old_payment_serial} was not the last on {old_date}; "
                            f"counter unchanged (gap accepted to avoid collision)"
                        )

            except Exception as e:
                logger.warning(f"Failed to update payments collection for date change: {e}")

        # Update the room document
        rooms_ref.document(room).update({
            "checkin_time": new_checkin_time,
            "renewal_count": 0,
            "last_renewal_time": None
        })

        invalidate_cache()

        msg = "Check-in time updated successfully."
        if new_serial:
            msg += f" Serial reassigned to #{new_serial} for {new_date}."

        logger.info(f"Check-in time updated for room {room}: {new_checkin_time}")
        return jsonify(success=True, message=msg, serial_number=new_serial)
    except Exception as e:
        logger.error(f"Error updating check-in time: {str(e)}")
        return jsonify(success=False, message=f"Error updating check-in time: {str(e)}")

@rooms_bp.route("/add_room", methods=["POST"])
def add_room():
    try:
        data_json = request.json
        room_number = data_json.get("roomNumber")

        if not room_number:
            return jsonify(success=False, message="Room number is required")

        room_doc = rooms_ref.document(room_number).get()
        if room_doc.exists:
            return jsonify(success=False, message=f"Room {room_number} already exists")

        rooms_ref.document(room_number).set({
            "status": "vacant",
            "guest": None,
            "checkin_time": None,
            "balance": 0,
            "add_ons": [],
            "renewal_count": 0,
            "last_renewal_time": None,
            "cleaning_status": None,
            "cleaning_start_time": None
        })

        invalidate_rooms_and_totals()

        logger.info(f"New room {room_number} added")
        return jsonify(success=True, message=f"Room {room_number} added successfully")

    except Exception as e:
        logger.error(f"Error adding new room: {str(e)}")
        return jsonify(success=False, message=f"Error adding new room: {str(e)}")

@rooms_bp.route("/apply_discount", methods=["POST"])
def apply_discount():
    try:
        data_json = request.json
        room = data_json["room"]
        amount = int(data_json.get("amount", 0))
        reason = data_json.get("reason", "Discount")

        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found.")

        room_data = room_doc.to_dict()

        if room_data["status"] != "occupied":
            return jsonify(success=False, message="Room is not occupied.")

        if amount <= 0:
            return jsonify(success=False, message="Please provide a valid discount amount.")

        batch = db.batch()

        discount_entry = {
            "amount": amount,
            "reason": reason,
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "time": datetime.now(IST).strftime("%H:%M")
        }

        batch.update(rooms_ref.document(room), {
            "discounts": firestore.ArrayUnion([discount_entry])
        })

        current_balance = room_data["balance"]
        new_balance = current_balance

        # Build atomic update for totals
        totals_update = {}

        if current_balance > 0:
            new_balance = max(0, current_balance - amount)
            # Only decrement totals if discount is applied
            decrement_amount = min(amount, current_balance)
            if decrement_amount > 0:
                totals_update["balance"] = firestore.Increment(-decrement_amount)
        else:
            new_balance = current_balance - amount

        batch.update(rooms_ref.document(room), {"balance": new_balance})
        if totals_update:
            batch.update(totals_ref.document('current_totals'), totals_update)

        batch.commit()
        invalidate_rooms_and_totals()

        # --- payments collection ---
        payment_service.write_payment({
            "room": room, "name": room_data["guest"]["name"],
            "amount": amount, "method": "discount", "type": "discount",
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "time": datetime.now(IST).strftime("%H:%M"),
            "reason": reason, "transaction_type": "discount",
            "stay_room_key": f"{room}_{room_data.get('checkin_time', '')}",
        })

        logger.info(f"Discount of ₹{amount} applied to room {room}, reason: {reason}")

        return jsonify(success=True, message=f"Discount of ₹{amount} applied successfully.")
    except Exception as e:
        logger.error(f"Error applying discount: {str(e)}")
        return jsonify(success=False, message=f"Error applying discount: {str(e)}")

@rooms_bp.route("/transfer_room", methods=["POST"])
def transfer_room():
    try:
        data_json = request.json
        old_room = str(data_json["old_room"])
        new_room = str(data_json["new_room"])
        new_price = data_json.get("new_price")
        is_ac = data_json.get("is_ac", False)

        rooms_dict = get_all_rooms()

        if old_room not in rooms_dict or new_room not in rooms_dict:
            return jsonify(success=False, message="One or both rooms do not exist.")

        if rooms_dict[old_room]["status"] != "occupied":
            return jsonify(success=False, message="Source room is not occupied.")

        if rooms_dict[new_room]["status"] != "vacant":
            return jsonify(success=False, message="Destination room is not vacant.")

        guest_name = rooms_dict[old_room]["guest"]["name"]
        guest_mobile = rooms_dict[old_room]["guest"]["mobile"]
        checkin_time = rooms_dict[old_room]["checkin_time"]

        new_room_data = rooms_dict[old_room].copy()

        if new_price:
            new_room_data["guest"]["price"] = int(new_price)

        if new_room >= "202" and new_room <= "205":
            new_room_data["guest"]["isAC"] = is_ac

        batch = db.batch()

        batch.set(rooms_ref.document(new_room), new_room_data)

        current_checkin_time = datetime.strptime(checkin_time, "%Y-%m-%d %H:%M")

        batch.update(rooms_ref.document(old_room), {
            "status": "vacant",
            "guest": None,
            "checkin_time": None,
            "balance": 0,
            "add_ons": [],
            "discounts": [],
            "renewal_count": 0,
            "last_renewal_time": None,
            "cleaning_status": None,
            "cleaning_start_time": None
        })

        batch.commit()
        invalidate_cache()

        # --- Update payments collection ---
        payment_service.update_payments_room(
            old_room, new_room, guest_name, current_checkin_time
        )
        # Write the shift log entry to payments
        payment_service.write_payment({
            "room": new_room, "name": guest_name, "amount": 0,
            "method": "none", "type": "room_shift",
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "time": datetime.now(IST).strftime("%H:%M"),
            "old_room": old_room, "transaction_type": "room_shift",
            "stay_room_key": f"{new_room}_{checkin_time}",
            "mobile": guest_mobile,
        })

        logger.info(f"Guest {guest_name} transferred from Room {old_room} to Room {new_room}")

        return jsonify(
            success=True,
            message=f"Guest transferred successfully from Room {old_room} to Room {new_room}."
        )

    except Exception as e:
        logger.error(f"Error transferring room: {str(e)}", exc_info=True)
        return jsonify(success=False, message=f"Error transferring room: {str(e)}")

@rooms_bp.route("/mark_room_cleaned", methods=["POST"])
def mark_room_cleaned():
    try:
        data_json = request.json
        room = data_json["room"]

        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found")

        room_data = room_doc.to_dict()

        # Verify room is in cleaning status before marking as cleaned
        if room_data.get("status") != "cleaning":
            return jsonify(success=False, message="This room is not in cleaning status")

        # Mark room as vacant and clear cleaning status
        rooms_ref.document(room).update({
            "status": "vacant",
            "cleaning_status": None,
            "cleaning_start_time": None,
            "guest": None,
            "checkin_time": None,
            "balance": 0,
            "add_ons": [],
            "discounts": [],
            "renewal_count": 0,
            "last_renewal_time": None
        })

        invalidate_rooms_and_totals()

        logger.info(f"Room {room} marked as cleaned")
        return jsonify(success=True, message=f"Room {room} marked as vacant")

    except Exception as e:
        logger.error(f"Error marking room as cleaned: {str(e)}")
        return jsonify(success=False, message=f"Error marking room as cleaned: {str(e)}")

@rooms_bp.route("/get_rooms_only")
def get_rooms_only():
    """Get only rooms data - faster endpoint"""
    try:
        rooms = get_all_rooms()
        return jsonify(success=True, rooms=rooms)
    except Exception as e:
        logger.error(f"Error getting rooms: {str(e)}")
        return jsonify(success=False, message=str(e))

@rooms_bp.route("/get_totals_only")
def get_totals_only():
    """Get only totals - fastest endpoint"""
    try:
        totals = get_totals()
        return jsonify(success=True, totals=totals)
    except Exception as e:
        logger.error(f"Error getting totals: {str(e)}")
        return jsonify(success=False, message=str(e))

@rooms_bp.route("/get_data")
def get_data():
    """
    Main page-load endpoint.

    OPTIMISED: the frontend only reads `logs.renewals` for display.
    All other log types are initialised to [] and never iterated.
    So we query ONLY recent renewals from the `payments` collection
    instead of downloading every transaction ever recorded.

    Falls back to the old full-download path if the payments query
    returns nothing (pre-migration scenario).
    """
    try:
        import time as _t
        from concurrent.futures import ThreadPoolExecutor
        t0 = _t.time()

        today = datetime.now(IST)
        three_days_ago = (today - timedelta(days=3)).strftime("%Y-%m-%d")
        tomorrow = (today + timedelta(days=1)).strftime("%Y-%m-%d")

        # Run all 3 Firestore queries in parallel (saves ~2s)
        with ThreadPoolExecutor(max_workers=3) as pool:
            f_rooms = pool.submit(get_all_rooms)
            f_totals = pool.submit(get_totals)
            f_payments = pool.submit(
                payment_service.query_payments_by_date_range,
                three_days_ago, tomorrow
            )

        rooms = f_rooms.result()
        totals = f_totals.result()
        recent_payments = f_payments.result() or []
        t1 = _t.time()
        logger.info(f"[PERF] parallel fetch (rooms+totals+payments): {t1-t0:.3f}s, {len(recent_payments)} payment docs")

        _refund_types = ("refund", "checkout_refund", "manual_refund",
                         "booking_cancel_refund")

        # Build logs in the shape the frontend expects — all from one query
        # "pay_later" method is used for settle-later check-ins; include alongside cash
        cash_logs = [p for p in recent_payments
                     if p.get("method") in ("cash", "pay_later")
                     and p.get("type") not in _refund_types
                     and p.get("type") not in ("expense", "discount")]
        online_logs = [p for p in recent_payments
                       if p.get("method") == "online"
                       and p.get("type") not in _refund_types
                       and p.get("type") not in ("expense", "discount")]
        refund_logs = [p for p in recent_payments
                       if p.get("type") in _refund_types]
        expense_logs = [p for p in recent_payments
                        if p.get("type") == "expense"]

        renewals_for_frontend = []
        for p in recent_payments:
            if p.get("type") == "renewal":
                renewals_for_frontend.append({
                    "room": p.get("room", ""),
                    "name": p.get("name", ""),
                    "amount": p.get("amount", 0),
                    "date": p.get("date", ""),
                    "time": p.get("time", ""),
                    "day": p.get("note", "").split("Day ")[-1].split(" ")[0] if "Day " in p.get("note", "") else "",
                    "note": p.get("note", ""),
                    "transaction_type": "rent_renewal",
                })

        logs = {
            "cash": cash_logs,
            "online": online_logs,
            "balance": [],
            "add_ons": [],
            "refunds": refund_logs,
            "renewals": renewals_for_frontend,
            "booking_payments": [],
            "discounts": [],
            "expenses": expense_logs,
            "room_shifts": [],
        }

        t4 = _t.time()
        logger.info(f"[PERF] /get_data TOTAL: {t4-t0:.3f}s")
        return jsonify(rooms=rooms, logs=logs, totals=totals)
    except Exception as e:
        logger.error(f"Error getting data: {str(e)}")
        return jsonify(success=False, message=f"Error getting data: {str(e)}")

@rooms_bp.route("/get_history", methods=["POST"])
def get_history():
    """
    OPTIMISED: queries payments collection for a specific room+guest
    instead of downloading every transaction.
    Falls back to old logs if payments collection returns nothing.
    """
    try:
        data_json = request.json
        room = data_json.get("room")
        guest_name = data_json.get("name")

        if not room or not guest_name:
            return jsonify(success=False, message="Room and guest name are required.")

        # Try to get checkin_dt for this room to scope the query
        room_doc = rooms_ref.document(room).get()
        checkin_dt = None
        if room_doc.exists:
            ct = room_doc.to_dict().get("checkin_time")
            if ct:
                try:
                    checkin_dt = datetime.strptime(ct, "%Y-%m-%d %H:%M")
                except ValueError:
                    pass

        # Fast path: payments collection
        if checkin_dt:
            payments = payment_service.query_payments_for_stay(
                room, guest_name, checkin_dt
            )
        else:
            # No checkin time — query last 30 days for this room+guest
            thirty_ago = (datetime.now(IST) - timedelta(days=30)).strftime("%Y-%m-%d")
            payments = payment_service.query_payments_by_date_range(thirty_ago, "9999-99-99")
            payments = [p for p in payments
                        if p.get("room") == str(room) and p.get("name") == guest_name]

        payments = payments or []
        room_cash_logs = [p for p in payments if p.get("method") == "cash"
                          and p.get("type") not in ("refund", "checkout_refund", "manual_refund")]
        room_online_logs = [p for p in payments if p.get("method") == "online"
                            and p.get("type") not in ("refund", "checkout_refund", "manual_refund")]
        room_refund_logs = [p for p in payments
                            if p.get("type") in ("refund", "checkout_refund", "manual_refund",
                                                   "booking_cancel_refund")]
        room_addons_logs = [p for p in payments if p.get("type") == "addon"]
        room_renewal_logs = [p for p in payments if p.get("type") == "renewal"]
        room_shift_logs = [p for p in payments if p.get("type") == "room_shift"]

        return jsonify(
            success=True,
            cash=room_cash_logs,
            online=room_online_logs,
            refunds=room_refund_logs,
            addons=room_addons_logs,
            renewals=room_renewal_logs,
            shifts=room_shift_logs
        )
    except Exception as e:
        logger.error(f"Error getting history: {str(e)}")
        return jsonify(success=False, message=f"Error retrieving history: {str(e)}")


@rooms_bp.route("/get_room_numbers", methods=["GET"])
def get_room_numbers():
    try:
        rooms_stream = rooms_ref.stream()
        room_numbers = [doc.id for doc in rooms_stream]

        def room_sort_key(room_num):
            if room_num.startswith('2'):
                return 2, int(room_num)
            else:
                return 1, int(room_num)

        room_numbers.sort(key=room_sort_key)

        first_floor = [r for r in room_numbers if not r.startswith('2')]
        second_floor = [r for r in room_numbers if r.startswith('2')]

        return jsonify(
            success=True,
            rooms=room_numbers,
            first_floor=first_floor,
            second_floor=second_floor
        )
    except Exception as e:
        logger.error(f"Error retrieving room numbers: {str(e)}")
        return jsonify(success=False, message=f"Error retrieving room numbers: {str(e)}")


@rooms_bp.route("/get_transaction_metadata", methods=["GET"])
def get_transaction_metadata():
    try:
        from config import counters_ref, metadata_ref
        counters_stream = counters_ref.stream()
        daily_counters = {doc.id: doc.to_dict().get('count', 0) for doc in counters_stream}

        metadata_stream = metadata_ref.stream()
        transaction_metadata = {doc.id: doc.to_dict() for doc in metadata_stream}

        return jsonify(
            success=True,
            daily_counters=daily_counters,
            transaction_metadata=transaction_metadata
        )
    except Exception as e:
        logger.error(f"Error getting transaction metadata: {str(e)}")
        return jsonify(success=False, message=f"Error getting transaction metadata: {str(e)}")


@rooms_bp.route("/cleanup_old_data", methods=["POST"])
def cleanup_old_data_route():
    try:
        from config import cleanup_old_counters
        cleanup_old_counters()
        return jsonify(success=True, message="Old data cleaned up successfully")
    except Exception as e:
        return jsonify(success=False, message=f"Error cleaning up data: {str(e)}")


# ── Manager password helper ───────────────────────────────────────────────────
import os as _os

def _check_manager_password(provided: str) -> bool:
    """
    Verify the manager password against the MANAGER_PASSWORD env var.
    Falls back to a default only in development (env var not set).
    Never expose the result in logs.
    """
    expected = _os.environ.get("MANAGER_PASSWORD", "manager@1234")
    return provided == expected


# ── Transaction logs for an arbitrary date range (manager-only) ───────────────
@rooms_bp.route("/get_transactions_range", methods=["POST"])
def get_transactions_range():
    """
    Return transaction logs for any date range.
    Body: { from_date: "YYYY-MM-DD", to_date: "YYYY-MM-DD" }
    Returns logs in the same shape as get_data's logs object.
    """
    try:
        data = request.json or {}
        from_date = data.get("from_date")
        to_date   = data.get("to_date")
        if not from_date or not to_date:
            return jsonify(success=False, message="from_date and to_date required"), 400

        # end_date is exclusive in the query, so add 1 day
        from datetime import datetime as _dt, timedelta as _td
        end_exclusive = (_dt.strptime(to_date, "%Y-%m-%d") + _td(days=1)).strftime("%Y-%m-%d")

        payments = payment_service.query_payments_by_date_range(from_date, end_exclusive) or []

        _refund_types = ("refund", "checkout_refund", "manual_refund", "booking_cancel_refund")

        logs = {
            "cash":     [p for p in payments if p.get("method") in ("cash", "pay_later")
                         and p.get("type") not in _refund_types
                         and p.get("type") not in ("expense", "discount")],
            "online":   [p for p in payments if p.get("method") == "online"
                         and p.get("type") not in _refund_types
                         and p.get("type") not in ("expense", "discount")],
            "refunds":  [p for p in payments if p.get("type") in _refund_types],
            # Only transaction-type expenses (expense_type="transaction"), not report/accounting ones
            "expenses": [p for p in payments
                         if p.get("type") == "expense"
                         and p.get("expense_type") == "transaction"],
        }
        return jsonify(success=True, logs=logs)
    except Exception as e:
        logger.error(f"get_transactions_range error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


# ── Simple password verification endpoint ─────────────────────────────────────
@rooms_bp.route("/verify_manager_password", methods=["POST"])
def verify_manager_password():
    """Lightweight endpoint to verify the manager password client-side flows."""
    try:
        data = request.json or {}
        password = data.get("password", "")
        if _check_manager_password(password):
            return jsonify(success=True)
        return jsonify(success=False, message="Incorrect password"), 403
    except Exception as e:
        return jsonify(success=False, message=str(e)), 500


# ══════════════════════════════════════════════════════════════════════════════
# STAY PAYMENTS — view & edit payment records for a specific stay
# ══════════════════════════════════════════════════════════════════════════════

@rooms_bp.route("/get_stay_payments", methods=["POST"])
def get_stay_payments():
    """
    Return all payment documents for a specific stay.

    Body: {
        password: str,
        room: str,
        guest_name: str,
        checkin_time: str  -- "YYYY-MM-DD HH:MM"
    }

    Queries the `payments` collection by room + name + date >= checkin_date.
    Returns each doc with its Firestore document ID so the frontend can
    address individual records for editing.

    Excludes expense and discount records (those are not guest payments).
    """
    try:
        data = request.json or {}
        password     = data.get("password", "")
        room         = str(data.get("room", "")).strip()
        guest_name   = data.get("guest_name", "").strip()
        checkin_time = data.get("checkin_time", "").strip()

        # ── Auth ──────────────────────────────────────────────────────────────
        if not _check_manager_password(password):
            return jsonify(success=False, message="Incorrect password"), 403

        # ── Validate inputs ───────────────────────────────────────────────────
        if not room or not guest_name or not checkin_time:
            return jsonify(success=False, message="room, guest_name, checkin_time are required"), 400

        try:
            checkin_dt = datetime.strptime(checkin_time, "%Y-%m-%d %H:%M")
        except ValueError:
            return jsonify(success=False, message="checkin_time must be YYYY-MM-DD HH:MM"), 400

        checkin_date_str = checkin_dt.strftime("%Y-%m-%d")

        # ── Query payments collection ─────────────────────────────────────────
        _payments_ref = db.collection("payments")
        _exclude_types = ("expense", "discount")

        query = (
            _payments_ref
            .where(filter=FieldFilter("room",  "==", room))
            .where(filter=FieldFilter("name",  "==", guest_name))
            .where(filter=FieldFilter("date",  ">=", checkin_date_str))
        )

        payments = []
        for doc in query.stream():
            d = doc.to_dict()
            if d.get("type") in _exclude_types:
                continue
            payments.append({
                "id":     doc.id,
                "amount": d.get("amount", 0),
                "method": d.get("method", ""),
                "type":   d.get("type", ""),
                "date":   d.get("date", ""),
                "time":   d.get("time", ""),
                "note":   d.get("note", ""),
            })

        # Sort in Python — avoids requiring a composite Firestore index
        payments.sort(key=lambda p: (p.get("date", ""), p.get("time", "")))

        logger.info(f"get_stay_payments: room={room} guest={guest_name} "
                    f"checkin={checkin_date_str} → {len(payments)} records")
        return jsonify(success=True, payments=payments)

    except Exception as e:
        logger.error(f"get_stay_payments error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {str(e)}"), 500


@rooms_bp.route("/update_stay_payment", methods=["POST"])
def update_stay_payment():
    """
    Edit the method, date, and/or amount of a single payment record.

    Body: {
        password: str,
        payment_id: str,        -- Firestore document ID in payments collection
        method: "cash"|"online",
        date: "YYYY-MM-DD",
        time: "HH:MM",          -- optional, preserves original if omitted
        amount: int             -- optional; only allowed for non-refund types
    }

    Side effects:
      - Updates the payment doc in the `payments` collection.
      - If method or amount changed: adjusts `current_totals` atomically
        (net delta applied so cash/online totals stay correct).
      - If amount changed and room is still occupied: adjusts room balance
        so the outstanding balance reflects the corrected payment.

    Does NOT touch the legacy `logs` collection.
    All operations are wrapped in a Firestore batch so they are atomic.
    """
    try:
        data = request.json or {}
        password   = data.get("password", "")
        payment_id = data.get("payment_id", "").strip()
        new_method = data.get("method", "").strip().lower()
        new_date   = data.get("date", "").strip()
        new_time   = data.get("time", "").strip()
        new_amount_raw = data.get("amount")   # None means "not provided"

        # ── Auth ──────────────────────────────────────────────────────────────
        if not _check_manager_password(password):
            return jsonify(success=False, message="Incorrect password"), 403

        # ── Validate ──────────────────────────────────────────────────────────
        if not payment_id:
            return jsonify(success=False, message="payment_id is required"), 400

        if new_method and new_method not in ("cash", "online"):
            return jsonify(success=False, message="method must be cash or online"), 400

        if new_date:
            try:
                datetime.strptime(new_date, "%Y-%m-%d")
            except ValueError:
                return jsonify(success=False, message="date must be YYYY-MM-DD"), 400

        if new_time:
            try:
                datetime.strptime(new_time, "%H:%M")
            except ValueError:
                return jsonify(success=False, message="time must be HH:MM"), 400

        new_amount = None
        if new_amount_raw is not None:
            try:
                new_amount = int(new_amount_raw)
                if new_amount <= 0:
                    return jsonify(success=False, message="amount must be greater than 0"), 400
            except (ValueError, TypeError):
                return jsonify(success=False, message="amount must be a valid integer"), 400

        # ── Fetch the existing payment doc ────────────────────────────────────
        _payments_ref = db.collection("payments")
        pay_doc_ref   = _payments_ref.document(payment_id)
        pay_snap      = pay_doc_ref.get()

        if not pay_snap.exists:
            return jsonify(success=False, message="Payment record not found"), 404

        old_data   = pay_snap.to_dict()
        old_method = old_data.get("method", "")
        old_amount = int(old_data.get("amount", 0))
        pay_type   = old_data.get("type", "")

        # Amount editing is not allowed for refund records
        _refund_types = ("refund", "checkout_refund", "manual_refund", "booking_cancel_refund")
        if new_amount is not None and pay_type in _refund_types:
            return jsonify(success=False,
                           message="Amount cannot be edited for refund records"), 400

        # ── Determine final values ────────────────────────────────────────────
        final_method = new_method if new_method else old_method
        final_amount = new_amount if new_amount is not None else old_amount

        # ── Build update payload ──────────────────────────────────────────────
        update_fields = {}
        if new_method and new_method != old_method:
            update_fields["method"] = new_method
        if new_date:
            update_fields["date"] = new_date
        if new_time:
            update_fields["time"] = new_time
        if new_amount is not None and new_amount != old_amount:
            update_fields["amount"] = new_amount

        if not update_fields:
            return jsonify(success=True, message="No changes detected")

        # ── Apply changes atomically ──────────────────────────────────────────
        batch = db.batch()

        # 1. Update payments doc
        batch.update(pay_doc_ref, update_fields)

        # 2. Adjust current_totals (cash/online) for any method or amount change
        #    Net delta approach: subtract the old contribution, add the new one.
        valid_total_methods = ("cash", "online")
        totals_doc_ref = totals_ref.document("current_totals")

        if final_method != old_method or final_amount != old_amount:
            delta_map = {}
            # Remove old entry's contribution
            if old_method in valid_total_methods:
                delta_map[old_method] = delta_map.get(old_method, 0) - old_amount
            # Add new entry's contribution
            if final_method in valid_total_methods:
                delta_map[final_method] = delta_map.get(final_method, 0) + final_amount
            totals_delta = {
                field: firestore.Increment(delta)
                for field, delta in delta_map.items()
                if delta != 0
            }
            if totals_delta:
                batch.update(totals_doc_ref, totals_delta)

        # 3. If amount changed, adjust room balance (only if room still occupied)
        if new_amount is not None and new_amount != old_amount:
            room_id = str(old_data.get("room", ""))
            if room_id:
                room_snap = rooms_ref.document(room_id).get()
                if room_snap.exists and room_snap.to_dict().get("status") == "occupied":
                    current_balance = int(room_snap.to_dict().get("balance", 0))
                    # Guest paid less than recorded → balance goes up (owes more)
                    # Guest paid more than recorded → balance goes down (owes less)
                    balance_adjustment = old_amount - new_amount
                    new_room_balance = current_balance + balance_adjustment
                    batch.update(rooms_ref.document(room_id), {"balance": new_room_balance})
                    logger.info(
                        f"update_stay_payment: room {room_id} balance adjusted "
                        f"{current_balance} → {new_room_balance} "
                        f"(amount {old_amount} → {new_amount})"
                    )

        batch.commit()
        invalidate_rooms_and_totals()

        logger.info(f"update_stay_payment: id={payment_id} "
                    f"changes={update_fields} old_method={old_method} old_amount={old_amount}")
        return jsonify(success=True, message="Payment updated successfully")

    except Exception as e:
        logger.error(f"update_stay_payment error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {str(e)}"), 500
