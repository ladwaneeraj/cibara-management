"""
/api/v2/customers/{mobile}/id-docs — guest ID documents (Aadhaar).

Native endpoints over the legacy helper `services/id_docs.py` (private
Storage objects, one Firestore record per document, append-only history).

Permissions (services/permissions.py):
  customer_doc.capture   admin, manager   upload a scan
  customer_doc.view      admin, manager   list, thumbnails, watermarked view
  customer_doc.download  admin            original file (no watermark)
  customer_doc.remove    admin            soft remove / restore / relabel

Audit actions: customer_doc.capture, customer_doc.view, customer_doc.download,
customer_doc.remove, customer_doc.restore, customer_doc.relabel. Thumbnails are
not audited individually (the list call that precedes them is).

Images are returned with `Cache-Control: no-store` and are only reachable with
the access token — there is no public or long-lived link anywhere.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, Path, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from ..core import audit
from ..security.deps import Principal, require_permission

log = logging.getLogger("cibara_api.customer_docs")
router = APIRouter(prefix="/api/v2/customers", tags=["customer-docs"])

Mobile = Path(..., pattern=r"^\d{10}$")
DocId = Path(..., pattern=r"^[A-Za-z0-9_-]{1,64}$")


def _svc():
    from services import id_docs
    return id_docs


def _fail(e: Exception) -> HTTPException:
    status = getattr(e, "status", 400)
    return HTTPException(status, str(e))


def _audit(p: Principal, action: str, mobile: str, **meta) -> None:
    audit.write(action, user=p.user.as_legacy_user(), client_ip=p.client_ip,
                user_agent=p.user_agent, target_collection="customers", target_id=mobile,
                metadata=meta)


@router.get("/{mobile}/id-docs")
async def list_id_docs(mobile: str = Mobile,
                       include_removed: bool = Query(False),
                       p: Principal = Depends(require_permission("customer_doc.view"))):
    svc = _svc()
    show_removed = include_removed and p.can("customer_doc.remove")
    try:
        docs = await run_in_threadpool(svc.list_documents, mobile, include_removed=show_removed)
    except svc.IdDocError as e:
        raise _fail(e) from e
    return {
        "success": True, "mobile": mobile, "documents": docs,
        "active": sum(1 for d in docs if d.get("status") == "active"),
        "can": {"capture": p.can("customer_doc.capture"),
                "download": p.can("customer_doc.download"),
                "remove": p.can("customer_doc.remove")},
    }


@router.post("/{mobile}/id-docs")
async def upload_id_doc(mobile: str = Mobile,
                        file: UploadFile = File(...),
                        side: Literal["front", "back", "other"] = Form("front"),
                        source: Literal["auto_scan", "manual", "upload"] = Form("manual"),
                        context: Literal["checkin", "checkout", "customer_manager",
                                         "viewer", "register"] = Form("viewer"),
                        room: str = Form("", max_length=12),
                        scan: str = Form("", max_length=500),
                        p: Principal = Depends(require_permission("customer_doc.capture"))):
    svc = _svc()
    raw = await file.read(svc.MAX_UPLOAD_BYTES + 1)
    scan_meta: dict = {}
    if scan:
        try:
            v = json.loads(scan)
            if isinstance(v, dict):
                scan_meta = {k: v[k] for k in ("detected", "enhance", "adjusted", "sharpness")
                             if k in v and isinstance(v[k], (bool, int, float, str))}
        except ValueError:
            pass

    def _do():
        rec = svc.add_document(mobile, raw, user=p.user.as_legacy_user(), side=side,
                               source=source, context={"kind": context, "room": room},
                               device=p.user_agent, scan=scan_meta)
        _audit(p, "customer_doc.capture", mobile, doc_id=rec["id"], side=side,
               source=source, context=context, room=room)
        return rec
    try:
        rec = await run_in_threadpool(_do)
    except svc.IdDocError as e:
        raise _fail(e) from e

    # Pincode / DOB extraction for analytics — same background job and
    # kill-switch as the legacy upload route; never affects the upload.
    try:
        from routes.customers import _maybe_extract_demographics
        _maybe_extract_demographics(mobile, raw, (file.content_type or "image/jpeg").lower(),
                                    f"iddoc:{rec['id']}")
    except Exception as e:  # pragma: no cover - best effort
        log.info("demographics extraction not started: %s", e)
    return {"success": True, "document": rec}


@router.get("/{mobile}/id-docs/{doc_id}/image")
async def id_doc_image(mobile: str = Mobile, doc_id: str = DocId,
                       variant: Literal["thumb", "view", "original"] = Query("view"),
                       p: Principal = Depends(require_permission("customer_doc.view"))):
    svc = _svc()
    if variant == "original" and not p.can("customer_doc.download"):
        raise HTTPException(403, "Forbidden: missing permission 'customer_doc.download'")
    admin_view = p.can("customer_doc.remove")

    def _do():
        data, rec = svc.read_image(mobile, doc_id, variant=variant,
                                   user=p.user.as_legacy_user(), include_removed=admin_view)
        if variant != "thumb":
            _audit(p, "customer_doc.download" if variant == "original" else "customer_doc.view",
                   mobile, doc_id=doc_id, side=rec.get("side"))
        return data, rec
    try:
        data, rec = await run_in_threadpool(_do)
    except svc.IdDocError as e:
        raise _fail(e) from e
    headers = {"Cache-Control": "private, no-store, max-age=0",
               "X-Content-Type-Options": "nosniff",
               "Referrer-Policy": "no-referrer"}
    if variant == "original":
        side = re.sub(r"[^a-z]", "", rec.get("side") or "doc")
        headers["Content-Disposition"] = f'attachment; filename="ID-{mobile[-4:]}-{side}-{doc_id[:14]}.jpg"'
    else:
        headers["Content-Disposition"] = "inline"
    return Response(data, media_type="image/jpeg", headers=headers)


class RemoveIn(BaseModel):
    reason: str = Field(..., min_length=3, max_length=200)


@router.post("/{mobile}/id-docs/{doc_id}/remove")
async def remove_id_doc(body: RemoveIn, mobile: str = Mobile, doc_id: str = DocId,
                        p: Principal = Depends(require_permission("customer_doc.remove"))):
    svc = _svc()

    def _do():
        rec = svc.remove_document(mobile, doc_id, user=p.user.as_legacy_user(), reason=body.reason)
        _audit(p, "customer_doc.remove", mobile, doc_id=doc_id, reason=body.reason)
        return rec
    try:
        return {"success": True, "document": await run_in_threadpool(_do)}
    except svc.IdDocError as e:
        raise _fail(e) from e


@router.post("/{mobile}/id-docs/{doc_id}/restore")
async def restore_id_doc(mobile: str = Mobile, doc_id: str = DocId,
                         p: Principal = Depends(require_permission("customer_doc.remove"))):
    svc = _svc()

    def _do():
        rec = svc.restore_document(mobile, doc_id, user=p.user.as_legacy_user())
        _audit(p, "customer_doc.restore", mobile, doc_id=doc_id)
        return rec
    try:
        return {"success": True, "document": await run_in_threadpool(_do)}
    except svc.IdDocError as e:
        raise _fail(e) from e


class SideIn(BaseModel):
    side: Literal["front", "back", "other"]


@router.post("/{mobile}/id-docs/{doc_id}/side")
async def relabel_id_doc(body: SideIn, mobile: str = Mobile, doc_id: str = DocId,
                         p: Principal = Depends(require_permission("customer_doc.capture"))):
    svc = _svc()

    def _do():
        rec = svc.set_side(mobile, doc_id, side=body.side, user=p.user.as_legacy_user())
        _audit(p, "customer_doc.relabel", mobile, doc_id=doc_id, side=body.side)
        return rec
    try:
        return {"success": True, "document": await run_in_threadpool(_do)}
    except svc.IdDocError as e:
        raise _fail(e) from e
