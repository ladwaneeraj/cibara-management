"""
Banking package — cash receipts, bank deposits, cash adjustments, and the
invoiceability trigger that ties them all together.

Architectural overview
----------------------

The Banking module sits *on top of* the existing `bills` and `payments`
collections; it adds three new Firestore collections and one append-only
event log:

    cash_receipts       — one doc per receipt voucher (RV/OR sequences)
    cash_deposits       — one doc per bank-deposit event
    cash_adjustments    — opening balances, over/short, owner withdrawals
    bank_accounts       — destination accounts for deposits
    bill_events         — append-only audit log of bill state transitions

The package follows the established Cibara service pattern: every module
exposes an `init(db)` entry point, holds module-level Firestore refs,
guards every Firestore call with try/except, and never raises from a
write path — failures are logged and returned as `False` / `None`.

Money handling
--------------

All monetary fields stored or computed *inside* this package are in
**paise** (integer). The rupee-facing boundaries (HTTP payloads, PDF
output, existing collection fields) continue to use rupees. Helpers in
`money.py` handle the conversion. This eliminates float-rounding bugs in
deposit math while preserving compatibility with the legacy schema.

Public entry point
------------------

`init_banking(db)` initialises every sub-module exactly once at app
startup. It is the only thing `app.py` / `config.py` needs to call.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def init_banking(db) -> None:
    """
    One-shot initialiser for every Banking sub-module.

    Call from config.py during startup, after the core Firestore client
    is up. Idempotent — safe to call more than once; sub-modules simply
    re-bind their collection refs to the same client.
    """
    # Local imports keep package import time cheap and avoid pulling in
    # firebase_admin from any caller that only needs the package's
    # constants (e.g. tests, migrations, type checks).
    from . import counters
    from . import bill_events
    from . import bank_accounts
    from . import cash_receipts
    from . import cash_deposits
    from . import cash_adjustments
    from . import validators

    counters.init(db)
    bill_events.init(db)
    bank_accounts.init(db)
    cash_receipts.init(db)
    cash_deposits.init(db)
    cash_adjustments.init(db)
    validators.init(db)
    logger.info("Banking package initialised")
