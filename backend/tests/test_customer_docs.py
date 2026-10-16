"""
Guest ID documents: private storage, permissions, audit trail, soft delete,
legacy adoption, and regressions for the "documents go missing" bugs.
"""
from __future__ import annotations

import io
import time

import pytest
from PIL import Image

from tests.conftest import DB, F

M = "9876501234"
BASE = f"/api/v2/customers/{M}/id-docs"


def _jpeg(color=(200, 180, 160), size=(1200, 760), mark=0) -> bytes:
    img = Image.new("RGB", size, color)
    # a few dark "text" bars so images differ and compress like a document
    for i in range(6):
        for x in range(80, 900):
            for y in range(100 + i * 90 + mark, 112 + i * 90 + mark):
                img.putpixel((x, y), (20, 20, 20))
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=90)
    return out.getvalue()


def _upload(client, headers, data=None, side="front", source="auto_scan", context="checkin", room="204"):
    return client.post(BASE, headers=headers,
                       files={"file": ("scan.jpg", data or _jpeg(), "image/jpeg")},
                       data={"side": side, "source": source, "context": context, "room": room,
                             "scan": '{"detected": true, "enhance": "magic"}'})


def _records():
    return {p: d for p, d in DB._store.docs.items() if p.startswith(f"customers/{M}/id_docs/")}


def _objects():
    return F.FAKE_BUCKET._objects


def _audits(action):
    deadline = time.time() + 2
    while time.time() < deadline:
        rows = [d for p, d in DB._store.docs.items()
                if p.startswith("audit_logs/") and d.get("action") == action]
        if rows:
            return rows
        time.sleep(0.05)
    return []


# ─── capture ───────────────────────────────────────────────────────────────

def test_manager_capture_is_private_and_records_who(client, manager):
    r = _upload(client, manager)
    assert r.status_code == 200, r.text
    doc = r.json()["document"]
    assert doc["side"] == "front" and doc["status"] == "active" and doc["source"] == "auto_scan"
    assert doc["captured_by"]["userId"] == "manager1"
    assert doc["captured_by"]["role"] == "manager"
    assert doc["context"] == {"kind": "checkin", "room": "204"}
    assert doc["history"][0]["action"] == "captured"
    assert "path" not in doc and "sha256" not in doc  # no storage detail leaks

    (path, obj), = _objects().items()
    assert path.startswith(f"customer_docs/{M}/")
    assert "firebaseStorageDownloadTokens" not in (obj["metadata"] or {})
    # EXIF/metadata stripped and re-encoded
    assert Image.open(io.BytesIO(obj["data"])).format == "JPEG"

    cust = DB.collection("customers").document(M).get().to_dict()
    assert cust["id_doc_count"] == 1 and cust["has_id_docs"] is True
    assert cust["id_doc_urls"] == []  # never a public link
    assert _audits("customer_doc.capture")


def test_housekeeping_cannot_capture_or_view(client, staff, manager):
    assert _upload(client, staff).status_code == 403
    assert client.get(BASE, headers=staff).status_code == 403
    doc_id = _upload(client, manager).json()["document"]["id"]
    assert client.get(f"{BASE}/{doc_id}/image", headers=staff).status_code == 403


def test_anonymous_gets_nothing(client, manager):
    doc_id = _upload(client, manager).json()["document"]["id"]
    assert client.get(BASE).status_code == 401
    assert client.get(f"{BASE}/{doc_id}/image").status_code == 401


def test_rejects_non_images(client, manager):
    r = client.post(BASE, headers=manager, files={"file": ("x.jpg", b"not an image", "image/jpeg")})
    assert r.status_code == 400
    assert not _objects()


def test_duplicate_upload_returns_same_document(client, manager):
    data = _jpeg()
    a = _upload(client, manager, data).json()["document"]["id"]
    b = _upload(client, manager, data).json()["document"]["id"]
    assert a == b
    assert len(_objects()) == 1


def test_new_front_archives_old_front_never_deletes(client, manager):
    first = _upload(client, manager, _jpeg(mark=0)).json()["document"]["id"]
    back = _upload(client, manager, _jpeg(mark=5), side="back").json()["document"]["id"]
    second = _upload(client, manager, _jpeg(mark=9)).json()["document"]["id"]
    docs = {d["id"]: d for d in client.get(BASE, headers=manager).json()["documents"]}
    assert docs[first]["status"] == "archived"
    assert docs[second]["status"] == "active" and docs[back]["status"] == "active"
    assert docs[first]["history"][-1]["action"] == "archived"
    assert len(_objects()) == 3  # every file kept


# ─── viewing ───────────────────────────────────────────────────────────────

