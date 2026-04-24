"""
Laundry Management Routes
Tracks daily items sent to / received from the laundry guy,
stores monthly bills, and records payments as expenses.
"""

from flask import Blueprint, request, jsonify
from datetime import datetime, timezone
import pytz
import logging
from google.cloud.firestore_v1.base_query import FieldFilter

from config import db, IST

logger = logging.getLogger(__name__)

laundry_bp = Blueprint("laundry", __name__)

# ── Firestore refs ────────────────────────────────────────────────────────────
_laundry_daily_ref   = lambda: db.collection("laundry_daily")
_laundry_bills_ref   = lambda: db.collection("laundry_bills")
_laundry_settings_ref = lambda: db.collection("settings").document("laundry_prices")

# ── Item keys (order matters — must match frontend) ───────────────────────────
ITEM_KEYS = ["single", "double", "pillow", "towel",
             "single_rug", "double_rug", "mat", "curtain"]

DEFAULT_PRICES = {k: 100 for k in ITEM_KEYS}


# ─────────────────────────────────────────────────────────────────────────────
# SETTINGS — prices per piece
# ─────────────────────────────────────────────────────────────────────────────

@laundry_bp.route("/laundry/settings", methods=["GET"])
def get_laundry_settings():
    try:
        doc = _laundry_settings_ref().get()
        if doc.exists:
            data = doc.to_dict()
            prices = data.get("prices", DEFAULT_PRICES)
        else:
            prices = DEFAULT_PRICES
        return jsonify(success=True, prices=prices)
    except Exception as e:
        logger.error(f"get_laundry_settings error: {e}")
        return jsonify(success=False, message=str(e)), 500


@laundry_bp.route("/laundry/settings", methods=["POST"])
def save_laundry_settings():
    try:
        data = request.json or {}
        prices = {}
        for k in ITEM_KEYS:
            try:
                prices[k] = int(data.get(k, DEFAULT_PRICES[k]))
            except (ValueError, TypeError):
                prices[k] = DEFAULT_PRICES[k]

        _laundry_settings_ref().set({
            "prices": prices,
            "updated_at": datetime.now(IST).isoformat()
        })
        return jsonify(success=True, message="Prices saved")
    except Exception as e:
        logger.error(f"save_laundry_settings error: {e}")
        return jsonify(success=False, message=str(e)), 500


# ─────────────────────────────────────────────────────────────────────────────
# DAILY — send items to laundry guy
# ─────────────────────────────────────────────────────────────────────────────

@laundry_bp.route("/laundry/send", methods=["POST"])
def send_laundry():
    """Upsert daily entry by date — one doc per date."""
    try:
        data = request.json or {}
        date = data.get("date", datetime.now(IST).strftime("%Y-%m-%d"))

        items = {}
        total = 0
        for k in ITEM_KEYS:
            qty = int(data.get(k, 0))
            items[k] = qty
            total += qty

        if total == 0:
            return jsonify(success=False, message="Add at least one item before sending"), 400

        # Check if a doc already exists for this date
        existing = list(
            _laundry_daily_ref()
            .where(filter=FieldFilter("date", "==", date))
            .limit(1)
            .stream()
        )

        if existing:
            # Update existing doc
            existing[0].reference.update({
                **items,
                "total":      total,
                "updated_at": datetime.now(IST).isoformat(),
            })
            doc_id = existing[0].id
        else:
            # Create new doc
            doc = {
                **items,
                "total":       total,
                "date":        date,
                "status":      "sent",
                "sent_at":     datetime.now(IST).isoformat(),
                "received_at": None,
            }
            ref = _laundry_daily_ref().document()
            ref.set(doc)
            doc_id = ref.id

        return jsonify(success=True, message="Saved", doc_id=doc_id)
    except Exception as e:
        logger.error(f"send_laundry error: {e}")
        return jsonify(success=False, message=str(e)), 500


@laundry_bp.route("/laundry/update/<doc_id>", methods=["POST"])
def update_laundry(doc_id):
    """Edit an existing daily entry (password verified client-side)."""
    try:
        data = request.json or {}
        items = {}
        total = 0
        for k in ITEM_KEYS:
            qty = int(data.get(k, 0))
            items[k] = qty
            total += qty

        _laundry_daily_ref().document(doc_id).update({
            **items,
            "total":      total,
            "updated_at": datetime.now(IST).isoformat(),
        })
        return jsonify(success=True, message="Updated")
    except Exception as e:
        logger.error(f"update_laundry error: {e}")
        return jsonify(success=False, message=str(e)), 500


