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
    credit_notes_ref, bookings_ref,
    _build_active_entry_fast, _find_serial_fast, _batch_fill_serials,
    get_all_rooms, invalidate_rooms_and_totals,
    get_billing_config, invalidate_billing_config_cache,
    get_ui_config, invalidate_ui_config_cache,
    validate_gstin, derive_state_from_gstin, classify_invoice_type,
    compute_gst_split, _STATE_CODE_TO_NAME,
    create_credit_note, compute_credit_components, CN_REASONS,
)
from services import payment_service, pdf_service, expense_service
from services import system_alerts
from services import gst_lock_service
from services.auth_service import requires_permission
from services.audit_log import write_log, attribution_update, _safe_user
from services.role_filters import clamp_date_range

billing_bp = Blueprint('billing', __name__)


def _month_lock_response(bill, action):
    """
    Return a (response, status) tuple if the bill's GST month is locked,
    else None. Single chokepoint so every mutating bill route states the
    same policy and message. The relevant period is the month of the
    bill's checkout_time (= the GSTR-1 period the invoice was reported in).
    """
    period = gst_lock_service.normalize_period(bill.get("checkout_time") or "")
    if period and gst_lock_service.is_month_locked(period):
        return (
            jsonify(
                success=False,
                month_locked=True,
                message=(
                    f"GST period {period} is locked (GSTR-1 filed) — "
                    f"{action} is not allowed. Issue a credit note "
                    f"(Section 34) for corrections, or ask an admin to "
                    f"unlock the month in the Bills tab."
                ),
            ),
            409,
        )
    return None


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

        # `mode` selects which timestamp the date range filters on.
        #   "checkin"  (default) — used by the Register tab. Includes active
        #                          (still-checked-in) rooms whose checkin_time
        #                          falls in range.
        #   "checkout"           — used by the Bills tab. A bill belongs to the
        #                          GST month it was actually invoiced (i.e. the
        #                          checkout date), NOT the day the guest walked
        #                          in. Active rooms are excluded since they have
        #                          no checkout_time yet.
        mode = (data_json.get("mode") or "checkin").lower()
        if mode not in ("checkin", "checkout"):
            mode = "checkin"

        if not start_date or not end_date:
            return jsonify(success=False, message="Start and end dates are required")

        # ── RBAC: clamp to last 3 days for non-admin users ────────────────────
        start_date, end_date = clamp_date_range(start_date, end_date)

        start_dt = datetime.strptime(start_date, "%Y-%m-%d")
        end_dt = datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1)

        range_start_str = start_dt.strftime("%Y-%m-%d %H:%M")
        range_end_str = end_dt.strftime("%Y-%m-%d %H:%M")

        logger.info(f"=== REGISTER ({mode}): {start_date} to {end_date} ===")

        import time as _t
        from concurrent.futures import ThreadPoolExecutor
        t0 = _t.time()

        # ── One parallel wave for EVERY independent Firestore fetch ──────────
        # rooms, range payments, range bills, the three Daily-Tally queries,
        # and the per-active-room stay-payment lookups have no data
        # dependencies on each other. They used to run sequentially (4–6
        # back-to-back round-trips, plus one payment query PER occupied room
        # inside the loop below — the dominant cost of this endpoint).
        # Submitting them all here collapses wall-clock to roughly the
        # slowest single query. Each result is consumed at the same point in
        # the flow as before, so per-consumer error handling is unchanged.
        today_str = datetime.now(IST).strftime("%Y-%m-%d")

        # In checkout mode the date range filters on `checkout_time` so a
        # bill belongs to the GST month it was actually invoiced. In checkin
        # mode (legacy / Register tab) we keep the original behaviour and
        # filter on `checkin_time`.
        _range_field = "checkout_time" if mode == "checkout" else "checkin_time"
        _bills_query = (
            bills_ref
            .where(filter=FieldFilter(_range_field, ">=", range_start_str))
            .where(filter=FieldFilter(_range_field, "<", range_end_str))
        )
        # Pending OTA settlements (MMT + Agoda) for the tally (sum of
        # net_receivable). Variable name kept for back-compat.
        _mmt_pending_query = (
            db.collection("bookings")
            .where("booking_source", "in", ["mmt", "agoda"])
            .where("settlement_status", "==", "pending")
        )

        stay_payment_futures = {}  # stay_id -> Future[list[payment]]
        with ThreadPoolExecutor(max_workers=16) as pool:
            f_rooms = pool.submit(get_all_rooms)
            f_payments = pool.submit(
                payment_service.query_payments_by_date_range,
                start_date, end_dt.strftime("%Y-%m-%d")
            )
            f_bills = pool.submit(lambda: list(_bills_query.stream()))
            f_today_pay = pool.submit(
                payment_service.query_payments_by_date_range, today_str, today_str
            )
            f_today_exp = pool.submit(
                expense_service.query_expenses_for_today, today_str
            )
            f_mmt_pending = pool.submit(
                lambda: [d.to_dict() for d in _mmt_pending_query.stream()]
            )

            rooms_data = f_rooms.result()

            # Pre-submit the per-occupied-room stay-payment lookups so they
            # run concurrently instead of one-by-one inside the loop below.
            # Only needed in checkin mode (checkout mode skips active rooms).
            if mode != "checkout" and hasattr(payment_service,
                                             "query_payments_by_stay_id"):
                for _rn, _rd in rooms_data.items():
                    if _rd.get("status") != "occupied":
                        continue
                    _sid = _rd.get("active_bill_id")
                    if not _sid:
                        continue
                    # Denormalized sums stamped on the room doc make the
                    # per-room payments query unnecessary (see
                    # payment_service.refresh_room_stay_aggregates).
                    if (_rd.get("stay_payment_for") == _sid
                            and _rd.get("stay_payment_cash") is not None):
                        continue
                    stay_payment_futures[_sid] = pool.submit(
                        payment_service.query_payments_by_stay_id, _sid
                    )

            range_payments = f_payments.result() or []
        # Exiting the `with` block waits for every submitted future, so all
        # results consumed below are already in memory — .result() calls
        # from here on are instant.
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
        # Skipped entirely in checkout mode: an active stay has no checkout_time
        # yet, so it can't belong to any "billed in this period" cohort. The
        # Register tab (checkin mode) still includes them.
        active_count = 0
        if mode == "checkout":
            rooms_iterable = []
        else:
            rooms_iterable = rooms_data.items()
        for room_number, room_data_item in rooms_iterable:
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

            # ── Payments lookup for active stays — keyed by stay_id ───────
            # The pre-built `payments_by_room` index is date-range scoped, so
            # it silently undercounts when a stay's check-in date was edited
            # outside the report range (e.g. operator backdates check-in and
            # the check-in payment moves with it).
            #
            # stay_id (== room.active_bill_id) is the canonical foreign key
            # every payment carries. Query by it directly when present — single
            # equality query, no date filter, complete answer. Falls back to
            # the multi-query helper only for legacy stays that pre-date the
            # stay_id migration.
            stay_id_for_lookup = room_data_item.get("active_bill_id")

            # Denormalized fast path — receipt sums stamped on the room doc
            # at payment time (payment_service.refresh_room_stay_aggregates).
            # Falls through to the live-query path when no valid stamp
            # exists (stays from before the stamps deploy, or a stamp write
            # that failed) — correctness never depends on the stamp.
            _stamp_ok = (
                stay_id_for_lookup
                and room_data_item.get("stay_payment_for") == stay_id_for_lookup
                and room_data_item.get("stay_payment_cash") is not None
            )
            if _stamp_ok:
                payment_cash = room_data_item.get("stay_payment_cash") or 0
                payment_online = room_data_item.get("stay_payment_online") or 0
            else:
                stay_payments = None
                if stay_id_for_lookup:
                    # Result of the parallel prefetch above — already
                    # completed, so .result() returns immediately. Missing
                    # key (legacy stay without stay_id) falls through to the
                    # multi-query helper, exactly as before.
                    _f_sp = stay_payment_futures.get(stay_id_for_lookup)
                    if _f_sp is not None:
                        try:
                            stay_payments = _f_sp.result()
                        except Exception as _qpe:
                            logger.warning(
                                f"query_payments_by_stay_id failed for {stay_id_for_lookup}: {_qpe}"
                            )
                            stay_payments = None
                if stay_payments is None:
                    # Fallback: stay-aware multi-query (handles legacy stays).
                    try:
                        stay_payments = payment_service.query_payments_for_stay(
                            room_str, guest_name, checkin_dt,
                            stay_id=stay_id_for_lookup,
                        )
                    except Exception as _qpe:
                        logger.warning(
                            f"query_payments_for_stay failed for room {room_str} "
                            f"({guest_name}): {_qpe}. Falling back to date-range index."
                        )
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
                # OTA / booking source — surfaced so the Register tab shows
                # the MMT badge for a live (checked-in, not-yet-checked-out)
                # MMT stay. Read off the room doc, stamped at check-in by
                # convert_booking_to_checkin. Walk-ins default to "normal".
                "booking_source": room_data_item.get("booking_source", "normal"),
                "payment_source": room_data_item.get("payment_source", "hotel"),
                # Include add_ons so the payment modal can display services
                "services": room_data_item.get("add_ons", []),
                "guest_count": guest.get("guests", 1),
                # Attribution from the live room doc — populates the
                # register-tab history popover for active stays.
                "cleanedBy":              room_data_item.get("cleanedBy"),
                "cleanedAt":              room_data_item.get("cleanedAt"),
                "inspectedBy":            room_data_item.get("inspectedBy"),
                "inspectedAt":            room_data_item.get("inspectedAt"),
                "bookedBy":               room_data_item.get("bookedBy"),
                "bookedAt":               room_data_item.get("bookedAt"),
                "lastCheckinBy":          room_data_item.get("lastCheckinBy"),
                "lastCheckinAt":          room_data_item.get("lastCheckinAt"),
                "lastCheckinTimeEditBy":  room_data_item.get("lastCheckinTimeEditBy"),
                "lastCheckinTimeEditAt":  room_data_item.get("lastCheckinTimeEditAt"),
                # Shift attribution (set by /transfer_room) — drives the
                # "Shifted A → B by" row in the room-history popover.
                "lastShiftedBy":          room_data_item.get("lastShiftedBy"),
                "lastShiftedAt":          room_data_item.get("lastShiftedAt"),
                "lastShiftedFrom":        room_data_item.get("lastShiftedFrom"),
                "lastShiftedTo":          room_data_item.get("lastShiftedTo"),
                # Active stays don't have a checkout actor yet
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
            # Range query was prefetched in the parallel wave at the top of
            # the handler (filters on checkout_time in checkout mode,
            # checkin_time otherwise). Stream already materialized — this
            # iterates in-memory docs.
            for bill_doc in f_bills.result():
                bill_data = bill_doc.to_dict()
                checkin_time = bill_data.get("checkin_time")
                checkout_time = bill_data.get("checkout_time")

                bill_status = bill_data.get("status", "completed")
                # "pending_settlement" = settle-later checkout; include these so
                # the guest still appears in the register / bills module with the
                # outstanding balance visible.
                # Revert-cancelled bills (status="cancelled" + cancelled_by_revert)
                # are surfaced ONLY in checkout mode (the Bills tab) so they show
                # there with a CANCELLED badge. The Register tab (checkin mode)
                # stays clean — it tracks live occupancy, not the bill archive.
                _is_revert_cancel = (
                    bill_status == "cancelled"
                    and bill_data.get("cancelled_by_revert")
                    and mode == "checkout"
                )
                if (bill_status not in ("completed", "checked_out",
                                        "pending_settlement", "")
                        and not _is_revert_cancel):
                    skipped_count += 1
                    # Diagnostic: a checked-out stay that vanishes from the
                    # register is almost always a bill left in an unexpected
                    # status (e.g. "draft" never finalized, or "cancelled").
                    # Log room/status/serial so the gap is traceable.
                    logger.info(
                        f"[REGISTER] skipped bill {bill_doc.id} room="
                        f"{bill_data.get('room')} status={bill_status!r} "
                        f"serial={bill_data.get('serial_number')} "
                        f"source={bill_data.get('booking_source')}"
                    )
                    continue

                if not checkin_time or not checkout_time:
                    skipped_count += 1
                    logger.info(
                        f"[REGISTER] skipped bill {bill_doc.id} room="
                        f"{bill_data.get('room')} status={bill_status!r} "
                        f"(missing checkin/checkout time) "
                        f"source={bill_data.get('booking_source')}"
                    )
                    continue

                try:
                    checkin_dt = datetime.strptime(checkin_time, "%Y-%m-%d %H:%M")
                except ValueError:
                    skipped_count += 1
                    continue

                # Dedup by stay_id (doc.id) — NOT (room, checkin_time).
                # After revert, the original bill and the fresh draft share
                # the same room + checkin_time but are separate stay docs;
                # the (room, ci) key was wrongly hiding the re-checkout row.
                # The active-rooms loop above keeps its (room, ci) dedup
                # because there's only one live stay per room at a time.
                dedup_key = ("bill", bill_doc.id)
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
                    # ── B2B / Section 34 fields (Goal 1 + Goal 2) ───────────
                    # These drive the B2B pill, REVERTED pill, GST modal
                    # pre-fill, and the GSTR-1 Excel export.
                    "invoice_type":          bill_data.get("invoice_type", "B2C"),
                    "recipient_gstin":       bill_data.get("recipient_gstin", ""),
                    "recipient_legal_name":  bill_data.get("recipient_legal_name", ""),
                    "recipient_trade_name":  bill_data.get("recipient_trade_name", ""),
                    "recipient_address":     bill_data.get("recipient_address", ""),
                    "recipient_state":       bill_data.get("recipient_state", "Karnataka"),
                    "recipient_state_code":  bill_data.get("recipient_state_code", "29"),
                    "linked_credit_note_id": bill_data.get("linked_credit_note_id"),
                    "linked_credit_note_ids": bill_data.get("linked_credit_note_ids", []),
                    "superseded_by_revert":  bill_data.get("superseded_by_revert", False),
                    "revert_credit_note_number": bill_data.get("revert_credit_note_number", ""),
                    "voided_bill_number":    bill_data.get("voided_bill_number", ""),
                    # Cancellation-charge invoice flag (SAC 999794 / 18% — Schedule II)
                    "is_cancellation_charge": bill_data.get("is_cancellation_charge", False),
                    "sac_or_hsn":             bill_data.get("sac_or_hsn", "9963"),
                    "service_description":    bill_data.get("service_description", ""),
                    "against_booking_id":     bill_data.get("against_booking_id", ""),
                    # Accommodation taxable + GST amount from create_bill_record —
                    # the export reads these to fill GSTR-1 columns directly.
                    "accommodation_taxable": bill_data.get("accommodation_taxable", 0),
                    "non_accommodation_total": bill_data.get("non_accommodation_total", 0),
                    "gst_amount":            bill_data.get("gst_amount", 0),
                    "total_amount":          bill_data.get("total_amount", 0),
                    "room_charges_total":    bill_data.get("room_charges_total", 0),
                    # Discount and services detail needed for bill re-render
                    "discounts": bill_data.get("discounts", 0),
                    "services": bill_data.get("services", []),
                    "guest_count": bill_data.get("guest_count", 1),
                    # Attribution snapshot — surfaces in the register
                    # tab's history popover (cleaned → inspected → booked
                    # → checked in → time edit → checked out).
                    "cleanedBy":              bill_data.get("cleanedBy"),
                    "cleanedAt":              bill_data.get("cleanedAt"),
                    "inspectedBy":            bill_data.get("inspectedBy"),
                    "inspectedAt":            bill_data.get("inspectedAt"),
                    "bookedBy":               bill_data.get("bookedBy"),
                    "bookedAt":               bill_data.get("bookedAt"),
                    "lastCheckinBy":          bill_data.get("lastCheckinBy"),
                    "lastCheckinAt":          bill_data.get("lastCheckinAt"),
                    "lastCheckinTimeEditBy":  bill_data.get("lastCheckinTimeEditBy"),
                    "lastCheckinTimeEditAt":  bill_data.get("lastCheckinTimeEditAt"),
                    "lastShiftedBy":          bill_data.get("lastShiftedBy"),
                    "lastShiftedAt":          bill_data.get("lastShiftedAt"),
                    "lastShiftedFrom":        bill_data.get("lastShiftedFrom"),
                    "lastShiftedTo":          bill_data.get("lastShiftedTo"),
                    "lastCheckoutBy":         bill_data.get("lastCheckoutBy"),
                    "lastCheckoutAt":         bill_data.get("lastCheckoutAt"),
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

        # ── 3b. Serial backfill — guarantee no serial vanishes ───────────────
        # A stay that consumed a daily serial number must appear in the
        # register even if its bill is missing or stuck in a status the
        # sections above exclude (e.g. an MMT booking-conversion whose draft
        # was never finalised, or a checkout that flipped the bill to
        # "cancelled"). We reconstruct a minimal entry from the payment rows
        # that carry that serial. Only serials NOT already represented by an
        # active-room or completed-bill entry are added, so this never
        # duplicates a healthy stay — it only recovers the orphans.
        try:
            present_serials = set()
            for e in register_entries:
                sn = e.get("serial_number")
                if sn:
                    try:
                        present_serials.add(int(sn))
                    except (TypeError, ValueError):
                        pass

            by_serial = {}
            for p in range_payments:
                sn = p.get("serial_number")
                if not sn or sn == 0:
                    continue
                if p.get("type") in _refund_types:
                    continue
                try:
                    sn = int(sn)
                except (TypeError, ValueError):
                    continue
                by_serial.setdefault(sn, []).append(p)

            # Anchor each orphaned serial on its check-in / conversion row,
            # then batch-fetch ALL their bill docs in ONE get_all round-trip.
            # The previous per-orphan .get() loop cost a full Firestore
            # round-trip per orphan (~0.7-1.5s each on high-latency links).
            _anchor_of = {}
            for sn, plist in by_serial.items():
                if sn in present_serials:
                    continue
                _anchor_of[sn] = next(
                    (p for p in plist
                     if p.get("type") in ("fresh_checkin", "booking_conversion")
                     or p.get("is_fresh_checkin") or p.get("is_booking_conversion")),
                    plist[0],
                )
            _orphan_bills = {}
            _orphan_sids = {a.get("stay_id") for a in _anchor_of.values()
                            if a.get("stay_id")}
            if _orphan_sids:
                try:
                    for _snap in db.get_all(
                            [bills_ref.document(s) for s in _orphan_sids]):
                        if _snap.exists:
                            _orphan_bills[_snap.id] = _snap.to_dict() or {}
                except Exception as _ga_err:
                    logger.warning(f"[REGISTER] orphan bill batch-get failed: {_ga_err}")
                    _orphan_bills = {}

            recovered = 0
            for sn, anchor in _anchor_of.items():
                guest_name = anchor.get("name", "")
                room_str = str(anchor.get("room", ""))
                if not guest_name:
                    continue
                plist = by_serial[sn]

                cash_sum = sum(p.get("amount", 0) for p in plist
                               if p.get("method") == "cash")
                online_sum = sum(p.get("amount", 0) for p in plist
                                 if p.get("method") in ("online", "upi", "card"))
                ota_sum = sum(p.get("amount", 0) for p in plist
                              if p.get("method") == "ota")
                is_mmt = any(
                    p.get("platform") == "mmt" or p.get("method") == "ota"
                    or p.get("type") == "ota_prepaid"
                    for p in plist
                )

                # Enrich from the bill doc (ANY status) when we can resolve
                # it — already fetched above in the single get_all round-trip.
                stay_id = anchor.get("stay_id")
                bill = _orphan_bills.get(stay_id, {}) if stay_id else {}

                checkin_time = bill.get("checkin_time") or (
                    f"{anchor.get('date', '')} {anchor.get('time', '')}".strip()
                )
                total_amount = bill.get("total_amount") or (ota_sum + cash_sum + online_sum)

                register_entries.append({
                    "id": f"recovered_{sn}_{room_str}",
                    "stay_id": stay_id,
                    "bill_number": bill.get("bill_number", "-"),
                    "guest_name": guest_name,
                    "guest_mobile": anchor.get("mobile", "") or bill.get("guest_mobile", ""),
                    "room": room_str,
                    "checkin_time": checkin_time,
                    "checkout_time": bill.get("checkout_time"),
                    "days_stayed": bill.get("days_stayed", 1),
                    "room_rent": bill.get("room_price_per_night", 0),
                    "room_charges": bill.get("room_charges_total", total_amount),
                    "services_total": bill.get("services_total", 0),
                    "total_amount": total_amount,
                    "payment_cash": cash_sum,
                    "payment_online": online_sum,
                    "balance": bill.get("balance", 0),
                    "status": bill.get("status", "completed"),
                    "serial_number": sn,
                    "booking_source": bill.get("booking_source",
                                               "mmt" if is_mmt else "normal"),
                    "payment_source": bill.get("payment_source",
                                               "ota" if is_mmt else "hotel"),
                    "guest_count": bill.get("guest_count", 1),
                    "services": bill.get("services", []),
                    # Marks a payments-reconstructed row (bill was missing or in
                    # an excluded status). Useful for debugging / UI hinting.
                    "recovered": True,
                })
                present_serials.add(sn)
                recovered += 1

            if recovered:
                logger.info(f"[REGISTER] recovered {recovered} orphaned serial(s) "
                            f"from payments")
        except Exception as _bf_err:
            logger.warning(f"[REGISTER] serial backfill failed: {_bf_err}")

        # ── 4. Sort: days newest-first; WITHIN each day by check-in time
        #         ascending (earliest check-in first). Two stable passes -
        #         the secondary (time ASC) is applied first, then the primary
        #         (date DESC) preserves that order within each day.
        #         The receipt `serial_number` shown in the # column is left
        #         untouched: it is intentionally NOT the sort key (GST/CA
        #         reconciliation value), only the row ORDER follows check-in time.
        register_entries.sort(
            key=lambda e: (e.get("checkin_time") or "9999-12-31 23:59")
        )
        register_entries.sort(
            key=lambda e: (e.get("checkin_time") or "0000-00-00").split(" ")[0],
            reverse=True,
        )

        # ── 5. Daily Tally Dashboard ─────────────────────────────────────────
        # today_str was computed (and the three tally queries prefetched) in
        # the parallel wave at the top of the handler.
        tally = {
            "cash_today": 0,
            "upi_today": 0,
            "revenue_today": 0,
            "expenses_today": 0,
            "mmt_pending": 0,
            "mmt_received_today": 0,
        }
        try:
            today_payments = f_today_pay.result()
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
            today_expenses = f_today_exp.result()
            for p in today_expenses:
                if p.get("expense_type") == "transaction":
                    tally["expenses_today"] += (p.get("amount") or 0)

            tally["revenue_today"] = tally["cash_today"] + tally["upi_today"]

            # MMT pending: sum net_receivable over pending MMT bookings.
            # Query was prefetched in the parallel wave (f_mmt_pending).
            for bdata in f_mmt_pending.result():
                tally["mmt_pending"] += bdata.get("net_receivable", 0) or 0

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
    """Search bills by guest name, mobile, or bill number.
    Non-admin callers are clamped to the last 3 days regardless of search."""
    try:
        from services.role_filters import visible_window_start, _current_role
        data_json = request.json
        search_term = data_json.get("search_term", "").strip()

        if not search_term:
            return jsonify(success=False, message="Search term is required")

        # Manager: only allow searches against the last-3-days window.
        # Use the role-filter helper so the rule lives in one place.
        is_admin = (_current_role() == "admin")
        manager_window_start = None if is_admin else (
            visible_window_start() + " 00:00"
        )

        # Search by bill number (exact match) — for non-admin restrict to window
        if is_admin:
            bills_query = bills_ref.where('bill_number', '==', search_term).limit(10).stream()
        else:
            bills_query = (
                bills_ref
                .where('bill_number', '==', search_term)
                .where('checkin_time', '>=', manager_window_start)
                .limit(10)
                .stream()
            )
        results = [doc.to_dict() for doc in bills_query]

        # If no results, search by guest name / mobile — limit to last 90 days so we
        # don't stream the entire historical bills collection on every name search.
        # Non-admin callers are further clamped to the 3-day window.
        if not results:
            if is_admin:
                cutoff = (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d") + " 00:00"
            else:
                cutoff = manager_window_start
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

        # ── RBAC: clamp to last 3 days for non-admin users ────────────────────
        start_date, end_date = clamp_date_range(start_date, end_date)

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
@requires_permission("settings.view")
def get_billing_config_endpoint():
    try:
        cfg = get_billing_config()
        return jsonify(success=True, config=cfg)
    except Exception as e:
        logger.error(f"get_billing_config_endpoint error: {e}")
        return jsonify(success=False, message=str(e)), 500


@billing_bp.route("/settings/billing_config", methods=["POST"])
@requires_permission("settings.update")
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
@requires_permission("settings.update")
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
        # Goal 2: discount_type fork. Default "financial" preserves the
        # historic blind-subtract behaviour. "credit_note" issues a
        # Section 34 CN for the discount amount.
        discount_type   = (data_json.get("discount_type") or "financial").lower()
        discount_reason = (data_json.get("discount_reason") or "").strip()
        # Optional client flag marking a financial discount as a bad-debt
        # write-off. Previously referenced but never parsed — any discount
        # payment write raised NameError. Defaults to False.
        is_bad_debt = bool(data_json.get("is_bad_debt", False))
        if discount_type not in ("financial", "credit_note"):
            return jsonify(success=False,
                           message="discount_type must be 'financial' or 'credit_note'")

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

        # GST month lock — receiving money against a filed invoice is fine
        # (the supply doesn't change), but a "financial" blind-subtract
        # discount rewrites total_amount / gst_amount of a filed invoice.
        # Only the credit-note discount path (Section 34) remains lawful.
        if discount > 0 and discount_type == "financial":
            _locked = _month_lock_response(
                bill_data, "a financial discount (use discount_type "
                           "'credit_note' instead)")
            if _locked:
                return _locked

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

        # Stamp attribution + lastEditedBy alias for the UI
        _bp_attr = attribution_update()
        bill_update.update(_bp_attr)
        bill_update["lastEditedBy"] = _bp_attr.get("lastModifiedBy")
        bill_update["lastEditedAt"] = _bp_attr.get("lastModifiedAt")
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
                "discount_type":    discount_type,
                "reason":           discount_reason,
                "is_bad_debt":      is_bad_debt and discount_type == "financial",
            })
            logger.info(
                f"Bill {bill_id} discount Rs.{discount} applied by staff "
                f"(type={discount_type}, bad_debt={is_bad_debt and discount_type == 'financial'})"
            )

            # ── Issue Section 34 CN if requested ─────────────────────────────
            if discount_type == "credit_note" and bill_data.get("bill_number"):
                _has_gstin = bool((bill_data.get("recipient_gstin") or "").strip())
                if not _has_gstin and not discount_reason:
                    return jsonify(
                        success=False,
                        message=("CN-discount requires either a B2B "
                                 "recipient with a GSTIN OR a "
                                 "discount_reason describing why the "
                                 "discount was agreed at/before time of "
                                 "supply (Section 15(3)(b))."),
                    )
                _tax, _cgst, _sgst = compute_credit_components(bill_data, discount)
                _cn = create_credit_note(
                    bill_id=bill_id,
                    bill_data=bill_data,
                    cn_date=datetime.now(IST),
                    reason="post_supply_discount",
                    reason_text=discount_reason or "Post-supply discount applied via /add_bill_payment",
                    credit_taxable=_tax,
                    credit_cgst=_cgst,
                    credit_sgst=_sgst,
                    credit_total=discount,
                    actor=(_safe_user() or {}).get("userId"),
                    idempotency_key=f"add_bill_payment:{bill_id}:{int(datetime.now(IST).timestamp())}",
                )
                if _cn:
                    try:
                        write_log(
                            "credit_note.create",
                            target_collection="credit_notes",
                            target_id=str(_cn.get("cn_id") or ""),
                            metadata={
                                "reason": "post_supply_discount",
                                "reason_text": discount_reason,
                                "bill_id": bill_id,
                                "credit_amount_total": discount,
                                "cn_number": _cn.get("cn_number"),
                                "is_b2b": _has_gstin,
                                "issued_via": "add_bill_payment",
                            },
                        )
                    except Exception:
                        pass

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

        write_log(
            "payment.add_bill",
            target_collection="bills",
            target_id=str(bill_id),
            metadata={"amount": amount, "discount": discount,
                      "method": payment_mode, "new_balance": new_balance},
        )
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
    """DEPRECATED stub. Auth has moved to RBAC (@requires_permission)."""
    logger.warning("billing._check_manager_password called (deprecated) — denying")
    return False


