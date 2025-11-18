from flask import Flask, render_template, request, jsonify, send_from_directory
from datetime import datetime, timedelta
import json
import os
import logging
import uuid
import firebase_admin
from firebase_admin import credentials, firestore, storage
from werkzeug.utils import secure_filename
import tempfile
import pytz
import base64
from functools import wraps
import threading

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.FileHandler("lodge.log"), logging.StreamHandler()]
)
logger = logging.getLogger(__name__)

app = Flask(__name__, static_folder='static')

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
        storage_bucket = os.environ.get('FIREBASE_STORAGE_BUCKET', 'your-project-id.appspot.com')
        firebase_admin.initialize_app(cred, {'storageBucket': storage_bucket})
    else:
        cred = credentials.Certificate('service-account.json')
        firebase_admin.initialize_app(cred, {'storageBucket': 'your-project-id.appspot.com'})
    
    db = firestore.client()
    bucket = storage.bucket()
    logger.info("Firebase initialized successfully")
except Exception as e:
    logger.error(f"Error initializing Firebase: {str(e)}")
    raise

# Define Firestore collection references
rooms_ref = db.collection('rooms')
logs_ref = db.collection('logs')
totals_ref = db.collection('totals')
bookings_ref = db.collection('bookings')
settings_ref = db.collection('settings')
settlements_ref = db.collection('settlements')
counters_ref = db.collection('daily_counters')
metadata_ref = db.collection('transaction_metadata')

# Upload folder
UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

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
@cached(ttl=5)
def get_all_rooms():
    """Get all rooms with caching"""
    rooms_dict = {}
    rooms_stream = rooms_ref.stream()
    for room_doc in rooms_stream:
        rooms_dict[room_doc.id] = room_doc.to_dict()
    return rooms_dict

@cached(ttl=10)
def get_all_logs():
    """Get all logs with caching"""
    logs_dict = {}
    logs_stream = logs_ref.stream()
    for log_doc in logs_stream:
        log_data = log_doc.to_dict()
        logs_dict[log_doc.id] = log_data.get('entries', [])
    return logs_dict

@cached(ttl=5)
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

# Lazy initialization
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
                "last_renewal_time": None
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
    """Check if a log entry is from the current guest stay"""
    try:
        log_date = log.get("date")
        log_time = log.get("time", "00:00")
        
        if not log_date:
            return True
        
        log_datetime = datetime.strptime(f"{log_date} {log_time}", "%Y-%m-%d %H:%M")
        return log_datetime >= checkin_time
        
    except Exception as e:
        logger.error(f"Error parsing log datetime: {str(e)}")
        return True

# Start initialization in background
threading.Thread(target=initialize_data, daemon=True).start()

# Routes
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/static/<path:path>")
def serve_static(path):
    return send_from_directory("static", path)

@app.route("/uploads/<path:filename>")
def uploaded_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

@app.route("/upload_photo", methods=["POST"])
def upload_photo():
    if 'photo' not in request.files:
        return jsonify(success=False, message="No file part")
    
    file = request.files['photo']
    if file.filename == '':
        return jsonify(success=False, message="No selected file")
    
    if file:
        try:
            filename = secure_filename(f"{datetime.now(IST).strftime('%Y%m%d%H%M%S')}-{file.filename}")
            temp_file_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
            file.save(temp_file_path)
            
            blob = bucket.blob(f"guest_photos/{filename}")
            blob.upload_from_filename(temp_file_path)
            blob.make_public()
            
            photo_url = blob.public_url
            os.remove(temp_file_path)
            
            return jsonify(success=True, filename=filename, path=photo_url)
        except Exception as e:
            logger.error(f"Error uploading photo: {str(e)}")
            return jsonify(success=False, message=f"Upload failed: {str(e)}")
    
    return jsonify(success=False, message="Upload failed")

@app.route("/checkin", methods=["POST"])
def checkin():
    try:
        data_json = request.json
        room = data_json["room"]
        amount_paid = int(data_json.get("amountPaid", 0))
        price = int(data_json["price"])
        balance = price - amount_paid
        payment = data_json["payment"]
        is_ac = data_json.get("isAC", False)
        
        if amount_paid > 0 and payment == "balance":
            return jsonify(success=False, message="Cannot use 'Pay Later' with an amount paid. Please select Cash or Online.")
        
        guest = {
            "name": data_json["name"],
            "mobile": data_json["mobile"],
            "price": price,
            "guests": int(data_json["guests"]),
            "payment": payment,
            "balance": balance,
            "isAC": is_ac
        }
        
        current_time = datetime.now(IST).strftime("%Y-%m-%d %H:%M")
        current_date = datetime.now(IST).strftime("%Y-%m-%d")
        
        serial_number = get_next_serial_number(current_date)
        store_transaction_metadata(room, current_date, serial_number, "fresh_checkin")
        
        batch = db.batch()
        
        room_ref = rooms_ref.document(room)
        batch.update(room_ref, {
            "status": "occupied",
            "guest": guest,
            "checkin_time": current_time,
            "balance": balance,
            "add_ons": [],
            "renewal_count": 0,
            "last_renewal_time": None
        })
        
        totals = get_totals()
        
        if payment != "balance":
            if amount_paid > 0:
                log_entry = {
                    "room": room,
                    "name": guest["name"],
                    "amount": amount_paid,
                    "time": datetime.now(IST).strftime("%H:%M"),
                    "date": current_date,
                    "serial_number": serial_number,
                    "transaction_type": "fresh_checkin",
                    "is_fresh_checkin": True
                }
                
                batch.update(logs_ref.document(payment), {
                    "entries": firestore.ArrayUnion([log_entry])
                })
                totals[payment] += amount_paid
        else:
            pay_later_log = {
                "room": room,
                "name": guest["name"],
                "amount": 0,
                "time": datetime.now(IST).strftime("%H:%M"),
                "date": current_date,
                "serial_number": serial_number,
                "transaction_type": "fresh_checkin",
                "is_fresh_checkin": True,
                "payment_method": "pay_later"
            }
            
            batch.update(logs_ref.document("cash"), {
                "entries": firestore.ArrayUnion([pay_later_log])
            })
        
        if balance > 0:
            balance_log = {
                "room": room,
                "name": guest["name"],
                "amount": balance,
                "date": current_date,
                "serial_number": serial_number,
                "transaction_type": "fresh_checkin"
            }
            
            batch.update(logs_ref.document("balance"), {
                "entries": firestore.ArrayUnion([balance_log])
            })
            totals["balance"] += balance
        
        batch.set(totals_ref.document('current_totals'), totals)
        batch.commit()
        
        invalidate_cache()
        
        logger.info(f"Check-in successful for room {room}, guest: {guest['name']}, serial: {serial_number}")
        return jsonify(
            success=True,
            message=f"Check-in successful for {guest['name']} (#{serial_number})",
            serial_number=serial_number
        )
    except Exception as e:
        logger.error(f"Error during check-in: {str(e)}")
        return jsonify(success=False, message=f"Error during check-in: {str(e)}")

