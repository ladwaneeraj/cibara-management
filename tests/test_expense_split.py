"""
Unit + integration tests for split-payment expenses.

A split spreads ONE expense across up to three money sources, each stored as
a linked single-method leg document:

    counter_cash -> transaction + cash   (the ONLY leg that moves the counter)
    home_cash    -> report      + cash
    account      -> report      + online

Two layers:

  1. Pure-function tests for  validate_split  and  _build_split_legs  — no
     I/O, no Firebase.

  2. Integration tests for the create + delete paths in routes/reports.py
     proving the counter math: a split increments the counter by the
     counter-cash leg ONLY, and deleting a split reverses by the same.

routes/reports.py imports the whole app at module load, so — following
tests/test_gst_helpers.py — we install lightweight stubs for those modules
first, then monkeypatch the specific collaborators on the imported module.

Run:  python -m unittest tests.test_expense_split
"""
from __future__ import annotations

import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _install_import_stubs():
    fa = types.ModuleType("firebase_admin")
    fa_fs = types.ModuleType("firebase_admin.firestore")

    class _Increment:
        def __init__(self, value):
            self.value = value

        def __eq__(self, other):
            return isinstance(other, _Increment) and other.value == self.value

        def __repr__(self):
            return f"Increment({self.value})"

    fa_fs.Increment = _Increment

    class _FieldFilter:
        def __init__(self, *a, **kw):
            self.args = a

    fa_fs.FieldFilter = _FieldFilter
    fa.firestore = fa_fs
    sys.modules["firebase_admin"] = fa
    sys.modules["firebase_admin.firestore"] = fa_fs

    gc = types.ModuleType("google")
    gc_cloud = types.ModuleType("google.cloud")
    gc_fs = types.ModuleType("google.cloud.firestore_v1")
    gc_bq = types.ModuleType("google.cloud.firestore_v1.base_query")
    gc_bq.FieldFilter = _FieldFilter
    sys.modules["google"] = gc
    sys.modules["google.cloud"] = gc_cloud
    sys.modules["google.cloud.firestore_v1"] = gc_fs
    sys.modules["google.cloud.firestore_v1.base_query"] = gc_bq

    flask = types.ModuleType("flask")

    class _Blueprint:
        def __init__(self, *a, **kw):
            pass

        def route(self, *a, **kw):
            def deco(fn):
                return fn
            return deco

    flask.Blueprint = _Blueprint
    flask.request = types.SimpleNamespace(json={}, get_json=lambda *a, **kw: {})
    flask.jsonify = lambda **kw: dict(kw)
    flask.g = types.SimpleNamespace()
    sys.modules["flask"] = flask

    config = types.ModuleType("config")
    config.db = None
    config.totals_ref = None
    config.bills_ref = None
    config.IST = None
    config.logger = types.SimpleNamespace(
        info=lambda *a, **kw: None,
        error=lambda *a, **kw: None,
        warning=lambda *a, **kw: None,
    )
    config.invalidate_rooms_and_totals = lambda *a, **kw: None
    config.get_all_rooms = lambda *a, **kw: {}
    sys.modules["config"] = config

    services_pkg = types.ModuleType("services")
    services_pkg.__path__ = []
    sys.modules["services"] = services_pkg
    for name in ("payment_service", "expense_service", "kpi_service"):
        m = types.ModuleType(f"services.{name}")
        sys.modules[f"services.{name}"] = m
        setattr(services_pkg, name, m)

    auth = types.ModuleType("services.auth_service")
    auth.requires_permission = lambda perm: (lambda fn: fn)
    auth.load_current_user = lambda: None
    sys.modules["services.auth_service"] = auth

    perms = types.ModuleType("services.permissions")
    perms.role_has_permission = lambda role, perm: False
    sys.modules["services.permissions"] = perms


_install_import_stubs()

import routes.reports as R  # noqa: E402


