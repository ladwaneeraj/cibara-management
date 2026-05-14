"""
Laundry Management Routes
Tracks daily items sent to / received from the laundry guy,
stores monthly bills, and records payments as expenses.

Payment model
-------------
Each monthly bill doc carries a `payments[]` array — one entry per
partial payment. Totals are derived from the array, never overwritten.

A payment entry:
    {
        "id":           uuid4 hex,
        "amount":       int,
        "method":       "cash" | "online",
        "expense_type": "transaction" | "report",
        "date":         "YYYY-MM-DD",     # IST wall-clock date of the payment
        "time":         "HH:MM",
        "expense_id":   <expenses doc id>,  # so we can delete the matching row
        "created_at":   UTC iso,
    }

Computed (always derived from payments[], never stored as the source of truth):
    paid_total = sum(p.amount for p in payments)
    balance    = grand_total - paid_total

Backward compatibility
----------------------
Bills written before this change have a single `paid_amount` field and no
`payments[]` array. On read, `_with_payment_totals` synthesises one payment
entry from the legacy field so old bills behave the same as new ones —
no data migration needed.
"""

from flask import Blueprint, request, jsonify
from datetime import datetime, timezone
import os as _os
import uuid as _uuid
import pytz
import logging
from google.cloud.firestore_v1.base_query import FieldFilter

from config import db, IST, totals_ref
from services.auth_service import requires_permission, requires_role

logger = logging.getLogger(__name__)

laundry_bp = Blueprint("laundry", __name__)

# -- Firestore refs ----------------------------------------------------------
_laundry_daily_ref    = lambda: db.collection("laundry_daily")
_laundry_bills_ref    = lambda: db.collection("laundry_bills")
_laundry_settings_ref = lambda: db.collection("settings").document("laundry_prices")

# -- Item keys (order matters -- must match frontend) ------------------------
ITEM_KEYS = ["single", "double", "pillow", "towel",
             "single_rug", "double_rug", "mat", "curtain"]

DEFAULT_PRICES = {k: 100 for k in ITEM_KEYS}


def _check_manager_password(provided: str) -> bool:
    """DEPRECATED stub. Auth has moved to RBAC (@requires_permission)."""
    logger.warning("laundry._check_manager_password called (deprecated) — denying")
    return False


def _month_label(month_str):
    """'2026-04' -> 'April 2026'"""
    try:
        return datetime.strptime(month_str, "%Y-%m").strftime("%B %Y")
    except Exception:
        return month_str


def _fmt_date_short(date_str):
    """'2026-04-29' -> 'Apr 29'  (best-effort, falls back to raw)."""
    try:
        return datetime.strptime(date_str, "%Y-%m-%d").strftime("%b %d")
    except Exception:
        return date_str or ""


def _find_laundry_expense_rows_for_month(month):
    """
    Return all expense docs that belong to a given laundry bill month.
    Each item:
        { id, amount, method, date, time, expense_type, description,
          source: "new" | "legacy" }
    sorted by date+time ascending. Used as the source of truth for the
    payment history shown on the bill.

    Two strategies, deduplicated:
      1. New expense rows have `laundry_bill_month` -- exact lookup.
      2. Legacy rows match on category=laundry + description containing
         the month label ("April 2026").
    """
    if not month:
        return []
    expenses_ref = db.collection("expenses")
    seen_ids = set()
    out = []

    try:
        for d in (
            expenses_ref
            .where(filter=FieldFilter("laundry_bill_month", "==", month))
            .stream()
        ):
            data = d.to_dict() or {}
            if d.id in seen_ids:
                continue
            seen_ids.add(d.id)
            out.append({
                "id":           d.id,
                "amount":       int(data.get("amount") or 0),
                "method":       data.get("payment_method", "cash"),
                "date":         data.get("date", ""),
                "time":         data.get("time", ""),
                "expense_type": data.get("expense_type", "transaction"),
                "description":  data.get("description", ""),
                "source":       "new",
            })
    except Exception as e:
        logger.warning(f"_find_laundry_expense_rows: new-row query failed for "
                       f"month={month}: {e}")

    label = _month_label(month)
    try:
        for d in (
            expenses_ref
            .where(filter=FieldFilter("category", "==", "laundry"))
            .stream()
        ):
            if d.id in seen_ids:
                continue
            data = d.to_dict() or {}
            desc = str(data.get("description") or "")
            if label and label not in desc:
                continue
            seen_ids.add(d.id)
            out.append({
                "id":           d.id,
                "amount":       int(data.get("amount") or 0),
                "method":       data.get("payment_method", "cash"),
                "date":         data.get("date", ""),
                "time":         data.get("time", ""),
                "expense_type": data.get("expense_type", "transaction"),
                "description":  desc,
                "source":       "legacy",
            })
    except Exception as e:
        logger.warning(f"_find_laundry_expense_rows: legacy-row query failed "
                       f"for month={month}: {e}")

    out.sort(key=lambda r: (r.get("date") or "", r.get("time") or ""))
    return out


