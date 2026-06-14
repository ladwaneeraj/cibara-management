"""
READ-ONLY audit: find gaps in the sequential bill-number series (CC/YYYY/MM/XXXXX).

WHY THIS EXISTS
    Each checkout mints a number from an atomic per-month counter
    (config.generate_sequential_bill_number -> counters/bill_YYYY_MM.count).
    A number is consumed the instant the counter increments, decoupled from
    whether the bill document is ultimately written. So a duplicate or failed
    checkout can burn a number that never lands on any document, leaving a
    permanent hole in the series.

    Under GST Rule 46(b) the invoice series must be consecutive. Any number the
    counter handed out but that is NOT present on a stored bill must be declared
    as a CANCELLED document in GSTR-1 (Table 13) for that month. This script
    lists exactly those numbers so they can be reported.

WHAT IT REPORTS, per month:
    - counter value (highest number the system handed out)
    - highest number actually present on a bill doc
    - MISSING numbers: handed out by the counter but on no document  -> the gaps
    - DUPLICATE numbers: the same number on more than one document    -> anomaly

    Cancelled bills are NOT gaps: a revert/cancel keeps its bill_number, so the
    number is still "present" and the series stays consecutive. This script
    counts any document that carries the number, regardless of status.

It NEVER writes.

USAGE (from repo root, same env as the app; set CIBARA_ENV=PROD for live):
    python -m scripts.audit_bill_number_gaps                 # all months
    python -m scripts.audit_bill_number_gaps --year 2026 --month 6
    python -m scripts.audit_bill_number_gaps --csv gaps.csv  # also write a CSV
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from collections import defaultdict

# counters/<id> docs minted for bill numbers are named bill_YYYY_MM
_COUNTER_ID_RE = re.compile(r"^bill_(\d{4})_(\d{2})$")
# trailing 5-digit sequence of CC/YYYY/MM/XXXXX
_BILL_NO_RE = re.compile(r"^CC/(\d{4})/(\d{2})/(\d+)$")


def _present_numbers_for_month(bills_ref, year: int, month: int):
    """Return {seq:int -> [doc_id, ...]} for every bill doc carrying a CC number
    in the given month. Uses a lexicographic range query on bill_number; the
    5-digit zero-padded suffix means lexicographic order == numeric order."""
    mm = f"{month:02d}"
    lo = f"CC/{year}/{mm}/00000"
    hi = f"CC/{year}/{mm}/99999"
    present: dict[int, list[str]] = defaultdict(list)
    for d in (bills_ref
              .where("bill_number", ">=", lo)
              .where("bill_number", "<=", hi)
              .stream()):
        b = d.to_dict() or {}
        m = _BILL_NO_RE.match(str(b.get("bill_number") or ""))
        if not m:
            continue
        # Guard the range query against any stray prefix collisions.
        if int(m.group(1)) != year or int(m.group(2)) != month:
            continue
        present[int(m.group(3))].append(d.id)
    return present


def _discover_months(counters_ref):
    """Yield (year, month, counter_count) for every bill_YYYY_MM counter doc."""
    out = []
    for c in counters_ref.stream():
        m = _COUNTER_ID_RE.match(c.id)
        if not m:
            continue
        cnt = int((c.to_dict() or {}).get("count", 0) or 0)
        out.append((int(m.group(1)), int(m.group(2)), cnt))
    out.sort()
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="Read-only bill-number gap audit.")
    ap.add_argument("--year", type=int, help="restrict to this year (e.g. 2026)")
    ap.add_argument("--month", type=int, help="restrict to this month 1-12")
    ap.add_argument("--csv", help="optional path to also write the gaps as CSV")
    args = ap.parse_args()

    # Importing config initialises Firebase (env chosen via CIBARA_ENV).
    from config import bills_ref, counters_ref  # noqa: WPS433

    months = _discover_months(counters_ref)
    if args.year is not None:
        months = [m for m in months if m[0] == args.year]
    if args.month is not None:
        months = [m for m in months if m[1] == args.month]

    if not months:
        print("No bill_YYYY_MM counter documents matched the filter.")
        return 0

    csv_rows: list[tuple[str, int, str]] = []  # (period, seq, formatted)
    grand_missing = 0
    grand_dupes = 0

    for year, month, counter_count in months:
        period = f"{year}-{month:02d}"
        present = _present_numbers_for_month(bills_ref, year, month)
        max_present = max(present) if present else 0

        # The counter is authoritative for "how many were handed out". Fall back
        # to the max present number if a counter doc is somehow behind the data.
        ceiling = max(counter_count, max_present)

        missing = [n for n in range(1, ceiling + 1) if n not in present]
        dupes = {n: ids for n, ids in present.items() if len(ids) > 1}

        print(f"\n=== {period} ===")
        print(f"  counter handed out : {counter_count}")
        print(f"  highest on a bill  : {max_present}")
        print(f"  bills with a number: {len(present)}")
        if counter_count and max_present and counter_count != max_present:
            print(f"  note: counter ({counter_count}) != highest stored "
                  f"({max_present}) — trailing number(s) minted but never stored.")

        if missing:
            grand_missing += len(missing)
            print(f"  MISSING ({len(missing)}) — declare as CANCELLED in GSTR-1 "
                  f"Table 13:")
            for n in missing:
                formatted = f"CC/{year}/{month:02d}/{n:05d}"
                print(f"    {formatted}")
                csv_rows.append((period, n, formatted))
        else:
            print("  MISSING: none — series is gap-free for this month.")

        if dupes:
            grand_dupes += len(dupes)
            print(f"  DUPLICATES ({len(dupes)}) — same number on multiple docs:")
            for n in sorted(dupes):
                formatted = f"CC/{year}/{month:02d}/{n:05d}"
                print(f"    {formatted}: {', '.join(dupes[n])}")

    print(f"\n--- summary: {grand_missing} missing number(s), "
          f"{grand_dupes} duplicate number(s) across {len(months)} month(s) ---")

    if args.csv and csv_rows:
        with open(args.csv, "w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(["period", "sequence", "bill_number"])
            w.writerows(csv_rows)
        print(f"Wrote {len(csv_rows)} missing-number row(s) to {args.csv}")

    print("\nDone (read-only; nothing was modified).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
