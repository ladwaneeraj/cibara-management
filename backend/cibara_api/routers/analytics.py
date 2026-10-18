"""
/api/v2/analytics — register-based analytics (forward facade).

Same shape as `report_insights` in routers/reports.py: validate the query,
enforce the permission, then run the unchanged legacy blueprint route
(`routes/analytics.py`, `/analytics/overview`) in-process. All aggregation,
projections and caching live there; this layer adds nothing but typing.

The nightly snapshot (`POST /analytics/snapshot`) is deliberately NOT exposed
here: it is a Cloud Scheduler ingest authenticated by `X-Ingest-Secret` on the
legacy path, like the MMT / Agoda / bank pollers.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ..security.deps import Principal, require_permission
from ._forward import forward

router = APIRouter(prefix="/api/v2", tags=["analytics"])


def DateQ():
    return Query(pattern=r"^\d{4}-\d{2}-\d{2}$")


@router.get("/analytics/overview")
async def analytics_overview(request: Request, start: str = DateQ(), end: str = DateQ(),
                             fresh: bool = False,
                             p: Principal = Depends(require_permission("analytics.view"))):
    if start > end:
        raise HTTPException(400, "start must be on or before end")
    return await forward(p, request, "GET", "/analytics/overview",
                         query={"from": start, "to": end, "fresh": "1" if fresh else None})
