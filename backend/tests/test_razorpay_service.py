"""services.razorpay_service: Razorpay test/live mode detection."""
from services import razorpay_service


def test_is_test_mode(monkeypatch):
    monkeypatch.setenv("RAZORPAY_KEY_ID", "rzp_test_abc123")
    assert razorpay_service.is_test_mode() is True
    monkeypatch.setenv("RAZORPAY_KEY_ID", "RZP_TEST_UPPER")
    assert razorpay_service.is_test_mode() is True
    monkeypatch.setenv("RAZORPAY_KEY_ID", "rzp_live_abc123")
    assert razorpay_service.is_test_mode() is False
    monkeypatch.delenv("RAZORPAY_KEY_ID", raising=False)
    assert razorpay_service.is_test_mode() is False
