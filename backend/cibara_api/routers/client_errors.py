"""
Browser error sink: POST /api/v2/client-errors

The classic UI (static/error-monitor.js) and the SPA (src/lib/errorMonitor.ts)
capture window.onerror / unhandledrejection and POST a small, PII-scrubbed
report here; this forwards it to Sentry server-side (core.observability). Doing
it server-side keeps the Sentry DSN off the client entirely and works under the
SPA's strict CSP (connect-src 'self') with no CDN script.

No auth: errors happen on the login page too. The payload is strictly size-
capped by the model, and the endpoint always answers 204 (even when Sentry is
disabled) so the client never retries. The global rate limiter in
core/middleware.py still applies, which bounds error storms.
"""
from __future__ import annotations

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from ..core import observability

router = APIRouter(prefix="/api/v2", tags=["meta"])


class BrowserError(BaseModel):
    model_config = {"extra": "ignore"}

    message: str = Field("", max_length=2000)
    kind: str = Field("", max_length=64)
    stack: str = Field("", max_length=8000)
    url: str = Field("", max_length=1000)
    line: int | None = None
    col: int | None = None
    appVersion: str = Field("", max_length=64)


@router.post("/client-errors", include_in_schema=False)
async def client_errors(err: BrowserError, request: Request) -> Response:
    observability.report_browser_error(
        err.model_dump(),
        request_id=request.headers.get("x-request-id"),
        user_agent=request.headers.get("user-agent", ""),
    )
    return Response(status_code=204)
