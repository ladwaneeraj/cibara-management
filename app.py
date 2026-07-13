from flask import Flask, render_template, send_from_directory, send_file, jsonify, request, Response
from flask_compress import Compress
import mimetypes
from config import (
    initialize_data, logger, db, UPLOAD_FOLDER,
    CIBARA_ENV, FIREBASE_WEB_CONFIG,
)
from routes.rooms import rooms_bp
from routes.bookings import bookings_bp
from routes.billing import billing_bp
from routes.settlements import settlements_bp
from routes.reports import reports_bp
from routes.expense_presets import expense_presets_bp
from routes.ocr import ocr_bp
from routes.customers import customers_bp
from routes.utils import utils_bp
from routes.laundry import laundry_bp
from routes.users import users_bp
from routes.banking import banking_bp
from routes.mmt_ingest import mmt_ingest_bp
from routes.agoda_ingest import agoda_ingest_bp
from routes.bank_settlement import bank_settlement_bp
from routes.maintenance import maintenance_bp
from services.auth_service import load_current_user
from flask import g
import os
import threading
import json

BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, 'static')

app = Flask(__name__,
            static_folder=STATIC_DIR,
            static_url_path='/static',
            template_folder=os.path.join(BASE_DIR, 'templates'))

Compress(app)


# ---------------------------------------------------------------------------
# Static asset cache-busting
# ---------------------------------------------------------------------------
# Browsers cache /static/*.css and *.js aggressively (Flask sends a 12h
# max-age by default), so a deployed CSS/JS change wouldn't show until the
# cache expired or the user manually cleared it. `asset_url` appends the
# file's modification time as a ?v= query, which changes whenever the file
# changes — forcing exactly one reload after each deploy and full caching
# otherwise. Templates use {{ asset_url('style.css') }}.
@app.template_global()
def asset_url(filename: str) -> str:
    try:
        full = os.path.join(STATIC_DIR, filename)
        ver = int(os.path.getmtime(full))
    except OSError:
        ver = 0
    return f"/static/{filename}?v={ver}"

# ---------------------------------------------------------------------------
# Startup warnings for missing env vars (non-fatal locally)
# ---------------------------------------------------------------------------
for _var in ["API_KEY"]:
    if not os.environ.get(_var):
        logger.warning(f"[WARN] Env var {_var} not set - running in dev mode for this feature")

# ---------------------------------------------------------------------------
# Auth: anything not in these lists requires either a valid Firebase ID
# token (preferred — issued via /login) OR the legacy API_KEY header
# (kept for backwards compat with any external integrations). Per-route
# role checks are applied via @requires_permission inside each blueprint.
# ---------------------------------------------------------------------------
_PUBLIC_PREFIXES = ("/static/", "/uploads/", "/firebase-config.js")
_PUBLIC_EXACT    = ("/", "/login", "/health", "/verify-pin")

@app.before_request
def _serve_static():
    if request.path.startswith('/static/'):
        filename = request.path[8:]
        if filename and '..' not in filename:
            filepath = os.path.join(STATIC_DIR, filename)
            if os.path.isfile(filepath):
                mime, _ = mimetypes.guess_type(filepath)
                return send_file(filepath, mimetype=mime or 'application/octet-stream')

