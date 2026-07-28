"""
Reports & expenses routes.

READ  → expenses collection (primary, via expense_service)
WRITE → expenses collection (primary) + minimal stub in payments (backward-compat)
"""

import os
import uuid
from flask import Blueprint, request, jsonify
from datetime import datetime, timedelta
from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from config import (
    db, totals_ref, bills_ref, IST, logger,
    invalidate_rooms_and_totals, get_all_rooms,
    validate_gstin,
)
from services import payment_service, expense_service, kpi_service
from services.auth_service import requires_permission, load_current_user
from services.permissions import role_has_permission

reports_bp = Blueprint('reports', __name__)

# ── Invoice bill-link security for the GST/ITC report ────────────────────────
# Bills are stored as Firebase Storage URLs with a permanent token (openable by
# anyone with the link). For the GST report we share with an external CA, we
# instead hand out short-lived V4 SIGNED URLs that expire. Google caps V4
# signed-URL lifetime at 7 days, so that's the default (and hard max).
_GST_LINK_EXPIRY_DAYS = max(1, min(int(os.environ.get("GST_LINK_EXPIRY_DAYS", "7") or 7), 7))


def _sign_invoice_url(url: str, expiry_days: int = _GST_LINK_EXPIRY_DAYS) -> str:
    """
    Convert a stored Firebase Storage invoice URL into a short-lived V4 signed
    URL so it can be emailed to a CA and then expire.

    Returns the original url UNCHANGED when it can't or shouldn't be signed:
      • empty, or a legacy local /uploads path (no cloud blob to sign),
      • not a Firebase Storage URL,
      • signing fails (e.g. runtime credentials lack a private key) — the
        report must never break over a link, so we fall back to the token URL
        and log a warning.
    """
    if not url or not url.startswith("https://firebasestorage.googleapis.com"):
        return url
    try:
        import urllib.parse
        from firebase_admin import storage as _storage
        path_encoded = url.split("/o/")[1].split("?")[0]
        blob_path = urllib.parse.unquote(path_encoded)
        blob = _storage.bucket().blob(blob_path)
        return blob.generate_signed_url(
            version="v4",
            expiration=timedelta(days=max(1, min(expiry_days, 7))),
            method="GET",
        )
    except Exception as e:
        logger.warning(f"GST report: could not sign invoice URL ({type(e).__name__}); "
                       f"falling back to token URL: {e}")
        return url

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


# ---------------------------------------------------------------------------
# Split-payment expenses — one expense paid from a mix of money sources.
#
# Architecture: a split is stored as 2-3 linked single-method expense
# documents, NOT one multi-method document. See services/expense_service.py
# for the rationale. The three sources each map to a fully-valid leg:
#     counter_cash -> transaction + cash   (the ONLY leg that moves the counter)
#     home_cash    -> report      + cash
#     account      -> report      + online
# All legs share a `split_group_id`; only the counter-cash leg touches
# totals/current_totals.expenses.
#
# Capability: ADMIN ONLY. Reuses the existing `expense.manage` permission
# (admin wildcard). Enforced server-side below — the frontend gate is only UX.
#
# Bill / GST: a billed or GST invoice CAN be split. The invoice metadata
# describes the single invoice (not the payment), so it is recorded ONCE on a
# designated primary leg — never duplicated — keeping ITC totals correct.
# Account-level categories (rent, booking.com commission) remain ineligible
# because a counter-cash leg has no meaning for them.
# ---------------------------------------------------------------------------

# Categories that are account-level costs, not daily counter-cash operations,
# and therefore cannot be split. Mirrors the list hidden from the "Daily
# Expense" (transaction) category dropdown on the frontend.
_SPLIT_INELIGIBLE_CATEGORIES = frozenset({"rent", "booking_commission"})


def validate_split(total_amount, counter_cash, home_cash, account, *,
                   category=None):
    """
    Pure validation for a split-payment request across the three money
    sources. No I/O — unit-testable.

    Sources:
      counter_cash  paid in cash out of the daily counter  (transaction+cash)
      home_cash     paid in cash from home / personal       (report+cash)
      account       paid from the bank account / online     (report+online)

    Returns (ok, error|None, counter_cash, home_cash, account).

    Invariants:
      • each part is a non-negative integer,
      • at least TWO parts are > 0 (one part alone is a normal single
        payment, not a split),
      • the parts sum to total_amount exactly (integer rupees),
      • category is eligible for splitting.

    Note: a bill / GST invoice CAN be split. The invoice metadata is recorded
    once on a single primary leg (see _build_split_legs) so input-tax-credit
    is never double-counted; that policy lives in the create path, not here.
    """
    try:
        total = int(total_amount)
        cc = int(counter_cash)
        hc = int(home_cash)
        ac = int(account)
    except (TypeError, ValueError):
        return False, "Split amounts must be whole numbers", 0, 0, 0

    if cc < 0 or hc < 0 or ac < 0:
        return False, "Split amounts cannot be negative", 0, 0, 0
    positive = sum(1 for x in (cc, hc, ac) if x > 0)
    if positive < 2:
        return False, ("A split needs a positive amount in at least two of "
                       "counter cash / home cash / account. Use a normal "
                       "single payment otherwise."), 0, 0, 0
    if cc + hc + ac != total:
        return False, (f"Split parts (₹{cc} + ₹{hc} + ₹{ac} = ₹{cc + hc + ac}) "
                       f"must equal the total ₹{total}"), 0, 0, 0
    if category in _SPLIT_INELIGIBLE_CATEGORIES:
        return False, f"'{category}' expenses cannot be split", 0, 0, 0

    return True, None, cc, hc, ac


