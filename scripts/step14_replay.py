"""Step 14: replay the last 24 hours for Japan, Australia and Colombia, before and after the fix.

Reads (never writes) the live D1. In an in-memory copy:
- Japan and Australia: every live story of the last 24 h tagged with them, with its articles;
- Colombia (no reader has it live): one real day of its Google News searches, run through the job's
  own search code 24 times (one simulated hour each, the cap of 8 a search), then the real pass 1;
  its keywords come from the job's real backfill call (with those headlines).
Then the editor's fields are cleared and the real editor (real AI) runs twice on the same stories:
- BEFORE: the editor prompt and reader-topic examples of the last commit, no keyword rule;
- AFTER: today's prompt (non-events at 3-4), the keyword rule over the pool and in the editor.
A story "passes" for a topic when a reader who follows only that topic would get it under that
topic's heading (it carries the tag and qualifies: the custom rule, topic score 6+, or a score of 7+).
Output: reports/data/step-14/replay.json (replay-again.json with --again) and a table on screen.
About 6-9 AI calls; --again reruns only the two editor runs on the saved copy (2 calls).

    venv/Scripts/python scripts/step14_replay.py [--again]
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from job import custom, editor, gnews, translate  # noqa: E402
from job.config import Settings, load_env, load_prompt  # noqa: E402
from job.d1 import SqliteDB, insert_statements  # noqa: E402
from job.run import Job, RunStats, build_from_env  # noqa: E402

OUT = ROOT / "reports" / "data" / "step-14"
H = 3600
SANDBOX = Path(tempfile.gettempdir()) / "axiom-step14-replay.sqlite"
EDITOR_FIELDS = ("final_score", "topic_score", "main_topic", "headline", "description", "emojis", "edited_at", "scored_at")


def copy(db, table, rows):
    for r in rows:
        cols = list(r)
        db.query(f"INSERT OR IGNORE INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                 [r[c] for c in cols])


def old_prompt_and_boost():
    """The editor prompt file and READER_BOOST of the last commit (before Step 14)."""
    md = subprocess.run(["git", "show", "HEAD:prompts/editor.md"], cwd=ROOT, capture_output=True, text=True,
                        encoding="utf-8", check=True).stdout
    py = subprocess.run(["git", "show", "HEAD:job/editor.py"], cwd=ROOT, capture_output=True, text=True,
                        encoding="utf-8", check=True).stdout
    boost = re.search(r'READER_BOOST = """(.*?)"""', py, re.S).group(1)
    path = Path(tempfile.gettempdir()) / "axiom-step14-old-editor.md"
    path.write_text(md, encoding="utf-8")
    return editor.load_editor_prompt(path), boost


def build_sandbox(live, plans, settings, now):
    db = SqliteDB(":memory:")
    db.executescript((ROOT / "db" / "schema.sql").read_text(encoding="utf-8"))
    db.query("INSERT INTO users (id, first_name, topics, created_at) VALUES (1, 'R', '[\"politics\"]', 1)")
    topics = live.query("SELECT * FROM custom_topics WHERE tag IN ('c2', 'c3')")
    copy(db, "custom_topics", topics)
    stories = live.query("SELECT * FROM stories WHERE max(updated_at, coalesce(scored_at, 0)) >= ? AND merged_into IS NULL "
                         "AND (topics LIKE '%\"c2\"%' OR topics LIKE '%\"c3\"%')", [now - 24 * H])
    ids = [s["id"] for s in stories]
    items = []
    for i in range(0, len(ids), 90):
        part = ids[i:i + 90]
        items += live.query(f"SELECT * FROM items WHERE story_id IN ({', '.join('?' * len(part))})", part)
    copy(db, "stories", stories)
    copy(db, "items", items)
    live_view = {s["id"]: s for s in stories}
    print(f"Japan and Australia: {len(stories)} live stories, {len(items)} articles")

    # Colombia: the Step 13 check's answer (names, searches), id 90 so it never meets a live id
    checks = json.loads((ROOT / "reports" / "data" / "step-13" / "checks.json").read_text(encoding="utf-8"))
    col = next(c for c in checks if c.get("input") == "Colombia")
    db.query("INSERT INTO custom_topics (id, tag, names, emoji, definition, queries, boost_max, created_at, searched_at) "
             "VALUES (90, 'c90', ?, ?, ?, ?, 2, ?, ?)",
             [json.dumps(col["names"], ensure_ascii=False), col["emoji"], col.get("definition") or "News about Colombia.",
              json.dumps(col["queries"], ensure_ascii=False), now - 26 * H, now - 25 * H])
    for tid in (2, 3, 90):
        db.query("INSERT INTO custom_follows (user_id, topic_id, at) VALUES (1, ?, 1)", [tid])
    pool = live.query("SELECT url_hash, source_key, source_name, tier, url, title, published_at, fetched_at FROM items "
                      "WHERE fetched_at >= ? AND hint_topic IS NULL", [now - 48 * H])
    rows = [(r["url_hash"], r["source_key"], r["source_name"], r["tier"], r["url"], r["title"], None, r["published_at"],
             r["fetched_at"], "done", 0, None) for r in pool]
    for st in insert_statements("items", custom.ITEM_COLUMNS, rows, suffix="ON CONFLICT(url_hash) DO NOTHING"):
        db.query(*st)
    cfg = custom.load_config()
    results = {}
    for n, q in enumerate(col["queries"]):
        ed = q["ed"] if q["ed"] in cfg["editions"] else "en"
        query = {"key": f"c90:{ed}:{n}", "topic": "c90", "q": q["q"], "ed": ed,
                 **{k: cfg["editions"][ed][k] for k in ("hl", "gl", "ceid")}}
        f = gnews.fetch(query, "1d", timeout=15)
        results[f"{q['q']}|{ed}"] = f.items
        print(f"google: Colombia {q['q']!r} ({ed}): {len(f.items)} results{' ' + f.error if f.error else ''}")
        time.sleep(0.5)
    clock = {"now": now - 24 * H}

    def fetcher(query, window):
        hours = int(window.rstrip("h"))
        lo, hi = clock["now"] - hours * H, clock["now"]
        got = results.get(f"{query['q']}|{query['ed']}", [])
        return gnews.Fetched(query, [i for i in got if i.published_at and lo < i.published_at <= hi], 200, 1)

    only_col = [t for t in custom.load_active(db) if t.tag == "c90"]
    for k in range(1, 25):
        clock["now"] = now - 24 * H + k * H
        only_col[0].searched_at = clock["now"] - H
        custom.Searcher(db, cfg=cfg, fetcher=fetcher, log=lambda _m: None).run(only_col, clock["now"])
    new = db.query("SELECT count(*) AS n FROM items WHERE status = 'pending'")[0]["n"]
    print(f"Colombia: {new} new Google headlines in 24 simulated hours")

    calls = []
    kw_done = custom.backfill_keywords(db, plans, now=now, on_call=lambda p, ok, *a, **k: calls.append(ok))
    print(f"Colombia keywords ({len(calls)} call): {db.query('SELECT keywords FROM custom_topics WHERE id = 90')[0]['keywords']}")
    job = Job(db, plans, settings=settings, log=lambda m: None)
    stats = RunStats()
    job.load_custom(stats)
    job.rule = custom.KeywordRule([])          # pass 1 as before; AFTER applies the rule over the pool
    pending = job.load_pending()
    job.run_ai(pending, now, stats)
    print(f"pass 1 (Colombia): {len(pending)} items, {len(job.calls_log)} calls, "
          f"{stats.input_tokens} in / {stats.output_tokens} out")
    db.query(f"UPDATE stories SET {', '.join(f'{c} = NULL' for c in EDITOR_FIELDS)}")
    return db, live_view, {"colombia_headlines": new, "pass1_calls": len(job.calls_log), "keyword_calls": len(calls),
                           "colombia_keywords_written": bool(kw_done)}


def clone(db):
    out = SqliteDB(":memory:")
    db.conn.backup(out.conn)
    return out


def scores(db, tag):
    """Every story with this main topic: score/topic score, for the report."""
    return sorted(f"{r['final_score']}/{r['topic_score']} {r['headline'] or r['summary']}" for r in db.query(
        "SELECT final_score, topic_score, headline, summary FROM stories WHERE merged_into IS NULL AND main_topic = ?", [tag]))


def run_editor(db, plans, settings, now, after: bool, old=None):
    job = Job(db, plans, settings=settings, log=lambda m: None)
    stats = RunStats()
    job.load_custom(stats)
    if after:
        changed = custom.enforce(db, job.rule, now)
    else:
        changed = []
    bp = load_prompt()
    ed = editor.Editor(db, plans, topics=job.ai_topics, facts=bp.facts, facts_checked=bp.facts_checked, settings=settings,
                       log=lambda m: None, prompt=None if after else old[0])
    saved = editor.READER_BOOST
    if not after:
        ed.rule = custom.KeywordRule([])
        editor.READER_BOOST = old[1]
    try:
        res = ed.run(now)
    finally:
        editor.READER_BOOST = saved
    print(f"editor {'AFTER' if after else 'BEFORE'}: {res.line()}")
    return res, len(changed)


def passing(db, tag):
    cfg = translate.load_digest_config()
    rows = db.query("SELECT id, headline, summary, topics, importance, final_score, topic_score, main_topic FROM stories "
                    "WHERE merged_into IS NULL")
    out = []
    for s in rows:
        tags = json.loads(s["topics"])
        if tag in tags and s["final_score"] is not None and translate.qualifies({**s, "topics": tags}, cfg, [tag]):
            out.append({"id": s["id"], "headline": s["headline"] or s["summary"], "score": s["final_score"],
                        "topic_score": s["topic_score"], "main": s["main_topic"]})
    return sorted(out, key=lambda x: (-(x["topic_score"] or 0), -x["score"]))


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    OUT.mkdir(parents=True, exist_ok=True)
    settings = Settings()
    live, plans = build_from_env(load_env(), settings)
    again = "--again" in sys.argv
    old = old_prompt_and_boost()
    if again:
        base = SqliteDB(str(SANDBOX))
        saved = json.loads(SANDBOX.with_suffix(".json").read_text(encoding="utf-8"))
        now, meta = saved["now"], saved["meta"]
        live_view = {int(k): v for k, v in saved["live_view"].items()}
    else:
        now = int(time.time())
        base, live_view, meta = build_sandbox(live, plans, settings, now)
        if SANDBOX.exists():
            SANDBOX.unlink()
        base.conn.backup(SqliteDB(str(SANDBOX)).conn)
        SANDBOX.with_suffix(".json").write_text(json.dumps({"now": now, "meta": meta, "live_view": live_view}), encoding="utf-8")
    before_db, after_db = clone(base), clone(base)
    res_b, _ = run_editor(before_db, plans, settings, now, after=False, old=old)
    res_a, enforced = run_editor(after_db, plans, settings, now, after=True)
    cfg = translate.load_digest_config()
    out = {**meta, "now": now, "editor_before": [res_b.calls, res_b.input_tokens, res_b.output_tokens],
           "editor_after": [res_a.calls, res_a.input_tokens, res_a.output_tokens], "enforced_before_editor": enforced, "topics": {}}
    for tag, name in (("c2", "Japan"), ("c3", "Australia"), ("c90", "Colombia")):
        live_pass = []
        if tag != "c90":
            for s in live_view.values():
                tags = json.loads(s["topics"])
                if tag in tags and s["final_score"] is not None and translate.qualifies({**s, "topics": tags}, cfg, [tag]):
                    live_pass.append({"id": s["id"], "headline": s["headline"] or s["summary"], "score": s["final_score"],
                                      "topic_score": s["topic_score"], "main": s["main_topic"]})
        b, a = passing(before_db, tag), passing(after_db, tag)
        out["topics"][tag] = {"name": name, "live": live_pass, "before": b, "after": a,
                              "all_before": scores(before_db, tag), "all_after": scores(after_db, tag)}
        print(f"\n{name}: live {len(live_pass) if tag != 'c90' else '-'}, before {len(b)}, after {len(a)}")
        for label, lst in (("before", b), ("after", a)):
            for s in lst:
                print(f"   {label:6} {s['score']}/{s['topic_score']} [{s['main']}] {s['headline']}")
    name = "replay-again.json" if again else "replay.json"
    (OUT / name).write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"\nwritten {OUT / name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
