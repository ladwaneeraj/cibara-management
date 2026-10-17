"""
Customer search routes.
Reads from the `customers` collection (managed by customer_service).
"""

import uuid
import threading
from datetime import datetime
from flask import Blueprint, request, jsonify
from config import logger
from services import customer_service
from services import ocr_service
from services import id_docs
from services.audit_log import write_log
from services import pincode_geo
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
        # ID documents are private now (services/id_docs.py): the browser gets
        # a count and loads images through /api/v2/customers/<m>/id-docs.
        # The key stays (empty) so older scripts that read it don't break.
        "id_doc_urls": [],
        "id_doc_count": id_docs.active_count(c),
        "total_stays": c.get("total_stays", 0),
        "total_spent": c.get("total_spent", 0),
        "first_visit": c.get("first_visit", ""),
        "last_stay_date": c.get("last_stay_date", ""),
        "last_stay_amount": c.get("last_stay_amount", 0),
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
        # ── Sticky preferences (services/customer_service.py) ──────────────
        # wants_bill: this guest asked for a bill before, so the next stay
        # gets one whatever the payment mode. Surfaced here so the check-in
        # form can say so before the operator wonders why a cash stay
        # produced an invoice.
        "wants_bill":        bool(c.get("wants_bill", False)),
        "wants_bill_since":  c.get("wants_bill_since", ""),
        "wants_bill_source": c.get("wants_bill_source", ""),
        # gst_profile: the GST details this guest was last invoiced under.
        # None when they have never been billed B2B. The check-in form OFFERS
        # these; it never applies them on its own.
        "gst_profile":       c.get("gst_profile") or None,
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


def _id_doc_links(mobile: str) -> dict:
    """In-app links to the guest's active ID photos, for users allowed to see
    them (customer_doc.view: admin, manager). The links only work with the
    signed-in session — there is no public URL any more. `id_doc_meta` says
    who captured each photo and when, for the photo viewer caption."""
    from services.auth_service import load_current_user, role_has_permission
    user = load_current_user()
    if not user or not role_has_permission(user.get("role"), "customer_doc.view"):
        return {"id_doc_urls": [], "id_doc_meta": []}
    try:
        docs = [d for d in id_docs.list_documents(mobile) if d.get("status") == "active"]
    except Exception as e:
        logger.warning(f"id doc links for {mobile} unavailable: {e}")
        return {"id_doc_urls": [], "id_doc_meta": []}
    clean = id_docs.clean_mobile(mobile)
    meta = [{
        "url": f"/api/v2/customers/{clean}/id-docs/{d['id']}/image",
        "side": d.get("side"),
        "captured_by": (d.get("captured_by") or {}).get("name") or "",
        "captured_at": d.get("captured_at") or "",
        "legacy": bool(d.get("legacy")),
    } for d in docs]
    return {"id_doc_urls": [m["url"] for m in meta], "id_doc_meta": meta,
            "id_doc_count": len(meta)}


def _pending_from_settlements(mobile: str, out: dict) -> dict:
    """The check-in warning, from the settlements themselves rather than the
    single has_pending_settlement flag (which describes one stay at most and
    can drift). The pending_settlement_* fields point at the OLDEST open
    balance — what the Collect button takes first — and the totals cover all
    of them. If the lookup fails the stored flag is kept as before."""
    rows = customer_service.open_settlements(mobile)
    if rows is None:
        return {}
    if not rows:
        return {"has_pending_settlement": False, "pending_settlement_id": None,
                "pending_settlement_amount": None, "pending_settlement_date": None,
                "pending_settlement_room": None, "pending_settlements": [],
                "pending_settlement_total": 0, "pending_settlement_count": 0}
    first = rows[0]
    return {
        "has_pending_settlement":    True,
        "pending_settlement_id":     first["id"],
        "pending_settlement_amount": first["amount"],
        "pending_settlement_date":   first["checkout_date"],
        "pending_settlement_room":   first["room"],
        "pending_settlements":       rows,
        "pending_settlement_total":  sum(r["amount"] for r in rows),
        "pending_settlement_count":  len(rows),
    }


@customers_bp.route("/get_customer/<mobile>", methods=["GET"])
def get_customer_route(mobile):
    """Get a single customer record by mobile number."""
    try:
        customer = customer_service.get_customer(mobile)
        if customer:
            customer.pop("_id", None)
            out = _format_customer(customer)
            out.update(_id_doc_links(customer.get("mobile") or mobile))
            out.update(_pending_from_settlements(customer.get("mobile") or mobile, out))
            return jsonify(success=True, customer=out)
        return jsonify(success=False, message="Customer not found")
    except Exception as e:
        logger.error(f"Error getting customer: {str(e)}")
        return jsonify(success=False, message=f"Error: {str(e)}")


