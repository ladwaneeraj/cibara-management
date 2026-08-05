"""
Manual bill route — /manual_bill/create

Operator-authored ("serial-wise generated") bill for a stay entered outside
the live check-in/checkout flow. Admin-only: it writes real financial records
(a sequential GST bill + dated payments) and backdates them, so it is gated on
the same admin-only custody permission as editing payments.

All validation, serial minting, GST build and atomic numbering live in
services/manual_bill_service.py (which reuses the checkout machinery verbatim).
"""

from flask import Blueprint, request, jsonify, g

from config import logger
from services import manual_bill_service as svc
from services.auth_service import requires_permission
from services.audit_log import write_log

manual_bill_bp = Blueprint("manual_bill", __name__, url_prefix="/manual_bill")

# Admin-only. payment.edit is granted only via the admin wildcard — managers
# do not have it — so it is the right custody gate for authoring/backdating a
# financial record.
_MANUAL_BILL_PERM = "payment.edit"


@manual_bill_bp.route("/create", methods=["POST"])
@requires_permission(_MANUAL_BILL_PERM)
def create():
    try:
        result = svc.create_manual_bill(request.json or {}, g.current_user)
        write_log(
            "bill.manual.create",
            target_collection="bills", target_id=result["stay_id"],
            after={"bill_number": result["bill_number"],
                   "serial_number": result["serial_number"],
                   "room": result["room"],
                   "guest": result["guest_name"],
                   "total_amount": result["total_amount"],
                   "checkin_time": result["checkin_time"],
                   "checkout_time": result["checkout_time"]},
        )
        bn = result["bill_number"]
        bn_txt = ("bill {}".format(bn) if bn and bn != "-" else "no GST invoice number")
        return jsonify(
            success=True,
            message="Manual bill created for {} — serial #{}, {}.".format(
                result["guest_name"], result["serial_number"], bn_txt),
            **result,
        )
    except ValueError as ve:
        return jsonify(success=False, message=str(ve)), 400
    except Exception as e:
        logger.exception("manual_bill/create failed")
        return jsonify(success=False, message="Error: {}".format(e)), 500
