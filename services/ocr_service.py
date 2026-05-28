"""
OCR Service — extract structured fields from invoice/bill photos.

Implementation: Google Gemini 2.0 Flash (vision + structured JSON output)
via the official google-generativeai SDK.

Design notes
────────────
• The model is asked to return STRICT JSON with a fixed schema. We use
  the SDK's response_mime_type="application/json" so the SDK does the
  parsing & validation — we just hand back the dict.

• Confidence: Gemini does NOT return per-field confidence. We treat any
  null as "couldn't extract" and the frontend leaves that field blank
  for the operator to type. Never trust an extraction blindly — every
  field is editable before save.

• Degraded mode: if GEMINI_API_KEY is missing OR the SDK import fails
  (e.g. the package wasn't installed yet), the service returns a clean
  {"success": False, "reason": "ocr_disabled"} so the route can respond
  200-with-disabled rather than crashing the modal.

• Cost: Gemini 2.0 Flash free tier comfortably covers a small lodge
  (1500 req/day). Each scan uses ~1–3k tokens. The first prod cost
  beyond free tier is roughly ₹0.10 per scan at current pricing.

• Privacy: images are sent to Google. Documented in the deployment
  README so the lodge owner can decide.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

# Lazy import — keeps app boot working even if the package isn't
# installed (e.g. on a dev box that doesn't have an OCR key set up).
try:
    import google.generativeai as _genai
    _SDK_AVAILABLE = True
except Exception as e:  # pragma: no cover
    logger.warning("google-generativeai not available — OCR disabled: %s", e)
    _genai = None
    _SDK_AVAILABLE = False


# Module-level model handle, configured on init(). None until configure
# is called or while the SDK is unavailable.
_model = None
# Gemini model name. As of 2026 the 1.5 series is retired; 2.5-flash is
# the current production-grade vision model — fast, cheap, accurate on
# printed Indian invoices. If Google later renames or deprecates this,
# override with the OCR_MODEL env var without touching code:
#   $env:OCR_MODEL = "gemini-2.0-flash"
#   $env:OCR_MODEL = "gemini-flash-latest"
_MODEL_NAME = os.environ.get("OCR_MODEL", "gemini-2.5-flash").strip() or "gemini-2.5-flash"
_configured = False


# ─── Extraction prompt ────────────────────────────────────────────────────
# Kept verbose because Gemini is highly prompt-sensitive on structured
# extraction. Each field describes WHERE to look and what format to use.
# The "never guess" instruction is critical — without it the model
# fabricates plausible-looking GSTINs for non-GST bills.
_PROMPT = """\
You are extracting fields from an Indian invoice or bill photo.
Return ONLY a single JSON object with the keys listed below.

Schema:
{
  "invoice_number": string|null,    // The bill or invoice number. Look for labels
                                     // like "Invoice No.", "Bill No.", "Receipt No.",
                                     // "Inv No", "BillNo". Copy the value exactly,
                                     // preserving slashes, dashes, and leading zeros.

  "invoice_date":   string|null,    // Date on the invoice in strict "YYYY-MM-DD"
                                     // format. Convert from DD/MM/YYYY, DD-MM-YY,
                                     // "12 Apr 2025" etc. Use the bill's own date,
                                     // NOT today's date. Null if no date visible.

  "vendor_name":    string|null,    // Shop / seller / vendor name as printed.
                                     // Usually at the very top in large text.
                                     // Strip "M/s.", "M/s", "Pvt Ltd" suffixes only
                                     // if they obviously clutter; otherwise keep.

  "vendor_gstin":   string|null,    // 15-character GSTIN: 2 digits + 5 letters
                                     // + 4 digits + 1 letter + 1 alphanumeric + Z
                                     // + 1 alphanumeric (e.g. 29AABCT1332L1ZR).
                                     // Null if no valid GSTIN appears.

  "amount":         integer|null,   // Total amount payable in rupees, as a
                                     // POSITIVE INTEGER. Strip Rs/INR/₹, commas,
                                     // decimals (round to nearest rupee). This is
                                     // the FINAL total, after taxes and discounts.

  "description":    string|null,    // A short 3–8 word summary of what was bought,
                                     // suitable for an expense log row.
                                     // Examples: "Cleaning supplies", "Electricity
                                     // bill April", "Plumber - tap repair".
                                     // Do not include the vendor name here.

  "has_gst":        boolean,        // True iff the bill shows a GST / CGST / SGST /
                                     // IGST line item. False if it's a simple cash
                                     // receipt with no tax breakdown.

  "taxable_amount": number|null,    // Pre-GST taxable value, if has_gst is true.
                                     // Null otherwise.

  "gst_amount":     number|null,    // Total GST amount (CGST+SGST or IGST), if
                                     // has_gst is true. Null otherwise.

  "gst_rate":       number|null     // GST rate as a percentage number (one of 5,
                                     // 12, 18, 28). Null if has_gst is false or
                                     // not clearly stated.
}

Rules:
1. Return ONLY the JSON object. No prose, no markdown fences.
2. Make your BEST EFFORT to read each field. Partial reads are useful —
   the human will verify every value before saving. Only return null
   when the field is truly illegible or absent from the bill.
3. Do not invent GSTINs or fabricate digits — those have format checks
   downstream. For amounts, dates, vendor names, descriptions: prefer
   a best-guess reading over null.
