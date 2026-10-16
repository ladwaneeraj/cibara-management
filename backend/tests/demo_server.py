"""
Run the full stack against the in-memory Firebase fakes — no credentials,
no network. Seeds users and a realistic day so every screen has data.

    cd backend && python -m tests.demo_server      # → http://localhost:8080/

Logins: admin / admin123   manager / manager123   staff / staff123
Realtime (Firestore listeners) is unavailable in this mode; the SPA falls
back to polling, which is also how it behaves if Firebase is unreachable.
"""
from __future__ import annotations

import os
import sys
import time
import uuid
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(BACKEND.parent), str(BACKEND)]
os.chdir(BACKEND.parent)
os.environ.setdefault("JWT_SECRET", "demo-only-secret-" + "z" * 40)
os.environ.setdefault("CIBARA_ENV", "UAT")

import tests.conftest as boot  # noqa: E402  (installs the fakes)


def seed(client):
    boot.make_user("admin", "admin", "admin123", "Asha Admin")
    boot.make_user("manager", "manager", "manager123", "Mohan Manager")
    boot.make_user("staff", "housekeeping", "staff123", "Sita Staff")
    # This demo runs on the in-memory Firebase fakes, so the browser's live
    # Firestore listeners can't authenticate to real Firebase (the custom token
    # is a stub → auth/invalid-custom-token) and every listener comes back
    # permission-denied. In listener-first mode the Rooms grid is painted ONLY
    # from the rooms listener, so it stays blank. Force the legacy /get_data
    # boot path for the demo so every device (incl. phones over a tunnel) paints
    # Rooms over REST. Live cross-device sync is still unavailable in this mode.
    boot.DB.collection("settings").document("ui_config").set({"listener_first": False})
    tok = client.post("/api/v2/auth/login", json={"user_id": "admin", "password": "admin123"}).json()["access_token"]
    h = {"Authorization": f"Bearer {tok}"}

    def post(path, body):
        r = client.post(path, json=body, headers={**h, "X-Op-Id": uuid.uuid4().hex})
        assert r.json().get("success") is not False, (path, r.text)
        return r.json()

    guests = [
        ("201", "Ravi Kumar", "9876543210", 2, 1200, 1200, "cash"),
        ("202", "Priya Sharma", "9876500001", 2, 1200, 0, "balance"),
        ("205", "Acme Travels", "9876500002", 3, 2100, 2100, "online"),
        ("210", "Imran Khan", "9876500003", 1, 450, 450, "cash"),
        ("223", "Lakshmi N", "9876500004", 2, 900, 500, "online"),
        ("24", "Gopal", "9876500005", 2, 500, 500, "cash"),
        ("3", "Suresh", "9876500006", 1, 250, 250, "cash"),
    ]
    for room, name, mob, g, price, paid, pay in guests:
        post(f"/api/v2/rooms/{room}/checkin", {"name": name, "mobile": mob, "guests": g, "price": price,
                                               "amount_paid": paid, "payment": pay, "is_ac": room == "205"})
    post("/api/v2/rooms/201/addons", {"item": "Water 1L", "unit_price": 20, "quantity": 2, "payment_method": "cash"})
    post("/api/v2/rooms/223/addons", {"item": "Extra Bed", "unit_price": 300, "quantity": 1, "payment_method": "balance",
                                      "accommodation_charge": True})
    # finished stays → bills
    for room, name, mob, price in (("204", "Deepa Rao", "9876500010", 1500), ("207", "Karan Mehta", "9876500011", 700),
                                   ("15", "Anil", "9876500012", 250), ("220", "Fatima", "9876500013", 1000)):
        post(f"/api/v2/rooms/{room}/checkin", {"name": name, "mobile": mob, "guests": 2, "price": price,
                                               "amount_paid": price, "payment": "online" if price > 900 else "cash"})
        post(f"/api/v2/rooms/{room}/checkout", {})
    post("/api/v2/rooms/15/cleaned", {})
    post("/api/v2/rooms/220/cleaned", {})
    post("/api/v2/rooms/220/ready", {"checklist": {"washroom": True}})
    # settle later
    post("/api/v2/rooms/26/checkin", {"name": "Vinod", "mobile": "9876500020", "guests": 2, "price": 500,
                                      "amount_paid": 100, "payment": "cash"})
    post("/api/v2/rooms/26/checkout", {"settle_later": True, "settlement_notes": "Regular guest, pays Friday"})
    post("/api/v2/rooms/210/housekeeping", {"room_clean": True})
    post("/api/v2/expenses", {"date": time.strftime("%Y-%m-%d"), "category": "utilities", "description": "Electricity top-up",
                              "amount": 850, "type": "transaction"})
    now = int(time.time() * 1000)
    boot.DB.collection("guestRequests").document("demo1").set({
        "uid": "anon", "room": "202", "stayId": "x", "guestName": "Priya Sharma", "kind": "extra_items",
        "team": "housekeeping", "note": "One more blanket please", "status": "open", "active": True,
        "createdAt": "", "createdAtMs": now - 4 * 60000})


if __name__ == "__main__":
    import uvicorn
    from fastapi.testclient import TestClient

    from cibara_api.main import app
    with TestClient(app) as c:
        seed(c)
    boot.limiter.reset()
    print("Demo ready -> http://localhost:8080/  (admin/admin123, manager/manager123, staff/staff123)")
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8080")), log_level="warning")
