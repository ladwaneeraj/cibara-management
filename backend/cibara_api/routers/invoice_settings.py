"""
/api/v2/settings/invoice — invoice branding an admin can change without a deploy:
logo, authorised signature, UPI ID / payee (dynamic QR with the amount due) or an
uploaded static UPI QR image, contact lines, terms and conditions.

Stored in a NEW document `settings/invoice_branding` (no existing document or
field is touched) and images in Storage `branding/<kind>.png` (private; the
server embeds them in the invoice). Every change is audited.
"""
from __future__ import annotations

import io
import logging
import re
from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, Path, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool

from ..core import audit
from ..invoice import render as R
from ..legacy import legacy_config
from ..security.deps import Principal, require_permission

log = logging.getLogger("cibara_api.invoice_settings")
router = APIRouter(prefix="/api/v2/settings/invoice", tags=["settings"])

Kind = Literal["logo", "signature", "upi_qr"]
_VPA = re.compile(r"^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,63}$")
MAX_UPLOAD = 2 * 1024 * 1024
MAX_SIDE = {"logo": 600, "signature": 600, "upi_qr": 800}


def _doc_ref():
    return legacy_config.db.collection(R.SETTINGS_DOC[0]).document(R.SETTINGS_DOC[1])


def _now() -> str:
    return datetime.now(legacy_config.IST).strftime("%Y-%m-%d %H:%M:%S")


class InvoiceSettingsIn(BaseModel):
    email: str = Field(default="", max_length=120)
    website: str = Field(default="", max_length=120)
    thank_you: str = Field(default="", max_length=200)
    signatory_label: str = Field(default="", max_length=60)
    terms: list[str] = Field(default_factory=list, max_length=10)
    upi_vpa: str = Field(default="", max_length=320)
    upi_payee_name: str = Field(default="", max_length=60)

    @field_validator("terms")
    @classmethod
    def _terms(cls, v: list[str]) -> list[str]:
        out = [t.strip() for t in v if t and t.strip()]
        if any(len(t) > 200 for t in out):
            raise ValueError("each term must be at most 200 characters")
        return out

    @field_validator("upi_vpa")
    @classmethod
    def _vpa(cls, v: str) -> str:
        v = (v or "").strip()
        if v and not _VPA.match(v):
            raise ValueError("UPI ID looks wrong — expected something like name@bank")
        return v

    @field_validator("email", "website", "thank_you", "signatory_label", "upi_payee_name")
    @classmethod
    def _strip(cls, v: str) -> str:
        return (v or "").strip()


def _public(doc: dict) -> dict:
    eff = R.branding()
    return {
        "success": True,
        "settings": {k: doc.get(k, "" if k != "terms" else []) for k in
                     ("email", "website", "thank_you", "signatory_label", "terms", "upi_vpa", "upi_payee_name")},
        "images": {k: {"set": bool(doc.get(f"{k}_path")), "updated_at": doc.get(f"{k}_updated_at")}
                   for k in R.IMAGE_KINDS},
        "effective": {"upi_vpa": (eff.get("upi") or {}).get("vpa", ""),
                      "terms": eff.get("terms") or [],
                      "has_logo": bool(eff.get("logo")), "has_signature": bool(eff.get("signature")),
                      "has_upi_qr": bool(eff.get("upi_qr"))},
    }


def _read() -> dict:
    snap = _doc_ref().get()
    return (snap.to_dict() or {}) if snap.exists else {}


@router.get("")
async def get_invoice_settings(p: Principal = Depends(require_permission("settings.view"))):
    doc = await run_in_threadpool(_read)
    return await run_in_threadpool(_public, doc)


@router.put("")
async def put_invoice_settings(body: InvoiceSettingsIn,
                               p: Principal = Depends(require_permission("settings.update"))):
    data = body.model_dump()

    def _save():
        before = _read()
        _doc_ref().set({**data, "updated_at": _now(), "updated_by": p.user.user_id}, merge=True)
        R.branding.cache_clear()
        changed = sorted(k for k in data if before.get(k) != data[k])
        audit.write("settings.invoice_update", user=p.user.as_legacy_user(), client_ip=p.client_ip,
                    user_agent=p.user_agent, target_collection="settings", target_id=R.SETTINGS_DOC[1],
                    metadata={"fields": changed})
        return _public(_read())
    return await run_in_threadpool(_save)


