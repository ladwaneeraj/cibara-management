"""
Customer search routes.
Reads from the `customers` collection (managed by customer_service).
"""

import uuid
from datetime import datetime
from flask import Blueprint, request, jsonify
from config import logger
from services import customer_service
from services.customer_service import search_by_mobile_prefix
from services.auth_service import requires_permission

customers_bp = Blueprint('customers', __name__)


# NOTE on RBAC:
# Some customer endpoints are used by the check-in flow (autocomplete by
# name/mobile, get one customer). Those stay open to anyone authenticated
# so manager can still complete a check-in. The panel-style endpoints —
# bulk list, edit, delete, flag, batch-check — are admin-only via the
# customer.manage permission. The frontend Customer Manager UI is also
# hidden for non-admins, but the backend gate is the actual boundary.


def _format_customer(c: dict) -> dict:
    """Serialise a customer dict for API responses (shared by search and get)."""
    return {
        "name": c.get("name", ""),
        "mobile": c.get("mobile", ""),
        "address": c.get("address", ""),
        "id_type": c.get("id_type", ""),
        "id_number": c.get("id_number", ""),
        "id_doc_urls": c.get("id_doc_urls", []),
        "total_stays": c.get("total_stays", 0),
        "total_spent": c.get("total_spent", 0),
        "first_visit": c.get("first_visit", ""),
        "last_stay_date": c.get("last_stay_date", ""),
        # Flag fields — included so frontend can show warning without a second request
        "is_flagged": c.get("is_flagged", False),
        "flag_reason": c.get("flag_reason", ""),
        "flag_notes": c.get("flag_notes", ""),
        "flagged_at": c.get("flagged_at", ""),
        "flagged_by": c.get("flagged_by", ""),
        # Pending settlement — auto-set on settle-later checkout, cleared on payment
        "has_pending_settlement":    c.get("has_pending_settlement", False),
        "pending_settlement_id":     c.get("pending_settlement_id"),
        "pending_settlement_amount": c.get("pending_settlement_amount"),
        "pending_settlement_date":   c.get("pending_settlement_date"),
        "pending_settlement_room":   c.get("pending_settlement_room"),
    }


@customers_bp.route("/search_customers", methods=["POST"])
def search_customers_route():
    """
    Search returning guests by name, mobile, or ID number.
    Used by the check-in form to auto-fill returning guest details.
    """
    try:
        data_json = request.json
        query_str = data_json.get("query", "").strip()
        if not query_str:
            return jsonify(success=True, customers=[])

        results = customer_service.search_customers(query_str, limit=10)
        customers = [_format_customer(c) for c in results]
        return jsonify(success=True, customers=customers)
    except Exception as e:
        logger.error(f"Error searching customers: {str(e)}")
        return jsonify(success=False, message=f"Error: {str(e)}")


@customers_bp.route("/get_customer/<mobile>", methods=["GET"])
def get_customer_route(mobile):
    """Get a single customer record by mobile number."""
    try:
        customer = customer_service.get_customer(mobile)
        if customer:
            customer.pop("_id", None)
            return jsonify(success=True, customer=_format_customer(customer))
        return jsonify(success=False, message="Customer not found")
    except Exception as e:
        logger.error(f"Error getting customer: {str(e)}")
        return jsonify(success=False, message=f"Error: {str(e)}")


@customers_bp.route("/search_customers_mobile", methods=["POST"])
def search_customers_by_mobile_route():
    """
    Search customers by partial mobile prefix (4+ digits).
    Used by the check-in form to show suggestions while typing.

    JSON body:  { "prefix": "9876" }
    Returns:    { success, customers[] }
    """
    try:
        body   = request.get_json(silent=True) or {}
        prefix = "".join(c for c in str(body.get("prefix", "")) if c.isdigit())

        if len(prefix) < 4:
            return jsonify(success=True, customers=[])

        results   = search_by_mobile_prefix(prefix)
        customers = [_format_customer(c) for c in results]
        return jsonify(success=True, customers=customers)
    except Exception as e:
        logger.error(f"Error searching customers by mobile: {str(e)}")
        return jsonify(success=False, message=f"Error: {str(e)}", customers=[])


