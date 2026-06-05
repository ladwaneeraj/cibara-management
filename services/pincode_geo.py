"""
Offline PIN-code -> coordinate resolver for the footfall heatmap.

Loads a static lookup from the data/ directory (lazily, once) and resolves a
6-digit PIN code to {lat, lon, place, state}.

File precedence (first that exists wins as the BASE, then the full file is
merged on top so it overrides the seed):
    data/pincode_centroids.seed.json   – small bundled seed (city-level)
    data/pincode_centroids.json        – full dataset from build_pincode_geo.py

Design:
  • Pure stdlib, no network, no heavy deps — safe to import anywhere.
  • Fails soft: if no data file is present, resolve() returns None for every
    PIN and is_available() returns False, so the heatmap shows a hint instead
    of crashing.
  • Thread-safe lazy load guarded by a lock (analytics can be hit concurrently).
"""

from __future__ import annotations

import json
import logging
import os
import threading

logger = logging.getLogger(__name__)

_DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
_SEED_FILE = os.path.join(_DATA_DIR, "pincode_centroids.seed.json")
_FULL_FILE = os.path.join(_DATA_DIR, "pincode_centroids.json")

_lock = threading.Lock()
_index: dict | None = None   # None until loaded; {} means "loaded, empty"


def _load_file(path: str) -> dict:
    """Load one centroid file. Returns {} on any problem."""
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            payload = json.load(fh)
        data = payload.get("data", payload)  # tolerate a bare mapping too
        if not isinstance(data, dict):
            return {}
        # Keep only well-formed entries.
        clean = {}
        for pin, v in data.items():
            if (isinstance(pin, str) and len(pin) == 6 and pin.isdigit()
                    and isinstance(v, dict) and "lat" in v and "lon" in v):
                clean[pin] = v
        return clean
    except Exception as e:
        logger.warning("pincode_geo: failed to load %s: %s", path, e)
        return {}


def _ensure_loaded() -> dict:
    global _index
    if _index is not None:
        return _index
    with _lock:
        if _index is not None:        # double-checked locking
            return _index
        merged = _load_file(_SEED_FILE)
        full = _load_file(_FULL_FILE)
        if full:
            merged = {**merged, **full}   # full overrides seed
        _index = merged
        logger.info(
            "pincode_geo: loaded %d PIN centroids (seed=%s, full=%s)",
            len(_index), os.path.exists(_SEED_FILE), os.path.exists(_FULL_FILE),
        )
        return _index


def reload() -> None:
    """Force a reload on next access (e.g. after running the build script)."""
    global _index
    with _lock:
        _index = None


def is_available() -> bool:
    """True if at least one PIN centroid is loaded."""
    return bool(_ensure_loaded())


def coverage() -> int:
    """Number of PIN codes currently resolvable."""
    return len(_ensure_loaded())


def resolve(pincode: str) -> dict | None:
    """
    Resolve a 6-digit PIN code to {lat, lon, place, state}, or None if the PIN
    is malformed or not in the lookup.
    """
    if not pincode:
        return None
    pin = "".join(c for c in str(pincode) if c.isdigit())
    if len(pin) != 6:
        return None
    return _ensure_loaded().get(pin)
