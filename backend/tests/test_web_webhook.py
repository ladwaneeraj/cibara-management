"""POST /web/razorpay_webhook: verified, idempotent order.paid -> confirm + pay + notify."""
import hashlib
import hmac
import json
from datetime import datetime, timedelta
from unittest.mock import patch

import pytest

import config
from services import availability_service as av
from services import blocks_service, razorpay_service, system_alerts
from tests.fakes import fake_firebase as F

DB = F.FAKE_DB
SECRET = "whsec_test_SECRET_xyz"
TOTAL = 4500


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("RAZORPAY_WEBHOOK_SECRET", SECRET)


@pytest.fixture
def notif():
    """Mock every outbound side effect; yields the mocks."""
    with patch.object(config, "send_whatsapp_message", return_value=True) as wa, \
         patch.object(system_alerts, "record_alert", return_value="alert1") as alert, \
         patch.object(system_alerts, "notify_owner") as ntfy:
        yield type("N", (), {"wa": wa, "alert": alert, "ntfy": ntfy})


def _booking(booking_id="bk1", status="pending_payment", total=TOTAL, **extra):
    exp = (datetime.now(config.IST) + timedelta(minutes=10)).isoformat()
    doc = {
        "room": "101", "guest_name": "Asha Rao", "guest_mobile": "9876543210",
        "check_in_date": (datetime.now(config.IST) + timedelta(days=30)).strftime("%Y-%m-%d"),
        "check_in_time": "12:00",
        "check_out_date": (datetime.now(config.IST) + timedelta(days=31)).strftime("%Y-%m-%d"),
        "days": 1, "guest_count": 2,
        "status": status, "booking_source": "web", "total_amount": total,
        "paid_amount": 0, "balance": total, "expires_at": exp,
    }
    doc.update(extra)
    config.bookings_ref.document(booking_id).set(doc)
    return booking_id


def _event(booking_id="bk1", payment_id="pay_1", amount_paise=None, event="order.paid",
           order_id="order_1"):
    amount_paise = av.to_paise(TOTAL) if amount_paise is None else amount_paise
    return {
        "entity": "event", "event": event,
        "payload": {
            "payment": {"entity": {"id": payment_id, "order_id": order_id,
                                   "amount": amount_paise, "status": "captured"}},
            "order": {"entity": {"id": order_id, "amount": amount_paise,
                                 "amount_paid": amount_paise, "receipt": booking_id,
                                 "status": "paid"}},
        },
    }


def _post(client, payload, secret=SECRET, signature=None):
    raw = json.dumps(payload).encode()
    sig = signature if signature is not None else hmac.new(
        secret.encode(), raw, hashlib.sha256).hexdigest()
    return client.post("/web/razorpay_webhook", content=raw,
                       headers={"X-Razorpay-Signature": sig, "Content-Type": "application/json"})


def _booking_doc(bid="bk1"):
    return config.bookings_ref.document(bid).get().to_dict()


def _payments():
    return list(DB.dump("payments").values())


def _kinds(notif):
    return [c.kwargs.get("kind") for c in notif.alert.call_args_list]


def test_valid_signature_confirms_booking(client, notif):
    bid = _booking()
    r = _post(client, _event(bid))
    assert r.status_code == 200, r.text
    b = _booking_doc(bid)
    assert b["status"] == "confirmed"
    assert b["paid_amount"] == TOTAL and b["balance"] == 0
    assert b["razorpay_payment_id"] == "pay_1" and b["razorpay_order_id"] == "order_1"
    assert b.get("expires_at") in (None, "")
    pays = _payments()
    assert len(pays) == 1
    assert pays[0]["method"] == "online" and pays[0]["booking_source"] == "web"
    assert pays[0]["amount"] == TOTAL and pays[0]["booking_id"] == bid
    assert pays[0]["type"] == "booking_advance"
    notif.wa.assert_called_once()
    assert notif.wa.call_args.args[0] == "919876543210"
    assert _kinds(notif) == ["web_booking"]
    notif.ntfy.assert_called_once()
    assert "pay_1" in DB.dump("processed_webhooks")
    totals = DB.dump("totals").get("current_totals", {})
    assert totals.get("online") == TOTAL and totals.get("advance_bookings") == TOTAL


