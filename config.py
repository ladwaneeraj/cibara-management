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

# ══════════════════════════════════════════════════════════════════════════
# ROOM CATEGORY MAP
# ══════════════════════════════════════════════════════════════════════════
# Server-side mirror of `_ROOM_CATEGORY_MAP` in static/script.js. Used to
# enforce the "transfer only within the same category" rule on the backend.
# KEEP IN SYNC with the JS map — if a room is recategorised there, update it
# here too. AC is a price toggle within the "premium" category, not a separate
# category, so 200–206 are all "premium" (matches the JS source of truth).
def _build_room_category_map():
    m = {}
    # First-floor: Single Non-Attach (1–5, 13–20)
    for n in [1, 2, 3, 4, 5]:
        m[str(n)] = "single-non-attach"
    for n in range(13, 21):
        m[str(n)] = "single-non-attach"
    # First-floor: Double Non-Attach (23–27)
    for n in range(23, 28):
        m[str(n)] = "double-non-attach"
    # Second-floor: Premium (200–206 — AC toggle handled separately)
    for n in range(200, 207):
        m[str(n)] = "premium"
    # Second-floor: Regular (207, 208–211, 215, 220–222)
    m["207"] = "regular"
    for n in range(208, 212):
        m[str(n)] = "regular"
    m["215"] = "regular"
    for n in range(220, 223):
        m[str(n)] = "regular"
    # Second-floor: Deluxe (223–227)
    for n in range(223, 228):
        m[str(n)] = "deluxe"
    # Second-floor: Single Attach (212–214, 216–219)
    for n in range(212, 215):
        m[str(n)] = "single-attach"
    for n in range(216, 220):
        m[str(n)] = "single-attach"
    # Party Hall (228)
    m["228"] = "party-hall"
    return m


_ROOM_CATEGORY_MAP = _build_room_category_map()


def room_category(room_number):
    """Return the rate-slab category for a room number (str/int). Unmapped
    rooms fall back to "other" — matching the JS helper."""
    return _ROOM_CATEGORY_MAP.get(str(room_number), "other")


# ── Server-side room pricing ────────────────────────────────────────────────
# Python mirror of roomPricing.calculatePrice() in static/script.js.
# KEEP IN SYNC with the JS map — the server is authoritative for
# cross-category transfers (/transfer_room re-rates the stay from here).
# AC surcharge: +₹600/night, only meaningful for "premium" (200–206).
AC_SURCHARGE = 600


def room_base_price(room_number, guest_count=1):
    """Standard per-night rate (non-AC base) for a room + guest count.

    Mirrors static/script.js roomPricing.calculatePrice(). Returns an int.
    The AC surcharge is NOT included — callers add AC_SURCHARGE when the
    stay is premium with the AC toggle on.
    """
    key = str(room_number)
    try:
        guests = int(guest_count or 1)
    except (TypeError, ValueError):
        guests = 1
    if guests < 1:
        guests = 1
    cat = room_category(key)

    if cat == "single-non-attach":
        return 250
    if cat == "double-non-attach":
        return 300 if guests == 1 else 500
    if cat == "premium":
        return 1200 + max(0, guests - 2) * 300
    if cat == "regular":
        # 220–222 are priced differently from the rest of Regular.
        if key in ("220", "221", "222"):
            return 700 + max(0, guests - 1) * 300
        return 450 if guests == 1 else 700 + max(0, guests - 2) * 300
    if cat == "deluxe":
        return 900 + max(0, guests - 2) * 300
    if cat == "single-attach":
        return 450 if guests == 1 else 700
    # party-hall / other — same fallback as the JS helper.
    return 500

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

    # mmt_hotel_issues_invoice (bool, default True):
    #   Controls whether the HOTEL issues its own GST tax invoice for the
    #   ROOM portion of a pure MMT (OTA) stay.
    #
    #   True (default): the property's GSTIN is registered on MMT, so the
    #          hotel is the supplier of the accommodation and declares the
    #          room supply in its own GSTR-1. MMT room stays get a sequential
    #          bill number + invoice_generated=True, the room is taxed at the
    #          normal 5% accommodation slab (NOT exempt), and the invoice is
    #          B2B when the guest company's GSTIN is on the voucher, else B2C.
    #          The room money is collected by MMT and settles to the bank
    #          later, so it is recorded as an "ota"-method payment on the
    #          stay (zeroing the bill balance) rather than as a front-desk
    #          cash/online receipt. The MMT commission is booked as a
    #          (report-type) expense when the settlement is marked received.
    #
    #   False: legacy behaviour — MMT handles the room invoice; the hotel
    #          issues no room invoice (invoice_generated=False, bill_number
    #          "-"). Use only if you revert your MMT GST registration.
    "mmt_hotel_issues_invoice": True,
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
    # incognito_mode (bool, default False):
    #   True  → single master switch. The frontend hides the Transactions and
    #           Register tabs and the bill-modal "Edit Price" button; the
    #           backend forces bill generation for every stay (OR-ed into
    #           always_generate_bill in create_bill_record). Kept here (not in
    #           billing_config) so the one Incognito toggle drives both UI and
    #           billing behaviour from a single doc.
    #   False → default.
    "incognito_mode": False,
    # listener_first (bool, default False):
    #   True  → the frontend treats the Firestore onSnapshot listeners in
    #           static/google_sync.js as the source of truth for the dashboard.
    #           The boot-time /get_data, /get_transaction_metadata and
    #           /get_upcoming_bookings calls are skipped entirely: the first
    #           paint comes from the SDK's IndexedDB cache (instant, zero
    #           billed reads) and the listeners deliver only what changed.
    #           Cuts Firestore reads roughly in half by removing the
    #           server-side duplicate of data the listeners already carry.
    #   False → default; legacy path. The dashboard is painted from /get_data
    #           and the listeners skip their first snapshot.
    #
    #   This is a kill switch. Flipping it to False from any device restores
    #   the legacy path on the next page load with no redeploy. Individual
    #   devices can override it for testing via
    #   localStorage.cibara_listener_first = "1" | "0".
    "listener_first": False,
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


def renumber_day_serials(date_str):
    """
    Re-rank every check-in on `date_str` by check-in time and reassign the
    daily serial (#) 1..N across ALL stays that day — active AND checked-out.
    Keeps the register's # column in check-in-time order after a check-in
    time/date edit. Updates each stay's check-in payment, its
    transaction_metadata (date_room), the linked bill doc (via stay_id), and
    the day counter. Best-effort: logs and continues on error.

    Returns a list of {stay_id, room, name, time, serial} in the NEW order,
    or [] on failure / no check-ins that day.
    """
    try:
        from google.cloud.firestore_v1.base_query import FieldFilter as _FF
        payments_ref = db.collection("payments")
        checkins = []
        for d in payments_ref.where(filter=_FF("date", "==", date_str)).stream():
            pd = d.to_dict() or {}
            if pd.get("transaction_type") in ("fresh_checkin", "booking_conversion"):
                checkins.append((d.id, pd))
        if not checkins:
            return []
        # Chronological by check-in time ("HH:MM"); stable tie-break on the
        # previous serial so equal times keep their relative order.
        checkins.sort(key=lambda it: ((it[1].get("time") or "99:99"),
                                      (it[1].get("serial_number") or 9999)))
        now_str = datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")
        order = []
        batch = db.batch()
        writes = 0
        for idx, (pid, pd) in enumerate(checkins, start=1):
            room = str(pd.get("room") or "")
            sid = pd.get("stay_id")
            batch.update(payments_ref.document(pid), {"serial_number": idx})
            batch.set(metadata_ref.document(f"{date_str}_{room}"),
                      {"serial_number": idx, "transaction_type": "renumber",
                       "timestamp": now_str}, merge=True)
            if sid:
                batch.set(bills_ref.document(sid), {"serial_number": idx}, merge=True)
            writes += 3
            order.append({"stay_id": sid, "room": room, "name": pd.get("name"),
                          "time": pd.get("time"), "serial": idx})
            if writes >= 400:
                batch.commit(); batch = db.batch(); writes = 0
        # Day counter = N so the next check-in continues the sequence.
        batch.set(counters_ref.document(date_str), {"count": len(checkins)}, merge=True)
        batch.commit()
        logger.info(f"renumber_day_serials({date_str}): re-ranked {len(checkins)} check-ins")
        return order
    except Exception as e:
        logger.error(f"renumber_day_serials({date_str}) failed: {e}", exc_info=True)
        return []


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

        # One-time auto-backfill of customers' `last_stay_amount` so the
        # check-in "last paid" column is never blank for guests who predate
        # the field or whose stay skipped the checkout stamp. Guarded by a
        # sentinel so it runs ONCE per project, off the request path.
        threading.Thread(target=_auto_backfill_last_stay, daemon=True).start()

        return True
    except Exception as e:
        logger.error(f"Error initializing Firebase data: {str(e)}")
        return False


def _auto_backfill_last_stay():
    """
    Run customer_service.backfill_last_stay_amounts() exactly once, guarded by
    a sentinel doc (settings/app_meta.last_stay_backfill_version). Idempotent:
    the backfill itself skips already-stamped customers, and any failure is
    logged without affecting startup. Bump SENTINEL_VERSION to force a re-run
    after changing the backfill logic.
    """
    SENTINEL_VERSION = 1
    try:
        meta_ref = settings_ref.document('app_meta')
        meta = (meta_ref.get().to_dict() or {})
        if int(meta.get('last_stay_backfill_version', 0)) >= SENTINEL_VERSION:
            return  # already done for this version
        result = customer_service.backfill_last_stay_amounts()
        meta_ref.set({
            'last_stay_backfill_version': SENTINEL_VERSION,
            'last_stay_backfill_at': datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
            'last_stay_backfill_result': result,
        }, merge=True)
        logger.info(f"[last_stay backfill] auto-run complete: {result}")
    except Exception as e:
        logger.error(f"[last_stay backfill] auto-run failed: {e}")

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

