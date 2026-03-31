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

from services import payment_service, customer_service

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

# Initialize Firebase Admin SDK
try:
    if 'FIREBASE_CREDENTIALS' in os.environ:
        cred_json = base64.b64decode(os.environ.get('FIREBASE_CREDENTIALS')).decode('utf-8')
        cred_dict = json.loads(cred_json)
        cred = credentials.Certificate(cred_dict)
        storage_bucket = os.environ.get('FIREBASE_STORAGE_BUCKET', 'cibara-software-61512.firebasestorage.app')
        firebase_admin.initialize_app(cred, {'storageBucket': storage_bucket})
    else:
        cred = credentials.Certificate('service-account.json')
        firebase_admin.initialize_app(cred, {'storageBucket': 'cibara-software-61512.firebasestorage.app'})

    db = firestore.client()
    bucket = storage.bucket()
    logger.info("Firebase initialized successfully")

    # Initialise optimisation services (payments + customers collections)
    payment_service.init(db)
    customer_service.init(db)
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
            return payment_service.query_payments_for_stay(
                room, guest["name"], checkin_dt
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
        renewal_count = room_data.get("renewal_count", 0)
        days_stayed = renewal_count + 1
        room_charges_total = room_price_per_night * days_stayed

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
        # Note: If AC was selected at check-in, the room price already includes it.
        # If AC / Extra Bed were added as services from the checkout modal they are
        # stored with accommodation_charge=True and included here.
        if room_price_per_night < 1000:
            gst_rate = 0
        elif room_price_per_night <= 7500:
            gst_rate = 5
        else:
            gst_rate = 18

        accommodation_addons_total = sum(
            s["price"] for s in services if s.get("accommodation_charge", False)
        )
        non_accommodation_total = services_total - accommodation_addons_total

        # Taxable accommodation value (exclusive of discount; discount applied pro-rata
        # on the invoice for compliance; here we store gross taxable for reference).
        accommodation_taxable = room_charges_total + accommodation_addons_total
        gst_amount = round(accommodation_taxable * gst_rate / 100, 2)

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

        # ── Invoice logic (Section 3 of spec) ───────────────────────────────────
        # invoice_number (INV/YYYY/MM/XXXXX) is the GST tax invoice — separate from
        # bill_number (CC/YYYY/MM/XXXXX) which is always generated as the folio/receipt.
        any_addon_online = any(
            p.get("type") == "addon" and p.get("method") == "online"
            for p in stay_payments
        )
        is_same_day = checkin_dt.date() == checkout_dt.date()
        is_mmt_ota = (booking_source == "mmt" and payment_source == "ota")
        is_booking_com = (booking_source == "booking.com")

        # Determine whether this checkout qualifies for a bill + invoice.
        # Same-day + cash-only = no folio, no GST invoice (walk-in, no overnight stay).
        is_no_bill = (
            is_same_day
            and payment_cash > 0
            and payment_online == 0
            and not any_addon_online
        )

        if is_mmt_ota and any_addon_online:
            # MMT room (no hotel invoice) BUT guest paid for a service via UPI →
            # generate a hotel invoice for the addon portion only
            invoice_generated = True
        elif is_mmt_ota:
            # OTA billing fully handled by MMT — no hotel-issued invoice
            invoice_generated = False
        elif is_booking_com:
            # Booking.com: always generate invoice (spec requirement)
            invoice_generated = True
        elif is_no_bill:
            # Same-day cash-only checkout → no bill number, no GST invoice
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
        # Same-day cash-only stays are excluded — they won't appear in the Bills module.
        if not is_no_bill and not is_mmt_ota:
            bill_number = generate_sequential_bill_number(checkout_dt)
        else:
            bill_number = "-"

        invoice_number = None
        if invoice_generated:
            invoice_number = generate_sequential_invoice_number(checkout_dt)

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
            # GST invoice fields (separate from bill_number folio)
            "invoice_generated": invoice_generated,
            "invoice_number": invoice_number,
            # Settle-later link
            "settlement_id": settlement_id if settle_later else None,
            # ── GST breakdown (SAC 9963 — Accommodation Services) ─────────────
            # gst_rate     : 0 / 5 / 18 — determined by room_price_per_night slab
            # accommodation_taxable : room charges + accommodation add-ons (AC, Extra Bed)
            # non_accommodation_total : water, misc services (outside GST scope)
            # gst_amount   : accommodation_taxable × gst_rate / 100 (exclusive of tariff)
            "gst_rate": gst_rate,
            "accommodation_taxable": accommodation_taxable,
            "non_accommodation_total": non_accommodation_total,
            "gst_amount": gst_amount,
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

def generate_sequential_invoice_number(checkout_date):
    """
    Format: INV/YYYY/MM/XXXXX
    Separate atomic counter from bill numbers.
    """
    try:
        year  = checkout_date.year
        month = str(checkout_date.month).zfill(2)

        counter_key = f"invoice_{year}_{month}"
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
        return f"INV/{year}/{month}/{serial}"

    except Exception as e:
        logger.error(f"Error generating invoice number: {e}")
        ts = max(1, int(checkout_date.timestamp()) % 100000)
        return f"INV/{checkout_date.year}/{str(checkout_date.month).zfill(2)}/{ts:05d}"


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

# Start initialization in background
threading.Thread(target=initialize_data, daemon=True).start()
