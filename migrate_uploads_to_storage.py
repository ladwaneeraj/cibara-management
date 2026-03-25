"""
migrate_uploads_to_storage.py
─────────────────────────────
One-time migration: fetches every local /uploads/... URL stored in Firestore
from the live server, re-uploads it to Firebase Storage, and patches Firestore.

Run from your LOCAL machine (where service-account.json lives):

    pip install firebase-admin requests
    python migrate_uploads_to_storage.py

Safe to re-run: already-migrated https://firebasestorage... URLs are skipped.
"""

import os
import sys
import uuid
import urllib.parse

import requests   # pip install requests  (usually already installed)

# ── Configure these two values ──────────────────────────────────────────────
APP_BASE_URL = "https://lodge-management-117552649945.asia-south1.run.app"
# Path to your service-account.json  (default: same folder as this script)
SERVICE_ACCOUNT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                    "service-account.json")
# ─────────────────────────────────────────────────────────────────────────────

import firebase_admin
from firebase_admin import credentials, firestore, storage as _fb_storage

def _init_firebase():
    if not firebase_admin._apps:
        cred = credentials.Certificate(SERVICE_ACCOUNT_PATH)
        firebase_admin.initialize_app(cred, {
            "storageBucket": "cibara-software-61512.firebasestorage.app"
        })
    return firestore.client()


def _fetch_file(url: str) -> bytes | None:
    """Download a file from the live server. Returns bytes or None on failure."""
    full_url = APP_BASE_URL + url if url.startswith("/") else url
    try:
        r = requests.get(full_url, timeout=30)
        if r.status_code == 200:
            return r.content
        print(f"  ✗ HTTP {r.status_code} fetching {full_url}")
        return None
    except Exception as e:
        print(f"  ✗ Fetch error for {full_url}: {e}")
        return None


def _upload_to_storage(mobile: str, filename: str, image_bytes: bytes) -> str:
    """Upload bytes to Firebase Storage, return the download URL or '' on failure."""
    try:
        bucket = _fb_storage.bucket()
        blob_path      = f"customer_docs/{mobile}/{filename}"
        blob           = bucket.blob(blob_path)
        download_token = str(uuid.uuid4())
        blob.metadata  = {"firebaseStorageDownloadTokens": download_token}
        blob.upload_from_string(image_bytes, content_type="image/jpeg")

        encoded = urllib.parse.quote(blob_path, safe="")
        return (
            f"https://firebasestorage.googleapis.com/v0/b/"
            f"{bucket.name}/o/{encoded}"
            f"?alt=media&token={download_token}"
        )
    except Exception as e:
        print(f"  ✗ Storage upload failed: {e}")
        return ""


def migrate():
    print("=" * 64)
    print("  migrate_uploads_to_storage.py")
    print(f"  Fetching files from: {APP_BASE_URL}")
    print("=" * 64)

    db = _init_firebase()
    customers = list(db.collection("customers").stream())
    print(f"\nFound {len(customers)} customer documents\n")

    total_migrated = 0
    total_skipped  = 0
    total_failed   = 0

    for doc in customers:
        data   = doc.to_dict()
        mobile = data.get("mobile", doc.id)
        urls   = data.get("id_doc_urls") or []

        local_urls = [u for u in urls if u.startswith("/uploads/")]
        if not local_urls:
            continue

        print(f"Customer {mobile}  ({len(local_urls)} local URL(s) to migrate)")

        new_urls = list(urls)
        changed  = False

        for i, url in enumerate(urls):
            if not url.startswith("/uploads/"):
                print(f"  [{i+1}] already on Storage — skip")
                total_skipped += 1
                continue

            filename = os.path.basename(url)
            print(f"  [{i+1}] Downloading {filename} …", end="", flush=True)

            image_bytes = _fetch_file(url)
            if not image_bytes:
                print(" DOWNLOAD FAILED — keeping local URL")
                total_failed += 1
                continue

            print(f" {len(image_bytes)//1024}KB  →  uploading to Storage …", end="", flush=True)

            new_url = _upload_to_storage(mobile, filename, image_bytes)
            if not new_url:
                print(" UPLOAD FAILED — keeping local URL")
                total_failed += 1
                continue

            print(" OK")
            new_urls[i] = new_url
            total_migrated += 1
            changed = True

        if changed:
            doc.reference.update({"id_doc_urls": new_urls})
            print(f"  → Firestore updated\n")
        else:
            print()

    print("=" * 64)
    print(f"  Migrated : {total_migrated}")
    print(f"  Skipped  : {total_skipped}  (already on Firebase Storage)")
    print(f"  Failed   : {total_failed}   (left unchanged)")
    print("=" * 64)
    if total_failed:
        print("\n  Re-run the script to retry failed items.")


if __name__ == "__main__":
    migrate()
