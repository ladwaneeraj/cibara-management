from flask import Flask, render_template, send_from_directory, send_file, jsonify, request, Response
from flask_compress import Compress
import mimetypes
from config import initialize_data, logger, db, UPLOAD_FOLDER
from routes.rooms import rooms_bp
from routes.bookings import bookings_bp
from routes.billing import billing_bp
from routes.settlements import settlements_bp
from routes.reports import reports_bp
from routes.customers import customers_bp
from routes.utils import utils_bp
from routes.laundry import laundry_bp
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
# Startup warnings for missing env vars (non-fatal locally)
# ---------------------------------------------------------------------------
for _var in ["API_KEY", "MANAGER_PASSWORD", "LODGE_PIN"]:
    if not os.environ.get(_var):
        logger.warning(f"⚠️  Env var {_var} not set — running in dev mode for this feature")

# ---------------------------------------------------------------------------
# API Key auth
# ---------------------------------------------------------------------------
_PUBLIC_PREFIXES = ("/static/", "/uploads/", "/firebase-config.js")
_PUBLIC_EXACT    = ("/", "/health", "/verify-pin")

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
def require_api_key():
    path = request.path
    if path in _PUBLIC_EXACT:
        return None
    if any(path.startswith(p) for p in _PUBLIC_PREFIXES):
        return None
    api_key = os.environ.get("API_KEY", "")
    if not api_key:
        logger.warning("API_KEY not set — all routes unprotected (dev mode)")
        return None
    provided = request.headers.get("X-API-Key", "") or request.args.get("api_key", "")
    if provided != api_key:
        return jsonify(success=False, message="Unauthorized"), 401

# ---------------------------------------------------------------------------
# Core routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html", api_key=os.environ.get("API_KEY", ""))

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
# Firebase config — keys served from env vars, never hardcoded in git
# Falls back to empty strings locally (google_sync.js keeps its own hardcoded
# fallback for local dev so realtime sync still works without env vars)
# ---------------------------------------------------------------------------
@app.route("/firebase-config.js")
def firebase_config_js():
    config = {
        "apiKey":            os.environ.get("FIREBASE_WEB_API_KEY", ""),
        "authDomain":        os.environ.get("FIREBASE_AUTH_DOMAIN", ""),
        "projectId":         os.environ.get("FIREBASE_PROJECT_ID", ""),
        "storageBucket":     os.environ.get("FIREBASE_STORAGE_BUCKET", ""),
        "messagingSenderId": os.environ.get("FIREBASE_MESSAGING_SENDER_ID", ""),
        "appId":             os.environ.get("FIREBASE_APP_ID", ""),
        "measurementId":     os.environ.get("FIREBASE_MEASUREMENT_ID", ""),
    }
    js = "// Firebase config from server env vars\nwindow.FIREBASE_CONFIG = " + json.dumps(config) + ";\n"
    return Response(js, mimetype="application/javascript", headers={"Cache-Control": "no-store"})

# ---------------------------------------------------------------------------
# PIN verification
# If LODGE_PIN env var not set → dev mode, grants access automatically
# ---------------------------------------------------------------------------
@app.route("/verify-pin", methods=["POST"])
def verify_pin():
    expected = str(os.environ.get("LODGE_PIN", "")).strip()
    if not expected:
        # Dev mode: no PIN configured → let them in
        return jsonify(success=True, dev=True)
    data = request.get_json(silent=True) or {}
    submitted = str(data.get("pin", "")).strip()
    if not submitted:
        return jsonify(success=False, message="PIN required"), 400
    if submitted == expected:
        return jsonify(success=True)
    logger.warning(f"Failed PIN attempt from {request.remote_addr}")
    return jsonify(success=False, message="Incorrect PIN"), 401

# ---------------------------------------------------------------------------
# Blueprints
# ---------------------------------------------------------------------------
app.register_blueprint(rooms_bp,       url_prefix="")
app.register_blueprint(bookings_bp,    url_prefix="")
app.register_blueprint(billing_bp,     url_prefix="")
app.register_blueprint(settlements_bp, url_prefix="")
app.register_blueprint(reports_bp,     url_prefix="")
app.register_blueprint(customers_bp,   url_prefix="")
app.register_blueprint(utils_bp,       url_prefix="")
app.register_blueprint(laundry_bp,    url_prefix="")

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
    app.run(host="0.0.0.0", port=port)
