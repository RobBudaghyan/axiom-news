"""Apply db/schema.sql to the D1 database named in .env, then list its tables.
Safe to re-run (every statement is IF NOT EXISTS).

Usage:  venv/Scripts/python scripts/apply_schema.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from job.config import load_env  # noqa: E402
from job.d1 import D1, D1Error  # noqa: E402

MIGRATIONS = [
    "ALTER TABLE stories ADD COLUMN dup_group INTEGER",   # Step 3: near-duplicate groups
    "ALTER TABLE users ADD COLUMN format TEXT",           # Step 4: per-user digest format (Mini App)
    "ALTER TABLE job_runs ADD COLUMN d1_rows_read INTEGER",     # Step 4: Admin tab, D1 use today
    "ALTER TABLE job_runs ADD COLUMN d1_rows_written INTEGER",
    # Step 5: the editor pass
    "ALTER TABLE stories ADD COLUMN headline TEXT",
    "ALTER TABLE stories ADD COLUMN description TEXT",
    "ALTER TABLE stories ADD COLUMN emojis TEXT",
    "ALTER TABLE stories ADD COLUMN final_score INTEGER",
    "ALTER TABLE stories ADD COLUMN edited_at INTEGER",
    "ALTER TABLE stories ADD COLUMN merged_into INTEGER",
    "ALTER TABLE job_runs ADD COLUMN editor_status TEXT",
    "ALTER TABLE job_runs ADD COLUMN editor_candidates INTEGER",
    "ALTER TABLE job_runs ADD COLUMN editor_merged INTEGER",
    "ALTER TABLE ai_calls ADD COLUMN kind TEXT",
    "ALTER TABLE stories ADD COLUMN main_topic TEXT",
    # Step 8: the dynamic digest
    "ALTER TABLE stories ADD COLUMN topic_score INTEGER",
    "ALTER TABLE stories ADD COLUMN scored_at INTEGER",
    # Step 9: reader languages (story_translations is a new table, created above)
    "ALTER TABLE users ADD COLUMN lang TEXT NOT NULL DEFAULT 'en'",
    # Step 13: custom topics and the AI budget guard (the new tables are created above)
    "ALTER TABLE items ADD COLUMN headline_only INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE items ADD COLUMN hint_topic TEXT",
    "ALTER TABLE stories ADD COLUMN link_state INTEGER",
    "ALTER TABLE ai_calls ADD COLUMN code INTEGER",
]


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    env = load_env()
    db = D1(env["CLOUDFLARE_ACCOUNT_ID"], env["D1_DATABASE_ID"], env["CLOUDFLARE_D1_TOKEN"])
    db.executescript((ROOT / "db" / "schema.sql").read_text(encoding="utf-8"))
    # Columns added after a table already existed (CREATE TABLE IF NOT EXISTS does not add them).
    for sql in MIGRATIONS:
        try:
            db.query(sql)
            print(f"migration applied: {sql}")
        except D1Error as exc:
            if "duplicate column" not in str(exc):
                raise
    rows = db.query("SELECT type, name FROM sqlite_master WHERE name NOT LIKE '\\_%' ESCAPE '\\' "
                    "AND name NOT LIKE 'sqlite_%' ORDER BY type, name")
    for r in rows:
        print(f"{r['type']:6} {r['name']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
