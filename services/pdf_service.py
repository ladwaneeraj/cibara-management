"""
PDF Service — manages bill PDF storage in Firebase Storage.

Storage path:  bills/{safe_invoice_no}/v{n}.pdf
Firestore:     bills/{bill_id}.pdf_url  (latest URL)
               bills/{bill_id}.versions (audit trail array)

Design mirrors customer_service._store_image() exactly:
  • Token-based download URLs — works with uniform bucket-level access.
  • Never overwrites an existing version (always increments).
  • Writes are synchronous (caller decides threading).
  • All exceptions caught and logged; returns "" on failure.
"""

import logging
import urllib.parse
import uuid as _uuid
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_bills_ref = None
_db = None


def init(db):
    """Call once at app startup to inject the Firestore client."""
    global _bills_ref, _db
    _db = db
    _bills_ref = db.collection("bills")
    logger.info("PdfService initialised (bills collection)")


# ---------------------------------------------------------------------------
# PUBLIC API
# ---------------------------------------------------------------------------

def upload_bill_pdf(bill_id: str, invoice_no: str, pdf_bytes: bytes) -> dict:
    """
    Upload a PDF to Firebase Storage and save the URL in the bill document.

    Storage path:  bills/{safe_invoice_no}/v{next_version}.pdf
    Returns:       { "url": str, "version": int } on success
                   { "url": "", "version": 0 }    on failure

    Versioning:
        Reads the existing `versions` array from Firestore to determine the
        next version number.  Never overwrites an existing PDF.
    """
    if _bills_ref is None or not bill_id:
        return {"url": "", "version": 0}

    try:
        bill_ref = _bills_ref.document(bill_id)
        bill_snap = bill_ref.get()
        if not bill_snap.exists:
            logger.error(f"PdfService: bill {bill_id} not found in Firestore")
            return {"url": "", "version": 0}

        existing_versions = bill_snap.to_dict().get("versions", []) or []
        next_version = len(existing_versions) + 1

        # Sanitise invoice_no for use in a Storage path
        # e.g. "INV/2026/03/00045" → "INV_2026_03_00045"
        safe_no = (invoice_no or bill_id).replace("/", "_").replace(" ", "_")
        filename = f"v{next_version}.pdf"
        blob_path = f"bills/{safe_no}/{filename}"

        url = _store_pdf(blob_path, pdf_bytes)
        if not url:
            return {"url": "", "version": 0}

        # Update Firestore atomically
        now_iso = datetime.now(timezone.utc).isoformat()
        version_entry = {
            "version": next_version,
            "url": url,
            "uploaded_at": now_iso,
        }

        from firebase_admin import firestore as _fs
        bill_ref.update({
            "pdf_url": url,
            "versions": _fs.ArrayUnion([version_entry]),
            "pdf_updated_at": now_iso,
        })

        logger.info(
            f"PdfService: uploaded {blob_path} for bill {bill_id} "
            f"(version {next_version})"
        )
        return {"url": url, "version": next_version}

    except Exception as e:
        logger.error(
            f"PdfService: upload_bill_pdf failed for bill {bill_id}: "
            f"{type(e).__name__}: {e}",
            exc_info=True,
        )
        return {"url": "", "version": 0}


# ---------------------------------------------------------------------------
# INTERNAL HELPERS
# ---------------------------------------------------------------------------

def _store_pdf(blob_path: str, pdf_bytes: bytes) -> str:
    """
    Upload PDF bytes to Firebase Storage.
    Returns a token-based download URL, or "" on failure.

    Mirrors customer_service._store_image() — same URL format, same token
    approach so the link works even with uniform bucket-level access enabled.
    """
    try:
        from firebase_admin import storage as _fb_storage

        bucket = _fb_storage.bucket()
        if not bucket or "your-project-id" in (bucket.name or ""):
            logger.error("PdfService: Firebase Storage not configured")
            return ""

        blob = bucket.blob(blob_path)

        # Set download token BEFORE upload (single multipart request)
        download_token = str(_uuid.uuid4())
        blob.metadata = {"firebaseStorageDownloadTokens": download_token}

        blob.upload_from_string(pdf_bytes, content_type="application/pdf")

        encoded_path = urllib.parse.quote(blob_path, safe="")
        url = (
            f"https://firebasestorage.googleapis.com/v0/b/"
            f"{bucket.name}/o/{encoded_path}"
            f"?alt=media&token={download_token}"
        )
        logger.info(f"PdfService: Storage upload OK → {blob_path}")
        return url

    except Exception as e:
        logger.error(
            f"PdfService: Storage upload FAILED for {blob_path} — "
            f"{type(e).__name__}: {e}",
            exc_info=True,
        )
        return ""
