"""
Unit tests for the GST + Section-34 pure helpers in config.py.

These exercise:
  - validate_gstin              (Rule 46(b) format check)
  - derive_state_from_gstin     (state-code mapping)
  - classify_invoice_type       (B2B / B2CL / B2C bucketing)
  - compute_credit_components   (CN taxable + CGST + SGST split)
  - section_34_window_status    (30-Nov-of-following-FY deadline)

The tests stub Firebase so the helpers can be exercised offline. They
don't touch Firestore directly.
"""
from __future__ import annotations

import os
import sys
import types
import unittest
from datetime import date

# ── Firebase / Flask stubs ────────────────────────────────────────────────
_fa = types.ModuleType("firebase_admin")
for _sub in ("credentials", "firestore", "storage"):
    setattr(_fa, _sub, types.ModuleType(f"firebase_admin.{_sub}"))
    sys.modules[f"firebase_admin.{_sub}"] = getattr(_fa, _sub)
_fa.credentials.Certificate = lambda *a, **kw: None
_fa.initialize_app = lambda *a, **kw: None


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

# Make repo importable.
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

import config  # noqa: E402


# ─────────────────────────────────────────────────────────────────────────


class TestValidateGSTIN(unittest.TestCase):
    def test_valid_format(self):
        self.assertTrue(config.validate_gstin("29AAACI1681G1ZJ"))
        self.assertTrue(config.validate_gstin("27AAAAA1234A1Z5"))
        self.assertTrue(config.validate_gstin("07AAAAA1234A1Z9"))

    def test_whitespace_tolerant(self):
        self.assertTrue(config.validate_gstin("  29AAACI1681G1ZJ  "))

    def test_lowercase_normalised(self):
        self.assertTrue(config.validate_gstin("29aaaci1681g1zj"))

    def test_wrong_length(self):
        self.assertFalse(config.validate_gstin("29AAACI1681G1Z"))   # 14
        self.assertFalse(config.validate_gstin("29AAACI1681G1ZJX")) # 16

    def test_missing_z(self):
        # 13th position must be literal Z
        self.assertFalse(config.validate_gstin("29AAACI1681G1AJ"))

    def test_non_numeric_state(self):
        self.assertFalse(config.validate_gstin("AAAAACI1681G1ZJ"))

    def test_empty_inputs(self):
        for v in ("", None, " ", 12345, [], {}):
            self.assertFalse(config.validate_gstin(v))


class TestDeriveStateFromGSTIN(unittest.TestCase):
    def test_karnataka(self):
        self.assertEqual(config.derive_state_from_gstin("29AAACI1681G1ZJ"),
                         ("Karnataka", "29"))

    def test_maharashtra(self):
        self.assertEqual(config.derive_state_from_gstin("27AAAAA1234A1Z5"),
                         ("Maharashtra", "27"))

    def test_delhi(self):
        self.assertEqual(config.derive_state_from_gstin("07AAAAA1234A1Z9"),
                         ("Delhi", "07"))

    def test_unknown_code(self):
        # State code 99 is "Centre Jurisdiction" — known
        out = config.derive_state_from_gstin("99AAAAA1234A1Z5")
        self.assertEqual(out[1], "99")

    def test_invalid_gstin_returns_empty(self):
        self.assertEqual(config.derive_state_from_gstin("INVALID"), ("", ""))
        self.assertEqual(config.derive_state_from_gstin(""), ("", ""))


class TestClassifyInvoiceType(unittest.TestCase):
    def test_b2b_with_valid_gstin(self):
        self.assertEqual(config.classify_invoice_type("29AAACI1681G1ZJ", 5000), "B2B")
        self.assertEqual(config.classify_invoice_type("27AAAAA1234A1Z5", 100), "B2B")

    def test_b2c_no_gstin(self):
        self.assertEqual(config.classify_invoice_type("", 5000), "B2C")
        self.assertEqual(config.classify_invoice_type(None, 0), "B2C")

    def test_b2cl_threshold(self):
        # Amount > 1L, recipient state captured and not Karnataka
        self.assertEqual(
            config.classify_invoice_type("", 200_000, "07"),  # Delhi
            "B2CL"
        )

    def test_b2c_when_state_is_karnataka(self):
        # Karnataka recipient is intra-state — never B2CL for accommodation
        self.assertEqual(
            config.classify_invoice_type("", 200_000, "29"),
            "B2C"
        )

    def test_b2c_below_threshold(self):
        self.assertEqual(
            config.classify_invoice_type("", 50_000, "07"),
            "B2C"
        )