@app.route("/checkout", methods=["POST"])
def checkout():
    try:
        data_json = request.json
        room = data_json["room"]
        payment_mode = data_json.get("payment_mode")
        amount = int(data_json.get("amount", 0))
        is_refund = data_json.get("is_refund", False)
        is_final_checkout = data_json.get("final_checkout", False)
        process_refund = data_json.get("process_refund", False)
        settle_later = data_json.get("settle_later", False)
        
        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found")
            
        room_data = room_doc.to_dict()
        totals = get_totals()
        batch = db.batch()
        
        if amount > 0 and payment_mode and not is_refund and not process_refund:
            current_balance = room_data["balance"]
            
            is_renewal_payment = False
            if room_data["guest"] and room_data["checkin_time"]:
                try:
                    checkin_date = datetime.strptime(room_data["checkin_time"].split()[0], "%Y-%m-%d")
                    current_date = datetime.now(IST).date()
                    days_since_checkin = (current_date - checkin_date.date()).days
                    is_renewal_payment = days_since_checkin >= 1
                except:
                    is_renewal_payment = False
            
            log_entry = {
                "room": room,
                "name": room_data["guest"]["name"],
                "amount": amount,
                "time": datetime.now(IST).strftime("%H:%M"),
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "is_renewal": is_renewal_payment,
                "transaction_type": "renewal_payment" if is_renewal_payment else "regular_payment"
            }
            
            batch.update(logs_ref.document(payment_mode), {
                "entries": firestore.ArrayUnion([log_entry])
            })
            
            totals[payment_mode] += amount
            
            if current_balance > 0:
                if amount >= current_balance:
                    totals["balance"] -= current_balance
                    overpayment = amount - current_balance
                    
                    if overpayment > 0:
                        new_balance = -overpayment
                        message = f"Payment of ₹{amount} received. Balance cleared. Overpayment: ₹{overpayment}"
                    else:
                        new_balance = 0
                        message = f"Payment of ₹{amount} received. Balance cleared."
                else:
                    new_balance = current_balance - amount
                    totals["balance"] -= amount
                    message = "Payment recorded successfully."
            else:
                new_balance = current_balance - amount
                message = "Payment recorded successfully."
            
            batch.update(rooms_ref.document(room), {"balance": new_balance})
            batch.set(totals_ref.document('current_totals'), totals)
            batch.commit()
            
            invalidate_cache()
            
            logger.info(f"Payment of ₹{amount} recorded for room {room}")
            return jsonify(success=True, message=message)
        
        elif process_refund and is_refund and amount > 0:
            current_balance = room_data["balance"]
            
            if abs(current_balance) < amount:
                return jsonify(
                    success=False,
                    message=f"Refund amount (₹{amount}) exceeds available balance (₹{abs(current_balance)})"
                )
            
            refund_method = payment_mode or "cash"
            guest_name = room_data["guest"]["name"]
            
            refund_log = {
                "room": room,
                "name": guest_name,
                "amount": amount,
                "payment_mode": refund_method,
                "time": data_json.get("time", datetime.now(IST).strftime("%H:%M")),
                "date": data_json.get("date", datetime.now(IST).strftime("%Y-%m-%d")),
                "note": "Manual refund",
                "transaction_type": "manual_refund"
            }
            
            batch.update(logs_ref.document("refunds"), {
                "entries": firestore.ArrayUnion([refund_log])
            })
            
            new_balance = current_balance + amount
            batch.update(rooms_ref.document(room), {"balance": new_balance})
            
            totals["refunds"] += amount
            batch.set(totals_ref.document('current_totals'), totals)
            batch.commit()
            
            invalidate_cache()
            
            logger.info(f"Manual refund of ₹{amount} processed for room {room}")
            return jsonify(success=True, message=f"Refund of ₹{amount} processed successfully")
        
        elif is_final_checkout:
            balance = room_data["balance"]
            guest_name = room_data["guest"]["name"] if room_data["guest"] else "Unknown"
            
            if balance > 0 and settle_later:
                settlement_id = str(uuid.uuid4())
                guest_info = room_data["guest"]
                settlement_amount = balance
                
                settlement = {
                    "id": settlement_id,
                    "guest_name": guest_info["name"],
                    "guest_mobile": guest_info["mobile"],
                    "room": room,
                    "amount": settlement_amount,
                    "checkout_date": datetime.now(IST).strftime("%Y-%m-%d"),
                    "checkout_time": datetime.now(IST).strftime("%H:%M"),
                    "status": "pending",
                    "notes": data_json.get("settlement_notes", ""),
                    "photo": guest_info.get("photo")
                }
                
                batch.set(settlements_ref.document(settlement_id), settlement)
                
                totals["balance"] -= settlement_amount
                
                balance_log = {
                    "room": room,
                    "name": guest_info["name"],
                    "amount": -settlement_amount,
                    "time": datetime.now(IST).strftime("%H:%M"),
                    "date": datetime.now(IST).strftime("%Y-%m-%d"),
                    "note": "Converted to 'settle later' during checkout",
                    "settlement_id": settlement_id,
                    "transaction_type": "settlement"
                }
                
                batch.update(logs_ref.document("balance"), {
                    "entries": firestore.ArrayUnion([balance_log])
                })
                
                logger.info(f"Settlement created for room {room}, amount: ₹{settlement_amount}")
            
            elif balance > 0 and not settle_later:
                return jsonify(success=False, message="Please clear the balance before checkout")
            
            refund_processed = False
            if balance < 0 and data_json.get("refund_method"):
                refund_amount = abs(balance)
                refund_method = data_json.get("refund_method", "cash")
                
                checkout_refund_log = {
                    "room": room,
                    "name": guest_name,
                    "amount": refund_amount,
                    "payment_mode": refund_method,
                    "time": datetime.now(IST).strftime("%H:%M"),
                    "date": datetime.now(IST).strftime("%Y-%m-%d"),
                    "note": "Checkout refund",
                    "transaction_type": "checkout_refund"
                }
                
                batch.update(logs_ref.document("refunds"), {
                    "entries": firestore.ArrayUnion([checkout_refund_log])
                })
                
                totals["refunds"] += refund_amount
                refund_processed = True
                
                logger.info(f"Checkout refund of ₹{refund_amount} processed for room {room}")
            
            batch.update(rooms_ref.document(room), {
                "status": "vacant",
                "guest": None,
                "checkin_time": None,
                "balance": 0,
                "add_ons": [],
                "renewal_count": 0,
                "last_renewal_time": None
            })
            
            batch.set(totals_ref.document('current_totals'), totals)
            batch.commit()
            
            invalidate_cache()
            
            if refund_processed:
                refund_amount = abs(balance)
                message = f"Checkout successful. Refund of ₹{refund_amount} processed."
            else:
                message = "Checkout successful"
            
            logger.info(f"Room {room} checked out. Guest: {guest_name}")
            return jsonify(success=True, message=message)
        
        return jsonify(success=False, message="Invalid request parameters")
            
    except Exception as e:
        logger.error(f"Error during checkout: {str(e)}")
        return jsonify(success=False, message=f"Error during checkout: {str(e)}")

