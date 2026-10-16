"""
GST invoice layout v2 (Rule 46 CGST Rules) — see render.py.

`install()` swaps the legacy renderer (`routes.billing._build_bill_html`) for
the v2 one, and wraps `_build_pdf_html` so v2 documents get their own print
CSS and a font that has the rupee glyph. Every surface that shows a bill —
the bill modal, Print, the PDF stored at checkout, /render_bill_pdf, the
WhatsApp/share copy — goes through those two functions, so the swap reaches
all of them. Money is NOT recomputed: totals come from the stored bill and
the tax table from `config.bill_tax_breakup` (the same function GSTR-1 uses).

Rollback: INVOICE_LAYOUT=legacy (no code change, no data change).
"""
from .render import build_invoice_html, build_pdf_document, install  # noqa: F401
