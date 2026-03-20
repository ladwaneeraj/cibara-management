from flask import Blueprint, request, jsonify
from config import (
    db, metadata_ref, IST, logger
)
from datetime import datetime
import os
import hashlib
import pytz

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
