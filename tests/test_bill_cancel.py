"""
Tests for cancelling a checked-out invoice (POST /cancel_bill).

The GST position the feature implements: an invoice raised by mistake is
never deleted or renumbered (Rule 46). While its month is not yet in a filed
GSTR-1 it is marked cancelled, keeps its number, and is reported in Table 13
as a cancelled document at zero value. Once the month is filed (locked) it
can only be corrected by a Section 34 credit note, so the cancel is refused.

Covered here:
  * bills_service.cancel_eligibility, the pure decision, branch by branch;
  * payment_service.receipt_totals, the one definition of "money received"
    shared with /recalculate_bill;
  * the /cancel_bill route against in-memory Firestore fakes (validation,
    permission, refusals, and the contents of the single atomic batch);
  * the guard that freezes money and tax on a cancelled bill;
  * the CANCELLED stamp on the invoice, in HTML and through xhtml2pdf.

Firebase is stubbed at import in the same style as test_bill_render.py.
"""
from __future__ import annotations

import io
import os
import sys
import types
import unittest

try:  # real exception class for the precondition test; imported before the
    from google.api_core import exceptions as _gexc  # google.* stubs below
except ImportError:  # pragma: no cover
    _gexc = None

# ── Firebase / Flask stubs ────────────────────────────────────────────────
_fa = types.ModuleType("firebase_admin")
for _sub in ("credentials", "firestore", "storage", "auth"):
    setattr(_fa, _sub, types.ModuleType(f"firebase_admin.{_sub}"))
    sys.modules[f"firebase_admin.{_sub}"] = getattr(_fa, _sub)
_fa.credentials.Certificate = lambda *a, **kw: None
_fa.initialize_app = lambda *a, **kw: None
_fa.auth.verify_id_token = lambda *a, **kw: {}


class _StubCollection:
    def document(self, *a, **kw): return self
    def get(self, *a, **kw):
        class _S:
            exists = False
            def to_dict(self): return {}
            def get(self, k, **kw): return None
        return _S()
    def set(self, *a, **kw): return None
    def update(self, *a, **kw): return None
    def stream(self, *a, **kw): return iter(())
    def where(self, *a, **kw): return self
    def limit(self, *a, **kw): return self
    def order_by(self, *a, **kw): return self
    parent = None


class _StubBatch:
    def set(self, *a, **kw): return None
    def update(self, *a, **kw): return None
    def commit(self, *a, **kw): return None


class _StubClient:
    def collection(self, n): return _StubCollection()
    def transaction(self): return None
    def batch(self): return _StubBatch()


_fa.firestore.client = _StubClient
_fa.firestore.transactional = lambda fn: fn
_fa.firestore.SERVER_TIMESTAMP = "STUB"
_fa.firestore.Increment = lambda v: v


class _FF:
    def __init__(self, *a, **kw): pass


_fa.firestore.FieldFilter = _FF
_fa.firestore.ArrayUnion = lambda v: v
_fa.storage.bucket = lambda: types.SimpleNamespace(name="stub", blob=lambda p: None)
sys.modules["firebase_admin"] = _fa

_gcf = types.ModuleType("google.cloud.firestore_v1.base_query")
_gcf.FieldFilter = _FF
sys.modules.setdefault("google", types.ModuleType("google"))
sys.modules.setdefault("google.cloud", types.ModuleType("google.cloud"))
sys.modules.setdefault("google.cloud.firestore_v1", types.ModuleType("google.cloud.firestore_v1"))
sys.modules["google.cloud.firestore_v1.base_query"] = _gcf

os.environ.setdefault("CIBARA_ENV", "UAT")
os.environ.setdefault("FIREBASE_KEY_FILE", "cibara-dev.json")

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

import config  # noqa: E402,F401
from flask import Flask  # noqa: E402
from routes import billing  # noqa: E402
from services import (  # noqa: E402
    auth_service, bills_service, customer_service, gst_lock_service,
    payment_service,
)
from services.bills_service import (  # noqa: E402
    cancel_eligibility, receipt_removal_check,
)
from services.payment_service import receipt_rows, receipt_totals  # noqa: E402

