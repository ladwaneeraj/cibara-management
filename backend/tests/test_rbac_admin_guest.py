import time
import uuid
from datetime import datetime

import pytest

from tests.conftest import AUTH, DB, login, make_user

import config
from cibara_api.security.legacy_hardening import required_permission

TODAY = datetime.now(config.IST).strftime("%Y-%m-%d")


# ── v2 permission matrix ──────────────────────────────────────────────────

MATRIX = [
    # (method, path, json, admin_ok, manager_ok, staff_ok)
    ("GET", f"/api/v2/reports/summary?start={TODAY}&end={TODAY}", None, True, False, False),
    ("GET", f"/api/v2/reports/revenue?start={TODAY}&end={TODAY}", None, True, False, False),
    ("GET", f"/api/v2/reports/gstr1?month={TODAY[:7]}", None, True, False, False),
    ("GET", f"/api/v2/reports/insights?start={TODAY}&end={TODAY}", None, True, False, False),
    ("GET", f"/api/v2/transactions?start={TODAY}&end={TODAY}", None, True, True, False),
    ("GET", f"/api/v2/expenses?start={TODAY}&end={TODAY}", None, True, True, False),
    ("GET", "/api/v2/settlements", None, True, True, False),
    ("GET", "/api/v2/admin/users", None, True, False, False),
    ("GET", "/api/v2/admin/audit-logs", None, True, False, False),
    ("GET", "/api/v2/admin/metrics", None, True, False, False),
    ("GET", "/api/v2/settings/billing", None, True, False, False),
    ("GET", "/api/v2/settings/ui", None, True, True, True),
    ("GET", "/api/v2/guest-requests", None, True, True, True),
    ("GET", "/api/v2/guest-portal/qr.png", None, True, False, False),
    ("GET", f"/api/v2/bills?start={TODAY}&end={TODAY}", None, True, True, False),
    ("POST", "/api/v2/rooms/1/discount", {"amount": 10, "reason": "x"}, True, False, False),
]


@pytest.mark.parametrize("method,path,body,a_ok,m_ok,s_ok", MATRIX)
def test_permission_matrix(client, admin, manager, staff, method, path, body, a_ok, m_ok, s_ok):
    for hdr, ok in ((admin, a_ok), (manager, m_ok), (staff, s_ok)):
        r = client.request(method, path, json=body, headers={**hdr, "X-Op-Id": uuid.uuid4().hex})
        if ok:
            assert r.status_code != 403, (path, r.status_code, r.text)
        else:
            assert r.status_code == 403, (path, r.status_code, r.text)


# ── legacy hardening (old paths, new JWT) ─────────────────────────────────

def test_hardening_table():
    assert required_permission("POST", "/checkin", {}) == "room.checkin"
    assert required_permission("POST", "/checkout", {"final_checkout": True, "settle_later": True}) == "settle_later.use"
    assert required_permission("POST", "/checkout", {"final_checkout": True}) == "room.checkout"
    assert required_permission("GET", "/get_data", None) is None


def test_housekeeping_cannot_checkin_via_legacy_path(client, staff):
    r = client.post("/checkin", headers=staff, json={"room": "1", "name": "x", "mobile": "9999999999",
                                                     "price": "250", "guests": "1", "payment": "cash",
                                                     "amountPaid": 250})
    assert r.status_code == 403
    assert DB.dump("rooms")["1"]["status"] == "vacant"


def test_manager_cannot_settle_later_via_legacy_path(client, admin, manager):
    from tests.test_parity import V2Driver
    V2Driver(client, admin).checkin("201", name="a", mobile="9999999999", guests=1, price=1200, paid=0,
                                    payment="balance")
    r = client.post("/checkout", headers=manager, json={"room": "201", "final_checkout": True,
                                                        "settle_later": True})
    assert r.status_code == 403
    r = client.post("/api/v2/rooms/201/checkout", headers=manager, json={"settle_later": True})
    assert r.status_code == 403


def test_manager_cannot_pull_revenue_report_via_legacy_path(client, manager):
    r = client.post("/revenue_report", headers=manager, json={"start_date": TODAY, "end_date": TODAY})
    assert r.status_code == 403


def test_hardening_can_be_disabled(client, staff, monkeypatch):
    from cibara_api.settings import get_settings
    monkeypatch.setattr(get_settings(), "LEGACY_RBAC_HARDENING", False)
    r = client.post("/revenue_report", headers=staff, json={"start_date": TODAY, "end_date": TODAY})
    assert r.status_code == 200  # legacy behaviour restored


# ── admin: users ──────────────────────────────────────────────────────────

def test_user_lifecycle_and_immediate_revocation(client, admin):
    r = client.post("/api/v2/admin/users", headers=admin,
                    json={"userId": "Desk1", "name": "Desk One", "role": "manager", "password": "pass1234"})
    assert r.status_code == 201, r.text
    assert DB.dump("users")["desk1"]["role"] == "manager"
    users = client.get("/api/v2/admin/users", headers=admin).json()["users"]
    assert any(u["userId"] == "desk1" for u in users)

    s = login(client, "desk1", "pass1234")
    h = {"Authorization": f"Bearer {s['access_token']}"}
    assert client.get("/api/v2/auth/me", headers=h).status_code == 200

    r = client.post("/api/v2/admin/users/desk1/force-logout", headers=admin)
    assert r.json()["success"]
    assert client.get("/api/v2/auth/me", headers=h).status_code == 401  # access token dead at once
    assert client.get("/api/auth/me", headers=h).status_code == 401      # legacy paths too

    time.sleep(1.1)
    s = login(client, "desk1", "pass1234")
    h = {"Authorization": f"Bearer {s['access_token']}"}
    r = client.patch("/api/v2/admin/users/desk1", headers=admin, json={"role": "housekeeping"})
    assert r.json()["success"]
    assert client.get("/api/v2/auth/me", headers=h).status_code == 401

    r = client.delete("/api/v2/admin/users/desk1", headers=admin)
    assert r.json()["success"] and DB.dump("users")["desk1"]["isActive"] is False
    time.sleep(1.1)
    assert client.post("/api/v2/auth/login", json={"user_id": "desk1", "password": "pass1234"}).status_code == 403


