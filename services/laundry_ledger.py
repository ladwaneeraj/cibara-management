"""
Pure ledger math for the laundry vendor account.

This module has NO Firestore / Flask imports on purpose — it is plain
arithmetic over plain dicts, so it can be unit-tested without any
emulator (see tests/test_laundry_ledger.py).

Model (the way hotel PMS "folio" / vendor-account software works)
-----------------------------------------------------------------
The laundry vendor has ONE running account:

    balance = opening + sum(bills) + sum(adjustments) - sum(payments)

* A BILL is a charge — it adds to what we owe the vendor.
* A PAYMENT subtracts. Partial or full makes no difference; there is no
  allocation step the user has to think about.
* An ADJUSTMENT is a signed manual correction (+ we owe more / − we owe
  less), used to fix history without editing or deleting records.
* OPENING is the balance brought forward from before the ledger existed.

Because the balance belongs to the ACCOUNT and not to any month, there
is no "Old Balance" field to retype and therefore nothing to
double-count. Carry-forward is automatic.

Bill status chips (Paid / Partial / Due) are DERIVED, never stored:
credits (payments + negative adjustments) are applied FIFO to charges
(opening, then bills and positive adjustments in chronological order).
This is display-only sugar — deleting a payment simply re-derives
everything.
"""

# Sort rank within one calendar date: charges before credits, so paying
# a bill on the day it is entered nets to the expected running balance.
_RANK = {"opening": 0, "bill": 1, "adjustment": 2, "payment": 3}

_FALLBACK_DATE = "0000-00-00"   # undated entries sort to the top, visibly


def _as_int(v):
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def _entry_sort_key(e):
    return (e.get("date") or _FALLBACK_DATE,
            _RANK.get(e.get("type"), 9),
            e.get("time") or "")


def _bill_chrono_key(b):
    """FIFO order for bills: by billed period, then entry date."""
    return (b.get("period_end") or b.get("date") or _FALLBACK_DATE,
            b.get("period_start") or "",
            b.get("date") or "")


def compute_ledger(opening, bills, adjustments, payments):
    """
    Args (all amounts are whole rupees, ints):
      opening:     {"amount": int, "date": "YYYY-MM-DD", "note": str}
      bills:       [{"id", "date", "bill_date", "month",
                     "period_start", "period_end", "amount", "pieces"}]
      adjustments: [{"id", "date", "amount" (signed), "note"}]
      payments:    [{"id", "date", "time", "amount", "method",
                     "expense_type", "description"}]

    Returns:
      {
        "summary":  {opening, total_billed, total_paid,
                     total_adjustments, balance, advance},
        "entries":  chronological list, each with signed "effect" and
                    "running_balance" (passbook style),
        "bills":    bills + {"settled", "due", "status"} (FIFO-derived),
        "overlaps": [{a, b, label}] — pairs of bills whose periods
                    overlap (almost always a double-entry mistake),
      }
    """
    opening = opening or {}
    opening_amt = _as_int(opening.get("amount"))

    bills = [dict(b, amount=_as_int(b.get("amount"))) for b in (bills or [])]
    adjustments = [dict(a, amount=_as_int(a.get("amount")))
                   for a in (adjustments or [])]
    payments = [dict(p, amount=_as_int(p.get("amount")))
                for p in (payments or [])]

    total_billed = sum(b["amount"] for b in bills)
    total_paid = sum(p["amount"] for p in payments)
    total_adjustments = sum(a["amount"] for a in adjustments)
    balance = opening_amt + total_billed + total_adjustments - total_paid

    # ── FIFO settlement (display-only): credits → oldest charges first ──
    credit_pool = total_paid + sum(-a["amount"] for a in adjustments
                                   if a["amount"] < 0)
    charges = []
    if opening_amt > 0:
        charges.append({"kind": "opening", "ref": None,
                        "amount": opening_amt,
                        "_key": (opening.get("date") or _FALLBACK_DATE, "", "")})
    for b in bills:
        charges.append({"kind": "bill", "ref": b, "amount": b["amount"],
                        "_key": _bill_chrono_key(b)})
    for a in adjustments:
        if a["amount"] > 0:
            charges.append({"kind": "adjustment", "ref": a,
                            "amount": a["amount"],
                            "_key": (a.get("date") or _FALLBACK_DATE, "", "")})
    charges.sort(key=lambda c: c["_key"])

    pool = credit_pool
    opening_settled = 0
    for c in charges:
        take = min(pool, c["amount"]) if pool > 0 else 0
        pool -= take
        if c["kind"] == "bill":
            b = c["ref"]
            b["settled"] = take
            b["due"] = b["amount"] - take
            b["status"] = ("paid" if b["due"] <= 0 and b["amount"] > 0
                           else ("partial" if take > 0 else "due"))
            if b["amount"] == 0:
                b["status"] = "paid"
        elif c["kind"] == "opening":
            opening_settled = take
    advance = max(0, -balance)

    # ── Passbook entries with running balance ───────────────────────────
    entries = []
    if opening_amt != 0:
        entries.append({
            "type": "opening",
            "id": "opening",
            "date": opening.get("date") or "",
            "label": opening.get("note") or "Balance brought forward",
            "effect": opening_amt,
        })
    for b in bills:
        entries.append({
            "type": "bill",
            "id": b.get("id"),
            "date": b.get("date") or "",
            "label": "Bill",
            "period_start": b.get("period_start") or "",
            "period_end": b.get("period_end") or "",
            "month": b.get("month") or "",
            "pieces": _as_int(b.get("pieces")),
            "status": b.get("status"),
            "due": b.get("due"),
            "effect": b["amount"],
        })
    for a in adjustments:
        entries.append({
            "type": "adjustment",
            "id": a.get("id"),
            "date": a.get("date") or "",
            "label": a.get("note") or "Adjustment",
            "effect": a["amount"],
        })
    for p in payments:
        entries.append({
            "type": "payment",
            "id": p.get("id"),
            "date": p.get("date") or "",
            "time": p.get("time") or "",
            "label": p.get("description") or "Payment",
            "method": p.get("method") or "cash",
            "expense_type": p.get("expense_type") or "transaction",
            "effect": -p["amount"],
        })
    entries.sort(key=_entry_sort_key)

    running = 0
    for e in entries:
        running += e["effect"]
        e["running_balance"] = running
    # Guard: the passbook must end exactly on the account balance.
    assert running == balance, "ledger math drift"

    # ── Overlapping bill periods (double-entry detector) ────────────────
    overlaps = []
    dated = [b for b in bills if b.get("period_start") and b.get("period_end")]
    dated.sort(key=lambda b: (b["period_start"], b["period_end"]))
    for i in range(len(dated)):
        for j in range(i + 1, len(dated)):
            a, b = dated[i], dated[j]
            if b["period_start"] > a["period_end"]:
                break  # sorted — nothing later can overlap a
            overlaps.append({
                "a": a.get("id"), "b": b.get("id"),
                "label": (f"{a['period_start']}→{a['period_end']} overlaps "
                          f"{b['period_start']}→{b['period_end']}"),
            })

    return {
        "summary": {
            "opening": opening_amt,
            "opening_settled": opening_settled,
            "total_billed": total_billed,
            "total_paid": total_paid,
            "total_adjustments": total_adjustments,
            "balance": balance,
            "advance": advance,
        },
        "entries": entries,
        "bills": bills,
        "overlaps": overlaps,
    }