@customers_bp.route("/admin/backfill_last_stay", methods=["POST"])
@requires_permission("customer.manage")
def backfill_last_stay_route():
    """One-off: populate last_stay_amount on existing customers. Admin only."""
    try:
        return jsonify(success=True, result=customer_service.backfill_last_stay_amounts())
    except Exception as e:
        logger.error(f"backfill_last_stay error: {e}")
        return jsonify(success=False, message=str(e)), 500


@customers_bp.route("/customer_stays/<mobile>", methods=["GET"])
def customer_stays_route(mobile):
    """Full stay history for a guest — powers the Customer Records History view."""
    try:
        return jsonify(success=True,
                       stays=customer_service.get_stay_history(mobile))
    except Exception as e:
        logger.error(f"customer_stays error: {e}")
        return jsonify(success=False, message=str(e), stays=[])


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
@requires_permission("customer_doc.capture")
def upload_customer_document():
    """
    Upload an ID document image and attach it to a customer by mobile number.
    Kept for older screens; the scanner uses POST /api/v2/customers/<m>/id-docs.

    Form fields:
        mobile    – 10-digit mobile number (customer key)
        document  – image file (JPEG / PNG / WebP)
        side      – optional: front | back | other (default front)
        source    – optional: auto_scan | manual | upload (default upload)
        context   – optional: checkin | checkout | customer_manager | register
        room      – optional room number

    Returns JSON: { success, url, id, message } — `url` is the in-app image
    endpoint (needs the signed-in session), never a public link.
    """
    try:
        from flask import g
        mobile = request.form.get("mobile", "").strip()
        if not mobile:
            return jsonify(success=False, message="Mobile number is required")

        if "document" not in request.files:
            return jsonify(success=False, message="No document file provided")

        file = request.files["document"]
        if not file or file.filename == "":
            return jsonify(success=False, message="Empty file")

        image_bytes = file.read()
        mime = (file.mimetype or "image/jpeg").lower()
        user = getattr(g, "current_user", None)
        try:
            rec = id_docs.add_document(
                mobile, image_bytes, user=user,
                # The classic screens don't label sides: "other" never archives
                # an earlier photo of the same guest.
                side=request.form.get("side", "other"),
                source=request.form.get("source", "upload"),
                context={"kind": request.form.get("context", "customer_manager"),
                         "room": request.form.get("room", "")},
                device=request.headers.get("User-Agent", ""),
            )
        except id_docs.IdDocError as e:
            return jsonify(success=False, message=str(e)), (e.status if e.status != 400 else 200)

        clean = id_docs.clean_mobile(mobile)
        url = f"/api/v2/customers/{clean}/id-docs/{rec['id']}/image"
        write_log("customer_doc.capture", target_collection="customers", target_id=clean,
                  metadata={"doc_id": rec["id"], "side": rec.get("side"),
                            "source": rec.get("source"), "via": "legacy_route"})
        # Best-effort demographics extraction (pincode + DOB) in the
        # background — never blocks the upload response, never fails it.
        # Gated by the ID-OCR kill-switch inside ocr_service.
        _maybe_extract_demographics(clean, image_bytes, mime, f"iddoc:{rec['id']}")
        return jsonify(success=True, url=url, id=rec["id"], document=rec,
                       message="Document saved securely")

    except Exception as e:
        logger.error(f"Error uploading customer document: {str(e)}")
        return jsonify(success=False, message=f"Error: {str(e)}")


