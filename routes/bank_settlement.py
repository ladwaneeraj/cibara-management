"""
Bank payment-advice settlement routes.

POST /bank/settlements/ingest
    Scan bank payment-advice emails (password-protected PDF attachments),
    decrypt + parse them, and auto-settle the matching pending OTA booking
    (MMT / Agoda) by amount. Idempotent. Same shared-secret scheme as the
    OTA ingest routes (X-Ingest-Secret) for Cloud Scheduler; normal app auth
    otherwise.

    Optional JSON body: {"dry_run": true} | {"force_days": 30}

GET /bank/settlements/ingest_status
    Stored cursor + config visibility. Normal app auth.
"""

from flask import Blueprint, request, jsonify

from config import logger, settings_ref
from services import bank_settlement_service as bank

bank_settlement_bp = Blueprint("bank_settlement", __name__)


@bank_settlement_bp.route("/bank/settlements/ingest", methods=["POST"])
def bank_settlements_ingest():
    try:
        body = request.get_json(silent=True) or {}
        dry_run = bool(body.get("dry_run", False))
        force_days = body.get("force_days")
        try:
            force_days = int(force_days) if force_days else None
        except (TypeError, ValueError):
            force_days = None
        summary = bank.ingest(dry_run=dry_run, force_days=force_days)
        return jsonify(success=True, **summary)
    except Exception as e:
        logger.error(f"/bank/settlements/ingest failed: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


@bank_settlement_bp.route("/bank/settlements/ingest_status", methods=["GET"])
def bank_settlements_status():
    try:
        cfg = bank.load_config()
        cursor = bank.read_cursor(settings_ref)
        return jsonify(
            success=True,
            configured=bank.is_configured(cfg),
            host=cfg.get("host"),
            user_set=bool(cfg.get("user")),
            senders=cfg.get("senders"),
            pdf_password_set=bool(cfg.get("pdf_passwords")),
            tolerance=cfg.get("tolerance"),
            cursor=cursor,
        )
    except Exception as e:
        logger.error(f"/bank/settlements/ingest_status failed: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500