def test_view_is_watermarked_counted_and_audited(client, manager):
    doc_id = _upload(client, manager).json()["document"]["id"]
    original = next(iter(_objects().values()))["data"]

    r = client.get(f"{BASE}/{doc_id}/image", headers=manager)
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    assert "no-store" in r.headers["cache-control"]
    assert r.content != original  # watermark applied

    thumb = client.get(f"{BASE}/{doc_id}/image?variant=thumb", headers=manager)
    assert thumb.status_code == 200 and max(Image.open(io.BytesIO(thumb.content)).size) <= 360

    rec = DB.collection("customers").document(M).collection("id_docs").document(doc_id).get().to_dict()
    assert rec["views"] == 1  # thumbnails are not counted as views
    assert rec["last_viewed_by"]["userId"] == "manager1"
    assert _audits("customer_doc.view")


def test_original_download_is_admin_only(client, manager, admin):
    doc_id = _upload(client, manager).json()["document"]["id"]
    assert client.get(f"{BASE}/{doc_id}/image?variant=original", headers=manager).status_code == 403
    r = client.get(f"{BASE}/{doc_id}/image?variant=original", headers=admin)
    assert r.status_code == 200
    assert r.content == next(iter(_objects().values()))["data"]
    assert "attachment" in r.headers["content-disposition"]
    assert _audits("customer_doc.download")


def test_cannot_read_another_guests_file(client, manager):
    doc_id = _upload(client, manager).json()["document"]["id"]
    # a record under another mobile that points into M's folder is refused
    other = "9876509999"
    rec = dict(DB.collection("customers").document(M).collection("id_docs").document(doc_id).get().to_dict())
    DB.collection("customers").document(other).collection("id_docs").document(doc_id).set(rec)
    r = client.get(f"/api/v2/customers/{other}/id-docs/{doc_id}/image", headers=manager)
    assert r.status_code == 404


# ─── remove / restore ─────────────────────────────────────────────────────

def test_remove_is_soft_admin_only_and_restorable(client, manager, admin):
    doc_id = _upload(client, manager).json()["document"]["id"]
    assert client.post(f"{BASE}/{doc_id}/remove", headers=manager,
                       json={"reason": "blurry"}).status_code == 403
    r = client.post(f"{BASE}/{doc_id}/remove", headers=admin, json={"reason": "blurry photo"})
    assert r.status_code == 200 and r.json()["document"]["status"] == "removed"
    assert len(_objects()) == 1  # file kept
    assert client.get(BASE, headers=manager).json()["documents"] == []
    listed = client.get(BASE + "?include_removed=true", headers=admin).json()["documents"]
    assert listed[0]["status"] == "removed" and listed[0]["remove_reason"] == "blurry photo"
    assert DB.collection("customers").document(M).get().to_dict()["id_doc_count"] == 0

    r = client.post(f"{BASE}/{doc_id}/restore", headers=admin)
    assert r.json()["document"]["status"] == "active"
    actions = [h["action"] for h in r.json()["document"]["history"]]
    assert actions == ["captured", "removed", "restored"]
    assert DB.collection("customers").document(M).get().to_dict()["id_doc_count"] == 1


# ─── legacy photos ────────────────────────────────────────────────────────

def _legacy(n=1):
    urls = []
    for i in range(n):
        path = f"customer_docs/{M}/doc_old{i}.jpg"
        F.FAKE_BUCKET.blob(path).upload_from_string(_jpeg(mark=i), content_type="image/jpeg")
        enc = path.replace("/", "%2F")
        urls.append(f"https://firebasestorage.googleapis.com/v0/b/cibara-dev.firebasestorage.app/o/{enc}"
                    f"?alt=media&token=tok{i}")
    DB.collection("customers").document(M).set({"mobile": M, "name": "Old Guest",
                                                "id_doc_urls": urls, "total_stays": 3})
    return urls


def test_old_photos_are_adopted_not_lost(client, manager):
    urls = _legacy(2)
    docs = client.get(BASE, headers=manager).json()["documents"]
    assert len(docs) == 2 and all(d["legacy"] and d["status"] == "active" for d in docs)
    assert docs[0]["captured_by"]["name"] == "Before audit trail"
    # the old array and the files are untouched
    assert DB.collection("customers").document(M).get().to_dict()["id_doc_urls"] == urls
    assert len(_objects()) == 2
    r = client.get(f"{BASE}/{docs[0]['id']}/image", headers=manager)
    assert r.status_code == 200
    # adoption is idempotent
    assert len(client.get(BASE, headers=manager).json()["documents"]) == 2


