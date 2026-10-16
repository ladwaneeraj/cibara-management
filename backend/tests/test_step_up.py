"""Phase 2 step-up re-auth: the action mapper, the token/grace store, the
/api/v2/authorize endpoint, and the bridge gate (428)."""
import pytest

from cibara_api.security import step_up
from cibara_api.settings import get_settings


class _S:
    STEP_UP_DISCOUNT_MIN = 2000
    STEP_UP_REFUND_MIN = 1000


@pytest.fixture(autouse=True)
def _clear_store():
    step_up.store.clear()
    yield
    step_up.store.clear()


@pytest.fixture
def step_up_on():
    s = get_settings()
    old = s.STEP_UP_AUTH
    s.STEP_UP_AUTH = True
    yield
    s.STEP_UP_AUTH = old


# ── mapper ────────────────────────────────────────────────────────────────
def test_mapper_always_gated_actions():
    s = _S()
    assert step_up.required("POST", "/cancel_bill", {"bill_id": "B1"}, s).action == "cancel_bill"
    assert step_up.required("POST", "/issue_credit_note", {"bill_id": "B1", "amount": 500}, s).action == "credit_note"
    assert step_up.required("POST", "/add_bill_payment",
                            {"bill_id": "B1", "is_bad_debt": True, "discount": 300}, s).action == "bad_debt"
    assert step_up.required("POST", "/add_bill_payment",
                            {"bill_id": "B1", "discount_type": "credit_note", "discount": 300}, s).action == "credit_note"
    assert step_up.required("POST", "/collect_settlement",
                            {"settlement_id": "S1", "bad_debt": True}, s).action == "writeoff"


def test_mapper_thresholds_and_passthrough():
    s = _S()
    # a plain payment is money IN → never gated
    assert step_up.required("POST", "/add_bill_payment", {"bill_id": "B", "amount": 50000}, s) is None
    # small discount passes; large discount is gated
    assert step_up.required("POST", "/add_bill_payment", {"bill_id": "B", "discount": 500}, s) is None
    assert step_up.required("POST", "/add_bill_payment", {"bill_id": "B", "discount": 2000}, s).action == "discount"
    # a normal checkout passes; a small manual refund passes; a large one is gated
    assert step_up.required("POST", "/checkout", {"room": "1"}, s) is None
    assert step_up.required("POST", "/checkout",
                            {"room": "1", "is_refund": True, "process_refund": True, "amount": 500}, s) is None
    assert step_up.required("POST", "/checkout",
                            {"room": "1", "is_refund": True, "process_refund": True, "amount": 1500}, s).action == "refund"
    # wrong method / unknown path
    assert step_up.required("GET", "/cancel_bill", {"bill_id": "B"}, s) is None
    assert step_up.required("POST", "/get_data", {}, s) is None


# ── store ─────────────────────────────────────────────────────────────────
def test_store_single_use_action_and_amount_binding():
    assert step_up.store.consume(step_up.store.issue("admin", "discount", 3000, "B1", 120),
                                 "refund", 3000, "B1") is None           # wrong action
    assert step_up.store.consume(step_up.store.issue("admin", "discount", 3000, "B1", 120),
                                 "discount", 4000, "B1") is None          # over ceiling
    t = step_up.store.issue("admin", "discount", 3000, "B1", 120)
    assert step_up.store.consume(t, "discount", 2500, "B1") == "admin"    # valid
    assert step_up.store.consume(t, "discount", 2500, "B1") is None       # single-use


def test_store_token_expiry(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(step_up.time, "monotonic", lambda: clock[0])
    t = step_up.store.issue("admin", "cancel_bill", 0, "B1", 10)  # expires at 1010
    clock[0] = 1011.0  # advance past expiry
    assert step_up.store.consume(t, "cancel_bill", 0, "B1") is None


def test_store_grace_window():
    assert step_up.store.in_grace("admin", "cancel_bill", "B1") is False
    step_up.store.set_grace("admin", "cancel_bill", "B1", 120)
    assert step_up.store.in_grace("admin", "cancel_bill", "B1") is True


# ── /api/v2/authorize ───────────────────────────────────────────────────────
def test_authorize_requires_admin(client, manager):
    r = client.post("/api/v2/authorize", json={"action": "cancel_bill", "password": "secret123"}, headers=manager)
    assert r.status_code == 403


def test_authorize_bad_password_denied(client, admin):
    r = client.post("/api/v2/authorize", json={"action": "discount", "amount": 3000, "password": "WRONG"}, headers=admin)
    assert r.status_code in (400, 401)


def test_authorize_success_returns_token(client, admin):
    r = client.post("/api/v2/authorize",
                    json={"action": "discount", "amount": 3000, "password": "secret123"}, headers=admin)
    assert r.status_code == 200, r.text
    assert r.json()["token"]


def test_authorize_unknown_action_rejected(client, admin):
    r = client.post("/api/v2/authorize", json={"action": "nonsense", "password": "secret123"}, headers=admin)
    assert r.status_code == 400


# ── bridge gate (428) ───────────────────────────────────────────────────────
def test_gate_blocks_without_token(client, admin, step_up_on):
    r = client.post("/cancel_bill", json={"bill_id": "DOES_NOT_EXIST"}, headers=admin)
    assert r.status_code == 428
    assert r.json().get("code") == "step_up_required"


def test_gate_passes_with_valid_token(client, admin, step_up_on):
    tok = client.post("/api/v2/authorize",
                      json={"action": "cancel_bill", "password": "secret123"}, headers=admin).json()["token"]
    r = client.post("/cancel_bill", json={"bill_id": "DOES_NOT_EXIST"},
                    headers={**admin, "X-Step-Up-Token": tok})
    # The gate let it through to the route (which rejects the bogus bill id) —
    # the point is it is no longer a 428 step-up block.
    assert r.status_code != 428


def test_gate_ignores_non_gated_requests(client, admin, step_up_on):
    # A plain dashboard read is never gated even with step-up on.
    assert client.get("/api/v2/dashboard", headers=admin).status_code == 200
