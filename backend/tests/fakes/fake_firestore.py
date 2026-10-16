"""
In-memory stand-in for the parts of google-cloud-firestore the app uses.

Why this exists
───────────────
The Firestore emulator could not be downloaded in the build sandbox, and the
legacy suite's stubs (tests/conftest.py) return empty results for everything,
so they cannot exercise a full check-in → checkout → bill flow. This fake
implements the real semantics that flow depends on:

  • documents, sub-collections, auto ids
  • set / set(merge=True) / update (dotted paths) / create / delete
  • transforms: Increment, ArrayUnion, ArrayRemove, DELETE_FIELD, SERVER_TIMESTAMP
  • where (positional and FieldFilter), ==, !=, <, <=, >, >=, in, not-in,
    array_contains, array_contains_any; nested field paths; __name__
  • order_by (multi-key, direction), limit, limit_to_last, offset,
    start_after / start_at, select, count() aggregation
  • batches, transactions (+ the @transactional decorator), get_all,
    write_option(last_update_time=…) preconditions

It deliberately raises the same google.api_core exceptions the real client
raises (NotFound on update of a missing doc, Conflict on create of an existing
doc, FailedPrecondition on a stale update_time) so error paths behave the same.

It is a TEST tool only. It does not model indexes, so a query that would need
a composite index in production succeeds here — index requirements are checked
separately against firestore.indexes.json (see test_indexes.py).
"""
from __future__ import annotations

import copy
import datetime as _dt
import itertools
import threading
import uuid
from typing import Any, Iterable

from google.api_core import exceptions as gexc
from google.cloud.firestore_v1 import transforms as T

_DELETE = T.DELETE_FIELD
_SERVER_TS = T.SERVER_TIMESTAMP

ASCENDING = "ASCENDING"
DESCENDING = "DESCENDING"

_MISSING = object()

# Optional hooks (set by the test bootstrap) so per-request read/write counts
# work against the fake exactly as against the real client.
on_read = None
on_write = None


def _hook(fn, n):
    if fn is not None and n:
        fn(n)


# ─── value helpers ─────────────────────────────────────────────────────────

def _type_rank(v):
    """Firestore cross-type ordering (simplified, but stable)."""
    if v is None:
        return 0
    if isinstance(v, bool):
        return 1
    if isinstance(v, (int, float)):
        return 2
    if isinstance(v, _dt.datetime):
        return 3
    if isinstance(v, str):
        return 4
    if isinstance(v, bytes):
        return 5
    if isinstance(v, list):
        return 8
    if isinstance(v, dict):
        return 9
    return 7


def _sort_key(v):
    r = _type_rank(v)
    if r in (8, 9):
        return (r, repr(v))
    if isinstance(v, _dt.datetime) and v.tzinfo is None:
        v = v.replace(tzinfo=_dt.timezone.utc)
    return (r, v)


def _comparable(a, b) -> bool:
    return _type_rank(a) == _type_rank(b)


def _get_path(data: dict, path: str):
    cur: Any = data
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return _MISSING
        cur = cur[part]
    return cur


def _set_path(data: dict, path: str, value):
    parts = path.split(".")
    cur = data
    for part in parts[:-1]:
        nxt = cur.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[part] = nxt
        cur = nxt
    _apply_value(cur, parts[-1], value)


def _apply_value(container: dict, key: str, value):
    """Write `value` into container[key], resolving transforms/sentinels."""
    if value is _DELETE:
        container.pop(key, None)
        return
    if value is _SERVER_TS:
        container[key] = _dt.datetime.now(_dt.timezone.utc)
        return
    if isinstance(value, T.Increment):
        cur = container.get(key)
        inc = value.value
        if isinstance(cur, (int, float)) and not isinstance(cur, bool):
            container[key] = cur + inc
        else:
            container[key] = inc
        return
    if isinstance(value, T.ArrayUnion):
        cur = container.get(key)
        cur = list(cur) if isinstance(cur, list) else []
        for v in value.values:
            if v not in cur:
                cur.append(copy.deepcopy(v))
        container[key] = cur
        return
    if isinstance(value, T.ArrayRemove):
        cur = container.get(key)
        cur = list(cur) if isinstance(cur, list) else []
        container[key] = [x for x in cur if x not in value.values]
        return
    container[key] = _resolve(value)


