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
_laundry_locks_ref    = lambda: db.collection("laundry_locks")


# -- Data locking ------------------------------------------------------------
# laundry_locks/{YYYY-MM}:
#   month_locked  bool                 — whole month frozen
#   locked_dates  ["YYYY-MM-DD", ...]  — individually frozen dates
#   updated_by / updated_at            — last change attribution
#   history       [{action, target, by, at}] — full lock/unlock trail
# A locked date/month rejects /laundry/send and /laundry/update (counts).
# Receiving a batch (/laundry/receive) stays allowed — it only marks the
# batch returned, it never changes the counts a lock protects.

def _laundry_lock_state(month: str) -> dict:
    snap = _laundry_locks_ref().document(month).get()
    d = (snap.to_dict() or {}) if snap.exists else {}
    return {
        "month_locked": bool(d.get("month_locked")),
        "locked_dates": list(d.get("locked_dates") or []),
    }


def _laundry_date_locked(date_str: str) -> bool:
    if not date_str or len(date_str) < 10:
        return False
    st = _laundry_lock_state(date_str[:7])
    return st["month_locked"] or date_str in st["locked_dates"]


def _locked_response(date_str: str):
    return jsonify(
        success=False,
        locked=True,
        message=(f"Laundry data for {date_str} is locked by admin — "
                 f"past entries can't be changed. Ask an admin to unlock "
                 f"the date/month first."),
    ), 423

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


def _find_laundry_expense_rows_for_period(period_key):
    """
    Expense rows belonging to a PERIOD bill — exact lookup on the
    `laundry_bill_period` stamp ("YYYY-MM-DD_YYYY-MM-DD"). Same row shape
    as _find_laundry_expense_rows_for_month.
    """
    if not period_key:
        return []
    out = []
    try:
        for d in (
            db.collection("expenses")
            .where(filter=FieldFilter("laundry_bill_period", "==", period_key))
            .stream()
        ):
            data = d.to_dict() or {}
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
        logger.warning(f"_find_laundry_expense_rows_for_period failed for "
                       f"{period_key}: {e}")
    out.sort(key=lambda r: (r.get("date") or "", r.get("time") or ""))
    return out


def _full_month_bounds(month):
    """(first_day, last_day) of YYYY-MM, or ("", "") if malformed."""
    try:
        import calendar as _cal
        y, m = int(month[:4]), int(month[5:7])
        return f"{month}-01", f"{month}-{str(_cal.monthrange(y, m)[1]).zfill(2)}"
    except (ValueError, TypeError, IndexError):
        return "", ""


def _payment_rows_for_bill(month, period_key, is_full_month):
    """
    The payment rows that belong to one bill.

    Period bills: exact period lookup. Full-month bills: month lookup
    (covers legacy rows) merged with period-stamped rows, deduped —
    payments recorded before AND after the period stamping both appear.
    """
    if period_key and not is_full_month:
        return _find_laundry_expense_rows_for_period(period_key)
    rows = _find_laundry_expense_rows_for_month(month) if month else []
    if period_key:
        seen = {r["id"] for r in rows}
        rows += [r for r in _find_laundry_expense_rows_for_period(period_key)
                 if r["id"] not in seen]
        rows.sort(key=lambda r: (r.get("date") or "", r.get("time") or ""))
    return rows


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

    month      = bill_dict.get("month")
    period_key = bill_dict.get("period_key") or ""
    _fm_start, _fm_end = _full_month_bounds(month or "")
    _is_full_month = (not period_key) or (
        bill_dict.get("period_start") == _fm_start
        and bill_dict.get("period_end") == _fm_end
    )
    expense_rows = _payment_rows_for_bill(month, period_key, _is_full_month)

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

        if _laundry_date_locked(date):
            return _locked_response(date)

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

        # Lock guard — the doc's own date decides (never the request body).
        _snap = _laundry_daily_ref().document(doc_id).get()
        _doc_date = ((_snap.to_dict() or {}).get("date") or "") if _snap.exists else ""
        if _doc_date and _laundry_date_locked(_doc_date):
            return _locked_response(_doc_date)

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
# DATA LOCKS -- admin-only month/date freeze of the daily grid
# ---------------------------------------------------------------------------

@laundry_bp.route("/laundry/locks", methods=["GET"])
def get_laundry_locks():
    """Lock state for a month — read by the grid to render locked rows."""
    try:
        month = request.args.get("month", datetime.now(IST).strftime("%Y-%m"))
        st = _laundry_lock_state(month)
        return jsonify(success=True, month=month,
                       month_locked=st["month_locked"],
                       locked_dates=st["locked_dates"])
    except Exception as e:
        logger.error(f"get_laundry_locks error: {e}")
        return jsonify(success=False, message=str(e)), 500


