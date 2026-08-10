"""
Regenerate the invoice PDF for a SINGLE bill, by its bill number.

It rebuilds the PDF from the bill's CURRENT data in Firestore (so it reflects
any edits), uploads it as a NEW version, and moves the bill's `pdf_url` pointer
to that new version. Previous PDF versions are RETAINED — pdf_service.upload_bill_pdf
never overwrites an existing file; only the "current" pointer changes. No other
bill is touched.

USAGE  (run from the repo root, in the SAME environment that runs the app):

    # Windows (PowerShell):
    $env:CIBARA_ENV = "PROD"
    .\.venv\Scripts\python -m scripts.regenerate_bill_pdf "CC/2026/06/00301"

    # macOS / Linux:
    export CIBARA_ENV=PROD
    python -m scripts.regenerate_bill_pdf "CC/2026/06/00301"

CIBARA_ENV selects the Firebase project (PROD = live). If no bill number is
passed, it defaults to CC/2026/06/00301.
"""
from __future__ import annotations

import io
import sys
from datetime import datetime


def main() -> int:
    bill_number = (sys.argv[1] if len(sys.argv) > 1 else "CC/2026/06/00301").strip()

    # Importing config initialises Firebase (project chosen via CIBARA_ENV).
    from config import bills_ref, IST
    from google.cloud.firestore_v1.base_query import FieldFilter
    from routes.billing import _build_bill_html, _build_pdf_html
    from services import pdf_service

    try:
        from xhtml2pdf import pisa
    except ImportError:
        print("ERROR: xhtml2pdf not installed. Run: pip install xhtml2pdf==0.2.16")
        return 1

    # ── Locate the bill by its invoice number ──────────────────────────────
    docs = list(
        bills_ref.where(filter=FieldFilter("bill_number", "==", bill_number))
                 .limit(2).stream()
    )
    if not docs:
        print(f"ERROR: no bill found with bill_number == {bill_number!r}")
        return 1
    if len(docs) > 1:
        print(f"WARN: multiple bills share {bill_number!r}; regenerating the FIRST only.")

    snap = docs[0]
    bill_id = snap.id
    bill = snap.to_dict() or {}
    bill["id"] = bill_id
    print(f"Found bill {bill_number}  (doc id {bill_id})")
    print(f"  current pdf_url : {bill.get('pdf_url') or '(none)'}")
    print(f"  room_price/night: {bill.get('room_price_per_night')}   "
          f"total: {bill.get('total_amount')}   balance: {bill.get('balance')}")

    # ── Build + convert the PDF from CURRENT data ──────────────────────────
    # Consolidated, matching /render_bill_pdf and auto_generate_bill_pdf. Every
    # path that can write a PDF to Storage pins the same view, so a bill's
    # invoice does not change shape depending on which one regenerated it.
    try:
        full_html = _build_pdf_html(_build_bill_html(bill, view="consolidated"))
    except Exception as e:  # noqa: BLE001
        print(f"ERROR: building the bill HTML failed: {e}")
        return 1

    buf = io.BytesIO()
    result = pisa.CreatePDF(full_html, dest=buf)
    if result.err:
        print(f"ERROR: xhtml2pdf conversion failed (code {result.err})")
        return 1

    # ── Upload as a NEW version (old versions are kept) ─────────────────────
    folder = bill.get("bill_number") or bill_id
    up = pdf_service.upload_bill_pdf(bill_id, folder, buf.getvalue())
    if not up.get("url"):
        print("ERROR: upload to Firebase Storage failed (check app logs).")
        return 1

    # upload_bill_pdf already stamped pdf_url + versions[]; refresh the timestamp.
    try:
        bills_ref.document(bill_id).update(
            {"pdf_updated_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S")}
        )
    except Exception:
        pass

    print("")
    print(f"OK: regenerated PDF v{up['version']} for {bill_number}")
    print(f"    new pdf_url: {up['url']}")
    print("    Previous versions retained; only this one bill was touched.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
