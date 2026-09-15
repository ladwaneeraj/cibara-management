"""
Editing and deleting a payroll row from the Transactions tab.

Why this file exists
--------------------
Every payout writes TWO documents in one batch: the payroll record (advance /
salary payment / meal log) and an `expenses` row, linked both ways. The
Transactions tab lists the expense side. Acting on a row there used to be
refused outright — routes/reports.py still refuses it on the generic expense
endpoints — because touching one half leaves the other stale: the
outstanding-advance balance is derived from the raw advance and deduction
history, and totals/current_totals.expenses is a running counter of cash that
left the drawer.

So the row's Edit and Delete go to the Staff endpoints instead, and what is
pinned here is everything about them that can silently go wrong with money:

  * the cash counter after an edit — including an edit that moves a payout
    from the counter to the bank, where the amount did not change but the
    counter's share of it went to zero;
  * an advance cut below what a salary payment has already recovered, which
    would make the outstanding balance negative;
  * the line between a figure somebody chose (an advance) and a figure worked
    out from attendance (a salary, a meal log). The second kind is refused
    with the reversal route, never quietly written;
  * resolving an expense row back to its payroll record, including the old
    advances that predate the back-link.

Firebase is stubbed at import, in the style of the other service tests, and
Firestore is a small in-memory fake — the batches here have to be inspected,
not just executed.

Run: python -m pytest tests/test_payroll_edit.py
"""
from __future__ import annotations

import os
import sys
import types
import unittest
from datetime import datetime, timedelta

# ── Firebase / google.cloud stubs, before anything imports config ──────────
if "firebase_admin" not in sys.modules:
    _fa = types.ModuleType("firebase_admin")
    for _sub in ("credentials", "firestore", "storage", "auth"):
        setattr(_fa, _sub, types.ModuleType(f"firebase_admin.{_sub}"))
        sys.modules[f"firebase_admin.{_sub}"] = getattr(_fa, _sub)
    _fa.credentials.Certificate = lambda *a, **kw: None
    _fa.initialize_app = lambda *a, **kw: None
    _fa.auth.verify_id_token = lambda *a, **kw: {}
    _fa.firestore.SERVER_TIMESTAMP = "STUB"
    _fa.firestore.ArrayUnion = lambda v: v
    _fa.firestore.transactional = lambda fn: fn
    _fa.firestore.Increment = lambda v: v
    _fa.firestore.FieldFilter = lambda *a, **kw: None
    _fa.storage.bucket = lambda: types.SimpleNamespace(
        name="stub", blob=lambda p: None)

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
    sys.modules["firebase_admin"] = _fa


class _FF:
    """google.cloud.firestore_v1.base_query.FieldFilter, enough of it."""

    def __init__(self, field, op, value):
        self.field_path, self.op_string, self.value = field, op, value


if "google.cloud.firestore_v1.base_query" not in sys.modules:
    _gcf = types.ModuleType("google.cloud.firestore_v1.base_query")
    _gcf.FieldFilter = _FF
    sys.modules.setdefault("google", types.ModuleType("google"))
    sys.modules.setdefault("google.cloud", types.ModuleType("google.cloud"))
    sys.modules.setdefault("google.cloud.firestore_v1",
                           types.ModuleType("google.cloud.firestore_v1"))
    sys.modules["google.cloud.firestore_v1.base_query"] = _gcf

os.environ.setdefault("CIBARA_ENV", "UAT")
os.environ.setdefault("FIREBASE_KEY_FILE", "cibara-dev.json")

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

from services import staff_service as svc              # noqa: E402

# staff_service binds FieldFilter at import: `from ... import FieldFilter`.
# Whichever test file loads first installs its own stub for that module, and
# the other stubs in this suite discard the filter's arguments — which is fine
# for a fake that ignores queries and fatal for the fake below, which answers
# them. Rebinding the module attribute makes this file's behaviour the same
# whether it runs alone or after the rest of the suite.
svc.FieldFilter = _FF


# ── In-memory Firestore ────────────────────────────────────────────────────
# Only the surface staff_service uses: document get/set/update/delete, a
# single-field equality query, and a batch that applies on commit. Increment
# is modelled because the cash counter is the thing most of these tests are
# actually asserting on.