@app.route("/add_on", methods=["POST"])
def add_on():
    try:
        data_json = request.json
        room = data_json["room"]
        item = data_json["item"]
        price = int(data_json["price"])
        payment_method = data_json.get("payment_method", "balance")
        
        unit_price = data_json.get("unit_price", price)
        quantity = data_json.get("quantity", 1)
        
        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found")
            
        room_data = room_doc.to_dict()
        totals = get_totals()
        batch = db.batch()
        
        add_on_entry = {
            "room": room,
            "item": item,
            "price": price,
            "unit_price": unit_price,
            "quantity": quantity,
            "time": datetime.now(IST).strftime("%H:%M"),
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "payment_method": payment_method,
            "transaction_type": "service"
        }
        
        if payment_method in ["cash", "online"]:
            payment_log = {
                "room": room,
                "name": room_data["guest"]["name"],
                "amount": price,
                "time": datetime.now(IST).strftime("%H:%M"),
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "item": item,
                "unit_price": unit_price,
                "quantity": quantity,
                "payment_method": payment_method,
                "transaction_type": "service"
            }
            
            batch.update(logs_ref.document(payment_method), {
                "entries": firestore.ArrayUnion([payment_log])
            })
            totals[payment_method] += price
        else:
            new_balance = room_data["balance"] + price
            batch.update(rooms_ref.document(room), {"balance": new_balance})
            
            totals["balance"] += price
            
            balance_log = {
                "room": room,
                "name": room_data["guest"]["name"],
                "amount": price,
                "time": datetime.now(IST).strftime("%H:%M"),
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "item": item,
                "unit_price": unit_price,
                "quantity": quantity,
                "note": f"Added {item} to balance",
                "transaction_type": "service"
            }
            
            batch.update(logs_ref.document("balance"), {
                "entries": firestore.ArrayUnion([balance_log])
            })
        
        batch.update(rooms_ref.document(room), {
            "add_ons": firestore.ArrayUnion([add_on_entry])
        })
        
        batch.update(logs_ref.document("add_ons"), {
            "entries": firestore.ArrayUnion([add_on_entry])
        })
        
        batch.set(totals_ref.document('current_totals'), totals)
        batch.commit()
        
        invalidate_cache()
        
        logger.info(f"Add-on '{item}' added to room {room}, price: ₹{price}, payment: {payment_method}")
        
        if payment_method == "balance":
            return jsonify(success=True, message=f"Added {item} (₹{price}) to room {room} balance")
        else:
            return jsonify(success=True, message=f"Added {item} (₹{price}) to room {room}, paid by {payment_method}")
    except Exception as e:
        logger.error(f"Error adding add-on: {str(e)}")
        return jsonify(success=False, message=f"Error adding add-on: {str(e)}")


@app.route("/get_rooms_only")
def get_rooms_only():
    """Get only rooms data - faster endpoint"""
    try:
        rooms = get_all_rooms()
        return jsonify(success=True, rooms=rooms)
    except Exception as e:
        logger.error(f"Error getting rooms: {str(e)}")
        return jsonify(success=False, message=str(e))

@app.route("/get_logs_only")
def get_logs_only():
    """Get only logs data - with limits"""
    try:
        logs = get_all_logs_limited()
        return jsonify(success=True, logs=logs)
    except Exception as e:
        logger.error(f"Error getting logs: {str(e)}")
        return jsonify(success=False, message=str(e))

@app.route("/get_totals_only")
def get_totals_only():
    """Get only totals - fastest endpoint"""
    try:
        totals = get_totals()
        return jsonify(success=True, totals=totals)
    except Exception as e:
        logger.error(f"Error getting totals: {str(e)}")
        return jsonify(success=False, message=str(e))

def get_all_logs_limited():
    """Get logs with limits to prevent memory overflow"""
    logs_dict = {}
    try:
        log_types = ["cash", "online", "balance", "add_ons", "refunds", 
                     "renewals", "booking_payments", "discounts", "expenses", "room_shifts"]
        
        for log_type in log_types:
            try:
                log_doc = logs_ref.document(log_type).get()
                if log_doc.exists:
                    entries = log_doc.to_dict().get('entries', [])
                    # Only return last 200 entries to save memory
                    logs_dict[log_type] = entries[-200:] if len(entries) > 200 else entries
                else:
                    logs_dict[log_type] = []
            except Exception as e:
                logger.error(f"Error fetching {log_type} logs: {str(e)}")
                logs_dict[log_type] = []
                
    except Exception as e:
        logger.error(f"Error fetching logs: {str(e)}")
    
    return logs_dict

@app.route("/get_data")
def get_data():
    try:
        rooms = get_all_rooms()
        logs = get_all_logs()
        totals = get_totals()
        return jsonify(rooms=rooms, logs=logs, totals=totals)
    except Exception as e:
        logger.error(f"Error getting data: {str(e)}")
        return jsonify(success=False, message=f"Error getting data: {str(e)}")

@app.route("/get_history", methods=["POST"])
def get_history():
    try:
        data_json = request.json
        room = data_json.get("room")
        guest_name = data_json.get("name")
        
        if not room or not guest_name:
            return jsonify(success=False, message="Room and guest name are required.")
        
        logs = get_all_logs()
        
        room_cash_logs = [log for log in logs.get("cash", []) if log["room"] == room and log["name"] == guest_name]
        room_online_logs = [log for log in logs.get("online", []) if log["room"] == room and log["name"] == guest_name]
        room_refund_logs = [log for log in logs.get("refunds", []) if log["room"] == room and log["name"] == guest_name]
        room_addons_logs = [log for log in logs.get("add_ons", []) if log["room"] == room]
        room_renewal_logs = [log for log in logs.get("renewals", []) if log["room"] == room and log["name"] == guest_name]
        
        return jsonify(
            success=True,
            cash=room_cash_logs,
            online=room_online_logs,
            refunds=room_refund_logs,
            addons=room_addons_logs,
            renewals=room_renewal_logs
        )
    except Exception as e:
        logger.error(f"Error getting history: {str(e)}")
        return jsonify(success=False, message=f"Error retrieving history: {str(e)}")

