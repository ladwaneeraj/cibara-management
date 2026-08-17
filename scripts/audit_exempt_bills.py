"""
READ-ONLY audit: bills issued under the dead sub-₹1,000 "Exempt" GST band.

Background
──────────
config._slab_for_value used to return 0% for a night valued under ₹1,000:

    if v < 1000:
        return 0

That was correct only until 17 July 2022. Notification 04/2022-CTR withdrew
the sub-₹1,000 accommodation exemption with effect from 18 July 2022, and the
56th GST Council (eff. 22 Sep 2025) collapsed the old 12% slab into 5% for
everything at or below ₹7,500. There is no exempt band for accommodation.

Two things made this bite harder than the raw tariff suggests. The slab is
taken on the POST-discount value of supply, so a ₹1,800 night with a ₹900
allocated discount fell to ₹900 and printed "Exempt". And a fully discounted
night (value ₹0) also came out "Exempt" rather than taxable-at-nil-value.

Net effect: output tax under-declared on those bills in GSTR-1.

This script finds them. It NEVER writes. Nothing is corrected, no credit or
debit note is raised, no bill is touched — the point is to size the problem,
and to separate bills in already-FILED GST months (which need a considered
route, usually a debit note or an amendment) from open months.

USAGE (from repo root, same env as the app):
    python -m scripts.audit_exempt_bills                        # dev project
    CIBARA_ENV=PROD python -m scripts.audit_exempt_bills        # live
    CIBARA_ENV=PROD python -m scripts.audit_exempt_bills --csv out.csv
    CIBARA_ENV=PROD python -m scripts.audit_exempt_bills --from 2025-04-01

Reading the output
──────────────────
"GST short" is the tax that SHOULD have been inside the amount already
collected, computed the same way the app does it (tax-inclusive:
value x rate / (100 + rate)). It is not extra money to collect from the
guest; it is output tax that was not declared. Take the totals to your CA
before deciding what to file.
"""

from __future__ import annotations

import argparse
import csv
import sys
from collections import defaultdict

# The exemption was withdrawn with effect from this date. Bills for stays
# before it were legitimately exempt and are reported separately rather than
# flagged as errors.
EXEMPTION_WITHDRAWN_FROM = "2022-07-18"

# Current slab, mirroring config._slab_for_value after the fix.
SLAB_CAP = 7500
SLAB_LOW = 5
SLAB_HIGH = 18


def _slab(value: float) -> int:
    return SLAB_LOW if value <= SLAB_CAP else SLAB_HIGH


def _tax_inclusive(value: float, rate: int) -> float:
    """Tax contained in a tax-inclusive amount. Matches compute_daily_folio."""
    if rate <= 0 or value <= 0:
        return 0.0
    return round(value * rate / (100 + rate), 2)


