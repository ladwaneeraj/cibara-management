"""
Agoda Gmail-ingestion routes (parallel to routes/mmt_ingest.py).

Endpoints
---------
POST /agoda/ingest
    Runs one ingestion pass: reads new Agoda booking-confirmation emails over
    IMAP, parses them, and creates bookings (source=agoda, room auto-assigned
    from the AC/Non-AC pool) for any not already present. Idempotent.

    Authenticated either by the logged-in operator's normal app auth, or by a
    shared secret header for Cloud Scheduler:

        X-Ingest-Secret: <AGODA_INGEST_SECRET or MMT_INGEST_SECRET>

    The header whitelisting lives in app.require_auth.

    Optional JSON body:
        {"dry_run": true}      parse without writing
        {"force_days": 30}     re-scan the last N days, ignoring the cursor

GET /agoda/ingest_status
    Returns the stored cursor + config visibility. Normal app auth applies.
"""

from flask import Blueprint, request, jsonify

from config import logger, settings_ref
from services import agoda_ingest_service as agoda

agoda_ingest_bp = Blueprint("agoda_ingest", __name__)


@agoda_ingest_bp.route("/agoda/ingest", methods=["POST"])
def agoda_ingest_run():
    try:
        body = request.get_json(silent=True) or {}
        dry_run = bool(body.get("dry_run", False))
        force_days = body.get("force_days")
        try:
            force_days = int(force_days) if force_days else None
        except (TypeError, ValueError):
            force_days = None
        summary = agoda.ingest(dry_run=dry_run, force_days=force_days)
        return jsonify(success=True, **summary)
    except Exception as e:
        logger.error(f"/agoda/ingest failed: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


@agoda_ingest_bp.route("/agoda/ingest_status", methods=["GET"])
def agoda_ingest_status():
    try:
        cfg = agoda.load_config()
        cursor = agoda.read_cursor(settings_ref)
        return jsonify(
            success=True,
            configured=agoda.is_configured(cfg),
            host=cfg.get("host"),
            user_set=bool(cfg.get("user")),
            senders=cfg.get("senders"),
            invoice_basis=cfg.get("invoice_basis"),
            cursor=cursor,
        )
    except Exception as e:
        logger.error(f"/agoda/ingest_status failed: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500
