import time

import jwt
import pytest

from tests.conftest import AUTH, DB, login, make_user

from cibara_api.security import tokens
from cibara_api.settings import get_settings


def test_login_success_returns_access_and_httponly_refresh_cookie(client):
    make_user("neeraj", "admin", name="Neeraj")
    r = client.post("/api/v2/auth/login", json={"user_id": "  Neeraj ", "password": "secret123"})
    assert r.status_code == 200
    body = r.json()
    assert {k: v for k, v in body["user"].items() if k != "authUid"} == {
        "userId": "neeraj", "name": "Neeraj", "role": "admin", "roleLabel": "Admin"}
    assert body["user"]["authUid"]
    assert "user.manage" in body["permissions"]
    assert body["expires_in"] == 15 * 60
    assert body["firebase_custom_token"]
    cookie = r.headers["set-cookie"]
    assert "cibara_rt=" in cookie and "HttpOnly" in cookie and "samesite=strict" in cookie.lower()
    assert "Path=/api/v2/auth" in cookie
    claims = jwt.decode(body["access_token"], get_settings().JWT_SECRET, algorithms=["HS256"],
                        issuer="cibara-api")
    assert claims["typ"] == "access" and claims["role"] == "admin" and claims["uid"] == "neeraj"
    assert claims["exp"] - claims["iat"] == 900
    # lastLoginAt stamped like the legacy /api/auth/me did
    assert DB.dump("users")["neeraj"]["lastLoginAt"]


def test_housekeeping_label_is_staff(client):
    make_user("hk9", "housekeeping")
    assert login(client, "hk9")["user"]["roleLabel"] == "Staff"


@pytest.mark.parametrize("pw", ["wrongpass", "short"])
def test_login_wrong_password(client, pw):
    make_user("bob", "manager")
    r = client.post("/api/v2/auth/login", json={"user_id": "bob", "password": pw})
    assert r.status_code == 401
    assert r.json() == {"success": False, "message": "Incorrect User ID or password."}


def test_login_unknown_user_writes_failed_audit(client):
    r = client.post("/api/v2/auth/login", json={"user_id": "ghost", "password": "secret123"})
    assert r.status_code == 401
    time.sleep(0.2)
    acts = [d["action"] for d in DB.dump("audit_logs").values()]
    assert "auth.login_failed" in acts


def test_login_disabled_firebase_user(client):
    rec = make_user("old", "manager")
    AUTH.update_user(rec.uid, disabled=True)
    r = client.post("/api/v2/auth/login", json={"user_id": "old", "password": "secret123"})
    assert r.status_code == 403


def test_login_inactive_profile_is_refused(client):
    make_user("gone", "manager", active=False)
    r = client.post("/api/v2/auth/login", json={"user_id": "gone", "password": "secret123"})
    assert r.status_code == 403
    assert "disabled" in r.json()["message"]


def test_login_without_role_claim_is_refused(client):
    rec = AUTH.create_user(email="noclaims@cibara.internal", password="secret123")
    r = client.post("/api/v2/auth/login", json={"user_id": "noclaims", "password": "secret123"})
    assert r.status_code == 403
    assert rec.uid


def test_login_rate_limited_per_account(client):
    make_user("target", "manager")
    for _ in range(8):
        client.post("/api/v2/auth/login", json={"user_id": "target", "password": "nope-nope"})
    r = client.post("/api/v2/auth/login", json={"user_id": "target", "password": "secret123"})
    assert r.status_code == 429
    assert int(r.headers["retry-after"]) > 0


def test_refresh_rotates_cookie_and_reflects_role_change(client):
    rec = make_user("ria", "manager")
    login(client, "ria")
    old_cookie = client.cookies.get("cibara_rt")
    time.sleep(1.1)
    AUTH.set_custom_user_claims(rec.uid, {"role": "admin", "userId": "ria", "name": "Ria"})
    r = client.post("/api/v2/auth/refresh")
    assert r.status_code == 200, r.text
    assert r.json()["user"]["role"] == "admin"
    assert client.cookies.get("cibara_rt") != old_cookie


def test_refresh_without_cookie(client):
    client.cookies.clear()
    r = client.post("/api/v2/auth/refresh")
    assert r.status_code == 401


def test_refresh_denied_after_firebase_revocation(client):
    rec = make_user("sam", "manager")
    login(client, "sam")
    time.sleep(1.1)
    AUTH.revoke_refresh_tokens(rec.uid)
    r = client.post("/api/v2/auth/refresh")
    assert r.status_code == 401
    assert 'cibara_rt=""' in r.headers.get("set-cookie", "") or "Max-Age=0" in r.headers.get("set-cookie", "")


