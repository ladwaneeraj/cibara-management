"""
READ-ONLY diagnostic: how expensive is one client attach / one page load?

Why this exists
───────────────
The Firestore console shows a single "Reads" number for the whole project. It
does not say which query produced them. This script sizes every collection and
every live-listener query in static/google_sync.js so the per-attach cost can
be computed instead of guessed.

It uses count() AGGREGATION queries only. Aggregations are NOT billed as
document reads (Firestore bills them at roughly 1 read per 1000 index entries
scanned, and the console's Billable Metrics panel excludes them outright), so
running this repeatedly costs effectively nothing. It NEVER writes.

USAGE (from repo root, same env as the app):
    python -m scripts.firestore_read_audit                 # dev project
    CIBARA_ENV=PROD python -m scripts.firestore_read_audit # live project

Interpreting the output
───────────────────────
"reads per listener attach" is what one browser pays every time google_sync.js
re-establishes its listeners from a cold cache — i.e. every page load, every
PWA resume where the resume token has expired. Multiply by the number of
reloads per device per day, then by the number of devices, and compare with
the daily figure in the console. If the two are in the same ballpark, the
listeners are the dominant cost and offline persistence is the lever.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta

# Collections read by the app at large. Sizing these shows which ones will
# become a problem as the business accumulates history.
ALL_COLLECTIONS = (
    "rooms", "bookings", "payments", "bills", "expenses", "customers",
    "settlements", "ota_settlements", "credit_notes", "audit_logs",
    "daily_counters", "transaction_metadata", "settings", "totals",
    "staff", "staff_attendance", "staff_advances", "staff_salaries",
    "maintenance_issues", "maintenance_rounds", "maintenance_inspections",
    "laundry_bills", "users",
)

BOOKINGS_HORIZON_DAYS = 180  # keep in sync with static/google_sync.js


def _count(query) -> int:
    """Run a count() aggregation and return the integer result.

    Returns -1 when the collection does not exist or the query errors, so one
    bad name never aborts the whole audit.
    """
    try:
        result = query.count().get()
        return int(result[0][0].value)
    except Exception as exc:  # noqa: BLE001 - diagnostic tool, report and continue
        print(f"    (count failed: {exc})", file=sys.stderr)
        return -1


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Read-only Firestore read-cost audit (aggregation queries only).",
    )
    ap.add_argument(
        "--date",
        default=None,
        help="Day to size the today-scoped listeners against (YYYY-MM-DD). "
             "Defaults to today in IST.",
    )
    args = ap.parse_args()

    # Importing config initialises Firebase (project chosen via CIBARA_ENV).
    from config import db, IST  # noqa: WPS433
    from google.cloud.firestore_v1.base_query import FieldFilter

    day = args.date or datetime.now(IST).strftime("%Y-%m-%d")
    horizon = (
        datetime.strptime(day, "%Y-%m-%d") + timedelta(days=BOOKINGS_HORIZON_DAYS)
    ).strftime("%Y-%m-%d")

    print(f"Firestore read audit — scoped to {day} (horizon {horizon})")
    print("=" * 68)

    print("\nCollection sizes (total documents)")
    print("-" * 68)
    sizes = {}
    for name in ALL_COLLECTIONS:
        n = _count(db.collection(name))
        sizes[name] = n
        if n >= 0:
            print(f"  {name:<26} {n:>9,}")

    # ── The seven listeners in static/google_sync.js ──────────────────────
    print("\nLive listeners in static/google_sync.js")
    print("-" * 68)
    listeners = [
        ("rooms (unfiltered)",
         db.collection("rooms")),
        ("totals/current_totals (single doc)",
         None),
        ("settings/ui_config (single doc)",
         None),
        ("payments where date == today",
         db.collection("payments").where(filter=FieldFilter("date", "==", day))),
        ("bills where checkout_time within today",
         db.collection("bills")
           .where(filter=FieldFilter("checkout_time", ">=", f"{day} 00:00"))
           .where(filter=FieldFilter("checkout_time", "<=", f"{day} 23:59"))),
        (f"bookings where today <= check_in_date <= +{BOOKINGS_HORIZON_DAYS}d",
         db.collection("bookings")
           .where(filter=FieldFilter("check_in_date", ">=", day))
           .where(filter=FieldFilter("check_in_date", "<=", horizon))),
        ("expenses where date == today",
         db.collection("expenses").where(filter=FieldFilter("date", "==", day))),
    ]

    total = 0
    for label, query in listeners:
        n = 1 if query is None else _count(query)
        if n < 0:
            print(f"  {label:<52} {'?':>6}")
            continue
        total += n
        print(f"  {label:<52} {n:>6,}")
    print("-" * 68)
    print(f"  {'READS PER LISTENER ATTACH (cold cache)':<52} {total:>6,}")

    # ── Comparison: the unbounded shape the bookings listener used to have ─
    unbounded = _count(
        db.collection("bookings").where(filter=FieldFilter("check_in_date", ">=", day)),
    )
    if unbounded >= 0:
        extra = unbounded - _count(
            db.collection("bookings")
              .where(filter=FieldFilter("check_in_date", ">=", day))
              .where(filter=FieldFilter("check_in_date", "<=", horizon)),
        )
        print(f"\n  bookings beyond the {BOOKINGS_HORIZON_DAYS}-day horizon: {max(extra, 0):,}")

    # ── Server-side: what one /get_data cache MISS costs ──────────────────
    print("\nServer-side: documents read by one /get_data cache miss")
    print("-" * 68)
    tomorrow = (
        datetime.strptime(day, "%Y-%m-%d") + timedelta(days=1)
    ).strftime("%Y-%m-%d")
    rooms_n = sizes.get("rooms", -1)
    pay_n = _count(
        db.collection("payments")
          .where(filter=FieldFilter("date", ">=", day))
          .where(filter=FieldFilter("date", "<", tomorrow)),
    )
    exp_n = _count(db.collection("expenses").where(filter=FieldFilter("date", "==", day)))
    for label, n in (
        ("get_all_rooms() — full rooms stream", rooms_n),
        ("get_totals() — single doc", 1),
        ("today's payments", pay_n),
        ("today's expenses", exp_n),
    ):
        print(f"  {label:<52} {n:>6,}")
    miss = sum(n for n in (rooms_n, 1, pay_n, exp_n) if n >= 0)
    print("-" * 68)
    print(f"  {'READS PER /get_data CACHE MISS':<52} {miss:>6,}")

    print(
        "\nNote: aggregation queries are not billed as document reads, so this "
        "audit does not itself move the counter in the console.",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