def _with_payment_totals(bill_dict):
    """
    Attach `payments`, `paid_total`, and `balance` to a bill dict.

    Source of truth is the `expenses` collection. The bill doc holds bill
    amount / items / grand total. Payments are *always* derived by querying
    expense rows that belong to this bill's month -- so the list shown to
    the user is whatever actually moved through the books.

    Legacy fallback: if the month has zero matching expense rows but the
    bill carries a non-zero `paid_amount` from before this fix, we emit
    one synthetic entry so the UI is not silently wrong. This case is
    rare -- it only happens for bills paid before the fix where the
    expense row was manually deleted from Firestore.
    """
    if bill_dict is None:
        return bill_dict

    month = bill_dict.get("month")
    expense_rows = _find_laundry_expense_rows_for_month(month) if month else []

    if expense_rows:
        payments = [{
            "id":           r["id"],
            "amount":       r["amount"],
            "method":       r["method"],
            "expense_type": r["expense_type"],
            "date":         r["date"],
            "time":         r["time"],
            "expense_id":   r["id"],
            "created_at":   r.get("date", "") + " " + r.get("time", ""),
            "source":       r["source"],
        } for r in expense_rows]
    else:
        legacy_paid = int(bill_dict.get("paid_amount") or 0)
        if legacy_paid > 0:
            payments = [{
                "id":           "legacy-" + (month or "x"),
                "amount":       legacy_paid,
                "method":       bill_dict.get("payment_method", "cash"),
                "expense_type": bill_dict.get("expense_type", "transaction"),
                "date":         bill_dict.get("bill_date") or month or "",
                "time":         "",
                "expense_id":   "",
                "created_at":   bill_dict.get("updated_at", ""),
                "legacy":       True,
            }]
        else:
            payments = []

    paid_total  = sum(int(p.get("amount") or 0) for p in payments)
    grand_total = int(bill_dict.get("grand_total")
                      or (int(bill_dict.get("bill_amount") or 0)
                          + int(bill_dict.get("old_balance") or 0)))
    balance     = grand_total - paid_total

    bill_dict["payments"]   = payments
    bill_dict["paid_total"] = paid_total
    bill_dict["balance"]    = balance
    bill_dict["paid_amount"] = paid_total  # legacy mirror
    return bill_dict


# ---------------------------------------------------------------------------
# SETTINGS -- prices per piece
# ---------------------------------------------------------------------------

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
@requires_permission("laundry.price.edit")
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


# ---------------------------------------------------------------------------
# DAILY -- send items to laundry guy
# ---------------------------------------------------------------------------

@laundry_bp.route("/laundry/send", methods=["POST"])
def send_laundry():
    """Upsert daily entry by date -- one doc per date."""
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
            existing[0].reference.update({
                **items,
                "total":      total,
                "updated_at": datetime.now(IST).isoformat(),
            })
            doc_id = existing[0].id
        else:
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


