"""
Money primitives — paise (integer) is the storage and arithmetic unit
inside the Banking package.

Why paise, not rupees
---------------------
Every deposit-math bug in the wild traces back to float arithmetic on
rupees-with-paise (1099.50 + 0.10 != 1099.60 in IEEE-754). By keeping
all internal sums in integer paise we eliminate that entire class of
bug. Conversion happens only at the I/O boundary.

Conversions
-----------
  rupees_to_paise(₹100.50)       → 10050
  paise_to_rupees_int(10050)     → 100              (truncates fraction)
  paise_to_rupees_str(10050)     → "100.50"          (display only)
  paise_to_rupees_float(10050)   → 100.5             (last resort)

Legacy compatibility
--------------------
Existing `bills.payment_cash`, `payments.amount`, etc. fields store
amounts as INT RUPEES. The Banking package writes a NEW field
`amount_paise` alongside; the old field is preserved for backward
compatibility. Reads tolerate both shapes via `coerce_to_paise()`.
"""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
from typing import Any


# ───────────────────────── Conversion ────────────────────────────────

def rupees_to_paise(amount: Any) -> int:
    """
    Convert a rupees value (int / float / str / Decimal) to integer paise.

    Rounds half-up at the paise level — Indian regulatory accounting
    convention. Returns 0 for None / empty / garbage rather than raising,
    so this helper can sit on hot write paths without a try/except wrapper.

    Examples
    --------
    >>> rupees_to_paise(100)        # 10000
    >>> rupees_to_paise(100.5)      # 10050
    >>> rupees_to_paise("99.99")    # 9999
    >>> rupees_to_paise(None)       # 0
    """
    if amount is None or amount == "":
        return 0
    try:
        d = Decimal(str(amount))
    except Exception:
        return 0
    if d.is_nan() or d.is_infinite():
        return 0
    paise = (d * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return int(paise)


def paise_to_rupees_int(paise: int) -> int:
    """Truncate paise to whole rupees. Used to populate legacy int-rupee fields."""
    try:
        return int(paise) // 100
    except (TypeError, ValueError):
        return 0


def paise_to_rupees_str(paise: int) -> str:
    """
    Render paise as a rupees string with exactly 2 decimal places.
    For display / PDF / CSV — never for further arithmetic.
    """
    try:
        p = int(paise)
    except (TypeError, ValueError):
        return "0.00"
    sign = "-" if p < 0 else ""
    p = abs(p)
    rupees, sub = divmod(p, 100)
    return f"{sign}{rupees}.{sub:02d}"


def paise_to_rupees_float(paise: int) -> float:
    """
    Float conversion, last resort — use only for legacy JSON payloads
    that the frontend expects as float. Avoid in any arithmetic chain.
    """
    try:
        return int(paise) / 100.0
    except (TypeError, ValueError):
        return 0.0


# ───────────────────────── Coercion ──────────────────────────────────

def coerce_to_paise(doc: dict, *, paise_key: str = "amount_paise",
                    rupee_key: str = "amount") -> int:
    """
    Read an amount from a doc that may be in either shape:
      - new shape: `amount_paise` (int paise)
      - legacy shape: `amount` (int rupees, possibly with float dust)

    Returns paise. Never raises. Used by reads/aggregations that span
    both schema versions during the migration window.
    """
    if doc is None:
        return 0
    if paise_key in doc and doc[paise_key] is not None:
        try:
            return int(doc[paise_key])
        except (TypeError, ValueError):
            pass  # fall through to legacy path
    return rupees_to_paise(doc.get(rupee_key))


# ───────────────────────── Aggregation ───────────────────────────────

def sum_paise(items, *, key: str = "amount_paise") -> int:
    """
    Sum a field across a list/iterable of dicts. Tolerates the
    legacy-shape rows by falling back through `coerce_to_paise()`.
    Returns 0 on any error.
    """
    try:
        total = 0
        for it in items:
            if it is None:
                continue
            if isinstance(it, dict):
                total += coerce_to_paise(it, paise_key=key)
            else:
                # Plain numeric — assume paise
                try:
                    total += int(it)
                except (TypeError, ValueError):
                    pass
        return total
    except Exception:
        return 0


# ───────────────────────── Validation ────────────────────────────────

def is_non_negative_paise(value: Any) -> bool:
    """True if value is an int-coercible non-negative paise amount."""
    try:
        return int(value) >= 0
    except (TypeError, ValueError):
        return False