@customers_bp.route("/delete_customer_document", methods=["POST"])
@requires_permission("customer_doc.remove")
def delete_customer_document():
    """
    Remove an ID document from a customer's record — SOFT delete.

    The record is marked `removed` with who/when/why and the file is kept, so
    an admin can restore it. (The old version rewrote the whole id_doc_urls
    list — losing any document uploaded at the same moment — and deleted the
    file from Storage for good.)

    JSON body:
        mobile  – 10-digit mobile number
        url     – the document's URL (old download link or in-app image URL)
        id      – or the document id
        reason  – optional reason (defaults to "Removed from viewer")
    """
    try:
        from flask import g
        data   = request.get_json(silent=True) or {}
        mobile = "".join(c for c in str(data.get("mobile", "")) if c.isdigit())
        url    = str(data.get("url", "")).strip()
        doc_id = str(data.get("id", "")).strip()

        if len(mobile) != 10:
            return jsonify(success=False, message="Valid 10-digit mobile required"), 400
        if not doc_id:
            doc_id = id_docs.resolve_legacy_url(mobile, url)
        if not doc_id:
            return jsonify(success=False, message="Document not found in customer record"), 404

        reason = str(data.get("reason", "")).strip() or "Removed from viewer"
        try:
            rec = id_docs.remove_document(mobile, doc_id, user=getattr(g, "current_user", None),
                                          reason=reason)
        except id_docs.IdDocError as e:
            return jsonify(success=False, message=str(e)), e.status
        write_log("customer_doc.remove", target_collection="customers", target_id=mobile,
                  metadata={"doc_id": doc_id, "reason": reason, "via": "legacy_route"})
        remaining = sum(1 for d in id_docs.list_documents(mobile) if d.get("status") == "active")
        return jsonify(success=True, message="Document removed (kept in history)",
                       remaining=remaining, document=rec)

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
        wants_bill – optional bool; send False to drop the always-bill
                     preference a guest picked up by asking for a bill.

    The allow-list lives in customer_service.update_customer, not here, so
    anything else in the body is ignored rather than written.
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



def _group_mobiles_by_clean(raw_mobiles):
    """Group raw mobile strings by their cleaned 10-digit key.

    Returns (clean_keys, clean_to_raws). Customer documents — and the id_docs
    summary on them — are keyed by the cleaned mobile, so a lookup must use the
    clean key; but the response has to echo the ORIGINAL strings the client
    sent, because the Register caches per-row doc status by the raw
    guest_mobile. This bridges the two: look up by `clean_keys`, answer with the
    `clean_to_raws[clean]` originals. Invalid / non-10-digit numbers drop out.
    """
    clean_to_raws: dict[str, list[str]] = {}
    for raw in raw_mobiles:
        clean = id_docs.clean_mobile(raw)
        if clean:
            clean_to_raws.setdefault(clean, []).append(str(raw))
    return list(clean_to_raws.keys()), clean_to_raws


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
        data = request.json or {}
        raw_mobiles = [str(m).strip() for m in data.get("mobiles", []) if m]

        # Clean every number to its 10-digit key before using it as a Firestore
        # document id. Customer docs — and the id_docs summary on them — are
        # keyed by the cleaned mobile (services.customer_service._clean_mobile),
        # and every other lookup in the app cleans first. This route did not: it
        # used the raw guest_mobile straight as the doc id. A number stored with
        # a +91 / space / leading 0 (check-in keeps it raw, routes/rooms.py) was
        # then looked up under a key that does not exist, so the Register row's
        # ID icon stayed "missing" even though the document was on file.
        #
        # The response must echo the ORIGINAL strings the client sent: the
        # Register keys its per-row doc-status cache by the raw guest_mobile, so
        # a cleaned key would never match. Map clean -> original(s) and return
        # the originals.
        clean_keys, clean_to_raws = _group_mobiles_by_clean(raw_mobiles)
        clean_keys = clean_keys[:500]  # cap at 500 lookups
        if not clean_keys:
            return jsonify(success=True, mobiles_with_docs=[])

        cust_ref = _db.collection("customers")

        # Firestore get_all() is hard-capped at 100 docs per call.
        # Chunk the mobile list so registers with 100+ entries work correctly.
        CHUNK = 100
        mobiles_with_docs = []
        for i in range(0, len(clean_keys), CHUNK):
            chunk = clean_keys[i:i + CHUNK]
            refs  = [cust_ref.document(m) for m in chunk]
            for snap in _db.get_all(refs):
                if snap.exists and id_docs.active_count(snap.to_dict() or {}) > 0:
                    mobiles_with_docs.extend(clean_to_raws.get(snap.id, [snap.id]))

        return jsonify(success=True, mobiles_with_docs=mobiles_with_docs)
    except Exception as e:
        logger.error(f"batch_check_customer_docs error: {e}")
        return jsonify(success=False, message=str(e)), 500


# ---------------------------------------------------------------------------
# DEMOGRAPHICS — ID-OCR extraction + analytics aggregate
# ---------------------------------------------------------------------------

