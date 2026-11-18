"""Database access. `D1` talks to Cloudflare D1 over its REST API; `SqliteDB` runs the same
SQL on a local SQLite file or in memory (used by the tests). Both have the same two methods:

    query(sql, params)          -> list of row dicts for one statement
    batch([(sql, params), ...]) -> list of row-dict lists, one per statement

REST API checked 2026-11-13 (developers.cloudflare.com/api/resources/d1/.../query):
body is {"sql", "params"} or {"batch": [{"sql", "params"}, ...]}; result is one
QueryResult {results, meta, success} per statement. Limits: 100 bound parameters per
statement, 100 KB per statement, the whole call must finish within 30 s.
"""
from __future__ import annotations

import re
import sqlite3
import time
from pathlib import Path
from typing import Iterable, Sequence

import requests

MAX_PARAMS = 100
API = "https://api.cloudflare.com/client/v4"

Statement = tuple[str, Sequence]


class D1Error(Exception):
    pass


class D1:
    def __init__(self, account_id: str, database_id: str, token: str, *,
                 timeout: float = 40, session: requests.Session | None = None):
        self.url = f"{API}/accounts/{account_id}/d1/database/{database_id}/query"
        self.session = session or requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {token}"})
        self.timeout = timeout
        self.calls = 0          # REST calls made (for stats)
        self.rows_written = 0
        self.rows_read = 0
        self.profile: dict[str, list[int]] = {}   # Step 17: statement shape -> [runs, rows read]

    def _note(self, sql: str, rows_read: int) -> None:
        entry = self.profile.setdefault(profile_key(sql), [0, 0])
        entry[0] += 1
        entry[1] += rows_read

    def top_reads(self, n: int = 12) -> list[tuple[str, int, int]]:
        """The statement shapes that read the most rows: (shape, times run, rows read)."""
        rows = sorted(self.profile.items(), key=lambda kv: -kv[1][1])[:n]
        return [(k, v[0], v[1]) for k, v in rows]

    def _post(self, body: dict) -> list[dict]:
        last = None
        for attempt in range(3):
            try:
                resp = self.session.post(self.url, json=body, timeout=self.timeout)
            except requests.RequestException as exc:
                last = f"network error {type(exc).__name__}"
            else:
                self.calls += 1
                if resp.status_code < 500 and resp.status_code != 429:
                    data = resp.json()
                    if not data.get("success"):
                        msg = "; ".join(e.get("message", str(e)) for e in data.get("errors") or [])
                        raise D1Error(f"D1 HTTP {resp.status_code}: {msg or resp.text[:300]}")
                    results = data["result"]
                    sqls = [b["sql"] for b in body["batch"]] if "batch" in body else [body["sql"]]
                    for i, r in enumerate(results):
                        meta = r.get("meta") or {}
                        self.rows_written += meta.get("rows_written") or 0
                        self.rows_read += meta.get("rows_read") or 0
                        self._note(sqls[min(i, len(sqls) - 1)], meta.get("rows_read") or 0)
                    return results
                last = f"HTTP {resp.status_code}: {resp.text[:200]}"
            time.sleep(2 * (attempt + 1))
        raise D1Error(f"D1 request failed after retries: {last}")

    def query(self, sql: str, params: Sequence = ()) -> list[dict]:
        results = self._post({"sql": sql, "params": list(params)})
        if not results:
            return []
        return results[-1].get("results") or []

    def batch(self, statements: Iterable[Statement]) -> list[list[dict]]:
        statements = list(statements)
        if not statements:
            return []
        out: list[list[dict]] = []
        # keep each REST call well inside the 30 s limit and a sane body size
        for i in range(0, len(statements), 50):
            part = statements[i:i + 50]
            results = self._post({"batch": [{"sql": s, "params": list(p)} for s, p in part]})
            out.extend(r.get("results") or [] for r in results)
        return out

    def executescript(self, sql: str) -> None:
        """Run a multi-statement script (the schema). The API runs `;`-joined statements."""
        self._post({"sql": sql})


class SqliteDB:
    """Same interface as D1, backed by sqlite3. Used by the tests and for local experiments."""

    def __init__(self, path: str | Path = ":memory:"):
        self.conn = sqlite3.connect(str(path))
        self.conn.row_factory = sqlite3.Row
        self.calls = 0
        self.rows_written = 0
        self.rows_read = 0

    def _run(self, sql: str, params: Sequence) -> list[dict]:
        cur = self.conn.execute(sql, tuple(params))
        return [dict(r) for r in cur.fetchall()]

    def query(self, sql: str, params: Sequence = ()) -> list[dict]:
        self.calls += 1
        with self.conn:
            return self._run(sql, params)

    def batch(self, statements: Iterable[Statement]) -> list[list[dict]]:
        statements = list(statements)
        if not statements:
            return []
        self.calls += 1
        with self.conn:   # one transaction, like a D1 batch
            return [self._run(s, p) for s, p in statements]

    def executescript(self, sql: str) -> None:
        self.conn.executescript(sql)


def profile_key(sql: str) -> str:
    """A statement's shape for the read profile: IN-lists and VALUES lists folded, 110 characters."""
    s = re.sub(r"\s+", " ", sql).strip()
    s = re.sub(r"\((\?,\s*)+\?\)", "(?..)", s)
    s = re.sub(r"(\(\?\.\.\),\s*)+\(\?\.\.\)", "(?..)", s)
    return s[:110]


def chunked(seq: Sequence, size: int) -> list[Sequence]:
    return [seq[i:i + size] for i in range(0, len(seq), size)]


def in_list_statements(sql_template: str, values: Sequence, extra_params: Sequence = ()) -> list[Statement]:
    """Split `... IN ({qs}) ...` over chunks so each statement stays under 100 parameters.
    `extra_params` are bound before the IN-list values."""
    size = MAX_PARAMS - len(extra_params)
    out = []
    for part in chunked(list(values), size):
        qs = ",".join("?" * len(part))
        out.append((sql_template.format(qs=qs), [*extra_params, *part]))
    return out


def insert_statements(table: str, columns: Sequence[str], rows: Sequence[Sequence],
                      suffix: str = "") -> list[Statement]:
    """Multi-row INSERTs, each under the 100-parameter limit."""
    per_row = len(columns)
    rows_per_stmt = max(1, MAX_PARAMS // per_row)
    out = []
    one = "(" + ",".join("?" * per_row) + ")"
    for part in chunked(list(rows), rows_per_stmt):
        sql = f"INSERT INTO {table} ({','.join(columns)}) VALUES {','.join([one] * len(part))} {suffix}"
        out.append((sql.strip(), [v for row in part for v in row]))
    return out
