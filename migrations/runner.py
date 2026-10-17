"""
Tracked, ordered, idempotent Firestore data migrations (Phase 4).

Formalises the ad-hoc one-off scripts in scripts/ into a runner that records
what has run, so a migration is applied exactly once and re-running is safe.

    python -m migrations.runner --status    # what is applied / pending
    python -m migrations.runner             # DRY RUN: list pending, change nothing
    python -m migrations.runner --commit     # run pending migrations, in order

Writing a migration — copy migrations/_template.py to migrations/NNNN_slug.py:

    ID = "0001_slug"                         # unique, sortable; = the filename stem
    DESCRIPTION = "one line"
    def up(db) -> dict:                      # MUST be idempotent (safe to re-run)
        ...                                  # return stats, e.g. {"scanned": n, "changed": m}

Applied migrations are recorded in the `_migrations` collection (id, description,
applied_at, stats) only AFTER up() returns, so a failure leaves the migration
pending and the next run retries it — which is why up() must be idempotent.

Run against UAT (CIBARA_ENV=UAT) before production, and read §6.5 of CLAUDE.md.
"""
from __future__ import annotations

import argparse
import datetime
import importlib
import logging
import pkgutil
import sys
from dataclasses import dataclass
from typing import Any, Callable

log = logging.getLogger("migrations")

MIGRATIONS_COLLECTION = "_migrations"


@dataclass
class Migration:
    id: str
    description: str
    up: Callable[[Any], dict]


def discover() -> list[Migration]:
    """All migration modules (migrations/NNNN_*.py), sorted by id. Modules whose
    name does not start with a digit (e.g. _template, runner) are ignored."""
    import migrations as pkg

    found: list[Migration] = []
    for info in pkgutil.iter_modules(pkg.__path__):
        if not info.name[:1].isdigit():
            continue
        mod = importlib.import_module(f"migrations.{info.name}")
        if not hasattr(mod, "up"):
            continue
        found.append(Migration(getattr(mod, "ID", info.name),
                                getattr(mod, "DESCRIPTION", ""), mod.up))
    ids = [m.id for m in found]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise RuntimeError(f"duplicate migration ids: {sorted(dupes)}")
    found.sort(key=lambda m: m.id)
    return found


def applied_ids(db) -> set[str]:
    return {d.id for d in db.collection(MIGRATIONS_COLLECTION).stream()}


def pending(db, migrations: list[Migration] | None = None) -> list[Migration]:
    done = applied_ids(db)
    migs = migrations if migrations is not None else discover()
    migs = sorted(migs, key=lambda m: m.id)  # always apply in id order
    return [m for m in migs if m.id not in done]


def status(db, migrations: list[Migration] | None = None) -> dict:
    return {
        "applied": sorted(applied_ids(db)),
        "pending": [m.id for m in pending(db, migrations)],
    }


def run(db, *, commit: bool, migrations: list[Migration] | None = None) -> list[dict]:
    """Run (commit=True) or preview (commit=False) the pending migrations in
    order. Records each as applied only after its up() returns."""
    results: list[dict] = []
    for m in pending(db, migrations):
        if not commit:
            results.append({"id": m.id, "status": "pending", "description": m.description})
            continue
        log.info("applying migration %s — %s", m.id, m.description)
        stats = m.up(db) or {}
        db.collection(MIGRATIONS_COLLECTION).document(m.id).set({
            "id": m.id,
            "description": m.description,
            "applied_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "stats": stats,
        })
        results.append({"id": m.id, "status": "applied", "stats": stats})
    return results


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Run tracked Firestore migrations.")
    ap.add_argument("--commit", action="store_true", help="apply pending migrations (default: dry run)")
    ap.add_argument("--status", action="store_true", help="print applied/pending and exit")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    from config import db  # noqa: E402  (side effect: Firebase init)

    if args.status:
        st = status(db)
        print(f"applied ({len(st['applied'])}): {', '.join(st['applied']) or '-'}")
        print(f"pending ({len(st['pending'])}): {', '.join(st['pending']) or '-'}")
        return 0

    results = run(db, commit=args.commit)
    if not results:
        print("No pending migrations.")
        return 0
    for r in results:
        if r["status"] == "pending":
            print(f"PENDING  {r['id']}  {r.get('description', '')}")
        else:
            print(f"APPLIED  {r['id']}  {r.get('stats', {})}")
    if not args.commit:
        print("\nDry run — nothing changed. Re-run with --commit to apply.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