# The three split sources, each mapped to a fully-valid single-method leg:
#   counter_cash -> transaction + cash   (the ONLY leg that moves the counter)
#   home_cash    -> report      + cash
#   account      -> report      + online
# Tuple order is (split_role, expense_type, payment_method). It also defines
# the priority for which leg becomes the invoice-carrying "primary" leg.
_SPLIT_SOURCES = (
    ("counter_cash", "transaction", "cash"),
    ("home_cash",    "report",      "cash"),
    ("account",      "report",      "online"),
)


def _build_split_legs(base_entry: dict, group_id: str,
                      counter_cash: int, home_cash: int, account: int, total: int,
                      primary_extra: dict | None = None):
    """
    Produce one leg document per NON-ZERO source from a shared base. Each leg
    is a valid single-method expense; per-leg fields (amount, payment_method,
    expense_type, split_role) are set here so a leg can never inherit a
    conflicting value. Returns a list of leg dicts (length 2 or 3).

    primary_extra holds invoice-level metadata (bill number, GST breakdown,
    invoice photo). It describes the ONE invoice — not how it was paid — so it
    is DENORMALISED onto every leg (so the bill/GST/photo display consistently
    wherever a leg is shown), but exactly ONE leg is flagged split_primary=True.
    The GST / ITC report keys off split_primary to count the invoice exactly
    once at its full gross (split_total); see _dedupe_split_groups.
    """
    common_keys = ("date", "time", "category", "description", "paid_to")
    common = {k: base_entry[k] for k in common_keys if k in base_entry}
    split_meta = {"split_group_id": group_id, "split_total": int(total)}
    invoice = dict(primary_extra or {})  # bill / GST / photo — same on each leg

    amounts = {"counter_cash": int(counter_cash),
               "home_cash": int(home_cash),
               "account": int(account)}

    legs = []
    primary_assigned = False
    for role, etype, method in _SPLIT_SOURCES:
        amt = amounts[role]
        if amt <= 0:
            continue
        leg = {
            **common, **invoice, **split_meta,
            "amount": amt,
            "payment_method": method,
            "expense_type": etype,
            "split_role": role,
        }
        if not primary_assigned:
            leg["split_primary"] = True
            primary_assigned = True
        legs.append(leg)
    return legs


def _dedupe_split_groups(expenses: list) -> list:
    """
    Collapse the legs of each split group to ONE representative — the leg
    flagged split_primary (which carries split_total = the full invoice gross)
    — so an invoice's input-tax-credit is counted exactly once. Non-split
    expenses pass through unchanged. Order is preserved.
    """
    from collections import OrderedDict
    singles = []
    groups = OrderedDict()
    for e in expenses:
        gid = e.get("split_group_id")
        if gid:
            groups.setdefault(gid, []).append(e)
        else:
            singles.append(e)
    collapsed = [
        next((l for l in legs if l.get("split_primary")), legs[0])
        for legs in groups.values()
    ]
    return singles + collapsed


def _clean_vendor_gstin(raw, *, gst_amount=0.0, category=""):
    """
    Normalize + validate a vendor GSTIN on an expense (ITC hygiene).

    Returns (gstin, error_message_or_None). Rules:
      * Whitespace stripped, uppercased — operators often type lowercase,
        which is technically invalid (Rule 46 format is uppercase).
      * If non-empty, must pass validate_gstin() — a malformed GSTIN means
        the ITC claim will never match GSTR-2B and will be denied.
      * If a positive GST amount is claimed, the GSTIN is MANDATORY.
        Exception: 'booking_commission' (foreign OTA — import of services
        under RCM; the supplier has no Indian GSTIN).
    """
    gstin = (raw or "").strip().upper()
    if gstin and not validate_gstin(gstin):
        return "", (f"Invalid vendor GSTIN '{gstin}' — must be the 15-character "
                    "GST format (e.g. 29ABCDE1234F1Z5). Correct it, or leave it "
                    "blank if the purchase carries no GST.")
    if (not gstin) and float(gst_amount or 0) > 0 and category != "booking_commission":
        return "", ("Vendor GSTIN is required when claiming GST on an expense — "
                    "an ITC claim without the supplier's GSTIN will not match "
                    "GSTR-2B and will be denied.")
    return gstin, None


