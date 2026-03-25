"""
Reports & expenses routes.
All reads use payments collection as primary data source.
"""

from flask import Blueprint, request, jsonify
from datetime import datetime, timedelta
from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from config import (
    db, totals_ref, bills_ref, IST, logger,
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


@reports_bp.route("/revenue_report", methods=["POST"])
def revenue_report():
    """
    Checkout-basis revenue report.

    Revenue is recognised when the guest checks OUT, not when payment is
    collected. This is what a CA needs for a proper monthly P&L.

    Reads from: bills collection (checkout_time range).
    Excludes:   MMT OTA bills (payment_source == 'ota') since hotel never
                collects that cash directly.
    """
    try:
        data_json = request.json
        start_date = data_json.get("start_date")
        end_date   = data_json.get("end_date")

        if not start_date or not end_date:
            return jsonify(success=False, message="start_date and end_date are required")

        # Build half-open range [start_date 00:00, end_date+1 00:00)
        start_dt  = datetime.strptime(start_date, "%Y-%m-%d")
        end_dt    = datetime.strptime(end_date,   "%Y-%m-%d") + timedelta(days=1)
        start_str = start_dt.strftime("%Y-%m-%d %H:%M")
        end_str   = end_dt.strftime("%Y-%m-%d %H:%M")

        bills_q = (
            bills_ref
            .where(filter=FieldFilter("checkout_time", ">=", start_str))
            .where(filter=FieldFilter("checkout_time", "<",  end_str))
            .order_by("checkout_time", direction="DESCENDING")
        )

        bills = []
        total_billed        = 0
        total_room_charges  = 0
        total_services      = 0
        total_discounts     = 0
        total_cash          = 0
        total_online        = 0
        total_refunds       = 0
        total_balance_due   = 0
        invoice_count       = 0
        ota_revenue         = 0
        hotel_revenue       = 0

        for doc in bills_q.stream():
            b = doc.to_dict()
            b["id"] = doc.id

            is_ota = (b.get("payment_source") == "ota")

            room_charges = b.get("room_charges_total", 0)
            services     = b.get("services_total", 0)
            discounts    = b.get("discounts", 0)
            grand_total  = b.get("total_amount", 0)
            cash         = b.get("payment_cash", 0)
            online       = b.get("payment_online", 0)
            refunds      = b.get("refunds", 0)
            balance      = b.get("balance", 0)

            total_billed       += grand_total
            total_room_charges += room_charges
            total_services     += services
            total_discounts    += discounts
            total_cash         += cash
            total_online       += online
            total_refunds      += refunds
            total_balance_due  += max(balance, 0)

            if b.get("invoice_generated"):
                invoice_count += 1

            if is_ota:
                ota_revenue   += grand_total
            else:
                hotel_revenue += grand_total

            bills.append(b)

        net_collected = total_cash + total_online - total_refunds

        return jsonify(
            success=True,
            period={"start": start_date, "end": end_date},
            summary={
                "total_bills":        len(bills),
                "total_billed":       total_billed,
                "hotel_revenue":      hotel_revenue,   # cash/UPI collected at hotel
                "ota_revenue":        ota_revenue,     # MMT/Booking.com (settled separately)
                "total_room_charges": total_room_charges,
                "total_services":     total_services,
                "total_discounts":    total_discounts,
                "total_cash":         total_cash,
                "total_online":       total_online,
                "total_refunds":      total_refunds,
                "net_collected":      net_collected,
                "total_balance_due":  total_balance_due,
                "invoices_issued":    invoice_count,
            },
            bills=bills,
        )

    except Exception as e:
        logger.error(f"Error generating revenue report: {str(e)}", exc_info=True)
        return jsonify(success=False, message=f"Error: {str(e)}")