def _maybe_extract_demographics(mobile: str, image_bytes: bytes,
                                mime: str, source_url: str) -> None:
    """
    Fire-and-forget: OCR the ID image for pincode + DOB and merge the result
    into the customer's demographics. Swallows all errors — this is an
    analytics nicety, never allowed to affect the upload itself.
    """
    if not ocr_service.id_ocr_enabled():
        return

    def _worker():
        try:
            res = ocr_service.extract_id_fields(image_bytes, mime)
            if res.get("success") and res.get("fields"):
                customer_service.apply_id_extraction(
                    mobile, res["fields"], source_url=source_url, sync=True
                )
        except Exception as e:
            logger.warning(f"demographics extraction skipped for {mobile}: {e}")

    threading.Thread(target=_worker, daemon=True).start()


@customers_bp.route("/customer_analytics", methods=["GET"])
@requires_permission("customer.manage")
def customer_analytics_route():
    """
    Aggregated guest demographics for the analytics dashboard:
    age distribution + average age, and footfall per pincode.

    Query params:
        refresh – "1" to bypass the 5-minute cache and rescan.

    Returns: { success, age:{...}, pincodes:[...], totals:{...},
               ocr_enabled: bool }
    """
    try:
        force = request.args.get("refresh", "") in ("1", "true", "yes")
        agg = customer_service.get_demographics_aggregate(force=force)

        # Attach map coordinates to each pincode (best-effort, offline lookup).
        # Rows whose PIN can't be resolved are still returned (for the bar
        # chart) but omitted from geo_points (the map).
        geo_points = []
        resolved = 0
        for row in agg["pincodes"]:
            loc = pincode_geo.resolve(row["pincode"])
            if loc:
                resolved += 1
                geo_points.append({
                    "pincode": row["pincode"],
                    "guests":  row["guests"],
                    "visits":  row["visits"],
                    "lat":     loc["lat"],
                    "lon":     loc["lon"],
                    "place":   loc.get("place", ""),
                    "state":   loc.get("state", ""),
                })

        return jsonify(
            success=True,
            age=agg["age"],
            pincodes=agg["pincodes"],
            totals=agg["totals"],
            ocr_enabled=ocr_service.id_ocr_enabled(),
            geo_points=geo_points,
            geo_available=pincode_geo.is_available(),
            geo_resolved=resolved,
            geo_total=len(agg["pincodes"]),
        )
    except Exception as e:
        logger.error(f"customer_analytics error: {e}")
        return jsonify(success=False, message=str(e)), 500


@customers_bp.route("/customer_insights", methods=["GET"])
@requires_permission("customer.manage")
def customer_insights_route():
    """
    Behavioural + financial CRM insights over the whole customers collection —
    headline KPIs, RFM-style segments, a 12-month acquisition trend and the top
    guests by spend / frequency. Powers the Customer Records "Insights" panel.

    Built only from fields every customer doc carries (stays, spend, dates,
    flags, dues, GST), so it needs no ID-OCR. One cached collection scan.

    Query params:
        refresh – "1" to bypass the 5-minute cache and rescan.

    Returns: { success, kpis:{...}, segments:{...}, acquisition_trend:[...],
               top_by_spend:[...], top_by_stays:[...], generated_at }
    """
    try:
        force = request.args.get("refresh", "") in ("1", "true", "yes")
        data = customer_service.get_customer_insights(force=force)
        return jsonify(success=True, **data)
    except Exception as e:
        logger.error(f"customer_insights error: {e}")
        return jsonify(success=False, message=str(e)), 500


@customers_bp.route("/customer_segment", methods=["GET"])
@requires_permission("customer.manage")
def customer_segment_route():
    """
    The guests in one insights cohort, so the Customer Records list can be
    filtered to exactly the segment an admin clicked on in the Insights panel
    (and exported). Served from the membership captured during the last
    insights scan — no extra Firestore reads.

    Query params:
        dimension – loyalty | value | recency | repeat | dues | lapsed |
                    new30 | flag | gst | wants_bill
        key       – 0-based tier/band index for loyalty/value/recency.

    Returns: { success, customers:[...], count }
    """
    try:
        dimension = request.args.get("dimension", "").strip()
        key       = request.args.get("key", "").strip()
        seg = customer_service.get_customer_segment(dimension, key)
        return jsonify(success=True, customers=seg["customers"], count=seg["count"])
    except Exception as e:
        logger.error(f"customer_segment error: {e}")
        return jsonify(success=False, message=str(e), customers=[], count=0), 500