@customers_bp.route("/upload_customer_document", methods=["POST"])
def upload_customer_document():
    """
    Upload a document image and attach it to a customer by mobile number.

    Form fields:
        mobile    – 10-digit mobile number (customer key)
        document  – image file (JPEG / PNG)

    Returns JSON: { success, url, message }
    """
    try:
        mobile = request.form.get("mobile", "").strip()
        if not mobile:
            return jsonify(success=False, message="Mobile number is required")

        if "document" not in request.files:
            return jsonify(success=False, message="No document file provided")

        file = request.files["document"]
        if not file or file.filename == "":
            return jsonify(success=False, message="Empty file")

        # Check the customer already has the maximum number of docs
        customer = customer_service.get_customer(mobile)
        if customer:
            existing_urls = customer.get("id_doc_urls", [])
            if len(existing_urls) >= 3:
                return jsonify(
                    success=False,
                    message="Maximum 3 documents already uploaded for this customer",
                    doc_count=len(existing_urls),
                )

        image_bytes = file.read()
        filename = f"doc_{uuid.uuid4().hex[:10]}_{datetime.now().strftime('%Y%m%d%H%M%S')}.jpg"

        url = customer_service.upload_document(mobile, image_bytes, filename)
        if url:
            return jsonify(success=True, url=url, message="Document uploaded successfully")
        return jsonify(success=False, message="Failed to store document — check server logs")

    except Exception as e:
        logger.error(f"Error uploading customer document: {str(e)}")
        return jsonify(success=False, message=f"Error: {str(e)}")


@customers_bp.route("/delete_customer_document", methods=["POST"])
@requires_permission("customer.manage")
def delete_customer_document():
    """
    Remove a specific document URL from a customer's id_doc_urls list.

    JSON body:
        mobile  – 10-digit mobile number
        url     – the exact URL to remove

    Returns JSON: { success, message, remaining }
    """
    try:
        data   = request.get_json(silent=True) or {}
        mobile = "".join(c for c in str(data.get("mobile", "")) if c.isdigit())
        url    = str(data.get("url", "")).strip()

        if len(mobile) != 10:
            return jsonify(success=False, message="Valid 10-digit mobile required"), 400
        if not url:
            return jsonify(success=False, message="Document URL required"), 400

        customer = customer_service.get_customer(mobile)
        if not customer:
            return jsonify(success=False, message="Customer not found"), 404

        urls = list(customer.get("id_doc_urls", []))
        if url not in urls:
            return jsonify(success=False, message="URL not found in customer record"), 404

        urls.remove(url)

        from config import db as _db
        _db.collection("customers").document(mobile).update({"id_doc_urls": urls})

        # Delete from Firebase Storage in a background thread so the HTTP response
        # is returned immediately after the Firestore update without waiting for
        # the Storage round-trip (~200-400 ms saved per delete).
        if url.startswith("https://firebasestorage.googleapis.com"):
            import threading, urllib.parse
            from firebase_admin import storage as _fb_storage

            def _delete_blob(blob_url):
                try:
                    path_encoded = blob_url.split("/o/")[1].split("?")[0]
                    blob_path    = urllib.parse.unquote(path_encoded)
                    _fb_storage.bucket().blob(blob_path).delete()
                    logger.info(f"Storage: deleted {blob_path}")
                except Exception as err:
                    logger.warning(f"Storage delete skipped: {err}")

            threading.Thread(target=_delete_blob, args=(url,), daemon=True).start()

        return jsonify(success=True, message="Document removed", remaining=len(urls))

    except Exception as e:
        logger.error(f"delete_customer_document error: {e}")
        return jsonify(success=False, message=f"Error: {e}"), 500


@customers_bp.route("/toggle_customer_flag", methods=["POST"])
@requires_permission("customer.manage")
def toggle_customer_flag():
    """
    Set or clear the customer flag.

    JSON body:
        mobile      – 10-digit mobile number
        is_flagged  – boolean (true = flag, false = unflag)
        flag_notes  – optional notes / reason string

    Returns JSON: { success, message }
    """
    try:
        data = request.get_json(silent=True) or {}
        mobile = "".join(c for c in str(data.get("mobile", "")) if c.isdigit())
        is_flagged = bool(data.get("is_flagged", False))
        flag_notes = str(data.get("flag_notes", "")).strip()

        if len(mobile) != 10:
            return jsonify(success=False, message="Valid 10-digit mobile required"), 400

        # update_flag uses set(merge=True) so it works whether the customer
        # document already exists or not — no existence pre-check needed.
        # Use sync=True so the HTTP response reflects the committed write.
        logger.info(f"toggle_customer_flag: mobile={mobile} is_flagged={is_flagged} notes='{flag_notes}'")
        customer_service.update_flag(mobile, is_flagged, flag_notes, sync=True)
        logger.info(f"toggle_customer_flag: write completed for {mobile}")

        action = "flagged" if is_flagged else "unflagged"
        return jsonify(success=True, message=f"Customer {action} successfully")

    except Exception as e:
        logger.error(f"toggle_customer_flag error: {e}")
        return jsonify(success=False, message=f"Error: {e}"), 500


