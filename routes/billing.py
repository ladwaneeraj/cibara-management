"""
Billing & Register routes.

All READ operations use the `payments` collection as primary data source.
Old `logs` collection is NOT used for reads anymore.
"""

from flask import Blueprint, request, jsonify
from datetime import datetime, timedelta
from google.cloud.firestore_v1.base_query import FieldFilter
from firebase_admin import firestore

from config import (
    db, rooms_ref, bills_ref, logs_ref, totals_ref, counters_ref,
    metadata_ref, IST, logger, settlements_ref,
    _build_active_entry_fast, _find_serial_fast, _batch_fill_serials,
    get_all_rooms, invalidate_rooms_and_totals,
    generate_sequential_invoice_number,
)
from services import payment_service, pdf_service

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
                # "pending_settlement" = settle-later checkout; include these so
                # the guest still appears in the register / bills module with the
                # outstanding balance visible.
                if bill_status not in ("completed", "checked_out",
                                       "pending_settlement", ""):
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
                    "refunds": bill_data.get("refunds", 0),
                    "refund_cash": bill_data.get("refund_cash", 0),
                    "refund_online": bill_data.get("refund_online", 0),
                    "balance": bill_data.get("balance", 0),
                    # Use real Firestore status — "pending_settlement" for
                    # settle-later checkouts so the frontend can badge them.
                    "status": bill_status,
                    "serial_number": serial_num,
                    # OTA / booking source fields
                    "booking_source": bill_data.get("booking_source", "normal"),
                    "payment_source": bill_data.get("payment_source", "hotel"),
                    "net_receivable": bill_data.get("net_receivable", 0),
                    "settlement_status": bill_data.get("settlement_status"),
                    # GST invoice fields
                    "invoice_generated": bill_data.get("invoice_generated", False),
                    "invoice_number": bill_data.get("invoice_number"),
                    # PDF — must be included so the WhatsApp button stays dark
                    # after a page refresh (icon colour is driven by pdf_url presence)
                    "pdf_url": bill_data.get("pdf_url", ""),
                    # GST rate stored at checkout time (used by buildBillHTML)
                    "gst_rate": bill_data.get("gst_rate"),
                    # Discount and services detail needed for bill re-render
                    "discounts": bill_data.get("discounts", 0),
                    "services": bill_data.get("services", []),
                    "guest_count": bill_data.get("guest_count", 1),
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

        # If no results, search by guest name / mobile across ALL bills
        # ordered by most recent checkout so newest results surface first
        if not results:
            all_bills = (
                bills_ref
                .order_by("checkin_time", direction="DESCENDING")
                .stream()
            )
            term_lower = search_term.lower()
            for doc in all_bills:
                data = doc.to_dict()
                if (term_lower in data.get('guest_name', '').lower() or
                        search_term in data.get('guest_mobile', '')):
                    results.append(data)
                if len(results) >= 20:
                    break

        return jsonify(success=True, bills=results[:20])

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
    """Debug endpoint — only accessible from localhost."""
    from flask import request as _req
    remote = _req.remote_addr or ""
    if remote not in ("127.0.0.1", "::1", "localhost"):
        return jsonify(success=False, message="Not found"), 404
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


# ══════════════════════════════════════════════════════════════════════════════
# ADD BILL PAYMENT — collect outstanding balance directly from the Bills tab
# ══════════════════════════════════════════════════════════════════════════════

