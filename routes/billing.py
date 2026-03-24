"""
Billing & Register routes.

All READ operations use the `payments` collection as primary data source.
Old `logs` collection is NOT used for reads anymore.
"""

from flask import Blueprint, request, jsonify
from datetime import datetime, timedelta
from google.cloud.firestore_v1.base_query import FieldFilter

from config import (
    db, rooms_ref, bills_ref, logs_ref, totals_ref, counters_ref,
    metadata_ref, IST, logger, settlements_ref,
    _build_active_entry_fast, _find_serial_fast, _batch_fill_serials,
    get_all_rooms,
)
from services import payment_service

billing_bp = Blueprint('billing', __name__)


# ══════════════════════════════════════════════════════════════════════════════
# REGISTER (check-in ledger)
# ══════════════════════════════════════════════════════════════════════════════

@billing_bp.route("/get_register_data", methods=["POST"])
def get_register_data():
    """
    Fetch register entries for the requested date range.
    CHECK-IN REGISTER — entries grouped by check-in date.

    READS FROM: payments collection (primary), bills collection (completed stays).
    """
    try:
        data_json = request.json
        start_date = data_json.get("start_date")
        end_date = data_json.get("end_date")

        if not start_date or not end_date:
            return jsonify(success=False, message="Start and end dates are required")

        start_dt = datetime.strptime(start_date, "%Y-%m-%d")
        end_dt = datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1)

        range_start_str = start_dt.strftime("%Y-%m-%d %H:%M")
        range_end_str = end_dt.strftime("%Y-%m-%d %H:%M")

        logger.info(f"=== REGISTER: {start_date} to {end_date} ===")

        import time as _t
        from concurrent.futures import ThreadPoolExecutor
        t0 = _t.time()

        # Run rooms + payments queries in parallel
        with ThreadPoolExecutor(max_workers=2) as pool:
            f_rooms = pool.submit(get_all_rooms)
            f_payments = pool.submit(
                payment_service.query_payments_by_date_range,
                start_date, end_dt.strftime("%Y-%m-%d")
            )

        rooms_data = f_rooms.result()
        range_payments = f_payments.result() or []
        t1 = _t.time()
        logger.info(f"[PERF] register parallel fetch: {t1-t0:.3f}s, {len(range_payments)} payments")

        # Pre-index ALL payments by (room, name) — ONE pass, no per-room queries
        payments_by_room = {}  # (room_str, name) -> [payment_docs]
        log_index = {}         # same but only entries with serial_number
        for p in range_payments:
            key = (str(p.get("room", "")), p.get("name", ""))
            if key not in payments_by_room:
                payments_by_room[key] = []
            payments_by_room[key].append(p)

            sn = p.get("serial_number")
            if sn and sn != 0:
                if key not in log_index:
                    log_index[key] = []
                log_index[key].append(p)

        _refund_types = ("refund", "checkout_refund", "manual_refund",
                         "booking_cancel_refund", "discount", "expense")

        register_entries = []
        seen = set()
        metadata_needed = []

        # ── 1. Active rooms — use pre-fetched payments (NO per-room queries) ──
        active_count = 0
        for room_number, room_data_item in rooms_data.items():
            if room_data_item.get("status") != "occupied":
                continue

            checkin_time = room_data_item.get("checkin_time")
            if not checkin_time:
                continue

            try:
                checkin_dt = datetime.strptime(checkin_time, "%Y-%m-%d %H:%M")
            except ValueError:
                continue

            if not (start_dt <= checkin_dt < end_dt):
                continue

            dedup_key = (str(room_number), checkin_time)
            if dedup_key in seen:
                continue
            seen.add(dedup_key)

            # Build entry from pre-fetched data (zero Firestore calls)
            guest = room_data_item.get("guest") or {}
            guest_name = guest.get("name", "")
            if not guest_name:
                continue

            room_str = str(room_number)
            room_price = guest.get("price", 0)
            days = (room_data_item.get("renewal_count") or 0) + 1
            room_charges = room_price * days
            services_total = sum(a.get("price", 0) for a in room_data_item.get("add_ons", []))

            # Look up payments from the pre-built index
            stay_payments = payments_by_room.get((room_str, guest_name), [])

            payment_cash = sum(
                p.get("amount", 0) for p in stay_payments
                if p.get("method") == "cash" and p.get("type") not in _refund_types
            )
            payment_online = sum(
                p.get("amount", 0) for p in stay_payments
                if p.get("method") == "online" and p.get("type") not in _refund_types
            )

            serial = _find_serial_fast(room_str, guest_name, checkin_dt, log_index)

            entry = {
                "id": f"active_{room_number}_{int(checkin_dt.timestamp())}",
                "bill_number": "-",
                "guest_name": guest_name,
                "guest_mobile": guest.get("mobile", ""),
                "room": room_str,
                "checkin_time": checkin_time,
                "checkout_time": None,
                "days_stayed": days,
                "room_rent": room_price,
                "room_charges": room_charges,
                "services_total": services_total,
                "total_amount": room_charges + services_total,
                "payment_cash": payment_cash,
                "payment_online": payment_online,
                "balance": room_data_item.get("balance", 0),
                "status": "active",
                "serial_number": serial,
            }
            register_entries.append(entry)
            active_count += 1
            if serial is None:
                metadata_needed.append(entry)

        t2 = _t.time()
        logger.info(f"[PERF] active rooms built: {t2-t1:.3f}s, count: {active_count}")

        # ── 2. Completed bills — Firestore range query ──
        completed_count = 0
        skipped_count = 0

        try:
            bills_query = (
                bills_ref
                .where(filter=FieldFilter("checkin_time", ">=", range_start_str))
                .where(filter=FieldFilter("checkin_time", "<", range_end_str))
            )

            for bill_doc in bills_query.stream():
                bill_data = bill_doc.to_dict()
                checkin_time = bill_data.get("checkin_time")
                checkout_time = bill_data.get("checkout_time")

                bill_status = bill_data.get("status", "completed")
                if bill_status not in ("completed", "checked_out", ""):
                    skipped_count += 1
                    continue

                if not checkin_time or not checkout_time:
                    skipped_count += 1
                    continue

                try:
                    checkin_dt = datetime.strptime(checkin_time, "%Y-%m-%d %H:%M")
                except ValueError:
                    skipped_count += 1
                    continue

                dedup_key = (str(bill_data.get("room", "")), checkin_time)
                if dedup_key in seen:
                    skipped_count += 1
                    continue
                seen.add(dedup_key)

                # Serial lookup from payments index
                serial_num = bill_data.get("serial_number")
                if not serial_num or serial_num == 0:
                    serial_num = _find_serial_fast(
                        str(bill_data.get("room", "")),
                        bill_data.get("guest_name", ""),
                        checkin_dt,
                        log_index,
                    )

                entry = {
                    "id": bill_doc.id,
                    "bill_number": bill_data.get("bill_number", "-"),
                    "guest_name": bill_data.get("guest_name", "Unknown"),
                    "guest_mobile": bill_data.get("guest_mobile", ""),
                    "room": str(bill_data.get("room", "")),
                    "checkin_time": checkin_time,
                    "checkout_time": checkout_time,
                    "days_stayed": bill_data.get("days_stayed", 1),
                    "room_rent": bill_data.get("room_price_per_night", 0),
                    "room_charges": bill_data.get("room_charges_total", 0),
                    "services_total": bill_data.get("services_total", 0),
                    "total_amount": bill_data.get("total_amount", 0),
                    "payment_cash": bill_data.get("payment_cash", 0),
                    "payment_online": bill_data.get("payment_online", 0),
                    "balance": bill_data.get("balance", 0),
                    "status": "completed",
                    "serial_number": serial_num,
                    # OTA / booking source fields
                    "booking_source": bill_data.get("booking_source", "normal"),
                    "payment_source": bill_data.get("payment_source", "hotel"),
                    "net_receivable": bill_data.get("net_receivable", 0),
                    "settlement_status": bill_data.get("settlement_status"),
                    # GST invoice fields
                    "invoice_generated": bill_data.get("invoice_generated", False),
                    "invoice_number": bill_data.get("invoice_number"),
                }
                register_entries.append(entry)
                completed_count += 1
                if serial_num is None:
                    metadata_needed.append(entry)

        except Exception as e:
            logger.error(f"Error querying bills: {e}", exc_info=True)

        logger.info(f"Completed bills: {completed_count}, skipped: {skipped_count}")

        # ── 3. Batch metadata lookup for entries still missing serials ──
        if metadata_needed:
            _batch_fill_serials(metadata_needed)

        # ── 4. Sort: date DESC, serial ASC within each day ──
        register_entries.sort(key=lambda e: e.get("serial_number") or 999999)
        register_entries.sort(
            key=lambda e: (e.get("checkin_time") or "0000-00-00").split(" ")[0],
            reverse=True,
        )

        # ── 5. Daily Tally Dashboard ─────────────────────────────────────────
        today_str = datetime.now(IST).strftime("%Y-%m-%d")
        tally = {
            "cash_today": 0,
            "upi_today": 0,
            "revenue_today": 0,
            "expenses_today": 0,
            "mmt_pending": 0,
            "mmt_received_today": 0,
        }
        try:
            today_payments = payment_service.query_payments_by_date_range(today_str, today_str)
            _refund_types = {"refund", "checkout_refund", "manual_refund", "booking_cancel_refund"}
            _bank_settlement = "bank_settlement"

            for p in today_payments:
                ptype = p.get("type", "")
                method = p.get("method", "")
                amount = p.get("amount", 0) or 0
                if ptype in _refund_types or ptype == "expense":
                    continue
                if method == "cash" and ptype != _bank_settlement:
                    tally["cash_today"] += amount
                elif method == "online" and ptype != _bank_settlement:
                    tally["upi_today"] += amount
                elif method == _bank_settlement or ptype == _bank_settlement:
                    tally["mmt_received_today"] += amount

            # Expenses today
            for p in today_payments:
                if p.get("type") == "expense" and p.get("expense_type") == "transaction":
                    tally["expenses_today"] += (p.get("amount") or 0)

            tally["revenue_today"] = tally["cash_today"] + tally["upi_today"]

            # MMT pending: sum net_receivable from settlements collection where status=pending
            pending_q = settlements_ref.where("settlement_status", "==", "pending").stream() \
                if False else None  # settlements_ref stores booking_source != settlements status
            # Query bookings collection directly for pending MMT settlements
            mmt_pending_q = db.collection("bookings") \
                .where("booking_source", "==", "mmt") \
                .where("settlement_status", "==", "pending") \
                .stream()
            for bdoc in mmt_pending_q:
                tally["mmt_pending"] += bdoc.to_dict().get("net_receivable", 0) or 0

        except Exception as te:
            logger.warning(f"Tally dashboard error: {te}")

        t3 = _t.time()
        logger.info(f"[PERF] /get_register_data TOTAL: {t3-t0:.3f}s, entries: {len(register_entries)}")
        return jsonify(success=True, entries=register_entries, tally=tally)

    except Exception as e:
        logger.error(f"ERROR in get_register_data: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {str(e)}")


