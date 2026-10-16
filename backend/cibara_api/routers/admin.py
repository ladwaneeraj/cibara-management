"""
/api/v2/admin — users, audit log, settings, system alerts, metrics.

User management runs the unchanged legacy routes (Firebase Auth user +
custom claims + users/{id} doc + audit entry, last-admin guard). On top, any
action that ends a user's sessions also kills their live 15-minute access
tokens immediately — done by a Flask after_request hook in legacy.py, so the
classic Users screen gets the same behaviour.
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, Path, Query, Request
from pydantic import BaseModel, Field

from ..core import metrics
from ..security.deps import Principal, get_principal, require_permission
from ._forward import forward, legacy, respond

router = APIRouter(prefix="/api/v2", tags=["admin"])

def UserIdP():
    return Path(pattern=r"^[a-z0-9][a-z0-9._-]{1,30}$")
Role = Literal["admin", "manager", "housekeeping"]




class UserCreateIn(BaseModel):
    userId: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{1,30}$")
    name: str = Field(default="", max_length=80)
    role: Role
    password: str = Field(min_length=6, max_length=128)


class UserPatchIn(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    role: Optional[Role] = None
    isActive: Optional[bool] = None


class ResetPasswordIn(BaseModel):
    password: str = Field(min_length=6, max_length=128)


@router.get("/admin/users")
async def list_users(request: Request, p: Principal = Depends(require_permission("user.manage"))):
    return await forward(p, request, "GET", "/api/users")


@router.post("/admin/users", status_code=201)
async def create_user(body: UserCreateIn, request: Request, p: Principal = Depends(require_permission("user.manage"))):
    payload = body.model_dump()
    payload["userId"] = payload["userId"].strip().lower()
    payload["name"] = payload["name"].strip() or payload["userId"]
    return await forward(p, request, "POST", "/api/users", json=payload)


@router.patch("/admin/users/{user_id}")
async def update_user(body: UserPatchIn, request: Request, user_id: str = UserIdP(),
                      p: Principal = Depends(require_permission("user.manage"))):
    payload = body.model_dump(exclude_none=True)
    r = await legacy(p, request, "PATCH", f"/api/users/{user_id}", json=payload)
    return respond(r)


@router.post("/admin/users/{user_id}/reset-password")
async def reset_password(body: ResetPasswordIn, request: Request, user_id: str = UserIdP(),
                         p: Principal = Depends(require_permission("user.manage"))):
    r = await legacy(p, request, "POST", f"/api/users/{user_id}/reset-password", json=body.model_dump())
    return respond(r)


@router.post("/admin/users/{user_id}/force-logout")
async def force_logout(request: Request, user_id: str = UserIdP(),
                       p: Principal = Depends(require_permission("user.manage"))):
    r = await legacy(p, request, "POST", f"/api/users/{user_id}/force-logout")
    return respond(r)


@router.delete("/admin/users/{user_id}")
async def deactivate_user(request: Request, user_id: str = UserIdP(),
                          p: Principal = Depends(require_permission("user.manage"))):
    r = await legacy(p, request, "DELETE", f"/api/users/{user_id}")
    return respond(r)


@router.get("/users/directory")
async def user_directory(request: Request, p: Principal = Depends(get_principal)):
    return await forward(p, request, "GET", "/api/user-directory")


@router.get("/admin/audit-logs")
async def audit_logs(request: Request,
                     start: Optional[str] = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
                     end: Optional[str] = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
                     userId: Optional[str] = Query(default=None, max_length=40),
                     action: Optional[str] = Query(default=None, max_length=80),
                     targetCollection: Optional[str] = Query(default=None, max_length=40),
                     targetId: Optional[str] = Query(default=None, max_length=120),
                     q: Optional[str] = Query(default=None, max_length=80),
                     limit: int = Query(default=200, ge=1, le=1000),
                     include_archive: bool = False,
                     p: Principal = Depends(require_permission("logs.view"))):
    return await forward(p, request, "GET", "/api/audit-logs", query={
        "from": start, "to": end, "userId": userId, "action": action,
        "targetCollection": targetCollection, "targetId": targetId, "q": q,
        "limit": str(limit), "include_archive": "1" if include_archive else None})


# ── settings ──────────────────────────────────────────────────────────────

class UiConfigIn(BaseModel):
    hide_register_tab: Optional[bool] = None
    incognito_mode: Optional[bool] = None
    listener_first: Optional[bool] = None
    inspection_photos: Optional[bool] = None
    cleaning_photos: Optional[bool] = None


class BillingConfigIn(BaseModel):
    always_generate_bill: bool


@router.get("/settings/ui")
async def get_ui_config(request: Request, p: Principal = Depends(get_principal)):
    return await forward(p, request, "GET", "/settings/ui_config")


@router.patch("/settings/ui")
async def patch_ui_config(body: UiConfigIn, request: Request,
                          p: Principal = Depends(require_permission("settings.update"))):
    return await forward(p, request, "POST", "/settings/ui_config", json=body.model_dump(exclude_none=True))


@router.get("/settings/billing")
async def get_billing_config(request: Request, p: Principal = Depends(require_permission("settings.view"))):
    return await forward(p, request, "GET", "/settings/billing_config")


@router.patch("/settings/billing")
async def patch_billing_config(body: BillingConfigIn, request: Request,
                               p: Principal = Depends(require_permission("settings.update"))):
    return await forward(p, request, "POST", "/settings/billing_config", json=body.model_dump())


# ── alerts & metrics ──────────────────────────────────────────────────────

@router.get("/admin/alerts")
async def alerts(request: Request, include_resolved: bool = False,
                 p: Principal = Depends(require_permission("logs.view"))):
    return await forward(p, request, "GET", "/system_alerts",
                         query={"include_resolved": "1" if include_resolved else None})


class ResolveIn(BaseModel):
    alert_id: str = Field(min_length=1, max_length=80)


@router.post("/admin/alerts/resolve")
async def resolve_alert(body: ResolveIn, request: Request, p: Principal = Depends(require_permission("logs.view"))):
    return await forward(p, request, "POST", "/system_alerts/resolve", json=body.model_dump())


@router.get("/admin/metrics")
async def get_metrics(p: Principal = Depends(require_permission("logs.view"))):
    return {"success": True, **metrics.snapshot()}
