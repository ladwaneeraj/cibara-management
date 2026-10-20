"""Guest-facing web booking routes (public, CORS-enabled for the website origin).

All endpoints here live under /web/ which is in app._PUBLIC_PREFIXES, so they
need no staff auth. Never expose secrets or internal tuning knobs from here.
"""
import json
import hmac
import logging
import os
import uuid
from datetime import datetime, timedelta

from firebase_admin import firestore
from flask import Blueprint, jsonify, request
from google.api_core import exceptions as gexc

import config
from config import get_web_config, invalidate_rooms_and_totals
from services import availability_service as av
from services import payment_service, razorpay_service, system_alerts

logger = logging.getLogger(__name__)

web_bp = Blueprint('web', __name__)

_MAX_STAY_DAYS = 30
# Best-effort per-IP cap on /web/availability. Backed by the shared in-memory
# sliding-window limiter, so it is PER PROCESS (resets on restart, not shared
# across instances) -- fine for Phase 0; the global middleware limit still applies.
_AVAIL_LIMIT_PER_MIN = 60
# /web/hold writes state (a pending booking that blocks inventory), so it gets
# its own bucket: a guest needs one hold, not dozens.
_HOLD_LIMIT_PER_MIN = 20

_MAX_NAME_LEN = 100
_MAX_MOBILE_LEN = 20
_MAX_EMAIL_LEN = 254


def _bad(message):
    return jsonify(error=message), 400


def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _client_ip():
    """Best-effort guest IP for rate limiting.

    Behind the reverse proxy ``remote_addr`` is the proxy, which would put every
    guest in one bucket. Use the left-most X-Forwarded-For entry when present.
    XFF is spoofable; that is acceptable here because the endpoint is read-only
    (no money, no state) -- the aim is to stop collapsing all guests into one
    bucket, not to be abuse-proof.
    """
    xff = request.headers.get("X-Forwarded-For", "")
    first = xff.split(",")[0].strip()
    return first or request.remote_addr or "unknown"


def _rate_limited(bucket="web_availability", limit=_AVAIL_LIMIT_PER_MIN):
    """True when this client IP has exceeded the per-minute cap for ``bucket``."""
    from cibara_api.core.ratelimit import limiter
    ok, _ = limiter.hit(f"{bucket}:{_client_ip()}", limit, 60)
    return not ok


class _Invalid(Exception):
    """Request validation failure; the message is safe to return to the guest."""


class _SoldOut(Exception):
    """No offerable room left for the requested stay."""


def _parse_stay(data):
    """Validate the stay fields shared by /web/availability and /web/hold.

    Returns ``(category, spec, days, guests, checkin_dt, now)``; raises ``_Invalid``.
    """
    category = data.get("category")
    spec = av.WEB_BOOKABLE.get(category) if isinstance(category, str) else None
    if spec is None:
        raise _Invalid("Unknown category")

    days = data.get("days")
    if not _is_int(days) or not 1 <= days <= _MAX_STAY_DAYS:
        raise _Invalid("Invalid days")

    guests = data.get("guests")
    if not _is_int(guests) or not 1 <= guests <= spec["max_guests"]:
        raise _Invalid("Invalid guests")

    date_s, time_s = data.get("check_in_date"), data.get("check_in_time")
    if not isinstance(date_s, str) or not isinstance(time_s, str):
        raise _Invalid("Invalid check-in date/time")
    day = av._parse_date(date_s)
    hm = av._parse_time(time_s)
    if day is None or hm is None:
        raise _Invalid("Invalid check-in date/time")
    # Build from the date + wall-clock time and localize (DST-free IST).
    checkin_dt = config.IST.localize(day.replace(tzinfo=None) + timedelta(hours=hm[0], minutes=hm[1]))
    now = datetime.now(config.IST)
    if checkin_dt < now:
        raise _Invalid("Check-in time is in the past")
    return category, spec, days, guests, checkin_dt, now


@web_bp.route("/web/config", methods=["GET"])
def web_config():
    """Public flags the website needs to decide whether to show booking."""
    cfg = get_web_config()
    return jsonify(
        online_bookings_enabled=bool(cfg["online_bookings_enabled"]),
        cleaning_gap_minutes=int(cfg["cleaning_gap_minutes"]),
    )


