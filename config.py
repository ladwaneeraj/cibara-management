"""
Shared configuration and utilities for the Flask app.
Contains Firebase initialization, collection references, cache, and helper functions.
"""

from datetime import datetime, timedelta
import json
import os
import logging
import uuid
import firebase_admin
from firebase_admin import credentials, firestore, storage
from functools import wraps
import threading
import pytz
import base64

from services import payment_service, customer_service, pdf_service, expense_service, bills_service, expense_presets_service, ocr_service
from services.banking import init_banking

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.FileHandler("lodge.log"), logging.StreamHandler()]
)
logger = logging.getLogger(__name__)

# Initialize Indian Timezone
IST = pytz.timezone('Asia/Kolkata')

# Global cache for frequently accessed data
_cache = {}
_cache_lock = threading.Lock()
CACHE_TTL = 5  # seconds

# ══════════════════════════════════════════════════════════════════════════
# ENVIRONMENT TOGGLE
# ══════════════════════════════════════════════════════════════════════════
# Single switch that decides which Firebase project the whole app talks to —
# both the Admin SDK (this file) and the front-end Firebase web SDK (served
# from /firebase-config.js in app.py).
#
# To switch locally, change DEFAULT_CIBARA_ENV below. To switch on Cloud Run
# / CI without editing code, set the CIBARA_ENV environment variable.
#
#   CIBARA_ENV = "PROD"  → talks to cibara-software-61512  (live customers)
#   CIBARA_ENV = "UAT"   → talks to cibara-dev             (testing)
#
# Each env entry holds:
#   key_file   – path to the Admin SDK service-account JSON for that project
#                (gitignored via cibara-*.json)
#   web_config – the Firebase web app config served to browsers. Get this
#                from Firebase Console → Project Settings → "Your apps" →
#                Web app config.
# ══════════════════════════════════════════════════════════════════════════

DEFAULT_CIBARA_ENV = "UAT"  # ← change this to flip local default

ENVIRONMENTS = {
    "PROD": {
        "key_file": "cibara-software-Prod.json",
        "web_config": {
            "apiKey":            "AIzaSyAj_K8Bq8IA0mYH94pu03s3DeDxc2pyCF4",
            "authDomain":        "cibara-software-61512.firebaseapp.com",
            "projectId":         "cibara-software-61512",
            "storageBucket":     "cibara-software-61512.firebasestorage.app",
            "messagingSenderId": "117552649945",
            "appId":             "1:117552649945:web:5d4983739b1a8c077e50c8",
            "measurementId":     "G-5VY26JYPN0",
        },
    },
    "UAT": {
        "key_file": "cibara-dev.json",
        # Web config from Firebase Console → cibara-dev → Project settings.
        # These values are public (the apiKey is exposed in the browser to
        # every visitor of /firebase-config.js); committing them is safe.
        # The corresponding private key is in cibara-dev.json which IS
        # gitignored via the cibara-*.json pattern.
        "web_config": {
            "apiKey":            "AIzaSyBikK4mEIEkUWe9zfSdro__0oqNYH3juek",
            "authDomain":        "cibara-dev.firebaseapp.com",
            "projectId":         "cibara-dev",
            "storageBucket":     "cibara-dev.firebasestorage.app",
            "messagingSenderId": "192930036248",
            "appId":             "1:192930036248:web:db63f04b3f1103d45ea16d",
            "measurementId":     "G-R4HLKKJCJ4",
        },
    },
}

# Cloud Run safety: when we're running on Cloud Run (it sets K_SERVICE
# automatically) and CIBARA_ENV is not explicitly set, refuse to start
# rather than silently fall back to DEFAULT_CIBARA_ENV. This prevents the
# scenario where a deploy lands without env vars configured and the
# production service silently flips to dev (or vice-versa). Local dev is
# unaffected — the K_SERVICE env var only exists on Cloud Run.
if os.environ.get("K_SERVICE") and not os.environ.get("CIBARA_ENV"):
    raise RuntimeError(
        "Refusing to start on Cloud Run without CIBARA_ENV set. "
        "Set CIBARA_ENV=PROD (or UAT) as a service env variable in the "
        "Cloud Run console — DEFAULT_CIBARA_ENV is for local dev only."
    )

CIBARA_ENV = (os.environ.get("CIBARA_ENV") or DEFAULT_CIBARA_ENV).upper()
if CIBARA_ENV not in ENVIRONMENTS:
    raise RuntimeError(
        f"Unknown CIBARA_ENV={CIBARA_ENV!r} — must be one of "
        f"{sorted(ENVIRONMENTS.keys())}"
    )
ACTIVE_ENV = ENVIRONMENTS[CIBARA_ENV]
FIREBASE_WEB_CONFIG = dict(ACTIVE_ENV["web_config"])  # exported for app.py


# ── Firebase Admin SDK initialisation ──────────────────────────────────────
# Credential resolution order (first hit wins):
#   1. FIREBASE_CREDENTIALS env var — base64-encoded service-account JSON
#      (Cloud Run / production).
#   2. FIREBASE_KEY_FILE env var — explicit path; wins over the env-toggle.
#   3. ACTIVE_ENV["key_file"] from the toggle above.
#   4. service-account.json — legacy local-prod path, kept for back-compat.
try:
    cred_dict = None
    cred_source = None

    if 'FIREBASE_CREDENTIALS' in os.environ:
        cred_json = base64.b64decode(
            os.environ.get('FIREBASE_CREDENTIALS')
        ).decode('utf-8')
        cred_dict = json.loads(cred_json)
        cred_source = "env:FIREBASE_CREDENTIALS"
    else:
        _key_path_env = os.environ.get('FIREBASE_KEY_FILE')
        _candidate_files = []
        if _key_path_env:
            _candidate_files.append(_key_path_env)
        _candidate_files.append(ACTIVE_ENV["key_file"])
        _candidate_files.append('service-account.json')

        _picked = None
        for _p in _candidate_files:
            if _p and os.path.isfile(_p):
                _picked = _p
                break

        if not _picked:
            raise FileNotFoundError(
                f"No Firebase credentials found for CIBARA_ENV={CIBARA_ENV!r}. "
                f"Tried: {_candidate_files}. "
                f"Place {ACTIVE_ENV['key_file']!r} in the project root, set "
                f"FIREBASE_KEY_FILE=<path>, or set FIREBASE_CREDENTIALS to "
                f"the base64-encoded JSON."
            )

        with open(_picked, 'r', encoding='utf-8') as _fh:
            cred_dict = json.load(_fh)
        cred_source = f"file:{_picked}"

    cred = credentials.Certificate(cred_dict)

    # Sanity check: cred's project_id should match the toggle's expected
    # project. A mismatch usually means the wrong key file was dropped in.
    _project_id = cred_dict.get('project_id') or ''
    _expected_project = ACTIVE_ENV["web_config"].get("projectId", "")
    if _expected_project and _project_id and _project_id != _expected_project:
        raise RuntimeError(
            f"Firebase project mismatch: CIBARA_ENV={CIBARA_ENV!r} expects "
            f"projectId={_expected_project!r} but the loaded credential "
            f"({cred_source}) is for {_project_id!r}. Either swap key files "
            f"or update ENVIRONMENTS in config.py."
        )

    storage_bucket = (
        os.environ.get('FIREBASE_STORAGE_BUCKET')
        or ACTIVE_ENV["web_config"].get("storageBucket")
        or (f"{_project_id}.firebasestorage.app" if _project_id else None)
    )
    if not storage_bucket:
        raise RuntimeError(
            "Could not determine Firebase storage bucket — set "
            "FIREBASE_STORAGE_BUCKET or fix ACTIVE_ENV.web_config.storageBucket."
        )

    firebase_admin.initialize_app(cred, {'storageBucket': storage_bucket})

    db = firestore.client()
    bucket = storage.bucket()
    logger.info(
        f"Firebase initialised — env={CIBARA_ENV} project={_project_id!r} "
        f"bucket={storage_bucket!r} source={cred_source}"
    )

    # Initialise optimisation services (payments + customers + pdf + expenses collections)
    payment_service.init(db)
    customer_service.init(db)
    pdf_service.init(db)
    expense_service.init(db)
    expense_presets_service.init(db)
    # OCR — Gemini client. init() reads GEMINI_API_KEY from env; if it's
    # absent the service stays disabled and the /ocr endpoints return
    # {"success": False, "reason": "ocr_disabled"} instead of crashing.
    ocr_service.init()
    # Phase 1 of the stay_id migration — adds the bills/stay-document helper.
    # Additive, no behaviour change. See docs/STAY_DOC_CONTRACT.md.
    bills_service.init(db)
    # Banking package — cash receipts, deposits, adjustments, bank
    # accounts. Adds five new Firestore collections plus a bill_events
    # audit log. Initialiser is idempotent.
    init_banking(db)
except Exception as e:
    logger.error(f"Error initializing Firebase: {str(e)}")
    raise

# Define Firestore collection references
rooms_ref = db.collection('rooms')
logs_ref = db.collection('logs')
totals_ref = db.collection('totals')
bookings_ref = db.collection('bookings')
settings_ref = db.collection('settings')
settlements_ref     = db.collection('settlements')      # hotel-side "settle later" only
ota_settlements_ref = db.collection('ota_settlements')   # MMT / OTA bank settlements
counters_ref = db.collection('daily_counters')
metadata_ref = db.collection('transaction_metadata')
bills_ref = db.collection('bills')
expenses_ref = db.collection('expenses')
credit_notes_ref = db.collection('credit_notes')        # Section 34 CGST credit notes
audit_logs_ref = db.collection('audit_logs')            # mirrors AUDIT_COLLECTION

# Upload folder
UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Cache decorator
def cached(ttl=CACHE_TTL):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            cache_key = f"{func.__name__}_{str(args)}_{str(kwargs)}"
            with _cache_lock:
                if cache_key in _cache:
                    cached_data, timestamp = _cache[cache_key]
                    if (datetime.now() - timestamp).total_seconds() < ttl:
                        return cached_data

            result = func(*args, **kwargs)

            with _cache_lock:
                _cache[cache_key] = (result, datetime.now())

            return result
        return wrapper
    return decorator

# Optimized data retrieval with caching
@cached(ttl=30)
def get_all_rooms():
    """Get all rooms with caching — 30s TTL since rooms change infrequently"""
    rooms_dict = {}
    rooms_stream = rooms_ref.stream()
    for room_doc in rooms_stream:
        rooms_dict[room_doc.id] = room_doc.to_dict()
    return rooms_dict

