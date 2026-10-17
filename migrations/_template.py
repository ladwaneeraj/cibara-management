"""
Migration template — copy to migrations/NNNN_slug.py (NNNN sortable, e.g. 0001).

Rules:
  * up(db) MUST be idempotent — the runner records a migration as applied only
    after up() returns, so a crash mid-way means it runs again. Guard every
    write so re-running is a no-op (skip already-migrated docs).
  * Never delete or alter money/tax records (bills, credit notes, settlements,
    folios, GST figures). Those are preserved logic; a data fix to them is an
    owner decision with its own test.
  * Read §6.5 of CLAUDE.md. Test on UAT (CIBARA_ENV=UAT) before production.

This file starts with "_" so the runner's discovery ignores it.
"""
from __future__ import annotations

ID = "0000_template"
DESCRIPTION = "template — do not run"


def up(db) -> dict:
    scanned = 0
    changed = 0
    # for doc in db.collection("...").stream():
    #     scanned += 1
    #     data = doc.to_dict()
    #     if _already_migrated(data):
    #         continue
    #     doc.reference.update({...})
    #     changed += 1
    return {"scanned": scanned, "changed": changed}