def _resolve(value):
    """Deep-copy a plain value, resolving SERVER_TIMESTAMP inside maps/lists."""
    if value is _SERVER_TS:
        return _dt.datetime.now(_dt.timezone.utc)
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            if v is _DELETE:
                continue
            _apply_value(out, k, v)
        return out
    if isinstance(value, (list, tuple)):
        return [_resolve(v) for v in value]
    return copy.deepcopy(value)


def _deep_merge(dst: dict, src: dict):
    for k, v in src.items():
        if isinstance(v, dict) and not _is_transform(v) and isinstance(dst.get(k), dict):
            _deep_merge(dst[k], v)
        else:
            _apply_value(dst, k, v)


def _is_transform(v):
    return isinstance(v, (T.Increment, T.ArrayUnion, T.ArrayRemove)) or v is _DELETE or v is _SERVER_TS


# ─── store ─────────────────────────────────────────────────────────────────

class _Store:
    def __init__(self):
        self.docs: dict[str, dict] = {}
        self.meta: dict[str, dict] = {}
        self.lock = threading.RLock()
        self._clock = itertools.count(1)
        self.read_count = 0
        self.write_count = 0

    def tick(self):
        base = _dt.datetime(2026, 1, 1, tzinfo=_dt.timezone.utc)
        return base + _dt.timedelta(microseconds=next(self._clock))


# ─── snapshots / refs ──────────────────────────────────────────────────────

class DocumentSnapshot:
    def __init__(self, ref, data, update_time=None, create_time=None, field_paths=None):
        self.reference = ref
        self._data = data
        self.update_time = update_time
        self.create_time = create_time
        self.read_time = update_time
        self._field_paths = field_paths

    @property
    def id(self):
        return self.reference.id

    @property
    def exists(self):
        return self._data is not None

    def to_dict(self):
        if self._data is None:
            return None
        d = copy.deepcopy(self._data)
        if self._field_paths:
            out: dict = {}
            for fp in self._field_paths:
                v = _get_path(d, fp)
                if v is not _MISSING:
                    _set_path(out, fp, v)
            return out
        return d

    def get(self, field_path):
        if self._data is None:
            return None
        v = _get_path(self._data, field_path)
        if v is _MISSING:
            raise KeyError(field_path)
        return copy.deepcopy(v)

    def __repr__(self):
        return f"<FakeSnapshot {self.reference.path} exists={self.exists}>"


class DocumentReference:
    def __init__(self, client: "FakeClient", path: str):
        self._client = client
        self.path = path

    @property
    def id(self):
        return self.path.rsplit("/", 1)[-1]

    @property
    def parent(self):
        return CollectionReference(self._client, self.path.rsplit("/", 1)[0])

    def collection(self, name):
        return CollectionReference(self._client, f"{self.path}/{name}")

    def __eq__(self, other):
        return isinstance(other, DocumentReference) and other.path == self.path

    def __hash__(self):
        return hash(self.path)

    # reads
    def get(self, field_paths=None, transaction=None, **_kw):
        st = self._client._store
        with st.lock:
            st.read_count += 1
            _hook(on_read, 1)
            data = st.docs.get(self.path)
            meta = st.meta.get(self.path, {})
            return DocumentSnapshot(self, copy.deepcopy(data) if data is not None else None,
                                    meta.get("update_time"), meta.get("create_time"),
                                    field_paths)

    # writes (applied immediately)
    def set(self, document_data, merge=False, **_kw):
        self._client._apply([("set", self, document_data, {"merge": merge})])
        return _WriteResult(self._client._store.tick())

    def create(self, document_data, **_kw):
        self._client._apply([("create", self, document_data, {})])
        return _WriteResult(self._client._store.tick())

    def update(self, field_updates, option=None, **_kw):
        self._client._apply([("update", self, field_updates, {"option": option})])
        return _WriteResult(self._client._store.tick())

    def delete(self, option=None, **_kw):
        self._client._apply([("delete", self, None, {"option": option})])
        return _WriteResult(self._client._store.tick())

    def collections(self):
        prefix = self.path + "/"
        names = set()
        for p in list(self._client._store.docs):
            if p.startswith(prefix):
                rest = p[len(prefix):].split("/")
                if len(rest) >= 2:
                    names.add(rest[0])
        return [self.collection(n) for n in sorted(names)]


class _WriteResult:
    def __init__(self, t):
        self.update_time = t


class _LastUpdateOption:
    def __init__(self, last_update_time):
        self.last_update_time = last_update_time


