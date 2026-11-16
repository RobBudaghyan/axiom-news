"""Step 13 fixes: replay the last 24 hours for Japan and Colombia under the new custom-topic rule.

Reads (never writes) the live D1 pool. In an in-memory copy of the database:
1. Each topic's real Google News searches are run ONCE for the last day (when:1d); the job's own
   search code (job/custom.py Searcher: the per-topic cap of 8, the no-AI check against the pool,
   tier 4, "headline only") is then run 24 times, once per simulated hour, on the results
   published in that hour's window.
2. The job's real pass 1 (job/run.py run_ai) and the real editor (job/editor.py, with the new
   reader-topic examples) run on those items with the real AI (Gemini, then the fallbacks).
3. Each story's main topic, score and topic score are counted under the new rule (custom main
   topic: topic score >= 6, no cap, no "above the score" rule; or a score of 7+) and, for
   comparison, under the old Step 13 rule (the topic's cap of 2 and "above the score").
Output: reports/data/step-13/replay.json and a table on screen. About 3-6 AI calls.
The in-memory copy is also saved (scratch file, see SANDBOX); `--editor-only` reruns only the
editor on it after a prompt change (the stories' editor fields are cleared first).

    venv/Scripts/python scripts/step13_replay.py [--editor-only]
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from job import custom, gnews, translate  # noqa: E402
from job.config import Settings, load_env  # noqa: E402
from job.d1 import D1, SqliteDB, insert_statements  # noqa: E402
from job.run import Job, RunStats, build_from_env  # noqa: E402

OUT = ROOT / "reports" / "data" / "step-13"
H = 3600
SANDBOX = Path(__import__("tempfile").gettempdir()) / "axiom-step13-replay.sqlite"


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    env = load_env()
    settings = Settings()
    live, plans = build_from_env(env, settings)
    editor_only = "--editor-only" in sys.argv
    meta_path = SANDBOX.with_suffix(".json")
    now = int(time.time()) if not editor_only else json.loads(meta_path.read_text())["now"]
    start = now - 24 * H
    cfg = custom.load_config()

    # the two topics: Japan as the owner created it (live row), Colombia from the Step 13 check
    japan = live.query("SELECT names, emoji, definition, queries FROM custom_topics WHERE tag = 'c2'")[0]
    checks = json.loads((OUT / "checks.json").read_text(encoding="utf-8"))
    col = next(c for c in checks if c.get("input") == "Colombia")
    topics = [
        {"id": 1, "names": json.loads(japan["names"]), "emoji": japan["emoji"], "definition": japan["definition"],
         "queries": json.loads(japan["queries"])},
        {"id": 2, "names": col["names"], "emoji": col["emoji"], "definition": col.get("definition") or "News about Colombia.",
         "queries": col["queries"]},
    ]

    if editor_only:
        return rerun_editor(live, plans, settings, now, topics, json.loads(meta_path.read_text()))
    if SANDBOX.exists():
        SANDBOX.unlink()
    db = SqliteDB(str(SANDBOX))
    db.executescript((ROOT / "db" / "schema.sql").read_text(encoding="utf-8"))
    db.query("INSERT INTO users (id, first_name, topics, created_at) VALUES (1, 'R', '[\"politics\"]', 1)")
    for t in topics:
        db.query("INSERT INTO custom_topics (id, tag, names, emoji, definition, queries, boost_max, created_at, searched_at) "
                 "VALUES (?,?,?,?,?,?,2,?,?)", [t["id"], f"c{t['id']}", json.dumps(t["names"], ensure_ascii=False), t["emoji"],
                                                t["definition"], json.dumps(t["queries"], ensure_ascii=False), start - 2 * H, start - H])
        db.query("INSERT INTO custom_follows (user_id, topic_id, at) VALUES (1, ?, 1)", [t["id"]])
    # the live pool's headlines of the last 48 hours, for the no-AI duplicate check (status done)
    pool = live.query("SELECT url_hash, source_key, source_name, tier, url, title, published_at, fetched_at FROM items "
                      "WHERE fetched_at >= ?", [now - 48 * H])
    rows = [(r["url_hash"], r["source_key"], r["source_name"], r["tier"], r["url"], r["title"], None, r["published_at"],
             r["fetched_at"], "done", 0, None) for r in pool]
    for st in insert_statements("items", custom.ITEM_COLUMNS, rows, suffix="ON CONFLICT(url_hash) DO NOTHING"):
        db.query(*st)
    print(f"pool headlines copied: {len(rows)}")

    # 1. one real day of Google results per query, then 24 simulated hourly searches
    results: dict[str, list] = {}
    editions = cfg["editions"]
    for t in topics:
        for n, q in enumerate(t["queries"]):
            ed = q["ed"] if q["ed"] in editions else "en"
            query = {"key": f"c{t['id']}:{ed}:{n}", "topic": f"c{t['id']}", "q": q["q"], "ed": ed,
                     **{k: editions[ed][k] for k in ("hl", "gl", "ceid")}}
            f = gnews.fetch(query, "1d", timeout=15)
            results[f"{query['topic']}|{q['q']}|{ed}"] = f.items
            print(f"google: c{t['id']} {q['q']!r} ({ed}): {len(f.items)} results{' ' + f.error if f.error else ''}")
            time.sleep(0.5)

    def fetcher(query, window):
        hours = int(window.rstrip("h"))
        items = results.get(f"{query['topic']}|{query['q']}|{query['ed']}", [])
        lo, hi = clock["now"] - hours * H, clock["now"]
        return gnews.Fetched(query, [i for i in items if i.published_at and lo < i.published_at <= hi], 200, 1)

    clock = {"now": start}
    per_hour = []
    for k in range(1, 25):
        clock["now"] = start + k * H
        active = custom.load_active(db)
        res = custom.Searcher(db, cfg=cfg, fetcher=fetcher, clock=time.time, log=lambda _m: None).run(active, clock["now"])
        per_hour.append({t: v["new_items"] for t, v in res.per_topic.items()})
    new_items = {f"c{t['id']}": sum(h.get(f"c{t['id']}", 0) for h in per_hour) for t in topics}
    print(f"simulated hourly searches: new headlines in 24 h: {new_items}")

    # 2. the real pass 1 and editor on them
    job = Job(db, plans, settings=settings, log=lambda m: print("  " + m) if m.startswith(("editor", "pass")) else None)
    stats = RunStats()
    job.load_custom(stats)
    pending = job.load_pending()
    left = job.run_ai(pending, now, stats)
    print(f"pass 1: {len(pending)} items, {len(left)} left, {len(job.calls_log)} calls, {stats.input_tokens} in / {stats.output_tokens} out")
    meta = {"now": now, "new_headlines_24h": new_items, "per_hour": per_hour, "pass1_items": len(pending),
            "pass1_tokens": [stats.input_tokens, stats.output_tokens], "pass1_calls": len(job.calls_log)}
    meta_path.write_text(json.dumps(meta))
    return finish(job, db, live, now, topics, meta, stats)


def rerun_editor(live, plans, settings, now, topics, meta) -> int:
    db = SqliteDB(str(SANDBOX))
    db.query("UPDATE stories SET final_score = NULL, topic_score = NULL, main_topic = NULL, headline = NULL, "
             "description = NULL, emojis = NULL, edited_at = NULL, scored_at = NULL")
    job = Job(db, plans, settings=settings, log=lambda m: print("  " + m) if m.startswith(("editor", "pass")) else None)
    stats = RunStats()
    job.load_custom(stats)
    return finish(job, db, live, now, topics, {**meta, "editor_rerun": True}, stats)


def finish(job, db, live, now, topics, meta, stats) -> int:
    calls_before = len(job.calls_log)
    ed = job.run_editor(now, stats)
    print(f"editor: {ed.line()}")

    # 3. count under the new rule and the old one
    base = translate.load_digest_config()
    tags = ["c1", "c2"]
    old_cfg = {**base, "topic_boost_max": {**base["topic_boost_max"], "c1": 2, "c2": 2}}
    stories = db.query("SELECT id, summary, headline, topics, importance, final_score, topic_score, main_topic FROM stories "
                       "WHERE merged_into IS NULL")
    out = {**meta, "editor_calls": len(job.calls_log) - calls_before,
           "editor_tokens": [ed.input_tokens, ed.output_tokens], "topics": {}}

    def old_rule(s, tag):
        if s["final_score"] is None:
            return (s["importance"] or 0) - base["unedited_offset"] >= base["editorial_bar"]
        if s["final_score"] >= base["editorial_bar"]:
            return True
        if s["main_topic"] != tag:
            return False
        boost = max(0, (s["topic_score"] if s["topic_score"] is not None else s["final_score"]) - s["final_score"])
        t = s["final_score"] + min(boost, 2)
        return t >= base["topic_bar"] and t > s["final_score"]

    for t in topics:
        tag = f"c{t['id']}"
        mine = [s for s in stories if tag in json.loads(s["topics"])]
        new = [s for s in mine if translate.qualifies(s, base, [tag])]
        old = [s for s in mine if old_rule(s, tag)]
        main = [s for s in mine if s["main_topic"] == tag]
        dist = {}
        for s in main:
            if s["topic_score"] is not None:
                dist[s["topic_score"]] = dist.get(s["topic_score"], 0) + 1
        out["topics"][tag] = {
            "name": t["names"]["en"], "stories": len(mine), "edited": sum(1 for s in mine if s["final_score"] is not None),
            "main_topic": len(main), "topic_score_counts": dict(sorted(dist.items())),
            "new_rule": len(new), "old_rule": len(old),
            "picked": [{"headline": s["headline"] or s["summary"], "score": s["final_score"], "topic_score": s["topic_score"]}
                       for s in sorted(new, key=lambda s: -(s["topic_score"] or s["final_score"] or 0))],
            "below_bar_examples": [{"headline": s["headline"] or s["summary"], "score": s["final_score"], "topic_score": s["topic_score"]}
                                   for s in main if s not in new and s["topic_score"] is not None][:8],
        }
        print(f"{t['names']['en']}: {len(mine)} stories ({len(main)} with it as main topic), "
              f"in a digest: {len(new)} under the new rule, {len(old)} under the old; topic scores {dict(sorted(dist.items()))}")
        for s in out["topics"][tag]["picked"]:
            print(f"   {s['score']}/{s['topic_score']}  {s['headline']}")

    # RSS stories of the live pool about the two countries (pass 1 tags them once the topic exists)
    for tag, words in (("c1", ["japan", "japanese", "tokyo"]), ("c2", ["colombia", "colombian", "bogot"])):
        like = " OR ".join(["lower(coalesce(headline, summary)) LIKE ?"] * len(words))
        rss = live.query(f"SELECT coalesce(headline, summary) AS h, final_score FROM stories WHERE created_at >= ? AND merged_into IS NULL AND ({like})",
                         [now - 24 * H, *[f"%{w}%" for w in words]])
        out["topics"][tag]["rss_pool_24h"] = {"stories": len(rss), "score_7_plus": sum(1 for r in rss if (r["final_score"] or 0) >= 7),
                                              "examples": [r["h"] for r in rss[:6]]}
        print(f"{tag}: live RSS pool stories mentioning it in 24 h: {len(rss)}")
    (OUT / "replay.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"written {OUT / 'replay.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