class SequentialNumberError(RuntimeError):
    """
    Raised when a statutory document number (bill / credit note) cannot be
    allocated from the atomic Firestore counter.

    This must NEVER be papered over with a fallback number: GST Rule 46(b)
    requires a consecutive serial — a synthetic/timestamp number breaks the
    series, can collide with a real one, and corrupts GSTR-1 Table 13.
    Callers must abort the operation and surface the error.
    """


class BillCreationError(Exception):
    """
    Raised when create_bill_record() cannot produce a bill for a checkout.

    Checkout MUST be blocked when this is raised — the pre-2026-06 behaviour
    (return None, silently cancel the draft, let the guest leave) caused
    invoices to vanish from the Register and GSTR-1 with no trace.

    Attributes:
        reason       — human-readable cause, safe to show to front-desk staff.
        bill_number  — set ONLY if a sequential number was already minted
                       before the failure. The counter cannot be rolled back,
                       so this number is consumed: it must be reported as a
                       cancelled document in GSTR-1 Table 13. The alert that
                       checkout writes records it for exactly that purpose.
    """

    def __init__(self, reason, bill_number=None):
        super().__init__(reason)
        self.reason = reason
        self.bill_number = bill_number


# ── OTA prepaid channels ────────────────────────────────────────────────────
# Channels that collect the FULL stay tariff from the guest up front and settle
# net to the hotel later. The guest owes the front desk nothing on arrival, so
# the whole stay is pre-charged at check-in, the tariff is recorded as an "ota"
# payment, and the room carries a zero balance.
#
# This lived as three separate literal comparisons that had drifted apart:
#   config.py         booking_source in ("mmt", "agoda")   <- invoicing
#   bookings.py:971   booking_source == "mmt"              <- prepaid handling
#   rooms.py:3650     booking_source in ("mmt", "ota")     <- transfer re-rating
#
# So an Agoda stay was invoiced as OTA but never given the prepaid treatment:
# no ota_prepaid payment row, renewal_count left at 0, and the room opened with
# the full tariff as balance due. A Rs.2,400 two-night Agoda booking showed
# Rs.2,400 outstanding on an invoice the guest had already paid Agoda for, and
# checkout blocked on it. The transfer path was inconsistent a third way and
# re-rated Agoda stays that should never be re-rated.
#
# One tuple, one predicate, imported everywhere. Adding a channel is one edit.
OTA_PREPAID_SOURCES = ("mmt", "agoda")


def is_ota_prepaid(doc) -> bool:
    """True when this booking/room is an OTA stay the channel has prepaid.

    Requires BOTH the source and payment_source == "ota": an OTA-sourced
    booking the hotel collects for itself is an ordinary stay.
    Accepts a booking doc or a room doc; missing/odd shapes return False.
    """
    if not isinstance(doc, dict):
        return False
    if (doc.get("payment_source") or "") != "ota":
        return False
    return (doc.get("booking_source") or "") in OTA_PREPAID_SOURCES


