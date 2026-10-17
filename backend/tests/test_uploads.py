"""Phase 4: upload content sniffing — magic bytes beat a spoofed Content-Type."""
from cibara_api.core import uploads


def test_sniff_detects_by_magic_bytes():
    assert uploads.sniff(b"\xff\xd8\xff\xe0JFIF") == "image/jpeg"
    assert uploads.sniff(b"\x89PNG\r\n\x1a\n...") == "image/png"
    assert uploads.sniff(b"%PDF-1.7\n...") == "application/pdf"
    assert uploads.sniff(b"GIF89a....") == "image/gif"
    assert uploads.sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "image/webp"
    assert uploads.sniff(b"<html>not an image</html>") is None
    assert uploads.sniff(b"") is None


def test_validate_image_upload_accepts_real_image():
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 200
    ok, mime, err = uploads.validate_image_upload(png, max_bytes=10_000)
    assert ok is True
    assert mime == "image/png"
    assert err == ""


def test_validate_image_upload_rejects_spoofed_and_wrong_types():
    # bytes are text even if the caller claimed image/jpeg
    ok, mime, err = uploads.validate_image_upload(b"<script>alert(1)</script>", max_bytes=10_000)
    assert ok is False and err

    # a real PDF is not an allowed image type
    ok, _, _ = uploads.validate_image_upload(b"%PDF-1.7 payload", max_bytes=10_000)
    assert ok is False

    # too large / empty
    big_png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 50
    ok, _, err = uploads.validate_image_upload(big_png, max_bytes=10)
    assert ok is False and "too large" in err.lower()
    ok, _, _ = uploads.validate_image_upload(b"", max_bytes=10_000)
    assert ok is False