# ───────────────────────────── Pure-function tests ─────────────────────────
class TestValidateSplit(unittest.TestCase):
    def test_valid_two_source_split(self):
        ok, err, cc, hc, ac = R.validate_split(1000, 400, 0, 600)
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertEqual((cc, hc, ac), (400, 0, 600))

    def test_valid_three_source_split(self):
        ok, err, cc, hc, ac = R.validate_split(1000, 200, 300, 500)
        self.assertTrue(ok)
        self.assertEqual((cc, hc, ac), (200, 300, 500))

    def test_sum_must_equal_total(self):
        ok, err, *_ = R.validate_split(1000, 400, 100, 600)  # = 1100
        self.assertFalse(ok)
        self.assertIn("equal the total", err)

    def test_needs_at_least_two_positive(self):
        ok, err, *_ = R.validate_split(1000, 1000, 0, 0)
        self.assertFalse(ok)
        self.assertIn("at least two", err)

    def test_negative_rejected(self):
        ok, err, *_ = R.validate_split(1000, -100, 500, 600)
        self.assertFalse(ok)
        self.assertIn("negative", err)

    def test_non_integer_rejected(self):
        ok, err, *_ = R.validate_split(1000, "abc", 0, 600)
        self.assertFalse(ok)
        self.assertIn("whole numbers", err)

    def test_ineligible_category_rejected(self):
        for cat in ("rent", "booking_commission"):
            ok, err, *_ = R.validate_split(1000, 400, 0, 600, category=cat)
            self.assertFalse(ok, cat)
            self.assertIn("cannot be split", err)


class TestBuildSplitLegs(unittest.TestCase):
    def _base(self):
        return {"date": "2026-06-09", "time": "10:30", "category": "purchase",
                "description": "Supplies", "paid_to": "",
                "payment_method": "cash", "expense_type": "transaction"}

    def test_three_legs_when_all_positive(self):
        legs = R._build_split_legs(self._base(), "g1", 200, 300, 500, 1000)
        self.assertEqual(len(legs), 3)
        by_role = {l["split_role"]: l for l in legs}
        self.assertEqual(by_role["counter_cash"]["expense_type"], "transaction")
        self.assertEqual(by_role["counter_cash"]["payment_method"], "cash")
        self.assertEqual(by_role["counter_cash"]["amount"], 200)
        self.assertEqual(by_role["home_cash"]["expense_type"], "report")
        self.assertEqual(by_role["home_cash"]["payment_method"], "cash")
        self.assertEqual(by_role["home_cash"]["amount"], 300)
        self.assertEqual(by_role["account"]["expense_type"], "report")
        self.assertEqual(by_role["account"]["payment_method"], "online")
        self.assertEqual(by_role["account"]["amount"], 500)

    def test_zero_source_is_skipped(self):
        legs = R._build_split_legs(self._base(), "g1", 400, 0, 600, 1000)
        roles = {l["split_role"] for l in legs}
        self.assertEqual(roles, {"counter_cash", "account"})
        self.assertEqual(len(legs), 2)

    def test_all_share_group_and_total(self):
        legs = R._build_split_legs(self._base(), "g1", 200, 300, 500, 1000)
        for l in legs:
            self.assertEqual(l["split_group_id"], "g1")
            self.assertEqual(l["split_total"], 1000)
            self.assertEqual(l["description"], "Supplies")

    def test_counter_invariant_only_counter_cash_is_transaction(self):
        legs = R._build_split_legs(self._base(), "g1", 200, 300, 500, 1000)
        counter_amount = sum(
            l["amount"] for l in legs if l["expense_type"] == "transaction"
        )
        self.assertEqual(counter_amount, 200)

    def test_invoice_metadata_denormalised_with_one_primary(self):
        extra = {"has_bill": True, "invoice_number": "INV-9", "gst_amount": 153.0}
        legs = R._build_split_legs(self._base(), "g1", 200, 300, 500, 1000,
                                   primary_extra=extra)
        # Every leg carries the invoice metadata (consistent display)...
        for l in legs:
            self.assertEqual(l["invoice_number"], "INV-9")
            self.assertEqual(l["gst_amount"], 153.0)
            self.assertEqual(l["split_total"], 1000)
        # ...but exactly one leg is flagged primary (for ITC dedup).
        primary = [l for l in legs if l.get("split_primary")]
        self.assertEqual(len(primary), 1)
        self.assertEqual(primary[0]["split_role"], "counter_cash")


# ───────────────────────── Integration: fakes ──────────────────────────────
class _FakeRef:
    _counter = 0

    def __init__(self, doc_id=None):
        if doc_id is None:
            _FakeRef._counter += 1
            doc_id = f"auto{_FakeRef._counter}"
        self.id = doc_id


class _FakeTotalsCollection:
    def __init__(self):
        self.ref = _FakeRef("current_totals")

    def document(self, _id):
        return self.ref