def create_bill_record(room, room_data, checkout_time, batch=None,
                       settle_later=False, settlement_id=None,
                       defer_number=False):
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
            raise BillCreationError(
                "guest data is missing on the room — cannot build the bill. "
                "Re-open the room card and verify the stay, then retry checkout."
            )

        checkin_time = room_data.get("checkin_time")
        if not checkin_time:
            raise BillCreationError(
                "check-in time is missing on the room — cannot build the bill. "
                "Fix the check-in time on the room card, then retry checkout."
            )

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
            """Return the raw booking dict (or None) for OTA / source fields.

            Primary lookup is by stay_id (the canonical FK stamped on the
            booking at conversion) — robust even when the guest checked in on a
            different calendar date than the booking's check_in_date (which is
            exactly when the legacy (room, guest, check_in_date) query missed
            and the bill fell back to booking_source='normal' for MMT stays).
            Falls back to the heuristic query for legacy bookings with no
            stay_id.
            """
            _sid = room_data.get("active_bill_id")
            if _sid:
                try:
                    bq = (
                        bookings_ref
                        .where("stay_id", "==", _sid)
                        .limit(1)
                        .stream()
                    )
                    for bdoc in bq:
                        return bdoc.to_dict()
                except Exception as _be:
                    logger.warning(
                        f"create_bill_record: booking lookup by stay_id "
                        f"{_sid} failed: {_be}; trying heuristic"
                    )
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

        # is_live_charge on the RECEIPT side too, not just the charge side.
        # /void_add_on flags the payments row `voided` whatever the method was
        # AND decrements totals[cash|online] — the money is treated as handed
        # back. Filtering the charge (services_total, below) without filtering
        # the receipt left the void counted as money still in the drawer:
        # a Rs.700 night with a voided Rs.60 cash add-on billed Rs.700 against
        # Rs.760 received and offered the guest a SECOND Rs.60 refund, while
        # /reports (which does filter) and the Bills tab (which reads the
        # stored payment_cash) reported two further different figures for the
        # same stay. It also defeated the is_no_bill check below — a voided
        # ONLINE add-on left payment_online > 0 and burned a sequential GST
        # invoice number on a stay that should never have had one.
        payment_cash = sum(
            p.get("amount", 0) for p in stay_payments
            if p.get("method") == "cash" and p.get("type") not in _exclude
            and payment_service.is_live_charge(p)
        )
        payment_online = sum(
            p.get("amount", 0) for p in stay_payments
            if p.get("method") == "online" and p.get("type") not in _exclude
            and payment_service.is_live_charge(p)
        )
        # OTA-settled amount (method="ota"): the room money MMT collected up
        # front and settles to the bank later. It is NOT a front-desk receipt
        # — it never counts in the cash/online drawer tallies — but it DOES
        # settle the guest's liability, so it must be subtracted from the
        # bill balance (otherwise an MMT room invoice shows the full tariff as
        # "balance due" even though the guest owes the hotel nothing).
        payment_ota = sum(
            p.get("amount", 0) for p in stay_payments
            if p.get("method") == "ota" and p.get("type") not in _exclude
            and payment_service.is_live_charge(p)
        )

        services = []
        services_total = 0
        for p in stay_payments:
            # is_live_charge: a voided add-on stays in the collection for
            # history but must not reach the invoice. Single definition in
            # payment_service so the folio, the balance preview and the
            # payment modal cannot drift apart from the bill.
            if p.get("type") == "addon" and payment_service.is_live_charge(p):
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
                # Same-day checkout after a shift normally still bills 1 night
                # in the new room. EXCEPT when the transfer folded the
                # in-progress day into the old segment ("apply today's
                # difference" OFF in /transfer_room) — that day is already
                # billed at the old rate inside pre_transfer_charges, and
                # forcing 1 here would double-charge it.
                _prebilled = guest.get("transfer_day_prebilled")
                _min_days = 0 if (_prebilled and _prebilled == last_transfer_date) else 1
                if days_in_current_room < _min_days:
                    days_in_current_room = _min_days
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
        balance = total_amount - payment_cash - payment_online - payment_ota + total_refunds

        # ── GST Calculation (SAC 9963 — Accommodation Services) ─────────────────
        # GST slab is determined by the value of supply per night.
        #   up to ₹7,500 → 5%  (no ITC)
        #   above ₹7,500 → 18%
        # A sub-₹1,000 exempt band is in force by business decision
        # (19 Aug 2026, on CA advice) — see _slab_for_value.
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

        # Slab comes from _slab_for_value — the single definition of the
        # accommodation rate table. It used to be re-typed here and in three
        # other places; a rate change then needed four coordinated edits.
        _gst_rate_for_price = _slab_for_value

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
            # Bucketed by slab and computed on each bucket's TOTAL — see
            # aggregate_folio_tax. Summing the per-night rounded figures (what
            # this used to do) both drifted from the true tax and produced
            # CGST != SGST, which is a defect on an intra-state invoice.
            _agg = aggregate_folio_tax(daily_folio)
            gst_amount             = _agg["tax"]
            accommodation_taxable  = _agg["taxable"]
            bill_cgst_amount       = _agg["cgst"]
            bill_sgst_amount       = _agg["sgst"]
            bill_igst_amount       = _agg["igst"]

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
        # Seed from the room doc (stamped at check-in by convert_booking_to_checkin)
        # so the source is correct even if the booking_doc lookup fails — then
        # let booking_doc override with the authoritative value when present.
        booking_source    = room_data.get("booking_source", "normal") or "normal"
        payment_source    = room_data.get("payment_source", "hotel") or "hotel"
        ota_total_amount  = 0
        ota_commission    = 0.0
        ota_commission_gst = 0.0
        net_receivable    = 0
        settlement_status = None
        # B2B recipient details carried on the booking (e.g. an MMT MyBiz
        # corporate booking ingested with the customer GSTIN). These default
        # to blank/B2C and are only populated when the booking actually
        # carries a recipient GSTIN. Pulling them through here means an MMT
        # B2B stay is correctly classified for GSTR-1 at checkout WITHOUT the
        # operator re-keying the GST modal. /update_bill_gst can still
        # override post-checkout.
        bk_recipient_gstin      = ""
        bk_recipient_legal_name = ""
        bk_recipient_trade_name = ""
        bk_recipient_address    = ""
        bk_recipient_state      = "Karnataka"
        bk_recipient_state_code = "29"
        bk_invoice_type         = "B2C"
        if booking_doc:
            # Default to the room-seeded value (not a hardcoded "normal") so a
            # booking_doc that happens to omit the field can't downgrade it.
            booking_source     = booking_doc.get("booking_source", booking_source)
            payment_source     = booking_doc.get("payment_source", payment_source)
            ota_total_amount   = booking_doc.get("ota_total_amount", 0)
            ota_commission     = booking_doc.get("ota_commission", 0.0)
            ota_commission_gst = booking_doc.get("ota_commission_gst", 0.0)
            net_receivable     = booking_doc.get("net_receivable", 0)
            settlement_status  = booking_doc.get("settlement_status")
            _bk_gstin = (booking_doc.get("recipient_gstin") or "").strip().upper()
            if validate_gstin(_bk_gstin):
                bk_recipient_gstin      = _bk_gstin
                bk_recipient_legal_name = booking_doc.get("recipient_legal_name", "") or booking_doc.get("recipient_trade_name", "")
                bk_recipient_trade_name = booking_doc.get("recipient_trade_name", "") or booking_doc.get("recipient_legal_name", "")
                bk_recipient_address    = booking_doc.get("recipient_address", "")
                _st_name, _st_code = derive_state_from_gstin(_bk_gstin)
                bk_recipient_state      = booking_doc.get("recipient_state") or _st_name or "Karnataka"
                bk_recipient_state_code = booking_doc.get("recipient_state_code") or _st_code or "29"

        # ── Stay-level GST profile (set at check-in) ──────────────────────────
        # When the operator answered "yes, apply this guest's stored GST
        # details" on the check-in form, /checkin stamped them onto the room
        # doc. Seed the invoice from them here so a returning corporate guest
        # comes out B2B WITHOUT anybody opening the GST modal after checkout.
        #
        # A booking's own GSTIN wins if it has one. That is more specific:
        # somebody entered it for THIS reservation, whereas the stay-level
        # profile is a remembered default. Both are re-validated rather than
        # trusted, because a stored GSTIN can go stale between visits and a
        # malformed one must never reach GSTR-1.
        if not bk_recipient_gstin:
            try:
                _stay_gst = room_data.get("gst_profile") or {}
                _sg = str(_stay_gst.get("gstin") or "").strip().upper()
                if validate_gstin(_sg):
                    bk_recipient_gstin      = _sg
                    bk_recipient_legal_name = (_stay_gst.get("legal_name") or
                                               _stay_gst.get("trade_name") or "")
                    bk_recipient_trade_name = (_stay_gst.get("trade_name") or
                                               _stay_gst.get("legal_name") or "")
                    bk_recipient_address    = _stay_gst.get("address") or ""
                    _sn, _sc = derive_state_from_gstin(_sg)
                    bk_recipient_state      = _stay_gst.get("state") or _sn or "Karnataka"
                    bk_recipient_state_code = _stay_gst.get("state_code") or _sc or "29"
                    logger.info(f"create_bill_record: applying stay-level GST "
                                f"profile (GSTIN={_sg}) from check-in")
                elif _sg:
                    logger.warning(f"create_bill_record: stay-level GSTIN "
                                   f"{_sg!r} failed validation — ignored, "
                                   f"bill stays B2C")
            except Exception as _sg_err:
                logger.warning(f"create_bill_record: stay GST profile read "
                               f"failed, ignoring: {_sg_err}")

        # ── Invoice flag logic ────────────────────────────────────────────────────
        # invoice_generated = True when this bill qualifies as a formal GST tax invoice.
        # bill_number (CC/YYYY/MM/XXXXX) is the single reference — no separate INV/... number.
        # Both flags gate whether a GST invoice number is minted, so a voided
        # service must not satisfy them. Without is_live_charge here, adding a
        # service by mistake on an MMT stay and voiding it still tripped the
        # service-only-bill branch and burned an invoice number on a stay with
        # no live services — a number that then has to be explained in GSTR-1.
        any_addon_online = any(
            p.get("type") == "addon" and p.get("method") == "online"
            and payment_service.is_live_charge(p)
            for p in stay_payments
        )
        # any service/addon (cash OR online) — used for MMT service-only bill trigger
        any_addon = any(
            p.get("type") == "addon" and payment_service.is_live_charge(p)
            for p in stay_payments
        )
        is_same_day = checkin_dt.date() == checkout_dt.date()
        # OTA stays where the hotel issues the room tax invoice and the room
        # money settles to the bank (MMT and Agoda behave identically here).
        # Name kept as is_mmt_ota because the downstream invoice/GST branches
        # reference it; broadening the source set makes Agoda follow the exact
        # same path as MMT without a sprawling rename.
        is_mmt_ota = is_ota_prepaid({"booking_source": booking_source,
                                    "payment_source": payment_source})
        is_booking_com = (booking_source == "booking.com")
        # ── Read billing config FIRST ────────────────────────────────────────
        # This MUST precede any use of mmt_hotel_issues_invoice / always_generate_bill
        # below. It previously sat AFTER `mmt_service_only`, which references
        # mmt_hotel_issues_invoice — so an MMT checkout that included a service
        # (any_addon True) evaluated the variable before assignment, raising
        # UnboundLocalError. create_bill_record then returned None and the
        # checkout flipped the draft to "cancelled" — no invoice was ever minted.
        # Reordering the read above its first use is the fix.
        try:
            _billing_cfg = get_billing_config()
        except Exception as _cfg_err:
            # Defensive: never let a settings read break checkout.
            logger.warning(f"create_bill_record: billing_config read failed, "
                           f"using defaults: {_cfg_err}")
            _billing_cfg = dict(_BILLING_CONFIG_DEFAULTS)
        always_generate_bill = bool(_billing_cfg.get("always_generate_bill", False))
        # Incognito mode (settings/ui_config) is a superset switch: when ON it
        # forces bill generation for every stay, exactly like always_generate_bill.
        # We OR it in here so the single Incognito toggle governs billing without
        # having to also flip the standalone always_generate_bill flag. Read is
        # defensive — a ui_config blip must never break checkout.
        try:
            if bool(get_ui_config().get("incognito_mode", False)):
                always_generate_bill = True
        except Exception as _incog_err:
            logger.warning(f"create_bill_record: ui_config read failed, "
                           f"ignoring incognito: {_incog_err}")
        # Guest-level sticky preference. If this guest asked for a bill on an
        # earlier stay — it was printed for them, or WhatsApp'd to them — they
        # get one again, whatever they pay with. Same OR as incognito above,
        # deliberately: it is the same kind of switch, just scoped to one
        # person instead of the whole property.
        #
        # Costs ONE document read per checkout, which is the price of the
        # preference being live: a guest who asks for a bill at 6pm must be
        # billed at 8pm, so there is no cache here. Any failure leaves
        # always_generate_bill untouched, i.e. exactly the old behaviour.
        try:
            _guest_mobile = str((guest or {}).get("mobile") or "").strip()
            if _guest_mobile and customer_service.wants_bill(_guest_mobile):
                always_generate_bill = True
                logger.info(f"create_bill_record: guest {_guest_mobile} has "
                            f"wants_bill set — forcing bill generation")
        except Exception as _pref_err:
            logger.warning(f"create_bill_record: wants_bill lookup failed, "
                           f"ignoring preference: {_pref_err}")
        # When the property's own GSTIN is registered on MMT, the hotel issues
        # the room tax invoice itself (see _BILLING_CONFIG_DEFAULTS note).
        # C3 — OTA invoices are MANDATORY. The lodge is GST-registered, so
        # Section 9(5) does NOT shift accommodation liability to the OTA:
        # every OTA stay is the hotel's own outward supply and MUST carry a
        # sequential tax invoice. The legacy model (OTA bills the room, the
        # hotel mints no number, bill_number "-") silently dropped those
        # supplies from GSTR-1. The Settings key is still read so old
        # configs don't error, but it can no longer disable invoicing.
        mmt_hotel_issues_invoice = True
        if not bool(_billing_cfg.get("mmt_hotel_issues_invoice", True)):
            logger.warning(
                "billing_config.mmt_hotel_issues_invoice=False is no longer "
                "honoured — OTA stays always receive a hotel tax invoice "
                "(registered supplier must report the supply in GSTR-1)."
            )

        # MMT service-only bill: room rent is billed by MMT, hotel issues an
        # invoice for the in-hotel service/addon portion only (cash or UPI).
        # This ONLY applies in the legacy model where the hotel does not issue
        # the room invoice. When mmt_hotel_issues_invoice is on, the hotel
        # bills the room itself at 5% (room charges are NOT zeroed), so a
        # service-taken MMT stay is a normal room+service invoice.
        mmt_service_only = is_mmt_ota and any_addon and not mmt_hotel_issues_invoice

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
        elif is_mmt_ota and mmt_hotel_issues_invoice:
            # Property is GST-registered on MMT → the hotel issues the room
            # tax invoice itself and reports the supply in its own GSTR-1
            # (B2B/B2C decided by the recipient details carried on the
            # booking). The room money is collected by MMT and settles later,
            # so payment columns stay zero — this is an invoice, not a receipt.
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
            needs_bill_number = False
        elif is_mmt_ota and not mmt_service_only and not mmt_hotel_issues_invoice:
            # Pure MMT room stay (no service) and the hotel does NOT issue the
            # room invoice → no hotel bill number. When mmt_hotel_issues_invoice
            # is enabled this branch is skipped and a sequential number is
            # minted below so the room supply is reportable in GSTR-1.
            bill_number = "-"
            needs_bill_number = False
        else:
            needs_bill_number = True
            if defer_number:
                # GAP-FREE PATH: do NOT mint here. The number is allocated
                # ATOMICALLY with the bill-document write at finalize time
                # (allocate_and_finalize_bill), so the counter can never
                # advance without a stored bill. Leave a placeholder; the
                # real CC/ number is stamped inside the transaction.
                bill_number = "-"
            else:
                # Legacy / non-checkout callers (repair scripts, MMT ingest)
                # keep the original inline mint.
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
            balance = total_amount - payment_cash - payment_online - payment_ota + total_refunds
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

        # ── Resolve B2B classification + place-of-supply split ────────────
        # Now that total_amount and gst_amount are known, finalise the
        # recipient classification. classify_invoice_type promotes to B2B
        # when a valid recipient GSTIN is present (else B2CL for large
        # inter-state B2C, else B2C). When the recipient is inter-state we
        # re-split the GST as IGST. For intra-state (Karnataka, code 29) the
        # earlier CGST/SGST split already stands. This makes an ingested MMT
        # B2B stay file correctly without the operator re-keying the GST modal.
        if bk_recipient_gstin:
            bk_invoice_type = classify_invoice_type(
                bk_recipient_gstin, total_amount, bk_recipient_state_code
            )
            # Place of supply — Section 12(3)(b) IGST Act: for hotel
            # accommodation the PoS is the LOCATION OF THE PROPERTY,
            # irrespective of the recipient's registered state. Every supply
            # on this bill is made at the lodge (Karnataka-29), so the split
            # is ALWAYS CGST+SGST — never IGST — even for an out-of-state
            # B2B recipient. (Previously this recomputed an IGST split from
            # the recipient's state: a hard compliance error, fixed 2026-06.)

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
            "payment_ota": payment_ota,
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
            "recipient_gstin":      bk_recipient_gstin,
            "recipient_legal_name": bk_recipient_legal_name,
            "recipient_trade_name": bk_recipient_trade_name,
            "recipient_address":    bk_recipient_address,
            "recipient_state":      bk_recipient_state,
            "recipient_state_code": bk_recipient_state_code,
            "invoice_type":         bk_invoice_type,
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

        # Internal hint for the atomic finalize path (popped before the doc is
        # written). Only present when the caller deferred minting; tells
        # allocate_and_finalize_bill whether this stay should consume a CC/
        # number at all (False for no-bill / pure-MMT stays).
        if defer_number:
            bill_record["_needs_bill_number"] = needs_bill_number

        return bill_record

    except BillCreationError:
        # Already a structured, caller-facing failure — propagate untouched.
        raise
    except Exception as e:
        # Any other exception is a bug or infrastructure failure. NEVER
        # swallow it: the old `return None` path let checkout continue and
        # the invoice silently vanished from the Register and GSTR-1.
        #
        # If the sequential number was already minted before the failure,
        # the counter is consumed — attach the number so the checkout
        # alert records it (it must be declared as a cancelled document
        # in GSTR-1 Table 13).
        _minted = locals().get("bill_number")
        if not isinstance(_minted, str) or _minted == "-":
            _minted = None
        logger.exception(f"Error creating bill record (room {room}): {e}")
        raise BillCreationError(
            f"internal error while building the bill: {e}",
            bill_number=_minted,
        ) from e

