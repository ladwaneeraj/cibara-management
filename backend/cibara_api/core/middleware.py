"""
Pure-ASGI request middleware: timing, Firestore counters, global rate limit,
security headers, request id, slow-request logging.

Pure ASGI (not BaseHTTPMiddleware) so streaming/large responses from the
legacy mount pass through untouched.
"""
from __future__ import annotations

import logging
import time
import uuid

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from ..security import tokens
from ..settings import get_settings
from . import metrics
from .ratelimit import limiter

log = logging.getLogger("cibara_api.request")

_SKIP_RATE = ("/app/assets/", "/static/", "/api/v2/health")

_CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com data:; "
    "img-src 'self' data: blob: https://firebasestorage.googleapis.com https://storage.googleapis.com; "
    "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com "
    "https://firebasestorage.googleapis.com; "
    "frame-src 'self' blob: https://firebasestorage.googleapis.com; "
    "worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
)


def _client_ip(scope: Scope) -> str:
    hops = max(0, get_settings().TRUSTED_PROXY_HOPS)
    for k, v in scope.get("headers") or []:
        if k == b"x-forwarded-for":
            parts = [p.strip() for p in v.decode("latin-1").split(",") if p.strip()]
            if hops and len(parts) >= hops:
                return parts[-hops]
    client = scope.get("client")
    return client[0] if client else "unknown"


def _bearer_sub(scope: Scope) -> str | None:
    for k, v in scope.get("headers") or []:
        if k == b"authorization":
            val = v.decode("latin-1")
            if val.lower().startswith("bearer "):
                try:
                    return tokens.user_from_access(val[7:].strip()).user_id
                except tokens.TokenError:
                    return None
    return None


class RequestContextMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        s = get_settings()
        path: str = scope["path"]
        method: str = scope["method"]
        rid = uuid.uuid4().hex[:12]

        if not path.startswith(_SKIP_RATE):
            ip = _client_ip(scope)
            ok, retry = limiter.hit(f"global:{ip}", s.RATE_LIMIT_GLOBAL_PER_MIN, 60)
            if ok and method not in ("GET", "HEAD", "OPTIONS"):
                who = _bearer_sub(scope) or f"ip:{ip}"
                ok, retry = limiter.hit(f"writes:{who}", s.RATE_LIMIT_WRITES_PER_USER_PER_MIN, 60)
            if not ok:
                await _send_429(send, retry)
                return

        # Conditional / HEAD requests: answer without gzip. A 304 has no body,
        # but Starlette's GZipMiddleware still emits a gzip trailer for it, and
        # uvicorn then aborts with "Response content longer than
        # Content-Length" (seen on every browser revalidation of /static and
        # /manifest.webmanifest). Nothing is lost: there is no body to shrink.
        if method == "HEAD" or any(k in (b"if-none-match", b"if-modified-since")
                                   for k, _ in scope.get("headers") or []):
            scope = dict(scope)
            scope["headers"] = [(k, v) for k, v in scope["headers"] if k != b"accept-encoding"]

        counter, token = metrics.start()
        t0 = time.perf_counter()
        state = {"status": 500, "legacy": False}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                state["status"] = message["status"]
                headers = list(message.get("headers") or [])
                names = {k.lower() for k, _ in headers}
                if b"x-firestore-reads" in names:
                    state["legacy"] = True
                else:
                    headers.append((b"x-firestore-reads", str(counter.reads).encode()))
                    headers.append((b"x-firestore-writes", str(counter.writes).encode()))
                ms = (time.perf_counter() - t0) * 1000
                headers.append((b"server-timing", f"app;dur={ms:.1f}".encode()))
                headers.append((b"x-request-id", rid.encode()))
                for k, v in ((b"x-content-type-options", b"nosniff"),
                             (b"referrer-policy", b"strict-origin-when-cross-origin"),
                             (b"x-frame-options", b"SAMEORIGIN")):
                    if k not in names:
                        headers.append((k, v))
                if path.startswith("/app") and b"content-security-policy" not in names:
                    headers.append((b"content-security-policy", _CSP.encode()))
                if path.startswith("/api/v2/") and b"cache-control" not in names:
                    headers.append((b"cache-control", b"no-store"))
                if path.startswith("/static/"):
                    # CDN-friendly caching for the classic assets (so Cloud CDN /
                    # the browser can cache them). They are requested via
                    # asset_url(?v=<mtime>), so a versioned URL is content-addressed
                    # and immutable; an unversioned hit gets a short TTL so a direct
                    # edit still propagates. Overrides Flask's default.
                    headers = [(k, v) for k, v in headers if k.lower() != b"cache-control"]
                    versioned = b"v=" in (scope.get("query_string") or b"")
                    headers.append((
                        b"cache-control",
                        b"public, max-age=31536000, immutable" if versioned else b"public, max-age=3600",
                    ))
                message["headers"] = headers
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            ms = (time.perf_counter() - t0) * 1000
            if not state["legacy"]:
                route = scope.get("route")
                key = getattr(route, "path", None) or metrics.normalise_path(path)
                if path.startswith("/api/"):
                    metrics.record(f"{method} {key}", ms, state["status"], counter.reads, counter.writes)
            if ms >= s.SLOW_REQUEST_MS:
                log.warning("slow request %s %s %.0fms status=%s reads=%s rid=%s",
                            method, path, ms, state["status"], counter.reads, rid)
            metrics.stop(token)


async def _send_429(send: Send, retry: float) -> None:
    body = b'{"success":false,"message":"Too many requests. Slow down."}'
    await send({"type": "http.response.start", "status": 429,
                "headers": [(b"content-type", b"application/json"),
                            (b"retry-after", str(int(retry) + 1).encode()),
                            (b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})
