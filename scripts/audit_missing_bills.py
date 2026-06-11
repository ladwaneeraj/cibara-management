"""
READ-ONLY audit: find stays that vanished from the Register / GSTR-1.

A bill disappears from every UI when checkout's create_bill_record() fails:
the draft is flipped to status='cancelled' with cancel_reason=
'checkout_without_bill_record' and NO bill_number (routes/rooms.py).
The Register hides cancelled bills and the GSTR-1 export skips anything
without invoice_generated + a real bill_number — so the stay is invisible
even though the doc still exists in Firestore.

This script finds those docs two ways:
  1. bills docs in the window stuck in 'draft'/'cancelled' without a number
     (excluding legitimate revert-cancellations, which keep their number)
  2. payment rows whose daily serial_number has no finalized bill behind it

It NEVER writes. Repair candidates print the exact repair_mmt_stay command.

USAGE (from repo root, same env as the app; set CIBARA_ENV=PROD for live):
  python -m scripts.audit_missing_bills --start 2026-05-15 --end 2026-06-08
"""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict

FINAL_STATUSES = ("completed", "checked_out", "pending_settlement")


def main() -> int:
    ap = argparse.ArgumentParser(description="Read-only audit for vanished bills.")
    ap.add_argument("--start", default="2026-05-15", help="check-in window start YYYY-MM-DD")
    ap.add_argument("--end",   default="2026-06-08", help="check-in window end YYYY-MM-DD")
    args = ap.parse_args()
    start, end = args.start, args.end

    # Importing config initialises Firebase (env chosen via CIBARA_ENV).
    from config import db, bills_ref  # noqa: WPS433

    # ── 1. Bill docs stuck without a number ─────────────────────────────────
    print(f"\n=== 1. bills with checkin_time {start}..{end} ===")
    stuck = []
    finalized_serials = set()   # (checkin_date, serial) covered by a real bill
    finalized_stay_ids = set()
    n = 0
    for d in (bills_ref
              .where("checkin_time", ">=", f"{start} 00:00")
              .where("checkin_time", "<=", f"{end} 23:59")
              .stream()):
        b = d.to_dict() or {}
        n += 1
        bn = b.get("bill_number")
        has_number = bool(bn) and bn != "-"
        sn = b.get("serial_number")
        ci_date = str(b.get("checkin_time") or "")[:10]
        if b.get("status") in FINAL_STATUSES:
            finalized_stay_ids.add(d.id)
            if sn is not None:
                finalized_serials.add((ci_date, int(sn)))
            continue
        if b.get("cancelled_by_revert"):
            continue  # legitimate revert — keeps its number, shows in Register
        if b.get("status") in ("draft", "cancelled") and not has_number:
            stuck.append((d.id, ci_date, sn, b))

    print(f"scanned {n} bill docs; {len(stuck)} stuck draft/cancelled without a number:")
    for doc_id, ci_date, sn, b in sorted(stuck, key=lambda x: x[1]):
        print(f"  id={doc_id[:14]} ci={b.get('checkin_time')!r} room={b.get('room')} "
              f"guest={b.get('guest_name')!r} status={b.get('status')!r} "
              f"reason={b.get('cancel_reason')!r} serial={sn} "
              f"src={b.get('booking_source')!r}")
        if sn is not None:
            print(f"    → python -m scripts.repair_mmt_stay --serial {sn} --date {ci_date}")

    # ── 2. Payment serials with no finalized bill ────────────────────────────
    print(f"\n=== 2. payment serials {start}..{end} without a finalized bill ===")
    by_key = defaultdict(list)
    for p in (db.collection("payments")
              .where("date", ">=", start)
              .where("date", "<=", end)
              .stream()):
        row = p.to_dict() or {}
        sn = row.get("serial_number")
        if sn is None:
            continue
        by_key[(row.get("date"), int(sn))].append(row)

    orphans = 0
    for (date_str, sn), rows in sorted(by_key.items()):
        if (date_str, sn) in finalized_serials:
            continue
        stay_id = next((r.get("stay_id") for r in rows if r.get("stay_id")), None)
        if stay_id and stay_id in finalized_stay_ids:
            continue  # serial date differs from check-in date but bill exists
        orphans += 1
        anchor = next((r for r in rows
                       if r.get("type") in ("fresh_checkin", "booking_conversion")),
                      rows[0])
        total = sum(float(r.get("amount", 0) or 0) for r in rows)
        print(f"  {date_str} serial #{sn}: guest={anchor.get('name')!r} "
              f"room={anchor.get('room')!r} stay_id={str(stay_id)[:14]} "
              f"payments={len(rows)} total={total}")
        print(f"    → python -m scripts.repair_mmt_stay --serial {sn} --date {date_str}")
    if orphans == 0:
        print("  (none — every serial in the window is backed by a finalized bill)")

    print("\nDone (read-only; nothing was modified). Run repair_mmt_stay WITHOUT "
          "--apply first for each candidate, review, then add --apply.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