@billing_bp.route("/add_bill_payment", methods=["POST"])
def add_bill_payment():
    """
    Record a payment against a bill that has an outstanding balance.
    Works for both new bills (have settlement_id) and old bills (no settlement_id).
    When a settlement_id exists the linked settlement record is updated too so
    the Pending Settlements tab stays in sync.
    """
    try:
        data_json    = request.json
        bill_id      = data_json.get("bill_id", "")
        payment_mode = data_json.get("payment_mode", "cash")   # "cash" | "online"
        amount       = int(data_json.get("amount",   0))
        discount     = int(data_json.get("discount", 0))

        if not bill_id:
            return jsonify(success=False, message="bill_id is required")
        if amount < 0:
            return jsonify(success=False, message="Amount cannot be negative")
        if discount < 0:
            return jsonify(success=False, message="Discount cannot be negative")
        if amount == 0 and discount == 0:
            return jsonify(success=False, message="Provide a payment amount or discount")

        # ── Fetch bill ────────────────────────────────────────────────────────
        bill_doc = bills_ref.document(bill_id).get()
        if not bill_doc.exists:
            return jsonify(success=False, message="Bill not found")

        bill_data       = bill_doc.to_dict()
        current_balance = int(bill_data.get("balance", 0))

        if current_balance <= 0:
            return jsonify(success=False, message="No outstanding balance on this bill")
        if discount > current_balance:
            return jsonify(success=False,
                           message=f"Discount ₹{discount} exceeds outstanding balance ₹{current_balance}")
        net_payable = current_balance - discount
        if amount > net_payable:
            return jsonify(success=False,
                           message=f"Amount ₹{amount} exceeds net payable ₹{net_payable} after discount")

        # ── Build bill update ─────────────────────────────────────────────────
        bill_update = {}
        if amount > 0:
            if payment_mode == "cash":
                bill_update["payment_cash"] = bill_data.get("payment_cash", 0) + amount
            else:
                bill_update["payment_online"] = bill_data.get("payment_online", 0) + amount

        if discount > 0:
            bill_update["discounts"] = bill_data.get("discounts", 0) + discount

        new_balance = current_balance - amount - discount
        bill_update["balance"] = new_balance

        invoice_number = None
        if new_balance <= 0:
            bill_update["status"] = "completed"
            # Generate invoice for UPI payment if not issued yet
            if payment_mode == "online" and not bill_data.get("invoice_generated"):
                try:
                    checkout_dt = datetime.strptime(
                        bill_data["checkout_time"], "%Y-%m-%d %H:%M")
                    invoice_number = generate_sequential_invoice_number(checkout_dt)
                    bill_update["invoice_generated"] = True
                    bill_update["invoice_number"]    = invoice_number
                except Exception as _ie:
                    logger.warning(f"Invoice generation failed: {_ie}")

        bills_ref.document(bill_id).update(bill_update)
        logger.info(f"Bill {bill_id} payment ₹{amount} ({payment_mode}), "
                    f"balance now ₹{new_balance}")

        # ── Update totals ─────────────────────────────────────────────────────
        batch = db.batch()
        batch.update(totals_ref.document("current_totals"),
                     {payment_mode: firestore.Increment(amount)})
        batch.commit()
        invalidate_rooms_and_totals()

        # ── Write to payments collection ──────────────────────────────────────
        now_date = datetime.now(IST).strftime("%Y-%m-%d")
        now_time = datetime.now(IST).strftime("%H:%M")
        _base = {
            "room":        bill_data.get("room", ""),
            "name":        bill_data.get("guest_name", ""),
            "date":        now_date,
            "time":        now_time,
            "bill_id":     bill_id,
            "bill_number": bill_data.get("bill_number", ""),
        }
        if amount > 0:
            payment_service.write_payment({
                **_base,
                "amount":           amount,
                "method":           payment_mode,
                "type":             "settlement_payment",
                "transaction_type": "settlement_payment",
            })
        if discount > 0:
            payment_service.write_payment({
                **_base,
                "amount":           discount,
                "method":           "discount",
                "type":             "discount",
                "transaction_type": "discount",
            })
            logger.info(f"Bill {bill_id} discount ₹{discount} applied by staff")

        # ── Sync linked settlement (if any) ───────────────────────────────────
        settlement_id = bill_data.get("settlement_id")
        if settlement_id:
            try:
                s_doc = settlements_ref.document(settlement_id).get()
                if s_doc.exists:
                    s_data        = s_doc.to_dict()
                    s_amount      = int(s_data.get("amount", 0))
                    # Total reduction = payment + discount
                    total_reduced = amount + discount
                    s_update = {}
                    if total_reduced >= s_amount:
                        s_update["status"]       = "paid"
                        s_update["payment_date"] = now_date
                        s_update["payment_time"] = now_time
                        s_update["payment_mode"] = payment_mode
                    else:
                        s_update["status"] = "partial"
                        s_update["amount"] = s_amount - total_reduced
                        prev = s_data.get("payments", [])
                        entry = {"date": now_date, "time": now_time, "mode": payment_mode}
                        if amount   > 0: entry["amount"]   = amount
                        if discount > 0: entry["discount"] = discount
                        s_update["payments"] = prev + [entry]
                    settlements_ref.document(settlement_id).update(s_update)
                    logger.info(f"Settlement {settlement_id} synced from bill payment")
            except Exception as _se:
                logger.warning(f"Could not sync settlement {settlement_id}: {_se}")

        # Build human-readable message
        parts = []
        if amount   > 0: parts.append(f"Payment ₹{amount}")
        if discount > 0: parts.append(f"Discount ₹{discount}")
        msg = " + ".join(parts) + " recorded."
        if new_balance > 0:
            msg += f" Remaining balance: ₹{new_balance}"
        else:
            msg += " Bill settled."

        return jsonify(
            success=True,
            message=msg,
            new_balance=new_balance,
            invoice_number=invoice_number,
        )

    except Exception as e:
        logger.error(f"Error in add_bill_payment: {str(e)}")
        return jsonify(success=False, message=f"Error: {str(e)}")


