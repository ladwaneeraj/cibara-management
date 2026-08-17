"""Booking management routes"""
from flask import Blueprint, request, jsonify
from datetime import datetime, timedelta
import uuid
from firebase_admin import firestore
from config import (
    db, bookings_ref, logs_ref, totals_ref, IST, logger,
    invalidate_rooms_and_totals,
    rooms_ref, get_next_serial_number, store_transaction_metadata, send_whatsapp_message,
    settlements_ref, ota_settlements_ref,  # logs_ref kept for whatsapp_messages only
    create_cancellation_charge_bill,
)
from services import payment_service, customer_service, bills_service, expense_service
from services.auth_service import requires_permission
from services.audit_log import write_log, attribution_create, attribution_update, _safe_user

bookings_bp = Blueprint('bookings', __name__)

# Fix 6: whitelist of accepted payment method values
VALID_PAYMENT_METHODS = {"cash", "upi", "card", "online", "balance", "ota", "already_paid", "bank_settlement"}

@bookings_bp.route("/get_bookings", methods=["GET"])
def get_bookings():
    try:
        # Only fetch bookings from the last 60 days onward (active + future + recent).
        # Older cancelled/checked-out bookings are not needed in the UI.
        cutoff = (datetime.now(IST) - timedelta(days=60)).strftime("%Y-%m-%d")
        bookings_stream = (
            bookings_ref
            .where("check_in_date", ">=", cutoff)
            .stream()
        )
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

