from flask import Blueprint, request, jsonify
from config import (
    db, metadata_ref, IST, logger
)
from datetime import datetime
import os
import hashlib
import pytz
import base64
import time as _time

from services.auth_service import requires_permission

utils_bp = Blueprint('utils', __name__)

UPLOAD_FOLDER = "/tmp/cibara_uploads"
if not os.path.exists(UPLOAD_FOLDER):
    os.makedirs(UPLOAD_FOLDER)

@utils_bp.route("/upload_photo", methods=["POST"])
def upload_photo():
    try:
        if "photo" not in request.files:
            return jsonify({"error": "No photo file provided"}), 400
        
        file = request.files["photo"]
        room_id = request.form.get("room_id")
        photo_type = request.form.get("photo_type", "general")
        
        if not file or not room_id:
            return jsonify({"error": "Missing file or room_id"}), 400
        
        filename = f"{room_id}_{photo_type}_{datetime.now(IST).timestamp()}.jpg"
        file_path = os.path.join(UPLOAD_FOLDER, filename)
        
        file.save(file_path)
        
        file_hash = hashlib.md5()
        with open(file_path, 'rb') as f:
            file_hash.update(f.read())
        
        photo_data = {
            "room_id": room_id,
            "photo_type": photo_type,
            "filename": filename,
            "file_path": file_path,
            "file_hash": file_hash.hexdigest(),
            "uploaded_at": datetime.now(IST),
            "file_size": os.path.getsize(file_path)
        }
        
        photos_ref = metadata_ref.collection("room_photos")
        doc_ref = photos_ref.add(photo_data)
        
        return jsonify({
            "success": True,
            "message": "Photo uploaded successfully",
            "photo_id": doc_ref[1].id,
            "photo_data": photo_data
        }), 201
    except Exception as e:
        logger.error(f"Error in upload_photo: {str(e)}")
        return jsonify({"error": str(e)}), 500


# ── One-time cleanup: strip dead local-path URLs from customer id_doc_urls ──

@utils_bp.route("/admin/cleanup_dead_doc_urls", methods=["POST"])
@requires_permission("customer.manage")
def cleanup_dead_doc_urls():
    """
    Remove id_doc_urls entries that are local file paths ('/uploads/…') —
    dead after a VM reset. Firebase Storage entries are never touched.

    Admin only (it used to be open to any signed-in user). Uses ArrayRemove
    of just the dead entries: the old version wrote the whole list back,
    which could drop a document uploaded at the same moment.
    """
    try:
        from firebase_admin import firestore as _fs
        customers_ref = db.collection("customers")
        inspected = updated = removed_total = 0
        for doc in customers_ref.stream():
            inspected += 1
            urls = (doc.to_dict() or {}).get("id_doc_urls", []) or []
            dead = [u for u in urls if isinstance(u, str) and u.startswith("/uploads/")]
            if dead:
                customers_ref.document(doc.id).update({"id_doc_urls": _fs.ArrayRemove(dead)})
                updated += 1
                removed_total += len(dead)
                logger.info(f"cleanup_dead_doc_urls: removed {len(dead)} dead URL(s) from {doc.id}")
        return jsonify(
            success=True, inspected=inspected, updated=updated, removed=removed_total,
            message=f"Done. Inspected {inspected} customers, "
                    f"cleaned {updated} records, removed {removed_total} dead URLs.",
        )
    except Exception as e:
        logger.error(f"cleanup_dead_doc_urls error: {e}")
        return jsonify(success=False, message=str(e)), 500


@utils_bp.route("/admin/repair_doc_tokens", methods=["POST"])
@requires_permission("customer.manage")
def repair_doc_tokens():
    """Retired. It minted fresh PUBLIC download tokens for every ID photo and
    rewrote every customer's document list. ID documents are private now and
    served through /api/v2/customers/<mobile>/id-docs (services/id_docs.py);
    old photos are adopted automatically or by scripts/migrate_id_docs.py."""
    return jsonify(success=False,
                   message="Retired: ID documents are private now. "
                           "Use scripts/migrate_id_docs.py for old photos."), 410