class _FakeBatch:
    def __init__(self, store, counter):
        self.store = store
        self.counter = counter

    def set(self, ref, doc):
        self.store[ref.id] = doc

    def delete(self, ref):
        self.store.pop(ref.id, None)

    def update(self, ref, fields):
        inc = fields.get("expenses")
        if inc is not None:
            self.counter["value"] += inc.value

    def commit(self):
        return None


class _FakeDB:
    def __init__(self, store, counter):
        self._store = store
        self._counter = counter

    def batch(self):
        return _FakeBatch(self._store, self._counter)


def _unwrap(ret):
    if isinstance(ret, tuple):
        return ret[0], ret[1]
    return ret, 200


class _SplitTestBase(unittest.TestCase):
    def setUp(self):
        self.store = {}
        self.counter = {"value": 0}
        self._saved = {
            "db": R.db, "totals_ref": R.totals_ref, "jsonify": R.jsonify,
            "load_current_user": R.load_current_user,
            "role_has_permission": R.role_has_permission,
            "invalidate": R.invalidate_rooms_and_totals,
            "es": R.expense_service,
        }
        R.db = _FakeDB(self.store, self.counter)
        R.totals_ref = _FakeTotalsCollection()
        R.jsonify = lambda **kw: dict(kw)
        R.invalidate_rooms_and_totals = lambda *a, **kw: None

        es = types.SimpleNamespace()
        es.new_doc_ref = lambda: _FakeRef()
        es.doc_ref = lambda doc_id: _FakeRef(doc_id)
        es.normalise = lambda d: dict(d)
        es.query_split_group = lambda gid: [
            {**v, "_doc_id": k} for k, v in self.store.items()
            if v.get("split_group_id") == gid
        ]
        es.get_expense = lambda doc_id: (
            {**self.store[doc_id], "_doc_id": doc_id}
            if doc_id in self.store else None
        )
        R.expense_service = es

    def tearDown(self):
        R.db = self._saved["db"]
        R.totals_ref = self._saved["totals_ref"]
        R.jsonify = self._saved["jsonify"]
        R.load_current_user = self._saved["load_current_user"]
        R.role_has_permission = self._saved["role_has_permission"]
        R.invalidate_rooms_and_totals = self._saved["invalidate"]
        R.expense_service = self._saved["es"]

    def _as_admin(self):
        R.load_current_user = lambda: {"userId": "u1", "role": "admin"}
        R.role_has_permission = lambda role, perm: role == "admin"

    def _as_manager(self):
        R.load_current_user = lambda: {"userId": "u2", "role": "manager"}
        R.role_has_permission = lambda role, perm: role == "admin"

    def _base_entry(self):
        return {"date": "2026-06-09", "time": "10:30",
                "category": "purchase", "description": "Supplies"}