@app.before_request
def require_auth():
    """
    Global gate.

    Order of acceptance:
      1. Public path → allow.
      2. Valid Firebase ID token (preferred path — set by the frontend
         via static/auth.js) → allow and stash user on flask.g.
      3. Legacy API_KEY header → allow (kept so external integrations
         and CLI scripts keep working during migration).
      4. Otherwise → 401.

    Per-route ROLE checks happen inside the blueprints via the
    @requires_permission decorator. This middleware only enforces
    authentication, not authorization.
    """
    path = request.path
    if path in _PUBLIC_EXACT:
        return None
    if any(path.startswith(p) for p in _PUBLIC_PREFIXES):
        return None

    # 1b. MMT ingestion endpoint — Cloud Scheduler calls this without a
    # Firebase token. Authenticate via a shared secret header instead, so we
    # don't have to mint tokens for an automated job. Only valid when the
    # secret is configured AND matches; otherwise we fall through to the
    # normal auth paths (a logged-in operator can still trigger it manually).
    if path in ("/mmt/ingest", "/mmt/create_test_booking"):
        _ingest_secret = os.environ.get("MMT_INGEST_SECRET", "")
        if _ingest_secret:
            _provided = request.headers.get("X-Ingest-Secret", "")
            if _provided == _ingest_secret:
                return None

    # 1c. Agoda ingestion endpoint — same shared-secret scheme as MMT. Accepts
    # AGODA_INGEST_SECRET, falling back to MMT_INGEST_SECRET so a single
    # scheduler secret can drive both OTA pollers.
    if path == "/agoda/ingest":
        _agoda_secret = os.environ.get("AGODA_INGEST_SECRET", "") or os.environ.get("MMT_INGEST_SECRET", "")
        if _agoda_secret:
            _provided = request.headers.get("X-Ingest-Secret", "")
            if _provided == _agoda_secret:
                return None

    # 1d. Bank payment-advice settlement endpoint — same shared-secret scheme.
    if path == "/bank/settlements/ingest":
        _bank_secret = os.environ.get("AGODA_INGEST_SECRET", "") or os.environ.get("MMT_INGEST_SECRET", "")
        if _bank_secret:
            _provided = request.headers.get("X-Ingest-Secret", "")
            if _provided == _bank_secret:
                return None

    # 2. Firebase ID token
    user = load_current_user()
    if user:
        g.current_user = user
        return None

    # 3. Legacy API key fallback
    api_key = os.environ.get("API_KEY", "")
    if api_key:
        provided = request.headers.get("X-API-Key", "") or request.args.get("api_key", "")
        if provided == api_key:
            return None
    elif not api_key and request.method == "GET":
        # Dev mode (no API_KEY set, no token): allow GETs so a fresh
        # checkout works on localhost. Mutating verbs still require auth.
        logger.warning("require_auth: dev-mode GET without auth allowed")
        return None

    return jsonify(success=False, message="Unauthorized"), 401

# ---------------------------------------------------------------------------
# Core routes
# ---------------------------------------------------------------------------

@app.route("/login")
def login_page():
    """Server-renders the login page. Frontend (static/login.js) drives the
    actual sign-in via Firebase Auth and redirects to "/" on success."""
    return render_template("login.html")


@app.route("/")
def index():
    # Server-render the initial UI config so visibility flags (e.g.
    # hide_register_tab) are applied on first paint. Without this, the
    # Register tab would briefly flash before the client-side fetch hides
    # it. A read failure here falls back to defaults — the page still
    # renders, just with everything visible.
    try:
        from config import get_ui_config
        ui_cfg = get_ui_config()
    except Exception as e:
        logger.warning(f"index: ui_config read failed, using defaults: {e}")
        ui_cfg = {"hide_register_tab": False}
    return render_template(
        "index.html",
        api_key=os.environ.get("API_KEY", ""),
        ui_config=ui_cfg,
    )

@app.route("/uploads/<path:filename>")
def uploaded_file(filename):
    return send_from_directory(UPLOAD_FOLDER, filename)

@app.route("/health")
def health():
    try:
        db.collection("settings").document("app_settings").get()
        return jsonify(status="healthy", db="connected"), 200
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return jsonify(status="unhealthy", error=str(e)), 503

# ---------------------------------------------------------------------------
# Firebase WEB config — public values, served as JS so the frontend can boot.
#
# Firebase web API keys are intentionally public; they identify the project
# and let the SDK find Auth + Firestore. The actual security boundary is
# Firestore Security Rules + the Auth provider configuration in the
# Firebase console — NOT this key. So shipping a hardcoded fallback for
# local dev is safe and standard.
#
# Order of resolution (env vars win so prod can swap projects without code
# changes; fallback keeps local dev working out of the box):
#   1. environment variable
#   2. hardcoded fallback for the cibara-software-61512 project
# ---------------------------------------------------------------------------
# Web Firebase config served to browsers. The fallback comes from
# config.FIREBASE_WEB_CONFIG (driven by the CIBARA_ENV toggle in config.py),
# so flipping the toggle there flips both Admin SDK and front-end at once.
# Per-field FIREBASE_* env vars still win for one-off overrides on Cloud Run.
_FIREBASE_WEB_FALLBACK = FIREBASE_WEB_CONFIG

