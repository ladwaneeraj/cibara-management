"""POST /web/order: server-priced Razorpay order for a held booking (SDK mocked)."""
from datetime import datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest

import config
from services import availability_service as av
from services import razorpay_service

SECRET = "rzp_test_SECRET_VALUE_xyz"
KEY_ID = "rzp_test_KEYID123"


@pytest.fixture(autouse=True)
def _rzp_env(monkeypatch):
    monkeypatch.setenv("RAZORPAY_KEY_ID", KEY_ID)
    monkeypatch.setenv("RAZORPAY_KEY_SECRET", SECRET)


def _hold(booking_id="bk1", status="pending_payment", total=4500, expires_in_min=10):
    exp = (datetime.now(config.IST) + timedelta(minutes=expires_in_min)).isoformat()
    config.bookings_ref.document(booking_id).set({
        "room": "101", "guest_name": "Asha Rao", "guest_mobile": "9876543210",
        "status": status, "booking_source": "web", "total_amount": total,
        "paid_amount": 0, "balance": total, "expires_at": exp,
    })
    return booking_id


def test_order_amount_from_booking(client):
    bid = _hold(total=4500)
    with patch.object(razorpay_service, "create_order", return_value={"id": "order_X1"}) as m:
        r = client.post("/web/order", json={"booking_id": bid, "amount": 1})
    assert r.status_code == 200, r.text
    expected = av.to_paise(4500)
    m.assert_called_once_with(expected, receipt=bid)
    assert r.json() == {"order_id": "order_X1", "key_id": KEY_ID, "amount": expected}


def test_order_returns_key_id_not_secret(client):
    bid = _hold()
    with patch.object(razorpay_service, "create_order", return_value={"id": "order_X2"}):
        r = client.post("/web/order", json={"booking_id": bid})
    assert r.status_code == 200
    assert r.json()["key_id"] == KEY_ID
    assert SECRET not in r.text


def test_order_404_for_missing_hold(client):
    with patch.object(razorpay_service, "create_order") as m:
        r = client.post("/web/order", json={"booking_id": "nope"})
        assert r.status_code == 404
        expired = _hold("old", expires_in_min=-5)
        r2 = client.post("/web/order", json={"booking_id": expired})
        assert r2.status_code == 404
        assert client.post("/web/order", json={}).status_code == 404
    m.assert_not_called()


def test_order_409_if_already_confirmed(client):
    bid = _hold(status="confirmed")
    with patch.object(razorpay_service, "create_order") as m:
        r = client.post("/web/order", json={"booking_id": bid})
    assert r.status_code == 409
    m.assert_not_called()


def test_service_create_order_uses_sdk_with_env_keys():
    fake = MagicMock()
    fake.order.create.return_value = {"id": "order_Z", "amount": 450000}
    with patch("services.razorpay_service.razorpay.Client", return_value=fake) as cls:
        out = razorpay_service.create_order(450000, receipt="bk1")
    cls.assert_called_once_with(auth=(KEY_ID, SECRET))
    fake.order.create.assert_called_once_with(
        {"amount": 450000, "currency": "INR", "receipt": "bk1"})
    assert out["id"] == "order_Z"