class _Inc:
    def __init__(self, amount):
        self.amount = amount


class _Snap:
    def __init__(self, doc_id, data):
        self.id = doc_id
        self._data = data

    @property
    def exists(self):
        return self._data is not None

    def to_dict(self):
        return dict(self._data) if self._data is not None else None


class _DocRef:
    def __init__(self, store, coll, doc_id):
        self._store, self._coll, self.id = store, coll, doc_id

    def get(self, **_kw):
        return _Snap(self.id, self._store.data(self._coll).get(self.id))

    def set(self, data, merge=False):
        bucket = self._store.data(self._coll)
        if merge and self.id in bucket:
            _merge(bucket[self.id], data)
        else:
            bucket[self.id] = _resolved(dict(data), {})

    def update(self, data):
        bucket = self._store.data(self._coll)
        if self.id not in bucket:
            raise KeyError("no such document: %s/%s" % (self._coll, self.id))
        _merge(bucket[self.id], data)

    def delete(self):
        self._store.data(self._coll).pop(self.id, None)


def _resolved(data, base):
    out = {}
    for k, v in data.items():
        out[k] = (int(base.get(k, 0) or 0) + v.amount) if isinstance(v, _Inc) else v
    return out


def _merge(target, data):
    target.update(_resolved(data, target))


class _CollRef:
    def __init__(self, store, coll, clauses=None, cap=None):
        self._store, self._coll = store, coll
        self._clauses = list(clauses or [])
        self._cap = cap

    def document(self, doc_id=None):
        if doc_id is None:
            doc_id = self._store.next_id(self._coll)
        return _DocRef(self._store, self._coll, str(doc_id))

    def where(self, filter=None, **_kw):          # noqa: A002 — Firestore's name
        return _CollRef(self._store, self._coll,
                        self._clauses + [filter], self._cap)

    def limit(self, n):
        return _CollRef(self._store, self._coll, self._clauses, n)

    def stream(self, **_kw):
        rows = []
        for doc_id, data in self._store.data(self._coll).items():
            if all(data.get(c.field_path) == c.value for c in self._clauses):
                rows.append(_Snap(doc_id, data))
        return iter(rows[:self._cap] if self._cap else rows)


class _Batch:
    """Staged writes. Nothing lands until commit, which is what makes a
    refusal raised mid-way provably a no-op."""

    def __init__(self):
        self._ops = []

    def set(self, ref, data, merge=False):
        self._ops.append(lambda: ref.set(data, merge=merge))

    def update(self, ref, data):
        self._ops.append(lambda: ref.update(data))

    def delete(self, ref):
        self._ops.append(lambda: ref.delete())

    def commit(self):
        for op in self._ops:
            op()
        self._ops = []


class _DB:
    def __init__(self):
        self._data = {}
        self._seq = 0

    def data(self, coll):
        return self._data.setdefault(coll, {})

    def next_id(self, coll):
        self._seq += 1
        return "%s_%d" % (coll, self._seq)

    def collection(self, name):
        return _CollRef(self, name)

    def batch(self):
        return _Batch()


def _today():
    return datetime.now(svc.IST).strftime("%Y-%m-%d")


def _tomorrow():
    return (datetime.now(svc.IST) + timedelta(days=1)).strftime("%Y-%m-%d")