@app.route("/renew_rent", methods=["POST"])
def renew_rent():
    try:
        data_json = request.json
        room = data_json["room"]
        
        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found")
            
        room_data = room_doc.to_dict()
        
        if room_data["status"] != "occupied" or not room_data["guest"]:
            return jsonify(success=False, message="Room not occupied.")
        
        guest = room_data["guest"]
        price = guest["price"]
        
        new_balance = room_data["balance"] + price
        renewal_count = data_json.get("renewal_count", 0)
        
        batch = db.batch()
        
        batch.update(rooms_ref.document(room), {
            "balance": new_balance,
            "renewal_count": renewal_count
        })
        
        totals = get_totals()
        totals["balance"] += price
        batch.set(totals_ref.document('current_totals'), totals)
        
        renewal_log = {
            "room": room,
            "name": guest["name"],
            "amount": price,
            "time": datetime.now(IST).strftime("%H:%M"),
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "note": f"Day {renewal_count + 1} rent renewal",
            "day": renewal_count + 1,
            "transaction_type": "rent_renewal"
        }
        
        batch.update(logs_ref.document("balance"), {
            "entries": firestore.ArrayUnion([renewal_log])
        })
        
        batch.update(logs_ref.document("renewals"), {
            "entries": firestore.ArrayUnion([renewal_log])
        })
        
        batch.commit()
        invalidate_cache()
        
        update_last_rent_check()
        
        logger.info(f"Rent renewed for Room {room}, Day {renewal_count + 1}")
        return jsonify(success=True, message=f"Rent renewed for Room {room}")
    except Exception as e:
        logger.error(f"Error renewing rent: {str(e)}")
        return jsonify(success=False, message=f"Error renewing rent: {str(e)}")

@app.route("/update_checkin_time", methods=["POST"])
def update_checkin_time():
    try:
        data_json = request.json
        room = data_json["room"]
        new_checkin_time = data_json["checkin_time"]
        
        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found")
            
        room_data = room_doc.to_dict()
        
        if room_data["status"] != "occupied":
            return jsonify(success=False, message="Room not occupied.")
        
        datetime.strptime(new_checkin_time, "%Y-%m-%d %H:%M")
        
        rooms_ref.document(room).update({
            "checkin_time": new_checkin_time,
            "renewal_count": 0,
            "last_renewal_time": None
        })
        
        invalidate_cache()
        
        logger.info(f"Check-in time updated for room {room}: {new_checkin_time}")
        return jsonify(success=True, message="Check-in time updated successfully.")
    except Exception as e:
        logger.error(f"Error updating check-in time: {str(e)}")
        return jsonify(success=False, message=f"Error updating check-in time: {str(e)}")

@app.route("/get_room_numbers", methods=["GET"])
def get_room_numbers():
    try:
        rooms_stream = rooms_ref.stream()
        room_numbers = [doc.id for doc in rooms_stream]
        
        def room_sort_key(room_num):
            if room_num.startswith('2'):
                return 2, int(room_num)
            else:
                return 1, int(room_num)
        
        room_numbers.sort(key=room_sort_key)
        
        first_floor = [r for r in room_numbers if not r.startswith('2')]
        second_floor = [r for r in room_numbers if r.startswith('2')]
        
        return jsonify(
            success=True,
            rooms=room_numbers,
            first_floor=first_floor,
            second_floor=second_floor
        )
    except Exception as e:
        logger.error(f"Error retrieving room numbers: {str(e)}")
        return jsonify(success=False, message=f"Error retrieving room numbers: {str(e)}")

@app.route("/add_room", methods=["POST"])
def add_room():
    try:
        data_json = request.json
        room_number = data_json.get("roomNumber")
        
        if not room_number:
            return jsonify(success=False, message="Room number is required")
        
        room_doc = rooms_ref.document(room_number).get()
        if room_doc.exists:
            return jsonify(success=False, message=f"Room {room_number} already exists")
            
        rooms_ref.document(room_number).set({
            "status": "vacant",
            "guest": None,
            "checkin_time": None,
            "balance": 0,
            "add_ons": [],
            "renewal_count": 0,
            "last_renewal_time": None
        })
        
        invalidate_cache()
        
        logger.info(f"New room {room_number} added")
        return jsonify(success=True, message=f"Room {room_number} added successfully")
        
    except Exception as e:
        logger.error(f"Error adding new room: {str(e)}")
        return jsonify(success=False, message=f"Error adding new room: {str(e)}")

@app.route("/apply_discount", methods=["POST"])
def apply_discount():
    try:
        data_json = request.json
        room = data_json["room"]
        amount = int(data_json.get("amount", 0))
        reason = data_json.get("reason", "Discount")
        
        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found.")
            
        room_data = room_doc.to_dict()
            
        if room_data["status"] != "occupied":
            return jsonify(success=False, message="Room is not occupied.")
        
        if amount <= 0:
            return jsonify(success=False, message="Please provide a valid discount amount.")
        
        batch = db.batch()
        
        discount_entry = {
            "amount": amount,
            "reason": reason,
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "time": datetime.now(IST).strftime("%H:%M")
        }
        
        batch.update(rooms_ref.document(room), {
            "discounts": firestore.ArrayUnion([discount_entry])
        })
        
        current_balance = room_data["balance"]
        new_balance = current_balance
        
        totals = get_totals()
        
        if current_balance > 0:
            new_balance = max(0, current_balance - amount)
            if "balance" in totals:
                totals["balance"] = max(0, totals["balance"] - amount)
        else:
            new_balance = current_balance - amount
        
        batch.update(rooms_ref.document(room), {"balance": new_balance})
        batch.set(totals_ref.document('current_totals'), totals)
        
        discount_log = {
            "room": room,
            "name": room_data["guest"]["name"],
            "amount": amount,
            "reason": reason,
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "time": datetime.now(IST).strftime("%H:%M")
        }
        
        batch.update(logs_ref.document("discounts"), {
            "entries": firestore.ArrayUnion([discount_log])
        })
        
        batch.commit()
        invalidate_cache()
        
        logger.info(f"Discount of ₹{amount} applied to room {room}, reason: {reason}")
        
        return jsonify(success=True, message=f"Discount of ₹{amount} applied successfully.")
    except Exception as e:
        logger.error(f"Error applying discount: {str(e)}")
        return jsonify(success=False, message=f"Error applying discount: {str(e)}")