@web_bp.route("/web/availability", methods=["POST"])
def web_availability():
    """Is a category offerable for a stay, and what does it cost.

    Returns only {available, price, currency}: the pool is internal, so no room
    number is ever exposed. The price is computed here; any price in the request
    is ignored.
    """
    # 1. Closed flag first: no input handling or availability work when OFF.
    if not get_web_config().get("online_bookings_enabled"):
        return jsonify(enabled=False), 403

    if _rate_limited():
        return jsonify(error="Too many requests. Please slow down."), 429

    # 2. Validate (all failures -> 400).
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return _bad("Invalid request body")

    try:
        _category, spec, days, guests, checkin_dt, now = _parse_stay(data)
    except _Invalid as e:
        return _bad(str(e))

    # 3-4. Availability and server-computed price.
    offerable = av.web_offerable_rooms(spec["pool"], checkin_dt, days, guests, now=now)
    price = av.web_quote(spec["pool"], guests, days, ac=spec["ac"])

    # 5. Never include a room.
    return jsonify(available=len(offerable) > 0, price=int(price), currency="INR")


def _clean_str(value, max_len, *, required):
    """Stripped string, or ``None`` when absent/blank and not required.

    Raises ``_Invalid`` for a non-string, a missing required value, or overlong text.
    """
    if value is None and not required:
        return None
    if not isinstance(value, str):
        raise _Invalid("Invalid guest details")
    value = value.strip()
    if not value:
        if required:
            raise _Invalid("Invalid guest details")
        return None
    if len(value) > max_len:
        raise _Invalid("Invalid guest details")
    return value


@web_bp.route("/web/hold", methods=["POST"])
def web_hold():
    """Place a short-lived ``pending_payment`` hold on one room of a category.

    The room is chosen server-side and never returned. Price is server-computed
    (any price/room/status in the request is ignored). Returns
    ``{booking_id, amount (rupees), expires_at}``; 409 when nothing is offerable.
    """
    # 1. Closed flag first: no input handling, rate-limit bookkeeping or writes when OFF.
    cfg = get_web_config()
    if not cfg.get("online_bookings_enabled"):
        return jsonify(enabled=False), 403

    if _rate_limited("web_hold", _HOLD_LIMIT_PER_MIN):
        return jsonify(error="Too many requests. Please slow down."), 429

    # 2. Validate (all failures -> 400).
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return _bad("Invalid request body")
    try:
        category, spec, days, guests, checkin_dt, now = _parse_stay(data)
        guest_name = _clean_str(data.get("guest_name"), _MAX_NAME_LEN, required=True)
        guest_mobile = _clean_str(data.get("guest_mobile"), _MAX_MOBILE_LEN, required=True)
        guest_email = _clean_str(data.get("guest_email"), _MAX_EMAIL_LEN, required=False)
    except _Invalid as e:
        return _bad(str(e))

    pool = spec["pool"]
    total = int(av.web_quote(pool, guests, days, ac=spec["ac"]))
    try:
        ttl = max(1, int(cfg.get("hold_ttl_minutes", 10)))
    except (TypeError, ValueError):
        ttl = 10
    expires_at = (now + timedelta(minutes=ttl)).isoformat()
    check_out_date = (checkin_dt + timedelta(hours=24 * days)).strftime("%Y-%m-%d")

    # 3. Race-safe hold.
    #
    # Why the sentinel: in REAL Firestore a collection query (which is how
    # web_offerable_rooms reads bookings) does NOT join the transaction's read
    # set. Without more, two concurrent holds could both see the last room free
    # and both write -> a double-book. So every hold on a pool reads AND writes
    # one per-pool doc (web_pool_locks/{pool}). Firestore's optimistic
    # concurrency then makes the second committer fail on the changed sentinel,
    # abort and retry; on retry web_offerable_rooms sees the winner's
    # just-committed pending booking and (if that was the last room) raises
    # _SoldOut. DO NOT remove the sentinel read/write: it is the only thing that
    # serialises same-pool holds in production. premium and premium_ac share
    # the "premium" pool, so they share one sentinel. set(merge=True), not
    # update(), so the very first hold on a pool (no lock doc yet) still works.
    lock_ref = config.db.collection("web_pool_locks").document(pool)
    now_iso = now.isoformat()

    @firestore.transactional
    def _hold(txn):
        # (1) read dependency on the sentinel. Must be an EAGER read: in the real
        # client ``txn.get(doc_ref)`` returns a lazy generator that performs no
        # RPC until consumed, which would silently drop the dependency.
        lock_ref.get(transaction=txn)
        # (2) re-check availability now, inside the transaction (buffer applied inside).
        free = av.web_offerable_rooms(pool, checkin_dt, days, guests, now=now)
        if not free:
            raise _SoldOut()
        room = free[0]  # (3) first offerable room, in guest-count preference order
        booking_id = uuid.uuid4().hex
        booking = {
            "room": room,
            "guest_name": guest_name,
            "guest_mobile": guest_mobile,
            "check_in_date": checkin_dt.strftime("%Y-%m-%d"),
            "check_in_time": checkin_dt.strftime("%H:%M"),
            "check_out_date": check_out_date,
            "days": days,
            "guest_count": guests,
            "status": "pending_payment",
            "booking_source": "web",
            "payment_source": "hotel",
            "is_ac": spec["ac"],
            "total_amount": total,
            "paid_amount": 0,
            "balance": total,
            "expires_at": expires_at,
            "booking_date": now.strftime("%Y-%m-%d"),
            "created_at": now_iso,
        }
        if guest_email:
            booking["guest_email"] = guest_email
        txn.set(config.bookings_ref.document(booking_id), booking)  # (4) pending booking
        txn.set(lock_ref, {"v": firestore.Increment(1), "updated_at": now_iso},
                merge=True)  # (5) bump the sentinel
        return booking_id

    try:
        booking_id = _hold(config.db.transaction())
    except _SoldOut:
        return jsonify(error="Sold out", sold_out=True), 409
    except gexc.Aborted:
        # Sustained contention on the sentinel exhausted the txn's retries; the
        # guest can simply try again. Nothing was written.
        return jsonify(error="Busy, please retry"), 503

    return jsonify(booking_id=booking_id, amount=total, expires_at=expires_at)


