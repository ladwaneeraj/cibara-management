"""
Laundry Management Routes
Tracks daily items sent to / received from the laundry guy, and runs the
vendor's account as a LEDGER (the hotel-PMS "folio" model).

Billing model — one running account
-----------------------------------
    balance = opening + sum(bills) + sum(adjustments) - sum(payments)

* laundry_bills        — one doc per billed period = a CHARGE.
                         Only `bill_amount` counts. The legacy fields
                         `old_balance` / `grand_total` / `paid_amount` /
                         `balance` are ignored on read and no longer
                         written (kept on old docs untouched).
* expenses             — every laundry payment is an expense row
                         (category="laundry"), exactly as before, so the
                         dashboard totals keep working. A payment belongs
                         to the ACCOUNT, not to a bill — partial or full,
                         it simply reduces the running balance.
* laundry_adjustments  — signed manual corrections (+ owe more / − owe
                         less) with a note, for fixing history without
                         editing records.
* settings/laundry_ledger — the account's opening balance ("balance
                         brought forward"). Auto-migrated once from the
                         OLDEST legacy bill's `old_balance` (later bills'
                         old_balance values were duplicates of earlier
                         balances — the double-count this rewrite kills).

All math lives in services/laundry_ledger.py (pure, unit-tested).
Per-bill Paid/Partial/Due chips are FIFO-derived on read, never stored.
"""

from flask import Blueprint, request, jsonify
from datetime import datetime
import logging
from google.cloud.firestore_v1.base_query import FieldFilter

from config import db, IST, totals_ref
from services.auth_service import requires_permission, requires_role
from services.laundry_ledger import compute_ledger

logger = logging.getLogger(__name__)

laundry_bp = Blueprint("laundry", __name__)

# -- Firestore refs ----------------------------------------------------------
_laundry_daily_ref    = lambda: db.collection("laundry_daily")
_laundry_bills_ref    = lambda: db.collection("laundry_bills")
_laundry_settings_ref = lambda: db.collection("settings").document("laundry_prices")
_laundry_locks_ref    = lambda: db.collection("laundry_locks")
_laundry_adjust_ref   = lambda: db.collection("laundry_adjustments")
_laundry_ledger_ref   = lambda: db.collection("settings").document("laundry_ledger")


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


def _full_month_bounds(month):
    """(first_day, last_day) of YYYY-MM, or ("", "") if malformed."""
    try:
        import calendar as _cal
        y, m = int(month[:4]), int(month[5:7])
        return f"{month}-01", f"{month}-{str(_cal.monthrange(y, m)[1]).zfill(2)}"
    except (ValueError, TypeError, IndexError):
        return "", ""


# ---------------------------------------------------------------------------
# LEDGER DATA LOADERS — the account's raw entries, straight from Firestore
# ---------------------------------------------------------------------------

def _all_laundry_payment_rows():
    """
    Every laundry payment that actually moved through the books: all
    expense rows with category="laundry" (both the rows this module
    writes and any recorded through the general expense screen). The
    account ledger subtracts each one from the running balance — no
    bill-matching heuristics anymore.
    """
    out = []
    try:
        for d in (
            db.collection("expenses")
            .where(filter=FieldFilter("category", "==", "laundry"))
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
            })
    except Exception as e:
        logger.error(f"_all_laundry_payment_rows failed: {e}")
    return out


def _all_bill_rows():
    """laundry_bills docs → charge rows for compute_ledger()."""
    out = []
    try:
        for s in _laundry_bills_ref().stream():
            bd = s.to_dict() or {}
            ps = bd.get("period_start") or _full_month_bounds(bd.get("month") or "")[0]
            pe = bd.get("period_end") or _full_month_bounds(bd.get("month") or "")[1]
            out.append({
                "id":           s.id,
                "date":         bd.get("bill_date") or pe or "",
                "bill_date":    bd.get("bill_date") or "",
                "month":        bd.get("month") or "",
                "period_start": ps,
                "period_end":   pe,
                "period_key":   bd.get("period_key") or (f"{ps}_{pe}" if ps and pe else ""),
                "amount":       int(bd.get("bill_amount") or 0),
                "pieces":       sum(int(bd.get(f"total_{k}") or 0) for k in ITEM_KEYS),
            })
    except Exception as e:
        logger.error(f"_all_bill_rows failed: {e}")
    return out