@cached(ttl=15)
def get_totals():
    """Get totals with caching"""
    totals_doc = totals_ref.document('current_totals').get()
    if totals_doc.exists:
        totals = totals_doc.to_dict()
        required_totals = ["cash", "online", "balance", "refunds", "advance_bookings", "expenses"]
        for total_type in required_totals:
            if total_type not in totals:
                totals[total_type] = 0
        return totals
    return {"cash": 0, "online": 0, "balance": 0, "refunds": 0, "advance_bookings": 0, "expenses": 0}

def invalidate_cache(cache_keys=None):
    """Invalidate specific cache keys or all cache"""
    with _cache_lock:
        if cache_keys:
            for key in cache_keys:
                _cache.pop(key, None)
        else:
            _cache.clear()


def invalidate_rooms_and_totals():
    """Targeted invalidation for room/payment operations (most common case).
    Clears rooms + totals cache entries."""
    with _cache_lock:
        keys_to_remove = [k for k in _cache
                          if 'get_all_rooms' in k or 'get_totals' in k]
        for k in keys_to_remove:
            del _cache[k]


# ── Billing config ─────────────────────────────────────────────────────────────
# A single Firestore doc (`settings/billing_config`) holds tenant-wide toggles
# that affect bill generation. Currently:
#   - always_generate_bill (bool, default False):
#       True  → generate a bill for every stay regardless of payment mode.
#       False → skip the bill when the entire stay (room + every service/addon)
#               was paid in cash. Note: the OTA branches (pure MMT room stays,
#               Booking.com) are intentionally unaffected by this flag — they
#               are about WHO issues the invoice, not about payment mode.
#
# The 5-second TTL on get_billing_config() keeps create_bill_record() fast
# while still propagating a flip from another device within a few seconds.
# When the toggle is changed via /settings/billing_config (POST), the caller
# invalidates this cache explicitly via invalidate_billing_config_cache().

_BILLING_CONFIG_DEFAULTS = {
    # G4: default to True so every taxable supply gets a sequential bill
    # number and an invoice flag, regardless of payment mode. Rule 46(a)
    # CGST Rules requires a tax invoice for every supply by a registered
    # supplier; the prior False default suppressed bill numbers for
    # all-cash stays which technically violated the rule.
    # An operator can still flip this back to False via the settings UI
    # if they explicitly want the legacy "cash-only stays don't get a
    # numbered bill" behaviour, but the safe default is True.
    "always_generate_bill": True,
}


@cached(ttl=5)
def get_billing_config():
    """Return the billing-config doc as a plain dict.

    Always returns a dict with all known keys filled in (so callers can do
    `cfg.get("always_generate_bill")` without worrying about missing keys
    on a fresh install). Read failures fall back to defaults rather than
    raising, so a transient Firestore blip cannot break checkout.
    """
    try:
        doc = settings_ref.document('billing_config').get()
        data = doc.to_dict() if doc.exists else {}
    except Exception as e:
        logger.warning(f"get_billing_config: read failed, using defaults: {e}")
        data = {}
    merged = dict(_BILLING_CONFIG_DEFAULTS)
    if isinstance(data, dict):
        for k in _BILLING_CONFIG_DEFAULTS:
            if k in data:
                merged[k] = data[k]
    return merged


def invalidate_billing_config_cache():
    """Drop the cached billing config so the next read sees fresh values."""
    with _cache_lock:
        keys_to_remove = [k for k in _cache if 'get_billing_config' in k]
        for k in keys_to_remove:
            del _cache[k]


# ── UI config ─────────────────────────────────────────────────────────────────
# Tenant-wide UI visibility flags. Stored in `settings/ui_config`. Currently:
#   - hide_register_tab (bool, default False):
#       True  → the Register tab is hidden from the navigation on every device.
#               Frontend honours this both at server render time (no flash) and
#               via a Firestore onSnapshot listener for live cross-browser sync.
#       False → default; Register tab visible.
#
# Kept in a separate doc from billing_config so concerns don't mix and a UI
# toggle change doesn't bust the billing-config cache.

_UI_CONFIG_DEFAULTS = {
    "hide_register_tab": False,
}


@cached(ttl=5)
def get_ui_config():
    """Return the ui-config doc as a plain dict with all known keys filled in.

    Read failures fall back to defaults so a Firestore blip never crashes
    page-render or settings reads.
    """
    try:
        doc = settings_ref.document('ui_config').get()
        data = doc.to_dict() if doc.exists else {}
    except Exception as e:
        logger.warning(f"get_ui_config: read failed, using defaults: {e}")
        data = {}
    merged = dict(_UI_CONFIG_DEFAULTS)
    if isinstance(data, dict):
        for k in _UI_CONFIG_DEFAULTS:
            if k in data:
                merged[k] = data[k]
    return merged


def invalidate_ui_config_cache():
    """Drop the cached ui config so the next read sees fresh values."""
    with _cache_lock:
        keys_to_remove = [k for k in _cache if 'get_ui_config' in k]
        for k in keys_to_remove:
            del _cache[k]