ZERO = {"cash": 0, "online": 0, "ota": 0, "refunds": 0}


def _bill(**over):
    b = {
        "bill_number": "CC/2026/09/00123",
        "status": "completed",
        "guest_name": "Ravi Kumar", "guest_mobile": "9876543210",
        "room": "204",
        "checkin_time": "2026-09-08 12:10",
        "checkout_time": "2026-09-09 10:05",
        "days_stayed": 1,
        "room_price_per_night": 1200, "room_charges_total": 1200,
        "gst_rate": 5, "gst_amount": 57.14, "total_amount": 1200,
        "services": [], "services_total": 0, "discounts": 0,
        "payment_cash": 0, "payment_online": 0, "balance": 1200,
    }
    b.update(over)
    return b


# ── cancel_eligibility ────────────────────────────────────────────────────

class TestCancelEligibility(unittest.TestCase):
    def test_completed_bill_with_nothing_received_is_cancellable(self):
        self.assertEqual(cancel_eligibility(_bill(), ZERO), (True, "OK", ""))

    def test_settle_later_bill_with_pending_settlement_is_cancellable(self):
        ok, code, _ = cancel_eligibility(
            _bill(status="pending_settlement", settlement_id="s1"),
            ZERO, {"status": "pending", "amount": 1200})
        self.assertEqual((ok, code), (True, "OK"))

    def test_second_click_on_a_manual_cancel_is_idempotent(self):
        ok, code, _ = cancel_eligibility(
            _bill(status="cancelled", cancel_kind="manual"), ZERO)
        self.assertEqual((ok, code), (True, "ALREADY_CANCELLED"))

    def test_revert_cancelled_bill_is_refused(self):
        ok, code, msg = cancel_eligibility(
            _bill(status="cancelled", cancelled_by_revert=True), ZERO)
        self.assertEqual((ok, code), (False, "CANCELLED_BY_REVERT"))
        self.assertIn("reverted", msg)

    def test_other_cancelled_bill_is_refused(self):
        ok, code, _ = cancel_eligibility(_bill(status="cancelled"), ZERO)
        self.assertEqual((ok, code), (False, "BAD_STATUS"))

    def test_draft_and_unknown_statuses_are_refused(self):
        for status in ("draft", "voided", "", None):
            ok, code, _ = cancel_eligibility(_bill(status=status), ZERO)
            self.assertEqual((ok, code), (False, "BAD_STATUS"), status)

    def test_legacy_reverted_bill_is_refused(self):
        # Pre cancel-on-revert: status stayed "completed" and a credit note
        # already reversed it. Cancelling too would reverse it twice.
        ok, code, _ = cancel_eligibility(_bill(superseded_by_revert=True), ZERO)
        self.assertEqual((ok, code), (False, "REVERTED"))

    def test_bill_with_a_credit_note_is_refused(self):
        for over in ({"linked_credit_note_id": "cn1"},
                     {"linked_credit_note_ids": ["cn1"]}):
            ok, code, msg = cancel_eligibility(_bill(**over), ZERO)
            self.assertEqual((ok, code), (False, "HAS_CREDIT_NOTE"), over)
            self.assertIn("twice", msg)

    def test_locked_month_is_refused_with_the_credit_note_route(self):
        ok, code, msg = cancel_eligibility(_bill(), ZERO, None, month_locked=True)
        self.assertEqual((ok, code), (False, "MONTH_LOCKED"))
        self.assertIn("2026-09", msg)
        self.assertIn("credit note", msg)
        self.assertIn("Section 34", msg)

    def test_month_lock_outranks_money_still_held(self):
        # The filed month is the real blocker: refunding would not help.
        ok, code, _ = cancel_eligibility(
            _bill(), dict(ZERO, cash=500), None, month_locked=True)
        self.assertEqual(code, "MONTH_LOCKED")

    def test_collected_settlement_is_refused(self):
        for status in ("paid", "partial", "PAID"):
            ok, code, _ = cancel_eligibility(
                _bill(status="pending_settlement"), ZERO, {"status": status})
            self.assertEqual((ok, code), (False, "SETTLEMENT_COLLECTED"), status)

    def test_cancelled_settlement_does_not_block(self):
        ok, _, _ = cancel_eligibility(_bill(), ZERO, {"status": "cancelled"})
        self.assertTrue(ok)

    def test_money_still_received_is_refused_with_the_breakdown(self):
        ok, code, msg = cancel_eligibility(
            _bill(), {"cash": 500, "online": 700, "ota": 0, "refunds": 200})
        self.assertEqual((ok, code), (False, "HAS_RECEIPTS"))
        self.assertIn("₹1000", msg)                 # 500 + 700 - 200
        self.assertIn("No money was received", msg)

    def test_ota_money_counts_as_received(self):
        ok, code, _ = cancel_eligibility(_bill(), dict(ZERO, ota=1200))
        self.assertEqual(code, "HAS_RECEIPTS")

    def test_fully_refunded_stay_is_cancellable(self):
        ok, code, _ = cancel_eligibility(
            _bill(), {"cash": 800, "online": 400, "ota": 0, "refunds": 1200})
        self.assertEqual((ok, code), (True, "OK"))

    def test_over_refund_is_refused(self):
        ok, code, msg = cancel_eligibility(_bill(), dict(ZERO, refunds=100))
        self.assertEqual(code, "HAS_RECEIPTS")
        self.assertIn("₹-100", msg)

    def test_fractional_amounts_are_shown_exactly(self):
        _, _, msg = cancel_eligibility(_bill(), dict(ZERO, online=10.5))
        self.assertIn("₹10.50", msg)