@web_bp.route("/web/order", methods=["POST"])
def web_order():
    """Create a Razorpay order for a held booking.

    The amount comes from the HELD BOOKING's total_amount, never the request body.
    Returns ``{order_id, key_id, amount (paise)}`` -- only the publishable key id,
    never the key secret. 404 when the hold is missing/expired; 409 if already paid.
    """
    data = request.get_json(silent=True)
    booking_id = data.get("booking_id") if isinstance(data, dict) else None
    if not isinstance(booking_id, str) or not booking_id.strip():
        return jsonify(error="Booking not found"), 404

    snap = config.bookings_ref.document(booking_id).get()
    if not snap.exists:
        return jsonify(error="Booking not found"), 404
    booking = snap.to_dict() or {}

    if booking.get("status") == "confirmed":
        return jsonify(error="Already paid"), 409
    if booking.get("status") != "pending_payment":
        return jsonify(error="Booking not found"), 404
    try:
        expires = datetime.fromisoformat(booking["expires_at"])
        if expires.tzinfo is None:
            expires = config.IST.localize(expires)
    except (KeyError, TypeError, ValueError):
        return jsonify(error="Hold expired"), 404
    if expires < datetime.now(config.IST):
        return jsonify(error="Hold expired"), 404

    amount_paise = av.to_paise(booking["total_amount"])
    order = razorpay_service.create_order(amount_paise, receipt=booking_id)
    return jsonify(order_id=order["id"], key_id=os.environ.get("RAZORPAY_KEY_ID", ""),
                   amount=amount_paise)


# ------------------------------------------------------------------- hold sweep
def _hold_expiry(booking):
    """IST-aware ``expires_at`` of a hold, or ``None`` when absent/unparseable."""
    raw = booking.get("expires_at")
    if not isinstance(raw, str):
        return None
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return config.IST.localize(dt) if dt.tzinfo is None else dt.astimezone(config.IST)