def test_payment_recorded_as_web_online(client, notif):
    bid = _booking()
    assert _post(client, _event(bid)).status_code == 200
    (p,) = _payments()
    assert p["method"] == "online"
    assert p["booking_source"] == "web"
    assert p["booking_id"] == bid
    assert p["mobile"] == "9876543210"


def test_duplicate_delivery_is_noop(client, notif):
    bid = _booking()
    ev = _event(bid)
    assert _post(client, ev).status_code == 200
    assert _post(client, ev).status_code == 200
    assert _booking_doc(bid)["status"] == "confirmed"
    assert len(_payments()) == 1
    notif.wa.assert_called_once()
    notif.ntfy.assert_called_once()
    assert notif.alert.call_count == 1
    totals = DB.dump("totals").get("current_totals", {})
    assert totals.get("online") == TOTAL  # not double-counted


def test_bad_signature_rejected(client, notif):
    bid = _booking()
    ev = _event(bid)
    assert _post(client, ev, signature="deadbeef").status_code == 400
    assert _post(client, ev, secret="wrong-secret").status_code == 400
    r = client.post("/web/razorpay_webhook", content=json.dumps(ev).encode())  # no header
    assert r.status_code == 400
    assert _booking_doc(bid)["status"] == "pending_payment"
    assert _payments() == []
    assert DB.dump("processed_webhooks") == {}
    notif.wa.assert_not_called()


def test_unset_secret_rejects_everything(client, notif, monkeypatch):
    monkeypatch.delenv("RAZORPAY_WEBHOOK_SECRET")
    bid = _booking()
    # a signature computed with an empty key must NOT be accepted
    assert _post(client, _event(bid), secret="").status_code == 400
    assert _booking_doc(bid)["status"] == "pending_payment"


def test_webhook_for_expired_or_swept_hold_rematerializes(client, notif):
    bid = _booking(status="expired")
    assert _post(client, _event(bid)).status_code == 200
    b = _booking_doc(bid)
    assert b["status"] == "confirmed" and b["paid_amount"] == TOTAL and b["balance"] == 0
    assert len(_payments()) == 1
    assert "web_hold_revived" in _kinds(notif)
    notif.wa.assert_called_once()


def test_expired_hold_whose_room_was_rebooked_is_not_confirmed(client, notif):
    bid = _booking(status="expired")
    _booking("other", status="confirmed")  # same room, same slot, now taken
    assert _post(client, _event(bid)).status_code == 200
    assert _booking_doc(bid)["status"] == "expired"
    assert _payments() == []
    assert _kinds(notif) == ["web_revive_conflict"]
    notif.wa.assert_not_called()
    assert "pay_1" in DB.dump("processed_webhooks")


def test_block_created_after_hold_is_not_confirmed(client, notif):
    """A category/room block placed AFTER the hold but before the webhook must
    win: the booking stays unconfirmed, no ledger row, owner is alerted, and the
    processed marker is written so Razorpay stops retrying."""
    bid = _booking(room="224")  # a deluxe-pool room
    blocks_service.create_block(scope="category", category="deluxe",
                                start=datetime.now(config.IST), reason="owner use",
                                created_by="owner")
    assert _post(client, _event(bid)).status_code == 200
    assert _booking_doc(bid)["status"] == "pending_payment"  # NOT confirmed
    assert _payments() == []
    assert _kinds(notif) == ["web_blocked_after_hold"]
    notif.wa.assert_not_called()
    assert "pay_1" in DB.dump("processed_webhooks")
    # redelivery is idempotent (marker already present) -> no extra work/alerts
    assert _post(client, _event(bid)).status_code == 200
    assert notif.alert.call_count == 1


