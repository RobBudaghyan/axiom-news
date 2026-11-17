"""Step 16: copy production data into the staging D1. No AI calls; reads production, writes staging only.

Stories (the default): the stories, their translations, the topics, the custom topics, the last job runs
and the feed health that changed in the last N hours, so the staging Worker builds digests from the
same pool as production. Old rows (7 days, like production) are removed from staging too.

    venv/Scripts/python scripts/sync_staging.py --auto          # what the hourly job runs: every 3 hours,
                                                                # since the last sync (staging meta 'sync_at')
    venv/Scripts/python scripts/sync_staging.py --hours 3       # the last 3 hours, now
    venv/Scripts/python scripts/sync_staging.py --hours 48      # on demand: a full pool
    venv/Scripts/python scripts/sync_staging.py --users         # one-off: users, their custom topics, sent, holds

Production comes from .env (or the job's environment); the staging database id from
STAGING_D1_DATABASE_ID (GitHub secret) or D1_DATABASE_ID in .env.staging. Prints row counts only.
A custom topic added on staging gets an id from 1,000,000 up, so it never clashes with production's.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from job.config import _read_env_file, load_env  # noqa: E402
from job.d1 import D1  # noqa: E402

PROD_ID = "2a1eb212-95b8-4715-b628-2967cbcb0367"
STAGING_SEQ_START = 1_000_000
RETENTION_DAYS = 7
AUTO_EVERY_S = 3 * 3600

# table -> (WHERE for "changed since ?", the same parameter repeated n times)
STORY_TABLES = {
    "stories": ("max(updated_at, coalesce(edited_at, 0), coalesce(scored_at, 0)) >= ?", 1),
    "story_translations": ("created_at >= ?", 1),
    "topics": ("1 = 1 OR ? = 0", 1),
    "custom_topics": ("1 = 1 OR ? = 0", 1),
    "job_runs": ("started_at >= ?", 1),
}
USER_TABLES = {
    "users": ("1 = 1 OR ? = 0", 1),
    "custom_follows": ("1 = 1 OR ? = 0", 1),
    "sent": ("sent_at >= ?", 1),
    "digest_holds": ("1 = 1 OR ? = 0", 1),
}


def staging_id() -> str:
    sid = os.environ.get("STAGING_D1_DATABASE_ID") or _read_env_file(ROOT / ".env.staging").get("D1_DATABASE_ID", "")
    if not sid:
        raise SystemExit("no staging database id (STAGING_D1_DATABASE_ID or .env.staging)")
    return sid


def upserts(table: str, rows: list[dict]) -> list[tuple[str, list]]:
    out = []
    for r in rows:
        cols = list(r)
        out.append((f"INSERT OR REPLACE INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                    [r[c] for c in cols]))
    return out


def copy(prod: D1, staging: D1, tables: dict, since: int) -> dict[str, int]:
    counts = {}
    for table, (where, n) in tables.items():
        rows = prod.query(f"SELECT * FROM {table} WHERE {where}", [since] * n)
        staging.batch(upserts(table, rows))
        counts[table] = len(rows)
    return counts


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=3)
    ap.add_argument("--auto", action="store_true", help="every 3 hours, from the last sync (for the hourly job)")
    ap.add_argument("--users", action="store_true", help="also copy users, custom follows, sent and holds (one-off)")
    a = ap.parse_args()
    if os.environ.get("AXIOM_ENV") == "staging":
        raise SystemExit("run without AXIOM_ENV: production is the source")
    env = load_env()
    if env["D1_DATABASE_ID"] != PROD_ID:
        raise SystemExit("the source must be the production D1")
    sid = staging_id()
    if sid == PROD_ID:
        raise SystemExit("refusing: the staging id is the production D1")
    prod = D1(env["CLOUDFLARE_ACCOUNT_ID"], PROD_ID, env["CLOUDFLARE_D1_TOKEN"])
    staging = D1(env["CLOUDFLARE_ACCOUNT_ID"], sid, env["CLOUDFLARE_D1_TOKEN"])
    now = int(time.time())
    since = int(now - a.hours * 3600)
    if a.auto:   # measured (Step 16): every 3 hours writes about 40% fewer rows than every hour
        last = staging.query("SELECT value FROM meta WHERE key = 'sync_at'")
        last_at = int(last[0]["value"]) if last else 0
        if now - last_at < AUTO_EVERY_S - 600:
            print(f"last sync {round((now - last_at) / 60)} min ago; next after {AUTO_EVERY_S // 3600} h")
            return 0
        since = max(last_at - 600, now - 26 * 3600) if last_at else now - 26 * 3600
    t0 = time.time()

    # staging-made custom topics start at 1,000,000 (AUTOINCREMENT keeps the highest id ever used)
    seq = staging.query("SELECT seq FROM sqlite_sequence WHERE name = 'custom_topics'")
    if not seq or seq[0]["seq"] < STAGING_SEQ_START:
        staging.batch([("INSERT INTO custom_topics (id, names, definition, queries, created_at) VALUES (?, '{}', 'x', '[]', ?)",
                        [STAGING_SEQ_START, now]),
                       ("DELETE FROM custom_topics WHERE id = ?", [STAGING_SEQ_START])])

    counts = copy(prod, staging, STORY_TABLES, since)
    fh = prod.query("SELECT key, value FROM meta WHERE key = 'feed_health'")
    staging.batch(upserts("meta", fh))
    if a.users:
        counts.update(copy(prod, staging, USER_TABLES, now - RETENTION_DAYS * 86400))
    cut = now - RETENTION_DAYS * 86400
    staging.batch([
        ("DELETE FROM story_translations WHERE story_id IN (SELECT id FROM stories WHERE updated_at < ?)", [cut]),
        ("DELETE FROM stories WHERE updated_at < ?", [cut]),
        ("DELETE FROM sent WHERE sent_at < ?", [cut]),
        ("DELETE FROM job_runs WHERE started_at < ?", [now - 30 * 86400]),
        ("INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_at', ?)", [str(now)]),
    ])
    print("copied " + ", ".join(f"{k} {v}" for k, v in counts.items()) +
          f"; production read {prod.rows_read} rows; staging read {staging.rows_read}, wrote {staging.rows_written} rows; "
          f"{time.time() - t0:.1f} s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