def generate_sequential_bill_number(checkout_date):
    """
    Format: CC/YYYY/MM/XXXXX
    Uses an atomic Firestore counter keyed on "bill_YYYY_MM".
    Minimum sequence value is 1 (never 0).

    Raises SequentialNumberError on ANY failure. There is deliberately no
    fallback: a non-sequential number violates GST Rule 46(b), can collide
    with a real number, and silently corrupts the series. The caller must
    abort (checkout is blocked and an alert is raised).
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
            # Tolerate a counter doc that exists but lacks the field —
            # treat as 0 rather than crashing the whole series.
            current = (snap.to_dict() or {}).get("count", 0) if snap.exists else 0
            new_val = int(current) + 1
            t.set(ref, {"count": new_val})
            return new_val

        seq    = _inc(txn, counter_ref)
        serial = str(seq).zfill(5)
        return f"CC/{year}/{month}/{serial}"

    except Exception as e:
        logger.exception(f"Bill number allocation failed for {checkout_date}: {e}")
        raise SequentialNumberError(
            f"could not allocate the next bill number ({e}). "
            "Checkout was aborted — no number was consumed. Retry; if it "
            "persists, check Firestore connectivity / the counters collection."
        ) from e


def allocate_and_finalize_bill(stay_id, bill_record, checkout_dt, *,
                               is_new_doc, needs_number):
    """
    Atomically mint the next sequential bill number AND write the finalized
    bill document, in ONE Firestore transaction.

    GAP-FREE INVARIANT
        The per-month counter (counters/bill_YYYY_MM.count) is advanced if and
        only if the bill document that carries the resulting number is committed
        in the SAME transaction. A retry, contention abort, crash, or any error
        rolls back BOTH the counter and the bill write together — so a CC/
        number is NEVER consumed without a stored bill, and the series stays
        gap-free (GST Rule 46(b)). This replaces the old two-step flow (mint in
        its own committed transaction, then write the bill later in a separate
        batch), where a duplicate or failed checkout could burn a number.

    IDEMPOTENT
        If the target doc is already finalized (status completed /
        pending_settlement with a real bill_number), the existing number is
        returned and NOTHING is minted or overwritten. Combined with Firestore
        optimistic concurrency, this also defeats a true double-submit race: the
        losing transaction is forced to retry, re-reads the now-finalized doc,
        and returns the existing number instead of minting a second one.

    Parameters
        stay_id      : Firestore doc id for the bill (draft UUID for new stays,
                       or the legacy {room}_{ts} id).
        bill_record  : fully-built record EXCEPT bill_number, which is stamped
                       here. Any internal "_needs_bill_number" hint is dropped.
        checkout_dt  : datetime — selects the counter month (CC/YYYY/MM/...).
        is_new_doc   : True  -> create a fresh doc (legacy path; transaction.set).
                       False -> finalize an existing draft (set with merge=True).
        needs_number : False for no-bill / pure-MMT stays -> the doc is still
                       written but bill_number stays "-" and the counter is
                       untouched.

    Returns
        (bill_number: str, newly_finalized: bool)
          newly_finalized is True when THIS call wrote the bill, False when it
          found the stay already finalized (duplicate/concurrent) — the caller
          must then NOT repeat the room / totals / payment side-effects.

    NOTE
        This is the checkout path, which always finalizes into the current
        (never-locked) GST month. Repair / backfill into a PAST month must keep
        using bills_service.finalize, which enforces the GST month-lock.
    """
    from datetime import timezone

    doc_ref     = bills_ref.document(stay_id)
    year        = checkout_dt.year
    month       = str(checkout_dt.month).zfill(2)
    counter_ref = counters_ref.document(f"bill_{year}_{month}")

    base_payload = dict(bill_record)
    base_payload.pop("_needs_bill_number", None)   # never persist the hint

    txn = db.transaction()

    @firestore.transactional
    def _run(t):
        # reads first (Firestore requires all reads before any write)
        snap = doc_ref.get(transaction=t)
        existing = snap.to_dict() if snap.exists else None
        if existing:
            _st = existing.get("status")
            _bn = existing.get("bill_number")
            if _st in ("completed", "pending_settlement") and _bn and _bn != "-":
                # Already finalized — idempotent no-op. No mint, no overwrite.
                return _bn, False

        if needs_number:
            csnap   = counter_ref.get(transaction=t)
            current = (csnap.to_dict() or {}).get("count", 0) if csnap.exists else 0
            new_count = int(current) + 1
            number    = f"CC/{year}/{month}/{str(new_count).zfill(5)}"
        else:
            new_count = None
            number    = "-"

        # writes
        now_utc = datetime.now(timezone.utc).isoformat()
        payload = dict(base_payload)
        payload["bill_number"]  = number
        payload["finalized_at"] = now_utc
        payload["updated_at"]   = now_utc

        if is_new_doc:
            t.set(doc_ref, payload)
        else:
            # merge keeps any draft-only fields not present in bill_record
            t.set(doc_ref, payload, merge=True)

        if needs_number:
            t.set(counter_ref, {"count": new_count}, merge=True)

        return number, True

    return _run(txn)


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

    Uses a single db.get_all() RPC for ALL metadata docs. The previous
    implementation looped over metadata_ref.document(key).get() one doc at
    a time — N sequential round-trips (~100ms each), which dominated
    register loads whenever many entries were missing serials.
    """
    if not entries:
        return

    try:
        # Build doc-key -> entry map (same key collision semantics as before:
        # last entry wins for a duplicate {date}_{room} key).
        ref_to_entry = {}
        for entry in entries:
            checkin_time = entry.get("checkin_time", "")
            room = entry.get("room", "")
            if checkin_time and room:
                checkin_date = checkin_time.split(" ")[0]
                doc_key = f"{checkin_date}_{room}"
                ref_to_entry[doc_key] = entry

        if not ref_to_entry:
            return

        # Fetch all metadata docs in ONE round-trip
        doc_refs = [metadata_ref.document(k) for k in ref_to_entry]
        for meta_doc in db.get_all(doc_refs):
            try:
                if meta_doc.exists:
                    sn = (meta_doc.to_dict() or {}).get("serial_number")
                    if sn and sn != 0:
                        entry = ref_to_entry.get(meta_doc.id)
                        if entry is not None:
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
        services_total       = sum(
            a.get("price", 0) for a in room_data.get("add_ons", [])
            if payment_service.is_live_charge(a)
        )
        total_amount         = room_charges_total + services_total

        room_str = str(room_number)

        # --- Try payments collection first (fast targeted query) ---
        stay_payments = payment_service.query_payments_for_stay(
            room_str, guest_name, checkin_dt
        )

        # Read from payments collection (primary data source)
        # Same void guard as create_bill_record — this row is what the
        # operator reads before deciding whether to ask for money.
        payment_cash = sum(
            p.get("amount", 0) for p in (stay_payments or [])
            if p.get("method") == "cash"
            and payment_service.is_live_charge(p)
            and p.get("type") not in ("refund", "checkout_refund",
                                       "manual_refund", "booking_cancel_refund",
                                       "discount", "expense")
        )
        payment_online = sum(
            p.get("amount", 0) for p in (stay_payments or [])
            if p.get("method") == "online"
            and payment_service.is_live_charge(p)
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
    """
    Accommodation GST slab from the value of supply per unit per day.

        under  ₹1,000  →   0%   (exempt — see the note below)
        up to  ₹7,500  →   5%   (no ITC)
        above  ₹7,500  →  18%

    THE SUB-₹1,000 BAND IS A DELIBERATE BUSINESS DECISION, NOT THE DEFAULT
    READING OF THE STATUTE. It was reinstated on 19 August 2026 on the advice
    of the business's chartered accountant, relayed by the proprietor, and
    applies from that date forward. Do not "tidy it away" as a bug.

    The contrary position is recorded here so that whoever reads this next
    gets the whole picture rather than half of it. Entry 14 of Notification
    12/2017-CTR exempted accommodation valued up to ₹1,000 per unit per day.
    Notification 04/2022-CTR ("serial number 14 and the entries relating
    thereto shall be omitted") withdrew it with effect from 18 July 2022.
    Neither 15/2025-CTR (service rates) nor 16/2025-CTR (service exemptions)
    reinstated it when the 56th Council collapsed the old 12% slab into 5% on
    22 September 2025. On that reading a ₹700 night is taxable at 5%.

    The CA carries the professional judgement on which reading governs this
    business, and signs the returns. If that advice is ever revisited, change
    the band HERE — this function is the single definition of the ladder, so
    the bill, the folio, the GSTR-1 workbook and the advance report all move
    together — and run scripts/audit_exempt_bills.py to size the invoices
    issued either side of the change.

    Two second-order effects of an exempt band, both deliberate and both
    worth knowing before anyone is surprised by an invoice:

      * the slab follows the POST-discount value (Section 15(3)(a) excludes
        an on-invoice discount from the value of supply), so a ₹1,800 night
        carrying a ₹900 allocated discount lands under ₹1,000 and prints as
        exempt;
      * a fully discounted night (value ₹0) is likewise exempt rather than
        taxable at a nil value.
    """
    try:
        v = float(value or 0)
    except (TypeError, ValueError):
        v = 0
    if v < 1000:
        return 0
    if v <= 7500:
        return 5
    return 18


# ── ₹999 snap ───────────────────────────────────────────────────────────────
# The value at which a night still sits inside the exempt band, and the first
# value outside it. Derived from _slab_for_value rather than duplicated: if the
# band ever moves, move it there and these follow.
EXEMPT_BAND_TARGET = 999


def snap_to_exempt_band(night_value_so_far, addon_price, quantity=1):
    """
    Trim an accommodation add-on by a rupee or two so the night lands on ₹999
    instead of just over ₹1,000 — but ONLY when that leaves more money on the
    counter than paying the tax would.

    The case this exists for: a ₹700 room plus a ₹300 extra bed is a ₹1,000
    night. Room and extra bed are one composite supply, so the whole ₹1,000 is
    the value of supply and the night is taxable. Charge ₹299 for the bed
    instead and the night is ₹999, inside the band, and the lodge keeps ₹999
    rather than ₹952.38. Giving up ₹1 to keep ₹46.62 is worth doing.

    This is a genuine price reduction, not a tax device. The guest is charged
    less and the invoice says so. Nothing is split, relabelled or hidden: the
    add-on's price really is ₹299.

    WHEN IT DOES NOT FIRE, and why each guard matters:

      * No exempt band in force. The whole benefit comes from landing under
        ₹1,000. If _slab_for_value stops returning 0 there — the CA's advice is
        revisited, or the law is applied differently — this goes inert on its
        own instead of quietly shaving rupees for a benefit that no longer
        exists. Nobody has to remember to delete it.

      * The shave costs more than the tax. Snapping ₹1,100 down to ₹999 gives
        up ₹101 to save ₹52. The break-even is computed from the live slab, not
        hard-coded: worth it while 999 > projected x 100/(100+rate), which at 5%
        makes ₹1,048 the last value worth snapping.

      * The night is already inside the band, or the room alone is already past
        ₹999. Neither can be fixed by trimming an add-on.

      * quantity > 1. `price` must stay equal to unit_price x quantity or the
        invoice contradicts itself. An extra bed is billed one at a time, so
        the constraint costs nothing real.

    Returns (adjusted_price, rupees_given_up). The second value is 0 whenever
    the price is unchanged, so callers can test it to decide whether to record
    anything.
    """
    try:
        base = int(night_value_so_far or 0)
        add = int(addon_price or 0)
        qty = int(quantity or 1)
    except (TypeError, ValueError):
        return addon_price, 0

    if add <= 0 or qty != 1:
        return addon_price, 0
    if _slab_for_value(EXEMPT_BAND_TARGET) != 0:
        return addon_price, 0

    projected = base + add
    if projected <= EXEMPT_BAND_TARGET or base >= EXEMPT_BAND_TARGET:
        return addon_price, 0

    target_add = EXEMPT_BAND_TARGET - base
    if target_add <= 0:
        return addon_price, 0

    rate = _slab_for_value(projected)
    net_if_taxed = projected * 100.0 / (100 + rate) if rate > 0 else float(projected)
    if EXEMPT_BAND_TARGET <= net_if_taxed:
        return addon_price, 0

    return target_add, add - target_add


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
        if not payment_service.is_live_charge(s):
            # Voided line. Skipped here as well as at the services build
            # above: a voided add-on must not contribute to a night's value
            # of supply, or it could push that night across a GST slab
            # boundary while contributing nothing to the amount charged.
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

        # GST slab follows the POST-discount value of supply.
        #
        # Basis: the "declared tariff" concept is gone (Notif. 05/2025-CTR,
        # eff. 1 Apr 2025; transaction-value basis since the 2019
        # amendments), and Section 15(3)(a) CGST Act EXCLUDES an on-invoice
        # discount from the value of supply. The slab thresholds
        # (₹7,500 per unit per day) therefore applies to the amount actually
        # charged for the night AFTER the allocated discount.
        #
        # Two boundaries apply here: the ₹1,000 exempt band (in force by
        # business decision from 19 Aug 2026, on CA advice) and the ₹7,500
        # 5%/18% boundary. Both are read off the POST-discount day_total, so
        # a discounted night can fall into the exempt band and print
        # "Exempt" on the invoice. That is the documented consequence of the
        # band, not a defect — see _slab_for_value before changing it.
        day_gst_rate = _slab_for_value(day_total)
        if day_gst_rate > 0 and day_total > 0:
            divisor = 100 + day_gst_rate
            day_gst = round(day_total * day_gst_rate / divisor, 2)
        else:
            day_gst = 0.0
        day_taxable = round(day_total - day_gst, 2)

        # Place-of-supply split — Section 12(3)(b) IGST Act: accommodation
        # is supplied AT the property, so the place of supply is always
        # Karnataka (29) regardless of the recipient's state. The split is
        # therefore ALWAYS CGST+SGST. day_igst stays in the schema (always
        # 0.0) for backward compatibility; recipient_state_code is retained
        # in the signature for audit visibility only and no longer affects
        # the tax heads.
        day_cgst = round(day_gst / 2, 2)
        day_sgst = round(day_gst - day_cgst, 2)
        day_igst = 0.0

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


def split_bucket_tax(gross, rate):
    """
    Tax on a tax-INCLUSIVE bucket total, split into CGST and SGST.

    Computed on the bucket total, never by summing per-night figures, and each
    half derived independently at half the rate:

        cgst = sgst = round(gross * (rate/2) / (100 + rate), 2)
        tax         = cgst + sgst
        taxable     = gross - tax

    Two properties that the previous approach did not have, and both matter on
    a tax invoice:

    1. CGST == SGST, always. An intra-state supply is 2.5% + 2.5%; an invoice
       showing 185.77 against 185.64 is defective on its face. That divergence
       came from splitting each NIGHT's tax — round(28.57/2) = 14.29 leaves
       14.28 for SGST, one paise adrift every night, 13 paise over a
       fortnight.

    2. taxable + cgst + sgst == gross, exactly. No residual paise to explain.

    The remaining error against the theoretical figure is under one paise per
    half, because the rounding happens once on the total instead of once per
    night. Summing 13 nights of round(600*5/105) = 28.57 lost 0.02 against the
    true 371.43 on a single ₹7,800 stay; the longer the stay the worse it got.

    rate 0 (legacy exempt-band folios) returns the gross as taxable with no
    tax, so historical bills still render as they were issued.
    """
    try:
        g = round(float(gross or 0), 2)
    except (TypeError, ValueError):
        g = 0.0
    try:
        r = int(rate or 0)
    except (TypeError, ValueError):
        r = 0
    if r <= 0 or g <= 0:
        return {"taxable": g, "cgst": 0.0, "sgst": 0.0, "igst": 0.0, "tax": 0.0}
    half = round(g * (r / 2.0) / (100 + r), 2)
    tax = round(half * 2, 2)
    return {"taxable": round(g - tax, 2), "cgst": half, "sgst": half,
            "igst": 0.0, "tax": tax}


def aggregate_folio_tax(folio):
    """
    Invoice-level tax from a daily folio, bucketed by slab.

    The folio decides WHICH slab each night falls in — that is per-night by
    law, since the threshold is per unit per day. But the tax itself is
    computed once per slab on the summed gross, because that is what the
    invoice's HSN table reports and it is where rounding belongs.

    Returns {by_rate: {rate: {gross, taxable, cgst, sgst, igst, tax}},
             taxable, cgst, sgst, igst, tax, exempt_value}.
    """
    gross_by_rate = {}
    for e in folio or []:
        try:
            r = int((e or {}).get("day_gst_rate") or 0)
            g = float((e or {}).get("day_total") or 0)
        except (TypeError, ValueError):
            continue
        gross_by_rate[r] = gross_by_rate.get(r, 0.0) + g

    out = {"by_rate": {}, "taxable": 0.0, "cgst": 0.0, "sgst": 0.0,
           "igst": 0.0, "tax": 0.0, "exempt_value": 0.0}
    for r, g in gross_by_rate.items():
        part = split_bucket_tax(g, r)
        part["gross"] = round(g, 2)
        out["by_rate"][r] = part
        if r <= 0:
            out["exempt_value"] = round(out["exempt_value"] + part["taxable"], 2)
        else:
            out["taxable"] = round(out["taxable"] + part["taxable"], 2)
        out["cgst"] = round(out["cgst"] + part["cgst"], 2)
        out["sgst"] = round(out["sgst"] + part["sgst"], 2)
        out["igst"] = round(out["igst"] + part["igst"], 2)
        out["tax"] = round(out["tax"] + part["tax"], 2)
    return out


def recompute_bill_gst(bill):
    """
    Rebuild a bill's GST fields from its CURRENT services and discounts, by
    regenerating the daily folio and re-aggregating over it.

    Returns the GST fields to write: daily_folio, gst_rate, gst_amount,
    accommodation_taxable, cgst_amount, sgst_amount, igst_amount. Totals and
    balances are deliberately NOT returned — those belong to the caller, which
    knows whether it is adding a discount, editing a service, or something
    else, and owns the receipt arithmetic.

    Why this exists. Two post-checkout paths used to scale the stored flat
    `gst_rate` instead of rebuilding:

        if _gst_rate > 0 and _effective_accom > 0:
            gst_amount = _effective_accom * _gst_rate / (100 + _gst_rate)

    That is wrong in three ways, and the exempt band makes all three bite.

      1. `gst_rate` is the MODAL night rate, so on a mixed stay the whole bill
         was re-taxed at whichever slab happened to be most common.
      2. The guard `if _gst_rate > 0` skips the recompute entirely when the
         modal rate is 0. Raise an extra bed from ₹200 to ₹400 on a ₹900 night
         and the night's value of supply becomes ₹1,300 — taxable — but the
         bill kept ₹0 tax against ₹1,300 of accommodation.
      3. Neither path touched `daily_folio`, and bill_tax_breakup is folio-
         first. So the stored aggregates and the printed invoice disagreed:
         the folio still said 5% on the old figure while gst_amount had moved.

    Rebuilding the folio fixes all three at once, because the folio is the
    thing every downstream surface reads.
    """
    bill = bill or {}

    def _int(v, default=0):
        """
        Money fields are not reliably integers on every document.

        `discounts` and `refunds` are written as LISTS on drafts
        (services/bills_service.create_draft) and as ints on finalised bills,
        `total_amount` is None on a draft, and legacy rows can carry strings.
        This runs from /add_bill_payment and /update_bill_service, so a bad
        shape here is a 500 on a live counter operation rather than a bad
        number. Coerce, never raise.
        """
        if isinstance(v, (list, tuple, dict)):
            # A draft's empty [] means "no discounts yet". A populated list is
            # the pre-finalisation payment-row shape; sum what looks like money.
            try:
                return int(sum(int((x or {}).get("amount", 0) or 0) for x in v))
            except (TypeError, ValueError, AttributeError):
                return default
        try:
            return int(float(v or 0))
        except (TypeError, ValueError):
            return default

    services = bill.get("services") or []
    if not isinstance(services, (list, tuple)):
        services = []
    services_total = sum(_int((s or {}).get("price")) for s in services)
    total_discounts = _int(bill.get("discounts"))
    room_charges_total = _int(bill.get("room_charges_total"))
    days_stayed = max(_int(bill.get("days_stayed"), 1) or 1, 1)

    accommodation_addons_total = sum(
        _int((s or {}).get("price")) for s in services
        if (s or {}).get("accommodation_charge")
    )
    non_accommodation_total = services_total - accommodation_addons_total
    accom_pre_discount = room_charges_total + accommodation_addons_total
    gross_pre_discount = accom_pre_discount + non_accommodation_total

    # Same accommodation/non-accommodation discount split create_bill_record
    # feeds the folio. Allocating the whole discount to accommodation would
    # move nights across the slab boundary that should not have moved.
    accom_discount_share = 0.0
    if total_discounts > 0 and gross_pre_discount > 0:
        accom_discount_share = round(
            total_discounts * (accom_pre_discount / gross_pre_discount), 2
        )

    try:
        checkin_dt = datetime.strptime(
            str(bill.get("checkin_time") or ""), "%Y-%m-%d %H:%M")
    except (ValueError, TypeError):
        checkin_dt = None

    folio = []
    if checkin_dt is not None:
        folio = compute_daily_folio(
            checkin_dt=checkin_dt,
            days_stayed=days_stayed,
            room_price_per_night=_int(bill.get("room_price_per_night")),
            current_room_no=str(bill.get("room") or ""),
            accommodation_services=services,
            pre_transfer_charges=bill.get("pre_transfer_charges") or [],
            discount_on_accom=accom_discount_share,
            recipient_state_code=str(bill.get("recipient_state_code") or "29"),
        )

    if folio:
        agg = aggregate_folio_tax(folio)
        counts = {}
        for e in folio:
            counts[e["day_gst_rate"]] = counts.get(e["day_gst_rate"], 0) + 1
        return {
            "daily_folio":           folio,
            # Display fallback only, and ties go to the higher slab. Nothing
            # should compute tax from this — see compute_credit_components.
            "gst_rate":              max(counts, key=lambda r: (counts[r], r)),
            "gst_amount":            agg["tax"],
            "accommodation_taxable": agg["taxable"],
            "cgst_amount":           agg["cgst"],
            "sgst_amount":           agg["sgst"],
            "igst_amount":           agg["igst"],
        }

    # Malformed checkin_time — mirror create_bill_record's own fallback.
    effective = accom_pre_discount - min(total_discounts, accom_pre_discount)
    rate = _slab_for_value(effective / days_stayed)
    gst = round(effective * rate / (100 + rate), 2) if rate else 0.0
    cgst, sgst, igst = compute_gst_split(gst, recipient_state_code="29")
    return {
        "gst_rate":              rate,
        "gst_amount":            gst,
        "accommodation_taxable": round(effective - gst, 2),
        "cgst_amount":           cgst,
        "sgst_amount":           sgst,
        "igst_amount":           igst,
    }


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
# SUPPLY CLASSIFICATION — non-accommodation items
# ============================================================================
#
# Kept here rather than in routes/billing.py so that the invoice renderer,
# the register payload and any report all classify a service line the same
# way. It used to live in billing.py while the browser carried its own
# incompatible rule ("does the item name contain the word water?"), which is
# why a ₹500 laundry charge printed "SAC: 999721 - 18%" on the invoice and
# contributed ₹0 to the GSTR-1 workbook.

# (keyword tuple, HSN/SAC, rate %, category)
_SERVICE_TAX_RULES = (
    (("water", "bisleri", "aquafina", "kinley", "bailley"), "2201", 5, "goods"),
    (("cold drink", "soft drink", "coke", "pepsi", "soda", "thums up",
      "sprite", "fanta", "limca", "maaza", "frooti"), "2202", 12, "goods"),
    (("tea", "coffee"), "996331", 5, "service"),
    (("snack", "biscuit", "namkeen", "chip", "wafer", "lays", "kurkure"),
     "1905", 5, "goods"),
    (("laundry", "ironing", "wash", "dry clean"), "999721", 18, "service"),
    (("taxi", "transport", "pickup", "drop", "auto", "cab"), "996412", 5, "service"),
)


def infer_service_tax(svc):
    """Return (hsn_or_sac, gst_rate_pct, tax_category) for a NON-accommodation line.

    Resolution order:
      1. Explicit fields stored on the service dict (`hsn_or_sac`, `gst_rate`,
         `tax_category`) — always win, so an operator override is never
         second-guessed by a keyword.
      2. Item-name keywords, per _SERVICE_TAX_RULES.
      3. Exempt — empty HSN, 0%. Covers deposits, refundable items and
         anything not yet categorised.

    NOTE: the keyword rules are a convenience, not tax advice. Any item whose
    name does not match a rule is billed at 0%. Review _SERVICE_TAX_RULES
    against your actual inventory, and prefer stamping `hsn_or_sac`/`gst_rate`
    explicitly on the service record for anything material.
    """
    svc = svc or {}
    if svc.get("hsn_or_sac"):
        try:
            rate = int(svc.get("gst_rate") or 0)
        except (TypeError, ValueError):
            rate = 0
        return (str(svc["hsn_or_sac"]), rate, svc.get("tax_category", "goods"))

    name = (svc.get("item") or "").lower()
    for keywords, hsn, rate, category in _SERVICE_TAX_RULES:
        if any(k in name for k in keywords):
            return (hsn, rate, category)
    return ("", 0, "exempt")


def service_tax_label(svc):
    """Sub-line label for a service row: 'HSN: 2201 - 5%' / 'Non-taxable'."""
    hsn, rate, cat = infer_service_tax(svc)
    if not hsn:
        return "Non-taxable"
    prefix = "HSN" if cat == "goods" else "SAC"
    return f"{prefix}: {hsn} - {rate}%" if rate > 0 else f"{prefix}: {hsn}"


# ============================================================================
# THE TAX BREAKUP — one rate-wise computation for every surface
# ============================================================================

# Place of supply for everything this property sells is Karnataka (29):
#   • Accommodation — Section 12(3)(b) IGST Act: the location of the
#     immovable property, NOT the recipient's state.
#   • Goods handed over at the counter (water, cold drinks) — Section 10(1)(c)
#     IGST Act: where the goods are at the time of delivery.
#   • Services performed at the property (laundry, tea/coffee) — Section 12(2).
# So a lodge invoice is ALWAYS intra-state CGST+SGST, even for a B2B guest
# registered in another state. Their state belongs in the BILL TO block and in
# the GSTR-1 recipient details; it must never flip the tax heads.
#
# Every storage path already hardcodes recipient_state_code="29" for this
# reason (create_bill_record, refresh_bill_pricing, update_bill_gst,
# compute_daily_folio). The IGST column is retained everywhere, always 0.00,
# because GSTR-1 expects the column to exist.
PLACE_OF_SUPPLY_STATE = "Karnataka"
PLACE_OF_SUPPLY_CODE = "29"

ACCOMMODATION_SAC = "996311"


def bill_tax_breakup(bill):
    """Authoritative rate-wise tax breakup for one bill.

    THE single tax computation. The invoice's HSN/SAC summary, the Bills-tab
    tally, the bills table and the GSTR-1 export workbook all consume this, so
    the figures a guest sees, the figures on screen and the figures filed are
    the same numbers by construction rather than by three implementations
    happening to agree.

    Accommodation figures are taken from the stored per-night folio and grouped
    by each night's OWN slab. That matters: a stay with a ₹1,150 night at 5%
    and a ₹950 night that is exempt must produce two rows. Collapsing it into
    one row keyed on a single "representative" rate — which is what the browser
    used to do — yields a row where Taxable x Rate does not equal the tax, and
    the GSTN utility rejects or silently restates it.

    On rounding: rows SUM the stored per-night figures rather than recomputing
    tax as taxable x rate. Each night is a separate supply whose tax was
    already rounded to the paisa when the folio was written, so summing keeps
    (taxable + tax) exactly equal to the amount charged — the number the guest
    pays and the invoice must foot to. The cost is that a row aggregating N
    nights can differ from taxable x rate by up to half a paisa per night
    (a 30-night stay drifts about 9 paise). Recomputing instead would make
    that check exact and leave the invoice not footing, which is the worse
    failure: a guest disputing a total is a real problem, a nine-paise
    rounding difference in a rate-wise summary is not.

    Returns
    -------
    dict with:
        rows      list of {hsn, description, rate, taxable, cgst, sgst, igst,
                           tax, category}  — category is "accommodation" or
                           "service"; one row per (code, rate).
        taxable / cgst / sgst / igst / tax   totals, each the sum of the
                           ROUNDED row values so the printed rows add up to
                           the printed total exactly.
        exempt_value       value of supply carried at 0% (not in `taxable`).
        source             "folio" | "aggregate" | "legacy" — provenance of
                           the accommodation figures, for diagnostics.
    """
    bill = bill or {}

    def _f(v):
        try:
            return float(v or 0)
        except (TypeError, ValueError):
            return 0.0

    # A cancelled (reverted) bill carries ZERO output tax. Reverting does not
    # clear accommodation_taxable / gst_amount / daily_folio from the record —
    # they are kept for audit — so anything reading those fields without this
    # guard reports tax against a bill that was undone. The browser used to do
    # exactly that and printed a GST figure on CANCELLED rows.
    if (bill.get("status") or "").lower() == "cancelled":
        return {"rows": [], "taxable": 0.0, "cgst": 0.0, "sgst": 0.0,
                "igst": 0.0, "tax": 0.0, "exempt_value": 0.0,
                "source": "cancelled"}

    # ── Accommodation ─────────────────────────────────────────────────────
    accom = {}          # rate -> {taxable, cgst, sgst, igst}
    exempt_value = 0.0
    folio = bill.get("daily_folio")
    folio = folio if isinstance(folio, list) else []

    def _bucket(rate, taxable, cgst, sgst, igst=0.0):
        agg = accom.setdefault(int(rate), {"taxable": 0.0, "cgst": 0.0,
                                           "sgst": 0.0, "igst": 0.0})
        agg["taxable"] += taxable
        agg["cgst"] += cgst
        agg["sgst"] += sgst
        agg["igst"] += igst

    if folio:
        source = "folio"
        # Same rule as create_bill_record: the folio picks the slab per night,
        # but the tax for each slab is computed once on that slab's total.
        # Bucketing the per-night rounded values (what this used to do) is what
        # printed CGST 185.77 against SGST 185.64 in the HSN table.
        _agg = aggregate_folio_tax(folio)
        for _rate, _part in _agg["by_rate"].items():
            # Exempt nights are bucketed like any other rate, NOT short-
            # circuited into exempt_value here. The rate-0 case is handled
            # once, in the row loop below, which both counts the value into
            # exempt_value AND emits a row carrying that value in the Taxable
            # column with nil tax against it.
            #
            # Skipping the bucket (what this used to do) meant an exempt
            # folio bill produced NO accommodation row at all: the tax
            # summary showed a taxable base of 0 against a grand total of
            # 900, so the invoice did not foot and the supply's value never
            # reached GSTR-1 Table 12. Harmless while there was no exempt
            # band; wrong the moment one exists.
            _bucket(_rate, _part["taxable"], _part["cgst"], _part["sgst"],
                    _part["igst"])
    elif _f(bill.get("accommodation_taxable")) > 0 or _f(bill.get("gst_amount")) > 0:
        # Pre-folio bill: use the stored stay-level aggregates. `gst_rate` on
        # these records is a single slab, which is accurate because pre-folio
        # bills were only ever computed at one slab.
        source = "aggregate"
        gst = _f(bill.get("gst_amount"))
        cgst = _f(bill.get("cgst_amount")) or round(gst / 2, 2)
        sgst = _f(bill.get("sgst_amount")) or round(gst - round(gst / 2, 2), 2)
        _bucket(_f(bill.get("gst_rate")), _f(bill.get("accommodation_taxable")),
                cgst, sgst, _f(bill.get("igst_amount")))
    else:
        # Nothing stored at all. Recompute from the room charge, netting the
        # accommodation share of any discount, and pick the slab from the
        # POST-discount per-night value (Section 15(3)(a)) — the same rule
        # compute_daily_folio applies.
        source = "legacy"
        days = int(bill.get("days_stayed") or 1) or 1
        rate_per_night = _f(bill.get("room_price_per_night") or bill.get("room_rent"))
        room_total = _f(bill.get("room_charges_total")) or rate_per_night * days
        services = bill.get("services") or []
        addons = sum(_f(s.get("price")) for s in services
                     if s.get("accommodation_charge"))
        others = sum(_f(s.get("price")) for s in services
                     if not s.get("accommodation_charge"))
        gross_accom = room_total + addons
        discounts = _f(bill.get("discounts"))
        gross_all = gross_accom + others
        accom_disc = (min(discounts * (gross_accom / gross_all), gross_accom)
                      if gross_all > 0 else 0.0)
        net = max(gross_accom - accom_disc, 0.0)
        slab = _slab_for_value(net / days) if days else 0
        if slab > 0 and net > 0:
            gst = round(net * slab / (100 + slab), 2)
            cgst = round(gst / 2, 2)
            _bucket(slab, round(net - gst, 2), cgst, round(gst - cgst, 2))
        elif net > 0:
            _bucket(0, net, 0.0, 0.0)

    rows = []
    for rate in sorted(accom):
        agg = accom[rate]
        taxable = round(agg["taxable"], 2)
        cgst = round(agg["cgst"], 2)
        sgst = round(agg["sgst"], 2)
        igst = round(agg["igst"], 2)
        if rate <= 0:
            # Exempt supply is reported separately: it has a value but no
            # taxable base, and folding it into a rated row is what made
            # Taxable x Rate disagree with the tax.
            exempt_value += taxable
            if taxable <= 0:
                continue
            rows.append({"hsn": ACCOMMODATION_SAC, "description": "Accommodation",
                         "rate": 0, "taxable": taxable, "cgst": 0.0, "sgst": 0.0,
                         "igst": 0.0, "tax": 0.0, "category": "accommodation"})
            continue
        if taxable <= 0 and (cgst + sgst + igst) <= 0:
            continue
        rows.append({"hsn": ACCOMMODATION_SAC, "description": "Accommodation",
                     "rate": rate, "taxable": taxable, "cgst": cgst, "sgst": sgst,
                     "igst": igst, "tax": round(cgst + sgst + igst, 2),
                     "category": "accommodation"})

    # ── Non-accommodation services ────────────────────────────────────────
    # Prices are collected at MRP, so the taxable base is back-calculated.
    svc_groups = {}
    for s in (bill.get("services") or []):
        if s.get("accommodation_charge"):
            continue           # already inside the folio
        hsn, rate, category = infer_service_tax(s)
        gross = _f(s.get("price"))
        if gross <= 0:
            continue
        if not hsn or rate <= 0:
            exempt_value += round(gross, 2)
            continue
        key = (hsn, rate)
        grp = svc_groups.setdefault(key, {"taxable": 0.0, "tax": 0.0,
                                          "description": s.get("item") or "Service",
                                          "category": category})
        taxable = gross / (1 + rate / 100.0)
        grp["taxable"] += taxable
        grp["tax"] += gross - taxable

    for (hsn, rate) in sorted(svc_groups):
        grp = svc_groups[(hsn, rate)]
        taxable = round(grp["taxable"], 2)
        tax = round(grp["tax"], 2)
        cgst = round(tax / 2, 2)
        rows.append({"hsn": hsn, "description": grp["description"], "rate": rate,
                     "taxable": taxable, "cgst": cgst, "sgst": round(tax - cgst, 2),
                     "igst": 0.0, "tax": tax, "category": "service"})

    # Totals sum the ROUNDED row values, so the printed rows add to the
    # printed total to the paise.
    #
    # The Taxable column includes exempt rows. GSTR-1 Table 12 reports the
    # value of a nil-rated supply in that column with zero tax against it, and
    # excluding it here would print a column of figures that does not add up to
    # its own total — an exempt-only invoice showed a 900.00 row above a 0.00
    # total. `exempt_value` is carried separately for callers that need the
    # split.
    return {
        "rows": rows,
        "taxable": round(sum(r["taxable"] for r in rows), 2),
        "cgst": round(sum(r["cgst"] for r in rows), 2),
        "sgst": round(sum(r["sgst"] for r in rows), 2),
        "igst": round(sum(r["igst"] for r in rows), 2),
        "tax": round(sum(r["tax"] for r in rows), 2),
        "exempt_value": round(exempt_value, 2),
        "source": source,
    }


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
    # bill_number is minted ATOMICALLY with the bill write below
    # (allocate_and_finalize_bill) so the CC/ series can never gap if the write
    # fails. Placeholder until the transaction stamps the real number.
    bill_number = "-"

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
        _num, _newly = allocate_and_finalize_bill(
            bill_id, bill_doc, cancel_dt,
            is_new_doc=True, needs_number=True,
        )
        bill_doc["bill_number"] = _num
        logger.info(
            f"create_cancellation_charge_bill: minted {_num} "
            f"booking={booking_id} amount=Rs.{retained_amount} "
            f"taxable={taxable} gst={gst_amount} (atomic; newly={_newly})"
        )
        return bill_doc
    except Exception as e:
        # Transaction rolled back -> NO CC/ number consumed, no bill written.
        logger.error(f"create_cancellation_charge_bill failed: {e}", exc_info=True)
        return None


def generate_sequential_credit_note_number(cn_date):
    """
    Mint next CN/YYYY/MM/XXXXX. Atomic Firestore transaction. Min value 1.

    Raises SequentialNumberError on failure — no fallback, for the same
    Rule 46(b) consecutive-series reasons as generate_sequential_bill_number.
    """
    try:
        year  = cn_date.year
        month = str(cn_date.month).zfill(2)
        counter_key = f"cn_{year}_{month}"
        counter_ref = counters_ref.document(counter_key)
        txn         = db.transaction()

        @firestore.transactional
        def _inc(t, ref):
            snap    = ref.get(transaction=t)
            current = (snap.to_dict() or {}).get("count", 0) if snap.exists else 0
            new_val = int(current) + 1
            t.set(ref, {"count": new_val})
            return new_val

        seq    = _inc(txn, counter_ref)
        serial = str(seq).zfill(5)
        return f"CN/{year}/{month}/{serial}"
    except Exception as e:
        logger.exception(f"CN number allocation failed for {cn_date}: {e}")
        raise SequentialNumberError(
            f"could not allocate the next credit-note number ({e}). "
            "The credit note was NOT issued — retry; if it persists, check "
            "Firestore connectivity / the counters collection."
        ) from e


def allocate_and_write_credit_note(cn_id, cn_doc, bill_id, cn_date):
    """
    Atomically mint the next CN/ number, write the credit-note document, and
    link it onto the original bill — all in ONE Firestore transaction.

    GAP-FREE INVARIANT: the cn_YYYY_MM counter advances if and only if the CN
    document carrying the number is committed in the same transaction. A retry,
    contention abort, or crash rolls back BOTH — a CN/ number is never consumed
    without a stored credit note (Section 34 / Rule 46(b) consecutive series).

    Returns the CN number string. The bill-link update reads the live bill doc
    inside the transaction, so concurrent links never clobber each other.
    """
    year        = cn_date.year
    month       = str(cn_date.month).zfill(2)
    counter_ref = counters_ref.document(f"cn_{year}_{month}")
    cn_ref      = credit_notes_ref.document(cn_id)
    bill_ref    = bills_ref.document(bill_id) if bill_id else None

    txn = db.transaction()

    @firestore.transactional
    def _run(t):
        # reads first (Firestore requires all reads before any write)
        csnap     = counter_ref.get(transaction=t)
        bill_snap = bill_ref.get(transaction=t) if bill_ref is not None else None

        current   = (csnap.to_dict() or {}).get("count", 0) if csnap.exists else 0
        new_count = int(current) + 1
        number    = f"CN/{year}/{month}/{str(new_count).zfill(5)}"

        doc = dict(cn_doc)
        doc["cn_number"] = number
        t.set(cn_ref, doc)
        t.set(counter_ref, {"count": new_count}, merge=True)

        if bill_snap is not None and bill_snap.exists:
            bd    = bill_snap.to_dict() or {}
            links = list(bd.get("linked_credit_note_ids") or [])
            if cn_id not in links:
                links.append(cn_id)
                t.update(bill_ref, {
                    "linked_credit_note_ids": links,
                    "linked_credit_note_id":  cn_id,
                    "lastModifiedAt": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
                })
        return number

    return _run(txn)


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
        # cn_number is minted ATOMICALLY with the CN write below
        # (allocate_and_write_credit_note) so the CN/ series can't gap if the
        # write fails. Placeholder until the transaction stamps the real number.
        cn_number = "-"
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

        # Atomic: mint the CN/ number, write the CN doc, and link it onto the
        # original bill in ONE transaction. The cn_YYYY_MM counter advances iff
        # the CN document is stored -> the CN series stays gap-free.
        cn_number = allocate_and_write_credit_note(cn_id, cn_doc, bill_id, cn_date)
        cn_doc["cn_number"] = cn_number

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
        # The operator sees the failure (callers return an error for a None
        # result), so unlike checkout this is not a silent path. But if the
        # CN number was already minted before the failure, the counter is
        # consumed — log it loudly so it can be declared as a cancelled
        # document in GSTR-1 Table 13.
        _minted_cn = locals().get("cn_number")
        if isinstance(_minted_cn, str) and _minted_cn:
            logger.critical(
                f"create_credit_note failed AFTER minting {_minted_cn} — "
                f"this CN number is consumed but no CN exists. Declare it "
                f"as a cancelled document in GSTR-1 Table 13. Error: {e}",
                exc_info=True,
            )
        else:
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
    """
    Split a credit-note total into (taxable, cgst, sgst), GST-inclusive.

    A CN must reverse output tax in the SAME PROPORTION the invoice charged
    it, so the rate comes from what the bill actually taxed — bill_tax_breakup
    over the folio — not from the flat `gst_rate` field.

    That field is the MODAL night rate (config.create_bill_record: the most
    common slab across the nights, ties going to the higher). It is a display
    fallback and was never a tax figure. Reading it here was harmless only
    while every night was 5% or 18%. With an exempt band in force it breaks
    outright:

        3 nights — two at ₹900 (exempt), one at ₹5,000 (5%).
        Modal rate = 0. Invoice charges ~₹238 of GST.
        The old code returned (total, 0.0, 0.0): the guest is credited in
        full and NOT ONE RUPEE of that ₹238 is reversed in GSTR-1.

    It fails the other way too. Two nights at ₹5,000 and three at ₹900 elects
    rate 0 while real tax was charged; invert the counts and a mostly-taxable
    bill reverses tax on its exempt nights as well.

    The blended fraction is right for both a full cancellation (the whole
    invoice is credited, so the whole tax reverses) and a partial credit
    (a post-supply discount reverses tax pro rata, which is what Section
    15(3)(b) contemplates). A wholly exempt bill has a fraction of zero and
    correctly reverses no tax.

    cgst is halved and sgst takes the remainder, so the two always sum to the
    tax exactly rather than drifting a paise apart on an odd number. Inter-
    state bills are re-routed into IGST by create_credit_note, which relies on
    this returning the even half-split.
    """
    try:
        total = float(credit_total or 0)
        if total <= 0:
            return (0.0, 0.0, 0.0)

        bt = bill_tax_breakup(bill_data or {})
        # Gross the invoice actually carried. bt["taxable"] includes exempt
        # rows at their full value (see bill_tax_breakup), so this is the
        # whole supply, not just the taxed part.
        gross = round(float(bt.get("taxable") or 0) + float(bt.get("tax") or 0), 2)
        tax_charged = float(bt.get("tax") or 0)

        if gross <= 0:
            # The breakup found NOTHING to work from: no folio, no stored
            # aggregates, no line items. Distinct from an exempt bill, which
            # has a gross and simply no tax. Fall back to the stored flat rate
            # rather than crediting untaxed — under-reversing real output tax
            # is the worse error, and this is the only path that can still
            # recover it.
            rate = int((bill_data or {}).get("gst_rate", 0) or 0)
            if rate <= 0:
                return (round(total, 2), 0.0, 0.0)
            gst = round(total * rate / (100 + rate), 2)
            cgst = round(gst / 2, 2)
            return (round(total - gst, 2), cgst, round(gst - cgst, 2))

        if tax_charged <= 0:
            # A wholly exempt stay. It has a value but no tax to reverse.
            return (round(total, 2), 0.0, 0.0)

        gst = round(total * (tax_charged / gross), 2)
        if gst > total:
            gst = round(total, 2)
        taxable = round(total - gst, 2)
        cgst = round(gst / 2, 2)
        return (taxable, cgst, round(gst - cgst, 2))
    except Exception:
        logger.exception("compute_credit_components failed; crediting untaxed")
        return (round(float(credit_total or 0), 2), 0.0, 0.0)


threading.Thread(target=initialize_data, daemon=True).start()