def test_second_distinct_payment_on_confirmed_booking_alerts_no_second_row(client, notif):
    bid = _booking()
    assert _post(client, _event(bid, payment_id="pay_1")).status_code == 200
    assert _post(client, _event(bid, payment_id="pay_2")).status_code == 200
    assert len(_payments()) == 1
    notif.wa.assert_called_once()
    assert _kinds(notif) == ["web_booking", "web_duplicate_payment"]
    assert _booking_doc(bid)["razorpay_payment_id"] == "pay_1"
    assert "pay_2" in DB.dump("processed_webhooks")
    # redelivery of the duplicate is itself a no-op
    assert _post(client, _event(bid, payment_id="pay_2")).status_code == 200
    assert notif.alert.call_count == 2


def test_amount_mismatch_does_not_confirm(client, notif):
    bid = _booking()
    assert _post(client, _event(bid, amount_paise=100)).status_code == 200
    assert _booking_doc(bid)["status"] == "pending_payment"
    assert _payments() == []
    assert _kinds(notif) == ["web_amount_mismatch"]
    notif.ntfy.assert_called_once()
    notif.wa.assert_not_called()


def test_missing_booking_alerts_and_returns_200(client, notif):
    r = _post(client, _event("ghost"))
    assert r.status_code == 200
    assert _payments() == []
    assert _kinds(notif) == ["web_payment_no_booking"]
    notif.ntfy.assert_called_once()
    assert "pay_1" in DB.dump("processed_webhooks")


def test_other_events_ignored(client, notif):
    bid = _booking()
    r = _post(client, _event(bid, event="payment.captured"))
    assert r.status_code == 200
    assert _booking_doc(bid)["status"] == "pending_payment"
    assert DB.dump("processed_webhooks") == {}
    notif.wa.assert_not_called()


def test_whatsapp_failure_does_not_break_confirm(client, notif):
    notif.wa.side_effect = RuntimeError("twilio down")
    bid = _booking()
    assert _post(client, _event(bid)).status_code == 200
    assert _booking_doc(bid)["status"] == "confirmed"
    assert len(_payments()) == 1


def test_payment_write_refused_rolls_back_and_5xx(client, notif):
    """If the ledger row can't be queued, the booking must NOT be confirmed
    (Razorpay retries on non-2xx)."""
    from services import payment_service
    bid = _booking()
    with patch.object(payment_service, "write_payment", return_value=False):
        r = _post(client, _event(bid))
    assert r.status_code == 500
    assert _booking_doc(bid)["status"] == "pending_payment"
    assert DB.dump("processed_webhooks") == {}


# ---- service-level unit tests ------------------------------------------------

def test_verify_webhook_signature_unit(monkeypatch):
    monkeypatch.setenv("RAZORPAY_WEBHOOK_SECRET", SECRET)
    raw = b'{"a": 1}'
    good = hmac.new(SECRET.encode(), raw, hashlib.sha256).hexdigest()
    assert razorpay_service.verify_webhook_signature(raw, good) is True
    assert razorpay_service.verify_webhook_signature(raw, good[:-1] + "0") is False
    assert razorpay_service.verify_webhook_signature(raw + b" ", good) is False
    assert razorpay_service.verify_webhook_signature(raw, "") is False
    assert razorpay_service.verify_webhook_signature(raw, None) is False
    monkeypatch.delenv("RAZORPAY_WEBHOOK_SECRET")
    empty_key = hmac.new(b"", raw, hashlib.sha256).hexdigest()
    assert razorpay_service.verify_webhook_signature(raw, empty_key) is False


def test_notify_owner_noop_without_topic_and_swallows_errors(monkeypatch):
    monkeypatch.delenv("NTFY_TOPIC", raising=False)
    with patch("services.system_alerts.requests.post") as post:
        system_alerts.notify_owner("hi")
        post.assert_not_called()
    monkeypatch.setenv("NTFY_TOPIC", "my-topic")
    with patch("services.system_alerts.requests.post", side_effect=OSError("boom")) as post:
        system_alerts.notify_owner("hi", title="T")  # must not raise
        assert post.call_args.args[0] == "https://ntfy.sh/my-topic"
        assert post.call_args.kwargs["timeout"] <= 10
