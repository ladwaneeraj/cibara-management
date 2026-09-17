"""
request_guard: the server half of the double-submit protection.

Firestore is replaced by an in-memory dict so these tests exercise the
decorator's decisions (replay, reject, release, force) without a network.
"""
from __future__ import annotations

import json

import pytest
from flask import Flask, jsonify, request

from services import request_guard as rg


@pytest.fixture
def store(monkeypatch):
    """In-memory stand-ins for the four Firestore touch points."""
    fps: dict[str, float] = {}     # fingerprint -> claimed-at (fake clock)
    ops: dict[str, dict] = {}      # op doc id -> stored response
    clock = {"now": 100.0}

    def claim(fp, path, window):
        at = fps.get(fp)
        if at is not None and 0 <= clock["now"] - at < window:
            return clock["now"] - at
        fps[fp] = clock["now"]
        return None

    monkeypatch.setattr(rg, "_claim_fingerprint", claim)
    monkeypatch.setattr(rg, "_release_fingerprint", lambda fp: fps.pop(fp, None))
    monkeypatch.setattr(rg, "_lookup_op", lambda op: ops.get(rg._op_doc_id(op)))
    monkeypatch.setattr(
        rg, "_store_op",
        lambda op, path, status, body: ops.__setitem__(
            rg._op_doc_id(op), {"status": status, "body": body}))
    return {"fps": fps, "ops": ops, "clock": clock}


@pytest.fixture
def client():
    app = Flask(__name__)
    calls = {"n": 0, "fail_next": False}

    @app.route("/pay", methods=["POST"])
    @rg.guard_duplicate_submit(window_seconds=8)
    def pay():
        calls["n"] += 1
        if calls["fail_next"]:
            calls["fail_next"] = False
            return jsonify(success=False, message="nope")
        return jsonify(success=True, n=calls["n"], amount=request.json["amount"])

    app.calls = calls
    return app.test_client(), calls


def post(c, body, headers=None):
    return c.post("/pay", data=json.dumps(body),
                  content_type="application/json", headers=headers or {})


def test_first_write_passes_and_is_counted(client, store):
    c, calls = client
    r = post(c, {"room": "27", "amount": 500, "payment_mode": "cash"})
    assert r.status_code == 200 and r.get_json()["success"]
    assert calls["n"] == 1


def test_same_intent_seconds_later_is_rejected_without_running_route(client, store):
    c, calls = client
    body = {"room": "27", "amount": 500, "payment_mode": "cash"}
    post(c, body)
    store["clock"]["now"] += 1.2
    r = post(c, dict(body, op_id="different-click"))
    assert r.status_code == 409
    data = r.get_json()
    assert data["duplicate_suspected"] and data["seconds_ago"] == 1.2
    assert calls["n"] == 1, "the route must not have run a second time"


def test_volatile_fields_do_not_make_a_request_look_new(client, store):
    c, calls = client
    post(c, {"room": "27", "amount": 500, "time": "23:59", "room_data": {"balance": 0}})
    r = post(c, {"room": "27", "amount": 500, "time": "00:00", "room_data": {"balance": -500}})
    assert r.status_code == 409 and calls["n"] == 1


def test_after_window_same_intent_is_allowed(client, store):
    c, calls = client
    body = {"room": "27", "amount": 500}
    post(c, body)
    store["clock"]["now"] += 9
    assert post(c, body).status_code == 200 and calls["n"] == 2


def test_force_header_bypasses_fingerprint(client, store):
    c, calls = client
    body = {"room": "27", "amount": 500}
    post(c, body)
    r = post(c, body, headers={"X-Force-Duplicate": "1"})
    assert r.status_code == 200 and calls["n"] == 2


def test_same_op_id_replays_stored_answer(client, store):
    c, calls = client
    body = {"room": "27", "amount": 500}
    first = post(c, body, headers={"X-Op-Id": "abc"}).get_json()
    store["clock"]["now"] += 5   # inside the window, would otherwise be a 409
    again = post(c, body, headers={"X-Op-Id": "abc"})
    assert again.status_code == 200
    data = again.get_json()
    assert data["replayed"] is True and data["n"] == first["n"]
    assert calls["n"] == 1


def test_failed_route_releases_claim_so_retry_is_immediate(client, store):
    c, calls = client
    calls["fail_next"] = True
    body = {"room": "27", "amount": 500}
    assert post(c, body).get_json()["success"] is False
    r = post(c, body)
    assert r.status_code == 200 and r.get_json()["success"]


def test_different_amounts_are_different_intents(client, store):
    c, calls = client
    post(c, {"room": "27", "amount": 500})
    assert post(c, {"room": "27", "amount": 30}).status_code == 200
    assert calls["n"] == 2


def test_non_json_posts_pass_through(client, store):
    c, calls = client
    r = c.post("/pay", data="raw", content_type="text/plain")
    # The route itself blows up on request.json for non-JSON, which is the
    # pre-existing behaviour; what matters is the guard did not intercept.
    assert r.status_code in (200, 400, 415, 500)