def _collect_invoice_extra(data_json: dict, category: str = "") -> dict:
    """
    Pull the invoice-level (bill / GST / photo) fields out of the request so
    they can be stamped onto the split's primary leg. Mirrors the field set
    used by the non-split add_expense path. Empty dict when none apply.
    """
    extra = {}
    if data_json.get("has_bill"):
        extra["has_bill"] = True
        extra["invoice_number"] = data_json.get("invoice_number", "")
        extra["invoice_date"] = data_json.get("invoice_date", "")
    if data_json.get("has_gst"):
        extra["has_gst"] = True
        extra["vendor_name"] = data_json.get("vendor_name", "")
        _gstin, _gerr = _clean_vendor_gstin(
            data_json.get("vendor_gstin", ""),
            gst_amount=data_json.get("gst_amount", 0),
            category=category,
        )
        if _gerr:
            raise ValueError(_gerr)
        extra["vendor_gstin"] = _gstin
        try:
            extra["taxable_amount"] = float(data_json.get("taxable_amount", 0))
            extra["gst_rate"] = float(data_json.get("gst_rate", 0))
            extra["gst_amount"] = float(data_json.get("gst_amount", 0))
        except (TypeError, ValueError):
            extra["taxable_amount"] = 0.0
            extra["gst_rate"] = 0.0
            extra["gst_amount"] = 0.0
    photo = data_json.get("invoice_photo_url", "")
    if photo:
        extra["invoice_photo_url"] = photo
    return extra


