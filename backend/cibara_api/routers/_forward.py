"""Helpers for typed /api/v2 facades over legacy routes."""
from __future__ import annotations

from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from ..legacy import LegacyResponse, call_legacy
from ..security.deps import Principal


async def legacy(p: Principal, request: Request | None, method: str, path: str, *,
                 json: Any = None, query: dict | None = None, data: Any = None,
                 content_type: str | None = None) -> LegacyResponse:
    return await run_in_threadpool(
        call_legacy, method, path, headers=p.legacy_headers(request), json=json,
        query={k: v for k, v in (query or {}).items() if v is not None} or None,
        data=data, content_type=content_type, client_ip=p.client_ip,
    )


def respond(r: LegacyResponse, *, transform=None) -> Response:
    """Pass the legacy status and body through unchanged.

    Legacy routes often answer HTTP 200 with {"success": false}; the SPA's
    API client treats `success: false` as an error regardless of status, so
    the original semantics are preserved without re-mapping codes here.
    """
    if r.json is not None:
        body = transform(r.json) if (transform and r.ok) else r.json
        return JSONResponse(body, status_code=r.status)
    media = r.headers.get("Content-Type", "application/octet-stream")
    headers = {k: v for k, v in r.headers.items() if k.lower() in ("cache-control", "content-disposition")}
    return Response(r.body, status_code=r.status, media_type=media, headers=headers)


async def forward(p: Principal, request: Request, method: str, path: str, **kw) -> Response:
    transform = kw.pop("transform", None)
    return respond(await legacy(p, request, method, path, **kw), transform=transform)
