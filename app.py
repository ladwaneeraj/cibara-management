from flask import Flask, render_template, send_from_directory, jsonify, request
from flask_compress import Compress
from config import initialize_data, logger, db, UPLOAD_FOLDER
from routes.rooms import rooms_bp
from routes.bookings import bookings_bp
from routes.billing import billing_bp
from routes.settlements import settlements_bp
from routes.reports import reports_bp
from routes.customers import customers_bp
from routes.utils import utils_bp
import os
import threading

app = Flask(__name__, static_folder='static', template_folder='templates')

# Gzip-compress all JSON/HTML responses automatically (~70% smaller payloads)
Compress(app)

# ---------------------------------------------------------------------------
# API Key Authentication
# ---------------------------------------------------------------------------
# Set API_KEY env var in Cloud Run (or .env locally).
# All API routes require X-API-Key header or ?api_key= query param.
# Exempt: index page, health probe, static assets, uploads.

_PUBLIC_PREFIXES = ("/static/", "/uploads/")
_PUBLIC_EXACT    = ("/", "/health")

@app.before_request
def require_api_key():
    path = request.path

    # Allow public routes through without a key
    if path in _PUBLIC_EXACT:
        return None
    if any(path.startswith(p) for p in _PUBLIC_PREFIXES):
        return None

    api_key = os.environ.get("API_KEY", "")
    if not api_key:
        # API_KEY not configured — allow all (dev mode, log a warning once)
        logger.warning("API_KEY env var not set — all routes are unprotected")
        return None

    provided = (
        request.headers.get("X-API-Key", "")
        or request.args.get("api_key", "")
    )
    if provided != api_key:
        return jsonify(success=False, message="Unauthorized"), 401

# ---------------------------------------------------------------------------
# Core routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/static/<path:path>")
def serve_static(path):
    return send_from_directory("static", path)

@app.route("/uploads/<path:filename>")
def uploaded_file(filename):
    return send_from_directory(UPLOAD_FOLDER, filename)

@app.route("/health")
def health():
    """Liveness / readiness probe for load balancers and monitoring."""
    try:
        # Quick Firestore ping — read a tiny doc
        db.collection("settings").document("app_settings").get()
        return jsonify(status="healthy", db="connected"), 200
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return jsonify(status="unhealthy", error=str(e)), 503


# ---------------------------------------------------------------------------
# Register blueprints
# ---------------------------------------------------------------------------
app.register_blueprint(rooms_bp, url_prefix="")
app.register_blueprint(bookings_bp, url_prefix="")
app.register_blueprint(billing_bp, url_prefix="")
app.register_blueprint(settlements_bp, url_prefix="")
app.register_blueprint(reports_bp, url_prefix="")
app.register_blueprint(customers_bp, url_prefix="")
app.register_blueprint(utils_bp, url_prefix="")

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

# Background initialization (non-blocking)
threading.Thread(target=initialize_data, daemon=True).start()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
