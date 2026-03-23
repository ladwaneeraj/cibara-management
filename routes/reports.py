"""
Reports & expenses routes.
All reads use payments collection as primary data source.
"""

from flask import Blueprint, request, jsonify
from datetime import datetime, timedelta
from firebase_admin import firestore

from config import (
    db, logs_ref, totals_ref, IST, logger,
    invalidate_rooms_and_totals, get_all_rooms,
)
from services import payment_service

reports_bp = Blueprint('reports', __name__)


@reports_bp.route("/reports", methods=["POST"])
def get_reports():
    """
    Generate reports for a date range.
    Reads from payments collection as primary data source.
    """
    try:
        data_json = request.json
        start_date = data_json.get("start_date")
        end_date = data_json.get("end_date")

        if not start_date or not end_date:
            return jsonify(success=False, message="Start and end dates are required.")

        start = datetime.strptime(start_date, "%Y-%m-%d")
        end = datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1)
        end_date_exclusive = end.strftime("%Y-%m-%d")

        # Read from payments collection
        all_payments = payment_service.query_payments_by_date_range(
            start_date, end_date_exclusive
        ) or []

        _exclude_refunds = ("refund", "checkout_refund", "manual_refund",
                            "booking_cancel_refund")

        cash_logs = [p for p in all_payments if p.get("method") == "cash"
                     and p.get("type") not in _exclude_refunds
                     and p.get("type") not in ("expense", "discount")]
        online_logs = [p for p in all_payments if p.get("method") == "online"
                       and p.get("type") not in _exclude_refunds
                       and p.get("type") not in ("expense", "discount")]
        add_on_logs = [p for p in all_payments if p.get("type") == "addon"]
        refund_logs = [p for p in all_payments if p.get("type") in _exclude_refunds]
        renewal_logs = [p for p in all_payments if p.get("type") == "renewal"]
        filtered_expense_logs = [p for p in all_payments if p.get("type") == "expense"]

        cash_total = sum(p.get("amount", 0) for p in cash_logs)
        online_total = sum(p.get("amount", 0) for p in online_logs)
        addon_total = sum(p.get("amount", 0) for p in add_on_logs)
        refund_total = sum(p.get("amount", 0) for p in refund_logs)

        transaction_expense_total = sum(
            p.get("amount", 0) for p in filtered_expense_logs
            if p.get("expense_type") == "transaction"
        )
        report_expense_total = sum(
            p.get("amount", 0) for p in filtered_expense_logs
            if p.get("expense_type") == "report"
        )
        total_expense = transaction_expense_total + report_expense_total

        checkins = 0
        renewals = len(renewal_logs)

        rooms_data = get_all_rooms()
        for room_info in rooms_data.values():
            if room_info.get("checkin_time"):
                try:
                    checkin_date = datetime.strptime(
                        room_info["checkin_time"].split(" ")[0], "%Y-%m-%d"
                    )
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
            expense_logs=filtered_expense_logs,
        )

    except Exception as e:
        logger.error(f"Error generating report: {str(e)}")
        return jsonify(success=False, message=f"Error generating report: {str(e)}")


@reports_bp.route("/add_expense", methods=["POST"])
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
            "time": datetime.now(IST).strftime("%H:%M"),
        }

        # Store commission-specific fields when category is booking_commission
        if category == "booking_commission":
            commission_fields = {
                "commission_platform": data_json.get("commission_platform", "booking.com"),
                "commission_amount": float(data_json.get("commission_amount", 0)),
                "commission_gst": float(data_json.get("commission_gst", 0)),
                "commission_invoice_number": data_json.get("commission_invoice_number", ""),
                "commission_invoice_date": data_json.get("commission_invoice_date", ""),
                "commission_payment_status": data_json.get("commission_payment_status", "pending"),
                "commission_payment_date": data_json.get("commission_payment_date", ""),
            }
            expense_entry.update(commission_fields)

        expenses_doc = logs_ref.document("expenses").get()
        if not expenses_doc.exists:
            batch.set(logs_ref.document("expenses"), {"entries": [expense_entry]})
        else:
            batch.update(logs_ref.document("expenses"), {
                "entries": firestore.ArrayUnion([expense_entry])
            })

        if expense_type == "transaction":
            batch.update(totals_ref.document('current_totals'), {
                "expenses": firestore.Increment(amount),
            })

        batch.commit()
        invalidate_rooms_and_totals()

        # Dual-write: payments collection (commission fields included for traceability)
        payment_entry = {
            "room": "", "name": description, "amount": amount,
            "method": payment_method, "type": "expense",
            "date": date, "time": datetime.now(IST).strftime("%H:%M"),
            "category": category, "expense_type": expense_type,
            "transaction_type": "expense",
        }
        if category == "booking_commission":
            payment_entry.update(commission_fields)
        payment_service.write_payment(payment_entry)

        logger.info(f"Expense added: {description}, Category: {category}, Amount: ₹{amount}")
        return jsonify(success=True, message=f"Expense of ₹{amount} added successfully")
    except Exception as e:
        logger.error(f"Error adding expense: {str(e)}")
        return jsonify(success=False, message=f"Error adding expense: {str(e)}")
