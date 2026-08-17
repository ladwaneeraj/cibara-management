"""
Guard tests for the invoice tax arithmetic in config.py.

WHY THIS FILE EXISTS
────────────────────
Bill CC/2026/08/00160 (13 nights x Rs 600) printed:

    taxable 7428.59   CGST 185.77   SGST 185.64   tax 371.41

Two faults, compounding:

  1. Tax was summed from PER-NIGHT rounded figures. round(600*5/105) = 28.57
     drops 0.0014 a night; over 13 nights the invoice was 0.02 short of the
     true 371.43, and the error grew with the length of the stay.

  2. Each night's tax was halved independently: round(28.57/2) = 14.29 left
     14.28 for SGST. One paise adrift every night, 13 paise over the stay. An
     intra-state supply is 2.5% + 2.5% — CGST and SGST must be EQUAL on the
     face of the invoice.

The fix computes tax once per slab on that slab's total, deriving each half
directly at half the rate (config.split_bucket_tax / config.aggregate_folio_tax).

These tests load the REAL functions out of config.py rather than a copy, so
they cannot pass against stale code. config.py imports firebase_admin at module
scope, so the pure math is extracted textually instead of imported.

RUN:  python tests/test_bill_tax.py        (from the repo root; no deps)
Exits non-zero on failure.
"""
import os
import sys
import types

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_pure_math():
    """Extract the pure tax functions from config.py into a live module."""
    src = open(os.path.join(_ROOT, "config.py"), encoding="utf-8").read()

    def grab(name, endmark):
        try:
            s = src.index("def %s(" % name)
        except ValueError:
            raise SystemExit(
                "tests/test_bill_tax.py: could not find %s() in config.py. "
                "If it was renamed, update this loader." % name)
        return src[s:src.index(endmark, s)]

    code = "from datetime import datetime, timedelta\nB2CL_THRESHOLD = 100000\n\n"
    code += grab("_slab_for_value", "\ndef compute_daily_folio")
    code += grab("compute_daily_folio", "\ndef split_bucket_tax")
    code += grab("split_bucket_tax", "\ndef aggregate_folio_tax")
    code += grab("aggregate_folio_tax", "\ndef compute_gst_split")
    mod = types.ModuleType("_cibara_tax_math")
    exec(compile(code, "config.py:tax-math", "exec"), mod.__dict__)
    return mod


folio = _load_pure_math()
split_bucket_tax = folio.split_bucket_tax
aggregate_folio_tax = folio.aggregate_folio_tax
compute_daily_folio = folio.compute_daily_folio
datetime = folio.datetime

fails = []


def paise(x):
    """Money comparisons in integer paise. abs(a-b) <= 0.01 on floats is a
    trap: 10428.58 - 10428.57 evaluates to 0.010000000000218, which fails a
    <= 0.01 test for no reason that has anything to do with the money."""
    return int(round(float(x) * 100))


def check(name, cond, detail=""):
    if cond:
        print("  ok   " + name)
    else:
        fails.append(name)
        print("  FAIL " + name + ("\n       " + detail if detail else ""))


def make_folio(days, rate_per_night, discount=0.0, room="212"):
    return compute_daily_folio(
        checkin_dt=datetime.strptime("2026-08-03 19:23", "%Y-%m-%d %H:%M"),
        days_stayed=days, room_price_per_night=rate_per_night,
        current_room_no=room, accommodation_services=[],
        pre_transfer_charges=[], discount_on_accom=discount,
        recipient_state_code="29")


print("\nThe reported bill: CC/2026/08/00160, 13 nights at Rs 600")
f = make_folio(13, 600)
a = aggregate_folio_tax(f)
print(f"  taxable {a['taxable']}  cgst {a['cgst']}  sgst {a['sgst']}  tax {a['tax']}")
check("CGST equals SGST", a["cgst"] == a["sgst"],
      f"cgst={a['cgst']} sgst={a['sgst']}")