# ── receipt_totals ────────────────────────────────────────────────────────

class TestReceiptTotals(unittest.TestCase):
    def test_splits_receipts_by_method(self):
        rows = [
            {"type": "checkin", "method": "cash", "amount": 500},
            {"type": "payment", "method": "online", "amount": 700},
            {"type": "ota_prepaid", "method": "ota", "amount": 1200},
            {"type": "addon", "method": "cash", "amount": 60},
        ]
        self.assertEqual(receipt_totals(rows),
                         {"cash": 560, "online": 700, "ota": 1200, "refunds": 0})

    def test_voided_rows_are_not_money(self):
        rows = [
            {"type": "addon", "method": "cash", "amount": 60, "voided": True},
            {"type": "addon", "method": "online", "amount": 90, "voided": True},
            {"type": "checkin", "method": "cash", "amount": 500},
        ]
        self.assertEqual(receipt_totals(rows)["cash"], 500)
        self.assertEqual(receipt_totals(rows)["online"], 0)

    def test_refunds_count_by_type_whatever_the_method(self):
        rows = [
            {"type": "checkin", "method": "cash", "amount": 1000},
            {"type": "refund", "method": "cash", "amount": 100},
            {"type": "checkout_refund", "method": "online", "amount": 200},
            {"type": "manual_refund", "method": "cash", "amount": 50},
            {"type": "booking_cancel_refund", "method": "online", "amount": 25},
        ]
        t = receipt_totals(rows)
        self.assertEqual(t["refunds"], 375)
        self.assertEqual(t["cash"], 1000)   # refunds never count as receipts
        self.assertEqual(t["online"], 0)

    def test_non_receipt_rows_are_ignored(self):
        rows = [
            {"type": "discount", "method": "cash", "amount": 100},
            {"type": "expense", "method": "cash", "amount": 300},
            {"type": "settlement", "method": "settlement", "amount": -1200},
            {"type": "checkin", "method": "pay_later", "amount": 0},
            {"type": "checkin_balance", "method": "balance", "amount": 1200},
            {"type": "payment", "method": "upi", "amount": 40},
            None, "junk",
            {"type": "payment", "method": "cash", "amount": None},
        ]
        self.assertEqual(receipt_totals(rows), ZERO)

    def test_empty_ledger(self):
        self.assertEqual(receipt_totals([]), ZERO)
        self.assertEqual(receipt_totals(None), ZERO)