class _ExistsOption:
    def __init__(self, exists):
        self.exists = exists


# ─── queries ───────────────────────────────────────────────────────────────

class Query:
    def __init__(self, client, coll_path, filters=None, orders=None, limit=None,
                 limit_to_last=False, offset=0, start=None, select=None, all_descendants=False):
        self._client = client
        self._coll_path = coll_path
        self._filters = list(filters or [])
        self._orders = list(orders or [])
        self._limit = limit
        self._limit_to_last = limit_to_last
        self._offset = offset
        self._start = start
        self._select = select
        self._all_desc = all_descendants

    def _copy(self, **kw):
        args = dict(filters=self._filters, orders=self._orders, limit=self._limit,
                    limit_to_last=self._limit_to_last, offset=self._offset,
                    start=self._start, select=self._select, all_descendants=self._all_desc)
        args.update(kw)
        return Query(self._client, self._coll_path, **args)

    def where(self, field_path=None, op_string=None, value=None, *, filter=None):
        if filter is not None:
            return self._copy(filters=self._filters + [_compile_filter(filter)])
        return self._copy(filters=self._filters + [(field_path, op_string, value)])

    def order_by(self, field_path, direction=ASCENDING):
        d = direction if isinstance(direction, str) else str(direction)
        d = DESCENDING if "DESC" in d.upper() else ASCENDING
        return self._copy(orders=self._orders + [(field_path, d)])

    def limit(self, count):
        return self._copy(limit=count, limit_to_last=False)

    def limit_to_last(self, count):
        return self._copy(limit=count, limit_to_last=True)

    def offset(self, num):
        return self._copy(offset=num)

    def select(self, field_paths):
        return self._copy(select=list(field_paths))

    def start_after(self, doc_or_values):
        return self._copy(start=("after", doc_or_values))

    def start_at(self, doc_or_values):
        return self._copy(start=("at", doc_or_values))

    def count(self, alias=None):
        return _CountQuery(self)

    # execution
    def _candidates(self):
        st = self._client._store
        out = []
        depth = self._coll_path.count("/") + 2
        for path, data in st.docs.items():
            parent, _, _ = path.rpartition("/")
            if self._all_desc:
                if parent.rsplit("/", 1)[-1] != self._coll_path:
                    continue
            elif parent != self._coll_path or path.count("/") + 1 != depth:
                continue
            out.append((path, data))
        return out

    def _run(self):
        st = self._client._store
        with st.lock:
            rows = []
            for path, data in self._candidates():
                ref = DocumentReference(self._client, path)
                if all(_match(ref, data, f) for f in self._filters):
                    rows.append((ref, data))
            # Firestore: an order_by (or inequality) on a field excludes docs missing it.
            order_fields = [f for f, _ in self._orders]
            for fp, op, _v in self._filters:
                if op in ("<", "<=", ">", ">=", "!=", "not-in") and fp not in order_fields and fp != "__name__":
                    order_fields.insert(0, fp)
                    self_orders = [(fp, ASCENDING)] + self._orders
                    break
            else:
                self_orders = list(self._orders)
            rows = [(r, d) for r, d in rows
                    if all(f == "__name__" or _get_path(d, f) is not _MISSING for f in order_fields)]
            # Implicit __name__ ordering follows the direction of the last order_by.
            rows.sort(key=lambda rd: rd[0].id,
                      reverse=bool(self_orders) and self_orders[-1][1] == DESCENDING)
            for fp, direction in reversed(self_orders):
                rows.sort(key=lambda rd: _sort_key(rd[0].id if fp == "__name__" else _get_path(rd[1], fp)),
                          reverse=(direction == DESCENDING))
            if self._start is not None:
                kind, cursor = self._start
                rows = _apply_cursor(rows, self_orders, kind, cursor)
            if self._offset:
                rows = rows[self._offset:]
            if self._limit is not None:
                rows = rows[-self._limit:] if self._limit_to_last else rows[: self._limit]
            st.read_count += max(1, len(rows))
            _hook(on_read, max(1, len(rows)))
            snaps = []
            for ref, data in rows:
                meta = st.meta.get(ref.path, {})
                snaps.append(DocumentSnapshot(ref, copy.deepcopy(data), meta.get("update_time"),
                                              meta.get("create_time"), self._select))
            return snaps

    def stream(self, transaction=None, **_kw):
        return iter(self._run())

    def get(self, transaction=None, **_kw):
        return self._run()