def sweep_expired_holds(now=None):
    """Flip ``pending_payment`` holds past ``expires_at`` to ``"expired"``; return the count.

    The status is EXACTLY ``"expired"``: availability's busy set is
    {confirmed, pending_payment}, so this frees the room, and the Razorpay
    webhook revives a swept hold only when ``status == "expired"`` (a late
    payment still confirms it, unless the room was taken meanwhile).

    A hold whose ``expires_at`` is missing or malformed is LEFT as-is (and
    logged): we cannot prove it expired, and releasing a room a guest may be
    paying for is worse than a stuck hold. The hold code always writes an ISO
    IST expiry, so this only guards against hand-edited data. Idempotent: swept
    docs no longer match the ``pending_payment`` query. The status is re-checked
    inside a transaction so a payment that confirmed the hold between the query
    and the write is never overwritten.
    """
    now = now or datetime.now(config.IST)
    swept = 0
    for doc in config.bookings_ref.where("status", "==", "pending_payment").stream():
        b = doc.to_dict() or {}
        expires = _hold_expiry(b)
        if expires is None:
            logger.warning("sweep: pending hold %s has no usable expires_at; leaving it", doc.id)
            continue
        if expires >= now:
            continue
        ref = config.bookings_ref.document(doc.id)

        @firestore.transactional
        def _expire(txn, ref=ref):
            cur = (ref.get(transaction=txn).to_dict() or {})
            if cur.get("status") != "pending_payment":
                return False  # confirmed (or otherwise changed) since the query
            txn.update(ref, {"status": "expired", "expired_at": now.isoformat()})
            return True

        if _expire(config.db.transaction()):
            swept += 1
    return swept


@web_bp.route("/web/sweep", methods=["POST"])
def web_sweep():
    """Cloud Scheduler hook (every minute): release expired holds.

    Not a browser endpoint (no CORS, no closed-flag). Guarded by a shared token:
    ``X-Sweep-Token`` must equal env ``WEB_SWEEP_TOKEN``; an unset env token
    rejects everything, so a public caller can never force-expire holds.
    """
    expected = os.environ.get("WEB_SWEEP_TOKEN", "")
    supplied = request.headers.get("X-Sweep-Token", "")
    if not expected or not hmac.compare_digest(supplied.encode(), expected.encode()):
        return jsonify(error="Forbidden"), 403
    return jsonify(swept=sweep_expired_holds())


# --------------------------------------------------------------- Razorpay webhook
class _PaymentWriteFailed(Exception):
    """The ledger row could not be queued; the confirm must roll back."""


def _guest_phone(mobile):
    """Digits-only with the 91 country prefix, as send_booking_confirmation does."""
    phone = "".join(ch for ch in str(mobile or "") if ch.isdigit())
    if phone.startswith("0"):
        phone = phone[1:]
    if phone and not phone.startswith("91"):
        phone = "91" + phone
    return phone


def _confirmation_message(booking_id, b):
    nights = b.get("days") or 1
    plural = "s" if nights != 1 else ""
    try:
        ci = datetime.strptime(b["check_in_date"], "%Y-%m-%d").strftime("%d %b %Y")
        co = datetime.strptime(b["check_out_date"], "%Y-%m-%d").strftime("%d %b %Y")
    except (KeyError, TypeError, ValueError):
        ci, co = b.get("check_in_date", ""), b.get("check_out_date", "")
    at = f" at {b['check_in_time']}" if b.get("check_in_time") else ""
    return (
        "\U0001F3E8 *BOOKING CONFIRMATION*\n\n"
        f"Hello {b.get('guest_name', '')},\n\n"
        "Your booking at our lodge has been confirmed!\n\n"
        "\U0001F4CB *Booking Details:*\n"
        f"• Booking ID: {booking_id[:8].upper()}\n"
        f"• Check-in: {ci}{at}\n"
        f"• Check-out: {co}\n"
        f"• Duration: {nights} night{plural}\n"
        f"• Guests: {b.get('guest_count', 1)}\n\n"
        "\U0001F4B0 *Payment Status:*\n"
        f"• Total Amount: ₹{b.get('total_amount')}\n"
        f"• Paid: ₹{b.get('paid_amount')}\n"
        f"• Balance Due: ₹{b.get('balance')}\n\n"
        "\U0001F4CD *Location:*\nhttps://maps.app.goo.gl/Mz5rTrvC3ctyMmUt5\n\n"
        "If you have any questions, please feel free to contact us.\n\n"
        "Thank you for choosing us! \U0001F64F"
    )


def _alert_owner(kind, message, context, *, severity="critical"):
    system_alerts.record_alert(kind=kind, message=message, severity=severity, context=context)
    system_alerts.notify_owner(message, title="Cibara: " + kind)


