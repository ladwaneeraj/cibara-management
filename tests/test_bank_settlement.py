"""
Unit tests for services/bank_settlement_service.py pure functions.

Offline only — exercises the advice-text parser, the platform detector, the
amount-based matcher, and the PDF-password derivation. No IMAP / Firestore /
pypdf needed. The fixture reproduces the decrypted text of a real HDFC payment
advice (MMT payout, UTR HDFCH01064621775, ₹3393.00, ref MMT3848).
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import bank_settlement_service as bank  # noqa: E402


# Mimics pypdf's extract_text() output for the sample MMT advice PDF.
ADVICE_TEXT = """PAYMENT ADVICE
MAKE MY TRIP (INDIA) PRIVATE LIMITED
MAKEMYTRIP INDIA PRIVATE LIMITED
19TH FLOOR,TOWER A,B & C EPITOME
BUILDING NO 5 DLF CYBER CITY PH-III
GURGAON, HARYANA. Pin : 122002
Beneficiary Name : CIBARA ENTERPRISE
Beneficiary Code : MHDOM1801821
Beneficiary Account Number : 925020058888935
Beneficiary Address
Client Reference No : SVPAUTOH018281772
Date : 15/06/2026
UTR / RRN No : HDFCH01064621775
Amount : 3393.00
Amount in Words : Three Thousand Three Hundred Ninety Three Rupees Only
Dear Sir / Madam,
We have initiated your payment to RBI for the amount of 3393.00 for the services rendered, vide NEFT, for below mentioned details
IFSC Code : UTIB0002669
Beneficiary Bank Name : AXIS BANK
Beneficiary Branch Name : HARIHAR
Payment Details 1 : statement
Payment Details 2 :
Payment Details 3 :
Payment Details 4 :
Payment Details 5 :
Payment Details 6 :
Payment Details 7 : MMT3848
This is computer generated advice. Does not require any signature.
"""

AGODA_ADVICE_TEXT = ADVICE_TEXT.replace(
    "MAKE MY TRIP (INDIA) PRIVATE LIMITED", "AGODA COMPANY PTE LTD"
).replace("MAKEMYTRIP INDIA PRIVATE LIMITED", "AGODA").replace(
    "MMT3848", "AGODA7782"
).replace("3393.00", "2620.80")


class TestParseAdvice(unittest.TestCase):
    def setUp(self):
        self.p = bank.parse_bank_advice_text(ADVICE_TEXT, subject="PAYMENT FROM MAKE MY TRIP")

    def test_parsed(self):
        self.assertIsNotNone(self.p)

    def test_money_and_refs(self):
        self.assertEqual(self.p["amount"], 3393.00)
        self.assertEqual(self.p["utr"], "HDFCH01064621775")
        self.assertEqual(self.p["txn_date"], "2026-06-15")
        self.assertEqual(self.p["client_ref"], "SVPAUTOH018281772")
        self.assertEqual(self.p["beneficiary_account"], "925020058888935")
        self.assertEqual(self.p["platform"], "mmt")
        self.assertIn("MMT3848", self.p["payment_refs"])
        # The empty "Payment Details N :" rows must NOT leak the next label.
        self.assertNotIn("Payment", self.p["payment_refs"])
        self.assertNotIn("statement", self.p["payment_refs"])
        self.assertFalse(self.p["needs_review"])

    def test_agoda_advice(self):
        p = bank.parse_bank_advice_text(AGODA_ADVICE_TEXT, subject="PAYMENT FROM AGODA")
        self.assertEqual(p["platform"], "agoda")
        self.assertEqual(p["amount"], 2620.80)

    def test_non_advice_rejected(self):
        self.assertIsNone(bank.parse_bank_advice_text("Your OTP is 123456. Do not share."))

    def test_platform_detect(self):
        self.assertEqual(bank.detect_platform("Payment from MakeMyTrip India"), "mmt")
        self.assertEqual(bank.detect_platform("AGODA COMPANY PTE LTD"), "agoda")
        self.assertEqual(bank.detect_platform("Some random bank text"), "")


class TestPickMatch(unittest.TestCase):
    def test_unique_match(self):
        cands = [
            {"booking_id": "a", "net_receivable": 3393.00},
            {"booking_id": "b", "net_receivable": 1200.00},
        ]
        b, reason = bank.pick_match(3393.00, cands, tolerance=1.0)
        self.assertIsNotNone(b)
        self.assertEqual(b["booking_id"], "a")

    def test_within_tolerance(self):
        b, _ = bank.pick_match(3393.00, [{"booking_id": "a", "net_receivable": 3392.5}], 1.0)
        self.assertEqual(b["booking_id"], "a")

    def test_no_match(self):
        b, reason = bank.pick_match(9999.00, [{"booking_id": "a", "net_receivable": 3393.0}], 1.0)
        self.assertIsNone(b)
        self.assertIn("no pending booking", reason)

    def test_ambiguous(self):
        cands = [
            {"booking_id": "a", "net_receivable": 3393.00},
            {"booking_id": "b", "net_receivable": 3393.00},
        ]
        b, reason = bank.pick_match(3393.00, cands, 1.0)
        self.assertIsNone(b)
        self.assertIn("ambiguous", reason)

    def test_none_amount(self):
        b, reason = bank.pick_match(None, [{"booking_id": "a", "net_receivable": 1.0}], 1.0)
        self.assertIsNone(b)


class TestPdfPassword(unittest.TestCase):
    def test_first6_derivation(self):
        os.environ["BANK_ACCOUNT_NUMBER"] = "925020058888935"
        try:
            cands = bank._pdf_password_candidates()
            self.assertEqual(cands[0], "925020")            # first 6 digits
            self.assertIn("925020058888935", cands)          # full no. as fallback
        finally:
            del os.environ["BANK_ACCOUNT_NUMBER"]

    def test_short_account(self):
        os.environ["BANK_ACCOUNT_NUMBER"] = "12345"
        try:
            self.assertEqual(bank._pdf_password_candidates()[0], "12345")
        finally:
            del os.environ["BANK_ACCOUNT_NUMBER"]

    def test_explicit_passwords_take_priority(self):
        os.environ["SETTLEMENT_PDF_PASSWORDS"] = "abc123, def456"
        os.environ["BANK_ACCOUNT_NUMBER"] = "925020058888935"
        try:
            cands = bank._pdf_password_candidates()
            self.assertEqual(cands[0], "abc123")
            self.assertIn("def456", cands)
            self.assertIn("925020", cands)
        finally:
            del os.environ["SETTLEMENT_PDF_PASSWORDS"]
            del os.environ["BANK_ACCOUNT_NUMBER"]


if __name__ == "__main__":
    unittest.main()
