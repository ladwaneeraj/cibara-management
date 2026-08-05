"""
Manual bill service — operator-authored ("serial-wise generated") bills.

Purpose
───────
Create a bill for a stay that happened outside the live check-in / check-out
flow (a walk-in the operator forgot to enter, a paper-register entry being
digitised, a correction). The operator supplies check-in date, check-out
time, room, tariff, guest name / mobile, and one or more payment rows with
their own dates; everything else — serial number, GST folio, totals, balance,
sequential bill number — is computed EXACTLY as a real checkout, so the entry
is indistinguishable from a genuine stay in the register, transactions and
reports.

How it stays faithful to a real bill
────────────────────────────────────
It reuses the checkout machinery verbatim:
  1. Mint the daily serial with the same counter (get_next_serial_number).
  2. Write the operator's payment rows to the payments collection, linked by
     the canonical stay_id — these are what the Transactions tab and Reports
     read, on the dates the operator chose.
  3. Build the bill via config.create_bill_record(...) — identical GST daily
     folio, tax-head split, invoice-flag logic and totals as a live checkout.
  4. Persist it via config.allocate_and_finalize_bill(...) — the same atomic,
     gap-free sequential-number mint used by checkout.

Deliberately does NOT touch totals/current_totals (the live drawer counter):
the payments carry their own past dates, so the register / transactions /
reports reflect them by date, while the running "today's cash" counter — a
live operational figure — is left alone. Every document written carries a
`manual_entry: True` marker for audit and future reversal.

Guardrails
──────────
  • Admin-only (enforced in routes/manual_bill.py).
  • Refuses to mint into a GST month whose GSTR-1 is already filed/locked
    (allocate_and_finalize_bill is the checkout path and skips that check, so
    we enforce it here — mirrors bills_service.finalize).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from config import (
    IST, logger, invalidate_rooms_and_totals,
    get_next_serial_number, create_bill_record, allocate_and_finalize_bill,
)
from services import payment_service

VALID_METHODS = ("cash", "online")
MAX_TARIFF = 10_00_000     # ₹ per night sanity ceiling
MAX_NIGHTS = 366           # a single manual stay longer than a year is a typo


def _valid_date(s) -> bool:
    try:
        datetime.strptime(str(s), "%Y-%m-%d")
        return True
    except (TypeError, ValueError):
        return False


def _valid_hhmm(s) -> bool:
    try:
        datetime.strptime(str(s), "%H:%M")
        return True
    except (TypeError, ValueError):
        return False


def _to_int(v, default=0) -> int:
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return default


def _user_stamp(user):
    user = user or {}
    return {"userId": user.get("userId", "system"),
            "name": user.get("name", "system")}


def create_manual_bill(data: dict, user) -> dict:
    """
    Validate + create a manual bill. Returns a summary dict on success.
    Raises ValueError with an operator-readable message on any rule breach.
    """
    data = data or {}

    # ── Guest / room ─────────────────────────────────────────────────────
    guest_name = str(data.get("guest_name", "")).strip()
    if not guest_name:
        raise ValueError("Guest name is required.")
    guest_mobile = str(data.get("guest_mobile", "")).strip()
    room = str(data.get("room", "")).strip()
    if not room:
        raise ValueError("Room number is required.")
    guest_count = max(1, _to_int(data.get("guest_count"), 1))
    is_ac = bool(data.get("is_ac", False))

    # ── Tariff ───────────────────────────────────────────────────────────
    price = _to_int(data.get("room_price"))
    if price <= 0:
        raise ValueError("Room price per night must be greater than zero.")
    if price > MAX_TARIFF:
        raise ValueError("Room price looks too large — please check it.")

    # ── Dates / times ────────────────────────────────────────────────────
    checkin_date = str(data.get("checkin_date", "")).strip()
    checkout_date = str(data.get("checkout_date", "")).strip()
    checkin_hhmm = str(data.get("checkin_time", "12:00")).strip() or "12:00"
    checkout_hhmm = str(data.get("checkout_time", "11:00")).strip() or "11:00"
    if not _valid_date(checkin_date):
        raise ValueError("Check-in date must be a valid YYYY-MM-DD date.")
    if not _valid_date(checkout_date):
        raise ValueError("Check-out date must be a valid YYYY-MM-DD date.")
    if not _valid_hhmm(checkin_hhmm) or not _valid_hhmm(checkout_hhmm):
        raise ValueError("Check-in / check-out time must be HH:MM (24-hour).")

    checkin_time = "{} {}".format(checkin_date, checkin_hhmm)
    checkout_time = "{} {}".format(checkout_date, checkout_hhmm)
    ci_dt = datetime.strptime(checkin_time, "%Y-%m-%d %H:%M")
    co_dt = datetime.strptime(checkout_time, "%Y-%m-%d %H:%M")
    if co_dt < ci_dt:
        raise ValueError("Check-out cannot be before check-in.")

    today = datetime.now(IST).strftime("%Y-%m-%d")
    if checkin_date > today or checkout_date > today:
        raise ValueError("A manual bill cannot be dated in the future.")

    # Nights: same rule as a live stay (minimum one billable night, even for
    # a same-day check-in/checkout).
    nights = max(1, (co_dt.date() - ci_dt.date()).days)
    if nights > MAX_NIGHTS:
        raise ValueError("Stay length looks wrong (> 1 year) — check the dates.")

    # ── GST month lock — refuse minting into a filed period ──────────────
    # allocate_and_finalize_bill is the checkout path and does NOT enforce
    # the lock, so we do it here (mirrors bills_service.finalize). A manual
    # bill into a filed month would desync the already-filed GSTR-1.
    try:
        from services.gst_lock_service import is_month_locked
        if is_month_locked(checkout_time):
            raise ValueError(
                "The GST month {} is locked (GSTR-1 filed). Unlock it first "
                "if a late bill genuinely has to be added.".format(checkout_time[:7])
            )
    except ImportError:
        pass

    # ── Payment rows ─────────────────────────────────────────────────────
    # Each: {date (YYYY-MM-DD), amount (>0), method (cash|online), time?}.
    # Zero rows is allowed — an unpaid stay (full balance).
    raw_payments = data.get("payments") or []
    if not isinstance(raw_payments, list):
        raise ValueError("Payments must be a list.")
    payments = []
    for i, p in enumerate(raw_payments, start=1):
        p = p or {}
        amt = _to_int(p.get("amount"))
        if amt <= 0:
            raise ValueError("Payment #{} amount must be greater than zero.".format(i))
        method = str(p.get("method", "cash")).lower()
        if method not in VALID_METHODS:
            raise ValueError("Payment #{} method must be cash or online.".format(i))
        pdate = str(p.get("date", "")).strip() or checkout_date
        if not _valid_date(pdate):
            raise ValueError("Payment #{} has an invalid date.".format(i))
        if pdate > today:
            raise ValueError("Payment #{} cannot be dated in the future.".format(i))
        ptime = str(p.get("time", "")).strip()
        if ptime and not _valid_hhmm(ptime):
            raise ValueError("Payment #{} time must be HH:MM.".format(i))
        payments.append({"amount": amt, "method": method, "date": pdate,
                         "time": ptime or checkin_hhmm})

    # ── Mint serial + stay id ────────────────────────────────────────────
    serial_number = get_next_serial_number(checkin_date)
    stay_id = uuid.uuid4().hex
    actor = _user_stamp(user)
    stay_key = "{}_{}".format(room, checkin_time)

    # ── Write payment rows (sync — must exist before create_bill_record
    #    reads them by stay_id) ─────────────────────────────────────────
    # The first money row (or a zero pay-later marker when there are none)
    # carries the fresh-checkin markers so the register's serial ordering and
    # the transaction categoriser recognise the stay's opening entry.
    def _write(payment_doc, *, first):
        base = {
            "room": room, "name": guest_name, "mobile": guest_mobile,
            "serial_number": serial_number, "stay_room_key": stay_key,
            "manual_entry": True, "created_by": actor,
        }
        base.update(payment_doc)
        if first:
            base["transaction_type"] = "fresh_checkin"
            base["is_fresh_checkin"] = True
            base.setdefault("type", "checkin")
        payment_service.write_payment_with_stay(stay_id, base, sync=True)

    if payments:
        for idx, p in enumerate(payments):
            _write({
                "amount": p["amount"], "method": p["method"],
                "type": "checkin" if idx == 0 else "payment",
                "date": p["date"], "time": p["time"],
            }, first=(idx == 0))
    else:
        # Unpaid stay — a zero marker so the stay still has its opening row.
        _write({
            "amount": 0, "method": "pay_later", "type": "checkin",
            "date": checkin_date, "time": checkin_hhmm,
        }, first=True)

    # ── Build the bill exactly like a live checkout ──────────────────────
    room_data = {
        "guest": {
            "name": guest_name,
            "mobile": guest_mobile,
            "price": price,
            "guests": guest_count,
            "isAC": is_ac,
        },
        "checkin_time": checkin_time,
        "active_bill_id": stay_id,
        # days_in_current_room = renewal_count + 1 → set so it equals `nights`.
        "renewal_count": nights - 1,
        "booking_source": "normal",
        "payment_source": "hotel",
    }

    try:
        bill_record = create_bill_record(
            room, room_data, checkout_time, defer_number=True,
        )
    except Exception as e:
        logger.error("manual_bill: create_bill_record failed: %s", e, exc_info=True)
        raise ValueError("Could not build the bill: {}".format(e))
    if not bill_record:
        raise ValueError("Could not build the bill (no record produced).")

    needs_number = bill_record.pop("_needs_bill_number", True)

    # Force a sequential GST bill number when the operator asked for one
    # (default). Without this, a cash-only stay with the property's "always
    # generate bill" setting OFF would come back with bill_number "-" — the
    # same rule a live cash-only checkout follows. Manual bills are deliberate
    # formal records, so we default to numbering them; the operator can turn
    # it off per bill for a plain no-invoice receipt. GST is already computed
    # on the record regardless, so forcing the number yields a valid invoice.
    force_bill_number = bool(data.get("generate_bill_number", True))
    if force_bill_number and not needs_number:
        needs_number = True
        bill_record["invoice_generated"] = True

    # Audit markers so the entry is identifiable and reversible later.
    bill_record["manual_entry"] = True
    bill_record["manual_entry_by"] = actor
    bill_record["manual_entry_at"] = datetime.now(IST).isoformat()
    bill_record["stay_id"] = stay_id

    # ── Atomic, gap-free finalize (same as checkout) ─────────────────────
    try:
        bill_number, newly = allocate_and_finalize_bill(
            stay_id, bill_record, co_dt,
            is_new_doc=True, needs_number=needs_number,
        )
    except Exception as e:
        logger.error("manual_bill: finalize failed for stay %s: %s",
                     stay_id, e, exc_info=True)
        raise ValueError("Could not save the bill: {}".format(e))

    invalidate_rooms_and_totals()
    logger.info(
        "manual_bill: created stay=%s serial=%s bill_number=%s room=%s "
        "guest=%s total=%s by=%s",
        stay_id, serial_number, bill_number, room, guest_name,
        bill_record.get("total_amount"), actor.get("name"),
    )

    return {
        "stay_id": stay_id,
        "bill_number": bill_number,
        "serial_number": serial_number,
        "room": room,
        "guest_name": guest_name,
        "checkin_time": checkin_time,
        "checkout_time": checkout_time,
        "nights": nights,
        "total_amount": bill_record.get("total_amount"),
        "payment_cash": bill_record.get("payment_cash"),
        "payment_online": bill_record.get("payment_online"),
        "balance": bill_record.get("balance"),
        "invoice_generated": bill_record.get("invoice_generated"),
    }
