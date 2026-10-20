"""Thin Razorpay wrapper. Keys come only from the environment.

RAZORPAY_KEY_SECRET must never leave this module (never returned to a client,
never logged). Callers get plain order dicts back.
"""
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