@app.route("/transfer_room", methods=["POST"])
def transfer_room():
    try:
        data_json = request.json
        old_room = str(data_json["old_room"])
        new_room = str(data_json["new_room"])
        new_price = data_json.get("new_price")
        is_ac = data_json.get("is_ac", False)
        
        rooms_dict = get_all_rooms()
        logs_dict = get_all_logs()
        
        if old_room not in rooms_dict or new_room not in rooms_dict:
            return jsonify(success=False, message="One or both rooms do not exist.")
            
        if rooms_dict[old_room]["status"] != "occupied":
            return jsonify(success=False, message="Source room is not occupied.")
            
        if rooms_dict[new_room]["status"] != "vacant":
            return jsonify(success=False, message="Destination room is not vacant.")
        
        guest_name = rooms_dict[old_room]["guest"]["name"]
        guest_mobile = rooms_dict[old_room]["guest"]["mobile"]
        checkin_time = rooms_dict[old_room]["checkin_time"]
        
        new_room_data = rooms_dict[old_room].copy()
        
        if new_price:
            new_room_data["guest"]["price"] = int(new_price)
        
        if new_room >= "202" and new_room <= "205":
            new_room_data["guest"]["isAC"] = is_ac
        
        batch = db.batch()
        
        batch.set(rooms_ref.document(new_room), new_room_data)
        
        current_checkin_time = datetime.strptime(checkin_time, "%Y-%m-%d %H:%M")
        
        def update_log_entries(log_type):
            log_doc = logs_ref.document(log_type).get()
            if log_doc.exists:
                entries = log_doc.to_dict().get('entries', [])
                updated = False
                
                for log in entries:
                    if (log.get("room") == old_room and
                        log.get("name") == guest_name and
                        is_log_from_current_stay(log, current_checkin_time)):
                        log["room"] = new_room
                        log["room_shifted"] = True
                        log["old_room"] = old_room
                        updated = True
                
                if updated:
                    batch.set(logs_ref.document(log_type), {"entries": entries})
        
        log_types = ["cash", "online", "balance", "add_ons", "refunds", "renewals",
                     "booking_payments", "discounts"]
        
        for log_type in log_types:
            update_log_entries(log_type)
        
        batch.update(rooms_ref.document(old_room), {
            "status": "vacant",
            "guest": None,
            "checkin_time": None,
            "balance": 0,
            "add_ons": [],
            "renewal_count": 0,
            "last_renewal_time": None
        })
        
        shift_log = {
            "room": new_room,
            "name": guest_name,
            "old_room": old_room,
            "time": datetime.now(IST).strftime("%H:%M"),
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "note": f"Transferred from Room {old_room} to Room {new_room}",
            "room_shifted": True,
            "guest_mobile": guest_mobile
        }
        
        if new_price:
            shift_log["new_price"] = new_price
            shift_log["note"] += f" (Price updated to ₹{new_price})"
        
        if new_room >= "202" and new_room <= "205":
            shift_log["is_ac"] = is_ac
            shift_log["note"] += f" ({'AC' if is_ac else 'Non-AC'})"
        
        batch.update(logs_ref.document("room_shifts"), {
            "entries": firestore.ArrayUnion([shift_log])
        })
        
        batch.commit()
        invalidate_cache()
        
        logger.info(f"Guest {guest_name} transferred from Room {old_room} to Room {new_room}")
        
        return jsonify(
            success=True,
            message=f"Guest transferred successfully from Room {old_room} to Room {new_room}."
        )
        
    except Exception as e:
        logger.error(f"Error transferring room: {str(e)}", exc_info=True)
        return jsonify(success=False, message=f"Error transferring room: {str(e)}")

@app.route("/add_expense", methods=["POST"])
def add_expense():
    try:
        data_json = request.json
        date = data_json.get("date")
        category = data_json.get("category")
        description = data_json.get("description")
        amount = int(data_json.get("amount", 0))
        payment_method = data_json.get("payment_method", "cash")
        expense_type = data_json.get("type", "transaction")
        
        if not date or not category or not description or amount <= 0 or not payment_method:
            return jsonify(success=False, message="All fields are required")
        
        batch = db.batch()
        
        expense_entry = {
            "date": date,
            "category": category,
            "description": description,
            "amount": amount,
            "payment_method": payment_method,
            "expense_type": expense_type,
            "time": datetime.now(IST).strftime("%H:%M")
        }
        
        expenses_doc = logs_ref.document("expenses").get()
        if not expenses_doc.exists:
            batch.set(logs_ref.document("expenses"), {"entries": [expense_entry]})
        else:
            batch.update(logs_ref.document("expenses"), {
                "entries": firestore.ArrayUnion([expense_entry])
            })
        
        if expense_type == "transaction":
            totals = get_totals()
            totals["expenses"] += amount
            batch.set(totals_ref.document('current_totals'), totals)
        
        batch.commit()
        invalidate_cache()
        
        logger.info(f"Expense added: {description}, Category: {category}, Amount: ₹{amount}, Type: {expense_type}")
        
        return jsonify(success=True, message=f"Expense of ₹{amount} added successfully")
    except Exception as e:
        logger.error(f"Error adding expense: {str(e)}")
        return jsonify(success=False, message=f"Error adding expense: {str(e)}")

@app.route("/reports", methods=["POST"])
def get_reports():
    try:
        data_json = request.json
        start_date = data_json.get("start_date")
        end_date = data_json.get("end_date")
        
        if not start_date or not end_date:
            return jsonify(success=False, message="Start and end dates are required.")
        
        start = datetime.strptime(start_date, "%Y-%m-%d")
        end = datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1)
        
        all_logs = get_all_logs()
        
        cash_logs = [log for log in all_logs.get("cash", []) if start <= datetime.strptime(log.get("date", "1970-01-01"), "%Y-%m-%d") < end]
        online_logs = [log for log in all_logs.get("online", []) if start <= datetime.strptime(log.get("date", "1970-01-01"), "%Y-%m-%d") < end]
        add_on_logs = [log for log in all_logs.get("add_ons", []) if start <= datetime.strptime(log.get("date", "1970-01-01"), "%Y-%m-%d") < end]
        refund_logs = [log for log in all_logs.get("refunds", []) if start <= datetime.strptime(log.get("date", "1970-01-01"), "%Y-%m-%d") < end]
        renewal_logs = [log for log in all_logs.get("renewals", []) if start <= datetime.strptime(log.get("date", "1970-01-01"), "%Y-%m-%d") < end]
        
        expense_logs = all_logs.get("expenses", [])
        filtered_expense_logs = [log for log in expense_logs if start <= datetime.strptime(log.get("date", "1970-01-01"), "%Y-%m-%d") < end]
        
        cash_total = sum(log["amount"] for log in cash_logs)
        online_total = sum(log["amount"] for log in online_logs)
        addon_total = sum(log["price"] for log in add_on_logs)
        refund_total = sum(log["amount"] for log in refund_logs)
        
        transaction_expense_total = sum(log["amount"] for log in filtered_expense_logs if log.get("expense_type") == "transaction")
        report_expense_total = sum(log["amount"] for log in filtered_expense_logs if log.get("expense_type") == "report")
        total_expense = transaction_expense_total + report_expense_total
        
        checkins = 0
        renewals = len(renewal_logs)
        
        rooms_data = get_all_rooms()
        
        for room_info in rooms_data.values():
            if room_info.get("checkin_time"):
                try:
                    checkin_date = datetime.strptime(room_info["checkin_time"].split(" ")[0], "%Y-%m-%d")
                    if start <= checkin_date < end:
                        checkins += 1
                except Exception as e:
                    logger.error(f"Error parsing checkin date: {str(e)}")
        
        return jsonify(
            success=True,
            cash_total=cash_total,
            online_total=online_total,
            addon_total=addon_total,
            refund_total=refund_total,
            expense_total=total_expense,
            transaction_expense_total=transaction_expense_total,
            report_expense_total=report_expense_total,
            total_revenue=cash_total + online_total - refund_total - transaction_expense_total,
            checkins=checkins,
            renewals=renewals,
            cash_logs=cash_logs,
            online_logs=online_logs,
            addon_logs=add_on_logs,
            refund_logs=refund_logs,
            renewal_logs=renewal_logs,
            expense_logs=filtered_expense_logs
        )
    
    except Exception as e:
        logger.error(f"Error generating report: {str(e)}")
        return jsonify(success=False, message=f"Error generating report: {str(e)}")