def _all_adjustment_rows():
    out = []
    try:
        for s in _laundry_adjust_ref().stream():
            ad = s.to_dict() or {}
            out.append({
                "id":     s.id,
                "date":   ad.get("date", ""),
                "amount": int(ad.get("amount") or 0),
                "note":   ad.get("note", ""),
            })
    except Exception as e:
        logger.error(f"_all_adjustment_rows failed: {e}")
    return out


def _ensure_opening_balance():
    """
    One-time, lazy auto-migration of the account's opening balance.

    Legacy bills chained the balance forward by COPYING it into each new
    bill's `old_balance` — so every old_balance after the first is a
    duplicate of amounts already billed. Only the OLDEST bill's
    old_balance is genuine pre-system debt; it becomes the account's
    opening balance, stored once in settings/laundry_ledger and stable
    from then on (editable via /laundry/opening).
    """
    try:
        ref = _laundry_ledger_ref()
        snap = ref.get()
        d = (snap.to_dict() or {}) if snap.exists else {}
        if "opening_balance" in d:
            return d
        oldest = None  # (sort_key, bill_dict)
        for s in _laundry_bills_ref().stream():
            bd = s.to_dict() or {}
            key = (bd.get("period_start")
                   or _full_month_bounds(bd.get("month") or "")[0]
                   or "9999-99-99")
            if oldest is None or key < oldest[0]:
                oldest = (key, bd)
        opening = int((oldest[1].get("old_balance") or 0)) if oldest else 0
        d = {
            "opening_balance": opening,
            "opening_date":    (oldest[0] if oldest and oldest[0] != "9999-99-99"
                                else ""),
            "opening_note":    "Balance brought forward",
            "migrated_at":     datetime.now(IST).isoformat(),
        }
        ref.set(d, merge=True)
        logger.info(f"laundry ledger: opening balance auto-migrated = {opening}")
        return d
    except Exception as e:
        logger.error(f"_ensure_opening_balance failed: {e}")
        return {"opening_balance": 0, "opening_date": "", "opening_note": ""}


def _build_ledger():
    """Assemble the full account ledger (see services/laundry_ledger.py)."""
    meta = _ensure_opening_balance()
    opening = {
        "amount": int(meta.get("opening_balance") or 0),
        "date":   meta.get("opening_date") or "",
        "note":   meta.get("opening_note") or "Balance brought forward",
    }
    return compute_ledger(opening, _all_bill_rows(),
                          _all_adjustment_rows(), _all_laundry_payment_rows())


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
# MONTHLY -- piece totals for a period + the bill covering it (Add Bill panel)
# ---------------------------------------------------------------------------

def _find_bill_ref_for_period(month, period_key, is_full_month):
    """
    The bill doc for one period, or None. Period bills are keyed by
    period_key; a full-month period falls back to the legacy month-keyed
    doc (bills saved before periods existed).
    """
    docs = list(
        _laundry_bills_ref()
        .where(filter=FieldFilter("period_key", "==", period_key))
        .limit(1).stream()
    )
    if not docs and is_full_month:
        docs = [
            s for s in _laundry_bills_ref()
            .where(filter=FieldFilter("month", "==", month))
            .limit(5).stream()
            if not (s.to_dict() or {}).get("period_key")
        ][:1]
    return docs[0] if docs else None


@laundry_bp.route("/laundry/monthly/<month>", methods=["GET"])
@requires_role("admin")
def get_monthly_laundry(month):
    """
    month: YYYY-MM. Item-wise piece totals for the period (query params
    `start` / `end`, default full month) + the existing bill doc for that
    period if one was already saved. Feeds the Add Bill panel — balances
    and payments come from /laundry/ledger, not from here.
    """
    try:
        default_start, default_end = _full_month_bounds(month)
        if not default_start:
            return jsonify(success=False, message="month must be YYYY-MM"), 400

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
        for d in docs:
            row = d.to_dict()
            for k in ITEM_KEYS:
                totals[k] += int(row.get(k, 0))
        totals["grand"] = sum(totals[k] for k in ITEM_KEYS)

        period_days = (
            datetime.strptime(period_end, "%Y-%m-%d")
            - datetime.strptime(period_start, "%Y-%m-%d")
        ).days + 1

        period_key    = f"{period_start}_{period_end}"
        is_full_month = (period_start == default_start
                         and period_end == default_end)
        snap = _find_bill_ref_for_period(month, period_key, is_full_month)
        bill = None
        if snap is not None:
            bill = snap.to_dict() or {}
            bill["doc_id"] = snap.id

        return jsonify(success=True, totals=totals, bill=bill,
                       period_start=period_start, period_end=period_end,
                       period_days=period_days)
    except Exception as e:
        logger.error(f"get_monthly_laundry error: {e}")
        return jsonify(success=False, message=str(e)), 500


