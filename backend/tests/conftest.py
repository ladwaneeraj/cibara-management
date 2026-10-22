"""
Test bootstrap for the FastAPI layer.

Installs in-memory Firebase fakes BEFORE the legacy config.py is imported, so
the whole stack — FastAPI → legacy Flask routes → services → "Firestore" —
runs for real in-process. See tests/fakes/fake_firestore.py.
"""
from __future__ import annotations

import base64
import json
import os
import sys
import time
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
REPO = BACKEND.parent
for p in (str(REPO), str(BACKEND)):
    if p not in sys.path:
        sys.path.insert(0, p)
os.chdir(REPO)  # config.py writes lodge.log / uploads relative to CWD

os.environ.setdefault("CIBARA_ENV", "UAT")
os.environ["FIREBASE_CREDENTIALS"] = base64.b64encode(json.dumps({"project_id": "cibara-dev"}).encode()).decode()
os.environ.setdefault("JWT_SECRET", "test-secret-" + "x" * 40)
os.environ.setdefault("RATE_LIMIT_GLOBAL_PER_MIN", "100000")
os.environ.setdefault("RATE_LIMIT_WRITES_PER_USER_PER_MIN", "100000")
# Step-up re-auth gate off by default in tests (it is off in a running env until
# the client prompt ships); test_step_up.py enables it per-test to exercise it.
os.environ.setdefault("STEP_UP_AUTH", "false")
os.environ.pop("API_KEY", None)

from tests.fakes import fake_firebase as F  # noqa: E402
from tests.fakes import fake_firestore as FF  # noqa: E402

F.install()

from cibara_api.core import metrics  # noqa: E402

FF.on_read = metrics.count_reads
FF.on_write = metrics.count_writes

from fastapi.testclient import TestClient  # noqa: E402

from cibara_api import main as api_main  # noqa: E402
from cibara_api.core.ratelimit import limiter  # noqa: E402
from cibara_api.security import passwords, revocation  # noqa: E402

DB = F.FAKE_DB
AUTH = F.FAKE_AUTH

# Let config.initialize_data (started on a thread at import) finish seeding.
for _ in range(50):
    if DB.dump("rooms"):
        break
    time.sleep(0.1)
_SEED = {p: d for p, d in DB._store.docs.items()}
_SEED_META = dict(DB._store.meta)


def _fake_verify_password(user_id: str, password: str):
    from services.auth_service import to_synthetic_email
    err, uid = AUTH.check_password(to_synthetic_email(user_id), password)
    if err:
        status, msg = passwords._ERRORS[err]
        raise passwords.PasswordCheckError(err, status, msg)
    return passwords.PasswordOk(auth_uid=uid)


REAL_VERIFY = passwords.verify_password
passwords.verify_password = _fake_verify_password


def make_user(user_id: str, role: str, password: str = "secret123", name: str | None = None,
              active: bool = True):
    rec = AUTH.create_user(email=f"{user_id}@cibara.internal", password=password,
                           display_name=name or user_id.title())
    AUTH.set_custom_user_claims(rec.uid, {"role": role, "userId": user_id, "name": name or user_id.title()})
    DB.collection("users").document(user_id).set({
        "userId": user_id, "name": name or user_id.title(), "role": role, "isActive": active,
        "authUid": rec.uid, "createdBy": "test", "createdAt": "2026-01-01 00:00:00", "lastLoginAt": None})
    return rec


@pytest.fixture(autouse=True)
def _reset_state():
    import copy
    DB._store.docs = copy.deepcopy(_SEED)
    DB._store.meta = dict(_SEED_META)
    AUTH.reset()
    F.FAKE_BUCKET._objects.clear()
    limiter.reset()
    revocation.clear()
    from cibara_api.core import metrics as _m
    _m.reset()
    # legacy in-process caches
    import config
    config.invalidate_cache()
    try:
        from routes import rooms as legacy_rooms
        legacy_rooms._invalidate_get_data_cache()
    except Exception:
        pass
    try:
        from cibara_api.routers import rooms as api_rooms
        api_rooms._clear_tariffs_cache()
    except Exception:
        pass
    yield


@pytest.fixture(scope="session")
def client():
    with TestClient(api_main.app, base_url="http://testserver") as c:
        yield c


def login(client, user_id: str, password: str = "secret123") -> dict:
    r = client.post("/api/v2/auth/login", json={"user_id": user_id, "password": password})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture
def admin(client):
    make_user("admin", "admin")
    s = login(client, "admin")
    return {"Authorization": f"Bearer {s['access_token']}"}


@pytest.fixture
def manager(client):
    make_user("manager1", "manager")
    s = login(client, "manager1")
    return {"Authorization": f"Bearer {s['access_token']}"}


@pytest.fixture
def staff(client):
    make_user("hk1", "housekeeping")
    s = login(client, "hk1")
    return {"Authorization": f"Bearer {s['access_token']}"}
