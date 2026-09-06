"""
Cleaning and inspection photos for the 200-block rooms.

Three moments in a room's cleaning life can require photos instead of (or
on top of) a tick-box checklist, each behind its own Settings switch:

    context "inspection"  manager approves a cleaned room as ready
                          (ui_config.inspection_photos, default on)
    context "cleaning"    housekeeping marks a room as cleaned
                          (ui_config.cleaning_photos, default off)
    context "service"     a mid-stay service clean (room and/or bathroom,
                          requested by the guest) is marked done; needs only
                          the photo(s) matching what was requested. Uses the
                          switch of whoever is marking it done: a manager
                          follows inspection_photos, housekeeping follows
                          cleaning_photos.

Admin is never asked for photos. Rooms outside 200-228 are never asked.

This module owns everything about those photos:

    • where they live  — Firebase Storage under
                         room_photos/<room>/<YYYYMMDD-HHMMSS>_<context>_<kind>.jpg
                         with a 320px companion  ..._<kind>_t.jpg  for
                         thumbnails, so listings and the room-details view
                         never load the full image just to show a preview;
    • the policy       — which rooms, which roles, which switch;
    • retention        — photos are evidence for a stay, not an archive.
                         After every upload the room's folder is pruned in a
                         background thread. A photo is PROTECTED (never
                         deleted) while the room document still references
                         it (the stay it prepared is in progress, or the room
                         is prepared and waiting) and, for GRACE_DAYS after
                         checkout, while the ended stay's bill references it.
                         Unprotected photos are kept
                         for RETENTION_DAYS and capped at MAX_PER_ROOM.

Only objects under room_photos/<room>/ are ever listed, and only files whose
name parses as one of ours are ever deleted. Customer documents
(customer_docs/) and every Firestore record are untouched.
"""
from __future__ import annotations

import logging
import threading
import urllib.parse
import uuid
from datetime import datetime, timedelta
from typing import Iterable, Optional

from config import IST

logger = logging.getLogger(__name__)

PHOTO_ROOM_MIN, PHOTO_ROOM_MAX = 200, 228
PREMIUM_MIN, PREMIUM_MAX = 200, 206   # premium rooms also photograph the coffee maker
PHOTO_KINDS = ("washroom", "coffee", "bed")   # display / capture order
CONTEXTS = ("inspection", "cleaning", "service")
SWITCH_FOR_ROLE = {"manager": "inspection_photos", "housekeeping": "cleaning_photos"}
RETENTION_DAYS = 7
GRACE_DAYS = 3                      # after checkout, for the stay's evidence
MAX_PER_ROOM = 10                   # unprotected full-size photos per room
MAX_UPLOAD_BYTES = 3 * 1024 * 1024  # client compresses to ~200 KB; this is a guard
_PREFIX = "room_photos"
_THUMB_SUFFIX = "_t"


# ── Policy ────────────────────────────────────────────────────────────────
def is_photo_room(room) -> bool:
    try:
        return PHOTO_ROOM_MIN <= int(str(room).strip()) <= PHOTO_ROOM_MAX
    except (TypeError, ValueError):
        return False


def _switch_on(name: str) -> bool:
    try:
        from config import get_ui_config
        return bool(get_ui_config().get(name, name == "inspection_photos"))
    except Exception as e:  # noqa: BLE001
        logger.warning(f"room_photos: ui_config read failed ({name}), assuming default: {e}")
        return name == "inspection_photos"


def photos_required(user: Optional[dict], room, context: str) -> bool:
    """True when this user, at this step, on this room, must attach photos."""
    if context not in CONTEXTS or not is_photo_room(room):
        return False
    role = str((user or {}).get("role") or "").lower()
    switch = SWITCH_FOR_ROLE.get(role)
    if not switch:
        return False                       # admin and anything else: never
    if context == "inspection" and role != "manager":
        return False
    if context == "cleaning" and role != "housekeeping":
        return False
    return _switch_on(switch)


def is_premium_room(room) -> bool:
    try:
        return PREMIUM_MIN <= int(str(room).strip()) <= PREMIUM_MAX
    except (TypeError, ValueError):
        return False


def required_kinds(context: str, service_type: Optional[str] = None, room=None) -> tuple:
    """Which photos a step needs.

    Full checks: washroom + bed, plus coffee maker for premium rooms
    (200-206). Service cleans need only what was asked for.
    """
    if context == "service":
        return ("bed",) if service_type == "room" else ("washroom",)
    return PHOTO_KINDS if is_premium_room(room) else tuple(k for k in PHOTO_KINDS if k != "coffee")


