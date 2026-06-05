"""
Diagnose why the GST (ITC) expense report looks empty.

Queries the expenses collection over a date range and reports how many
expenses carry GST — exactly the filter the /expenses_gst report uses. This
tells you whether the problem is DATA (expenses were never flagged with GST)
or RANGE (the GST bills fall outside the dates you exported).

    python -m scripts.check_gst_expenses 2026-04-01 2026-06-05

If no dates are given, it scans the last 90 days.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta


def _carries_gst(e) -> bool:
    if e.get("has_gst") is True:
        return True
    try:
        return (float(e.get("gst_amount", 0) or 0) > 0
                or float(e.get("commission_gst", 0) or 0) > 0)
    except (TypeError, ValueError):
        return False


def main() -> int:
    from config import db  # noqa: F401 (side-effect: Firebase init)
    from services import expense_service

    if len(sys.argv) >= 3:
        start, end = sys.argv[1], sys.argv[2]
    else:
        end = datetime.now().strftime("%Y-%m-%d")
        start = (datetime.now() - timedelta(days=90)).strftime("%Y-%m-%d")

    end_excl = (datetime.strptime(end, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    print(f"Scanning expenses {start} .. {end} (inclusive)")
    print("=" * 72)

    rows = expense_service.query_expenses_by_date_range(start, end_excl) or []
    gst = [e for e in rows if _carries_gst(e)]
    flagged = [e for e in rows if e.get("has_gst") is True]
    have_amount = [e for e in rows if _to_f(e.get("gst_amount")) > 0]
    have_gstin = [e for e in rows if (e.get("vendor_gstin") or "").strip()]

    print(f"Total expenses in range      : {len(rows)}")
    print(f"  carry GST (report shows)   : {len(gst)}")
    print(f"  has_gst == True            : {len(flagged)}")
    print(f"  gst_amount > 0             : {len(have_amount)}")
    print(f"  have a vendor GSTIN        : {len(have_gstin)}")
    print("=" * 72)

    if not rows:
        print("No expenses at all in this range → it's a DATE-RANGE problem. "
              "Export a wider range.")
        return 0
    if not gst:
        print("Expenses exist but NONE carry GST → it's a DATA problem: the GST "
              "checkbox wasn't ticked when these bills were recorded. Edit a bill "
              "and tick 'GST Bill' (or re-run OCR), then it will appear in the "
              "ITC report.")
        return 0

    print("Sample GST expenses that WILL appear in the ITC report:")
    for e in sorted(gst, key=lambda x: str(x.get("date", "")))[:15]:
        print(f"  {e.get('date','?'):10}  ₹{e.get('amount',0):>8}  "
              f"GST ₹{_to_f(e.get('gst_amount')):>7.0f}  "
              f"{(e.get('vendor_name') or e.get('description') or '')[:28]:28}  "
              f"GSTIN={e.get('vendor_gstin') or '-'}")
    if len(gst) > 15:
        print(f"  … and {len(gst) - 15} more")
    print("\nThese match what /expenses_gst returns. If they're missing from your "
          "downloaded workbook, check the export's date range and that you have "
          "the data.export (admin) permission.")
    return 0


def _to_f(v) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return 0.0


if __name__ == "__main__":
    sys.exit(main())