@app.route("/firebase-config.js")
def firebase_config_js():
    def pick(env_key, fallback_key):
        return os.environ.get(env_key) or _FIREBASE_WEB_FALLBACK.get(fallback_key, "")

    config = {
        "apiKey":            pick("FIREBASE_WEB_API_KEY",         "apiKey"),
        "authDomain":        pick("FIREBASE_AUTH_DOMAIN",         "authDomain"),
        "projectId":         pick("FIREBASE_PROJECT_ID",          "projectId"),
        "storageBucket":     pick("FIREBASE_STORAGE_BUCKET",      "storageBucket"),
        "messagingSenderId": pick("FIREBASE_MESSAGING_SENDER_ID", "messagingSenderId"),
        "appId":             pick("FIREBASE_APP_ID",              "appId"),
        "measurementId":     pick("FIREBASE_MEASUREMENT_ID",      "measurementId"),
    }
    js = (
        f"// Firebase web config — CIBARA_ENV={CIBARA_ENV} "
        f"(env vars override fallback)\n"
        f"window.FIREBASE_CONFIG = {json.dumps(config)};\n"
    )
    return Response(js, mimetype="application/javascript",
                    headers={"Cache-Control": "no-store"})

# ---------------------------------------------------------------------------
# DEPRECATED: PIN verification.
# Kept as a 410 stub so any cached client that still POSTs here gets a
# clear signal to reload, instead of silently succeeding.
# Authentication has moved to /login (Firebase ID tokens).
# ---------------------------------------------------------------------------
@app.route("/verify-pin", methods=["POST", "GET"])
def verify_pin_deprecated():
    return (
        jsonify(
            success=False,
            deprecated=True,
            message="PIN auth has been replaced by user login. Please reload.",
            redirect="/login",
        ),
        410,
    )

# ---------------------------------------------------------------------------
# Blueprints
# ---------------------------------------------------------------------------
app.register_blueprint(rooms_bp,       url_prefix="")
app.register_blueprint(bookings_bp,    url_prefix="")
app.register_blueprint(billing_bp,     url_prefix="")
app.register_blueprint(settlements_bp, url_prefix="")
app.register_blueprint(reports_bp,     url_prefix="")
app.register_blueprint(expense_presets_bp, url_prefix="")
app.register_blueprint(ocr_bp,             url_prefix="")
app.register_blueprint(customers_bp,   url_prefix="")
app.register_blueprint(utils_bp,       url_prefix="")
app.register_blueprint(laundry_bp,    url_prefix="")
app.register_blueprint(users_bp,      url_prefix="")
app.register_blueprint(banking_bp)    # /banking/* — owns its url_prefix
app.register_blueprint(mmt_ingest_bp, url_prefix="")  # /mmt/ingest, /mmt/ingest_status
app.register_blueprint(agoda_ingest_bp, url_prefix="")  # /agoda/ingest, /agoda/ingest_status
app.register_blueprint(bank_settlement_bp, url_prefix="")  # /bank/settlements/ingest
app.register_blueprint(maintenance_bp)   # /maintenance/* — deep-check rounds, issues, analytics

# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------
@app.errorhandler(404)
def not_found(error):
    return jsonify(success=False, message="Route not found"), 404

@app.errorhandler(500)
def internal_error(error):
    logger.error(f"Internal server error: {error}")
    return jsonify(success=False, message="Internal server error"), 500

# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------
threading.Thread(target=initialize_data, daemon=True).start()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    # threaded=True: the Werkzeug dev server handles ONE request at a
    # time by default, so the ~8 API calls a page fires queue single
    # file — a trivial endpoint then "takes" 9s because it spent 9s
    # waiting, not working. threaded=True serves them concurrently.
    # Local dev only; production is served by gunicorn (gunicorn_config.py).
    app.run(host="0.0.0.0", port=port, threaded=True)