def missing_kinds(photos: Optional[dict], kinds: Iterable[str] = PHOTO_KINDS) -> list:
    photos = photos if isinstance(photos, dict) else {}
    return [k for k in kinds if not str(photos.get(k) or "").strip()]


def clean_photo_map(raw) -> dict:
    """Keep only our keys (kind and kind_thumb) with non-empty string values."""
    if not isinstance(raw, dict):
        return {}
    out = {}
    for k in PHOTO_KINDS:
        for key in (k, f"{k}_thumb"):
            v = str(raw.get(key) or "").strip()
            if v:
                out[key] = v
    return out


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


def _put(bucket, blob_path: str, data: bytes, meta: dict) -> str:
    token = uuid.uuid4().hex
    blob = bucket.blob(blob_path)
    # Token set before upload so it rides in the single multipart request.
    blob.metadata = dict(meta, firebaseStorageDownloadTokens=token)
    blob.upload_from_string(data, content_type="image/jpeg")
    return _download_url(bucket.name, blob_path, token)


def store(room, kind: str, image_bytes: bytes, user: Optional[dict] = None,
          context: str = "inspection", thumb_bytes: Optional[bytes] = None) -> dict:
    """Upload one photo (and its thumbnail). Returns {url, thumb}. Raises on failure.

    Who took it is written into the blob's metadata, so the history listing
    can show a name without a second lookup and the photo stays attributable
    even after the room's stay_timeline has been cleared at checkout.
    """
    if kind not in PHOTO_KINDS:
        raise ValueError("Unknown photo kind")
    if context not in CONTEXTS:
        raise ValueError("Unknown photo context")
    if not image_bytes:
        raise ValueError("Empty photo")
    if len(image_bytes) > MAX_UPLOAD_BYTES or (thumb_bytes and len(thumb_bytes) > MAX_UPLOAD_BYTES):
        raise ValueError("Photo is too large")

    bucket = _bucket()
    user = user or {}
    meta = {
        "by": str(user.get("userId") or "system"),
        "byName": str(user.get("name") or user.get("userId") or "system"),
        "context": context,
    }
    stamp = datetime.now(IST).strftime("%Y%m%d-%H%M%S")
    base = f"{_PREFIX}/{int(room)}/{stamp}_{context}_{kind}"
    url = _put(bucket, base + ".jpg", image_bytes, meta)
    thumb = _put(bucket, base + _THUMB_SUFFIX + ".jpg", thumb_bytes, meta) if thumb_bytes else ""
    logger.info(f"room_photos: stored {base}.jpg ({len(image_bytes) // 1024} KB"
                f"{', thumb ' + str(len(thumb_bytes) // 1024) + ' KB' if thumb_bytes else ''})")

    # Self-cleaning: never block the response on it.
    threading.Thread(target=prune, args=(room,), daemon=True).start()
    return {"url": url, "thumb": thumb}


def _parse_name(name: str) -> Optional[dict]:
    """<stamp>_<context>_<kind>[_t].jpg (or legacy <stamp>_<kind>.jpg)."""
    if not name.endswith(".jpg"):
        return None
    stem = name[:-4]
    is_thumb = stem.endswith(_THUMB_SUFFIX)
    if is_thumb:
        stem = stem[:-len(_THUMB_SUFFIX)]
    parts = stem.split("_")
    if len(parts) == 2:
        stamp, context, kind = parts[0], "inspection", parts[1]
    elif len(parts) == 3:
        stamp, context, kind = parts
    else:
        return None
    try:
        at = datetime.strptime(stamp, "%Y%m%d-%H%M%S")
    except ValueError:
        return None
    if kind not in PHOTO_KINDS or context not in CONTEXTS:
        return None
    return {"stamp": stamp, "context": context, "kind": kind, "thumb": is_thumb, "at": at}


def _parse_blob(blob) -> Optional[dict]:
    parsed = _parse_name(blob.name.rsplit("/", 1)[-1])
    if not parsed:
        return None
    meta = blob.metadata or {}
    token = meta.get("firebaseStorageDownloadTokens")
    if not token:
        return None
    parsed["url"] = _download_url(blob.bucket.name, blob.name, token)
    parsed["by"] = meta.get("by") or ""
    parsed["byName"] = meta.get("byName") or meta.get("by") or ""
    parsed["blob"] = blob
    return parsed


