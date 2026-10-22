"""Capture the classic-screen Firestore-read baseline and print a markdown table.

    cd backend && python -m tests.perf.capture_baseline

Boots the in-memory fakes (via tests.conftest), seeds a realistic day
(tests.demo_server.seed), then drives each heavily-used screen's primary load
endpoint through the harness and prints a table ranked by ground-truth COLD
Firestore reads. Reads are deterministic and backend-independent; the local ms
columns are a relative signal only (no network in the fake).
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

import tests.conftest as boot  # noqa: E402  (installs fakes, wires counting hooks)
from tests.demo_server import seed  # noqa: E402
from tests.perf.harness import Screen, run_baseline  # noqa: E402

# Each screen's PRIMARY data-load call. "legacy" rows are what the classic UI
# calls today (the "before"); "native" rows are the fast /api/v2 equivalents a
# classic screen could be routed to.
_RANGE = {"start": "2026-10-01", "end": "2026-10-31"}  # seed checks in/out "today" (2026-10-22)

SCREENS = [
    Screen("Front desk (classic)",     "GET",  "/get_data", params={"fresh": "1"},
           note="legacy - classic rooms/transactions page load"),
    Screen("Front desk (native alt)",  "GET",  "/api/v2/dashboard",
           note="native - candidate target for the front desk"),
    Screen("Stay history popup",       "POST", "/get_history", json={"room": "201", "name": "Ravi Kumar"},
           note="legacy - register/room history (no checkin_time sent: worst case)"),
    Screen("Bills list",               "GET",  "/api/v2/bills", params=_RANGE,
           note="native - keyset-paginated bills list (50/page)"),
    Screen("Bills period tally",       "GET",  "/api/v2/bills/summary", params=_RANGE,
           note="native - period totals"),
    Screen("Reports overview",         "GET",  "/api/v2/reports/summary", params=_RANGE,
           note="native - forwards legacy /reports"),
    Screen("Reports GSTR-1",           "GET",  "/api/v2/reports/gstr1", params={"month": "2026-10"},
           note="native - forwards legacy /reports/gstr1_summary"),
    Screen("Transactions report",      "GET",  "/api/v2/transactions", params=_RANGE,
           note="native - forwards legacy /get_transactions_range"),
    Screen("Settle-later list",        "GET",  "/api/v2/settlements",
           note="native - status-filtered settlements"),
    Screen("Customer search (keystroke)", "GET", "/api/v2/customers/suggest", params={"prefix": "9876"},
           note="native - per-keystroke indexed mobile search"),
    Screen("Customer lookup",          "GET",  "/api/v2/customers/lookup", params={"mobile": "9876543210"},
           note="native - single customer by mobile"),
    Screen("Room tariffs",             "GET",  "/api/v2/rooms/tariffs",
           note="native - reference data (rarely changes)"),
    Screen("Admin system health",      "GET",  "/api/v2/admin/metrics",
           note="native - in-memory metrics"),
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
        rows = run_baseline(c, auth, SCREENS, repeats=30)

    print("| Screen | Route | Status | Cold reads | Writes | Header reads | p50 ms | p95 ms |")
    print("|---|---|---:|---:|---:|---:|---:|---:|")
    for r in rows:
        print(f"| {r.screen} | `{r.route}` | {r.status} | {r.reads} | {r.writes} "
              f"| {r.header_reads} | {r.p50_ms} | {r.p95_ms} |")
    print()
    for r in rows:
        flag = "" if r.header_reads < 0 or r.header_reads == r.reads else \
            f"  [WARN header under-reports {r.header_reads} vs {r.reads}]"
        print(f"- {r.screen}: {r.reads} cold reads, status {r.status}{flag}  -- {r.note}")


if __name__ == "__main__":
    main()
