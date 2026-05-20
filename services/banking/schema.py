"""
Banking schema — single source of truth for collection names, field
names, and enum values.

Everything in this module is a constant. Other modules import these
constants instead of hard-coding strings, so a rename here propagates
once and only once. Frontend mirrors the JS-visible subset; keep the two
files in sync.

DO NOT add behaviour to this module. If you find yourself writing a
function here, it belongs in another module.
"""

from __future__ import annotations

from typing import Final


# ───────────────────────── Collections ──────────────────────────────────

COL_BILLS: Final[str]            = "bills"             # existing
COL_PAYMENTS: Final[str]         = "payments"          # existing
COL_EXPENSES: Final[str]         = "expenses"          # existing
COL_COUNTERS: Final[str]         = "daily_counters"    # existing — shared

# New collections owned by the Banking package
COL_CASH_RECEIPTS: Final[str]    = "cash_receipts"
COL_CASH_DEPOSITS: Final[str]    = "cash_deposits"
COL_CASH_ADJUSTMENTS: Final[str] = "cash_adjustments"
COL_BANK_ACCOUNTS: Final[str]    = "bank_accounts"
COL_BILL_EVENTS: Final[str]      = "bill_events"


# ───────────────────────── Bill (stay) extensions ───────────────────────
# These are NEW fields written onto the existing `bills` doc by the
# trigger / deposit flow. The legacy fields (stay_id, bill_number,
# status, etc.) are owned by bills_service.py and untouched here.

BILL_INVOICEABLE: Final[str]              = "invoiceable"
BILL_INVOICEABLE_AT: Final[str]           = "invoiceable_at"
BILL_INVOICEABLE_TRIGGER_PAYMENT: Final[str] = "invoiceable_trigger_payment_id"
BILL_INVOICEABLE_TRIGGER_TOKEN: Final[str]   = "invoiceable_trigger_token"
BILL_FIRST_DEPOSIT_AT: Final[str]         = "first_deposit_at"
BILL_PROPERTY_ID: Final[str]              = "property_id"


# ───────────────────────── Payment extensions ───────────────────────────
# NEW fields stamped onto the existing `payments` doc by the Banking flow.

PAY_METHOD: Final[str]               = "method"             # existing
PAY_AMOUNT_PAISE: Final[str]         = "amount_paise"       # NEW — paise int
PAY_OFFICIALIZED_AT: Final[str]      = "officialized_at"    # ISO ts, IST
PAY_RECEIPT_ID: Final[str]           = "cash_receipt_id"
PAY_RECEIPT_NO: Final[str]           = "receipt_no"
PAY_RECEIPT_ISSUED_AT: Final[str]    = "receipt_issued_at"
PAY_DEPOSIT_ELIGIBILITY: Final[str]  = "deposit_eligibility"
PAY_CASH_DEPOSIT_ID: Final[str]      = "cash_deposit_id"
PAY_INVOICEABLE: Final[str]          = "invoiceable"        # mirrors bill
PAY_VOIDED_AT: Final[str]            = "voided_at"
PAY_REPLACES_PAYMENT_ID: Final[str]  = "replaces_payment_id"
PAY_PROPERTY_ID: Final[str]          = "property_id"


# ───────────────────────── Expense extensions ───────────────────────────

EXP_CASH_DEPOSIT_ID: Final[str]  = "cash_deposit_id"
EXP_VOIDED_AT: Final[str]        = "voided_at"
EXP_PROPERTY_ID: Final[str]      = "property_id"
EXP_AMOUNT_PAISE: Final[str]     = "amount_paise"


# ───────────────────────── Enums ────────────────────────────────────────

class PaymentMethod:
    CASH = "cash"
    ONLINE = "online"     # umbrella for UPI / card / bank-transfer / cheque

    ALL = frozenset({CASH, ONLINE})


class DepositEligibility:
    """
    Where a cash payment sits in the deposit lifecycle.

      pending   — bill not invoiceable yet, awaiting trigger
      eligible  — invoiceable, undeposited
      deposited — already bundled into a confirmed cash_deposit
      excluded  — bill closed without invoice (off-deposit/unofficial)
    """
    PENDING   = "pending"
    ELIGIBLE  = "eligible"
    DEPOSITED = "deposited"
    EXCLUDED  = "excluded"

    ALL = frozenset({PENDING, ELIGIBLE, DEPOSITED, EXCLUDED})


class DepositStatus:
    DRAFT      = "draft"        # being assembled
    CONFIRMED  = "confirmed"    # slip taken to bank
    RECONCILED = "reconciled"   # matched against bank statement
    REVERSED   = "reversed"     # rolled back (rare; admin-only)

    ALL = frozenset({DRAFT, CONFIRMED, RECONCILED, REVERSED})