class _PayrollCase(unittest.TestCase):
    """A staff member, an advance, a salary payout and a meal log, each with
    its linked expense row, sitting on a cash counter of ₹10,000."""

    def setUp(self):
        self.db = _DB()
        self._real = (svc.db, svc.totals_ref, svc.fa_firestore.Increment)
        svc.db = self.db
        svc.totals_ref = self.db.collection("totals")
        svc.fa_firestore.Increment = _Inc
        self.db.data("totals")["current_totals"] = {"expenses": 10000}
        self.addCleanup(self._restore)

    def _restore(self):
        svc.db, svc.totals_ref, svc.fa_firestore.Increment = self._real

    # ── fixtures ───────────────────────────────────────────────────────────
    def counter(self):
        return self.db.data("totals")["current_totals"]["expenses"]

    def add_advance(self, amount=2000, date=None, expense_type="transaction",
                    payment_method="cash", opening=False, link=True):
        date = date or _today()
        adv_id = "adv1"
        exp_id = "exp_adv1"
        adv = {"staff_id": "s1", "staff_name": "Maltesh K", "date": date,
               "amount": amount, "note": "", "payment_method": payment_method,
               "expense_type": expense_type}
        if opening:
            adv.update({"opening": True, "payment_method": "books",
                        "expense_type": "opening"})
        else:
            adv["expense_doc_id"] = exp_id
            self.db.data("expenses")[exp_id] = {
                "date": date, "category": "staff_advance",
                "description": "Staff Advance — Maltesh K", "amount": amount,
                "payment_method": payment_method, "expense_type": expense_type,
                "staff_advance": True, "staff_id": "s1",
                "staff_name": "Maltesh K",
                **({"advance_id": adv_id} if link else {}),
            }
        self.db.data("staff_advances")[adv_id] = adv
        return adv_id, exp_id

    def add_salary(self, net_paid=2100, paid_on=None, advance_deducted=0):
        paid_on = paid_on or _today()
        pay_id, exp_id = "sal1", "exp_sal1"
        pay = {"staff_id": "s1", "staff_name": "Maltesh K",
               "period_start": "2026-09-08", "period_end": "2026-09-14",
               "gross": net_paid + advance_deducted, "adjustment": 0,
               "advance_deducted": advance_deducted, "meal_deducted": 0,
               "net_paid": net_paid, "days_worked": 7, "daily_wage": 300,
               "payment_method": "cash", "expense_type": "transaction",
               "paid_on": paid_on,
               "expense_doc_id": exp_id if net_paid > 0 else None}
        self.db.data("staff_salary_payments")[pay_id] = pay
        if net_paid > 0:
            self.db.data("expenses")[exp_id] = {
                "date": paid_on, "category": "salary",
                "description": "Salary — Maltesh K", "amount": net_paid,
                "payment_method": "cash", "expense_type": "transaction",
                "staff_salary_payment": True, "salary_payment_id": pay_id,
                "staff_id": "s1", "staff_name": "Maltesh K",
            }
        return pay_id, exp_id

    def add_meals(self, amount=350):
        log_id, exp_id = "meal1", "exp_meal1"
        self.db.data("staff_meal_logs")[log_id] = {
            "staff_id": "s1", "staff_name": "Maltesh K", "amount": amount,
            "meal_days": 7, "meal_rate": 50, "logged_on": _today(),
            "payment_method": "cash", "expense_type": "transaction",
            "expense_doc_id": exp_id, "note": "",
        }
        self.db.data("expenses")[exp_id] = {
            "date": _today(), "category": "staff_meals", "amount": amount,
            "payment_method": "cash", "expense_type": "transaction",
            "staff_meal_log": True, "meal_log_id": log_id,
            "staff_id": "s1", "staff_name": "Maltesh K",
        }
        return log_id, exp_id