# ---------------------------------------------------------------------------
# LEDGER -- the whole account: entries, running balance, bill statuses
# ---------------------------------------------------------------------------

@laundry_bp.route("/laundry/ledger", methods=["GET"])
@requires_role("admin")
def get_laundry_ledger():
    """
    The vendor account statement. Everything the Billing tab shows comes
    from this one endpoint:
      summary  — opening / total billed / total paid / balance / advance
      entries  — chronological passbook rows with running_balance
      bills    — each bill with FIFO-derived settled / due / status
      overlaps — bill periods that overlap (double-entry warning)
    """
    try:
        ledger = _build_ledger()
        return jsonify(success=True, **ledger)
    except Exception as e:
        logger.error(f"get_laundry_ledger error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


# ---------------------------------------------------------------------------
# BILL -- save a charge (adds to the account; no payment fields here)
# ---------------------------------------------------------------------------

def _upsert_bill(data):
    """
    Create/update one bill (charge) doc from a request payload.
    Returns (bill_id, error_response_or_None). One bill per period_key;
    a full-month period reuses the legacy month-keyed doc if one exists.
    Legacy money fields (old_balance / grand_total / paid_amount /
    balance) are NOT written — the ledger ignores them.
    """
    month       = data.get("month")
    bill_date   = (data.get("bill_date") or "").strip()
    bill_amount = int(data.get("bill_amount", 0))
    if not month:
        return None, (jsonify(success=False, message="Month is required"), 400)
    if bill_amount < 0:
        return None, (jsonify(success=False,
                              message="Bill amount can't be negative"), 400)

    _def_start, _def_end = _full_month_bounds(month)
    if not _def_start:
        return None, (jsonify(success=False, message="month must be YYYY-MM"), 400)
    period_start = (data.get("period_start") or "").strip() or _def_start
    period_end   = (data.get("period_end") or "").strip() or _def_end
    if period_end < period_start:
        return None, (jsonify(success=False,
                              message="'From' date must be on or before 'To' date"), 400)
    period_key    = f"{period_start}_{period_end}"
    is_full_month = (period_start == _def_start and period_end == _def_end)

    item_totals = {k: int(data.get(f"total_{k}", 0)) for k in ITEM_KEYS}
    prices      = {k: int(data.get(f"price_{k}", 100)) for k in ITEM_KEYS}

    snap = _find_bill_ref_for_period(month, period_key, is_full_month)
    bill_ref = (_laundry_bills_ref().document(snap.id) if snap is not None
                else _laundry_bills_ref().document())

    bill_ref.set({
        "month":        month,
        "bill_date":    bill_date or datetime.now(IST).strftime("%Y-%m-%d"),
        "period_start": period_start,
        "period_end":   period_end,
        "period_key":   period_key,
        **{f"total_{k}": item_totals[k] for k in ITEM_KEYS},
        **{f"price_{k}": prices[k]      for k in ITEM_KEYS},
        "bill_amount":  bill_amount,
        "updated_at":   datetime.now(IST).isoformat(),
    }, merge=True)
    return bill_ref.id, None


@laundry_bp.route("/laundry/bill", methods=["POST"])
@requires_role("admin")
def save_laundry_bill():
    """
    Save/update one bill. Payload: month, bill_date, bill_amount,
    period_start, period_end, total_*, price_*. Payments are a separate
    action (/laundry/pay) — a bill only ADDS to the account balance.
    """
    try:
        bill_id, err = _upsert_bill(request.json or {})
        if err:
            return err
        ledger = _build_ledger()
        return jsonify(success=True, message="Bill saved",
                       bill_id=bill_id, summary=ledger["summary"])
    except Exception as e:
        logger.error(f"save_laundry_bill error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


@laundry_bp.route("/laundry/bill/delete", methods=["POST"])
@requires_permission("payment.edit")
def delete_laundry_bill():
    """
    Delete one bill (e.g. a duplicate / overlapping period entered by
    mistake). Payments are untouched — they belong to the account. The
    balance simply re-derives.  Body: { bill_id }
    """
    try:
        bill_id = (request.json or {}).get("bill_id")
        if not bill_id:
            return jsonify(success=False, message="bill_id required"), 400
        ref = _laundry_bills_ref().document(bill_id)
        snap = ref.get()
        if not snap.exists:
            return jsonify(success=False, message="Bill not found"), 404
        bd = snap.to_dict() or {}
        ref.delete()
        try:
            from services.audit_log import write_log
            write_log("laundry.bill.delete", target_collection="laundry_bills",
                      target_id=bill_id,
                      metadata={"month": bd.get("month"),
                                "period_key": bd.get("period_key"),
                                "bill_amount": bd.get("bill_amount")})
        except Exception as le:
            logger.warning(f"delete_laundry_bill: audit log failed: {le}")
        ledger = _build_ledger()
        return jsonify(success=True, message="Bill deleted",
                       summary=ledger["summary"])
    except Exception as e:
        logger.error(f"delete_laundry_bill error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


# ---------------------------------------------------------------------------
# PAY -- record a payment against the ACCOUNT (partial or full, no allocation)
# ---------------------------------------------------------------------------

def _record_payment(amount, method, expense_type, date_str="", note=""):
    """
    Write one payment as an expense row (single source of truth — the
    dashboard reads the same collection). Returns the expense doc id.
    """
    now_ist = datetime.now(IST)
    pay_date = date_str or now_ist.strftime("%Y-%m-%d")
    desc = f"Laundry Payment (paid {_fmt_date_short(pay_date)})"
    if note:
        desc += f" — {note}"
    expense_entry = {
        "date":            pay_date,
        "time":            now_ist.strftime("%H:%M"),
        "category":        "laundry",
        "description":     desc,
        "amount":          amount,
        "payment_method":  method,
        "expense_type":    expense_type,
        "laundry_payment": True,   # account-level payment stamp
    }
    ref = db.collection("expenses").document()
    ref.set(expense_entry)
    if expense_type == "transaction":
        _update_expense_totals(amount, method, _ist_at_date(pay_date))
    return ref.id


@laundry_bp.route("/laundry/pay", methods=["POST"])
@requires_role("admin")
def pay_laundry():
    """
    Record a payment. Body: { amount, payment_method ("cash"|"upi"|
    "online"), expense_type ("transaction"|"report"), date (optional,
    default today), note (optional) }.

    Partial or full makes no difference — the amount subtracts from the
    running account balance, and whatever remains carries forward
    automatically. Overpaying simply shows as an advance.
    """
    try:
        data = request.json or {}
        try:
            amount = int(data.get("amount", 0))
        except (TypeError, ValueError):
            amount = 0
        if amount <= 0:
            return jsonify(success=False,
                           message="Enter a payment amount above zero"), 400
        method       = data.get("payment_method", "cash")
        expense_type = data.get("expense_type", "transaction")
        date_str     = (data.get("date") or "").strip()
        note         = str(data.get("note") or "").strip()[:120]
        if date_str:
            try:
                datetime.strptime(date_str, "%Y-%m-%d")
            except ValueError:
                return jsonify(success=False,
                               message="date must be YYYY-MM-DD"), 400

        try:
            expense_id = _record_payment(amount, method, expense_type,
                                         date_str, note)
        except Exception as exp_err:
            logger.error(f"pay_laundry: expense write failed "
                         f"amount={amount}: {exp_err}", exc_info=True)
            return jsonify(success=False,
                           message="Payment could not be recorded — "
                                   "please try again"), 500

        ledger = _build_ledger()
        return jsonify(success=True, message="Payment recorded",
                       expense_id=expense_id, summary=ledger["summary"])
    except Exception as e:
        logger.error(f"pay_laundry error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


# ---------------------------------------------------------------------------
# ADJUSTMENTS -- signed manual corrections, and the opening balance
# ---------------------------------------------------------------------------

@laundry_bp.route("/laundry/adjust", methods=["POST"])
@requires_permission("payment.edit")
def add_laundry_adjustment():
    """
    Add a correction entry. Body: { amount (signed int, non-zero:
    + we owe more / − we owe less), note (required), date (optional) }.
    """
    try:
        data = request.json or {}
        try:
            amount = int(data.get("amount", 0))
        except (TypeError, ValueError):
            amount = 0
        note = str(data.get("note") or "").strip()[:200]
        date_str = (data.get("date") or "").strip() \
            or datetime.now(IST).strftime("%Y-%m-%d")
        if amount == 0:
            return jsonify(success=False,
                           message="Adjustment amount can't be zero"), 400
        if not note:
            return jsonify(success=False,
                           message="A note explaining the adjustment is "
                                   "required"), 400
        try:
            datetime.strptime(date_str, "%Y-%m-%d")
        except ValueError:
            return jsonify(success=False, message="date must be YYYY-MM-DD"), 400

        ref = _laundry_adjust_ref().document()
        ref.set({"amount": amount, "note": note, "date": date_str,
                 "created_at": datetime.now(IST).isoformat()})
        try:
            from services.audit_log import write_log
            write_log("laundry.adjustment.add",
                      target_collection="laundry_adjustments",
                      target_id=ref.id,
                      metadata={"amount": amount, "note": note, "date": date_str})
        except Exception as le:
            logger.warning(f"add_laundry_adjustment: audit log failed: {le}")

        ledger = _build_ledger()
        return jsonify(success=True, message="Adjustment added",
                       adjustment_id=ref.id, summary=ledger["summary"])
    except Exception as e:
        logger.error(f"add_laundry_adjustment error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


@laundry_bp.route("/laundry/adjust/delete", methods=["POST"])
@requires_permission("payment.edit")
def delete_laundry_adjustment():
    """Delete an adjustment entry. Body: { adjustment_id }"""
    try:
        adj_id = (request.json or {}).get("adjustment_id")
        if not adj_id:
            return jsonify(success=False, message="adjustment_id required"), 400
        ref = _laundry_adjust_ref().document(adj_id)
        snap = ref.get()
        if not snap.exists:
            return jsonify(success=False, message="Adjustment not found"), 404
        ad = snap.to_dict() or {}
        ref.delete()
        try:
            from services.audit_log import write_log
            write_log("laundry.adjustment.delete",
                      target_collection="laundry_adjustments",
                      target_id=adj_id, metadata=ad)
        except Exception as le:
            logger.warning(f"delete_laundry_adjustment: audit log failed: {le}")
        ledger = _build_ledger()
        return jsonify(success=True, message="Adjustment removed",
                       summary=ledger["summary"])
    except Exception as e:
        logger.error(f"delete_laundry_adjustment error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


@laundry_bp.route("/laundry/opening", methods=["POST"])
@requires_permission("payment.edit")
def set_laundry_opening():
    """
    Set the account's opening balance (balance brought forward from
    before the ledger). Body: { opening_balance (int ≥ 0),
    opening_date (optional), note (optional) }.
    """
    try:
        data = request.json or {}
        try:
            opening = int(data.get("opening_balance", 0))
        except (TypeError, ValueError):
            return jsonify(success=False,
                           message="opening_balance must be a number"), 400
        if opening < 0:
            return jsonify(success=False,
                           message="Opening balance can't be negative — "
                                   "use an adjustment for an advance"), 400
        date_str = (data.get("opening_date") or "").strip()
        if date_str:
            try:
                datetime.strptime(date_str, "%Y-%m-%d")
            except ValueError:
                return jsonify(success=False,
                               message="opening_date must be YYYY-MM-DD"), 400
        payload = {
            "opening_balance": opening,
            "opening_note": (str(data.get("note") or "").strip()[:200]
                             or "Balance brought forward"),
            "updated_at": datetime.now(IST).isoformat(),
        }
        if date_str:
            payload["opening_date"] = date_str
        _laundry_ledger_ref().set(payload, merge=True)
        try:
            from services.audit_log import write_log
            write_log("laundry.opening.set", target_collection="settings",
                      target_id="laundry_ledger", metadata=payload)
        except Exception as le:
            logger.warning(f"set_laundry_opening: audit log failed: {le}")
        ledger = _build_ledger()
        return jsonify(success=True, message="Opening balance saved",
                       summary=ledger["summary"])
    except Exception as e:
        logger.error(f"set_laundry_opening error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


# ---------------------------------------------------------------------------
# LEGACY COMPAT -- old clients (cached laundry.js) posting the combined form
# ---------------------------------------------------------------------------

@laundry_bp.route("/laundry/monthly", methods=["POST"])
@requires_role("admin")
def save_monthly_bill():
    """
    DEPRECATED shim for the pre-ledger UI, kept so a stale cached
    frontend can't corrupt data. Saves the bill (old_balance is IGNORED
    — carry-forward is automatic now) and, if paid_amount > 0, records
    an account payment.
    """
    try:
        data = request.json or {}
        bill_id, err = _upsert_bill(data)
        if err:
            return err
        try:
            paid = int(data.get("paid_amount", 0))
        except (TypeError, ValueError):
            paid = 0
        if paid > 0:
            _record_payment(paid, data.get("payment_method", "cash"),
                            data.get("expense_type", "transaction"))
        ledger = _build_ledger()
        s = ledger["summary"]
        return jsonify(success=True,
                       message=("Payment recorded" if paid > 0
                                else "Bill totals saved"),
                       balance=s["balance"], paid_total=s["total_paid"])
    except Exception as e:
        logger.error(f"save_monthly_bill (compat) error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


# ---------------------------------------------------------------------------
# DELETE PARTIAL PAYMENT
# ---------------------------------------------------------------------------

@laundry_bp.route("/laundry/payment/delete", methods=["POST"])
@requires_permission("payment.edit")
def delete_laundry_payment():
    """
    Delete one laundry payment (an expense row) and reverse the expense
    totals counter. The ledger re-derives — nothing else to update.

    Body: { payment_id }   (payment_id = the expense doc id; the legacy
    body also carried month/period_key — accepted and ignored.)
    """
    try:
        data = request.json or {}
        expense_id = data.get("payment_id")
        if not expense_id:
            return jsonify(success=False, message="payment_id required"), 400

        exp_doc = db.collection("expenses").document(expense_id).get()
        if not exp_doc.exists:
            return jsonify(success=False, message="Payment entry not found"), 404
        exp_data = exp_doc.to_dict() or {}

        # Only laundry rows may be deleted through this endpoint —
        # protects against a UI bug passing some other expense's id.
        if (exp_data.get("category") != "laundry"
                and not exp_data.get("laundry_payment")
                and not exp_data.get("laundry_bill_month")
                and not exp_data.get("laundry_bill_period")):
            return jsonify(success=False,
                           message="That entry is not a laundry payment"), 400

        deleted_amount = int(exp_data.get("amount") or 0)
        deleted_method = exp_data.get("payment_method") or "cash"
        deleted_etype  = exp_data.get("expense_type") or "transaction"
        deleted_date   = (exp_data.get("date")
                          or datetime.now(IST).strftime("%Y-%m-%d"))

        try:
            db.collection("expenses").document(expense_id).delete()
        except Exception as ee:
            logger.error(f"delete_laundry_payment: expense delete failed "
                         f"(id={expense_id}): {ee}")
            return jsonify(success=False, message="Could not delete payment"), 500

        if deleted_etype == "transaction" and deleted_amount > 0:
            try:
                _update_expense_totals(-deleted_amount, deleted_method,
                                       _ist_at_date(deleted_date))
            except Exception as ee:
                logger.warning(f"delete_laundry_payment: totals reversal failed: {ee}")

        try:
            from services.audit_log import write_log
            write_log("laundry.payment.delete", target_collection="expenses",
                      target_id=expense_id,
                      metadata={"amount": deleted_amount,
                                "method": deleted_method,
                                "date": deleted_date})
        except Exception as le:
            logger.warning(f"delete_laundry_payment: audit log failed: {le}")

        ledger = _build_ledger()
        return jsonify(success=True,
                       message=f"Payment of {deleted_amount} removed",
                       summary=ledger["summary"])
    except Exception as e:
        logger.error(f"delete_laundry_payment error: {e}", exc_info=True)
        return jsonify(success=False, message=str(e)), 500


# ---------------------------------------------------------------------------
# ALL BILLS -- ledger-derived list (kept for stale cached frontends)
# ---------------------------------------------------------------------------

@laundry_bp.route("/laundry/all_bills", methods=["GET"])
@requires_role("admin")
def get_all_bills():
    """
    DEPRECATED — the Billing tab reads /laundry/ledger now. Returns each
    bill with FIFO-derived settled amounts mapped onto the legacy field
    names so an old cached frontend still shows sane numbers.
    """
    try:
        ledger = _build_ledger()
        results = []
        for b in ledger["bills"]:
            results.append({
                "doc_id":       b.get("id"),
                "month":        b.get("month"),
                "bill_date":    b.get("bill_date"),
                "period_start": b.get("period_start"),
                "period_end":   b.get("period_end"),
                "period_key":   b.get("period_key"),
                "bill_amount":  b.get("amount"),
                "paid_total":   b.get("settled", 0),
                "paid_amount":  b.get("settled", 0),
                "balance":      b.get("due", b.get("amount")),
                "status":       b.get("status"),
                "payments":     [],
            })
        results.sort(key=lambda x: (x.get("month") or "",
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