class AdjustmentReason:
    OPENING_BALANCE   = "opening_balance"   # one-time, when feature goes live
    CASH_OVER         = "cash_over"         # EOD count > expected
    CASH_SHORT        = "cash_short"        # EOD count < expected
    OWNER_WITHDRAWAL  = "owner_withdrawal"  # owner took cash from drawer
    OWNER_DEPOSIT     = "owner_deposit"     # owner topped up drawer
    PETTY_EXPENSE     = "petty_expense"     # untracked tiny outflow
    BANK_REVERSAL     = "bank_reversal"     # deposit rejected by bank
    OTHER             = "other"

    ALL = frozenset({
        OPENING_BALANCE, CASH_OVER, CASH_SHORT,
        OWNER_WITHDRAWAL, OWNER_DEPOSIT, PETTY_EXPENSE,
        BANK_REVERSAL, OTHER,
    })


class BillEventType:
    CREATED            = "created"
    TRIGGER_FIRED      = "trigger_fired"
    TRIGGER_REVERTED   = "trigger_reverted"   # rare; only if no deposit yet
    PAYMENT_ADDED      = "payment_added"
    PAYMENT_VOIDED     = "payment_voided"
    PAYMENT_EDITED     = "payment_edited"
    RECEIPT_ISSUED     = "receipt_issued"
    RECEIPT_VOIDED     = "receipt_voided"
    DEPOSIT_LINKED     = "deposit_linked"
    DEPOSIT_UNLINKED   = "deposit_unlinked"
    FINALIZED          = "finalized"          # checkout, bill_number issued
    MARKED_UNOFFICIAL  = "marked_unofficial"  # checkout, no bill_number
    EDIT_BLOCKED       = "edit_blocked"       # guard fired

    ALL = frozenset({
        CREATED, TRIGGER_FIRED, TRIGGER_REVERTED,
        PAYMENT_ADDED, PAYMENT_VOIDED, PAYMENT_EDITED,
        RECEIPT_ISSUED, RECEIPT_VOIDED,
        DEPOSIT_LINKED, DEPOSIT_UNLINKED,
        FINALIZED, MARKED_UNOFFICIAL, EDIT_BLOCKED,
    })


class CounterKind:
    """
    Logical counter names used by counters.next_serial(). The full
    Firestore doc ID is `<kind>_FY<YY>-<YY>` (e.g. "rv_FY26-27").
    """
    CASH_RECEIPT   = "rv"   # Receipt Voucher (cash)
    ONLINE_RECEIPT = "or"   # Online Receipt
    DEPOSIT        = "dep"  # Bank-deposit serial

    ALL = frozenset({CASH_RECEIPT, ONLINE_RECEIPT, DEPOSIT})


# ───────────────────────── Permission keys ─────────────────────────────
# Mirrors entries that must be added to services/permissions.py.
# Listed here so service-layer code can reference them by name.

PERM_BANKING_VIEW              = "banking.view"
PERM_BANKING_DEPOSIT_CREATE    = "banking.deposit.create"
PERM_BANKING_DEPOSIT_CONFIRM   = "banking.deposit.confirm"
PERM_BANKING_DEPOSIT_RECONCILE = "banking.deposit.reconcile"
PERM_BANKING_DEPOSIT_REVERSE   = "banking.deposit.reverse"
PERM_BANKING_ADJUSTMENT_CREATE = "banking.adjustment.create"
PERM_BANKING_ACCOUNT_MANAGE    = "banking.account.manage"

BANKING_PERMISSIONS = frozenset({
    PERM_BANKING_VIEW,
    PERM_BANKING_DEPOSIT_CREATE,
    PERM_BANKING_DEPOSIT_CONFIRM,
    PERM_BANKING_DEPOSIT_RECONCILE,
    PERM_BANKING_DEPOSIT_REVERSE,
    PERM_BANKING_ADJUSTMENT_CREATE,
    PERM_BANKING_ACCOUNT_MANAGE,
})


# ───────────────────────── Constants ───────────────────────────────────

# Hard cap on how much cash can sit undeposited per stay before the UI
# nudges the operator. Used by routes/banking.py to surface a warning;
# does not block writes.
DEFAULT_UNDEPOSITED_THRESHOLD_PAISE: Final[int] = 25_000 * 100  # ₹25,000

# Format: RV/FY26-27/00001
RECEIPT_NO_FORMAT: Final[str] = "{prefix}/FY{fy_short}/{serial}"
RECEIPT_SERIAL_PAD: Final[int] = 5

# Format: DEP/FY26-27/00001 — internal serial for cash_deposit docs
DEPOSIT_REF_FORMAT: Final[str] = "DEP/FY{fy_short}/{serial}"
DEPOSIT_SERIAL_PAD: Final[int] = 5
