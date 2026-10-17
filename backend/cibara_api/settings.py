"""
Runtime settings for the FastAPI layer.

Everything the legacy Flask app reads from the environment (CIBARA_ENV,
FIREBASE_CREDENTIALS, GEMINI_API_KEY, the OTA ingest secrets, …) is still read
by config.py exactly as before. This module only adds what the new layer needs.
"""
from __future__ import annotations

import logging
import os
import secrets
from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger("cibara_api.settings")

REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="", extra="ignore", case_sensitive=True)

    # ── JWT ────────────────────────────────────────────────────────────────
    # HS256 signing secret. REQUIRED on Cloud Run (startup fails without it);
    # locally a random per-process secret is generated so dev "just works"
    # (every restart then signs everyone out, which is fine for dev).
    JWT_SECRET: str = Field(default="")
    # Alternative to JWT_SECRET: read the signing secret from a file. This is
    # the Secret Manager "mounted volume" pattern on Cloud Run — the secret
    # never appears in the environment (safer than an env var, which leaks via
    # /proc and the metadata server). Used only when JWT_SECRET is not set.
    JWT_SECRET_FILE: str = ""
    JWT_ISSUER: str = "cibara-api"
    ACCESS_TOKEN_TTL_SECONDS: int = 15 * 60
    REFRESH_TOKEN_TTL_SECONDS: int = 7 * 24 * 60 * 60

    # ── Refresh cookie ────────────────────────────────────────────────────
    REFRESH_COOKIE_NAME: str = "cibara_rt"
    REFRESH_COOKIE_PATH: str = "/api/v2/auth"
    # None → secure when running on Cloud Run (K_SERVICE set), else False so
    # http://localhost works.
    REFRESH_COOKIE_SECURE: bool | None = None
    REFRESH_COOKIE_SAMESITE: str = "strict"

    # ── Firebase Auth password check (Identity Toolkit REST) ──────────────
    # Defaults to the active CIBARA_ENV web apiKey from config.py.
    FIREBASE_WEB_API_KEY: str = ""
    IDENTITY_TOOLKIT_URL: str = "https://identitytoolkit.googleapis.com/v1"
    # Sent as Referer on the server-side sign-in call. Only matters if the
    # web API key has HTTP-referrer restrictions in the GCP console.
    PUBLIC_ORIGIN: str = ""

    # ── Rate limits (in-memory, per Cloud Run instance) ───────────────────
    RATE_LIMIT_GLOBAL_PER_MIN: int = 600
    RATE_LIMIT_LOGIN_PER_IP_PER_MIN: int = 20  # desks share one NAT IP
    RATE_LIMIT_LOGIN_PER_USER_PER_15MIN: int = 8
    RATE_LIMIT_WRITES_PER_USER_PER_MIN: int = 120
    # How many proxy hops append to X-Forwarded-For in front of the app.
    # Cloud Run's front end appends exactly one entry (the real client IP).
    TRUSTED_PROXY_HOPS: int = 1

    # ── Legacy bridge ─────────────────────────────────────────────────────
    # Enforce permissions on legacy routes that the Flask code leaves ungated
    # (see security/legacy_hardening.py). Only applies to requests that carry
    # a user identity; API-key callers are unaffected.
    LEGACY_RBAC_HARDENING: bool = True
    LEGACY_WSGI_WORKERS: int = 16

    # ── Frontend ──────────────────────────────────────────────────────────
    # "classic": the original Flask/Jinja screens are the UI ("/" and
    #            "/login"), signed in through /api/v2/auth. Default.
    # "spa":     the React app at /app is the UI ("/" and "/login" redirect
    #            there). Kept so the switch is an env var, not a code change.
    UI_MODE: str = "classic"
    FRONTEND_DIST: str = str(REPO_ROOT / "frontend" / "dist")
    # Dev only: allow the Vite dev server origin. Empty in production
    # (same-origin, no CORS needed).
    CORS_ORIGINS: str = ""

    SLOW_REQUEST_MS: int = 1500

    # Classic-UI Content-Security-Policy mode: "enforce" (default), "report-only"
    # (send Content-Security-Policy-Report-Only so violations are visible in the
    # console/Sentry without breaking the page — use this to vet the policy after
    # a template change), or "off". The SPA CSP on /app is always enforced and is
    # unaffected by this. The classic policy keeps 'unsafe-inline' for scripts
    # because the Jinja pages carry inline <script> blocks and handlers.
    CLASSIC_CSP: str = "enforce"

    # ── Invoice (cibara_api/invoice) ──────────────────────────────────────
    # "v2": GST invoice layout v2 for every bill surface (modal, print, PDF,
    # share). "legacy": the original routes.billing renderer, untouched.
    INVOICE_LAYOUT: str = "v2"
    # "by_supply": TAX INVOICE / BILL OF SUPPLY / INVOICE-CUM-BILL OF SUPPLY by
    # what was supplied (Rules 46, 46A, 49). "tax_invoice": always TAX INVOICE.
    INVOICE_TITLE_RULE: str = "by_supply"
    # Supply-based titles apply only to bills checked out on/after this date
    # (YYYY-MM-DD). Empty = off: every bill stays TAX INVOICE, as before. Set it
    # once your CA confirms; earlier invoices keep their issued title.
    INVOICE_TITLE_BY_SUPPLY_FROM: str = ""

    # Absolute session lifetime: a refresh-token family (one login) cannot be
    # extended past this, however often it is rotated.
    SESSION_MAX_DAYS: int = 30

    # ── Error monitoring (Sentry) ─────────────────────────────────────────
    # OFF unless SENTRY_DSN is set, so it is silent locally and in tests. When
    # set, unhandled exceptions (FastAPI + the mounted legacy Flask app), 5xx
    # responses and browser errors (forwarded to /api/v2/client-errors) are
    # reported — with PII scrubbed (see core/observability.py). Never sends
    # request bodies, cookies or credentials.
    SENTRY_DSN: str = ""
    # Tag for events; defaults to CIBARA_ENV when empty.
    SENTRY_ENVIRONMENT: str = ""
    # Release identifier (e.g. the Cloud Run revision or a git sha). Optional.
    SENTRY_RELEASE: str = ""
    # Performance tracing sample rate. 0.0 = error monitoring only (default).
    SENTRY_TRACES_SAMPLE_RATE: float = 0.0

    @property
    def on_cloud_run(self) -> bool:
        return bool(os.environ.get("K_SERVICE"))

    @property
    def cookie_secure(self) -> bool:
        if self.REFRESH_COOKIE_SECURE is not None:
            return self.REFRESH_COOKIE_SECURE
        return self.on_cloud_run

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()]


def _read_secret_file(path: str) -> str:
    """Read a secret from a file (e.g. a Secret Manager volume mount). Trailing
    newlines are stripped. Raises if the path is set but unreadable."""
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except OSError as e:
        raise RuntimeError(f"JWT_SECRET_FILE is set but unreadable: {path} ({e})") from e


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    # Prefer a mounted secret file over an env var when JWT_SECRET is not set.
    if not s.JWT_SECRET and s.JWT_SECRET_FILE:
        s.JWT_SECRET = _read_secret_file(s.JWT_SECRET_FILE)
    if not s.JWT_SECRET:
        if s.on_cloud_run:
            raise RuntimeError(
                "JWT_SECRET is not set. Bind it in the Cloud Run console "
                "(Variables & Secrets), or mount a Secret Manager secret and "
                "point JWT_SECRET_FILE at it — use a random value of 32+ bytes."
            )
        s.JWT_SECRET = secrets.token_urlsafe(48)
        log.warning("JWT_SECRET not set — using a random per-process dev secret")
    if len(s.JWT_SECRET) < 32:
        raise RuntimeError("JWT_SECRET must be at least 32 characters")
    return s
