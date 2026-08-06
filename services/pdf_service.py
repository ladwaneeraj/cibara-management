"""
PDF Service — manages bill PDF storage in Firebase Storage.

Storage path:  bills/{safe_invoice_no}.pdf              (the ONE live invoice)
               bills/{safe_invoice_no}/history/v{n}.pdf (superseded copies)
               (placeholder numbers like "-" fall back to
                bills/unnumbered/{date}_Rm{room}_{shortid}.pdf — see
                _safe_folder; a shared folder rotates tokens and 403s old URLs)
Firestore:     bills/{bill_id}.pdf_url  (the live URL — stable across rewrites)
               bills/{bill_id}.versions (audit trail array)

Design mirrors customer_service._store_image() exactly:
  • Token-based download URLs — works with uniform bucket-level access.
  • Overwrites the live object in place, REUSING its download token so links
    already shared with guests keep working; the old bytes are archived to
    history/ first, so nothing is lost.
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

def _is_placeholder(value) -> bool:
    """True when a bill number is missing or a placeholder like "-" / "N/A".

    Placeholder numbers ("-") are minted for no-bill cash stays, pure MMT OTA
    stays, and deferred-number checkouts. They MUST NOT be used as a Storage
    folder: every such bill would share bills/-/v1.pdf, and each upload
    overwrites the object and rotates the download token — 403ing every
    previously saved URL.
    """
    if not value:
        return True
    return not any(c.isalnum() for c in str(value))


def _sanitise(value) -> str:
    """Strip a value down to Storage-safe characters. May return ""."""
    safe = str(value).replace("/", "_").replace(" ", "_")
    return "".join(c for c in safe if c.isalnum() or c in "._-")


def _unnumbered_folder(bill_id: str, bill_doc: dict) -> str:
    """
    Readable folder for bills that never got a sequential number.

    Placeholder bill numbers ("-") are minted for no-bill cash stays, pure MMT
    OTA stays and deferred-number checkouts, so those bills have nothing to file
    under. Falling back to the raw Firestore doc id gave folders like
    bills/0427d61f29da4d378c5f14a278a7e167/, which are impossible to scan by eye
    in the Storage console.

    Shape: unnumbered/{YYYY-MM-DD}_Rm{room}_{first 8 of bill_id}
    Nesting them under a single "unnumbered" prefix keeps them out of the way of
    the CC_YYYY_MM_XXXXX folders, and the date prefix sorts chronologically.
    The bill_id suffix is what actually guarantees uniqueness — date and room
    alone collide across same-day stays in the same room.
    """
    doc = bill_doc or {}
    date = _sanitise((doc.get("checkout_time") or "")[:10]) or "no-date"
    room = _sanitise(doc.get("current_room") or doc.get("room") or "")
    short = _sanitise(bill_id)[:8] or "unknown"
    parts = [date] + ([f"Rm{room}"] if room else []) + [short]
    return "unnumbered/" + "_".join(parts)


def _safe_folder(invoice_no: str, doc_bill_number: str, bill_id: str,
                 bill_doc: dict = None) -> str:
    """
    Resolve a unique, Storage-safe folder name for a bill's PDFs.

    Priority: caller-supplied invoice_no → bill_number on the Firestore doc
    (may have been stamped after the caller captured its stale copy) → a
    readable unnumbered/... path derived from the bill. Placeholders are
    rejected at each step.

    Note this only affects NEW uploads. Existing bill_id-named folders are left
    alone on purpose: renaming a Storage object rotates its download token,
    which would 403 every invoice link already sent to a guest.
    """
    for candidate in (invoice_no, doc_bill_number):
        if not _is_placeholder(candidate):
            safe = _sanitise(candidate)
            if not _is_placeholder(safe):
                return safe
    return _unnumbered_folder(bill_id, bill_doc)


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

        bill_doc = bill_snap.to_dict() or {}
        existing_versions = bill_doc.get("versions", []) or []
        next_version = len(existing_versions) + 1

        # Resolve a unique Storage name. Placeholder numbers ("-") fall back
        # to the doc's bill_number, then to a readable unnumbered/... path —
        # never a shared path. e.g. "CC/2026/08/00045" → "CC_2026_08_00045"
        safe_no = _safe_folder(invoice_no, bill_doc.get("bill_number") or "",
                               bill_id, bill_doc)

        # ONE live file per bill, named by the bill number:
        #     bills/CC_2026_08_00045.pdf
        # Regenerating overwrites it in place and REUSES the existing download
        # token (see _store_pdf), so the link already sent to a guest on
        # WhatsApp keeps working. That token reuse is what makes overwriting
        # safe — a fresh token would 403 every previously shared URL, which is
        # the reason this used to write v1/v2/v3 side by side instead.
        #
        # The previous bytes are archived first, so the audit trail survives:
        #     bills/CC_2026_08_00045/history/v{n}.pdf
        # History copies get their own tokens and are never shared.
        #
        # safe_no may contain a "/" for unnumbered bills — flatten it for the
        # Content-Disposition filename, which cannot carry a path separator.
        download_no = safe_no.replace("/", "_")
        blob_path = f"bills/{safe_no}.pdf"

        if next_version > 1:
            _archive_previous(blob_path,
                              f"bills/{safe_no}/history/v{next_version - 1}.pdf")

        url = _store_pdf(blob_path, pdf_bytes,
                         download_name=f"Invoice_{download_no}.pdf",
                         reuse_token=True)
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


def upload_filing_attachment(period: str, filename: str, data: bytes,
                             content_type: str = "application/octet-stream") -> str:
    """
    Upload a GST filing-report file (GSTR-1/3B summary, ARN receipt, etc.) to
    Firebase Storage under gst_filings/{period}/. Returns a token download URL,
    or "" on failure. Does NOT touch Firestore — the caller records the URL on
    the gst_month_locks doc via gst_lock_service.add_attachment().
    """
    try:
        safe_period = (period or "unknown").replace("/", "_").replace(" ", "_")
        safe_name = "".join(
            c for c in (filename or "file") if c.isalnum() or c in "._-"
        ) or "file"
        blob_path = f"gst_filings/{safe_period}/{_uuid.uuid4().hex}_{safe_name}"
        return _store_bytes(blob_path, data, content_type or "application/octet-stream")
    except Exception as e:
        logger.error(
            f"PdfService: upload_filing_attachment failed for {period}: "
            f"{type(e).__name__}: {e}",
            exc_info=True,
        )
        return ""


# ---------------------------------------------------------------------------
# INTERNAL HELPERS
# ---------------------------------------------------------------------------

def _archive_previous(live_path: str, history_path: str) -> bool:
    """
    Copy the current live PDF to its history slot before it gets overwritten.

    Best-effort by design: a bill with no existing object (first upload, or a
    bill migrated from the old v{n}.pdf layout) simply has nothing to archive,
    and a copy failure must never block the new invoice from being written.
    Returns True only when bytes were actually copied.
    """
    try:
        from firebase_admin import storage as _fb_storage

        bucket = _fb_storage.bucket()
        if not bucket:
            return False
        src = bucket.blob(live_path)
        if not src.exists():
            return False
        bucket.copy_blob(src, bucket, history_path)
        logger.info(f"PdfService: archived {live_path} -> {history_path}")
        return True
    except Exception as e:
        logger.warning(
            f"PdfService: could not archive {live_path} -> {history_path}: "
            f"{type(e).__name__}: {e}"
        )
        return False


def _store_pdf(blob_path: str, pdf_bytes: bytes, download_name: str = "",
               reuse_token: bool = False) -> str:
    """
    Upload PDF bytes to Firebase Storage.
    Returns a token-based download URL, or "" on failure.

    Mirrors customer_service._store_image() — same URL format, same token
    approach so the link works even with uniform bucket-level access enabled.

    download_name: when set, stored as `inline; filename="..."` so the PDF
    previews in the browser but downloads with a proper invoice filename
    instead of "v1.pdf".

    reuse_token: when True and an object already exists at blob_path, keep its
    existing firebaseStorageDownloadTokens value instead of minting a new one.
    This is what lets a bill's invoice be overwritten in place without
    invalidating the download URL already shared with the guest. Minting a new
    token on overwrite rotates the URL and 403s every link sent earlier.
    """
    try:
        from firebase_admin import storage as _fb_storage

        bucket = _fb_storage.bucket()
        if not bucket or "your-project-id" in (bucket.name or ""):
            logger.error("PdfService: Firebase Storage not configured")
            return ""

        blob = bucket.blob(blob_path)

        # Set download token BEFORE upload (single multipart request).
        # On overwrite, carry the existing token forward so shared links live.
        download_token = ""
        if reuse_token:
            try:
                blob.reload()
                download_token = ((blob.metadata or {})
                                  .get("firebaseStorageDownloadTokens") or "")
                # The field may hold a comma-separated list — the first is live.
                download_token = download_token.split(",")[0].strip()
            except Exception:
                download_token = ""      # no existing object, or unreadable
        if not download_token:
            download_token = str(_uuid.uuid4())
        blob.metadata = {"firebaseStorageDownloadTokens": download_token}
        if download_name:
            blob.content_disposition = f'inline; filename="{download_name}"'

        blob.upload_from_string(pdf_bytes, content_type="application/pdf")

        encoded_path = urllib.parse.quote(blob_path, safe="")
        url = (
            f"https://firebasestorage.googleapis.com/v0/b/"
            f"{bucket.name}/o/{encoded_path}"
            f"?alt=media&token={download_token}"
        )
        # ASCII arrow: Windows cp1252 log handlers can't encode U+2192
        logger.info(f"PdfService: Storage upload OK -> {blob_path}")
        return url

    except Exception as e:
        logger.error(
            f"PdfService: Storage upload FAILED for {blob_path} — "
            f"{type(e).__name__}: {e}",
            exc_info=True,
        )
        return ""


def _store_bytes(blob_path: str, data: bytes, content_type: str) -> str:
    """
    Generic Storage upload (any content type). Mirrors _store_pdf() but lets the
    caller set the MIME type — used for GST filing-report attachments which may
    be PDF or image. Returns a token download URL, or "" on failure.
    """
    try:
        from firebase_admin import storage as _fb_storage

        bucket = _fb_storage.bucket()
        if not bucket or "your-project-id" in (bucket.name or ""):
            logger.error("PdfService: Firebase Storage not configured")
            return ""

        blob = bucket.blob(blob_path)
        download_token = str(_uuid.uuid4())
        blob.metadata = {"firebaseStorageDownloadTokens": download_token}
        blob.upload_from_string(data, content_type=content_type or "application/octet-stream")

        encoded_path = urllib.parse.quote(blob_path, safe="")
        url = (
            f"https://firebasestorage.googleapis.com/v0/b/"
            f"{bucket.name}/o/{encoded_path}"
            f"?alt=media&token={download_token}"
        )
        logger.info(f"PdfService: Storage upload OK -> {blob_path}")
        return url
    except Exception as e:
        logger.error(
            f"PdfService: _store_bytes FAILED for {blob_path} — "
            f"{type(e).__name__}: {e}",
            exc_info=True,
        )
        return ""