class TestCreateSplit(_SplitTestBase):
    def test_three_source_split_counts_counter_cash_only(self):
        self._as_admin()
        data = {"split": {"counter_cash": 200, "home_cash": 300, "account": 500}}
        body, status = R._create_split_expense(data, self._base_entry(), 1000)
        self.assertEqual(status, 200)
        self.assertTrue(body["success"])
        self.assertEqual(len(self.store), 3)              # three legs written
        self.assertEqual(self.counter["value"], 200)      # counter-cash only

        legs = list(self.store.values())
        txn = [l for l in legs if l["expense_type"] == "transaction"]
        rep = [l for l in legs if l["expense_type"] == "report"]
        self.assertEqual(len(txn), 1)
        self.assertEqual(txn[0]["amount"], 200)
        self.assertEqual(sorted(l["amount"] for l in rep), [300, 500])
        gids = {l["split_group_id"] for l in legs}
        self.assertEqual(len(gids), 1)

    def test_two_source_split_no_counter_cash(self):
        # home + account only → no counter movement at all.
        self._as_admin()
        data = {"split": {"counter_cash": 0, "home_cash": 400, "account": 600}}
        body, status = R._create_split_expense(data, self._base_entry(), 1000)
        self.assertEqual(status, 200)
        self.assertEqual(len(self.store), 2)
        self.assertEqual(self.counter["value"], 0)

    def test_manager_is_forbidden(self):
        self._as_manager()
        data = {"split": {"counter_cash": 400, "home_cash": 0, "account": 600}}
        body, status = R._create_split_expense(data, self._base_entry(), 1000)
        self.assertEqual(status, 403)
        self.assertEqual(len(self.store), 0)
        self.assertEqual(self.counter["value"], 0)

    def test_unauthenticated_is_401(self):
        R.load_current_user = lambda: None
        data = {"split": {"counter_cash": 400, "home_cash": 0, "account": 600}}
        body, status = R._create_split_expense(data, self._base_entry(), 1000)
        self.assertEqual(status, 401)
        self.assertEqual(len(self.store), 0)

    def test_invalid_split_writes_nothing(self):
        self._as_admin()
        data = {"split": {"counter_cash": 400, "home_cash": 0, "account": 500}}  # 900 != 1000
        body, status = R._create_split_expense(data, self._base_entry(), 1000)
        self.assertEqual(status, 400)
        self.assertEqual(len(self.store), 0)
        self.assertEqual(self.counter["value"], 0)

    def test_single_source_rejected_as_not_a_split(self):
        self._as_admin()
        data = {"split": {"counter_cash": 1000, "home_cash": 0, "account": 0}}
        body, status = R._create_split_expense(data, self._base_entry(), 1000)
        self.assertEqual(status, 400)
        self.assertEqual(len(self.store), 0)

    def test_split_with_gst_dedupes_to_one_itc_row(self):
        self._as_admin()
        data = {
            "split": {"counter_cash": 400, "home_cash": 0, "account": 600},
            "has_bill": True, "invoice_number": "INV-42",
            "invoice_date": "2026-06-09",
            "has_gst": True, "vendor_name": "Acme", "taxable_amount": 847,
            "gst_rate": 18, "gst_amount": 153,
        }
        body, status = R._create_split_expense(data, self._base_entry(), 1000)
        self.assertEqual(status, 200)
        legs = list(self.store.values())
        self.assertEqual(len(legs), 2)
        # Both legs carry the GST metadata (denormalised for display)...
        self.assertTrue(all(l.get("gst_amount") for l in legs))
        # ...but the ITC dedup collapses the group to ONE row at full gross.
        deduped = R._dedupe_split_groups(legs)
        self.assertEqual(len(deduped), 1)
        self.assertEqual(deduped[0]["invoice_number"], "INV-42")
        self.assertEqual(deduped[0]["split_total"], 1000)  # full invoice gross
        self.assertIs(deduped[0].get("split_primary"), True)
        self.assertEqual(self.counter["value"], 400)       # counter-cash only


class TestDeleteSplitGroup(_SplitTestBase):
    def test_delete_any_leg_removes_group_and_reverses_counter_cash_only(self):
        self._as_admin()
        R._create_split_expense(
            {"split": {"counter_cash": 200, "home_cash": 300, "account": 500}},
            self._base_entry(), 1000,
        )
        self.assertEqual(len(self.store), 3)
        self.assertEqual(self.counter["value"], 200)

        # Delete via the account (report) leg — whole group goes, counter
        # reverses by the counter-cash leg (200) only.
        account_leg_id = next(
            k for k, v in self.store.items() if v["split_role"] == "account"
        )
        body, status = _unwrap(R.delete_expense_route(account_leg_id))
        self.assertEqual(status, 200)
        self.assertTrue(body["success"])
        self.assertEqual(len(self.store), 0)
        self.assertEqual(self.counter["value"], 0)


class TestDedupeSplitGroups(unittest.TestCase):
    def test_keeps_primary_and_passes_singles(self):
        rows = [
            {"split_group_id": "g", "split_role": "counter_cash",
             "split_primary": True, "amount": 400, "gst_amount": 153},
            {"split_group_id": "g", "split_role": "account",
             "amount": 600, "gst_amount": 153},
            {"description": "non-split gst expense", "amount": 50, "gst_amount": 9},
        ]
        out = R._dedupe_split_groups(rows)
        self.assertEqual(len(out), 2)                  # group->1 + single
        grouped = [r for r in out if r.get("split_group_id")]
        self.assertEqual(len(grouped), 1)
        self.assertIs(grouped[0].get("split_primary"), True)

    def test_falls_back_to_first_when_no_primary_flag(self):
        rows = [
            {"split_group_id": "g", "amount": 400},
            {"split_group_id": "g", "amount": 600},
        ]
        out = R._dedupe_split_groups(rows)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["amount"], 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)
