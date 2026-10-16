"""
Guest ID documents (Aadhaar) — private storage with a per-document record.

Why this module exists
----------------------
ID photos used to be stored with a Firebase download token and the token URL
was written into `customers/{mobile}.id_doc_urls`. Anyone holding such a link
could open the guest's Aadhaar without signing in, forever. Several code paths
also rewrote that array wholesale, so a document could silently disappear.

Model
-----
* File:   Storage `customer_docs/{mobile}/{doc_id}.jpg` — uploaded WITHOUT a
          download token, so it is reachable only through the service account
          (i.e. through our API, which checks the permission and audits).
* Record: `customers/{mobile}/id_docs/{doc_id}` — one Firestore document per
          image. Nothing ever rewrites a list of documents, so concurrent
          uploads, check-ins and removals cannot drop each other's work.

    side         front | back | other | unknown (legacy)
    status       active | archived (superseded by a newer scan of the same
                 side) | removed (soft delete; file kept, admin can restore)
    source       auto_scan | manual | upload | legacy
    captured_by  {userId, name, role}      captured_at  IST ISO time
    context      {kind: checkin|checkout|customer_manager|viewer, room}
    history      append-only [{action, by, at, note}]
    views, last_viewed_by, last_viewed_at

* Customer:  `id_doc_count` (active documents) and `has_id_docs` are kept on
             the customer document for the register / check-in indicators.
             Only those two fields are written there (merge), never the list.

Legacy documents
----------------
Existing `id_doc_urls` entries are *adopted* the first time a guest's
documents are listed: a record `legacy-<hash>` is created pointing at the same
Storage object. The old array and the files are left exactly as they were —
nothing is deleted. `scripts/migrate_id_docs.py` adopts everything in one pass
and, as a separate explicit step, switches off the old public tokens.

No money, tax or bill logic lives here.
"""
from __future__ import annotations

import hashlib
import io
import logging
import os
import urllib.parse
import uuid
from datetime import datetime, timezone, timedelta
from typing import Any

logger = logging.getLogger("cibara.id_docs")

IST = timezone(timedelta(hours=5, minutes=30))

SUBCOLLECTION = "id_docs"
STORAGE_PREFIX = "customer_docs/"
SIDES = ("front", "back", "other")
SOURCES = ("auto_scan", "manual", "upload")
CONTEXTS = ("checkin", "checkout", "customer_manager", "viewer", "register")

MAX_UPLOAD_BYTES = 12 * 1024 * 1024      # raw upload limit
MAX_PIXELS = 40_000_000                  # decompression-bomb guard
MAX_EDGE = 2400                          # stored long edge (readable at 100 %)
JPEG_QUALITY = 90
THUMB_EDGE = 360
MAX_ACTIVE_OTHER = 6                     # "other" pages kept active at once
MAX_HISTORY = 60                         # history entries kept per document