class TestAdvanceEdit(_PayrollCase):
    def test_amount_moves_both_documents_and_the_counter(self):
        adv_id, exp_id = self.add_advance(amount=2000)
        svc.update_advance(adv_id, {"amount": 2500})
        self.assertEqual(self.db.data("staff_advances")[adv_id]["amount"], 2500)
        self.assertEqual(self.db.data("expenses")[exp_id]["amount"], 2500)
        self.assertEqual(self.counter(), 10500)

    def test_lowering_an_advance_gives_the_counter_the_money_back(self):
        adv_id, _ = self.add_advance(amount=2000)
        svc.update_advance(adv_id, {"amount": 500})
        self.assertEqual(self.counter(), 8500)

    def test_moving_a_cash_advance_to_the_bank_empties_its_share(self):
        """The amount does not change; the counter's share of it goes to zero.

        An amount-only correction would leave ₹2,000 of counter cash behind
        for money that never left the drawer.
        """
        adv_id, exp_id = self.add_advance(amount=2000)
        svc.update_advance(adv_id, {"payment_method": "online",
                                    "expense_type": "report"})
        self.assertEqual(self.counter(), 8000)
        self.assertEqual(self.db.data("expenses")[exp_id]["expense_type"], "report")
        self.assertEqual(
            self.db.data("staff_advances")[adv_id]["payment_method"], "online")

    def test_moving_an_account_advance_back_to_cash_adds_it(self):
        adv_id, _ = self.add_advance(amount=2000, payment_method="online",
                                     expense_type="report")
        self.assertEqual(self.counter(), 10000)
        svc.update_advance(adv_id, {"payment_method": "cash",
                                    "expense_type": "transaction"})
        self.assertEqual(self.counter(), 12000)

    def test_the_note_is_rewritten_into_the_expense_description(self):
        adv_id, exp_id = self.add_advance()
        svc.update_advance(adv_id, {"note": "for bus fare"})
        self.assertEqual(self.db.data("expenses")[exp_id]["description"],
                         "Staff Advance — Maltesh K (for bus fare)")

    def test_cutting_below_what_a_salary_already_deducted_is_refused(self):
        adv_id, _ = self.add_advance(amount=2000)
        self.add_salary(net_paid=1000, advance_deducted=1500)
        with self.assertRaises(ValueError) as ctx:
            svc.update_advance(adv_id, {"amount": 800})
        self.assertIn("already been deducted", str(ctx.exception))
        # Nothing was written: the guard runs before the batch commits.
        self.assertEqual(self.db.data("staff_advances")[adv_id]["amount"], 2000)
        self.assertEqual(self.counter(), 10000)

    def test_cutting_down_to_what_was_deducted_is_allowed(self):
        adv_id, _ = self.add_advance(amount=2000)
        self.add_salary(net_paid=1000, advance_deducted=1500)
        svc.update_advance(adv_id, {"amount": 1500})
        self.assertEqual(self.db.data("staff_advances")[adv_id]["amount"], 1500)

    def test_a_future_date_is_refused(self):
        adv_id, _ = self.add_advance()
        with self.assertRaises(ValueError):
            svc.update_advance(adv_id, {"date": _tomorrow()})

    def test_zero_and_silly_amounts_are_refused(self):
        adv_id, _ = self.add_advance()
        for bad in (0, -100, svc.MAX_ADVANCE + 1, "abc"):
            with self.subTest(amount=bad):
                with self.assertRaises(ValueError):
                    svc.update_advance(adv_id, {"amount": bad})

    def test_an_opening_balance_has_no_payment_method_to_set(self):
        adv_id, _ = self.add_advance(opening=True)
        with self.assertRaises(ValueError) as ctx:
            svc.update_advance(adv_id, {"payment_method": "cash",
                                        "expense_type": "transaction"})
        self.assertIn("books", str(ctx.exception))

    def test_an_opening_balance_amount_is_still_correctable(self):
        adv_id, _ = self.add_advance(opening=True, amount=2000)
        svc.update_advance(adv_id, {"amount": 2400})
        self.assertEqual(self.db.data("staff_advances")[adv_id]["amount"], 2400)
        # It never went through the counter, so the counter must not move.
        self.assertEqual(self.counter(), 10000)

    def test_an_empty_edit_is_refused_rather_than_written(self):
        adv_id, _ = self.add_advance()
        with self.assertRaises(ValueError):
            svc.update_advance(adv_id, {})