# ══════════════════════════════════════════════════════════════════════════════
# BILL ENDPOINTS
# ══════════════════════════════════════════════════════════════════════════════

@billing_bp.route("/generate_bill/<entry_id>", methods=["GET"])
def generate_bill(entry_id):
    """Generate bill from bills collection."""
    try:
        bill_doc = bills_ref.document(entry_id).get()
        if not bill_doc.exists:
            return jsonify(success=False, message="Bill not found")

        bill_data = bill_doc.to_dict()
        return jsonify(success=True, bill=bill_data)

    except Exception as e:
        logger.error(f"Error generating bill: {str(e)}", exc_info=True)
        return jsonify(success=False, message=f"Error: {str(e)}")


@billing_bp.route("/get_bill/<bill_number>", methods=["GET"])
def get_bill_by_number(bill_number):
    """Retrieve a previously generated bill by bill number."""
    try:
        bills_query = bills_ref.where('bill_number', '==', bill_number).limit(1).stream()
        bills = list(bills_query)
        if not bills:
            return jsonify(success=False, message="Bill not found")

        bill_data = bills[0].to_dict()
        return jsonify(success=True, bill=bill_data)

    except Exception as e:
        logger.error(f"Error retrieving bill: {str(e)}")
        return jsonify(success=False, message=f"Error retrieving bill: {str(e)}")