# ── /cancel_bill against in-memory Firestore ─────────────────────────────

class _Snap:
    def __init__(self, doc_id, data):
        self.id = doc_id
        self.exists = data is not None
        self._data = data
        self.update_time = ("t", doc_id)

    def to_dict(self):
        return dict(self._data) if self._data is not None else None


class _Ref:
    def __init__(self, store, coll, doc_id):
        self.store, self.coll, self.id = store, coll, doc_id

    def get(self):
        return _Snap(self.id, self.store.get((self.coll, self.id)))

    def update(self, data):
        self.store[(self.coll, self.id)].update(data)


class _Coll:
    def __init__(self, store, name):
        self.store, self.name = store, name

    def document(self, doc_id):
        return _Ref(self.store, self.name, doc_id)


class _Batch:
    def __init__(self, db):
        self.db, self.ops = db, []

    def update(self, ref, data, option=None):
        self.ops.append((ref.coll, ref.id, dict(data), option))

    def delete(self, ref, option=None):
        self.ops.append((ref.coll, ref.id, None, option))

    def commit(self):
        if self.db.fail_commit:
            raise self.db.fail_commit
        for coll, doc_id, data, _ in self.ops:
            if data is None:
                self.db.store.pop((coll, doc_id), None)
            else:
                self.db.store.setdefault((coll, doc_id), {}).update(data)
        self.db.committed.append(self)


class _DB:
    def __init__(self, store):
        self.store, self.committed, self.fail_commit = store, [], None

    def batch(self):
        return _Batch(self)

    def collection(self, name):
        return _Coll(self.store, name)

    def write_option(self, **kw):
        return ("precondition", kw)


class _RouteHarness(unittest.TestCase):
    """/cancel_bill against the in-memory fakes. No tests of its own."""
    ADMIN = {"userId": "u-admin", "role": "admin", "name": "Owner"}

    def setUp(self):
        self.store = {}
        self.db = _DB(self.store)
        self.ledger = []
        self.locked = False
        self.logs, self.pdf, self.cleared = [], [], []
        self.user = dict(self.ADMIN)
        patches = [
            (billing, "db", self.db),
            (billing, "bills_ref", _Coll(self.store, "bills")),
            (billing, "settlements_ref", _Coll(self.store, "settlements")),
            (billing, "rooms_ref", _Coll(self.store, "rooms")),
            (billing, "totals_ref", _Coll(self.store, "totals")),
            (billing, "write_log", lambda action, **kw: self.logs.append((action, kw))),
            (billing, "invalidate_rooms_and_totals", lambda: None),
            (billing, "_trigger_bill_pdf_refresh",
             lambda *a, **kw: self.pdf.append((a, kw))),
            (payment_service, "query_payments_by_stay_id", lambda sid: list(self.ledger)),
            (payment_service, "query_payments_for_stay", lambda *a, **kw: []),
            (gst_lock_service, "is_month_locked", lambda p: self.locked),
            (customer_service, "clear_pending_settlement",
             lambda mobile, settlement_id=None: self.cleared.append((mobile, settlement_id))),
            (auth_service, "load_current_user", lambda: self.user),
        ]
        self._saved = [(m, n, getattr(m, n)) for m, n, _ in patches]
        for m, n, v in patches:
            setattr(m, n, v)
        self.app = Flask(__name__)

    def tearDown(self):
        for m, n, v in self._saved:
            setattr(m, n, v)

    def _post(self, body):
        with self.app.test_request_context("/cancel_bill", method="POST", json=body):
            ret = billing.cancel_bill()
        resp, code = ret if isinstance(ret, tuple) else (ret, 200)
        return code, resp.get_json()

    def _seed(self, **over):
        self.store[("bills", "b1")] = _bill(**over)

    def _cancel(self, **extra):
        body = {"bill_id": "b1", "reason": "Duplicate room entry for Ravi", "confirm": True}
        body.update(extra)
        return self._post(body)