class TestSalaryEdit(_PayrollCase):
    def test_the_payment_date_moves_the_row_in_the_cash_book(self):
        pay_id, exp_id = self.add_salary(paid_on="2026-09-15")
        svc.update_salary_payment(pay_id, {"paid_on": "2026-09-14"})
        self.assertEqual(
            self.db.data("staff_salary_payments")[pay_id]["paid_on"], "2026-09-14")
        self.assertEqual(self.db.data("expenses")[exp_id]["date"], "2026-09-14")
        # Only the date moved, so the counter must not.
        self.assertEqual(self.counter(), 10000)

    def test_moving_a_payout_to_the_bank_takes_it_out_of_the_counter(self):
        pay_id, _ = self.add_salary(net_paid=2100)
        svc.update_salary_payment(pay_id, {"payment_method": "online",
                                           "expense_type": "report"})
        self.assertEqual(self.counter(), 7900)

    def test_every_derived_figure_is_refused_with_the_way_to_change_it(self):
        pay_id, _ = self.add_salary()
        for field in ("net_paid", "gross", "amount", "advance_deducted",
                      "days_worked", "period_start", "period_end"):
            with self.subTest(field=field):
                with self.assertRaises(ValueError) as ctx:
                    svc.update_salary_payment(pay_id, {field: 1})
                self.assertIn("Reverse the payment", str(ctx.exception))

    def test_a_derived_figure_alongside_a_legal_one_still_refuses(self):
        """The whole request is rejected, not the good half applied.

        Half-applying would move the date and silently drop the amount the
        operator thought they were changing.
        """
        pay_id, _ = self.add_salary(paid_on="2026-09-15")
        with self.assertRaises(ValueError):
            svc.update_salary_payment(pay_id, {"paid_on": "2026-09-14",
                                               "net_paid": 5000})
        self.assertEqual(
            self.db.data("staff_salary_payments")[pay_id]["paid_on"], "2026-09-15")

    def test_a_payout_fully_adjusted_against_an_advance_still_edits(self):
        """net_paid 0 wrote no expense row, so there is nothing to move."""
        pay_id, _ = self.add_salary(net_paid=0, advance_deducted=2100)
        svc.update_salary_payment(pay_id, {"paid_on": "2026-09-14"})
        self.assertEqual(
            self.db.data("staff_salary_payments")[pay_id]["paid_on"], "2026-09-14")
        self.assertEqual(self.counter(), 10000)

    def test_a_future_payment_date_is_refused(self):
        pay_id, _ = self.add_salary()
        with self.assertRaises(ValueError):
            svc.update_salary_payment(pay_id, {"paid_on": _tomorrow()})

    def test_an_invalid_money_source_is_refused(self):
        pay_id, _ = self.add_salary()
        with self.assertRaises(ValueError):
            svc.update_salary_payment(pay_id, {"payment_method": "cheque"})


class TestMealLogEdit(_PayrollCase):
    def test_the_date_moves_both_documents(self):
        log_id, exp_id = self.add_meals()
        svc.update_meal_log(log_id, {"logged_on": "2026-09-14"})
        self.assertEqual(
            self.db.data("staff_meal_logs")[log_id]["logged_on"], "2026-09-14")
        self.assertEqual(self.db.data("expenses")[exp_id]["date"], "2026-09-14")

    def test_the_amount_is_refused_with_the_way_to_change_it(self):
        log_id, _ = self.add_meals()
        with self.assertRaises(ValueError) as ctx:
            svc.update_meal_log(log_id, {"amount": 400})
        self.assertIn("log the days again", str(ctx.exception))


