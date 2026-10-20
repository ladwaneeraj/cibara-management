"""Guest-facing web booking routes (public, CORS-enabled for the website origin).

All endpoints here live under /web/ which is in app._PUBLIC_PREFIXES, so they
need no staff auth. Never expose secrets or internal tuning knobs from here.
"""
from flask import Blueprint, jsonify

from config import get_web_config

web_bp = Blueprint('web', __name__)


@web_bp.route("/web/config", methods=["GET"])
def web_config():
    """Public flags the website needs to decide whether to show booking."""
    cfg = get_web_config()
    return jsonify(
        online_bookings_enabled=bool(cfg["online_bookings_enabled"]),
        cleaning_gap_minutes=int(cfg["cleaning_gap_minutes"]),
    )