def _compile_filter(f):
    # google.cloud.firestore_v1.base_query.FieldFilter or a test double
    fp = getattr(f, "field_path", None)
    op = getattr(f, "op_string", None)
    val = getattr(f, "value", None)
    if fp is None and hasattr(f, "args"):
        fp, op, val = f.args
    return (fp, op, val)


def _match(ref, data, flt):
    fp, op, val = flt
    if fp == "__name__":
        cur = ref.id
        if isinstance(val, DocumentReference):
            val = val.id
        elif isinstance(val, str) and "/" in val:
            val = val.rsplit("/", 1)[-1]
        elif isinstance(val, (list, tuple)):
            val = [v.id if isinstance(v, DocumentReference) else v for v in val]
    else:
        cur = _get_path(data, fp)
    if op == "==":
        return cur is not _MISSING and _comparable(cur, val) and cur == val
    if op == "!=":
        return cur is not _MISSING and cur is not None and cur != val
    if op in ("<", "<=", ">", ">="):
        if cur is _MISSING or not _comparable(cur, val):
            return False
        a, b = _sort_key(cur), _sort_key(val)
        return {"<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op]
    if op == "in":
        return cur is not _MISSING and any(_comparable(cur, v) and cur == v for v in val)
    if op == "not-in":
        return cur is not _MISSING and cur is not None and cur not in val
    if op == "array_contains":
        return isinstance(cur, list) and val in cur
    if op == "array_contains_any":
        return isinstance(cur, list) and any(v in cur for v in val)
    raise ValueError(f"fake firestore: unsupported operator {op!r}")


def _apply_cursor(rows, orders, kind, cursor):
    if isinstance(cursor, DocumentSnapshot):
        if orders:
            values = [cursor.reference.id if f == "__name__" else _get_path(cursor._data or {}, f)
                      for f, _ in orders]
        else:
            values = [cursor.reference.id]
            orders = [("__name__", ASCENDING)]
    elif isinstance(cursor, dict):
        values = [cursor.get(f) for f, _ in orders]
    else:
        values = list(cursor)
    out = []
    for ref, data in rows:
        key = []
        for (f, d), v in zip(orders, values):
            cur = ref.id if f == "__name__" else _get_path(data, f)
            a, b = _sort_key(cur), _sort_key(v)
            key.append((a > b) - (a < b) if d == ASCENDING else (b > a) - (b < a))
        cmp = next((k for k in key if k), 0)
        if (kind == "after" and cmp > 0) or (kind == "at" and cmp >= 0):
            out.append((ref, data))
    return out


class _AggResult:
    def __init__(self, value, alias="count"):
        self.value = value
        self.alias = alias


class _CountQuery:
    def __init__(self, q):
        self._q = q

    def get(self, **_kw):
        return [[_AggResult(len(self._q._run()))]]

    def stream(self, **_kw):
        return iter(self.get())


class CollectionReference(Query):
    def __init__(self, client, path):
        super().__init__(client, path)
        self.path = path

    @property
    def id(self):
        return self.path.rsplit("/", 1)[-1]

    @property
    def parent(self):
        if "/" not in self.path:
            return None
        return DocumentReference(self._client, self.path.rsplit("/", 1)[0])

    def document(self, document_id=None):
        if document_id is None:
            document_id = uuid.uuid4().hex[:20]
        return DocumentReference(self._client, f"{self.path}/{document_id}")

    def add(self, document_data, document_id=None):
        ref = self.document(document_id)
        wr = ref.create(document_data)
        return wr.update_time, ref

    def list_documents(self, **_kw):
        return [DocumentReference(self._client, p) for p, _ in self._candidates()]


# ─── batches & transactions ────────────────────────────────────────────────

class WriteBatch:
    def __init__(self, client):
        self._client = client
        self._ops = []

    def set(self, ref, data, merge=False, **_kw):
        self._ops.append(("set", ref, data, {"merge": merge}))
        return self

    def create(self, ref, data, **_kw):
        self._ops.append(("create", ref, data, {}))
        return self

    def update(self, ref, data, option=None, **_kw):
        self._ops.append(("update", ref, data, {"option": option}))
        return self

    def delete(self, ref, option=None, **_kw):
        self._ops.append(("delete", ref, None, {"option": option}))
        return self

    def commit(self, **_kw):
        ops, self._ops = self._ops, []
        self._client._apply(ops)
        t = self._client._store.tick()
        return [_WriteResult(t) for _ in ops]

    def __len__(self):
        return len(self._ops)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, *_):
        if exc_type is None:
            self.commit()


