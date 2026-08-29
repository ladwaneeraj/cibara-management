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
    store_transaction_metadata, create_bill_record, BillCreationError,
    allocate_and_finalize_bill,
    find_serial_number_for_checkin, _build_active_entry_fast, _find_serial_fast,
    _batch_fill_serials, room_category, room_base_price, AC_SURCHARGE,
    OTA_PREPAID_SOURCES,
    validate_gstin, derive_state_from_gstin,
    snap_to_exempt_band, EXEMPT_BAND_TARGET,
)
from services import payment_service, customer_service, expense_service, bills_service
from services import system_alerts
from services.gst_lock_service import is_month_locked
from services.auth_service import requires_permission, login_required
from services.audit_log import write_log, attribution_create, attribution_update, _safe_user
from services import stay_timeline
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
            # One casing standard at the source: the room doc, the draft
            # stay, the bill, and the customer record all inherit this name,
            # so normalizing here keeps every surface consistent (the
            # customer upsert applies the same function independently).
            "name": customer_service.standardize_name(data_json["name"]),
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

        # ── Company billing (GST) chosen on the CHECK-IN form ────────────────
        # A returning B2B guest's saved GST details are OFFERED at check-in
        # (customer-docs.js shows the card only when a stored profile exists).
        # The operator's explicit "bill to this company" answer arrives here
        # and is stamped on the room doc; create_bill_record already reads
        # `gst_profile` from the room, and the checkout modal's Company
        # billing card pre-selects "Applied" from this stamp — the operator
        # confirms (or flips to Personal) at checkout, so the check-in answer
        # is a default, never a silent commitment.
        #
        # Re-validated rather than trusted, exactly like the /checkout path:
        # this is client input destined for a tax invoice. Absent or invalid
        # → None, which preserves the original poisoning guard (a profile
        # left behind by an earlier occupant must never survive a check-in).
        _gst_in = data_json.get("gst_profile")
        _stay_gst = None
        if isinstance(_gst_in, dict):
            try:
                _g = str(_gst_in.get("gstin") or "").strip().upper()
                if validate_gstin(_g):
                    _sn_gst, _sc_gst = derive_state_from_gstin(_g)
                    _stay_gst = {
                        "gstin":      _g,
                        "legal_name": str(_gst_in.get("legal_name") or "").strip(),
                        "trade_name": str(_gst_in.get("trade_name") or "").strip(),
                        "address":    str(_gst_in.get("address") or "").strip(),
                        "state":      str(_gst_in.get("state") or "").strip() or _sn_gst,
                        "state_code": str(_gst_in.get("state_code") or "").strip() or _sc_gst,
                        "source":     "checkin",
                    }
                else:
                    logger.warning(
                        f"/checkin room {room}: gst_profile GSTIN {_g!r} "
                        f"failed validation — stay stays B2C"
                    )
            except Exception as _ge:
                logger.warning(f"/checkin room {room}: gst_profile parse "
                               f"failed, ignoring: {_ge}")
        if _stay_gst:
            # Explicit trail: pairs with create_bill_record's "applying
            # stay-level GST profile" line at checkout. If THIS line is
            # missing after a check-in that selected Company, the answer
            # never left the browser; if this prints but checkout's line
            # doesn't, the stamp was lost in between.
            logger.info(f"/checkin room {room}: company billing stamped on "
                        f"stay (GSTIN={_stay_gst['gstin']})")

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
                # Company billing: the operator's answer from the check-in
                # form's GST card (validated above), or None. ALWAYS written,
                # deliberately: the room document outlives the stay, and a
                # profile left behind by an earlier occupant would otherwise
                # be picked up by create_bill_record and put somebody else's
                # GSTIN on this guest's invoice. The checkout modal offers a
                # final confirm/flip before the invoice is actually made.
                "gst_profile": _stay_gst,
                # Pointer to the draft stay doc so /checkout can finalize
                # the existing record instead of creating a new bill.
                "active_bill_id": stay_id,
                # Denormalized per-stay receipt sums (register fast path).
                # Seeded here so the register is correct immediately;
                # payment_service.refresh_room_stay_aggregates re-stamps
                # after every subsequent payment write for this stay.
                "stay_payment_cash": amount_paid if payment == "cash" else 0,
                "stay_payment_online": amount_paid if payment == "online" else 0,
                "stay_payment_for": stay_id,
                "stay_payment_synced_at": None,
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
                # Per-stay event timeline. Seeded from whatever prep records
                # the room already carries (the cleaning and inspection that
                # readied it for THIS guest) plus this check-in. Everything
                # older was cleared when the previous guest checked out, so
                # nothing from that stay can leak in. See services/stay_timeline.
                "stay_timeline": stay_timeline.merge(
                    stay_timeline.prep_only(stay_timeline.read(snap.to_dict())),
                    [stay_timeline.make_event("room.checkin", room,
                                              at=_attr.get("createdAt"))],
                ),
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

        # Customer upsert runs fire-and-forget. The original "Fix 7" concern
        # (errors silently swallowed in a daemon thread) no longer applies:
        # customer_service._upsert() logs every failure via logger.error, so
        # errors stay visible in the logs. Running it sync here had a worse
        # failure mode — an upsert error AFTER the room was already claimed
        # returned "check-in failed" for a check-in that had in fact
        # succeeded — and it added 2–3 Firestore round-trips to every
        # check-in response. The customer record is non-critical to the stay.
        customer_service.upsert_customer({
            "name": guest["name"],
            "mobile": data_json.get("mobile", ""),
            "id_type": data_json.get("id_type", ""),
            "id_number": data_json.get("id_number", ""),
            "address": data_json.get("address", ""),
            "photo": data_json.get("photo_path", ""),
        }, amount_paid=amount_paid, sync=False)

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

        # ── Company billing (GST) chosen in the checkout modal ────────────────
        # The operator answers "bill to this company?" at checkout, and the
        # answer arrives here. Written onto the in-memory room_data because
        # create_bill_record already reads `gst_profile` from there — the same
        # slot a booking-seeded GSTIN would use — so nothing downstream needs
        # to know where the answer came from.
        #
        # Re-validated rather than trusted. This is client input and it ends
        # up on a tax invoice; a malformed GSTIN in GSTR-1 is a filing error.
        # Note the room_data above may be client-supplied too, which is why an
        # ABSENT gst_profile here explicitly clears the field instead of
        # leaving whatever the client sent.
        # The answer is a TRI-STATE, and the server is authoritative:
        #   * dict        → operator chose "Bill to this company" at checkout
        #                   (or the card was pre-applied from check-in) —
        #                   validate and use it.
        #   * "personal"  → operator EXPLICITLY tapped Personal at checkout —
        #                   clear any check-in stamp.
        #   * null/absent → the browser has no explicit answer (older client,
        #                   or its card state was lost between modal-open and
        #                   POST). Fall back to the profile /checkin stamped
        #                   on the LIVE room doc — never the client's copy.
        #                   This is safe against the previous-occupant
        #                   poisoning hazard because /checkin ALWAYS writes
        #                   the field (a fresh validated profile or None).
        _gst_in = data_json.get("gst_profile")
        _stay_gst = None
        if isinstance(_gst_in, dict):
            try:
                _g = str(_gst_in.get("gstin") or "").strip().upper()
                if validate_gstin(_g):
                    _sn, _sc = derive_state_from_gstin(_g)
                    _stay_gst = {
                        "gstin":      _g,
                        "legal_name": str(_gst_in.get("legal_name") or "").strip(),
                        "trade_name": str(_gst_in.get("trade_name") or "").strip(),
                        "address":    str(_gst_in.get("address") or "").strip(),
                        "state":      str(_gst_in.get("state") or "").strip() or _sn or "Karnataka",
                        "state_code": str(_gst_in.get("state_code") or "").strip() or _sc or "29",
                    }
                elif _g:
                    logger.warning(f"checkout: GSTIN {_g!r} for room {room} failed "
                                   f"validation — bill stays B2C")
            except Exception as _gst_err:
                logger.warning(f"checkout: gst_profile parse failed for room "
                               f"{room}, ignoring: {_gst_err}")
        elif _gst_in == "personal":
            logger.info(f"checkout room {room}: operator chose Personal — "
                        f"any check-in company stamp is cleared")
        else:
            # No explicit answer — read the check-in stamp from the LIVE doc.
            try:
                _live = rooms_ref.document(room).get()
                _stamp = ((_live.to_dict() or {}).get("gst_profile")
                          if _live.exists else None) or {}
                _g = str(_stamp.get("gstin") or "").strip().upper()
                if validate_gstin(_g):
                    _stay_gst = {
                        "gstin":      _g,
                        "legal_name": str(_stamp.get("legal_name") or "").strip(),
                        "trade_name": str(_stamp.get("trade_name") or "").strip(),
                        "address":    str(_stamp.get("address") or "").strip(),
                        "state":      str(_stamp.get("state") or "").strip() or "Karnataka",
                        "state_code": str(_stamp.get("state_code") or "").strip() or "29",
                    }
                    logger.info(f"checkout room {room}: no explicit answer from "
                                f"client — using the company profile stamped at "
                                f"check-in (GSTIN={_g})")
            except Exception as _stamp_err:
                logger.warning(f"checkout: stamped gst_profile read failed for "
                               f"room {room}, bill stays B2C: {_stamp_err}")
        room_data["gst_profile"] = _stay_gst

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
            # ── Stale/duplicate-submit guard ─────────────────────────────────
            # A second /checkout for this room can arrive after the FIRST one
            # already committed (double-click on "Yes, Checkout", a retried
            # request, the optimistic-UI button re-enabling before the 5-8s
            # server round trip finishes). By the time this second request is
            # handled, the client-supplied room_data has no guest (either the
            # frontend's own optimistic mutation already nulled it locally, or
            # — since a falsy client guest forces a live Firestore re-read
            # above — the re-read now reflects the first request's completed
            # reset). Falling through would hit create_bill_record() with no
            # guest and raise BillCreationError, surfacing a scary "Checkout
            # blocked — alert sent to admin" message for a checkout that, in
            # fact, already succeeded.
            #
            # Detect this by room status rather than by active_bill_id/guest
            # (both already cleared): a room that is no longer "occupied" has
            # already been actioned by a prior request. A room stuck in
            # "occupied" with a missing guest is a genuinely different,
            # real data problem — that case still falls through and is
            # correctly blocked below.
            if room_data.get("status") != "occupied":
                _dup_last_bill = room_data.get("last_bill_id")
                logger.warning(
                    f"[CHECKOUT] ignoring duplicate/stale final-checkout "
                    f"request for room {room}: status="
                    f"{room_data.get('status')!r} (already actioned by a "
                    f"prior request; last_bill_id={_dup_last_bill})"
                )
                if _dup_last_bill:
                    return jsonify(
                        success=True, idempotent=True,
                        bill_id=_dup_last_bill,
                        message="Checkout already completed for this stay.",
                    )
                return jsonify(
                    success=False,
                    message=f"Room {room} is not currently occupied — nothing to check out.",
                )

            balance = room_data["balance"]
            guest_info = room_data["guest"]
            guest_name = guest_info["name"] if guest_info else "Unknown"

            # ── Idempotency guard — prevents duplicate bill-number minting ──────
            # A duplicate /checkout for the same stay (double-click, a retried
            # request, or two competing client handlers) must NOT mint a second
            # sequential bill number. generate_sequential_bill_number() consumes
            # a CC/ number the moment it runs, decoupled from whether the bill is
            # ultimately stored — so a second pass burns a number and leaves a
            # permanent gap in the GST series (Rule 46(b)).
            #
            # If this stay's draft is already finalized (status completed /
            # pending_settlement with a real bill_number), the checkout is
            # already done: return that result idempotently WITHOUT minting or
            # writing anything.
            #
            # Scope note: this is a read-check. It closes the common duplicate
            # cases (sequential re-submits, retries, the double-handler bug). A
            # pair of *truly simultaneous* requests can still both observe
            # "draft" before either finalizes; fully closing that race requires
            # minting inside the same transaction that writes the bill (see
            # config.create_bill_record / generate_sequential_bill_number).
            if active_bill_id:
                try:
                    _existing = bills_ref.document(active_bill_id).get()
                    if _existing.exists:
                        _ed = _existing.to_dict() or {}
                        _estatus = _ed.get("status")
                        _ebill_no = _ed.get("bill_number")
                        if (_estatus in ("completed", "pending_settlement")
                                and _ebill_no and _ebill_no != "-"):
                            logger.warning(
                                f"[CHECKOUT] duplicate ignored for room {room}: "
                                f"stay {active_bill_id} already finalized "
                                f"(status={_estatus}, bill_number={_ebill_no}). "
                                f"No new bill number minted."
                            )
                            # Recovery: if a prior attempt committed the bill but
                            # its room-reset batch failed, the room may still read
                            # 'occupied'. Free it idempotently so the operator is
                            # not stuck. Totals / payment-ledger are NOT re-touched
                            # (amounts already live on the bill doc).
                            try:
                                _lr = rooms_ref.document(room).get()
                                if _lr.exists and _lr.to_dict().get("status") == "occupied":
                                    rooms_ref.document(room).update({
                                        "status": "cleaning",
                                        "guest": None,
                                        "checkin_time": None,
                                        "balance": 0,
                                        "active_bill_id": None,
                                        "last_bill_id": active_bill_id,
                                        "cleaning_status": "in_progress",
                                        # This releases the room, so it owes
                                        # the same reset as the normal
                                        # checkout path. Without it the room
                                        # carries the finished stay's timeline
                                        # and prep pair into the next cycle,
                                        # and the grid's cleaned-by /
                                        # inspected-by rings show whoever
                                        # prepped it for the guest who just
                                        # left. The bill already holds this
                                        # stay's copy.
                                        "stay_timeline": [],
                                        "cleanedBy":     None,
                                        "cleanedAt":     None,
                                        "inspectedBy":   None,
                                        "inspectedAt":   None,
                                    })
                                    invalidate_rooms_and_totals()
                                    logger.warning(
                                        f"[CHECKOUT] freed stuck room {room} on "
                                        f"idempotent retry (bill {_ebill_no} "
                                        f"already stored)."
                                    )
                            except Exception as _free_err:
                                logger.warning(
                                    f"[CHECKOUT] could not free room {room} on "
                                    f"retry: {_free_err}"
                                )
                            return jsonify(
                                success=True,
                                idempotent=True,
                                bill_id=active_bill_id,
                                bill_number=_ebill_no,
                                message="Checkout already completed for this stay.",
                            )
                except Exception as _idem_err:
                    # A guard failure must NEVER block a legitimate checkout —
                    # fall through to the normal path (which still creates the
                    # bill). Worst case we lose idempotency for this one request.
                    logger.warning(
                        f"[CHECKOUT] idempotency pre-check failed for "
                        f"{active_bill_id}: {_idem_err}. Proceeding with checkout."
                    )

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

            _perf_t0 = _time.time()
            _sid = settlement_id if (balance > 0 and settle_later) else None
            try:
                bill_record = create_bill_record(
                    room, room_data, checkout_time, batch,
                    settle_later=(balance > 0 and settle_later),
                    settlement_id=_sid,
                    defer_number=True,
                )
            except BillCreationError as bce:
                # ── CHECKOUT BLOCKED ─────────────────────────────────────────
                # The bill could not be built. The old behaviour (cancel the
                # draft, let the guest leave) silently destroyed statutory
                # invoices — see the May/June 2026 GSTR-1 incident. Now:
                #   * nothing is committed (the batch is abandoned),
                #   * the room stays occupied,
                #   * the operator sees the reason immediately,
                #   * a persistent admin alert is recorded.
                # NOTE the cash no-bill toggle is NOT affected: an all-cash
                # stay with the toggle OFF still returns a valid record with
                # bill_number "-" — it never raises.
                logger.error(
                    f"CHECKOUT BLOCKED for room {room}: {bce.reason} "
                    f"(minted_number={bce.bill_number})"
                )
                _alert_ctx = {
                    "room":          str(room),
                    "guest":         guest_name,
                    "stay_id":       active_bill_id,
                    "checkout_time": checkout_time,
                    "minted_bill_number": bce.bill_number,
                }
                _alert_msg = (
                    f"Checkout for room {room} (guest: {guest_name}) was "
                    f"blocked — bill creation failed: {bce.reason}"
                )
                if bce.bill_number:
                    _alert_msg += (
                        f" Bill number {bce.bill_number} was already minted "
                        f"and is consumed: declare it as a CANCELLED document "
                        f"in GSTR-1 Table 13 for that month."
                    )
                system_alerts.record_alert(
                    "bill.create.blocked", _alert_msg,
                    severity="critical", context=_alert_ctx,
                )
                write_log(
                    "bill.create.blocked",
                    target_collection="rooms",
                    target_id=str(room),
                    metadata=_alert_ctx,
                )
                return jsonify(
                    success=False,
                    checkout_blocked=True,
                    message=(
                        f"Checkout blocked — the bill could not be created: "
                        f"{bce.reason} The room has NOT been checked out. "
                        f"An alert has been sent to the admin."
                    ),
                )

            _perf_t1 = _time.time()
            logger.info(f"[PERF] checkout create_bill_record: {_perf_t1-_perf_t0:.3f}s room={room}")

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

                # Freeze this stay's event timeline onto the bill, closed with
                # the checkout itself. The room's copy is reset in the batch
                # below, so from here the completed stay's history is immutable
                # and the room starts accumulating prep for the next guest.
                bill_record["stay_timeline"] = stay_timeline.merge(
                    stay_timeline.read(room_data),
                    [stay_timeline.make_event("room.checkout", room,
                                              at=_bill_co_now)],
                )

                # Carry shift attribution from the room onto the bill so the
                # room-history popover shows "Shifted A → B by" for completed
                # (transferred) stays too. Absent on non-transferred stays.
                for _sf in ("lastShiftedBy", "lastShiftedAt",
                            "lastShiftedFrom", "lastShiftedTo"):
                    if room_data.get(_sf) is not None:
                        bill_record[_sf] = room_data.get(_sf)

                # Stamp this stay's total onto the customer doc (background)
                # so the check-in mobile-suggestion dropdown shows "last paid"
                # with no extra query next time this guest returns.
                _co_mobile = (guest_info or {}).get("mobile", "")
                if _co_mobile:
                    customer_service.update_last_stay(
                        _co_mobile,
                        bill_record.get("total_amount", 0),
                        bill_record.get("days_stayed", 1),
                        checkout_time.split(" ")[0],
                    )

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
                    # Without this, reverting a checkout would silently drop
                    # the stay's B2B details and the re-issued bill would come
                    # out B2C. Bills snapshotted before this field existed
                    # restore as None, which is the old behaviour.
                    "gst_profile":             room_data.get("gst_profile"),
                    # IST wall-clock when this snapshot was taken (for debugging)
                    "snapshot_at":             datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
                }

                # ── Atomic mint + write (gap-free bill numbering) ─────────────
                # The CC/ number is allocated INSIDE the same transaction that
                # writes the bill doc, so the per-month counter can never
                # advance without a stored bill (and a stored bill always
                # carries its number). Replaces the old split flow where the
                # number was minted separately and could be burned by a
                # duplicate or a failed commit.
                _needs_number = bill_record.pop("_needs_bill_number", True)
                try:
                    _checkout_dt = datetime.strptime(checkout_time, "%Y-%m-%d %H:%M")
                except (ValueError, TypeError):
                    _checkout_dt = datetime.now(IST)
                try:
                    _minted_number, _newly_finalized = allocate_and_finalize_bill(
                        bill_id, bill_record,
                        checkout_dt=_checkout_dt,
                        is_new_doc=(active_bill_id is None),
                        needs_number=_needs_number,
                    )
                except Exception as _alloc_err:
                    # Transaction rolled back: NO number consumed, NO bill
                    # written. Block the checkout exactly like a build failure.
                    logger.error(
                        f"CHECKOUT BLOCKED for room {room}: atomic bill "
                        f"finalize failed: {_alloc_err}", exc_info=True
                    )
                    system_alerts.record_alert(
                        "bill.create.blocked",
                        f"Checkout for room {room} (guest: {guest_name}) was "
                        f"blocked — atomic bill finalize failed: {_alloc_err}. "
                        f"No bill number was consumed (the series is intact).",
                        severity="critical",
                        context={"room": str(room), "guest": guest_name,
                                 "stay_id": active_bill_id},
                    )
                    return jsonify(
                        success=False,
                        checkout_blocked=True,
                        message=(
                            "Checkout blocked — the bill could not be saved "
                            "atomically. No bill number was used and the room "
                            "has NOT been checked out. Please retry; an alert "
                            "has been sent to the admin."
                        ),
                    )

                bill_record["bill_number"] = _minted_number

                if not _newly_finalized:
                    # A concurrent / duplicate checkout already finalized this
                    # stay and owns the room/totals/payment writes. Do NOT
                    # repeat them (would double-count). Return idempotently.
                    logger.warning(
                        f"[CHECKOUT] concurrent duplicate for room {room}: "
                        f"stay {bill_id} already finalized as {_minted_number}; "
                        f"skipping side-effects."
                    )
                    return jsonify(
                        success=True, idempotent=True,
                        bill_id=bill_id, bill_number=_minted_number,
                        message="Checkout already completed for this stay.",
                    )

                logger.info(
                    f"Bill saved (atomic) for room {room}: {_minted_number}, "
                    f"status={bill_record.get('status')}, "
                    f"path={'finalize' if active_bill_id else 'legacy'}"
                )
            else:
                # Defence in depth: create_bill_record now raises
                # BillCreationError on every failure path, so a falsy return
                # should be impossible. If it ever happens, treat it exactly
                # like a failure — block the checkout. NEVER fall back to the
                # old cancel-the-draft behaviour (it silently destroyed
                # statutory invoices).
                system_alerts.record_alert(
                    "bill.create.blocked",
                    f"Checkout for room {room} (guest: {guest_name}) blocked: "
                    f"create_bill_record returned no record without raising — "
                    f"this is a bug, please report it.",
                    severity="critical",
                    context={"room": str(room), "guest": guest_name,
                             "stay_id": active_bill_id},
                )
                return jsonify(
                    success=False,
                    checkout_blocked=True,
                    message=("Checkout blocked — internal billing error "
                             "(no bill record). The room has NOT been checked "
                             "out. An alert has been sent to the admin."),
                )

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
                # Clear the per-stay denormalized receipt sums; the final
                # bill was just recomputed from the payments collection.
                "stay_payment_cash": None,
                "stay_payment_online": None,
                "stay_payment_for": None,
                "stay_payment_synced_at": None,
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
                # The stay is over and its timeline now lives on the bill.
                # Emptying the room's copy is what guarantees the next guest's
                # history cannot inherit this one's events.
                "stay_timeline":          [],
                # Same reasoning for the prep pair. cleanedBy / inspectedBy
                # describe ONE cleaning cycle, and this one is finished: the
                # room is dirty again the moment the guest walks out. Leaving
                # them set is what made a vacant room show a cleaner from
                # months ago beside today's inspector — /mark_room_ready_for_
                # checkin stamps inspectedBy even when the cleaning step was
                # skipped, so the two halves came from different cycles and
                # the card read as though the room had been prepped when only
                # half of it had. Cleared here, an unprepped room shows a gap,
                # which is the honest answer and the whole point of the field.
                #
                # Safe to clear: create_bill_record already snapshotted these
                # onto the bill from room_data, which was read before this
                # batch, so the completed stay's history keeps them.
                "cleanedBy":              None,
                "cleanedAt":              None,
                "inspectedBy":            None,
                "inspectedAt":            None,
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
            try:
                batch.commit()
            except Exception as _commit_err:
                # The bill + its number are ALREADY committed atomically above,
                # so the invoice series is intact (no gap). Only the room reset
                # / totals / payment-ledger writes in this batch failed. Surface
                # it loudly; re-running checkout frees the room without minting a
                # new number (handled by the idempotency guard above).
                logger.error(
                    f"[CHECKOUT] post-bill batch commit failed for room {room} "
                    f"(bill {bill_record.get('bill_number')} is safely stored): "
                    f"{_commit_err}", exc_info=True
                )
                system_alerts.record_alert(
                    "checkout.sideeffects.failed",
                    f"Bill {bill_record.get('bill_number')} for room {room} "
                    f"(guest: {guest_name}) was created, but freeing the room / "
                    f"updating totals did not commit: {_commit_err}. The bill "
                    f"series is intact (no gap). Re-run checkout for room "
                    f"{room} to finish.",
                    severity="critical",
                    context={"room": str(room), "guest": guest_name,
                             "bill_number": bill_record.get("bill_number"),
                             "stay_id": bill_id},
                )
                return jsonify(
                    success=False, checkout_partial=True,
                    bill_id=bill_id, bill_number=bill_record.get("bill_number"),
                    message=(
                        f"The bill ({bill_record.get('bill_number')}) was "
                        f"created — no number was lost — but freeing the room "
                        f"failed. Please click Checkout again to finish."
                    ),
                )
            logger.info(
                f"[PERF] checkout TOTAL: {_time.time()-_perf_t0:.3f}s room={room} "
                f"(bill={_perf_t1-_perf_t0:.3f}s, commit={_time.time()-_perf_t1:.3f}s)"
            )

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

                    # Runs in the background: this is 2–4 Firestore
                    # round-trips (query + batch + event record) that the
                    # operator should not wait on. mark_unofficial_on_checkout
                    # already catches and records its own failures internally;
                    # the wrapper below logs anything that still escapes.
                    def _bk_unofficial(_sid=bill_id):
                        try:
                            _bk_receipts.mark_unofficial_on_checkout(_sid)
                        except Exception as _e:
                            logger.warning(
                                f"mark_unofficial_on_checkout failed "
                                f"for stay={_sid}: {_e}"
                            )

                    import threading as _threading
                    _threading.Thread(target=_bk_unofficial, daemon=True).start()
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

        # ── 2b. GST month lock — a revert voids the invoice. If GSTR-1 for
        # the bill's month is already filed (month locked), the filed return
        # would no longer match the books. Refuse; the lawful correction is
        # a credit note. (In practice the 3-hour window below means this
        # only triggers if a month is locked on filing day itself.)
        _co_period = (bill.get("checkout_time") or "")[:7]
        if _co_period and is_month_locked(_co_period):
            return jsonify(
                success=False,
                message=(
                    f"GST period {_co_period} is locked (GSTR-1 filed) — "
                    f"this checkout cannot be reverted. Issue a credit note "
                    f"instead, or ask an admin to unlock the month."
                ),
            ), 409

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

        # 6c-bis. Re-point this stay's payments at the FRESH stay_id.
        #
        # revert_to_draft mints a new stay_id for a stay that is still
        # running. Without this step the payments already written keep the
        # OLD id, and every fast path that keys off the canonical FK — and
        # returns as soon as that FK yields ANY row — reports only whatever
        # is written AFTER the revert:
        #
        #   create_bill_record._fetch_payments  -> the re-issued invoice
        #   query_payments_for_stay Q0          -> /get_history
        #   get_stay_payments Q0                -> Payment History modal
        #
        # Observed: revert room 200, add one AC add-on, and the payment
        # history collapses to that single row while the re-issued bill
        # drops every earlier add-on and receipt. Under-billing, not a
        # display glitch.
        #
        # Runs INSIDE the same batch as the bill + room writes, so the FK
        # can never be left split across two stay_ids by a partial commit.
        # Only the stay_id pointer is rewritten; amounts and audit fields
        # are untouched, and the cancelled predecessor bill still renders
        # from its own stored services / payment_* fields.
        _relink_checkin = snapshot.get("checkin_time") or bill.get("checkin_time") or ""
        try:
            _relinked = payment_service.relink_stay_payments(
                stay_id, new_stay_id,
                room=str(room), checkin_time=_relink_checkin,
                batch=batch,
            )
        except Exception as _rl_e:
            # Never block a revert on the re-stamp. The legacy Q1/Q2
            # fallbacks still find the rows by room/stay_room_key.
            logger.error(f"revert_checkout: relink_stay_payments failed: {_rl_e}",
                         exc_info=True)
            _relinked = 0

        # 6c-ter. The booking carries the same foreign key and must follow.
        # create_bill_record finds it with bookings.where(stay_id == X) and
        # falls back to a (room, guest, check_in_date) heuristic that misses
        # whenever the guest arrived on a different calendar date than they
        # booked. On that miss every booking-derived field defaults: the
        # re-issued invoice comes out B2C with a blank recipient_gstin, and
        # the OTA settlement figures reset to zero. For a corporate MyBiz
        # booking that is a B2B invoice silently downgraded to B2C — and it
        # is the re-issued one that goes into GSTR-1.
        try:
            _bk_relinked = 0
            for _bk in bookings_ref.where(
                filter=FieldFilter("stay_id", "==", stay_id)
            ).stream():
                batch.update(_bk.reference, {"stay_id": new_stay_id})
                _bk_relinked += 1
        except Exception as _bk_e:
            logger.error(f"revert_checkout: booking relink failed: {_bk_e}",
                         exc_info=True)
            _bk_relinked = 0

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
            # Restore the stay's GST details so the re-issued bill is B2B
            # again. Always written (None when absent) so the room can never
            # inherit a profile from a different stay.
            "gst_profile":             snapshot.get("gst_profile"),
            # Restore the prep pair that checkout cleared. The bill captured
            # them on the way out, so an undone checkout puts the room back
            # to describing the cleaning cycle that actually prepped this
            # stay rather than showing a blank.
            "cleanedBy":               bill.get("cleanedBy"),
            "cleanedAt":               bill.get("cleanedAt"),
            "inspectedBy":             bill.get("inspectedBy"),
            "inspectedAt":             bill.get("inspectedAt"),
            # The bill's copy is closed with a room.checkout record. This stay
            # is active again, so that record is dropped rather than restored:
            # a live stay showing its own checkout is the kind of contradiction
            # the timeline exists to eliminate. The next real checkout appends
            # a fresh one.
            "stay_timeline":           [
                _e for _e in (bill.get("stay_timeline") or [])
                if isinstance(_e, dict) and _e.get("action") != "room.checkout"
            ],
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
                    # Stamp the author HERE, on the request thread. The write
                    # below runs on a daemon thread where flask.g and the
                    # request are both gone, so payment_service's resolver
                    # would fall through to "system" and this reversal would
                    # look like the machine did it. _normalise only fills
                    # createdBy when it is absent, so setting it wins.
                    "createdBy": (_safe_user() or {}).get("userId") or "system",
                }
                # NEW stay_id, not the old one. The original checkout_refund
                # row is re-pointed to the successor by the relink above, so
                # writing its reversal against the predecessor split the pair
                # across two stays: the re-issued bill then saw the refund
                # without its reversal and over-billed by exactly that amount.
                # (Rs.1,100 refunded, reverted, re-checked out -> bill asked
                # for Rs.900 instead of crediting Rs.200.)
                import threading as _thr
                _thr.Thread(
                    target=payment_service.write_payment_with_stay,
                    args=(new_stay_id, _reversal_payload),
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
                "payments_relinked":    _relinked,
                "bookings_relinked":    _bk_relinked,
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

        # ── ₹999 snap ─────────────────────────────────────────────────────
        # An accommodation add-on that would tip this night just past ₹1,000
        # is trimmed so the night lands on ₹999 instead: a ₹700 room plus a
        # ₹300 extra bed is billed as ₹700 + ₹299.
        #
        # Applied HERE, on the server, not in the browser. The price that
        # reaches Firestore is the price that gets billed, and a client can be
        # stale, offline-queued or simply bypassed. snap_to_exempt_band decides
        # whether it fires; every guard lives there.
        #
        # The night's value is the room rate plus the accommodation add-ons
        # ALREADY on this same night. Matching prefers applied_on_date and
        # falls back to applied_on_day for rows written before the absolute
        # date was stamped — the same precedence compute_daily_folio uses. The
        # two must agree, or the snap would be computed against a different
        # night than the one the folio actually bills.
        snap_given_up = 0
        if accommodation_charge:
            try:
                _night_value = int((room_data.get("guest") or {}).get("price") or 0)
                for _prev in (room_data.get("add_ons") or []):
                    if not _prev.get("accommodation_charge"):
                        continue
                    if not payment_service.is_live_charge(_prev):
                        continue   # voided line adds nothing to this night
                    if applied_on_date and _prev.get("applied_on_date"):
                        if _prev.get("applied_on_date") != applied_on_date:
                            continue
                    elif int(_prev.get("applied_on_day") or 1) != applied_on_day:
                        continue
                    _night_value += int(_prev.get("price") or 0)

                _snapped, snap_given_up = snap_to_exempt_band(
                    _night_value, price, quantity)
                if snap_given_up:
                    _asked = price
                    price = _snapped
                    unit_price = _snapped        # quantity is 1 or we would not be here
                    logger.info(
                        "add_on: 999-snap on room %s - %s Rs%s -> Rs%s "
                        "(night %s + %s would be %s, trimmed to %s)",
                        room, item, _asked, price, _night_value, _asked,
                        _night_value + _asked, EXEMPT_BAND_TARGET)
            except (TypeError, ValueError, AttributeError) as _snap_e:
                # Never block an add-on over a pricing convenience.
                logger.warning("add_on: 999-snap skipped: %s", _snap_e)
                snap_given_up = 0

        # ── Stable identity ─────────────────────────────────────────────
        # Two things depend on this.
        #
        # 1. Corrections. /update_add_on and /void_add_on have to name ONE
        #    row in an array and the matching doc in the payments collection.
        #    Before this key existed the only handle was the row's content,
        #    which cannot distinguish two identical lines.
        # 2. ArrayUnion de-duplicates structurally equal elements. Two
        #    genuine "Water 2L ₹60" sales in the same minute produced one
        #    identical dict, so the second silently never got written and the
        #    guest was undercharged. A unique key per row makes every element
        #    distinct, so ArrayUnion appends both.
        #
        # The SAME value is stamped into the payments doc below. That pairing
        # is what lets a correction move both stores together.
        _addon_uid = uuid.uuid4().hex

        # Does this add-on permanently raise the nightly rate? Computed here,
        # before the entry is built, so the flag can be stored on the row —
        # and reused by the branch below instead of being derived twice.
        # A row carrying this flag is refused by /update_add_on and
        # /void_add_on: reversing it means unpicking guest.price,
        # pre_transfer_charges and transfer_day_offset, and a wrong guess
        # there silently misprices every remaining night.
        _will_bump_rate = bool(
            accommodation_charge
            and applied_on_day >= _default_day_idx
            and data_json.get("apply_to_all_nights", False)
        )

        add_on_entry = {
            "addon_uid": _addon_uid,
            "voided": False,
            "bumped_nightly_rate": _will_bump_rate,
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
            # Set only when the 999-snap trimmed this line. Keeps the asked
            # price on the record so the reduction stays visible instead of
            # the add-on merely appearing to cost an odd number.
            "price_snapped_from": (price + snap_given_up) if snap_given_up else None,
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
            # Increment, not read-add-write. `room_data` was read before this
            # request did any work, so computing balance+price here and
            # writing an absolute value meant two staff adding a service to
            # the same room within the same second each wrote a total derived
            # from the SAME stale read — the second overwrote the first and
            # one charge silently vanished from the balance while staying on
            # the bill. The totals doc on the next line already used
            # Increment; the room doc was the odd one out.
            batch.update(rooms_ref.document(room),
                         {"balance": firestore.Increment(price)})
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
        # (Both halves of that test are folded into _will_bump_rate above.)
        # One-time by default: an accommodation add-on (Extra Bed / AC / extra
        # person) is a SINGLE charge for the day it is applied and must NOT
        # raise the nightly rent. Bumping guest.price made every later renewal
        # bill at the higher rate while staff kept collecting the old rate,
        # leaving a phantom balance (the "why is there a Rs.150 balance" bug:
        # a Rs.150 Extra Bed silently turned Rs.450/night into Rs.600/night).
        # Set apply_to_all_nights=true ONLY for a genuine permanent per-night
        # increase for the rest of the stay (e.g. a real AC upgrade).
        # _will_bump_rate (computed above, and stored on the row) is exactly
        # this condition: accommodation_charge and not retroactive and
        # apply_to_all_nights. `is_retroactive` is `applied_on_day <
        # _default_day_idx`, so `not is_retroactive` is `>=`. One source of
        # truth, so the stored flag can never disagree with what ran.
        if _will_bump_rate:
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
            # Same key as the room.add_ons entry. This is the join that lets
            # /update_add_on and /void_add_on correct both stores together.
            "addon_uid": _addon_uid,
            "voided": False,
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



# ═══════════════════════════════════════════════════════════════════════════
# ADD-ON CORRECTIONS  —  /update_add_on  and  /void_add_on
# ═══════════════════════════════════════════════════════════════════════════
#
# The operator taps a service row in Payment History ("Water 2L ₹60") and
# fixes it: wrong item, wrong quantity, wrong price, or added by mistake.
#
# What makes this dangerous, and what these routes do about it:
#
#   1. TWO STORES. The counter UI reads `room.add_ons`; the GUEST'S BILL is
#      built from the `payments` collection (create_bill_record assembles
#      `services` from stay_payments where type == "addon"). Correcting one
#      and not the other changes what staff see and not what the guest pays.
#      Both routes locate the payments doc FIRST and refuse the whole
#      correction if it cannot be found unambiguously, before anything is
#      mutated.
#
#   2. MONEY ALREADY MOVED. /add_on incremented either room.balance (method
#      "balance") or the day's cash/online counter. A correction has to move
#      the same counter by exactly the delta, in the same transaction as the
#      array rewrite, or the room balance and the totals drift apart.
#
#   3. ACTIVE STAYS ONLY. Once a guest is checked out an invoice number
#      exists, and changing a service then is a Section 34 amendment, not an
#      edit. That path needs a credit note and an amendment record, neither
#      of which exists yet. Both routes require room.status == "occupied"
#      with a live guest and refuse otherwise.
#
#   4. VOID, NEVER DELETE. A voided row stays in both stores with the
#      voided flag, who did it, when, and why. Every place that sums money
#      calls payment_service.is_live_charge, so a voided row contributes
#      nothing while remaining visible in history.
#
#   5. RATE-BUMPING ROWS ARE REFUSED. An accommodation add-on saved with
#      apply_to_all_nights rewrote guest.price, guest.pre_transfer_charges
#      and guest.transfer_day_offset. Unpicking that correctly is not
#      possible from the row alone, and guessing would misprice every
#      remaining night. Those rows carry bumped_nightly_rate and both routes
#      reject them with an explanation.

def _addon_match_key(entry: dict) -> tuple:
    """
    Fingerprint used to find a row that predates `addon_uid`.

    Deliberately the same tuple payment_service.find_addon_payment falls
    back to, so the room array and the payments collection are matched on
    identical criteria. If one store finds exactly one row and the other
    finds two, the correction is refused rather than half-applied.
    """
    return (
        str(entry.get("room") or ""),
        str(entry.get("item") or ""),
        int(entry.get("price") or entry.get("amount") or 0),
        str(entry.get("date") or ""),
        str(entry.get("time") or ""),
    )


def _locate_addon(add_ons: list, addon_uid: str, legacy: dict):
    """
    Find one add-on in `room.add_ons`.

    Returns (index, entry, reason). index is None when nothing safe was
    found; reason is "" on success, else "not_found" or "ambiguous".

    Never returns a match when two rows are equally good. An ambiguous
    correction is refused because editing the wrong ₹60 line is a silent
    billing error, and refusing is a visible one the operator can act on.
    """
    rows = list(add_ons or [])

    if addon_uid:
        hits = [i for i, a in enumerate(rows)
                if isinstance(a, dict) and a.get("addon_uid") == addon_uid]
        if len(hits) == 1:
            return (hits[0], rows[hits[0]], "")
        if len(hits) > 1:
            return (None, None, "ambiguous")
        return (None, None, "not_found")

    want = _addon_match_key(legacy or {})
    hits = [i for i, a in enumerate(rows)
            if isinstance(a, dict)
            and not a.get("addon_uid")
            and _addon_match_key(a) == want]
    if len(hits) == 1:
        return (hits[0], rows[hits[0]], "")
    if len(hits) > 1:
        return (None, None, "ambiguous")
    return (None, None, "not_found")


def _addon_correction_preflight(data_json):
    """
    Shared guard for both correction routes.

    Resolves the room, the target row and the paired payments doc, and
    enforces every refusal rule, WITHOUT mutating anything. Returns either
    ("err", (payload, http_status)) or ("ok", context-dict).

    Separated from the mutating transaction on purpose: every reason to say
    no is evaluated and reported before a single byte is written, so a
    refused correction can never leave a half-applied state behind.
    """
    room = str(data_json.get("room") or "").strip()
    if not room:
        return ("err", ({"success": False, "message": "room is required"}, 400))

    addon_uid = str(data_json.get("addon_uid") or "").strip()
    legacy = {
        "room": room,
        "item": data_json.get("match_item"),
        "price": data_json.get("match_price"),
        "date": data_json.get("match_date"),
        "time": data_json.get("match_time"),
    }
    if not addon_uid and not (legacy["item"] and legacy["date"] is not None):
        return ("err", ({
            "success": False,
            "message": "Could not identify which service to change. "
                       "Reload the room and try again.",
        }, 400))

    room_snap = rooms_ref.document(room).get()
    if not room_snap.exists:
        return ("err", ({"success": False, "message": "Room not found"}, 404))
    room_data = room_snap.to_dict() or {}

    # Guard 3 — active stays only.
    if room_data.get("status") != "occupied" or not room_data.get("guest"):
        return ("err", ({
            "success": False,
            "message": "This stay is no longer active. A service on a "
                       "checked-out bill has to be corrected with a credit "
                       "note, not edited.",
        }, 409))

    idx, entry, why = _locate_addon(room_data.get("add_ons"), addon_uid, legacy)
    if idx is None:
        return ("err", ({
            "success": False,
            "message": ("That service was already changed by someone else — "
                        "reload and try again."
                        if why == "not_found" else
                        "There are two identical service lines on this room, "
                        "so it is not clear which one to change. Void both "
                        "and re-add the correct one."),
        }, 409))

    # Guard 5 — rows that permanently changed the nightly rate.
    if entry.get("bumped_nightly_rate"):
        return ("err", ({
            "success": False,
            "message": "This charge also raised the nightly rate for the rest "
                       "of the stay, so it cannot be corrected on its own. "
                       "Fix the room rate directly instead.",
        }, 409))

    stay_id = room_data.get("active_bill_id")
    if not stay_id:
        return ("err", ({
            "success": False,
            "message": "This stay has no bill record yet, so its services "
                       "cannot be corrected. Reload the room and try again.",
        }, 409))

    # Guard 1 — resolve the payments doc BEFORE touching anything.
    pay_id, pay_doc, pay_why = payment_service.find_addon_payment(
        stay_id, addon_uid,
        room=entry.get("room"), item=entry.get("item"),
        amount=entry.get("price"), date=entry.get("date"),
        time_str=entry.get("time"),
    )
    if not pay_id:
        return ("err", ({
            "success": False,
            "message": ("This service is not linked to a billing record, so "
                        "changing it here would not change the guest's bill. "
                        "Nothing was modified."
                        if pay_why == "not_found" else
                        "This service matches more than one billing record, "
                        "so it is not safe to change automatically. Nothing "
                        "was modified."),
            "reason": pay_why,
        }, 409))

    if pay_doc.get("voided"):
        return ("err", ({
            "success": False,
            "message": "This service was already voided.",
        }, 409))

    return ("ok", {
        "room": room, "room_data": room_data, "idx": idx, "entry": entry,
        "stay_id": stay_id, "pay_id": pay_id, "pay_doc": pay_doc,
        "addon_uid": addon_uid or entry.get("addon_uid") or "",
    })


def _commit_addon_correction(room, idx, new_entry, delta, method, expect_uid,
                             expect_key):
    """
    Rewrite one element of room.add_ons and move the money, atomically.

    Read-modify-write inside a transaction rather than ArrayRemove +
    ArrayUnion: those two are not atomic together, and a failure between
    them would drop the row entirely. The transaction re-reads the array and
    re-verifies that the element at `idx` is still the row we decided to
    change (by addon_uid, or by content fingerprint for legacy rows). If a
    concurrent /add_on or transfer shifted the array underneath us, the
    correction aborts instead of overwriting the wrong line.

    `delta` is the signed change in rupees: (new price - old price) for an
    edit, -old_price for a void. It moves room.balance for balance-method
    rows and the day's cash/online counter otherwise, mirroring exactly what
    /add_on incremented.
    """
    room_ref = rooms_ref.document(room)

    @firestore.transactional
    def _txn(txn):
        snap = room_ref.get(transaction=txn)
        if not snap.exists:
            return ("err", "Room not found")
        rd = snap.to_dict() or {}
        if rd.get("status") != "occupied" or not rd.get("guest"):
            return ("err", "This stay is no longer active.")

        rows = list(rd.get("add_ons") or [])
        if idx >= len(rows) or not isinstance(rows[idx], dict):
            return ("err", "That service was already changed — reload and retry.")

        current = rows[idx]
        if expect_uid:
            if current.get("addon_uid") != expect_uid:
                return ("err", "That service was already changed — reload and retry.")
        elif _addon_match_key(current) != expect_key:
            return ("err", "That service was already changed — reload and retry.")
        if current.get("voided"):
            return ("err", "This service was already voided.")

        rows[idx] = new_entry
        room_update = {"add_ons": rows}

        totals_update = {}
        if delta:
            if method in ("cash", "online"):
                totals_update[method] = firestore.Increment(delta)
            else:
                room_update["balance"] = int(rd.get("balance") or 0) + delta
                totals_update["balance"] = firestore.Increment(delta)

        txn.update(room_ref, room_update)
        if totals_update:
            txn.update(totals_ref.document("current_totals"), totals_update)
        return ("ok", None)

    return _txn(db.transaction())


@rooms_bp.route("/update_add_on", methods=["POST"])
@requires_permission("payment.edit")
def update_add_on():
    """
    Correct a service already recorded against an ACTIVE stay.

    Body: room, addon_uid (or match_item/match_price/match_date/match_time
    for rows written before addon_uid existed), plus the new item /
    unit_price / quantity.

    The payment method is deliberately NOT editable. Moving a charge between
    "balance" and "cash" moves money between the guest's outstanding balance
    and the physical drawer, which is a cash movement, not a typo fix. Void
    the row and re-add it if the method was wrong.
    """
    try:
        data_json = request.json or {}
        status, payload = _addon_correction_preflight(data_json)
        if status == "err":
            body, code = payload
            return jsonify(**body), code
        ctx = payload
        entry = ctx["entry"]

        new_item = str(data_json.get("item") or entry.get("item") or "").strip()
        if not new_item:
            return jsonify(success=False, message="Item name cannot be empty"), 400
        try:
            new_qty = int(data_json.get("quantity", entry.get("quantity", 1)) or 1)
            new_unit = int(data_json.get(
                "unit_price", entry.get("unit_price", entry.get("price", 0))) or 0)
        except (TypeError, ValueError):
            return jsonify(success=False, message="Price and quantity must be numbers"), 400
        if new_qty < 1:
            return jsonify(success=False, message="Quantity must be at least 1"), 400
        if new_unit < 0:
            return jsonify(success=False, message="Price cannot be negative"), 400

        new_price = new_unit * new_qty
        old_price = int(entry.get("price") or 0)
        method = entry.get("payment_method") or "balance"
        accommodation_charge = bool(entry.get("accommodation_charge"))

        # ── ₹999 snap, re-evaluated ─────────────────────────────────────────
        # Runs on edit for the same reason it runs on add: the price that
        # reaches Firestore must be the price that gets billed, whichever
        # route wrote it. The night's value is recomputed EXCLUDING this row,
        # otherwise the row's own old price would be counted twice and the
        # snap would trim against a night that does not exist.
        snap_given_up = 0
        if accommodation_charge:
            try:
                _night = int((ctx["room_data"].get("guest") or {}).get("price") or 0)
                _adate = entry.get("applied_on_date")
                _aday = int(entry.get("applied_on_day") or 1)
                for _prev in (ctx["room_data"].get("add_ons") or []):
                    if not isinstance(_prev, dict):
                        continue
                    if _prev is entry or _prev.get("addon_uid") == entry.get("addon_uid"):
                        continue           # never count the row being edited
                    if not _prev.get("accommodation_charge"):
                        continue
                    if not payment_service.is_live_charge(_prev):
                        continue
                    if _adate and _prev.get("applied_on_date"):
                        if _prev.get("applied_on_date") != _adate:
                            continue
                    elif int(_prev.get("applied_on_day") or 1) != _aday:
                        continue
                    _night += int(_prev.get("price") or 0)
                _snapped, snap_given_up = snap_to_exempt_band(_night, new_price, new_qty)
                if snap_given_up:
                    new_price = _snapped
                    new_unit = _snapped
            except (TypeError, ValueError, AttributeError) as _e:
                logger.warning(f"update_add_on: 999-snap skipped: {_e}")
                snap_given_up = 0

        delta = new_price - old_price
        if (new_item == entry.get("item") and new_price == old_price
                and new_qty == int(entry.get("quantity") or 1)):
            return jsonify(success=True, unchanged=True,
                           message="Nothing changed."), 200

        actor = _safe_user()
        now = datetime.now(IST)
        new_entry = dict(entry)
        new_entry.update({
            "item": new_item,
            "price": new_price,
            "unit_price": new_unit,
            "quantity": new_qty,
            "price_snapped_from": (new_price + snap_given_up) if snap_given_up else None,
            "editedBy": actor,
            "editedAt": now.strftime("%Y-%m-%d %H:%M"),
            "edit_count": int(entry.get("edit_count") or 0) + 1,
        })

        # Re-infer the tax tag: the item name decides HSN/SAC and rate, so a
        # rename from "Water 2L" to "Laundry" must not keep the water tag.
        # Accommodation charges keep SAC 996311 and take their rate from the
        # folio, exactly as /add_on does.
        try:
            if accommodation_charge:
                new_entry["hsn_or_sac"] = "996311"
                new_entry["tax_category"] = "accommodation"
                new_entry.pop("gst_rate", None)
            else:
                from routes.billing import infer_service_tax as _infer
                _hsn, _rate, _cat = _infer({"item": new_item})
                if _hsn:
                    new_entry["hsn_or_sac"] = _hsn
                    new_entry["gst_rate"] = _rate
                    new_entry["tax_category"] = _cat
                else:
                    new_entry.pop("hsn_or_sac", None)
                    new_entry.pop("gst_rate", None)
                    new_entry["tax_category"] = "exempt"
        except Exception as _tax_e:  # noqa: BLE001
            logger.warning(f"update_add_on: tax inference failed: {_tax_e}")

        st, err = _commit_addon_correction(
            ctx["room"], ctx["idx"], new_entry, delta, method,
            ctx["addon_uid"], _addon_match_key(entry),
        )
        if st == "err":
            return jsonify(success=False, message=err), 409

        # Move the billing record. Synchronous: the money has already moved
        # above, so a silent failure here is the one outcome we cannot allow
        # to pass unreported.
        ok = payment_service.apply_addon_correction(ctx["pay_id"], {
            "item": new_item,
            "amount": new_price,
            "unit_price": new_unit,
            "quantity": new_qty,
            "editedBy": actor,
            "editedAt": now.isoformat(),
        })
        if not ok:
            logger.error(
                "update_add_on: room %s array updated but payments doc %s did "
                "NOT — bill and balance now disagree", ctx["room"], ctx["pay_id"]
            )
            write_log("room.addon.edit.split", target_collection="rooms",
                      target_id=str(ctx["room"]),
                      metadata={"addon_uid": ctx["addon_uid"],
                                "payment_id": ctx["pay_id"],
                                "room_delta_applied": delta,
                                "bill_updated": False})
            return jsonify(
                success=False,
                message="The service was changed on the room but the billing "
                        "record did not update. Do not check this guest out — "
                        "tell the administrator.",
            ), 500

        try:
            payment_service.refresh_room_stay_aggregates(ctx["stay_id"])
        except Exception:  # noqa: BLE001
            logger.warning("update_add_on: aggregate refresh failed", exc_info=True)

        invalidate_rooms_and_totals()
        write_log("room.addon.edit", target_collection="rooms",
                  target_id=str(ctx["room"]),
                  metadata={
                      "addon_uid": ctx["addon_uid"],
                      "payment_id": ctx["pay_id"],
                      "from": {"item": entry.get("item"), "price": old_price,
                               "quantity": entry.get("quantity")},
                      "to": {"item": new_item, "price": new_price,
                             "quantity": new_qty},
                      "delta": delta, "method": method,
                      "snapped": bool(snap_given_up),
                  })
        logger.info(
            f"add_on edit: room {ctx['room']} {entry.get('item')} ₹{old_price} "
            f"-> {new_item} ₹{new_price} (delta ₹{delta}, {method}) by {actor}"
        )
        # Return the resulting state, not just an acknowledgement. The client
        # otherwise has to re-fetch the whole room list and then the payment
        # history to discover what this call already knows, which is two extra
        # round trips and a visible spinner on a correction the operator has
        # already been told succeeded.
        _fresh = (rooms_ref.document(ctx["room"]).get().to_dict() or {})
        return jsonify(
            success=True, price=new_price, unit_price=new_unit,
            quantity=new_qty, delta=delta, snapped=bool(snap_given_up),
            add_ons=_fresh.get("add_ons", []),
            balance=_fresh.get("balance", 0),
            message=(f"Updated to {new_item} (₹{new_price})"
                     + (f", trimmed from ₹{new_price + snap_given_up} to keep the "
                        f"night under ₹1,000" if snap_given_up else "")),
        )
    except Exception as e:  # noqa: BLE001
        logger.error(f"update_add_on error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {e}"), 500


@rooms_bp.route("/void_add_on", methods=["POST"])
@requires_permission("payment.edit")
def void_add_on():
    """
    Void a service on an ACTIVE stay. The row is kept, not deleted.

    Body: room, addon_uid (or the legacy match_* fields), optional reason.
    """
    try:
        data_json = request.json or {}
        status, payload = _addon_correction_preflight(data_json)
        if status == "err":
            body, code = payload
            return jsonify(**body), code
        ctx = payload
        entry = ctx["entry"]

        old_price = int(entry.get("price") or 0)
        method = entry.get("payment_method") or "balance"
        reason = str(data_json.get("reason") or "").strip()[:200]
        actor = _safe_user()
        now = datetime.now(IST)

        new_entry = dict(entry)
        new_entry.update({
            "voided": True,
            "voidedBy": actor,
            "voidedAt": now.strftime("%Y-%m-%d %H:%M"),
            "void_reason": reason,
            # The price is preserved. is_live_charge is what keeps a voided
            # row out of every total, so zeroing the amount here would only
            # destroy the record of what was originally charged.
        })

        st, err = _commit_addon_correction(
            ctx["room"], ctx["idx"], new_entry, -old_price, method,
            ctx["addon_uid"], _addon_match_key(entry),
        )
        if st == "err":
            return jsonify(success=False, message=err), 409

        ok = payment_service.apply_addon_correction(ctx["pay_id"], {
            "voided": True,
            "voidedBy": actor,
            "voidedAt": now.isoformat(),
            "void_reason": reason,
        })
        if not ok:
            logger.error(
                "void_add_on: room %s array voided but payments doc %s did NOT "
                "— the charge is off the balance but still on the bill",
                ctx["room"], ctx["pay_id"]
            )
            return jsonify(
                success=False,
                message="The service was removed from the room but the billing "
                        "record did not update. Do not check this guest out — "
                        "tell the administrator.",
            ), 500

        try:
            payment_service.refresh_room_stay_aggregates(ctx["stay_id"])
        except Exception:  # noqa: BLE001
            logger.warning("void_add_on: aggregate refresh failed", exc_info=True)

        invalidate_rooms_and_totals()
        write_log("room.addon.void", target_collection="rooms",
                  target_id=str(ctx["room"]),
                  metadata={"addon_uid": ctx["addon_uid"],
                            "payment_id": ctx["pay_id"],
                            "item": entry.get("item"), "price": old_price,
                            "method": method, "reason": reason})
        logger.info(
            f"add_on void: room {ctx['room']} {entry.get('item')} ₹{old_price} "
            f"({method}) by {actor} reason={reason!r}"
        )
        _fresh = (rooms_ref.document(ctx["room"]).get().to_dict() or {})
        return jsonify(success=True, delta=-old_price,
                       add_ons=_fresh.get("add_ons", []),
                       balance=_fresh.get("balance", 0),
                       message=f"Removed {entry.get('item')} (₹{old_price})")
    except Exception as e:  # noqa: BLE001
        logger.error(f"void_add_on error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {e}"), 500


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

            # ── Price-segment boundary guard ─────────────────────────────────
            # After a transfer / re-rate, days before the boundary were
            # accrued at a PREVIOUS rate (snapshotted in pre_transfer_charges,
            # cumulative day count = transfer_day_offset). Reversing at
            # today's guest.price would refund the wrong amount for those
            # days — cap the reversal at the current price segment.
            _g = rd.get("guest") or {}
            _seg_offset = int(_g.get("transfer_day_offset", 0) or 0)
            if _seg_offset and (_g.get("pre_transfer_charges") or []):
                # Cycles accrued so far = renewal_count + 1 (cycle 1 is funded
                # at check-in). Cycles 1.._seg_offset belong to earlier
                # segments; the rest are at the current rate (the transfer's
                # shift-day adjustment re-rated any straddling cycle).
                _reversible = (current_count + 1) - _seg_offset
                if days_to_reverse > max(0, _reversible):
                    return (
                        "err",
                        f"Cannot reverse {days_to_reverse} day(s): only "
                        f"{max(0, _reversible)} renewal(s) belong to the "
                        f"current rate segment (earlier days were billed at "
                        f"a previous room's rate). Adjust those via a "
                        f"discount / price edit instead.",
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
            # Appended rather than replaced: the flat field holds only the most
            # recent edit, but every correction to a stay's check-in time is
            # worth showing separately.
            "stay_timeline": stay_timeline.append_op(
                stay_timeline.make_event("room.checkin_time_update", room,
                                         at=_ed_now)),
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

        # ── Re-rank the affected day(s) so the daily serial (#) always
        #    matches check-in-time order. A time-only edit re-ranks the one
        #    day; a date change re-ranks BOTH the old and the new day. Covers
        #    ALL stays that day (active and checked-out), per ops policy.
        from config import renumber_day_serials
        _final_serial = None
        _days = [new_date] + ([old_date] if (date_changed and old_date) else [])
        for _d in _days:
            try:
                _order = renumber_day_serials(_d)
            except Exception as _re:
                logger.warning(f"renumber_day_serials({_d}) failed: {_re}")
                _order = []
            if _d == new_date and _abid:
                for _row in _order:
                    if _row.get("stay_id") == _abid:
                        _final_serial = _row.get("serial")
                        break
        if _final_serial is not None:
            new_serial = _final_serial

        # Same _GET_DATA_CACHE concern as transfer_room — use the
        # monkey-patched invalidator so the /get_data cache is busted too.
        invalidate_rooms_and_totals()

        msg = "Check-in time updated successfully."
        if new_serial:
            msg += f" Serial set to #{new_serial} for {new_date} (day re-ordered by check-in time)."

        logger.info(f"Check-in time updated for room {room}: {new_checkin_time}")
        write_log("room.checkin_time_update", target_collection="rooms", target_id=str(room),
                  metadata={"new_checkin_time": new_checkin_time, "serial": new_serial})
        return jsonify(success=True, message=msg, serial_number=new_serial)
    except Exception as e:
        logger.error(f"Error updating check-in time: {str(e)}")
        return jsonify(success=False, message=f"Error updating check-in time: {str(e)}")


@rooms_bp.route("/update_stay_times", methods=["POST"])
@requires_permission("stay.times.edit")   # not granted to any non-admin role → admin-only
def update_stay_times():
    """
    Edit check-in AND checkout date/time on a COMPLETED stay, from the
    Register tab. Active stays keep using /update_checkin_time (which
    handles the live room doc, the manager one-edit rule, and renewals).

    Body: { bill_id, checkin_time "YYYY-MM-DD HH:MM",
            checkout_time "YYYY-MM-DD HH:MM" }

    What this DOES:
      • updates the bill doc's checkin_time / checkout_time (timestamps only)
      • moves the stay's first check-in payment (fresh_checkin /
        booking_conversion) to the new check-in date+time, so the
        Transactions tab and daily serials stay consistent
      • re-ranks daily serials (#) for every affected check-in day via
        renumber_day_serials — payments, transaction_metadata, bill docs
        and the day counter all move together
      • appends an audit entry on the bill (stay_time_edits[]) + audit log

    What this deliberately does NOT do (loophole guards):
      • never touches amounts — if the new dates imply a different night
        count than billed, the response carries a `warning` and the
        operator adjusts the price explicitly
      • rejects edits when either the old or the new checkout month is
        GST-locked (GSTR-1 filed)
      • rejects moving an INVOICED bill's checkout into a different month
        (bill numbers embed YYYY/MM and are sequential per GST)
      • rejects future timestamps and checkout ≤ check-in
    """
    try:
        data = request.json or {}
        bill_id    = (data.get("bill_id") or "").strip()
        new_ci_raw = (data.get("checkin_time") or "").strip()[:16]
        new_co_raw = (data.get("checkout_time") or "").strip()[:16]
        if not bill_id or not new_ci_raw or not new_co_raw:
            return jsonify(success=False,
                           message="bill_id, checkin_time and checkout_time "
                                   "are required"), 400
        try:
            new_ci = datetime.strptime(new_ci_raw, "%Y-%m-%d %H:%M")
            new_co = datetime.strptime(new_co_raw, "%Y-%m-%d %H:%M")
        except ValueError:
            return jsonify(success=False,
                           message="Times must be 'YYYY-MM-DD HH:MM'"), 400
        if new_co <= new_ci:
            return jsonify(success=False,
                           message="Checkout must be after check-in"), 400
        _now_naive = datetime.now(IST).replace(tzinfo=None)
        if new_ci > _now_naive or new_co > _now_naive:
            return jsonify(success=False,
                           message="Stay times can't be in the future"), 400

        bill = bills_service.get(bill_id)
        if not bill:
            return jsonify(success=False, message="Stay not found"), 404
        old_ci_raw = (bill.get("checkin_time") or "")[:16]
        old_co_raw = (bill.get("checkout_time") or "")[:16]
        status     = bill.get("status") or ""
        if status == "cancelled":
            return jsonify(success=False,
                           message="This stay is cancelled — nothing to edit"), 400
        if not old_co_raw or status in ("draft", "active"):
            return jsonify(success=False,
                           message="Guest is still checked in — use the "
                                   "check-in time editor on the room card"), 400

        # ── GST month locks: neither the old nor the new checkout month may
        #    be filed. (The checkout month is the GSTR-1 period.)
        for _d in (old_co_raw[:10], new_co_raw[:10]):
            try:
                if _d and is_month_locked(_d):
                    return jsonify(success=False, locked=True,
                                   message=f"GST period {_d[:7]} is locked "
                                           f"(GSTR-1 filed) — stay dates in "
                                           f"that month can't be changed."), 423
            except Exception as _lk_e:
                logger.warning(f"update_stay_times: lock check failed: {_lk_e}")

        # ── Invoiced bills: checkout month is baked into the bill number
        #    (CC/YYYY/MM/xxxxx, sequential). Cross-month moves are blocked.
        bill_no = bill.get("bill_number") or "-"
        if (bill.get("invoice_generated") and bill_no != "-"
                and old_co_raw[:7] != new_co_raw[:7]):
            return jsonify(success=False,
                           message=f"Bill {bill_no} is a GST invoice for "
                                   f"{old_co_raw[:7]} — its checkout can't "
                                   f"move to a different month. Use a credit "
                                   f"note for that correction."), 400

        ci_changed = (old_ci_raw != new_ci_raw)
        co_changed = (old_co_raw != new_co_raw)
        if not ci_changed and not co_changed:
            return jsonify(success=False, message="Nothing changed"), 400

        old_ci_date = old_ci_raw[:10]
        new_ci_date = new_ci_raw[:10]

        # ── 1. Move the first check-in payment with the check-in time ──────
        moved_payment = False
        if ci_changed:
            try:
                payments_ref = db.collection("payments")
                first_pays = []
                # Canonical: stamped stay_id.
                for d in (payments_ref
                          .where(filter=FieldFilter("stay_id", "==", bill_id))
                          .stream()):
                    pd = d.to_dict() or {}
                    if pd.get("transaction_type") in ("fresh_checkin",
                                                      "booking_conversion"):
                        first_pays.append((d.id, pd))
                # Legacy fallback: room + old check-in date + guest name.
                if not first_pays and old_ci_date:
                    gname = bill.get("guest_name") or ""
                    for d in (payments_ref
                              .where(filter=FieldFilter("room", "==",
                                                        str(bill.get("room") or "")))
                              .where(filter=FieldFilter("date", "==", old_ci_date))
                              .stream()):
                        pd = d.to_dict() or {}
                        if (pd.get("name") == gname and
                                pd.get("transaction_type") in
                                ("fresh_checkin", "booking_conversion")):
                            first_pays.append((d.id, pd))
                # Exactly one check-in payment per stay; take the first match.
                for pid, pd in first_pays[:1]:
                    _pay_update = {"date": new_ci_date,
                                   "time": new_ci_raw[11:16]}
                    if old_ci_date != new_ci_date:
                        _pay_update["original_date"] = old_ci_date
                    payments_ref.document(pid).update(_pay_update)
                    moved_payment = True
                    logger.info(f"update_stay_times: payment {pid} moved to "
                                f"{new_ci_date} {new_ci_raw[11:16]}")
            except Exception as _pe:
                logger.warning(f"update_stay_times: payment sync failed: {_pe}")

        # ── 2. Bill doc: timestamps + attribution. Amounts untouched. ──────
        _user = (_safe_user() or {}).get("userId") or "system"
        _now  = datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")
        _hist = list(bill.get("stay_time_edits") or [])[-19:]
        _hist.append({"by": _user, "at": _now,
                      "old_checkin": old_ci_raw,  "new_checkin": new_ci_raw,
                      "old_checkout": old_co_raw, "new_checkout": new_co_raw})
        ok = bills_service.update(bill_id, {
            "checkin_time":         new_ci_raw,
            "checkout_time":        new_co_raw,
            "stay_time_edits":      _hist,
            "lastStayTimesEditBy":  _user,
            "lastStayTimesEditAt":  _now,
        })
        if not ok:
            return jsonify(success=False,
                           message="Could not update the stay record — "
                                   "try again"), 500

        # ── 3. Re-rank daily serials on every affected check-in day ────────
        new_serial = None
        _days = {new_ci_date}
        if ci_changed and old_ci_date and old_ci_date != new_ci_date:
            _days.add(old_ci_date)
        from config import renumber_day_serials
        for _d in sorted(_days):
            try:
                _order = renumber_day_serials(_d) or []
            except Exception as _re:
                logger.warning(f"renumber_day_serials({_d}) failed: {_re}")
                _order = []
            if _d == new_ci_date:
                for _row in _order:
                    if _row.get("stay_id") == bill_id:
                        new_serial = _row.get("serial")

        # ── 4. Nights mismatch → warn only (never touch money) ─────────────
        implied_nights = max(1, (new_co.date() - new_ci.date()).days)
        billed_nights  = int(bill.get("days_stayed") or 0)
        warning = None
        if billed_nights and implied_nights != billed_nights:
            warning = (f"The new dates span {implied_nights} night(s) but the "
                       f"bill was charged for {billed_nights}. Amounts were "
                       f"NOT changed — adjust the bill manually if the price "
                       f"should differ.")

        invalidate_rooms_and_totals()
        write_log("stay.times_update", target_collection="bills",
                  target_id=bill_id,
                  metadata={"old_checkin": old_ci_raw, "new_checkin": new_ci_raw,
                            "old_checkout": old_co_raw, "new_checkout": new_co_raw,
                            "moved_payment": moved_payment,
                            "serial": new_serial, "warning": bool(warning)})

        msg = "Stay times updated."
        if new_serial:
            msg += f" Serial re-ranked to #{new_serial} for {new_ci_date}."
        return jsonify(success=True, message=msg,
                       serial_number=new_serial, warning=warning,
                       moved_payment=moved_payment)
    except Exception as e:
        logger.error(f"update_stay_times error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


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
        # Cross-category only: True (default) → the shift day is billed at
        # the NEW rate and the difference lands on the balance (due/refund).
        # False → the shift day stays at the OLD rate; the new rate starts
        # from the next rent cycle (no balance change today).
        apply_today_diff = bool(data_json.get("apply_today_diff", True))

        rooms_dict = get_all_rooms()

        if old_room not in rooms_dict or new_room not in rooms_dict:
            return jsonify(success=False, message="One or both rooms do not exist.")

        if rooms_dict[old_room]["status"] != "occupied":
            return jsonify(success=False, message="Source room is not occupied.")

        if rooms_dict[new_room]["status"] != "vacant":
            return jsonify(success=False, message="Destination room is not vacant.")

        # ── Category resolution ──────────────────────────────────────────────
        # Same-category transfers keep the guest's tariff unchanged (physical
        # move only — legacy behaviour). Cross-category transfers RE-RATE the
        # stay from the shift day onward: prior nights are snapshotted into
        # pre_transfer_charges at the old rate, guest.price moves to the new
        # room's rate, and the daily folio bills each night at its own
        # segment's rate. Destination categories without a published tariff
        # (party-hall / unmapped) are blocked for cross-category moves.
        _old_cat = room_category(old_room)
        _new_cat = room_category(new_room)
        cross_category = _old_cat != _new_cat
        if cross_category and _new_cat in ("party-hall", "other"):
            return jsonify(
                success=False,
                message=(
                    f"Room {new_room} ({_new_cat}) has no standard nightly "
                    "tariff — cross-category transfer into it is not allowed."
                ),
            ), 400

        # ── Role gate: cross-category is admin-only ──────────────────────────
        # Managers hold "room.transfer" (same-category physical moves).
        # Re-rating a stay (upgrade/downgrade) requires
        # "room.transfer.cross_category", granted only via the admin
        # wildcard. Checked inline (not as a decorator) so same-category
        # transfers keep their existing access rules.
        if cross_category:
            from services.auth_service import load_current_user
            from services.permissions import role_has_permission
            _cur_user = load_current_user()
            if not _cur_user:
                return jsonify(success=False,
                               message="Authentication required"), 401
            if not role_has_permission(_cur_user["role"],
                                       "room.transfer.cross_category"):
                logger.info(
                    f"transfer_room: cross-category denied for "
                    f"{_cur_user['userId']} ({_cur_user['role']}) "
                    f"{old_room}({_old_cat}) → {new_room}({_new_cat})"
                )
                return jsonify(
                    success=False,
                    message=(
                        "Cross-category transfers (upgrade/downgrade) need "
                        "admin access. You can shift only within the same "
                        "room category."
                    ),
                ), 403

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

        # ── "Don't apply today's difference" (cross-category only) ──────────
        # When the operator opts NOT to charge/refund the shift-day rate
        # difference, every cycle ACCRUED so far (day 1 at check-in +
        # renewals) is folded into the old segment at the OLD rate — the
        # folio then bills today at the old price and the new rate starts
        # from the next cycle, keeping balance == folio with zero
        # adjustment. transfer_day_prebilled marks that the in-progress day
        # is already covered by the segment, so checkout's minimum-1-day
        # rule must not double-bill it on a same-day checkout.
        # "ota" was a source that is never written ("mmt"/"agoda"/"normal" are),
        # and "agoda" was missing, so a cross-category transfer re-rated an
        # Agoda stay and moved its balance — something that never happens to
        # an MMT stay. guest.payment == "ota" stays as the primary signal
        # because it survives on the room doc after conversion; the source
        # check is the fallback for rooms that predate that stamp.
        _is_ota = (new_room_data["guest"].get("payment") == "ota") or (
            new_room_data.get("booking_source") in OTA_PREPAID_SOURCES)
        transfer_day_prebilled = False
        if cross_category and not _is_ota and not apply_today_diff:
            _renewals_now = int(new_room_data.get("renewal_count", 0) or 0)
            _fold_days = max(0, (_renewals_now + 1) - existing_offset)
            if _fold_days > old_days:
                transfer_day_prebilled = True
                old_days = _fold_days

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
        # Stamp / clear the prebilled marker (clear guards against a stale
        # flag carried over from an earlier "difference off" shift).
        if transfer_day_prebilled:
            new_room_data["guest"]["transfer_day_prebilled"] = \
                _transfer_now.strftime("%Y-%m-%d")
        else:
            new_room_data["guest"].pop("transfer_day_prebilled", None)
        # renewal_count carries over unchanged — still used for non-transfer stays
        # ────────────────────────────────────────────────────────────────────────

        # ── Tariff on transfer ───────────────────────────────────────────────
        # SAME category  → physical move only, tariff carries over unchanged
        #                  (legacy policy; client-supplied price/AC ignored).
        # CROSS category → the stay is re-rated from the shift day onward:
        #                  guest.price moves to the destination tariff, and
        #                  the daily folio bills prior nights at the old
        #                  segment's rate (pre_transfer_charges snapshot above).
        # OTA / MMT stays are prepaid and settled with the OTA — the desk
        # never charges or refunds the guest for a room change, so their
        # tariff NEVER changes regardless of category.
        _guest = new_room_data["guest"]   # _is_ota computed in snapshot block
        _dest_is_premium = _new_cat == "premium"
        renewal_count    = int(new_room_data.get("renewal_count", 0) or 0)

        balance_adjustment = 0
        price_overridden   = False
        new_price_final    = old_price

        if cross_category and not _is_ota:
            # Standard tariff for the destination (guest-count aware).
            _guests = _guest.get("guests", 1)
            std_price = room_base_price(new_room, _guests)
            _want_ac  = bool(is_ac) and _dest_is_premium
            if _want_ac:
                std_price += AC_SURCHARGE

            # Client may override the standard price (negotiated rate).
            # Validate: positive int, hard cap as a fat-finger guard.
            new_price_final = std_price
            if new_price is not None:
                try:
                    _np = int(new_price)
                except (TypeError, ValueError):
                    _np = -1
                if 1 <= _np <= 100000:
                    new_price_final = _np
                    price_overridden = _np != std_price
                else:
                    return jsonify(
                        success=False,
                        message=f"Invalid new_price {new_price!r} — must be a "
                                f"positive amount (standard is ₹{std_price}).",
                    ), 400

            _guest["price"] = new_price_final
            _guest["isAC"]  = _want_ac

            # ── Shift-day re-rate: keep balance in sync with the folio ──────
            # Rent is accrued per 24h cycle: day 1 at check-in, later cycles
            # via /renew_rent — always at the price current AT THAT MOMENT.
            # The folio bills cycles AFTER the completed ones at the NEW rate,
            # so any cycle already accrued at the old rate but billed at the
            # new rate needs the difference applied to the running balance:
            #   accrued cycles          = renewal_count + 1
            #   cycles billed at OLD    = _completed_cycles (this + prior segments)
            #   over-accrued at old rate = max(0, accrued − completed)
            # Normally 1 (the in-progress day); 0 if today's renewal hasn't
            # been clicked yet (that renewal will charge the new rate).
            # Cycles accrued beyond those captured into segments. When
            # "apply today's difference" is OFF, the fold above already
            # covers them (offset == accrued), so this is 0 and no
            # adjustment is applied.
            _offset_after = existing_offset + old_days
            _over_accrued = max(0, (renewal_count + 1) - _offset_after)
            balance_adjustment = (new_price_final - old_price) * _over_accrued
            if balance_adjustment:
                new_room_data["balance"] = int(
                    new_room_data.get("balance", 0) or 0) + balance_adjustment
        else:
            # Same-category (or OTA): tariff unchanged. Defensive: outside the
            # premium range an AC flag is meaningless — drop it so the room
            # card doesn't show a phantom AC indicator.
            if not _dest_is_premium:
                _guest["isAC"] = False

        # Stamp shift attribution on the destination room so the room-history
        # popover can show "Shifted A → B by <user>" for THIS stay. Carried on
        # the room doc (active stay) and snapshotted onto the bill at checkout.
        _shift_user = (_safe_user() or {}).get("userId") or "system"
        _shift_at   = datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")
        new_room_data["lastShiftedBy"]   = _shift_user
        new_room_data["lastShiftedAt"]   = _shift_at
        new_room_data["lastShiftedFrom"] = str(old_room)
        new_room_data["lastShiftedTo"]   = str(new_room)

        # ── Carry the stay's event timeline into the destination room ────────
        # new_room_data is a copy of the OLD room's doc and is written with
        # batch.set (a full replace), so without this the destination's own
        # prep records would be silently overwritten and the flat lastShifted*
        # fields would be the only trace of the move — which is exactly the
        # mixture of stays the popover was showing.
        #
        # Three groups merge, chronologically:
        #   1. the stay's history so far, on the old room
        #   2. the destination's cleaning/inspection — the prep that readied
        #      THIS room for THIS guest, and part of their accountability trail
        #   3. the shift itself
        # Anything else sitting on the destination is dropped by prep_only:
        # a vacant room should carry nothing but prep, and a stray record
        # there belongs to somebody who never occupied it.
        new_room_data["stay_timeline"] = stay_timeline.merge(
            stay_timeline.read(rooms_dict[old_room]),
            stay_timeline.prep_only(stay_timeline.read(rooms_dict[new_room])),
            [stay_timeline.make_event("room.transfer", new_room,
                                      from_room=old_room, to_room=new_room,
                                      at=_shift_at)],
        )

        batch = db.batch()

        batch.set(rooms_ref.document(new_room), new_room_data)

        # Cross-category re-rate: mirror the room-balance delta on the global
        # totals counter (same pattern as /renew_rent and /shorten_stay).
        if balance_adjustment:
            batch.update(totals_ref.document("current_totals"),
                         {"balance": firestore.Increment(balance_adjustment)})

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
            "cleaning_start_time": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
            # The stay moved out with its history. Empty this room's copy so
            # the next guest here starts from their own prep, same as checkout.
            "stay_timeline": [],
            # And its prep pair, for the same reason as checkout: this room
            # was just vacated, so the cycle that cleaned it is spent.
            "cleanedBy":     None,
            "cleanedAt":     None,
            "inspectedBy":   None,
            "inspectedAt":   None,
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
        if cross_category:
            _shift_payload["note"] = (
                f"Category change {_old_cat}→{_new_cat}: "
                f"₹{old_price}/night → ₹{new_price_final}/night"
                + (" (AC)" if _guest.get("isAC") else "")
            )
        if _stay_id_for_transfer:
            payment_service.write_payment_with_stay(_stay_id_for_transfer, _shift_payload)
        else:
            payment_service.write_payment(_shift_payload)

        # Audit row for the shift-day re-rate so the per-stay payment history
        # explains the balance change. type is NOT a receipt/discount/refund
        # type, so checkout's payment sums ignore it (like renewal rows).
        if balance_adjustment:
            _adj_payload = {
                "room": new_room, "name": guest_name,
                "amount": balance_adjustment, "method": "balance",
                "type": "room_shift_adjustment",
                "transaction_type": "room_shift_adjustment",
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "time": datetime.now(IST).strftime("%H:%M"),
                "old_room": old_room,
                "note": (f"Shift-day rate difference "
                         f"(₹{old_price} → ₹{new_price_final})"),
                "stay_room_key": f"{new_room}_{checkin_time}",
                "mobile": guest_mobile,
            }
            if _stay_id_for_transfer:
                payment_service.write_payment_with_stay(_stay_id_for_transfer, _adj_payload)
            else:
                payment_service.write_payment(_adj_payload)

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
                "cross_category": cross_category,
                "old_category": _old_cat,
                "new_category": _new_cat,
                "old_price": old_price,
                "new_price": new_price_final,
                "price_overridden": price_overridden,
                "is_ac": bool(_guest.get("isAC")),
                "apply_today_diff": apply_today_diff,
                "transfer_day_prebilled": transfer_day_prebilled,
            },
        )
        _msg = (f"Guest transferred successfully from Room {old_room} "
                f"to Room {new_room}.")
        if cross_category and new_price_final != old_price:
            _msg += (f" Rate changed ₹{old_price} → ₹{new_price_final}/night"
                     + (" (AC)" if _guest.get("isAC") else "") + ".")
            if not apply_today_diff:
                _msg += (" Today stays at the previous rate; the new rate "
                         "applies from the next rent cycle.")
        return jsonify(
            success=True,
            message=_msg,
            balance_adjustment=balance_adjustment,
            new_price=new_price_final,
            is_ac=bool(_guest.get("isAC")),
            cross_category=cross_category,
        )

    except Exception as e:
        logger.error(f"Error transferring room: {str(e)}", exc_info=True)
        return jsonify(success=False, message=f"Error transferring room: {str(e)}")

@rooms_bp.route("/edit_room_price", methods=["POST"])
@requires_permission("payment.edit")
def edit_room_price():
    """Correct the nightly tariff on an ACTIVE stay. Admin-gated.

    The finalized-bill equivalent is /edit_bill_room_price. This is its
    in-stay counterpart: it exists because the tariff is most often found to
    be wrong at the checkout modal, while the guest is standing there, and
    the only way to fix it before this was to check out at the wrong price
    and correct the bill afterwards.

    Balance arithmetic
    ──────────────────
    Nights already accrued at the CURRENT room's rate have to be re-priced,
    or the correction silently under- or over-charges the guest. That count
    is the same one /transfer_room uses:

        accrued at this rate = (renewal_count + 1) - transfer_day_offset

    renewal_count + 1 is the nights consumed so far (day 1 is consumed at
    check-in); transfer_day_offset is the nights already billed at an
    earlier room's rate and captured in guest.pre_transfer_charges. Those
    earlier nights are NOT re-priced here — they were charged at a tariff
    that was correct for the room the guest was actually in.

    The delta moves the room balance and the global counter together, the
    same pairing /transfer_room, /renew_rent and /shorten_stay use.

    What this does NOT do
    ─────────────────────
    It does not touch a finalized bill, and it refuses on a room that is not
    occupied. Nothing here recomputes GST: the per-night folio is built from
    guest.price at checkout by config.compute_daily_folio, so correcting the
    tariff now is enough for the slab to be picked from the corrected value.
    """
    try:
        data = request.get_json(silent=True) or {}
        room = str(data.get("room") or "").strip()
        reason = str(data.get("reason") or "").strip()

        if not room:
            return jsonify(success=False, message="room is required"), 400

        try:
            new_price = int(data.get("room_price_per_night"))
        except (TypeError, ValueError):
            return jsonify(success=False,
                           message="room_price_per_night must be a whole number"), 400
        if new_price <= 0:
            return jsonify(success=False, message="Price must be greater than zero"), 400

        room_ref = rooms_ref.document(room)
        snap = room_ref.get()
        if not snap.exists:
            return jsonify(success=False, message=f"Room {room} does not exist"), 404

        room_data = snap.to_dict() or {}
        if room_data.get("status") != "occupied":
            return jsonify(
                success=False,
                message=("Room is not occupied. A finalized stay's tariff is "
                         "corrected from the bill's Edit Price instead."),
            ), 409

        guest = dict(room_data.get("guest") or {})
        old_price = int(guest.get("price", 0) or 0)
        if old_price == new_price:
            return jsonify(success=False,
                           message="That is already the current price."), 400

        # Nights charged at THIS room's rate — see the docstring.
        renewal_count = int(room_data.get("renewal_count", 0) or 0)
        offset = int(guest.get("transfer_day_offset", 0) or 0)
        nights_at_rate = max(0, (renewal_count + 1) - offset)
        delta = (new_price - old_price) * nights_at_rate

        old_balance = int(room_data.get("balance", 0) or 0)
        new_balance = old_balance + delta

        _pu_user = (_safe_user() or {}).get("userId") or "system"
        _pu_now = datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")

        guest["price"] = new_price

        batch = db.batch()
        batch.update(room_ref, {
            "guest": guest,
            "balance": new_balance,
            # Attribution for the room-history popover. The timeline record
            # carries the amounts so the trail reads "Price 600 -> 800 by X"
            # rather than just naming an edit that happened.
            "lastPriceEditBy": _pu_user,
            "lastPriceEditAt": _pu_now,
            "stay_timeline": stay_timeline.append_op(
                stay_timeline.make_event("room.price_update", room, at=_pu_now,
                                         old_price=old_price,
                                         new_price=new_price,
                                         nights=nights_at_rate)),
            "lastModifiedBy": _pu_user,
            "lastModifiedAt": _pu_now,
        })
        if delta:
            batch.update(totals_ref.document("current_totals"),
                         {"balance": firestore.Increment(delta)})

        # Keep the draft stay doc in step so a checkout that reads it (or a
        # register row rendered from it) does not show the superseded tariff.
        _stay_id = room_data.get("active_bill_id")
        if _stay_id:
            batch.update(bills_ref.document(_stay_id),
                         {"room_price_per_night": new_price})

        batch.commit()
        invalidate_rooms_and_totals()

        write_log(
            "room.price_update",
            target_collection="rooms",
            target_id=str(room),
            before={"room_price_per_night": old_price, "balance": old_balance},
            after={"room_price_per_night": new_price, "balance": new_balance},
            metadata={
                "guest": guest.get("name"),
                "nights_repriced": nights_at_rate,
                "balance_delta": delta,
                "reason": reason,
            },
        )
        logger.info(f"Room {room} price {old_price} -> {new_price} by {_pu_user} "
                    f"({nights_at_rate} nights, balance delta {delta})")

        return jsonify(
            success=True,
            message=(f"Price updated to \u20b9{new_price}."
                     + (f" Balance adjusted by \u20b9{delta}."
                        if delta else "")),
            room_price_per_night=new_price,
            balance=new_balance,
            balance_delta=delta,
            nights_repriced=nights_at_rate,
        )

    except Exception as e:
        logger.error(f"edit_room_price error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error updating price: {e}"), 500


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
            # Prep record for the NEXT stay. The room's array was emptied at
            # checkout, so this is the first entry of that stay's history.
            "stay_timeline":     stay_timeline.append_op(
                stay_timeline.make_event("room.cleaning.complete", room,
                                         at=_hk_now)),
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

        # Vacate + clear all guest-related fields. Same shape as the old
        # mark_room_cleaned final write, with the cleaning workflow fields
        # also cleared.
        #
        # ATOMIC CLAIM (same pattern as check-in's _claim_room): the status
        # check and the vacate-update run inside one transaction so two
        # racing requests (e.g. a double-tap on the QC approve button) can
        # never BOTH pass the "is it in cleaning?" check. The loser raises
        # ValueError and, crucially, writes no duplicate audit entry —
        # duplicate audit entries were double-counting rooms in the
        # Daily Insights cleaning history.
        _insp_user = (_safe_user() or {}).get("userId") or "system"
        _insp_now = datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")

        @firestore.transactional
        def _claim_ready(txn, ref):
            snap = ref.get(transaction=txn)
            if not snap.exists:
                raise ValueError("Room not found")
            data = snap.to_dict() or {}
            if data.get("status") != "cleaning":
                raise ValueError("This room is not in cleaning status")
            txn.update(ref, {
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
                # Second prep record for the next stay. Appended, not replaced:
                # a room cleaned and inspected twice while idle shows both,
                # which is the point of an accountability trail.
                "stay_timeline":     stay_timeline.append_op(
                    stay_timeline.make_event("room.inspection.approve", room,
                                             at=_insp_now)),
                "lastModifiedBy":    _insp_user,
                "lastModifiedAt":    _insp_now,
            })
            return data

        try:
            room_data = _claim_ready(db.transaction(), rooms_ref.document(room))
        except ValueError as ve:
            return jsonify(success=False, message=str(ve))
        prev_state = room_data.get("cleaning_status")

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

        # Cache-bypass: the refresh button appends ?_t=<ts> (or ?fresh=1) to
        # force a live read. invalidate_rooms_and_totals() (monkey-patched
        # above) clears the rooms, totals AND /get_data payload caches, so the
        # payload below is recomputed fresh from Firestore.
        if request.args.get("_t") or request.args.get("fresh"):
            invalidate_rooms_and_totals()

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

        # ── GST month lock ────────────────────────────────────────────────────
        # A locked month's books are FROZEN. Editing a payment row (method,
        # date, amount) rewrites the filed month's Cash/UPI columns in the
        # CA workbook and regenerates a filed invoice's PDF — history must
        # not change after GSTR-1 is filed. Block edits that touch a payment
        # dated in a locked month, or that would MOVE a payment into one.
        _lock_periods = set()
        _old_period = (old_data.get("date") or "")[:7]
        if _old_period:
            _lock_periods.add(_old_period)
        if new_date:
            _lock_periods.add(new_date[:7])
        for _p in sorted(_lock_periods):
            if is_month_locked(_p):
                return jsonify(
                    success=False,
                    code="MONTH_LOCKED",
                    message=(f"GST period {_p} is locked (GSTR-1 filed) — "
                             f"payment records of that month cannot be edited. "
                             f"If a correction is unavoidable, an admin must "
                             f"unlock the month first (Bills tab → lock icon), "
                             f"and the change must be re-declared to your CA."),
                ), 409

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

        # (b2) An ADD-ON is a charge, not a receipt, and this route only
        # knows how to move receipts.
        #
        # get_stay_payments renders any cash/online add-on as an editable row
        # (it filters only expense/discount and cash/online), so "Water 2L
        # Rs.60" shows up in Payment History looking exactly like a payment.
        # Editing it here moved three stores in three different directions:
        #
        #   * the payments doc amount changed, so the BILL now charges the new
        #     figure and credits it as received;
        #   * step 3 below applied balance += (old - new), but a cash/online
        #     add-on never touched the balance when it was created, so that
        #     invents money — editing Rs.60 to Rs.80 left a phantom Rs.20
        #     CREDIT on a room that owed nothing;
        #   * room.add_ons was not touched at all, so the counter UI, the
        #     balance preview and the Rs.999 snap kept using the old price
        #     while the invoice used the new one.
        #
        # /update_add_on already does all of this correctly and moves both
        # stores together, so charges go there. Mirrors the USE_SERVICE_VOID
        # guard in /delete_stay_payment.
        if old_data.get("type") == "addon":
            _room_id_chk = str(old_data.get("room", ""))
            _rsnap = rooms_ref.document(_room_id_chk).get() if _room_id_chk else None
            if _rsnap is not None and _rsnap.exists \
                    and (_rsnap.to_dict() or {}).get("status") == "occupied":
                return jsonify(
                    success=False,
                    code="USE_SERVICE_EDIT",
                    message=("This is a service charge, not a payment. Change "
                             "it with Edit next to the service itself — that "
                             "also updates the guest's balance and the bill."),
                ), 409
            # Checked-out stay: room.add_ons is no longer live, so there is no
            # second store to drift and no balance to corrupt. Allow the edit,
            # but never let step 3 touch a balance for a charge.

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

        # 3. If amount changed, adjust room balance (only if room still
        #    occupied). Receipts only — a charge row is refused above while the
        #    room is live, and on a checked-out stay there is no balance to
        #    move. Without this second check the "guest paid less than
        #    recorded" reasoning would still fire on an add-on and invent a
        #    balance the stay never had.
        if (new_amount is not None and new_amount != old_amount
                and old_data.get("type") != "addon"):
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

        # Re-stamp the room's denormalized stay sums (register fast path) —
        # an edited amount/method must be reflected in the stamped totals.
        _agg_sid = old_data.get("stay_id")
        if _agg_sid:
            import threading as _th
            _th.Thread(
                target=payment_service.refresh_room_stay_aggregates,
                args=(_agg_sid,), daemon=True,
            ).start()

        # If the CHECK-IN payment's date changed, the stay moved to a different
        # day — re-rank BOTH the old and new day's serials from 1 so the #
        # column stays a clean check-in-time sequence (and the day the stay
        # left no longer has a gap at the top).
        try:
            _is_checkin_pay = (old_data.get("transaction_type") in
                               ("fresh_checkin", "booking_conversion"))
            _old_d = (old_data.get("date") or "")[:10]
            _new_d = (new_date or "")[:10]
            if _is_checkin_pay and _new_d and _new_d != _old_d:
                from config import renumber_day_serials
                for _d in {_old_d, _new_d}:
                    if _d:
                        try:
                            renumber_day_serials(_d)
                        except Exception as _re:
                            logger.warning(f"renumber_day_serials({_d}) failed: {_re}")
        except Exception as _e:
            logger.warning(f"update_stay_payment renumber hook failed: {_e}")

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
        #
        # That reasoning holds for a RECEIPT and is exactly backwards for a
        # CHARGE. An add-on row is a charge: "Water 2L ₹60" on the balance
        # means the guest OWES ₹60. Deleting it should take ₹60 off the
        # balance, not add ₹60 on — the old code moved it the wrong way, a
        # ₹120 error on a ₹60 line. For a cash/online add-on it was worse
        # still: that charge never touched the balance when it was created,
        # so any balance adjustment on delete invents money.
        #
        # Deleting an add-on also left the matching entry in room.add_ons, so
        # the charge disappeared from the guest's bill (built from payments)
        # while the room's balance and the ₹999 snap still counted it.
        #
        # There is already a route that does all of this correctly and moves
        # both stores in one transaction, so charges are sent there instead of
        # being half-handled here.
        _is_charge = (old_data.get("type") == "addon")

        if _is_charge:
            room_snap = rooms_ref.document(room_id).get() if room_id else None
            if room_snap is not None and room_snap.exists \
                    and (room_snap.to_dict() or {}).get("status") == "occupied":
                return jsonify(
                    success=False,
                    code="USE_SERVICE_VOID",
                    message=("This is a service charge, not a payment. Remove it "
                             "with Delete next to the service itself — that also "
                             "takes it off the guest's balance and off the bill."),
                ), 409
            # Checked-out stay: no live balance to correct, so the delete is
            # allowed. The balance block below is skipped for charges.

        if room_id and old_amount > 0 and not _is_charge:
            room_snap = rooms_ref.document(room_id).get()
            if room_snap.exists and room_snap.to_dict().get("status") == "occupied":
                # Increment for the same reason /add_on now uses it: this read
                # and the commit are not atomic together.
                current_balance = int(room_snap.to_dict().get("balance", 0))
                batch.update(rooms_ref.document(room_id),
                             {"balance": firestore.Increment(old_amount)})
                logger.info(
                    f"delete_stay_payment: room {room_id} balance adjusted "
                    f"{current_balance} → {current_balance + old_amount} "
                    f"(deleted receipt {old_amount})"
                )

        batch.commit()
        invalidate_rooms_and_totals()

        # Re-stamp the room's denormalized stay sums (register fast path) —
        # the deleted row must disappear from the stamped totals too.
        _agg_sid = old_data.get("stay_id")
        if _agg_sid:
            import threading as _th
            _th.Thread(
                target=payment_service.refresh_room_stay_aggregates,
                args=(_agg_sid,), daemon=True,
            ).start()

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

    Body: { room: str, room_clean?: bool, bathroom_clean?: bool }

    Only the flags present in the body are updated; any omitted flag is
    left untouched. This is important because the card icons and the
    single-toggle in the checkout modal send just one flag at a time.
    Rebuilding the whole service_cleaning map here would reset the
    unsent flag to False and make both icons vanish on the next refresh.
    """
    try:
        data = request.json or {}
        room = data.get("room", "")
        if not room:
            return jsonify(success=False, message="room is required"), 400

        room_clean_raw     = data.get("room_clean", None)
        bathroom_clean_raw = data.get("bathroom_clean", None)

        if room_clean_raw is None and bathroom_clean_raw is None:
            return jsonify(
                success=False,
                message="At least one of room_clean or bathroom_clean is required",
            ), 400

        room_doc = rooms_ref.document(str(room)).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found"), 404

        # Use dotted field paths so only the specified sub-field(s) change;
        # the other flag and the rest of the map are preserved by Firestore.
        update = {
            "service_cleaning.requested_at":
                datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
        }
        if room_clean_raw is not None:
            update["service_cleaning.room"] = bool(room_clean_raw)
        if bathroom_clean_raw is not None:
            update["service_cleaning.bathroom"] = bool(bathroom_clean_raw)

        rooms_ref.document(str(room)).update(update)
        invalidate_rooms_and_totals()
        return jsonify(success=True, message="Housekeeping flags updated")
    except Exception as e:
        logger.error(f"toggle_housekeeping error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {e}"), 500