@web_bp.route("/web/razorpay_webhook", methods=["POST"])
def razorpay_webhook():
    """Razorpay ``order.paid`` -> the ONLY place a web booking becomes paid.

    Order of operations matters: the HMAC is checked over the RAW bytes before
    anything is parsed or written. Everything that changes state (idempotency
    marker, booking confirm, ledger row, totals) commits in ONE Firestore
    transaction, so a retry/duplicate/concurrent delivery can never double-count:
    the second one finds ``processed_webhooks/{payment_id}`` and no-ops.
    Side effects (WhatsApp, alerts, ntfy) fire only after that commit, and only
    for the delivery that actually applied it.
    """
    raw = request.get_data()  # raw bytes first; do not touch request.json before this
    if not razorpay_service.verify_webhook_signature(
            raw, request.headers.get("X-Razorpay-Signature", "")):
        return jsonify(error="Invalid signature"), 400

    try:
        event = json.loads(raw)
        if not isinstance(event, dict):
            raise ValueError("not an object")
    except ValueError:
        return jsonify(error="Invalid payload"), 400

    if event.get("event") != "order.paid":
        return jsonify(status="ignored"), 200

    try:
        payload = event["payload"]
        order = payload["order"]["entity"]
        payment_id = payload["payment"]["entity"]["id"]
        booking_id = order.get("receipt")
        order_id = order.get("id")
        paid_paise = order.get("amount_paid", order.get("amount"))
    except (KeyError, TypeError, AttributeError):
        _alert_owner("web_webhook_malformed",
                     "Razorpay order.paid webhook had an unexpected shape; check the dashboard.", {})
        return jsonify(status="malformed"), 200
    if (not isinstance(payment_id, str) or not payment_id or "/" in payment_id
            or not isinstance(booking_id, str) or not booking_id.strip() or "/" in booking_id):
        _alert_owner("web_webhook_malformed",
                     "Razorpay order.paid webhook had no usable payment id / receipt.",
                     {"payment_id": str(payment_id)[:64], "order_id": str(order_id)[:64]})
        return jsonify(status="malformed"), 200

    proc_ref = config.db.collection("processed_webhooks").document(payment_id)
    booking_ref = config.bookings_ref.document(booking_id)
    totals_doc = config.totals_ref.document("current_totals")
    now = datetime.now(config.IST)
    out = {}

    @firestore.transactional
    def _apply(txn):
        out.clear()  # the transaction body can be retried
        # All reads first (Firestore requires reads before writes in a txn).
        if proc_ref.get(transaction=txn).exists:
            out["outcome"] = "duplicate"
            return
        snap = booking_ref.get(transaction=txn)
        mark = {"payment_id": payment_id, "booking_id": booking_id, "order_id": order_id,
                "processed_at": now.isoformat()}

        if not snap.exists:
            out["outcome"] = "no_booking"
            txn.set(proc_ref, {**mark, "outcome": "no_booking"})
            return
        b = snap.to_dict() or {}
        out["booking"] = b
        status = b.get("status")

        if status == "confirmed":
            # A SECOND distinct payment for an already-paid booking: never
            # re-confirm, never write a second ledger row. Owner refunds.
            out["outcome"] = "dup_payment"
            txn.set(proc_ref, {**mark, "outcome": "dup_payment"})
            return
        if status not in ("pending_payment", "expired"):
            out["outcome"] = "bad_status"
            txn.set(proc_ref, {**mark, "outcome": "bad_status"})
            return

        try:
            expected_paise = av.to_paise(b["total_amount"])
        except (KeyError, TypeError, ValueError):
            expected_paise = None
        if expected_paise is None or not _is_int(paid_paise) or paid_paise != expected_paise:
            out["outcome"] = "mismatch"
            out["expected_paise"] = expected_paise
            txn.set(proc_ref, {**mark, "outcome": "mismatch"})
            return

        if status == "expired":
            # A swept hold released its room; someone may have taken it since.
            # Do not double-book: leave it expired and let the owner refund/reassign.
            ci = av._parse_date(b.get("check_in_date"))
            hm = av._parse_time(b.get("check_in_time"))
            days = av._parse_days(b.get("days"))
            if ci is not None and hm is not None and days is not None:
                ws = ci.replace(hour=hm[0], minute=hm[1])
                busy = av.occupied_intervals([b.get("room")], ws, ws + timedelta(hours=24 * days),
                                             now=now, exclude_booking_id=booking_id)
                if busy.get(str(b.get("room"))):
                    out["outcome"] = "revive_conflict"
                    txn.set(proc_ref, {**mark, "outcome": "revive_conflict"})
                    return

        total = b["total_amount"]
        rupees = int(total)
        updates = {
            "status": "confirmed", "paid_amount": total, "balance": 0,
            "razorpay_payment_id": payment_id, "razorpay_order_id": order_id,
            "expires_at": firestore.DELETE_FIELD, "confirmed_at": now.isoformat(),
        }
        txn.update(booking_ref, updates)
        # Ledger row, mirroring create_booking's online advance (FK = booking_id).
        # Written through the transaction so it commits atomically with the confirm.
        if not payment_service.write_payment({
            "room": b.get("room"), "name": b.get("guest_name"), "amount": rupees,
            "method": "online", "type": "booking_advance",
            "transaction_type": "booking_advance",
            "date": now.strftime("%Y-%m-%d"), "time": now.strftime("%H:%M"),
            "booking_id": booking_id, "booking_source": "web",
            "mobile": b.get("guest_mobile"),
            "stay_checkin_date": b.get("check_in_date", ""),
            "razorpay_payment_id": payment_id,
        }, batch=txn):
            raise _PaymentWriteFailed()
        txn.set(totals_doc, {"online": firestore.Increment(rupees),
                             "advance_bookings": firestore.Increment(rupees)}, merge=True)
        txn.set(proc_ref, {**mark, "outcome": "confirmed", "was_expired": status == "expired"})
        out["outcome"] = "confirmed"
        out["revived"] = status == "expired"
        out["booking"] = {**b, "status": "confirmed", "paid_amount": total, "balance": 0}

    try:
        _apply(config.db.transaction())
    except Exception:  # noqa: BLE001 -- nothing was committed; ask Razorpay to retry
        logger.exception("web webhook: confirm failed for booking %s (will be retried)", booking_id)
        system_alerts.record_alert(
            kind="web_webhook_failed",
            message=f"Payment {payment_id} for web booking {booking_id[:8].upper()} could not be "
                    "recorded; Razorpay will retry. If this persists, reconcile manually.",
            context={"booking_id": booking_id, "payment_id": payment_id})
        return jsonify(error="Temporary failure"), 500

    outcome = out.get("outcome")
    b = out.get("booking") or {}
    ref = booking_id[:8].upper()
    ctx = {"booking_id": booking_id, "payment_id": payment_id, "order_id": order_id}

    if outcome == "duplicate":
        return jsonify(status="duplicate"), 200
    if outcome == "no_booking":
        _alert_owner("web_payment_no_booking",
                     f"Money captured (payment {payment_id}) but there is no booking "
                     f"{ref}. Refund or recreate it manually.", ctx)
    elif outcome == "dup_payment":
        _alert_owner("web_duplicate_payment",
                     f"Possible duplicate charge: payment {payment_id} arrived for booking "
                     f"{ref}, which is already paid. Check and refund.", ctx)
    elif outcome == "bad_status":
        _alert_owner("web_payment_bad_status",
                     f"Payment {payment_id} captured for booking {ref} in status "
                     f"{b.get('status')!r}; not confirmed. Review/refund.", ctx)
    elif outcome == "mismatch":
        _alert_owner("web_amount_mismatch",
                     f"Payment {payment_id} for booking {ref} paid {paid_paise} paise but "
                     f"{out.get('expected_paise')} was due; NOT confirmed. Review/refund.", ctx)
    elif outcome == "revive_conflict":
        _alert_owner("web_revive_conflict",
                     f"Payment {payment_id} captured for an expired hold ({ref}) but room "
                     f"{b.get('room')} has since been taken; NOT confirmed. Refund or reassign.", ctx)
    elif outcome == "confirmed":
        invalidate_rooms_and_totals()
        if out.get("revived"):
            _alert_owner("web_hold_revived",
                         f"A swept (expired) hold {ref} was revived by captured payment "
                         f"{payment_id}; booking is now confirmed.", ctx)
        _alert_owner("web_booking",
                     f"New web booking {ref}: {b.get('guest_name')}, room {b.get('room')}, "
                     f"{b.get('check_in_date')}, ₹{b.get('total_amount')} paid online.",
                     ctx, severity="warning")
        try:
            config.send_whatsapp_message(_guest_phone(b.get("guest_mobile")),
                                         _confirmation_message(booking_id, b))
        except Exception:  # noqa: BLE001 -- the guest message must never undo a confirmed booking
            logger.exception("web webhook: WhatsApp confirmation failed for %s", booking_id)
    return jsonify(status=outcome), 200
