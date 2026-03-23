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


# ── Scanner config (stored server-side so any WiFi device can scan) ────────────

_SCANNER_CONFIG_DOC = ("settings", "scanner_config")

@utils_bp.route("/scanner/config", methods=["GET"])
def get_scanner_config():
    """Return saved scanner settings (ip, doc_type)."""
    try:
        doc = db.collection(_SCANNER_CONFIG_DOC[0]).document(_SCANNER_CONFIG_DOC[1]).get()
        if doc.exists:
            return jsonify(success=True, config=doc.to_dict())
        return jsonify(success=True, config={"ip": "", "doc_type": "page"})
    except Exception as e:
        logger.error(f"get_scanner_config error: {e}")
        return jsonify(success=False, message=str(e)), 500


@utils_bp.route("/scanner/config", methods=["POST"])
def set_scanner_config():
    """Save scanner IP (and optional doc_type) to Firestore so all devices share it."""
    try:
        data     = request.get_json(silent=True) or {}
        ip       = str(data.get("ip", "")).strip()
        doc_type = str(data.get("doc_type", "page")).strip()

        if not ip:
            return jsonify(success=False, message="IP is required"), 400

        # Warn about link-local IPv6 (fe80::...) — not routable
        if ip.lower().startswith("fe80"):
            return jsonify(
                success=False,
                message=(
                    "That looks like a link-local IPv6 address (fe80::…) which won't work over a network. "
                    "Please use the IPv4 address (e.g. 192.168.1.45) or the mDNS hostname (EPSON4F183E.local)."
                )
            ), 400

        db.collection(_SCANNER_CONFIG_DOC[0]).document(_SCANNER_CONFIG_DOC[1]).set({
            "ip": ip,
            "doc_type": doc_type,
            "updated_at": datetime.now(IST).isoformat(),
        })
        return jsonify(success=True, message=f"Scanner IP saved: {ip}")
    except Exception as e:
        logger.error(f"set_scanner_config error: {e}")
        return jsonify(success=False, message=str(e)), 500


@utils_bp.route("/scan_document", methods=["POST"])
def scan_document():
    """
    Scan a document using an Epson L3250 (or any eSCL/AirScan-compatible scanner)
    over WiFi.

    JSON body:
        scanner_ip  – IP address of the scanner on the local network (e.g. "192.168.1.50")
        doc_type    – "card" (ID/Aadhaar landscape) or "page" (A4 portrait, default)

    Returns JSON: { success, image (data-URI), message }
    """
    try:
        import requests as http_req

        data = request.get_json(silent=True) or {}
        scanner_ip = data.get("scanner_ip", "").strip()
        doc_type   = data.get("doc_type", "page")

        if not scanner_ip:
            return jsonify(success=False, message="Scanner IP not provided"), 400

        # Scan region dimensions in 1/300-inch units
        # ID card (85.6 × 53.98 mm @ 300 dpi ≈ 1012 × 638 units)
        # A4 page (210 × 297 mm @ 300 dpi ≈ 2480 × 3508 units)
        if doc_type == "card":
            scan_w, scan_h = 1012, 638
        else:
            scan_w, scan_h = 2480, 3508

        scan_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03"
                   xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.62</pwg:Version>
  <scan:Intent>Document</scan:Intent>
  <pwg:ScanRegions>
    <pwg:ScanRegion>
      <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>
      <pwg:Width>{scan_w}</pwg:Width>
      <pwg:Height>{scan_h}</pwg:Height>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
  <scan:ColorMode>RGB24</scan:ColorMode>
  <scan:XResolution>300</scan:XResolution>
  <scan:YResolution>300</scan:YResolution>
  <pwg:InputSource>Platen</pwg:InputSource>
</scan:ScanSettings>"""

        base_url = f"http://{scanner_ip}/eSCL"

        # Step 1: Create scan job
        try:
            job_resp = http_req.post(
                f"{base_url}/ScanJobs",
                data=scan_xml.encode("utf-8"),
                headers={"Content-Type": "text/xml"},
                timeout=15,
            )
        except Exception as conn_err:
            return jsonify(
                success=False,
                message=f"Cannot reach scanner at {scanner_ip} — check IP and WiFi connection. ({conn_err})"
            ), 503

        if job_resp.status_code not in (200, 201):
            return jsonify(
                success=False,
                message=f"Scanner rejected job: HTTP {job_resp.status_code}"
            ), 500

        # Step 2: Get job URI from Location header
        job_uri = job_resp.headers.get("Location", "").strip()
        if not job_uri:
            return jsonify(success=False, message="Scanner did not return job location"), 500

        if not job_uri.startswith("http"):
            job_uri = f"http://{scanner_ip}{job_uri}"

        # Step 3: Poll for the scanned image (eSCL returns 503 while scanning)
        doc_url = f"{job_uri}/NextDocument"
        for attempt in range(20):
            try:
                doc_resp = http_req.get(doc_url, timeout=30)
            except Exception as poll_err:
                return jsonify(success=False, message=f"Error retrieving scan: {poll_err}"), 500

            if doc_resp.status_code == 200:
                img_b64  = base64.b64encode(doc_resp.content).decode("utf-8")
                ctype    = doc_resp.headers.get("Content-Type", "image/jpeg")
                return jsonify(
                    success=True,
                    image=f"data:{ctype};base64,{img_b64}",
                    message="Scan complete"
                )
            elif doc_resp.status_code == 503:
                # Scanner still working — wait and retry
                _time.sleep(1.5)
            else:
                return jsonify(
                    success=False,
                    message=f"Scanner error while retrieving image: HTTP {doc_resp.status_code}"
                ), 500

        return jsonify(success=False, message="Scan timed out — place document and try again"), 500

    except Exception as e:
        logger.error(f"scan_document error: {e}")
        return jsonify(success=False, message=f"Unexpected error: {e}"), 500


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