@customers_bp.route("/list_customers", methods=["GET"])
@requires_permission("customer.manage")
def list_customers_route():
    """
    Paginated lightweight customer list (no image URLs — only doc_count).

    Query params:
        search      – name / mobile / ID search (disables cursor paging)
        page_size   – rows per page, 1-100, default 50
        cursor      – mobile of last row from previous page (empty = first page)
    """
    try:
        search    = request.args.get("search", "").strip()
        page_size = min(int(request.args.get("page_size", 50)), 100)
        cursor    = request.args.get("cursor", "").strip()

        result = customer_service.list_customers_page(
            page_size=page_size, cursor=cursor, search=search
        )
        return jsonify(
            success=True,
            customers=result["customers"],
            next_cursor=result["next_cursor"],
            has_more=result["has_more"],
            total=len(result["customers"]),
        )
    except Exception as e:
        logger.error(f"list_customers error: {e}")
        return jsonify(success=False, message=str(e)), 500


@customers_bp.route("/update_customer", methods=["POST"])
@requires_permission("customer.manage")
def update_customer_route():
    """
    Update editable fields on a customer record.

    JSON body:
        mobile   – 10-digit mobile (required, used as the key)
        name     – optional
        address  – optional
        id_type  – optional
        id_number – optional
    """
    try:
        data   = request.get_json(silent=True) or {}
        mobile = "".join(c for c in str(data.get("mobile", "")) if c.isdigit())
        if len(mobile) != 10:
            return jsonify(success=False, message="Valid 10-digit mobile required"), 400

        ok = customer_service.update_customer(mobile, data)
        if ok:
            return jsonify(success=True, message="Customer updated")
        return jsonify(success=False, message="Update failed or no valid fields"), 400
    except Exception as e:
        logger.error(f"update_customer error: {e}")
        return jsonify(success=False, message=str(e)), 500


@customers_bp.route("/add_customer", methods=["POST"])
def add_customer_route():
    """
    Manually add a new customer record (without a booking).

    JSON body:
        mobile   – 10-digit (required)
        name     – required
        address  – optional
        id_type  – optional
        id_number – optional
    """
    try:
        data   = request.get_json(silent=True) or {}
        mobile = "".join(c for c in str(data.get("mobile", "")) if c.isdigit())
        name   = str(data.get("name", "")).strip()

        if len(mobile) != 10:
            return jsonify(success=False, message="Valid 10-digit mobile required"), 400
        if not name:
            return jsonify(success=False, message="Name is required"), 400

        ok = customer_service.add_customer(data)
        if ok:
            return jsonify(success=True, message="Customer added")
        return jsonify(success=False, message="Failed to add customer"), 500
    except Exception as e:
        logger.error(f"add_customer error: {e}")
        return jsonify(success=False, message=str(e)), 500



@customers_bp.route("/batch_check_customer_docs", methods=["POST"])
# Open to any authenticated user. This is a lightweight existence check —
# returns just the list of mobile numbers that have at least one ID
# document on file. Manager / admin both need it for the Register tab to
# reveal the per-row "View ID document" icon. The actual document URLs
# come from /get_customer/<mobile>, which is also open to all roles
# (used during the check-in autocomplete flow).
def batch_check_customer_docs():
    """
    Given a list of mobile numbers, return which ones have at least one
    ID document stored (non-empty id_doc_urls).

    Uses Firestore getAll() for a single round-trip regardless of list size.

    Body:  { "mobiles": ["9876543210", ...] }
    Returns: { "success": true, "mobiles_with_docs": ["9876543210", ...] }
    """
    try:
        from config import db as _db
        data    = request.json or {}
        mobiles = [str(m).strip() for m in data.get("mobiles", []) if m]
        mobiles = list(dict.fromkeys(mobiles))[:500]  # deduplicate, cap at 500

        if not mobiles:
            return jsonify(success=True, mobiles_with_docs=[])

        cust_ref = _db.collection("customers")

        # Firestore get_all() is hard-capped at 100 docs per call.
        # Chunk the mobile list so registers with 100+ entries work correctly.
        CHUNK = 100
        mobiles_with_docs = []
        for i in range(0, len(mobiles), CHUNK):
            chunk = mobiles[i:i + CHUNK]
            refs  = [cust_ref.document(m) for m in chunk]
            for snap in _db.get_all(refs):
                if snap.exists:
                    urls = snap.get("id_doc_urls") or []
                    if urls:
                        mobiles_with_docs.append(snap.id)

        return jsonify(success=True, mobiles_with_docs=mobiles_with_docs)

    except Exception as e:
        logger.error(f"batch_check_customer_docs error: {e}")
        # Non-fatal — return empty so the UI just hides all doc buttons
        return jsonify(success=True, mobiles_with_docs=[])


