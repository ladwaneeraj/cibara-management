"""Session hardening + legacy-bridge safety nets added after review."""
import time

import pytest
from firebase_admin import auth as fb_auth

from tests.conftest import AUTH, login, make_user

from cibara_api.core import metrics
from cibara_api.security import revocation, tokens


def _set_cookie(client, value):
    client.cookies.clear()
    client.cookies.set("cibara_rt", value, domain="testserver.local", path="/api/v2/auth")


def _cookie(client):
    return client.cookies.get("cibara_rt")


# ── refresh families ──────────────────────────────────────────────────────

def test_reused_refresh_cookie_kills_the_family(client, monkeypatch):
    monkeypatch.setattr(revocation, "FAMILY_GRACE_SECONDS", 0)
    make_user("fam1", "manager")
    login(client, "fam1")
    c1 = _cookie(client)
    assert client.post("/api/v2/auth/refresh").status_code == 200
    c2 = _cookie(client)
    time.sleep(0.01)
    _set_cookie(client, c1)                       # a copied, already-rotated cookie
    assert client.post("/api/v2/auth/refresh").status_code == 401
    _set_cookie(client, c2)                       # the legitimate one is dead too
    assert client.post("/api/v2/auth/refresh").status_code == 401


def test_concurrent_tabs_within_grace_are_fine(client):
    make_user("fam2", "manager")
    login(client, "fam2")
    c1 = _cookie(client)
    assert client.post("/api/v2/auth/refresh").status_code == 200
    _set_cookie(client, c1)                       # second tab raced with the old cookie
    assert client.post("/api/v2/auth/refresh").status_code == 200


def test_unknown_family_after_restart_is_adopted(client):
    make_user("fam3", "manager")
    login(client, "fam3")
    revocation.clear_families()                   # simulates a new process
    assert client.post("/api/v2/auth/refresh").status_code == 200


def test_logout_kills_the_family(client):
    make_user("fam4", "manager")
    login(client, "fam4")
    c1 = _cookie(client)
    assert client.post("/api/v2/auth/logout").status_code == 200
    _set_cookie(client, c1)
    assert client.post("/api/v2/auth/refresh").status_code == 401


def test_absolute_session_cap(client):
    rec = make_user("fam5", "manager")
    u = tokens.TokenUser("fam5", rec.uid, "manager", "fam5")
    old, _ = tokens.mint_refresh(u, auth_time=int(time.time()) - 31 * 86400)
    _set_cookie(client, old)
    r = client.post("/api/v2/auth/refresh")
    assert r.status_code == 401 and "expired" in r.json()["message"]


def test_rotation_carries_auth_time(client):
    make_user("fam6", "manager")
    login(client, "fam6")
    first = tokens.decode(_cookie(client), tokens.REFRESH)["auth_time"]
    time.sleep(1.1)
    client.post("/api/v2/auth/refresh")
    assert tokens.decode(_cookie(client), tokens.REFRESH)["auth_time"] == first


def test_firebase_outage_on_refresh_is_503_and_keeps_cookie(client, monkeypatch):
    make_user("fam7", "manager")
    login(client, "fam7")

    def boom(uid):
        raise RuntimeError("network down")
    monkeypatch.setattr(fb_auth, "get_user", boom)
    r = client.post("/api/v2/auth/refresh")
    assert r.status_code == 503
    assert "cibara_rt" not in r.headers.get("set-cookie", "")


def test_deleted_firebase_user_is_401(client):
    rec = make_user("fam8", "manager")
    login(client, "fam8")
    AUTH.delete_user(rec.uid)
    assert client.post("/api/v2/auth/refresh").status_code == 401


# ── legacy bridge safety nets ─────────────────────────────────────────────

def test_classic_page_does_not_leak_api_key(client, monkeypatch):
    monkeypatch.setenv("API_KEY", "integration-key-123456")
    r = client.get("/legacy")
    assert r.status_code == 200 and "<html" in r.text.lower()
    assert "integration-key-123456" not in r.text
    assert 'const _API_KEY = ""' in r.text


def test_api_key_still_works_for_integrations(client, monkeypatch):
    monkeypatch.setenv("API_KEY", "integration-key-123456")
    assert client.get("/get_data").status_code == 401
    assert client.get("/get_data", headers={"X-API-Key": "integration-key-123456"}).status_code == 200


def test_no_anonymous_reads_on_cloud_run(client, admin, monkeypatch):
    monkeypatch.setenv("K_SERVICE", "cibara")
    monkeypatch.delenv("API_KEY", raising=False)
    assert client.get("/get_data").status_code == 401
    assert client.get("/get_data", headers=admin).status_code == 200
    assert client.get("/legacy").status_code == 200       # public shell page
    assert client.get("/health").status_code == 200


def test_anonymous_reads_still_allowed_locally(client, monkeypatch):
    monkeypatch.delenv("K_SERVICE", raising=False)
    monkeypatch.delenv("API_KEY", raising=False)
    assert client.get("/get_data").status_code == 200     # legacy dev mode, unchanged


def test_classic_users_screen_force_logout_revokes_jwt(client, admin):
    make_user("desk9", "manager")
    victim = {"Authorization": "Bearer " + login(client, "desk9")["access_token"]}
    assert client.get("/api/v2/auth/me", headers=victim).status_code == 200
    time.sleep(1.1)
    r = client.post("/api/users/desk9/force-logout", headers=admin)   # classic UI path
    assert r.status_code == 200, r.text
    assert client.get("/api/v2/auth/me", headers=victim).status_code == 401


def test_classic_users_screen_rename_does_not_revoke(client, admin):
    make_user("desk10", "manager")
    victim = {"Authorization": "Bearer " + login(client, "desk10")["access_token"]}
    time.sleep(1.1)
    r = client.patch("/api/users/desk10", headers=admin, json={"name": "Desk Ten"})
    assert r.status_code == 200, r.text
    assert client.get("/api/v2/auth/me", headers=victim).status_code == 200


def test_legacy_404s_share_one_metrics_row(client):
    metrics.reset()
    for p in ("/wp-login.php", "/.env", "/xyz/abc"):
        assert client.get(p).status_code in (401, 404)
    routes = {r["route"] for r in metrics.snapshot()["routes"]}
    assert not any("wp-login" in r or ".env" in r for r in routes)


def test_metrics_registry_is_bounded():
    metrics.reset()
    for i in range(metrics._MAX_ROUTES + 50):
        metrics.record(f"GET /r{i}", 1, 200, 0, 0)
    snap = metrics.snapshot()
    assert len(snap["routes"]) == metrics._MAX_ROUTES + 1
    assert any(r["route"] == "other" and r["count"] == 50 for r in snap["routes"])