class IdDocError(Exception):
    """User-facing failure (bad image, unknown document…). `status` is HTTP."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ─── small helpers ────────────────────────────────────────────────────────

def _db():
    from config import db
    return db


def _bucket():
    from firebase_admin import storage
    return storage.bucket()


def _fs():
    from firebase_admin import firestore
    return firestore


def now_iso() -> str:
    return datetime.now(IST).isoformat(timespec="seconds")


def clean_mobile(raw: Any) -> str:
    from services.customer_service import _clean_mobile
    return _clean_mobile(raw)


def _who(user: dict | None) -> dict:
    user = user or {}
    return {
        "userId": str(user.get("userId") or "system"),
        "name": str(user.get("name") or user.get("userId") or "system"),
        "role": str(user.get("role") or "system"),
    }


def _customer_ref(mobile: str):
    return _db().collection("customers").document(mobile)


def _docs_ref(mobile: str):
    return _customer_ref(mobile).collection(SUBCOLLECTION)


def _history(action: str, user: dict | None, note: str = "") -> dict:
    w = _who(user)
    return {"action": action, "by": w["userId"], "by_name": w["name"],
            "by_role": w["role"], "at": now_iso(), "note": (note or "")[:200]}


def _append_history(ref, entry: dict, extra: dict | None = None) -> None:
    """Append one history entry (ArrayUnion — never rewrites the list)."""
    upd = {"history": _fs().ArrayUnion([entry])}
    if extra:
        upd.update(extra)
    ref.update(upd)


def storage_path_from_url(url: str) -> str:
    """Object path for a Firebase download URL, '' for anything else."""
    if not isinstance(url, str) or "firebasestorage.googleapis.com" not in url or "/o/" not in url:
        return ""
    try:
        return urllib.parse.unquote(url.split("/o/", 1)[1].split("?", 1)[0])
    except Exception:
        return ""


def legacy_doc_id(path: str) -> str:
    return "legacy-" + hashlib.sha1(path.encode("utf-8")).hexdigest()[:16]


# ─── image handling ───────────────────────────────────────────────────────

def normalise_image(raw: bytes) -> tuple[bytes, int, int]:
    """Decode (rejects non-images), apply EXIF rotation, DROP all metadata
    (phone photos carry GPS), cap the size, re-encode as JPEG."""
    from PIL import Image, ImageOps, UnidentifiedImageError
    if not raw:
        raise IdDocError("The photo is empty.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise IdDocError("Photo is too large (max 12 MB).", 413)
    try:
        probe = Image.open(io.BytesIO(raw))
        probe.verify()
        img = Image.open(io.BytesIO(raw))
        if (img.format or "").upper() not in ("JPEG", "PNG", "WEBP"):
            raise IdDocError("Use a JPEG, PNG or WebP photo.")
        if img.width * img.height > MAX_PIXELS:
            raise IdDocError("Photo resolution is too high.")
        img.load()
    except IdDocError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as e:
        raise IdDocError("That file is not a readable photo.") from e
    img = ImageOps.exif_transpose(img)
    if img.mode not in ("RGB", "L"):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        rgba = img.convert("RGBA")
        bg.paste(rgba, mask=rgba.split()[-1])
        img = bg
    elif img.mode == "L":
        img = img.convert("RGB")
    if max(img.size) > MAX_EDGE:
        img.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
    return out.getvalue(), img.width, img.height


def make_thumb(jpeg: bytes) -> bytes:
    from PIL import Image
    img = Image.open(io.BytesIO(jpeg))
    img = img.convert("RGB")
    img.thumbnail((THUMB_EDGE, THUMB_EDGE), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=78, optimize=True)
    return out.getvalue()


def _font(size: int):
    from PIL import ImageFont
    here = os.path.dirname(os.path.abspath(__file__))
    for cand in (
        os.path.join(here, "..", "backend", "cibara_api", "invoice", "fonts", "DejaVuSans.ttf"),
        os.path.join(here, "..", "static", "fonts", "DejaVuSans.ttf"),
    ):
        if os.path.isfile(cand):
            try:
                return ImageFont.truetype(cand, size)
            except OSError:
                pass
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1
        return ImageFont.load_default()


def watermark(jpeg: bytes, text: str) -> bytes:
    """Tile a faint diagonal line of text over the image. Keeps the document
    fully readable but makes any screenshot traceable to the viewer."""
    from PIL import Image, ImageDraw
    base = Image.open(io.BytesIO(jpeg)).convert("RGBA")
    w, h = base.size
    size = max(14, int(min(w, h) / 26))
    font = _font(size)
    tile_w = int((w * w + h * h) ** 0.5) + size * 4
    layer = Image.new("RGBA", (tile_w, tile_w), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    try:
        tw = draw.textlength(text, font=font)
    except AttributeError:  # pragma: no cover - very old Pillow
        tw = len(text) * size * 0.6
    step_x, step_y = int(tw + size * 4), int(size * 5.5)
    for row, y in enumerate(range(0, tile_w, step_y)):
        off = (row % 2) * step_x // 2
        for x in range(-step_x + off, tile_w, step_x):
            draw.text((x, y), text, font=font, fill=(90, 90, 90, 46))
    layer = layer.rotate(28, resample=Image.BICUBIC)
    left, top = (tile_w - w) // 2, (tile_w - h) // 2
    layer = layer.crop((left, top, left + w, top + h))
    out_img = Image.alpha_composite(base, layer).convert("RGB")
    # small solid footer so the viewer and time are always legible
    draw = ImageDraw.Draw(out_img)
    fsize = max(11, int(min(w, h) / 48))
    ffont = _font(fsize)
    pad = max(4, fsize // 3)
    draw.rectangle((0, h - fsize - pad * 2, w, h), fill=(255, 255, 255))
    draw.text((pad, h - fsize - pad - 1), text, font=ffont, fill=(70, 70, 70))
    out = io.BytesIO()
    out_img.save(out, format="JPEG", quality=88, optimize=True)
    return out.getvalue()


# ─── records ──────────────────────────────────────────────────────────────

def _public(rec: dict, *, include_removed_detail: bool = True) -> dict:
    """Record as returned to the browser — never a Storage path or token."""
    keep = ("id", "side", "status", "source", "width", "height", "bytes",
            "captured_by", "captured_at", "context", "views", "last_viewed_by",
            "last_viewed_at", "removed_by", "removed_at", "remove_reason",
            "restored_by", "restored_at", "archived_at", "legacy", "history",
            "scan")
    out = {k: rec.get(k) for k in keep if k in rec}
    out["history"] = list(rec.get("history") or [])[-MAX_HISTORY:]
    if not include_removed_detail:
        out.pop("remove_reason", None)
    return out


def _refresh_customer_summary(mobile: str) -> int:
    """Recount active documents and store the count on the customer doc."""
    try:
        snaps = list(_docs_ref(mobile).where("status", "==", "active").stream())
        n = len(snaps)
    except Exception as e:
        logger.warning("id_docs: recount failed for %s: %s", mobile, e)
        return -1
    _customer_ref(mobile).set(
        {"id_doc_count": n, "has_id_docs": n > 0, "id_docs_updated_at": now_iso()},
        merge=True)
    return n


def _ensure_customer(mobile: str) -> None:
    """Create a minimal customer stub if the guest is new. Uses create() so it
    can never overwrite a record that a parallel check-in just wrote."""
    from google.api_core import exceptions as gexc
    ref = _customer_ref(mobile)
    try:
        ref.create({
            "mobile": mobile, "name": "", "address": "",
            "id_doc_urls": [], "total_stays": 0, "total_spent": 0,
            "first_visit": datetime.now(timezone.utc).isoformat(),
            "last_stay_date": "",
        })
    except gexc.Conflict:  # AlreadyExists
        pass


def add_document(mobile: str, raw: bytes, *, user: dict | None, side: str = "front",
                 source: str = "manual", context: dict | None = None,
                 device: str = "", scan: dict | None = None) -> dict:
    """Store one scanned ID image privately and record who captured it.

    A new front (or back) supersedes the previous active front (back): the
    older one moves to `archived` — still viewable, never deleted.
    """
    clean = clean_mobile(mobile)
    if not clean:
        raise IdDocError("A valid 10-digit mobile number is required.")
    side = side if side in SIDES else "other"
    source = source if source in SOURCES else "manual"
    ctx = dict(context or {})
    ctx = {"kind": ctx.get("kind") if ctx.get("kind") in CONTEXTS else "viewer",
           "room": str(ctx.get("room") or "")[:12]}

    jpeg, w, h = normalise_image(raw)
    digest = hashlib.sha256(jpeg).hexdigest()

    # Same image uploaded twice (double tap, retry after a slow network):
    # return the existing record instead of storing a duplicate.
    try:
        for s in _docs_ref(clean).where("sha256", "==", digest).limit(3).stream():
            rec = s.to_dict() or {}
            if rec.get("status") == "active":
                return _public(rec)
    except Exception as e:
        logger.warning("id_docs: duplicate check skipped for %s: %s", clean, e)

    doc_id = datetime.now(IST).strftime("%Y%m%d%H%M%S") + "-" + uuid.uuid4().hex[:8]
    path = f"{STORAGE_PREFIX}{clean}/{doc_id}.jpg"
    who = _who(user)

    blob = _bucket().blob(path)
    # Deliberately NO firebaseStorageDownloadTokens: the object is private.
    blob.metadata = {"mobile": clean, "doc_id": doc_id, "side": side,
                     "captured_by": who["userId"]}
    blob.cache_control = "private, no-store"
    blob.upload_from_string(jpeg, content_type="image/jpeg")

    _ensure_customer(clean)
    try:
        adopt_legacy(clean)  # so the active count includes older photos
    except Exception as e:
        logger.warning("id_docs: legacy adoption skipped for %s: %s", clean, e)
    rec = {
        "id": doc_id, "mobile": clean, "path": path, "side": side,
        "status": "active", "source": source, "width": w, "height": h,
        "bytes": len(jpeg), "sha256": digest,
        "captured_by": who, "captured_at": now_iso(),
        "context": ctx, "device": (device or "")[:160],
        "views": 0, "last_viewed_by": None, "last_viewed_at": None,
        "legacy": False,
        "history": [_history("captured", user,
                             f"{side} · {source.replace('_', ' ')}"
                             + (f" · room {ctx['room']}" if ctx["room"] else "")
                             + f" · {ctx['kind'].replace('_', ' ')}")],
    }
    if scan:
        rec["scan"] = {k: scan[k] for k in ("detected", "enhance", "adjusted", "sharpness")
                       if k in scan}
    try:
        _docs_ref(clean).document(doc_id).create(rec)
    except Exception:
        # Never leave a private file nobody can reach.
        try:
            blob.delete()
        except Exception:
            pass
        raise

    # Keep the active set small without ever deleting: a newer front/back
    # archives the previous one; beyond MAX_ACTIVE_OTHER unlabelled photos the
    # oldest are archived. Archived photos stay viewable and restorable.
    try:
        active = [(s.reference, s.id, s.to_dict() or {})
                  for s in _docs_ref(clean).where("status", "==", "active").stream()]
        if side in ("front", "back"):
            stale = [a for a in active if a[1] != doc_id and a[2].get("side") == side]
            note = f"replaced by newer {side}"
        else:
            others = sorted((a for a in active if a[2].get("side") in ("other", "unknown")),
                            key=lambda a: a[2].get("captured_at") or "")
            stale = others[:max(0, len(others) - MAX_ACTIVE_OTHER)]
            note = f"more than {MAX_ACTIVE_OTHER} photos on file"
        for ref, _id, _rec in stale:
            _append_history(ref, _history("archived", user, note),
                            {"status": "archived", "archived_at": now_iso()})
    except Exception as e:
        logger.warning("id_docs: archiving older photos failed for %s: %s", clean, e)

    _refresh_customer_summary(clean)
    logger.info("id_docs: stored %s for %s (%s, %s, %d KB) by %s",
                doc_id, clean, side, source, len(jpeg) // 1024, who["userId"])
    return _public(rec)


def adopt_legacy(mobile: str, customer: dict | None = None) -> int:
    """Create records for any `id_doc_urls` entry that has none yet. The old
    array and the files are left untouched. Returns how many were adopted."""
    from google.api_core import exceptions as gexc
    clean = clean_mobile(mobile)
    if not clean:
        return 0
    if customer is None:
        snap = _customer_ref(clean).get()
        customer = (snap.to_dict() or {}) if snap.exists else {}
    urls = [u for u in (customer.get("id_doc_urls") or []) if isinstance(u, str)]
    adopted = 0
    for idx, url in enumerate(urls):
        path = storage_path_from_url(url)
        if not path.startswith(STORAGE_PREFIX):
            continue
        doc_id = legacy_doc_id(path)
        ref = _docs_ref(clean).document(doc_id)
        if ref.get().exists:
            continue
        captured_at = ""
        try:
            b = _bucket().get_blob(path)
            if b is None:
                continue  # file genuinely gone — nothing to show
            tc = getattr(b, "time_created", None)
            if tc:
                captured_at = tc.astimezone(IST).isoformat(timespec="seconds")
        except Exception:
            pass
        rec = {
            "id": doc_id, "mobile": clean, "path": path, "side": "unknown",
            "status": "active", "source": "legacy", "width": None, "height": None,
            "bytes": None, "sha256": None,
            "captured_by": {"userId": "unknown", "name": "Before audit trail",
                            "role": "unknown"},
            "captured_at": captured_at or customer.get("first_visit") or "",
            "context": {"kind": "legacy", "room": ""}, "device": "",
            "views": 0, "last_viewed_by": None, "last_viewed_at": None,
            "legacy": True, "legacy_index": idx,
            "history": [{"action": "imported", "by": "system", "by_name": "System",
                         "by_role": "system", "at": now_iso(),
                         "note": "Existing photo moved to secure storage records"}],
        }
        try:
            ref.create(rec)
            adopted += 1
        except gexc.Conflict:  # AlreadyExists — adopted concurrently
            pass
        except Exception as e:
            logger.warning("id_docs: adopt %s for %s failed: %s", path, clean, e)
    if adopted:
        _refresh_customer_summary(clean)
    return adopted


def list_documents(mobile: str, *, include_removed: bool = False) -> list[dict]:
    clean = clean_mobile(mobile)
    if not clean:
        raise IdDocError("A valid 10-digit mobile number is required.")
    try:
        adopt_legacy(clean)
    except Exception as e:
        logger.warning("id_docs: legacy adoption skipped for %s: %s", clean, e)
    recs = [s.to_dict() or {} for s in _docs_ref(clean).stream()]
    if not include_removed:
        recs = [r for r in recs if r.get("status") != "removed"]
    order = {"active": 0, "archived": 1, "removed": 2}
    side_order = {"front": 0, "back": 1, "other": 2, "unknown": 3}
    recs.sort(key=lambda r: (order.get(r.get("status"), 3),
                             side_order.get(r.get("side"), 4),
                             _neg(r.get("captured_at") or "")))
    return [_public(r) for r in recs]


def _neg(s: str) -> str:
    # newest first inside a group without parsing dates
    return "".join(chr(0x10FFFF - ord(c)) if ord(c) < 0x10FFFF else c for c in s)


def get_record(mobile: str, doc_id: str) -> tuple[Any, dict]:
    clean = clean_mobile(mobile)
    if not clean or not doc_id or "/" in doc_id or len(doc_id) > 64:
        raise IdDocError("Document not found.", 404)
    ref = _docs_ref(clean).document(doc_id)
    snap = ref.get()
    if not snap.exists:
        raise IdDocError("Document not found.", 404)
    rec = snap.to_dict() or {}
    path = rec.get("path") or ""
    # A record can only ever point inside this guest's own folder.
    if not path.startswith(f"{STORAGE_PREFIX}{clean}/"):
        raise IdDocError("Document not found.", 404)
    return ref, rec


def read_image(mobile: str, doc_id: str, *, variant: str, user: dict | None,
               include_removed: bool = False) -> tuple[bytes, dict]:
    """Bytes for `variant` = thumb | view (watermarked) | original."""
    ref, rec = get_record(mobile, doc_id)
    if rec.get("status") == "removed" and not include_removed:
        raise IdDocError("This document was removed.", 410)
    try:
        data = _bucket().blob(rec["path"]).download_as_bytes()
    except Exception as e:
        logger.warning("id_docs: download %s failed: %s", rec.get("path"), e)
        raise IdDocError("The image file could not be read from storage.", 404) from e
    if variant == "thumb":
        return make_thumb(data), rec
    if variant == "view":
        who = _who(user)
        stamp = datetime.now(IST).strftime("%d %b %Y %H:%M")
        out = watermark(data, f"Cibara · ID verification only · {who['name']} · {stamp}")
    else:
        out = data
    try:
        upd = {"views": _fs().Increment(1),
               "last_viewed_by": _who(user), "last_viewed_at": now_iso()}
        if variant == "original":
            _append_history(ref, _history("downloaded", user), upd)
        else:
            ref.update(upd)
    except Exception as e:
        logger.warning("id_docs: view stamp failed for %s: %s", doc_id, e)
    return out, rec


def remove_document(mobile: str, doc_id: str, *, user: dict | None, reason: str) -> dict:
    """Soft delete: the record is marked removed and the FILE IS KEPT."""
    reason = (reason or "").strip()
    if len(reason) < 3:
        raise IdDocError("Please give a reason (at least 3 characters).")
    ref, rec = get_record(mobile, doc_id)
    if rec.get("status") == "removed":
        return _public(rec)
    w = _who(user)
    _append_history(ref, _history("removed", user, reason), {
        "status": "removed", "status_before_remove": rec.get("status") or "active",
        "removed_by": w, "removed_at": now_iso(), "remove_reason": reason[:200]})
    _refresh_customer_summary(clean_mobile(mobile))
    return _public(ref.get().to_dict() or {})


def restore_document(mobile: str, doc_id: str, *, user: dict | None) -> dict:
    ref, rec = get_record(mobile, doc_id)
    if rec.get("status") != "removed":
        return _public(rec)
    back_to = rec.get("status_before_remove") or "active"
    if back_to not in ("active", "archived"):
        back_to = "active"
    _append_history(ref, _history("restored", user), {
        "status": back_to, "restored_by": _who(user), "restored_at": now_iso()})
    _refresh_customer_summary(clean_mobile(mobile))
    return _public(ref.get().to_dict() or {})


def set_side(mobile: str, doc_id: str, *, side: str, user: dict | None) -> dict:
    """Label a document front/back/other (mainly for adopted legacy photos)."""
    if side not in SIDES:
        raise IdDocError("Side must be front, back or other.")
    ref, rec = get_record(mobile, doc_id)
    if rec.get("side") != side:
        _append_history(ref, _history("relabelled", user, f"{rec.get('side')} → {side}"),
                        {"side": side})
    return _public(ref.get().to_dict() or {})


def resolve_legacy_url(mobile: str, url: str) -> str:
    """doc_id for an old download URL or a new in-app image URL ('' if none)."""
    url = (url or "").strip()
    marker = "/id-docs/"
    if marker in url:
        return url.split(marker, 1)[1].split("/", 1)[0].split("?", 1)[0]
    path = storage_path_from_url(url)
    if path.startswith(f"{STORAGE_PREFIX}{clean_mobile(mobile)}/"):
        adopt_legacy(mobile)
        return legacy_doc_id(path)
    return ""


def active_count(customer: dict) -> int:
    """Indicator count from a customer dict (legacy-aware, no extra reads)."""
    n = customer.get("id_doc_count")
    if isinstance(n, int) and n >= 0 and customer.get("id_docs_updated_at"):
        return n
    return len([u for u in (customer.get("id_doc_urls") or [])
                if isinstance(u, str) and u.startswith("https://")])
