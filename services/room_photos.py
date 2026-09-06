"""
Inspection photos for the 200-block rooms.

When a MANAGER approves a room in 200-228 as ready for check-in, the
Quality Check asks for two photos (washroom, room and bed) instead of the
tick-box checklist. Admin and housekeeping keep the checklist. This module
owns everything about those photos:

    • where they live  — Firebase Storage under
                         room_photos/<room>/<YYYYMMDD-HHMMSS>_<kind>.jpg,
                         so a plain name sort is chronological and the
                         capture time is recoverable from the name alone;
    • the policy       — which rooms and which roles must supply them;
    • retention        — photos are evidence for the next stay, not an
                         archive. After every upload the room's folder is
                         pruned to the newest MAX_PER_ROOM files and to
                         RETENTION_DAYS, in a background thread, so storage
                         never grows unattended and nobody has to run a
                         cleanup job.

Photos are served through the same token-based download URLs the customer
document uploads use (services/customer_service._store_image), so no bucket
ACLs are needed.
"""
from __future__ import annotations

import logging
import threading
import urllib.parse
import uuid
from datetime import datetime, timedelta
from typing import Optional

from config import IST

logger = logging.getLogger(__name__)

PHOTO_ROOM_MIN, PHOTO_ROOM_MAX = 200, 228
PHOTO_KINDS = ("washroom", "bed")
PHOTO_ROLES = ("manager",)          # roles for whom photos replace the checklist
RETENTION_DAYS = 7
MAX_PER_ROOM = 6                    # three inspections' worth
MAX_UPLOAD_BYTES = 3 * 1024 * 1024  # client compresses to ~200 KB; this is a guard
_PREFIX = "room_photos"


# ── Policy ────────────────────────────────────────────────────────────────
def is_photo_room(room) -> bool:
    try:
        return PHOTO_ROOM_MIN <= int(str(room).strip()) <= PHOTO_ROOM_MAX
    except (TypeError, ValueError):
        return False


def enabled() -> bool:
    """Admin switch: Settings → "Photo check for rooms 200-228"."""
    try:
        from config import get_ui_config
        return bool(get_ui_config().get("inspection_photos", True))
    except Exception as e:  # noqa: BLE001
        logger.warning(f"room_photos: ui_config read failed, assuming on: {e}")
        return True


def photos_required(user: Optional[dict], room) -> bool:
    """True when this user approving this room must attach both photos."""
    role = str((user or {}).get("role") or "").lower()
    return enabled() and role in PHOTO_ROLES and is_photo_room(room)


def missing_kinds(photos: Optional[dict]) -> list:
    photos = photos if isinstance(photos, dict) else {}
    return [k for k in PHOTO_KINDS if not str(photos.get(k) or "").strip()]


# ── Storage ───────────────────────────────────────────────────────────────
def _bucket():
    from firebase_admin import storage as _fb_storage
    bucket = _fb_storage.bucket()
    if not bucket or "your-project-id" in (bucket.name or ""):
        raise RuntimeError("Firebase Storage is not configured")
    return bucket


def _download_url(bucket_name: str, blob_path: str, token: str) -> str:
    return (
        f"https://firebasestorage.googleapis.com/v0/b/{bucket_name}/o/"
        f"{urllib.parse.quote(blob_path, safe='')}?alt=media&token={token}"
    )