# ══════════════════════════════════════════════════════════════════════════════
# SAVE BILL PDF — upload generated PDF to Firebase Storage, store URL in bill
# ══════════════════════════════════════════════════════════════════════════════

@billing_bp.route("/save_bill_pdf", methods=["POST"])
def save_bill_pdf():
    """
    Accept a base64-encoded PDF from the browser, upload it to Firebase Storage
    under bills/{invoice_no}/v{n}.pdf, and save the download URL in the bill
    document (pdf_url field + versions array for audit history).

    Request JSON:
        bill_id     — Firestore document ID of the bill
        invoice_no  — used as the Storage folder name (e.g. "INV/2026/03/00045")
        pdf_base64  — base64-encoded PDF bytes (without data-URI prefix)

    Response JSON:
        success, pdf_url, version
    """
    import base64

    try:
        data = request.json or {}
        bill_id    = (data.get("bill_id") or "").strip()
        invoice_no = (data.get("invoice_no") or "").strip()
        pdf_b64    = (data.get("pdf_base64") or "").strip()

        if not bill_id:
            return jsonify(success=False, message="bill_id is required")
        if not pdf_b64:
            return jsonify(success=False, message="pdf_base64 is required")

        # Strip data-URI prefix if the client accidentally included it
        if pdf_b64.startswith("data:"):
            pdf_b64 = pdf_b64.split(",", 1)[-1]

        try:
            pdf_bytes = base64.b64decode(pdf_b64)
        except Exception:
            return jsonify(success=False, message="Invalid base64 PDF data")

        # Use bill_id as folder name fallback when invoice_no is absent
        folder = invoice_no or bill_id
        result = pdf_service.upload_bill_pdf(bill_id, folder, pdf_bytes)

        if not result["url"]:
            return jsonify(
                success=False,
                message="PDF upload to Firebase Storage failed. Check server logs."
            )

        return jsonify(
            success=True,
            pdf_url=result["url"],
            version=result["version"],
            message=f"PDF v{result['version']} saved successfully",
        )

    except Exception as e:
        logger.error(f"Error in save_bill_pdf: {e}", exc_info=True)
        return jsonify(success=False, message=f"Server error: {str(e)}")


# ══════════════════════════════════════════════════════════════════════════════
# RENDER BILL PDF — server-side HTML→PDF using xhtml2pdf (no browser canvas)
# ══════════════════════════════════════════════════════════════════════════════

# ── Server-side bill HTML builder ───────────────────────────────────────────
# Python port of buildBillHTML() from bills.js.
# Called by auto_generate_bill_pdf() so the PDF can be created at checkout
# without needing the browser to be on the bills page.

_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]