@billing_bp.route("/search_bills", methods=["POST"])
def search_bills():
    """Search bills by guest name, mobile, or bill number."""
    try:
        data_json = request.json
        search_term = data_json.get("search_term", "").strip()

        if not search_term:
            return jsonify(success=False, message="Search term is required")

        # Search by bill number (exact match)
        bills_query = bills_ref.where('bill_number', '==', search_term).limit(10).stream()
        results = [doc.to_dict() for doc in bills_query]

        # If no results, search by guest name / mobile (partial match)
        if not results:
            all_bills = bills_ref.limit(100).stream()
            results = [
                doc.to_dict()
                for doc in all_bills
                if (search_term.lower() in doc.to_dict().get('guest_name', '').lower() or
                    search_term in doc.to_dict().get('guest_mobile', ''))
            ]

        return jsonify(success=True, bills=results[:10])

    except Exception as e:
        logger.error(f"Error searching bills: {str(e)}")
        return jsonify(success=False, message=f"Error searching bills: {str(e)}")


@billing_bp.route("/print_bill/<bill_id>", methods=["POST"])
def print_bill(bill_id):
    """Mark a bill as printed and update print count."""
    try:
        bill_doc = bills_ref.document(bill_id).get()
        if not bill_doc.exists:
            return jsonify(success=False, message="Bill not found")

        bill_data = bill_doc.to_dict()
        print_count = bill_data.get("print_count", 0) + 1

        bills_ref.document(bill_id).update({
            "print_count": print_count,
            "last_printed_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
        })

        return jsonify(success=True, message=f"Bill printed (Count: {print_count})")

    except Exception as e:
        logger.error(f"Error recording bill print: {str(e)}")
        return jsonify(success=False, message=f"Error: {str(e)}")


