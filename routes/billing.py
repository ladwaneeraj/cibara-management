"""
Billing & Register routes.

All READ operations use the `payments` collection as primary data source.
Expense reads use the dedicated `expenses` collection via expense_service.
Old `logs` collection is NOT used for reads anymore.
"""

from flask import Blueprint, request, jsonify
from datetime import datetime, timedelta
from google.cloud.firestore_v1.base_query import FieldFilter
from firebase_admin import firestore

from config import (
    db, rooms_ref, bills_ref, logs_ref, totals_ref, counters_ref,
    metadata_ref, IST, logger, settlements_ref, settings_ref,
    _build_active_entry_fast, _find_serial_fast, _batch_fill_serials,
    get_all_rooms, invalidate_rooms_and_totals,
    get_billing_config, invalidate_billing_config_cache,
    get_ui_config, invalidate_ui_config_cache,
)
from services import payment_service, pdf_service, expense_service

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
                # Canonical stay foreign key. Set by /checkin (Phase 2). For
                # legacy active stays (checked in before Phase 2 went live),
                # this field is absent — the Payment Records modal will
                # fall back to the heuristic lookup.
                "stay_id": room_data_item.get("active_bill_id"),
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
                # Include add_ons so the payment modal can display services
                "services": room_data_item.get("add_ons", []),
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
                    # Canonical stay foreign key. For new stays this equals
                    # bill_doc.id (UUID4). For legacy stays, the Phase-7
                    # backfill stamps stay_id == bill_doc.id; we fall through
                    # to bill_doc.id as the default here for any not-yet-
                    # backfilled bills so the Phase-6 lookup still works.
                    "stay_id": bill_data.get("stay_id") or bill_doc.id,
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
                    # GST invoice flag
                    "invoice_generated": bill_data.get("invoice_generated", False),
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

            # Expenses today — read from dedicated expenses collection
            today_expenses = expense_service.query_expenses_for_today(today_str)
            for p in today_expenses:
                if p.get("expense_type") == "transaction":
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

        # If no results, search by guest name / mobile — limit to last 90 days so we
        # don't stream the entire historical bills collection on every name search.
        if not results:
            cutoff = (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d") + " 00:00"
            all_bills = (
                bills_ref
                .where("checkin_time", ">=", cutoff)
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




# ══════════════════════════════════════════════════════════════════════════════
# BILLING CONFIG (Settings → Bill generation toggle)
# ══════════════════════════════════════════════════════════════════════════════
# Two endpoints back the toggle in the Settings modal:
#   GET  /settings/billing_config  → current config (defaults filled in)
#   POST /settings/billing_config  → update one or more keys
# Both inherit the global X-API-Key check applied at the app level. The UI
# additionally gates the Settings modal behind the manager password before
# this endpoint is ever called.

@billing_bp.route("/settings/billing_config", methods=["GET"])
def get_billing_config_endpoint():
    try:
        cfg = get_billing_config()
        return jsonify(success=True, config=cfg)
    except Exception as e:
        logger.error(f"get_billing_config_endpoint error: {e}")
        return jsonify(success=False, message=str(e)), 500


@billing_bp.route("/settings/billing_config", methods=["POST"])
def update_billing_config_endpoint():
    try:
        data = request.get_json(silent=True) or {}

        # Whitelist + type-coerce. Adding new keys here is the only path to
        # changing what the toggle persists — we do NOT blindly write whatever
        # the client sends.
        update = {}
        if "always_generate_bill" in data:
            update["always_generate_bill"] = bool(data["always_generate_bill"])

        if not update:
            return jsonify(success=False,
                           message="No recognised settings keys in body"), 400

        # merge=True so we can add future keys without clobbering existing ones.
        settings_ref.document('billing_config').set(update, merge=True)
        invalidate_billing_config_cache()

        # Return the freshly-merged config so the client can update its UI from
        # one source of truth.
        cfg = get_billing_config()
        logger.info(f"billing_config updated: {update}")
        return jsonify(success=True, config=cfg)
    except Exception as e:
        logger.error(f"update_billing_config_endpoint error: {e}")
        return jsonify(success=False, message=str(e)), 500


# ══════════════════════════════════════════════════════════════════════════════
# UI CONFIG (Settings → tab visibility, etc.)
# ══════════════════════════════════════════════════════════════════════════════
# Tenant-wide UI flags. Same shape as /settings/billing_config but separated
# so a UI flip doesn't touch billing logic and vice versa. Real-time sync to
# other browsers is handled by an onSnapshot listener in google_sync.js.

@billing_bp.route("/settings/ui_config", methods=["GET"])
def get_ui_config_endpoint():
    try:
        cfg = get_ui_config()
        return jsonify(success=True, config=cfg)
    except Exception as e:
        logger.error(f"get_ui_config_endpoint error: {e}")
        return jsonify(success=False, message=str(e)), 500


@billing_bp.route("/settings/ui_config", methods=["POST"])
def update_ui_config_endpoint():
    try:
        data = request.get_json(silent=True) or {}

        # Whitelist + type-coerce. New flags must be added here explicitly.
        update = {}
        if "hide_register_tab" in data:
            update["hide_register_tab"] = bool(data["hide_register_tab"])

        if not update:
            return jsonify(success=False,
                           message="No recognised settings keys in body"), 400

        settings_ref.document('ui_config').set(update, merge=True)
        invalidate_ui_config_cache()
        cfg = get_ui_config()
        logger.info(f"ui_config updated: {update}")
        return jsonify(success=True, config=cfg)
    except Exception as e:
        logger.error(f"update_ui_config_endpoint error: {e}")
        return jsonify(success=False, message=str(e)), 500


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
            new_total_discounts = bill_data.get("discounts", 0) + discount
            bill_update["discounts"] = new_total_discounts

            # ── Recalculate gst_amount on post-discount base (Sec 15(3)(a)) ────
            # This keeps the stored gst_amount in sync with what the invoice shows.
            _gst_rate   = bill_data.get("gst_rate", 0)
            _room_chrg  = bill_data.get("room_charges_total", 0) or 0
            _services   = bill_data.get("services") or []
            _accom_addons_total = sum(
                s.get("price", 0) for s in _services
                if s.get("accommodation_charge")
                and "water" not in (s.get("item") or "").lower()
            )
            _accom_total        = _room_chrg + _accom_addons_total
            _discount_on_accom  = min(new_total_discounts, _accom_total)
            _effective_accom    = _accom_total - _discount_on_accom
            if _gst_rate > 0 and _effective_accom > 0:
                bill_update["gst_amount"] = round(
                    _effective_accom * _gst_rate / (100 + _gst_rate), 2
                )
            elif _gst_rate > 0:
                bill_update["gst_amount"] = 0.0

        new_balance = current_balance - amount - discount
        bill_update["balance"] = new_balance

        if new_balance <= 0:
            bill_update["status"] = "completed"
            # Mark invoice_generated for UPI payments if not already flagged
            if payment_mode == "online" and not bill_data.get("invoice_generated"):
                bill_update["invoice_generated"] = True

        # Make sure stay_id is stamped onto the bill doc (idempotent — the
        # field equals the doc ID for every stay). Lets Phase-6 queries
        # resolve linked payments without waiting for the Phase-7 backfill.
        if not bill_data.get("stay_id"):
            bill_update["stay_id"] = bill_id

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
        # bill_id is the canonical stay_id — for new stays it's the UUID
        # minted at check-in; for legacy stays it's {room}_{ts} which the
        # Phase-7 backfill stamps onto the bill doc as stay_id. Either way,
        # passing it through write_payment_with_stay creates a payment that
        # joins back to its bill via stay_id.
        if amount > 0:
            payment_service.write_payment_with_stay(bill_id, {
                **_base,
                "amount":           amount,
                "method":           payment_mode,
                "type":             "settlement_payment",
                "transaction_type": "settlement_payment",
            })
        if discount > 0:
            payment_service.write_payment_with_stay(bill_id, {
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
        )

    except Exception as e:
        logger.error(f"Error in add_bill_payment: {str(e)}")
        return jsonify(success=False, message=f"Error: {str(e)}")


# ══════════════════════════════════════════════════════════════════════════════
# MANAGER PASSWORD HELPER (local copy — avoids circular import with rooms.py)
# ══════════════════════════════════════════════════════════════════════════════

def _check_manager_password(provided: str) -> bool:
    import os as _os
    expected = _os.environ.get("MANAGER_PASSWORD", "manager@1234")
    return provided == expected


# ══════════════════════════════════════════════════════════════════════════════
# RECALCULATE BILL — recompute payment totals from payments collection
# ══════════════════════════════════════════════════════════════════════════════

@billing_bp.route("/recalculate_bill", methods=["POST"])
def recalculate_bill():
    """
    Re-fetch all payment records for a stay and update the bill document's
    payment_cash, payment_online, and balance fields.
    Triggered after a payment edit so the bill reflects the corrected amounts.
    Also fires a background PDF regeneration so the new version is stored.
    """
    try:
        data     = request.json or {}
        password = data.get("password", "")
        bill_id  = (data.get("bill_id") or "").strip()

        if not _check_manager_password(password):
            return jsonify(success=False, message="Incorrect password"), 403

        if not bill_id:
            return jsonify(success=False, message="bill_id is required"), 400

        bill_snap = bills_ref.document(bill_id).get()
        if not bill_snap.exists:
            return jsonify(success=False, message="Bill not found"), 404

        bill_data    = bill_snap.to_dict()
        room         = str(bill_data.get("room", ""))
        guest_name   = bill_data.get("guest_name", "")
        checkin_time = bill_data.get("checkin_time", "")

        if not room or not guest_name or not checkin_time:
            return jsonify(success=False, message="Bill is missing required fields"), 400

        checkin_dt = datetime.strptime(checkin_time, "%Y-%m-%d %H:%M")

        stay_payments = payment_service.query_payments_for_stay(
            room, guest_name, checkin_dt
        ) or []

        _exclude      = ("refund", "checkout_refund", "manual_refund",
                         "booking_cancel_refund", "discount", "expense")
        _refund_types = ("refund", "checkout_refund", "manual_refund",
                         "booking_cancel_refund")

        payment_cash = sum(
            p.get("amount", 0) for p in stay_payments
            if p.get("method") == "cash" and p.get("type") not in _exclude
        )
        payment_online = sum(
            p.get("amount", 0) for p in stay_payments
            if p.get("method") == "online" and p.get("type") not in _exclude
        )
        total_refunds = sum(
            p.get("amount", 0) for p in stay_payments
            if p.get("type") in _refund_types
        )

        total_amount = bill_data.get("total_amount", 0)
        new_balance  = total_amount - payment_cash - payment_online + total_refunds

        bills_ref.document(bill_id).update({
            "payment_cash":   payment_cash,
            "payment_online": payment_online,
            "balance":        new_balance,
        })

        # Background PDF regeneration
        updated_bill = dict(bill_data)
        updated_bill.update({
            "payment_cash":   payment_cash,
            "payment_online": payment_online,
            "balance":        new_balance,
        })
        import threading as _thr
        _thr.Thread(
            target=auto_generate_bill_pdf,
            args=(bill_id, updated_bill),
            daemon=True,
        ).start()

        logger.info(
            f"recalculate_bill: {bill_id} → cash={payment_cash} "
            f"online={payment_online} balance={new_balance}"
        )
        return jsonify(
            success=True,
            message="Bill recalculated and PDF queued",
            payment_cash=payment_cash,
            payment_online=payment_online,
            balance=new_balance,
        )

    except Exception as e:
        logger.error(f"recalculate_bill error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {str(e)}"), 500


# ══════════════════════════════════════════════════════════════════════════════
# UPDATE BILL SERVICE — change a service price and regenerate bill totals + PDF
# ══════════════════════════════════════════════════════════════════════════════

@billing_bp.route("/update_bill_service", methods=["POST"])
def update_bill_service():
    """
    Edit the price of a single service in a completed bill.
    Recalculates services_total, total_amount, balance, then fires a
    background PDF regeneration so the new version lands in bills module.
    """
    try:
        data          = request.json or {}
        password      = data.get("password", "")
        bill_id       = (data.get("bill_id") or "").strip()
        svc_index_raw = data.get("service_index")
        new_price_raw = data.get("new_price")

        if not _check_manager_password(password):
            return jsonify(success=False, message="Incorrect password"), 403

        if not bill_id or svc_index_raw is None or new_price_raw is None:
            return jsonify(
                success=False,
                message="bill_id, service_index, and new_price are required"
            ), 400

        try:
            svc_index = int(svc_index_raw)
            new_price = int(new_price_raw)
        except (ValueError, TypeError):
            return jsonify(
                success=False,
                message="service_index and new_price must be integers"
            ), 400

        if new_price < 0:
            return jsonify(success=False, message="Price cannot be negative"), 400

        bill_snap = bills_ref.document(bill_id).get()
        if not bill_snap.exists:
            return jsonify(success=False, message="Bill not found"), 404

        bill_data = bill_snap.to_dict()
        services  = list(bill_data.get("services", []))

        if svc_index < 0 or svc_index >= len(services):
            return jsonify(success=False, message="Service index out of range"), 400

        old_price = services[svc_index].get("price", 0)
        services[svc_index]["price"]      = new_price
        services[svc_index]["unit_price"] = new_price  # single-unit assumption

        services_total     = sum(s.get("price", 0) for s in services)
        total_discounts    = bill_data.get("discounts", 0)
        room_charges_total = bill_data.get("room_charges_total", 0)
        total_amount       = room_charges_total + services_total - total_discounts

        payment_cash   = bill_data.get("payment_cash", 0)
        payment_online = bill_data.get("payment_online", 0)
        total_refunds  = bill_data.get("refunds", 0)
        new_balance    = total_amount - payment_cash - payment_online + total_refunds

        # ── Recalculate gst_amount if an accommodation add-on was edited ─────
        # Accommodation add-ons (extra bed, AC) affect the GST base under SAC 9963.
        # Recalculate on the new effective accommodation total (post-discount).
        _svc_gst_rate      = bill_data.get("gst_rate", 0)
        _accom_addons_total = sum(
            s.get("price", 0) for s in services
            if s.get("accommodation_charge")
            and "water" not in (s.get("item") or "").lower()
        )
        _accom_total        = room_charges_total + _accom_addons_total
        _discount_on_accom  = min(total_discounts, _accom_total)
        _effective_accom    = _accom_total - _discount_on_accom
        if _svc_gst_rate > 0 and _effective_accom > 0:
            new_gst_amount = round(
                _effective_accom * _svc_gst_rate / (100 + _svc_gst_rate), 2
            )
        elif _svc_gst_rate > 0:
            new_gst_amount = 0.0
        else:
            new_gst_amount = bill_data.get("gst_amount", 0)  # unchanged if exempt

        bills_ref.document(bill_id).update({
            "services":       services,
            "services_total": services_total,
            "total_amount":   total_amount,
            "balance":        new_balance,
            "gst_amount":     new_gst_amount,
        })

        updated_bill = dict(bill_data)
        updated_bill.update({
            "services":       services,
            "services_total": services_total,
            "total_amount":   total_amount,
            "balance":        new_balance,
            "gst_amount":     new_gst_amount,
        })

        import threading as _thr
        _thr.Thread(
            target=auto_generate_bill_pdf,
            args=(bill_id, updated_bill),
            daemon=True,
        ).start()

        logger.info(
            f"update_bill_service: {bill_id} idx={svc_index} "
            f"item={services[svc_index].get('item')} "
            f"price {old_price}→{new_price}"
        )
        return jsonify(success=True, message="Service updated and bill PDF queued")

    except Exception as e:
        logger.error(f"update_bill_service error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {str(e)}"), 500


# ══════════════════════════════════════════════════════════════════════════════
# SAVE BILL PDF — upload generated PDF to Firebase Storage, store URL in bill
# ══════════════════════════════════════════════════════════════════════════════

@billing_bp.route("/save_bill_pdf", methods=["POST"])
def save_bill_pdf():
    """
    Accept a base64-encoded PDF from the browser, upload it to Firebase Storage
    under bills/{bill_number}/v{n}.pdf, and save the download URL in the bill
    document (pdf_url field + versions array for audit history).

    Request JSON:
        bill_id     — Firestore document ID of the bill
        bill_number — used as the Storage folder name (e.g. "CC/2026/04/00001")
        pdf_base64  — base64-encoded PDF bytes (without data-URI prefix)

    Response JSON:
        success, pdf_url, version
    """
    import base64

    try:
        data = request.json or {}
        bill_id     = (data.get("bill_id") or "").strip()
        bill_number = (data.get("bill_number") or data.get("invoice_no") or "").strip()
        pdf_b64     = (data.get("pdf_base64") or "").strip()

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

        folder = bill_number or bill_id
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

    # ── Water vs non-water split (water = GST 5% inclusive / MRP; others = non-taxable) ──
    water_services_raw     = [s for s in other_services if "water" in s.get("item", "").lower()]
    non_water_services_raw = [s for s in other_services if "water" not in s.get("item", "").lower()]

    # ── Consolidate duplicate items (e.g. "Water 2L" added at different times → one row) ──
    def _consolidate_services(svc_list):
        """Group by item name, sum qty and price; keep unit_price from first entry."""
        grouped = {}
        for s in svc_list:
            key = (s.get("item") or "Service").strip().lower()
            if key not in grouped:
                grouped[key] = {
                    "item":               s.get("item", "Service"),
                    "quantity":           int(s.get("quantity", 1)),
                    "unit_price":         float(s.get("unit_price") or s.get("price", 0)),
                    "price":              float(s.get("price", 0)),
                    "accommodation_charge": s.get("accommodation_charge", False),
                }
            else:
                grouped[key]["quantity"] += int(s.get("quantity", 1))
                grouped[key]["price"]    += float(s.get("price", 0))
        return list(grouped.values())

    water_services      = _consolidate_services(water_services_raw)
    non_water_services  = _consolidate_services(non_water_services_raw)
    water_svc_total     = sum(s.get("price", 0) for s in water_services)
    non_water_svc_total = sum(s.get("price", 0) for s in non_water_services)

    gst_rate_pct = b.get("gst_rate", 0)
    cgst_rate    = gst_rate_pct / 2
    sgst_rate    = gst_rate_pct / 2

    # Use the stored room_charges_total when available — this is always correct,
    # including when the room price changed mid-stay (room transfer or AC add-on).
    # Fall back to rate × days only for old bills that pre-date this field.
    room_charges  = b.get("room_charges_total") or (rate * days)
    accom_total   = room_charges + accom_addons_total

    discounts    = b.get("discounts") or 0

    # ── GST display strategy ──────────────────────────────────────────────────
    # Section 15(3)(a) CGST Act: pre-supply discounts (given at time of supply)
    # reduce the taxable value. GST must be computed on (accom_total - discount).
    # We prorate the discount to accommodation first; any excess goes to services.
    discount_on_accom    = min(discounts, accom_total)
    effective_accom      = accom_total - discount_on_accom   # post-discount base

    stored_gst = b.get("gst_amount")
    if gst_rate_pct > 0:
        # Always recalculate on effective (post-discount) accommodation amount.
        # Handles: full waiver (effective=0 → gst=0), partial discount, old bills.
        gst_divisor = 100 + gst_rate_pct
        gst_amt     = effective_accom * gst_rate_pct / gst_divisor
    else:
        gst_amt = 0
    cgst       = gst_amt / 2
    sgst       = cgst
    accom_base = effective_accom - gst_amt   # net taxable base (excl. GST)
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

    # ── Water service rows (GST 5% inclusive — show taxable value in Amount col) ──
    # taxable_value = price / 1.05  (back-calculate from MRP)
    # final price (MRP) is unchanged — no amount added
    _water_cgst = 0.0
    _water_sgst = 0.0
    for _w in water_services:
        _w_price = float(_w.get("price", 0))
        _w_gst   = _w_price - (_w_price / 1.05)
        _water_cgst += _w_gst / 2
        _water_sgst += _w_gst / 2

    water_rows = "".join(
        f'<tr><td>{s.get("item", "Water")}</td>'
        f'<td class="b-tr">{s.get("quantity", 1)}</td>'
        f'<td class="b-tr">{_f2(float(s.get("unit_price") or s.get("price", 0)) / 1.05)}</td>'
        f'<td class="b-tr">{_f2(float(s.get("price", 0)) / 1.05)}</td></tr>'
        for s in water_services
    )
    water_svc_section = (
        f'<tr class="b-sec"><td colspan="4">Packaged Drinking Water (HSN: 2201)</td></tr>'
        f'{water_rows}'
        f'<tr class="b-gst-row"><td>CGST @ 2.5%</td>'
        f'<td class="b-tr">—</td><td class="b-tr">—</td>'
        f'<td class="b-tr">{_f2(_water_cgst)}</td></tr>'
        f'<tr class="b-gst-row"><td>SGST @ 2.5%</td>'
        f'<td class="b-tr">—</td><td class="b-tr">—</td>'
        f'<td class="b-tr">{_f2(_water_sgst)}</td></tr>'
        f'<tr class="b-subtotal"><td colspan="3" class="b-tr">Water Total (MRP, incl. GST)</td>'
        f'<td class="b-tr">{_f2(water_svc_total)}</td></tr>'
    ) if water_services else ""

    # ── Other service rows (non-water, non-taxable) ──
    other_svc_rows = "".join(
        f'<tr><td>{s.get("item","Service")}</td>'
        f'<td class="b-tr">{s.get("quantity",1)}</td>'
        f'<td class="b-tr">{_f2(s.get("unit_price") or s.get("price",0))}</td>'
        f'<td class="b-tr">{_f2(s.get("price",0))}</td></tr>'
        for s in non_water_services
    )

    # ── GST rows — only if effective accommodation > 0 after discount ────────
    if gst_rate_pct > 0 and effective_accom > 0:
        gst_rows = (
            f'<tr class="b-gst-row"><td>CGST @ {cgst_rate}%</td>'
            f'<td class="b-tr">—</td><td class="b-tr">—</td>'
            f'<td class="b-tr">{_f2(cgst)}</td></tr>'
            f'<tr class="b-gst-row"><td>SGST @ {sgst_rate}%</td>'
            f'<td class="b-tr">—</td><td class="b-tr">—</td>'
            f'<td class="b-tr">{_f2(sgst)}</td></tr>'
        )
    elif gst_rate_pct > 0 and effective_accom <= 0:
        # Full discount — GST waived per Sec 15(3)(a) CGST Act
        gst_rows = (
            f'<tr class="b-gst-row"><td colspan="3" style="color:#2e7d32;">'
            f'GST Nil (Discount applied — Sec 15(3)(a) CGST Act)</td>'
            f'<td class="b-tr">0.00</td></tr>'
        )
    else:
        gst_rows = ""

    # Accommodation subtotal shows pre-discount total; discount row below explains reduction
    _is_multi_room = (_is_new_format and len(room_segments) > 1) or (not _is_new_format and room_segments)
    accom_subtotal_row = (
        f'<tr class="b-subtotal">'
        f'<td colspan="3" class="b-tr">Accommodation Total (incl. GST)</td>'
        f'<td class="b-tr">{_f2(accom_total)}</td></tr>'
        if accom_addons or days > 1 or _is_multi_room else ""
    )

    other_svc_section = (
        f'<tr class="b-sec"><td colspan="4">Additional Services (Non-Taxable)</td></tr>'
        f'{other_svc_rows}'
        f'<tr class="b-subtotal"><td colspan="3" class="b-tr">Services Total</td>'
        f'<td class="b-tr">{_f2(non_water_svc_total)}</td></tr>'
        if other_svc_rows else ""
    )

    # Discount row — shown above grand total
    discount_row = (
        f'<tr><td colspan="3" style="text-align:right;color:#2e7d32;font-weight:600;">'
        f'Discount</td>'
        f'<td class="b-tr" style="color:#2e7d32;font-weight:700;">- {_f2(discounts)}</td></tr>'
        if discounts > 0 else ""
    )

    # ── Round-off row ────────────────────────────────────────────────────────
    # GST back-calculation (price / 1.0x) can leave a ₹0.01 floating-point gap
    # between (taxable_base + CGST + SGST) and the actual MRP charged.
    # A round-off row makes the invoice self-consistent and is standard practice.
    _computed_accom_sum = round(accom_base + cgst + sgst, 2)
    _round_diff = round(effective_accom - _computed_accom_sum, 2)
    round_off_row = (
        f'<tr class="b-gst-row"><td colspan="3" style="text-align:right;color:#888;">Round-off</td>'
        f'<td class="b-tr" style="color:#888;">{("+" if _round_diff > 0 else "")}{_f2(_round_diff)}</td></tr>'
        if abs(_round_diff) >= 0.01 else ""
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

    paid_full_row = ""  # removed — balance row already shows ₹0 when settled

    # ── Helper: GST slab for a given per-night price ─────────────────────────
    def _seg_gst_rate(price):
        if price < 1000: return 0
        elif price <= 7500: return 5
        else: return 18

    def _seg_taxable(total_incl, price):
        """Pre-GST taxable value for a segment given its inclusive total."""
        r = _seg_gst_rate(price)
        return total_incl / (1 + r / 100) if r > 0 else total_incl

    # ── Room Rent rows: pre-GST values, one per segment for transfer stays ────
    room_segments = b.get("room_segments") or []

    # Detect format: new format has "room" key; old format has "from_room" key
    # Old format also needs current_room_* fields from the bill document.
    _is_new_format = bool(room_segments and "room" in room_segments[0])

    if _is_new_format and len(room_segments) > 1:
        # NEW FORMAT — multi-room stay: render all segments from the clean array
        room_rent_rows = ""
        for seg in room_segments:
            seg_room   = seg.get("room", "")
            seg_nights = seg.get("nights", 0)
            seg_rate   = seg.get("rate", 0)
            seg_total  = seg.get("total", 0)
            if seg_nights > 0:
                seg_tax      = _seg_taxable(seg_total, seg_rate)
                seg_rate_ex  = seg_tax / seg_nights if seg_nights else 0
                room_rent_rows += (
                    f'<tr><td>Room Rent – Rm {seg_room}</td>'
                    f'<td class="b-tr">{seg_nights}</td>'
                    f'<td class="b-tr">{_f2(seg_rate_ex)}</td>'
                    f'<td class="b-tr">{_f2(seg_tax)}</td></tr>'
                )
    elif not _is_new_format and room_segments:
        # OLD FORMAT — backward compat for bills created before this change
        current_room_no    = b.get("current_room") or b.get("room", "")
        current_room_days  = b.get("current_room_days")
        current_room_price = b.get("current_room_price")
        current_room_total = b.get("current_room_total")
        room_rent_rows = ""
        for seg in room_segments:
            seg_room  = seg.get("from_room", "")
            seg_days  = seg.get("days", 0)
            seg_price = seg.get("price", 0)
            seg_total = seg.get("total", 0)
            if seg_days > 0:
                seg_tax  = _seg_taxable(seg_total, seg_price)
                seg_rate = seg_tax / seg_days if seg_days else 0
                room_rent_rows += (
                    f'<tr><td>Room Rent – Rm {seg_room}</td>'
                    f'<td class="b-tr">{seg_days}</td>'
                    f'<td class="b-tr">{_f2(seg_rate)}</td>'
                    f'<td class="b-tr">{_f2(seg_tax)}</td></tr>'
                )
        if (current_room_days or 0) > 0:
            curr_tax  = _seg_taxable(current_room_total or 0, current_room_price or 0)
            curr_rate = curr_tax / current_room_days if current_room_days else 0
            room_rent_rows += (
                f'<tr><td>Room Rent – Rm {current_room_no}</td>'
                f'<td class="b-tr">{current_room_days}</td>'
                f'<td class="b-tr">{_f2(curr_rate)}</td>'
                f'<td class="b-tr">{_f2(curr_tax)}</td></tr>'
            )
    else:
        # Single-room stay — show pre-GST taxable base
        room_rent_rows = (
            f'<tr><td>Room Rent</td>'
            f'<td class="b-tr">{days}</td>'
            f'<td class="b-tr">{_f2(accom_base / (days or 1))}</td>'
            f'<td class="b-tr">{_f2(accom_base)}</td></tr>'
        )

    # For add-on stays, show a "Taxable Base" row so the math is transparent
    taxable_base_row = (
        f'<tr class="b-gst-row"><td>Taxable Base (excl. GST)</td>'
        f'<td class="b-tr">—</td><td class="b-tr">—</td>'
        f'<td class="b-tr">{_f2(accom_base)}</td></tr>'
        if accom_addons else ""
    )

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
      {room_rent_rows}
      {accom_addon_rows}
      {taxable_base_row}
      {gst_rows}
      {round_off_row}
      {accom_subtotal_row}
      {water_svc_section}
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

        folder = bill_record.get("bill_number") or bill_id
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

    Request JSON:  { bill_id, bill_number, html_content }
    Response JSON: { success, pdf_url, version, skipped? }
    """
    try:
        data        = request.json or {}
        bill_id     = (data.get("bill_id") or "").strip()
        bill_number = (data.get("bill_number") or data.get("invoice_no") or "").strip()
        html_body   = (data.get("html_content") or "").strip()

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
        folder = bill_number or bill_id
        upload = pdf_service.upload_bill_pdf(bill_id, folder, pdf_bytes)

        if not upload.get("url"):
            return jsonify(success=False,
                           message="PDF upload to Firebase Storage failed"), 500

        return jsonify(
            success=True,
            pdf_url=upload["url"],
            version=upload["version"],
            message=f"PDF v{upload['version']} generated successfully",
        )

    except Exception as e:
        logger.error(f"render_bill_pdf error: {str(e)}", exc_info=True)
        return jsonify(success=False, message=f"Error generating PDF: {str(e)}"), 500