def test_refresh_denied_when_disabled(client):
    rec = make_user("dee", "manager")
    login(client, "dee")
    AUTH.update_user(rec.uid, disabled=True)
    assert client.post("/api/v2/auth/refresh").status_code == 403


def test_refresh_token_cannot_be_used_as_access(client):
    make_user("eve", "admin")
    login(client, "eve")
    rt = client.cookies.get("cibara_rt")
    r = client.get("/api/v2/auth/me", headers={"Authorization": f"Bearer {rt}"})
    assert r.status_code == 401


def test_expired_access_token_rejected(client):
    rec = make_user("tim", "admin")
    user = tokens.TokenUser("tim", rec.uid, "admin", "Tim")
    payload = {"iss": "cibara-api", "typ": "access", "sub": rec.uid, "uid": "tim", "role": "admin",
               "name": "Tim", "iat": int(time.time()) - 3600, "exp": int(time.time()) - 60, "jti": "x"}
    tok = jwt.encode(payload, get_settings().JWT_SECRET, algorithm="HS256")
    r = client.get("/api/v2/auth/me", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 401
    assert r.json()["message"] == "Session expired"
    assert user.email == "tim@cibara.internal"


def test_tampered_token_rejected(client):
    make_user("max", "manager")
    tok = login(client, "max")["access_token"]
    forged = jwt.encode({**jwt.decode(tok, options={"verify_signature": False}), "role": "admin"},
                        "not-the-secret-" + "y" * 40, algorithm="HS256")
    assert client.get("/api/v2/auth/me", headers={"Authorization": f"Bearer {forged}"}).status_code == 401


def test_me_and_logout(client):
    make_user("amy", "manager")
    s = login(client, "amy")
    h = {"Authorization": f"Bearer {s['access_token']}"}
    me = client.get("/api/v2/auth/me", headers=h).json()
    assert me["user"]["userId"] == "amy" and "room.checkin" in me["permissions"]
    r = client.post("/api/v2/auth/logout")
    assert r.status_code == 200
    assert client.post("/api/v2/auth/refresh").status_code == 401


def test_password_change_revokes_sessions(client):
    make_user("pat", "manager")
    s = login(client, "pat")
    h = {"Authorization": f"Bearer {s['access_token']}"}
    bad = client.post("/api/v2/auth/password", headers=h,
                      json={"current_password": "wrong-one", "new_password": "newsecret1"})
    assert bad.status_code == 400
    ok = client.post("/api/v2/auth/password", headers=h,
                     json={"current_password": "secret123", "new_password": "newsecret1"})
    assert ok.status_code == 200
    # old access token dies immediately
    assert client.get("/api/v2/auth/me", headers=h).status_code == 401
    time.sleep(1.1)
    assert login(client, "pat", "newsecret1")["user"]["userId"] == "pat"
    time.sleep(0.2)
    acts = [d["action"] for d in DB.dump("audit_logs").values()]
    assert "auth.password_change" in acts and "auth.login" in acts


def test_firebase_token_endpoint(client, admin):
    r = client.get("/api/v2/auth/firebase-token", headers=admin)
    assert r.status_code == 200 and r.json()["firebase_custom_token"]


def test_legacy_routes_accept_new_jwt(client, admin):
    # a legacy Flask route through the catch-all mount, authenticated with the JWT
    r = client.get("/api/auth/me", headers=admin)
    assert r.status_code == 200
    assert r.json()["user"]["userId"] == "admin"


def test_legacy_routes_still_accept_firebase_id_tokens(client):
    rec = make_user("legacyui", "admin")
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer fbid:{rec.uid}"})
    assert r.status_code == 200 and r.json()["user"]["userId"] == "legacyui"


def test_legacy_route_with_expired_jwt_gets_401_for_retry(client):
    rec = make_user("zed", "admin")
    payload = {"iss": "cibara-api", "typ": "access", "sub": rec.uid, "uid": "zed", "role": "admin",
               "name": "Zed", "iat": int(time.time()) - 3600, "exp": int(time.time()) - 60, "jti": "x"}
    tok = jwt.encode(payload, get_settings().JWT_SECRET, algorithm="HS256")
    r = client.post("/checkin", json={"room": "1"}, headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 401
    assert r.json()["message"] == "Session expired, retrying"


def test_no_token_on_v2_is_401(client):
    assert client.get("/api/v2/dashboard").status_code == 401
    assert client.get("/api/v2/dashboard", headers={"Authorization": "Basic abc"}).status_code == 401
