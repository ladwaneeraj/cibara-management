"""
Backfill guest demographics (pincode + DOB) from existing ID documents.

For every customer that has ID document images on file but no demographics
yet, this downloads each image, runs ID-OCR, and stores the extracted
pincode / DOB on the customer record (services.customer_service).

  python -m scripts.backfill_demographics                 # dry run, all customers
  python -m scripts.backfill_demographics --commit        # actually write
  python -m scripts.backfill_demographics --commit --limit 50
  python -m scripts.backfill_demographics --commit --only 9876543210

Safety / behaviour:
  • Idempotent — a doc already represented in guest_demographics (matched by
    source_url) is skipped, so the script is safe to re-run / resume.
  • Rate-limited (default 1.2s between OCR calls) to stay within Gemini limits.
  • Requires GEMINI_API_KEY and ID_OCR_ENABLED (the same flags the live
    feature uses). Aborts early with a clear message if OCR is disabled.
  • Dry run by default: prints what it WOULD extract without writing.

Run against UAT first. This reads every customer document (Firestore read
cost) and sends each ID image to Google's Gemini API.

Exit code 0 = completed, non-zero = aborted.
"""

from __future__ import annotations

import argparse
import sys
import time
import urllib.request


def _download(url: str, timeout: int = 25, retries: int = 4) -> bytes:
    """
    Fetch image bytes from a (token-bearing) Firebase Storage URL.

    Retries with exponential backoff. Transient DNS failures
    ("getaddrinfo failed") are common when many requests fire in quick
    succession; a short pause lets the resolver recover instead of the
    whole run cascading into failures.
    """
    import time as _t
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "cibara-backfill"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except Exception as e:
            last_err = e
            # Backoff: 1.5s, 3s, 4.5s between attempts (skip after the last).
            if attempt < retries - 1:
                _t.sleep(1.5 * (attempt + 1))
    raise last_err


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--commit", action="store_true",
                    help="Actually write demographics (default is a dry run).")
    ap.add_argument("--limit", type=int, default=0,
                    help="Process at most N customers (0 = no limit).")
    ap.add_argument("--only", type=str, default="",
                    help="Process a single mobile number only.")
    ap.add_argument("--sleep", type=float, default=1.2,
                    help="Seconds to sleep between OCR calls (rate limit).")
    args = ap.parse_args()

    # Importing config bootstraps Firebase and initialises customer_service +
    # ocr_service (see config.py).
    from config import db  # noqa: F401  (side-effect: init)
    from services import customer_service, ocr_service

    if not ocr_service.id_ocr_enabled():
        print("ABORT: ID-OCR is disabled. Set GEMINI_API_KEY and ensure "
              "ID_OCR_ENABLED is not '0'/'false'. Nothing was changed.")
        return 2

    mode = "COMMIT" if args.commit else "DRY-RUN"
    print(f"Backfill demographics — mode={mode}, sleep={args.sleep}s")
    print("=" * 72)

    cust_ref = db.collection("customers")

    if args.only:
        only = "".join(c for c in args.only if c.isdigit())
        snaps = [cust_ref.document(only).get()]
        snaps = [s for s in snaps if s.exists]
    else:
        # IMPORTANT: materialise the whole list up front with list(...). We must
        # NOT hold a Firestore query stream open while doing slow per-doc OCR
        # (~8s each). The server-side stream has a ~60s deadline, so iterating it
        # lazily during OCR raises DeadlineExceeded after a few customers. This
        # read is lightweight (only id_doc_urls + guest_demographics) so pulling
        # it all at once is cheap.
        print("Loading customer list…")
        snaps = list(cust_ref.select(
            ["id_doc_urls", "guest_demographics"]
        ).stream())
        print(f"Loaded {len(snaps)} customer records.")

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    stats = {"customers": 0, "docs": 0, "ocr_ok": 0, "ocr_empty": 0,
             "written": 0, "errors": 0, "skipped_existing": 0,
             "skipped_local": 0}

    # Stop early if the billing/quota wall is hit — otherwise every remaining
    # doc fails the same way and just wastes time.
    consecutive_billing_errors = 0
    BILLING_ABORT_AFTER = 3
    aborted = False

    def _is_billing_error(msg: str) -> bool:
        m = (msg or "").lower()
        return ("credits are depleted" in m or "billing" in m
                or "quota" in m or "resource_exhausted" in m
                or "rate limit" in m)

    for snap in snaps:
        if aborted or (args.limit and stats["customers"] >= args.limit):
            break
        data = snap.to_dict() or {}
        urls = list(data.get("id_doc_urls", []) or [])
        if not urls:
            continue
        stats["customers"] += 1
        mobile = snap.id

        already = {e.get("source_url") for e in
                   (data.get("guest_demographics", []) or []) if e.get("source_url")}

        for url in urls:
            if url in already:
                stats["skipped_existing"] += 1
                continue
            stats["docs"] += 1

            # ── Fetch image bytes ────────────────────────────────────────────
            img = None
            if url.startswith("http://") or url.startswith("https://"):
                try:
                    img = _download(url)
                except Exception as e:
                    stats["errors"] += 1
                    print(f"  [{mobile}] download failed: {e}")
                    continue
            else:
                # Legacy local path (e.g. /uploads/customer_docs/..). The cloud
                # has no copy; try the local disk, otherwise skip quietly.
                local = os.path.join(repo_root, url.lstrip("/\\"))
                if os.path.exists(local):
                    try:
                        with open(local, "rb") as fh:
                            img = fh.read()
                    except Exception:
                        img = None
                if img is None:
                    stats["skipped_local"] += 1
                    continue

            # ── OCR ──────────────────────────────────────────────────────────
            res = ocr_service.extract_id_fields(img, "image/jpeg")
            time.sleep(args.sleep)

            if not res.get("success"):
                stats["errors"] += 1
                msg = res.get("message", res.get("reason"))
                print(f"  [{mobile}] OCR error: {msg}")
                if _is_billing_error(str(msg)):
                    consecutive_billing_errors += 1
                    if consecutive_billing_errors >= BILLING_ABORT_AFTER:
                        print("\n*** Stopping: Gemini billing/quota limit reached. "
                              "Add credits (https://ai.studio/projects) or switch to "
                              "free tier / Flash-Lite, then re-run — progress so far "
                              "is saved and will be skipped. ***")
                        aborted = True
                        break
                continue
            consecutive_billing_errors = 0  # a success resets the counter

            fields = res.get("fields") or {}
            has_data = bool(fields.get("dob") or fields.get("birth_year")
                            or fields.get("pincode"))
            if not has_data:
                stats["ocr_empty"] += 1
                print(f"  [{mobile}] nothing extractable from {url[-24:]}")
                continue

            stats["ocr_ok"] += 1
            print(f"  [{mobile}] pincode={fields.get('pincode')} "
                  f"dob={fields.get('dob')} birth_year={fields.get('birth_year')} "
                  f"({fields.get('doc_kind')})")

            if args.commit:
                customer_service.apply_id_extraction(
                    mobile, fields, source_url=url, sync=True
                )
                stats["written"] += 1

    print("=" * 72)
    print(f"Customers with docs : {stats['customers']}")
    print(f"Docs OCR'd          : {stats['docs']}  "
          f"(skipped existing: {stats['skipped_existing']})")
    print(f"OCR with data       : {stats['ocr_ok']}")
    print(f"OCR empty           : {stats['ocr_empty']}")
    print(f"Skipped local-only  : {stats['skipped_local']}  "
          f"(old /uploads paths with no cloud copy)")
    print(f"Errors              : {stats['errors']}")
    print(f"Written             : {stats['written']}"
          + ("" if args.commit else "  (dry run — pass --commit to write)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
