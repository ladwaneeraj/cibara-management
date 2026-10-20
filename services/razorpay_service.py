"""Thin Razorpay wrapper. Keys come only from the environment.

RAZORPAY_KEY_SECRET must never leave this module (never returned to a client,
never logged). Callers get plain order dicts back.
"""
import hashlib
import hmac
import os

import razorpay


def _client():
    return razorpay.Client(auth=(os.environ.get("RAZORPAY_KEY_ID", ""),
                                 os.environ.get("RAZORPAY_KEY_SECRET", "")))


def create_order(amount_paise: int, receipt: str) -> dict:
    """Create a Razorpay order (INR) and return the order dict (includes ``id``)."""
    return _client().order.create({
        "amount": int(amount_paise),
        "currency": "INR",
        "receipt": receipt,
    })


def verify_webhook_signature(raw_body: bytes, signature) -> bool:
    """True iff ``signature`` is the hex HMAC-SHA256 of the RAW body under
    ``RAZORPAY_WEBHOOK_SECRET``.

    Fails closed: an unset/blank secret rejects everything (an empty-key HMAC is
    trivially forgeable). Constant-time comparison.
    """
    secret = os.environ.get("RAZORPAY_WEBHOOK_SECRET", "")
    if not secret or not signature or not isinstance(signature, str):
        return False
    expected = hmac.new(secret.encode(), raw_body or b"", hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)
