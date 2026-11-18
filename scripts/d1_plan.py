"""Step 17: EXPLAIN QUERY PLAN (and, on D1, rows read) for the heavy read queries of the hourly job
and the Worker digest.

    venv/Scripts/python scripts/d1_plan.py --local          # in-memory SQLite, synthetic pool, no D1
    AXIOM_ENV=staging venv/Scripts/python scripts/d1_plan.py  # staging D1: plans and real rows read

Only SELECTs and EXPLAIN, so it changes nothing. D1 mode refuses to run without AXIOM_ENV=staging.
A plan line "SCAN stories" (or "SCAN s") on a big table is a full read: the thing to avoid.
"""
from __future__ import annotations

import json
import os
import random
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from job import custom, dupes, editor, translate  # noqa: E402
from job.d1 import SqliteDB  # noqa: E402


def worker_candidate_sql() -> str:
    src = (ROOT / "worker" / "src" / "digest.js").read_text(encoding="utf-8")
    return re.search(r"export const CANDIDATE_SQL = `(.*?)`;", src, re.S).group(1)


def local_db(now: int, stories: int = 7000, items: int = 21000) -> SqliteDB:
    """A pool shaped like production's: a week of stories, most of them old, a few merged."""
    db = SqliteDB()
    db.executescript((ROOT / "db" / "schema.sql").read_text(encoding="utf-8"))
    rnd = random.Random(17)
    rows = []
    for i in range(1, stories + 1):
        upd = now - rnd.randint(0, 7 * 86400)
        scored = upd + rnd.randint(0, 3600) if rnd.random() < 0.6 else None
        merged = rnd.randint(1, i) if rnd.random() < 0.05 and i > 1 else None
        rows.append((i, f"s{i}", json.dumps(["armenia"]), rnd.randint(1, 9), "u", "src", 1, upd - 600, 1,
                     upd - 3600, upd, rnd.randint(4, 8) if scored else None, scored, merged, "armenia"))
    db.conn.executemany(
        "INSERT INTO stories (id, summary, topics, importance, best_url, best_source, best_tier, best_published_at, "
        "source_count, created_at, updated_at, final_score, scored_at, merged_into, main_topic) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    db.conn.executemany(
        "INSERT INTO items (id, url_hash, source_key, source_name, tier, url, title, fetched_at, status, story_id) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        [(i, f"h{i}", "k", "n", 1, "u", f"t{i}", now - rnd.randint(0, 7 * 86400),
          "pending" if i % 200 == 0 else "done", None if i % 200 == 0 else rnd.randint(1, stories))
         for i in range(1, items + 1)])
    db.conn.executemany("INSERT INTO sent (user_id, story_id, sent_at) VALUES (?,?,?)",
                        [(u, s, now) for u in range(1, 21) for s in range(1, stories, 40)])
    db.conn.commit()
    return db


def cases(now: int, ids: list[int]) -> list[tuple[str, str, list]]:
    day = now - 24 * 3600
    qs = ",".join("?" * len(ids))
    cfg = {"armenia": 2}
    return [
        ("editor pool", editor.POOL_SQL, [day, 3]),
        ("editor items", editor.ITEMS_SQL.format(qs=qs), ids),
        ("dupes pool", dupes.POOL_SQL, [day, 3]),
        ("translate eligible", translate.ELIGIBLE_SQL, [day, 2, json.dumps(cfg), 7, 7, 1,
                                                        json.dumps(["armenia", "russia"]), json.dumps([]), 6]),
        ("enforce", custom.ENFORCE_SQL, [now - 26 * 3600]),
        ("worker digest", worker_candidate_sql(),
         [1, json.dumps(["armenia", "russia"]), now - 5 * 3600, 40, 7, 2, 7, json.dumps(cfg), 1, "en",
          day, json.dumps(["armenia", "russia", "politics_conflicts"]), 6]),
        ("merge children", "SELECT id FROM stories WHERE merged_into = ?", [ids[-1]]),
        ("sent by story", "SELECT user_id FROM sent WHERE story_id = ?", [ids[-1]]),
        ("pending", "SELECT id FROM items WHERE status = 'pending' ORDER BY coalesce(published_at, fetched_at), id", []),
        ("expire pending", "SELECT id FROM items WHERE status = 'pending' AND fetched_at < ?", [day]),
        ("custom admin", "SELECT x.value AS tag, count(*) AS stories FROM stories s, json_each(s.topics) x "
                         "WHERE s.updated_at >= ?1 AND s.created_at >= ?1 AND s.merged_into IS NULL "
                         "AND x.value GLOB 'c[0-9]*' GROUP BY x.value", [day]),
    ]


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    local = "--local" in sys.argv
    only = [a for a in sys.argv[1:] if not a.startswith("--")]
    now = int(time.time())
    if local:
        db = local_db(now)
    else:
        if os.environ.get("AXIOM_ENV") != "staging":
            raise SystemExit("run with AXIOM_ENV=staging (never against production), or use --local")
        from job.config import load_env
        from job.d1 import D1
        env = load_env()
        db = D1(env["CLOUDFLARE_ACCOUNT_ID"], env["D1_DATABASE_ID"], env["CLOUDFLARE_D1_TOKEN"])
    ids = [r["id"] for r in db.query("SELECT id FROM stories ORDER BY id DESC LIMIT 50")]
    full = 0
    for name, sql, params in cases(now, ids):
        if only and name not in only:
            continue
        plan = db.query("EXPLAIN QUERY PLAN " + sql, params)
        before = db.rows_read
        rows = db.query(sql, params)
        read = "" if local else f", {db.rows_read - before} rows read"
        print(f"{name}: {len(rows)} rows returned{read}")
        for p in plan:
            detail = str(p.get("detail"))
            print("    " + detail)
            # a scan of the partial index (only pending items) is small; a scan of a table is not
            if (re.match(r"SCAN (stories|items|sent|s)\b", detail)
                    and "VIRTUAL" not in detail and "idx_items_pending" not in detail):
                full += 1
                print("    ^ FULL SCAN")
    print(f"full scans: {full}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
