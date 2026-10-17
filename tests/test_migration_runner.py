"""Phase 4 migration runner: ordering, dry-run vs commit, idempotent tracking.
Uses a tiny self-contained fake db (the runner only needs collection().stream()
and document().set()) so it is independent of the Firestore fakes."""
from migrations.runner import Migration, pending, run, status


class _Doc:
    def __init__(self, id, data):
        self.id = id
        self._d = data

    def to_dict(self):
        return self._d


class _Coll:
    def __init__(self, store):
        self._s = store

    def stream(self):
        return [_Doc(k, v) for k, v in self._s.items()]

    def document(self, doc_id):
        store = self._s

        class _Ref:
            def set(self, data):
                store[doc_id] = data

        return _Ref()


class _DB:
    def __init__(self):
        self._colls = {}

    def collection(self, name):
        return _Coll(self._colls.setdefault(name, {}))


def _migs(log):
    return [
        Migration("0002_b", "second", lambda db: log.append("0002") or {"n": 2}),
        Migration("0001_a", "first", lambda db: log.append("0001") or {"n": 1}),
    ]


def test_dry_run_changes_nothing():
    db = _DB()
    log = []
    res = run(db, commit=False, migrations=_migs(log))
    assert [r["id"] for r in res] == ["0001_a", "0002_b"]   # sorted by id
    assert all(r["status"] == "pending" for r in res)
    assert log == []                                        # no up() called
    assert db._colls.get("_migrations", {}) == {}           # nothing recorded


def test_commit_runs_in_order_and_records():
    db = _DB()
    log = []
    res = run(db, commit=True, migrations=_migs(log))
    assert log == ["0001", "0002"]                          # ran in id order
    assert [r["id"] for r in res] == ["0001_a", "0002_b"]
    recorded = db._colls["_migrations"]
    assert set(recorded) == {"0001_a", "0002_b"}
    assert recorded["0001_a"]["stats"] == {"n": 1}
    assert "applied_at" in recorded["0001_a"]


def test_rerun_skips_applied():
    db = _DB()
    log = []
    run(db, commit=True, migrations=_migs(log))
    log.clear()
    # add a third migration; only it should run on the second pass
    migs = _migs(log) + [Migration("0003_c", "third", lambda db: log.append("0003") or {})]
    assert [m.id for m in pending(db, migs)] == ["0003_c"]
    run(db, commit=True, migrations=migs)
    assert log == ["0003"]                                  # 0001/0002 skipped


def test_status_reports_applied_and_pending():
    db = _DB()
    log = []
    migs = _migs(log)
    run(db, commit=True, migrations=[migs[1]])              # apply only 0001_a
    st = status(db, migs)
    assert st["applied"] == ["0001_a"]
    assert st["pending"] == ["0002_b"]