def _create_split_expense(data_json: dict, base_entry: dict, total_amount: int):
    """
    Validate + atomically write a split-payment expense (admin only).

    Returns a (json_body, http_status) tuple ready to return from the route.
    Performs a single Firestore batch commit covering every leg document and
    the counter increment, so a split can never be left half-written. Only the
    counter-cash leg moves totals/current_totals.expenses. Any bill/GST invoice
    metadata is recorded once, on the primary leg.
    """
    # ── Admin gate — the real security boundary ──────────────────────────
    user = load_current_user()
    if not user:
        return jsonify(success=False, message="Authentication required"), 401
    if not role_has_permission(user["role"], _EXPENSE_MANAGE_PERM):
        logger.info(
            "split_expense: denied %s (%s) — admin only",
            user.get("userId"), user.get("role"),
        )
        return jsonify(success=False,
                       message="Split payments are admin-only"), 403

    split = data_json.get("split") or {}
    # Guard against a stale cached frontend POSTing the old 2-field shape
    # ({cash_amount, upi_amount}); the keys changed when splits went 3-way.
    if not any(k in split for k in ("counter_cash", "home_cash", "account")):
        return jsonify(
            success=False,
            message="Outdated form. Please hard-refresh the page "
                    "(Ctrl+Shift+R) and try again.",
        ), 400
    ok, err, counter_cash, home_cash, account = validate_split(
        total_amount,
        split.get("counter_cash"),
        split.get("home_cash"),
        split.get("account"),
        category=base_entry.get("category"),
    )
    if not ok:
        logger.info("split rejected (%s): total=%s split=%s category=%s",
                    err, total_amount, split, base_entry.get("category"))
        return jsonify(success=False, message=err), 400

    group_id = uuid.uuid4().hex
    try:
        primary_extra = _collect_invoice_extra(
            data_json, category=base_entry.get("category") or "")
    except ValueError as _ve:
        return jsonify(success=False, message=str(_ve)), 400
    legs = _build_split_legs(
        base_entry, group_id, counter_cash, home_cash, account, total_amount,
        primary_extra=primary_extra,
    )

    refs = [expense_service.new_doc_ref() for _ in legs]
    if any(r is None for r in refs):
        return jsonify(success=False, message="Expense store unavailable"), 503

    try:
        batch = db.batch()
        for ref, leg in zip(refs, legs):
            batch.set(ref, expense_service.normalise(leg))
        # Only the counter-cash leg moves the cash counter.
        if counter_cash > 0:
            batch.update(totals_ref.document("current_totals"), {
                "expenses": firestore.Increment(counter_cash),
            })
        batch.commit()
    except Exception as e:
        logger.error(f"_create_split_expense batch failed: {e}", exc_info=True)
        return jsonify(success=False, message=f"Error saving split: {e}"), 500

    invalidate_rooms_and_totals()
    logger.info(
        "Split expense added: group=%s total=₹%s counter=₹%s home=₹%s account=₹%s by %s",
        group_id, total_amount, counter_cash, home_cash, account, user.get("userId"),
    )
    parts = []
    if counter_cash:
        parts.append(f"₹{counter_cash} counter")
    if home_cash:
        parts.append(f"₹{home_cash} home")
    if account:
        parts.append(f"₹{account} account")
    return jsonify(
        success=True,
        message="Split expense added: " + " + ".join(parts),
        split_group_id=group_id,
    ), 200


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
        # Accept "6600", "6599.69" or numeric — coerce to whole rupees so a
        # fractional GST total never throws or silently truncates oddly.
        amount = int(round(float(data_json.get("amount", 0) or 0)))
        payment_method = data_json.get("payment_method", "cash")
        expense_type = data_json.get("type", "transaction")   # transaction | report

        if not date or not category or not description or amount <= 0 or not payment_method:
            return jsonify(success=False, message="All fields are required")

        time_str = datetime.now(IST).strftime("%H:%M")

        # ── Build expense document ───────────────────────────────────────────
        _actor = load_current_user() or {}
        expense_entry = {
            "date":           date,
            "time":           time_str,
            "category":       category,
            "description":    description,
            "amount":         amount,
            "payment_method": payment_method,
            "expense_type":   expense_type,
            # Audit: who recorded this expense. Set before the split branch
            # below so split legs inherit the same stamp.
            "created_by":     {"userId": _actor.get("userId", "system"),
                               "name": _actor.get("name", "system")},
        }

        # Salary: capture paid_to
        if category == "salary":
            expense_entry["paid_to"] = data_json.get("paid_to", "")

        # ── Split payment (part cash counter / part UPI account) ─────────────
        # Admin-only. Handled entirely by _create_split_expense, which writes
        # two linked leg documents + the counter increment in one atomic
        # batch and returns the HTTP response. We branch here — after the
        # shared base fields (date/time/category/description/paid_to) are set
        # but before the single-doc write — so the split legs inherit the
        # same base without the single-method assumptions below.
        if data_json.get("split"):
            return _create_split_expense(data_json, expense_entry, amount)

        # Tier 2 — Bill without GST: capture invoice number + invoice date
        has_bill = data_json.get("has_bill", False)
        if has_bill:
            expense_entry["has_bill"]       = True
            expense_entry["invoice_number"] = data_json.get("invoice_number", "")
            expense_entry["invoice_date"]   = data_json.get("invoice_date", "")

        # Tier 3 — GST Bill: capture vendor + GST breakdown
        has_gst = data_json.get("has_gst", False)
        if has_gst:
            _gstin, _gerr = _clean_vendor_gstin(
                data_json.get("vendor_gstin", ""),
                gst_amount=data_json.get("gst_amount", 0),
                category=category or "",
            )
            if _gerr:
                return jsonify(success=False, message=_gerr), 400
            expense_entry["has_gst"]        = True
            expense_entry["vendor_name"]    = data_json.get("vendor_name", "")
            expense_entry["vendor_gstin"]   = _gstin
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
        # write_expense(sync=True) returns the new doc ID — echoed back in the
        # response so the client can smooth-insert the row (with working
        # edit/delete buttons) without waiting for a refetch.
        _new_doc_id = expense_service.write_expense(expense_entry, sync=True)

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
        # Echo the stored row (with _doc_id, the key the transaction log's
        # edit/delete handlers match on) for the client's smooth-insert.
        _stored_row = dict(expense_entry)
        _stored_row["_doc_id"] = _new_doc_id if isinstance(_new_doc_id, str) else ""
        return jsonify(success=True,
                       message=f"Expense of ₹{amount} added successfully",
                       expense=_stored_row)

    except Exception as e:
        logger.error(f"Error adding expense: {str(e)}")
        return jsonify(success=False, message=f"Error adding expense: {str(e)}")