4. "amount" is the final total payable, not any sub-line.
"""


# ─── Public API ───────────────────────────────────────────────────────────

def init() -> None:
    """
    Configure the Gemini client at app startup.

    Idempotent — safe to call more than once. If GEMINI_API_KEY isn't set,
    init() is a no-op and is_enabled() will return False.
    """
    global _model, _configured

    if not _SDK_AVAILABLE:
        return

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        logger.info("OCR: GEMINI_API_KEY not set — OCR disabled")
        return

    try:
        _genai.configure(api_key=api_key)
        _model = _genai.GenerativeModel(_MODEL_NAME)
        _configured = True
        logger.info("OCR service initialised (model=%s)", _MODEL_NAME)
    except Exception as e:
        logger.error("OCR init failed: %s", e)
        _model = None
        _configured = False


def is_enabled() -> bool:
    return bool(_SDK_AVAILABLE and _configured and _model is not None)


def extract_invoice_fields(image_bytes: bytes, mime_type: str) -> dict:
    """
    Send the image to Gemini and return the parsed field dict.

    Return shape:
        {"success": True,  "fields": {...}}     on a successful extraction
        {"success": False, "reason": "ocr_disabled"}    if OCR isn't configured
        {"success": False, "reason": "ocr_error", "message": "..."}    on failure

    Never raises — callers can rely on the dict shape.
    """
    if not is_enabled():
        return {"success": False, "reason": "ocr_disabled"}

    if not image_bytes:
        return {"success": False, "reason": "ocr_error", "message": "Empty image"}

    # Gemini SDK accepts a list of "parts" — text + inline image data.
    # response_mime_type forces strict JSON output (the SDK parses it).
    try:
        resp = _model.generate_content(
            [
                {"mime_type": mime_type or "image/jpeg", "data": image_bytes},
                _PROMPT,
            ],
            generation_config={
                "response_mime_type": "application/json",
                # Low temperature — extraction is deterministic, not creative.
                "temperature": 0.1,
                # Cap output: the JSON is tiny (~300 tokens). 1024 is safe.
                "max_output_tokens": 1024,
            },
        )
    except Exception as e:
        logger.error("OCR call failed: %s", e)
        return {"success": False, "reason": "ocr_error", "message": str(e)}

    # Parse the JSON the model returned. SDK usually provides .text;
    # response_mime_type=json keeps it as a JSON string we still parse
    # ourselves so we can normalise the shape before returning.
    raw = ""
    try:
        raw = (resp.text or "").strip()
    except Exception:
        # Some responses split candidates across parts — fallback path.
        try:
            cand = resp.candidates[0]
            raw = "".join(p.text for p in cand.content.parts if hasattr(p, "text"))
        except Exception:
            raw = ""

    # Log the raw model output. Truncated to 1500 chars so noisy bills
    # don't blow up the log line, but enough to see every field. This
    # is the single most useful debugging signal when extractions fail.
    logger.info("OCR raw response (%d bytes): %s",
                len(raw), raw[:1500] + ("…" if len(raw) > 1500 else ""))

    if not raw:
        return {"success": False, "reason": "ocr_error", "message": "Empty response"}

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        logger.warning("OCR JSON parse failed: %s | raw=%s", e, raw[:300])
        return {"success": False, "reason": "ocr_error",
                "message": "Model returned non-JSON output"}

    normalised = _normalise(parsed)
    # Log the post-normalisation result so we can tell whether fields
    # got stripped by validation (e.g. a malformed GSTIN being nulled).
    logger.info("OCR normalised fields: %s", normalised)
    return {"success": True, "fields": normalised}


# ─── Normalisation ─────────────────────────────────────────────────────────

# Keys we accept from the model. Anything else is dropped — keeps the
# response shape stable even if Gemini ever decides to add a key.
_KNOWN_KEYS = (
    "invoice_number", "invoice_date", "vendor_name", "vendor_gstin",
    "amount", "description",
    "has_gst", "taxable_amount", "gst_amount", "gst_rate",
)


def _normalise(d: dict) -> dict:
    """
    Clean up the model output:
      • coerce numerics
      • blank out obvious "no value" strings ("", "null", "n/a", "—", "-")
      • strip whitespace
      • uppercase + length-check GSTIN
    """
    if not isinstance(d, dict):
        return {}

    out: dict = {k: None for k in _KNOWN_KEYS}
    out["has_gst"] = False

    def _blankish(v) -> bool:
        if v is None:
            return True
        if isinstance(v, str):
            s = v.strip().lower()
            return s in ("", "null", "none", "n/a", "na", "-", "—")
        return False

    for k in _KNOWN_KEYS:
        if k not in d or _blankish(d.get(k)):
            continue
        v = d[k]

        if k == "amount":
            try:
                out[k] = int(round(float(v)))
                if out[k] <= 0:
                    out[k] = None
            except (TypeError, ValueError):
                out[k] = None

        elif k in ("taxable_amount", "gst_amount", "gst_rate"):
            try:
                out[k] = float(v)
            except (TypeError, ValueError):
                out[k] = None

        elif k == "has_gst":
            out[k] = bool(v) if isinstance(v, bool) else str(v).strip().lower() in ("true", "yes", "1")

        elif k == "vendor_gstin":
            g = str(v).strip().upper()
            # Strict-ish format check. GSTIN is exactly 15 chars,
            # alphanumeric. We don't validate the checksum here — that's
            # overkill for an auto-fill suggestion.
            if len(g) == 15 and g.isalnum():
                out[k] = g
            else:
                out[k] = None

        elif k == "invoice_date":
            # Trust the model only if it produced YYYY-MM-DD; otherwise
            # leave null. We don't want to push the wrong format into
            # the date input element.
            s = str(v).strip()
            if len(s) == 10 and s[4] == "-" and s[7] == "-":
                out[k] = s
            else:
                out[k] = None

        elif isinstance(v, str):
            out[k] = v.strip()

        else:
            out[k] = v

    # Coherence check: if has_gst is False, drop GST sub-fields so the
    # frontend doesn't show stale numbers.
    if not out["has_gst"]:
        out["taxable_amount"] = None
        out["gst_amount"] = None
        out["gst_rate"] = None

    return out
