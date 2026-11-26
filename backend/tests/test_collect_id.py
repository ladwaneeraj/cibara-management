"""
Guest ID self-upload (collect_id) — the security-critical bits.

Covers the signed-link token (round-trip, expiry, tampering, wrong type), the
short-code indirection, the "already uploaded" short-circuit, the OCR guest-list
normaliser, and the public page's HTML escaping. These are unit tests over the
module functions — the fakes from conftest give collect_id a real (in-memory)
Firestore for the short-code and customer lookups.
"""
from __future__ import annotations

import time

import jwt
import pytest
from fastapi import HTTPException

from cibara_api import collect_id_page as page
from cibara_api.routers import collect_id as c
from cibara_api.settings import get_settings


# ── token ──────────────────────────────────────────────────────────────────

def test_token_roundtrip():
    tok = c._sign(mobile="9916593806", name="Deepak", room="225",
                  booking_id="b1", exp_ts=int(time.time()) + 3600)
    d = c._verify(tok)
    assert d["m"] == "9916593806"
    assert d["r"] == "225"
    assert d["b"] == "b1"
    assert d["typ"] == c.TOKEN_TYP


def test_token_expired_is_410():
    tok = c._sign(mobile="9916593806", name="X", room="1",
                  booking_id="b", exp_ts=int(time.time()) - 5)
    with pytest.raises(HTTPException) as e:
        c._verify(tok)
    assert e.value.status_code == 410


def test_token_tampered_is_400():
    tok = c._sign(mobile="9916593806", name="X", room="1",
                  booking_id="b", exp_ts=int(time.time()) + 3600)
    with pytest.raises(HTTPException) as e:
        c._verify(tok + "x")
    assert e.value.status_code == 400


def test_token_wrong_type_rejected():
    # A validly-signed token that is NOT an id_collect token must be refused, so
    # an access/refresh token can never be replayed against the upload endpoint.
    s = get_settings()
    bad = jwt.encode({"typ": "access", "iss": s.JWT_ISSUER, "m": "9916593806",
                      "exp": int(time.time()) + 60}, s.JWT_SECRET, algorithm="HS256")
    with pytest.raises(HTTPException) as e:
        c._verify(bad)
    assert e.value.status_code == 400


def test_checkout_exp_capped_and_fallback():
    now = int(time.time())
    # A far-future checkout is clamped to the max TTL.
    assert c._checkout_exp("2099-01-01") <= now + c._MAX_TTL_DAYS * 86400 + 5
    # An unparseable date falls back to the default window.
    assert abs(c._checkout_exp("garbage") - (now + c._DEFAULT_TTL_DAYS * 86400)) < 5
    # A near checkout still gets a couple of days of grace.
    soon = time.strftime("%Y-%m-%d", time.gmtime(now))
    assert c._checkout_exp(soon) >= now + 86400


# ── short code + already-uploaded (use the fake Firestore) ──────────────────

def test_short_code_roundtrip():
    tok = c._sign(mobile="9916593806", name="D", room="1",
                  booking_id="b", exp_ts=int(time.time()) + 3600)
    code = c._make_short(tok, int(time.time()) + 3600)
    assert code
    assert c._resolve_short(code) == tok
    assert c._resolve_short("does-not-exist") is None


def test_already_uploaded():
    from config import db
    db.collection("customers").document("9000000123").set({"id_doc_count": 2})
    db.collection("customers").document("9000000124").set({"id_doc_count": 0})
    assert c._already_uploaded("9000000123") is True
    assert c._already_uploaded("9000000124") is False
    assert c._already_uploaded("9000000999") is False  # no such customer


# ── OCR guest-list normaliser ───────────────────────────────────────────────

def test_extract_guest_list_normalises(monkeypatch):
    from services import ocr_service

    class _Resp:
        text = ('{"guests":['
                '{"room":"Room 203","name":"Rajeev","mobile":"+91 63618 00647"},'
                '{"room":"205","name":"Amir Khan","mobile":"6361800667"},'
                '{"room":"","name":"No Number","mobile":"123"}]}')

    class _Model:
        def generate_content(self, *a, **k):
            return _Resp()

    monkeypatch.setattr(ocr_service, "_SDK_AVAILABLE", True)
    monkeypatch.setattr(ocr_service, "_configured", True)
    monkeypatch.setattr(ocr_service, "_model", _Model())

    res = ocr_service.extract_guest_list(b"img", "image/jpeg")
    assert res["success"] is True
    g = res["guests"]
    assert g[0] == {"room": "203", "name": "Rajeev", "mobile": "6361800647"}  # +91 stripped
    assert g[1] == {"room": "205", "name": "Amir Khan", "mobile": "6361800667"}
    assert g[2]["mobile"] == ""  # a 3-digit "number" is dropped, never guessed


def test_extract_guest_list_disabled():
    # No OCR configured → a clean disabled result, never a crash.
    from services import ocr_service
    if not ocr_service.is_enabled():
        assert ocr_service.extract_guest_list(b"x", "image/jpeg") == \
            {"success": False, "reason": "ocr_disabled"}


# ── public page ─────────────────────────────────────────────────────────────

def test_page_escapes_and_has_four_slots():
    html = page.render_page(token="tok", guest_name="A <b>", room="203", already=False)
    assert "A &lt;b&gt;" in html          # guest name is escaped
    assert html.count('type="file"') == 4  # four photo slots
    assert "tok" in html


def test_error_page():
    assert "This link has expired." in page.render_error("This link has expired.")


# ── expected check-in time (guest-entered, 24h) ─────────────────────────────

def test_valid_checkin_accepts_24h_only():
    assert c._valid_checkin("07:30") == "07:30"
    assert c._valid_checkin("23:59") == "23:59"
    assert c._valid_checkin("00:00") == "00:00"
    assert c._valid_checkin(" 9:05 ") == ""     # not zero-padded HH
    assert c._valid_checkin("24:00") == ""      # out of range
    assert c._valid_checkin("7:30 PM") == ""    # 12h / junk rejected
    assert c._valid_checkin("") == ""


def test_page_prefills_checkin_field():
    html = page.render_page(token="tok", guest_name="A", room="203", already=False,
                            booking={"check_in_time": "19:30:00"})
    assert 'id="gci-btn"' in html            # the clock-picker trigger button
    assert 'data-val="19:30"' in html        # 24h value carried for submit (seconds trimmed)
    assert "7:30 PM" in html                 # 12h label shown to the guest


def test_fmt12_conversions():
    assert page._fmt12("19:30") == "7:30 PM"
    assert page._fmt12("00:05") == "12:05 AM"
    assert page._fmt12("12:00") == "12:00 PM"
    assert page._fmt12("09:00") == "9:00 AM"
    assert page._fmt12("") == "" and page._fmt12("bad") == ""