class Transaction(WriteBatch):
    def __init__(self, client):
        super().__init__(client)
        self._id = uuid.uuid4().bytes
        self.in_progress = True
        self._max_attempts = 5
        self._read_only = False

    def get(self, ref_or_query, **_kw):
        if isinstance(ref_or_query, DocumentReference):
            return ref_or_query.get()
        return ref_or_query.stream()

    def get_all(self, refs, **_kw):
        return self._client.get_all(refs)


def transactional(fn):
    """Fake @firestore.transactional: run once, commit buffered writes atomically."""
    def wrapper(transaction, *args, **kwargs):
        store = transaction._client._store
        with store.lock:
            result = fn(transaction, *args, **kwargs)
            transaction.commit()
            transaction.in_progress = False
            return result
    wrapper.__wrapped__ = fn
    return wrapper


# ─── client ────────────────────────────────────────────────────────────────

class FakeClient:
    def __init__(self, project="cibara-dev"):
        self.project = project
        self._store = _Store()

    # navigation
    def collection(self, *path):
        return CollectionReference(self, "/".join(path))

    def document(self, *path):
        return DocumentReference(self, "/".join(path))

    def collection_group(self, collection_id):
        return Query(self, collection_id, all_descendants=True)

    def collections(self):
        names = {p.split("/", 1)[0] for p in self._store.docs}
        return [self.collection(n) for n in sorted(names)]

    def batch(self):
        return WriteBatch(self)

    def transaction(self, **_kw):
        return Transaction(self)

    def bulk_writer(self, **_kw):
        return WriteBatch(self)

    def get_all(self, references: Iterable, field_paths=None, transaction=None, **_kw):
        for ref in references:
            yield ref.get(field_paths=field_paths)

    @staticmethod
    def write_option(**kwargs):
        if "last_update_time" in kwargs:
            return _LastUpdateOption(kwargs["last_update_time"])
        if "exists" in kwargs:
            return _ExistsOption(kwargs["exists"])
        raise TypeError(kwargs)

    # test helpers
    def reset(self):
        with self._store.lock:
            self._store.docs.clear()
            self._store.meta.clear()
            self._store.read_count = 0
            self._store.write_count = 0

    def dump(self, collection: str) -> dict:
        prefix = collection + "/"
        return {p[len(prefix):]: copy.deepcopy(d) for p, d in self._store.docs.items()
                if p.startswith(prefix) and "/" not in p[len(prefix):]}

    # write engine — all-or-nothing
    def _apply(self, ops):
        st = self._store
        with st.lock:
            staged_docs = dict(st.docs)
            staged_meta = dict(st.meta)
            t = st.tick()
            for kind, ref, data, opts in ops:
                path = ref.path
                cur = staged_docs.get(path)
                opt = opts.get("option")
                if isinstance(opt, _LastUpdateOption):
                    have = staged_meta.get(path, {}).get("update_time")
                    if cur is None or have != opt.last_update_time:
                        raise gexc.FailedPrecondition(f"stale update_time for {path}")
                if kind == "create":
                    if cur is not None:
                        raise gexc.Conflict(f"Document already exists: {path}")
                    staged_docs[path] = _resolve(data)
                    staged_meta[path] = {"create_time": t, "update_time": t}
                elif kind == "set":
                    if opts.get("merge"):
                        new = copy.deepcopy(cur) if cur is not None else {}
                        _deep_merge(new, data)
                    else:
                        new = _resolve(data)
                    staged_docs[path] = new
                    m = dict(staged_meta.get(path, {}))
                    m.setdefault("create_time", t)
                    m["update_time"] = t
                    staged_meta[path] = m
                elif kind == "update":
                    if cur is None:
                        raise gexc.NotFound(f"No document to update: {path}")
                    new = copy.deepcopy(cur)
                    for k, v in data.items():
                        key = k if isinstance(k, str) else ".".join(k)
                        _set_path(new, key, v)
                    staged_docs[path] = new
                    m = dict(staged_meta.get(path, {}))
                    m["update_time"] = t
                    staged_meta[path] = m
                elif kind == "delete":
                    staged_docs.pop(path, None)
                    staged_meta.pop(path, None)
                st.write_count += 1
                _hook(on_write, 1)
            st.docs = staged_docs
            st.meta = staged_meta