def _fmt_bill_dt(dt_str):
    """Format '2026-04-02 14:30' → 'Apr 2, 2026, 02:30 PM' (mirrors fmtBillDT in JS)."""
    if not dt_str:
        return "-"
    parts = dt_str.split(" ")
    y, m, d = parts[0].split("-")
    month_name = _MONTHS[int(m) - 1]
    time_str = ""
    if len(parts) > 1:
        hh, mm = parts[1].split(":")
        h = int(hh)
        ampm = "PM" if h >= 12 else "AM"
        h12 = 12 if h == 0 else (h - 12 if h > 12 else h)
        time_str = f", {h12:02d}:{mm} {ampm}"
    return f"{month_name} {int(d)}, {y}{time_str}"

def _f2(n):
    """Format a number to 2 decimal places."""
    return f"{float(n or 0):.2f}"

def _build_bill_html(b: dict) -> str:
    """Build the bill HTML fragment from a bill record dict.

    Mirrors the JS buildBillHTML() function in bills.js so the server-generated
    PDF is visually identical to what the browser modal shows.
    """
    days       = b.get("days_stayed", 1)
    rate       = b.get("room_price_per_night") or b.get("room_rent") or 0
    services   = b.get("services") or []

    accom_addons   = [s for s in services if s.get("accommodation_charge")]
    other_services = [s for s in services if not s.get("accommodation_charge")]
    accom_addons_total = sum(s.get("price", 0) for s in accom_addons)
    other_svc_total    = sum(s.get("price", 0) for s in other_services)

    gst_rate_pct = b.get("gst_rate", 0)
    cgst_rate    = gst_rate_pct / 2
    sgst_rate    = gst_rate_pct / 2

    # Use the stored room_charges_total when available — this is always correct,
    # including when the room price changed mid-stay (room transfer or AC add-on).
    # Fall back to rate × days only for old bills that pre-date this field.
    room_charges  = b.get("room_charges_total") or (rate * days)
    accom_total   = room_charges + accom_addons_total

    # Use stored gst_amount when available (correctly computed per-segment).
    # Derive CGST/SGST from it; fall back to back-calculation for old bills.
    stored_gst    = b.get("gst_amount")
    if stored_gst is not None:
        cgst      = stored_gst / 2
        sgst      = cgst
        accom_base = accom_total - stored_gst
    else:
        divisor   = 1 + gst_rate_pct / 100
        accom_base = accom_total / divisor if divisor else accom_total
        cgst      = (accom_total - accom_base) / 2
        sgst      = cgst

    discounts    = b.get("discounts") or 0
    svc_total_all = b.get("services_total") or 0
    # Use stored total_amount when available (authoritative figure from billing).
    grand_total  = b.get("total_amount") or (room_charges + svc_total_all - discounts)

    cash_paid    = b.get("payment_cash") or 0
    online_paid  = b.get("payment_online") or 0
    refunds      = b.get("refunds") or 0
    refund_cash  = b.get("refund_cash") or 0
    refund_online = b.get("refund_online") or 0
    total_paid   = cash_paid + online_paid
    net_collected = total_paid - refunds
    balance      = b.get("balance") or 0

    display_bill_no = b.get("bill_number") or "N/A"
    bill_date    = _fmt_bill_dt(b.get("checkout_time"))

    # ── Accommodation add-on rows ──
    accom_addon_rows = "".join(
        f'<tr><td>{s.get("item","Service")}</td>'
        f'<td class="b-tr">{s.get("quantity",1)}</td>'
        f'<td class="b-tr">{_f2(s.get("unit_price") or s.get("price",0))}</td>'
        f'<td class="b-tr">{_f2(s.get("price",0))}</td></tr>'
        for s in accom_addons
    )

    # ── Other service rows ──
    other_svc_rows = "".join(
        f'<tr><td>{s.get("item","Service")}</td>'
        f'<td class="b-tr">{s.get("quantity",1)}</td>'
        f'<td class="b-tr">{_f2(s.get("unit_price") or s.get("price",0))}</td>'
        f'<td class="b-tr">{_f2(s.get("price",0))}</td></tr>'
        for s in other_services
    )

    # ── GST rows ──
    gst_rows = (
        f'<tr class="b-gst-row"><td>CGST @ {cgst_rate}%</td>'
        f'<td class="b-tr">—</td><td class="b-tr">—</td>'
        f'<td class="b-tr">{_f2(cgst)}</td></tr>'
        f'<tr class="b-gst-row"><td>SGST @ {sgst_rate}%</td>'
        f'<td class="b-tr">—</td><td class="b-tr">—</td>'
        f'<td class="b-tr">{_f2(sgst)}</td></tr>'
    )

    accom_subtotal_row = (
        f'<tr class="b-subtotal">'
        f'<td colspan="3" class="b-tr">Accommodation Total (incl. GST)</td>'
        f'<td class="b-tr">{_f2(accom_total)}</td></tr>'
        if accom_addons or days > 1 else ""
    )

    other_svc_section = (
        f'<tr class="b-sec"><td colspan="4">Additional Services (Non-Taxable)</td></tr>'
        f'{other_svc_rows}'
        f'<tr class="b-subtotal"><td colspan="3" class="b-tr">Services Total</td>'
        f'<td class="b-tr">{_f2(other_svc_total)}</td></tr>'
        if other_svc_rows else ""
    )

    discount_row = (
        f'<tr><td colspan="3" style="text-align:right;color:#2e7d32;font-weight:600;">'
        f'Discount</td>'
        f'<td class="b-tr" style="color:#2e7d32;font-weight:700;">- {_f2(discounts)}</td></tr>'
        if discounts > 0 else ""
    )

    # ── Refund rows ──
    refund_rows = ""
    if refunds > 0:
        if refund_cash > 0:
            refund_rows += (
                f'<tr><td>Refund Given (Cash)</td>'
                f'<td class="b-tr" style="color:#c00;">- Rs. {_f2(refund_cash)}</td></tr>'
            )
        if refund_online > 0:
            refund_rows += (
                f'<tr><td>Refund Given (UPI)</td>'
                f'<td class="b-tr" style="color:#c00;">- Rs. {_f2(refund_online)}</td></tr>'
            )
        if not refund_cash and not refund_online:
            refund_rows += (
                f'<tr><td>Refund Given</td>'
                f'<td class="b-tr" style="color:#c00;">- Rs. {_f2(refunds)}</td></tr>'
            )
        refund_rows += (
            f'<tr class="b-subtotal"><td>Net Collected</td>'
            f'<td class="b-tr">Rs. {_f2(net_collected)}</td></tr>'
        )

    balance_row = (
        f'<tr><td style="font-weight:800;color:#c62828;">Balance Due</td>'
        f'<td class="b-tr" style="font-weight:800;color:#c62828;">Rs. {_f2(balance)}</td></tr>'
        if balance > 0 else ""
    )

    paid_full_row = (
        f'<tr><td style="color:#2e7d32;font-weight:700;">Payment Status</td>'
        f'<td class="b-tr" style="color:#2e7d32;font-weight:700;">PAID IN FULL</td></tr>'
        if balance <= 0 and refunds <= 0 else ""
    )

    per_night_base = _f2(accom_base / (days or 1))

    return f"""
<div class="b-bill-wrap">
  <div class="b-header-block">
    <div class="b-lodge-name">CIBARA COMFORTS</div>
    <div class="b-lodge-entity">A Unit of Cibara Enterprise</div>
    <div class="b-lodge-sub">Opposite Bus Stand Road, Harihar, Karnataka - 577601</div>
    <div class="b-lodge-sub">Ph: +91 9482831381</div>
    <div class="b-gstin-bar">GSTIN: 29AAWFC1962B1Z9 &nbsp;.&nbsp; SAC: 9963 &nbsp;.&nbsp; Karnataka (KA - 29)</div>
    <div class="b-title">TAX INVOICE</div>
  </div>
  <table class="b-info-outer">
    <tr>
      <td class="b-info-col">
        <div class="b-row"><span class="b-lbl">Bill No:</span> {display_bill_no}</div>
        <div class="b-row"><span class="b-lbl">Guest Name:</span> {b.get("guest_name","")}</div>
        <div class="b-row"><span class="b-lbl">Mobile:</span> {b.get("guest_mobile","") or "N/A"}</div>
        <div class="b-row"><span class="b-lbl">Room No:</span> {b.get("room","")}</div>
        <div class="b-row"><span class="b-lbl">Guests:</span> {b.get("guest_count",1)}</div>
      </td>
      <td class="b-info-col b-info-col-r">
        <div class="b-row"><span class="b-lbl">Check-in:</span> {_fmt_bill_dt(b.get("checkin_time"))}</div>
        <div class="b-row"><span class="b-lbl">Check-out:</span> {_fmt_bill_dt(b.get("checkout_time"))}</div>
        <div class="b-row"><span class="b-lbl">Days Stayed:</span> {days}</div>
        <div class="b-row"><span class="b-lbl">Bill Date:</span> {bill_date}</div>
        <div class="b-row"><span class="b-lbl">Place of Supply:</span> Karnataka (KA - 29)</div>
      </td>
    </tr>
  </table>
  <table class="b-tbl">
    <thead>
      <tr>
        <th>Description</th><th class="b-tr">Qty</th>
        <th class="b-tr">Rate (Rs.)</th><th class="b-tr">Amount (Rs.)</th>
      </tr>
    </thead>
    <tbody>
      <tr class="b-sec"><td colspan="4">Accommodation Charges (SAC: 9963)</td></tr>
      <tr>
        <td>Room Rent - Base Amount (excl. GST)</td>
        <td class="b-tr">{days}</td>
        <td class="b-tr">{per_night_base}</td>
        <td class="b-tr">{_f2(accom_base)}</td>
      </tr>
      {gst_rows}
      {accom_addon_rows}
      {accom_subtotal_row}
      {other_svc_section}
      {discount_row}
      <tr class="b-grand">
        <td colspan="3" class="b-tr">GRAND TOTAL</td>
        <td class="b-tr">Rs. {_f2(grand_total)}</td>
      </tr>
    </tbody>
  </table>
  <div class="b-pay-section">
    <div class="b-pay-title">Payment Details</div>
    <table class="b-tbl">
      <tbody>
        <tr><td>Cash Paid</td><td class="b-tr">Rs. {_f2(cash_paid)}</td></tr>
        <tr><td>Online / UPI Paid</td><td class="b-tr">Rs. {_f2(online_paid)}</td></tr>
        <tr class="b-subtotal"><td>Total Paid</td><td class="b-tr">Rs. {_f2(total_paid)}</td></tr>
        {refund_rows}
        {balance_row}
        {paid_full_row}
      </tbody>
    </table>
  </div>
  <table class="b-sig">
    <tr>
      <td><div class="b-sig-line">Guest Signature</div></td>
      <td style="text-align:right"><div class="b-sig-line">Authorised Signatory</div></td>
    </tr>
  </table>
  <div class="b-footer">
    <p>Thank you for staying at Cibara Comforts. We look forward to welcoming you again!</p>
    <p>This is a computer-generated invoice.</p>
  </div>
</div>"""


