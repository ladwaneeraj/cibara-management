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

# Model used specifically for guest ID extraction (pincode + DOB). Defaults to
# the invoice model, but can be pointed at a cheaper model independently — e.g.
# Flash-Lite is ~5-8x cheaper and plenty accurate for pulling a PIN and a date:
#   $env:ID_OCR_MODEL = "gemini-2.5-flash-lite"
_ID_MODEL_NAME = os.environ.get("ID_OCR_MODEL", "").strip() or _MODEL_NAME
_id_model = None


# ─── Extraction prompt ────────────────────────────────────────────────────
# Kept verbose because Gemini is highly prompt-sensitive on structured
# extraction. Each field describes WHERE to look and what format to use.
# The "never guess" instruction is critical — without it the model
# fabricates plausible-looking GSTINs for non-GST bills.
_PROMPT = """\
You are extracting fields from an Indian invoice or bill. The input is either
a photograph of a paper bill or a PDF invoice; treat both the same way. If a
PDF contains several pages, extract from the page carrying the invoice header
and totals.
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
    global _model, _id_model, _configured

    if not _SDK_AVAILABLE:
        return

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        logger.info("OCR: GEMINI_API_KEY not set — OCR disabled")
        return

    try:
        _genai.configure(api_key=api_key)
        _model = _genai.GenerativeModel(_MODEL_NAME)
        # Reuse the same handle when the ID model matches the invoice model,
        # otherwise build a second handle for ID extraction.
        _id_model = _model if _ID_MODEL_NAME == _MODEL_NAME else \
            _genai.GenerativeModel(_ID_MODEL_NAME)
        _configured = True
        logger.info("OCR service initialised (invoice model=%s, id model=%s)",
                    _MODEL_NAME, _ID_MODEL_NAME)
    except Exception as e:
        logger.error("OCR init failed: %s", e)
        _model = None
        _id_model = None
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


# ═══════════════════════════════════════════════════════════════════════════
# GUEST ID DOCUMENT EXTRACTION  —  pincode + date-of-birth for analytics
# ═══════════════════════════════════════════════════════════════════════════
#
# Separate from invoice extraction because the prompt, schema and validation
# are completely different. We only pull the two demographic fields the lodge
# owner asked for (area pincode + age via DOB) plus the name for sanity.
#
# Privacy note: this sends the guest's ID image to Google's Gemini API. The
# guest's full ID NUMBER is intentionally NOT requested here — it is already
# captured at check-in and stored as id_number. We extract only pincode +
# DOB, which are far less sensitive than the ID number itself. The feature is
# gated behind the same OCR-enabled flag and can be turned off entirely with
# the ID_OCR_ENABLED env var.

# Independent kill-switch. Defaults to "on when OCR is on". Set to "0"/"false"
# to keep invoice OCR working while disabling ID-document OCR specifically.
_ID_OCR_ENABLED = os.environ.get("ID_OCR_ENABLED", "1").strip().lower() not in (
    "0", "false", "no", "off",
)


_ID_PROMPT = """\
You are reading a photo of an Indian identity document. It may be an
Aadhaar card, Voter ID (EPIC), Driving Licence, PAN card, or Passport.

Return ONLY a single JSON object with exactly these keys:
{
  "name":       string|null,   // The person's full name as printed.

  "dob":        string|null,   // Date of birth in STRICT "YYYY-MM-DD" format.
                                // Convert from DD/MM/YYYY, DD-MM-YYYY,
                                // "12 Apr 1990" etc. Look for labels "DOB",
                                // "Date of Birth", "जन्म तिथि". If only a year
                                // of birth is printed (some Aadhaar show
                                // "Year of Birth: 1985"), leave dob null and
                                // use birth_year instead.

  "birth_year": integer|null,  // 4-digit year of birth. Fill this whenever you
                                // know the birth year, EVEN IF dob is also set
                                // (use the year from the dob). If the card shows
                                // only an AGE (e.g. Voter ID "Age: 34"), leave
                                // this null — do not guess a year from age.

  "pincode":    string|null,   // The 6-digit postal PIN code from the address
                                // block. Indian PIN codes are exactly 6 digits.
                                // Return the digits only, as a string, keeping
                                // any leading zero. If several addresses appear,
                                // use the permanent/main address. Null if no
                                // 6-digit PIN is clearly visible.

  "doc_kind":   string|null    // One of: "aadhaar", "voter", "dl", "pan",
                                // "passport", "other". Your best guess.
}

