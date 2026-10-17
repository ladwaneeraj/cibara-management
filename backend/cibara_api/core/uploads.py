"""
Upload content sniffing (Phase 4) — trust the BYTES, not the client-declared
content-type.

The stored-image paths already re-encode through Pillow
(services/id_docs.py, routers/invoice_settings.py), which is the real malware
defence for images: it rejects anything that isn't a decodable image and
strips polyglot/metadata payloads. This helper guards the paths that only
checked the declared content-type, by matching the file's magic bytes.

Deeper scanning of the PDF ingest paths (ClamAV / a GCS malware-scan function)
is infra — see the CLAUDE.md §6.5 runbook.
"""
from __future__ import annotations

# (mime, magic-byte prefix)
_SIGNATURES: list[tuple[str, bytes]] = [
    ("image/jpeg", b"\xff\xd8\xff"),
    ("image/png", b"\x89PNG\r\n\x1a\n"),
    ("image/gif", b"GIF87a"),
    ("image/gif", b"GIF89a"),
    ("application/pdf", b"%PDF-"),
]

IMAGE_TYPES = ("image/jpeg", "image/png", "image/webp")


def sniff(data: bytes) -> str | None:
    """Detected content-type from the leading bytes, or None if unrecognised."""
    for mime, sig in _SIGNATURES:
        if data[: len(sig)] == sig:
            return mime
    # WebP: "RIFF" .... "WEBP"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def validate_image_upload(data: bytes, *, max_bytes: int,
                          allowed: tuple[str, ...] = IMAGE_TYPES) -> tuple[bool, str, str]:
    """Returns (ok, detected_mime, error_message). Checks the size and the real
    magic bytes — a spoofed Content-Type does not pass."""
    if not data:
        return False, "", "Empty upload."
    if len(data) > max_bytes:
        return False, "", f"File too large (max {max_bytes // (1024 * 1024)} MB)."
    mime = sniff(data)
    if mime is None or mime not in allowed:
        return False, mime or "", "Unsupported file type — a valid image is required."
    return True, mime, ""
