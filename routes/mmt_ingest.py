"""
MMT Gmail-ingestion routes.

Endpoints
---------
POST /mmt/ingest
    Runs one ingestion pass: reads new MMT voucher emails over IMAP, parses
    them, and creates bookings (source=mmt, room unassigned) for any not
    already present. Designed to be called by Cloud Scheduler every few
    minutes. Authenticated by a shared secret header so the scheduler does
    not need a Firebase token:

        X-Ingest-Secret: <MMT_INGEST_SECRET>

    The whitelisting for this header lives in app.require_auth so the global
    auth gate lets the scheduler through. If MMT_INGEST_SECRET is unset, the
    endpoint still requires normal app auth (Firebase token / API key), so it
    can be triggered manually from an authenticated session.

    Optional JSON body: {"dry_run": true} to parse without writing.

GET /mmt/ingest_status
    Returns the stored cursor + last-run summary for visibility in the UI.
    Normal app auth applies.
"""

import os
import uuid
import random
from datetime import datetime, timedelta

from flask import Blueprint, request, jsonify

from config import logger, settings_ref, bookings_ref, rooms_ref, IST, CIBARA_ENV
from services import mmt_ingest_service as mmt

mmt_ingest_bp = Blueprint("mmt_ingest", __name__)


@mmt_ingest_bp.route("/mmt/ingest", methods=["POST"])
def mmt_ingest_run():
    try:
        body = request.get_json(silent=True) or {}
        dry_run = bool(body.get("dry_run", False))
        # Optional: re-scan the last N days ignoring the cursor (recover/test
        # a settlement email older than the last processed voucher).
        force_days = body.get("force_days")
        try:
            force_days = int(force_days) if force_days else None
        except (TypeError, ValueError):
            force_days = None
        summary = mmt.ingest(dry_run=dry_run, force_days=force_days)
        # 200 even when not configured / soft errors — the summary carries
        # the detail. The scheduler treats any 2xx as "ran"; operators read
        # the summary. Hard failures (exceptions) fall through to 500 below.
        return jsonify(success=True, **summary)
    except Exception as e:
        logger.error(f"/mmt/ingest failed: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


@mmt_ingest_bp.route("/mmt/ingest_status", methods=["GET"])
def mmt_ingest_status():
    try:
        cfg = mmt.load_config()
        cursor = mmt.read_cursor(settings_ref)
        return jsonify(
            success=True,
            configured=mmt.is_configured(cfg),
            host=cfg.get("host"),
            user_set=bool(cfg.get("user")),
            senders=cfg.get("senders"),
            cursor=cursor,
        )
    except Exception as e:
        logger.error(f"/mmt/ingest_status failed: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


@mmt_ingest_bp.route("/mmt/create_test_booking", methods=["POST"])
def mmt_create_test_booking():
    """
    DEV/UAT ONLY — create a fully-formed MMT test booking for today so the
    end-to-end flow (room auto-assign → check-in → 5% B2B invoice → settle)
    can be exercised without a real voucher email. Disabled when
    CIBARA_ENV=PROD.

    Reuses the real ingestion logic (build_booking_from_voucher + _assign_room)
    so the test booking is identical in shape to a real ingested one. Each call
    uses a fresh random mmt_booking_id, so it never collides / is never skipped.

    Optional JSON body (all have sensible defaults):
        room_type   : "Premium AC Rooms" | "Premium Rooms" | "AC Room" | ...
        b2b         : true  -> include GOGREEN customer GSTIN (B2B);
                      false -> no GSTIN (B2C)
        tariff      : gross room amount incl GST (default 1365)
        nights      : default 1
        guest_name  : default "Test MMT Guest"
    """
    if (CIBARA_ENV or "").upper() == "PROD":
        return jsonify(success=False, message="Disabled in PROD"), 403
    try:
        body = request.get_json(silent=True) or {}
        room_type = body.get("room_type", "Premium AC Rooms")
        is_b2b = body.get("b2b", True)
        tariff = float(body.get("tariff", 1365))
        nights = int(body.get("nights", 1))
        guest_name = body.get("guest_name", "Test MMT Guest")

        now = datetime.now(IST)
        today = now.strftime("%Y-%m-%d")
        co = (now + timedelta(days=nights)).strftime("%Y-%m-%d")

        # Commission ~19% incl 18% GST (mirrors a real voucher) + TCS/TDS.
        commission = round(tariff * 0.19 / 1.18, 2)
        commission_gst = round(commission * 0.18, 2)
        tcs = round(tariff * 0.005, 2)
        tds = round(tariff * 0.001, 2)
        payable = round(tariff - commission - commission_gst - tcs - tds, 2)

        parsed = {
            "mmt_booking_id": f"NH{random.randint(10**13, 10**14 - 1)}",
            "pnr": str(random.randint(10**9, 10**10 - 1)),
            "guest_name": guest_name,
            "check_in_date": today,
            "check_in_time": "12:00",
            "check_out_date": co,
            "guest_count": 1,
            "room_type": room_type,
            "invoice_amount": tariff,
            "property_gross_charges": tariff,
            "payable_to_property": payable,
            "commission": commission,
            "commission_gst": commission_gst,
            "commission_incl_gst": round(commission + commission_gst, 2),
            "tcs_amount": tcs,
            "tds_amount": tds,
            "nights": nights,
            "property_gstin": "29AAWFC1962B1Z9",
            "needs_review": False,
            "review_reasons": [],
        }
        if is_b2b:
            parsed["customer_gstin"] = "29AACCF7185N1ZW"
            parsed["customer_name"] = "GOGREEN WAREHOUSES PVT LTD"
            parsed["customer_address"] = ("KHATA NO 65/5,65/4,68/10, KACHANAHALLI "
                                          "VILLAGE, NELAMANGALA, KARNATAKA, 562123")

        booking = mmt.build_booking_from_voucher(parsed, now=now)

        room, is_ac, reason = mmt._assign_room(
            bookings_ref, rooms_ref, today, co, room_type, today,
            booking.get("guest_count", 1))
        if room:
            booking["room"] = room
            booking["is_ac"] = is_ac
            booking["room_assigned"] = True

        booking_id = str(uuid.uuid4())
        booking["createdAt"] = now.isoformat()
        booking["bookedBy"] = "mmt-test"
        booking["createdBy"] = "mmt-test"
        bookings_ref.document(booking_id).set(booking)

        try:
            from config import invalidate_rooms_and_totals
            invalidate_rooms_and_totals()
        except Exception:
            pass

        return jsonify(
            success=True,
            booking_id=booking_id,
            mmt_booking_id=parsed["mmt_booking_id"],
            room=booking["room"] or "(unassigned)",
            is_ac=booking.get("is_ac"),
            invoice_type=booking.get("invoice_type"),
            check_in_date=today,
            check_out_date=co,
            tariff=tariff,
            assign_note=reason or "assigned",
            message=f"Test MMT booking created in {CIBARA_ENV}",
        )
    except Exception as e:
        logger.error(f"/mmt/create_test_booking failed: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500
