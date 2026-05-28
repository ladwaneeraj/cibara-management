"""
OCR endpoints — pre-fill the expense modal from a photo of the bill.

Routes
──────
POST /ocr/expense_invoice    multipart with "file"   → parsed fields JSON
GET  /ocr/status             →   { enabled: bool }   (frontend feature flag)

Both endpoints are login-gated. They're a typing helper, not a
sensitive action, so no extra permission is required beyond being
authenticated. The cost / privacy concerns sit at the deployment layer
(API key + the fact that images are sent to Google).
"""

from __future__ import annotations

from flask import Blueprint, request, jsonify

from config import logger
from services import ocr_service
from services.auth_service import login_required


ocr_bp = Blueprint("ocr", __name__)


# Image size + type guardrails. Matches the limits already enforced in
# /upload_expense_invoice so OCR can't accept a file the upload would
# later reject.
_MAX_BYTES = 5 * 1024 * 1024  # 5 MB
_ALLOWED_MIME = ("image/jpeg", "image/png", "image/webp", "application/pdf")


@ocr_bp.route("/ocr/status", methods=["GET"])
@login_required
def ocr_status():
    """Lets the frontend know whether to show the auto-fill UI at all."""
    return jsonify(success=True, enabled=ocr_service.is_enabled())


@ocr_bp.route("/ocr/expense_invoice", methods=["POST"])
@login_required
def ocr_expense_invoice():
    """
    Run OCR on an uploaded image and return a dict of suggested fields.

    The frontend uses the result to pre-fill the expense modal — every
    field is editable by the operator before save.
    """
    try:
        if not ocr_service.is_enabled():
            # 200 with success=False so the frontend treats this as
            # "feature off" rather than a server error.
            return jsonify(success=False, reason="ocr_disabled",
                           message="OCR not configured on this server")

        if "file" not in request.files:
            return jsonify(success=False, reason="bad_request",
                           message="No file provided"), 400

        file = request.files["file"]
        if not file or not file.filename:
            return jsonify(success=False, reason="bad_request",
                           message="Empty file"), 400

        mime = (file.mimetype or "").lower()
        if mime not in _ALLOWED_MIME:
            return jsonify(
                success=False, reason="bad_request",
                message="Only JPG/PNG/WEBP/PDF supported"
            ), 400

        # Read the bytes once. flask's FileStorage stream is one-shot.
        data = file.read()
        if not data:
            return jsonify(success=False, reason="bad_request",
                           message="Empty file body"), 400
        if len(data) > _MAX_BYTES:
            return jsonify(success=False, reason="bad_request",
                           message="File too large (max 5 MB)"), 400

        result = ocr_service.extract_invoice_fields(data, mime)
        # Always 200 — the result dict itself carries success / reason.
        return jsonify(result)

    except Exception as e:
        logger.error("ocr_expense_invoice failed: %s", e)
        return jsonify(success=False, reason="ocr_error", message=str(e)), 500
