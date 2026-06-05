"""
Build the full offline PIN-code -> coordinate lookup used by the footfall
heatmap.

Generates  data/pincode_centroids.json  containing every Indian PIN code with
its latitude / longitude / place / state. Once this file exists it OVERRIDES
the small bundled seed (data/pincode_centroids.seed.json), giving the heatmap
locality-level precision instead of city-level approximations.

Run this on a machine WITH internet (it downloads the public GeoNames postal
dataset once). The app itself stays fully offline afterwards — it only reads
the generated JSON.

    pip install pgeocode
    python -m scripts.build_pincode_geo

Re-run any time to refresh (e.g. when new PIN codes are introduced).

Data source: GeoNames (https://www.geonames.org/), CC BY 4.0.
"""

from __future__ import annotations

import json
import math
import os
import sys

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
OUT_FILE = os.path.join(OUT_DIR, "pincode_centroids.json")


def main() -> int:
    try:
        import pgeocode
    except ImportError:
        print("ERROR: pgeocode is not installed.  Run:  pip install pgeocode")
        return 2

    print("Downloading + loading GeoNames postal data for India (one-time)…")
    try:
        nomi = pgeocode.Nominatim("IN")
        df = nomi._data  # the full postal dataframe
    except Exception as e:
        print(f"ERROR: could not load GeoNames data: {e}")
        print("Check your internet connection and try again.")
        return 3

    os.makedirs(OUT_DIR, exist_ok=True)

    out = {}
    skipped = 0
    for _, row in df.iterrows():
        pin = str(row.get("postal_code") or "").strip()
        lat = row.get("latitude")
        lon = row.get("longitude")
        # Skip rows without a clean 6-digit PIN or without coordinates.
        if len(pin) != 6 or not pin.isdigit():
            skipped += 1
            continue
        try:
            lat = float(lat)
            lon = float(lon)
        except (TypeError, ValueError):
            skipped += 1
            continue
        if math.isnan(lat) or math.isnan(lon):
            skipped += 1
            continue
        # A PIN code can map to several post offices; keep the first and round
        # to 4 decimals (~11 m) to keep the file small.
        if pin in out:
            continue
        out[pin] = {
            "lat": round(lat, 4),
            "lon": round(lon, 4),
            "place": str(row.get("place_name") or "").strip(),
            "state": str(row.get("state_name") or "").strip(),
        }

    payload = {
        "_about": "Full India PIN-code -> coordinate lookup generated from "
                  "GeoNames by scripts/build_pincode_geo.py. Overrides the seed.",
        "data": out,
    }
    with open(OUT_FILE, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))

    size_mb = os.path.getsize(OUT_FILE) / (1024 * 1024)
    print(f"Wrote {len(out):,} PIN codes to {OUT_FILE} ({size_mb:.1f} MB).")
    print(f"Skipped {skipped:,} rows (no 6-digit PIN or no coordinates).")
    print("Restart the app (or wait for the geo cache TTL) to pick up the new file.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
