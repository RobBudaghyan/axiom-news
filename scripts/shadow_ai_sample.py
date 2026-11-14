"""Step 6, one-off: run the real first AI pass over a sample of shadow (Google News) items in a
SANDBOX, to estimate how many are real news per topic, how many are events the live pool does not
have yet, and the token cost per item.

    venv/Scripts/python scripts/shadow_ai_sample.py [--per-topic 20] [--dry-run] [--json out.json]

Sandbox = an in-memory SQLite database with the real schema. The live D1 database is only READ
(shadow_items, and the last 24 h of live stories copied in as "existing stories", exactly what the
real pass sees). Nothing is written to D1, and nothing reaches a digest. The AI calls are real
(the normal Gemini -> Gemini -> Groq chain) but are not logged in the live ai_calls table, so they
are reported here and in the Step 6 report instead.

A sampled item the AI attaches to one of the copied live stories = an event the live pool already
has. A sampled item in a NEW sandbox story = an event the curated feeds did not give us (at the
time of the sample). Items in not_news = not news on our topics.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from job.config import Settings, load_env, load_topics  # noqa: E402
from job.d1 import SqliteDB, insert_statements  # noqa: E402
from job.run import Job, RunStats, build_from_env  # noqa: E402

STORY_COLS = ("id", "summary", "topics", "importance", "best_url", "best_source", "best_tier",
              "best_published_at", "source_count", "created_at", "updated_at")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-topic", type=int, default=20)
    ap.add_argument("--seed", type=int, default=6)
    ap.add_argument("--dry-run", action="store_true", help="build the prompt and count tokens only")
    ap.add_argument("--json", help="write the per-item results here")
    args = ap.parse_args()

    env = load_env()
    settings = Settings()
    live, plans = build_from_env(env, settings)
    now = int(time.time())

    # 1. the sample: unique shadow items (no title duplicate), per topic, spread over the period
    rows = live.query("SELECT id, topic, topics, query_key, title, source, curated_outlet, link, published_at, "
                      "fetched_at FROM shadow_items WHERE dup IS NULL ORDER BY id")
    rng = random.Random(args.seed)
    sample = []
    for topic in sorted({r["topic"] for r in rows}):
        pool = [r for r in rows if r["topic"] == topic]
        sample += sorted(rng.sample(pool, min(args.per_topic, len(pool))), key=lambda r: r["id"])
    print(f"shadow items without a title duplicate: {len(rows)}; sample {len(sample)} "
          f"({', '.join(f'{t} {sum(1 for s in sample if s['topic'] == t)}' for t in sorted({s['topic'] for s in sample}))})")

    # 2. the sandbox: real schema, the live pool's last 24 h of stories, the sample as pending items
    box = SqliteDB()
    box.executescript((ROOT / "db" / "schema.sql").read_text(encoding="utf-8"))
    stories = live.query(f"SELECT {', '.join(STORY_COLS)} FROM stories WHERE updated_at >= ? AND merged_into IS NULL "
                         "ORDER BY updated_at DESC LIMIT ?", [now - 24 * 3600, settings.existing_max])
    box.batch(insert_statements("stories", STORY_COLS, [tuple(s[c] for c in STORY_COLS) for s in stories]))
    live_ids = {s["id"] for s in stories}
    item_rows = [(10_000_000 + n, f"shadow{s['id']}", f"gnews:{s['query_key']}", s["source"] or "Google News",
                  2 if s["curated_outlet"] else 3, s["link"], s["title"], "", s["published_at"], now, "pending")
                 for n, s in enumerate(sample)]
    box.batch(insert_statements("items", ("id", "url_hash", "source_key", "source_name", "tier", "url", "title",
                                          "snippet", "published_at", "fetched_at", "status"), item_rows))
    by_item = {10_000_000 + n: s for n, s in enumerate(sample)}
    print(f"sandbox: {len(stories)} live stories of the last 24 h copied in as existing stories")

    job = Job(box, plans, settings=settings, topics=load_topics(), sources=[], fetcher=lambda s, n: [],
              editor_enabled=False)
    pending = job.load_pending()
    full = job.render(pending, job.load_existing(now, settings.existing_max), now)
    empty = job.render([], job.load_existing(now, settings.existing_max), now)
    gem = plans[0].provider
    t_full, t_empty = gem.count_tokens(full), gem.count_tokens(empty)
    print(f"prompt tokens (countTokens): {t_full} with the sample, {t_empty} without items -> "
          f"{(t_full - t_empty) / max(1, len(pending)):.1f} input tokens per item")
    if args.dry_run:
        return 0

    # 3. the real first pass, in the sandbox
    stats = RunStats()
    t = time.time()
    left = job.run_ai(pending, now, stats)
    print(f"AI: {len(job.calls_log)} calls ({', '.join(f'{c[2]} ok={c[3]}' for c in job.calls_log)}), "
          f"{time.time() - t:.0f} s, tokens in {stats.input_tokens} out {stats.output_tokens}, "
          f"left pending {len(left)}; errors: {stats.ai_errors or 'none'}")

    # 4. what happened to each sampled item
    items = {r["id"]: r for r in box.query("SELECT id, status, story_id FROM items WHERE id >= 10000000")}
    new_stories = {r["id"]: r for r in box.query(
        "SELECT id, summary, topics, importance FROM stories WHERE id NOT IN (%s)" % ",".join(map(str, live_ids or {0})))}
    live_by_id = {s["id"]: s for s in stories}
    results, per = [], {}
    for iid, s in by_item.items():
        it = items[iid]
        if it["status"] == "pending":
            kind = "pending"
        elif it["status"] != "done":
            kind = "not_news"
        elif it["story_id"] in live_ids:
            kind = "in_live_pool"
        else:
            kind = "new_event"
        st = new_stories.get(it["story_id"]) or live_by_id.get(it["story_id"])
        results.append({"shadow_id": s["id"], "topic": s["topic"], "title": s["title"], "source": s["source"],
                        "curated_outlet": s["curated_outlet"], "kind": kind, "story_id": it["story_id"],
                        "story": st["summary"] if st else None,
                        "importance": st["importance"] if st else None,
                        "story_topics": json.loads(st["topics"]) if st else None})
        p = per.setdefault(s["topic"], {"sample": 0, "not_news": 0, "in_live_pool": 0, "new_event": 0, "pending": 0})
        p["sample"] += 1
        p[kind] += 1
    print("\nper query topic (sample | not news | already in live pool | new event | pending):")
    for topic, p in sorted(per.items()):
        print(f"  {topic:15} {p['sample']:3} | {p['not_news']:3} | {p['in_live_pool']:3} | {p['new_event']:3} | {p['pending']}")
    new_events = {}
    for r in results:
        if r["kind"] == "new_event":
            new_events.setdefault(r["story_id"], []).append(r)
    print(f"\nnew events (new sandbox stories): {len(new_events)}")
    for sid, rs in sorted(new_events.items(), key=lambda kv: -(kv[1][0]["importance"] or 0)):
        r = rs[0]
        print(f"  [{r['importance']}] {','.join(r['story_topics'] or [])} | {r['story']}")
        for x in rs:
            print(f"        <- {x['title']} | {x['source']}")
    out_tokens_per_item = stats.output_tokens / max(1, len(pending))
    print(f"\noutput tokens per item: {out_tokens_per_item:.1f} (whole answer / items)")
    if args.json:
        Path(args.json).write_text(json.dumps({
            "at": now, "sample": len(sample), "live_stories": len(stories), "prompt_tokens_full": t_full,
            "prompt_tokens_empty": t_empty, "input_tokens": stats.input_tokens, "output_tokens": stats.output_tokens,
            "calls": [list(c) for c in job.calls_log], "per_topic": per, "results": results,
            "errors": stats.ai_errors}, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"written {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
