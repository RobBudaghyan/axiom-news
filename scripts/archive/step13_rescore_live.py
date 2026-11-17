"""Step 13 fixes: re-run the editor on a copy of the live custom-topic stories of the last hours,
to check a prompt change against what readers really got. Reads (never writes) the live D1:
copies every story of the window tagged with a live custom topic (and its articles) into an
in-memory database, clears the editor's fields, runs the real editor (job/editor.py, real AI) and
counts, per topic, the stories at topic score 6+ before (live) and after (this run).
Output: reports/data/step-13/rescore-live.json and a table on screen. 1-3 AI calls.

    venv/Scripts/python scripts/step13_rescore_live.py [--hours 13]
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from job import translate  # noqa: E402
from job.config import Settings, load_env  # noqa: E402
from job.d1 import SqliteDB  # noqa: E402
from job.run import Job, RunStats, build_from_env  # noqa: E402

OUT = ROOT / "reports" / "data" / "step-13"
EDITOR_FIELDS = ("final_score", "topic_score", "main_topic", "headline", "description", "emojis", "edited_at", "scored_at")


def copy(db, table, rows):
    for r in rows:
        cols = list(r)
        db.query(f"INSERT OR IGNORE INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", [r[c] for c in cols])


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    hours = float(sys.argv[sys.argv.index("--hours") + 1]) if "--hours" in sys.argv else 13
    settings = Settings()
    live, plans = build_from_env(load_env(), settings)
    now = int(time.time())
    since = now - int(hours * 3600)
    topics = live.query("SELECT * FROM custom_topics WHERE tag IS NOT NULL")
    tags = [t["tag"] for t in topics]
    like = " OR ".join(["topics LIKE ?"] * len(tags))
    stories = live.query(f"SELECT * FROM stories WHERE created_at >= ? AND merged_into IS NULL AND ({like})",
                         [since, *[f'%"{t}"%' for t in tags]])
    ids = [s["id"] for s in stories]
    items = []
    for i in range(0, len(ids), 90):
        chunk = ids[i:i + 90]
        items += live.query(f"SELECT * FROM items WHERE story_id IN ({', '.join('?' * len(chunk))})", chunk)
    before = {s["id"]: (s["main_topic"], s["final_score"], s["topic_score"], s["headline"] or s["summary"]) for s in stories}

    db = SqliteDB(":memory:")
    db.executescript((ROOT / "db" / "schema.sql").read_text(encoding="utf-8"))
    db.query("INSERT INTO users (id, first_name, topics, created_at) VALUES (1, 'R', '[\"politics\"]', 1)")
    copy(db, "custom_topics", topics)
    for t in topics:
        db.query("INSERT INTO custom_follows (user_id, topic_id, at) VALUES (1, ?, 1)", [t["id"]])
    copy(db, "stories", stories)
    copy(db, "items", items)
    db.query(f"UPDATE stories SET {', '.join(f'{c} = NULL' for c in EDITOR_FIELDS)}")
    print(f"copied {len(stories)} stories ({len(items)} articles) of the last {hours:g} h on {', '.join(tags)}")

    job = Job(db, plans, settings=settings, log=lambda m: print("  " + m) if m.startswith("editor") else None)
    stats = RunStats()
    job.load_custom(stats)
    ed = job.run_editor(now, stats)
    after = {r["id"]: r for r in db.query("SELECT id, main_topic, final_score, topic_score, headline, summary FROM stories")}
    cfg = translate.load_digest_config()
    out = {"hours": hours, "stories": len(stories), "editor_tokens": [ed.input_tokens, ed.output_tokens], "topics": {}}
    for t in topics:
        tag, name = t["tag"], json.loads(t["names"])["en"]
        old = [(i, b) for i, b in before.items() if b[0] == tag and (b[2] or 0) >= 6]
        new = [r for r in after.values() if r["main_topic"] == tag and translate.qualifies({**r, "topics": [tag], "importance": 0}, cfg, [tag])]
        out["topics"][tag] = {
            "name": name, "live_6_plus": len(old), "rescored_6_plus": len(new),
            "per_day_live": round(len(old) * 24 / hours, 1), "per_day_rescored": round(len(new) * 24 / hours, 1),
            "live": [f"{b[1]}/{b[2]} {b[3]}" for _, b in old],
            "rescored": [f"{r['final_score']}/{r['topic_score']} {r['headline'] or r['summary']}" for r in new]}
        print(f"\n{name}: topic score 6+ live {len(old)}, with the new prompt {len(new)} "
              f"(per day: {out['topics'][tag]['per_day_live']} -> {out['topics'][tag]['per_day_rescored']})")
        for x in out["topics"][tag]["rescored"]:
            print(f"   {x}")
    (OUT / "rescore-live.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