class TestResolvingARowToItsPayrollRecord(_PayrollCase):
    def test_the_stamped_id_is_the_fast_path(self):
        adv_id, exp_id = self.add_advance()
        found = svc.payroll_record_for_expense(exp_id)
        self.assertEqual(found["kind"], "advance")
        self.assertEqual(found["id"], adv_id)
        self.assertEqual(found["staff_name"], "Maltesh K")

    def test_an_advance_written_before_the_back_link_still_resolves(self):
        """The oldest rows are the ones most likely to need a correction.

        They carry staff_advance and expense_doc_id but no advance_id, so the
        resolver falls back to a query on the advances collection.
        """
        adv_id, exp_id = self.add_advance(link=False)
        self.assertNotIn("advance_id", self.db.data("expenses")[exp_id])
        found = svc.payroll_record_for_expense(exp_id)
        self.assertEqual(found["id"], adv_id)

    def test_salary_and_meal_rows_resolve_to_their_own_kind(self):
        pay_id, sal_exp = self.add_salary()
        log_id, meal_exp = self.add_meals()
        self.assertEqual(svc.payroll_record_for_expense(sal_exp)["kind"], "salary")
        self.assertEqual(svc.payroll_record_for_expense(sal_exp)["id"], pay_id)
        self.assertEqual(svc.payroll_record_for_expense(meal_exp)["kind"], "meals")
        self.assertEqual(svc.payroll_record_for_expense(meal_exp)["id"], log_id)

    def test_an_ordinary_expense_is_not_payroll(self):
        self.db.data("expenses")["e9"] = {
            "date": _today(), "category": "rent", "amount": 5000,
            "payment_method": "cash", "expense_type": "transaction"}
        self.assertIsNone(svc.payroll_record_for_expense("e9"))

    def test_a_row_whose_payroll_record_vanished_says_so(self):
        _, exp_id = self.add_advance()
        self.db.data("staff_advances").clear()
        with self.assertRaises(ValueError) as ctx:
            svc.payroll_record_for_expense(exp_id)
        self.assertIn("payroll record is missing", str(ctx.exception))

    def test_a_row_that_no_longer_exists_says_so(self):
        with self.assertRaises(ValueError):
            svc.payroll_record_for_expense("gone")

    def test_salary_advertises_what_it_will_not_let_you_change(self):
        _, sal_exp = self.add_salary()
        found = svc.payroll_record_for_expense(sal_exp)
        self.assertNotIn("amount", found["editable"])
        self.assertIn("paid_on", found["editable"])
        self.assertTrue(found["locked_hint"])

    def test_advance_advertises_the_amount_as_editable(self):
        _, exp_id = self.add_advance()
        found = svc.payroll_record_for_expense(exp_id)
        self.assertIn("amount", found["editable"])
        self.assertFalse(found["locked_hint"])


class TestWhoMayEdit(unittest.TestCase):
    """Editing moves the same money a reversal does, so it takes the same
    permission: staff.manage, which is admin-only."""

    def test_editing_payroll_is_admin_only(self):
        from services.permissions import (
            ROLE_ADMIN, ROLE_MANAGER, role_has_permission)
        self.assertTrue(role_has_permission(ROLE_ADMIN, "staff.manage"))
        self.assertFalse(role_has_permission(ROLE_MANAGER, "staff.manage"))

    def test_the_generic_expense_endpoints_still_refuse_payroll_rows(self):
        """One door. If this guard ever goes, an edit through /expense would
        move the expense leg and leave the payroll record behind it."""
        src = open(os.path.join(_REPO, "routes", "reports.py"),
                   encoding="utf-8").read()
        self.assertEqual(src.count('old.get("staff_salary_payment")'), 2)
        self.assertEqual(src.count("payroll_linked=True"), 2)


class TestPatchAccountGate(unittest.TestCase):
    """The edits reuse _reject_account_source, the gate the create paths use.

    A PATCH body names only the fields being changed, so the question is
    whether that gate reads a partial body correctly. It does, because of its
    defaults: an absent payment_method reads as "cash". These pin that, since
    the alternative — a gate that treats every silent edit as a bank payment
    — locks a manager out of correcting a note.
    """

    def setUp(self):
        try:
            from routes import staff as staff_routes
        except Exception as exc:                      # pragma: no cover
            self.skipTest("routes.staff not importable here: %s" % exc)
        self.mod = staff_routes

    def _gate(self, data, can_pay_from_account):
        real = self.mod._can_pay_from_account
        self.mod._can_pay_from_account = lambda: can_pay_from_account
        try:
            return self.mod._reject_account_source(data)
        finally:
            self.mod._can_pay_from_account = real

    def test_an_edit_that_does_not_mention_the_source_is_not_an_account_move(self):
        self.assertFalse(self._gate({"paid_on": "2026-09-14"}, False))

    def test_moving_to_the_bank_without_the_permission_is_rejected(self):
        self.assertTrue(self._gate({"payment_method": "online"}, False))
        self.assertTrue(self._gate({"expense_type": "report"}, False))

    def test_an_admin_may_move_it_to_the_bank(self):
        self.assertFalse(self._gate({"payment_method": "online"}, True))

    def test_setting_the_source_back_to_cash_is_never_an_account_move(self):
        self.assertFalse(self._gate({"payment_method": "cash",
                                     "expense_type": "transaction"}, False))


if __name__ == "__main__":
    unittest.main(verbosity=2)