check("taxable + tax reconciles to the gross 7800",
      paise(a["taxable"] + a["tax"]) == paise(7800),
      f"{a['taxable']} + {a['tax']} = {round(a['taxable']+a['tax'],2)}")
check("tax is within a paise of 7800*5/105 = 371.43",
      abs(paise(a["tax"]) - paise(371.43)) <= 1, f"tax={a['tax']}")
check("the old drifted figures are gone",
      a["taxable"] != 7428.59 and a["cgst"] != 185.77,
      f"taxable={a['taxable']} cgst={a['cgst']}")

print("\nsplit_bucket_tax invariants")
for gross, rate in [(7800, 5), (1800, 5), (900, 5), (100000, 18), (1, 5),
                    (12345.67, 5), (7501, 18), (0, 5), (5000, 0)]:
    r = split_bucket_tax(gross, rate)
    lhs = r["taxable"] + r["tax"]
    check(f"gross {gross} @ {rate}%: halves equal and reconciles",
          r["cgst"] == r["sgst"] and paise(lhs) == paise(gross),
          f"cgst={r['cgst']} sgst={r['sgst']} taxable+tax={lhs} gross={gross}")

print("\nLength independence — drift must not grow with the stay")
for n in (1, 2, 7, 13, 30, 90, 365):
    f = make_folio(n, 600)
    a = aggregate_folio_tax(f)
    gross = round(600.0 * n, 2)
    true_tax = round(gross * 5 / 105, 2)
    # A 1-paise band is the unavoidable cost of forcing CGST == SGST: each
    # half is rounded to 2dp, so their sum can sit a paise either side of the
    # theoretical total. Unequal halves on an invoice is the worse trade.
    check(f"{n:>3} nights: reconciles and stays within a paise of the true tax",
          paise(a["taxable"] + a["tax"]) == paise(gross)
          and abs(paise(a["tax"]) - paise(true_tax)) <= 1,
          f"tax={a['tax']} true={true_tax} sum={round(a['taxable']+a['tax'],2)} gross={gross}")

print("\nMixed slabs in one stay (transfer across the 7500 boundary)")
f = compute_daily_folio(
    checkin_dt=datetime.strptime("2026-08-03 12:00", "%Y-%m-%d %H:%M"),
    days_stayed=4, room_price_per_night=9000, current_room_no="301",
    accommodation_services=[],
    pre_transfer_charges=[{"from_room": "201", "days": 2, "price": 7000}],
    discount_on_accom=0.0, recipient_state_code="29")
a = aggregate_folio_tax(f)
print(f"  buckets: { {k: v['gross'] for k, v in a['by_rate'].items()} }")
check("both slabs are bucketed separately", set(a["by_rate"]) == {5, 18})
check("CGST equals SGST across mixed slabs", a["cgst"] == a["sgst"])
check("everything reconciles to 32000",
      paise(a["taxable"] + a["tax"]) == paise(32000),
      f"{round(a['taxable']+a['tax'],2)}")

print("\nDiscounted stay (the earlier 2-night / 1800 case)")
f = make_folio(2, 1800, discount=1800.0)
a = aggregate_folio_tax(f)
print(f"  taxable {a['taxable']}  cgst {a['cgst']}  sgst {a['sgst']}  tax {a['tax']}")
check("CGST equals SGST", a["cgst"] == a["sgst"])
check("reconciles to the discounted gross 1800",
      paise(a["taxable"] + a["tax"]) == paise(1800),
      f"{round(a['taxable']+a['tax'],2)}")
check("taxable at 5%, not exempt", 5 in a["by_rate"])

print("\nLegacy exempt folio still renders as issued")
r = split_bucket_tax(1500, 0)
check("rate 0 carries the gross as value with no tax",
      r["taxable"] == 1500.0 and r["tax"] == 0.0)

print(f"\n{'FAILED: ' + '; '.join(fails) if fails else 'All tax invariants hold'}")
raise SystemExit(1 if fails else 0)
