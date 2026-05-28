"""
Reports & expenses routes.

READ  → expenses collection (primary, via expense_service)
WRITE → expenses collection (primary) + minimal stub in payments (backward-compat)
"""

from flask import Blueprint, request, jsonify
from datetime import datetime, timedelta
from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from config import (
    db, totals_ref, bills_ref, IST, logger,
    invalidate_rooms_and_totals, get_all_rooms,
)
from services import payment_service, expense_service
from services.auth_service import requires_permission

reports_bp = Blueprint('reports', __name__)

# Permission required to edit or delete an existing expense. Admin only
# by default (granted via the wildcard in services/permissions.py).
_EXPENSE_MANAGE_PERM = "expense.manage"


# ---------------------------------------------------------------------------
# Helpers — totals-counter delta for edit / delete.
#
# /add_expense increments totals/current_totals.expenses by `amount` only
# for expense_type == "transaction". So when we edit or delete a doc we
# need to mirror that increment with the right sign so the day-cash
# arithmetic on the home tab stays correct.
# ---------------------------------------------------------------------------

def _totals_delta_for_edit(old: dict, new_amount: int, new_type: str) -> int:
    """
    Calculate the counter delta required when an expense is updated.

    Cases:
      transaction → transaction : delta = new - old
      transaction → report      : delta = -old              (refund counter)
      report      → transaction : delta = +new              (move into counter)
      report      → report      : delta = 0
    """
    old_amt   = int(old.get("amount", 0) or 0)
    old_type  = old.get("expense_type", "transaction")
    was_txn   = (old_type == "transaction")
    will_txn  = (new_type == "transaction")

    if was_txn and will_txn:
        return int(new_amount) - old_amt
    if was_txn and not will_txn:
        return -old_amt
    if not was_txn and will_txn:
        return int(new_amount)
    return 0


def _apply_totals_delta(delta: int) -> None:
    """Increment totals/current_totals.expenses by delta (signed)."""
    if delta == 0:
        return
    try:
        batch = db.batch()
        batch.update(totals_ref.document('current_totals'), {
            "expenses": firestore.Increment(delta),
        })
        batch.commit()
    except Exception as e:
        logger.error(f"_apply_totals_delta({delta}) failed: {e}")


