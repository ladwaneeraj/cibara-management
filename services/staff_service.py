"""
Staff & payroll service — Firestore I/O for the Staff module.

All salary/advance arithmetic lives in services/staff_ledger.py (pure,
unit-tested); this module owns the documents and the atomic batches that
keep the payroll records and the expenses collection in lock-step.

Schema
──────
staff                               (one doc per staff member)
    name           str
    designation    str   ("Housekeeping", "Front desk", …, free text)
    phone          str
    daily_wage     int ₹ per full day (half day pays half)
    meal_rate      int ₹ per day of food eaten at the lodge (0 = none).
                   Withheld from the salary payout and billed separately
                   via a meal log, so a ₹350/day member on a ₹50 meal rate
                   takes home ₹300/day in cash and the kitchen cost shows
                   up as its own expense row. Charged per calendar day
                   PRESENT — a half day still eats, a dual-shift day is
                   still one meal.
    is_dual_shift  bool  (works a Day AND a Night shift — gets a second
                          attendance record per day; False for everyone
                          else, who is marked once per day as today)
    active         bool  (soft delete — history is never removed)
    joined_date    "YYYY-MM-DD"
    notes          str
    created_at/by, updated_at/by

staff_attendance
    doc id = "<staff_id>__<date>"             for single-shift staff
    doc id = "<staff_id>__<date>__<shift>"    for dual-shift staff (shift
                                               is "D" or "N")
    staff_id, date "YYYY-MM-DD"
    shift          "D" | "N"  (present ONLY on dual-shift staff's records;
                               absent/omitted = the staff member's single
                               daily record, same as before this existed)
    status         "full" | "half" | "absent"
    marked_by      {userId, name}
    marked_at      UTC iso
    (unmarked days/shifts simply have no doc; clearing a mark deletes it)

    Payroll note: a dual-shift staff member's day is worth the SUM of
    their D and N records (up to 2.0 worked-day units if both are full) —
    see services/staff_ledger.py::attendance_summary. Single-shift staff
    are unaffected and still cap at 1.0/day exactly as before.

staff_advances                      (one doc per advance given)
    staff_id, staff_name
    date "YYYY-MM-DD", amount int ₹
    note           str
    payment_method "cash" | "online"
    expense_type   "transaction" | "report"
    expense_doc_id linked expenses-collection doc (same batch, never orphaned)
    created_at, created_by {userId, name}

staff_salary_payments               (one doc per settled payout)
    staff_id, staff_name
    period_start / period_end   "YYYY-MM-DD" (inclusive)
    full_days, half_days, days_worked, daily_wage
    gross, adjustment (signed), adjustment_note
    advance_deducted, net_paid
    payment_method, expense_type
    expense_doc_id  linked expense for net_paid (None when net_paid = 0)
    paid_on "YYYY-MM-DD", paid_at UTC iso, paid_by {userId, name}

Expense linkage
───────────────
Advances and salary payouts ARE money leaving the business, so each one
writes a row into the `expenses` collection in the SAME Firestore batch:

    advance → category "staff_advance", marker staff_advance: True
    salary  → category "salary",        marker staff_salary_payment: True

expense_type == "transaction" additionally increments the canonical
totals/current_totals.expenses counter (mirroring routes/reports.py::
add_expense) so the home-tab day-cash arithmetic stays correct. The
generic /expense edit/delete routes refuse staff-linked rows (409) —
they must be managed from the Staff module so both sides stay in sync.

Invariants
──────────
* No day is ever paid twice: a new payment that overlaps earlier ones
  records those days in `excluded_dates` and pays ₹0 for them (a mid-week
  one-day payout no longer blocks settling the rest of the week).
* No day is paid without attendance: a day with no attendance record is
  recorded in `excluded_dates` too (and listed in `unmarked_dates`). It
  earns ₹0, stays UNLOCKED so attendance can still be marked, and is still
  payable in a later period. Without this a forgotten day would be consumed
  by the payout — locked, worth nothing, and skipped forever after.
* Attendance on a day a payment actually covered is locked.
* outstanding_advance (Σ advances − Σ deductions) never goes negative:
  deleting an advance that was already recovered is refused.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from firebase_admin import firestore as fa_firestore
from google.cloud.firestore_v1.base_query import FieldFilter

from config import db, IST, logger, totals_ref
from services import staff_ledger as ledger

# Lambdas so tests can patch `db` (same pattern as maintenance_service).
_staff_ref = lambda: db.collection("staff")
_att_ref = lambda: db.collection("staff_attendance")
_adv_ref = lambda: db.collection("staff_advances")
_sal_ref = lambda: db.collection("staff_salary_payments")
_meal_ref = lambda: db.collection("staff_meal_logs")
_expenses_ref = lambda: db.collection("expenses")

VALID_METHODS = ("cash", "online")
VALID_EXPENSE_TYPES = ("transaction", "report")

MAX_DAILY_WAGE = 100_000          # sanity ceiling, ₹/day
MAX_ADVANCE = 10_00_000           # sanity ceiling per advance, ₹
MAX_MEAL_RATE = 5_000             # sanity ceiling, ₹/day of food


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ist_today() -> str:
    return datetime.now(IST).strftime("%Y-%m-%d")


_MONTH_ABBR = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def _dmy(ymd) -> str:
    """"2026-08-02" -> "02 Aug 2026".

    Dates stay ISO in every stored field (they are sorted and compared as
    strings); this is only for the human-readable description on the expense
    row, which the Transactions list prints verbatim. A month NAME is used
    here rather than the numeric DD-MM-YYYY the compact UI uses: these strings
    are read as prose mid-sentence ("Salary — Menamma (04 Aug 2026 to 10 Aug
    2026)"), where two adjacent numbers invite a moment of "which one is the
    month?".

    The month name is looked up from a fixed tuple, not strftime, so the
    output never depends on the server's locale.
    """
    t = str(ymd or "")
    if not _valid_date(t):
        return t
    return "{} {} {}".format(t[8:10], _MONTH_ABBR[int(t[5:7]) - 1], t[0:4])


def _ist_time() -> str:
    return datetime.now(IST).strftime("%H:%M")


def _user_stamp(user: Optional[dict]) -> dict:
    user = user or {}
    return {"userId": user.get("userId", "system"),
            "name": user.get("name", "system")}


def _valid_date(s) -> bool:
    """Strict YYYY-MM-DD (round-trip check — strptime alone accepts
    non-padded dates, which would break string-ordering comparisons)."""
    try:
        return datetime.strptime(str(s), "%Y-%m-%d").strftime("%Y-%m-%d") == str(s)
    except (TypeError, ValueError):
        return False


def _doc_with_id(snap) -> dict:
    d = snap.to_dict() or {}
    d["id"] = snap.id
    return d


# ═══════════════════════════════════════════════════════════════════════════
# Staff directory
# ═══════════════════════════════════════════════════════════════════════════

def list_staff(include_inactive: bool = False) -> list:
    """All staff, active first then by name. Firestore-side filtering is
    intentionally avoided (tiny collection; no composite index needed)."""
    out = [_doc_with_id(s) for s in _staff_ref().stream()]
    if not include_inactive:
        out = [s for s in out if s.get("active", True)]
    out.sort(key=lambda s: (not s.get("active", True),
                            str(s.get("name", "")).lower()))
    return out


def get_staff(staff_id: str) -> Optional[dict]:
    if not staff_id:
        return None
    snap = _staff_ref().document(staff_id).get()
    return _doc_with_id(snap) if snap.exists else None


def _clean_staff_fields(data: dict, *, partial: bool) -> dict:
    """Validate + whitelist staff fields. Raises ValueError on bad input."""
    fields = {}
    if "name" in data or not partial:
        name = str(data.get("name", "")).strip()
        if not name:
            raise ValueError("Staff name is required.")
        if len(name) > 60:
            raise ValueError("Staff name is too long (60 chars max).")
        fields["name"] = name
    if "daily_wage" in data or not partial:
        try:
            wage = int(round(float(data.get("daily_wage", 0))))
        except (TypeError, ValueError):
            raise ValueError("Per-day wage must be a number.")
        if wage <= 0:
            raise ValueError("Per-day wage must be above zero.")
        if wage > MAX_DAILY_WAGE:
            raise ValueError("Per-day wage looks too large — check the amount.")
        fields["daily_wage"] = wage
    if "meal_rate" in data:
        raw = data.get("meal_rate")
        try:
            meal = 0 if raw in (None, "") else int(round(float(raw)))
        except (TypeError, ValueError):
            raise ValueError("Meal rate must be a number.")
        if meal < 0:
            raise ValueError("Meal rate cannot be negative.")
        if meal > MAX_MEAL_RATE:
            raise ValueError("Meal rate looks too large — check the amount.")
        fields["meal_rate"] = meal
    if "designation" in data:
        fields["designation"] = str(data.get("designation", "")).strip()[:40]
    if "phone" in data:
        fields["phone"] = str(data.get("phone", "")).strip()[:20]
    if "notes" in data:
        fields["notes"] = str(data.get("notes", "")).strip()[:300]
    if "joined_date" in data:
        jd = str(data.get("joined_date", "")).strip()
        if jd and not _valid_date(jd):
            raise ValueError("Joined date must be YYYY-MM-DD.")
        fields["joined_date"] = jd
    if "active" in data:
        fields["active"] = bool(data.get("active"))
    if "is_dual_shift" in data:
        fields["is_dual_shift"] = bool(data.get("is_dual_shift"))
    return fields


def create_staff(data: dict, user: Optional[dict]) -> dict:
    fields = _clean_staff_fields(data or {}, partial=False)
    fields.setdefault("designation", "")
    fields.setdefault("phone", "")
    fields.setdefault("notes", "")
    fields.setdefault("joined_date", _ist_today())
    fields.setdefault("is_dual_shift", False)
    fields.setdefault("meal_rate", 0)
    fields["active"] = True
    fields["created_at"] = _now_utc()
    fields["created_by"] = _user_stamp(user)
    ref = _staff_ref().document()
    ref.set(fields)
    fields["id"] = ref.id
    logger.info("staff: created %s (%s) wage=₹%s/day",
                fields["name"], ref.id, fields["daily_wage"])
    return fields


def update_staff(staff_id: str, data: dict, user: Optional[dict]) -> dict:
    existing = get_staff(staff_id)
    if not existing:
        raise ValueError("Staff member not found.")
    fields = _clean_staff_fields(data or {}, partial=True)
    if not fields:
        raise ValueError("Nothing to update.")
    fields["updated_at"] = _now_utc()
    fields["updated_by"] = _user_stamp(user)
    _staff_ref().document(staff_id).update(fields)
    existing.update(fields)
    return existing


# ═══════════════════════════════════════════════════════════════════════════
# Attendance
# ═══════════════════════════════════════════════════════════════════════════

def attendance_range(start: str, end: str,
                     staff_id: Optional[str] = None) -> list:
    """
    Attendance records with start ≤ date ≤ end. Single-field range query
    (auto-indexed); the optional staff filter happens in memory — the
    collection is small (staff × days), and this avoids needing a
    composite Firestore index.
    """
    q = (_att_ref()
         .where(filter=FieldFilter("date", ">=", start))
         .where(filter=FieldFilter("date", "<=", end)))
    out = [_doc_with_id(s) for s in q.stream()]
    if staff_id:
        out = [a for a in out if a.get("staff_id") == staff_id]
    return out


VALID_SHIFTS = ("D", "N")


def _attendance_doc_id(staff_id: str, date: str, shift: Optional[str]) -> str:
    return ("{}__{}__{}".format(staff_id, date, shift) if shift
            else "{}__{}".format(staff_id, date))


def _first_marked_ist_date(rec: dict) -> Optional[str]:
    """
    The IST calendar date on which this record was FIRST entered.

    `marked_at` is rewritten on every change, so an edited record would
    otherwise look freshly marked and stay editable forever. history[0] is
    the oldest superseded version, and its `marked_at` is the original
    entry's timestamp — that is the day that counts.
    """
    hist = rec.get("history") or []
    stamp = (hist[0].get("marked_at") if hist else None) or rec.get("marked_at")
    if not stamp:
        return None
    try:
        dt = datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))
    except Exception:
        return None
    if dt.tzinfo is None:                       # legacy naive stamps are UTC
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(IST).strftime("%Y-%m-%d")


def attendance_frozen(rec: Optional[dict]) -> bool:
    """
    True when this record may no longer be CHANGED.

    The rule: a mark is editable only on the IST calendar day it was first
    entered. Marking the 29th on the 29th leaves it editable that day and
    frozen from the 30th. Back-filling the 29th on the 30th is a first
    entry, not a change, so it is allowed and then stays correctable for the
    rest of the 30th, freezing on the 31st. Creating a record for a day
    nobody marked is therefore never blocked by this — only rewriting one.

    Records written before this rule existed (or carrying an unreadable
    timestamp) fall back to their own `date`: a past day is frozen, today is
    still open. Erring towards frozen is deliberate; the alternative is a
    silent bypass for exactly the oldest records.
    """
    if not rec:
        return False
    day = _first_marked_ist_date(rec) or rec.get("date")
    return bool(day) and day != _ist_today()


def mark_attendance(staff_id: str, date: str, status: str,
                    user: Optional[dict], shift: Optional[str] = None,
                    allow_amend: bool = False) -> dict:
    """
    Idempotently set (or clear) one staff member's attendance for a date.
    status: "full" | "half" | "absent" | "clear".

    shift: "D" | "N" — REQUIRED for dual-shift staff (two independent
    records per day), and must be omitted/None for everyone else (they
    keep the original single record-per-day scheme).

    allow_amend: caller holds staff.attendance.amend (admin). Lets them
    change a record that is already frozen; see attendance_frozen().

    Guards: staff must exist & be active, date must be valid and not in
    the future, the date must not fall inside an already-paid salary
    period (paid history must stay immutable), and an existing record may
    only be changed on the day it was entered.
    """
    staff = get_staff(staff_id)
    if not staff:
        raise ValueError("Staff member not found.")
    if not staff.get("active", True):
        raise ValueError("This staff member is inactive — reactivate them "
                         "before marking attendance.")
    if not _valid_date(date):
        raise ValueError("Date must be YYYY-MM-DD.")
    if date > _ist_today():
        raise ValueError("Attendance cannot be marked for a future date.")
    if status not in ledger.ATTENDANCE_STATUSES and status != "clear":
        raise ValueError("Status must be full, half, absent or clear.")

    shift = str(shift).strip().upper() if shift else None
    is_dual = bool(staff.get("is_dual_shift"))
    if is_dual:
        if shift not in VALID_SHIFTS:
            raise ValueError(
                "This staff member works two shifts — pick Day (D) or "
                "Night (N) before marking attendance.")
    elif shift is not None:
        raise ValueError(
            "This staff member isn't set up for two shifts — mark their "
            "single daily attendance instead.")

    paid = ledger.date_in_paid_period(date, salary_payments_for(staff_id))
    if paid:
        raise ValueError(
            "Salary for {} – {} is already paid — attendance in that "
            "period is locked. Delete the salary payment first if you "
            "really need to correct it.".format(
                paid.get("period_start"), paid.get("period_end")))

    doc_id = _attendance_doc_id(staff_id, date, shift)
    prev_snap = _att_ref().document(doc_id).get()
    prev = ((prev_snap.to_dict() or {})
            if getattr(prev_snap, "exists", False) else None)

    # Past days are write-once. Creating a record for a day nobody marked is
    # always allowed — that is the back-fill case, and it is how a missed
    # staff member gets recorded at all. CHANGING (or clearing) one after the
    # day it was entered is not, because payroll is computed from these rows.
    # Checked before the delete branch too: clearing a day is a change.
    if prev is not None and not allow_amend and attendance_frozen(prev):
        raise ValueError(
            "Attendance for {} was entered on {} and can no longer be "
            "changed. Ask an admin to amend it.".format(
                date, _first_marked_ist_date(prev) or date))

    if status == "clear":
        _att_ref().document(doc_id).delete()
        return {"staff_id": staff_id, "date": date, "shift": shift,
                "status": None}

    doc = {
        "staff_id": staff_id,
        "date": date,
        "status": status,
        "marked_by": _user_stamp(user),
        "marked_at": _now_utc(),
    }
    if shift:
        doc["shift"] = shift
    # Audit trail: when a mark is CHANGED, keep what it was and who set it
    # (last 10 changes). Settles "I was present that day" disputes.
    # Limitation: clearing a day deletes the doc, so its history goes with
    # it — the app-level write_log in routes/staff.py still records the op.
    if prev:
        if prev.get("status") and prev.get("status") != status:
            doc["history"] = (prev.get("history") or [])[-9:] + [{
                "status": prev.get("status"),
                "marked_by": prev.get("marked_by") or {},
                "marked_at": prev.get("marked_at") or "",
            }]
        elif prev.get("history"):
            doc["history"] = prev["history"]
    _att_ref().document(doc_id).set(doc)
    doc["id"] = doc_id
    return doc


def mark_all_present(date: str, user: Optional[dict]) -> dict:
    """
    Mark every ACTIVE staff member without a record on `date` as "full",
    in one batch. Staff already marked (any status) are left untouched;
    days inside a paid salary period are skipped. Dual-shift staff get
    BOTH their Day and Night records marked (whichever of the two isn't
    already marked) — "all present" means a full day's work, both shifts.
    Returns the new records plus counts so the UI can report exactly what
    happened.
    """
    if not _valid_date(date):
        raise ValueError("Date must be YYYY-MM-DD.")
    if date > _ist_today():
        raise ValueError("Attendance cannot be marked for a future date.")

    staff = list_staff(include_inactive=False)
    existing = {(a.get("staff_id"), a.get("shift")) for a in attendance_range(date, date)}
    paid = paid_periods_by_staff()

    def _locked(sid):
        return any(p["start"] <= date <= p["end"]
                   and date not in (p.get("excluded") or [])
                   for p in paid.get(sid, []))

    stamp, now = _user_stamp(user), _now_utc()
    marked, skipped_locked, already = [], 0, 0
    batch = db.batch()
    for s in staff:
        sid = s["id"]
        if _locked(sid):
            skipped_locked += 1
            continue
        shifts = VALID_SHIFTS if s.get("is_dual_shift") else (None,)
        newly_marked = False
        for shift in shifts:
            if (sid, shift) in existing:
                continue
            newly_marked = True
            doc = {"staff_id": sid, "date": date, "status": ledger.STATUS_FULL,
                   "marked_by": stamp, "marked_at": now}
            if shift:
                doc["shift"] = shift
            doc_id = _attendance_doc_id(sid, date, shift)
            batch.set(_att_ref().document(doc_id), doc)
            doc["id"] = doc_id
            marked.append(doc)
        if not newly_marked:
            already += 1
    if marked:
        batch.commit()
    return {"marked": marked, "already_marked": already,
            "skipped_locked": skipped_locked}


# ═══════════════════════════════════════════════════════════════════════════
# Advances & salary payments — reads
# ═══════════════════════════════════════════════════════════════════════════

def advances_for(staff_id: str) -> list:
    q = _adv_ref().where(filter=FieldFilter("staff_id", "==", staff_id))
    out = [_doc_with_id(s) for s in q.stream()]
    out.sort(key=lambda a: (a.get("date") or "", a.get("created_at") or ""))
    return out


def salary_payments_for(staff_id: str) -> list:
    q = _sal_ref().where(filter=FieldFilter("staff_id", "==", staff_id))
    out = [_doc_with_id(s) for s in q.stream()]
    out.sort(key=lambda p: p.get("period_start") or "")
    return out


def outstanding_advance(staff_id: str) -> int:
    return ledger.outstanding_advance(advances_for(staff_id),
                                      salary_payments_for(staff_id))


def paid_periods_by_staff() -> dict:
    """
    {staff_id: [{"start", "end"}, …]} for every settled salary period —
    one collection scan, so the attendance grid can lock paid days across
    ALL staff without a per-staff query fan-out. The collection stays tiny
    (staff × pay cycles), so no range filtering is needed.
    """
    out: dict = {}
    for snap in _sal_ref().stream():
        p = snap.to_dict() or {}
        sid = p.get("staff_id")
        ps, pe = p.get("period_start"), p.get("period_end")
        if not sid or not (_valid_date(ps) and _valid_date(pe)):
            continue
        out.setdefault(sid, []).append({
            "start": ps, "end": pe,
            # Days this payment skipped (paid earlier by another payment) —
            # they are NOT locked by this one.
            "excluded": sorted(p.get("excluded_dates") or []),
        })
    return out


# ═══════════════════════════════════════════════════════════════════════════
# Expense-collection linkage helpers
# ═══════════════════════════════════════════════════════════════════════════

def _validate_money_source(payment_method: str, expense_type: str):
    if payment_method not in VALID_METHODS:
        raise ValueError("payment_method must be cash or online.")
    if expense_type not in VALID_EXPENSE_TYPES:
        raise ValueError("expense_type must be transaction or report.")


def _counter_increment(batch, amount: int):
    """Stage the totals/current_totals.expenses increment on the batch —
    mirrors routes/reports.py::add_expense. Signed: negative reverses."""
    if amount:
        batch.set(totals_ref.document("current_totals"),
                  {"expenses": fa_firestore.Increment(amount)}, merge=True)


# ═══════════════════════════════════════════════════════════════════════════
# Advances — give / delete
# ═══════════════════════════════════════════════════════════════════════════

def create_advance(staff_id: str, amount, date: str, payment_method: str,
                   expense_type: str, note: str, user: Optional[dict],
                   opening: bool = False) -> dict:
    """
    Record an advance: ONE atomic batch writes the advance doc, the linked
    expense doc, and (for counter-cash) the totals increment — an advance
    can never exist without its expense row or vice versa.

    opening=True records an OPENING BALANCE from the paper books — an
    advance handed out before the software existed. Only the advance doc
    is written: no linked expense row, no counter touch, so today's
    counter, expense reports and banking stay clean while the outstanding
    balance (and future salary deductions) include it. Admin-only,
    enforced in routes/staff.py.

    Returns {advance, expense} (expense includes _doc_id for the
    transaction log's smooth-insert; expense is None for opening entries).
    """
    staff = get_staff(staff_id)
    if not staff:
        raise ValueError("Staff member not found.")
    if not staff.get("active", True):
        raise ValueError("This staff member is inactive.")
    try:
        amt = int(round(float(amount)))
    except (TypeError, ValueError):
        raise ValueError("Advance amount must be a number.")
    if amt <= 0:
        raise ValueError("Advance amount must be above zero.")
    if amt > MAX_ADVANCE:
        raise ValueError("Advance amount looks too large — check it.")
    date = str(date or "").strip() or _ist_today()
    if not _valid_date(date):
        raise ValueError("Date must be YYYY-MM-DD.")
    if date > _ist_today():
        raise ValueError("An advance cannot be dated in the future.")
    if not opening:
        _validate_money_source(payment_method, expense_type)
    note = str(note or "").strip()[:120]
    name = staff.get("name", "")

    # ── Opening balance (from the physical books) ────────────────────────
    # The ledger derives the outstanding advance from raw advance docs
    # (amounts only), so a books-only advance participates in salary
    # deductions exactly like a normal one. delete_advance already
    # tolerates a missing expense_doc_id.
    if opening:
        adv_doc = {
            "staff_id": staff_id,
            "staff_name": name,
            "date": date,
            "amount": amt,
            "note": note,
            "payment_method": "books",
            "expense_type": "opening",
            "opening": True,
            "created_at": _now_utc(),
            "created_by": _user_stamp(user),
        }
        adv_ref = _adv_ref().document()
        adv_ref.set(adv_doc)
        adv_doc["id"] = adv_ref.id
        logger.info("staff: OPENING advance ₹%s recorded for %s (%s) from books",
                    amt, name, staff_id)
        return {"advance": adv_doc, "expense": None}

    desc = "Staff Advance — {}".format(name)
    if note:
        desc += " ({})".format(note)

    expense_doc = {
        "date": date,
        "time": _ist_time(),
        "category": "staff_advance",
        "description": desc,
        "amount": amt,
        "payment_method": payment_method,
        "expense_type": expense_type,
        "paid_to": name,
        "staff_advance": True,          # marker: managed by the Staff module
        "staff_id": staff_id,
        "staff_name": name,
        "created_at": _now_utc(),
        "created_by": _user_stamp(user),   # audit: who gave it
    }
    adv_doc = {
        "staff_id": staff_id,
        "staff_name": name,
        "date": date,
        "amount": amt,
        "note": note,
        "payment_method": payment_method,
        "expense_type": expense_type,
        "created_at": _now_utc(),
        "created_by": _user_stamp(user),
    }

    exp_ref = _expenses_ref().document()
    adv_ref = _adv_ref().document()
    adv_doc["expense_doc_id"] = exp_ref.id
    # Back-link, the mirror of expense_doc_id above. The Transactions tab
    # holds an expense row and needs the advance that owns it; without this
    # the only route back was a collection query. Salary and meal expenses
    # have carried salary_payment_id / meal_log_id from the start.
    expense_doc["advance_id"] = adv_ref.id

    batch = db.batch()
    batch.set(exp_ref, expense_doc)
    batch.set(adv_ref, adv_doc)
    if expense_type == "transaction":
        _counter_increment(batch, amt)
    batch.commit()

    adv_doc["id"] = adv_ref.id
    expense_doc["_doc_id"] = exp_ref.id
    logger.info("staff: advance ₹%s to %s (%s) via %s/%s",
                amt, name, staff_id, payment_method, expense_type)
    return {"advance": adv_doc, "expense": expense_doc}


def delete_advance(advance_id: str) -> dict:
    """
    Remove an advance AND its linked expense row atomically, reversing the
    cash counter when needed. Refused when the advance was already (even
    partially) recovered — the outstanding balance must never go negative.
    """
    snap = _adv_ref().document(advance_id).get()
    if not snap.exists:
        raise ValueError("Advance not found.")
    adv = _doc_with_id(snap)
    staff_id = adv.get("staff_id", "")

    remaining = [a for a in advances_for(staff_id) if a["id"] != advance_id]
    if ledger.outstanding_advance(remaining,
                                  salary_payments_for(staff_id)) < 0:
        raise ValueError(
            "This advance was already deducted in a salary payment — "
            "delete that salary payment first.")

    batch = db.batch()
    batch.delete(_adv_ref().document(advance_id))
    exp_id = adv.get("expense_doc_id")
    reversal = 0
    if exp_id:
        exp_snap = _expenses_ref().document(exp_id).get()
        if exp_snap.exists:
            exp = exp_snap.to_dict() or {}
            batch.delete(_expenses_ref().document(exp_id))
            if exp.get("expense_type") == "transaction":
                reversal = int(exp.get("amount", 0) or 0)
    if reversal:
        _counter_increment(batch, -reversal)
    batch.commit()
    logger.info("staff: advance %s deleted (₹%s, counter reversal ₹%s)",
                advance_id, adv.get("amount"), reversal)
    return adv


# ═══════════════════════════════════════════════════════════════════════════
# Salary — preview / pay / delete
# ═══════════════════════════════════════════════════════════════════════════

def salary_preview(staff_id: str, period_start: str, period_end: str,
                   adjustment=0) -> dict:
    """
    Everything the payout screen needs, computed but NOT written:
    attendance breakdown, gross, outstanding advance, suggested deduction
    and the resulting net — plus the suggested next period start.
    """
    staff = get_staff(staff_id)
    if not staff:
        raise ValueError("Staff member not found.")
    if not (_valid_date(period_start) and _valid_date(period_end)):
        raise ValueError("Period dates must be YYYY-MM-DD.")
    if period_start > period_end:
        raise ValueError("Period start must be on or before period end.")

    attendance = attendance_range(period_start, period_end, staff_id)
    payments = salary_payments_for(staff_id)
    # Days an earlier payment already covered are simply SKIPPED — they
    # earn nothing here and never block the rest of the period.
    covered = ledger.covered_dates(period_start, period_end, payments)
    # Days nobody has marked attendance for. They earn nothing, and crucially
    # they must NOT be consumed by this payout — see ledger.unmarked_dates.
    # Kept disjoint from `covered` so the payout screen can name each group.
    unmarked = ledger.unmarked_dates(period_start, period_end, attendance,
                                     exclude=covered)
    skipped = covered | unmarked
    computed = ledger.compute_salary(staff.get("daily_wage", 0), attendance,
                                     period_start, period_end, adjustment,
                                     exclude=skipped)
    outstanding = max(0, ledger.outstanding_advance(
        advances_for(staff_id), payments))
    payable = computed["payable_before_advance"]
    # Meals for the same days the salary covers. Not optional the way the
    # advance deduction is: if the staff member eats here, the food has
    # already been consumed by the time payday arrives. The UI shows it as a
    # fixed line, not an editable one.
    meals = ledger.compute_meals(staff.get("meal_rate", 0), attendance,
                                 period_start, period_end, exclude=skipped)
    # Advance recovery has to fit in what is left after meals, otherwise the
    # payout would go negative.
    suggested_deduction = min(outstanding,
                              max(0, payable - meals["meal_total"]))
    excluded_days = sorted(covered)
    unmarked_days = sorted(unmarked)
    all_covered = bool(covered) and all(
        d in covered
        for d in ledger._dates_between(period_start, period_end))
    return {
        "staff": staff,
        "period_start": period_start,
        "period_end": period_end,
        "computed": computed,
        "meals": meals,
        "meal_deduction": meals["meal_total"],
        "outstanding_advance": outstanding,
        "suggested_deduction": suggested_deduction,
        "net_if_suggested": payable - suggested_deduction - meals["meal_total"],
        "excluded_days": excluded_days,       # already-paid days, skipped
        # Same census the payment doc will carry, so the payout screen and
        # the ledger row cannot disagree about the period.
        "period_breakdown": ledger.period_breakdown(
            attendance, period_start, period_end,
            covered=covered, unmarked=unmarked),
        # Days with no attendance record. Skipped and worth ₹0, but unlike
        # excluded_days they are NOT settled — they stay unlocked and remain
        # payable once someone marks them. Surfaced so the payout screen can
        # warn before the operator hands over a short period.
        "unmarked_days": unmarked_days,
        "all_days_unmarked": bool(unmarked_days) and not excluded_days
                             and computed["marked_days"] == 0,
        "all_days_paid": all_covered,
        "suggested_period_start": ledger.suggest_period_start(payments),
    }


def pay_salary(staff_id: str, period_start: str, period_end: str,
               advance_deduction, adjustment, adjustment_note: str,
               payment_method: str, expense_type: str,
               user: Optional[dict], paid_on: Optional[str] = None) -> dict:
    # NOTE: the meal deduction is intentionally NOT a parameter. It is
    # derived from the staff record's meal_rate and the period's attendance
    # — see the `meals` block below.
    """
    Settle one salary period. Validates via the ledger (overlap guard,
    deduction bounds), then ONE atomic batch writes the salary-payment
    doc, the linked expense row for the net amount actually paid out, and
    the counter increment. net_paid == 0 (salary fully consumed by the
    advance) writes no expense row — no money left the till.
    """
    staff = get_staff(staff_id)
    if not staff:
        raise ValueError("Staff member not found.")
    _validate_money_source(payment_method, expense_type)

    valid_range = _valid_date(period_start) and _valid_date(period_end)
    attendance = attendance_range(period_start, period_end, staff_id) \
        if valid_range else []
    payments = salary_payments_for(staff_id)
    outstanding = max(0, ledger.outstanding_advance(
        advances_for(staff_id), payments))
    covered = ledger.covered_dates(period_start, period_end, payments) \
        if valid_range else set()
    # Days with no attendance record. A payout must not consume them: they
    # earn ₹0, and if this payment claimed to cover them they would be locked
    # against later marking AND skipped as "already paid" by the next payout,
    # so the staff member would never be paid for the day at all. Treated the
    # same way as already-covered days — skipped here, still open afterwards.
    unmarked = ledger.unmarked_dates(period_start, period_end, attendance,
                                     exclude=covered) if valid_range else set()
    skipped = covered | unmarked
    computed = ledger.compute_salary(staff.get("daily_wage", 0), attendance,
                                     period_start, period_end, adjustment,
                                     exclude=skipped)
    # Meals are computed server-side from the staff member's rate and the
    # same attendance the salary used. The client never sends the amount —
    # it is not a number an operator should be able to talk down at the
    # counter, and it has to agree with what the meal log bills.
    meals = ledger.compute_meals(staff.get("meal_rate", 0), attendance,
                                 period_start, period_end, exclude=skipped)
    err = ledger.validate_payment(period_start, period_end, computed,
                                  advance_deduction, outstanding, payments,
                                  _ist_today(), covered=covered,
                                  meal_deduction=meals["meal_total"])
    if err:
        raise ValueError(err)

    final = ledger.settlement(computed, advance_deduction, outstanding,
                              meal_deduction=meals["meal_total"])
    name = staff.get("name", "")
    today = _ist_today()
    # The day the money actually left the counter. Distinct from the period
    # being settled: a week's wages are often handed over a day or two later,
    # and the expense has to land on the day the drawer was short, not on
    # whatever day the operator got round to recording it.
    paid_on = str(paid_on or "").strip() or today
    if not _valid_date(paid_on):
        raise ValueError("Payment date must be YYYY-MM-DD.")
    if paid_on > today:
        raise ValueError("Payment date cannot be in the future.")

    sal_ref = _sal_ref().document()
    sal_doc = {
        "staff_id": staff_id,
        "staff_name": name,
        "period_start": period_start,
        "period_end": period_end,
        "full_days": computed["full_days"],
        "half_days": computed["half_days"],
        "days_worked": computed["days_worked"],
        "daily_wage": computed["daily_wage"],
        "gross": final["gross"],
        "adjustment": final["adjustment"],
        "adjustment_note": str(adjustment_note or "").strip()[:120],
        "advance_deducted": final["advance_deducted"],
        "meal_rate": meals["meal_rate"],
        "meal_days": meals["meal_days"],
        "meal_deducted": final["meal_deducted"],
        "net_paid": final["net_paid"],
        # Days inside the period this payment did NOT pay for, so locks and
        # future coverage checks know exactly who paid what. Two reasons a
        # day lands here, and both must be excluded or the day is silently
        # lost:
        #   * an EARLIER payment already covered it;
        #   * nobody marked attendance for it, so there was nothing to pay.
        # Stored as one field because payment_covers/covered_dates only care
        # THAT the day is unpaid. The reason is kept separately below for the
        # ledger UI and for anyone auditing a payout after the fact.
        "excluded_dates": sorted(skipped),
        "unmarked_dates": sorted(unmarked),
        # Calendar-day census of the period: present / absent / carried /
        # unmarked, summing to the length of the period. Written here, at pay
        # time, because this is the only moment the attendance for the period
        # is already in hand. Deriving it later would mean re-reading
        # attendance once per ledger row, which is exactly the read pattern
        # the Staff screen is trying to avoid. Payments written before this
        # field existed simply lack it and the ledger reconstructs an
        # approximation from full_days/half_days.
        "period_breakdown": ledger.period_breakdown(
            attendance, period_start, period_end,
            covered=covered, unmarked=unmarked),
        "payment_method": payment_method,
        "expense_type": expense_type,
        "expense_doc_id": None,
        "paid_on": paid_on,
        "paid_at": _now_utc(),
        "paid_by": _user_stamp(user),
    }

    batch = db.batch()
    expense_doc = None
    if final["net_paid"] > 0:
        desc = "Salary — {} ({} to {})".format(
            name, _dmy(period_start), _dmy(period_end))
        if covered:
            desc += " · {} already-paid day{} skipped".format(
                len(covered), "s" if len(covered) != 1 else "")
        if unmarked:
            desc += " · {} unmarked day{} skipped".format(
                len(unmarked), "s" if len(unmarked) != 1 else "")
        if final["advance_deducted"]:
            desc += " · advance ₹{} deducted".format(final["advance_deducted"])
        if final["meal_deducted"]:
            desc += " · meals ₹{} ({} day{}) withheld".format(
                final["meal_deducted"], meals["meal_days"],
                "s" if meals["meal_days"] != 1 else "")
        expense_doc = {
            "date": paid_on,
            "time": _ist_time(),
            "category": "salary",
            "description": desc,
            "amount": final["net_paid"],
            "payment_method": payment_method,
            "expense_type": expense_type,
            "paid_to": name,
            "staff_salary_payment": True,   # marker: managed by Staff module
            "staff_id": staff_id,
            "staff_name": name,
            "salary_payment_id": sal_ref.id,
            "created_at": _now_utc(),
            "created_by": _user_stamp(user),   # audit: who paid it
        }
        exp_ref = _expenses_ref().document()
        sal_doc["expense_doc_id"] = exp_ref.id
        batch.set(exp_ref, expense_doc)
        if expense_type == "transaction":
            _counter_increment(batch, final["net_paid"])
    batch.set(sal_ref, sal_doc)
    batch.commit()

    sal_doc["id"] = sal_ref.id
    if expense_doc is not None:
        expense_doc["_doc_id"] = sal_doc["expense_doc_id"]
    logger.info(
        "staff: salary paid %s (%s) %s–%s days=%s gross=₹%s adv−₹%s "
        "meals−₹%s net=₹%s",
        name, staff_id, period_start, period_end, computed["days_worked"],
        final["gross"], final["advance_deducted"], final["meal_deducted"],
        final["net_paid"])
    return {"payment": sal_doc, "expense": expense_doc,
            "advance_remaining": final["advance_remaining"],
            "meals": meals}


def delete_salary_payment(payment_id: str) -> dict:
    """
    Reverse a salary payout: delete the payment doc and its linked expense
    row atomically, reversing the counter. Any advance that the payment
    had deducted automatically becomes outstanding again (the balance is
    always derived, never stored).
    """
    snap = _sal_ref().document(payment_id).get()
    if not snap.exists:
        raise ValueError("Salary payment not found.")
    pay = _doc_with_id(snap)

    batch = db.batch()
    batch.delete(_sal_ref().document(payment_id))
    exp_id = pay.get("expense_doc_id")
    reversal = 0
    if exp_id:
        exp_snap = _expenses_ref().document(exp_id).get()
        if exp_snap.exists:
            exp = exp_snap.to_dict() or {}
            batch.delete(_expenses_ref().document(exp_id))
            if exp.get("expense_type") == "transaction":
                reversal = int(exp.get("amount", 0) or 0)
    if reversal:
        _counter_increment(batch, -reversal)
    batch.commit()
    logger.info("staff: salary payment %s deleted (net ₹%s, reversal ₹%s)",
                payment_id, pay.get("net_paid"), reversal)
    return pay


# ═══════════════════════════════════════════════════════════════════════════
# Meals — preview / log / delete
#
# A staff member who eats at the lodge is charged a flat per-day rate
# (staff.meal_rate). Two things follow from that, and they are deliberately
# separate operations:
#
#   * pay_salary() withholds the meal charge for the days it pays, so the
#     cash handed over is the reduced figure (₹300/day, not ₹350/day).
#   * log_meals() records the matching COST — the food the kitchen actually
#     supplied — as one expense row covering a range of days. In practice
#     this is done once a week, after the fact, which is exactly why it is
#     not welded to the salary payout.
#
# Together they add back up to the staff member's true daily rate.
#
# Double-logging is prevented the same way double-paying is: each log stores
# the exact dates it charged for, and a new log skips any date an earlier
# log already covered. Because the stored set is exact dates (not a range),
# a day the staff member was absent on stays available — if attendance is
# corrected later, a subsequent log picks it up.
# ═══════════════════════════════════════════════════════════════════════════

def meal_logs_for(staff_id: str) -> list:
    q = _meal_ref().where(filter=FieldFilter("staff_id", "==", staff_id))
    out = [_doc_with_id(s) for s in q.stream()]
    out.sort(key=lambda m: (m.get("period_start") or "",
                            m.get("created_at") or ""))
    return out


def meal_preview(staff_id: str, period_start: str, period_end: str) -> dict:
    """
    What log_meals() would charge for this range, computed but NOT written.
    """
    staff = get_staff(staff_id)
    if not staff:
        raise ValueError("Staff member not found.")
    if not (_valid_date(period_start) and _valid_date(period_end)):
        raise ValueError("Period dates must be YYYY-MM-DD.")
    if period_start > period_end:
        raise ValueError("Period start must be on or before period end.")

    rate = int(staff.get("meal_rate") or 0)
    attendance = attendance_range(period_start, period_end, staff_id)
    already = ledger.logged_meal_dates(period_start, period_end,
                                       meal_logs_for(staff_id))
    meals = ledger.compute_meals(rate, attendance, period_start, period_end,
                                 exclude=already)
    return {
        "staff": staff,
        "period_start": period_start,
        "period_end": period_end,
        "meal_rate": rate,
        "meals": meals,
        "already_logged_days": sorted(already),
        "has_meal_rate": rate > 0,
    }


def log_meals(staff_id: str, period_start: str, period_end: str,
              payment_method: str, expense_type: str, note: str,
              user: Optional[dict]) -> dict:
    """
    Record the meal cost for [period_start, period_end] as ONE expense.

    One atomic batch writes the meal-log doc, the linked expense row and the
    counter increment — the same shape as an advance or a salary payout, so
    a meal log can never end up in the books without its expense row (or
    vice versa).

    The rate comes from the staff record, never from the caller: the amount
    has to agree with what pay_salary() withheld, and letting the client
    send a figure is how those two drift apart.
    """
    staff = get_staff(staff_id)
    if not staff:
        raise ValueError("Staff member not found.")
    _validate_money_source(payment_method, expense_type)
    if not (_valid_date(period_start) and _valid_date(period_end)):
        raise ValueError("Period dates must be YYYY-MM-DD.")
    if period_start > period_end:
        raise ValueError("Period start must be on or before period end.")
    if period_end > _ist_today():
        raise ValueError("Period cannot extend into the future.")

    rate = int(staff.get("meal_rate") or 0)
    if rate <= 0:
        raise ValueError(
            "{} has no meal rate set. Add a per-day meal rate on their "
            "staff record first.".format(staff.get("name", "This staff member")))

    attendance = attendance_range(period_start, period_end, staff_id)
    already = ledger.logged_meal_dates(period_start, period_end,
                                       meal_logs_for(staff_id))
    meals = ledger.compute_meals(rate, attendance, period_start, period_end,
                                 exclude=already)
    if meals["meal_days"] <= 0:
        if already:
            raise ValueError(
                "Every present day in {} – {} is already logged.".format(
                    period_start, period_end))
        raise ValueError(
            "No days marked present in {} – {} — nothing to charge.".format(
                period_start, period_end))

    name = staff.get("name", "")
    today = _ist_today()
    log_ref = _meal_ref().document()
    desc = "Staff meals — {} ({} day{} × ₹{}, {} to {})".format(
        name, meals["meal_days"], "s" if meals["meal_days"] != 1 else "",
        rate, _dmy(period_start), _dmy(period_end))
    if already:
        desc += " · {} already-logged day{} skipped".format(
            len(already), "s" if len(already) != 1 else "")

    log_doc = {
        "staff_id": staff_id,
        "staff_name": name,
        "period_start": period_start,
        "period_end": period_end,
        "meal_rate": rate,
        "meal_days": meals["meal_days"],
        # The exact days charged. This is what makes the double-log guard
        # precise rather than a range overlap test.
        "meal_dates": meals["meal_dates"],
        "skipped_dates": sorted(already),
        "amount": meals["meal_total"],
        "note": str(note or "").strip()[:120],
        "payment_method": payment_method,
        "expense_type": expense_type,
        "expense_doc_id": None,
        "logged_on": today,
        "created_at": _now_utc(),
        "created_by": _user_stamp(user),
    }

    expense_doc = {
        "date": today,
        "time": _ist_time(),
        "category": "staff_meals",
        "description": desc + ((" · " + log_doc["note"]) if log_doc["note"] else ""),
        "amount": meals["meal_total"],
        "payment_method": payment_method,
        "expense_type": expense_type,
        "paid_to": name,
        "staff_meal_log": True,          # marker: managed by Staff module
        "staff_id": staff_id,
        "staff_name": name,
        "meal_log_id": log_ref.id,
        "created_at": _now_utc(),
        "created_by": _user_stamp(user),
    }

    batch = db.batch()
    exp_ref = _expenses_ref().document()
    log_doc["expense_doc_id"] = exp_ref.id
    batch.set(exp_ref, expense_doc)
    batch.set(log_ref, log_doc)
    if expense_type == "transaction":
        _counter_increment(batch, meals["meal_total"])
    batch.commit()

    log_doc["id"] = log_ref.id
    expense_doc["_doc_id"] = exp_ref.id
    logger.info("staff: meals logged %s (%s) %s–%s days=%s ₹%s",
                name, staff_id, period_start, period_end,
                meals["meal_days"], meals["meal_total"])
    return {"meal_log": log_doc, "expense": expense_doc}


def delete_meal_log(log_id: str) -> dict:
    """
    Reverse a meal log: delete the log doc and its linked expense row
    atomically, reversing the counter. The days it covered become available
    to log again.
    """
    snap = _meal_ref().document(log_id).get()
    if not snap.exists:
        raise ValueError("Meal log not found.")
    log = _doc_with_id(snap)

    batch = db.batch()
    exp_id = log.get("expense_doc_id")
    if exp_id:
        batch.delete(_expenses_ref().document(exp_id))
        if log.get("expense_type") == "transaction":
            _counter_increment(batch, -int(log.get("amount") or 0))
    batch.delete(_meal_ref().document(log_id))
    batch.commit()
    logger.info("staff: meal log %s deleted (%s, ₹%s)",
                log_id, log.get("staff_name"), log.get("amount"))
    return log


# ═══════════════════════════════════════════════════════════════════════════
# Payroll rows seen from the Transactions tab — resolve, amend
# ═══════════════════════════════════════════════════════════════════════════
#
# Every payroll payout writes two documents in one batch: the payroll record
# (advance / salary payment / meal log) and an `expenses` row, linked both
# ways. The Transactions tab lists the expense side, so acting on a row there
# means finding the payroll record that owns it and changing BOTH, or the
# outstanding-advance arithmetic and the cash counter drift apart.
#
# routes/reports.py refuses to edit or delete these rows through the generic
# expense endpoints for exactly that reason. It stays refusing: the functions
# below are the one door, and they go through the payroll record first.
#
# What may be amended is not the same for all three, and the line is drawn at
# money that was DERIVED:
#
#   advance    an amount somebody chose. Amount, date, note and money source
#              are all correctable.
#   salary     gross = days worked x wage, net = gross + adjustment - advance
#              - meals, and period_start/period_end decide which attendance
#              days the payment marks as paid. None of that can be retyped
#              here without the figures ceasing to be re-derivable, so only
#              the payment details move: when it was paid, from where, and
#              the note. Changing the money means reversing the payout and
#              paying again, which recomputes it from attendance.
#   meals      amount = days present x meal rate, over a fixed set of dates.
#              Same rule as salary: details yes, money no.

_ADVANCE_EDITABLE = ("amount", "date", "note", "payment_method", "expense_type")
_SALARY_EDITABLE = ("paid_on", "payment_method", "expense_type",
                    "adjustment_note")
_MEAL_EDITABLE = ("logged_on", "payment_method", "expense_type", "note")

# Fields whose value is computed from attendance. Named individually so the
# refusal can say which one was sent rather than "something is not editable".
_DERIVED_FIELDS = (
    "amount", "net_paid", "gross", "adjustment", "advance_deducted",
    "meal_deducted", "days_worked", "full_days", "half_days",
    "period_start", "period_end", "meal_dates", "meal_days", "meal_rate",
)

_REPAY_HINT = ("Reverse the payment and pay again — the amount is worked out "
               "from attendance, so it has to be recomputed, not retyped.")
_RELOG_HINT = ("Delete the meal log and log the days again — the amount is "
               "the days present times the meal rate.")


def _payroll_kinds():
    """(kind, id field on the expense row, marker field, collection ref)."""
    return (
        ("advance", "advance_id", "staff_advance", _adv_ref),
        ("salary", "salary_payment_id", "staff_salary_payment", _sal_ref),
        ("meals", "meal_log_id", "staff_meal_log", _meal_ref),
    )


def payroll_record_for_expense(expense_doc_id: str) -> Optional[dict]:
    """The payroll record behind one Transactions-tab expense row.

    Returns None when the row is an ordinary expense — that is the answer,
    not an error, and it is what tells the caller to use the normal expense
    actions instead.

    Resolution is two hops. The id stamped on the expense row when it was
    written is the fast path. Advances recorded before that stamp existed
    fall back to a query on the payroll collection for expense_doc_id ==
    this row, which is a single-field equality and needs no index.
    """
    if not expense_doc_id:
        return None
    snap = _expenses_ref().document(expense_doc_id).get()
    if not snap.exists:
        raise ValueError("That expense row no longer exists — refresh.")
    exp = snap.to_dict() or {}
    exp["_doc_id"] = expense_doc_id

    for kind, id_field, marker, ref in _payroll_kinds():
        if not (exp.get(marker) or exp.get(id_field)):
            continue
        rec = None
        rec_id = exp.get(id_field)
        if rec_id:
            rec_snap = ref().document(str(rec_id)).get()
            if rec_snap.exists:
                rec = _doc_with_id(rec_snap)
        if rec is None:
            # Legacy row, or the payroll doc was removed without its expense.
            found = list(ref().where(
                filter=FieldFilter("expense_doc_id", "==", expense_doc_id)
            ).limit(1).stream())
            if found:
                rec = _doc_with_id(found[0])
        if rec is None:
            raise ValueError(
                "This row is linked to Staff payroll but its payroll record "
                "is missing. Delete it from the Staff ledger.")
        return {
            "kind": kind,
            "id": rec["id"],
            "staff_id": rec.get("staff_id", "") or exp.get("staff_id", ""),
            "staff_name": rec.get("staff_name", "") or exp.get("staff_name", ""),
            "record": rec,
            "expense": exp,
            "editable": list({"advance": _ADVANCE_EDITABLE,
                              "salary": _SALARY_EDITABLE,
                              "meals": _MEAL_EDITABLE}[kind]),
            "locked_hint": {"advance": "",
                            "salary": _REPAY_HINT,
                            "meals": _RELOG_HINT}[kind],
        }
    return None


def _reject_derived(fields: dict, hint: str):
    """Refuse an attempt to retype a figure that is computed."""
    sent = [k for k in _DERIVED_FIELDS if k in fields]
    if sent:
        raise ValueError("{} cannot be changed here. {}".format(
            sent[0].replace("_", " ").capitalize(), hint))


def _money_source_changes(fields: dict, rec: dict) -> dict:
    """Validated payment_method / expense_type, or {} when neither was sent."""
    if "payment_method" not in fields and "expense_type" not in fields:
        return {}
    method = str(fields.get("payment_method",
                            rec.get("payment_method", "cash")) or "")
    etype = str(fields.get("expense_type",
                           rec.get("expense_type", "transaction")) or "")
    _validate_money_source(method, etype)
    return {"payment_method": method, "expense_type": etype}


def _edit_stamp(user: Optional[dict]) -> dict:
    return {"updated_at": _now_utc(), "updated_by": _user_stamp(user)}


def _stage_expense_side(batch, expense_doc_id, updates, new_amount, new_type):
    """Stage the linked expense row's update and correct the cash counter.

    totals/current_totals.expenses holds only rows whose expense_type is
    "transaction" — money that left the counter. An edit can move the amount,
    the type, or both, so the correction is what the row contributes now minus
    what it contributed before. Taking the amount difference alone would leave
    the counter carrying a row that has since become an account payment.

    The old figures are read from the EXPENSE row rather than the payroll
    record: the counter was incremented from that row, and on a stay where
    the two ever disagree the counter has to be unwound by what went in.
    """
    if not expense_doc_id:
        return
    exp_snap = _expenses_ref().document(expense_doc_id).get()
    if not exp_snap.exists:
        # Nothing to update and nothing in the counter to correct: this
        # payroll record's expense row is already gone.
        return
    exp = exp_snap.to_dict() or {}
    if updates:
        batch.update(_expenses_ref().document(expense_doc_id), updates)
    before = int(exp.get("amount", 0) or 0) if \
        exp.get("expense_type") == "transaction" else 0
    after = int(new_amount or 0) if new_type == "transaction" else 0
    _counter_increment(batch, after - before)


def update_advance(advance_id: str, fields: dict,
                   user: Optional[dict] = None) -> dict:
    """
    Correct an advance and its linked expense row in one batch.

    Refused when the new amount is below what salary payments have already
    recovered from it. The outstanding advance is derived from the raw
    advance and deduction history, never stored, so cutting an advance under
    what was deducted makes the balance negative — which reads on the Staff
    screen as the business owing the staff member money it does not.
    """
    fields = dict(fields or {})
    snap = _adv_ref().document(advance_id).get()
    if not snap.exists:
        raise ValueError("Advance not found.")
    adv = _doc_with_id(snap)
    is_opening = bool(adv.get("opening"))

    changes = {}
    amount = int(adv.get("amount", 0) or 0)
    if "amount" in fields:
        try:
            amount = int(round(float(fields["amount"])))
        except (TypeError, ValueError):
            raise ValueError("Advance amount must be a number.")
        if amount <= 0:
            raise ValueError("Advance amount must be above zero.")
        if amount > MAX_ADVANCE:
            raise ValueError("Advance amount looks too large — check it.")
        changes["amount"] = amount

    date = str(adv.get("date") or "")
    if "date" in fields:
        date = str(fields["date"] or "").strip()
        if not _valid_date(date):
            raise ValueError("Date must be YYYY-MM-DD.")
        if date > _ist_today():
            raise ValueError("An advance cannot be dated in the future.")
        changes["date"] = date

    note = str(adv.get("note") or "")
    if "note" in fields:
        note = str(fields["note"] or "").strip()[:120]
        changes["note"] = note

    source = {}
    if is_opening:
        # An opening balance came off the paper books: no expense row was
        # written and no cash moved, so there is no money source to set.
        if "payment_method" in fields or "expense_type" in fields:
            raise ValueError(
                "An opening balance was carried over from the books, so it "
                "has no payment method.")
    else:
        source = _money_source_changes(fields, adv)
        changes.update(source)

    if not changes:
        raise ValueError("Nothing to change.")

    staff_id = adv.get("staff_id", "")
    probe = [a for a in advances_for(staff_id) if a.get("id") != advance_id]
    probe.append(dict(adv, **changes))
    if ledger.outstanding_advance(probe, salary_payments_for(staff_id)) < 0:
        raise ValueError(
            "₹{} is less than what has already been deducted from this "
            "advance in a salary payment. Reverse that payment first, then "
            "change the advance.".format(amount))

    changes.update(_edit_stamp(user))

    batch = db.batch()
    batch.update(_adv_ref().document(advance_id), changes)

    exp_id = None if is_opening else adv.get("expense_doc_id")
    if exp_id:
        desc = "Staff Advance — {}".format(adv.get("staff_name", ""))
        if note:
            desc += " ({})".format(note)
        exp_updates = {"amount": amount, "date": date, "description": desc}
        exp_updates.update(source)
        exp_updates.update(_edit_stamp(user))
        _stage_expense_side(
            batch, exp_id, exp_updates, amount,
            source.get("expense_type", adv.get("expense_type", "transaction")))
    batch.commit()

    out = dict(adv, **changes)
    logger.info("staff: advance %s edited (%s) -> ₹%s on %s via %s/%s",
                advance_id, adv.get("staff_name"), amount, date,
                out.get("payment_method"), out.get("expense_type"))
    return out


def update_salary_payment(payment_id: str, fields: dict,
                          user: Optional[dict] = None) -> dict:
    """
    Correct a settled payout's payment DETAILS: the date the money left, the
    source it left from, and the adjustment note.

    Every figure on a payout is derived — see _DERIVED_FIELDS and the block
    comment above — so an attempt to send one is refused with the reversal
    route rather than quietly ignored. Changing paid_on moves the expense row
    to that day in the cash book, which is the point: it is how a payout
    entered on the wrong day is put right.
    """
    fields = dict(fields or {})
    _reject_derived(fields, _REPAY_HINT)

    snap = _sal_ref().document(payment_id).get()
    if not snap.exists:
        raise ValueError("Salary payment not found.")
    pay = _doc_with_id(snap)

    changes = {}
    paid_on = str(pay.get("paid_on") or "")
    if "paid_on" in fields:
        paid_on = str(fields["paid_on"] or "").strip()
        if not _valid_date(paid_on):
            raise ValueError("Payment date must be YYYY-MM-DD.")
        if paid_on > _ist_today():
            raise ValueError("A salary cannot be dated in the future.")
        changes["paid_on"] = paid_on

    if "adjustment_note" in fields:
        changes["adjustment_note"] = str(fields["adjustment_note"] or "").strip()[:120]

    source = _money_source_changes(fields, pay)
    changes.update(source)

    if not changes:
        raise ValueError("Nothing to change.")
    changes.update(_edit_stamp(user))

    batch = db.batch()
    batch.update(_sal_ref().document(payment_id), changes)

    # net_paid of 0 (a payout fully adjusted against an advance) never wrote
    # an expense row, so there is nothing on the expense side to move.
    exp_id = pay.get("expense_doc_id")
    if exp_id:
        exp_updates = {"date": paid_on}
        exp_updates.update(source)
        exp_updates.update(_edit_stamp(user))
        _stage_expense_side(
            batch, exp_id, exp_updates, int(pay.get("net_paid", 0) or 0),
            source.get("expense_type", pay.get("expense_type", "transaction")))
    batch.commit()

    out = dict(pay, **changes)
    logger.info("staff: salary payment %s edited (%s) paid_on=%s via %s/%s",
                payment_id, pay.get("staff_name"), paid_on,
                out.get("payment_method"), out.get("expense_type"))
    return out


def update_meal_log(log_id: str, fields: dict,
                    user: Optional[dict] = None) -> dict:
    """
    Correct a meal log's payment details. The amount and the days it covers
    are derived from attendance and the meal rate, so they are not editable
    here — delete the log and log the days again.
    """
    fields = dict(fields or {})
    _reject_derived(fields, _RELOG_HINT)

    snap = _meal_ref().document(log_id).get()
    if not snap.exists:
        raise ValueError("Meal log not found.")
    log = _doc_with_id(snap)

    changes = {}
    logged_on = str(log.get("logged_on") or "")
    if "logged_on" in fields:
        logged_on = str(fields["logged_on"] or "").strip()
        if not _valid_date(logged_on):
            raise ValueError("Date must be YYYY-MM-DD.")
        if logged_on > _ist_today():
            raise ValueError("A meal log cannot be dated in the future.")
        changes["logged_on"] = logged_on

    if "note" in fields:
        changes["note"] = str(fields["note"] or "").strip()[:120]

    source = _money_source_changes(fields, log)
    changes.update(source)

    if not changes:
        raise ValueError("Nothing to change.")
    changes.update(_edit_stamp(user))

    batch = db.batch()
    batch.update(_meal_ref().document(log_id), changes)
    exp_id = log.get("expense_doc_id")
    if exp_id:
        exp_updates = {"date": logged_on}
        exp_updates.update(source)
        exp_updates.update(_edit_stamp(user))
        _stage_expense_side(
            batch, exp_id, exp_updates, int(log.get("amount", 0) or 0),
            source.get("expense_type", log.get("expense_type", "transaction")))
    batch.commit()

    out = dict(log, **changes)
    logger.info("staff: meal log %s edited (%s) on %s via %s/%s",
                log_id, log.get("staff_name"), logged_on,
                out.get("payment_method"), out.get("expense_type"))
    return out


# ═══════════════════════════════════════════════════════════════════════════
# Combined payloads for the UI
# ═══════════════════════════════════════════════════════════════════════════

def staff_overview(include_inactive: bool = False,
                   include_payroll: bool = True) -> list:
    """
    The staff list enriched with what the cards show: this-month days
    worked, outstanding advance and paid-until. include_payroll=False
    strips wage/advance figures (for roles that only mark attendance).

    Performance: everything is loaded in 2-4 PARALLEL whole-collection
    reads and grouped in memory — never per-staff queries (the previous
    N+1 shape made the tab noticeably slow: 2 sequential Firestore
    round-trips for every staff member).
    """
    from concurrent.futures import ThreadPoolExecutor

    today = _ist_today()
    month_start = today[:8] + "01"

    with ThreadPoolExecutor(max_workers=4) as ex:
        f_staff = ex.submit(list_staff, include_inactive)
        f_att = ex.submit(attendance_range, month_start, today)
        f_adv = ex.submit(_all_advances) if include_payroll else None
        f_pay = ex.submit(_all_salary_payments) if include_payroll else None
        staff = f_staff.result()
        month_att = f_att.result()
        advances = f_adv.result() if f_adv else []
        payments = f_pay.result() if f_pay else []
    if not staff:
        return []

    att_by_staff: dict = {}
    for a in month_att:
        att_by_staff.setdefault(a.get("staff_id"), []).append(a)
    adv_by_staff: dict = {}
    for a in advances:
        adv_by_staff.setdefault(a.get("staff_id"), []).append(a)
    pay_by_staff: dict = {}
    for p in payments:
        pay_by_staff.setdefault(p.get("staff_id"), []).append(p)

    out = []
    for s in staff:
        sid = s["id"]
        summary = ledger.attendance_summary(
            att_by_staff.get(sid, []), month_start, today)
        row = {
            "id": sid,
            "name": s.get("name", ""),
            "designation": s.get("designation", ""),
            "phone": s.get("phone", ""),
            "active": s.get("active", True),
            "joined_date": s.get("joined_date", ""),
            "is_dual_shift": bool(s.get("is_dual_shift")),
            "month_days_worked": summary["days_worked"],
            "month_full_days": summary["full_days"],
            "month_half_days": summary["half_days"],
            "month_absent_days": summary["absent_days"],
        }
        if include_payroll:
            s_pay = pay_by_staff.get(sid, [])
            row["daily_wage"] = s.get("daily_wage", 0)
            row["meal_rate"] = int(s.get("meal_rate") or 0)
            row["notes"] = s.get("notes", "")
            row["outstanding_advance"] = max(0, ledger.outstanding_advance(
                adv_by_staff.get(sid, []), s_pay))
            row["paid_until"] = max(
                (p.get("period_end") or "" for p in s_pay), default="")
            row["suggested_period_start"] = ledger.suggest_period_start(s_pay)
        out.append(row)
    return out


def staff_detail(staff_id: str) -> dict:
    """Full ledger for one staff member (admin payroll view)."""
    staff = get_staff(staff_id)
    if not staff:
        raise ValueError("Staff member not found.")
    advances = advances_for(staff_id)
    payments = salary_payments_for(staff_id)
    return {
        "staff": staff,
        "advances": advances,
        "salary_payments": payments,
        "meal_logs": meal_logs_for(staff_id),
        "outstanding_advance": max(
            0, ledger.outstanding_advance(advances, payments)),
        "suggested_period_start": ledger.suggest_period_start(payments),
    }


# ═══════════════════════════════════════════════════════════════════════════
# Analytics & monthly register
# ═══════════════════════════════════════════════════════════════════════════

def _all_advances() -> list:
    return [_doc_with_id(s) for s in _adv_ref().stream()]


def _all_salary_payments() -> list:
    return [_doc_with_id(s) for s in _sal_ref().stream()]


def _month_add(ym: str, n: int) -> str:
    y, m = int(ym[:4]), int(ym[5:7])
    m += n
    y += (m - 1) // 12
    m = (m - 1) % 12 + 1
    return "{:04d}-{:02d}".format(y, m)


def payroll_analytics(months: int = 6, month: str = "") -> dict:
    """
    Everything the Insights tab shows for ONE month, in one payload.

    month   "YYYY-MM"; defaults to the current month. A past month is
            reported over its whole length; the current month up to today.
            A future month is refused (there is nothing to report yet).
    months  length of the cash-out trend ENDING at `month`, so the chart
            always frames the month being looked at.

    months_out  advances given plus net salaries paid per month. Advances
            count when given and salaries net of deductions, so a rupee is
            never counted twice across the two rows.
    totals  the selected month's cash-out and wages, plus advances still
            outstanding and today's present count (both are "as of now",
            not month figures, and are labelled that way in the UI).
    staff   per staff, for the selected month: attendance breakdown, rate
            over the days elapsed in it, wages EARNED (shifts x current wage,
            an estimate if the wage changed mid-month), advances taken and
            salary paid in the month, current outstanding advance and
            paid-until.

            Shifts and days are deliberately separate. Wages follow SHIFTS,
            because a day-and-night staff member who covers both is paid for
            both. Attendance follows DAYS: the staff who rotate (two weeks of
            days, two weeks of nights) work one shift a day and must read as
            100% present, not 50%, and a day with both shifts covered is one
            day present plus cover, not a 200% day.
    highlights  who did best and what needs attention, decided here so the
            table and the cards can never rank staff differently.
    """
    from calendar import monthrange
    from concurrent.futures import ThreadPoolExecutor

    months = max(1, min(int(months or 6), 24))
    today = _ist_today()
    this_month = today[:7]

    sel_month = (month or "").strip() or this_month
    try:
        datetime.strptime(sel_month + "-01", "%Y-%m-%d")
    except (TypeError, ValueError):
        raise ValueError("month must be YYYY-MM.")
    if sel_month > this_month:
        raise ValueError("That month has not started yet.")

    is_current = sel_month == this_month
    period_start = sel_month + "-01"
    if is_current:
        period_end = today
        # Days the staff could have worked so far. The denominator of every
        # attendance rate below, so a month is never judged by days that
        # have not happened.
        elapsed_days = int(today[8:10])
    else:
        elapsed_days = monthrange(int(sel_month[:4]), int(sel_month[5:7]))[1]
        period_end = "{}-{:02d}".format(sel_month, elapsed_days)

    # Independent Firestore reads run in parallel — latency, not compute,
    # dominates this endpoint.
    with ThreadPoolExecutor(max_workers=4) as ex:
        f_adv = ex.submit(_all_advances)
        f_pay = ex.submit(_all_salary_payments)
        f_att = ex.submit(attendance_range, period_start, period_end)
        f_staff = ex.submit(list_staff, False)
        advances = f_adv.result()
        payments = f_pay.result()
        month_att = f_att.result()
        _staff_pre = f_staff.result()

    # ── monthly cash-out trend, ending at the selected month ──
    month_keys = [_month_add(sel_month, -(months - 1 - i))
                  for i in range(months)]
    trend = {m: {"month": m, "advances": 0, "salaries_net": 0}
             for m in month_keys}
    for a in advances:
        m = str(a.get("date") or "")[:7]
        if m in trend:
            trend[m]["advances"] += int(a.get("amount", 0) or 0)
    for p in payments:
        m = str(p.get("paid_on") or p.get("period_end") or "")[:7]
        if m in trend:
            trend[m]["salaries_net"] += int(p.get("net_paid", 0) or 0)
    months_out = []
    for m in month_keys:
        row = trend[m]
        row["total"] = row["advances"] + row["salaries_net"]
        months_out.append(row)

    # ── per-staff stats for the selected month ──
    adv_by_staff: dict = {}
    for a in advances:
        adv_by_staff.setdefault(a.get("staff_id"), []).append(a)
    pay_by_staff: dict = {}
    for p in payments:
        pay_by_staff.setdefault(p.get("staff_id"), []).append(p)

    att_by_staff: dict = {}
    for a in month_att:
        att_by_staff.setdefault(a.get("staff_id"), []).append(a)
    today_present = sum(
        1 for a in month_att
        if a.get("date") == today and a.get("status") in ("full", "half"))

    staff_rows = []
    outstanding_total = 0
    for s in _staff_pre:
        sid = s["id"]
        rows = att_by_staff.get(sid, [])
        summary = ledger.attendance_summary(rows, period_start, period_end)
        presence = ledger.presence_summary(rows, period_start, period_end)
        outstanding = max(0, ledger.outstanding_advance(
            adv_by_staff.get(sid, []), pay_by_staff.get(sid, [])))
        outstanding_total += outstanding
        wage = int(s.get("daily_wage", 0) or 0)
        # Everyone is measured against the days in the period. A rotating
        # day/night member works one shift a day and reads 100%; whoever
        # covered a second shift shows it as double_shift_days, not as a rate
        # above 100.
        expected = elapsed_days
        staff_rows.append({
            "id": sid,
            "name": s.get("name", ""),
            "designation": s.get("designation", ""),
            "daily_wage": wage,
            "is_dual_shift": bool(s.get("is_dual_shift")),
            "full_days": summary["full_days"],
            "half_days": summary["half_days"],
            # Days the person was away, not shifts they did not take: a D
            # marked absent on a day they worked the N is cover, not an
            # absence.
            "absent_days": presence["days_absent"],
            "absent_shifts": summary["absent_days"],
            # Shifts (what wages are paid on), kept under the old key so
            # every existing caller of this payload still adds up.
            "days_worked": summary["days_worked"],
            "shifts_worked": presence["shifts_worked"],
            # Calendar days present, half days included as whole days —
            # the same count the salary ledger's census prints, so the two
            # screens cannot show different numbers for the same fortnight.
            # half_days_present keeps the detail visible; what a half day is
            # WORTH stays in days_worked.
            "days_present": presence["days_present"],
            "half_days_present": presence["half_days_present"],
            "double_shift_days": presence["double_shift_days"],
            "extra_shifts": presence["extra_shifts"],
            "expected_days": expected,
            "attendance_rate": round(
                100.0 * presence["days_present"] / expected) if expected else 0,
            "wages_earned": int(round(summary["days_worked"] * wage)),
            "advances_taken": sum(
                int(a.get("amount", 0) or 0)
                for a in adv_by_staff.get(sid, [])
                if str(a.get("date") or "")[:7] == sel_month),
            "salary_paid": sum(
                int(p.get("net_paid", 0) or 0)
                for p in pay_by_staff.get(sid, [])
                if str(p.get("paid_on") or p.get("period_end") or "")[:7] == sel_month),
            "outstanding_advance": outstanding,
            "paid_until": max(
                (p.get("period_end") or "" for p in pay_by_staff.get(sid, [])),
                default=""),
        })
    staff_rows.sort(key=lambda r: -r["days_worked"])

    # ── highlights ──
    # Ranked here rather than in the browser so the cards, the table and the
    # register can never disagree about who did best.
    def _card(row, *keys):
        if not row:
            return None
        out = {"id": row["id"], "name": row["name"],
               "designation": row.get("designation", "")}
        for k in keys:
            out[k] = row.get(k)
        return out

    worked = [r for r in staff_rows if r["days_worked"] > 0]
    # Turning up every day wins; covering an extra shift breaks the tie.
    top_att = max(
        worked,
        key=lambda r: (r["attendance_rate"], r["extra_shifts"], -r["absent_days"]),
        default=None)
    coverers = [r for r in staff_rows if r["double_shift_days"] > 0]
    top_cover = max(coverers, key=lambda r: (r["double_shift_days"],
                                             r["extra_shifts"]), default=None)
    top_earner = max(worked, key=lambda r: r["wages_earned"], default=None)
    top_advance = max(staff_rows, key=lambda r: r["outstanding_advance"],
                      default=None)
    if top_advance and top_advance["outstanding_advance"] <= 0:
        top_advance = None
    absentees = [r for r in staff_rows if r["absent_days"] > 0]
    most_absent = max(absentees, key=lambda r: r["absent_days"], default=None)
    perfect = [r for r in worked if r["absent_days"] == 0
               and r["attendance_rate"] >= 100]
    days_present_total = sum(r["days_present"] for r in staff_rows)
    days_worked_total = sum(r["days_worked"] for r in staff_rows)
    expected_total = sum(r["expected_days"] for r in staff_rows)

    this_row = trend.get(sel_month, {"advances": 0, "salaries_net": 0})
    return {
        "month": sel_month,
        "is_current_month": is_current,
        "period": {"start": period_start, "end": period_end,
                   "elapsed_days": elapsed_days},
        "months": months_out,
        "totals": {
            "outstanding_advance": outstanding_total,
            "active_staff": len(staff_rows),
            "month_cash_out": this_row["advances"] + this_row["salaries_net"],
            "month_advances": this_row["advances"],
            "month_salaries": this_row["salaries_net"],
            "month_wages_earned": sum(r["wages_earned"] for r in staff_rows),
            "days_worked": days_worked_total,
            "days_present": days_present_total,
            "half_days_present": sum(r["half_days_present"] for r in staff_rows),
            "double_shift_days": sum(r["double_shift_days"] for r in staff_rows),
            "extra_shifts": round(sum(r["extra_shifts"] for r in staff_rows), 2),
            "absent_days": sum(r["absent_days"] for r in staff_rows),
            # Days present over days available. Shifts would read over 100%
            # for a team that covers both shifts.
            "avg_attendance_rate": round(
                100.0 * days_present_total / expected_total)
                if expected_total else 0,
            "today_present": today_present if is_current else None,
            "today_total": len(staff_rows),
        },
        "highlights": {
            "top_attendance": _card(top_att, "attendance_rate", "days_present",
                                    "expected_days", "absent_days",
                                    "half_days_present", "double_shift_days"),
            "top_cover": _card(top_cover, "double_shift_days", "extra_shifts"),
            "top_earner": _card(top_earner, "wages_earned", "days_worked"),
            "top_advance": _card(top_advance, "outstanding_advance"),
            "most_absent": _card(most_absent, "absent_days", "attendance_rate"),
            "perfect_attendance": {
                "count": len(perfect),
                "names": [r["name"] for r in perfect[:3]],
            },
        },
        "staff": staff_rows,
    }


def month_register(month: str) -> dict:
    """
    The payroll register for one month ("YYYY-MM") — one row per staff
    member with any activity or currently active: attendance, wages
    earned, advances taken, salary paid and advance recovered in that
    month, plus the current outstanding. The frontend turns this into
    the downloadable CSV.
    """
    try:
        datetime.strptime(month + "-01", "%Y-%m-%d")
    except (TypeError, ValueError):
        raise ValueError("month must be YYYY-MM.")
    start = month + "-01"
    end = month + "-31"          # string bound — safe for lexicographic dates
    today = _ist_today()

    advances = _all_advances()
    payments = _all_salary_payments()
    adv_by_staff: dict = {}
    for a in advances:
        adv_by_staff.setdefault(a.get("staff_id"), []).append(a)
    pay_by_staff: dict = {}
    for p in payments:
        pay_by_staff.setdefault(p.get("staff_id"), []).append(p)

    att = attendance_range(start, end)
    att_by_staff: dict = {}
    for a in att:
        att_by_staff.setdefault(a.get("staff_id"), []).append(a)

    rows = []
    for s in list_staff(include_inactive=True):
        sid = s["id"]
        summary = ledger.attendance_summary(
            att_by_staff.get(sid, []), start, end)
        adv_month = sum(int(a.get("amount", 0) or 0)
                        for a in adv_by_staff.get(sid, [])
                        if str(a.get("date") or "").startswith(month))
        pays_month = [p for p in pay_by_staff.get(sid, [])
                      if str(p.get("paid_on") or "").startswith(month)]
        paid_net = sum(int(p.get("net_paid", 0) or 0) for p in pays_month)
        deducted = sum(int(p.get("advance_deducted", 0) or 0)
                       for p in pays_month)
        # Skip rows with zero activity for inactive staff — keeps the
        # register clean without hiding anyone who worked or was paid.
        if (not s.get("active", True) and summary["marked_days"] == 0
                and adv_month == 0 and not pays_month):
            continue
        wage = int(s.get("daily_wage", 0) or 0)
        rows.append({
            "name": s.get("name", ""),
            "designation": s.get("designation", ""),
            "active": s.get("active", True),
            "daily_wage": wage,
            "full_days": summary["full_days"],
            "half_days": summary["half_days"],
            "absent_days": summary["absent_days"],
            "days_worked": summary["days_worked"],
            "wages_earned": int(round(summary["days_worked"] * wage)),
            "advances_taken": adv_month,
            "salary_paid_net": paid_net,
            "advance_recovered": deducted,
            "outstanding_advance": max(0, ledger.outstanding_advance(
                adv_by_staff.get(sid, []), pay_by_staff.get(sid, []))),
        })
    return {"month": month, "generated_on": today, "rows": rows}