# ---------------------------------------------------------------------------
# LOGS -- all daily entries for a month (table view)
# ---------------------------------------------------------------------------

@laundry_bp.route("/laundry/logs", methods=["GET"])
def get_laundry_logs():
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
        results.sort(key=lambda x: x.get("date", ""))
        return jsonify(success=True, logs=results)
    except Exception as e:
        logger.error(f"get_laundry_logs error: {e}")
        return jsonify(success=False, message=str(e)), 500


# ---------------------------------------------------------------------------
# PENDING -- batches sent but not yet received
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# RECEIVE -- mark a batch as received
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# MONTHLY -- get auto-totals + bill (with normalised payments[])
# ---------------------------------------------------------------------------

@laundry_bp.route("/laundry/monthly/<month>", methods=["GET"])
@requires_role("admin")
def get_monthly_laundry(month):
    """
    month: YYYY-MM
    Returns item-wise totals + the existing bill record (with payments[]
    normalised so the frontend can always rely on the same shape).
    """
    try:
        start = f"{month}-01"
        year, mon = int(month[:4]), int(month[5:7])
        end = f"{year + 1}-01-01" if mon == 12 else f"{year}-{str(mon + 1).zfill(2)}-01"

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

        bill_docs = list(
            _laundry_bills_ref()
            .where(filter=FieldFilter("month", "==", month))
            .limit(1).stream()
        )
        bill = None
        if bill_docs:
            bill = bill_docs[0].to_dict()
            bill["doc_id"] = bill_docs[0].id
            _with_payment_totals(bill)

        return jsonify(success=True, totals=totals, bill=bill, daily_rows=daily_rows)
    except Exception as e:
        logger.error(f"get_monthly_laundry error: {e}")
        return jsonify(success=False, message=str(e)), 500


# ---------------------------------------------------------------------------
# MONTHLY BILL -- save bill totals + APPEND a partial payment
# ---------------------------------------------------------------------------

