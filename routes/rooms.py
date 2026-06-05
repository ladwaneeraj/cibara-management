"""
Room management routes: checkin, checkout, add_on, renew_rent, update_checkin_time,
add_room, transfer_room, mark_room_cleaned, apply_discount, get_rooms_only, get_data,
get_history, get_totals_only
"""

from flask import Blueprint, request, jsonify
from datetime import datetime, timedelta
import logging
import re
import uuid
import time as _time

from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from config import (
    db, rooms_ref, totals_ref, bookings_ref, metadata_ref,
    counters_ref, bills_ref, IST, logger, invalidate_cache,
    invalidate_rooms_and_totals, get_all_rooms,
    get_totals, is_log_from_current_stay, get_next_serial_number,
    store_transaction_metadata, create_bill_record,
    find_serial_number_for_checkin, _build_active_entry_fast, _find_serial_fast,
    _batch_fill_serials, room_category
)
from services import payment_service, customer_service, expense_service, bills_service
from services.auth_service import requires_permission, login_required
from services.audit_log import write_log, attribution_create, attribution_update, _safe_user
from routes.billing import auto_generate_bill_pdf

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

        # `current_date` always reflects the actual moment of recording — the
        # serial-number sequence, payment-record dates, and reporting buckets
        # all key off this. Don't shift it based on the client's override.
        _now_ist     = datetime.now(IST)
        current_date = _now_ist.strftime("%Y-%m-%d")

        # `current_time` is the guest's check-in time. By default this is
        # "now"; staff can override it via `checkin_time` to record a stay
        # that started a few hours ago. The override is constrained to:
        #   - same calendar day as today (no backdating across days)
        #   - not in the future
        # If the override fails validation we silently fall back to now()
        # rather than rejecting the check-in — the staff member already
        # filled out the form, and a check-in time off by a few minutes
        # is far less bad than blocking the check-in entirely. We log the
        # rejection for traceability.
        _override_raw = (data_json.get("checkin_time") or "").strip()
        current_time  = _now_ist.strftime("%Y-%m-%d %H:%M")
        if _override_raw:
            try:
                _ovr_naive = datetime.strptime(_override_raw, "%Y-%m-%d %H:%M")
                _ovr = IST.localize(_ovr_naive)
                _ok_same_day = _ovr.strftime("%Y-%m-%d") == current_date
                # Allow up to 60s of clock skew on the future check.
                _ok_not_future = _ovr <= _now_ist + timedelta(seconds=60)
                if _ok_same_day and _ok_not_future:
                    current_time = _ovr.strftime("%Y-%m-%d %H:%M")
                else:
                    logger.warning(
                        f"Check-in time override rejected for room {room}: "
                        f"value={_override_raw!r} same_day={_ok_same_day} "
                        f"not_future={_ok_not_future} — using now() instead"
                    )
            except ValueError:
                logger.warning(
                    f"Check-in time override unparseable for room {room}: "
                    f"value={_override_raw!r} — using now() instead"
                )

        serial_number = get_next_serial_number(current_date)

        # ── Stay document — Phase 2/4 of stay_id migration ───────────────────
        # Mint a UUID4 stay_id BEFORE the transaction so we can stamp it on
        # both the room update and the new draft bill doc atomically. The
        # stay_id is the canonical foreign key used by every payment for
        # this stay; see docs/STAY_DOC_CONTRACT.md.
        stay_id = uuid.uuid4().hex

        # ── Fix 2: Atomically claim the room — prevents double check-in ──────
        room_ref = rooms_ref.document(room)

        @firestore.transactional
        def _claim_room(txn, r_ref):
            snap = r_ref.get(transaction=txn)
            if not snap.exists:
                raise ValueError(f"Room {room} does not exist")
            if snap.to_dict().get("status") != "vacant":
                raise ValueError(f"Room {room} is already occupied")
            # ── Attribution ─────────────────────────────────────────────────
            # The room doc is shared across stays, so we use _create
            # attribution at checkin (same semantics as "this stay began
            # under this user"). lastCheckinBy is the business-friendly
            # field the UI displays on the register row.
            _attr = attribution_create()
            _checkin_user = (_safe_user() or {}).get("userId") or "system"
            txn.update(r_ref, {
                "status": "occupied",
                "guest": guest,
                "checkin_time": current_time,
                "balance": balance,
                "add_ons": [],
                "renewal_count": 0,
                "last_renewal_time": None,
                "last_renewal_date": None,
                "checkin_time_edit_count": 0,
                # Walk-in / direct check-in → this is a NORMAL hotel stay.
                # The room doc is reused across stays, so if the previous
                # occupant was an MMT/OTA booking these fields would still
                # read "mmt"/"ota" and the new bill would inherit the wrong
                # source tag at checkout (billing.py copies booking_source
                # from the room). Reset them explicitly here so a direct
                # check-in is never mislabelled as MMT.
                "booking_source": "normal",
                "payment_source": "hotel",
                # Pointer to the draft stay doc so /checkout can finalize
                # the existing record instead of creating a new bill.
                "active_bill_id": stay_id,
                # Per-stay attribution. These accumulate through the stay
                # so the room-history popover can show the full chain:
                #   cleanedBy → inspectedBy → bookedBy → lastCheckinBy
                #   → lastCheckinTimeEditBy → lastCheckoutBy
                # cleanedBy / inspectedBy were set during the previous
                # cleaning cycle (which prepped this room for THIS stay)
                # — keep them. They'll be overwritten naturally when
                # housekeeping cleans for the NEXT stay.
                "lastCheckinBy": _checkin_user,
                "lastCheckinAt": _attr.get("createdAt"),
                # Walk-in (no booking) → bookedBy is cleared.
                "bookedBy": None,
                "bookedAt": None,
                # Time-edit field is per-stay; clear so we don't carry over
                # the previous stay's edit attribution.
                "lastCheckinTimeEditBy": None,
                "lastCheckinTimeEditAt": None,
                # Clear the PREVIOUS stay's checkout so during this active
                # stay the popover doesn't list a stale "Checked out by".
                # This field repopulates when the current stay checks out.
                "lastCheckoutBy": None,
                "lastCheckoutAt": None,
                # Universal attribution
                "createdBy": _attr.get("createdBy"),
                "createdAt": _attr.get("createdAt"),
                "lastModifiedBy": _attr.get("lastModifiedBy"),
                "lastModifiedAt": _attr.get("lastModifiedAt"),
            })
            # Create the draft stay/bill doc inside the same transaction.
            # If this fails, the whole claim rolls back — guarantees we
            # never have an occupied room without its stay doc, or vice versa.
            bills_service.create_draft(
                room=room,
                guest=guest,
                checkin_time=current_time,
                stay_id=stay_id,
                source="checkin",
                txn=txn,
            )

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
        # Phase 2-4 of stay_id migration: every payment for this stay carries
        # the canonical stay_id. The legacy stay_room_key field is kept for
        # backward compatibility with any code still reading it.
        stay_key = f"{room}_{current_time}"
        if payment != "balance" and amount_paid > 0:
            payment_service.write_payment_with_stay(stay_id, {
                "room": room, "name": guest["name"], "amount": amount_paid,
                "method": payment, "type": "checkin", "date": current_date,
                "time": datetime.now(IST).strftime("%H:%M"),
                "serial_number": serial_number, "stay_room_key": stay_key,
                "transaction_type": "fresh_checkin", "is_fresh_checkin": True,
                "mobile": data_json.get("mobile", ""),
            })
        elif payment == "balance":
            payment_service.write_payment_with_stay(stay_id, {
                "room": room, "name": guest["name"], "amount": 0,
                "method": "pay_later", "type": "checkin", "date": current_date,
                "time": datetime.now(IST).strftime("%H:%M"),
                "serial_number": serial_number, "stay_room_key": stay_key,
                "transaction_type": "fresh_checkin", "is_fresh_checkin": True,
                "mobile": data_json.get("mobile", ""),
            })
        if balance > 0:
            payment_service.write_payment_with_stay(stay_id, {
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
        write_log(
            "room.checkin",
            target_collection="rooms",
            target_id=str(room),
            after={"guest": guest["name"], "price": price, "amount_paid": amount_paid,
                   "payment_method": payment, "serial_number": serial_number},
        )
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

        # Use room_data sent by the frontend (saves a Firestore read).
        # Fall back to fetching from Firestore only when it's missing.
        _client_room_data = data_json.get("room_data")
        if _client_room_data and isinstance(_client_room_data, dict) and _client_room_data.get("guest"):
            room_data = _client_room_data
        else:
            room_doc = rooms_ref.document(room).get()
            if not room_doc.exists:
                return jsonify(success=False, message="Room not found")
            room_data = room_doc.to_dict()

        # Stay-id linkage (Phase 2/4 of stay_doc migration).
        # `active_bill_id` is set on the room at /checkin and points at the
        # draft bill document for the current stay. Every payment for this
        # stay carries it as `stay_id`. At final checkout we finalize that
        # draft instead of creating a second bill record.
        #
        # Legacy stays that checked in before Phase 2 went live have no
        # `active_bill_id` — we fall back to the legacy bill-create path
        # for them. As a safety net (in case the client-supplied room_data
        # is stale and doesn't include the field), re-read the room doc
        # if it's missing rather than assuming legacy.
        active_bill_id = room_data.get("active_bill_id")
        if active_bill_id is None and _client_room_data:
            try:
                _live_snap = rooms_ref.document(room).get()
                if _live_snap.exists:
                    active_bill_id = _live_snap.to_dict().get("active_bill_id")
            except Exception as _e:
                logger.warning(f"checkout: active_bill_id refresh failed: {_e}")

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
            _mid_stay_payload = {
                "room": room, "name": room_data["guest"]["name"],
                "amount": amount, "method": payment_mode,
                "type": "renewal" if is_renewal_payment else "payment",
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "time": datetime.now(IST).strftime("%H:%M"),
                "transaction_type": "renewal_payment" if is_renewal_payment else "regular_payment",
                "stay_room_key": f"{room}_{room_data.get('checkin_time', '')}",
            }
            if active_bill_id:
                payment_service.write_payment_with_stay(active_bill_id, _mid_stay_payload)
            else:
                # Legacy stay without a draft bill — fall back to the
                # original writer so old stays still complete cleanly.
                payment_service.write_payment(_mid_stay_payload)

            logger.info(f"Payment of ₹{amount} recorded for room {room}")
            write_log(
                "payment.add" if not is_renewal_payment else "room.renew_payment",
                target_collection="rooms",
                target_id=str(room),
                metadata={"amount": amount, "method": payment_mode,
                          "guest": room_data["guest"]["name"]},
            )
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
            _manual_refund_payload = {
                "room": room, "name": guest_name, "amount": amount,
                "method": refund_method, "type": "manual_refund",
                "date": data_json.get("date", datetime.now(IST).strftime("%Y-%m-%d")),
                "time": data_json.get("time", datetime.now(IST).strftime("%H:%M")),
                "transaction_type": "manual_refund",
                "stay_room_key": f"{room}_{room_data.get('checkin_time', '')}",
            }
            if active_bill_id:
                payment_service.write_payment_with_stay(active_bill_id, _manual_refund_payload)
            else:
                payment_service.write_payment(_manual_refund_payload)

            logger.info(f"Manual refund of ₹{amount} processed for room {room}")
            write_log(
                "payment.refund",
                target_collection="rooms",
                target_id=str(room),
                metadata={"amount": amount, "method": refund_method,
                          "guest": guest_name, "type": "manual_refund"},
            )
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

                # Auto-flag the customer as having a pending settlement so the
                # next check-in shows a warning with the outstanding balance.
                _guest_mobile = guest_info.get("mobile", "")
                if _guest_mobile:
                    from services import customer_service as _cs
                    _cs.set_pending_settlement(_guest_mobile, settlement)

            elif balance > 0 and not settle_later and guest_info.get("payment") != "ota":
                return jsonify(success=False, message="Please clear the balance before checkout")

            # Handle refund for negative balance
            refund_processed = False
            if balance < 0 and data_json.get("refund_method"):
                refund_amount = abs(balance)
                refund_method = data_json.get("refund_method", "cash")

                totals_update["refunds"] = firestore.Increment(refund_amount)
                refund_processed = True

                # A3: write the refund payment INTO the same checkout batch
                # so it commits atomically with the room/bill/totals updates.
                # The previous daemon-thread pattern could lose the payment
                # row if the process died between batch.commit() and the
                # thread flushing (Cloud Run scale-down, OOM, deploy).
                _refund_payload = {
                    "room": room, "name": guest_name, "amount": refund_amount,
                    "method": refund_method, "type": "checkout_refund",
                    "date": datetime.now(IST).strftime("%Y-%m-%d"),
                    "time": datetime.now(IST).strftime("%H:%M"),
                    "transaction_type": "checkout_refund",
                    "stay_room_key": f"{room}_{room_data.get('checkin_time', '')}",
                }
                if active_bill_id:
                    payment_service.write_payment_with_stay(
                        active_bill_id, _refund_payload, batch=batch,
                    )
                else:
                    payment_service.write_payment(_refund_payload, batch=batch)
                logger.info(
                    f"Checkout refund of ₹{refund_amount} added to checkout "
                    f"batch for room {room}"
                )

            # A3: settlement payment also goes into the same batch (atomic
            # with the rest of the checkout).
            if balance > 0 and settle_later:
                _settle_payload = {
                    "room": room, "name": guest_info["name"],
                    "amount": -balance, "method": "settlement",
                    "type": "settlement", "date": datetime.now(IST).strftime("%Y-%m-%d"),
                    "time": datetime.now(IST).strftime("%H:%M"),
                    "transaction_type": "settlement",
                    "settlement_id": settlement_id,
                    "stay_room_key": f"{room}_{room_data.get('checkin_time', '')}",
                }
                if active_bill_id:
                    payment_service.write_payment_with_stay(
                        active_bill_id, _settle_payload, batch=batch,
                    )
                else:
                    payment_service.write_payment(_settle_payload, batch=batch)

            # Save to bills + mark room cleaning — all in one batch commit
            checkout_time = datetime.now(IST).strftime("%Y-%m-%d %H:%M")

            # bill_id selection (Phase 4 of stay_doc migration):
            #   - New stays (post-Phase-2): finalize the existing draft.
            #     Its UUID is the bill_id. No second doc is created.
            #   - Legacy stays (pre-Phase-2): use the original {room}_{ts}
            #     ID format and create a fresh bill doc, exactly as before.
            if active_bill_id:
                bill_id = active_bill_id
            else:
                bill_id = f"{room}_{int(datetime.now(IST).timestamp())}"

            _sid = settlement_id if (balance > 0 and settle_later) else None
            bill_record = create_bill_record(
                room, room_data, checkout_time, batch,
                settle_later=(balance > 0 and settle_later),
                settlement_id=_sid
            )

            if bill_record:
                # Make sure the stay_id field stays correct on the doc even
                # if create_bill_record didn't set it. For legacy stays this
                # is the {room}_{ts} ID (same value as the doc ID); for new
                # stays it's the UUID (the active_bill_id).
                bill_record["stay_id"] = bill_id

                # Stamp checkout attribution onto the bill (config.create_bill_record
                # captured the pre-checkout fields; we add the checkout actor here
                # because we have flask.g context).
                _bill_co_user = (_safe_user() or {}).get("userId") or "system"
                _bill_co_now = datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")
                bill_record["lastCheckoutBy"] = _bill_co_user
                bill_record["lastCheckoutAt"] = _bill_co_now

                # ── pre_checkout_snapshot ────────────────────────────────────
                # Capture the room state being cleared by this checkout so the
                # 3-hour revert flow can restore it deterministically. Without
                # this snapshot, revert can only guess at fields like add_ons,
                # discounts, and renewal_count which are wiped from the room
                # doc below.
                bill_record["pre_checkout_snapshot"] = {
                    "guest":                   room_data.get("guest"),
                    "checkin_time":            room_data.get("checkin_time"),
                    "balance":                 room_data.get("balance", 0),
                    "add_ons":                 room_data.get("add_ons", []),
                    "discounts":               room_data.get("discounts", []),
                    "renewal_count":           room_data.get("renewal_count", 0),
                    "last_renewal_time":       room_data.get("last_renewal_time"),
                    "last_renewal_date":       room_data.get("last_renewal_date"),
                    "checkin_time_edit_count": room_data.get("checkin_time_edit_count", 0),
                    "active_bill_id":          active_bill_id,
                    # IST wall-clock when this snapshot was taken (for debugging)
                    "snapshot_at":             datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
                }

                if active_bill_id:
                    # Finalize the existing draft — merges checkout fields
                    # onto the doc that's been there since check-in. Goes
                    # through the helper so the audit timestamps and the
                    # "no revert to draft" guard are applied.
                    bills_service.finalize(active_bill_id, bill_record, batch=batch)
                else:
                    # Legacy path: create a fresh bill doc as before.
                    batch.set(bills_ref.document(bill_id), bill_record)

                logger.info(f"Bill saved for room {room}: {bill_record.get('bill_number')}, "
                            f"status={bill_record.get('status')}, "
                            f"path={'finalize' if active_bill_id else 'legacy'}")
            elif active_bill_id:
                # bill_record is None (guest data missing / parse error) but
                # we have a draft pointing at this stay. Don't leave an
                # orphan in "draft" status — flip it to cancelled so the
                # canary in Phase 8 doesn't flag it as stuck.
                batch.update(bills_ref.document(active_bill_id), {
                    "status":        "cancelled",
                    "cancel_reason": "checkout_without_bill_record",
                    "cancelled_at":  datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
                })
                logger.warning(f"Checkout for room {room}: bill_record was None "
                               f"with active_bill_id={active_bill_id}; draft "
                               f"flipped to cancelled to avoid orphan.")

            # Mark room as cleaning. We also stamp `last_bill_id` and
            # `last_checkout_at` (UTC iso) so the 3-hour mistake-checkout
            # revert button on the cleaning card can find the bill it would
            # undo and run the server-authoritative window check without
            # extra queries.
            from datetime import timezone as _tz
            _last_checkout_at_utc = datetime.now(_tz.utc).isoformat()
            _co_user = (_safe_user() or {}).get("userId") or "system"
            _co_now = datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")
            batch.update(rooms_ref.document(room), {
                "status": "cleaning",
                "guest": None,
                "checkin_time": None,
                "balance": 0,
                "add_ons": [],
                "discounts": [],
                "renewal_count": 0,
                "last_renewal_time": None,
                "last_renewal_date": None,
                "checkin_time_edit_count": 0,
                # Release the stay-doc pointer; the stay_id now lives on
                # the (newly finalized) bill doc.
                "active_bill_id": None,
                "cleaning_status": "in_progress",
                "cleaning_start_time": _co_now,
                # Revert-window pointers (cleared by /mark_room_cleaned and
                # by /revert_checkout itself).
                "last_bill_id":        bill_id if bill_record else None,
                "last_checkout_at":    _last_checkout_at_utc,
                # Attribution — who did this checkout. The lastCheckinBy
                # / bookedBy / lastCheckinTimeEditBy fields are cleared
                # because the popover on a vacant / cleaning room should
                # only show the post-stay trail (checked-out-by →
                # cleaned-by → approved-by). The full pre-stay chain is
                # preserved on the bill doc for the register-tab popover.
                "lastCheckoutBy":         _co_user,
                "lastCheckoutAt":         _co_now,
                "lastCheckinBy":          None,
                "lastCheckinAt":          None,
                "bookedBy":               None,
                "bookedAt":               None,
                "lastCheckinTimeEditBy":  None,
                "lastCheckinTimeEditAt":  None,
                "lastModifiedBy":         _co_user,
                "lastModifiedAt":         _co_now,
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

            write_log(
                "room.checkout",
                target_collection="rooms",
                target_id=str(room),
                # A1: before/after snapshots — only the fields this action
                # flips. Full doc dumps would bloat the audit_logs collection.
                before={
                    "status":       "occupied",
                    "guest_name":   guest_name,
                    "balance":      balance,
                    "checkin_time": room_data.get("checkin_time"),
                },
                after={
                    "status":         "cleaning",
                    "guest":          None,
                    "balance":        0,
                    "bill_status":    (bill_record or {}).get("status") if bill_record else None,
                    "settle_later":   bool(data_json.get("settle_later", False)),
                    "refund_processed": bool(refund_processed),
                },
                metadata={
                    "guest": guest_name,
                    "balance_at_checkout": balance,
                    "bill_id": bill_id if bool(bill_record) else None,
                    "bill_number": (bill_record or {}).get("bill_number") if bill_record else None,
                },
            )

            # ── Auto-generate PDF in background (non-blocking) ───────────────
            # Runs server-side so the PDF is saved to Firebase Storage regardless
            # of which page the staff is on when they do the checkout.
            has_bill = bool(bill_record)
            if has_bill:
                import threading
                threading.Thread(
                    target=auto_generate_bill_pdf,
                    args=(bill_id, bill_record),
                    daemon=True,
                ).start()
            # ────────────────────────────────────────────────────────────────

            # ── Banking: finalise pending cash on this stay ────────────────
            # If the stay finished WITHOUT a real bill number (invoice
            # toggle OFF -> bill_number == "-"), any cash collected on it
            # is non-deposit cash. Flip its eligibility from `pending`
            # to `excluded` so the deposit screen never offers it, and
            # the Unofficial tab can list it. If the bill DOES have a
            # real number, mark_unofficial_on_checkout is a no-op (the
            # trigger should already have fired on the first online
            # payment); calling it would simply do nothing.
            try:
                _bnum = (bill_record or {}).get("bill_number") if bill_record else None
                if not _bnum or str(_bnum).strip() in ("", "-"):
                    from services.banking import cash_receipts as _bk_receipts
                    _bk_receipts.mark_unofficial_on_checkout(bill_id)
            except Exception as _bk_e:
                # Banking-side bookkeeping must never block a checkout.
                logger.warning(
                    f"mark_unofficial_on_checkout failed for stay={bill_id}: {_bk_e}"
                )

            return jsonify(
                success=True,
                message=message,
                bill_id=bill_id if has_bill else None,
                has_bill=has_bill,
            )

        return jsonify(success=False, message="Invalid request parameters")

    except Exception as e:
        logger.error(f"Error during checkout: {str(e)}")
        return jsonify(success=False, message=f"Error during checkout: {str(e)}")


# ══════════════════════════════════════════════════════════════════════════════
# REVERT CHECKOUT — undo a mistake checkout within a 3-hour server-side window
# ══════════════════════════════════════════════════════════════════════════════
#
# Use case: front-desk accidentally checks out the wrong room while the guest
# is still staying. Within 3 hours of the wrong checkout, a manager can revert
# the action: the bill is voided (status -> draft, bill_number released), the
# room is restored to its pre-checkout state from the snapshot we captured at
# checkout time, settle-later settlements are deleted, refunds issued at
# checkout are reversed, and daily totals are corrected.
#
# Hard refusals (the system explains, the manager fixes manually):
#   * Window expired (now - finalized_at > 3h, server clock).
#   * Room has been re-occupied since the wrong checkout.
#   * Settle-later settlement was already collected (cash already moved).
#   * Bill not in completed/pending_settlement (already reverted, cancelled, etc.).
#   * Wrong manager password.
#
# Configurable: REVERT_CHECKOUT_WINDOW_HOURS env var (default 3).
# Local import — `_os` is defined further down in the file (under
# _check_manager_password) and isn't available at this point in module load.

import os as _os_revert
REVERT_CHECKOUT_WINDOW_HOURS = float(_os_revert.environ.get("REVERT_CHECKOUT_WINDOW_HOURS", "3"))


def _parse_finalized_at(bill: dict):
    """
    Return a timezone-aware UTC datetime for when the bill was finalized.

    Prefers `finalized_at` (UTC iso, written by bills_service.finalize for
    new stays). Falls back to `checkout_time` ("YYYY-MM-DD HH:MM" in IST)
    for legacy bills that pre-date the bills_service migration.

    Returns None if neither field is parseable — caller MUST refuse revert
    in that case (we can't enforce the window without a trustworthy timestamp).
    """
    from datetime import timezone as _tz
    fa = bill.get("finalized_at")
    if fa:
        try:
            # iso parser handles offset-aware strings ("...+00:00") and naive
            return datetime.fromisoformat(fa.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            logger.warning(f"_parse_finalized_at: bad finalized_at={fa!r}")

    co = bill.get("checkout_time")
    if co:
        try:
            naive = datetime.strptime(co, "%Y-%m-%d %H:%M")
            return IST.localize(naive).astimezone(_tz.utc)
        except (ValueError, TypeError):
            logger.warning(f"_parse_finalized_at: bad checkout_time={co!r}")

    return None


@rooms_bp.route("/revert_checkout", methods=["POST"])
@requires_permission("booking.revert")
def revert_checkout():
    """
    Undo a mistake checkout within REVERT_CHECKOUT_WINDOW_HOURS.

    Body: { stay_id: str, reason: str }
    Auth: admin role required (enforced by @requires_permission).

    Returns: { success: bool, message: str, ... }
    """
    from datetime import timezone as _tz
    from config import settlements_ref

    try:
        data = request.json or {}
        stay_id  = (data.get("stay_id") or "").strip()
        reason   = (data.get("reason")   or "").strip()

        if not stay_id:
            return jsonify(success=False, message="stay_id is required"), 400

        # ── 1. Auth handled by @requires_permission decorator above ──────────
        # (The legacy `password` field on the body is now ignored.)

        # ── 2. Load bill ─────────────────────────────────────────────────────
        bill_snap = bills_ref.document(stay_id).get()
        if not bill_snap.exists:
            return jsonify(success=False, message="Bill not found"), 404
        bill = bill_snap.to_dict()
        bill_status = bill.get("status")

        # Idempotency: a second click after a successful revert should be a no-op.
        if bill_status == "draft":
            return jsonify(
                success=True,
                already_reverted=True,
                message="This checkout was already reverted",
            )

        if bill_status not in ("completed", "pending_settlement"):
            return jsonify(
                success=False,
                message=f"Cannot revert a bill in status '{bill_status}'",
            ), 400

        # ── 3. Window check (server-authoritative) ───────────────────────────
        finalized_at_utc = _parse_finalized_at(bill)
        if finalized_at_utc is None:
            return jsonify(
                success=False,
                message="Cannot determine checkout time — revert refused",
            ), 400

        now_utc = datetime.now(_tz.utc)
        age_hours = (now_utc - finalized_at_utc).total_seconds() / 3600.0
        if age_hours > REVERT_CHECKOUT_WINDOW_HOURS:
            return jsonify(
                success=False,
                message=(
                    f"Revert window expired — checkout was "
                    f"{age_hours:.1f} hours ago "
                    f"(limit: {REVERT_CHECKOUT_WINDOW_HOURS}h)"
                ),
            ), 400
        if age_hours < 0:
            # Clock skew or bad data — refuse rather than silently allow.
            return jsonify(
                success=False,
                message="Checkout timestamp is in the future — revert refused",
            ), 400

        # ── 4. Room availability check ───────────────────────────────────────
        room = bill.get("room")
        if not room:
            return jsonify(success=False, message="Bill has no room — revert refused"), 400

        room_snap = rooms_ref.document(str(room)).get()
        if not room_snap.exists:
            return jsonify(success=False, message="Room not found"), 404
        room_doc = room_snap.to_dict()
        room_status = room_doc.get("status")

        # The room must be in cleaning state (just checked out) or vacant
        # (already marked cleaned but no new guest yet). If it's occupied
        # again, a different stay is in progress and we won't clobber it.
        if room_status == "occupied":
            return jsonify(
                success=False,
                message=f"Room {room} is occupied by a new guest — revert refused. "
                        f"Check that guest out first if this is wrong.",
            ), 409
        if room_status not in ("cleaning", "vacant"):
            return jsonify(
                success=False,
                message=f"Room {room} is in unexpected state '{room_status}' — revert refused",
            ), 409

        # If the room reference still points at a different active stay,
        # something is very wrong — refuse.
        cur_active = room_doc.get("active_bill_id")
        if cur_active and cur_active != stay_id:
            return jsonify(
                success=False,
                message=f"Room {room} is linked to a different active stay — revert refused",
            ), 409

        # ── 5. Settlement check ──────────────────────────────────────────────
        settlement_id = bill.get("settlement_id")
        settlement_doc = None
        if settlement_id:
            settlement_doc = settlements_ref.document(settlement_id).get()
            if settlement_doc.exists:
                s_status = (settlement_doc.to_dict() or {}).get("status")
                if s_status == "paid":
                    return jsonify(
                        success=False,
                        message=(
                            "The settle-later balance from this checkout has "
                            "already been collected — money has moved. "
                            "Revert refused. Handle this as a manual adjustment."
                        ),
                    ), 409

        # ── 6. Reverse side effects in a single batch ────────────────────────
        snapshot = bill.get("pre_checkout_snapshot") or {}
        guest_snap = snapshot.get("guest")

        if not guest_snap:
            # Older bills (pre-snapshot deploy) won't have this field.
            # Try the best fallback we have: rebuild from bill fields.
            logger.warning(
                f"revert_checkout: stay_id={stay_id} has no pre_checkout_snapshot; "
                f"falling back to bill-derived restore (may be lossy)."
            )
            guest_snap = {
                "name":   bill.get("guest_name", ""),
                "mobile": bill.get("guest_mobile", ""),
                "price":  bill.get("room_price_per_night", 0),
                "guests": bill.get("guest_count", 1),
                # Best-effort defaults — original payment mode is unknown.
                "payment": "balance",
                "balance": int(bill.get("balance", 0) or 0),
                "isAC":   bool(bill.get("is_ac", False)),
            }

        batch = db.batch()
        totals_update = {}

        # 6a. Settlement: delete the doc and credit balance back.
        was_settle_later = (bill_status == "pending_settlement") and bool(settlement_id)
        if was_settle_later and settlement_doc and settlement_doc.exists:
            settlement_amount = int((settlement_doc.to_dict() or {}).get("amount", 0))
            batch.delete(settlements_ref.document(settlement_id))
            if settlement_amount > 0:
                totals_update["balance"] = firestore.Increment(settlement_amount)

            # Clear the customer's pending-settlement flag.
            mobile = guest_snap.get("mobile") if guest_snap else None
            if mobile:
                try:
                    customer_service.clear_pending_settlement(mobile)
                except Exception as _e:
                    logger.warning(f"revert_checkout: clear_pending_settlement failed: {_e}")

        # 6b. Refund: reverse the totals.refunds bump and write a reversing
        # payment entry. The original refund payment row is left in place
        # (audit trail) — the reversal nets it out.
        refund_total = int(bill.get("refunds", 0) or 0)
        refund_reversed = False
        if refund_total > 0:
            totals_update["refunds"] = firestore.Increment(-refund_total)
            refund_reversed = True

        # 6c. Bill: cancel the original bill (no Credit Note — the invoice
        #     is not yet GSTR-1-filed, see revert_to_draft) and create a
        #     fresh draft for the re-checkout.
        revert_result = bills_service.revert_to_draft(
            stay_id,
            reason=reason,
            actor=f"manager:{request.remote_addr or 'unknown'}",
            batch=batch,
        )
        if revert_result is None:
            # bills_service refused — bail out before committing anything.
            return jsonify(
                success=False,
                message="Bill revert refused by bills_service — see server logs",
            ), 500
        new_stay_id = revert_result.get("new_stay_id") or stay_id
        revert_cn   = revert_result.get("credit_note")

        # 6d. Room: restore from snapshot.
        restored_balance = int(snapshot.get("balance", guest_snap.get("balance", 0)) or 0)
        room_restore = {
            "status":                  "occupied",
            "guest":                   guest_snap,
            "checkin_time":            snapshot.get("checkin_time") or bill.get("checkin_time"),
            "balance":                 restored_balance,
            "add_ons":                 snapshot.get("add_ons", []),
            "discounts":               snapshot.get("discounts", []),
            "renewal_count":           int(snapshot.get("renewal_count", 0) or 0),
            "last_renewal_time":       snapshot.get("last_renewal_time"),
            "last_renewal_date":       snapshot.get("last_renewal_date"),
            "checkin_time_edit_count": int(snapshot.get("checkin_time_edit_count", 0) or 0),
            # Re-attach to the FRESH draft stay_id (the original is now
            # superseded with a credit note linked). Future payments and
            # the next checkout flow will write against this new ID.
            "active_bill_id":          new_stay_id,
            # Cancel cleaning state.
            "cleaning_status":         None,
            "cleaning_start_time":     None,
            # Clear revert-window pointers.
            "last_bill_id":            None,
            "last_checkout_at":        None,
        }
        batch.update(rooms_ref.document(str(room)), room_restore)

        if totals_update:
            batch.update(totals_ref.document('current_totals'), totals_update)

        try:
            batch.commit()
        except Exception as e:
            logger.error(f"revert_checkout: batch commit failed for stay_id={stay_id}: {e}",
                         exc_info=True)
            return jsonify(success=False, message=f"Revert failed: {e}"), 500

        invalidate_rooms_and_totals()
        _invalidate_get_data_cache()

        # 6e. Reversing payment row (best-effort, after commit so a failure here
        # doesn't undo the revert itself).
        if refund_reversed:
            try:
                _reversal_payload = {
                    "room":             str(room),
                    "name":             guest_snap.get("name", ""),
                    "amount":           refund_total,
                    "method":           "cash",  # method-agnostic reversal entry
                    "type":             "revert_checkout_refund_reversal",
                    "date":             datetime.now(IST).strftime("%Y-%m-%d"),
                    "time":             datetime.now(IST).strftime("%H:%M"),
                    "transaction_type": "revert_checkout_refund_reversal",
                    "stay_room_key":    f"{room}_{snapshot.get('checkin_time', bill.get('checkin_time', ''))}",
                    "reverted_stay_id": stay_id,
                }
                import threading as _thr
                _thr.Thread(
                    target=payment_service.write_payment_with_stay,
                    args=(stay_id, _reversal_payload),
                    daemon=True,
                ).start()
            except Exception as _e:
                logger.warning(f"revert_checkout: refund reversal write failed: {_e}")

        # 6f. Audit log (separate collection, best-effort).
        try:
            db.collection("revert_audit").document().set({
                "stay_id":              stay_id,
                "new_stay_id":          new_stay_id,
                "room":                 str(room),
                "reason":               reason,
                "reverted_at":          datetime.now(_tz.utc).isoformat(),
                "reverted_by_ip":       request.remote_addr or "",
                "original_checkout_at": bill.get("checkout_time"),
                "original_finalized_at": bill.get("finalized_at"),
                "original_bill_number": bill.get("bill_number"),
                "had_settlement":       was_settle_later,
                "settlement_amount":    int((settlement_doc.to_dict() or {}).get("amount", 0))
                                          if (was_settle_later and settlement_doc and settlement_doc.exists)
                                          else 0,
                "refund_reversed":      refund_total if refund_reversed else 0,
                "snapshot_used":        bool(snapshot.get("guest")),
                "age_hours_at_revert":  round(age_hours, 3),
                "credit_note_number":   (revert_cn or {}).get("cn_number"),
                "credit_note_id":       (revert_cn or {}).get("cn_id"),
            })
        except Exception as _e:
            logger.warning(f"revert_checkout: audit log write failed: {_e}")

        # CN-specific audit (Goal 2 requirement: every CN write goes through
        # services.audit_log.write_log).
        if revert_cn:
            try:
                write_log(
                    "credit_note.create",
                    target_collection="credit_notes",
                    target_id=str(revert_cn.get("cn_id") or ""),
                    metadata={
                        "reason":               "checkout_mistake",
                        "against_bill_id":      stay_id,
                        "against_bill_number":  bill.get("bill_number"),
                        "credit_amount_total":  revert_cn.get("credit_amount_total"),
                        "cn_number":            revert_cn.get("cn_number"),
                    },
                )
            except Exception as _le:
                logger.warning(f"revert_checkout: CN audit-log failed: {_le}")

        logger.info(
            f"revert_checkout: stay_id={stay_id} → new_stay_id={new_stay_id} "
            f"room={room} age_hours={age_hours:.2f} "
            f"settle_later_reversed={was_settle_later} refund_reversed={refund_reversed} "
            f"snapshot_used={bool(snapshot.get('guest'))}"
        )

        write_log(
            "booking.revert",
            target_collection="rooms",
            target_id=str(room),
            metadata={
                "stay_id": stay_id,
                "new_stay_id": new_stay_id,
                "reason": reason,
                "had_settlement": was_settle_later,
                "refund_reversed": refund_total if refund_reversed else 0,
                "age_hours_at_revert": round(age_hours, 3),
                "credit_note_number": (revert_cn or {}).get("cn_number"),
            },
        )
        return jsonify(
            success=True,
            message=f"Checkout reverted. Room {room} restored.",
            stay_id=stay_id,
            new_stay_id=new_stay_id,
            credit_note_number=(revert_cn or {}).get("cn_number"),
            room=str(room),
            refund_reversed=refund_total if refund_reversed else 0,
            settlement_reversed=was_settle_later,
            snapshot_used=bool(snapshot.get("guest")),
        )

    except Exception as e:
        logger.error(f"revert_checkout: unhandled error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error reverting checkout: {e}"), 500


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

        # Accommodation charges (AC, Extra Bed) are taxable under GST alongside room rent.
        # The frontend sends this flag for those specific service types.
        accommodation_charge = bool(data_json.get("accommodation_charge", False))

        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found")

        room_data = room_doc.to_dict()
        batch = db.batch()

        # ── Stamp applied_on_day for the daily folio model ────────────────────
        # The 24h stay-day boundary is anchored to checkin_time (renewal at
        # checkin + 24h, not at midnight). Day index = floor((now - checkin)
        # / 24h) + 1. So a service added at +1h is Day 1; at +25h is Day 2.
        #
        # Frontend may override by sending an explicit applied_on_day (e.g.
        # operator wants to retroactively bill an AC charge to Day 2 instead
        # of Day 1). When omitted, we default to the computed current day.
        # This stamp lets create_bill_record's daily_folio attribute the
        # right slab to the right night even when stays cross slab thresholds.
        _default_day_idx = 1
        _checkin_str = room_data.get("checkin_time")
        if _checkin_str:
            try:
                _ci_dt = datetime.strptime(_checkin_str, "%Y-%m-%d %H:%M")
                _ci_dt = IST.localize(_ci_dt)
                _elapsed_h = (datetime.now(IST) - _ci_dt).total_seconds() / 3600.0
                _default_day_idx = max(1, int(_elapsed_h // 24) + 1)
            except (ValueError, TypeError):
                _default_day_idx = 1
        try:
            applied_on_day = int(
                data_json.get("applied_on_day") or _default_day_idx
            )
        except (TypeError, ValueError):
            applied_on_day = _default_day_idx
        if applied_on_day < 1:
            applied_on_day = 1

        # Pin the service to an absolute date too. applied_on_day is a
        # RELATIVE index counted from check-in; if the operator later
        # corrects the check-in time, the day index for a previously
        # written service is no longer correct. applied_on_date stores
        # the actual calendar date the service applies to, computed
        # from the CURRENT check-in time + (applied_on_day - 1) full
        # days. The folio computation prefers this absolute date when
        # present and falls back to the relative index for legacy rows.
        applied_on_date = None
        if _checkin_str:
            try:
                _ci_dt_pin = datetime.strptime(_checkin_str, "%Y-%m-%d %H:%M")
                applied_on_date = (
                    _ci_dt_pin.date()
                    + timedelta(days=(applied_on_day - 1))
                ).strftime("%Y-%m-%d")
            except (ValueError, TypeError):
                applied_on_date = None

        add_on_entry = {
            "room": room,
            "item": item,
            "price": price,
            "unit_price": unit_price,
            "quantity": quantity,
            "time": datetime.now(IST).strftime("%H:%M"),
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "payment_method": payment_method,
            "transaction_type": "service",
            # Mark whether this add-on is an accommodation charge for GST purposes.
            "accommodation_charge": accommodation_charge,
            # Daily folio: which stay-day this charge belongs to.
            # `applied_on_day` is the relative 1-based index counted from
            # check-in; `applied_on_date` is the absolute calendar date the
            # service applies to. The folio prefers the date when present
            # so a later check-in time correction does NOT silently move
            # the charge to a different night.
            "applied_on_day":  applied_on_day,
            "applied_on_date": applied_on_date,
        }

        # ── Tax classification (Rule 46) ──────────────────────────────────────
        # Accommodation charges (AC, extra bed, extra person) share the room's
        # SAC 996311 and follow the per-night room tariff slab — those are
        # handled by the folio renderer. For non-accommodation services we
        # infer HSN/SAC + GST rate from the item name so every line on the
        # bill carries a correct tax tag and the tax summary aggregates per
        # (HSN/SAC, rate). Explicit fields in the request payload win.
        try:
            if accommodation_charge:
                add_on_entry["hsn_or_sac"] = "996311"
                add_on_entry["tax_category"] = "accommodation"
                # gst_rate is determined per-night by the folio; not stamped here.
            else:
                _payload_hsn = (data_json.get("hsn_or_sac") or "").strip()
                if _payload_hsn:
                    add_on_entry["hsn_or_sac"] = _payload_hsn
                    add_on_entry["gst_rate"] = int(data_json.get("gst_rate") or 0)
                    add_on_entry["tax_category"] = data_json.get("tax_category", "goods")
                else:
                    from routes.billing import infer_service_tax as _infer
                    _hsn, _rate, _cat = _infer({"item": item})
                    if _hsn:
                        add_on_entry["hsn_or_sac"] = _hsn
                        add_on_entry["gst_rate"] = _rate
                        add_on_entry["tax_category"] = _cat
        except Exception as _tax_e:
            # Inference failure must never block the add-on write. Render-time
            # inference will fill the gap.
            logger.warning(f"tax inference for add_on failed: {_tax_e}")

        # Build atomic update for totals
        totals_update = {}

        if payment_method in ["cash", "online"]:
            totals_update[payment_method] = firestore.Increment(price)
        else:
            new_balance = room_data["balance"] + price
            batch.update(rooms_ref.document(room), {"balance": new_balance})
            totals_update["balance"] = firestore.Increment(price)

        room_update = {"add_ons": firestore.ArrayUnion([add_on_entry])}

        # If this is an AC service charge, mark the room's guest as AC-enabled.
        # This causes the snowflake (❄️) indicator to appear on the room card
        # after the next data refresh.
        is_ac_service = accommodation_charge and item.upper().startswith("AC")
        if is_ac_service:
            room_update["guest.isAC"] = True

        # ── Mid-stay price change for accommodation add-ons ──────────────────────
        # When an accommodation_charge add-on is added (AC, Extra Bed, etc.) it
        # CAN represent a permanent per-night increase going forward — in which
        # case we snapshot prior days at the old rate and bump guest.price so
        # the next renewal picks up the new rate.
        #
        # But it CAN ALSO be a retroactive charge for a past day only ("guest
        # used AC yesterday, forgot to record it"). In that case the room
        # rate must NOT change for future days — the addon sits on the
        # specific past day in the folio and that's it.
        #
        # We use the applied_on_day stamp to distinguish:
        #   applied_on_day < _default_day_idx  → retroactive (past day)
        #     → just record the addon, don't touch guest.price
        #   applied_on_day >= _default_day_idx → going-forward
        #     → bump guest.price + snapshot prior days (legacy behaviour)
        is_retroactive = applied_on_day < _default_day_idx
        if accommodation_charge and not is_retroactive:
            guest        = room_data.get("guest", {})
            old_price    = guest.get("price", 0)
            renewal_count = room_data.get("renewal_count", 0)
            existing_offset = guest.get("transfer_day_offset", 0)
            # For accommodation add-ons (Extra Bed, AC): use +1 formula.
            # The service price covers TODAY at old room rate; the bumped
            # price covers future renewals.
            old_days     = (renewal_count + 1) - existing_offset

            existing_pre = list(guest.get("pre_transfer_charges", []) or [])
            if old_days > 0:
                existing_pre.append({
                    "days":      old_days,
                    "price":     old_price,
                    "total":     old_price * old_days,
                    "from_room": room,          # same room — price change, not room change
                })
            new_price = old_price + int(unit_price)

            room_update["guest.pre_transfer_charges"] = existing_pre
            room_update["guest.transfer_day_offset"]  = existing_offset + old_days
            room_update["guest.price"]                = new_price
        # Retroactive addons fall through with no guest.price change. The
        # addon row is still written to room.add_ons + payments above, and
        # picked up by the daily_folio at checkout (it knows which day to
        # attribute the charge to via applied_on_day).
        # ─────────────────────────────────────────────────────────────────────────

        batch.update(rooms_ref.document(room), room_update)

        batch.update(totals_ref.document('current_totals'), totals_update)
        batch.commit()

        invalidate_rooms_and_totals()

        # --- Dual-write: payments collection ---
        _addon_payload = {
            "room": room, "name": room_data["guest"]["name"],
            "amount": price, "method": payment_method, "type": "addon",
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "time": datetime.now(IST).strftime("%H:%M"),
            "item": item, "unit_price": unit_price, "quantity": quantity,
            "transaction_type": "service",
            "accommodation_charge": accommodation_charge,
            "applied_on_day":  applied_on_day,
            "applied_on_date": applied_on_date,
            "stay_room_key": f"{room}_{room_data.get('checkin_time', '')}",
        }
        _abid_addon = room_data.get("active_bill_id")
        if _abid_addon:
            payment_service.write_payment_with_stay(_abid_addon, _addon_payload)
        else:
            payment_service.write_payment(_addon_payload)

        logger.info(f"Add-on '{item}' added to room {room}, price: ₹{price}, payment: {payment_method}")

        if payment_method == "balance":
            write_log("room.addon", target_collection="rooms", target_id=str(room),
                      metadata={"item": item, "price": price, "method": "balance"})
            return jsonify(success=True, message=f"Added {item} (₹{price}) to room {room} balance")
        else:
            write_log("room.addon", target_collection="rooms", target_id=str(room),
                      metadata={"item": item, "price": price, "method": payment_method})
            return jsonify(success=True, message=f"Added {item} (₹{price}) to room {room}, paid by {payment_method}")
    except Exception as e:
        logger.error(f"Error adding add-on: {str(e)}")
        return jsonify(success=False, message=f"Error adding add-on: {str(e)}")

@rooms_bp.route("/renew_rent", methods=["POST"])
def renew_rent():
    """
    Renew rent for one more 24h cycle on a room.

    Race-safe: the read of (renewal_count, last_renewal_date) and the
    write of the incremented values run inside one Firestore transaction.
    Two simultaneous renew requests cannot both pass the
    `incoming_count == current_count + 1` guard -- the second one sees
    the first's committed state and is rejected with the
    "Renewal already processed" message.

    Payment-row write (the dual-write into the `payments` collection)
    happens AFTER the transaction commits and is keyed by the canonical
    stay_id when available. The transaction guarantees that for any
    successful renewal, exactly one renewal_count++ happened on the
    room doc, so at most one payment row can be produced per click.
    """
    try:
        data_json = request.json
        room = data_json["room"]
        incoming_count = data_json.get("renewal_count", 0)
        today_str = datetime.now(IST).strftime("%Y-%m-%d")

        room_ref = rooms_ref.document(room)

        # State captured by the transactional closure so we can use it
        # for the (outside-transaction) payment + audit-log writes.
        captured = {"room_data": None, "price": 0}

        @firestore.transactional
        def _txn_renew(txn):
            snap = room_ref.get(transaction=txn)
            if not snap.exists:
                return ("err", "Room not found")
            rd = snap.to_dict() or {}
            if rd.get("status") != "occupied" or not rd.get("guest"):
                return ("err", "Room not occupied.")
            current_count = rd.get("renewal_count", 0) or 0
            if incoming_count != current_count + 1:
                return ("err",
                        "Renewal already processed. Please refresh and try again.")
            if rd.get("last_renewal_date", "") == today_str:
                return ("err", "Rent already renewed today for this room.")

            guest_in_txn = rd["guest"]
            price_in_txn = int(guest_in_txn["price"])
            new_balance  = int(rd.get("balance", 0)) + price_in_txn

            txn.update(room_ref, {
                "balance":           new_balance,
                "renewal_count":     incoming_count,
                "last_renewal_date": today_str,
            })
            txn.update(
                totals_ref.document("current_totals"),
                {"balance": firestore.Increment(price_in_txn)},
            )
            captured["room_data"] = rd
            captured["price"]     = price_in_txn
            return ("ok", None)

        txn = db.transaction()
        status, msg = _txn_renew(txn)
        if status != "ok":
            return jsonify(success=False, message=msg)

        room_data     = captured["room_data"]
        price         = captured["price"]
        guest         = room_data["guest"]
        renewal_count = incoming_count

        invalidate_rooms_and_totals()

        from config import update_last_rent_check
        update_last_rent_check()

        # --- Dual-write: payments collection ---
        _renewal_payload = {
            "room": room, "name": guest["name"], "amount": price,
            "method": "balance", "type": "renewal",
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "time": datetime.now(IST).strftime("%H:%M"),
            "transaction_type": "rent_renewal",
            "note": f"Day {renewal_count + 1} rent renewal",
            "stay_room_key": f"{room}_{room_data.get('checkin_time', '')}",
        }
        _abid_renew = room_data.get("active_bill_id")
        if _abid_renew:
            payment_service.write_payment_with_stay(_abid_renew, _renewal_payload)
        else:
            payment_service.write_payment(_renewal_payload)

        logger.info(f"Rent renewed for Room {room}, Day {renewal_count + 1}")
        write_log("room.renew", target_collection="rooms", target_id=str(room),
                  metadata={"guest": guest.get("name"), "renewal_count": renewal_count, "amount": price})
        return jsonify(success=True, message=f"Rent renewed for Room {room}")
    except Exception as e:
        logger.error(f"Error renewing rent: {str(e)}")
        return jsonify(success=False, message=f"Error renewing rent: {str(e)}")


@rooms_bp.route("/shorten_stay", methods=["POST"])
@requires_permission("discount.apply")
def shorten_stay():
    """
    Reverse one or more previously-applied rent renewals on an occupied room.

    Use case: guest booked / renewed for N days but is leaving early. Instead
    of papering over the mismatch with a fake discount (which produced
    misleading bills before this endpoint existed), the operator clicks
    "Shorten Stay" on the checkout modal and the system:

      1. Decrements ``renewal_count`` by the requested amount.
      2. Subtracts ``days_to_reverse × current_price`` from ``room.balance``
         and from the global ``totals.balance`` counter, undoing the
         "add a day's rent to balance" effect of past /renew_rent calls.
      3. Clears ``last_renewal_date`` so the same day can be re-renewed
         later if circumstances change (rare, but allowed).
      4. Writes a single ``payments`` row of type ``rent_reversal`` for the
         audit trail — this row carries ``stay_id`` so it appears in the
         per-stay history alongside the original renewals it offsets.
      5. Writes an audit log entry.

    After this runs the operator's bill recomputes against the smaller
    ``renewal_count`` (folio uses ``renewal_count + 1`` days). If the guest
    has already paid for the now-reversed nights the resulting negative
    balance flows naturally through the existing refund-on-checkout path.

    Auth: ``discount.apply`` — same gate that protects the manual-discount
    endpoint, since this is functionally a fee reduction.

    Body
    ----
    room : str             — required, room number / id
    days_to_reverse : int  — required, must be >= 1 and <= current renewal_count
    reason : str           — optional, free-text note for the audit log

    Returns
    -------
    JSON: {success, message, new_renewal_count, new_balance, reversal_amount}
    """
    try:
        data_json = request.json or {}
        room = data_json.get("room")
        days_to_reverse = int(data_json.get("days_to_reverse", 0) or 0)
        reason = (data_json.get("reason") or "").strip()[:200]

        if not room:
            return jsonify(success=False, message="Room is required"), 400
        if days_to_reverse < 1:
            return jsonify(success=False, message="days_to_reverse must be >= 1"), 400

        room_ref = rooms_ref.document(str(room))

        # State captured by the transactional closure so we can use it
        # for the (outside-transaction) audit + payment-row writes.
        captured = {
            "room_data": None,
            "price": 0,
            "reversal_amount": 0,
            "new_renewal_count": 0,
            "new_balance": 0,
        }

        @firestore.transactional
        def _txn_shorten(txn):
            snap = room_ref.get(transaction=txn)
            if not snap.exists:
                return ("err", "Room not found", 404)
            rd = snap.to_dict() or {}
            if rd.get("status") != "occupied" or not rd.get("guest"):
                return ("err", "Room is not occupied", 409)

            current_count = int(rd.get("renewal_count", 0) or 0)
            if days_to_reverse > current_count:
                return (
                    "err",
                    f"Cannot reverse {days_to_reverse} day(s): only "
                    f"{current_count} renewal(s) exist on this stay.",
                    409,
                )

            price_in_txn = int((rd.get("guest") or {}).get("price", 0) or 0)
            if price_in_txn <= 0:
                return ("err", "Room rate missing on guest record", 409)

            reversal_amount = price_in_txn * days_to_reverse
            new_count   = current_count - days_to_reverse
            new_balance = int(rd.get("balance", 0) or 0) - reversal_amount

            # Update room doc.
            #   - renewal_count: drops by N
            #   - balance: drops by N * rate (undoes the +rate-per-renewal effect)
            #   - last_renewal_date: cleared so the date-of-day guard in
            #     /renew_rent doesn't lock today if the operator changes
            #     their mind again. Re-renewal is rare but harmless.
            txn.update(room_ref, {
                "balance":           new_balance,
                "renewal_count":     new_count,
                "last_renewal_date": "",
            })
            txn.update(
                totals_ref.document("current_totals"),
                {"balance": firestore.Increment(-reversal_amount)},
            )
            captured["room_data"]        = rd
            captured["price"]            = price_in_txn
            captured["reversal_amount"]  = reversal_amount
            captured["new_renewal_count"] = new_count
            captured["new_balance"]      = new_balance
            return ("ok", None, 200)

        txn = db.transaction()
        status, msg, http_code = _txn_shorten(txn)
        if status != "ok":
            return jsonify(success=False, message=msg), http_code

        room_data       = captured["room_data"]
        price           = captured["price"]
        reversal_amount = captured["reversal_amount"]
        guest           = room_data.get("guest") or {}

        invalidate_rooms_and_totals()

        # ── Audit-friendly payments row ──────────────────────────────────────
        # type=rent_reversal, method=balance, amount=reversal_amount.
        # This is a ledger entry — not a cash flow — so it sits on the
        # "balance" rail like the original renewal entries it offsets. The
        # bill renderer's folio math relies on renewal_count (which we just
        # decremented), so this row is informational; it does not need to
        # be summed into Cash Paid / Online Paid totals.
        _reversal_payload = {
            "room": str(room),
            "name": guest.get("name", ""),
            "amount": reversal_amount,
            "method": "balance",
            "type": "rent_reversal",
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "time": datetime.now(IST).strftime("%H:%M"),
            "transaction_type": "rent_reversal",
            "note": (
                f"Shorten stay by {days_to_reverse} day(s) "
                f"@ ₹{price}/day"
                + (f" — {reason}" if reason else "")
            ),
            "stay_room_key": f"{room}_{room_data.get('checkin_time', '')}",
            "days_reversed": days_to_reverse,
            "rate_at_reversal": price,
        }
        _abid = room_data.get("active_bill_id")
        try:
            if _abid:
                payment_service.write_payment_with_stay(_abid, _reversal_payload)
            else:
                payment_service.write_payment(_reversal_payload)
        except Exception as _e:
            # Audit-row failure is non-fatal — the room state has already
            # been corrected. Log loud and keep going.
            logger.error(f"shorten_stay: failed to write audit payment row: {_e}")

        logger.info(
            f"shorten_stay: room={room} days_reversed={days_to_reverse} "
            f"amount=₹{reversal_amount} new_renewal_count={captured['new_renewal_count']} "
            f"new_balance=₹{captured['new_balance']}"
        )
        write_log(
            "room.shorten_stay",
            target_collection="rooms",
            target_id=str(room),
            metadata={
                "guest": guest.get("name"),
                "days_reversed": days_to_reverse,
                "rate": price,
                "reversal_amount": reversal_amount,
                "new_renewal_count": captured["new_renewal_count"],
                "new_balance": captured["new_balance"],
                "reason": reason,
            },
        )
        return jsonify(
            success=True,
            message=(
                f"Stay shortened by {days_to_reverse} day(s). "
                f"₹{reversal_amount} removed from balance."
            ),
            new_renewal_count=captured["new_renewal_count"],
            new_balance=captured["new_balance"],
            reversal_amount=reversal_amount,
        )
    except Exception as e:
        logger.error(f"Error in shorten_stay: {str(e)}")
        return jsonify(success=False, message=f"Error: {str(e)}"), 500


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

        # ── RBAC: manager gets ONE edit per stay; admin unrestricted. ────────
        # The frontend hides the button after the first edit, but we re-check
        # here so a manager can't bypass via dev tools or a stale bundle.
        from flask import g as _g
        _user = getattr(_g, "current_user", None) or {}
        _role = _user.get("role")
        _edit_count = int(room_data.get("checkin_time_edit_count") or 0)
        if _role == "manager" and _edit_count >= 1:
            return (
                jsonify(
                    success=False,
                    message="Check-in time has already been edited once. "
                            "Ask an admin if it needs to change again.",
                ),
                403,
            )
        if _role and _role not in ("admin", "manager"):
            # Housekeeping (or any future role without the room.update perm)
            return jsonify(success=False, message="Forbidden"), 403

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

        # Move the first check-in payment onto the new check-in date/time.
        # Runs on ANY edit — a date change OR a time-only correction —
        # because the Transactions tab derives each day's serial order
        # from the payment's date/time, so the check-in row only
        # re-sorts once its payment carries the new time. A stay with no
        # payment row simply has nothing to update.
        if guest_name:
            try:
                from firebase_admin import firestore as _fs
                from google.cloud.firestore_v1.base_query import FieldFilter as _FF
                payments_ref = db.collection("payments")
                # The check-in payment is dated on the OLD check-in date
                # (which equals new_date for a time-only edit).
                pq = (
                    payments_ref
                    .where(filter=_FF("room", "==", str(room)))
                    .where(filter=_FF("date", "==", old_date))
                )
                new_time_str = new_checkin_dt.strftime("%H:%M")
                old_payment_serial = None
                for pdoc in pq.stream():
                    pdata = pdoc.to_dict()
                    # Only the first checkin / booking-conversion payment.
                    if (pdata.get("name") == guest_name and
                            pdata.get("transaction_type") in
                            ("fresh_checkin", "booking_conversion")):
                        old_payment_serial = pdata.get("serial_number")
                        _pay_update = {
                            "date": new_date,
                            "time": new_time_str,
                        }
                        if new_serial is not None:
                            _pay_update["serial_number"] = new_serial
                        if date_changed:
                            _pay_update["original_date"] = old_date
                        pdoc.reference.update(_pay_update)
                        logger.info(
                            f"Updated payments doc {pdoc.id}: date {old_date} -> "
                            f"{new_date}, time -> {new_time_str}"
                        )

                # On a DATE change, release the old date's counter slot if
                # this was the last serial issued that day, so the next
                # check-in there can reuse the number instead of skipping
                # it. If it was NOT the last, the counter is left alone to
                # avoid creating a duplicate serial.
                if date_changed and old_payment_serial is not None:
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
                logger.warning(f"Failed to update check-in payment date/time: {e}")

        # Build update payload — only reset renewal cycle if the DATE changed.
        # A time-only correction (same calendar day) should NOT wipe out
        # the renewal count; the guest is still on the same day cycle.
        _ed_user = (_safe_user() or {}).get("userId") or "system"
        _ed_now = datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")
        update_payload = {
            "checkin_time": new_checkin_time,
            "last_renewal_time": None,
            "checkin_time_edit_count": (room_data.get("checkin_time_edit_count") or 0) + 1,
            # Attribution — surfaced in the room-history popover.
            "lastCheckinTimeEditBy": _ed_user,
            "lastCheckinTimeEditAt": _ed_now,
            "lastModifiedBy": _ed_user,
            "lastModifiedAt": _ed_now,
        }
        if date_changed:
            update_payload["renewal_count"] = 0
            update_payload["last_renewal_date"] = None

        rooms_ref.document(room).update(update_payload)

        # Keep the draft stay doc's checkin_time in sync with the room.
        # The doc ID (stay_id) is intentionally NOT regenerated — the same
        # stay continues, just with a corrected timestamp.
        _abid = room_data.get("active_bill_id")
        if _abid:
            try:
                bills_service.update(_abid, {"checkin_time": new_checkin_time})
            except Exception as _e:
                logger.warning(f"update_checkin_time: failed to sync draft "
                               f"stay_id={_abid}: {_e}")

        # Same _GET_DATA_CACHE concern as transfer_room — use the
        # monkey-patched invalidator so the /get_data cache is busted too.
        invalidate_rooms_and_totals()

        msg = "Check-in time updated successfully."
        if new_serial:
            msg += f" Serial reassigned to #{new_serial} for {new_date}."

        logger.info(f"Check-in time updated for room {room}: {new_checkin_time}")
        write_log("room.checkin_time_update", target_collection="rooms", target_id=str(room),
                  metadata={"new_checkin_time": new_checkin_time, "serial": new_serial})
        return jsonify(success=True, message=msg, serial_number=new_serial)
    except Exception as e:
        logger.error(f"Error updating check-in time: {str(e)}")
        return jsonify(success=False, message=f"Error updating check-in time: {str(e)}")


@rooms_bp.route("/update_guest_mobile", methods=["POST"])
def update_guest_mobile():
    """
    Set / correct the guest mobile number on an OCCUPIED room.

    Body: { room: "101", mobile: "9876543210" }

    Primary use case: MMT (and other OTA) vouchers mask the guest phone, so an
    auto-ingested booking checks in with an empty mobile. Staff need to capture
    the real number after check-in so checkout, the call link, and any later
    follow-up have it.

    Auth: admin or manager (same room-edit tier as /update_checkin_time).
    Housekeeping and unknown roles are rejected.
    """
    try:
        data_json = request.json or {}
        room = data_json.get("room")
        # Keep digits only — strip spaces, dashes, a leading +91, etc.
        raw_mobile = str(data_json.get("mobile", "")).strip()
        mobile = re.sub(r"\D", "", raw_mobile)
        # Drop a leading country code (91) if the result is 12 digits.
        if len(mobile) == 12 and mobile.startswith("91"):
            mobile = mobile[2:]

        if not room:
            return jsonify(success=False, message="Room is required."), 400

        if len(mobile) != 10:
            return jsonify(
                success=False,
                message="Enter a valid 10-digit mobile number.",
            ), 400

        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found."), 404

        room_data = room_doc.to_dict()
        if room_data.get("status") != "occupied" or not room_data.get("guest"):
            return jsonify(success=False, message="Room is not occupied."), 400

        # ── RBAC: admin or manager only (mirrors /update_checkin_time) ────────
        from flask import g as _g
        _user = getattr(_g, "current_user", None) or {}
        _role = _user.get("role")
        if _role and _role not in ("admin", "manager"):
            return jsonify(success=False, message="Forbidden"), 403

        old_mobile = (room_data.get("guest") or {}).get("mobile", "")

        _ed_user = (_safe_user() or {}).get("userId") or "system"
        _ed_now = datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")

        # Nested-field update — leaves the rest of the guest object intact.
        rooms_ref.document(room).update({
            "guest.mobile": mobile,
            "lastModifiedBy": _ed_user,
            "lastModifiedAt": _ed_now,
        })

        # Keep the draft stay/bill doc's guest_mobile in sync so checkout and
        # the generated invoice show the corrected number.
        _abid = room_data.get("active_bill_id")
        if _abid:
            try:
                bills_service.update(_abid, {"guest_mobile": mobile})
            except Exception as _e:
                logger.warning(
                    f"update_guest_mobile: failed to sync draft bill "
                    f"{_abid} for room {room}: {_e}"
                )

        invalidate_rooms_and_totals()

        logger.info(
            f"Guest mobile updated for room {room}: {old_mobile!r} -> {mobile!r}"
        )
        write_log(
            "room.guest_mobile_update",
            target_collection="rooms",
            target_id=str(room),
            metadata={"old_mobile": old_mobile, "new_mobile": mobile},
        )
        return jsonify(success=True, message="Mobile number updated.", mobile=mobile)
    except Exception as e:
        logger.error(f"Error updating guest mobile: {str(e)}", exc_info=True)
        return jsonify(success=False, message=f"Error updating guest mobile: {str(e)}"), 500


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
@requires_permission("discount.apply")
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
        _discount_payload = {
            "room": room, "name": room_data["guest"]["name"],
            "amount": amount, "method": "discount", "type": "discount",
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "time": datetime.now(IST).strftime("%H:%M"),
            "reason": reason, "transaction_type": "discount",
            "stay_room_key": f"{room}_{room_data.get('checkin_time', '')}",
        }
        _abid_disc = room_data.get("active_bill_id")
        if _abid_disc:
            payment_service.write_payment_with_stay(_abid_disc, _discount_payload)
        else:
            payment_service.write_payment(_discount_payload)

        logger.info(f"Discount of ₹{amount} applied to room {room}, reason: {reason}")

        write_log("discount.apply", target_collection="rooms", target_id=str(room),
                  metadata={"amount": amount, "reason": reason})
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

        # ── Same-category guard ──────────────────────────────────────────────
        # A transfer must stay within the same rate-slab category so the stay's
        # billing doesn't change mid-stay. Cross-category moves (genuine
        # upgrade/downgrade) are a different operation and are blocked here as
        # defense-in-depth behind the filtered dropdown in shift.js.
        _old_cat = room_category(old_room)
        _new_cat = room_category(new_room)
        if _old_cat != _new_cat:
            return jsonify(
                success=False,
                message=(
                    f"Transfer not allowed: Room {old_room} ({_old_cat}) and "
                    f"Room {new_room} ({_new_cat}) are different categories. "
                    "Transfers are only permitted within the same category."
                ),
            ), 400

        guest_name = rooms_dict[old_room]["guest"]["name"]
        guest_mobile = rooms_dict[old_room]["guest"]["mobile"]
        checkin_time = rooms_dict[old_room]["checkin_time"]

        new_room_data = rooms_dict[old_room].copy()

        # ── Snapshot pre-transfer charges before changing price ──────────────────
        # Use 24-HOUR CYCLES (from actual check-in time), not calendar dates.
        # Business rule: rent is per 24-hr window starting at check-in time.
        # A guest who checks in at 10 PM and transfers at 10 AM the next calendar
        # day has only completed ~12 hours — 0 full cycles → 0 days in old room.
        # Calendar-date subtraction would wrongly give 1 day across midnight.
        old_price        = new_room_data["guest"].get("price", 0)
        existing_offset  = new_room_data["guest"].get("transfer_day_offset", 0)

        _checkin_str  = new_room_data.get("checkin_time", "")
        _transfer_now = datetime.now(IST).replace(tzinfo=None)
        try:
            _checkin_dt = datetime.strptime(_checkin_str[:16], "%Y-%m-%d %H:%M")
        except (ValueError, TypeError):
            _checkin_dt = _transfer_now

        # Completed 24-hr billing cycles since original check-in
        _hours_elapsed    = (_transfer_now - _checkin_dt).total_seconds() / 3600
        _completed_cycles = int(_hours_elapsed / 24)
        # Days in THIS (old) room = completed cycles − days already captured
        old_days = max(0, _completed_cycles - existing_offset)

        existing_pre_transfer = list(new_room_data["guest"].get("pre_transfer_charges", []) or [])
        if old_days > 0:
            existing_pre_transfer.append({
                "days":      old_days,
                "price":     old_price,
                "total":     old_price * old_days,
                "from_room": old_room,
            })
        new_room_data["guest"]["pre_transfer_charges"] = existing_pre_transfer
        # Advance the offset by the days just recorded
        new_room_data["guest"]["transfer_day_offset"] = existing_offset + old_days
        # Store the transfer date so checkout can compute current-room days by date
        new_room_data["guest"]["last_transfer_date"] = _transfer_now.strftime("%Y-%m-%d")
        # renewal_count carries over unchanged — still used for non-transfer stays
        # ────────────────────────────────────────────────────────────────────────

        # ── A transfer NEVER re-rates the stay ──────────────────────────────────
        # Policy: shifting changes only the physical room, never the tariff. The
        # guest's existing price carries over unchanged (new_room_data is a copy
        # of the old room, so guest["price"] is already correct), so there is no
        # price difference and the room balance is never adjusted on transfer.
        # Same-category enforcement above guarantees the destination is on the
        # same rate slab anyway. Any client-supplied new_price / is_ac is
        # intentionally ignored — the server is authoritative here.
        balance_adjustment = 0

        # isAC carries over unchanged. Defensive only: if the destination is
        # somehow not AC-capable (cannot happen under same-category, since AC
        # lives within the "premium" category), drop a stale AC flag so the
        # room card doesn't show a phantom AC indicator.
        try:
            _new_room_num = int(new_room)
        except (TypeError, ValueError):
            _new_room_num = -1
        if not (200 <= _new_room_num <= 206):
            new_room_data["guest"]["isAC"] = False

        batch = db.batch()

        batch.set(rooms_ref.document(new_room), new_room_data)

        current_checkin_time = datetime.strptime(checkin_time, "%Y-%m-%d %H:%M")

        batch.update(rooms_ref.document(old_room), {
            "status": "cleaning",
            "guest": None,
            "checkin_time": None,
            "balance": 0,
            "add_ons": [],
            "discounts": [],
            "renewal_count": 0,
            "last_renewal_time": None,
            # Stay continues in the new room — release the pointer here.
            "active_bill_id": None,
            "cleaning_status": "in_progress",
            "cleaning_start_time": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")
        })

        # The draft bill doc stays in place, but its `room` field needs to
        # update from old_room to new_room so any future query by room
        # finds the right doc. The stay_id (doc ID) does not change — same
        # stay, new physical room.
        _stay_id_for_transfer = new_room_data.get("active_bill_id")
        if _stay_id_for_transfer:
            batch.update(bills_ref.document(_stay_id_for_transfer), {
                "room": str(new_room),
                "updated_at": datetime.now(IST).isoformat(),
            })

        batch.commit()
        # Use invalidate_rooms_and_totals (the monkey-patched version below)
        # so the 30-second /get_data payload cache is also busted. The plain
        # invalidate_cache() only clears the @cached function-level cache and
        # leaves _GET_DATA_CACHE serving the pre-transfer snapshot — which
        # surfaces as "the destination room still shows vacant" until the TTL
        # expires.
        invalidate_rooms_and_totals()

        # --- Update payments collection ---
        payment_service.update_payments_room(
            old_room, new_room, guest_name, current_checkin_time
        )
        # Write the shift log entry to payments
        _shift_payload = {
            "room": new_room, "name": guest_name, "amount": 0,
            "method": "none", "type": "room_shift",
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "time": datetime.now(IST).strftime("%H:%M"),
            "old_room": old_room, "transaction_type": "room_shift",
            "stay_room_key": f"{new_room}_{checkin_time}",
            "mobile": guest_mobile,
        }
        if _stay_id_for_transfer:
            payment_service.write_payment_with_stay(_stay_id_for_transfer, _shift_payload)
        else:
            payment_service.write_payment(_shift_payload)

        logger.info(f"Guest {guest_name} transferred from Room {old_room} to Room {new_room}")

        write_log(
            "room.transfer",
            target_collection="rooms",
            target_id=str(new_room),
            metadata={
                "from_room": str(old_room),
                "to_room": str(new_room),
                "guest": guest_name,
                "balance_adjustment": balance_adjustment,
            },
        )
        return jsonify(
            success=True,
            message=f"Guest transferred successfully from Room {old_room} to Room {new_room}.",
            balance_adjustment=balance_adjustment,
        )

    except Exception as e:
        logger.error(f"Error transferring room: {str(e)}", exc_info=True)
        return jsonify(success=False, message=f"Error transferring room: {str(e)}")

# ─── Two-stage cleaning workflow ────────────────────────────────────────────
# Stage 1: housekeeping marks the room as "cleaned" (cleaning_status moves
#          from "in_progress" → "ready_to_inspect"). The room stays in
#          status="cleaning" — it is NOT yet bookable.
#
# Stage 2: admin / manager inspects and marks "ready for check-in"
#          (cleaning_status → null, status → "vacant"). All guest-related
#          fields are cleared at this point.
#
# Admin / manager can also call stage 2 directly on a room that's still in
# "in_progress" — useful when a guest checks out and the front desk staff
# wants to skip the housekeeping verification step.

@rooms_bp.route("/mark_room_cleaned", methods=["POST"])
@requires_permission("room.cleaning.complete")
def mark_room_cleaned():
    """Stage 1 — mark the room as cleaned and awaiting inspection.

    Allowed roles: housekeeping, manager, admin (anyone with
    room.cleaning.complete). The room stays in status="cleaning" until
    an admin / manager approves it via /mark_room_ready_for_checkin.
    """
    try:
        data_json = request.json
        room = data_json["room"]

        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found")

        room_data = room_doc.to_dict()

        # Must be in cleaning status. If it's already ready_to_inspect we
        # treat it as a no-op (idempotent — rapid double-tap won't error).
        if room_data.get("status") != "cleaning":
            return jsonify(success=False, message="This room is not in cleaning status")

        if room_data.get("cleaning_status") == "ready_to_inspect":
            return jsonify(
                success=True,
                message=f"Room {room} is already awaiting inspection",
                cleaning_status="ready_to_inspect",
            )

        _hk_user = (_safe_user() or {}).get("userId") or "system"
        _hk_now = datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")
        rooms_ref.document(room).update({
            # status stays "cleaning" — the room is NOT bookable yet.
            "cleaning_status": "ready_to_inspect",
            "cleaning_done_at": _hk_now,
            # Attribution — who marked it cleaned
            "cleanedBy":         _hk_user,
            "cleanedAt":         _hk_now,
            "lastModifiedBy":    _hk_user,
            "lastModifiedAt":    _hk_now,
        })

        invalidate_rooms_and_totals()

        logger.info(f"Room {room} marked as cleaned (awaiting inspection)")
        write_log(
            "room.cleaning.complete",
            target_collection="rooms",
            target_id=str(room),
            metadata={"new_state": "ready_to_inspect"},
        )
        return jsonify(
            success=True,
            message=f"Room {room} cleaned. Awaiting inspection.",
            cleaning_status="ready_to_inspect",
        )

    except Exception as e:
        logger.error(f"Error marking room as cleaned: {str(e)}")
        return jsonify(success=False, message=f"Error marking room as cleaned: {str(e)}")


@rooms_bp.route("/mark_room_ready_for_checkin", methods=["POST"])
@requires_permission("room.inspection.approve")
def mark_room_ready_for_checkin():
    """Stage 2 — inspector approves the room and clears it for the next guest.

    Allowed roles: admin, manager (room.inspection.approve).
    Allowed to be called from EITHER state ("in_progress" or
    "ready_to_inspect") so admin / manager can skip stage 1 if needed.

    Optional body fields (captured in audit log metadata):
        checklist          : dict of {item_key: bool}  — QC items ticked
        checklist_skipped  : bool                       — inspector chose to skip
        notes              : str                        — free-form notes
    """
    try:
        data_json = request.json or {}
        room = data_json["room"]
        qc_checklist = data_json.get("checklist") or {}
        qc_skipped = bool(data_json.get("checklist_skipped"))
        qc_notes = (data_json.get("notes") or "").strip()

        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found")

        room_data = room_doc.to_dict()
        prev_state = room_data.get("cleaning_status")

        if room_data.get("status") != "cleaning":
            return jsonify(success=False, message="This room is not in cleaning status")

        # Vacate + clear all guest-related fields. Same shape as the old
        # mark_room_cleaned final write, with the cleaning workflow fields
        # also cleared.
        _insp_user = (_safe_user() or {}).get("userId") or "system"
        _insp_now = datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")
        rooms_ref.document(room).update({
            "status": "vacant",
            "cleaning_status": None,
            "cleaning_start_time": None,
            "cleaning_done_at": None,
            "inspected_at": _insp_now,
            "guest": None,
            "checkin_time": None,
            "balance": 0,
            "add_ons": [],
            "discounts": [],
            "renewal_count": 0,
            "last_renewal_time": None,
            "last_renewal_date": None,
            # Clear revert-window pointers — once the room is approved
            # and ready for the next guest, the previous checkout is no
            # longer eligible for undo.
            "last_bill_id":     None,
            "last_checkout_at": None,
            # Attribution — who approved the room ready for the next guest
            "inspectedBy":       _insp_user,
            "inspectedAt":       _insp_now,
            "lastModifiedBy":    _insp_user,
            "lastModifiedAt":    _insp_now,
        })

        invalidate_rooms_and_totals()

        skipped_inspection = (prev_state == "in_progress")
        logger.info(
            f"Room {room} approved ready for check-in "
            f"(previous_state={prev_state}, skipped_inspection={skipped_inspection})"
        )
        write_log(
            "room.inspection.approve",
            target_collection="rooms",
            target_id=str(room),
            metadata={
                "previous_state": prev_state,
                "skipped_housekeeping": skipped_inspection,
                # Quality-check details captured for the audit trail.
                # checklist is a flat {item_key: bool} dict.
                "checklist": qc_checklist if isinstance(qc_checklist, dict) else {},
                "checklist_skipped": qc_skipped,
                "notes": qc_notes,
            },
        )
        return jsonify(
            success=True,
            message=f"Room {room} is ready for the next check-in",
        )

    except Exception as e:
        logger.error(f"Error approving room: {str(e)}")
        return jsonify(success=False, message=f"Error approving room: {str(e)}")

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

# ── /get_data 30-second in-memory cache ─────────────────────────────────────
# Serves multiple rapid page loads / background debounce calls from cache.
# Invalidated by invalidate_rooms_and_totals() (called on every write).
_GET_DATA_CACHE: dict = {"payload": None, "ts": 0.0}
_GET_DATA_TTL = 30  # seconds

def _invalidate_get_data_cache():
    _GET_DATA_CACHE["payload"] = None
    _GET_DATA_CACHE["ts"] = 0.0

# Monkey-patch invalidate_rooms_and_totals so writes bust this cache too
_orig_invalidate = invalidate_rooms_and_totals
def invalidate_rooms_and_totals():   # noqa: F811
    _invalidate_get_data_cache()
    return _orig_invalidate()
# ─────────────────────────────────────────────────────────────────────────────

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
        from concurrent.futures import ThreadPoolExecutor
        t0 = _time.time()

        # Serve from cache if fresh
        if _GET_DATA_CACHE["payload"] and (_time.time() - _GET_DATA_CACHE["ts"] < _GET_DATA_TTL):
            logger.info("[PERF] /get_data served from cache")
            return _GET_DATA_CACHE["payload"]

        today = datetime.now(IST)
        today_str   = today.strftime("%Y-%m-%d")
        tomorrow    = (today + timedelta(days=1)).strftime("%Y-%m-%d")

        # Fix 4: fetch only TODAY's payments instead of 3 days back.
        # Transaction-tab modules (register.js, bills.js) lazy-load their own
        # data when the tab is opened.  The only live use of `logs` on the rooms
        # tab is the renewal-history badge, which is covered by today's renewals.
        # Totals are accurate from the `totals` collection regardless of date range.
        # Run all 4 Firestore queries in parallel (rooms, totals, payments, expenses)
        with ThreadPoolExecutor(max_workers=4) as pool:
            f_rooms    = pool.submit(get_all_rooms)
            f_totals   = pool.submit(get_totals)
            f_payments = pool.submit(
                payment_service.query_payments_by_date_range,
                today_str, tomorrow
            )
            f_expenses = pool.submit(
                expense_service.query_expenses_for_today,
                today_str
            )

        rooms = f_rooms.result()
        totals = f_totals.result()
        recent_payments = f_payments.result() or []
        expense_logs    = f_expenses.result() or []
        t1 = _time.time()
        logger.info(f"[PERF] parallel fetch (rooms+totals+payments+expenses): {t1-t0:.3f}s, "
                    f"{len(recent_payments)} payment docs, {len(expense_logs)} expense docs")

        _refund_types = ("refund", "checkout_refund", "manual_refund",
                         "booking_cancel_refund")

        # Build logs in the shape the frontend expects.
        #   - "pay_later"   → settle-later check-ins (₹0 cash row).
        #   - "already_paid" → booking conversions where the advance covered
        #     the full amount; the conversion still represents a real check-in
        #     event with a serial number, and staff expect to see it in
        #     today's transactions even though no cash/online was tendered at
        #     the conversion moment. Without this, fully-prepaid bookings
        #     disappear from the transaction log on the conversion date.
        _cash_methods = ("cash", "pay_later", "already_paid")
        cash_logs = [p for p in recent_payments
                     if p.get("method") in _cash_methods
                     and p.get("type") not in _refund_types
                     and p.get("type") not in ("expense", "discount")]
        online_logs = [p for p in recent_payments
                       if p.get("method") == "online"
                       and p.get("type") not in _refund_types
                       and p.get("type") not in ("expense", "discount")]
        refund_logs = [p for p in recent_payments
                       if p.get("type") in _refund_types]
        # Settle-later checkouts — written at checkout when the guest
        # leaves with the balance deferred to a pending settlement.
        # Surfaced in the Transactions tab (SETTLE LATER tag); kept out
        # of the cash/online/refund buckets so day totals stay correct.
        settlement_logs = [p for p in recent_payments
                           if p.get("type") == "settlement"]
        # expense_logs already fetched from expenses collection above

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
            "settlements": settlement_logs,
            "renewals": renewals_for_frontend,
            "booking_payments": [],
            "discounts": [],
            "expenses": expense_logs,
            "room_shifts": [],
        }

        t4 = _time.time()
        logger.info(f"[PERF] /get_data TOTAL: {t4-t0:.3f}s")
        response = jsonify(rooms=rooms, logs=logs, totals=totals)

        # Store in cache for next 30 seconds
        _GET_DATA_CACHE["payload"] = response
        _GET_DATA_CACHE["ts"] = _time.time()

        return response
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

        # Prefer checkin_time sent by the frontend (already in local state)
        # to avoid an extra Firestore room-doc read.
        checkin_dt = None
        ct = data_json.get("checkin_time")
        if ct:
            try:
                checkin_dt = datetime.strptime(ct, "%Y-%m-%d %H:%M")
            except ValueError:
                pass

        # Fallback: fetch from Firestore only if frontend didn't send it
        if not checkin_dt:
            room_doc = rooms_ref.document(room).get()
            if room_doc.exists:
                ct = room_doc.to_dict().get("checkin_time")
                if ct:
                    try:
                        checkin_dt = datetime.strptime(ct, "%Y-%m-%d %H:%M")
                    except ValueError:
                        pass

        # Resolve the canonical stay_id (active_bill_id on the room doc)
        # so query_payments_for_stay can fire its Q0 single-field equality
        # query — the fast path that returns the full set in one query.
        #
        # Order of preference:
        #   1. Body field — frontend already has it from rooms[roomNumber]
        #      and sending it eliminates a Firestore room-doc fetch.
        #   2. Already-fetched room_doc — re-use if we read it above.
        #   3. New room-doc fetch — only as a last resort.
        stay_id = (data_json.get("stay_id") or "").strip() or None
        if not stay_id:
            try:
                if "room_doc" in locals() and room_doc and room_doc.exists:
                    stay_id = (room_doc.to_dict() or {}).get("active_bill_id")
                else:
                    _rd = rooms_ref.document(str(room)).get()
                    if _rd.exists:
                        stay_id = (_rd.to_dict() or {}).get("active_bill_id")
            except Exception as _e:
                logger.warning(f"get_history: stay_id lookup failed: {_e}")

        # Fast path: payments collection
        if checkin_dt:
            payments = payment_service.query_payments_for_stay(
                room, guest_name, checkin_dt, stay_id=stay_id
            )
        else:
            # No checkin time — query last 30 days for this room+guest
            thirty_ago = (datetime.now(IST) - timedelta(days=30)).strftime("%Y-%m-%d")
            payments = payment_service.query_payments_by_date_range(thirty_ago, "9999-99-99")
            payments = [p for p in payments
                        if p.get("room") == str(room) and p.get("name") == guest_name]

        payments = payments or []

        # If any room shifts exist, also fetch payments still on the old room.
        # This handles the race condition where the background migration thread
        # (update_payments_room) hasn't finished updating room numbers yet.
        shift_entries = [p for p in payments if p.get("type") == "room_shift"]
        fetched_old_rooms = set()
        for shift in shift_entries:
            old_room_num = shift.get("old_room")
            if old_room_num and old_room_num not in fetched_old_rooms:
                fetched_old_rooms.add(old_room_num)
                try:
                    if checkin_dt:
                        old_pmts = payment_service.query_payments_for_stay(
                            old_room_num, guest_name, checkin_dt
                        ) or []
                    else:
                        old_pmts = []
                    # Only include payments still tagged with the old room
                    # (already-migrated ones are already in `payments`)
                    for p in old_pmts:
                        if p.get("room") == str(old_room_num):
                            payments.append(p)
                except Exception as e:
                    logger.warning(f"Could not fetch old room {old_room_num} payments: {e}")

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
    """
    Returns today's serial-number counter only.
    - daily_counters: single-doc read for today's date (was: full collection stream)
    - transaction_metadata: deprecated, always returns {} (was: full collection stream, never used by frontend)
    """
    try:
        today = datetime.now(IST).strftime("%Y-%m-%d")
        today_doc = counters_ref.document(today).get()
        today_count = today_doc.to_dict().get("count", 0) if today_doc.exists else 0

        return jsonify(
            success=True,
            daily_counters={today: today_count},
            transaction_metadata={}   # deprecated — no longer streamed
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


# ── DEPRECATED: manager password helper ───────────────────────────────────────
# Kept only for the few routes still being migrated. New code MUST use
# @requires_permission("...") from services.auth_service. This stub will be
# deleted once all callers are converted (see the audit log in the PR).
def _check_manager_password(provided: str) -> bool:  # pragma: no cover
    """DEPRECATED — always returns False. Auth has moved to RBAC.
    Any route still calling this is a bug; convert it to @requires_permission."""
    logger.warning("_check_manager_password called (deprecated) — denying")
    return False


# ── Transaction logs for an arbitrary date range ──────────────────────────────
# Admin: any date range. Manager / housekeeping: clamped to last 3 days
# (enforced server-side via clamp_date_range — frontend cannot widen it).
@rooms_bp.route("/get_transactions_range", methods=["POST"])
def get_transactions_range():
    """
    Return transaction logs for a date range.
    Body: { from_date: "YYYY-MM-DD", to_date: "YYYY-MM-DD" }
    Returns logs in the same shape as get_data's logs object.

    Auth: any authenticated user. Admin gets the requested range; others
    are silently clamped to the last 3 days.
    """
    from services.role_filters import clamp_date_range
    try:
        data = request.json or {}
        from_date = data.get("from_date")
        to_date   = data.get("to_date")
        if not from_date or not to_date:
            return jsonify(success=False, message="from_date and to_date required"), 400

        # ── RBAC: clamp to last 3 days for non-admin users ────────────────────
        from_date, to_date = clamp_date_range(from_date, to_date)

        # end_date is exclusive in the query, so add 1 day
        from datetime import datetime as _dt, timedelta as _td
        end_exclusive = (_dt.strptime(to_date, "%Y-%m-%d") + _td(days=1)).strftime("%Y-%m-%d")

        payments = payment_service.query_payments_by_date_range(from_date, end_exclusive) or []
        # Expenses from dedicated collection
        all_expenses = expense_service.query_expenses_by_date_range(from_date, end_exclusive) or []

        _refund_types = ("refund", "checkout_refund", "manual_refund", "booking_cancel_refund")
        _hidden_types = ("expense", "discount")

        # `already_paid` is written by /convert_booking_to_checkin when the
        # booking's advance covered the full amount, so no cash/online was
        # tendered at conversion time. The record still represents a real
        # check-in event (with a serial number) that staff expect to see in
        # the day's transactions list — without it, fully-prepaid bookings
        # vanish from the transactions tab the moment they convert. Treat
        # those rows like the existing zero-tender `pay_later` rows: cash
        # bucket, ₹0 amount, BOOKING tag rendered by the frontend.
        _cash_methods = ("cash", "pay_later", "already_paid")

        logs = {
            "cash":     [p for p in payments if p.get("method") in _cash_methods
                         and p.get("type") not in _refund_types
                         and p.get("type") not in _hidden_types],
            "online":   [p for p in payments if p.get("method") == "online"
                         and p.get("type") not in _refund_types
                         and p.get("type") not in _hidden_types],
            "refunds":  [p for p in payments if p.get("type") in _refund_types],
            # Settle-later checkouts — guest left with the balance
            # deferred. Shown in the Transactions tab with a SETTLE LATER
            # tag; a separate bucket so totals are not distorted.
            # Also includes OTA bank settlements (type="bank_settlement",
            # written by /mark_ota_settlement) so the MMT payout actually
            # appears in the Transactions tab. These are bank receipts, not
            # drawer cash/online, so the settlements bucket (excluded from the
            # cash/online analytics totals) is the right home for them.
            "settlements": [p for p in payments
                            if p.get("type") in ("settlement", "bank_settlement")],
            # All expenses (daily + report). The Transactions tab filters
            # by expense_type client-side via the admin Daily/Report
            # sub-filter; non-admins still see daily expenses only.
            "expenses": all_expenses,
        }
        return jsonify(success=True, logs=logs)
    except Exception as e:
        logger.error(f"get_transactions_range error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


# ── DEPRECATED password-verify endpoint ───────────────────────────────────────
# Returns 410 Gone so any cached frontend that still POSTs here gets a clear
# signal to reload. Auth flows now use Firebase ID tokens (see /login).
@rooms_bp.route("/verify_manager_password", methods=["POST"])
def verify_manager_password():
    return (
        jsonify(
            success=False,
            deprecated=True,
            message="Manager password auth has been replaced by user login.",
            redirect="/login",
        ),
        410,
    )


# ══════════════════════════════════════════════════════════════════════════════
# STAY PAYMENTS — view & edit payment records for a specific stay
# ══════════════════════════════════════════════════════════════════════════════

@rooms_bp.route("/get_stay_payments", methods=["POST"])
@requires_permission("payment.edit")
def get_stay_payments():
    """
    Return all payment documents for a specific stay.

    Body: {
        stay_id: str,        -- canonical foreign key (UUID4 for new stays,
                                {room}_{ts} for legacy bills, may also be
                                an active_bill_id from the room doc).
                                Preferred when present.
        room: str,
        guest_name: str,
        checkin_time: str    -- "YYYY-MM-DD HH:MM"
    }

    Phase-6 lookup: when `stay_id` is provided, the canonical query
    `payments where stay_id == X` runs first. The legacy heuristics (Q1
    by room+name+date, Q2 by stay_room_key) still run as a safety net so
    pre-migration payments and booking advances written before stamping
    are still found.

    Returns each doc with its Firestore document ID so the frontend can
    address individual records for editing.

    Excludes expense and discount records (those are not guest payments).
    """
    try:
        data = request.json or {}
        stay_id      = (data.get("stay_id") or "").strip()
        room         = str(data.get("room", "")).strip()
        guest_name   = data.get("guest_name", "").strip()
        checkin_time = data.get("checkin_time", "").strip()

        # ── Auth: enforced by @requires_permission("payment.edit") ───────────

        # Either stay_id alone or the legacy (room, guest_name, checkin_time)
        # tuple is sufficient. The endpoint accepts both and combines results.
        if not stay_id and not (room and guest_name and checkin_time):
            return jsonify(
                success=False,
                message="stay_id OR (room, guest_name, checkin_time) is required"
            ), 400

        checkin_dt = None
        if checkin_time:
            try:
                checkin_dt = datetime.strptime(checkin_time, "%Y-%m-%d %H:%M")
            except ValueError:
                return jsonify(success=False,
                               message="checkin_time must be YYYY-MM-DD HH:MM"), 400

        # ── Multi-query approach — Q0 is the canonical Phase-6 lookup; ────────
        # Q1 + Q2 are legacy fallbacks for payments written before stamping
        # (or for booking advances paid pre-conversion).
        #
        # Filtering rules:
        #   - `_exclude_types`  : never relevant to a guest's payment record.
        #   - `_include_methods`: only entries where money actually moved
        #     (cash or online) are shown. "balance" / "pay_later" are
        #     accruals (rent owed) — they appear on the room balance but
        #     never as a payment the guest made. "discount", "settlement",
        #     "none", "bank_settlement" are status markers / internal,
        #     not money-in events from the guest.
        _exclude_types   = {"expense", "discount"}
        _include_methods = {"cash", "online"}
        _payments_col    = db.collection("payments")
        seen_ids = set()
        payments = []

        def _add_doc(doc):
            if doc.id in seen_ids:
                return
            d = doc.to_dict()
            if d.get("type") in _exclude_types:
                return
            if d.get("method") not in _include_methods:
                return
            seen_ids.add(doc.id)
            payments.append({
                "id":        doc.id,
                "amount":    d.get("amount", 0),
                "method":    d.get("method", ""),
                "type":      d.get("type", ""),
                "date":      d.get("date", ""),
                "time":      d.get("time", ""),
                "note":      d.get("note", ""),
                # Attribution — surfaces "added by" in the payment list UI
                "createdBy": d.get("createdBy", None),
            })

        # ─── Q0 fast path — canonical foreign key ────────────────────────
        # When stay_id is present, Q0 alone returns the full set via a
        # single-field equality query (~200–400ms). Q1/Q2 are legacy
        # safety nets — they only add value for stays that predate
        # stay_id stamping. If Q0 finds anything, return immediately;
        # the fallbacks would only contribute duplicates the dedup step
        # would drop anyway, while doubling the round-trips.
        q0_count = 0
        if stay_id:
            try:
                q0 = _payments_col.where(filter=FieldFilter("stay_id", "==", stay_id))
                for doc in q0.stream():
                    _add_doc(doc)
                    q0_count += 1
            except Exception as e:
                logger.warning(f"get_stay_payments Q0 failed: {e}")

            if q0_count:
                payments.sort(key=lambda p: (p.get("date", ""), p.get("time", "")))
                logger.info(
                    f"get_stay_payments(fast): stay_id={stay_id} → {len(payments)} (Q0={q0_count})"
                )
                return jsonify(success=True, payments=payments)

        # ─── Slow path: no stay_id, or Q0 returned nothing. Run the
        # legacy heuristics in parallel.
        def _q1():
            if not (checkin_dt and room and guest_name):
                return []
            try:
                cd = checkin_dt.strftime("%Y-%m-%d")
                q = (
                    _payments_col
                    .where(filter=FieldFilter("room", "==", room))
                    .where(filter=FieldFilter("date", ">=", cd))
                )
                return [d for d in q.stream() if d.to_dict().get("name") == guest_name]
            except Exception as e:
                logger.warning(f"get_stay_payments Q1 failed: {e}")
                return []

        def _q2():
            if not (checkin_dt and room):
                return []
            try:
                stay_key = f"{room}_{checkin_dt.strftime('%Y-%m-%d %H:%M')}"
                q = _payments_col.where(filter=FieldFilter("stay_room_key", "==", stay_key))
                return list(q.stream())
            except Exception as e:
                logger.warning(f"get_stay_payments Q2 failed: {e}")
                return []

        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=2) as pool:
            f1, f2 = pool.submit(_q1), pool.submit(_q2)
            for doc in f1.result():
                _add_doc(doc)
            for doc in f2.result():
                _add_doc(doc)

        payments.sort(key=lambda p: (p.get("date", ""), p.get("time", "")))

        logger.info(
            f"get_stay_payments: stay_id={stay_id or '-'} room={room or '-'} "
            f"guest={guest_name or '-'} → {len(payments)} records "
            f"(Q0={q0_count}, total={len(payments)})"
        )
        return jsonify(success=True, payments=payments)

    except Exception as e:
        logger.error(f"get_stay_payments error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {str(e)}"), 500


@rooms_bp.route("/update_stay_payment", methods=["POST"])
@requires_permission("payment.edit")
def update_stay_payment():
    """
    Edit the method, date, and/or amount of a single payment record.

    Body: {
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
        payment_id = data.get("payment_id", "").strip()
        new_method = data.get("method", "").strip().lower()
        new_date   = data.get("date", "").strip()
        new_time   = data.get("time", "").strip()
        new_amount_raw = data.get("amount")   # None means "not provided"

        # ── Auth: enforced by @requires_permission("payment.edit") ───────────

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

        # ── Banking integrity guards ──────────────────────────────────────────
        # These guards protect deposit and receipt-voucher integrity.
        # They block edits that would silently corrupt downstream Banking
        # state. The error message in each case tells the operator the
        # supported recovery path.

        # (a) If the payment is already bundled into a confirmed bank
        # deposit, refuse the edit — changing the row would alter the
        # gross/net of that deposit without the deposit knowing about
        # it.
        if old_data.get("cash_deposit_id"):
            return jsonify(
                success=False,
                code="DEPOSIT_LINKED",
                message=(
                    "Cannot edit: this payment is linked to bank "
                    f"deposit {old_data.get('cash_deposit_id')}. "
                    f"Reverse the deposit first (Banking → History → "
                    f"Reverse), then edit."
                ),
            ), 409

        # (b) If a receipt voucher has been issued for this payment AND
        # the method is changing (cash → online or vice versa), refuse.
        # Re-stamping a different receipt prefix on the same payment is
        # not a supported operation — the audit trail would lie. The
        # supported workflow is: refund this payment and record a fresh
        # one with the correct method.
        _old_receipt = old_data.get("receipt_no")
        _method_changing = (
            new_method and new_method != (old_method or "").lower()
        )
        if _method_changing and _old_receipt:
            return jsonify(
                success=False,
                code="RECEIPT_ISSUED",
                message=(
                    f"Cannot change method: receipt {_old_receipt} has "
                    f"already been issued for this payment. To correct "
                    f"the method, refund this payment and record a "
                    f"fresh one with the right method."
                ),
            ), 409

        # (c) If this payment is THE trigger that made the stay
        # invoiceable AND the method is changing away from online, the
        # stay's invoiceable state is no longer justified. Attempt to
        # un-trigger automatically. revert_trigger_if_safe will refuse
        # if any cash from this stay has already been deposited — in
        # which case the operator must reverse the deposit first.
        _stay_id = old_data.get("stay_id")
        if _method_changing and new_method != "online" and _stay_id:
            try:
                bill_snap = db.collection("bills").document(_stay_id).get()
                if bill_snap.exists:
                    bill = bill_snap.to_dict() or {}
                    if bill.get("invoiceable_trigger_payment_id") == payment_id:
                        from services.banking import cash_receipts as _bk_rc
                        from services.banking.cash_receipts import UnTriggerBlocked
                        try:
                            _bk_rc.revert_trigger_if_safe(
                                _stay_id,
                                reason="trigger_payment_method_change",
                            )
                        except UnTriggerBlocked as _bk_e:
                            return jsonify(
                                success=False,
                                code="TRIGGER_LOCKED",
                                message=(
                                    "Cannot change method: this is the "
                                    "online payment that made the stay "
                                    "invoiceable, and cash from the "
                                    "stay has already been deposited "
                                    f"(on {_bk_e.first_deposit_at}). "
                                    "Reverse that deposit first."
                                ),
                            ), 409
            except Exception as _bk_e:
                logger.warning(
                    f"update_stay_payment: trigger-payment-edit guard "
                    f"errored for {payment_id}: {_bk_e}"
                )

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
        write_log("payment.edit", target_collection="payments", target_id=payment_id,
                  metadata={"new_method": new_method or None, "new_date": new_date or None,
                            "new_amount": new_amount_raw})
        return jsonify(success=True, message="Payment updated successfully")

    except Exception as e:
        logger.error(f"update_stay_payment error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {str(e)}"), 500


# ─────────────────────────────────────────────────────────────────────────────
# Delete a single payment record
# ─────────────────────────────────────────────────────────────────────────────

@rooms_bp.route("/delete_stay_payment", methods=["POST"])
@requires_permission("payment.edit")
def delete_stay_payment():
    """
    Permanently delete a single payment record.

    Body: {
        payment_id: str   -- Firestore document ID in payments collection
    }
    Auth: admin role required (via @requires_permission).

    Side effects:
      - Removes the doc from the `payments` collection.
      - Reverses its contribution to `current_totals` (cash/online).
      - If room is still occupied: adds the deleted amount back to room balance
        (guest now owes that money again).
    """
    try:
        data = request.json or {}
        payment_id = data.get("payment_id", "").strip()

        # Auth handled by @requires_permission decorator

        if not payment_id:
            return jsonify(success=False, message="payment_id is required"), 400

        _payments_ref = db.collection("payments")
        pay_doc_ref   = _payments_ref.document(payment_id)
        pay_snap      = pay_doc_ref.get()

        if not pay_snap.exists:
            return jsonify(success=False, message="Payment record not found"), 404

        old_data   = pay_snap.to_dict()
        old_method = old_data.get("method", "")
        old_amount = int(old_data.get("amount", 0))
        room_id    = str(old_data.get("room", ""))

        # ── Banking integrity guard ──────────────────────────────────────
        # Refuse to delete a payment that's already been bundled into a
        # confirmed/reconciled bank deposit. Deleting it would silently
        # corrupt that deposit's gross/net totals — the deposit doc
        # would still claim it includes a ₹X cash row that no longer
        # exists. Force the operator to reverse the deposit first
        # (which unlinks the rows cleanly), then they can delete.
        _linked_deposit = old_data.get("cash_deposit_id")
        if _linked_deposit:
            return jsonify(
                success=False,
                code="DEPOSIT_LINKED",
                message=(
                    "Cannot delete: this payment is already linked to "
                    f"bank deposit {_linked_deposit}. Reverse that "
                    f"deposit first (Banking → History → Reverse), "
                    f"then delete."
                ),
            ), 409

        batch = db.batch()

        # 1. Delete the payment doc
        batch.delete(pay_doc_ref)

        # 2. Reverse contribution to current_totals (cash/online only)
        valid_total_methods = ("cash", "online")
        if old_method in valid_total_methods and old_amount > 0:
            totals_doc_ref = totals_ref.document("current_totals")
            batch.update(totals_doc_ref, {old_method: firestore.Increment(-old_amount)})

        # 3. If room is still occupied, add the amount back to balance
        #    (guest paid this, but we're removing the record → they owe it again)
        if room_id and old_amount > 0:
            room_snap = rooms_ref.document(room_id).get()
            if room_snap.exists and room_snap.to_dict().get("status") == "occupied":
                current_balance = int(room_snap.to_dict().get("balance", 0))
                new_balance = current_balance + old_amount
                batch.update(rooms_ref.document(room_id), {"balance": new_balance})
                logger.info(
                    f"delete_stay_payment: room {room_id} balance adjusted "
                    f"{current_balance} → {new_balance} (deleted amount {old_amount})"
                )

        batch.commit()
        invalidate_rooms_and_totals()

        logger.info(
            f"delete_stay_payment: id={payment_id} method={old_method} amount={old_amount}"
        )
        write_log("payment.delete", target_collection="payments", target_id=payment_id)
        return jsonify(success=True, message="Transaction deleted")

    except Exception as e:
        logger.error(f"delete_stay_payment error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {str(e)}"), 500


# ─────────────────────────────────────────────────────────────────────────────
# Housekeeping (mid-stay cleaning request) toggle
# ─────────────────────────────────────────────────────────────────────────────

@rooms_bp.route("/toggle_housekeeping", methods=["POST"])
def toggle_housekeeping():
    """
    Toggle mid-stay housekeeping request for a room.
    Sets service_cleaning.room and/or service_cleaning.bathroom flags.

    Body: { room: str, room_clean: bool, bathroom_clean: bool }
    """
    try:
        data = request.json or {}
        room = data.get("room", "")
        if not room:
            return jsonify(success=False, message="room is required"), 400

        room_clean     = bool(data.get("room_clean", False))
        bathroom_clean = bool(data.get("bathroom_clean", False))

        room_doc = rooms_ref.document(str(room)).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found"), 404

        update = {
            "service_cleaning": {
                "room":     room_clean,
                "bathroom": bathroom_clean,
                "requested_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
            }
        }
        rooms_ref.document(str(room)).update(update)
        invalidate_rooms_and_totals()
        return jsonify(success=True, message="Housekeeping flags updated")
    except Exception as e:
        logger.error(f"toggle_housekeeping error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {e}"), 500
