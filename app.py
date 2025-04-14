# app.py
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

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.FileHandler("lodge.log"), logging.StreamHandler()]
)
logger = logging.getLogger(__name__)

app = Flask(__name__, static_folder='static')

# Initialize Firebase Admin SDK
try:
    # For production deployment, use this approach
    cred = credentials.Certificate('D:\WorkSpace\V2\cibara-software-61512-firebase-adminsdk-fbsvc-9a37e53816.json')  # Replace with your key path
    
    # For deployment platforms that support environment variables like Heroku
    # import json
    # cred_dict = json.loads(os.environ.get('FIREBASE_CREDENTIALS'))
    # cred = credentials.Certificate(cred_dict)
    
    firebase_admin.initialize_app(cred, {
        'storageBucket': 'your-project-id.appspot.com'  # Replace with your storage bucket
    })
    
    # Get Firestore database
    db = firestore.client()
    bucket = storage.bucket()
    
    logger.info("Firebase initialized successfully")
except Exception as e:
    logger.error(f"Error initializing Firebase: {str(e)}")
    raise

# Initialize Indian Timezone for consistent timestamps
IST = pytz.timezone('Asia/Kolkata')

# Define references for Firestore collections
rooms_ref = db.collection('rooms')
logs_ref = db.collection('logs')
totals_ref = db.collection('totals')
bookings_ref = db.collection('bookings')
settings_ref = db.collection('settings')

# Upload folder for temporary storage during processing
UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

# Initialize or load existing data
def initialize_data():
    logger.info("Initializing data from Firebase...")
    
    try:
        # Get app settings
        settings_doc = settings_ref.document('app_settings').get()
        
        if not settings_doc.exists:
            # Default settings
            settings_ref.document('app_settings').set({
                'last_rent_check': datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")
            })
        
        # Check if rooms exist, if not create default structure
        rooms_count = len(list(rooms_ref.limit(1).stream()))
        
        if rooms_count == 0:
            # Create default room structure
            logger.info("Creating default room structure in Firestore")
            
            # First floor rooms
            first_floor_rooms = list(range(1, 6)) + list(range(13, 21)) + list(range(23, 28))
            # Second floor rooms
            second_floor_rooms = list(range(200, 229))
            
            # Batch write to Firestore (for better performance)
            batch = db.batch()
            
            # Add first floor rooms
            for num in first_floor_rooms:
                room_ref = rooms_ref.document(str(num))
                batch.set(room_ref, {
                    "status": "vacant", 
                    "guest": None, 
                    "checkin_time": None, 
                    "balance": 0, 
                    "add_ons": []
                })
                
            # Add second floor rooms
            for num in second_floor_rooms:
                room_ref = rooms_ref.document(str(num))
                batch.set(room_ref, {
                    "status": "vacant", 
                    "guest": None, 
                    "checkin_time": None, 
                    "balance": 0, 
                    "add_ons": []
                })
            
            # Commit the batch
            batch.commit()
            
            # Create log structure
            log_types = ["cash", "online", "balance", "add_ons", "refunds", "renewals", "booking_payments"]
            for log_type in log_types:
                logs_ref.document(log_type).set({
                    "entries": []
                })
            
            # Create totals structure
            total_types = ["cash", "online", "balance", "refunds", "advance_bookings"]
            totals_doc = {}
            for total_type in total_types:
                totals_doc[total_type] = 0
                
            totals_ref.document('current_totals').set(totals_doc)
            
            logger.info("Default data structure created in Firebase")
            
        return True
    except Exception as e:
        logger.error(f"Error initializing Firebase data: {str(e)}")
        return False

# Load all rooms from Firestore
def get_all_rooms():
    rooms_dict = {}
    rooms_stream = rooms_ref.stream()
    
    for room_doc in rooms_stream:
        room_data = room_doc.to_dict()
        rooms_dict[room_doc.id] = room_data
        
    return rooms_dict

# Load logs from Firestore
def get_all_logs():
    logs_dict = {}
    logs_stream = logs_ref.stream()
    
    for log_doc in logs_stream:
        log_data = log_doc.to_dict()
        if 'entries' in log_data:
            logs_dict[log_doc.id] = log_data['entries']
        else:
            logs_dict[log_doc.id] = []
            
    return logs_dict

# Load totals from Firestore
def get_totals():
    totals_doc = totals_ref.document('current_totals').get()
    if totals_doc.exists:
        return totals_doc.to_dict()
    else:
        return {
            "cash": 0, 
            "online": 0, 
            "balance": 0, 
            "refunds": 0,
            "advance_bookings": 0
        }