def _f(v, default=0.0) -> float:
    try:
        return float(v or 0)
    except (TypeError, ValueError):
        return default


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Read-only audit of bills taxed under the withdrawn "
                    "sub-Rs.1000 accommodation exemption.")
    ap.add_argument("--from", dest="date_from", default=EXEMPTION_WITHDRAWN_FROM,
                    help="Only bills on/after this date (YYYY-MM-DD). "
                         f"Default {EXEMPTION_WITHDRAWN_FROM}, the day the "
                         "exemption was withdrawn.")
    ap.add_argument("--to", dest="date_to", default="9999-12-31",
                    help="Only bills on/before this date (YYYY-MM-DD).")
    ap.add_argument("--csv", dest="csv_path", default="",
                    help="Also write the affected rows to this CSV.")
    args = ap.parse_args()

    # Importing config initialises Firebase (project chosen via CIBARA_ENV).
    from config import bills_ref, logger  # noqa: WPS433
    try:
        from services import gst_lock_service as gls
    except Exception:                                    # pragma: no cover
        gls = None

    print("Exempt-rate audit — READ ONLY, nothing is written")
    print(f"Window: {args.date_from} .. {args.date_to}")
    print("=" * 78)

    affected, pre_withdrawal, scanned = [], 0, 0

    for snap in bills_ref.stream():
        b = snap.to_dict() or {}
        scanned += 1

        # Invoice date: checkout_time is the time of supply the app files on.
        date = str(b.get("checkout_time") or b.get("bill_date") or "")[:10]
        if not date:
            continue

        rate = b.get("gst_rate")
        gst_amount = _f(b.get("gst_amount"))
        # Accommodation value actually charged, after discounts.
        room_total = _f(b.get("room_charges_total"))
        discounts = _f(b.get("discounts"))
        nights = int(b.get("days_stayed") or b.get("nights") or 1) or 1

        # The signature of the bug: accommodation was charged, but zero GST
        # was applied to it. Either an explicit 0 rate, or a nil gst_amount
        # against a non-zero accommodation value.
        looks_exempt = (
            room_total > 0
            and gst_amount <= 0
            and (rate in (0, "0", None) or _f(rate) == 0)
        )
        if not looks_exempt:
            continue

        if date < EXEMPTION_WITHDRAWN_FROM:
            pre_withdrawal += 1
            continue
        if date < args.date_from or date > args.date_to:
            continue

        # Reconstruct the per-night value of supply the slab should have used.
        net = max(room_total - discounts, 0.0)
        per_night = net / nights if nights else net
        should_rate = _slab(per_night)
        should_tax = _tax_inclusive(net, should_rate)

        month = date[:7]
        filed = None
        if gls is not None:
            try:
                filed = bool(gls.is_month_locked(month))
            except Exception:
                filed = None

        affected.append({
            "bill_id": snap.id,
            "bill_number": b.get("bill_number") or "-",
            "date": date,
            "month": month,
            "guest": b.get("guest_name") or "",
            "nights": nights,
            "accommodation_net": round(net, 2),
            "per_night": round(per_night, 2),
            "charged_rate": "Exempt",
            "should_rate": f"{should_rate}%",
            "gst_short": should_tax,
            "gst_month_filed": filed,
            "invoice_generated": bool(b.get("invoice_generated")),
            "invoice_type": b.get("invoice_type") or "B2C",
        })

    affected.sort(key=lambda r: r["date"])

    if pre_withdrawal:
        print(f"\n{pre_withdrawal} exempt bill(s) dated before "
              f"{EXEMPTION_WITHDRAWN_FROM} — legitimately exempt, ignored.")

    if not affected:
        print(f"\nScanned {scanned:,} bills. Nothing affected in this window.")
        return 0

    print(f"\nScanned {scanned:,} bills. {len(affected)} affected:\n")
    hdr = (f"{'Bill No':<22} {'Date':<11} {'N':>2} {'Accom net':>10} "
           f"{'Per night':>10} {'Was':>7} {'Should':>7} {'GST short':>10}  Filed")
    print(hdr)
    print("-" * len(hdr))
    for r in affected:
        filed = "?" if r["gst_month_filed"] is None else ("YES" if r["gst_month_filed"] else "no")
        print(f"{r['bill_number']:<22} {r['date']:<11} {r['nights']:>2} "
              f"{r['accommodation_net']:>10,.2f} {r['per_night']:>10,.2f} "
              f"{'Exempt':>7} {r['should_rate']:>7} {r['gst_short']:>10,.2f}  {filed}")

    total_short = round(sum(r["gst_short"] for r in affected), 2)
    by_month: dict = defaultdict(lambda: [0, 0.0])
    for r in affected:
        by_month[r["month"]][0] += 1
        by_month[r["month"]][1] = round(by_month[r["month"]][1] + r["gst_short"], 2)

    print("\nBy GST month")
    print("-" * 40)
    for month in sorted(by_month):
        n, amt = by_month[month]
        print(f"  {month}   {n:>3} bill(s)   Rs {amt:>12,.2f}")

    filed_rows = [r for r in affected if r["gst_month_filed"] is True]
    print("-" * 40)
    print(f"  TOTAL under-declared output tax: Rs {total_short:,.2f}")
    if filed_rows:
        filed_short = round(sum(r["gst_short"] for r in filed_rows), 2)
        print(f"\n  !! {len(filed_rows)} of these are in months already marked "
              f"FILED (Rs {filed_short:,.2f}).")
        print("     Those cannot simply be re-rated: the return is out. The "
              "usual route is a debit note or an amendment in a later period.")
        print("     Take this list to your CA before changing anything.")
    if any(r["gst_month_filed"] is None for r in affected):
        print("\n  (Filed status unavailable for some months — gst_lock_service "
              "could not be queried.)")

    if args.csv_path:
        with open(args.csv_path, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(affected[0].keys()))
            w.writeheader()
            w.writerows(affected)
        print(f"\nWrote {len(affected)} rows to {args.csv_path}")

    print("\nNothing was modified. This script only reads.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
