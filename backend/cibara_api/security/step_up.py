"""
Step-up re-authentication for money-leaving actions (Phase 2).

This is RE-AUTH, not two-person separation of duties: the acting admin
re-enters their own password to confirm a money-out action (and to protect an
unattended, signed-in session). The gated actions are already admin-only, so
the initiator and the authorizer are the same person.

Two pieces:
  * required(method, path, body, settings) — pure mapper: given a request to a
    legacy money route, returns a StepUpSpec when the action needs confirmation
    (or None). Thresholds come from settings; always-gated actions ignore them.
  * store — an in-memory, single-instance store of single-use authorization
    tokens (issued by POST /api/v2/authorize after a password check) plus a
    short per-(user, action, target) grace window so a burst of actions on one
    bill isn't re-prompted. Single instance only (like the rate limiter and the
    revocation list); moving it off-process is a separate, flagged migration.

Only body-detectable money-out is mapped here. Deliberately NOT yet gated (see
CLAUDE.md): checkout OVERPAY refunds (amount is computed server-side, not in the
request body) and staff BANK payouts (dynamic /staff/<id>/... paths; already
admin-only via staff.pay.account).
"""
from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass


@dataclass(frozen=True)
class StepUpSpec:
    action: str   # cancel_bill | credit_note | bad_debt | writeoff | discount | refund
    amount: int   # ₹ involved (0 when not applicable); the token covers up to this
    target: str   # bill_id / settlement_id / room — the grace key


def _int(v) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def required(method: str, path: str, body, s) -> StepUpSpec | None:
    """Map a legacy request to the money-out action that needs step-up, or None."""
    if method.upper() != "POST":
        return None
    b = body if isinstance(body, dict) else {}

    if path == "/cancel_bill":
        return StepUpSpec("cancel_bill", 0, str(b.get("bill_id", "")))

    if path == "/issue_credit_note":
        return StepUpSpec("credit_note", _int(b.get("amount")), str(b.get("bill_id", "")))

    if path == "/add_bill_payment":
        dtype = (b.get("discount_type") or "financial").lower()
        disc = _int(b.get("discount"))
        bill = str(b.get("bill_id", ""))
        if bool(b.get("is_bad_debt")) and dtype == "financial":
            return StepUpSpec("bad_debt", disc, bill)        # always
        if dtype == "credit_note" and disc > 0:
            return StepUpSpec("credit_note", disc, bill)     # always
        if disc >= s.STEP_UP_DISCOUNT_MIN:
            return StepUpSpec("discount", disc, bill)        # threshold
        return None

    if path == "/collect_settlement":
        dtype = (b.get("discount_type") or "financial").lower()
        target = str(b.get("settlement_id", ""))
        if bool(b.get("bad_debt")):
            return StepUpSpec("writeoff", 0, target)         # always
        if dtype == "credit_note":
            return StepUpSpec("credit_note", 0, target)      # always
        return None

    if path == "/checkout":
        # Only a MANUAL refund is body-detectable here; overpay refunds are
        # computed server-side and are not gated (see module docstring).
        if bool(b.get("is_refund")) and bool(b.get("process_refund")):
            amt = _int(b.get("amount"))
            if amt >= s.STEP_UP_REFUND_MIN:
                return StepUpSpec("refund", amt, str(b.get("room", "")))
        return None

    return None


class _Store:
    def __init__(self, max_entries: int = 1024):
        self._lock = threading.Lock()
        self._tokens: dict[str, tuple[str, str, int, str, float]] = {}
        self._grace: dict[tuple[str, str, str], float] = {}
        self._max = max_entries

    def _evict_locked(self, now: float) -> None:
        if len(self._tokens) >= self._max:
            for k in [k for k, v in self._tokens.items() if v[4] <= now]:
                self._tokens.pop(k, None)
        if len(self._grace) >= self._max:
            for k in [k for k, v in self._grace.items() if v <= now]:
                self._grace.pop(k, None)

    def issue(self, authorizer: str, action: str, amount: int, target: str, ttl: float) -> str:
        token = secrets.token_urlsafe(24)
        now = time.monotonic()
        with self._lock:
            self._evict_locked(now)
            self._tokens[token] = (authorizer, action, max(0, int(amount)), target, now + ttl)
        return token

    def consume(self, token: str, action: str, amount: int, target: str) -> str | None:
        """Single-use. Returns the authorizer id if the token is valid for this
        action and covers this amount, else None."""
        if not token:
            return None
        with self._lock:
            rec = self._tokens.pop(token, None)
        if not rec:
            return None
        authorizer, a_action, a_amount, a_target, exp = rec
        if time.monotonic() > exp:
            return None
        if a_action != action:
            return None
        # a_amount == 0 means "always-gated, no ceiling"; otherwise the request
        # amount must not exceed what was authorized.
        if a_amount > 0 and amount > a_amount:
            return None
        return authorizer

    def set_grace(self, user: str, action: str, target: str, window: float) -> None:
        with self._lock:
            self._grace[(user, action, target)] = time.monotonic() + window

    def in_grace(self, user: str, action: str, target: str) -> bool:
        key = (user, action, target)
        with self._lock:
            exp = self._grace.get(key)
            if exp is None:
                return False
            if time.monotonic() <= exp:
                return True
            self._grace.pop(key, None)
            return False

    def clear(self) -> None:  # tests
        with self._lock:
            self._tokens.clear()
            self._grace.clear()


store = _Store()
