"""
Error monitoring (Sentry) — optional, DSN-gated, PII-scrubbed.

OFF unless ``SENTRY_DSN`` is set, so it stays silent locally and in tests
(``sentry_sdk`` is imported lazily and only when a DSN is configured). When
enabled it captures:

  * unhandled exceptions from the FastAPI layer (via ``capture_exception`` in
    the app's catch-all handler) and from the mounted legacy Flask app (via
    ``FlaskIntegration``), i.e. the 5xx surface;
  * browser errors the classic UI and the SPA forward to
    ``POST /api/v2/client-errors``.

PRIVACY RULE (hard): no Aadhaar, mobile number, e-mail address, request body,
cookie or credential ever leaves the process. ``send_default_pii`` is False,
request bodies are never attached, and ``before_send`` runs :func:`scrub_event`
over every outgoing event. The scrubbing never raises — a bug in it must not
drop error reporting, and must never let unscrubbed data through: on failure it
drops the event.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any

log = logging.getLogger("cibara_api.observability")

# Set True only after a successful sentry_sdk.init().
_ENABLED = False

REDACTED = "[redacted]"

# Aadhaar: 12 digits, optionally grouped 4-4-4. Mobile: Indian 10-digit (6-9
# lead). E-mail: ordinary pattern (also covers the synthetic <id>@cibara.internal
# login identity, which is safe to redact).
_AADHAAR = re.compile(r"\b\d{4}\s?\d{4}\s?\d{4}\b")
_MOBILE = re.compile(r"\b[6-9]\d{9}\b")
_EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")

# Keys whose values are redacted wholesale wherever they appear in an event.
_SENSITIVE_KEYS = {
    "authorization", "cookie", "set-cookie", "x-api-key", "x-ingest-secret",
    "x-force-duplicate", "password", "passwd", "pwd", "secret", "jwt_secret",
    "token", "id_token", "access_token", "refresh_token", "idtoken",
    "aadhaar", "aadhar", "mobile", "phone", "otp",
}


def scrub_text(s: str) -> str:
    """Redact Aadhaar / mobile / e-mail occurrences inside a string."""
    s = _AADHAAR.sub(REDACTED, s)
    s = _MOBILE.sub(REDACTED, s)
    s = _EMAIL.sub(REDACTED, s)
    return s


def _walk(obj: Any) -> Any:
    """Recursively redact sensitive keys and scrub PII in string values."""
    if isinstance(obj, str):
        return scrub_text(obj)
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if isinstance(k, str) and k.lower() in _SENSITIVE_KEYS:
                out[k] = REDACTED
            else:
                out[k] = _walk(v)
        return out
    if isinstance(obj, (list, tuple)):
        return [_walk(v) for v in obj]
    return obj


def scrub_event(event: dict, hint: dict | None = None) -> dict | None:
    """Sentry ``before_send`` hook. Drops request bodies/cookies, redacts
    sensitive headers, strips query strings, and scrubs PII everywhere.

    Returns the scrubbed event, or ``None`` to drop it if scrubbing fails
    (fail closed — never ship an unscrubbed event)."""
    try:
        req = event.get("request")
        if isinstance(req, dict):
            req.pop("data", None)
            req.pop("cookies", None)
            headers = req.get("headers")
            if isinstance(headers, dict):
                req["headers"] = {
                    k: (REDACTED if isinstance(k, str) and k.lower() in _SENSITIVE_KEYS else v)
                    for k, v in headers.items()
                }
            if isinstance(req.get("query_string"), str):
                req["query_string"] = ""
            if isinstance(req.get("url"), str):
                req["url"] = req["url"].split("?", 1)[0]
        return _walk(event)
    except Exception:  # pragma: no cover - defensive
        log.exception("sentry before_send scrubbing failed; dropping event")
        return None


def is_enabled() -> bool:
    return _ENABLED


def init_sentry(settings) -> bool:
    """Initialise Sentry if a DSN is configured. Safe to call once at startup;
    a no-op (returns False) when no DSN is set or the SDK is unavailable."""
    global _ENABLED
    dsn = (getattr(settings, "SENTRY_DSN", "") or "").strip()
    if not dsn:
        return False
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.flask import FlaskIntegration
        from sentry_sdk.integrations.logging import LoggingIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
    except Exception:
        log.warning("SENTRY_DSN is set but sentry-sdk is not installed; error monitoring disabled")
        return False

    env = (settings.SENTRY_ENVIRONMENT or os.environ.get("CIBARA_ENV") or "unknown")
    sentry_sdk.init(
        dsn=dsn,
        environment=env,
        release=(settings.SENTRY_RELEASE or None),
        send_default_pii=False,
        max_request_body_size="never",
        traces_sample_rate=float(getattr(settings, "SENTRY_TRACES_SAMPLE_RATE", 0.0) or 0.0),
        before_send=scrub_event,
        integrations=[
            StarletteIntegration(),
            FastApiIntegration(),
            FlaskIntegration(),
            # Don't turn log records into events (noise + PII risk); we capture
            # exceptions explicitly. Breadcrumbs from logs are still useful.
            LoggingIntegration(level=logging.INFO, event_level=None),
        ],
    )
    _ENABLED = True
    log.info("Sentry error monitoring enabled (environment=%s)", env)
    return True


def capture_exception(exc: BaseException) -> None:
    """Report an already-handled exception (e.g. the FastAPI catch-all). No-op
    when Sentry is disabled."""
    if not _ENABLED:
        return
    try:
        import sentry_sdk
        sentry_sdk.capture_exception(exc)
    except Exception:  # pragma: no cover - never let reporting break a response
        log.exception("sentry capture_exception failed")


def report_browser_error(data: dict, *, request_id: str | None = None, user_agent: str = "") -> bool:
    """Forward a browser error (from /api/v2/client-errors) to Sentry as an
    error-level event tagged source=browser. No-op when disabled. Values are
    scrubbed here too; before_send scrubs again as a backstop."""
    if not _ENABLED:
        return False
    try:
        import sentry_sdk
    except Exception:  # pragma: no cover
        return False

    def _s(v: Any) -> Any:
        return scrub_text(v) if isinstance(v, str) else v

    url = (data.get("url") or "")
    if isinstance(url, str):
        url = url.split("?", 1)[0]
    message = _s(data.get("message") or "Browser error")
    with sentry_sdk.new_scope() as scope:
        scope.set_tag("source", "browser")
        if data.get("kind"):
            scope.set_tag("browser.kind", str(data["kind"])[:64])
        if request_id:
            scope.set_tag("request_id", str(request_id)[:64])
        scope.set_context("browser_error", {
            "kind": _s(data.get("kind")),
            "url": _s(url),
            "line": data.get("line"),
            "col": data.get("col"),
            "stack": _s(data.get("stack")),
            "appVersion": _s(data.get("appVersion")),
            "userAgent": _s(user_agent or data.get("userAgent") or ""),
        })
        sentry_sdk.capture_message(message, level="error")
    return True