# Get last rent check time
def get_last_rent_check():
    settings_doc = settings_ref.document('app_settings').get()
    if settings_doc.exists:
        settings = settings_doc.to_dict()
        return settings.get('last_rent_check', datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"))
    return datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")

# Update last rent check time
def update_last_rent_check():
    settings_ref.document('app_settings').update({
        'last_rent_check': datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")
    })

# Initialize Firebase data
initialize_data()

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
            # Create a temporary filename
            filename = secure_filename(f"{datetime.now(IST).strftime('%Y%m%d%H%M%S')}-{file.filename}")
            temp_file_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
            
            # Save temporarily
            file.save(temp_file_path)
            
            # Upload to Firebase Storage
            blob = bucket.blob(f"guest_photos/{filename}")
            blob.upload_from_filename(temp_file_path)
            
            # Make the file publicly accessible
            blob.make_public()
            
            # Get the public URL
            photo_url = blob.public_url
            
            # Remove temporary file
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
        photo_path = data_json.get("photoPath")  # Get photo path if provided
        
        # Validation: don't allow amount_paid > 0 with payment="balance"
        if amount_paid > 0 and payment == "balance":
            return jsonify(success=False, message="Cannot use 'Pay Later' with an amount paid. Please select Cash or Online.")
        
        guest = {
            "name": data_json["name"],
            "mobile": data_json["mobile"],
            "price": price,
            "guests": int(data_json["guests"]),
            "payment": payment,
            "balance": balance,
            "photo": photo_path  # Store photo path with guest info
        }
        
        # Use consistent datetime format YYYY-MM-DD HH:MM for easier manipulation
        current_time = datetime.now(IST).strftime("%Y-%m-%d %H:%M")
        
        # Update room in Firestore
        room_ref = rooms_ref.document(room)
        room_ref.update({
            "status": "occupied",
            "guest": guest,
            "checkin_time": current_time,
            "balance": balance,
            "add_ons": [],
            "renewal_count": 0,
            "last_renewal_time": None
        })
        
        # Get current totals
        totals = get_totals()
        
        # Add payment log and update totals
        if amount_paid > 0:
            log_entry = {
                "room": room, 
                "name": guest["name"], 
                "amount": amount_paid, 
                "time": datetime.now(IST).strftime("%H:%M"),
                "date": datetime.now(IST).strftime("%Y-%m-%d")
            }
            
            # Update payment logs
            logs_ref.document(payment).update({
                "entries": firestore.ArrayUnion([log_entry])
            })
            
            # Update totals
            totals[payment] += amount_paid
        
        # Add balance log if needed
        if balance > 0:
            balance_log = {
                "room": room, 
                "name": guest["name"], 
                "amount": balance,
                "date": datetime.now(IST).strftime("%Y-%m-%d")
            }
            
            # Update balance logs
            logs_ref.document("balance").update({
                "entries": firestore.ArrayUnion([balance_log])
            })
            
            # Update totals
            totals["balance"] += balance
        
        # Update totals in Firestore
        totals_ref.document('current_totals').set(totals)
            
        logger.info(f"Check-in successful for room {room}, guest: {guest['name']}")
        return jsonify(success=True, message=f"Check-in successful for {guest['name']}")
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
        
        # Get current room data
        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found")
            
        room_data = room_doc.to_dict()
        
        # Get current totals
        totals = get_totals()
        
        # If this is a payment to clear balance
        if amount > 0 and payment_mode and not is_refund and not process_refund:
            current_balance = room_data["balance"]
            
            # Log the payment
            log_entry = {
                "room": room, 
                "name": room_data["guest"]["name"], 
                "amount": amount, 
                "time": datetime.now(IST).strftime("%H:%M"),
                "date": datetime.now(IST).strftime("%Y-%m-%d")
            }
            
            # Add to payment logs
            logs_ref.document(payment_mode).update({
                "entries": firestore.ArrayUnion([log_entry])
            })
            
            # Update totals
            totals[payment_mode] += amount
            
            # Handle case where balance is positive
            if current_balance > 0:
                # Check if payment equals or exceeds balance
                if amount >= current_balance:
                    # Update totals - remove from balance total
                    totals["balance"] -= current_balance
                    
                    # Calculate any overpayment
                    overpayment = amount - current_balance
                    
                    # Set balance to exactly 0 or negative for overpayment
                    if overpayment > 0:
                        # This is an overpayment
                        new_balance = -overpayment
                        message = f"Payment of ₹{amount} received. Balance cleared. Overpayment: ₹{overpayment}"
                    else:
                        # This is an exact payment
                        new_balance = 0
                        message = f"Payment of ₹{amount} received. Balance cleared."
                else:
                    # Normal partial payment
                    new_balance = current_balance - amount
                    totals["balance"] -= amount
                    message = "Payment recorded successfully."
            else:
                # Adding payment when no balance or negative balance
                new_balance = current_balance - amount
                message = "Payment recorded successfully."
            
            # Update room balance in Firestore
            rooms_ref.document(room).update({
                "balance": new_balance
            })
            
            # Update totals in Firestore
            totals_ref.document('current_totals').set(totals)
            
            logger.info(f"Payment of ₹{amount} recorded for room {room}")
            return jsonify(success=True, message=message)
        
        # Process refund if requested
        elif process_refund and is_refund and amount > 0:
            current_balance = room_data["balance"]
            
            # Validate that refund amount doesn't exceed available balance
            if abs(current_balance) < amount:
                return jsonify(
                    success=False, 
                    message=f"Refund amount (₹{amount}) exceeds available balance (₹{abs(current_balance)})"
                )
            
            # Get refund details
            refund_method = payment_mode or "cash"  # Default to cash if not specified
            guest_name = room_data["guest"]["name"]
            
            # Create refund log entry
            refund_log = {
                "room": room,
                "name": guest_name,
                "amount": amount,
                "payment_mode": refund_method,
                "time": data_json.get("time", datetime.now(IST).strftime("%H:%M")),
                "date": data_json.get("date", datetime.now(IST).strftime("%Y-%m-%d")),
                "note": "Partial refund" if abs(current_balance) > amount else "Full refund"
            }
            
            # Add to refunds log
            logs_ref.document("refunds").update({
                "entries": firestore.ArrayUnion([refund_log])
            })
            
            # Update room balance - only reduce by the amount being refunded
            new_balance = current_balance + amount
            rooms_ref.document(room).update({
                "balance": new_balance
            })
            
            # Update total refunds
            totals["refunds"] += amount
            totals_ref.document('current_totals').set(totals)
            
            logger.info(f"Refund of ₹{amount} processed for room {room}")
            
            return jsonify(success=True, message=f"Refund of ₹{amount} processed successfully")
        
        # Process final checkout
        elif is_final_checkout:
            # Check balance status
            balance = room_data["balance"]
            if balance > 0:
                return jsonify(success=False, message="Please clear the balance before checkout")
            
            # Process any refund if there's a negative balance
            if balance < 0 and "refund_method" in data_json:
                refund_amount = abs(balance)
                refund_method = data_json.get("refund_method", "cash")
                
                # Log the refund
                refund_log = {
                    "room": room,
                    "name": room_data["guest"]["name"],
                    "amount": refund_amount,
                    "payment_mode": refund_method,
                    "time": datetime.now(IST).strftime("%H:%M"),
                    "date": datetime.now(IST).strftime("%Y-%m-%d"),
                    "note": "Checkout refund"
                }
                
                logs_ref.document("refunds").update({
                    "entries": firestore.ArrayUnion([refund_log])
                })
                
                # Update total refunds
                totals["refunds"] += refund_amount
                totals_ref.document('current_totals').set(totals)
                
                logger.info(f"Checkout refund of ₹{refund_amount} processed for room {room}")
            
            # Clear room data
            guest_name = room_data["guest"]["name"] if room_data["guest"] else "Unknown"
            
            # Reset room to vacant
            rooms_ref.document(room).update({
                "status": "vacant", 
                "guest": None, 
                "checkin_time": None, 
                "balance": 0, 
                "add_ons": []
            })
            
            logger.info(f"Room {room} checked out. Guest: {guest_name}")
            
            return jsonify(success=True, message=f"Checkout successful")
        
        # If none of the above conditions match
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
        payment_method = data_json.get("payment_method", "balance")  # Default to balance if not specified
        
        # Get current room data
        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found")
            
        room_data = room_doc.to_dict()
        
        # Get totals
        totals = get_totals()
        
        # Create add-on entry
        add_on_entry = {
            "room": room, 
            "item": item, 
            "price": price, 
            "time": datetime.now(IST).strftime("%H:%M"),
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "payment_method": payment_method  # Store payment method
        }
        
        # If payment is immediate (cash or online), log it as a payment with item information
        if payment_method in ["cash", "online"]:
            payment_log = {
                "room": room,
                "name": room_data["guest"]["name"],
                "amount": price,
                "time": datetime.now(IST).strftime("%H:%M"),
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "item": item,  # Add item info to indicate this is a service payment
                "payment_method": payment_method
            }
            
            # Update payment logs
            logs_ref.document(payment_method).update({
                "entries": firestore.ArrayUnion([payment_log])
            })
            
            # Update totals
            totals[payment_method] += price
        else:
            # Add to balance if payment method is "balance" (pay later)
            new_balance = room_data["balance"] + price
            rooms_ref.document(room).update({
                "balance": new_balance
            })
            
            totals["balance"] += price
            
            # Log in balance logs
            balance_log = {
                "room": room,
                "name": room_data["guest"]["name"],
                "amount": price,
                "time": datetime.now(IST).strftime("%H:%M"),
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "item": item,
                "note": f"Added {item} to balance"
            }
            
            logs_ref.document("balance").update({
                "entries": firestore.ArrayUnion([balance_log])
            })
        
        # Always add to room's add-ons list for record keeping
        rooms_ref.document(room).update({
            "add_ons": firestore.ArrayUnion([add_on_entry])
        })
        
        # Also log in the central add-ons log
        logs_ref.document("add_ons").update({
            "entries": firestore.ArrayUnion([add_on_entry])
        })
        
        # Update totals
        totals_ref.document('current_totals').set(totals)
        
        logger.info(f"Add-on '{item}' added to room {room}, price: ₹{price}, payment: {payment_method}")
        
        if payment_method == "balance":
            return jsonify(success=True, message=f"Added {item} (₹{price}) to room {room} balance")
        else:
            return jsonify(success=True, message=f"Added {item} (₹{price}) to room {room}, paid by {payment_method}")
    except Exception as e:
        logger.error(f"Error adding add-on: {str(e)}")
        return jsonify(success=False, message=f"Error adding add-on: {str(e)}")

@app.route("/get_data")
def get_data():
    try:
        # Get data from Firestore
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
        
        # Get logs from Firestore
        logs = get_all_logs()
        
        # Filter logs for this specific room and guest
        room_cash_logs = [log for log in logs.get("cash", []) if log["room"] == room and log["name"] == guest_name]
        room_online_logs = [log for log in logs.get("online", []) if log["room"] == room and log["name"] == guest_name]
        room_refund_logs = [log for log in logs.get("refunds", []) if log["room"] == room and log["name"] == guest_name]
        room_addons_logs = [log for log in logs.get("add_ons", []) if log["room"] == room and log.get("name") == guest_name]
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
        
        # Get current room data
        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found")
            
        room_data = room_doc.to_dict()
        
        if room_data["status"] != "occupied" or not room_data["guest"]:
            return jsonify(success=False, message="Room not occupied.")
        
        guest = room_data["guest"]
        price = guest["price"]
        
        # Add new balance for rent renewal
        new_balance = room_data["balance"] + price
        
        # Update renewal count - this is the key value used to calculate next renewal time
        renewal_count = data_json.get("renewal_count", 0)
        
        # Update room in Firestore
        rooms_ref.document(room).update({
            "balance": new_balance,
            "renewal_count": renewal_count
        })
        
        # Get totals and update balance
        totals = get_totals()
        totals["balance"] += price
        totals_ref.document('current_totals').set(totals)
        
        logger.info(f"Rent renewed for room {room}, new renewal count: {renewal_count}")
        
        # Log the renewal
        renewal_log = {
            "room": room, 
            "name": guest["name"], 
            "amount": price,
            "time": datetime.now(IST).strftime("%H:%M"),
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "note": f"Day {renewal_count + 1} rent renewal",
            "day": renewal_count + 1
        }
        
        # Add to balance logs
        logs_ref.document("balance").update({
            "entries": firestore.ArrayUnion([renewal_log])
        })
        
        # Also add to renewals log
        logs_ref.document("renewals").update({
            "entries": firestore.ArrayUnion([renewal_log])
        })
        
        # Update last rent check time
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
        
        # Get current room data
        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found")
            
        room_data = room_doc.to_dict()
        
        if room_data["status"] != "occupied":
            return jsonify(success=False, message="Room not occupied.")
        
        # Validate the new time
        datetime.strptime(new_checkin_time, "%Y-%m-%d %H:%M")
        
        # Update the checkin time
        rooms_ref.document(room).update({
            "checkin_time": new_checkin_time,
            "renewal_count": 0,
            "last_renewal_time": None
        })
        
        logger.info(f"Check-in time updated for room {room}: {new_checkin_time}")
        return jsonify(success=True, message="Check-in time updated successfully.")
    except Exception as e:
        logger.error(f"Error updating check-in time: {str(e)}")
        return jsonify(success=False, message=f"Error updating check-in time: {str(e)}")

@app.route("/get_room_numbers", methods=["GET"])
def get_room_numbers():
    try:
        # Get all rooms from Firestore
        rooms_stream = rooms_ref.stream()
        room_numbers = [doc.id for doc in rooms_stream]
        
        # Sort rooms by floor and number
        def room_sort_key(room_num):
            # Second floor rooms (start with 2)
            if room_num.startswith('2'):
                return 2, int(room_num)
            # First floor rooms
            else:
                return 1, int(room_num)
        
        room_numbers.sort(key=room_sort_key)
        
        # Group by floor
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
        
        # Check if room already exists
        room_doc = rooms_ref.document(room_number).get()
        if room_doc.exists:
            return jsonify(success=False, message=f"Room {room_number} already exists")
            
        # Add the new room
        rooms_ref.document(room_number).set({
            "status": "vacant", 
            "guest": None, 
            "checkin_time": None, 
            "balance": 0, 
            "add_ons": []
        })
        
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
        
        # Get room data
        room_doc = rooms_ref.document(room).get()
        if not room_doc.exists:
            return jsonify(success=False, message="Room not found.")
            
        room_data = room_doc.to_dict()
            
        if room_data["status"] != "occupied":
            return jsonify(success=False, message="Room is not occupied.")
        
        if amount <= 0:
            return jsonify(success=False, message="Please provide a valid discount amount.")
        
        # Create discount entry
        discount_entry = {
            "amount": amount,
            "reason": reason,
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "time": datetime.now(IST).strftime("%H:%M")
        }
        
        # Add discount to room's discount array
        if "discounts" not in room_data:
            room_data["discounts"] = []
            
        # Update discounts in room document
        rooms_ref.document(room).update({
            "discounts": firestore.ArrayUnion([discount_entry])
        })
        
        # Adjust balance
        current_balance = room_data["balance"]
        new_balance = current_balance
        
        if current_balance > 0:
            # Only reduce balance if there is an outstanding amount
            new_balance = max(0, current_balance - amount)
            
            # Adjust totals
            totals = get_totals()
            if "balance" in totals:
                totals["balance"] = max(0, totals["balance"] - amount)
                totals_ref.document('current_totals').set(totals)
        else:
            # If balance is already paid or negative (refund due), 
            # create a negative balance (additional refund)
            new_balance = current_balance - amount
        
        # Update room balance
        rooms_ref.document(room).update({
            "balance": new_balance
        })
        
        # Log the discount
        if "discounts" not in logs_ref.document("discounts").get().to_dict():
            logs_ref.document("discounts").set({
                "entries": []
            })
            
        discount_log = {
            "room": room,
            "name": room_data["guest"]["name"],
            "amount": amount,
            "reason": reason,
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "time": datetime.now(IST).strftime("%H:%M")
        }
        
        logs_ref.document("discounts").update({
            "entries": firestore.ArrayUnion([discount_log])
        })
        
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
        
        # Get room data
        old_room_doc = rooms_ref.document(old_room).get()
        new_room_doc = rooms_ref.document(new_room).get()
        
        if not old_room_doc.exists or not new_room_doc.exists:
            return jsonify(success=False, message="One or both rooms do not exist.")
            
        old_room_data = old_room_doc.to_dict()
        new_room_data = new_room_doc.to_dict()
            
        if old_room_data["status"] != "occupied":
            return jsonify(success=False, message="Source room is not occupied.")
            
        if new_room_data["status"] != "vacant":
            return jsonify(success=False, message="Destination room is not vacant.")
        
        # Store guest name before transfer
        guest_name = old_room_data["guest"]["name"]
        
        # Transfer guest data to new room
        rooms_ref.document(new_room).set(old_room_data)
        
        # Clear old room
        rooms_ref.document(old_room).set({
            "status": "vacant", 
            "guest": None, 
            "checkin_time": None, 
            "balance": 0, 
            "add_ons": []
        })
        
        # Create a batch for updating logs
        batch = db.batch()
        
        # Record the room shift event
        shift_log = {
            "room": new_room,
            "name": guest_name,
            "old_room": old_room,
            "time": datetime.now(IST).strftime("%H:%M"),
            "date": datetime.now(IST).strftime("%Y-%m-%d"),
            "note": f"Transferred from Room {old_room} to Room {new_room}"
        }
        
        # Create a room_shifts log if it doesn't exist
        room_shifts_doc = logs_ref.document("room_shifts").get()
        if not room_shifts_doc.exists:
            logs_ref.document("room_shifts").set({
                "entries": [shift_log]
            })
        else:
            logs_ref.document("room_shifts").update({
                "entries": firestore.ArrayUnion([shift_log])
            })
        
        logger.info(f"Guest transferred from Room {old_room} to Room {new_room}")
        
        return jsonify(
            success=True, 
            message=f"Guest transferred from Room {old_room} to Room {new_room} successfully."
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
        expense_type = data_json.get("type", "transaction")  # "transaction" or "report"
        
        if not date or not category or not description or amount <= 0 or not payment_method:
            return jsonify(success=False, message="All fields are required")
        
        # Create expense entry
        expense_entry = {
            "date": date,
            "category": category,
            "description": description,
            "amount": amount,
            "payment_method": payment_method,
            "expense_type": expense_type,
            "time": datetime.now(IST).strftime("%H:%M")
        }
        
        # Add to expenses log
        expenses_doc = logs_ref.document("expenses").get()
        if not expenses_doc.exists:
            logs_ref.document("expenses").set({
                "entries": [expense_entry]
            })
        else:
            logs_ref.document("expenses").update({
                "entries": firestore.ArrayUnion([expense_entry])
            })
        
        # Only transaction expenses affect daily totals
        if expense_type == "transaction":
            # Update totals
            totals = get_totals()
            if "expenses" not in totals:
                totals["expenses"] = 0
                
            totals["expenses"] += amount
            totals_ref.document('current_totals').set(totals)
        
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
        end = datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1)  # Include end date
        
        # Get logs from Firestore
        all_logs = get_all_logs()
        
        # Filter logs by date range
        cash_logs = [log for log in all_logs.get("cash", []) if start <= datetime.strptime(log.get("date", "1970-01-01"), "%Y-%m-%d") < end]
        online_logs = [log for log in all_logs.get("online", []) if start <= datetime.strptime(log.get("date", "1970-01-01"), "%Y-%m-%d") < end]
        add_on_logs = [log for log in all_logs.get("add_ons", []) if start <= datetime.strptime(log.get("date", "1970-01-01"), "%Y-%m-%d") < end]
        refund_logs = [log for log in all_logs.get("refunds", []) if start <= datetime.strptime(log.get("date", "1970-01-01"), "%Y-%m-%d") < end]
        renewal_logs = [log for log in all_logs.get("renewals", []) if start <= datetime.strptime(log.get("date", "1970-01-01"), "%Y-%m-%d") < end]
        
        # Filter expense logs
        expense_logs = all_logs.get("expenses", [])
        filtered_expense_logs = [log for log in expense_logs if start <= datetime.strptime(log.get("date", "1970-01-01"), "%Y-%m-%d") < end]
        
        # Calculate summaries
        cash_total = sum(log["amount"] for log in cash_logs)
        online_total = sum(log["amount"] for log in online_logs)
        addon_total = sum(log["price"] for log in add_on_logs)
        refund_total = sum(log["amount"] for log in refund_logs)
        
        # Calculate expense totals
        transaction_expense_total = sum(log["amount"] for log in filtered_expense_logs if log.get("expense_type") == "transaction")
        report_expense_total = sum(log["amount"] for log in filtered_expense_logs if log.get("expense_type") == "report")
        total_expense = transaction_expense_total + report_expense_total
        
        # Count check-ins during this period
        checkins = 0
        renewals = len(renewal_logs)
        
        # Get all rooms
        rooms_data = get_all_rooms()
        
        # Count check-ins from room data
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
        # Get bookings from Firestore
        bookings_stream = bookings_ref.stream()
        
        # Convert to list for easier frontend handling
        bookings_list = []
        for booking_doc in bookings_stream:
            booking = booking_doc.to_dict()
            booking["booking_id"] = booking_doc.id
            bookings_list.append(booking)
        
        # Sort by check-in date (most recent first)
        bookings_list.sort(key=lambda b: b.get("check_in_date", ""), reverse=True)
        
        return jsonify(success=True, bookings=bookings_list)
    except Exception as e:
        logger.error(f"Error getting bookings: {str(e)}")
        return jsonify(success=False, message=f"Error getting bookings: {str(e)}")

@app.route("/create_booking", methods=["POST"])
def create_booking():
    try:
        booking_data = request.json
        
        # Validate required fields
        required_fields = ["room", "guest_name", "guest_mobile", "check_in_date", "check_out_date", "total_amount"]
        for field in required_fields:
            if field not in booking_data:
                return jsonify(success=False, message=f"Missing required field: {field}")
        
        # Generate a unique booking ID
        booking_id = str(uuid.uuid4())
        
        # Initialize booking structure
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
        
        # Handle partial payment logging if amount is paid
        paid_amount = int(booking_data.get("paid_amount", 0))
        if paid_amount > 0:
            payment_method = booking_data.get("payment_method", "cash")
            
            # Add to payment logs
            payment_log = {
                "booking_id": booking_id,
                "room": booking["room"],
                "name": booking["guest_name"],
                "amount": paid_amount,
                "time": datetime.now(IST).strftime("%H:%M"),
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "type": "booking_advance"
            }
            
            logs_ref.document(payment_method).update({
                "entries": firestore.ArrayUnion([payment_log])
            })
            
            # Add to booking payments log specifically
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
            
            logs_ref.document("booking_payments").update({
                "entries": firestore.ArrayUnion([booking_payment])
            })
            
            # Update totals
            totals = get_totals()
            totals[payment_method] += paid_amount
            totals["advance_bookings"] += paid_amount
            totals_ref.document('current_totals').set(totals)
        
        # Add booking to Firestore
        bookings_ref.document(booking_id).set(booking)
        
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
        
        # Check if booking exists
        booking_doc = bookings_ref.document(booking_id).get()
        if not booking_doc.exists:
            return jsonify(success=False, message="Invalid booking ID")
        
        # Get the existing booking
        booking = booking_doc.to_dict()
        
        # Check if there's a new payment to process
        new_payment_amount = int(booking_data.get("new_payment", 0))
        if new_payment_amount > 0:
            payment_method = booking_data.get("payment_method", "cash")
            
            # Add to payment logs
            payment_log = {
                "booking_id": booking_id,
                "room": booking["room"],
                "name": booking["guest_name"],
                "amount": new_payment_amount,
                "time": datetime.now(IST).strftime("%H:%M"),
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "type": "booking_payment"
            }
            
            logs_ref.document(payment_method).update({
                "entries": firestore.ArrayUnion([payment_log])
            })
            
            # Add to booking payments log specifically
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
            
            logs_ref.document("booking_payments").update({
                "entries": firestore.ArrayUnion([booking_payment])
            })
            
            # Update totals
            totals = get_totals()
            totals[payment_method] += new_payment_amount
            totals["advance_bookings"] += new_payment_amount
            totals_ref.document('current_totals').set(totals)
            
            # Update booking paid amount and balance
            booking["paid_amount"] += new_payment_amount
            booking["balance"] = booking["total_amount"] - booking["paid_amount"]
        
        # Update fields that can be modified
        updatable_fields = [
            "guest_name", "guest_mobile", "check_in_date", "check_out_date", 
            "room", "notes", "guest_count", "total_amount", "status"
        ]
        
        for field in updatable_fields:
            if field in booking_data:
                booking[field] = booking_data[field]
        
        # Recalculate balance if total amount was updated
        if "total_amount" in booking_data:
            booking["total_amount"] = int(booking_data["total_amount"])
            booking["balance"] = booking["total_amount"] - booking["paid_amount"]
            
        # Save updated booking
        bookings_ref.document(booking_id).set(booking)
        
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
        
        # Check if booking exists
        booking_doc = bookings_ref.document(booking_id).get()
        if not booking_doc.exists:
            return jsonify(success=False, message="Invalid booking ID")
        
        # Get the booking
        booking = booking_doc.to_dict()
        
        # Process refund if requested
        refund_amount = int(booking_data.get("refund_amount", 0))
        if refund_amount > 0:
            refund_method = booking_data.get("refund_method", "cash")
            
            # Log the refund
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
            
            logs_ref.document("refunds").update({
                "entries": firestore.ArrayUnion([refund_log])
            })
            
            # Update total refunds
            totals = get_totals()
            totals["refunds"] += refund_amount
            totals_ref.document('current_totals').set(totals)
            
            # Update booking paid amount and balance
            booking["paid_amount"] -= refund_amount
            booking["balance"] = booking["total_amount"] - booking["paid_amount"]
        
        # Update booking status
        booking["status"] = "cancelled"
        booking["cancellation_date"] = datetime.now(IST).strftime("%Y-%m-%d")
        booking["cancellation_reason"] = booking_data.get("reason", "")
        
        # Save updated booking
        bookings_ref.document(booking_id).set(booking)
        
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
        
        # Check if booking exists
        booking_doc = bookings_ref.document(booking_id).get()
        if not booking_doc.exists:
            return jsonify(success=False, message="Invalid booking ID")
        
        # Get the booking
        booking = booking_doc.to_dict()
        
        # Check if the room is currently vacant
        room_number = booking["room"]
        room_doc = rooms_ref.document(room_number).get()
        
        if not room_doc.exists:
            return jsonify(success=False, message=f"Room {room_number} not found")
            
        room_data = room_doc.to_dict()
        
        if room_data["status"] != "vacant":
            return jsonify(success=False, message=f"Room {room_number} is not vacant")
        
        # Process remaining payment if provided
        remaining_payment = int(booking_data.get("remaining_payment", 0))
        payment_method = booking_data.get("payment_method", "cash")
        balance_after_payment = booking["balance"] - remaining_payment
        
        # Get totals
        totals = get_totals()
        
        if remaining_payment > 0:
            # Add payment to logs
            payment_log = {
                "booking_id": booking_id,
                "room": booking["room"],
                "name": booking["guest_name"],
                "amount": remaining_payment,
                "time": datetime.now(IST).strftime("%H:%M"),
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "type": "booking_final_payment"
            }
            
            logs_ref.document(payment_method).update({
                "entries": firestore.ArrayUnion([payment_log])
            })
            
            # Add to booking payments log
            booking_payment = {
                "booking_id": booking_id,
                "room": booking["room"],
                "name": booking["guest_name"],
                "amount": remaining_payment,
                "payment_method": payment_method,
                "time": datetime.now(IST).strftime("%H:%M"),
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "type": "final_payment"
            }
            
            logs_ref.document("booking_payments").update({
                "entries": firestore.ArrayUnion([booking_payment])
            })
            
            # Update totals
            totals[payment_method] += remaining_payment
        
        # Create guest object for check-in
        guest = {
            "name": booking["guest_name"],
            "mobile": booking["guest_mobile"],
            "price": int(booking_data.get("room_price", booking["total_amount"])),
            "guests": booking["guest_count"],
            "payment": payment_method,
            "balance": balance_after_payment if balance_after_payment > 0 else 0,
            "photo": booking.get("photo_path")
        }
        
        # Update room to occupied
        rooms_ref.document(room_number).update({
            "status": "occupied",
            "guest": guest,
            "checkin_time": datetime.now(IST).strftime("%Y-%m-%d %H:%M"),
            "balance": balance_after_payment if balance_after_payment > 0 else 0,
            "add_ons": [],
            "renewal_count": 0,
            "last_renewal_time": None
        })
        
        # If there's still balance, add to balance log
        if balance_after_payment > 0:
            balance_log = {
                "room": room_number,
                "name": guest["name"],
                "amount": balance_after_payment,
                "date": datetime.now(IST).strftime("%Y-%m-%d"),
                "note": "Remaining balance from booking"
            }
            
            logs_ref.document("balance").update({
                "entries": firestore.ArrayUnion([balance_log])
            })
            
            totals["balance"] += balance_after_payment
        
        # Update totals
        totals_ref.document('current_totals').set(totals)
        
        # Update booking status
        booking["status"] = "checked_in"
        booking["check_in_time"] = datetime.now(IST).strftime("%Y-%m-%d %H:%M")
        bookings_ref.document(booking_id).set(booking)
        
        logger.info(f"Booking {booking_id} converted to check-in for room {room_number}")
        return jsonify(success=True, message=f"Guest checked in to Room {room_number}")
        
    except Exception as e:
        logger.error(f"Error converting booking to check-in: {str(e)}")
        return jsonify(success=False, message=f"Error converting booking to check-in: {str(e)}")

@app.route("/check_availability", methods=["POST"])
def check_availability():
    try:
        request_data = request.json
        check_in_date = request_data.get("check_in_date")
        check_out_date = request_data.get("check_out_date")
        
        if not check_in_date or not check_out_date:
            return jsonify(success=False, message="Check-in and check-out dates are required")
        
        # Parse dates
        try:
            check_in = datetime.strptime(check_in_date, "%Y-%m-%d")
            check_out = datetime.strptime(check_out_date, "%Y-%m-%d")
        except ValueError:
            return jsonify(success=False, message="Invalid date format. Use YYYY-MM-DD")
        
        # Get all bookings from Firestore
        bookings_stream = bookings_ref.stream()
        booked_rooms = set()
        
        for booking_doc in bookings_stream:
            booking = booking_doc.to_dict()
            
            # Skip cancelled bookings
            if booking.get("status") == "cancelled":
                continue
                
            # Skip checked-in bookings
            if booking.get("status") == "checked_in":
                continue
                
            # Parse booking dates
            booking_check_in = datetime.strptime(booking["check_in_date"], "%Y-%m-%d")
            booking_check_out = datetime.strptime(booking["check_out_date"], "%Y-%m-%d")
            
            # Check if there's any overlap in the date ranges
            if (check_in < booking_check_out and check_out > booking_check_in):
                booked_rooms.add(booking["room"])
        
        # For current occupancy, ONLY exclude rooms if check-in date is TODAY
        today = datetime.now(IST).replace(hour=0, minute=0, second=0, microsecond=0)
        
        if check_in.date() == today.date():
            # Get all rooms from Firestore
            rooms_stream = rooms_ref.stream()
            
            for room_doc in rooms_stream:
                room_data = room_doc.to_dict()
                if room_data["status"] == "occupied":
                    booked_rooms.add(room_doc.id)
        
        # Get all room numbers from Firestore
        all_rooms_stream = rooms_ref.stream()
        all_rooms = [room_doc.id for room_doc in all_rooms_stream]
        
        # Compile available rooms (all rooms except those already booked for the requested dates)
        available_rooms = [room for room in all_rooms if room not in booked_rooms]
        
        # Sort room numbers
        available_rooms.sort(key=lambda r: (int(r) if r.isdigit() else float('inf'), r))
        
        return jsonify(success=True, available_rooms=available_rooms)
        
    except Exception as e:
        logger.error(f"Error checking availability: {str(e)}")
        return jsonify(success=False, message=f"Error checking availability: {str(e)}")


@app.route("/login")
def login():
    return render_template("login.html")

@app.route("/logout")
def logout():
    return render_template("login.html", message="You have been logged out")

# Protect routes requiring authentication
@app.before_request
def check_auth():
    # Skip auth check for these routes
    public_routes = ['/login', '/static', '/favicon.ico']
    
    for route in public_routes:
        if request.path.startswith(route):
            return None  # Continue to the route handler
    
    # For all other routes, check if an ID token is provided
    id_token = request.cookies.get('firebase_id_token')
    
    if not id_token:
        return redirect('/login')
        
    # In a real app, you'd verify the ID token with Firebase here
    # This is simplified for the example
    
    return None  # Continue to the route handler


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host='0.0.0.0', port=port)