def test_returning_guest_with_three_docs_keeps_new_scans(client, manager):
    """Bug 1: the old background 'trim to 3' deleted every new scan (and its
    file) for a guest who already had three documents on file."""
    _legacy(3)
    _upload(client, manager, _jpeg(mark=20))
    _upload(client, manager, _jpeg(mark=30), side="back")
    time.sleep(0.3)  # the old trim ran on a background thread
    assert len(_objects()) == 5
    docs = client.get(BASE, headers=manager).json()["documents"]
    assert len(docs) == 5
    assert DB.collection("customers").document(M).get().to_dict()["id_doc_count"] == 5


def test_checkin_upsert_cannot_wipe_a_parallel_upload(client, manager, monkeypatch):
    """Bug 2: a first-time guest's /checkin read 'no customer', the parallel
    ID upload then created the customer, and /checkin's set() replaced it."""
    from services import customer_service
    from tests.fakes import fake_firestore as FF

    real_get = FF.DocumentReference.get
    state = {"stale": True}

    def stale_get(self, *a, **kw):
        snap = real_get(self, *a, **kw)
        if self.path == f"customers/{M}" and state["stale"]:
            state["stale"] = False
            # simulate the upload landing right after this read
            _upload(client, manager)
            return FF.DocumentSnapshot(self, None)
        return snap

    monkeypatch.setattr(FF.DocumentReference, "get", stale_get)
    customer_service._upsert(M, {"name": "new guest", "mobile": M}, 1200)
    monkeypatch.setattr(FF.DocumentReference, "get", real_get)

    cust = DB.collection("customers").document(M).get().to_dict()
    assert cust["total_stays"] == 1 and cust["name"]
    assert cust["id_doc_count"] == 1
    assert len(_records()) == 1


# ─── legacy routes (older screens) ────────────────────────────────────────

def test_legacy_upload_route_is_private_and_permissioned(client, manager, staff):
    r = client.post("/upload_customer_document", headers=staff,
                    data={"mobile": M}, files={"document": ("a.jpg", _jpeg(), "image/jpeg")})
    assert r.status_code == 403
    r = client.post("/upload_customer_document", headers=manager,
                    data={"mobile": M, "context": "checkout"},
                    files={"document": ("a.jpg", _jpeg(), "image/jpeg")})
    body = r.json()
    assert body["success"], body
    assert body["url"].startswith(f"/api/v2/customers/{M}/id-docs/")
    assert "firebasestorage" not in body["url"]
    rec = next(iter(_records().values()))
    assert rec["captured_by"]["userId"] == "manager1" and rec["context"]["kind"] == "checkout"


def test_legacy_delete_route_is_soft(client, manager, admin):
    url = client.post("/upload_customer_document", headers=manager, data={"mobile": M},
                      files={"document": ("a.jpg", _jpeg(), "image/jpeg")}).json()["url"]
    r = client.post("/delete_customer_document", headers=admin, json={"mobile": M, "url": url})
    assert r.json()["success"] and r.json()["remaining"] == 0
    assert len(_objects()) == 1
    assert next(iter(_records().values()))["status"] == "removed"


def test_customer_payloads_carry_only_private_links(client, manager, staff):
    _legacy(1)
    r = client.get(f"/get_customer/{M}", headers=manager).json()["customer"]
    assert r["id_doc_count"] == 1
    (url,) = r["id_doc_urls"]
    assert url.startswith(f"/api/v2/customers/{M}/id-docs/legacy-") and url.endswith("/image")
    assert "token" not in url and "firebasestorage" not in url
    assert r["id_doc_meta"][0]["legacy"] is True
    assert client.get(url, headers=manager).status_code == 200
    assert client.get(url).status_code == 401
    # staff (housekeeping) get no links at all
    r = client.get(f"/get_customer/{M}", headers=staff).json()["customer"]
    assert r["id_doc_urls"] == []
    # search results never carry links
    r = client.post("/search_customers", headers=manager, json={"query": M}).json()
    assert all(c["id_doc_urls"] == [] for c in r["customers"])
    r = client.post("/batch_check_customer_docs", headers=manager, json={"mobiles": [M, "9000000000"]})
    assert r.json()["mobiles_with_docs"] == [M]


def test_repair_tokens_route_is_retired(client, manager, admin):
    assert client.post("/admin/repair_doc_tokens", headers=manager).status_code == 403
    assert client.post("/admin/repair_doc_tokens", headers=admin).status_code == 410


def test_unlabelled_photos_never_archive_each_other_until_the_limit(client, manager):
    for i in range(3):
        r = client.post("/upload_customer_document", headers=manager, data={"mobile": M},
                        files={"document": ("a.jpg", _jpeg(mark=i * 7), "image/jpeg")})
        assert r.json()["success"], r.text
    docs = client.get(BASE, headers=manager).json()["documents"]
    assert [d["status"] for d in docs] == ["active"] * 3
    assert {d["side"] for d in docs} == {"other"}
