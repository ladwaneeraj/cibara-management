"""
/api/v2/guest-* — staff side of the QR guest portal (facades).

The guest's phone app (guest/, Firebase Hosting) is unchanged: guests are the
"Guest" role — an anonymous Firebase session proven against the room + mobile
by firestore.rules. They never call this API.
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, Path, Query, Request
from pydantic import BaseModel, Field

from ..security.deps import Principal, require_permission
from ._forward import forward

router = APIRouter(prefix="/api/v2", tags=["guest"])

def ReqId():
    return Path(pattern=r"^[A-Za-z0-9_-]{1,120}$")


class Kinds(BaseModel):
    room_service: Optional[bool] = None
    housekeeping: Optional[bool] = None
    extra_items: Optional[bool] = None
    laundry: Optional[bool] = None
    maintenance: Optional[bool] = None
    wake_up: Optional[bool] = None
    late_checkout: Optional[bool] = None
    taxi: Optional[bool] = None
    do_not_disturb: Optional[bool] = None
    complaint: Optional[bool] = None


class PortalSettingsIn(BaseModel):
    enabled: Optional[bool] = None
    hotelName: Optional[str] = Field(default=None, max_length=120)
    receptionPhone: Optional[str] = Field(default=None, max_length=120)
    whatsapp: Optional[str] = Field(default=None, max_length=120)
    wifiName: Optional[str] = Field(default=None, max_length=120)
    wifiPassword: Optional[str] = Field(default=None, max_length=120)
    checkoutTime: Optional[str] = Field(default=None, max_length=120)
    sessionHours: Optional[int] = Field(default=None, ge=1, le=72)
    houseRules: Optional[str] = Field(default=None, max_length=2000)
    nearbyInfo: Optional[str] = Field(default=None, max_length=2000)
    publicBaseUrl: Optional[str] = Field(default=None, max_length=120, pattern=r"^(https://.*)?$")
    kinds: Optional[Kinds] = None


@router.get("/guest-portal/settings")
async def get_settings(request: Request, p: Principal = Depends(require_permission("guest_request.handle"))):
    return await forward(p, request, "GET", "/api/guest-portal/settings")


@router.patch("/guest-portal/settings")
async def patch_settings(body: PortalSettingsIn, request: Request,
                         p: Principal = Depends(require_permission("guest_portal.manage"))):
    payload = body.model_dump(exclude_none=True)
    if "kinds" in payload:
        # Legacy stores every kind; missing ones default to on.
        payload["kinds"] = {k: (v if v is not None else True) for k, v in body.kinds.model_dump().items()}
    return await forward(p, request, "PATCH", "/api/guest-portal/settings", json=payload)


@router.get("/guest-portal/qr.png")
async def portal_qr(request: Request, p: Principal = Depends(require_permission("guest_portal.manage"))):
    return await forward(p, request, "GET", "/api/guest-portal/qr.png")


@router.get("/guest-requests")
async def active_requests(request: Request, p: Principal = Depends(require_permission("guest_request.handle"))):
    return await forward(p, request, "GET", "/api/guest-requests")


@router.get("/guest-requests/history")
async def request_history(request: Request, days: int = Query(default=7, ge=1, le=90),
                          p: Principal = Depends(require_permission("guest_request.handle"))):
    return await forward(p, request, "GET", "/api/guest-requests/history", query={"days": str(days)})


@router.post("/guest-requests/{request_id}/{action}")
async def transition(request: Request, action: Literal["acknowledge", "done"], request_id: str = ReqId(),
                     p: Principal = Depends(require_permission("guest_request.handle"))):
    return await forward(p, request, "POST", f"/api/guest-requests/{request_id}/{action}")