@bookings_bp.route("/get_upcoming_bookings", methods=["GET"])
def get_upcoming_bookings():
    """
    Return a compact map of {room: <booking>} for bookings whose check-in
    is within the next 24 hours (or already overdue) and which are not
    cancelled / checked-out. Used by the room-grid to drive the small
    arrival-indicator dot on each room card.

    Contract (consumed by static/script.js around line 573):
        upcoming[<room>] = {
            booking_id, guest_name, name, check_in_date, check_in_time,
            check_out_date, status, paid_amount, total_amount,
            hours_until,     # float; negative when the booking is overdue
        }

    Single object per room (not an array). When multiple upcoming
    bookings exist for the same room we return the CLOSEST one — the
    indicator is meant to flag "what's about to arrive", so the nearest
    future check-in (or the most overdue, if all are past) is the
    relevant one. Bookings >24h out are filtered out server-side so the
    dot doesn't show indefinitely for far-future reservations (the bug
    where every room with any future booking showed a blue dot).

    Response: {success: true, upcoming: {"205": {...}, "207": {...}}}
    """
    try:
        now_dt = datetime.now(IST)
        today = now_dt.strftime("%Y-%m-%d")
        # Look up to yesterday so overdue check-ins (yesterday's date,
        # not yet checked in) still surface as a red/pulsing dot.
        yesterday = (now_dt - timedelta(days=1)).strftime("%Y-%m-%d")

        upcoming = {}
        q = bookings_ref.where("check_in_date", ">=", yesterday)
        for snap in q.stream():
            b = snap.to_dict() or {}
            status = (b.get("status") or "").lower()
            if status in ("cancelled", "checked_out"):
                continue
            room = str(b.get("room") or "")
            if not room:
                continue

            # Compute hours_until from check_in_date + check_in_time.
            # Time is optional in the schema; default to noon if missing
            # so we don't accidentally treat "today" as midnight.
            cd = (b.get("check_in_date") or "").strip()
            ct = (b.get("check_in_time") or "").strip()
            if not cd:
                continue
            try:
                if ct:
                    # check_in_time may arrive as "HH:MM" or "HH:MM:SS";
                    # accept both. Anything else falls through to noon.
                    try:
                        ci_dt_naive = datetime.strptime(f"{cd} {ct}", "%Y-%m-%d %H:%M")
                    except ValueError:
                        ci_dt_naive = datetime.strptime(f"{cd} {ct}", "%Y-%m-%d %H:%M:%S")
                else:
                    ci_dt_naive = datetime.strptime(f"{cd} 12:00", "%Y-%m-%d %H:%M")
            except ValueError:
                # Malformed date — skip; better no dot than a wrong one.
                continue
            # IST is a pytz timezone. Use .localize(), NOT .replace(tzinfo=...)
            # — pytz's tzinfo can return LMT (+05:53:28) when applied via
            # replace, which drifts hours_until by ~23 minutes. Matches the
            # convention used everywhere else in this codebase.
            ci_dt = IST.localize(ci_dt_naive)

            hours_until = (ci_dt - now_dt).total_seconds() / 3600.0

            # 24-hour window. Allow modestly negative values (overdue
            # check-ins) up to -24h so the red dot still appears for
            # missed arrivals from the last day; older overdue bookings
            # are likely abandoned and shouldn't clutter the grid.
            if hours_until > 24 or hours_until < -24:
                continue

            row = {
                "booking_id":     snap.id,
                "guest_name":     b.get("guest_name", ""),
                "name":           b.get("guest_name", ""),   # frontend reads either
                "check_in_date":  cd,
                "check_in_time":  ct,
                "check_out_date": b.get("check_out_date", ""),
                "status":         status,
                "paid_amount":    b.get("paid_amount", 0),
                "total_amount":   b.get("total_amount", 0),
                "hours_until":    round(hours_until, 2),
            }

            # Keep only the closest upcoming booking per room. "Closest"
            # = smallest absolute hours_until — that surfaces overdue
            # arrivals over future ones when both exist.
            existing = upcoming.get(room)
            if existing is None or abs(row["hours_until"]) < abs(existing["hours_until"]):
                upcoming[room] = row

        return jsonify(success=True, upcoming=upcoming, count=len(upcoming))
    except Exception as e:
        logger.error(f"get_upcoming_bookings error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


@bookings_bp.route("/get_upcoming_bookings_list", methods=["GET"])
def get_upcoming_bookings_list():
    """
    Return CONFIRMED bookings whose check-in is today or later (IST),
    sorted soonest-first. Unlike /get_upcoming_bookings (a 24h room-keyed
    map for the room-grid arrival dots), this is a full list — today's
    arrivals plus all future ones — for the Bookings "Upcoming" view and for
    quick terminal checks.

    Response: {success, count, bookings:[...]} where each booking includes
    booking_source so MMT arrivals are identifiable.
    """
    try:
        debug = request.args.get("debug")
        # ?include_cancelled=1 shows cancelled/checked-out too (for verifying
        # what's in the DB); default hides them.
        include_cancelled = request.args.get("include_cancelled")
        today = datetime.now(IST).strftime("%Y-%m-%d")

        def _norm_date(v):
            """Normalise a stored check_in_date to 'YYYY-MM-DD' for comparison.
            Handles plain ISO strings, datetime/Timestamp objects, and a few
            common alternate formats so a today booking is never missed on a
            format quirk."""
            if not v:
                return ""
            if hasattr(v, "strftime"):           # datetime / Firestore Timestamp
                try:
                    return v.strftime("%Y-%m-%d")
                except Exception:
                    return ""
            s = str(v).strip()
            if len(s) >= 10 and s[4] == "-" and s[7] == "-":
                return s[:10]                     # already ISO 'YYYY-MM-DD...'
            for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%d %b %Y", "%d %b '%y"):
                try:
                    return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
                except ValueError:
                    continue
            return s  # last resort — compared as-is

        # Stream the whole collection and filter in Python. This is bulletproof
        # against a today booking being missed because its date was stored in a
        # non-ISO form or its status differs in case. The bookings collection
        # for a lodge is small; if it ever grows large, swap to a bounded
        # check_in_date range query.
        EXCLUDED = {"cancelled", "checked_out", "no_show"}
        out, status_breakdown = [], {}
        for d in bookings_ref.stream():
            b = d.to_dict() or {}
            ci = _norm_date(b.get("check_in_date"))
            if not ci or ci < today:             # today or future only
                continue
            status = (b.get("status") or "").strip().lower()
            status_breakdown[status] = status_breakdown.get(status, 0) + 1
            if status in EXCLUDED and not include_cancelled:  # hide cancelled / finished
                continue
            b["booking_id"] = d.id
            b["check_in_date"] = ci
            out.append(b)

        out.sort(key=lambda x: (x.get("check_in_date", ""),
                                x.get("check_in_time", "")))
        resp = {"success": True, "count": len(out), "today": today, "bookings": out}
        if debug:
            resp["status_breakdown"] = status_breakdown
        return jsonify(**resp)
    except Exception as e:
        logger.error(f"get_upcoming_bookings_list error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


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
            "is_ac": bool(booking_data.get("is_ac", False)),
            "rate_per_night": int(booking_data.get("rate_per_night") or 0) or None,
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

        # ── Attribution — universal + business-friendly bookedBy ─────────────
        _book_user = (_safe_user() or {}).get("userId") or "system"
        booking.update(attribution_create())
        booking["bookedBy"] = _book_user

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
        write_log("booking.create", target_collection="bookings", target_id=booking_id)
        return jsonify(success=True, booking_id=booking_id, message="Booking created successfully")
        
    except Exception as e:
        logger.error(f"Error creating booking: {str(e)}")
        return jsonify(success=False, message=f"Error creating booking: {str(e)}")

@bookings_bp.route("/create_multi_booking", methods=["POST"])
def create_multi_booking():
    """Create several room-bookings that share one stay (same dates, same
    check-in time) in a single submission — e.g. one group taking 4 Deluxe
    + 3 Single rooms with different guests and prices. Each room still
    becomes its own booking document (so checkout/billing/ledger logic
    downstream doesn't need to know about groups at all); they're tied
    together only by a shared group_booking_id for reference. MMT/Agoda
    (prepaid OTA) sources aren't supported here — those need per-booking
    commission fields that this flow doesn't collect; use the regular
    New Booking form for those."""
    try:
        data = request.json or {}
        rooms_in = data.get("rooms")
        if not isinstance(rooms_in, list) or len(rooms_in) < 2:
            return jsonify(success=False, message="Provide at least 2 rooms for a multi-room booking")
        if len(rooms_in) > 20:
            return jsonify(success=False, message="Too many rooms in one submission (max 20)")

        check_in_date  = data.get("check_in_date")
        check_in_time  = data.get("check_in_time")
        check_out_date = data.get("check_out_date")
        booking_source = data.get("booking_source", "normal")
        payment_method = data.get("payment_method", "cash")
        notes          = data.get("notes", "")

        for field_name, value in (("check_in_date", check_in_date),
                                   ("check_in_time", check_in_time),
                                   ("check_out_date", check_out_date)):
            if not value:
                return jsonify(success=False, message=f"Missing required field: {field_name}")

        if booking_source in ("mmt", "agoda"):
            return jsonify(success=False, message="MMT/Agoda bookings aren't supported in multi-room booking — use the regular New Booking form for those")

        if payment_method not in VALID_PAYMENT_METHODS:
            return jsonify(success=False, message=f"Invalid payment method: {payment_method}")

        try:
            check_in  = datetime.strptime(check_in_date, "%Y-%m-%d")
            check_out = datetime.strptime(check_out_date, "%Y-%m-%d")
        except ValueError:
            return jsonify(success=False, message="Invalid date format. Use YYYY-MM-DD")
        if check_out <= check_in:
            return jsonify(success=False, message="Check-out date must be after check-in date")

        seen_rooms = set()
        parsed_rooms = []
        for idx, r in enumerate(rooms_in, start=1):
            room = r.get("room")
            guest_name = str(r.get("guest_name", "")).strip()
            guest_mobile = str(r.get("guest_mobile", "")).strip()

            if not room:
                return jsonify(success=False, message=f"Room #{idx}: room is required")
            if room in seen_rooms:
                return jsonify(success=False, message=f"Room {room} is selected more than once")
            seen_rooms.add(room)
            if not guest_name:
                return jsonify(success=False, message=f"Room {room}: guest name is required")
            if not guest_mobile:
                return jsonify(success=False, message=f"Room {room}: guest mobile is required")

            try:
                total_amount = int(r.get("total_amount"))
            except (TypeError, ValueError):
                return jsonify(success=False, message=f"Room {room}: total amount is required")
            if total_amount < 0:
                return jsonify(success=False, message=f"Room {room}: total amount cannot be negative")

            try:
                advance = int(r.get("advance") or 0)
            except (TypeError, ValueError):
                return jsonify(success=False, message=f"Room {room}: advance must be a number")
            if advance < 0:
                return jsonify(success=False, message=f"Room {room}: advance cannot be negative")
            if advance > total_amount:
                return jsonify(success=False, message=f"Room {room}: advance (₹{advance}) cannot exceed its total (₹{total_amount})")

            parsed_rooms.append({
                "room": room,
                "guest_name": guest_name,
                "guest_mobile": guest_mobile,
                "guest_count": int(r.get("guest_count") or 1),
                "rate_per_night": int(r.get("rate_per_night") or 0) or None,
                "total_amount": total_amount,
                "advance": advance,
                "is_ac": bool(r.get("is_ac", False)),
            })

        # Same overlap check as /check_availability, scoped to just the
        # rooms being requested — reject the whole submission if any of
        # them are already booked/occupied for this date range.
        bookings_stream = (
            bookings_ref
            .where("check_out_date", ">=", check_in.strftime("%Y-%m-%d"))
            .where("check_in_date",  "<=", check_out.strftime("%Y-%m-%d"))
            .stream()
        )
        conflicting = set()
        for booking_doc in bookings_stream:
            b = booking_doc.to_dict()
            if b.get("status") in ("cancelled", "checked_in"):
                continue
            if b.get("room") not in seen_rooms:
                continue
            b_ci = datetime.strptime(b["check_in_date"], "%Y-%m-%d")
            b_co = datetime.strptime(b["check_out_date"], "%Y-%m-%d")
            if check_in < b_co and check_out > b_ci:
                conflicting.add(b["room"])

        today = datetime.now(IST).replace(hour=0, minute=0, second=0, microsecond=0)
        if check_in.date() == today.date():
            for room_doc in rooms_ref.stream():
                if room_doc.id in seen_rooms and room_doc.to_dict().get("status") == "occupied":
                    conflicting.add(room_doc.id)

        if conflicting:
            return jsonify(success=False, message="Room(s) already booked for these dates: " + ", ".join(sorted(conflicting)))

        group_booking_id = str(uuid.uuid4())
        _book_user = (_safe_user() or {}).get("userId") or "system"
        booking_date_str = datetime.now(IST).strftime("%Y-%m-%d")
        now_time_str = datetime.now(IST).strftime("%H:%M")

        batch = db.batch()
        created_ids = []
        total_advance = 0

        for pr in parsed_rooms:
            booking_id = str(uuid.uuid4())
            created_ids.append(booking_id)
            booking = {
                "room": pr["room"],
                "guest_name": pr["guest_name"],
                "guest_mobile": pr["guest_mobile"],
                "booking_date": booking_date_str,
                "check_in_date": check_in_date,
                "check_in_time": check_in_time,
                "check_out_date": check_out_date,
                "status": "confirmed",
                "booking_source": booking_source,
                "payment_source": "hotel",
                "total_amount": pr["total_amount"],
                "paid_amount": pr["advance"],
                "balance": pr["total_amount"] - pr["advance"],
                "is_ac": pr["is_ac"],
                "rate_per_night": pr["rate_per_night"],
                "payment_method": payment_method,
                "notes": notes,
                "photo_path": None,
                "guest_count": pr["guest_count"],
                "group_booking_id": group_booking_id,
            }
            booking.update(attribution_create())
            booking["bookedBy"] = _book_user

            batch.set(bookings_ref.document(booking_id), booking)
            total_advance += pr["advance"]

        if total_advance > 0:
            batch.update(totals_ref.document('current_totals'), {
                payment_method: firestore.Increment(total_advance),
                "advance_bookings": firestore.Increment(total_advance),
            })

        batch.commit()
        invalidate_rooms_and_totals()

        # Payment ledger rows — one per room with an advance, same shape as
        # the single-room flow so the checkout-time stay-payment lookup
        # (query_payments_for_stay) finds them.
        for pr, booking_id in zip(parsed_rooms, created_ids):
            if pr["advance"] > 0:
                payment_service.write_payment({
                    "room": pr["room"], "name": pr["guest_name"],
                    "amount": pr["advance"], "method": payment_method,
                    "type": "booking_advance",
                    "date": booking_date_str,
                    "time": now_time_str,
                    "booking_id": booking_id, "transaction_type": "booking_advance",
                    "mobile": pr["guest_mobile"],
                    "stay_checkin_date": check_in_date,
                })

        logger.info(f"Multi-room booking created: group {group_booking_id}, {len(created_ids)} rooms")
        write_log("booking.create_multi", target_collection="bookings", target_id=group_booking_id)

        # Best-effort WhatsApp confirmation — one consolidated message for
        # the whole group, sent to whoever's on the first room (the "lead"
        # contact for the group). A WhatsApp failure here must never fail
        # the booking itself — the rooms are already committed — so this is
        # deliberately isolated in its own try/except.
        try:
            NL = chr(10)
            lead = parsed_rooms[0]
            phone_number = str(lead["guest_mobile"]).strip()
            if phone_number.startswith("0"):
                phone_number = phone_number[1:]
            if not phone_number.startswith("91"):
                phone_number = f"91{phone_number}"

            nights = (check_out - check_in).days
            grand_total = sum(pr["total_amount"] for pr in parsed_rooms)
            grand_advance = sum(pr["advance"] for pr in parsed_rooms)
            room_lines = NL.join(
                f"• Room {pr['room']} — {pr['guest_name']} — ₹{pr['total_amount']} (adv ₹{pr['advance']})"
                for pr in parsed_rooms
            )

            message_lines = [
                "🏨 *GROUP BOOKING CONFIRMATION*",
                "",
                f"Hello {lead['guest_name']},",
                "",
                f"Your group booking of {len(parsed_rooms)} rooms has been confirmed!",
                "",
                "📋 *Rooms:*",
                room_lines,
                "",
                f"🗓️ Check-in: {check_in.strftime('%d %b %Y')} ({check_in_time})",
                f"🗓️ Check-out: {check_out.strftime('%d %b %Y')}",
                f"🌙 Duration: {nights} night{'s' if nights != 1 else ''}",
                "",
                "💰 *Payment:*",
                f"• Grand Total: ₹{grand_total}",
                f"• Total Advance Paid: ₹{grand_advance}",
                f"• Balance Due: ₹{grand_total - grand_advance}",
                "",
                "If you have any questions, please feel free to contact us.",
                "",
                "Thank you for choosing us! 🙏",
            ]
            group_message = NL.join(message_lines)

            wa_sent = send_whatsapp_message(phone_number, group_message)
            if not wa_sent:
                logger.warning(f"create_multi_booking: WhatsApp group confirmation send returned falsy for group {group_booking_id}")
        except Exception as _wa_e:
            logger.warning(f"create_multi_booking: WhatsApp group confirmation failed for group {group_booking_id}: {_wa_e}")

        return jsonify(success=True, group_booking_id=group_booking_id, booking_ids=created_ids,
                        message=f"{len(created_ids)} bookings created successfully")


    except Exception as e:
        logger.error(f"Error creating multi-room booking: {str(e)}")
        return jsonify(success=False, message=f"Error creating multi-room booking: {str(e)}")

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

        # AC flag — only meaningful for rooms 200-206. We always coerce to
        # bool so the doc never holds truthy strings ("true"/"false"). If
        # the caller didn't send the field we leave the existing value
        # untouched (back-compat with older clients that don't yet send it).
        # When the caller switches to a non-AC room we force the flag off
        # so an old isAC=true can't survive on a room that can't have AC.
        AC_ROOMS = {"200", "201", "202", "203", "204", "205", "206"}
        if "is_ac" in booking_data:
            new_room = str(booking.get("room", ""))
            booking["is_ac"] = bool(booking_data["is_ac"]) if new_room in AC_ROOMS else False

        if "total_amount" in booking_data:
            booking["total_amount"] = int(booking_data["total_amount"])
            booking["balance"] = booking["total_amount"] - booking["paid_amount"]

        # Attribution stamp on every booking edit
        booking.update(attribution_update())

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
        write_log("booking.update", target_collection="bookings",
                  target_id=str(booking.get("id") or booking.get("booking_id") or ""))
        return jsonify(success=True, booking=booking, message="Booking updated successfully")
        
    except Exception as e:
        logger.error(f"Error updating booking: {str(e)}")
        return jsonify(success=False, message=f"Error updating booking: {str(e)}")

@bookings_bp.route("/cancel_booking", methods=["POST"])
def cancel_booking():
    """
    Cancel an advance booking.

    Accepts (in JSON body):
      booking_id        : str   — the booking to cancel
      refund_amount     : int   — amount being refunded to the guest (>= 0)
      refund_method     : str   — "cash" | "online" (only used when refund > 0)
      reason            : str   — free-text cancellation reason
      retain_as_charge  : bool  — when true, the (paid_amount - refund_amount)
                                  difference is treated as a cancellation
                                  forfeiture and a separate Tax Invoice is
                                  minted at SAC 999794 / 18% per Schedule II.
                                  When false (default — backwards compatible)
                                  the retained amount stays on the books as
                                  accommodation revenue, which is the legacy
                                  behaviour.

    Returns the new bill_number in the response when retain_as_charge=True
    so the UI can show / print it.
    """
    try:
        booking_data = request.json
        booking_id = booking_data.get("booking_id")

        booking_doc = bookings_ref.document(booking_id).get()
        if not booking_doc.exists:
            return jsonify(success=False, message="Invalid booking ID")

        booking = booking_doc.to_dict()
        batch = db.batch()

        refund_amount = int(booking_data.get("refund_amount", 0))
        if refund_amount < 0:
            return jsonify(success=False, message="Refund amount cannot be negative")

        paid_amount = int(booking.get("paid_amount", 0) or 0)
        if refund_amount > paid_amount:
            return jsonify(
                success=False,
                message=f"Refund amount Rs.{refund_amount} exceeds paid amount Rs.{paid_amount}",
            )

        retain_as_charge = bool(booking_data.get("retain_as_charge", False))
        retained_amount  = paid_amount - refund_amount

        if refund_amount > 0:
            refund_method = booking_data.get("refund_method", "cash")
            if refund_method not in VALID_PAYMENT_METHODS:
                return jsonify(success=False, message=f"Invalid refund method: {refund_method}")
            batch.update(totals_ref.document('current_totals'),
                         {"refunds": firestore.Increment(refund_amount)})
            booking["paid_amount"] -= refund_amount
            booking["balance"] = booking["total_amount"] - booking["paid_amount"]

        booking["status"] = "cancelled"
        booking["cancellation_date"] = datetime.now(IST).strftime("%Y-%m-%d")
        booking["cancellation_reason"] = booking_data.get("reason", "")
        booking["cancelledBy"] = (_safe_user() or {}).get("userId") or "system"
        booking["retain_as_charge"] = retain_as_charge
        booking["retained_amount"]  = retained_amount if retain_as_charge else 0
        booking.update(attribution_update())

        batch.set(bookings_ref.document(booking_id), booking)
        batch.commit()
        invalidate_rooms_and_totals()

        # Refund payment row.
        if refund_amount > 0:
            payment_service.write_payment({
                "room": booking["room"], "name": booking["guest_name"],
                "amount": refund_amount,
                "method": booking_data.get("refund_method", "cash"),
                "type": "booking_cancel_refund",
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "time": datetime.now(IST).strftime("%H:%M"),
                "booking_id": booking_id,
                "transaction_type": "booking_cancel_refund",
            })

        # Cancellation-forfeiture invoice (SAC 999794 / 18%).
        cancel_charge_bill = None
        if retain_as_charge and retained_amount > 0:
            try:
                cancel_charge_bill = create_cancellation_charge_bill(
                    booking_id=booking_id,
                    booking_data=booking,
                    retained_amount=retained_amount,
                    cancel_dt=datetime.now(IST),
                    actor=(_safe_user() or {}).get("userId"),
                )
                if cancel_charge_bill:
                    write_log(
                        "booking.cancel.charge",
                        target_collection="bills",
                        target_id=str(cancel_charge_bill.get("stay_id") or ""),
                        metadata={
                            "booking_id": booking_id,
                            "retained_amount": retained_amount,
                            "bill_number": cancel_charge_bill.get("bill_number"),
                            "sac": "999794",
                            "gst_rate": 18,
                        },
                    )
                    # Auto-generate the PDF in a background thread so the
                    # cancellation invoice is immediately downloadable from
                    # the Bills tab without the operator having to open
                    # and re-save it. Best-effort; failure is logged but
                    # does not block the cancellation.
                    try:
                        from routes.billing import auto_generate_bill_pdf as _autopdf
                        import threading as _thr
                        _thr.Thread(
                            target=_autopdf,
                            args=(cancel_charge_bill.get("stay_id"), cancel_charge_bill),
                            daemon=True,
                        ).start()
                    except Exception as _pe:
                        logger.warning(f"cancel_booking: cancel-charge PDF auto-gen skipped: {_pe}")
            except Exception as _ce:
                logger.error(f"cancel_booking: forfeiture bill failed: {_ce}",
                             exc_info=True)

        logger.info(
            f"Booking cancelled: {booking_id} refund=Rs.{refund_amount} "
            f"retain_as_charge={retain_as_charge} "
            f"retained=Rs.{retained_amount if retain_as_charge else 0} "
            f"charge_bill={(cancel_charge_bill or {}).get('bill_number')}"
        )
        write_log(
            "booking.cancel",
            target_collection="bookings",
            target_id=str(booking_id or ""),
            metadata={
                "refund_amount": refund_amount,
                "retain_as_charge": retain_as_charge,
                "retained_amount": retained_amount if retain_as_charge else 0,
                "charge_bill_number": (cancel_charge_bill or {}).get("bill_number"),
            },
        )
        return jsonify(
            success=True,
            message="Booking cancelled successfully",
            charge_bill_number=(cancel_charge_bill or {}).get("bill_number"),
            charge_bill_id=(cancel_charge_bill or {}).get("stay_id"),
            retained_amount=retained_amount if retain_as_charge else 0,
        )

    except Exception as e:
        logger.error(f"Error cancelling booking: {str(e)}", exc_info=True)
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
        # Initialised up-front so a malformed `check_in_time` (which OTA/MMT
        # bookings can carry, e.g. "14:00:00" or "") can't leave this name
        # unbound. It is referenced again far below for `arrival_status`,
        # which runs AFTER batch.commit() — an unbound name there raised and
        # made an already-committed check-in return success=False.
        expected_datetime = None

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

        # Resolve PER-NIGHT room price. The booking doc stores `total_amount`
        # for the WHOLE stay (e.g. ₹1,400 for 2 nights @ ₹700). The per-night
        # rate the room is charged at = total_amount ÷ nights.
        #
        # We derive it from total ÷ nights as the PRIMARY source rather than a
        # stored `rate_per_night`, because a mis-captured rate_per_night (e.g.
        # the whole-stay ₹1,400 saved into the nightly field) would otherwise
        # be charged as ONE night's rent — the reported bug where a 2-night
        # ₹700 booking checked in at ₹1,400/night (balance 400 at check-in,
        # 1,800 after one renewal). total ÷ nights is always the true nightly
        # value and also correctly spreads any whole-stay discount across
        # nights. rate_per_night / total are only fallbacks when total or
        # nights are unusable. Resolution order:
        #   1. explicit `room_price` in the request (front-desk override)
        #   2. total_amount ÷ nights  (the per-night price — primary)
        #   3. booking.rate_per_night (if total/nights unusable)
        #   4. total_amount (last resort)
        # Nights is computed up-front — also needed for renewal_count below.
        _nights = 1
        try:
            _ci = datetime.strptime(booking["check_in_date"], "%Y-%m-%d")
            _co = datetime.strptime(booking["check_out_date"], "%Y-%m-%d")
            _nights = max((_co - _ci).days, 1)
        except Exception as _e:
            logger.warning(
                f"convert_booking_to_checkin: nights calc fell back to 1 "
                f"(booking_id={booking_id}, err={_e})"
            )

        _override_price = booking_data.get("room_price")
        if _override_price is not None:
            room_price = int(_override_price)
        else:
            _total = int(booking.get("total_amount") or 0)
            _stored_rate = booking.get("rate_per_night")
            if _total > 0 and _nights > 0:
                room_price = int(round(_total / _nights))     # per-night price
            elif _stored_rate and int(_stored_rate) > 0:
                room_price = int(_stored_rate)
            else:
                room_price = _total
        is_ac = False

        # Rooms 200-206 support AC; use stored booking flag or frontend override
        AC_ROOMS = {"200","201","202","203","204","205","206"}
        if str(room_number) in AC_ROOMS:
            if "is_ac" in booking:
                is_ac = bool(booking["is_ac"])
            elif "is_ac" in booking_data:
                is_ac = bool(booking_data["is_ac"])

        # ── Walk-in-style balance model ─────────────────────────────────────
        # Only Day 1's rent is on the room at check-in. Any prior advance
        # paid against the booking (booking.paid_amount) plus the conversion
        # payment (remaining_payment) are applied as credit against that
        # Day-1 rate. Subsequent nights are added to the balance only when
        # the operator manually clicks Renew Rent — exactly the same flow
        # as a walk-in stay.
        #
        # Why this beats pre-charging N nights up-front:
        #   1. Single mental model for booking + walk-in stays.
        #   2. Early check-out is handled by *not renewing* — no special
        #      "shorten stay" / "discount-as-hack" workflow needed for the
        #      common case. The existing refund flow handles any leftover
        #      credit naturally.
        #   3. Bill renderer's `days = renewal_count + 1` and room.balance
        #      stay in sync by construction.
        #
        # If the guest checks in via a 2-night booking with ₹1800 already
        # paid and a ₹900/night rate:
        #   - room.balance starts at  900 − 1800 = −900   (₹900 credit)
        #   - operator renews on Day 2 → balance becomes 0 (credit consumed)
        #   - guest checks out clean.
        # If the guest leaves Day 2 morning without renewing:
        #   - balance stays at −900, refund flow returns ₹900 to the guest.
        _prior_paid_against_booking = int(booking.get("paid_amount", 0) or 0)
        _total_paid_against_stay = _prior_paid_against_booking + remaining_payment
        _room_balance_at_checkin = room_price - _total_paid_against_stay
        # Negative balance is a legitimate credit — preserve the sign so the
        # operator can see it and the refund flow can act on it. The old
        # code clamped at zero, which silently lost the overpayment signal.

        # ── MMT (OTA) prepaid override ──────────────────────────────────────
        # MakeMyTrip collects the FULL stay tariff up front, so an MMT stay is
        # not a day-by-day walk-in: the hotel bills the whole stay now and the
        # room carries a zero balance (the guest owes the hotel nothing). We
        # pre-charge all nights (renewal_count = nights-1) so the checkout
        # bill computes the full room_charges_total, and record the tariff as
        # an "ota" payment after commit so the invoice nets to a zero balance.
        # MMT settles the net amount to the bank later (marked via
        # /mark_ota_settlement), which is when the commission expense is booked.
        _is_mmt = booking.get("booking_source") == "mmt"
        _renewal_count_at_checkin = 0
        _ota_prepaid = 0
        if _is_mmt:
            _ota_prepaid = int(
                booking.get("ota_total_amount") or booking.get("total_amount") or 0
            )
            _renewal_count_at_checkin = max(_nights - 1, 0)
            _room_balance_at_checkin = 0

        guest = {
            "name": booking["guest_name"],
            "mobile": booking["guest_mobile"],
            "price": room_price,
            "guests": booking["guest_count"],
            "payment": payment_method,
            "balance": _room_balance_at_checkin,
            "photo": booking.get("photo_path"),
            "isAC": is_ac
        }

        # Mint stay_id and create the draft bill — same lifecycle as /checkin
        # except that booking-converted bills are born invoiceable=true.
        #
        # Why pre-officialise: a confirmed booking that has been converted
        # is, operationally, an official stay — the operator already
        # collected advance payment and committed to the room. Forcing
        # the cash through the "pending → trigger fires on first online
        # payment" lifecycle made booking-advance cash invisible to the
        # deposit screen on cash-only stays (the common case for this
        # hotel). Setting invoiceable=true at create_draft makes the
        # banking hook below route each booking-advance cash row straight
        # to "eligible" with an RV, so the operator can include it in
        # a deposit on day one.
        stay_id = uuid.uuid4().hex
        bills_service.create_draft(
            room=room_number,
            guest=guest,
            checkin_time=checkin_datetime_str,
            stay_id=stay_id,
            booking_id=booking_id,
            source="booking_conversion",
            invoiceable=True,
            batch=batch,
        )

        # Attribution stamps so the room-history popover shows the full
        # trail (booked by → checked in by). bookedBy is propagated from
        # the booking doc; the front desk may differ from the original
        # booker. Stale cleaning fields are cleared — a new stay starts.
        _conv_attr = attribution_create()
        _conv_user = (_safe_user() or {}).get("userId") or "system"
        _booked_by = booking.get("bookedBy") or booking.get("createdBy") or _conv_user
        batch.update(rooms_ref.document(room_number), {
            "status": "occupied",
            "guest": guest,
            "checkin_time": checkin_datetime_str,
            "balance": _room_balance_at_checkin,
            "add_ons": [],
            # Carry the booking source onto the live room so the Register tab
            # shows "MMT" the moment the guest is checked in (the active-stay
            # rows are built from the room doc, not the not-yet-existent
            # completed bill). Defaults keep walk-ins as "normal"/"hotel".
            "booking_source": booking.get("booking_source", "normal"),
            "payment_source": booking.get("payment_source", "hotel"),
            # Same room-reuse hazard as booking_source. A stay-level GST
            # profile left on this room by the PREVIOUS occupant would be
            # picked up by create_bill_record and stamp their company GSTIN
            # on this guest's invoice. Cleared unconditionally: a booking
            # carries its own recipient_gstin, and create_bill_record reads
            # that in preference to anything on the room.
            "gst_profile": None,
            # Walk-in pattern: start on Day 1; operator renews each
            # subsequent day manually. Booked nights N>1 are NOT
            # pre-charged. See the long comment above the `guest` dict
            # for the rationale. EXCEPTION: MMT stays are fully prepaid via
            # the OTA, so all nights are pre-charged here (nights-1) and the
            # bill reflects the whole stay at once.
            "renewal_count": _renewal_count_at_checkin,
            "last_renewal_date": "",
            "last_renewal_time": None,
            # Pointer to the draft so /checkout finalizes it instead of
            # creating a second bill record.
            "active_bill_id": stay_id,
            # Attribution. cleanedBy / inspectedBy from the previous
            # cleaning cycle prepped this room for THIS stay — keep them
            # so the popover shows the full history chain. They're
            # overwritten naturally on the next cleaning/inspection.
            "bookedBy":      _booked_by,
            "bookedAt":      booking.get("createdAt") or _conv_attr.get("createdAt"),
            "lastCheckinBy": _conv_user,
            "lastCheckinAt": _conv_attr.get("createdAt"),
            # Per-stay fields — cleared so we don't carry the previous
            # stay's time-edit / checkout attribution into this one.
            "lastCheckinTimeEditBy": None,
            "lastCheckinTimeEditAt": None,
            "lastCheckoutBy": None,
            "lastCheckoutAt": None,
            # Universal attribution
            "createdBy":      _conv_attr.get("createdBy"),
            "createdAt":      _conv_attr.get("createdAt"),
            "lastModifiedBy": _conv_attr.get("lastModifiedBy"),
            "lastModifiedAt": _conv_attr.get("lastModifiedAt"),
        })

        # totals.balance reflects only money currently owed against
        # *already-charged* nights. Under the walk-in model that's Day-1
        # only; future nights get added to totals.balance when they're
        # actually renewed. Negative room balances (credits) don't
        # contribute — they're tracked on the room and consumed by
        # subsequent renewals or refunded at checkout.
        if _room_balance_at_checkin > 0:
            totals_update["balance"] = firestore.Increment(_room_balance_at_checkin)

        booking["status"] = "checked_in"
        booking["check_in_time"] = checkin_datetime_str
        booking["actual_checkin_time"] = current_datetime.strftime("%Y-%m-%d %H:%M")
        # Carry the new stay_id onto the booking so historical lookups can
        # resolve "what stay did this booking become".
        booking["stay_id"] = stay_id

        batch.set(bookings_ref.document(booking_id), booking)
        if totals_update:
            batch.update(totals_ref.document('current_totals'), totals_update)

        # ── B2: stamp stay_id onto prior booking advances atomically with the
        # conversion. Previously this happened AFTER batch.commit(), so a
        # Firestore blip could leave the advances orphaned w.r.t. the new
        # stay. Now the per-advance update is added to the same batch and
        # commits with everything else.
        #
        # Failure mode: if the query ITSELF raises (Firestore error before we
        # get a stream), we log + audit + flag advance_relink_pending=True
        # on the bill so a follow-up retry job can pick it up. We do NOT
        # block the conversion on this — check-in is a high-pressure path
        # and a relink that can be retried later is worth more than a hard
        # failure here.
        stay_key = f"{room_number}_{checkin_datetime_str}"
        relink_pending = False
        relink_count = 0
        # Banking-hook queue. Booking-advance payments were written via the
        # legacy `write_payment()` path at booking creation time — before a
        # stay_id existed — so they never went through the banking hook
        # and have no `deposit_eligibility` field. After we stamp stay_id
        # on them in this batch, we'll fire the hook on each so they
        # enter the cash-receipts lifecycle (cash → pending; online →
        # triggers invoiceability). Without this, booking-advance cash
        # is invisible to BOTH the deposit screen and the unofficial-cash
        # list — it falls into a no-field limbo and the operator loses
        # track of the money.
        _advance_banking_queue: list[tuple[str, str, str]] = []
        try:
            from google.cloud.firestore_v1.base_query import FieldFilter as _FF
            _payments_coll = db.collection("payments")
            for pdoc in _payments_coll.where(
                filter=_FF("booking_id", "==", booking_id)
            ).stream():
                pdata = pdoc.to_dict() or {}
                if pdata.get("type") in ("booking_advance", "booking_payment"):
                    batch.update(pdoc.reference, {
                        "stay_id":           stay_id,
                        "stay_room_key":     stay_key,
                        "stay_checkin_date": current_date,
                    })
                    relink_count += 1
                    # Capture for post-commit banking-hook firing. We only
                    # need (payment_id, method, prior_eligibility) — the
                    # hook decides what to do based on method, and we
                    # gate on prior_eligibility so re-runs of conversion
                    # don't regress an already-stamped doc.
                    _advance_banking_queue.append((
                        pdoc.reference.id,
                        (pdata.get("method") or "").lower().strip(),
                        (pdata.get("deposit_eligibility") or "").strip(),
                    ))
        except Exception as _re:
            relink_pending = True
            logger.warning(
                f"convert_booking_to_checkin: advance relink query failed for "
                f"booking_id={booking_id} ({_re}); flagging "
                f"advance_relink_pending on bill stay_id={stay_id}."
            )

        # If we flagged the bill for a retry, add the flag to the same batch
        # so it's visible immediately after commit.
        if relink_pending:
            from config import bills_ref as _bills_ref
            batch.update(_bills_ref.document(stay_id), {
                "advance_relink_pending": True,
                "advance_relink_booking_id": booking_id,
            })

        batch.commit()

        # ── Fire banking hooks on the just-relinked booking advances ────────
        # Must run AFTER batch.commit() so the stay_id stamps are durable
        # before the banking flow reads each payment. Idempotent: skipped
        # for any advance that already has a deposit_eligibility set (so
        # a second run of conversion, manual retry, etc. is safe).
        #
        # Behaviour:
        #   - cash advance:   stamps deposit_eligibility = "pending".
        #                     Later picked up by either the trigger
        #                     (an online payment hits the stay) or by
        #                     mark_unofficial_on_checkout (stay closes
        #                     without invoice), flipping to eligible or
        #                     excluded respectively.
        #   - online advance: fires the trigger immediately, which also
        #                     officialises any prior cash on this stay.
        #
        # Failures are logged but never raised — the conversion has
        # already succeeded and the advance can be retried via a
        # follow-up admin tool if needed.
        try:
            from services.banking import cash_receipts as _cr
            for (_pid, _pmethod, _peligibility) in _advance_banking_queue:
                if _peligibility:
                    # Already in the banking lifecycle — don't regress.
                    continue
                if _pmethod in ("cash",):
                    try:
                        _cr.issue_receipt_for_new_payment(
                            stay_id, _pid, method="cash"
                        )
                    except Exception as _bhe:
                        logger.warning(
                            f"convert_booking_to_checkin: banking hook "
                            f"failed for cash advance {_pid}: {_bhe}"
                        )
                elif _pmethod in ("online", "upi", "card", "bank_transfer"):
                    try:
                        _cr.issue_receipt_for_new_payment(
                            stay_id, _pid, method="online"
                        )
                    except Exception as _bhe:
                        logger.warning(
                            f"convert_booking_to_checkin: banking hook "
                            f"failed for online advance {_pid}: {_bhe}"
                        )
                # Other methods (ota, already_paid, balance, etc.) don't
                # participate in the cash-receipts lifecycle — intentional.
        except Exception as _bhe_outer:
            logger.warning(
                f"convert_booking_to_checkin: banking-hook pass failed "
                f"outer ({_bhe_outer}); stay_id={stay_id}, "
                f"queue_size={len(_advance_banking_queue)}"
            )

        # Fix 4: store_transaction_metadata AFTER batch commit
        store_transaction_metadata(room_number, current_date, serial_number, "booking_conversion")

        invalidate_rooms_and_totals()

        # Audit-log the relink outcome — visibility either way.
        try:
            write_log(
                "booking.advance_relink",
                target_collection="payments",
                target_id=str(stay_id),
                metadata={
                    "booking_id":   booking_id,
                    "stay_id":      stay_id,
                    "relinked":     relink_count,
                    "pending":      relink_pending,
                },
            )
        except Exception:
            pass
        if remaining_payment > 0:
            payment_service.write_payment_with_stay(stay_id, {
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
            payment_service.write_payment_with_stay(stay_id, {
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
            payment_service.write_payment_with_stay(stay_id, {
                "room": room_number, "name": booking["guest_name"],
                "amount": balance_after_payment, "method": "balance",
                "type": "booking_balance",
                "date": current_date, "time": current_time,
                "serial_number": serial_number, "booking_id": booking_id,
                "stay_room_key": stay_key,
                "transaction_type": "booking_conversion",
            })

        # (advance relink is now handled inside the batch above — B2)

        # ── MMT prepaid room payment ────────────────────────────────────────
        # Record the full OTA tariff as an "ota"-method payment on the stay.
        # This is NOT a front-desk receipt (it never counts in the cash/online
        # drawer tallies), but create_bill_record subtracts method="ota"
        # payments from the bill balance so the MMT room invoice nets to zero
        # — the guest owes the hotel nothing; MMT settles the net to the bank
        # later. Method "ota" is already whitelisted in VALID_PAYMENT_METHODS.
        if _is_mmt and _ota_prepaid > 0:
            payment_service.write_payment_with_stay(stay_id, {
                "room": room_number, "name": booking["guest_name"],
                "amount": _ota_prepaid, "method": "ota",
                "type": "ota_prepaid",
                "date": current_date, "time": current_time,
                "serial_number": serial_number, "booking_id": booking_id,
                "stay_room_key": stay_key,
                "transaction_type": "ota_prepaid",
                "mobile": booking["guest_mobile"],
                "platform": "mmt",
            })

        # Fix 7: sync=True so errors surface in logs rather than dying silently
        customer_service.upsert_customer({
            "name": booking["guest_name"],
            "mobile": booking["guest_mobile"],
        }, amount_paid=remaining_payment, sync=True)

        arrival_status = (
            "early"
            if (expected_datetime is not None and current_datetime < expected_datetime)
            else "on time"
        )

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
        
        # Only fetch bookings whose check_out_date is on or after our check_in,
        # and check_in_date is on or before our check_out — i.e. potential overlaps only.
        # This avoids streaming the whole collection. Add a small backward buffer (1 day)
        # so same-day bookings are always caught.
        query_from = (check_in - timedelta(days=1)).strftime("%Y-%m-%d")
        bookings_stream = (
            bookings_ref
            .where("check_out_date", ">=", check_in.strftime("%Y-%m-%d"))
            .where("check_in_date",  "<=", check_out.strftime("%Y-%m-%d"))
            .stream()
        )
        booked_rooms = set()

        for booking_doc in bookings_stream:
            booking = booking_doc.to_dict()

            if booking.get("status") in ["cancelled", "checked_in"]:
                continue

            booking_check_in  = datetime.strptime(booking["check_in_date"],  "%Y-%m-%d")
            booking_check_out = datetime.strptime(booking["check_out_date"], "%Y-%m-%d")

            if check_in < booking_check_out and check_out > booking_check_in:
                booked_rooms.add(booking["room"])

        # Read all rooms ONCE — reuse for both occupied-status check and full list
        today = datetime.now(IST).replace(hour=0, minute=0, second=0, microsecond=0)
        all_room_docs = list(rooms_ref.stream())

        if check_in.date() == today.date():
            for room_doc in all_room_docs:
                room_data = room_doc.to_dict()
                if room_data.get("status") == "occupied":
                    booked_rooms.add(room_doc.id)

        all_rooms      = [room_doc.id for room_doc in all_room_docs]
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


def apply_ota_settlement(booking_id, settlement_date, settlement_amount, *,
                         utr="", source="manual"):
    """
    Mark an MMT booking's settlement as received and record the money trail.

    Shared by the manual /mark_ota_settlement route and the automatic
    settlement-email ingestion, so both produce identical records. Performs
    its own validation + idempotency check, then writes:
      • booking.settlement_status = "received"
      • an ota_settlements doc
      • a bank_settlement payment (shows in the Transactions tab)
      • a booking_commission expense (commission + GST as ITC)

    Returns a dict: {ok, already, message, settlement_amount}. Never raises.
    `source` is stamped for audit ("manual" | "email"); `utr` is the bank
    transaction reference from the settlement email (HDFC CMS NEFT ref).
    """
    try:
        settlement_amount = float(settlement_amount or 0)
        if not booking_id or not settlement_date or settlement_amount <= 0:
            return {"ok": False, "already": False,
                    "message": "booking_id, settlement_date and a positive amount are required"}

        booking_doc = bookings_ref.document(booking_id).get()
        if not booking_doc.exists:
            return {"ok": False, "already": False, "message": "Booking not found"}

        booking = booking_doc.to_dict()
        _src = booking.get("booking_source")
        if _src not in ("mmt", "agoda"):
            return {"ok": False, "already": False,
                    "message": "Settlement is only applicable to OTA (MMT / Agoda) bookings"}
        # Human-readable platform label used on the payment / settlement rows.
        _platform_label = {"mmt": "MMT", "agoda": "Agoda"}.get(_src, _src.upper())
        if booking.get("settlement_status") == "received":
            return {"ok": True, "already": True,
                    "message": "Settlement already marked as received",
                    "settlement_amount": booking.get("settlement_amount")}

        # Update booking doc
        bookings_ref.document(booking_id).update({
            "settlement_status": "received",
            "settlement_date": settlement_date,
            "settlement_amount": settlement_amount,
            "settlement_utr": utr,
            "settlement_source": source,
        })

        # Write to ota_settlements collection (separate from hotel-side settle-later)
        settlement_entry = {
            "booking_id": booking_id,
            "platform": _src,
            "type": "bank_settlement",
            "room": booking.get("room", ""),
            "guest_name": booking.get("guest_name", ""),
            "net_receivable": booking.get("net_receivable", 0),
            "settlement_amount": settlement_amount,
            "settlement_date": settlement_date,
            "utr": utr,
            "source": source,
            "created_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M"),
        }
        ota_settlements_ref.add(settlement_entry)

        # Also write to payments collection for traceability (method="bank_settlement")
        # If the booking has been converted to a stay, the booking doc carries
        # the stay_id — use it. Otherwise fall back to legacy (OTA advance
        # settlements that arrive before the guest checks in have no stay yet).
        _ota_payload = {
            "room": booking.get("room", ""),
            "name": booking.get("guest_name", ""),
            "amount": settlement_amount,
            "method": "bank_settlement",
            "type": "bank_settlement",
            "date": settlement_date,
            "time": datetime.now(IST).strftime("%H:%M"),
            "booking_id": booking_id,
            "transaction_type": "bank_settlement",
            "platform": _src,
            "utr": utr,
            # Label surfaced in the Transactions tab so the row reads
            # "MMT Settlement" / "Agoda Settlement" rather than a generic one.
            "label": f"{_platform_label} Settlement",
        }
        _booking_stay_id = booking.get("stay_id")
        if _booking_stay_id:
            payment_service.write_payment_with_stay(_booking_stay_id, _ota_payload)
        else:
            payment_service.write_payment(_ota_payload)

        # ── Book the MMT commission as an expense ───────────────────────────
        # MMT keeps a commission (+18% GST) out of the tariff before paying
        # the hotel. That commission is a real cost, and its GST is claimable
        # input tax credit, so we record it as a booking_commission expense
        # when the settlement is confirmed. expense_type="report" → it is a
        # non-cash accrual (MMT deducted it; nothing left the cash drawer), so
        # it does NOT touch the daily cash counter — it only surfaces in
        # reports / GST. TCS (u/s 52) and TDS (u/s 194-O) are captured for
        # reference; they are tax credits, not part of the expense amount.
        # Guarded so a failure here never blocks the settlement.
        try:
            _comm = float(booking.get("ota_commission", 0) or 0)
            _comm_gst = float(booking.get("ota_commission_gst", 0) or 0)
            _comm_total = round(_comm + _comm_gst, 2)
            if _comm_total > 0:
                _vendor = {"mmt": "MakeMyTrip / Go-MMT", "agoda": "Agoda"}.get(_src, _platform_label)
                expense_service.write_expense({
                    "date": settlement_date,
                    "time": datetime.now(IST).strftime("%H:%M"),
                    "category": "booking_commission",
                    "description": (
                        f"{_platform_label} commission — {booking.get('guest_name', '')} "
                        f"(booking {str(booking_id)[:8]})"
                    ),
                    "amount": int(round(_comm_total)),
                    "payment_method": "bank_settlement",
                    "expense_type": "report",          # non-cash accrual
                    "has_gst": True,
                    "vendor_name": _vendor,
                    "vendor_gstin": "",
                    "taxable_amount": _comm,
                    "gst_rate": 18.0,
                    "gst_amount": _comm_gst,
                    "commission_platform": _src,
                    "commission_amount": _comm,
                    "commission_gst": _comm_gst,
                    "commission_payment_status": "paid",
                    "commission_payment_date": settlement_date,
                    "tcs_amount": float(booking.get("tcs_amount", 0) or 0),
                    "tds_amount": float(booking.get("tds_amount", 0) or 0),
                    "booking_id": booking_id,
                }, sync=True)
        except Exception as _ce:
            logger.warning(
                f"apply_ota_settlement: commission expense write failed for "
                f"booking {booking_id}: {_ce}"
            )

        logger.info(
            f"OTA settlement [{source}] for booking {booking_id}: "
            f"₹{settlement_amount} on {settlement_date} (UTR {utr or '-'})"
        )
        return {"ok": True, "already": False,
                "message": f"Settlement of ₹{settlement_amount} recorded",
                "settlement_amount": settlement_amount}

    except Exception as e:
        logger.error(f"apply_ota_settlement error for {booking_id}: {e}", exc_info=True)
        return {"ok": False, "already": False, "message": f"Error: {e}"}


@bookings_bp.route("/mark_ota_settlement", methods=["POST"])
def mark_ota_settlement():
    """Manually mark an MMT booking's settlement as received (thin wrapper
    over apply_ota_settlement; the email ingestion uses the same core)."""
    try:
        data = request.json or {}
        res = apply_ota_settlement(
            data.get("booking_id"),
            data.get("settlement_date"),
            data.get("settlement_amount", 0),
            utr=data.get("utr", ""),
            source="manual",
        )
        return jsonify(success=bool(res.get("ok")), message=res.get("message"))
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
    Return all OTA bookings (MMT + Agoda) where settlement has NOT been
    received yet. Queries bookings for booking_source in (mmt, agoda) AND
    settlement_status=pending. Sorted by check-in date descending.

    The route name is kept for backwards compatibility with the existing
    frontend; it now covers every OTA source.
    """
    try:
        docs = (
            bookings_ref
            .where("booking_source", "in", ["mmt", "agoda"])
            .where("settlement_status", "==", "pending")
            .stream()
        )
        unsettled = []
        for doc in docs:
            b = doc.to_dict()
            b["booking_id"] = doc.id
            b["platform"] = b.get("booking_source", "")
            unsettled.append(b)

        # Sort by check_in_date descending (string sort works for YYYY-MM-DD)
        unsettled.sort(key=lambda x: x.get("check_in_date", ""), reverse=True)

        return jsonify(success=True, unsettled=unsettled)
    except Exception as e:
        logger.error(f"Error fetching unsettled OTA bookings: {str(e)}")
        return jsonify(success=False, message=f"Error: {str(e)}")
