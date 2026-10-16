"""
Cibara ERP — FastAPI entry point.

    uvicorn cibara_api.main:app --host 0.0.0.0 --port 8080

Routing order (first match wins):
  1. /api/v2/*          new typed API (auth, dashboard, rooms, bills, reports,
                        admin, guest) — OpenAPI docs at /api/v2/docs
  2. /app, /app/*       React SPA (frontend/dist), index.html fallback
  3. /, /login          redirect to the SPA
  4. everything else    the legacy Flask app, unchanged (all 235 routes,
                        /legacy = the old UI, /static, /uploads, OTA ingest
                        endpoints with their shared-secret headers, …)
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

from a2wsgi import WSGIMiddleware
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.gzip import GZipMiddleware

from . import legacy
from .core.middleware import RequestContextMiddleware
from .routers import admin, auth, bills, customer_docs, dashboard, guest, reports, rooms, invoice_settings
from .settings import get_settings

log = logging.getLogger("cibara_api")

VERSION = "2.0.0"


def _error_body(message: str, **extra) -> dict:
    return {"success": False, "message": message, **extra}


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(
        title="Cibara ERP API", version=VERSION,
        docs_url="/api/v2/docs", openapi_url="/api/v2/openapi.json", redoc_url=None,
    )

    # ── errors: one envelope everywhere ({success:false, message}) ────────
    @app.exception_handler(StarletteHTTPException)
    async def _http_exc(request: Request, exc: StarletteHTTPException):
        msg = exc.detail if isinstance(exc.detail, str) else "Request failed"
        return JSONResponse(_error_body(msg), status_code=exc.status_code, headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def _validation_exc(request: Request, exc: RequestValidationError):
        errors = [{"field": ".".join(str(x) for x in e.get("loc", [])[1:]), "message": e.get("msg", "")}
                  for e in exc.errors()]
        first = errors[0] if errors else {"field": "", "message": "Invalid request"}
        msg = first["message"].removeprefix("Value error, ")
        if first["field"]:
            msg = f"{first['field']}: {msg}"
        return JSONResponse(_error_body(msg, errors=errors), status_code=422)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):  # pragma: no cover - safety net
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(_error_body("Internal server error"), status_code=500)

    # ── API ───────────────────────────────────────────────────────────────
    @app.get("/api/v2/health", tags=["meta"])
    async def health():
        return {"status": "ok", "version": VERSION, "env": legacy.legacy_config.CIBARA_ENV}

    @app.get("/api/v2/config", tags=["meta"])
    async def public_config():
        """Public Firebase web config for the SPA's realtime listeners
        (same values /firebase-config.js serves; web API keys are public)."""
        cfg = dict(legacy.legacy_config.FIREBASE_WEB_CONFIG)
        for env_key, k in (("FIREBASE_WEB_API_KEY", "apiKey"), ("FIREBASE_AUTH_DOMAIN", "authDomain"),
                           ("FIREBASE_PROJECT_ID", "projectId"), ("FIREBASE_STORAGE_BUCKET", "storageBucket"),
                           ("FIREBASE_APP_ID", "appId")):
            if os.environ.get(env_key):
                cfg[k] = os.environ[env_key]
        return {"success": True, "env": legacy.legacy_config.CIBARA_ENV, "version": VERSION, "firebase": cfg}

    for r in (auth.router, dashboard.router, rooms.router, bills.router, reports.router,
              admin.router, guest.router, invoice_settings.router, customer_docs.router):
        app.include_router(r)

    @app.api_route("/api/v2/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
                   include_in_schema=False)
    async def _api_404(rest: str):
        return JSONResponse(_error_body("Route not found"), status_code=404)

    # ── UI: classic screens (default) or the React SPA ────────────────────
    dist = Path(s.FRONTEND_DIST)
    index = dist / "index.html"
    spa = s.UI_MODE.lower() == "spa"

    if spa:
        @app.get("/", include_in_schema=False)
        async def _root():
            return RedirectResponse("/app/", status_code=302)

        @app.get("/login", include_in_schema=False)
        async def _login_redirect():
            # Only the classic UI sends people to /login, and only after it has
            # signed out. signout=1 makes the SPA end its own session too
            # instead of resuming it from the refresh cookie.
            return RedirectResponse("/app/login?signout=1", status_code=302)

        @app.get("/app", include_in_schema=False)
        @app.get("/app/{path:path}", include_in_schema=False)
        async def _spa(path: str = ""):
            target = (dist / path).resolve() if path else index
            if path and dist.resolve() in target.parents and target.is_file():
                cache = "public, max-age=31536000, immutable" if path.startswith("assets/") else "no-cache"
                return FileResponse(target, headers={"Cache-Control": cache})
            if path.startswith("assets/"):
                return JSONResponse(_error_body("Not found"), status_code=404)
            if not index.is_file():
                return JSONResponse(_error_body("Frontend not built. Run `npm run build` in frontend/."), status_code=503)
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
    else:
        # Classic mode: "/" and "/login" fall through to the Flask app below.
        @app.get("/app", include_in_schema=False)
        @app.get("/app/{path:path}", include_in_schema=False)
        async def _spa_off(path: str = ""):
            return RedirectResponse("/", status_code=302)

    # ── legacy catch-all (must be last) ───────────────────────────────────
    app.mount("/", WSGIMiddleware(legacy.legacy_wsgi, workers=s.LEGACY_WSGI_WORKERS))

    # ── middleware (outermost last) ───────────────────────────────────────
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    if s.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=s.cors_origins, allow_credentials=True,
                           allow_methods=["*"], allow_headers=["*"],
                           expose_headers=["X-Firestore-Reads", "X-Request-ID"])
    app.add_middleware(RequestContextMiddleware)
    return app


app = create_app()