class TestComputeCreditComponents(unittest.TestCase):
    def test_at_0_percent(self):
        t, c, s = config.compute_credit_components({"gst_rate": 0}, 1000)
        self.assertEqual(t, 1000.0)
        self.assertEqual(c, 0.0)
        self.assertEqual(s, 0.0)

    def test_at_5_percent_inclusive(self):
        # ₹1000 inclusive @5% → taxable ≈ 952.38, GST ≈ 47.62 split equally
        t, c, s = config.compute_credit_components({"gst_rate": 5}, 1000)
        self.assertAlmostEqual(t, 952.38, places=2)
        self.assertAlmostEqual(c, 23.81, places=2)
        self.assertAlmostEqual(s, 23.81, places=2)
        self.assertAlmostEqual(t + c + s, 1000.0, places=1)

    def test_at_18_percent_inclusive(self):
        # ₹1000 inclusive @18% → taxable ≈ 847.46, GST ≈ 152.54
        t, c, s = config.compute_credit_components({"gst_rate": 18}, 1000)
        self.assertAlmostEqual(t, 847.46, places=2)
        self.assertAlmostEqual(c, 76.27, places=2)
        self.assertAlmostEqual(s, 76.27, places=2)

    def test_zero_total(self):
        self.assertEqual(
            config.compute_credit_components({"gst_rate": 18}, 0),
            (0.0, 0.0, 0.0),
        )

    def test_negative_total_normalises_to_taxable_only(self):
        # Defensive: shouldn't happen in practice but mustn't crash
        t, c, s = config.compute_credit_components({"gst_rate": 18}, -100)
        # Negative input falls through the rate<=0 / total<=0 guard
        self.assertEqual(c, 0.0)
        self.assertEqual(s, 0.0)


class TestSection34Window(unittest.TestCase):
    def test_within_window_fresh_invoice(self):
        s = config.section_34_window_status("2026-04-01", today=date(2026, 5, 10))
        self.assertTrue(s["in_window"])
        self.assertEqual(s["deadline"], date(2027, 11, 30))
        self.assertGreater(s["days_left"], 0)

    def test_within_window_late_in_year(self):
        # Supply Dec 2025 (FY 2025-26) → deadline 30 Nov 2026
        s = config.section_34_window_status("2025-12-15", today=date(2026, 5, 10))
        self.assertTrue(s["in_window"])
        self.assertEqual(s["deadline"], date(2026, 11, 30))

    def test_out_of_window(self):
        # Supply May 2024 (FY 2024-25) → deadline 30 Nov 2025; today 10 May 2026
        s = config.section_34_window_status("2024-05-15", today=date(2026, 5, 10))
        self.assertFalse(s["in_window"])
        self.assertEqual(s["deadline"], date(2025, 11, 30))
        self.assertLess(s["days_left"], 0)

    def test_march_supply_is_previous_fy(self):
        # March 2024 = FY 2023-24 → deadline 30 Nov 2024
        s = config.section_34_window_status("2024-03-31", today=date(2024, 6, 1))
        self.assertEqual(s["deadline"], date(2024, 11, 30))

    def test_april_supply_is_new_fy(self):
        # April 2024 = FY 2024-25 → deadline 30 Nov 2025
        s = config.section_34_window_status("2024-04-01", today=date(2024, 6, 1))
        self.assertEqual(s["deadline"], date(2025, 11, 30))

    def test_none_invoice_date(self):
        s = config.section_34_window_status(None)
        self.assertTrue(s["in_window"])    # safe default
        self.assertIsNone(s["deadline"])

    def test_garbage_invoice_date(self):
        s = config.section_34_window_status("not-a-date")
        self.assertTrue(s["in_window"])


class TestCNReasonMapping(unittest.TestCase):
    """Sanity-check the GSTR-1 Table 9B reason enum mapping."""

    def test_all_reasons_mapped(self):
        for reason in config.CN_REASONS:
            self.assertIn(reason, config.CN_REASON_GSTR1)
            self.assertTrue(config.CN_REASON_GSTR1[reason])

    def test_specific_mappings(self):
        self.assertEqual(config.CN_REASON_GSTR1["checkout_mistake"],
                         "04-Correction in Invoice")
        self.assertEqual(config.CN_REASON_GSTR1["post_supply_discount"],
                         "02-Post Sale Discount")
        self.assertEqual(config.CN_REASON_GSTR1["cancellation"],
                         "01-Sales Return")


if __name__ == "__main__":
    unittest.main(verbosity=2)