class CancelBillRouteTests(_RouteHarness):
    # validation / auth
    def test_reason_and_confirmation_are_required(self):
        self._seed()
        self.assertEqual(self._cancel(reason="dup")[0], 400)
        self.assertEqual(self._cancel(reason="x" * 501)[0], 400)
        self.assertEqual(self._cancel(confirm="true")[0], 400)
        self.assertEqual(self._cancel(confirm=None)[0], 400)
        self.assertFalse(self.db.committed)

    def test_managers_cannot_cancel(self):
        self._seed()
        self.user = {"userId": "u-mgr", "role": "manager", "name": "Mgr"}
        self.assertEqual(self._cancel()[0], 403)
        self.assertEqual(self.store[("bills", "b1")]["status"], "completed")

    def test_missing_bill_is_404(self):
        self.assertEqual(self._cancel()[0], 404)

    # the happy path and what goes in the one batch
    def test_cancel_marks_the_bill_and_keeps_its_number_and_amounts(self):
        self._seed(pdf_url="https://x/bill.pdf")
        self.ledger = [{"type": "checkin", "method": "pay_later", "amount": 0}]
        code, body = self._cancel()
        self.assertEqual(code, 200, body)
        self.assertTrue(body["success"])
        b = self.store[("bills", "b1")]
        self.assertEqual(b["status"], "cancelled")
        self.assertEqual(b["cancel_kind"], "manual")
        self.assertEqual(b["previous_status"], "completed")
        self.assertEqual(b["cancel_reason"], "Duplicate room entry for Ravi")
        self.assertEqual(b["cancelled_by"], "u-admin")
        self.assertEqual(b["cancelled_by_name"], "Owner")
        self.assertRegex(b["cancelled_at_ist"], r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$")
        self.assertEqual(b["lastModifiedBy"], "u-admin")
        # Rule 46: the number and every figure survive.
        self.assertEqual(b["bill_number"], "CC/2026/09/00123")
        self.assertEqual((b["total_amount"], b["balance"]), (1200, 1200))
        self.assertEqual(body["bill"]["status"], "cancelled")
        # one batch, bill write guarded by a precondition
        self.assertEqual(len(self.db.committed), 1)
        (op,) = [o for o in self.db.committed[0].ops if o[0] == "bills"]
        self.assertEqual(op[3], ("precondition", {"last_update_time": ("t", "b1")}))
        # audit + PDF refresh
        action, kw = self.logs[0]
        self.assertEqual(action, "bill.cancel")
        self.assertEqual(kw["metadata"]["bill_number"], "CC/2026/09/00123")
        self.assertEqual(kw["metadata"]["period"], "2026-09")
        self.assertEqual(self.pdf[0][1], {"pdf_status": "pending_cancel_refresh"})

    def test_no_pdf_refresh_for_a_bill_never_rendered(self):
        self._seed()
        self.ledger = [{"type": "checkin", "method": "pay_later", "amount": 0}]
        self.assertEqual(self._cancel()[0], 200)
        self.assertEqual(self.pdf, [])

    def test_repeat_is_idempotent_and_writes_nothing(self):
        self._seed(status="cancelled", cancel_kind="manual")
        code, body = self._cancel()
        self.assertEqual(code, 200)
        self.assertTrue(body["already_cancelled"])
        self.assertFalse(self.db.committed)

    def test_pending_settlement_is_cancelled_in_the_same_batch(self):
        self._seed(status="pending_settlement", settlement_id="s1")
        self.store[("settlements", "s1")] = {
            "status": "pending", "amount": 1200, "guest_mobile": "98765 43210"}
        self.store[("rooms", "204")] = {
            "status": "cleaning", "last_bill_id": "b1", "last_checkout_at": "x"}
        self.ledger = [{"type": "settlement", "method": "settlement", "amount": -1200}]
        code, body = self._cancel()
        self.assertEqual(code, 200, body)
        self.assertTrue(body["settlement_cancelled"])
        s = self.store[("settlements", "s1")]
        self.assertEqual(s["status"], "cancelled")
        self.assertEqual(s["cancel_reason"],
                         "Bill CC/2026/09/00123 cancelled: Duplicate room entry for Ravi")
        self.assertIn("cancel_date", s)
        room = self.store[("rooms", "204")]
        self.assertIsNone(room["last_bill_id"])
        self.assertIsNone(room["last_checkout_at"])
        self.assertEqual(len(self.db.committed), 1)
        self.assertEqual({o[0] for o in self.db.committed[0].ops},
                         {"bills", "settlements", "rooms"})
        # the customer flag is cleared only if it still names this settlement
        self.assertEqual(self.cleared, [("98765 43210", "s1")])

    def test_room_pointer_to_another_bill_is_left_alone(self):
        self._seed()
        self.store[("rooms", "204")] = {"status": "vacant", "last_bill_id": "other"}
        self.ledger = [{"type": "checkin", "method": "pay_later", "amount": 0}]
        self.assertEqual(self._cancel()[0], 200)
        self.assertEqual(self.store[("rooms", "204")]["last_bill_id"], "other")

    # refusals
    def test_locked_month_is_409_and_untouched(self):
        self._seed()
        self.locked = True
        code, body = self._cancel()
        self.assertEqual(code, 409)
        self.assertTrue(body["month_locked"])
        self.assertIn("credit note", body["message"])
        self.assertEqual(self.store[("bills", "b1")]["status"], "completed")

    def test_money_received_is_409_with_amounts(self):
        self._seed()
        self.ledger = [
            {"type": "checkin", "method": "cash", "amount": 500},
            {"type": "addon", "method": "online", "amount": 60, "voided": True},
        ]
        code, body = self._cancel()
        self.assertEqual(code, 409)
        self.assertEqual(body["code"], "HAS_RECEIPTS")
        self.assertEqual((body["cash"], body["online"], body["ota"], body["refunds"]),
                         (500, 0, 0, 0))
        self.assertFalse(self.db.committed)

    def test_empty_ledger_falls_back_to_the_receipts_on_the_bill(self):
        self._seed(payment_online=900, balance=300)
        self.ledger = []
        code, body = self._cancel()
        self.assertEqual(code, 409)
        self.assertEqual(body["code"], "HAS_RECEIPTS")
        self.assertEqual(body["online"], 900)

    def test_collected_settlement_is_409(self):
        self._seed(status="pending_settlement", settlement_id="s1")
        self.store[("settlements", "s1")] = {"status": "partial", "amount": 600}
        self.ledger = [{"type": "checkin", "method": "pay_later", "amount": 0}]
        code, body = self._cancel()
        self.assertEqual((code, body["code"]), (409, "SETTLEMENT_COLLECTED"))

    def test_revert_cancelled_is_409(self):
        self._seed(status="cancelled", cancelled_by_revert=True)
        code, body = self._cancel()
        self.assertEqual((code, body["code"]), (409, "CANCELLED_BY_REVERT"))

    @unittest.skipIf(_gexc is None, "google-api-core not installed")
    def test_concurrent_change_fails_the_batch_cleanly(self):
        self._seed()
        self.ledger = [{"type": "checkin", "method": "pay_later", "amount": 0}]
        self.db.fail_commit = _gexc.FailedPrecondition("stale")
        code, body = self._cancel()
        self.assertEqual((code, body["code"]), (409, "CHANGED"))
        self.assertEqual(self.store[("bills", "b1")]["status"], "completed")
        self.assertEqual(self.logs, [])


# ── money and tax frozen on a cancelled bill ─────────────────────────────

class TestReceiptRemoval(unittest.TestCase):
    """The duplicate-room case: the same Rs.500 online advance typed into
    rooms 225 and 226. The 226 bill can only be cancelled once its Rs.500,
    which never existed, leaves the ledger with it."""

    ADV = {"id": "p226", "type": "checkin", "method": "online", "amount": 500,
           "date": "2026-09-10", "time": "10:05"}

    def check(self, rows, receipts=None, locked=()):
        receipts = receipts or receipt_totals(rows)
        return receipt_removal_check(receipt_rows(rows), receipts,
                                     lambda period: period in locked)

    def test_duplicate_advance_can_be_removed(self):
        self.assertEqual(self.check([self.ADV]), (True, "OK", ""))

    def test_receipt_rows_are_what_receipt_totals_counts(self):
        rows = [self.ADV,
                {"type": "addon", "method": "cash", "amount": 60, "voided": True},
                {"type": "discount", "method": "cash", "amount": 100},
                {"type": "checkout_refund", "method": "cash", "amount": 40},
                {"type": "settlement", "method": "settlement", "amount": -700}]
        self.assertEqual(receipt_rows(rows), [self.ADV])

    def test_ota_money_and_refunds_are_never_removed(self):
        ota = dict(self.ADV, id="p1", method="ota")
        self.assertEqual(self.check([ota])[1], "RECEIPTS_NOT_REMOVABLE")
        refund = {"id": "r1", "type": "manual_refund", "method": "cash", "amount": 100}
        self.assertEqual(self.check([self.ADV, refund])[1], "RECEIPTS_NOT_REMOVABLE")

    def test_unreadable_ledger_removes_nothing(self):
        ok, code, _ = receipt_removal_check([], {"cash": 0, "online": 500,
                                                 "ota": 0, "refunds": 0},
                                            lambda p: False)
        self.assertEqual((ok, code), (False, "RECEIPTS_NOT_REMOVABLE"))

    def test_row_without_an_id_is_refused(self):
        row = {k: v for k, v in self.ADV.items() if k != "id"}
        self.assertEqual(self.check([row])[1], "RECEIPTS_NOT_REMOVABLE")

    def test_banked_cash_is_refused(self):
        row = dict(self.ADV, method="cash", cash_deposit_id="dep-9")
        ok, code, msg = self.check([row])
        self.assertFalse(ok)
        self.assertIn("dep-9", msg)

    def test_payment_in_a_locked_month_is_refused(self):
        ok, _, msg = self.check([dict(self.ADV, date="2026-08-31")],
                                locked={"2026-08"})
        self.assertFalse(ok)
        self.assertIn("2026-08", msg)


class CancelWithRemovalRouteTests(_RouteHarness):
    """/cancel_bill with remove_receipts, against the same in-memory fakes."""

    ADV = TestReceiptRemoval.ADV

    def setUp(self):
        super().setUp()
        self.store[("totals", "current_totals")] = {"online": 9000, "cash": 4000}

    def test_has_receipts_offers_removal_when_it_can_work(self):
        self._seed()
        self.ledger = [dict(self.ADV)]
        code, body = self._cancel()
        self.assertEqual(code, 409)
        self.assertEqual(body["code"], "HAS_RECEIPTS")
        self.assertTrue(body["can_remove_receipts"])
        self.assertEqual(body["receipt_entries"],
                         [{"method": "online", "amount": 500,
                           "date": "2026-09-10", "time": "10:05"}])
        self.assertFalse(self.db.committed)

    def test_duplicate_advance_is_removed_and_the_bill_cancelled_together(self):
        self._seed()
        self.store[("payments", "p226")] = dict(self.ADV)
        # Room 226 already holds the next guest: it must not be touched.
        self.store[("rooms", "204")] = {"status": "occupied", "balance": 800,
                                        "active_bill_id": "next-guest"}
        self.ledger = [dict(self.ADV)]
        code, body = self._cancel(remove_receipts=True)
        self.assertEqual(code, 200, body)
        self.assertNotIn(("payments", "p226"), self.store)
        self.assertEqual(self.store[("totals", "current_totals")]["online"], -500)
        b = self.store[("bills", "b1")]
        self.assertEqual(b["status"], "cancelled")
        self.assertEqual(b["removed_receipts"][0]["payment_id"], "p226")
        self.assertEqual(b["removed_receipts"][0]["amount"], 500)
        self.assertEqual(self.store[("rooms", "204")]["balance"], 800)
        self.assertEqual(len(self.db.committed), 1)
        self.assertIn("removed", body["message"])
        self.assertEqual(self.logs[0][1]["metadata"]["removed_receipts"][0]["payment_id"],
                         "p226")

    def test_cash_receipt_voucher_is_voided_not_deleted(self):
        self._seed()
        row = dict(self.ADV, method="cash", cash_receipt_id="rv1", receipt_no="RV/0042")
        self.store[("payments", "p226")] = dict(row)
        self.store[("cash_receipts", "rv1")] = {"receipt_no": "RV/0042", "voided_at": None}
        self.ledger = [row]
        self.assertEqual(self._cancel(remove_receipts=True)[0], 200)
        rv = self.store[("cash_receipts", "rv1")]
        self.assertEqual(rv["receipt_no"], "RV/0042")
        self.assertTrue(rv["voided_at"])
        self.assertEqual(self.store[("totals", "current_totals")]["cash"], -500)

    def test_banked_payment_refuses_and_writes_nothing(self):
        self._seed()
        self.ledger = [dict(self.ADV, method="cash", cash_deposit_id="dep-9")]
        code, body = self._cancel(remove_receipts=True)
        self.assertEqual(code, 409)
        self.assertEqual(body["code"], "RECEIPTS_NOT_REMOVABLE")
        self.assertFalse(self.db.committed)
        self.assertEqual(self.store[("bills", "b1")]["status"], "completed")


class TestCancelledBillGuard(unittest.TestCase):
    def test_guard(self):
        app = Flask(__name__)
        with app.app_context():
            self.assertIsNone(billing._cancelled_bill_response(_bill(), "x"))
            resp, code = billing._cancelled_bill_response(
                _bill(status="cancelled"), "recording a payment")
            self.assertEqual(code, 409)
            self.assertTrue(resp.get_json()["bill_cancelled"])
            self.assertIn("recording a payment", resp.get_json()["message"])


# ── CANCELLED stamp on the invoice ───────────────────────────────────────

def _manual_cancel():
    return _bill(status="cancelled", cancel_kind="manual",
                 cancel_reason="Duplicate <b>entry</b> & wrong room",
                 cancelled_by_name="Owner",
                 cancelled_at_ist="2026-09-10 14:05:33")


class TestCancelledBanner(unittest.TestCase):
    def test_live_bill_has_no_stamp(self):
        self.assertNotIn("b-cancel-banner", billing._build_bill_html(_bill()))

    def test_manual_cancel_stamp_says_who_when_why(self):
        html = billing._build_bill_html(_manual_cancel())
        self.assertIn("b-cancel-banner", html)
        self.assertIn("CANCELLED", html)
        self.assertIn("Sep 10, 2026, 02:05 PM", html)
        self.assertIn("by Owner", html)
        # operator text is escaped, never injected as markup
        self.assertIn("Duplicate &lt;b&gt;entry&lt;/b&gt; &amp; wrong room", html)
        self.assertNotIn("<b>entry</b>", html)

    def test_stamp_sits_above_the_letterhead(self):
        html = billing._build_bill_html(_manual_cancel())
        self.assertLess(html.index("b-cancel-banner"), html.index("TAX INVOICE"))

    def test_revert_cancel_stamp(self):
        html = billing._build_bill_html(
            _bill(status="cancelled", cancelled_by_revert=True))
        self.assertIn("Cancelled on checkout revert.", html)

    def test_stamp_is_plain_ascii(self):
        banner = billing._cancelled_banner(_manual_cancel())
        banner.encode("ascii")   # xhtml2pdf's core fonts are WinAnsi

    def test_pdf_renders_with_the_stamp(self):
        try:
            from xhtml2pdf import pisa
        except ImportError:
            self.skipTest("xhtml2pdf not installed")
        full = billing._build_pdf_html(
            billing._build_bill_html(_manual_cancel(), view="consolidated"))
        self.assertIn("CANCELLED", full)
        buf = io.BytesIO()
        result = pisa.CreatePDF(full, dest=buf)
        self.assertFalse(result.err)
        self.assertGreater(len(buf.getvalue()), 1000)


if __name__ == "__main__":
    unittest.main()