def store(room, kind: str, image_bytes: bytes, user: Optional[dict] = None) -> str:
    """Upload one photo and return its download URL. Raises on failure.

    Who took it is written into the blob's metadata, so the history listing
    can show a name without a second lookup and the photo stays attributable
    even after the room's stay_timeline has been cleared at checkout.
    """
    if kind not in PHOTO_KINDS:
        raise ValueError("Unknown photo kind")
    if not image_bytes:
        raise ValueError("Empty photo")
    if len(image_bytes) > MAX_UPLOAD_BYTES:
        raise ValueError("Photo is too large")

    bucket = _bucket()
    stamp = datetime.now(IST).strftime("%Y%m%d-%H%M%S")
    blob_path = f"{_PREFIX}/{int(room)}/{stamp}_{kind}.jpg"
    token = uuid.uuid4().hex
    blob = bucket.blob(blob_path)
    # Token set before upload so it rides in the single multipart request.
    user = user or {}
    blob.metadata = {
        "firebaseStorageDownloadTokens": token,
        "by": str(user.get("userId") or "system"),
        "byName": str(user.get("name") or user.get("userId") or "system"),
    }
    blob.upload_from_string(image_bytes, content_type="image/jpeg")
    logger.info(f"room_photos: stored {blob_path} ({len(image_bytes) // 1024} KB)")

    # Self-cleaning: never block the response on it.
    threading.Thread(target=prune, args=(room,), daemon=True).start()
    return _download_url(bucket.name, blob_path, token)


def _parse_blob(blob) -> Optional[dict]:
    """room_photos/<room>/<stamp>_<kind>.jpg → {kind, at, url}; None if odd."""
    name = blob.name.rsplit("/", 1)[-1]
    try:
        stamp, kind_ext = name.split("_", 1)
        kind = kind_ext[: -len(".jpg")]
        at = datetime.strptime(stamp, "%Y%m%d-%H%M%S")
    except ValueError:
        return None
    if kind not in PHOTO_KINDS:
        return None
    meta = blob.metadata or {}
    token = meta.get("firebaseStorageDownloadTokens")
    if not token:
        return None
    return {
        "kind": kind,
        "at": at.strftime("%Y-%m-%d %H:%M:%S"),
        "by": meta.get("by") or "",
        "byName": meta.get("byName") or meta.get("by") or "",
        "url": _download_url(blob.bucket.name, blob.name, token),
    }


def list_recent(room) -> list:
    """Newest first. Empty list when Storage is unavailable."""
    try:
        bucket = _bucket()
        blobs = bucket.list_blobs(prefix=f"{_PREFIX}/{int(room)}/")
    except Exception as e:  # noqa: BLE001
        logger.warning(f"room_photos: list failed for room {room}: {e}")
        return []
    items = [p for p in (_parse_blob(b) for b in blobs) if p]
    items.sort(key=lambda p: p["at"], reverse=True)
    return items


def prune(room) -> int:
    """Delete photos beyond MAX_PER_ROOM or older than RETENTION_DAYS.

    Returns the number deleted. Safe to call any time; errors are logged,
    never raised, because this runs in a background thread.

    Scope, deliberately narrow: only objects under room_photos/<room>/ are
    listed (customer documents live under customer_docs/, bills and every
    Firestore record are untouched), and within that folder only files
    whose name parses as <stamp>_<kind>.jpg are ever deleted. Anything
    else found there is left alone and logged.
    """
    deleted = 0
    try:
        bucket = _bucket()
        blobs = list(bucket.list_blobs(prefix=f"{_PREFIX}/{int(room)}/"))
        cutoff = datetime.now(IST).replace(tzinfo=None) - timedelta(days=RETENTION_DAYS)
        photos = []
        for blob in blobs:
            parsed = _parse_blob(blob)
            if parsed is None:
                logger.warning(f"room_photos: leaving unrecognised object {blob.name}")
                continue
            photos.append((blob, datetime.strptime(parsed["at"], "%Y-%m-%d %H:%M:%S")))
        photos.sort(key=lambda p: p[1], reverse=True)       # newest first
        for idx, (blob, taken_at) in enumerate(photos):
            if idx >= MAX_PER_ROOM or taken_at < cutoff:
                blob.delete()
                deleted += 1
        if deleted:
            logger.info(f"room_photos: pruned {deleted} photo(s) for room {room}")
    except Exception as e:  # noqa: BLE001
        logger.warning(f"room_photos: prune failed for room {room}: {e}")
    return deleted