@app.route("/get_bookings", methods=["GET"])
def get_bookings():
    try:
        bookings_stream = bookings_ref.stream()
        
        bookings_list = []
        for booking_doc in bookings_stream:
            booking = booking_doc.to_dict()
            booking["booking_id"] = booking_doc.id
            bookings_list.append(booking)
        
        bookings_list.sort(key=lambda b: b.get("check_in_date", ""), reverse=True)
        
        return jsonify(success=True, bookings=bookings_list)
    except Exception as e:
        logger.error(f"Error getting bookings: {str(e)}")
        return jsonify(success=False, message=f"Error getting bookings: {str(e)}")

@app.route("/create_booking", methods=["POST"])
def create_booking():
    try:
        booking_data = request.json
        
        required_fields = ["room", "guest_name", "guest_mobile", "check_in_date", "check_out_date", "total_amount"]
        for field in required_fields:
            if field not in booking_data:
                return jsonify(success=False, message=f"Missing required field: {field}")
        
        booking_id = str(uuid.uuid4())
        
        booking = {
            "room": booking_data["room"],
            "guest_name": booking_data["guest_name"],
            "guest_mobile": booking_data["guest_mobile"],
            "booking_date": datetime.now(IST).strftime("%Y-%m-%d"),
            "check_in_date": booking_data["check_in_date"],
            "check_out_date": booking_data["check_out_date"],
            "status": "confirmed",
            "total_amount": int(booking_data["total_amount"]),
            "paid_amount": int(booking_data.get("paid_amount", 0)),
            "balance": int(booking_data["total_amount"]) - int(booking_data.get("paid_amount", 0)),
            "payment_method": booking_data.get("payment_method", "cash"),
            "notes": booking_data.get("notes", ""),
            "photo_path": booking_data.get("photo_path", None),
            "guest_count": int(booking_data.get("guest_count", 1))
        }
        
        batch = db.batch()
        
        paid_amount = int(booking_data.get("paid_amount", 0))
        if paid_amount > 0:
            payment_method = booking_data.get("payment_method", "cash")
            
            payment_log = {
                "booking_id": booking_id,
                "room": booking["room"],
                "name": booking["guest_name"],
                "amount": paid_amount,
                "time": datetime.now(IST).strftime("%H:%M"),
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "type": "booking_advance"
            }
            
            batch.update(logs_ref.document(payment_method), {
                "entries": firestore.ArrayUnion([payment_log])
            })
            
            booking_payment = {
                "booking_id": booking_id,
                "room": booking["room"],
                "name": booking["guest_name"],
                "amount": paid_amount,
                "payment_method": payment_method,
                "time": datetime.now(IST).strftime("%H:%M"),
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "type": "advance"
            }
            
            batch.update(logs_ref.document("booking_payments"), {
                "entries": firestore.ArrayUnion([booking_payment])
            })
            
            totals = get_totals()
            totals[payment_method] += paid_amount
            totals["advance_bookings"] += paid_amount
            batch.set(totals_ref.document('current_totals'), totals)
        
        batch.set(bookings_ref.document(booking_id), booking)
        batch.commit()
        
        invalidate_cache()
        
        logger.info(f"Booking created: {booking_id} for {booking['guest_name']}")
        return jsonify(success=True, booking_id=booking_id, message="Booking created successfully")
        
    except Exception as e:
        logger.error(f"Error creating booking: {str(e)}")
        return jsonify(success=False, message=f"Error creating booking: {str(e)}")

@app.route("/update_booking", methods=["POST"])
def update_booking():
    try:
        booking_data = request.json
        booking_id = booking_data.get("booking_id")
        
        booking_doc = bookings_ref.document(booking_id).get()
        if not booking_doc.exists:
            return jsonify(success=False, message="Invalid booking ID")
        
        booking = booking_doc.to_dict()
        batch = db.batch()
        
        new_payment_amount = int(booking_data.get("new_payment", 0))
        if new_payment_amount > 0:
            payment_method = booking_data.get("payment_method", "cash")
            
            payment_log = {
                "booking_id": booking_id,
                "room": booking["room"],
                "name": booking["guest_name"],
                "amount": new_payment_amount,
                "time": datetime.now(IST).strftime("%H:%M"),
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "type": "booking_payment"
            }
            
            batch.update(logs_ref.document(payment_method), {
                "entries": firestore.ArrayUnion([payment_log])
            })
            
            booking_payment = {
                "booking_id": booking_id,
                "room": booking["room"],
                "name": booking["guest_name"],
                "amount": new_payment_amount,
                "payment_method": payment_method,
                "time": datetime.now(IST).strftime("%H:%M"),
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "type": "additional_payment"
            }
            
            batch.update(logs_ref.document("booking_payments"), {
                "entries": firestore.ArrayUnion([booking_payment])
            })
            
            totals = get_totals()
            totals[payment_method] += new_payment_amount
            totals["advance_bookings"] += new_payment_amount
            batch.set(totals_ref.document('current_totals'), totals)
            
            booking["paid_amount"] += new_payment_amount
            booking["balance"] = booking["total_amount"] - booking["paid_amount"]
        
        updatable_fields = [
            "guest_name", "guest_mobile", "check_in_date", "check_out_date",
            "room", "notes", "guest_count", "total_amount", "status"
        ]
        
        for field in updatable_fields:
            if field in booking_data:
                booking[field] = booking_data[field]
        
        if "total_amount" in booking_data:
            booking["total_amount"] = int(booking_data["total_amount"])
            booking["balance"] = booking["total_amount"] - booking["paid_amount"]
            
        batch.set(bookings_ref.document(booking_id), booking)
        batch.commit()
        
        invalidate_cache()
        
        logger.info(f"Booking updated: {booking_id}")
        return jsonify(success=True, booking=booking, message="Booking updated successfully")
        
    except Exception as e:
        logger.error(f"Error updating booking: {str(e)}")
        return jsonify(success=False, message=f"Error updating booking: {str(e)}")

@app.route("/cancel_booking", methods=["POST"])
def cancel_booking():
    try:
        booking_data = request.json
        booking_id = booking_data.get("booking_id")
        
        booking_doc = bookings_ref.document(booking_id).get()
        if not booking_doc.exists:
            return jsonify(success=False, message="Invalid booking ID")
        
        booking = booking_doc.to_dict()
        batch = db.batch()
        
        refund_amount = int(booking_data.get("refund_amount", 0))
        if refund_amount > 0:
            refund_method = booking_data.get("refund_method", "cash")
            
            refund_log = {
                "booking_id": booking_id,
                "room": booking["room"],
                "name": booking["guest_name"],
                "amount": refund_amount,
                "time": datetime.now(IST).strftime("%H:%M"),
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "payment_mode": refund_method,
                "note": "Booking cancellation refund"
            }
            
            batch.update(logs_ref.document("refunds"), {
                "entries": firestore.ArrayUnion([refund_log])
            })
            
            totals = get_totals()
            totals["refunds"] += refund_amount
            batch.set(totals_ref.document('current_totals'), totals)
            
            booking["paid_amount"] -= refund_amount
            booking["balance"] = booking["total_amount"] - booking["paid_amount"]
        
        booking["status"] = "cancelled"
        booking["cancellation_date"] = datetime.now(IST).strftime("%Y-%m-%d")
        booking["cancellation_reason"] = booking_data.get("reason", "")
        
        batch.set(bookings_ref.document(booking_id), booking)
        batch.commit()
        
        invalidate_cache()
        
        logger.info(f"Booking cancelled: {booking_id}")
        return jsonify(success=True, message="Booking cancelled successfully")
        
    except Exception as e:
        logger.error(f"Error cancelling booking: {str(e)}")
        return jsonify(success=False, message=f"Error cancelling booking: {str(e)}")