@laundry_bp.route("/laundry/monthly", methods=["POST"])
@requires_role("admin")
def save_monthly_bill():
    """
    Save / update the monthly laundry bill totals and APPEND a partial
    payment to the bill's payments[] array.

    `paid_amount` in the request body means "amount paid IN THIS
    transaction" -- it is appended, never replaces the running total.
    Pass paid_amount = 0 (or omit) to update bill totals only without
    recording a payment.

    Payload:
      month, bill_date, item_totals{}, prices{},
      bill_amount, old_balance,
      paid_amount,            # amount paying right now
      payment_method,         # "cash" | "online"
      expense_type            # "transaction" | "report"
    """
    try:
        data = request.json or {}
        month        = data.get("month")
        bill_date    = data.get("bill_date", "")
        bill_amount  = int(data.get("bill_amount", 0))
        old_balance  = int(data.get("old_balance", 0))
        new_payment_amount = int(data.get("paid_amount", 0))
        grand_total  = bill_amount + old_balance
        payment_method = data.get("payment_method", "cash")
        expense_type   = data.get("expense_type", "transaction")

        if not month:
            return jsonify(success=False, message="Month is required"), 400

        item_totals = {k: int(data.get(f"total_{k}", 0)) for k in ITEM_KEYS}
        prices      = {k: int(data.get(f"price_{k}", 100)) for k in ITEM_KEYS}

        now_ist = datetime.now(IST)
        now_utc_iso = datetime.now(timezone.utc).isoformat()

        # -- Locate or create the bill doc -----------------------------------
        existing_q = list(
            _laundry_bills_ref()
            .where(filter=FieldFilter("month", "==", month))
            .limit(1).stream()
        )
        if existing_q:
            bill_ref = _laundry_bills_ref().document(existing_q[0].id)
        else:
            bill_ref = _laundry_bills_ref().document()

        # -- Record the partial payment as a fresh expense row ---------------
        # Expenses are the single source of truth for what was paid; the
        # bill doc only stores the WHAT (items, prices, grand total).
        if new_payment_amount > 0:
            month_label = _month_label(month)
            today_str   = now_ist.strftime("%Y-%m-%d")
            time_str    = now_ist.strftime("%H:%M")
            expense_entry = {
                "date":           today_str,
                "time":           time_str,
                "category":       "laundry",
                "description":    f"Laundry Payment - {month_label} (paid {_fmt_date_short(today_str)})",
                "amount":         new_payment_amount,
                "payment_method": payment_method,
                "expense_type":   expense_type,
                "laundry_bill_month": month,
            }
            try:
                db.collection("expenses").document().set(expense_entry)
            except Exception as exp_err:
                logger.error(
                    f"save_monthly_bill: expense write failed for month={month} "
                    f"amount={new_payment_amount}: {exp_err}",
                    exc_info=True,
                )
                return jsonify(
                    success=False,
                    message="Payment could not be recorded -- please try again",
                ), 500

            if expense_type == "transaction":
                _update_expense_totals(new_payment_amount, payment_method, now_ist)

        # -- Compute totals from the live expense rows ----------------------
        rows = _find_laundry_expense_rows_for_month(month)
        paid_total = sum(r["amount"] for r in rows)
        balance    = grand_total - paid_total

        bill_doc = {
            "month":          month,
            "bill_date":      bill_date,
            **{f"total_{k}": item_totals[k] for k in ITEM_KEYS},
            **{f"price_{k}":  prices[k]     for k in ITEM_KEYS},
            "bill_amount":    bill_amount,
            "old_balance":    old_balance,
            "grand_total":    grand_total,
            # `paid_amount` / `balance` here are CACHED projections of the
            # expense rows. Reads always re-derive from expenses, so these
            # cannot drift in a way that matters to the UI -- they are
            # kept only so legacy callers reading the bill doc directly
            # see sane numbers.
            "paid_amount":    paid_total,
            "paid_total":     paid_total,
            "balance":        balance,
            "payment_method": payment_method,
            "expense_type":   expense_type,
            "updated_at":     now_ist.isoformat(),
        }
        bill_ref.set(bill_doc, merge=True)

        return jsonify(
            success=True,
            message=("Payment recorded" if new_payment_amount > 0
                     else "Bill totals saved"),
            balance=balance,
            paid_total=paid_total,
            payment_count=len(rows),
        )
    except Exception as e:
        logger.error(f"save_monthly_bill error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


# ---------------------------------------------------------------------------
# DELETE PARTIAL PAYMENT
# ---------------------------------------------------------------------------

@laundry_bp.route("/laundry/payment/delete", methods=["POST"])
@requires_permission("payment.edit")
def delete_laundry_payment():
    """
    Delete one expense row that belongs to a laundry bill, then refresh
    the bill's cached summary fields from the remaining expense rows.

    `payment_id` here is the EXPENSE doc id (this is what the UI passes
    -- it is the same value as the `id` field on each entry in the
    payments[] list returned by /laundry/monthly).

    Body: { month, payment_id }
    Auth: admin (via @requires_permission).
    """
    try:
        data = request.json or {}
        month      = data.get("month")
        expense_id = data.get("payment_id")

        if not month or not expense_id:
            return jsonify(success=False, message="month and payment_id required"), 400
        # Auth handled by @requires_permission decorator

        # Look up the expense doc so we can reverse the totals correctly.
        exp_doc = db.collection("expenses").document(expense_id).get()
        if not exp_doc.exists:
            return jsonify(success=False, message="Expense entry not found"), 404
        exp_data = exp_doc.to_dict() or {}
        deleted_amount = int(exp_data.get("amount") or 0)
        deleted_method = exp_data.get("payment_method") or "cash"
        deleted_etype  = exp_data.get("expense_type") or "transaction"
        deleted_date   = exp_data.get("date") or datetime.now(IST).strftime("%Y-%m-%d")

        # Sanity: refuse to delete an expense that does not belong to the
        # claimed month -- protects against a UI bug passing the wrong id.
        belongs = (
            exp_data.get("laundry_bill_month") == month
            or _month_label(month) in str(exp_data.get("description") or "")
        )
        if not belongs:
            return jsonify(
                success=False,
                message="That expense entry does not belong to this bill",
            ), 400

        try:
            db.collection("expenses").document(expense_id).delete()
        except Exception as ee:
            logger.error(f"delete_laundry_payment: expense delete failed "
                         f"(id={expense_id}): {ee}")
            return jsonify(success=False, message="Could not delete expense"), 500

        if deleted_etype == "transaction" and deleted_amount > 0:
            try:
                _update_expense_totals(-deleted_amount, deleted_method,
                                       _ist_at_date(deleted_date))
            except Exception as ee:
                logger.warning(f"delete_laundry_payment: totals reversal failed: {ee}")

        # Refresh the bill's cached summary fields (best-effort -- not
        # critical, since reads re-derive from expenses).
        try:
            bill_q = list(
                _laundry_bills_ref()
                .where(filter=FieldFilter("month", "==", month))
                .limit(1).stream()
            )
            if bill_q:
                bill = bill_q[0].to_dict() or {}
                bill_amount = int(bill.get("bill_amount") or 0)
                old_balance = int(bill.get("old_balance") or 0)
                grand_total = bill_amount + old_balance
                rows = _find_laundry_expense_rows_for_month(month)
                paid_total = sum(r["amount"] for r in rows)
                balance    = grand_total - paid_total
                _laundry_bills_ref().document(bill_q[0].id).update({
                    "paid_amount": paid_total,
                    "paid_total":  paid_total,
                    "balance":     balance,
                    "updated_at":  datetime.now(IST).isoformat(),
                })
        except Exception as ee:
            logger.warning(f"delete_laundry_payment: bill refresh failed: {ee}")

        return jsonify(
            success=True,
            message=f"Payment of {deleted_amount} removed",
        )
    except Exception as e:
        logger.error(f"delete_laundry_payment error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


# ---------------------------------------------------------------------------
# ALL BILLS -- history for the monthly bill tab
# ---------------------------------------------------------------------------

@laundry_bp.route("/laundry/all_bills", methods=["GET"])
@requires_role("admin")
def get_all_bills():
    """All monthly bill records, sorted by month desc, with payments[] normalised."""
    try:
        docs = _laundry_bills_ref().stream()
        results = []
        for d in docs:
            row = d.to_dict()
            row["doc_id"] = d.id
            _with_payment_totals(row)
            results.append(row)
        results.sort(key=lambda x: x.get("month", ""), reverse=True)
        return jsonify(success=True, bills=results)
    except Exception as e:
        logger.error(f"get_all_bills error: {e}")
        return jsonify(success=False, message=str(e)), 500


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------

def _ist_at_date(date_str):
    """Return an IST-aware datetime at noon on the given YYYY-MM-DD (or now())."""
    try:
        naive = datetime.strptime(date_str, "%Y-%m-%d").replace(hour=12)
        return IST.localize(naive)
    except Exception:
        return datetime.now(IST)


def _update_expense_totals(amount: int, method: str, now_ist):
    """
    Mirror routes/reports.py::add_expense — increment the canonical
    totals/current_totals counter that the dashboard reads. Pass a
    NEGATIVE `amount` to reverse a previously-recorded expense.

    `method` ("cash" / "online") is currently unused for the totals
    counter (the dashboard aggregates expenses irrespective of method),
    but the parameter is kept on the signature so callers don't need to
    change. If a per-method split is ever needed, add a dedicated field
    name like `cash_expense` / `online_expense` rather than reusing the
    `cash` / `online` field names (which represent gross receipts in
    this collection).
    """
    try:
        from firebase_admin import firestore as _fs
        totals_ref.document("current_totals").set(
            {"expenses": _fs.Increment(amount)},
            merge=True,
        )
    except Exception as e:
        logger.warning(f"_update_expense_totals failed: {e}")
