"""Does the first AI pass put the same Armenian event, reported in Armenian, Russian and English,
into one story? (dev tool, Step 7; read only)

    venv/Scripts/python scripts/armenia_grouping.py --since 2026-11-14T15:00 [--show 15]

For Armenia stories created since --since:
  grouped  stories whose articles come from feeds in 2 or more languages (good: one story)
  missed   pairs of separate Armenia stories that look like the same event: their English
           summaries are similar (job/dupes.py word score >= --sim), or the editor merged one
           into the other later (`merged_into`), or they were put in one near-duplicate group.
Prints examples with each article's language and title. Never prints secrets.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job import dupes  # noqa: E402
from job.config import load_env, load_sources  # noqa: E402
from job.d1 import D1, in_list_statements  # noqa: E402
from scripts.armenia_stats import parse_time  # noqa: E402


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--since", required=True)
    ap.add_argument("--until")
    ap.add_argument("--sim", type=float, default=0.35)
    ap.add_argument("--show", type=int, default=12)
    args = ap.parse_args()
    since = parse_time(args.since)
    until = parse_time(args.until) if args.until else 2 ** 31
    env = load_env()
    db = D1(env["CLOUDFLARE_ACCOUNT_ID"], env["D1_DATABASE_ID"], env["CLOUDFLARE_D1_TOKEN"], timeout=60)
    lang = {s["key"]: s.get("language", "?") for s in load_sources(include_disabled=True)}
    stories = db.query("SELECT id, summary, headline, final_score, merged_into, dup_group, created_at FROM stories "
                       "WHERE created_at >= ? AND created_at < ? AND topics LIKE '%\"armenia\"%' ORDER BY id",
                       [since, until])
    ids = [s["id"] for s in stories]
    items: dict[int, list[dict]] = {}
    for rows in db.batch(in_list_statements("SELECT story_id, source_key, title FROM items WHERE story_id IN ({qs})",
                                            ids)):
        for r in rows:
            items.setdefault(r["story_id"], []).append(r)
    by_id = {s["id"]: s for s in stories}

    def langs(sid):
        return sorted({lang.get(i["source_key"], "?") for i in items.get(sid, [])})

    def show(sid):
        s = by_id.get(sid)
        if not s:
            return
        print(f"  S{sid} score {s['final_score']} | {s['headline'] or s['summary']}")
        for i in items.get(sid, [])[:6]:
            print(f"      [{lang.get(i['source_key'], '?')}] {i['source_key']}: {i['title'][:100]}")

    multi = [s for s in stories if len(langs(s["id"])) >= 2]
    print(f"Armenia stories: {len(stories)}; with articles in 2+ languages: {len(multi)}; "
          f"by language mix: " + ", ".join(f"{'+'.join(k)} {v}" for k, v in sorted(
              {tuple(langs(s['id'])): sum(1 for x in stories if langs(x['id']) == langs(s['id']))
               for s in stories}.items(), key=lambda kv: -kv[1])))
    print("\n== grouped across languages (examples)")
    for s in sorted(multi, key=lambda s: -len(items.get(s["id"], [])))[:args.show]:
        show(s["id"])

    # possible misses
    live = [s for s in stories if s["merged_into"] is None]
    maps = [dupes.tokens(s["summary"]) for s in live]
    idf = dupes.idf_table(maps)
    pairs = []
    for a in range(len(live)):
        for b in range(a + 1, len(live)):
            if abs(live[a]["created_at"] - live[b]["created_at"]) > 12 * 3600:
                continue
            sim = dupes.similarity(maps[a], maps[b], idf)
            if sim >= args.sim:
                pairs.append((sim, live[a]["id"], live[b]["id"]))
    merged = [(s["id"], s["merged_into"]) for s in stories if s["merged_into"]]
    grouped = [s for s in stories if s["dup_group"] and s["dup_group"] != s["id"]]
    print(f"\n== possible misses: {len(pairs)} similar pairs (score >= {args.sim}), "
          f"{len(merged)} merged later by the editor, {len(grouped)} in a near-duplicate group")
    for sim, a, b in sorted(pairs, reverse=True)[:args.show]:
        print(f"-- similarity {sim:.2f}")
        show(a)
        show(b)
    for a, b in merged[:args.show]:
        print(f"-- editor merged S{a} into S{b}")
        show(a)
        show(b)
    print(f"\nD1 rows read {db.rows_read}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