def get_last_rent_check():
    settings_doc = settings_ref.document('app_settings').get()
    if settings_doc.exists:
        settings = settings_doc.to_dict()
        return settings.get('last_rent_check', datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"))
    return datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")

def update_last_rent_check():
    settings_ref.document('app_settings').update({
        'last_rent_check': datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")
    })

# Serial number management
def get_next_serial_number(date_str):
    """Get next serial number with transaction"""
    counter_ref = counters_ref.document(date_str)
    transaction = db.transaction()

    @firestore.transactional
    def update_in_transaction(transaction, counter_ref):
        snapshot = counter_ref.get(transaction=transaction)
        if snapshot.exists:
            new_count = snapshot.get('count') + 1
        else:
            new_count = 1
        transaction.set(counter_ref, {'count': new_count})
        return new_count

    return update_in_transaction(transaction, counter_ref)

def store_transaction_metadata(room, date, serial_number, transaction_type="checkin"):
    """Store metadata asynchronously"""
    def _store():
        try:
            key = f"{date}_{room}"
            metadata_ref.document(key).set({
                'serial_number': serial_number,
                'transaction_type': transaction_type,
                'timestamp': datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")
            })
        except Exception as e:
            logger.error(f"Error storing metadata: {str(e)}")

    threading.Thread(target=_store, daemon=True).start()

def cleanup_old_counters():
    """Cleanup old counters in background"""
    try:
        cutoff_date = (datetime.now(IST) - timedelta(days=30)).strftime("%Y-%m-%d")
        batch = db.batch()

        old_counters = counters_ref.where('__name__', '<', cutoff_date).limit(500).stream()
        for counter in old_counters:
            batch.delete(counter.reference)

        old_metadata = metadata_ref.where('__name__', '<', cutoff_date).limit(500).stream()
        for metadata in old_metadata:
            batch.delete(metadata.reference)

        batch.commit()
        logger.info("Cleaned up old daily counters and metadata")
    except Exception as e:
        logger.error(f"Error cleaning up old counters: {str(e)}")

def is_log_from_current_stay(log, checkin_time):
    """
    Check if a log entry is from the current guest stay.
    Returns False for logs with no date (cannot confirm they belong to this stay).
    """
    try:
        log_date = log.get("date")
        log_time = log.get("time", "00:00")

        if not log_date:
            return False  # No date = cannot confirm it belongs to this stay

        # Handle different time formats
        if len(log_time) == 5:  # HH:MM
            log_datetime = datetime.strptime(f"{log_date} {log_time}", "%Y-%m-%d %H:%M")
        else:
            log_datetime = datetime.strptime(log_date, "%Y-%m-%d")

        return log_datetime >= checkin_time

    except Exception as e:
        logger.error(f"Error parsing log datetime: {str(e)}")
        return False

def initialize_data():
    """Lazy initialization - runs in background"""
    logger.info("Checking Firebase data structure...")
    try:
        settings_doc = settings_ref.document('app_settings').get()
        if not settings_doc.exists:
            settings_ref.document('app_settings').set({
                'last_rent_check': datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")
            })

        rooms_count = len(list(rooms_ref.limit(1).stream()))
        if rooms_count == 0:
            logger.info("Creating default room structure in background...")
            threading.Thread(target=create_default_structure, daemon=True).start()

        return True
    except Exception as e:
        logger.error(f"Error initializing Firebase data: {str(e)}")
        return False

def create_default_structure():
    """Create default room structure in background"""
    try:
        first_floor_rooms = list(range(1, 6)) + list(range(13, 21)) + list(range(23, 28))
        second_floor_rooms = list(range(200, 229))

        batch = db.batch()
        batch_count = 0

        for num in first_floor_rooms + second_floor_rooms:
            room_ref = rooms_ref.document(str(num))
            batch.set(room_ref, {
                "status": "vacant",
                "guest": None,
                "checkin_time": None,
                "balance": 0,
                "add_ons": [],
                "renewal_count": 0,
                "last_renewal_time": None,
                "cleaning_status": None,
                "cleaning_start_time": None
            })
            batch_count += 1

            if batch_count >= 400:
                batch.commit()
                batch = db.batch()
                batch_count = 0

        if batch_count > 0:
            batch.commit()

        log_types = ["cash", "online", "balance", "add_ons", "refunds", "renewals",
                    "booking_payments", "discounts", "expenses", "room_shifts"]
        batch = db.batch()
        for log_type in log_types:
            batch.set(logs_ref.document(log_type), {"entries": []})
        batch.commit()

        totals_ref.document('current_totals').set({
            "cash": 0, "online": 0, "balance": 0, "refunds": 0,
            "advance_bookings": 0, "expenses": 0
        })

        logger.info("Default data structure created successfully")
    except Exception as e:
        logger.error(f"Error creating default structure: {str(e)}")


def send_whatsapp_message(phone_number, message):
    """
    Send WhatsApp message via Twilio
    Requires: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER env variables
    """
    try:
        from twilio.rest import Client

        account_sid = os.environ.get('TWILIO_ACCOUNT_SID')
        auth_token = os.environ.get('TWILIO_AUTH_TOKEN')
        twilio_whatsapp_number = os.environ.get('TWILIO_WHATSAPP_NUMBER', 'whatsapp:+14155552671')

        if not account_sid or not auth_token:
            logger.warning("Twilio credentials not configured")
            return False

        client = Client(account_sid, auth_token)

        msg = client.messages.create(
            from_=twilio_whatsapp_number,
            body=message,
            to=f"whatsapp:+{phone_number}"
        )

        logger.info(f"WhatsApp message sent via Twilio: {msg.sid}")
        return True

    except Exception as e:
        logger.error(f"Error sending WhatsApp via Twilio: {str(e)}")
        return False

def create_bill_record(room, room_data, checkout_time, batch=None,
                       settle_later=False, settlement_id=None):
    """
    Create bill record with original check-in serial number.
    Reads from payments collection as primary data source.
    If settle_later=True the bill is stored with status='pending_settlement'
    and settlement_id is embedded so it can be updated when collected.

    OPTIMISED: the three independent Firestore reads (payments, metadata doc,
    booking-source lookup) now run concurrently via ThreadPoolExecutor.
    Serial number is extracted from the already-fetched payments list instead
    of making a duplicate query via find_serial_number().
    """
    from concurrent.futures import ThreadPoolExecutor as _TPE
    try:
        guest = room_data.get("guest")
        if not guest:
            return None

        checkin_time = room_data.get("checkin_time")
        if not checkin_time:
            return None

        checkin_dt = datetime.strptime(checkin_time, "%Y-%m-%d %H:%M")
        checkout_dt = datetime.strptime(checkout_time, "%Y-%m-%d %H:%M")
        checkin_date_str = checkin_dt.strftime("%Y-%m-%d")

        # ── Parallel Firestore reads ──────────────────────────────────────────
        # Previously: query_payments_for_stay → find_serial_number (which
        # re-runs query_payments_for_stay internally) → metadata get → booking
        # query — all sequential, 4-6 round-trips.
        # Now: all three independent reads fire at once, serial is extracted
        # from the already-fetched payments list (no duplicate query).

        def _fetch_payments():
            # Prefer the canonical stay_id foreign key — single equality
            # query on the FK is complete regardless of date corrections,
            # room shifts, or payment-date edits. Falls back to the legacy
            # multi-query helper only when stay_id is missing (very old
            # stays that pre-date the stay_id migration).
            _sid = room_data.get("active_bill_id")
            if _sid and hasattr(payment_service, "query_payments_by_stay_id"):
                try:
                    _r = payment_service.query_payments_by_stay_id(_sid)
                    if _r:
                        return _r
                except Exception as _e:
                    logger.warning(
                        f"create_bill_record: query_payments_by_stay_id"
                        f"({_sid}) failed: {_e}; falling back to legacy helper"
                    )
            return payment_service.query_payments_for_stay(
                room, guest["name"], checkin_dt, stay_id=_sid
            ) or []

        def _fetch_meta_serial():
            """Read the metadata doc for a serial-number fallback."""
            try:
                meta_doc = metadata_ref.document(f"{checkin_date_str}_{room}").get()
                if meta_doc.exists:
                    sn = meta_doc.to_dict().get("serial_number")
                    if sn and sn != 0:
                        return int(sn)
            except Exception:
                pass
            return None

        def _fetch_booking_doc():
            """Return the raw booking dict (or None) for OTA / source fields."""
            try:
                bq = (
                    bookings_ref
                    .where("room", "==", room)
                    .where("guest_name", "==", guest["name"])
                    .where("check_in_date", "==", checkin_date_str)
                    .limit(1)
                    .stream()
                )
                for bdoc in bq:
                    return bdoc.to_dict()
            except Exception as _be:
                logger.warning(f"Could not fetch booking source for room {room}: {_be}")
            return None

        with _TPE(max_workers=3) as _pool:
            _f_pay  = _pool.submit(_fetch_payments)
            _f_meta = _pool.submit(_fetch_meta_serial)
            _f_book = _pool.submit(_fetch_booking_doc)

        stay_payments  = _f_pay.result()
        meta_serial    = _f_meta.result()
        booking_doc    = _f_book.result()

        # Extract serial from the already-fetched payments (no extra DB call)
        serial_number = None
        for _p in stay_payments:
            _sn = _p.get("serial_number")
            if _sn and _sn != 0:
                serial_number = int(_sn)
                break
        # Fall back to metadata doc value
        if not serial_number:
            serial_number = meta_serial

        _exclude = ("refund", "checkout_refund", "manual_refund",
                     "booking_cancel_refund", "discount", "expense")

        payment_cash = sum(
            p.get("amount", 0) for p in stay_payments
            if p.get("method") == "cash" and p.get("type") not in _exclude
        )
        payment_online = sum(
            p.get("amount", 0) for p in stay_payments
            if p.get("method") == "online" and p.get("type") not in _exclude
        )

        services = []
        services_total = 0
        for p in stay_payments:
            if p.get("type") == "addon":
                services.append({
                    "item": p.get("item", "Service"),
                    "quantity": p.get("quantity", 1),
                    "unit_price": p.get("unit_price", p.get("amount", 0)),
                    "price": p.get("amount", 0),
                    # Accommodation charges (AC, Extra Bed) are taxable alongside room rent.
                    "accommodation_charge": p.get("accommodation_charge", False),
                    # Folio attribution. `applied_on_date` is the absolute
                    # calendar date the service applies to and is robust under
                    # check-in time corrections; `applied_on_day` is the legacy
                    # relative index (1-based from check-in) and is kept for
                    # backward compatibility. The folio prefers the date when
                    # present and falls back to the index for legacy rows.
                    "applied_on_day":  p.get("applied_on_day", 1),
                    "applied_on_date": p.get("applied_on_date"),
                })
                services_total += p.get("amount", 0)

        _refund_types = ("refund", "checkout_refund", "manual_refund", "booking_cancel_refund")
        total_refunds = sum(
            p.get("amount", 0) for p in stay_payments
            if p.get("type") in _refund_types
        )
        refund_cash = sum(
            p.get("amount", 0) for p in stay_payments
            if p.get("type") in _refund_types and p.get("method") == "cash"
        )
        refund_online = sum(
            p.get("amount", 0) for p in stay_payments
            if p.get("type") in _refund_types and p.get("method") == "online"
        )
        total_discounts = sum(
            p.get("amount", 0) for p in stay_payments
            if p.get("type") == "discount"
        )

        room_price_per_night = guest.get("price", 0)
        renewal_count        = room_data.get("renewal_count", 0)

        # ── Room transfer: build charges per price segment ───────────────────────
        # pre_transfer_charges: [{days, price, total, from_room}, ...]
        # Each entry was written by transfer_room() using date-based day counts.
        pre_transfer_charges  = guest.get("pre_transfer_charges", [])
        transfer_day_offset   = guest.get("transfer_day_offset", 0)
        last_transfer_date    = guest.get("last_transfer_date")   # set by transfer_room()

        if pre_transfer_charges and last_transfer_date:
            # Transfer occurred — use calendar dates to count current-room days.
            # last_transfer_date = the date the guest moved INTO this (current) room.
            # days_in_current_room = checkout_date − transfer_date
            # Minimum 1 so a same-day-checkout-after-transfer still bills 1 night.
            try:
                _transfer_dt = datetime.strptime(last_transfer_date, "%Y-%m-%d").date()
                days_in_current_room = (checkout_dt.date() - _transfer_dt).days
                if days_in_current_room < 1:
                    days_in_current_room = 1
            except (ValueError, TypeError):
                # Fallback to renewal_count logic if date is malformed
                days_in_current_room = max(1, (renewal_count + 1) - transfer_day_offset)
        else:
            # No transfer — original renewal_count-based calculation (still correct).
            days_in_current_room = (renewal_count + 1) - transfer_day_offset

        pre_transfer_total    = sum(entry.get("total", 0) for entry in pre_transfer_charges)
        pre_transfer_days     = sum(entry.get("days",  0) for entry in pre_transfer_charges)

        current_room_charges  = room_price_per_night * days_in_current_room
        room_charges_total    = pre_transfer_total + current_room_charges
        days_stayed           = pre_transfer_days  + days_in_current_room
        # ────────────────────────────────────────────────────────────────────────

        total_amount = room_charges_total + services_total - total_discounts
        balance = total_amount - payment_cash - payment_online + total_refunds

        # ── GST Calculation (SAC 9963 — Accommodation Services) ─────────────────
        # GST slab is determined by the declared room tariff per night.
        #   < ₹1,000   → Exempt (0%)
        #   ₹1,000 – ₹7,500 → 5%
        #   > ₹7,500   → 18%
        #
        # Taxable base = room_charges_total + accommodation add-ons (AC, Extra Bed).
        # Water and miscellaneous services are NOT accommodation charges and are
        # excluded from the GST taxable base.
        #
        # When a room transfer occurred, each price segment is taxed at its own
        # slab rate (correct per GST rules), then summed.
        #
        # Note: If AC was selected at check-in, the room price already includes it.
        # If AC / Extra Bed were added as services from the checkout modal they are
        # stored with accommodation_charge=True and included here.

        def _gst_rate_for_price(price):
            if price < 1000:
                return 0
            elif price <= 7500:
                return 5
            else:
                return 18

        accommodation_addons_total = sum(
            s["price"] for s in services if s.get("accommodation_charge", False)
        )
        non_accommodation_total = services_total - accommodation_addons_total

        # ── Discount allocation (accommodation vs. non-accommodation) ────────
        # We don't capture which line the operator applied the discount to,
        # so allocate proportionally based on each bucket's share. Used to
        # pass through to the folio so the per-day GST math respects it.
        accommodation_total_pre_discount = room_charges_total + accommodation_addons_total
        gross_pre_discount = accommodation_total_pre_discount + non_accommodation_total
        accommodation_discount_share = 0.0
        if total_discounts > 0 and gross_pre_discount > 0:
            accommodation_share_ratio = (
                accommodation_total_pre_discount / gross_pre_discount
            )
            accommodation_discount_share = round(
                total_discounts * accommodation_share_ratio, 2
            )

        # ── Daily folio — canonical per-night ledger (24h windows from check-in) ─
        # Each entry holds one 24h period's accommodation charges and its OWN
        # GST slab + tax-head split. This replaces the previous "one slab
        # for the whole stay (averaged)" math and matches what every commercial
        # PMS does. Crucially, when nights differ in value of supply (mid-stay
        # AC add, extra-person charge applied to Day 1 only, etc.) each night
        # gets its legally correct slab independently.
        #
        # See compute_daily_folio() docstring for the full schema.
        daily_folio = compute_daily_folio(
            checkin_dt=checkin_dt,
            days_stayed=days_stayed,
            room_price_per_night=room_price_per_night,
            current_room_no=str(room),
            accommodation_services=services,
            pre_transfer_charges=pre_transfer_charges,
            discount_on_accom=accommodation_discount_share,
            recipient_state_code="29",  # intra-state default; refreshed by /update_bill_gst
        )

        # Aggregate flat-field totals from the folio. These are the values
        # the PDF, GSTR-1 export, and frontend currently read. The folio
        # is the source of truth; these aggregates are derived from it.
        if daily_folio:
            gst_amount             = round(sum(e["day_gst_amount"] for e in daily_folio), 2)
            accommodation_taxable  = round(sum(e["day_taxable"]    for e in daily_folio), 2)
            bill_cgst_amount       = round(sum(e["day_cgst"]       for e in daily_folio), 2)
            bill_sgst_amount       = round(sum(e["day_sgst"]       for e in daily_folio), 2)
            bill_igst_amount       = round(sum(e["day_igst"]       for e in daily_folio), 2)

            # gst_rate field on the bill is for display fall-back only — the
            # per-day rate is the source of truth. Use the most common slab
            # across the stay (ties broken in favour of the larger rate).
            _rate_counts = {}
            for _e in daily_folio:
                _rate_counts[_e["day_gst_rate"]] = _rate_counts.get(_e["day_gst_rate"], 0) + 1
            gst_rate = max(
                _rate_counts.keys(),
                key=lambda r: (_rate_counts[r], r),
            )
            # First-day effective per-night, kept for audit visibility
            effective_per_night_for_slab = daily_folio[0]["day_total"]
        else:
            # Defensive fallback (only fires if days_stayed <= 0, which
            # shouldn't normally happen). Keep the legacy single-slab math.
            gst_rate = _gst_rate_for_price(room_price_per_night)
            divisor = 100 + gst_rate if gst_rate else 100
            gst_amount = round(
                (room_charges_total + accommodation_addons_total) * gst_rate / divisor, 2
            ) if gst_rate else 0
            accommodation_taxable = round(
                (room_charges_total + accommodation_addons_total) - gst_amount, 2
            )
            bill_cgst_amount, bill_sgst_amount, bill_igst_amount = compute_gst_split(
                gst_amount, recipient_state_code="29",
            )
            effective_per_night_for_slab = room_price_per_night

        # bill_number is determined after invoice logic below
        bill_number = None

        # ── Booking source / OTA fields (from parallel-fetched booking_doc) ──
        booking_source    = "normal"
        payment_source    = "hotel"
        ota_total_amount  = 0
        ota_commission    = 0.0
        ota_commission_gst = 0.0
        net_receivable    = 0
        settlement_status = None
        if booking_doc:
            booking_source     = booking_doc.get("booking_source", "normal")
            payment_source     = booking_doc.get("payment_source", "hotel")
            ota_total_amount   = booking_doc.get("ota_total_amount", 0)
            ota_commission     = booking_doc.get("ota_commission", 0.0)
            ota_commission_gst = booking_doc.get("ota_commission_gst", 0.0)
            net_receivable     = booking_doc.get("net_receivable", 0)
            settlement_status  = booking_doc.get("settlement_status")

        # ── Invoice flag logic ────────────────────────────────────────────────────
        # invoice_generated = True when this bill qualifies as a formal GST tax invoice.
        # bill_number (CC/YYYY/MM/XXXXX) is the single reference — no separate INV/... number.
        any_addon_online = any(
            p.get("type") == "addon" and p.get("method") == "online"
            for p in stay_payments
        )
        # any service/addon (cash OR online) — used for MMT service-only bill trigger
        any_addon = any(p.get("type") == "addon" for p in stay_payments)
        is_same_day = checkin_dt.date() == checkout_dt.date()
        is_mmt_ota = (booking_source == "mmt" and payment_source == "ota")
        is_booking_com = (booking_source == "booking.com")
        # MMT service-only bill: room rent is billed by MMT, hotel issues an
        # invoice for the in-hotel service/addon portion only (cash or UPI).
        mmt_service_only = is_mmt_ota and any_addon

        # ── Determine whether this checkout qualifies for a bill + invoice ──
        # The Settings → Bill Generation toggle controls the cash-only skip:
        #   • always_generate_bill = True  → never skip (every stay gets a bill).
        #   • always_generate_bill = False → skip the bill when the entire stay
        #     (room + every service/addon) was paid in cash. This is the
        #     date-independent rule: payment_cash > 0 AND payment_online == 0
        #     AND no addon was paid online.
        #
        # OTA branches (pure MMT room stays, Booking.com) are NOT controlled by
        # this toggle — they are evaluated separately further down. The toggle
        # only governs the cash-only skip for non-OTA stays.
        try:
            _billing_cfg = get_billing_config()
        except Exception as _cfg_err:
            # Defensive: never let a settings read break checkout.
            logger.warning(f"create_bill_record: billing_config read failed, "
                           f"using defaults: {_cfg_err}")
            _billing_cfg = dict(_BILLING_CONFIG_DEFAULTS)
        always_generate_bill = bool(_billing_cfg.get("always_generate_bill", False))

        if always_generate_bill:
            is_no_bill = False
        else:
            is_no_bill = (
                payment_cash > 0
                and payment_online == 0
                and not any_addon_online
            )

        if mmt_service_only:
            # MMT room (no hotel invoice for room) BUT guest took a service →
            # generate a hotel invoice for the addon portion only
            invoice_generated = True
        elif is_mmt_ota:
            # OTA billing fully handled by MMT — no hotel-issued invoice
            invoice_generated = False
        elif is_booking_com:
            # Booking.com: always generate invoice (spec requirement)
            invoice_generated = True
        elif always_generate_bill:
            # Toggle ON: every non-OTA stay gets a tax invoice. Without this
            # branch, an all-cash stay with no online addon would fall through
            # to the `else` (False) below — giving a bill_number but no
            # invoice flag, which contradicts "generate bills for all stays".
            invoice_generated = True
        elif is_no_bill:
            # Cash-only stay (toggle OFF): no bill number, no GST invoice
            invoice_generated = False
        elif payment_cash > 0 and payment_online > 0:
            # Split payment (cash + UPI) → generate invoice
            invoice_generated = True
        elif payment_online > 0:
            # UPI-only payment → generate invoice
            invoice_generated = True
        elif any_addon_online:
            # Addon/service paid via UPI → generate invoice
            invoice_generated = True
        else:
            invoice_generated = False

        # Only generate bill_number (CC/...) when a bill is actually warranted.
        # When the Bill-generation toggle is OFF, entirely-cash stays are
        # excluded (is_no_bill = True) and won't appear in the Bills module.
        # When ON, every non-OTA stay gets a sequential bill_number.
        # MMT stays get a real bill_number ONLY when a service is taken
        # (service-only bill); pure MMT room stays remain "-" regardless of
        # the toggle.
        if is_no_bill:
            bill_number = "-"
        elif is_mmt_ota and not mmt_service_only:
            # Pure MMT room stay (no service) — no hotel bill
            bill_number = "-"
        else:
            bill_number = generate_sequential_bill_number(checkout_dt)

        # ── Build clean room_segments array ──────────────────────────────────────
        # Each entry: {room, date_from, date_to, nights, rate, total}
        # Covers ALL segments (prior rooms + final room) in chronological order.
        # Single-room stays have exactly one entry.
        try:
            _checkin_date = datetime.strptime(checkin_time[:10], "%Y-%m-%d").date()
        except (ValueError, TypeError):
            _checkin_date = checkout_dt.date()

        clean_segments = []
        _cursor_date = _checkin_date
        for _seg in (pre_transfer_charges or []):
            _seg_nights = _seg.get("days", 0)
            _seg_date_to = _cursor_date + timedelta(days=_seg_nights)
            clean_segments.append({
                "room":      _seg.get("from_room", ""),
                "date_from": _cursor_date.strftime("%Y-%m-%d"),
                "date_to":   _seg_date_to.strftime("%Y-%m-%d"),
                "nights":    _seg_nights,
                "rate":      _seg.get("price", 0),
                "total":     _seg.get("total", 0),
            })
            _cursor_date = _seg_date_to
        # Append final (current) room segment
        clean_segments.append({
            "room":      room,
            "date_from": _cursor_date.strftime("%Y-%m-%d"),
            "date_to":   checkout_dt.date().strftime("%Y-%m-%d"),
            "nights":    days_in_current_room,
            "rate":      room_price_per_night,
            "total":     current_room_charges,
        })
        # ─────────────────────────────────────────────────────────────────────────

        # ── MMT service-only invoice override ─────────────────────────────────
        # For MMT stays the room rent is already billed by MakeMyTrip. When the
        # guest takes an in-hotel service (water, extras, etc.) we issue a
        # hotel invoice for the SERVICE PORTION ONLY — room charges and room
        # segments are zeroed out, and GST is recomputed on the service base.
        if mmt_service_only:
            room_charges_total = 0
            days_stayed = 0
            clean_segments = []
            # MMT room is billed by MakeMyTrip — the hotel only invoices
            # in-hotel services. The daily folio model doesn't apply here
            # (there are no nights of accommodation from the hotel side);
            # the folio is empty and we fall back to flat math on services.
            daily_folio = []
            total_amount = services_total - total_discounts
            balance = total_amount - payment_cash - payment_online + total_refunds
            if accommodation_addons_total > 0 and gst_rate > 0:
                _divisor = 100 + gst_rate
                gst_amount = round(accommodation_addons_total * gst_rate / _divisor, 2)
                accommodation_taxable = round(accommodation_addons_total - gst_amount, 2)
            else:
                gst_rate = 0
                gst_amount = 0
                accommodation_taxable = 0
            non_accommodation_total = services_total - accommodation_addons_total
            bill_cgst_amount, bill_sgst_amount, bill_igst_amount = compute_gst_split(
                gst_amount, recipient_state_code="29"
            )
        # ─────────────────────────────────────────────────────────────────────

        bill_record = {
            "bill_number": bill_number,
            "room": room,
            "guest_name": guest["name"],
            "guest_mobile": guest.get("mobile", ""),
            "guest_count": guest.get("guests", 1),
            "is_ac": guest.get("isAC", False),
            "checkin_time": checkin_time,
            "checkout_time": checkout_time,
            "days_stayed": days_stayed,
            "room_price_per_night": room_price_per_night,
            "room_charges_total": room_charges_total,
            "services": services,
            "services_total": services_total,
            "discounts": total_discounts,
            "refunds": total_refunds,
            "refund_cash": refund_cash,
            "refund_online": refund_online,
            "total_amount": total_amount,
            "payment_cash": payment_cash,
            "payment_online": payment_online,
            "balance": balance,
            "status": "pending_settlement" if settle_later else "completed",
            "created_at": checkout_time,
            "print_count": 0,
            "serial_number": serial_number,
            # OTA / booking source fields
            "booking_source": booking_source,
            "payment_source": payment_source,
            "ota_total_amount": ota_total_amount,
            "ota_commission": ota_commission,
            "ota_commission_gst": ota_commission_gst,
            "net_receivable": net_receivable,
            "settlement_status": settlement_status,
            # GST invoice flag — True when bill qualifies as a formal GST invoice.
            # bill_number (CC/YYYY/MM/XXXXX) is the single reference for all invoices.
            "invoice_generated": invoice_generated,
            # Settle-later link
            "settlement_id": settlement_id if settle_later else None,
            # ── GST breakdown (SAC 9963 — Accommodation Services) ─────────────
            # gst_rate     : 0 / 5 / 18 — slab determined by EFFECTIVE per-night
            #                value of supply (post-discount; see G3 block above).
            # accommodation_taxable : room charges + accommodation add-ons (AC, Extra Bed)
            # non_accommodation_total : water, misc services (outside GST scope)
            # gst_amount   : back-calculated from inclusive accommodation total
            # cgst/sgst/igst_amount : split per place of supply (G1). Intra-state
            #                at create-time; refreshed by /update_bill_gst when
            #                an inter-state recipient is captured.
            # sac_or_hsn   : "9963" for accommodation. Required on the bill body
            #                per Rule 46(g); also used by the GSTR-1 export (G6).
            # effective_per_night_for_slab : audit aid showing which per-night value
            #                was used to pick the slab (G3 traceability).
            # round_off    : reserved for any sum-of-components vs. total drift.
            #                Always 0 today (total math is integer-exact); the
            #                field is here so GSTR-1 exports can carry the
            #                round_off column without a schema change (G7).
            "gst_rate": gst_rate,
            "accommodation_taxable": accommodation_taxable,
            "non_accommodation_total": non_accommodation_total,
            "gst_amount": gst_amount,
            "cgst_amount": bill_cgst_amount,
            "sgst_amount": bill_sgst_amount,
            "igst_amount": bill_igst_amount,
            "sac_or_hsn": "9963",
            "effective_per_night_for_slab": effective_per_night_for_slab,
            # ── Daily folio — per-night accommodation ledger (24h windows) ──
            # Canonical source of truth. Flat fields above (gst_amount,
            # cgst_amount, etc.) are derived by summing per-day values from
            # this array. Empty for MMT service-only bills (no accommodation).
            # Schema: see compute_daily_folio() docstring.
            "daily_folio": daily_folio,
            "round_off": round(
                total_amount
                - (
                    accommodation_taxable
                    + gst_amount
                    + non_accommodation_total
                    - total_discounts
                ),
                2,
            ),
            # ── B2B / GST recipient fields ────────────────────────────────────
            # All default to empty/None — a B2C bill carries blank recipient
            # info. Filled in via /update_bill_gst (Bills tab "GST" icon).
            # invoice_type defaults to "B2C"; classify_invoice_type recomputes
            # whenever recipient details change.
            "recipient_gstin":      "",
            "recipient_legal_name": "",
            "recipient_trade_name": "",
            "recipient_address":    "",
            "recipient_state":      "Karnataka",
            "recipient_state_code": "29",
            "invoice_type":         "B2C",
            # Linked credit notes — populated by create_credit_note.
            "linked_credit_note_ids": [],
            "linked_credit_note_id":  None,
            # ── Room segments — clean array for all stays ──────────────────────
            # Each entry: {room, date_from, date_to, nights, rate, total}
            # Single-room stays have exactly one entry.
            "room_segments": clean_segments,
            # ── Attribution snapshot — captures the FULL stay lifecycle ───────
            # Copied off the room doc at checkout so the register-tab history
            # popover can reconstruct the chain even after the room is reset.
            # The room doc clears these on checkout to keep the vacant-card
            # popover focused on post-stay info; the bill keeps them for audit.
            "cleanedBy":              room_data.get("cleanedBy"),
            "cleanedAt":              room_data.get("cleanedAt") or room_data.get("cleaning_done_at"),
            "inspectedBy":            room_data.get("inspectedBy"),
            "inspectedAt":            room_data.get("inspectedAt") or room_data.get("inspected_at"),
            "bookedBy":               room_data.get("bookedBy"),
            "bookedAt":               room_data.get("bookedAt"),
            "lastCheckinBy":          room_data.get("lastCheckinBy"),
            "lastCheckinAt":          room_data.get("lastCheckinAt") or room_data.get("checkin_time"),
            "lastCheckinTimeEditBy":  room_data.get("lastCheckinTimeEditBy"),
            "lastCheckinTimeEditAt":  room_data.get("lastCheckinTimeEditAt"),
            # checkout attribution is added by routes.rooms.checkout itself
            # (it has flask.g context for the user who initiated the checkout).
        }

        return bill_record

    except Exception as e:
        logger.error(f"Error creating bill record: {str(e)}")
        return None

def generate_sequential_bill_number(checkout_date):
    """
    Format: CC/YYYY/MM/XXXXX
    Uses an atomic Firestore counter keyed on "bill_YYYY_MM".
    Minimum sequence value is 1 (never 0).
    """
    try:
        year  = checkout_date.year
        month = str(checkout_date.month).zfill(2)

        counter_key = f"bill_{year}_{month}"
        counter_ref = counters_ref.document(counter_key)
        txn         = db.transaction()

        @firestore.transactional
        def _inc(t, ref):
            snap    = ref.get(transaction=t)
            new_val = (snap.get("count") + 1) if snap.exists else 1
            t.set(ref, {"count": new_val})
            return new_val

        seq    = _inc(txn, counter_ref)
        serial = str(seq).zfill(5)
        return f"CC/{year}/{month}/{serial}"

    except Exception as e:
        logger.error(f"Error generating bill number: {e}")
        # Timestamp-based fallback — still unique, never 0
        ts = max(1, int(checkout_date.timestamp()) % 100000)
        return f"CC/{checkout_date.year}/{str(checkout_date.month).zfill(2)}/{ts:05d}"


def find_serial_number_for_checkin(room_number, guest_name, checkin_dt, all_logs):
    """
    Search for the serial number assigned at this check-in.
    Returns int or None. Never returns 0.

    OPTIMISED: tries payments collection first (fast), then falls back to
    metadata + old logs scan.

    Search order:
      0. payments collection (new, fast)
      1. transaction_metadata (most authoritative - keyed on checkin_date + room)
      2. Log entries that match checkin date exactly
      3. Log entries from current stay (broader fallback)
    """
    room_str = str(room_number)
    checkin_date = checkin_dt.strftime("%Y-%m-%d")

    # 0. Try payments collection first (fast targeted query)
    sn = payment_service.find_serial_number(room_str, guest_name, checkin_dt)
    if sn:
        return sn

    # 1. transaction_metadata (most reliable, especially after date edits)
    try:
        meta_doc = metadata_ref.document(f"{checkin_date}_{room_str}").get()
        if meta_doc.exists:
            sn = meta_doc.to_dict().get("serial_number")
            if sn and sn != 0:
                return int(sn)
    except Exception as e:
        logger.warning(f"Metadata lookup failed for room {room_str}: {e}")

    return None

def _find_serial_fast(room_str, guest_name, checkin_dt, log_index):
    """
    Fast serial lookup from pre-indexed logs. No Firestore calls.
    Checks exact date match first, then broader stay match.
    """
    checkin_date = checkin_dt.strftime("%Y-%m-%d")
    key = (room_str, guest_name)
    logs = log_index.get(key, [])

    # Prefer exact date match
    for log in logs:
        if log.get("date") == checkin_date:
            sn = log.get("serial_number")
            if sn and sn != 0:
                return int(sn)

    # Broader: any log from current stay
    for log in logs:
        if is_log_from_current_stay(log, checkin_dt):
            sn = log.get("serial_number")
            if sn and sn != 0:
                return int(sn)

    return None  # Will be resolved by batch metadata lookup

def _batch_fill_serials(entries):
    """
    Batch Firestore reads for entries still missing serial numbers.
    Uses getAll (via individual gets) but batched together to minimize overhead.
    """
    if not entries:
        return

    try:
        # Build list of metadata doc refs to fetch
        refs = []
        ref_to_entry = {}
        for entry in entries:
            checkin_time = entry.get("checkin_time", "")
            room = entry.get("room", "")
            if checkin_time and room:
                checkin_date = checkin_time.split(" ")[0]
                doc_key = f"{checkin_date}_{room}"
                refs.append(doc_key)
                ref_to_entry[doc_key] = entry

        # Fetch all metadata docs
        for doc_key, entry in ref_to_entry.items():
            try:
                meta_doc = metadata_ref.document(doc_key).get()
                if meta_doc.exists:
                    sn = meta_doc.to_dict().get("serial_number")
                    if sn and sn != 0:
                        entry["serial_number"] = int(sn)
            except Exception:
                pass  # Skip individual failures

        logger.info(f"Batch metadata lookup for {len(ref_to_entry)} entries")
    except Exception as e:
        logger.warning(f"Batch metadata lookup failed: {e}")

def _build_active_entry_fast(room_number, room_data, all_logs, checkin_dt, log_index):
    """
    Build a register entry for an occupied room.

    OPTIMISED: tries payments collection for cash/online sums and serial.
    Falls back to pre-indexed logs if payments collection has no data.
    """
    try:
        guest = room_data.get("guest") or {}
        guest_name = guest.get("name", "")
        if not guest_name:
            return None

        checkin_time         = room_data.get("checkin_time")
        room_price_per_night = guest.get("price", 0)
        days_stayed          = (room_data.get("renewal_count") or 0) + 1
        room_charges_total   = room_price_per_night * days_stayed
        services_total       = sum(a.get("price", 0) for a in room_data.get("add_ons", []))
        total_amount         = room_charges_total + services_total

        room_str = str(room_number)

        # --- Try payments collection first (fast targeted query) ---
        stay_payments = payment_service.query_payments_for_stay(
            room_str, guest_name, checkin_dt
        )

        # Read from payments collection (primary data source)
        payment_cash = sum(
            p.get("amount", 0) for p in (stay_payments or [])
            if p.get("method") == "cash"
            and p.get("type") not in ("refund", "checkout_refund",
                                       "manual_refund", "booking_cancel_refund",
                                       "discount", "expense")
        )
        payment_online = sum(
            p.get("amount", 0) for p in (stay_payments or [])
            if p.get("method") == "online"
            and p.get("type") not in ("refund", "checkout_refund",
                                       "manual_refund", "booking_cancel_refund",
                                       "discount", "expense")
        )
        serial = payment_service.find_serial_number(
            room_str, guest_name, checkin_dt
        )
        # If serial still missing, try pre-indexed logs (metadata fallback)
        if serial is None:
            serial = _find_serial_fast(room_str, guest_name, checkin_dt, log_index)

        balance = room_data.get("balance", 0)

        return {
            "id"            : f"active_{room_number}_{int(checkin_dt.timestamp())}",
            "bill_number"   : "-",
            "guest_name"    : guest_name,
            "guest_mobile"  : guest.get("mobile", ""),
            "room"          : room_str,
            "checkin_time"  : checkin_time,
            "checkout_time" : None,
            "days_stayed"   : days_stayed,
            "room_rent"     : room_price_per_night,
            "room_charges"  : room_charges_total,
            "services_total": services_total,
            "total_amount"  : total_amount,
            "payment_cash"  : payment_cash,
            "payment_online": payment_online,
            "balance"       : balance,
            "status"        : "active",
            "serial_number" : serial,
        }
    except Exception as e:
        logger.error(f"Error building active entry for room {room_number}: {e}")
        return None


# ============================================================================
# GST helpers - recipient (B2B) capture, validation, classification (Goal 1)
# ============================================================================

import re as _re

_GSTIN_RE = _re.compile(
    r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[0-9A-Z]{1}Z[0-9A-Z]{1}$"
)

_STATE_CODE_TO_NAME = {
    "01": "Jammu and Kashmir",     "02": "Himachal Pradesh",
    "03": "Punjab",                "04": "Chandigarh",
    "05": "Uttarakhand",           "06": "Haryana",
    "07": "Delhi",                 "08": "Rajasthan",
    "09": "Uttar Pradesh",         "10": "Bihar",
    "11": "Sikkim",                "12": "Arunachal Pradesh",
    "13": "Nagaland",              "14": "Manipur",
    "15": "Mizoram",               "16": "Tripura",
    "17": "Meghalaya",             "18": "Assam",
    "19": "West Bengal",           "20": "Jharkhand",
    "21": "Odisha",                "22": "Chhattisgarh",
    "23": "Madhya Pradesh",        "24": "Gujarat",
    "25": "Daman and Diu",         "26": "Dadra and Nagar Haveli",
    "27": "Maharashtra",           "28": "Andhra Pradesh (old)",
    "29": "Karnataka",             "30": "Goa",
    "31": "Lakshadweep",           "32": "Kerala",
    "33": "Tamil Nadu",            "34": "Puducherry",
    "35": "Andaman and Nicobar Islands",
    "36": "Telangana",             "37": "Andhra Pradesh",
    "38": "Ladakh",                "97": "Other Territory",
    "99": "Centre Jurisdiction",
}


def validate_gstin(gstin):
    """Format-only check against Rule 46(b). True if valid format."""
    if not gstin or not isinstance(gstin, str):
        return False
    return bool(_GSTIN_RE.match(gstin.strip().upper()))


def derive_state_from_gstin(gstin):
    """Return (state_name, state_code) from GSTIN's first 2 digits."""
    if not validate_gstin(gstin):
        return ("", "")
    code = gstin.strip()[:2]
    return (_STATE_CODE_TO_NAME.get(code, ""), code)


B2CL_THRESHOLD = 100000


def classify_invoice_type(recipient_gstin, total_amount, recipient_state_code=""):
    """Compute GSTR-1 invoice_type bucket. Returns 'B2B' / 'B2CL' / 'B2C'."""
    if validate_gstin(recipient_gstin or ""):
        return "B2B"
    try:
        amt = int(total_amount or 0)
    except (TypeError, ValueError):
        amt = 0
    if (
        amt > B2CL_THRESHOLD
        and recipient_state_code
        and recipient_state_code != "29"
    ):
        return "B2CL"
    return "B2C"


def _slab_for_value(value):
    """Accommodation slab per CBIC 03/2024-CTR — value of supply per night."""
    try:
        v = float(value or 0)
    except (TypeError, ValueError):
        v = 0
    if v < 1000:
        return 0
    if v <= 7500:
        return 5
    return 18


def compute_daily_folio(
    *,
    checkin_dt,
    days_stayed,
    room_price_per_night,
    current_room_no,
    accommodation_services,
    pre_transfer_charges,
    discount_on_accom,
    recipient_state_code,
):
    """
    Build a per-night folio — one entry per 24-hour accommodation period
    starting from check-in. This is the canonical model for billing under
    the lodge's 24-hour stay-day rule (renewal at checkin_time + 24h, not
    at calendar midnight).

    Why this exists
    ---------------
    The legacy create_bill_record used a single room_price_per_night plus
    a flat list of addons, then averaged the effective per-night value to
    pick ONE GST slab for the whole stay. That works when every night is
    in the same slab — but it silently mis-classifies tax when nights
    cross a slab boundary (e.g. Day 1 = ₹2,400 with addons → 5%, Day 2
    = ₹950 base only → exempt). The folio fixes this by computing each
    night's slab from its OWN value of supply, then summing GST.

    Each entry carries:
        day_index       1-based, day_index == 1 covers the first 24h
        day_start       checkin_dt + (day_index-1) * 24h, IST string
        day_end         checkin_dt + day_index * 24h
        room            the room occupied that night (transfer-aware)
        base_rate       per-night room rate for that night (gross, incl GST)
        addons          accommodation services applied to that day
        addons_total    sum of addon prices for that day (gross)
        discount_allocated   proportional share of the stay's discount
        day_total       gross (incl GST) accommodation charge for the day
                        after discount allocation
        day_taxable     pre-GST taxable base
        day_gst_rate    0 / 5 / 18 — determined per-day from day_total
        day_gst_amount  back-calculated from day_total at day_gst_rate
        day_cgst / day_sgst / day_igst    place-of-supply split

    Parameters
    ----------
    checkin_dt : datetime
    days_stayed : int
        Total 24h periods covered.
    room_price_per_night : int
        Rate of the CURRENT (last-segment) room.
    current_room_no : str
        The current room number — used for nights not covered by
        pre_transfer_charges.
    accommodation_services : list[dict]
        All services on the stay. Only those with accommodation_charge=True
        are folded into per-day totals. Each may carry `applied_on_day`
        (1-based). Missing values default to Day 1 — this keeps the
        backward-compat behaviour for stays that pre-date the folio model
        (their AC/extra-person charges land on Day 1, which is correct
        the vast majority of the time).
    pre_transfer_charges : list[dict]
        Previous-room segments [{from_room, days, price, total, ...}].
        Days 1..N1 from check-in are billed at segment 1's rate; the
        next N2 at segment 2's; etc. Residual days go to the current room.
    discount_on_accom : float
        Total discount allocated to accommodation. Distributed across days
        proportionally to each day's pre-discount accommodation total.
    recipient_state_code : str
        "29" (Karnataka, intra) → CGST + SGST; anything else → IGST.

    Returns
    -------
    list[dict]
        One entry per night, ordered Day 1 → Day N.
    """
    from datetime import timedelta as _td

    if not checkin_dt or not days_stayed or days_stayed <= 0:
        return []

    # ── 1. Walk transfer segments to build (room, rate) per day ────────────
    daily_room_rate = []
    if pre_transfer_charges:
        for seg in pre_transfer_charges:
            try:
                seg_days = int(seg.get("days", 0) or 0)
            except (TypeError, ValueError):
                seg_days = 0
            try:
                seg_rate = int(seg.get("price", 0) or 0)
            except (TypeError, ValueError):
                seg_rate = 0
            seg_room = seg.get("from_room") or current_room_no
            for _ in range(seg_days):
                daily_room_rate.append((str(seg_room), seg_rate))
    # Fill remaining days with the current room's rate
    remaining = days_stayed - len(daily_room_rate)
    if remaining > 0:
        for _ in range(remaining):
            daily_room_rate.append((str(current_room_no), int(room_price_per_night or 0)))
    # Truncate any over-shoot if pre_transfer_charges had stale extras
    daily_room_rate = daily_room_rate[:days_stayed]

    # -- 2. Group accommodation services by their day index ---------------
    # Prefer `applied_on_date` (absolute YYYY-MM-DD) when present, falling
    # back to the relative `applied_on_day` index for legacy rows. Absolute
    # date is robust under check-in time corrections; the relative index
    # silently drifts if the check-in time is later edited.
    addons_by_day = {}
    _checkin_date = checkin_dt.date() if checkin_dt else None
    for s in (accommodation_services or []):
        if not s.get("accommodation_charge"):
            continue

        day_idx = None
        _applied_date = s.get("applied_on_date")
        if _applied_date and _checkin_date:
            try:
                from datetime import datetime as _dt
                _ad = _dt.strptime(str(_applied_date)[:10], "%Y-%m-%d").date()
                # day_idx is 1-based: the check-in date itself is Day 1.
                day_idx = (_ad - _checkin_date).days + 1
            except (TypeError, ValueError):
                day_idx = None

        if day_idx is None:
            try:
                day_idx = int(s.get("applied_on_day", 1) or 1)
            except (TypeError, ValueError):
                day_idx = 1

        if day_idx < 1:
            day_idx = 1
        if day_idx > days_stayed:
            day_idx = days_stayed  # clamp to last day
        addons_by_day.setdefault(day_idx, []).append(s)

    # ── 3. First pass — pre-discount per-day totals (for discount allocation) ─
    pre_discount = []
    for day_idx in range(1, days_stayed + 1):
        room_no, base_rate = daily_room_rate[day_idx - 1]
        addons = addons_by_day.get(day_idx, [])
        addons_total = sum(
            int(a.get("price", 0) or 0) for a in addons
        )
        pre_discount.append({
            "day_idx":            day_idx,
            "room":               room_no,
            "base_rate":          int(base_rate or 0),
            "addons":             addons,
            "addons_total":       addons_total,
            "pre_discount_total": int(base_rate or 0) + addons_total,
        })

    sum_pre_discount = sum(e["pre_discount_total"] for e in pre_discount) or 1

    # ── 4. Build the final folio with per-day GST math ────────────────────
    folio = []
    discount_remaining = float(discount_on_accom or 0)
    for i, entry in enumerate(pre_discount):
        is_last = (i == len(pre_discount) - 1)
        if is_last:
            # Last day absorbs any rounding drift so the discount sum is exact
            day_discount = round(discount_remaining, 2)
        else:
            share = entry["pre_discount_total"] / sum_pre_discount
            day_discount = round(float(discount_on_accom or 0) * share, 2)
            discount_remaining -= day_discount

        day_total = round(entry["pre_discount_total"] - day_discount, 2)
        if day_total < 0:
            day_total = 0.0

        # GST slab is determined by the TARIFF (the per-night rate the
        # hotel actually charges), NOT the post-discount net. Under
        # CBIC Notification 11/2017-CTR as amended, the slab follows
        # the value-of-supply BEFORE discount is applied; the discount
        # is then treated as a deduction (Section 15(3)).
        #
        # Previously this used `day_total` (post-discount). That broke
        # for fully-discounted nights: a ₹1800 room with a ₹1800 disc
        # would reclassify to Exempt (post-discount net = ₹0), even
        # though the tariff is firmly in the 5% bracket. Same row would
        # then show Rate=Exempt while Taxable=₹1800 — visibly broken.
        day_gst_rate = _slab_for_value(entry["pre_discount_total"])
        if day_gst_rate > 0 and day_total > 0:
            divisor = 100 + day_gst_rate
            day_gst = round(day_total * day_gst_rate / divisor, 2)
        else:
            day_gst = 0.0
        day_taxable = round(day_total - day_gst, 2)

        # Place-of-supply split — same logic as compute_gst_split, inlined
        # here so the helper has no inter-dependency.
        is_intra = (not recipient_state_code) or recipient_state_code == "29"
        if is_intra:
            day_cgst = round(day_gst / 2, 2)
            day_sgst = round(day_gst - day_cgst, 2)
            day_igst = 0.0
        else:
            day_cgst = 0.0
            day_sgst = 0.0
            day_igst = round(day_gst, 2)

        # 24h day window anchored on check-in time
        day_start = checkin_dt + _td(hours=24 * (entry["day_idx"] - 1))
        day_end   = checkin_dt + _td(hours=24 * entry["day_idx"])

        folio.append({
            "day_index":          entry["day_idx"],
            "day_start":          day_start.strftime("%Y-%m-%d %H:%M"),
            "day_end":            day_end.strftime("%Y-%m-%d %H:%M"),
            "room":               entry["room"],
            "base_rate":          entry["base_rate"],
            "addons":             entry["addons"],
            "addons_total":       entry["addons_total"],
            "discount_allocated": day_discount,
            "day_total":          day_total,
            "day_taxable":        day_taxable,
            "day_gst_rate":       day_gst_rate,
            "day_gst_amount":     day_gst,
            "day_cgst":           day_cgst,
            "day_sgst":           day_sgst,
            "day_igst":           day_igst,
        })

    return folio


def compute_gst_split(gst_amount, recipient_state_code=""):
    """
    Split a GST amount into (cgst, sgst, igst) based on place of supply.

    The supplier is fixed in Karnataka (state code "29"). Intra-state supply
    (recipient in KA-29, OR no recipient info → assume local B2C) attracts
    CGST + SGST in equal halves. Inter-state supply (recipient_state_code
    set to anything other than "29") attracts IGST instead, with CGST = SGST = 0.

    Storing the split on the bill (rather than just `gst_amount`) is required
    for a correct GSTR-1 / GSTR-3B filing and lets the PDF render the right
    tax-head columns. Without this split, every inter-state B2B invoice
    silently mis-classifies the tax head.

    Returns
    -------
    tuple[float, float, float]
        (cgst, sgst, igst), each rounded to 2 decimal places. The sum equals
        the input gst_amount within at most one paise of rounding drift
        (the SGST half absorbs any drift so CGST + SGST == gst_amount).
    """
    try:
        total = float(gst_amount or 0)
    except (TypeError, ValueError):
        total = 0.0
    if total <= 0:
        return (0.0, 0.0, 0.0)

    code = (recipient_state_code or "").strip()
    is_intra_state = (not code) or code == "29"
    if is_intra_state:
        half = round(total / 2, 2)
        return (half, round(total - half, 2), 0.0)
    return (0.0, 0.0, round(total, 2))


# ============================================================================
# CREDIT NOTE numbering and creation (Section 34 CGST Act) - Goal 2
# ============================================================================

def create_cancellation_charge_bill(*, booking_id, booking_data, retained_amount,
                                    cancel_dt=None, actor=None):
    """
    Issue a separate Tax Invoice for a cancellation forfeiture amount.

    Per Schedule II + SAC 999794 ("agreement to refrain from an act, or to
    tolerate an act"), the retained portion of a cancelled booking is a
    distinct supply taxable at 18% (CGST 9 + SGST 9) — NOT at the
    accommodation slab. The retained amount is treated as GST-inclusive
    (the operator collected exactly that amount as advance).

    The new bill mints its own CC/YYYY/MM/XXXXX from the same monthly
    counter so the numbering stays consecutive (Rule 46(b)). It is
    written as `is_cancellation_charge=True` and `sac_or_hsn="999794"`
    so the GSTR-1 export can route it to the correct HSN bucket and the
    Bills tab can show a distinct pill.

    Returns the bill dict on success, None on failure (including
    retained_amount <= 0).
    """
    if not booking_id or not isinstance(booking_data, dict):
        return None
    try:
        retained_amount = int(retained_amount or 0)
    except (TypeError, ValueError):
        return None
    if retained_amount <= 0:
        return None

    cancel_dt = cancel_dt or datetime.now(IST)
    bill_number = generate_sequential_bill_number(cancel_dt)

    # 18% inclusive math. SAC 999794 ("agreement to refrain") — a B2C
    # forfeiture by default; the operator never has GSTIN for a no-show.
    # If a corporate cancellation needs B2B treatment, the bill can be
    # upgraded via /update_bill_gst, which will also recompute the split.
    gst_rate    = 18
    gst_amount  = round(retained_amount * 18 / 118, 2)
    taxable     = round(retained_amount - gst_amount, 2)
    cgst_amt, sgst_amt, igst_amt = compute_gst_split(
        gst_amount, recipient_state_code="29"
    )
    now_str     = cancel_dt.strftime("%Y-%m-%d %H:%M:%S")
    co_str      = cancel_dt.strftime("%Y-%m-%d %H:%M")

    bill_id = uuid.uuid4().hex
    bill_doc = {
        "stay_id":               bill_id,
        "bill_number":           bill_number,
        "is_cancellation_charge": True,
        "against_booking_id":    booking_id,
        "guest_name":            booking_data.get("guest_name", "") or "",
        "guest_mobile":          booking_data.get("guest_mobile", "") or "",
        "guest_count":           int(booking_data.get("guests", 1) or 1),
        "room":                  str(booking_data.get("room", "") or "-"),
        # checkin/checkout timestamps make the bill render properly even
        # though no actual stay occurred. checkin = booked check-in date,
        # checkout = cancel datetime.
        "checkin_time":          (booking_data.get("check_in_date") or "")[:10] + " 00:00",
        "checkout_time":         co_str,
        "days_stayed":           0,
        "room_price_per_night":  0,
        "room_charges_total":    0,
        "services":              [],
        "services_total":        0,
        "discounts":             0,
        "refunds":               0,
        "total_amount":          retained_amount,
        # The retained amount was already collected as part of the
        # booking advance. We classify the receipt by the booking's
        # original payment method when available, defaulting to cash.
        "payment_cash":          retained_amount if (booking_data.get("payment_method") or "cash") != "online" else 0,
        "payment_online":        retained_amount if (booking_data.get("payment_method") or "cash") == "online" else 0,
        "balance":               0,
        "status":                "completed",
        "created_at":            now_str,
        "invoice_generated":     True,
        "gst_rate":              gst_rate,
        "accommodation_taxable": taxable,
        "non_accommodation_total": 0,
        "gst_amount":            gst_amount,
        # G1: CGST/SGST/IGST split. Intra-state (KA-29) at creation; will be
        # recomputed by /update_bill_gst if the bill is later flagged B2B.
        "cgst_amount":           cgst_amt,
        "sgst_amount":           sgst_amt,
        "igst_amount":           igst_amt,
        "sac_or_hsn":            "999794",
        "round_off":             0.0,
        "effective_per_night_for_slab": 0,
        "service_description":   ("Cancellation forfeiture — agreement to refrain "
                                  "from supply (Schedule II of CGST Act, "
                                  "SAC 999794, GST 18%)"),
        "invoice_type":          "B2C",
        "recipient_gstin":       "",
        "recipient_legal_name":  "",
        "recipient_trade_name":  "",
        "recipient_address":     "",
        "recipient_state":       "Karnataka",
        "recipient_state_code":  "29",
        "linked_credit_note_ids": [],
        "linked_credit_note_id":  None,
        "createdBy":             actor or "system",
        "lastModifiedBy":        actor or "system",
        "lastModifiedAt":        now_str,
        "booking_source":        "cancellation_charge",
        "payment_source":        "hotel",
    }
    try:
        bills_ref.document(bill_id).set(bill_doc)
        logger.info(
            f"create_cancellation_charge_bill: minted {bill_number} "
            f"booking={booking_id} amount=Rs.{retained_amount} "
            f"taxable={taxable} gst={gst_amount}"
        )
        return bill_doc
    except Exception as e:
        logger.error(f"create_cancellation_charge_bill failed: {e}", exc_info=True)
        return None


def generate_sequential_credit_note_number(cn_date):
    """Mint next CN/YYYY/MM/XXXXX. Atomic Firestore transaction. Min value 1."""
    try:
        year  = cn_date.year
        month = str(cn_date.month).zfill(2)
        counter_key = f"cn_{year}_{month}"
        counter_ref = counters_ref.document(counter_key)
        txn         = db.transaction()

        @firestore.transactional
        def _inc(t, ref):
            snap    = ref.get(transaction=t)
            new_val = (snap.get("count") + 1) if snap.exists else 1
            t.set(ref, {"count": new_val})
            return new_val

        seq    = _inc(txn, counter_ref)
        serial = str(seq).zfill(5)
        return f"CN/{year}/{month}/{serial}"
    except Exception as e:
        logger.error(f"Error generating CN number: {e}")
        ts = max(1, int(cn_date.timestamp()) % 100000)
        return f"CN/{cn_date.year}/{str(cn_date.month).zfill(2)}/{ts:05d}"


CN_REASONS = (
    "checkout_mistake",
    "post_supply_discount",
    "service_deficiency",
    "cancellation",
    "other",
)

CN_REASON_GSTR1 = {
    "checkout_mistake":     "04-Correction in Invoice",
    "post_supply_discount": "02-Post Sale Discount",
    "service_deficiency":   "03-Deficiency in services",
    "cancellation":         "01-Sales Return",
    "other":                "07-Others",
}


def create_credit_note(
    *,
    bill_id,
    bill_data,
    cn_date,
    reason,
    reason_text,
    credit_taxable,
    credit_cgst,
    credit_sgst,
    credit_total,
    actor=None,
    idempotency_key=None,
):
    """Mint CN number, write credit_notes/{cn_id}, link onto original bill.
    Idempotent on idempotency_key."""
    import uuid as _uuid
    if reason not in CN_REASONS:
        logger.error(f"create_credit_note: invalid reason {reason!r}")
        return None
    if not bill_id or not isinstance(bill_data, dict):
        logger.error("create_credit_note: missing bill_id or bill_data")
        return None
    if not cn_date:
        logger.error("create_credit_note: cn_date is required")
        return None

    try:
        if idempotency_key:
            try:
                existing = (
                    credit_notes_ref
                    .where("idempotency_key", "==", idempotency_key)
                    .limit(1).stream()
                )
                for snap in existing:
                    d = snap.to_dict() or {}
                    d["cn_id"] = snap.id
                    logger.info(
                        f"create_credit_note: idempotent hit "
                        f"(key={idempotency_key}) -> {d.get('cn_number')}"
                    )
                    return d
            except Exception as _ie:
                logger.warning(f"create_credit_note: idempotency lookup failed: {_ie}")

        cn_id     = _uuid.uuid4().hex
        cn_number = generate_sequential_credit_note_number(cn_date)
        cn_date_s = cn_date.strftime("%Y-%m-%d")
        now_iso   = datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")

        gst_rate = int(bill_data.get("gst_rate", 0) or 0)

        # G1 (CN side): route the credit GST to the correct tax head based on
        # the original bill's place of supply. Callers pass (cgst, sgst) from
        # compute_credit_components which always returns the half-split; if the
        # bill is inter-state we re-route those into igst here so the CN
        # reverses the same tax head that was charged on the invoice.
        _rcpt_state_code = (bill_data.get("recipient_state_code") or "29")
        _rcpt_state_code = str(_rcpt_state_code).strip() or "29"
        _is_inter_state_cn = _rcpt_state_code != "29"
        _cgst_in = float(credit_cgst or 0)
        _sgst_in = float(credit_sgst or 0)
        if _is_inter_state_cn:
            _cn_cgst = 0.0
            _cn_sgst = 0.0
            _cn_igst = round(_cgst_in + _sgst_in, 2)
        else:
            _cn_cgst = _cgst_in
            _cn_sgst = _sgst_in
            _cn_igst = 0.0

        _rcpt_state = (bill_data.get("recipient_state") or "Karnataka")

        cn_doc = {
            "cn_id":               cn_id,
            "cn_number":           cn_number,
            "cn_date":             cn_date_s,
            "against_bill_id":     bill_id,
            "against_bill_number": bill_data.get("bill_number") or "",
            "against_invoice_date": (bill_data.get("checkout_time") or "")[:10],
            "reason":              reason,
            "reason_text":         (reason_text or "")[:500],
            "recipient_gstin":     (bill_data.get("recipient_gstin")     or ""),
            "recipient_legal_name": (bill_data.get("recipient_legal_name") or
                                     bill_data.get("guest_name") or ""),
            "recipient_trade_name": (bill_data.get("recipient_trade_name") or ""),
            "recipient_address":   (bill_data.get("recipient_address") or ""),
            "recipient_state":     _rcpt_state,
            "recipient_state_code": _rcpt_state_code,
            "invoice_type":        (bill_data.get("invoice_type") or "B2C"),
            "credit_amount_taxable": float(credit_taxable or 0),
            "credit_amount_cgst":  _cn_cgst,
            "credit_amount_sgst":  _cn_sgst,
            "credit_amount_igst":  _cn_igst,
            "credit_amount_total": int(round(credit_total or 0)),
            "gst_rate":            gst_rate,
            "sac_or_hsn":          "9963",
            # Place of supply mirrors the original bill — used by GSTR-1
            # export to bucket the CN into the right destination state.
            "place_of_supply":     f"{_rcpt_state} ({_rcpt_state_code})",
            "created_at":          now_iso,
            "created_by":          actor or "system",
            "pdf_url":             "",
            "idempotency_key":     idempotency_key or "",
            "guest_name":          bill_data.get("guest_name") or "",
            "guest_mobile":        bill_data.get("guest_mobile") or "",
            "room":                str(bill_data.get("room") or ""),
        }

        batch = db.batch()
        batch.set(credit_notes_ref.document(cn_id), cn_doc)
        existing_links = bill_data.get("linked_credit_note_ids") or []
        if cn_id not in existing_links:
            updated_links = list(existing_links) + [cn_id]
            batch.update(bills_ref.document(bill_id), {
                "linked_credit_note_ids": updated_links,
                "linked_credit_note_id":  cn_id,
                "lastModifiedAt":         now_iso,
            })
        batch.commit()

        logger.info(
            f"create_credit_note: minted {cn_number} for bill "
            f"{bill_data.get('bill_number') or bill_id} reason={reason} "
            f"amount={credit_total}"
        )

        # Fire-and-forget PDF generation so the CN is downloadable
        # immediately from the Credit Notes sub-tab. Best-effort —
        # failure here only delays the PDF until the operator clicks
        # "Generate" manually.
        try:
            import threading as _thr
            _thr.Thread(target=_auto_generate_cn_pdf,
                        args=(cn_id,), daemon=True).start()
        except Exception as _pe:
            logger.warning(f"create_credit_note: CN PDF auto-gen skipped: {_pe}")

        return cn_doc

    except Exception as e:
        logger.error(f"create_credit_note failed: {e}", exc_info=True)
        return None


def _auto_generate_cn_pdf(cn_id):
    """Background helper — builds + uploads the CN PDF for a freshly
    minted credit note. Mirrors render_credit_note_pdf but without
    going through the HTTP layer."""
    try:
        if not cn_id:
            return
        snap = credit_notes_ref.document(cn_id).get()
        if not snap.exists:
            return
        cn = snap.to_dict() or {}
        cn["cn_id"] = snap.id
        if cn.get("pdf_url"):
            return   # already generated (e.g. idempotency or manual click)

        from routes.billing import _build_credit_note_html, _build_pdf_html
        try:
            from xhtml2pdf import pisa
        except ImportError:
            logger.warning("_auto_generate_cn_pdf: xhtml2pdf not installed; skipping")
            return

        import io as _io, urllib.parse as _u, uuid as _uu
        from firebase_admin import storage as _fb_storage
        from firebase_admin import firestore as _fs

        full_html = _build_pdf_html(_build_credit_note_html(cn))
        buf = _io.BytesIO()
        result = pisa.CreatePDF(full_html, dest=buf)
        if result.err:
            logger.warning(f"_auto_generate_cn_pdf({cn_id}): xhtml2pdf error code {result.err}")
            return

        bucket = _fb_storage.bucket()
        safe_no = (cn.get("cn_number") or cn_id).replace("/", "_").replace(" ", "_")
        existing_versions = cn.get("versions") or []
        next_version = len(existing_versions) + 1
        blob_path = f"credit_notes/{safe_no}/v{next_version}.pdf"
        blob = bucket.blob(blob_path)
        token = str(_uu.uuid4())
        blob.metadata = {"firebaseStorageDownloadTokens": token}
        blob.upload_from_string(buf.getvalue(), content_type="application/pdf")
        encoded = _u.quote(blob_path, safe="")
        url = (f"https://firebasestorage.googleapis.com/v0/b/"
               f"{bucket.name}/o/{encoded}?alt=media&token={token}")

        credit_notes_ref.document(cn_id).update({
            "pdf_url":        url,
            "versions":       _fs.ArrayUnion([{
                "version": next_version, "url": url,
                "uploaded_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
            }]),
            "pdf_updated_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
        })
        logger.info(f"_auto_generate_cn_pdf: PDF v{next_version} stored for {cn.get('cn_number')}")
    except Exception as e:
        logger.error(f"_auto_generate_cn_pdf({cn_id}) failed: {e}", exc_info=True)



def section_34_window_status(invoice_date, today=None):
    """30-Nov deadline check for Section 34 credit notes."""
    from datetime import date as _date, datetime as _dt
    if invoice_date is None:
        return {"in_window": True, "deadline": None, "days_left": None}
    if isinstance(invoice_date, str):
        try:
            invoice_date = _dt.strptime(invoice_date[:10], "%Y-%m-%d").date()
        except (ValueError, TypeError):
            return {"in_window": True, "deadline": None, "days_left": None}
    elif isinstance(invoice_date, _dt):
        invoice_date = invoice_date.date()
    if invoice_date.month >= 4:
        fy_start_year = invoice_date.year
    else:
        fy_start_year = invoice_date.year - 1
    deadline = _date(fy_start_year + 1, 11, 30)
    today_d = (today or _dt.now(IST)).date() if not isinstance(today, _date) else today
    days_left = (deadline - today_d).days
    return {"in_window": days_left >= 0, "deadline": deadline, "days_left": days_left}



def compute_credit_components(bill_data, credit_total):
    """Split a CN total into taxable, cgst, sgst per GST-inclusive math."""
    try:
        rate = int(bill_data.get("gst_rate", 0) or 0)
        total = float(credit_total or 0)
        if rate <= 0 or total <= 0:
            return (round(total, 2), 0.0, 0.0)
        gst = round(total * rate / (100 + rate), 2)
        taxable = round(total - gst, 2)
        return (taxable, round(gst / 2, 2), round(gst / 2, 2))
    except Exception:
        return (round(float(credit_total or 0), 2), 0.0, 0.0)


threading.Thread(target=initialize_data, daemon=True).start()
