"""services/room_photos.store(): the photo and its thumbnail are uploaded
concurrently now — assert both objects land, both URLs come back, and an error
on either upload still propagates (the thumb's after the join)."""
import pytest

from tests.fakes import fake_firebase as F
from services import room_photos


@pytest.fixture
def bucket(monkeypatch):
    b = F.FakeBucket()
    monkeypatch.setattr(room_photos, "_bucket", lambda: b)
    # prune() runs in a daemon thread against the same fake bucket; harmless.
    return b


def test_store_uploads_photo_and_thumb(bucket):
    out = room_photos.store(204, "bed", b"photo-bytes", {"userId": "u1", "name": "Asha"},
                            context="inspection", thumb_bytes=b"thumb-bytes")
    assert out["url"] and out["thumb"]
    names = list(bucket._objects)
    assert any(n.endswith("_inspection_bed.jpg") for n in names)
    assert any(n.endswith("_inspection_bed_t.jpg") for n in names)
    assert bucket._objects[[n for n in names if n.endswith("_bed.jpg")][0]]["data"] == b"photo-bytes"


def test_store_without_thumb(bucket):
    out = room_photos.store(204, "bed", b"photo-bytes", context="inspection")
    assert out["url"] and out["thumb"] == ""
    assert not any(n.endswith("_t.jpg") for n in bucket._objects)


def test_thumb_upload_error_propagates(bucket, monkeypatch):
    real_put = room_photos._put

    def _put(b, path, data, meta):
        if path.endswith("_t.jpg"):
            raise RuntimeError("thumb upload boom")
        return real_put(b, path, data, meta)

    monkeypatch.setattr(room_photos, "_put", _put)
    with pytest.raises(RuntimeError, match="thumb upload boom"):
        room_photos.store(204, "bed", b"photo-bytes", context="inspection",
                          thumb_bytes=b"thumb-bytes")