@billing_bp.route("/get_register_stats", methods=["POST"])
def get_register_stats():
    """Get statistics for register data."""
    try:
        data_json = request.json
        start_date = data_json.get("start_date")
        end_date = data_json.get("end_date")

        if not start_date or not end_date:
            return jsonify(success=False, message="Date range required")

        # Use the register data endpoint logic to get entries, then compute stats
        # For now, return basic stats from bills
        start_str = start_date
        end_dt = datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1)
        end_str = end_dt.strftime("%Y-%m-%d %H:%M")
        start_full = datetime.strptime(start_date, "%Y-%m-%d").strftime("%Y-%m-%d %H:%M")

        bills_query = (
            bills_ref
            .where(filter=FieldFilter("checkin_time", ">=", start_full))
            .where(filter=FieldFilter("checkin_time", "<", end_str))
        )

        total_entries = 0
        total_revenue = 0
        cash_collected = 0
        online_collected = 0
        pending_balance = 0

        for bill_doc in bills_query.stream():
            bd = bill_doc.to_dict()
            total_entries += 1
            total_revenue += bd.get("total_amount", 0)
            cash_collected += bd.get("payment_cash", 0)
            online_collected += bd.get("payment_online", 0)
            bal = bd.get("balance", 0)
            if bal > 0:
                pending_balance += bal

        stats = {
            "total_entries": total_entries,
            "total_revenue": total_revenue,
            "cash_collected": cash_collected,
            "online_collected": online_collected,
            "pending_balance": pending_balance,
        }

        return jsonify(success=True, stats=stats)

    except Exception as e:
        logger.error(f"Error calculating register stats: {str(e)}")
        return jsonify(success=False, message=f"Error: {str(e)}")




@billing_bp.route("/debug_bills", methods=["GET"])
def debug_bills():
    """Debug endpoint to see all completed bills."""
    try:
        bills_query = bills_ref.where('status', '==', 'completed').stream()

        bills_list = []
        for bill_doc in bills_query:
            bill_data = bill_doc.to_dict()
            bills_list.append({
                "id": bill_doc.id,
                "guest": bill_data.get("guest_name"),
                "room": bill_data.get("room"),
                "checkin": bill_data.get("checkin_time"),
                "checkout": bill_data.get("checkout_time"),
                "bill_number": bill_data.get("bill_number"),
            })

        bills_list.sort(key=lambda x: x.get("checkout", ""), reverse=True)

        return jsonify(success=True, count=len(bills_list), bills=bills_list)

    except Exception as e:
        logger.error(f"Error in debug: {str(e)}")
        return jsonify(success=False, message=str(e))