@app.route("/convert_booking_to_checkin", methods=["POST"])
def convert_booking_to_checkin():
    try:
        booking_data = request.json
        booking_id = booking_data.get("booking_id")
        
        booking_doc = bookings_ref.document(booking_id).get()
        if not booking_doc.exists:
            return jsonify(success=False, message="Invalid booking ID")
        
        booking = booking_doc.to_dict()
        
        room_number = booking["room"]
        room_doc = rooms_ref.document(room_number).get()
        
        if not room_doc.exists:
            return jsonify(success=False, message=f"Room {room_number} does not exist")
        
        room_data = room_doc.to_dict()
        
        if room_data["status"] != "vacant":
            return jsonify(success=False, message=f"Room {room_number} is not vacant")
        
        remaining_payment = int(booking_data.get("remaining_payment", 0))
        payment_method = booking_data.get("payment_method", "cash")
        balance_after_payment = booking["balance"] - remaining_payment
        
        current_date = datetime.now(IST).strftime("%Y-%m-%d")
        serial_number = get_next_serial_number(current_date)
        
        store_transaction_metadata(room_number, current_date, serial_number, "booking_conversion")
        
        batch = db.batch()
        totals = get_totals()
        
        if remaining_payment > 0:
            payment_log = {
                "booking_id": booking_id,
                "room": booking["room"],
                "name": booking["guest_name"],
                "amount": remaining_payment,
                "time": datetime.now(IST).strftime("%H:%M"),
                "date": current_date,
                "type": "booking_final_payment",
                "serial_number": serial_number,
                "transaction_type": "booking_conversion",
                "is_booking_conversion": True
            }
            
            batch.update(logs_ref.document(payment_method), {
                "entries": firestore.ArrayUnion([payment_log])
            })
            
            totals[payment_method] += remaining_payment
        else:
            zero_payment_log = {
                "booking_id": booking_id,
                "room": booking["room"],
                "name": booking["guest_name"],
                "amount": 0,
                "time": datetime.now(IST).strftime("%H:%M"),
                "date": current_date,
                "type": "booking_conversion_zero_payment",
                "serial_number": serial_number,
                "transaction_type": "booking_conversion",
                "is_booking_conversion": True,
                "payment_method": "already_paid"
            }
            
            batch.update(logs_ref.document("cash"), {
                "entries": firestore.ArrayUnion([zero_payment_log])
            })
        
        booking_payment = {
            "booking_id": booking_id,
            "room": booking["room"],
            "name": booking["guest_name"],
            "amount": remaining_payment,
            "payment_method": payment_method if remaining_payment > 0 else "already_paid",
            "time": datetime.now(IST).strftime("%H:%M"),
            "date": current_date,
            "type": "final_payment" if remaining_payment > 0 else "conversion_no_payment",
            "serial_number": serial_number,
            "transaction_type": "booking_conversion",
            "is_booking_conversion": True
        }
        
        batch.update(logs_ref.document("booking_payments"), {
            "entries": firestore.ArrayUnion([booking_payment])
        })
        
        guest = {
            "name": booking["guest_name"],
            "mobile": booking["guest_mobile"],
            "price": int(booking_data.get("room_price", booking["total_amount"])),
            "guests": booking["guest_count"],
            "payment": payment_method,
            "balance": balance_after_payment if balance_after_payment > 0 else 0,
            "photo": booking.get("photo_path")
        }
        
        batch.update(rooms_ref.document(room_number), {
            "status": "occupied",
            "guest": guest,
            "checkin_time": datetime.now(IST).strftime("%Y-%m-%d %H:%M"),
            "balance": balance_after_payment if balance_after_payment > 0 else 0,
            "add_ons": [],
            "renewal_count": 0,
            "last_renewal_time": None
        })
        
        if balance_after_payment > 0:
            balance_log = {
                "room": room_number,
                "name": guest["name"],
                "amount": balance_after_payment,
                "date": current_date,
                "time": datetime.now(IST).strftime("%H:%M"),
                "note": "Remaining balance from booking",
                "serial_number": serial_number,
                "transaction_type": "booking_conversion",
                "is_booking_conversion": True
            }
            
            batch.update(logs_ref.document("balance"), {
                "entries": firestore.ArrayUnion([balance_log])
            })
            
            totals["balance"] += balance_after_payment
        
        booking["status"] = "checked_in"
        booking["check_in_time"] = datetime.now(IST).strftime("%Y-%m-%d %H:%M")
        
        batch.set(bookings_ref.document(booking_id), booking)
        batch.set(totals_ref.document('current_totals'), totals)
        batch.commit()
        
        invalidate_cache()
        
        logger.info(f"Booking {booking_id} converted to check-in for room {room_number} with serial #{serial_number}")
        
        return jsonify(
            success=True,
            message=f"Guest checked in to Room {room_number} (#{serial_number})",
            serial_number=serial_number
        )
        
    except Exception as e:
        logger.error(f"Error converting booking to check-in: {str(e)}", exc_info=True)
        return jsonify(success=False, message=f"Error converting booking to check-in: {str(e)}")

@app.route("/check_availability", methods=["POST"])
def check_availability():
    try:
        request_data = request.json
        check_in_date = request_data.get("check_in_date")
        check_out_date = request_data.get("check_out_date")
        
        if not check_in_date or not check_out_date:
            return jsonify(success=False, message="Check-in and check-out dates are required")
        
        try:
            check_in = datetime.strptime(check_in_date, "%Y-%m-%d")
            check_out = datetime.strptime(check_out_date, "%Y-%m-%d")
        except ValueError:
            return jsonify(success=False, message="Invalid date format. Use YYYY-MM-DD")
        
        bookings_stream = bookings_ref.stream()
        booked_rooms = set()
        
        for booking_doc in bookings_stream:
            booking = booking_doc.to_dict()
            
            if booking.get("status") in ["cancelled", "checked_in"]:
                continue
                
            booking_check_in = datetime.strptime(booking["check_in_date"], "%Y-%m-%d")
            booking_check_out = datetime.strptime(booking["check_out_date"], "%Y-%m-%d")
            
            if (check_in < booking_check_out and check_out > booking_check_in):
                booked_rooms.add(booking["room"])
        
        today = datetime.now(IST).replace(hour=0, minute=0, second=0, microsecond=0)
        
        if check_in.date() == today.date():
            rooms_stream = rooms_ref.stream()
            
            for room_doc in rooms_stream:
                room_data = room_doc.to_dict()
                if room_data["status"] == "occupied":
                    booked_rooms.add(room_doc.id)
        
        all_rooms_stream = rooms_ref.stream()
        all_rooms = [room_doc.id for room_doc in all_rooms_stream]
        
        available_rooms = [room for room in all_rooms if room not in booked_rooms]
        available_rooms.sort(key=lambda r: (int(r) if r.isdigit() else float('inf'), r))
        
        return jsonify(success=True, available_rooms=available_rooms)
        
    except Exception as e:
        logger.error(f"Error checking availability: {str(e)}")
        return jsonify(success=False, message=f"Error checking availability: {str(e)}")