# ══════════════════════════════════════════════════════════════════════════════
# RECALCULATE BILL — recompute payment totals from payments collection
# ══════════════════════════════════════════════════════════════════════════════

@billing_bp.route("/recalculate_bill", methods=["POST"])
@requires_permission("payment.edit")
def recalculate_bill():
    """
    Re-fetch all payment records for a stay and update the bill document's
    payment_cash, payment_online, and balance fields.
    Triggered after a payment edit so the bill reflects the corrected amounts.
    Also fires a background PDF regeneration so the new version is stored.
    Auth: admin (via @requires_permission).
    """
    try:
        data     = request.json or {}
        bill_id  = (data.get("bill_id") or "").strip()

        # Auth handled by @requires_permission decorator above.

        if not bill_id:
            return jsonify(success=False, message="bill_id is required"), 400

        bill_snap = bills_ref.document(bill_id).get()
        if not bill_snap.exists:
            return jsonify(success=False, message="Bill not found"), 404

        bill_data    = bill_snap.to_dict()

        # GST month lock — recalculation rewrites payment_cash /
        # payment_online / balance and regenerates the PDF of an invoice
        # already reported in a filed GSTR-1. Frozen months stay frozen.
        _locked = _month_lock_response(bill_data, "recalculating this bill")
        if _locked:
            return _locked

        room         = str(bill_data.get("room", ""))
        guest_name   = bill_data.get("guest_name", "")
        checkin_time = bill_data.get("checkin_time", "")

        if not room or not guest_name or not checkin_time:
            return jsonify(success=False, message="Bill is missing required fields"), 400

        checkin_dt = datetime.strptime(checkin_time, "%Y-%m-%d %H:%M")

        # The bill_id IS the canonical stay_id. Use the FK query when
        # available — it's complete regardless of date corrections, room
        # shifts, or any payment-date edits. Multi-query fallback for legacy.
        stay_payments = []
        if hasattr(payment_service, "query_payments_by_stay_id"):
            try:
                stay_payments = (
                    payment_service.query_payments_by_stay_id(bill_id) or []
                )
            except Exception as _qe:
                logger.warning(
                    f"recalculate_bill: query_payments_by_stay_id({bill_id}) "
                    f"failed: {_qe}; falling back to legacy helper"
                )
        if not stay_payments:
            stay_payments = payment_service.query_payments_for_stay(
                room, guest_name, checkin_dt, stay_id=bill_id
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
        # OTA-settled (MMT prepaid room). Not a drawer receipt, but it does
        # settle the guest's liability, so it must be subtracted from the
        # balance — mirrors create_bill_record. Without this, recalculating an
        # MMT bill would show the full tariff as "balance due".
        payment_ota = sum(
            p.get("amount", 0) for p in stay_payments
            if p.get("method") == "ota" and p.get("type") not in _exclude
        )
        total_refunds = sum(
            p.get("amount", 0) for p in stay_payments
            if p.get("type") in _refund_types
        )

        total_amount = bill_data.get("total_amount", 0)
        new_balance  = total_amount - payment_cash - payment_online - payment_ota + total_refunds

        _rb_attr = attribution_update()
        bills_ref.document(bill_id).update({
            "payment_cash":   payment_cash,
            "payment_online": payment_online,
            "payment_ota":    payment_ota,
            "balance":        new_balance,
            "lastEditedBy":   _rb_attr.get("lastModifiedBy"),
            "lastEditedAt":   _rb_attr.get("lastModifiedAt"),
            **_rb_attr,
        })

        # Background PDF regeneration
        updated_bill = dict(bill_data)
        updated_bill.update({
            "payment_cash":   payment_cash,
            "payment_online": payment_online,
            "payment_ota":    payment_ota,
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
@requires_permission("payment.edit")
def update_bill_service():
    """
    Edit the price of a single service in a completed bill.
    Recalculates services_total, total_amount, balance, then fires a
    background PDF regeneration so the new version lands in bills module.
    Auth: admin (via @requires_permission).
    """
    try:
        data          = request.json or {}
        bill_id       = (data.get("bill_id") or "").strip()
        svc_index_raw = data.get("service_index")
        new_price_raw = data.get("new_price")

        # Auth handled by @requires_permission decorator above.

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

        # GST month lock — editing a service price changes the taxable
        # value of an invoice already reported in a filed GSTR-1.
        _locked = _month_lock_response(bill_data, "editing a service price")
        if _locked:
            return _locked

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

        _ub_attr = attribution_update()
        bills_ref.document(bill_id).update({
            "services":       services,
            "services_total": services_total,
            "total_amount":   total_amount,
            "balance":        new_balance,
            "gst_amount":     new_gst_amount,
            "lastEditedBy":   _ub_attr.get("lastModifiedBy"),
            "lastEditedAt":   _ub_attr.get("lastModifiedAt"),
            **_ub_attr,
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
        write_log("payment.edit_bill_service", target_collection="bills",
                  target_id=str(bill_id),
                  metadata={"service_index": svc_index, "new_price": new_price_raw})
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


def infer_service_tax(svc: dict) -> tuple:
    """
    Return (hsn_or_sac, gst_rate_pct, tax_category) for a non-accommodation
    service. Used for render-time tagging and for stamping new addon records.

    Resolution order:
      1. Explicit fields on the service dict (forward-compatible schema):
         `hsn_or_sac`, `gst_rate`, `tax_category` — used as-is when present.
      2. Item-name heuristics — covers the inventory most small lodges sell:
         packaged water, cold drinks, tea/coffee, snacks, laundry, transport.
      3. Default — empty HSN, 0%, "exempt" (security deposits, refundable
         items, anything the operator hasn't categorised).

    Categories:
      "accommodation" — only set when the caller already knows; this helper
                        is only called for non-accommodation lines.
      "goods"         — physical items, HSN code.
      "service"       — SAC code.
      "exempt"        — no GST.
    """
    if svc.get("hsn_or_sac"):
        return (
            str(svc["hsn_or_sac"]),
            int(svc.get("gst_rate") or 0),
            svc.get("tax_category", "goods"),
        )

    name = (svc.get("item") or "").lower()

    # Water (HSN 2201, 5%)
    if any(k in name for k in ("water", "bisleri", "aquafina", "kinley", "bailley")):
        return ("2201", 5, "goods")

    # Cold drinks / sodas (HSN 2202, 12%)
    if any(k in name for k in (
        "cold drink", "soft drink", "coke", "pepsi", "soda",
        "thums up", "sprite", "fanta", "limca", "maaza", "frooti"
    )):
        return ("2202", 12, "goods")

    # Tea / coffee served (SAC 996331, 5%)
    if any(k in name for k in ("tea", "coffee")):
        return ("996331", 5, "service")

    # Snacks / biscuits / namkeen (HSN 1905, 5%)
    if any(k in name for k in ("snack", "biscuit", "namkeen", "chip", "wafer", "lays", "kurkure")):
        return ("1905", 5, "goods")

    # Laundry / ironing (SAC 999721, 18%)
    if any(k in name for k in ("laundry", "ironing", "wash", "dry clean")):
        return ("999721", 18, "service")

    # Transport / taxi / pickup-drop (SAC 996412, 5%)
    if any(k in name for k in ("taxi", "transport", "pickup", "drop", "auto", "cab")):
        return ("996412", 5, "service")

    # Default — non-taxable / un-categorised
    return ("", 0, "exempt")


def _service_tax_label(svc: dict) -> str:
    """Render a sub-line label for a non-accommodation service.
       'HSN: 2201 - 5%' for goods, 'SAC: 999721 - 18%' for services, or
       'Non-taxable' for exempt items."""
    hsn, rate, cat = infer_service_tax(svc)
    if not hsn:
        return "Non-taxable"
    prefix = "HSN" if cat == "goods" else "SAC"
    if rate > 0:
        return f"{prefix}: {hsn} - {rate}%"
    return f"{prefix}: {hsn}"

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

    # ── Place of supply / tax head determination ──────────────────────────────
    # Supplier is in Karnataka (KA-29). When the bill carries a non-KA
    # recipient_state_code (B2B with non-KA GSTIN, or B2CL flagged via
    # /update_bill_gst), the supply is INTER-state and IGST applies INSTEAD of
    # CGST+SGST. Without this fork the PDF would always print CGST+SGST,
    # giving the customer a document that doesn't match the GSTR-1 filing.
    recipient_state_code = (b.get("recipient_state_code") or "29").strip() or "29"
    is_inter_state       = recipient_state_code != "29"
    cgst_rate = gst_rate_pct / 2 if not is_inter_state else 0
    sgst_rate = gst_rate_pct / 2 if not is_inter_state else 0
    igst_rate = gst_rate_pct     if is_inter_state     else 0

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
    # Route the GST amount to the correct tax head(s) based on place of supply.
    if is_inter_state:
        cgst = 0.0
        sgst = 0.0
        igst = gst_amt
    else:
        cgst = gst_amt / 2
        sgst = gst_amt - cgst   # SGST absorbs any paise rounding drift
        igst = 0.0
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
    # Show pre-GST (excl) values so the Amount column reconciles:
    # Room Rent (excl) + each addon (excl) + CGST + SGST = grand total.
    # Without this, the row showed gross MRP while Room Rent showed excl,
    # producing a visually unreconciled line-item sum (room+addon != total).
    # Any discount is allocated proportionally between room and each addon
    # before stripping GST so the per-line numbers stay consistent with the
    # Taxable Base row below.
    _addon_divisor = (1 + (gst_rate_pct / 100)) if gst_rate_pct > 0 else 1
    _addon_rows_list = []
    for s in accom_addons:
        _item_gross = float(s.get("price", 0))
        _unit_gross = float(s.get("unit_price") or s.get("price", 0))
        if discount_on_accom > 0 and accom_total > 0:
            _item_disc = discount_on_accom * (_item_gross / accom_total)
        else:
            _item_disc = 0.0
        _item_eff_gross = _item_gross - _item_disc
        _item_taxable   = _item_eff_gross / _addon_divisor
        _unit_taxable   = _unit_gross    / _addon_divisor
        _addon_rows_list.append(
            f'<tr><td>{s.get("item","Service")}'
            f'<br><span class="b-sac">SAC: 996311</span></td>'
            f'<td class="b-tr">{s.get("quantity",1)}</td>'
            f'<td class="b-tr">{_f2(_unit_taxable)}</td>'
            f'<td class="b-tr">{_f2(_item_taxable)}</td></tr>'
        )
    accom_addon_rows = "".join(_addon_rows_list)

    # ── Water service rows (GST 5% inclusive — show taxable value in Amount col) ──
    # taxable_value = price / 1.05  (back-calculate from MRP)
    # final price (MRP) is unchanged — no amount added
    _water_total_gst = 0.0
    for _w in water_services:
        _w_price = float(_w.get("price", 0))
        _water_total_gst += _w_price - (_w_price / 1.05)
    if is_inter_state:
        _water_cgst = 0.0
        _water_sgst = 0.0
        _water_igst = _water_total_gst
    else:
        _water_cgst = _water_total_gst / 2
        _water_sgst = _water_total_gst - _water_cgst
        _water_igst = 0.0

    water_rows = "".join(
        f'<tr><td>{s.get("item", "Water")}'
        f'<br><span class="b-sac">HSN: 2201</span></td>'
        f'<td class="b-tr">{s.get("quantity", 1)}</td>'
        f'<td class="b-tr">{_f2(float(s.get("unit_price") or s.get("price", 0)) / 1.05)}</td>'
        f'<td class="b-tr">{_f2(float(s.get("price", 0)) / 1.05)}</td></tr>'
        for s in water_services
    )
    if is_inter_state:
        water_tax_rows = (
            f'<tr class="b-gst-row"><td>IGST @ 5%</td>'
            f'<td class="b-tr">—</td><td class="b-tr">—</td>'
            f'<td class="b-tr">{_f2(_water_igst)}</td></tr>'
        )
    else:
        water_tax_rows = (
            f'<tr class="b-gst-row"><td>CGST @ 2.5%</td>'
            f'<td class="b-tr">—</td><td class="b-tr">—</td>'
            f'<td class="b-tr">{_f2(_water_cgst)}</td></tr>'
            f'<tr class="b-gst-row"><td>SGST @ 2.5%</td>'
            f'<td class="b-tr">—</td><td class="b-tr">—</td>'
            f'<td class="b-tr">{_f2(_water_sgst)}</td></tr>'
        )
    water_svc_section = (
        f'<tr class="b-sec"><td colspan="4">Packaged Drinking Water (HSN: 2201)</td></tr>'
        f'{water_rows}'
        f'{water_tax_rows}'
        f'<tr class="b-subtotal"><td colspan="3" class="b-tr">Water Total (MRP, incl. GST)</td>'
        f'<td class="b-tr">{_f2(water_svc_total)}</td></tr>'
    ) if water_services else ""

    # ── Other service rows (non-water, non-taxable) ──
    other_svc_rows = "".join(
        f'<tr><td>{s.get("item","Service")}'
        f'<br><span class="b-sac">{_service_tax_label(s)}</span></td>'
        f'<td class="b-tr">{s.get("quantity",1)}</td>'
        f'<td class="b-tr">{_f2(s.get("unit_price") or s.get("price",0))}</td>'
        f'<td class="b-tr">{_f2(s.get("price",0))}</td></tr>'
        for s in non_water_services
    )

    # ── GST rows — only if effective accommodation > 0 after discount ────────
    if gst_rate_pct > 0 and effective_accom > 0:
        if is_inter_state:
            gst_rows = (
                f'<tr class="b-gst-row"><td>IGST @ {igst_rate}%</td>'
                f'<td class="b-tr">—</td><td class="b-tr">—</td>'
                f'<td class="b-tr">{_f2(igst)}</td></tr>'
            )
        else:
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

    # Resolve room_segments + format flag here (used by _is_multi_room
    # below and again ~80 lines down for the per-segment renderer).
    room_segments = b.get("room_segments") or []
    _is_new_format = bool(room_segments and "room" in room_segments[0])

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
    # between (taxable_base + tax_heads) and the actual MRP charged.
    # A round-off row makes the invoice self-consistent and is standard practice.
    # Sum all three tax heads — only one is non-zero per bill (intra vs inter)
    # so this works for both branches without special-casing.
    _computed_accom_sum = round(accom_base + cgst + sgst + igst, 2)
    _round_diff = round(effective_accom - _computed_accom_sum, 2)
    round_off_row = (
        f'<tr class="b-gst-row"><td colspan="3" style="text-align:right;color:#888;">Round-off</td>'
        f'<td class="b-tr" style="color:#888;">{("+" if _round_diff > 0 else "")}{_f2(_round_diff)}</td></tr>'
        if abs(_round_diff) >= 0.01 else ""
    )

    # ── Folio-based per-night rendering ──────────────────────────────────────
    # When the bill carries a daily_folio (new-style bills created after the
    # folio migration), render one section per night with its own slab,
    # tax-head split, and night-total. This is how every commercial PMS
    # presents multi-night stays — clear per-day accountability, no
    # averaging artefacts. For stays where some nights cross GST slabs
    # (Day 1 ₹2,400 = 5%, Day 2 ₹950 = exempt), each night gets its own
    # correct tax computation.
    #
    # If the folio is absent (legacy bills), the existing single-block
    # rendering above (room_rent_rows + accom_addon_rows + taxable_base_row
    # + gst_rows + round_off_row + accom_subtotal_row) stays in effect.
    _folio = b.get("daily_folio") or []
    if _folio:
        # ── Per-day folio rendering — matches the eZee/Hotelogix layout ─────────
        # Each Day gets a section header, gross line items, and a Day Total row.
        # GST breakdown lives in the Tax Summary table (built below) — Rule 46
        # is satisfied by the summary, and the per-day section stays uncluttered.
        from datetime import datetime as _dt
        _DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
        def _fmt_day_date(iso_or_space):
            """'2026-05-12 14:20' → '12 May 2026 (Tue)'."""
            if not iso_or_space:
                return ""
            try:
                s = iso_or_space.replace("T", " ")
                ymd = s.split(" ")[0]
                y, m, d = ymd.split("-")
                month = _MONTHS[int(m) - 1]
                weekday = _DAY_NAMES[_dt(int(y), int(m), int(d)).weekday()]
                return f"{int(d)} {month} {y} ({weekday})"
            except Exception:
                return iso_or_space[:10] if iso_or_space else ""

        _folio_html_parts = []
        for _e in _folio:
            _di       = _e.get("day_index", 1)
            _di_room  = _e.get("room", b.get("room", ""))
            _di_base_gross = float(_e.get("base_rate", 0) or 0)
            _di_addons     = _e.get("addons", []) or []
            _di_total      = float(_e.get("day_total", 0) or 0)
            _di_discount   = float(_e.get("discount_allocated", 0) or 0)
            _di_start      = _e.get("day_start", "")
            _di_date_disp  = _fmt_day_date(_di_start)

            # ─ Day header — centered with subtle background
            _folio_html_parts.append(
                f'<tr class="b-day-header"><td colspan="4" style="text-align:center;">'
                f'Day {_di} &nbsp;&mdash;&nbsp; {_di_date_disp} &nbsp;&middot;&nbsp; Rm {_di_room}'
                f'</td></tr>'
            )

            # Room Rent — gross (incl. GST), 1 qty per night
            _folio_html_parts.append(
                f'<tr><td>Room Rent'
                f'<br><span class="b-sac">SAC: 996311</span></td>'
                f'<td class="b-tr">1</td>'
                f'<td class="b-tr">{_f2(_di_base_gross)}</td>'
                f'<td class="b-tr">{_f2(_di_base_gross)}</td></tr>'
            )

            # Accommodation addons for this day — gross amounts
            for _a in _di_addons:
                _a_gross = float(_a.get("price", 0) or 0)
                _a_unit  = float(_a.get("unit_price") or _a.get("price", 0) or 0)
                _a_qty   = int(_a.get("quantity", 1) or 1)
                _folio_html_parts.append(
                    f'<tr><td>{_a.get("item", "Service")}'
                    f'<br><span class="b-sac">SAC: 996311</span></td>'
                    f'<td class="b-tr">{_a_qty}</td>'
                    f'<td class="b-tr">{_f2(_a_unit)}</td>'
                    f'<td class="b-tr">{_f2(_a_gross)}</td></tr>'
                )

            # Per-day discount line, if any
            if _di_discount > 0:
                _folio_html_parts.append(
                    f'<tr><td colspan="3" style="text-align:right;color:#2e7d32;font-weight:600;">'
                    f'Less: Discount allocated to Day {_di}</td>'
                    f'<td class="b-tr" style="color:#2e7d32;font-weight:700;">- {_f2(_di_discount)}</td></tr>'
                )

            # Day Total — gross (incl. GST)
            _folio_html_parts.append(
                f'<tr class="b-day-total"><td colspan="3" class="b-tr">'
                f'Day {_di} Total (incl. GST)</td>'
                f'<td class="b-tr">{_f2(_di_total)}</td></tr>'
            )

        room_rent_rows     = "".join(_folio_html_parts)
        accom_addon_rows   = ""
        taxable_base_row   = ""
        gst_rows           = ""
        round_off_row      = ""
        accom_subtotal_row = (
            f'<tr class="b-subtotal">'
            f'<td colspan="3" class="b-tr">Accommodation Total (all days, incl. GST)</td>'
            f'<td class="b-tr">{_f2(sum(float(e.get("day_total", 0) or 0) for e in _folio))}</td></tr>'
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
    # `room_segments` and `_is_new_format` were resolved earlier so the
    # accommodation-subtotal-row check could use them.
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
                    f'<tr><td>Room Rent – Rm {seg_room}'
                    f'<br><span class="b-sac">SAC: 996311</span></td>'
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
                    f'<tr><td>Room Rent – Rm {seg_room}'
                    f'<br><span class="b-sac">SAC: 996311</span></td>'
                    f'<td class="b-tr">{seg_days}</td>'
                    f'<td class="b-tr">{_f2(seg_rate)}</td>'
                    f'<td class="b-tr">{_f2(seg_tax)}</td></tr>'
                )
        if (current_room_days or 0) > 0:
            curr_tax  = _seg_taxable(current_room_total or 0, current_room_price or 0)
            curr_rate = curr_tax / current_room_days if current_room_days else 0
            room_rent_rows += (
                f'<tr><td>Room Rent – Rm {current_room_no}'
                f'<br><span class="b-sac">SAC: 996311</span></td>'
                f'<td class="b-tr">{current_room_days}</td>'
                f'<td class="b-tr">{_f2(curr_rate)}</td>'
                f'<td class="b-tr">{_f2(curr_tax)}</td></tr>'
            )
    else:
        # Single-room stay — show ROOM-ONLY pre-GST taxable. Previous logic
        # used accom_base which is the WHOLE accommodation taxable (room +
        # accommodation addons). When an addon like AC was added, the Room
        # Rent line silently grew to include the addon's taxable portion,
        # while the addon was still printed as its own row → the bill
        # appeared to double-count the addon. Splitting per-line so room
        # and each addon contribute independently to accom_base makes the
        # column add up: room_taxable + addon_taxable + CGST + SGST = total.
        if discount_on_accom > 0 and accom_total > 0:
            _room_disc = discount_on_accom * (room_charges / accom_total)
        else:
            _room_disc = 0.0
        _room_eff_gross = room_charges - _room_disc
        _room_divisor   = (1 + (gst_rate_pct / 100)) if gst_rate_pct > 0 else 1
        _room_taxable   = _room_eff_gross / _room_divisor
        room_rent_rows = (
            f'<tr><td>Room Rent'
            f'<br><span class="b-sac">SAC: 996311</span></td>'
            f'<td class="b-tr">{days}</td>'
            f'<td class="b-tr">{_f2(_room_taxable / (days or 1))}</td>'
            f'<td class="b-tr">{_f2(_room_taxable)}</td></tr>'
        )

    # For add-on stays, show a "Taxable Base" row so the math is transparent
    taxable_base_row = (
        f'<tr class="b-gst-row"><td>Taxable Base (excl. GST)</td>'
        f'<td class="b-tr">—</td><td class="b-tr">—</td>'
        f'<td class="b-tr">{_f2(accom_base)}</td></tr>'
        if accom_addons else ""
    )

    # ── Folio override (LAST WINS) ────────────────────────────────────────────
    # The legacy room_rent_rows reassignment in the if/elif/else chain above
    # runs AFTER the per-day folio renderer earlier in this function, so it
    # would overwrite the clean per-day HTML. Re-apply the override here so
    # the final rendered HTML uses the per-day folio layout when present.
    if _folio:
        try:
            room_rent_rows = "".join(_folio_html_parts)
        except NameError:
            pass
        accom_addon_rows = ""
        taxable_base_row = ""
        gst_rows         = ""
        round_off_row    = ""
        accom_subtotal_row = (
            f'<tr class="b-subtotal">'
            f'<td colspan="3" class="b-tr">Accommodation Total (all days, incl. GST)</td>'
            f'<td class="b-tr">{_f2(sum(float(e.get("day_total", 0) or 0) for e in _folio))}</td></tr>'
        )

    # ── B2B / B2CL recipient block ───────────────────────────────────────────
    # Rule 46 of CGST Rules requires the recipient's GSTIN, name, and full
    # address on a B2B tax invoice. For B2CL (unregistered, value > B2CL
    # threshold and inter-state) recipient address + state are required.
    # Address is captured but not enforced — the UI shows a Rule 46 warning
    # if blank; we render whatever was captured.
    invoice_type      = b.get("invoice_type", "B2C")
    rcpt_gstin        = (b.get("recipient_gstin")      or "").strip()
    rcpt_legal_name   = (b.get("recipient_legal_name") or "").strip()
    rcpt_trade_name   = (b.get("recipient_trade_name") or "").strip()
    rcpt_address      = (b.get("recipient_address")    or "").strip()
    rcpt_state        = (b.get("recipient_state")      or "Karnataka").strip()
    rcpt_state_code   = (b.get("recipient_state_code") or "29").strip()

    if invoice_type == "B2B":
        recipient_block = f"""
  <table class="b-info-outer" style="margin-top:6px;">
    <tr>
      <td class="b-info-col" colspan="2" style="background:#f8f9fc;">
        <div class="b-row" style="font-weight:bold;color:#1a1a1a;">
          BILL TO (Recipient — Registered)
        </div>
        <div class="b-row"><span class="b-lbl">Legal Name:</span> {rcpt_legal_name}</div>
        {('<div class="b-row"><span class="b-lbl">Trade Name:</span> ' + rcpt_trade_name + '</div>') if rcpt_trade_name else ''}
        <div class="b-row"><span class="b-lbl">GSTIN:</span> {rcpt_gstin}</div>
        {('<div class="b-row"><span class="b-lbl">Address:</span> ' + rcpt_address.replace(chr(10), ', ') + '</div>') if rcpt_address else ''}
        <div class="b-row"><span class="b-lbl">State:</span> {rcpt_state} ({rcpt_state_code})</div>
        <div class="b-row" style="font-size:8.5pt;color:#666;margin-top:4px;">
          GST payable on reverse charge: No
        </div>
      </td>
    </tr>
  </table>"""
    elif invoice_type == "B2CL" and (rcpt_address or rcpt_state):
        recipient_block = f"""
  <table class="b-info-outer" style="margin-top:6px;">
    <tr>
      <td class="b-info-col" colspan="2" style="background:#f8f9fc;">
        <div class="b-row" style="font-weight:bold;color:#1a1a1a;">
          BILL TO (Recipient — Unregistered, Inter-State)
        </div>
        {('<div class="b-row"><span class="b-lbl">Address:</span> ' + rcpt_address.replace(chr(10), ', ') + '</div>') if rcpt_address else ''}
        <div class="b-row"><span class="b-lbl">State:</span> {rcpt_state} ({rcpt_state_code})</div>
      </td>
    </tr>
  </table>"""
    else:
        recipient_block = ""

    # ── Tax Summary by HSN/SAC ────────────────────────────────────────────────
    # Rule 46(j)(k): tax rate and amount must be on the invoice. We already show
    # this per-night inside the line-items table; the summary below aggregates
    # by (HSN/SAC, rate) so the recipient can see total tax exposure at a glance.
    # Standard practice in eZee/Hotelogix-style PMS invoices.
    _tax_sum_rows = []
    _tot_taxable = _tot_cgst = _tot_sgst = _tot_igst = 0.0

    # Accommodation: aggregate from folio if present, else from the bill totals
    if _folio:
        _by_rate = {}
        for _e in _folio:
            _r = float(_e.get("day_gst_rate", 0) or 0)
            _t = float(_e.get("day_taxable", 0) or 0)
            _cg = float(_e.get("day_cgst", 0) or 0)
            _sg = float(_e.get("day_sgst", 0) or 0)
            _ig = float(_e.get("day_igst", 0) or 0)
            agg = _by_rate.setdefault(_r, {"taxable": 0, "cgst": 0, "sgst": 0, "igst": 0})
            agg["taxable"] += _t
            agg["cgst"]    += _cg
            agg["sgst"]    += _sg
            agg["igst"]    += _ig
        for _r in sorted(_by_rate):
            agg = _by_rate[_r]
            _tot_taxable += agg["taxable"]
            _tot_cgst    += agg["cgst"]
            _tot_sgst    += agg["sgst"]
            _tot_igst    += agg["igst"]
            _label = "Accommodation"
            _rate_disp = f"{_r}%" if _r > 0 else "Exempt"
            _tax_sum_rows.append(
                f'<tr><td>996311</td><td>{_label}</td>'
                f'<td class="b-tr">{_rate_disp}</td>'
                f'<td class="b-tr">{_f2(agg["taxable"])}</td>'
                f'<td class="b-tr">{_f2(agg["cgst"])}</td>'
                f'<td class="b-tr">{_f2(agg["sgst"])}</td>'
                f'<td class="b-tr">{_f2(agg["igst"])}</td>'
                f'<td class="b-tr">{_f2(agg["cgst"]+agg["sgst"]+agg["igst"])}</td></tr>'
            )
    else:
        # Legacy (non-folio) bill: single accommodation row from already-computed
        # bill-level totals (accom_base, cgst, sgst, igst).
        if accom_base > 0 or (cgst+sgst+igst) > 0:
            _tot_taxable += accom_base
            _tot_cgst    += cgst
            _tot_sgst    += sgst
            _tot_igst    += igst
            _rate_disp = f"{gst_rate_pct}%" if gst_rate_pct > 0 else "Exempt"
            _tax_sum_rows.append(
                f'<tr><td>996311</td><td>Accommodation</td>'
                f'<td class="b-tr">{_rate_disp}</td>'
                f'<td class="b-tr">{_f2(accom_base)}</td>'
                f'<td class="b-tr">{_f2(cgst)}</td>'
                f'<td class="b-tr">{_f2(sgst)}</td>'
                f'<td class="b-tr">{_f2(igst)}</td>'
                f'<td class="b-tr">{_f2(cgst+sgst+igst)}</td></tr>'
            )

    # Non-water non-accommodation services (laundry, cold drinks, etc.) —
    # aggregate by (HSN/SAC, rate) inferred from the item name. Tax-inclusive
    # pricing: taxable = gross / (1 + rate/100). Exempt items skipped.
    _by_other = {}
    for _s in non_water_services:
        _hsn, _r, _cat = infer_service_tax(_s)
        if not _hsn or _r <= 0:
            continue  # exempt / un-categorised — no tax row
        _gross = float(_s.get("price", 0) or 0)
        _tax_inc = _gross - (_gross / (1 + _r / 100.0))
        _half_split = round(_tax_inc / 2, 2)
        _key = (_hsn, _r, _cat)
        if _key not in _by_other:
            _by_other[_key] = {"taxable": 0.0, "cgst": 0.0, "sgst": 0.0,
                               "igst": 0.0, "desc": _s.get("item", "Service")}
        agg = _by_other[_key]
        agg["taxable"] += (_gross / (1 + _r / 100.0))
        if is_inter_state:
            agg["igst"] += _tax_inc
        else:
            agg["cgst"] += _half_split
            agg["sgst"] += _tax_inc - _half_split
    for (_hsn, _r, _cat), agg in _by_other.items():
        _tot_taxable += agg["taxable"]
        _tot_cgst    += agg["cgst"]
        _tot_sgst    += agg["sgst"]
        _tot_igst    += agg["igst"]
        # First service name in the bucket — short label for the row.
        _label = agg["desc"]
        _tax_sum_rows.append(
            f'<tr><td>{_hsn}</td><td>{_label}</td>'
            f'<td class="b-tr">{_r}%</td>'
            f'<td class="b-tr">{_f2(agg["taxable"])}</td>'
            f'<td class="b-tr">{_f2(agg["cgst"])}</td>'
            f'<td class="b-tr">{_f2(agg["sgst"])}</td>'
            f'<td class="b-tr">{_f2(agg["igst"])}</td>'
            f'<td class="b-tr">{_f2(agg["cgst"]+agg["sgst"]+agg["igst"])}</td></tr>'
        )

    # Water (HSN 2201, 5% inclusive)
    if water_services:
        _w_taxable = water_svc_total / 1.05 if water_svc_total else 0
        _tot_taxable += _w_taxable
        _tot_cgst    += _water_cgst
        _tot_sgst    += _water_sgst
        _tot_igst    += _water_igst
        _tax_sum_rows.append(
            f'<tr><td>2201</td><td>Packaged Drinking Water</td>'
            f'<td class="b-tr">5%</td>'
            f'<td class="b-tr">{_f2(_w_taxable)}</td>'
            f'<td class="b-tr">{_f2(_water_cgst)}</td>'
            f'<td class="b-tr">{_f2(_water_sgst)}</td>'
            f'<td class="b-tr">{_f2(_water_igst)}</td>'
            f'<td class="b-tr">{_f2(_water_cgst+_water_sgst+_water_igst)}</td></tr>'
        )

    if _tax_sum_rows:
        tax_summary_table = (
            '<table class="b-tax-summary">'
            '<thead><tr>'
            '<th>HSN/SAC</th><th>Description</th>'
            '<th class="b-tr">Rate</th>'
            '<th class="b-tr">Taxable</th>'
            '<th class="b-tr">CGST</th><th class="b-tr">SGST</th>'
            '<th class="b-tr">IGST</th><th class="b-tr">Total Tax</th>'
            '</tr></thead><tbody>'
            + "".join(_tax_sum_rows)
            + f'<tr class="b-tax-sum-total"><td colspan="3" class="b-tr">Total</td>'
            f'<td class="b-tr">{_f2(_tot_taxable)}</td>'
            f'<td class="b-tr">{_f2(_tot_cgst)}</td>'
            f'<td class="b-tr">{_f2(_tot_sgst)}</td>'
            f'<td class="b-tr">{_f2(_tot_igst)}</td>'
            f'<td class="b-tr">{_f2(_tot_cgst+_tot_sgst+_tot_igst)}</td></tr>'
            '</tbody></table>'
        )
    else:
        tax_summary_table = ""

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
        <div class="b-row"><span class="b-lbl">Place of Supply:</span> {rcpt_state} ({rcpt_state_code if rcpt_state_code.startswith('0') or rcpt_state_code.isdigit() else '29'} - {'IGST' if is_inter_state else 'CGST+SGST'})</div>
        <div class="b-row"><span class="b-lbl">Reverse Charge:</span> No</div>
      </td>
    </tr>
  </table>
  {recipient_block}
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
  {tax_summary_table}
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

/* Info table */
.b-info-outer { border: 1px solid #ccc;
                width: 100%; border-collapse: collapse; margin-bottom: 8px; }
.b-info-col   { padding: 7px 10px; font-size: 9.5pt; width: 50%;
                vertical-align: top; }
.b-info-col-r { border-left: 1px solid #ccc; }
.b-row  { margin-bottom: 3px; }
.b-lbl  { font-weight: bold; color: #444; display: inline-block;
          min-width: 100px; margin-right: 4px; }
.b-val  { color: #1a1a1a; }

.b-tbl    { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin-bottom: 6px; }
.b-tbl th { background: #efefef; font-weight: bold; padding: 5px 6px;
            border: 1px solid #bbb; }
.b-tbl td { padding: 4px 6px; border: 1px solid #ddd; }
.b-tr     { text-align: right; }

.b-sec td      { background: #f5f5f5; font-weight: bold; font-size: 9pt;
                 color: #333; padding: 4px 6px;
                 border-color: #bbb; text-transform: uppercase; }
.b-gst-row td  { color: #666; font-size: 9pt; }
.b-subtotal td { font-weight: bold; background: #fafafa; }

.b-grand    { border-top: 2px solid #333; }
.b-grand td { font-weight: bold; background: #eeeeee; padding: 5px 6px; font-size: 10pt; }

.b-pay-section { margin-top: 8px; border: 1px solid #ccc; }
.b-pay-title   { background: #efefef; font-weight: bold;
                 font-size: 9pt; padding: 5px 6px; text-transform: uppercase; }
.b-pay-section .b-tbl    { margin-bottom: 0; }
.b-pay-section .b-tbl td { border-color: #eeeeee; padding: 4px 6px; }

.b-sig       { width: 100%; margin-top: 30px; border-collapse: collapse; }
.b-sig td    { padding-top: 10px; }
.b-sig td:last-child { text-align: right; }
.b-sig-line  { display: inline-block; border-top: 1px solid #555;
               padding-top: 3px; width: 140px; text-align: center;
               font-size: 9pt; color: #555; }

/* Reverse-charge declaration line (Rule 46(p) — required on every tax invoice) */
.b-rcm-line { margin-top: 4px; padding: 4px 6px; font-size: 8.5pt;
              color: #555; background: #fafafa; border: 1px solid #eaeaea;
              border-radius: 2px; }

/* Original / Duplicate stamp (Rule 46 audit practice) */
.b-copy-stamp { float: right; font-size: 8pt; font-weight: bold;
                color: #888; border: 1px solid #888;
                padding: 2px 6px; letter-spacing: 1px;
                text-transform: uppercase; margin-bottom: 4px; }


/* Inline HSN/SAC sub-line under a line-item description (Rule 46(g)) */
.b-sac { font-size: 7.5pt; color: #888; font-style: italic;
         display: inline-block; margin-top: 1px; }


/* Per-day section header — sits above each Day's line items */
.b-day-header td { background: #e8eef5; font-weight: bold;
                   font-size: 9.5pt; color: #1a1a1a;
                   padding: 5px 6px; border-color: #b8c6d8;
                   letter-spacing: 0.3px; }

/* Per-day total row — sits below each Day's line items */
.b-day-total td { background: #fafafa; font-weight: bold;
                  font-size: 9.5pt; color: #1a1a1a;
                  border-top: 1px dashed #b0b0b0; padding: 4px 6px; }

/* Tax Summary by HSN/SAC — appears between line items and Payment Details */
.b-tax-summary { width: 100%; border-collapse: collapse;
                 font-size: 9pt; margin: 4px 0 8px 0; }
.b-tax-summary th { background: #efefef; font-weight: bold; padding: 4px 6px;
                    border: 1px solid #bbb; }
.b-tax-summary td { padding: 4px 6px; border: 1px solid #ddd; }
.b-tax-summary .b-tax-sum-total td { font-weight: bold; background: #fafafa;
                                     border-top: 1.5px solid #555; }
/* Footer */
.b-footer { margin-top: 12px; border-top: 1px solid #ddd;
            padding-top: 5px; font-size: 8.5pt; color: #999;
            text-align: center; }
"""


def _build_pdf_html(html_body: str) -> str:
    """Wrap bill or CN HTML in a complete document for xhtml2pdf.
    Replaces Unicode rupee with 'Rs.' (xhtml2pdf cannot render U+20B9)."""
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
    Server-side HTML->PDF using xhtml2pdf, upload to Storage, return URL.

    Two modes:

    1. **Client-rendered** (legacy): client builds the bill HTML in JS and
       POSTs `html_content` + `bill_id`. Server wraps in the PDF chrome and
       converts to PDF. Used by the Bills tab's in-browser preview path.

    2. **Server-rendered** (new): client POSTs just `bill_id` (with optional
       `force: true`). Server fetches the bill record from Firestore, calls
       `_build_bill_html` directly, and converts. Used when the client doesn't
       have an up-to-date renderer — e.g. force-regenerating an old bill so it
       picks up the new per-night folio layout.

    `force: true` bypasses the "skip if pdf_url exists" guard so the new PDF
    overwrites the cached one in Firebase Storage.
    """
    try:
        data        = request.json or {}
        bill_id     = (data.get("bill_id") or "").strip()
        bill_number = (data.get("bill_number") or data.get("invoice_no") or "").strip()
        html_body   = (data.get("html_content") or "").strip()
        force       = bool(data.get("force"))

        if not bill_id:
            return jsonify(success=False, message="bill_id is required"), 400

        bill_snap = bills_ref.document(bill_id).get()
        if not bill_snap.exists:
            return jsonify(success=False, message="Bill not found"), 404

        bill_data = bill_snap.to_dict() or {}
        bill_data["id"] = bill_id
        # Use the bill's own bill_number for the Storage folder if the
        # caller didn't pass one explicitly.
        if not bill_number:
            bill_number = bill_data.get("bill_number") or ""

        existing_url = bill_data.get("pdf_url")
        if existing_url and not force and not html_body:
            # No fresh HTML to render and force not requested — return cached.
            logger.info(f"render_bill_pdf: PDF already exists for {bill_id}, skipping")
            return jsonify(success=True, pdf_url=existing_url,
                           version=None, skipped=True)

        # ── Build the HTML body ───────────────────────────────────────────────
        # If the caller passed pre-built HTML, use it (client-rendered mode).
        # Otherwise build it server-side from the bill record — this is the
        # path that picks up the latest _build_bill_html (per-night folio,
        # IGST routing, etc.) when force-regenerating an existing bill.
        if not html_body:
            try:
                html_body = _build_bill_html(bill_data)
            except Exception as _be:
                logger.error(f"render_bill_pdf: _build_bill_html failed for "
                             f"{bill_id}: {_be}", exc_info=True)
                return jsonify(success=False,
                               message=f"HTML build failed: {_be}"), 500

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
        folder = bill_number or bill_id
        upload = pdf_service.upload_bill_pdf(bill_id, folder, pdf_bytes)
        if not upload.get("url"):
            return jsonify(success=False,
                           message="PDF upload to Firebase Storage failed"), 500
        # Stamp the new URL onto the bill record so subsequent reads see it.
        try:
            bills_ref.document(bill_id).update({
                "pdf_url": upload["url"],
                "pdf_updated_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
            })
        except Exception as _ue:
            logger.warning(f"render_bill_pdf: failed to stamp pdf_url on {bill_id}: {_ue}")
        return jsonify(success=True, pdf_url=upload["url"], version=upload["version"],
                       message=f"PDF v{upload['version']} generated successfully",
                       mode="client" if (data.get("html_content") or "").strip() else "server")

    except Exception as e:
        logger.error(f"render_bill_pdf error: {str(e)}", exc_info=True)
        return jsonify(success=False, message=f"Error generating PDF: {str(e)}"), 500


# ============================================================================
# UPDATE BILL GST (B2B / B2CL recipient details) - Goal 1
# ============================================================================
# Same-month edit guard: GST details on a bill finalised in a prior month
# are LOCKED. Past-month corrections must go via Credit Note + fresh invoice.
# A linked Credit Note also locks GST editing.

@billing_bp.route("/update_bill_gst", methods=["POST"])
@requires_permission("bill.gst.edit")
def update_bill_gst():
    try:
        data    = request.get_json(silent=True) or {}
        bill_id = (data.get("bill_id") or "").strip()
        if not bill_id:
            return jsonify(success=False, message="bill_id is required"), 400

        bill_snap = bills_ref.document(bill_id).get()
        if not bill_snap.exists:
            return jsonify(success=False, message="Bill not found"), 404
        bill = bill_snap.to_dict() or {}

        # GST month lock — recipient details decide B2B vs B2C placement
        # in a GSTR-1 that has already been filed.
        _locked = _month_lock_response(bill, "editing GST recipient details")
        if _locked:
            return _locked

        if bill.get("linked_credit_note_ids"):
            return jsonify(
                success=False,
                message=("This bill has a credit note linked - GST recipient "
                         "details are locked. Issue a fresh invoice if "
                         "recipient details need to change."),
            ), 409

        cur_status = bill.get("status")
        if cur_status in ("completed", "pending_settlement"):
            checkout_time = bill.get("checkout_time") or ""
            try:
                co_ym = checkout_time[:7]
                now_ym = datetime.now(IST).strftime("%Y-%m")
                if co_ym and co_ym != now_ym:
                    return jsonify(
                        success=False,
                        message=("This bill was finalised in a prior month "
                                 f"({co_ym}). GST recipient details are "
                                 "locked. Issue a credit note + fresh "
                                 "invoice instead."),
                    ), 409
            except Exception:
                pass

        gstin       = (data.get("recipient_gstin")      or "").strip().upper()
        legal_name  = (data.get("recipient_legal_name") or "").strip()
        trade_name  = (data.get("recipient_trade_name") or "").strip()
        address     = (data.get("recipient_address")    or "").strip()
        # G5: B2CL path — accept an explicit state code when no GSTIN is
        # given. Required for inter-state B2C invoices >₹1L (B2CL). Without
        # this, the classifier can never return "B2CL" because state code
        # is only derived from GSTIN.
        state_code_in = (data.get("recipient_state_code") or "").strip()
        clear         = bool(data.get("clear", False))

        # Snapshot the "before" state for the audit log (A1). We only keep
        # the fields this endpoint can change — audit_log.write_log expects
        # partial snapshots, not full document dumps.
        gst_fields = (
            "recipient_gstin", "recipient_legal_name", "recipient_trade_name",
            "recipient_address", "recipient_state", "recipient_state_code",
            "invoice_type", "cgst_amount", "sgst_amount", "igst_amount",
        )
        before_snapshot = {k: bill.get(k) for k in gst_fields}

        # Helper closure: tax-head split for this bill. Section 12(3)(b)
        # IGST Act — accommodation place of supply is the PROPERTY location
        # (Karnataka-29), NOT the recipient's state, so the split is ALWAYS
        # CGST+SGST. The recipient's state is still stored on the bill for
        # GSTR-1 recipient details, but it must never flip the tax heads.
        # The state_code parameter is accepted and deliberately ignored so
        # all existing call sites stay unchanged.
        def _split_for(state_code):  # noqa: ARG001 — documented no-op
            return compute_gst_split(
                float(bill.get("gst_amount") or 0),
                recipient_state_code="29",
            )

        if clear:
            # Reset to intra-state B2C — CGST + SGST.
            cgst_v, sgst_v, igst_v = _split_for("29")
            update = {
                "recipient_gstin":      "",
                "recipient_legal_name": "",
                "recipient_trade_name": "",
                "recipient_address":    "",
                "recipient_state":      "Karnataka",
                "recipient_state_code": "29",
                "invoice_type":         "B2C",
                "cgst_amount":          cgst_v,
                "sgst_amount":          sgst_v,
                "igst_amount":          igst_v,
                "lastModifiedAt":       datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
            }
            update.update(attribution_update())
            bills_ref.document(bill_id).update(update)
            after_snapshot = {k: update.get(k, bill.get(k)) for k in gst_fields}
            write_log(
                "bill.gst.clear",
                target_collection="bills",
                target_id=str(bill_id),
                before=before_snapshot,
                after=after_snapshot,
                metadata={"prev_invoice_type": bill.get("invoice_type")},
            )
            _trigger_bill_pdf_refresh(bill_id, bill, update)
            return jsonify(success=True, message="GST details cleared", bill_id=bill_id)

        # ── Branch 1: B2B (GSTIN supplied) ───────────────────────────────────
        if gstin:
            if not validate_gstin(gstin):
                return jsonify(
                    success=False,
                    message=("Invalid GSTIN format. Must be 15 characters: "
                             "2 digits state + 5 letters PAN + 4 digits + 1 letter "
                             "+ 1 alnum + 'Z' + 1 alnum (Rule 46 format)."),
                ), 400
            if not legal_name:
                return jsonify(success=False,
                               message="Recipient legal name is required for B2B"), 400

            state_name, state_code = derive_state_from_gstin(gstin)
            total_amount = int(bill.get("total_amount") or 0)
            invoice_type = classify_invoice_type(gstin, total_amount, state_code)
            cgst_v, sgst_v, igst_v = _split_for(state_code or "29")

            update = {
                "recipient_gstin":      gstin,
                "recipient_legal_name": legal_name,
                "recipient_trade_name": trade_name,
                "recipient_address":    address,
                "recipient_state":      state_name or "Karnataka",
                "recipient_state_code": state_code or "29",
                "invoice_type":         invoice_type,
                "cgst_amount":          cgst_v,
                "sgst_amount":          sgst_v,
                "igst_amount":          igst_v,
                "lastModifiedAt":       datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
            }
            update.update(attribution_update())
            bills_ref.document(bill_id).update(update)

            after_snapshot = {k: update.get(k, bill.get(k)) for k in gst_fields}
            write_log(
                "bill.gst.update",
                target_collection="bills",
                target_id=str(bill_id),
                before=before_snapshot,
                after=after_snapshot,
                metadata={
                    "branch": "b2b",
                    "rule46_address_blank": not address,
                    "tax_head": "IGST" if igst_v > 0 else "CGST+SGST",
                },
            )
            logger.info(
                f"update_bill_gst[B2B]: bill={bill_id} invoice_type={invoice_type} "
                f"GSTIN={gstin} state={state_name} "
                f"split=(cgst={cgst_v} sgst={sgst_v} igst={igst_v})"
            )
            _trigger_bill_pdf_refresh(bill_id, bill, update)

            return jsonify(
                success=True,
                message=(f"B2B GST details saved. Invoice type: {invoice_type}"
                         + (" - Rule 46 address blank, soft warning." if not address else "")),
                bill_id=bill_id,
                invoice_type=invoice_type,
                recipient_state=state_name,
                recipient_state_code=state_code,
                address_warning=not address,
                cgst_amount=cgst_v,
                sgst_amount=sgst_v,
                igst_amount=igst_v,
            )

        # ── Branch 2: recipient-state details without a GSTIN ───────────────
        # Records the recipient's home state for the bill's recipient block.
        # NOTE (Section 12(3)(b) IGST Act): accommodation supplied at the
        # lodge is ALWAYS an intra-state supply (PoS = property location),
        # so the tax stays CGST+SGST and true B2CL (inter-state) treatment
        # cannot arise for room charges — the state code here is recipient
        # metadata, not place of supply.
        if state_code_in:
            if state_code_in not in _STATE_CODE_TO_NAME:
                return jsonify(
                    success=False,
                    message=(f"Unknown state code {state_code_in!r}. "
                             "Must be a 2-digit GST state code (e.g. '27' for "
                             "Maharashtra, '07' for Delhi)."),
                ), 400
            state_name = _STATE_CODE_TO_NAME[state_code_in]
            total_amount = int(bill.get("total_amount") or 0)
            invoice_type = classify_invoice_type("", total_amount, state_code_in)
            cgst_v, sgst_v, igst_v = _split_for(state_code_in)

            update = {
                "recipient_gstin":      "",
                "recipient_legal_name": legal_name,
                "recipient_trade_name": trade_name,
                "recipient_address":    address,
                "recipient_state":      state_name,
                "recipient_state_code": state_code_in,
                "invoice_type":         invoice_type,
                "cgst_amount":          cgst_v,
                "sgst_amount":          sgst_v,
                "igst_amount":          igst_v,
                "lastModifiedAt":       datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
            }
            update.update(attribution_update())
            bills_ref.document(bill_id).update(update)

            after_snapshot = {k: update.get(k, bill.get(k)) for k in gst_fields}
            write_log(
                "bill.gst.state_update",
                target_collection="bills",
                target_id=str(bill_id),
                before=before_snapshot,
                after=after_snapshot,
                metadata={
                    "branch": "b2cl_state_only",
                    "tax_head": "IGST" if igst_v > 0 else "CGST+SGST",
                },
            )
            logger.info(
                f"update_bill_gst[B2CL]: bill={bill_id} invoice_type={invoice_type} "
                f"state={state_name}({state_code_in}) "
                f"split=(cgst={cgst_v} sgst={sgst_v} igst={igst_v})"
            )
            _trigger_bill_pdf_refresh(bill_id, bill, update)

            return jsonify(
                success=True,
                message=f"Recipient state saved. Invoice type: {invoice_type}",
                bill_id=bill_id,
                invoice_type=invoice_type,
                recipient_state=state_name,
                recipient_state_code=state_code_in,
                cgst_amount=cgst_v,
                sgst_amount=sgst_v,
                igst_amount=igst_v,
            )

        return jsonify(
            success=False,
            message=("Either a GSTIN (B2B) or an explicit recipient_state_code "
                     "(B2CL) is required. Pass clear=true to reset to B2C."),
        ), 400

    except Exception as e:
        logger.error(f"update_bill_gst error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {str(e)}"), 500


def _trigger_bill_pdf_refresh(bill_id, prev_bill, fields_changed):
    """Background-regenerate bill PDF after GST-detail change. Best-effort."""
    try:
        merged = dict(prev_bill or {})
        merged.update(fields_changed or {})
        try:
            bills_ref.document(bill_id).update({
                "pdf_url": "",
                "pdf_status": "pending_gst_refresh",
            })
        except Exception:
            pass
        merged["pdf_url"] = ""
        import threading as _thr
        _thr.Thread(
            target=auto_generate_bill_pdf,
            args=(bill_id, merged),
            daemon=True,
        ).start()
    except Exception as _e:
        logger.warning(f"_trigger_bill_pdf_refresh: {_e}")


# ============================================================================
# CREDIT NOTES - list, get, render PDF (Goal 2)
# ============================================================================

@billing_bp.route("/list_credit_notes", methods=["POST"])
def list_credit_notes():
    """Return credit notes whose cn_date falls in [start_date, end_date]."""
    try:
        data = request.get_json(silent=True) or {}
        start_date = data.get("start_date")
        end_date   = data.get("end_date")
        if not start_date or not end_date:
            return jsonify(success=False, message="Start and end dates are required"), 400
        start_date, end_date = clamp_date_range(start_date, end_date)

        q = (
            credit_notes_ref
            .where(filter=FieldFilter("cn_date", ">=", start_date))
            .where(filter=FieldFilter("cn_date", "<=", end_date))
        )
        notes = []
        for snap in q.stream():
            d = snap.to_dict() or {}
            d["cn_id"] = snap.id
            notes.append(d)
        notes.sort(
            key=lambda n: (n.get("cn_date") or "", n.get("cn_number") or ""),
            reverse=True,
        )
        return jsonify(success=True, credit_notes=notes, count=len(notes))
    except Exception as e:
        logger.error(f"list_credit_notes error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {str(e)}"), 500


@billing_bp.route("/list_advances", methods=["POST"])
def list_advances():
    """
    Return advance receipts for GSTR-1 Table 11 reporting.

    "Advance" here means: a payment received via the booking flow
    (transaction_type in {"booking_payment", "advance_booking",
    "booking_advance"}) where the linked booking's check-in date is in a
    DIFFERENT calendar month from the payment date. These are the rows
    that need to appear in Table 11A (received) for the payment month and
    Table 11B (adjusted) for the check-in / invoice month.

    Same-month advances are NOT returned — they're effectively neutral
    in GSTR-1 because both 11A and 11B fall in the same period and net
    to zero. (Strict reading still requires reporting both; we leave
    that decision to the operator's CA — they can extend the date
    range to include them if needed.)

    Body: { start_date, end_date }   (inclusive YYYY-MM-DD)
    Response: {
      success, advances: [
        {
          payment_id, date, amount, method, gst_rate, taxable, cgst, sgst,
          guest_name, room, booking_id, check_in_date, status,
            "Received"  - paid in [start,end], stay still upcoming
            "Adjusted"  - paid earlier, stay finalised in [start,end]
        }, ...
      ]
    }
    """
    try:
        data = request.get_json(silent=True) or {}
        start_date = data.get("start_date")
        end_date   = data.get("end_date")
        if not start_date or not end_date:
            return jsonify(success=False, message="Start and end dates are required"), 400
        start_date, end_date = clamp_date_range(start_date, end_date)

        from services import payment_service as _ps

        advance_types = {"booking_payment", "booking_advance", "advance_booking"}

        # Pull payments for the period AND for any booking advance whose
        # linked stay closed in this period (Table 11B "Adjusted").
        # We do two passes: by payment date, and by linked-bill checkout.

        rows = []

        # Pass 1: payments in [start,end] tagged as advance.
        pay_in_range = _ps.query_payments_by_date_range(start_date, end_date) or []
        for p in pay_in_range:
            ttype = (p.get("transaction_type") or p.get("type") or "").lower()
            booking_id = p.get("booking_id")
            if ttype not in advance_types or not booking_id:
                continue
            # Look up the booking to find the eventual check-in date.
            try:
                bdoc = bookings_ref.document(booking_id).get()
                bd = bdoc.to_dict() or {} if bdoc.exists else {}
            except Exception:
                bd = {}
            check_in_date = bd.get("check_in_date") or ""
            pay_date      = p.get("date") or ""
            if not check_in_date or not pay_date:
                continue
            # Cross-month advance check.
            if pay_date[:7] == check_in_date[:7]:
                continue   # same-month — skip per docstring

            # Prospective GST rate from booking's room price (pre-checkout
            # rate is the best estimate; CA can override at filing time).
            # The booking schema is inconsistent across older bookings —
            # probe multiple field names. Falls back to total_amount /
            # nights if a per-night rate isn't stored.
            try:
                rate_per_night = int(
                    bd.get("price")
                    or bd.get("price_per_night")
                    or bd.get("room_price")
                    or bd.get("nightly_rate")
                    or 0
                )
                if rate_per_night == 0 and bd.get("total_amount"):
                    # Compute from total / nights if direct rate missing.
                    try:
                        ci = datetime.strptime(bd.get("check_in_date","")[:10], "%Y-%m-%d")
                        co = datetime.strptime(bd.get("check_out_date","")[:10], "%Y-%m-%d")
                        nights = max(1, (co - ci).days)
                        rate_per_night = int(int(bd.get("total_amount", 0)) / nights)
                    except (ValueError, TypeError, ZeroDivisionError):
                        pass
            except (TypeError, ValueError):
                rate_per_night = 0
            if rate_per_night >= 7501:
                rate_pct = 18
            elif rate_per_night >= 1000:
                rate_pct = 5
            else:
                rate_pct = 0

            amt = float(p.get("amount") or 0)
            gst_amt   = round(amt * rate_pct / (100 + rate_pct), 2) if rate_pct > 0 else 0.0
            taxable   = round(amt - gst_amt, 2)
            cgst      = round(gst_amt / 2, 2)

            # Status: "Received" if pay_date in selected window, "Adjusted"
            # is computed in Pass 2 below.
            rows.append({
                "payment_id":     p.get("id") or "",
                "date":           pay_date,
                "amount":         int(round(amt)),
                "method":         p.get("method") or "cash",
                "gst_rate":       rate_pct,
                "taxable":        taxable,
                "cgst":           cgst,
                "sgst":           cgst,
                "guest_name":     p.get("name") or bd.get("guest_name") or "",
                "room":           str(p.get("room") or bd.get("room") or ""),
                "booking_id":     booking_id,
                "check_in_date":  check_in_date,
                "status":         "Received",
            })

        # Pass 2: bills finalised in [start,end] linked to a booking whose
        # advance was paid in a prior month — those are the Table 11B
        # "Adjusted" rows.
        try:
            from datetime import datetime as _dt, timedelta as _td
            sd = _dt.strptime(start_date, "%Y-%m-%d")
            ed = _dt.strptime(end_date,   "%Y-%m-%d") + _td(days=1)
            range_start = sd.strftime("%Y-%m-%d %H:%M")
            range_end   = ed.strftime("%Y-%m-%d %H:%M")
            bills_q = (
                bills_ref
                .where(filter=FieldFilter("checkout_time", ">=", range_start))
                .where(filter=FieldFilter("checkout_time", "<", range_end))
            )
            for snap in bills_q.stream():
                d = snap.to_dict() or {}
                booking_id = d.get("booking_id")
                if not booking_id:
                    continue
                # Find the advance payment(s) for this booking that landed
                # before the bill's month.
                bill_month = (d.get("checkout_time") or "")[:7]
                try:
                    pay_q = (
                        bookings_ref.parent
                        # We can't query payments collection directly here without
                        # going through payment_service. Use the service.
                    )
                except Exception:
                    pass
                booking_advances = _ps.query_payments_by_booking_id(booking_id) \
                    if hasattr(_ps, "query_payments_by_booking_id") else []
                for pa in (booking_advances or []):
                    pa_date = (pa.get("date") or "")
                    if not pa_date or pa_date[:7] >= bill_month:
                        continue
                    rate_pct = int(d.get("gst_rate") or 0)
                    amt = float(pa.get("amount") or 0)
                    gst_amt   = round(amt * rate_pct / (100 + rate_pct), 2) if rate_pct > 0 else 0.0
                    taxable   = round(amt - gst_amt, 2)
                    cgst      = round(gst_amt / 2, 2)
                    rows.append({
                        "payment_id":     pa.get("id") or "",
                        "date":           pa_date,
                        "amount":         int(round(amt)),
                        "method":         pa.get("method") or "cash",
                        "gst_rate":       rate_pct,
                        "taxable":        taxable,
                        "cgst":           cgst,
                        "sgst":           cgst,
                        "guest_name":     d.get("guest_name") or "",
                        "room":           str(d.get("room") or ""),
                        "booking_id":     booking_id,
                        "check_in_date":  d.get("checkin_time") or "",
                        "bill_number":    d.get("bill_number") or "",
                        "status":         "Adjusted",
                    })
        except Exception as _e:
            logger.warning(f"list_advances: pass 2 failed: {_e}")

        # Newest-first sort.
        rows.sort(key=lambda r: r.get("date") or "", reverse=True)
        return jsonify(success=True, advances=rows, count=len(rows))

    except Exception as e:
        logger.error(f"list_advances error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {str(e)}"), 500


@billing_bp.route("/get_credit_note/<cn_id>", methods=["GET"])
def get_credit_note(cn_id):
    try:
        snap = credit_notes_ref.document(cn_id).get()
        if not snap.exists:
            return jsonify(success=False, message="Credit note not found"), 404
        d = snap.to_dict() or {}
        d["cn_id"] = snap.id
        return jsonify(success=True, credit_note=d)
    except Exception as e:
        logger.error(f"get_credit_note error: {e}")
        return jsonify(success=False, message=f"Error: {str(e)}"), 500


def _build_credit_note_html(cn: dict, original_bill=None) -> str:
    cn_no   = cn.get("cn_number") or "N/A"
    cn_date = cn.get("cn_date") or "-"
    against_bill_no   = cn.get("against_bill_number") or "-"
    against_inv_date  = cn.get("against_invoice_date") or "-"
    reason            = cn.get("reason") or "-"
    reason_text       = cn.get("reason_text") or ""
    rcpt_gstin        = (cn.get("recipient_gstin") or "").strip()
    rcpt_legal_name   = cn.get("recipient_legal_name") or cn.get("guest_name") or ""
    rcpt_state        = cn.get("recipient_state") or "Karnataka"
    rcpt_state_code   = cn.get("recipient_state_code") or "29"

    taxable = float(cn.get("credit_amount_taxable") or 0)
    cgst    = float(cn.get("credit_amount_cgst") or 0)
    sgst    = float(cn.get("credit_amount_sgst") or 0)
    igst    = float(cn.get("credit_amount_igst") or 0)
    total   = float(cn.get("credit_amount_total") or 0)
    rate    = int(cn.get("gst_rate") or 0)
    sac_hsn = cn.get("sac_or_hsn") or "9963"

    # Inter-state CN? Mirror the bill's tax-head routing: if the recipient is
    # outside Karnataka, the credit is to IGST rather than CGST+SGST. For
    # legacy CNs created before the credit_amount_igst field existed, fall
    # back to treating (cgst + sgst) as the IGST when state is non-KA.
    is_inter_state_cn = (rcpt_state_code or "29") != "29"
    if is_inter_state_cn and igst == 0 and (cgst + sgst) > 0:
        igst = cgst + sgst
        cgst = 0.0
        sgst = 0.0

    recipient_block = ""
    if rcpt_gstin:
        recipient_block = (
            f'<table class="b-info-outer" style="margin-top:6px;">'
            f'<tr><td class="b-info-col" colspan="2" style="background:#f8f9fc;">'
            f'<div class="b-row" style="font-weight:bold;color:#1a1a1a;">'
            f'BILL TO (Recipient - Registered)</div>'
            f'<div class="b-row"><span class="b-lbl">Legal Name:</span> {rcpt_legal_name}</div>'
            f'<div class="b-row"><span class="b-lbl">GSTIN:</span> {rcpt_gstin}</div>'
            f'<div class="b-row"><span class="b-lbl">State:</span> {rcpt_state} ({rcpt_state_code})</div>'
            f'</td></tr></table>'
        )

    reason_box = ""
    if reason_text:
        reason_box = (
            f'<div style="font-size:9pt;color:#555;margin-top:8px;padding:6px 8px;'
            f'background:#fafafa;border:1px solid #ddd;">'
            f'<b>Reason narrative:</b> {reason_text}</div>'
        )

    return (
        f'<div class="b-bill-wrap">'
        f'<div class="b-header-block">'
        f'<div class="b-lodge-name">CIBARA COMFORTS</div>'
        f'<div class="b-lodge-entity">A Unit of Cibara Enterprise</div>'
        f'<div class="b-lodge-sub">Opposite Bus Stand Road, Harihar, Karnataka - 577601</div>'
        f'<div class="b-gstin-bar">GSTIN: 29AAWFC1962B1Z9 . SAC: 9963 . Karnataka (KA - 29)</div>'
        f'<div class="b-title">CREDIT NOTE</div>'
        f'</div>'
        f'<table class="b-info-outer">'
        f'<tr>'
        f'<td class="b-info-col">'
        f'<div class="b-row"><span class="b-lbl">CN No:</span> {cn_no}</div>'
        f'<div class="b-row"><span class="b-lbl">CN Date:</span> {cn_date}</div>'
        f'<div class="b-row"><span class="b-lbl">Against Bill:</span> {against_bill_no}</div>'
        f'<div class="b-row"><span class="b-lbl">Bill Date:</span> {against_inv_date}</div>'
        f'</td>'
        f'<td class="b-info-col b-info-col-r">'
        f'<div class="b-row"><span class="b-lbl">Guest Name:</span> {cn.get("guest_name","")}</div>'
        f'<div class="b-row"><span class="b-lbl">Room:</span> {cn.get("room","")}</div>'
        f'<div class="b-row"><span class="b-lbl">Reason:</span> {reason.replace("_"," ").title()}</div>'
        f'<div class="b-row"><span class="b-lbl">Place of Supply:</span> {rcpt_state} ({rcpt_state_code}) - {"IGST" if is_inter_state_cn else "CGST+SGST"}</div>'
        f'</td>'
        f'</tr></table>'
        f'{recipient_block}'
        f'<table class="b-tbl">'
        f'<thead><tr><th>Description</th><th class="b-tr">Amount (Rs.)</th></tr></thead>'
        f'<tbody>'
        f'<tr class="b-sec"><td colspan="2">CREDIT (Reversal of Output Tax - Section 34 CGST Act)</td></tr>'
        f'<tr><td>Taxable Value Reversed (SAC: {sac_hsn})</td>'
        f'<td class="b-tr" style="color:#c62828;">- {_f2(taxable)}</td></tr>'
        + (
            f'<tr class="b-gst-row"><td>IGST @ {rate}%</td>'
            f'<td class="b-tr" style="color:#c62828;">- {_f2(igst)}</td></tr>'
            if is_inter_state_cn else
            f'<tr class="b-gst-row"><td>CGST @ {rate/2:.1f}%</td>'
            f'<td class="b-tr" style="color:#c62828;">- {_f2(cgst)}</td></tr>'
            f'<tr class="b-gst-row"><td>SGST @ {rate/2:.1f}%</td>'
            f'<td class="b-tr" style="color:#c62828;">- {_f2(sgst)}</td></tr>'
        ) +
        f'<tr class="b-grand"><td class="b-tr">TOTAL CREDIT</td>'
        f'<td class="b-tr" style="color:#c62828;">- Rs. {_f2(total)}</td></tr>'
        f'</tbody></table>'
        f'{reason_box}'
        f'<table class="b-sig">'
        f'<tr>'
        f'<td><div class="b-sig-line">Recipient Acknowledgement</div></td>'
        f'<td style="text-align:right"><div class="b-sig-line">Authorised Signatory</div></td>'
        f'</tr></table>'
        f'<div class="b-footer">'
        f'<p>Section 34 Credit Note - reduces output tax liability for the supplier.</p>'
        f'<p>This is a computer-generated credit note.</p>'
        f'</div></div>'
    )


@billing_bp.route("/render_credit_note_pdf", methods=["POST"])
@requires_permission("credit_note.issue")
def render_credit_note_pdf():
    """Generate (and upload) a PDF for a credit note."""
    try:
        data  = request.get_json(silent=True) or {}
        cn_id = (data.get("cn_id") or "").strip()
        if not cn_id:
            return jsonify(success=False, message="cn_id is required"), 400

        snap = credit_notes_ref.document(cn_id).get()
        if not snap.exists:
            return jsonify(success=False, message="Credit note not found"), 404
        cn = snap.to_dict() or {}
        cn["cn_id"] = snap.id

        existing_url = cn.get("pdf_url")
        if existing_url and not data.get("force"):
            return jsonify(success=True, pdf_url=existing_url, skipped=True)

        try:
            from xhtml2pdf import pisa
        except ImportError:
            return jsonify(success=False, message="xhtml2pdf not installed"), 500

        full_html = _build_pdf_html(_build_credit_note_html(cn))
        import io as _io
        buf = _io.BytesIO()
        result = pisa.CreatePDF(full_html, dest=buf)
        if result.err:
            return jsonify(success=False,
                           message=f"PDF conversion error (code {result.err})"), 500

        from firebase_admin import storage as _fb_storage
        import urllib.parse as _u
        import uuid as _uu

        bucket = _fb_storage.bucket()
        safe_no = (cn.get("cn_number") or cn_id).replace("/", "_").replace(" ", "_")
        existing_versions = cn.get("versions") or []
        next_version = len(existing_versions) + 1
        blob_path = f"credit_notes/{safe_no}/v{next_version}.pdf"
        blob = bucket.blob(blob_path)
        token = str(_uu.uuid4())
        blob.metadata = {"firebaseStorageDownloadTokens": token}
        blob.upload_from_string(buf.getvalue(), content_type="application/pdf")
        encoded = _u.quote(blob_path, safe="")
        url = (
            f"https://firebasestorage.googleapis.com/v0/b/"
            f"{bucket.name}/o/{encoded}?alt=media&token={token}"
        )

        version_entry = {
            "version": next_version,
            "url": url,
            "uploaded_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
        }
        from firebase_admin import firestore as _fs
        credit_notes_ref.document(cn_id).update({
            "pdf_url": url,
            "versions": _fs.ArrayUnion([version_entry]),
            "pdf_updated_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
        })

        write_log(
            "credit_note.pdf",
            target_collection="credit_notes",
            target_id=cn_id,
            metadata={"version": next_version, "cn_number": cn.get("cn_number")},
        )

        return jsonify(success=True, pdf_url=url, version=next_version)

    except Exception as e:
        logger.error(f"render_credit_note_pdf error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {str(e)}"), 500


@billing_bp.route("/issue_credit_note", methods=["POST"])
@requires_permission("credit_note.issue")
def issue_credit_note():
    """Manual CN issuance - rare path for goodwill / service-deficiency."""
    try:
        data = request.get_json(silent=True) or {}
        bill_id = (data.get("bill_id") or "").strip()
        reason  = (data.get("reason")  or "").strip()
        reason_text = (data.get("reason_text") or "").strip()
        try:
            credit_total = int(data.get("credit_total") or 0)
        except (TypeError, ValueError):
            return jsonify(success=False,
                           message="credit_total must be an integer"), 400

        if not bill_id:
            return jsonify(success=False, message="bill_id is required"), 400
        if reason not in CN_REASONS:
            return jsonify(success=False,
                           message=f"reason must be one of {list(CN_REASONS)}"), 400
        if credit_total <= 0:
            return jsonify(success=False, message="credit_total must be > 0"), 400
        if reason == "other" and not reason_text:
            return jsonify(success=False,
                           message="reason_text is required for reason 'other'"), 400

        snap = bills_ref.document(bill_id).get()
        if not snap.exists:
            return jsonify(success=False, message="Bill not found"), 404
        bill = snap.to_dict() or {}

        if not bill.get("bill_number"):
            return jsonify(success=False,
                           message="Cannot issue CN against an un-finalised bill"), 400
        if credit_total > int(bill.get("total_amount") or 0):
            return jsonify(success=False,
                           message="credit_total exceeds bill total_amount"), 400

        tax, cgst, sgst = compute_credit_components(bill, credit_total)
        from flask import g as _g
        _user = getattr(_g, "current_user", None) or {}
        cn_doc = create_credit_note(
            bill_id=bill_id,
            bill_data=bill,
            cn_date=datetime.now(IST),
            reason=reason,
            reason_text=reason_text,
            credit_taxable=tax,
            credit_cgst=cgst,
            credit_sgst=sgst,
            credit_total=credit_total,
            actor=_user.get("userId"),
            idempotency_key=data.get("idempotency_key") or "",
        )
        if not cn_doc:
            return jsonify(success=False,
                           message="Credit note creation failed - see server logs"), 500
        write_log(
            "credit_note.create",
            target_collection="credit_notes",
            target_id=str(cn_doc.get("cn_id") or ""),
            metadata={
                "reason": reason,
                "reason_text": reason_text,
                "against_bill_id": bill_id,
                "against_bill_number": bill.get("bill_number"),
                "credit_amount_total": credit_total,
                "cn_number": cn_doc.get("cn_number"),
                "issued_via": "manual_endpoint",
            },
        )
        return jsonify(success=True, credit_note=cn_doc,
                       message=f"Credit note {cn_doc.get('cn_number')} issued")

    except Exception as e:
        logger.error(f"issue_credit_note error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {str(e)}"), 500


# ══════════════════════════════════════════════════════════════════════════════
# GST MONTH LOCKS & SYSTEM ALERTS (admin)
# ══════════════════════════════════════════════════════════════════════════════

@billing_bp.route("/gst_locks", methods=["GET"])
@requires_permission("gst.lock.manage")
def gst_locks_list():
    """Last 18 months with lock state — feeds the Bills-tab lock modal."""
    try:
        # 24 months → two full Indian financial years in the picker.
        return jsonify(success=True, locks=gst_lock_service.list_locks(months_back=24))
    except Exception as e:
        logger.error(f"gst_locks_list error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {e}"), 500


@billing_bp.route("/gst_locks/set", methods=["POST"])
@requires_permission("gst.lock.manage")
def gst_locks_set():
    """
    Lock or unlock a GST month after filing.
    Body: {period: "YYYY-MM", locked: bool, note: str}.
    Locking current/future months is refused by the service layer.
    """
    try:
        data   = request.get_json(silent=True) or {}
        period = (data.get("period") or "").strip()
        locked = bool(data.get("locked"))
        note   = (data.get("note") or "").strip()
        actor  = (_safe_user() or {}).get("userId") or "unknown"
        try:
            doc = gst_lock_service.set_lock(period, locked, actor, note)
        except ValueError as ve:
            return jsonify(success=False, message=str(ve)), 400
        write_log(
            "gst.month.lock" if locked else "gst.month.unlock",
            target_collection="gst_month_locks",
            target_id=doc["period"],
            metadata={"note": note},
        )
        return jsonify(success=True, lock=doc)
    except Exception as e:
        logger.error(f"gst_locks_set error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {e}"), 500


@billing_bp.route("/gst_locks/attachments/upload", methods=["POST"])
@requires_permission("gst.lock.manage")
def gst_lock_attach_upload():
    """
    Attach a GST filing report (GSTR-1/3B summary, ARN receipt; PDF or image)
    to a month. Multipart: period=YYYY-MM, file=<upload>. Multiple files per
    month are allowed, and attaching is permitted whether or not the month is
    locked (it is evidence, not a financial figure).
    """
    try:
        period = (request.form.get("period") or "").strip()
        norm = gst_lock_service.normalize_period(period)
        if not norm:
            return jsonify(success=False, message="period must be YYYY-MM"), 400
        if "file" not in request.files:
            return jsonify(success=False, message="No file provided"), 400
        f = request.files["file"]
        if not f or not f.filename:
            return jsonify(success=False, message="Empty file"), 400
        data = f.read()
        if not data:
            return jsonify(success=False, message="Empty file"), 400
        if len(data) > 15 * 1024 * 1024:
            return jsonify(success=False, message="File too large (max 15 MB)"), 400
        ctype = f.mimetype or "application/octet-stream"
        url = pdf_service.upload_filing_attachment(norm, f.filename, data, ctype)
        if not url:
            return jsonify(success=False, message="Upload to storage failed"), 500
        actor = (_safe_user() or {}).get("userId") or "unknown"
        att = gst_lock_service.add_attachment(norm, {
            "filename": f.filename, "url": url,
            "content_type": ctype, "size": len(data), "uploaded_by": actor,
        })
        write_log("gst.month.attach", target_collection="gst_month_locks",
                  target_id=norm, metadata={"filename": f.filename})
        return jsonify(success=True, attachment=att)
    except Exception as e:
        logger.error(f"gst_lock_attach_upload error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {e}"), 500


@billing_bp.route("/gst_locks/attachments/delete", methods=["POST"])
@requires_permission("gst.lock.manage")
def gst_lock_attach_delete():
    """Remove a filing-report attachment. Body: {period, attachment_id}."""
    try:
        data = request.get_json(silent=True) or {}
        period = (data.get("period") or "").strip()
        att_id = (data.get("attachment_id") or "").strip()
        norm = gst_lock_service.normalize_period(period)
        if not norm or not att_id:
            return jsonify(success=False, message="period and attachment_id required"), 400
        if not gst_lock_service.remove_attachment(norm, att_id):
            return jsonify(success=False, message="Attachment not found"), 404
        write_log("gst.month.attach.delete", target_collection="gst_month_locks",
                  target_id=norm, metadata={"attachment_id": att_id})
        return jsonify(success=True)
    except Exception as e:
        logger.error(f"gst_lock_attach_delete error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {e}"), 500


@billing_bp.route("/generate_invoice/<entry_id>", methods=["POST"])
@requires_permission("bill.gst.edit")
def generate_invoice(entry_id):
    """
    Admin: ensure a GST invoice PDF exists for a CHECKED-OUT stay whose bill is
    finalized (has a CC/ number) but is missing its PDF — re-renders it. The
    action is:
      * idempotent — if a PDF already exists it returns the existing URL;
      * lock-aware — refuses if the stay's GST month is locked (GSTR-1 filed);
      * time-boxed — only stays checked out within the last 5 days qualify;
      * non-fabricating — a stay with NO finalized bill number (checked out
        without billing) is NOT minted here (that needs a re-checkout within
        the revert window); a clear message is returned instead.
    """
    try:
        snap = bills_ref.document(entry_id).get()
        if not snap.exists:
            return jsonify(success=False,
                           message="No bill on record for this stay."), 404
        bill = snap.to_dict() or {}

        checkout_time = (bill.get("checkout_time") or "").strip()
        status = (bill.get("status") or "").strip()
        if not checkout_time or status not in ("completed", "pending_settlement"):
            return jsonify(success=False,
                           message="This stay is not checked out yet."), 400

        # GST month lock — never (re)write a filed month.
        locked = _month_lock_response(bill, "generating the invoice")
        if locked:
            return locked

        # 7-day window (admin policy): only recent checkouts qualify.
        co_date = checkout_time[:10]
        try:
            age_days = (datetime.now(IST).date()
                        - datetime.strptime(co_date, "%Y-%m-%d").date()).days
        except ValueError:
            age_days = None
        if age_days is not None and age_days > 7:
            return jsonify(success=False, message=(
                f"Checkout was {age_days} days ago — invoice generation is only "
                f"available within 7 days of checkout."
            )), 400

        # No inter-month generation: the invoice must belong to the CURRENT
        # calendar month. Never mint an invoice number into a prior month
        # (its GSTR-1 figures must not change), even if within 7 days and
        # not yet locked.
        if checkout_time[:7] != datetime.now(IST).strftime("%Y-%m"):
            return jsonify(success=False, message=(
                "Invoice can only be generated in the same month as the "
                "checkout. This checkout falls in a previous month, so a new "
                "invoice number cannot be created for it."
            )), 400

        bill_number = (bill.get("bill_number") or "").strip()
        has_number = bool(bill_number) and bill_number != "-"
        has_pdf = bool(bill.get("pdf_url"))

        if not has_number:
            # No invoice number yet (same-day cash / OTA checkout). Mint one
            # now — atomically and gap-free — into the bill's OWN checkout
            # month. The month-lock and 5-day checks above already gate this,
            # so we never mint into a filed or stale period.
            try:
                co_dt = datetime.strptime(checkout_time[:16], "%Y-%m-%d %H:%M")
            except ValueError:
                try:
                    co_dt = datetime.strptime(co_date, "%Y-%m-%d")
                except ValueError:
                    return jsonify(success=False,
                                   message="This stay has an invalid checkout time."), 400
            from config import allocate_and_finalize_bill
            try:
                number, _newly = allocate_and_finalize_bill(
                    entry_id, bill, co_dt, is_new_doc=False, needs_number=True)
            except Exception as me:
                logger.error(f"generate_invoice mint failed for {entry_id}: {me}",
                             exc_info=True)
                return jsonify(success=False,
                               message=f"Could not allocate an invoice number: {me}"), 500
            fresh = (bills_ref.document(entry_id).get().to_dict() or {})
            auto_generate_bill_pdf(entry_id, fresh)
            fresh = (bills_ref.document(entry_id).get().to_dict() or {})
            write_log("bill.invoice.generate", target_collection="bills",
                      target_id=entry_id,
                      metadata={"bill_number": number, "minted": True})
            return jsonify(success=True, bill_number=number,
                           pdf_url=fresh.get("pdf_url", ""),
                           message=f"Invoice {number} generated.")

        if has_pdf:
            return jsonify(success=True, already=True, pdf_url=bill.get("pdf_url"),
                           message="Invoice already generated.")

        # Bill is finalized but the PDF is missing — render it now (synchronous
        # so the caller gets the URL back). auto_generate_bill_pdf re-reads the
        # bill and skips if a PDF appeared in the meantime.
        auto_generate_bill_pdf(entry_id, bill)
        fresh = (bills_ref.document(entry_id).get().to_dict() or {})
        write_log("bill.invoice.generate", target_collection="bills",
                  target_id=entry_id, metadata={"bill_number": bill_number})
        return jsonify(success=True, pdf_url=fresh.get("pdf_url", ""),
                       message="Invoice generated." if fresh.get("pdf_url")
                       else "Invoice generation started; refresh shortly.")
    except Exception as e:
        logger.error(f"generate_invoice error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {e}"), 500


@billing_bp.route("/system_alerts", methods=["GET"])
@requires_permission("logs.view")
def system_alerts_list():
    """Operational alerts (blocked checkouts etc.), newest first."""
    try:
        include_resolved = request.args.get("include_resolved") == "1"
        rows = system_alerts.list_alerts(unresolved_only=not include_resolved)
        return jsonify(success=True, alerts=rows)
    except Exception as e:
        logger.error(f"system_alerts_list error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {e}"), 500


@billing_bp.route("/system_alerts/resolve", methods=["POST"])
@requires_permission("logs.view")
def system_alerts_resolve():
    """Mark an alert handled. Body: {alert_id}."""
    try:
        data = request.get_json(silent=True) or {}
        alert_id = (data.get("alert_id") or "").strip()
        if not alert_id:
            return jsonify(success=False, message="alert_id is required"), 400
        actor = (_safe_user() or {}).get("userId") or "unknown"
        if not system_alerts.resolve_alert(alert_id, actor):
            return jsonify(success=False, message="Alert not found"), 404
        return jsonify(success=True)
    except Exception as e:
        logger.error(f"system_alerts_resolve error: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error: {e}"), 500
