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
def cleanup_dead_doc_urls():
    """
    Scan all customer records and remove any id_doc_url entries that are
    local file paths (starting with '/uploads/') — these are dead after a
    VM reset and will never resolve.  Firebase Storage URLs
    (https://firebasestorage.googleapis.com/...) are kept untouched.

    Safe to call multiple times (idempotent).
    Returns counts of customers inspected, updated, and URLs removed.
    """
    try:
        customers_ref = db.collection("customers")
        docs = list(customers_ref.stream())

        inspected = 0
        updated = 0
        removed_total = 0

        for doc in docs:
            inspected += 1
            data = doc.to_dict()
            urls = data.get("id_doc_urls", [])
            if not urls:
                continue

            live_urls = [u for u in urls if u.startswith("https://")]
            removed = len(urls) - len(live_urls)

            if removed > 0:
                customers_ref.document(doc.id).update({"id_doc_urls": live_urls})
                updated += 1
                removed_total += removed
                logger.info(
                    f"cleanup_dead_doc_urls: removed {removed} dead URL(s) "
                    f"from customer {doc.id}"
                )

        return jsonify(
            success=True,
            inspected=inspected,
            updated=updated,
            removed=removed_total,
            message=f"Done. Inspected {inspected} customers, "
                    f"cleaned {updated} records, removed {removed_total} dead URLs.",
        )
    except Exception as e:
        logger.error(f"cleanup_dead_doc_urls error: {e}")
        return jsonify(success=False, message=str(e)), 500


# ── Repair broken Firebase Storage download tokens ───────────────────────────

@utils_bp.route("/admin/repair_doc_tokens", methods=["POST"])
def repair_doc_tokens():
    """
    Walk every customer's id_doc_urls, re-patch each Firebase Storage blob
    with a fresh firebaseStorageDownloadTokens metadata value, and update the
    Firestore URL to match the new token.

    Fixes:
      - Blobs uploaded with old code (no token persisted → 403)
      - Blobs uploaded with wrong metadata key (nested dict → invalid token)

    Safe to call multiple times (idempotent — each call just refreshes tokens).
    """
    import uuid as _uuid
    import urllib.parse
    try:
        from firebase_admin import storage as _fb_storage
        storage_bucket = _fb_storage.bucket()
    except Exception as e:
        return jsonify(success=False, message=f"Firebase Storage not available: {e}"), 500

    customers_ref = db.collection("customers")

    inspected   = 0
    blobs_fixed = 0
    errors      = []

    try:
        docs = list(customers_ref.stream())
    except Exception as e:
        return jsonify(success=False, message=f"Firestore read failed: {e}"), 500

    for doc in docs:
        data = doc.to_dict()
        urls = data.get("id_doc_urls", [])
        if not urls:
            continue

        inspected += 1
        new_urls = list(urls)
        changed  = False

        for i, url in enumerate(urls):
            if not url.startswith("https://firebasestorage.googleapis.com"):
                continue  # skip local/dead paths

            try:
                # Parse blob path from URL
                path_encoded = url.split("/o/")[1].split("?")[0]
                blob_path    = urllib.parse.unquote(path_encoded)

                blob = storage_bucket.blob(blob_path)

                # Generate a fresh download token and write it to GCS metadata
                new_token = str(_uuid.uuid4())
                blob.metadata = {"firebaseStorageDownloadTokens": new_token}
                blob.patch()

                # Rebuild the URL with the new token
                new_url = (
                    f"https://firebasestorage.googleapis.com/v0/b/"
                    f"{storage_bucket.name}/o/{path_encoded}"
                    f"?alt=media&token={new_token}"
                )
                new_urls[i] = new_url
                changed      = True
                blobs_fixed += 1
                logger.info(f"repair_doc_tokens: fixed blob {blob_path}")

            except Exception as blob_err:
                msg = f"customer {doc.id} url[{i}]: {blob_err}"
                logger.warning(f"repair_doc_tokens: skipped — {msg}")
                errors.append(msg)

        if changed:
            customers_ref.document(doc.id).update({"id_doc_urls": new_urls})

    return jsonify(
        success=True,
        inspected=inspected,
        blobs_fixed=blobs_fixed,
        errors=errors,
        message=(
            f"Done. Inspected {inspected} customers with docs, "
            f"fixed {blobs_fixed} blob(s)."
            + (f" {len(errors)} error(s) — check server log." if errors else "")
        ),
    )