def fetch_settlements():
    settlements_stream = settlements_ref.stream()
    settlements_list = []
    
    for doc in settlements_stream:
        settlement_data = doc.to_dict()
        settlement_data["id"] = doc.id
        settlements_list.append(settlement_data)
        
    return settlements_list

@app.route("/get_pending_settlements", methods=["GET"])
def get_pending_settlements_route():
    try:
        settlements = fetch_settlements()
        return jsonify(success=True, settlements=settlements)
    except Exception as e:
        logger.error(f"Error fetching settlements: {str(e)}")
        return jsonify(success=False, message=f"Error fetching settlements: {str(e)}")

@app.route("/collect_settlement", methods=["POST"])
def collect_settlement():
    try:
        data_json = request.json
        settlement_id = data_json["settlement_id"]
        payment_mode = data_json["payment_mode"]
        
        payment_amount = int(data_json.get("payment_amount", 0))
        discount_amount = int(data_json.get("discount_amount", 0))
        discount_reason = data_json.get("discount_reason", "")
        
        settlement_doc = settlements_ref.document(settlement_id).get()
        if not settlement_doc.exists:
            return jsonify(success=False, message="Settlement not found")
        
        settlement = settlement_doc.to_dict()
        batch = db.batch()
        
        if discount_amount > 0:
            if discount_amount > settlement["amount"]:
                return jsonify(success=False, message=f"Discount amount (₹{discount_amount}) exceeds settlement amount (₹{settlement['amount']})")
                
            settlement["amount"] -= discount_amount
            settlement["discount_amount"] = discount_amount
            settlement["discount_reason"] = discount_reason
            
            discount_log = {
                "settlement_id": settlement_id,
                "name": settlement["guest_name"],
                "amount": discount_amount,
                "reason": discount_reason,
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "time": datetime.now(IST).strftime("%H:%M")
            }
            
            batch.update(logs_ref.document("discounts"), {
                "entries": firestore.ArrayUnion([discount_log])
            })
        
        if payment_amount <= 0:
            payment_amount = settlement["amount"]
        
        if payment_amount > settlement["amount"]:
            return jsonify(success=False, message=f"Payment amount (₹{payment_amount}) exceeds settlement amount (₹{settlement['amount']})")
        
        payment_log = {
            "room": settlement["room"],
            "name": settlement["guest_name"],
            "amount": payment_amount,
            "time": datetime.now(IST).strftime("%H:%M"),
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "settlement_id": settlement_id,
            "note": "Settlement payment collected"
        }
        
        batch.update(logs_ref.document(payment_mode), {
            "entries": firestore.ArrayUnion([payment_log])
        })
        
        totals = get_totals()
        totals[payment_mode] += payment_amount
        batch.set(totals_ref.document('current_totals'), totals)
        
        if payment_amount == settlement["amount"]:
            settlement["status"] = "paid"
            settlement["payment_date"] = datetime.now(IST).strftime("%Y-%m-%d")
            settlement["payment_time"] = datetime.now(IST).strftime("%H:%M")
            settlement["payment_mode"] = payment_mode
        else:
            settlement["status"] = "partial"
            settlement["amount"] -= payment_amount
            
            if "payments" not in settlement:
                settlement["payments"] = []
                
            settlement["payments"].append({
                "amount": payment_amount,
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "time": datetime.now(IST).strftime("%H:%M"),
                "mode": payment_mode
            })
        
        batch.set(settlements_ref.document(settlement_id), settlement)
        batch.commit()
        
        invalidate_cache()
        
        if payment_amount == settlement["amount"]:
            message = f"Full payment of ₹{payment_amount} collected successfully"
        else:
            message = f"Partial payment of ₹{payment_amount} collected. Remaining: ₹{settlement['amount']}"
            
        return jsonify(
            success=True,
            message=message,
            payment_mode=payment_mode,
            remaining=settlement["amount"]
        )
        
    except Exception as e:
        logger.error(f"Error collecting settlement payment: {str(e)}")
        return jsonify(success=False, message=f"Error collecting settlement payment: {str(e)}")

@app.route("/cancel_settlement", methods=["POST"])
def cancel_settlement():
    try:
        data_json = request.json
        settlement_id = data_json["settlement_id"]
        reason = data_json.get("reason", "Cancelled by user")
        
        settlement_doc = settlements_ref.document(settlement_id).get()
        if not settlement_doc.exists:
            return jsonify(success=False, message="Settlement not found")
            
        settlement = settlement_doc.to_dict()
        
        guest_name = settlement["guest_name"]
        amount = settlement["amount"]
        
        if data_json.get("delete", False):
            settlements_ref.document(settlement_id).delete()
        else:
            settlement["status"] = "cancelled"
            settlement["cancel_date"] = datetime.now(IST).strftime("%Y-%m-%d")
            settlement["cancel_time"] = datetime.now(IST).strftime("%H:%M")
            settlement["cancel_reason"] = reason
            
            settlements_ref.document(settlement_id).set(settlement)
        
        invalidate_cache()
        
        logger.info(f"Settlement cancelled: ₹{amount} from {guest_name}, reason: {reason}")
        
        return jsonify(
            success=True,
            message=f"Settlement of ₹{amount} cancelled successfully"
        )
        
    except Exception as e:
        logger.error(f"Error cancelling settlement: {str(e)}")
        return jsonify(success=False, message=f"Error cancelling settlement: {str(e)}")

@app.route("/get_transaction_metadata", methods=["GET"])
def get_transaction_metadata():
    try:
        counters_stream = counters_ref.stream()
        daily_counters = {doc.id: doc.to_dict().get('count', 0) for doc in counters_stream}
        
        metadata_stream = metadata_ref.stream()
        transaction_metadata = {doc.id: doc.to_dict() for doc in metadata_stream}
        
        return jsonify(
            success=True,
            daily_counters=daily_counters,
            transaction_metadata=transaction_metadata
        )
    except Exception as e:
        logger.error(f"Error getting transaction metadata: {str(e)}")
        return jsonify(success=False, message=f"Error getting transaction metadata: {str(e)}")

@app.route("/cleanup_old_data", methods=["POST"])
def cleanup_old_data_route():
    try:
        cleanup_old_counters()
        return jsonify(success=True, message="Old data cleaned up successfully")
    except Exception as e:
        return jsonify(success=False, message=f"Error cleaning up data: {str(e)}")

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port)