@reports_bp.route("/expenses_gst", methods=["POST"])
@requires_permission("data.export")
def expenses_gst():
    """
    Return ONLY the expenses that carry GST within a date range — used by the
    GST workbook's "Expenses (ITC)" sheet so a CA can claim input tax credit.

    Body : { "start_date": "YYYY-MM-DD", "end_date": "YYYY-MM-DD" }  (inclusive)
    Auth : data.export (admin / manager) — enforced server-side via the
           @requires_permission decorator. This is the real security boundary;
           the frontend gate is only cosmetic.

    Each returned expense includes the full GST breakdown (vendor, GSTIN,
    taxable value, rate, tax amount), the invoice metadata, and the public
    invoice photo URL so the sheet can link straight to the bill.
    """
    try:
        data = request.json or {}
        start_date = (data.get("start_date") or "").strip()
        end_date = (data.get("end_date") or "").strip()
        if not start_date or not end_date:
            return jsonify(success=False, message="start_date and end_date are required."), 400

        # Validate the date strings and convert the inclusive end_date into the
        # exclusive upper bound the query expects.
        try:
            datetime.strptime(start_date, "%Y-%m-%d")
            _end_dt = datetime.strptime(end_date, "%Y-%m-%d")
        except ValueError:
            return jsonify(success=False, message="Dates must be YYYY-MM-DD."), 400
        end_exclusive = (_end_dt + timedelta(days=1)).strftime("%Y-%m-%d")

        all_expenses = expense_service.query_expenses_by_date_range(start_date, end_exclusive) or []

        def _carries_gst(e):
            # A GST bill is flagged has_gst; booking.com commission carries GST
            # under commission_gst even when has_gst isn't set. Treat a positive
            # tax amount as authoritative either way.
            if e.get("has_gst") is True:
                return True
            try:
                return (float(e.get("gst_amount", 0) or 0) > 0
                        or float(e.get("commission_gst", 0) or 0) > 0)
            except (TypeError, ValueError):
                return False

        gst_expenses = [e for e in all_expenses if _carries_gst(e)]
        # A split invoice is stored as 2-3 legs, each carrying the SAME GST
        # metadata. Collapse each split group to its primary leg so the CA's
        # ITC sheet lists the invoice once at its full gross (split_total),
        # never 2-3x.
        gst_expenses = _dedupe_split_groups(gst_expenses)
        # Stable, auditable order: by date then time.
        gst_expenses.sort(key=lambda e: (str(e.get("date", "")), str(e.get("time", ""))))

        # Replace each permanent bill URL with a short-lived signed link so the
        # report shared with the CA exposes expiring links, not the permanent
        # public token URLs. Falls back to the original URL if signing isn't
        # available. Mutates only the in-memory response copy, never Firestore.
        for e in gst_expenses:
            if e.get("invoice_photo_url"):
                e["invoice_photo_url"] = _sign_invoice_url(e["invoice_photo_url"])

        return jsonify(
            success=True,
            expenses=gst_expenses,
            count=len(gst_expenses),
            link_expiry_days=_GST_LINK_EXPIRY_DAYS,
        )
    except Exception as e:
        logger.error(f"expenses_gst error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


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

        # Staff-payroll rows are managed from the Staff module only. An
        # inline edit here would desync the linked advance / salary-payment
        # document (and the outstanding-advance arithmetic derived from it).
        if old.get("staff_advance") or old.get("staff_salary_payment"):
            return jsonify(
                success=False,
                message=("This entry is linked to Staff payroll. Manage it "
                         "from the Staff section so the advance/salary "
                         "records stay in sync."),
            ), 409

        # Vendor GSTIN hygiene on edit: normalize + format-check whenever the
        # field is being changed. (The GSTIN-mandatory-with-GST rule is
        # enforced at creation; edits only need to never INTRODUCE a
        # malformed value.)
        if "vendor_gstin" in fields:
            _gstin, _gerr = _clean_vendor_gstin(fields.get("vendor_gstin"))
            if _gerr:
                return jsonify(success=False, message=_gerr), 400
            fields["vendor_gstin"] = _gstin

        # Split legs are immutable inline. Re-splitting an amount or moving
        # money between the cash and UPI legs has subtle counter-arithmetic
        # implications across two documents; rather than risk a drifted
        # counter we require the admin to delete the split (which removes
        # both legs atomically) and re-create it. This keeps the edit path
        # simple and the counter provably correct.
        if old.get("split_group_id"):
            return jsonify(
                success=False,
                message=("This is a split-payment expense. Delete it and "
                         "re-create to change the amounts."),
            ), 409

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

        # Audit: who last edited this expense (creation stamp is preserved —
        # created_by is not in _EDITABLE_FIELDS so it can never be patched).
        _editor = load_current_user() or {}
        fields["updated_by"] = {"userId": _editor.get("userId", "system"),
                                "name": _editor.get("name", "system")}
        fields["updated_at"] = datetime.now(IST).isoformat()

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

        # Staff-payroll rows are managed from the Staff module only —
        # deleting the expense leg here would orphan the linked advance /
        # salary-payment doc and silently corrupt the outstanding-advance
        # balance. The Staff section deletes both sides atomically.
        if old.get("staff_advance") or old.get("staff_salary_payment"):
            return jsonify(
                success=False,
                message=("This entry is linked to Staff payroll. Delete it "
                         "from the Staff section (it removes the payroll "
                         "record and this expense together)."),
            ), 409

        # ── Split-group delete ───────────────────────────────────────────
        # Deleting ANY leg of a split removes the WHOLE group atomically so
        # the two legs can never become orphaned. The counter is reversed by
        # the sum of the transaction (cash) legs only — mirroring how the
        # create path incremented it.
        group_id = old.get("split_group_id")
        if group_id:
            legs = expense_service.query_split_group(group_id)
            if not legs:  # fall through to single delete if the group vanished
                legs = [old]
            cash_reversal = sum(
                int(l.get("amount", 0) or 0)
                for l in legs if l.get("expense_type") == "transaction"
            )
            try:
                batch = db.batch()
                for leg in legs:
                    ref = expense_service.doc_ref(leg.get("_doc_id"))
                    if ref is not None:
                        batch.delete(ref)
                if cash_reversal:
                    batch.update(totals_ref.document("current_totals"), {
                        "expenses": firestore.Increment(-cash_reversal),
                    })
                batch.commit()
            except Exception as e:
                logger.error(f"split delete batch failed: {e}", exc_info=True)
                return jsonify(success=False, message=f"Delete failed: {e}"), 500

            invalidate_rooms_and_totals()
            logger.info(
                "Split expense deleted: group=%s legs=%s cash_reversal=₹%s",
                group_id, len(legs), cash_reversal,
            )
            return jsonify(success=True, message="Split expense deleted")

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

            # ── Exclude non-revenue bills ───────────────────────────────────
            # Cancelled / voided stays, and bills superseded by a checkout
            # revert, retain their checkout_time AND total_amount. Without
            # this guard their GST-inclusive total is added to the revenue
            # (and embedded GST) for their checkout date — and in the revert
            # case it is double-counted alongside the replacement stay that
            # carries the real revenue. gstr1_summary already excludes these;
            # this brings the revenue/billing strip into agreement.
            #
            # We exclude only on EXPLICIT cancellation markers so legacy bills
            # that predate the status field (status missing/empty) are still
            # counted as completed revenue.
            _status = (b.get("status") or "").strip().lower()
            if (_status in ("cancelled", "voided")
                    or b.get("superseded_by_revert")
                    or b.get("cancelled_by_revert")):
                continue

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


@reports_bp.route("/reports/gstr1_summary", methods=["POST"])
def gstr1_summary():
    """
    GSTR-1 outward-supply summary for a filing period (checkout basis).

    Buckets every invoiced bill (invoice_generated == True AND a real
    bill_number) into the GSTR-1 sections the hotel actually files:

        b2b   — recipient has a valid GSTIN (registered customer; e.g. an
                MMT MyBiz corporate booking). Listed per-invoice so the
                values can be keyed into GSTR-1 Table 4A.
        b2cl  — large inter-state B2C invoice (> Rs.1,00,000, non-KA).
        b2cs  — all remaining B2C, summarised by rate + place of supply.

    Also returns:
        rate_summary  — taxable / CGST / SGST / IGST grouped by GST rate,
                        the cross-check used when filing.
        ota_commission_itc — total GST charged by the OTA on commission for
                        the period (input tax credit the hotel can claim;
                        the actual claim happens in GSTR-3B against the OTA's
                        own invoice — this is a reconciliation aid only).
        credit_notes  — Section-34 cancellation / revert documents, listed
                        so output tax reversals are visible.

    Request JSON: {"month": "YYYY-MM"}  OR  {"start_date","end_date"} (YYYY-MM-DD).
    Read-only — never mutates anything.
    """
    try:
        data_json = request.json or {}
        month = (data_json.get("month") or "").strip()
        if month:
            period_start = datetime.strptime(month + "-01", "%Y-%m-%d")
            # First day of next month.
            if period_start.month == 12:
                period_end = period_start.replace(year=period_start.year + 1, month=1)
            else:
                period_end = period_start.replace(month=period_start.month + 1)
            start_date = period_start.strftime("%Y-%m-%d")
            end_date = (period_end - timedelta(days=1)).strftime("%Y-%m-%d")
        else:
            start_date = data_json.get("start_date")
            end_date = data_json.get("end_date")
            if not start_date or not end_date:
                return jsonify(success=False,
                               message="Provide 'month' (YYYY-MM) or start_date/end_date"), 400
            period_start = datetime.strptime(start_date, "%Y-%m-%d")
            period_end = datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1)

        start_str = period_start.strftime("%Y-%m-%d %H:%M")
        end_str = period_end.strftime("%Y-%m-%d %H:%M")

        bills_q = (
            bills_ref
            .where(filter=FieldFilter("checkout_time", ">=", start_str))
            .where(filter=FieldFilter("checkout_time", "<", end_str))
            .order_by("checkout_time")
        )

        b2b, b2cl, credit_notes = [], [], []
        cancelled_documents = []   # every numbered-but-cancelled invoice, zero value
        b2cs = {}          # key: (rate, state_code) -> aggregates
        rate_summary = {}   # key: rate -> aggregates
        hsn_summary = {}    # key: (hsn, rate) -> aggregates (GSTR-1 Table 12)
        ota_commission_itc = 0.0
        ota_commission_count = 0
        totals = {"taxable": 0.0, "cgst": 0.0, "sgst": 0.0, "igst": 0.0,
                  "invoice_value": 0.0, "invoices": 0}

        def _acc(bucket, b, rate, taxable, cgst, sgst, igst, value):
            bucket["taxable"] = bucket.get("taxable", 0.0) + taxable
            bucket["cgst"] = bucket.get("cgst", 0.0) + cgst
            bucket["sgst"] = bucket.get("sgst", 0.0) + sgst
            bucket["igst"] = bucket.get("igst", 0.0) + igst
            bucket["invoice_value"] = bucket.get("invoice_value", 0.0) + value
            bucket["count"] = bucket.get("count", 0) + 1

        def _hsn(hsn, rate, taxable, cgst, sgst, igst):
            if taxable <= 0 and cgst <= 0 and sgst <= 0 and igst <= 0:
                return
            k = f"{hsn}|{rate}"
            h = hsn_summary.setdefault(k, {"hsn": hsn, "gst_rate": rate})
            h["taxable"] = h.get("taxable", 0.0) + taxable
            h["cgst"] = h.get("cgst", 0.0) + cgst
            h["sgst"] = h.get("sgst", 0.0) + sgst
            h["igst"] = h.get("igst", 0.0) + igst

        def _rate_add(rate, taxable, cgst, sgst, igst):
            """Fold a (rate, tax) line into the period rate_summary."""
            rb = rate_summary.setdefault(rate, {})
            rb["taxable"] = rb.get("taxable", 0.0) + taxable
            rb["cgst"] = rb.get("cgst", 0.0) + cgst
            rb["sgst"] = rb.get("sgst", 0.0) + sgst
            rb["igst"] = rb.get("igst", 0.0) + igst

        def _water_goods(b):
            """
            Water/goods sold at 5% MRP-inclusive (HSN 2201) — the hotel's
            outward supply of GOODS, reported separately from accommodation.
            Returns (taxable, gst, gross). Non-water misc services are treated
            as non-taxable here and excluded (matches the bill renderer's
            water-vs-other split).
            """
            gross = 0.0
            for s in (b.get("services") or []):
                if s.get("accommodation_charge"):
                    continue
                if "water" in (s.get("item") or "").lower():
                    gross += float(s.get("price", 0) or 0)
            if gross <= 0:
                return (0.0, 0.0, 0.0)
            taxable = round(gross / 1.05, 2)
            return (taxable, round(gross - taxable, 2), round(gross, 2))

        for doc in bills_q.stream():
            b = doc.to_dict()

            # OTA commission ITC accrues whether or not the room itself is
            # hotel-invoiced — it's the GST MMT charged us on commission.
            cg = float(b.get("ota_commission_gst", 0) or 0)
            if cg:
                ota_commission_itc += cg
                ota_commission_count += 1

            # Only invoiced supplies are reportable in GSTR-1.
            bill_no = b.get("bill_number")
            if not b.get("invoice_generated") or not bill_no or bill_no == "-":
                continue

            # ── Accommodation (SAC 9963) — the primary supply ───────────────
            a_taxable = float(b.get("accommodation_taxable", 0) or 0)
            a_cgst = float(b.get("cgst_amount", 0) or 0)
            a_sgst = float(b.get("sgst_amount", 0) or 0)
            a_igst = float(b.get("igst_amount", 0) or 0)
            value = float(b.get("total_amount", 0) or 0)
            a_rate = int(b.get("gst_rate", 0) or 0)
            inv_type = (b.get("invoice_type") or "B2C").upper()
            state_code = (b.get("recipient_state_code") or "29").strip() or "29"
            is_inter = state_code != "29"

            # ── Goods (water, HSN 2201 @ 5%) — separate outward supply ──────
            # The backend stores water under non_accommodation and does NOT
            # split its GST (it's MRP-inclusive), so we derive it here at 5%
            # and split by the same place of supply. This makes the invoice
            # value reconcile (room + water + GST) and populates HSN Table 12.
            g_taxable, g_gst, _g_gross = _water_goods(b)
            g_rate = 5 if g_taxable > 0 else 0
            g_cgst = g_sgst = g_igst = 0.0
            if g_gst > 0:
                if is_inter:
                    g_igst = g_gst
                else:
                    g_cgst = round(g_gst / 2, 2)
                    g_sgst = round(g_gst - g_cgst, 2)

            # Combined per-invoice taxable + tax (across both supplies).
            taxable = round(a_taxable + g_taxable, 2)
            cgst = round(a_cgst + g_cgst, 2)
            sgst = round(a_sgst + g_sgst, 2)
            igst = round(a_igst + g_igst, 2)

            row = {
                "bill_number": bill_no,
                "invoice_date": (b.get("checkout_time") or "")[:10],
                "recipient_gstin": b.get("recipient_gstin", ""),
                "recipient_name": b.get("recipient_legal_name")
                or b.get("recipient_trade_name") or b.get("guest_name", ""),
                "place_of_supply": f"{b.get('recipient_state', 'Karnataka')} ({state_code})",
                "gst_rate": a_rate,
                "taxable": taxable,
                "cgst": cgst,
                "sgst": sgst,
                "igst": igst,
                "invoice_value": round(value, 2),
                # Per-supply breakdown so multi-rate invoices can be keyed
                # into GSTR-1 line by line.
                "accommodation": {"sac": "9963", "rate": a_rate,
                                  "taxable": round(a_taxable, 2),
                                  "cgst": round(a_cgst, 2), "sgst": round(a_sgst, 2),
                                  "igst": round(a_igst, 2)},
                "goods": {"hsn": "2201", "rate": g_rate,
                          "taxable": g_taxable, "cgst": g_cgst,
                          "sgst": g_sgst, "igst": g_igst} if g_taxable > 0 else None,
                "sac_or_hsn": b.get("sac_or_hsn", "9963"),
                "booking_source": b.get("booking_source", "normal"),
                "is_cancellation_charge": bool(b.get("is_cancellation_charge")),
            }

            # ── Document status (C2) ────────────────────────────────────
            # EVERY numbered invoice of the period appears in the report
            # with an explicit status. Cancelled documents (revert within
            # the 3-hour window, or any cancelled bill that still carries a
            # number) are listed at ZERO value and excluded from totals,
            # the rate/HSN summaries and the B2B/B2CL/B2CS buckets — they
            # carry no output tax, but their numbers must stay visible
            # (they feed GSTR-1 Table 13 "documents cancelled").
            _is_cancelled = bool(
                b.get("cancelled_by_revert")
                or b.get("superseded_by_revert")
                or b.get("status") == "cancelled"
            )
            row["status"] = "CANCELLED" if _is_cancelled else "LIVE"
            if _is_cancelled:
                for _zk in ("taxable", "cgst", "sgst", "igst",
                            "invoice_value", "gst_rate"):
                    row[_zk] = 0
                row["accommodation"] = None
                row["goods"] = None
                cancelled_documents.append(row)
                continue

            totals["taxable"] += taxable
            totals["cgst"] += cgst
            totals["sgst"] += sgst
            totals["igst"] += igst
            totals["invoice_value"] += value
            totals["invoices"] += 1

            # Period rate + HSN summaries — each supply folded at its OWN rate.
            _rate_add(a_rate, a_taxable, a_cgst, a_sgst, a_igst)
            _hsn("9963", a_rate, a_taxable, a_cgst, a_sgst, a_igst)
            if g_taxable > 0:
                _rate_add(g_rate, g_taxable, g_cgst, g_sgst, g_igst)
                _hsn("2201", g_rate, g_taxable, g_cgst, g_sgst, g_igst)

            if inv_type == "B2B":
                b2b.append(row)
            elif inv_type == "B2CL":
                b2cl.append(row)
            else:
                key = f"{a_rate}|{state_code}"
                bucket = b2cs.setdefault(key, {
                    "gst_rate": a_rate, "state_code": state_code,
                    "place_of_supply": row["place_of_supply"],
                })
                _acc(bucket, b, a_rate, taxable, cgst, sgst, igst, value)

        def _round_bucket(d):
            for k in ("taxable", "cgst", "sgst", "igst", "invoice_value"):
                if k in d:
                    d[k] = round(d[k], 2)
            return d

        return jsonify(
            success=True,
            period={"start": start_date, "end": end_date},
            b2b=b2b,
            b2cl=b2cl,
            b2cs=[_round_bucket(v) for v in b2cs.values()],
            credit_notes=credit_notes,
            cancelled_documents=cancelled_documents,
            documents={
                # Table 13 seed: numbered documents in the period.
                "listed":    totals["invoices"] + len(cancelled_documents),
                "cancelled": len(cancelled_documents),
                "net_live":  totals["invoices"],
            },
            rate_summary={str(k): _round_bucket(v) for k, v in rate_summary.items()},
            hsn_summary=[_round_bucket(v) for v in hsn_summary.values()],
            ota_commission_itc=round(ota_commission_itc, 2),
            ota_commission_count=ota_commission_count,
            totals=_round_bucket(totals),
        )
    except Exception as e:
        logger.error(f"gstr1_summary error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500