# ─────────────────────────────────────────────────────────────────────────────
# LOGS — all daily entries for a month (for the table view)
# ─────────────────────────────────────────────────────────────────────────────

@laundry_bp.route("/laundry/logs", methods=["GET"])
def get_laundry_logs():
    """
    Returns all daily laundry logs for a given month.
    Query param: month=YYYY-MM  (defaults to current month)
    """
    try:
        month = request.args.get("month", datetime.now(IST).strftime("%Y-%m"))
        start = f"{month}-01"
        year, mon = int(month[:4]), int(month[5:7])
        end = f"{year + 1}-01-01" if mon == 12 else f"{year}-{str(mon + 1).zfill(2)}-01"

        docs = (
            _laundry_daily_ref()
            .where(filter=FieldFilter("date", ">=", start))
            .where(filter=FieldFilter("date", "<",  end))
            .stream()
        )
        results = []
        for d in docs:
            row = d.to_dict()
            row["doc_id"] = d.id
            results.append(row)
        # Sort by date ascending (like the spreadsheet)
        results.sort(key=lambda x: x.get("date", ""))
        return jsonify(success=True, logs=results)
    except Exception as e:
        logger.error(f"get_laundry_logs error: {e}")
        return jsonify(success=False, message=str(e)), 500


# ─────────────────────────────────────────────────────────────────────────────
# PENDING — batches sent but not yet received (kept for backward compat)
# ─────────────────────────────────────────────────────────────────────────────

@laundry_bp.route("/laundry/pending", methods=["GET"])
def get_pending_laundry():
    try:
        docs = (
            _laundry_daily_ref()
            .where(filter=FieldFilter("status", "==", "sent"))
            .stream()
        )
        results = []
        for d in docs:
            row = d.to_dict()
            row["doc_id"] = d.id
            results.append(row)
        results.sort(key=lambda x: x.get("sent_at", ""), reverse=True)
        return jsonify(success=True, pending=results)
    except Exception as e:
        logger.error(f"get_pending_laundry error: {e}")
        return jsonify(success=False, message=str(e)), 500


# ─────────────────────────────────────────────────────────────────────────────
# RECEIVE — mark a batch as received
# ─────────────────────────────────────────────────────────────────────────────

@laundry_bp.route("/laundry/receive/<doc_id>", methods=["POST"])
def receive_laundry(doc_id):
    try:
        ref = _laundry_daily_ref().document(doc_id)
        doc = ref.get()
        if not doc.exists:
            return jsonify(success=False, message="Record not found"), 404

        ref.update({
            "status":      "received",
            "received_at": datetime.now(IST).isoformat(),
        })
        return jsonify(success=True, message="Marked as received")
    except Exception as e:
        logger.error(f"receive_laundry error: {e}")
        return jsonify(success=False, message=str(e)), 500


# ─────────────────────────────────────────────────────────────────────────────
# MONTHLY — get auto-totals from daily logs for a month
# ─────────────────────────────────────────────────────────────────────────────

@laundry_bp.route("/laundry/monthly/<month>", methods=["GET"])
def get_monthly_laundry(month):
    """
    month: YYYY-MM  e.g. 2026-04
    Returns item-wise totals from laundry_daily for that month,
    plus the existing bill record if any.
    """
    try:
        start = f"{month}-01"
        # get last day robustly
        year, mon = int(month[:4]), int(month[5:7])
        if mon == 12:
            end = f"{year + 1}-01-01"
        else:
            end = f"{year}-{str(mon + 1).zfill(2)}-01"

        docs = (
            _laundry_daily_ref()
            .where(filter=FieldFilter("date", ">=", start))
            .where(filter=FieldFilter("date", "<", end))
            .stream()
        )

        totals = {k: 0 for k in ITEM_KEYS}
        daily_rows = []
        for d in docs:
            row = d.to_dict()
            row["doc_id"] = d.id
            daily_rows.append(row)
            for k in ITEM_KEYS:
                totals[k] += int(row.get(k, 0))

        totals["grand"] = sum(totals[k] for k in ITEM_KEYS)

        # existing bill record for this month?
        bill_docs = list(_laundry_bills_ref().where(filter=FieldFilter("month", "==", month)).limit(1).stream())
        bill = None
        if bill_docs:
            bill = bill_docs[0].to_dict()
            bill["doc_id"] = bill_docs[0].id

        return jsonify(success=True, totals=totals, bill=bill, daily_rows=daily_rows)
    except Exception as e:
        logger.error(f"get_monthly_laundry error: {e}")
        return jsonify(success=False, message=str(e)), 500