@laundry_bp.route("/laundry/lock", methods=["POST"])
@requires_permission("laundry.lock.manage")
def set_laundry_lock():
    """
    Admin: lock/unlock a whole month or a single date of the laundry grid.

    Body: { month:  "YYYY-MM",
            action: "lock_month" | "unlock_month" | "lock_date" |
                    "unlock_date" | "lock_dates" | "unlock_dates",
            date:   "YYYY-MM-DD"          (for *_date actions),
            dates:  ["YYYY-MM-DD", ...]   (for *_dates batch actions —
                                           calendar picker) }

    A locked date/month rejects /laundry/send and /laundry/update with 423.
    Full lock/unlock history is kept on the month doc + the audit log.
    """
    try:
        import re as _re
        from services.audit_log import write_log, _safe_user

        data   = request.json or {}
        month  = (data.get("month") or "").strip()
        action = (data.get("action") or "").strip()
        date   = (data.get("date") or "").strip()
        dates  = data.get("dates") or []

        if not _re.match(r"^\d{4}-(0[1-9]|1[0-2])$", month):
            return jsonify(success=False, message="month must be YYYY-MM"), 400
        if action not in ("lock_month", "unlock_month",
                          "lock_date", "unlock_date",
                          "lock_dates", "unlock_dates"):
            return jsonify(success=False, message="invalid action"), 400
        if action.endswith("_date") and (
                len(date) != 10 or not date.startswith(month)):
            return jsonify(success=False,
                           message="date must be YYYY-MM-DD inside the month"), 400
        if action.endswith("_dates"):
            dates = [str(d).strip() for d in dates if d]
            if not dates or any(
                    len(d) != 10 or not d.startswith(month) for d in dates):
                return jsonify(success=False, message=(
                    "dates must be a non-empty list of YYYY-MM-DD inside "
                    "the month")), 400

        ref  = _laundry_locks_ref().document(month)
        snap = ref.get()
        doc  = (snap.to_dict() or {}) if snap.exists else {}
        month_locked = bool(doc.get("month_locked"))
        locked_dates = set(doc.get("locked_dates") or [])

        if action == "lock_month":
            month_locked = True
        elif action == "unlock_month":
            month_locked = False
        elif action == "lock_date":
            locked_dates.add(date)
        elif action == "unlock_date":
            locked_dates.discard(date)
        elif action == "lock_dates":
            locked_dates.update(dates)
        else:  # unlock_dates
            locked_dates.difference_update(dates)

        _user = (_safe_user() or {}).get("userId") or "admin"
        now   = datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")
        entry = {"action": action,
                 "target": ",".join(dates) if dates else (date or month),
                 "by": _user, "at": now}
        history = (list(doc.get("history") or []) + [entry])[-100:]

        ref.set({
            "month_locked": month_locked,
            "locked_dates": sorted(locked_dates),
            "updated_by":   _user,
            "updated_at":   now,
            "history":      history,
        })
        write_log("laundry.lock", target_collection="laundry_locks",
                  target_id=month, metadata=entry)
        return jsonify(success=True, month=month, month_locked=month_locked,
                       locked_dates=sorted(locked_dates),
                       message=action.replace("_", " ").capitalize() + " done")
    except Exception as e:
        logger.error(f"set_laundry_lock error: {e}")
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

    Optional query params `start` / `end` (YYYY-MM-DD, both inclusive)
    restrict the aggregation to that date range instead of the full month
    — used by the Bill tab's from→to selector so the bill amount is
    computed only for the chosen period. The response echoes
    period_start / period_end / period_days so the UI can show exactly
    which dates the calculation covers. The bill doc itself stays keyed
    by month.
    """
    try:
        import calendar as _cal

        year, mon = int(month[:4]), int(month[5:7])
        default_start = f"{month}-01"
        default_end   = f"{month}-{str(_cal.monthrange(year, mon)[1]).zfill(2)}"

        def _valid_date(s):
            try:
                datetime.strptime(s, "%Y-%m-%d")
                return True
            except (ValueError, TypeError):
                return False

        q_start = (request.args.get("start") or "").strip()
        q_end   = (request.args.get("end") or "").strip()
        period_start = q_start if _valid_date(q_start) else default_start
        period_end   = q_end   if _valid_date(q_end)   else default_end
        if period_end < period_start:
            return jsonify(success=False,
                           message="'From' date must be on or before 'To' date"), 400

        docs = (
            _laundry_daily_ref()
            .where(filter=FieldFilter("date", ">=", period_start))
            .where(filter=FieldFilter("date", "<=", period_end))
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

        period_days = (
            datetime.strptime(period_end, "%Y-%m-%d")
            - datetime.strptime(period_start, "%Y-%m-%d")
        ).days + 1

        # ── Locate the bill for THIS period ──────────────────────────────────
        # Period bills are keyed by period_key; a full-month period falls
        # back to the legacy month-keyed doc (bills saved before periods).
        period_key    = f"{period_start}_{period_end}"
        is_full_month = (period_start == default_start
                         and period_end == default_end)

        bill_docs = list(
            _laundry_bills_ref()
            .where(filter=FieldFilter("period_key", "==", period_key))
            .limit(1).stream()
        )
        if not bill_docs and is_full_month:
            bill_docs = [
                s for s in _laundry_bills_ref()
                .where(filter=FieldFilter("month", "==", month))
                .limit(5).stream()
                if not (s.to_dict() or {}).get("period_key")
            ][:1]
        bill = None
        if bill_docs:
            bill = bill_docs[0].to_dict()
            bill["doc_id"] = bill_docs[0].id
            _with_payment_totals(bill)

        # ── Suggested opening balance ────────────────────────────────────────
        # Balance carries bill-to-bill: the most recent bill whose period
        # ENDS before this period STARTS (legacy month bills count as
        # full-month periods). Advisory — the Old Balance field stays
        # editable.
        suggested_old_balance = 0
        try:
            _best = None
            for s in _laundry_bills_ref().stream():
                bd = s.to_dict() or {}
                p_end = bd.get("period_end") or ""
                if not p_end:
                    p_end = _full_month_bounds(bd.get("month") or "")[1]
                if p_end and p_end < period_start:
                    if _best is None or p_end > _best[0]:
                        _best = (p_end, s)
            if _best is not None:
                prev_bill = _best[1].to_dict() or {}
                _with_payment_totals(prev_bill)
                suggested_old_balance = int(prev_bill.get("balance") or 0)
        except Exception as _sb_e:
            logger.warning(f"get_monthly_laundry: suggested balance failed: {_sb_e}")

        return jsonify(success=True, totals=totals, bill=bill,
                       daily_rows=daily_rows,
                       period_start=period_start, period_end=period_end,
                       period_days=period_days,
                       suggested_old_balance=suggested_old_balance)
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

        # -- Billing period (defaults to the full month) ----------------------
        _def_start, _def_end = _full_month_bounds(month)
        period_start = (data.get("period_start") or "").strip() or _def_start
        period_end   = (data.get("period_end") or "").strip() or _def_end
        period_key   = f"{period_start}_{period_end}"
        is_full_month = (period_start == _def_start and period_end == _def_end)
        period_label = (f"{_fmt_date_short(period_start)} to "
                        f"{_fmt_date_short(period_end)}")

        # -- Locate or create the bill doc -----------------------------------
        # One bill per PERIOD. A full-month period reuses the legacy
        # month-keyed doc if one exists (it gets the period stamp on save).
        existing_q = list(
            _laundry_bills_ref()
            .where(filter=FieldFilter("period_key", "==", period_key))
            .limit(1).stream()
        )
        if not existing_q and is_full_month:
            existing_q = [
                s for s in _laundry_bills_ref()
                .where(filter=FieldFilter("month", "==", month))
                .limit(5).stream()
                if not (s.to_dict() or {}).get("period_key")
            ][:1]
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
            # The description carries the billed period so anyone reading the
            # expense later knows exactly which dates this payment covered.
            _desc = (
                f"Laundry Payment - {month_label} (paid {_fmt_date_short(today_str)})"
                if is_full_month else
                f"Laundry Payment - {period_label} (paid {_fmt_date_short(today_str)})"
            )
            expense_entry = {
                "date":           today_str,
                "time":           time_str,
                "category":       "laundry",
                "description":    _desc,
                "amount":         new_payment_amount,
                "payment_method": payment_method,
                "expense_type":   expense_type,
                # Period stamp — the bill this payment belongs to. Full-month
                # bills also keep the legacy month stamp for old readers.
                "laundry_bill_period": period_key,
                "laundry_bill_period_start": period_start,
                "laundry_bill_period_end":   period_end,
            }
            if is_full_month:
                expense_entry["laundry_bill_month"] = month
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
        rows = _payment_rows_for_bill(month, period_key, is_full_month)
        paid_total = sum(r["amount"] for r in rows)
        balance    = grand_total - paid_total

        bill_doc = {
            "month":          month,
            "bill_date":      bill_date,
            # The date range this bill's amount was calculated for (from→to,
            # inclusive). period_key is the bill's identity — one bill per
            # period; balance chains bill-to-bill by period_end order.
            "period_start":   period_start,
            "period_end":     period_end,
            "period_key":     period_key,
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
        _req_period = (data.get("period_key") or "").strip()
        belongs = (
            exp_data.get("laundry_bill_month") == month
            or _month_label(month) in str(exp_data.get("description") or "")
            or (_req_period and
                exp_data.get("laundry_bill_period") == _req_period)
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
            bill_q = []
            if _req_period:
                bill_q = list(
                    _laundry_bills_ref()
                    .where(filter=FieldFilter("period_key", "==", _req_period))
                    .limit(1).stream()
                )
            if not bill_q:
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
                _pk = bill.get("period_key") or ""
                _fs, _fe = _full_month_bounds(bill.get("month") or "")
                _ifm = (not _pk) or (bill.get("period_start") == _fs
                                     and bill.get("period_end") == _fe)
                rows = _payment_rows_for_bill(bill.get("month"), _pk, _ifm)
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
        # Period bills within the same month order by period_end desc.
        results.sort(key=lambda x: (x.get("month", ""),
                                    x.get("period_end") or ""),
                     reverse=True)
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