def auto_generate_bill_pdf(bill_id: str, bill_record: dict):
    """Generate and upload a PDF for a bill in a background thread.

    Called right after checkout commits. Runs silently — errors are logged but
    never propagate back to the checkout response.
    """
    try:
        # Skip if no bill was created (same-day cash / MMT OTA)
        if not bill_id or not bill_record:
            return
        # Skip if a PDF already exists (shouldn't happen on fresh checkout,
        # but guard against duplicate calls)
        bill_snap = bills_ref.document(bill_id).get()
        if bill_snap.exists and (bill_snap.to_dict() or {}).get("pdf_url"):
            logger.info(f"[auto_pdf] Bill {bill_id} already has a PDF, skipping.")
            return

        html_body  = _build_bill_html(bill_record)
        full_html  = _build_pdf_html(html_body)

        from xhtml2pdf import pisa
        import io
        pdf_buf = io.BytesIO()
        result  = pisa.CreatePDF(full_html, dest=pdf_buf)
        if result.err:
            logger.error(f"[auto_pdf] xhtml2pdf error for bill {bill_id}: code {result.err}")
            return

        folder = (
            bill_record.get("invoice_number")
            or bill_record.get("bill_number")
            or bill_id
        )
        upload = pdf_service.upload_bill_pdf(bill_id, folder, pdf_buf.getvalue())
        if upload.get("url"):
            logger.info(
                f"[auto_pdf] PDF auto-generated for bill {bill_id} "
                f"(v{upload['version']}): {upload['url']}"
            )
        else:
            logger.error(f"[auto_pdf] Storage upload failed for bill {bill_id}")
    except Exception as exc:
        logger.error(f"[auto_pdf] Unhandled error for bill {bill_id}: {exc}", exc_info=True)