def _listing(bucket, room) -> list:
    return [p for p in (_parse_blob(b) for b in bucket.list_blobs(prefix=f"{_PREFIX}/{int(room)}/")) if p]


def list_recent(room) -> list:
    """Full-size photos, newest first, each with its thumb URL when present."""
    try:
        items = _listing(_bucket(), room)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"room_photos: list failed for room {room}: {e}")
        return []
    thumbs = {(p["stamp"], p["context"], p["kind"]): p["url"] for p in items if p["thumb"]}
    out = []
    for p in items:
        if p["thumb"]:
            continue
        out.append({
            "kind": p["kind"],
            "context": p["context"],
            "at": p["at"].strftime("%Y-%m-%d %H:%M:%S"),
            "by": p["by"],
            "byName": p["byName"],
            "url": p["url"],
            "thumb": thumbs.get((p["stamp"], p["context"], p["kind"]), ""),
        })
    out.sort(key=lambda p: p["at"], reverse=True)
    return out


# ── Retention ─────────────────────────────────────────────────────────────
def _referenced_urls(room_doc: dict) -> set:
    """Every photo URL the room document still points at."""
    urls = set()

    def take(m):
        if isinstance(m, dict):
            for k, v in m.items():
                if isinstance(v, str) and v.startswith("https://") and (k in PHOTO_KINDS or k.endswith("_thumb")):
                    urls.add(v)

    for key in ("last_inspection_photos", "last_cleaning_photos"):
        take(room_doc.get(key))
    for ev in room_doc.get("stay_timeline") or []:
        if isinstance(ev, dict):
            take(ev.get("photos"))
    return urls


def _protection(room) -> set:
    """URLs that must not be deleted for this room right now.

    Two sources: the room document (the stay in progress, or a prepared room
    waiting for its guest) and, for GRACE_DAYS after the last checkout, the
    bill of the stay that just ended (its stay_timeline was copied there at
    checkout, photo URLs included). Everything else is fair game once old.
    """
    try:
        from config import rooms_ref, bills_ref
        snap = rooms_ref.document(str(int(room))).get()
        doc = snap.to_dict() if snap.exists else {}
    except Exception as e:  # noqa: BLE001
        logger.warning(f"room_photos: room read failed for {room}, protecting nothing extra: {e}")
        return set()
    urls = _referenced_urls(doc)

    raw = str(doc.get("last_checkout_at") or "").strip()[:19]
    checkout = None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S"):
        try:
            checkout = datetime.strptime(raw, fmt)
            break
        except ValueError:
            continue
    now = datetime.now(IST).replace(tzinfo=None)
    bill_id = doc.get("last_bill_id")
    if bill_id and checkout and now < checkout + timedelta(days=GRACE_DAYS):
        try:
            bill = bills_ref.document(str(bill_id)).get()
            urls |= _referenced_urls(bill.to_dict() if bill.exists else {})
        except Exception as e:  # noqa: BLE001
            logger.warning(f"room_photos: bill read failed for {bill_id}: {e}")
    return urls


def prune(room) -> int:
    """Delete photos that are no longer evidence for any stay.

    Returns the number of objects deleted (thumbnails included). Safe to call
    any time; errors are logged, never raised, because this runs in a
    background thread.
    """
    deleted = 0
    try:
        bucket = _bucket()
        items = _listing(bucket, room)
        keep_urls = _protection(room)
        now = datetime.now(IST).replace(tzinfo=None)
        cutoff = now - timedelta(days=RETENTION_DAYS)

        # Decide per photo (thumbs follow their full-size twin).
        fulls = sorted((p for p in items if not p["thumb"]), key=lambda p: p["at"], reverse=True)
        doomed = set()
        unprotected_seen = 0
        for p in fulls:
            if p["url"] in keep_urls:
                continue
            unprotected_seen += 1
            if p["at"] < cutoff or unprotected_seen > MAX_PER_ROOM:
                doomed.add((p["stamp"], p["context"], p["kind"]))

        for p in items:
            if (p["stamp"], p["context"], p["kind"]) in doomed:
                p["blob"].delete()
                deleted += 1
        if deleted:
            logger.info(f"room_photos: pruned {deleted} object(s) for room {room}")
    except Exception as e:  # noqa: BLE001
        logger.warning(f"room_photos: prune failed for room {room}: {e}")
    return deleted