Rules:
1. Return ONLY the JSON object. No prose, no markdown fences.
2. Never invent digits. A wrong PIN or DOB pollutes the owner's analytics.
   When a field is not clearly legible, return null for that field.
3. Do NOT return the document/ID number. It is not needed.
4. PAN cards have no PIN code and usually no DOB address — return nulls for
   those fields rather than guessing.
"""


def extract_id_fields(image_bytes: bytes, mime_type: str) -> dict:
    """
    Extract demographic fields (name, dob, birth_year, pincode) from a guest
    ID-document image.

    Return shape (never raises):
        {"success": True,  "fields": {name, dob, birth_year, pincode, doc_kind}}
        {"success": False, "reason": "ocr_disabled"}
        {"success": False, "reason": "ocr_error", "message": "..."}
    """
    if not is_enabled() or not _ID_OCR_ENABLED:
        return {"success": False, "reason": "ocr_disabled"}

    if not image_bytes:
        return {"success": False, "reason": "ocr_error", "message": "Empty image"}

    try:
        resp = (_id_model or _model).generate_content(
            [
                {"mime_type": mime_type or "image/jpeg", "data": image_bytes},
                _ID_PROMPT,
            ],
            generation_config={
                "response_mime_type": "application/json",
                "temperature": 0.1,
                # gemini-2.5-flash is a THINKING model: its reasoning tokens
                # count against max_output_tokens. 512 was too tight — thinking
                # consumed the budget and the JSON came back truncated
                # ("Unterminated string"). 2048 leaves ample room for the
                # reasoning PLUS the tiny JSON payload.
                "max_output_tokens": 2048,
            },
        )
    except Exception as e:
        logger.error("ID OCR call failed: %s", e)
        return {"success": False, "reason": "ocr_error", "message": str(e)}

    raw = ""
    try:
        raw = (resp.text or "").strip()
    except Exception:
        try:
            cand = resp.candidates[0]
            raw = "".join(p.text for p in cand.content.parts if hasattr(p, "text"))
        except Exception:
            raw = ""

    if not raw:
        return {"success": False, "reason": "ocr_error", "message": "Empty response"}

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as e:
        logger.warning("ID OCR JSON parse failed: %s | raw=%s", e, raw[:300])
        return {"success": False, "reason": "ocr_error",
                "message": "Model returned non-JSON output"}

    fields = _normalise_id(parsed)
    logger.info("ID OCR normalised fields: %s", fields)
    return {"success": True, "fields": fields}


def _normalise_id(d: dict) -> dict:
    """Validate + coerce the ID extraction. Garbage values become None."""
    from datetime import datetime as _dt

    out = {"name": None, "dob": None, "birth_year": None,
           "pincode": None, "doc_kind": None}
    if not isinstance(d, dict):
        return out

    def _blankish(v) -> bool:
        if v is None:
            return True
        if isinstance(v, str):
            return v.strip().lower() in ("", "null", "none", "n/a", "na", "-", "—")
        return False

    # name
    if not _blankish(d.get("name")):
        out["name"] = str(d["name"]).strip()

    # dob — accept only strict YYYY-MM-DD that parses to a real, sane date
    if not _blankish(d.get("dob")):
        s = str(d["dob"]).strip()
        try:
            dt = _dt.strptime(s, "%Y-%m-%d")
            yr = dt.year
            if 1900 <= yr <= _dt.now().year:
                out["dob"] = s
                out["birth_year"] = yr  # derive year from a valid dob
        except ValueError:
            pass

    # birth_year — only if not already derived from dob
    if out["birth_year"] is None and not _blankish(d.get("birth_year")):
        try:
            yr = int(str(d["birth_year"]).strip())
            if 1900 <= yr <= _dt.now().year:
                out["birth_year"] = yr
        except (TypeError, ValueError):
            pass

    # pincode — exactly 6 digits
    if not _blankish(d.get("pincode")):
        digits = "".join(c for c in str(d["pincode"]) if c.isdigit())
        if len(digits) == 6:
            out["pincode"] = digits

    # doc_kind
    if not _blankish(d.get("doc_kind")):
        k = str(d["doc_kind"]).strip().lower()
        out["doc_kind"] = k if k in (
            "aadhaar", "voter", "dl", "pan", "passport", "other"
        ) else "other"

    return out


def id_ocr_enabled() -> bool:
    """True only when OCR is configured AND the ID-OCR kill-switch is on."""
    return bool(is_enabled() and _ID_OCR_ENABLED)