# ── Bill CSS for PDF ─────────────────────────────────────────────────────────
# CSS for xhtml2pdf / ReportLab PDF rendering. Uses pt units (better for print).
# Key difference from browser CSS: border-bottom is placed on .b-title (last element
# in the header block) instead of .b-header-block. xhtml2pdf has a bug where
# border-bottom on a div container gets incorrectly applied to every child block
# element, creating multiple unwanted horizontal lines in the header.
_BILL_PDF_CSS = """
@page { size: A4 portrait; margin: 15mm 15mm; }

body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt;
       color: #1a1a1a; margin: 0; padding: 0; }

/* Full A4 width — margins set via @page, no artificial max-width cap */
.b-bill-wrap { width: 100%; margin: 0 auto; }

/* Header — centered text, NO border on the container div (xhtml2pdf bug: border-bottom
   on a div gets applied to every child block element, creating unwanted extra lines).
   Instead, the border lives on .b-title, the last element in the header. */
.b-header-block { text-align: center; padding-bottom: 0; margin-bottom: 0; }
.b-lodge-name   { font-size: 20pt; font-weight: bold; letter-spacing: 1px; }
.b-lodge-entity { font-size: 10pt; color: #444; font-style: italic; margin-top: 2px; }
.b-lodge-sub    { font-size: 9.5pt; color: #555; margin-top: 2px; }
.b-gstin-bar    { font-size: 9pt; color: #777; margin-top: 3px; }
.b-title        { font-size: 10pt; font-weight: bold; letter-spacing: 2px;
                  margin-top: 6px; padding-bottom: 7px;
                  border-bottom: 2px solid #333; }

/* Info table — all 4 borders so it sits cleanly below the header rule */
.b-info-outer { border: 1px solid #ccc;
                width: 100%; border-collapse: collapse; margin-bottom: 8px; }
.b-info-col   { padding: 7px 10px; font-size: 9.5pt; width: 50%;
                vertical-align: top; }
.b-info-col-r { border-left: 1px solid #ccc; }
.b-row  { margin-bottom: 3px; }
.b-lbl  { font-weight: bold; color: #444; display: inline-block;
          min-width: 100px; margin-right: 4px; }
.b-val  { color: #1a1a1a; }

/* Items table */
.b-tbl    { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin-bottom: 6px; }
.b-tbl th { background: #efefef; font-weight: bold; padding: 5px 6px;
            border: 1px solid #bbb; }
.b-tbl td { padding: 4px 6px; border: 1px solid #ddd; }
.b-tr     { text-align: right; }

/* Section / subtotal / GST rows */
.b-sec td      { background: #f5f5f5; font-weight: bold; font-size: 9pt;
                 color: #333; padding: 4px 6px;
                 border-color: #bbb; text-transform: uppercase; }
.b-gst-row td  { color: #666; font-size: 9pt; }
.b-subtotal td { font-weight: bold; background: #fafafa; }

/* Grand total */
.b-grand    { border-top: 2px solid #333; }
.b-grand td { font-weight: bold; background: #eeeeee; padding: 5px 6px; font-size: 10pt; }

/* Payment section */
.b-pay-section { margin-top: 8px; border: 1px solid #ccc; }
.b-pay-title   { background: #efefef; font-weight: bold;
                 font-size: 9pt; padding: 5px 6px; text-transform: uppercase; }
.b-pay-section .b-tbl    { margin-bottom: 0; }
.b-pay-section .b-tbl td { border-color: #eeeeee; padding: 4px 6px; }

/* Signature */
.b-sig       { width: 100%; margin-top: 30px; border-collapse: collapse; }
.b-sig td    { padding-top: 10px; }
.b-sig td:last-child { text-align: right; }
.b-sig-line  { display: inline-block; border-top: 1px solid #555;
               padding-top: 3px; width: 140px; text-align: center;
               font-size: 9pt; color: #555; }

/* Footer */
.b-footer { margin-top: 12px; border-top: 1px solid #ddd;
            padding-top: 5px; font-size: 8.5pt; color: #999;
            text-align: center; }
"""


