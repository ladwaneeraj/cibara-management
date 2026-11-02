# ─────────────────────────────────────────────────────────────────────────────
# Cibara ERP — FastAPI + React (Cloud Run)
#
# Stage 1 builds the React SPA; stage 2 is the Python runtime serving
#   /api/v2/*  FastAPI     /app/*  the SPA     everything else  the unchanged
#   Flask app (legacy routes, /legacy UI, /static, OTA ingest endpoints).
#
# Rollback: Dockerfile.flask is the previous gunicorn/Flask image, byte-for-byte.
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.11-slim

# Same system packages as before: xhtml2pdf / pycairo (bill PDFs).
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config libcairo2-dev libxml2-dev libxslt1-dev \
    libjpeg-dev zlib1g-dev libffi-dev libssl-dev libpango-1.0-0 libpangocairo-1.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app:/app/backend \
    PORT=8080

COPY requirements.txt ./requirements.txt
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --upgrade pip && pip install -r backend/requirements.txt

COPY . .
COPY --from=web /web/dist ./frontend/dist

# Run unprivileged. The legacy code writes lodge.log and uploads/ relative to
# the working directory, so /app stays writable for this user.
RUN useradd --create-home --uid 10001 app && chown -R app:app /app
USER app

EXPOSE 8080
# One worker on purpose: rate limits, session revocation and the legacy
# in-process caches live in memory. Requests run concurrently on the event
# loop + thread pool (sync Firestore calls go to threads, as before).
CMD exec uvicorn cibara_api.main:app --host 0.0.0.0 --port ${PORT} --workers 1 \
    --timeout-keep-alive 75 --no-server-header