@reports_bp.route("/reports", methods=["POST"])
def get_reports():
    """
    Generate reports for a date range.
    Revenue data reads from payments collection.
    Expense data reads from expenses collection.
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

        # ── Revenue data from payments collection ────────────────────────────
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

        cash_total = sum(p.get("amount", 0) for p in cash_logs)
        online_total = sum(p.get("amount", 0) for p in online_logs)
        addon_total = sum(p.get("amount", 0) for p in add_on_logs)
        refund_total = sum(p.get("amount", 0) for p in refund_logs)

        # ── Expense data from expenses collection ────────────────────────────
        filtered_expense_logs = expense_service.query_expenses_by_date_range(
            start_date, end_date_exclusive
        ) or []

        transaction_expense_total = sum(
            p.get("amount", 0) for p in filtered_expense_logs
            if p.get("expense_type") == "transaction"
        )
        report_expense_total = sum(
            p.get("amount", 0) for p in filtered_expense_logs
            if p.get("expense_type") == "report"
        )
        total_expense = transaction_expense_total + report_expense_total

        # ── Checkins count ───────────────────────────────────────────────────
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
    """
    Add an expense.

    Primary write  → expenses collection (via expense_service)
    Secondary stub → payments collection (backward-compat for tally during transition)
    totals/current_totals is incremented only for transaction-type expenses.
    """
    try:
        data_json = request.json
        date = data_json.get("date")
        category = data_json.get("category")
        description = data_json.get("description")
        amount = int(data_json.get("amount", 0))
        payment_method = data_json.get("payment_method", "cash")
        expense_type = data_json.get("type", "transaction")   # transaction | report

        if not date or not category or not description or amount <= 0 or not payment_method:
            return jsonify(success=False, message="All fields are required")

        time_str = datetime.now(IST).strftime("%H:%M")

        # ── Build expense document ───────────────────────────────────────────
        expense_entry = {
            "date":           date,
            "time":           time_str,
            "category":       category,
            "description":    description,
            "amount":         amount,
            "payment_method": payment_method,
            "expense_type":   expense_type,
        }

        # Salary: capture paid_to
        if category == "salary":
            expense_entry["paid_to"] = data_json.get("paid_to", "")

        # Tier 2 — Bill without GST: capture invoice number + invoice date
        has_bill = data_json.get("has_bill", False)
        if has_bill:
            expense_entry["has_bill"]       = True
            expense_entry["invoice_number"] = data_json.get("invoice_number", "")
            expense_entry["invoice_date"]   = data_json.get("invoice_date", "")

        # Tier 3 — GST Bill: capture vendor + GST breakdown
        has_gst = data_json.get("has_gst", False)
        if has_gst:
            expense_entry["has_gst"]        = True
            expense_entry["vendor_name"]    = data_json.get("vendor_name", "")
            expense_entry["vendor_gstin"]   = data_json.get("vendor_gstin", "")
            expense_entry["taxable_amount"] = float(data_json.get("taxable_amount", 0))
            expense_entry["gst_rate"]       = float(data_json.get("gst_rate", 0))
            expense_entry["gst_amount"]     = float(data_json.get("gst_amount", 0))

        # Invoice photo URL (uploaded separately via /upload_expense_invoice)
        invoice_photo_url = data_json.get("invoice_photo_url", "")
        if invoice_photo_url:
            expense_entry["invoice_photo_url"] = invoice_photo_url

        # Booking.com commission fields
        commission_fields = {}
        if category == "booking_commission":
            commission_fields = {
                "commission_platform":       data_json.get("commission_platform", "booking.com"),
                "commission_amount":         float(data_json.get("commission_amount", 0)),
                "commission_gst":            float(data_json.get("commission_gst", 0)),
                "commission_invoice_number": data_json.get("commission_invoice_number", ""),
                "commission_invoice_date":   data_json.get("commission_invoice_date", ""),
                "commission_payment_status": data_json.get("commission_payment_status", "pending"),
                "commission_payment_date":   data_json.get("commission_payment_date", ""),
            }
            expense_entry.update(commission_fields)

        # ── Primary write → expenses collection (sync so doc exists before counter) ──
        expense_service.write_expense(expense_entry, sync=True)

        # ── Update totals counter for transaction expenses ───────────────────
        # Done AFTER the expense doc is confirmed written (sync=True above),
        # so the counter never gets ahead of the actual data.
        if expense_type == "transaction":
            batch = db.batch()
            batch.update(totals_ref.document('current_totals'), {
                "expenses": firestore.Increment(amount),
            })
            batch.commit()

        invalidate_rooms_and_totals()

        logger.info(f"Expense added: {description}, Category: {category}, Amount: ₹{amount}")
        return jsonify(success=True, message=f"Expense of ₹{amount} added successfully")

    except Exception as e:
        logger.error(f"Error adding expense: {str(e)}")
        return jsonify(success=False, message=f"Error adding expense: {str(e)}")


@reports_bp.route("/update_expense_photo", methods=["PATCH"])
def update_expense_photo():
    """
    Attach or replace invoice_photo_url on an existing expense document.
    Called from the transaction tab when staff adds a photo after the fact.
    Body: { "doc_id": "<firestore doc id>", "invoice_photo_url": "<url>" }
    """
    try:
        data_json = request.json
        doc_id    = data_json.get("doc_id", "").strip()
        photo_url = data_json.get("invoice_photo_url", "").strip()

        if not doc_id:
            return jsonify(success=False, message="doc_id is required")
        if not photo_url:
            return jsonify(success=False, message="invoice_photo_url is required")

        ok = expense_service.update_photo(doc_id, photo_url)
        if ok:
            logger.info(f"Expense {doc_id} photo updated via transaction tab")
            return jsonify(success=True, message="Invoice photo attached")
        else:
            return jsonify(success=False, message="Failed to update expense")

    except Exception as e:
        logger.error(f"Error updating expense photo: {str(e)}")
        return jsonify(success=False, message=f"Error: {str(e)}")


# ---------------------------------------------------------------------------
# Admin-only edit / delete of an existing expense.
# ---------------------------------------------------------------------------
# Fields the admin is allowed to mutate on an existing expense. Anything
# not in this set is silently ignored. Locking the list down keeps the
# audit story straightforward — server-generated fields (date stamps,
# doc_id) cannot be rewritten by a client request.
_EDITABLE_FIELDS = frozenset({
    "date", "category", "description", "amount", "payment_method",
    "expense_type", "paid_to",
    "has_bill", "invoice_number", "invoice_date",
    "has_gst", "vendor_name", "vendor_gstin",
    "taxable_amount", "gst_rate", "gst_amount",
    "invoice_photo_url",
    # Booking-commission specific
    "commission_platform", "commission_amount", "commission_gst",
    "commission_invoice_number", "commission_invoice_date",
    "commission_payment_status", "commission_payment_date",
})


@reports_bp.route("/expense/<doc_id>", methods=["PATCH"])
@requires_permission(_EXPENSE_MANAGE_PERM)
def edit_expense(doc_id):
    """
    Update an existing expense document. Admin-only.

    The route adjusts totals/current_totals.expenses by the signed delta
    so the home-tab cash arithmetic remains consistent after an edit.
    """
    try:
        if not doc_id:
            return jsonify(success=False, message="doc_id is required"), 400

        body = request.get_json(silent=True) or {}
        # Restrict to the whitelisted field set
        fields = {k: v for k, v in body.items() if k in _EDITABLE_FIELDS}
        if not fields:
            return jsonify(success=False, message="No editable fields supplied"), 400

        old = expense_service.get_expense(doc_id)
        if not old:
            return jsonify(success=False, message="Expense not found"), 404

        # Validate amount if it was supplied
        if "amount" in fields:
            try:
                amt = int(fields["amount"])
            except (TypeError, ValueError):
                return jsonify(success=False, message="Invalid amount"), 400
            if amt <= 0:
                return jsonify(success=False, message="Amount must be positive"), 400
            fields["amount"] = amt

        # Sanity-check expense_type if supplied
        if "expense_type" in fields and fields["expense_type"] not in ("transaction", "report"):
            return jsonify(success=False, message="Invalid expense_type"), 400

        # Compute totals delta BEFORE writing so we always have the old amount
        new_amount = int(fields.get("amount", old.get("amount", 0) or 0))
        new_type   = fields.get("expense_type", old.get("expense_type", "transaction"))
        delta      = _totals_delta_for_edit(old, new_amount, new_type)

        # ── Conditional-field reconciliation ────────────────────────────────
        # When admin unchecks "Has bill" or "Has GST", or changes category
        # away from salary / booking_commission, the fields that no longer
        # apply must be cleared in the document — otherwise stale values
        # carry forward and show up in reports, search results, and the
        # edit form on the next open.
        #
        # We resolve the FINAL state of the document (= the patch on top of
        # the old doc) and then explicitly blank out any sub-field that
        # doesn't belong in that state. The result is a single consistent
        # write, regardless of what the client did or didn't send.
        new_has_bill = fields.get("has_bill", old.get("has_bill", False))
        new_has_gst  = fields.get("has_gst",  old.get("has_gst",  False))
        new_category = fields.get("category", old.get("category", ""))

        if not new_has_bill:
            for f in ("invoice_number", "invoice_date"):
                fields[f] = ""
            # has_bill itself must be present in the write so the doc's
            # boolean flips even if it was set to True before.
            fields["has_bill"] = False

        if not new_has_gst:
            for f in ("vendor_name", "vendor_gstin"):
                fields[f] = ""
            for f in ("taxable_amount", "gst_amount", "gst_rate"):
                fields[f] = 0
            fields["has_gst"] = False

        if new_category != "salary":
            fields["paid_to"] = ""

        if new_category != "booking_commission":
            for f in (
                "commission_platform", "commission_invoice_number",
                "commission_invoice_date", "commission_payment_status",
                "commission_payment_date",
            ):
                fields[f] = ""
            for f in ("commission_amount", "commission_gst"):
                fields[f] = 0

        ok = expense_service.update_expense(doc_id, fields)
        if not ok:
            return jsonify(success=False, message="Update failed"), 500

        # Counter adjustment only matters if delta != 0; helper short-circuits.
        _apply_totals_delta(delta)

        invalidate_rooms_and_totals()
        logger.info(
            "Expense edited: id=%s delta=%s old_amt=%s new_amt=%s "
            "old_type=%s new_type=%s",
            doc_id, delta, old.get("amount"), new_amount,
            old.get("expense_type"), new_type,
        )
        return jsonify(success=True, message="Expense updated")

    except Exception as e:
        logger.error(f"edit_expense failed: {e}")
        return jsonify(success=False, message=f"Error: {str(e)}"), 500


@reports_bp.route("/expense/<doc_id>", methods=["DELETE"])
@requires_permission(_EXPENSE_MANAGE_PERM)
def delete_expense_route(doc_id):
    """
    Hard-delete an expense document. Admin-only.

    Decrements totals/current_totals.expenses by the deleted amount
    iff the doc was expense_type == "transaction" — matching the add
    path so the counter stays consistent.
    """
    try:
        if not doc_id:
            return jsonify(success=False, message="doc_id is required"), 400

        old = expense_service.get_expense(doc_id)
        if not old:
            return jsonify(success=False, message="Expense not found"), 404

        ok = expense_service.delete_expense(doc_id)
        if not ok:
            return jsonify(success=False, message="Delete failed"), 500

        if old.get("expense_type") == "transaction":
            _apply_totals_delta(-int(old.get("amount", 0) or 0))

        invalidate_rooms_and_totals()
        logger.info(
            "Expense deleted: id=%s amount=%s type=%s",
            doc_id, old.get("amount"), old.get("expense_type"),
        )
        return jsonify(success=True, message="Expense deleted")

    except Exception as e:
        logger.error(f"delete_expense failed: {e}")
        return jsonify(success=False, message=f"Error: {str(e)}"), 500


@reports_bp.route("/upload_expense_invoice", methods=["POST"])
def upload_expense_invoice():
    """
    Upload an invoice photo/PDF to Firebase Storage and return the download URL.
    Called from the frontend before submitting the expense form.
    """
    try:
        from config import bucket
        import uuid as _uuid

        if "file" not in request.files:
            return jsonify(success=False, message="No file provided")

        file = request.files["file"]
        if not file.filename:
            return jsonify(success=False, message="Empty filename")

        allowed_extensions = {"jpg", "jpeg", "png", "pdf", "webp"}
        ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
        if ext not in allowed_extensions:
            return jsonify(success=False, message="Only JPG, PNG, PDF, WEBP allowed")

        unique_name = f"{_uuid.uuid4().hex[:12]}.{ext}"
        storage_path = f"expense_invoices/{unique_name}"

        blob = bucket.blob(storage_path)
        blob.upload_from_file(file, content_type=file.content_type)

        blob.make_public()
        download_url = blob.public_url

        logger.info(f"Expense invoice uploaded: {storage_path}")
        return jsonify(success=True, url=download_url)

    except Exception as e:
        logger.error(f"Error uploading expense invoice: {str(e)}")
        return jsonify(success=False, message=f"Upload failed: {str(e)}")


@reports_bp.route("/revenue_report", methods=["POST"])
def revenue_report():
    """
    Checkout-basis revenue report.
    Revenue is recognised when the guest checks OUT, not at payment time.
    Reads from: bills collection (checkout_time range).
    Excludes MMT OTA bills (payment_source == 'ota').
    """
    try:
        data_json = request.json
        start_date = data_json.get("start_date")
        end_date   = data_json.get("end_date")

        if not start_date or not end_date:
            return jsonify(success=False, message="start_date and end_date are required")

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
        total_billed = total_room_charges = total_services = 0
        total_discounts = total_cash = total_online = 0
        total_refunds = total_balance_due = invoice_count = 0
        ota_revenue = hotel_revenue = 0

        for doc in bills_q.stream():
            b = doc.to_dict()
            b["id"] = doc.id
            is_ota = (b.get("payment_source") == "ota")
            grand_total        = b.get("total_amount", 0)
            total_billed       += grand_total
            total_room_charges += b.get("room_charges_total", 0)
            total_services     += b.get("services_total", 0)
            total_discounts    += b.get("discounts", 0)
            total_cash         += b.get("payment_cash", 0)
            total_online       += b.get("payment_online", 0)
            total_refunds      += b.get("refunds", 0)
            total_balance_due  += max(b.get("balance", 0), 0)
            if b.get("invoice_generated"):
                invoice_count += 1
            if is_ota:
                ota_revenue   += grand_total
            else:
                hotel_revenue += grand_total
            bills.append(b)

        return jsonify(
            success=True,
            period={"start": start_date, "end": end_date},
            summary={
                "total_bills":        len(bills),
                "total_billed":       total_billed,
                "hotel_revenue":      hotel_revenue,
                "ota_revenue":        ota_revenue,
                "total_room_charges": total_room_charges,
                "total_services":     total_services,
                "total_discounts":    total_discounts,
                "total_cash":         total_cash,
                "total_online":       total_online,
                "total_refunds":      total_refunds,
                "net_collected":      total_cash + total_online- total_refunds,
                # Backward-compat: static/analytics.js still reads
                # `total_balance_due`. Expose both the legacy and the
                # newer `balance_due` / `invoice_count` aliases so any
                # caller that already adopted the rename keeps working.
                "total_balance_due":  total_balance_due,
                "balance_due":        total_balance_due,
                "invoices_issued":    invoice_count,
                "invoice_count":      invoice_count,
            },
            bills=bills,
        )
    except Exception as e:
        logger.error(f"revenue_report error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500