def _build_pdf_html(html_body: str) -> str:
    """Wrap the bill HTML fragment in a complete HTML document for xhtml2pdf.
    The HTML uses <table> for the info grid and signature (same as the browser
    modal), so no regex manipulation is needed — the markup is already correct.

    xhtml2pdf / ReportLab cannot render the Unicode Rupee sign (U+20B9 ₹).
    Replace it with 'Rs.' before passing to the PDF engine.
    """
    html_body = html_body.replace('\u20b9', 'Rs.')
    return f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>{_BILL_PDF_CSS}</style>
</head>
<body>
  {html_body}
</body>
</html>"""


@billing_bp.route("/render_bill_pdf", methods=["POST"])
def render_bill_pdf():
    """
    Server-side HTML→PDF conversion using xhtml2pdf.
    Accepts the bill HTML fragment from the browser, wraps it in a
    complete document with PDF-safe CSS, converts to PDF bytes,
    uploads to Firebase Storage, and returns the download URL.

    Skips generation if a PDF URL already exists in Firestore.

    Request JSON:  { bill_id, invoice_no, html_content }
    Response JSON: { success, pdf_url, version, skipped? }
    """
    try:
        data       = request.json or {}
        bill_id    = (data.get("bill_id") or "").strip()
        invoice_no = (data.get("invoice_no") or "").strip()
        html_body  = (data.get("html_content") or "").strip()

        if not bill_id or not html_body:
            return jsonify(success=False,
                           message="bill_id and html_content are required"), 400

        # ── Guard: never create a v2 if a PDF already exists ─────────────────
        bill_snap = bills_ref.document(bill_id).get()
        if bill_snap.exists:
            existing_url = (bill_snap.to_dict() or {}).get("pdf_url")
            if existing_url:
                logger.info(f"render_bill_pdf: PDF already exists for {bill_id}, skipping")
                return jsonify(success=True, pdf_url=existing_url,
                               version=None, skipped=True)

        # ── Convert HTML → PDF bytes ──────────────────────────────────────────
        try:
            from xhtml2pdf import pisa
        except ImportError:
            return jsonify(
                success=False,
                message="xhtml2pdf not installed. Run: pip install xhtml2pdf==0.2.16"
            ), 500

        full_html = _build_pdf_html(html_body)

        import io
        pdf_buf = io.BytesIO()
        result  = pisa.CreatePDF(full_html, dest=pdf_buf)

        if result.err:
            logger.error(f"render_bill_pdf: xhtml2pdf error for {bill_id}: {result.err}")
            return jsonify(success=False,
                           message=f"PDF conversion error (code {result.err})"), 500

        pdf_bytes = pdf_buf.getvalue()

        # ── Upload to Firebase Storage ────────────────────────────────────────
        folder = invoice_no or bill_id
        upload = pdf_service.upload_bill_pdf(bill_id, folder, pdf_bytes)

        if not upload.get("url"):
            return jsonify(success=False,
                           message="PDF upload to Firebase Storage failed"), 500

        return jsonify(
            success=True,
            pdf_url=upload["url"],
            version=upload["version"],
            message=f"PDF v{upload['version']} generated and saved",
        )

    except Exception as e:
        logger.error(f"render_bill_pdf error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500