# ─────────────────────────────────────────────────────────────────────────────
# MONTHLY BILL — save bill + record expense
# ─────────────────────────────────────────────────────────────────────────────

@laundry_bp.route("/laundry/monthly", methods=["POST"])
def save_monthly_bill():
    """
    Saves/updates the monthly laundry bill and records payment as an expense.
    Payload:
      month, bill_date, item_totals{}, prices{},
      bill_amount, old_balance, paid_amount, payment_method,
      expense_type (transaction|report)
    """
    try:
        data = request.json or {}
        month        = data.get("month")
        bill_date    = data.get("bill_date", "")
        bill_amount  = int(data.get("bill_amount", 0))
        old_balance  = int(data.get("old_balance", 0))
        paid_amount  = int(data.get("paid_amount", 0))
        grand_total  = bill_amount + old_balance
        balance      = grand_total - paid_amount
        payment_method = data.get("payment_method", "cash")
        expense_type   = data.get("expense_type", "transaction")   # transaction | report

        if not month:
            return jsonify(success=False, message="Month is required"), 400

        item_totals = {k: int(data.get(f"total_{k}", 0)) for k in ITEM_KEYS}
        prices      = {k: int(data.get(f"price_{k}", 100)) for k in ITEM_KEYS}

        now_ist = datetime.now(IST)

        bill_doc = {
            "month":          month,
            "bill_date":      bill_date,
            **{f"total_{k}": item_totals[k] for k in ITEM_KEYS},
            **{f"price_{k}":  prices[k]     for k in ITEM_KEYS},
            "bill_amount":    bill_amount,
            "old_balance":    old_balance,
            "grand_total":    grand_total,
            "paid_amount":    paid_amount,
            "payment_method": payment_method,
            "expense_type":   expense_type,
            "balance":        balance,
            "updated_at":     now_ist.isoformat(),
        }

        # Upsert bill record
        existing = list(_laundry_bills_ref().where(filter=FieldFilter("month", "==", month)).limit(1).stream())
        if existing:
            _laundry_bills_ref().document(existing[0].id).set(bill_doc)
        else:
            _laundry_bills_ref().document().set(bill_doc)

        # Record as expense (only if paying something)
        if paid_amount > 0:
            month_label = _month_label(month)
            expense_entry = {
                "date":           now_ist.strftime("%Y-%m-%d"),
                "time":           now_ist.strftime("%H:%M"),
                "category":       "laundry",
                "description":    f"Laundry Payment – {month_label}",
                "amount":         paid_amount,
                "payment_method": payment_method,
                "expense_type":   expense_type,
            }
            db.collection("expenses").document().set(expense_entry)

            # Update totals for transaction-type expenses
            if expense_type == "transaction":
                _update_expense_totals(paid_amount, payment_method, now_ist)

        return jsonify(success=True, message="Bill saved", balance=balance)
    except Exception as e:
        logger.error(f"save_monthly_bill error: {e}")
        return jsonify(success=False, message=str(e)), 500


# ─────────────────────────────────────────────────────────────────────────────
# ALL BILLS — history for the monthly bill tab
# ─────────────────────────────────────────────────────────────────────────────

@laundry_bp.route("/laundry/all_bills", methods=["GET"])
def get_all_bills():
    """Returns all monthly bill records sorted by month descending."""
    try:
        docs = _laundry_bills_ref().stream()
        results = []
        for d in docs:
            row = d.to_dict()
            row["doc_id"] = d.id
            results.append(row)
        results.sort(key=lambda x: x.get("month", ""), reverse=True)
        return jsonify(success=True, bills=results)
    except Exception as e:
        logger.error(f"get_all_bills error: {e}")
        return jsonify(success=False, message=str(e)), 500


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _month_label(month_str):
    """'2026-04' → 'April 2026'"""
    try:
        return datetime.strptime(month_str, "%Y-%m").strftime("%B %Y")
    except Exception:
        return month_str


def _update_expense_totals(amount: int, method: str, now_ist):
    """Mirror what billing.py does — increment totals/current_totals for expense."""
    try:
        today = now_ist.strftime("%Y-%m-%d")
        totals_doc = db.collection("totals").document(today)
        snap = totals_doc.get()
        if snap.exists:
            existing = snap.to_dict()
        else:
            existing = {}

        field = "cash_expense" if method == "cash" else "online_expense"
        current_val = int(existing.get(field, 0))
        totals_doc.set({field: current_val + amount}, merge=True)
    except Exception as e:
        logger.warning(f"_update_expense_totals failed (non-fatal): {e}")