def _normalise_png(raw: bytes, kind: str) -> bytes:
    """Decode with Pillow (rejects anything that is not a real image), drop
    metadata, cap the size and re-encode as PNG."""
    from PIL import Image, UnidentifiedImageError
    try:
        img = Image.open(io.BytesIO(raw))
        img.verify()
        img = Image.open(io.BytesIO(raw))
        img.load()
    except (UnidentifiedImageError, OSError, ValueError) as e:
        raise HTTPException(400, "That file is not a PNG or JPEG image.") from e
    if (img.format or "").upper() not in ("PNG", "JPEG"):
        raise HTTPException(400, "Use a PNG or JPEG image.")
    if img.width * img.height > 25_000_000:
        raise HTTPException(400, "Image is too large.")
    img = img.convert("RGBA" if img.mode in ("RGBA", "LA", "P") else "RGB")
    img.thumbnail((MAX_SIDE[kind], MAX_SIDE[kind]))
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=True)
    return out.getvalue()


@router.post("/images/{kind}")
async def upload_image(kind: Kind = Path(...), file: UploadFile = File(...),
                       p: Principal = Depends(require_permission("settings.update"))):
    raw = await file.read(MAX_UPLOAD + 1)
    if len(raw) > MAX_UPLOAD:
        raise HTTPException(413, "Image must be 2 MB or smaller.")
    png = await run_in_threadpool(_normalise_png, raw, kind)

    def _store():
        from firebase_admin import storage as fb_storage
        path = f"branding/{kind}.png"
        blob = fb_storage.bucket().blob(path)
        blob.cache_control = "no-store"
        try:
            blob.upload_from_string(png, content_type="image/png")
        except Exception as e:
            log.error("invoice image upload failed: %s", e)
            raise HTTPException(503, "Could not save the image to Storage. Is the Storage bucket set up?") from e
        _doc_ref().set({f"{kind}_path": path, f"{kind}_updated_at": _now(),
                        "updated_by": p.user.user_id}, merge=True)
        R.branding.cache_clear()
        audit.write("settings.invoice_image", user=p.user.as_legacy_user(), client_ip=p.client_ip,
                    user_agent=p.user_agent, target_collection="settings", target_id=R.SETTINGS_DOC[1],
                    metadata={"kind": kind, "action": "upload", "bytes": len(png)})
        return _public(_read())
    return await run_in_threadpool(_store)


@router.delete("/images/{kind}")
async def delete_image(kind: Kind = Path(...), p: Principal = Depends(require_permission("settings.update"))):
    def _remove():
        from google.cloud.firestore_v1 import DELETE_FIELD
        _doc_ref().set({f"{kind}_path": DELETE_FIELD, f"{kind}_updated_at": DELETE_FIELD,
                        "updated_by": p.user.user_id}, merge=True)
        R.branding.cache_clear()
        audit.write("settings.invoice_image", user=p.user.as_legacy_user(), client_ip=p.client_ip,
                    user_agent=p.user_agent, target_collection="settings", target_id=R.SETTINGS_DOC[1],
                    metadata={"kind": kind, "action": "remove"})
        return _public(_read())
    return await run_in_threadpool(_remove)


@router.get("/images/{kind}")
async def get_image(kind: Kind = Path(...), p: Principal = Depends(require_permission("settings.view"))):
    def _get() -> bytes | None:
        path = _read().get(f"{kind}_path")
        if not path:
            return None
        from firebase_admin import storage as fb_storage
        try:
            return fb_storage.bucket().blob(path).download_as_bytes()
        except Exception:
            return None
    data = await run_in_threadpool(_get)
    if not data:
        raise HTTPException(404, "No image set")
    return Response(data, media_type="image/png", headers={"Cache-Control": "no-store"})
