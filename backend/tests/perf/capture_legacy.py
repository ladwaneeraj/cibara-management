"""Legacy-only classic-UI read baseline — the endpoints static/*.js actually
calls (NOT the SPA-only /api/v2 natives).

    cd backend && python -m tests.perf.capture_legacy

Grounded in static/*.js: the classic screens load through legacy routes
(/get_data, /get_register_data, /get_transactions_range, /get_history,
/list_customers, /get_pending_settlements, /get_bookings, /staff/*, /reports,
/revenue_report, …) plus a few classic-used natives (bills, customers, which
are already cheap and measured in the mixed baseline).
"""
from __future__ import annotations

import os
import sys
import uuid
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(BACKEND.parent), str(BACKEND)]
os.chdir(BACKEND.parent)
os.environ.setdefault("JWT_SECRET", "baseline-only-secret-" + "z" * 40)
os.environ.setdefault("CIBARA_ENV", "UAT")

import tests.conftest as boot  # noqa: E402
from tests.demo_server import seed  # noqa: E402
from tests.perf.harness import Screen, run_baseline  # noqa: E402

S, E = "2026-10-01", "2026-10-31"          # range covering the seeded "today"
_SE = {"start_date": S, "end_date": E}

# One row per legacy load the classic screens issue. "Front desk" is 3-4 calls.
SCREENS = [
    Screen("Front desk: rooms", "GET", "/get_data", params={"fresh": "1"}, note="script.js boot/refresh"),
    Screen("Front desk: txn metadata", "GET", "/get_transaction_metadata", note="script.js"),
    Screen("Front desk: upcoming bookings", "GET", "/get_upcoming_bookings", note="script.js"),
    Screen("Front desk: room numbers", "GET", "/get_room_numbers", note="check-in form"),
    Screen("Register/Bills: day data", "POST", "/get_register_data", json=_SE, note="bills.js/register.js"),
    Screen("Transactions: range", "POST", "/get_transactions_range", json={"from_date": S, "to_date": E}, note="transaction-tracking.js"),
    Screen("Transactions: expenses", "POST", "/expenses/browse", json=_SE, note="transaction-tracking.js"),
    Screen("Stay history popup", "POST", "/get_history", json={"room": "201", "name": "Ravi Kumar"}, note="script.js/register.js"),
    Screen("Customer manager: list", "GET", "/list_customers", note="customer-manager.js"),
    Screen("Customer: lookup", "GET", "/get_customer/9876543210", note="register.js/customer-manager.js"),
    Screen("Settle-later: pending", "GET", "/get_pending_settlements", note="settle-later.js"),
    Screen("Bookings: list", "GET", "/get_bookings", note="booking.js"),
    Screen("Banking: OTA settlements", "GET", "/get_ota_settlements", note="booking.js"),
    Screen("Banking: MMT unsettled", "GET", "/get_mmt_unsettled", note="booking.js"),
    Screen("Staff: list", "GET", "/staff/list", note="staff.js"),
    Screen("Staff: attendance", "GET", "/staff/attendance", note="staff.js"),
    Screen("Staff: analytics", "GET", "/staff/analytics", note="staff.js"),
    Screen("Reports: summary", "POST", "/reports", json=_SE, note="analytics.js"),
    Screen("Reports: revenue", "POST", "/revenue_report", json=_SE, note="analytics.js"),
    Screen("Reports: customer analytics", "GET", "/customer_analytics", note="analytics.js"),
    Screen("Reports: daily insights", "GET", "/insights/summary", params={"from": S, "to": E}, note="daily-insights.js"),
]


def main() -> None:
    from fastapi.testclient import TestClient
    from cibara_api.main import app

    with TestClient(app) as c:
        seed(c)
        boot.limiter.reset()
        tok = c.post("/api/v2/auth/login",
                     json={"user_id": "admin", "password": "admin123"}).json()["access_token"]
        auth = {"Authorization": f"Bearer {tok}", "X-Op-Id": uuid.uuid4().hex}
        rows = run_baseline(c, auth, SCREENS, repeats=20)

    print("| Classic screen (legacy load) | Route | Status | Cold reads | Writes | p50 ms | p95 ms |")
    print("|---|---|---:|---:|---:|---:|---:|")
    for r in rows:
        print(f"| {r.screen} | `{r.route}` | {r.status} | {r.reads} | {r.writes} | {r.p50_ms} | {r.p95_ms} |")
    print()
    for r in rows:
        if r.status != 200:
            print(f"- NON-200 {r.status}: {r.route} ({r.screen}) -- {r.note}")


if __name__ == "__main__":
    main()