def test_last_admin_guard_preserved(client, admin):
    r = client.delete("/api/v2/admin/users/admin", headers=admin)
    assert r.status_code == 400 and "last active admin" in r.json()["message"]


def test_create_user_validation(client, admin):
    r = client.post("/api/v2/admin/users", headers=admin, json={"userId": "x", "role": "manager", "password": "pass1234"})
    assert r.status_code == 422
    r = client.post("/api/v2/admin/users", headers=admin, json={"userId": "okay", "role": "owner", "password": "pass1234"})
    assert r.status_code == 422


def test_reset_password(client, admin):
    make_user("rp", "manager")
    r = client.post("/api/v2/admin/users/rp/reset-password", headers=admin, json={"password": "fresh123"})
    assert r.json()["success"]
    time.sleep(1.1)
    assert login(client, "rp", "fresh123")["user"]["userId"] == "rp"


def test_audit_log_endpoint_lists_logins(client, admin):
    time.sleep(0.3)
    r = client.get("/api/v2/admin/audit-logs", headers=admin, params={"action": "auth.login"}).json()
    assert r["success"] and any(e["userId"] == "admin" for e in r["entries"])
    e = r["entries"][0]
    for k in ("timestamp", "userName", "userRole", "action", "targetCollection", "ipAddress", "userAgent"):
        assert k in e


def test_settings_roundtrip(client, admin):
    r = client.patch("/api/v2/settings/billing", headers=admin, json={"always_generate_bill": False}).json()
    assert r["success"] and r["config"]["always_generate_bill"] is False
    r = client.patch("/api/v2/settings/ui", headers=admin, json={"cleaning_photos": True}).json()
    assert r["success"] and r["config"]["cleaning_photos"] is True
    assert client.patch("/api/v2/settings/ui", headers=admin, json={}).status_code == 400


def test_metrics_endpoint(client, admin):
    client.get("/api/v2/dashboard", headers=admin)
    m = client.get("/api/v2/admin/metrics", headers=admin).json()
    routes = {r["route"] for r in m["routes"]}
    assert "GET /api/v2/dashboard" in routes
    dash = next(r for r in m["routes"] if r["route"] == "GET /api/v2/dashboard")
    assert dash["reads"] > 0 and dash["count"] >= 1


# ── guest portal (staff side) ─────────────────────────────────────────────

def test_guest_portal_settings_and_requests(client, admin, staff):
    r = client.patch("/api/v2/guest-portal/settings", headers=admin,
                     json={"enabled": True, "wifiName": "Cibara", "wifiPassword": "pw", "sessionHours": 24}).json()
    assert r["success"] and r["settings"]["enabled"] is True
    s = client.get("/api/v2/guest-portal/settings", headers=staff).json()["settings"]
    assert "wifiPassword" not in s  # only admins see it (legacy rule)
    assert client.patch("/api/v2/guest-portal/settings", headers=admin,
                        json={"publicBaseUrl": "http://insecure"}).status_code == 422
    qr = client.get("/api/v2/guest-portal/qr.png", headers=admin)
    assert qr.status_code == 200 and qr.headers["content-type"] == "image/png" and qr.content[:4] == b"\x89PNG"

    now = int(time.time() * 1000)
    DB.collection("guestRequests").document("r1").set({
        "uid": "anon1", "room": "201", "stayId": "s1", "guestName": "G", "kind": "extra_items",
        "team": "housekeeping", "note": "", "status": "open", "active": True,
        "createdAt": "x", "createdAtMs": now})
    DB.collection("guestRequests").document("r2").set({
        "uid": "anon1", "room": "201", "stayId": "s1", "guestName": "G", "kind": "taxi",
        "team": "desk", "note": "", "status": "open", "active": True, "createdAt": "x", "createdAtMs": now})
    mine = client.get("/api/v2/guest-requests", headers=staff).json()["requests"]
    assert [x["id"] for x in mine] == ["r1"]  # housekeeping sees only its team
    assert client.post("/api/v2/guest-requests/r2/done", headers=staff).status_code == 403
    assert client.post("/api/v2/guest-requests/r1/acknowledge", headers=staff).json()["success"]
    assert client.post("/api/v2/guest-requests/r1/done", headers=staff).json()["success"]
    hist = client.get("/api/v2/guest-requests/history?days=7", headers=admin).json()
    assert hist["success"] and hist["summary"]["done"] == 1
    assert client.post("/api/v2/guest-requests/r1/explode", headers=admin).status_code == 422


def test_disabled_user_cannot_refresh_even_with_valid_cookie(client):
    rec = make_user("tmp", "manager")
    login(client, "tmp")
    DB.collection("users").document("tmp").update({"isActive": False})
    assert client.post("/api/v2/auth/refresh").status_code == 403
    assert rec.uid in AUTH.users
