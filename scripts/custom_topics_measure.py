"""Step 13: what custom topics cost in AI calls and tokens per day, for 1, 5 and 20 topics.

Reads (never writes) the live D1 pool for the comparison, uses the real topic checks of
worker/scripts/step13-checks.mjs (reports/data/step-13/checks.json: each topic's searches) and:
1. runs each set's Google News searches for real, the way the hourly job would in a steady state
   (the 40-request cap: with more searches than fit, each topic is searched every few hours with a
   wider window), into an in-memory copy, after the same no-AI duplicate check against the pool;
2. makes ONE sandbox pass-1 call (Gemini) on the 5-topic set's new items with the real prompt, to
   measure tokens per Google headline and how many become stories;
3. adds up the extra calls and tokens per day for pass 1, the editor, translation and the checks,
   using this pool's own measured averages (ai_calls of the last 48 hours).
Output: reports/data/step-13/cost.json and a table on screen.

    venv/Scripts/python scripts/custom_topics_measure.py
"""
from __future__ import annotations

import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from job import ai, custom, gnews  # noqa: E402
from job.config import Settings, load_env, load_prompt, load_topics  # noqa: E402
from job.d1 import D1, SqliteDB, insert_statements  # noqa: E402

OUT = ROOT / "reports" / "data" / "step-13"
H = 3600


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    env = load_env()
    live = D1(env["CLOUDFLARE_ACCOUNT_ID"], env["D1_DATABASE_ID"], env["CLOUDFLARE_D1_TOKEN"])
    checks = json.loads((OUT / "checks.json").read_text(encoding="utf-8"))
    accepted = [c for c in checks if c.get("verdict") == "accept" and not c.get("same_as") and c.get("queries")][:20]
    now = int(time.time())
    cfg = custom.load_config()

    # ---- baseline from the live pool (last 48 h)
    runs = live.query("SELECT count(*) AS n FROM job_runs WHERE started_at >= ? AND status IN ('ok','partial')", [now - 48 * H])[0]["n"]
    kinds = live.query("SELECT coalesce(kind,'batch') AS kind, count(*) AS calls, sum(ok) AS ok, sum(items) AS items, "
                       "sum(input_tokens) AS tin, sum(output_tokens) AS tout FROM ai_calls WHERE at >= ? GROUP BY 1",
                       [now - 48 * H])
    base = {r["kind"]: r for r in kinds}
    per_day = lambda v: (v or 0) / 2   # noqa: E731  48 h -> one day
    b1 = base.get("batch", {})
    ed = base.get("editor", {})
    tr = {k: v for k, v in base.items() if k.startswith("translate_")}
    tr_calls = sum(v["calls"] for v in tr.values())
    tr_items = sum(v["items"] or 0 for v in tr.values())
    tr_tok = sum((v["tin"] or 0) + (v["tout"] or 0) for v in tr.values())
    baseline = {
        "runs_48h": runs,
        "pass1": {"calls_day": per_day(b1.get("calls")), "in_day": per_day(b1.get("tin")), "out_day": per_day(b1.get("tout")),
                  "items_day": per_day(b1.get("items"))},
        "editor": {"calls_day": per_day(ed.get("calls")), "in_day": per_day(ed.get("tin")), "out_day": per_day(ed.get("tout")),
                   "candidates_day": per_day(ed.get("items"))},
        "translate": {"calls_day": per_day(tr_calls), "stories_day": per_day(tr_items), "tokens_day": per_day(tr_tok)},
    }
    pass1_in_per_run = (b1.get("tin") or 0) / max(1, runs)
    ed_tok_per_cand = ((ed.get("tin") or 0) + (ed.get("tout") or 0)) / max(1, ed.get("items") or 1)
    tr_tok_per_story = tr_tok / max(1, tr_items) if tr_items else 230.0

    # ---- the pool's titles of the last 24 h, for the no-AI duplicate check
    rows = live.query("SELECT id, url_hash, source_key, source_name, tier, url, title, fetched_at, status FROM items "
                      "WHERE fetched_at >= ?", [now - 24 * H])
    print(f"pool: {len(rows)} items in the last 24 h; {runs} runs in 48 h")

    results = {}
    sandbox = None
    for size in (1, 5, 20):
        topics = accepted[:size]
        db = SqliteDB()
        db.executescript((ROOT / "db" / "schema.sql").read_text(encoding="utf-8"))
        db.batch(insert_statements("items", ("id", "url_hash", "source_key", "source_name", "tier", "url", "title",
                                             "fetched_at", "status"),
                                   [(r["id"], r["url_hash"], r["source_key"], r["source_name"], r["tier"], r["url"], r["title"],
                                     r["fetched_at"], r["status"]) for r in rows]))
        requests = sum(len(t["queries"]) for t in topics)
        interval = max(1, math.ceil(requests / (cfg["max_requests_per_run"] - 2)))   # hours between two searches of a topic
        cts = [custom.CustomTopic(i + 1, f"c{i + 1}", t["names"], t["emoji"], t["definition"], t["queries"], t["boost_max"],
                                  now - interval * H, 1) for i, t in enumerate(topics)]
        all_cfg = {**cfg, "max_requests_per_run": 1000, "search_budget_s": 60}
        st = custom.Searcher(db, cfg=all_cfg, log=lambda _m: None).run(cts, now)
        per_run = st.stored / interval
        results[size] = {"topics": size, "searches": requests, "hours_between_searches": interval,
                         "window_h": custom.window_hours(now - interval * H, now, cfg), "results": st.fetched,
                         "same_as_pool": st.dup_dropped, "over_cap": st.capped, "new_items_per_search_round": st.stored,
                         "new_items_per_run": round(per_run, 1), "failed_requests": st.failed, "stopped": st.stopped,
                         "per_topic": {t["names"]["en"]: st.per_topic.get(f"c{i + 1}", {}) for i, t in enumerate(topics)}}
        print(f"{size} topics: {requests} searches, every {interval} h (when:{results[size]['window_h']}h): {st.fetched} results, "
              f"{st.dup_dropped} same as the pool, {st.capped} over the cap, {st.stored} new -> {per_run:.1f} per run"
              f"{'; ' + st.stopped if st.stopped else ''}")
        if size == 5:
            if "--reuse-sandbox" in sys.argv:   # Gemini busy: the last real sandbox answer (cost.json)
                sandbox = json.loads((OUT / "cost.json").read_text(encoding="utf-8"))["sandbox"]
                imp = sandbox["importance"]
                sandbox.setdefault("editor_floor_share", round(sum(1 for i in imp if i >= 3) / len(imp), 3))
                sandbox.setdefault("bar_share", round(sum(1 for i in imp if i >= 5) / len(imp), 3))
                print(f"sandbox reused: {sandbox['items']} items, {sandbox['stories']} stories")
            else:
                sandbox = sandbox_call(env, db, cts, now)

    # ---- per day
    s = sandbox
    in_per_item = s["in_per_item"]
    out_per_item = s["out_per_item"]
    story_share = s["stories_per_item"]
    budget = Settings().gemini_max_input_tokens
    table = {}
    # per run of the last 48 h: pass-1 input tokens and editor candidates (new ones = all minus the
    # up to 15 shown for comparison), to see when extra items need one more call
    per_run = live.query(
        "SELECT r.id, r.editor_candidates AS cands, (SELECT sum(input_tokens) FROM ai_calls a WHERE a.run_id = r.id "
        "AND coalesce(a.kind,'batch') = 'batch' AND a.ok = 1) AS p1 FROM job_runs r WHERE r.started_at >= ? "
        "AND r.status IN ('ok','partial')", [now - 48 * H])
    ed_new = Settings().editor_new
    floor_share = s["editor_floor_share"]
    for size, r in results.items():
        items_run = r["new_items_per_run"]
        items_day = items_run * 24
        p1_in, p1_out = items_day * in_per_item, items_day * out_per_item
        # pass 1: a run needs another call when its items pass the 25k-token budget of a call
        p1_extra = sum(math.ceil(((x["p1"] or 0) + items_run * in_per_item) / budget) - math.ceil((x["p1"] or 0) / budget)
                       for x in per_run) / 2
        stories_run = items_run * story_share
        ed_cands_run = stories_run * floor_share
        # editor: a second call (Gemini only) when the new candidates pass 90
        ed_extra = sum((1 if max(0, (x["cands"] or 0) - 15) + ed_cands_run > ed_new else 0)
                       - (1 if max(0, (x["cands"] or 0) - 15) > ed_new else 0) for x in per_run) / 2
        ed_tok = ed_cands_run * 24 * ed_tok_per_cand
        tr_stories = items_day * story_share * s["bar_share"]   # custom stories that may pass a bar
        tr_tok = tr_stories * tr_tok_per_story
        checks = s["check_tokens"]
        table[size] = {"new_items_day": round(items_day), "new_stories_day": round(items_day * story_share),
                       "pass1_extra_calls_day": round(p1_extra, 1), "pass1_extra_tokens_day": round(p1_in + p1_out),
                       "editor_extra_candidates_day": round(ed_cands_run * 24),
                       "editor_extra_calls_day": round(ed_extra, 1), "editor_extra_tokens_day": round(ed_tok),
                       "translate_extra_stories_day": round(tr_stories), "translate_extra_calls_day": 0,
                       "translate_extra_tokens_day_per_language": round(tr_tok),
                       "topic_check_calls_once": size, "topic_check_tokens_once": round(checks * size),
                       "total_extra_calls_day": round(p1_extra + ed_extra, 1),
                       "total_extra_tokens_day": round(p1_in + p1_out + ed_tok + tr_tok)}
    out = {"measured_at": datetime.fromtimestamp(now, timezone.utc).isoformat(), "baseline": baseline,
           "per_unit": {"pass1_in_tokens_per_google_item": in_per_item, "pass1_out_tokens_per_google_item": out_per_item,
                        "stories_per_google_item": story_share, "editor_tokens_per_candidate": round(ed_tok_per_cand),
                        "translate_tokens_per_story": round(tr_tok_per_story), "check_tokens": s["check_tokens"],
                        "pass1_in_tokens_per_run_now": round(pass1_in_per_run)},
           "searches": results, "sandbox": s, "per_day": table}
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "cost.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("\nbaseline per day:", json.dumps(baseline))
    print("per unit:", json.dumps(out["per_unit"]))
    print("\n| Custom topics | New Google items/day | New stories/day | Extra AI calls/day | Extra tokens/day | One-time checks |")
    print("|---|---|---|---|---|---|")
    for size, t in table.items():
        print(f"| {size} | {t['new_items_day']} | {t['new_stories_day']} | {t['total_extra_calls_day']} | "
              f"{t['total_extra_tokens_day']:,} | {t['topic_check_calls_once']} calls, {t['topic_check_tokens_once']:,} tokens |")
    return 0


def sandbox_call(env: dict, db, cts: list, now: int) -> dict:
    """One real pass-1 call on the new Google items (in-memory; nothing is written to D1)."""
    items = db.query("SELECT id, source_name, tier, url, title, snippet, published_at, fetched_at, headline_only FROM items "
                     "WHERE source_key = 'gnews' ORDER BY id")[:200]
    prompt = load_prompt()
    topics = load_topics() + [t.as_topic() for t in cts]
    today = datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d")
    text = ai.render_prompt(prompt.template, today=today, topics=topics, facts=prompt.facts,
                            facts_checked=prompt.facts_checked, existing=[], items=items)
    fixed = ai.render_prompt(prompt.template, today=today, topics=topics, facts=prompt.facts,
                             facts_checked=prompt.facts_checked, existing=[], items=[])
    res = None
    for model in (env.get("GEMINI_MODEL") or "gemini-3.5-flash-lite", env.get("GEMINI_FALLBACK_MODEL") or "gemini-3.1-flash-lite"):
        g = ai.GeminiProvider(env["GEMINI_API_KEY"], model)
        try:
            fixed_tokens = g.count_tokens(fixed)
            res = g.generate(text, prompt.schema)
            break
        except ai.AIError as exc:   # "high demand": the job would try the second model too
            print(f"sandbox: {model}: {exc}")
    if res is None:
        raise SystemExit("sandbox call failed on both Gemini models; try again later")
    data = ai.parse_json(res.text)
    tags = [t["tag"] for t in topics]
    stories = ai.validate_stories(data, {i["id"] for i in items}, set(), tags)
    custom_tags = {t.tag for t in cts}
    placed = sum(len(s.item_ids) for s in stories)
    on_custom = [s for s in stories if set(s.topics) & custom_tags]
    checks = json.loads((OUT / "checks.json").read_text(encoding="utf-8"))
    ok = [c for c in checks if c.get("input_tokens")]
    check_tokens = sum((c["input_tokens"] or 0) + (c["output_tokens"] or 0) for c in ok) / max(1, len(ok))
    out = {"items": len(items), "input_tokens": res.input_tokens, "output_tokens": res.output_tokens,
           "fixed_prompt_tokens": fixed_tokens, "stories": len(stories), "items_placed": placed,
           "not_news": len(items) - placed, "stories_on_custom_topics": len(on_custom),
           "importance": sorted((s.importance for s in on_custom), reverse=True),
           "in_per_item": round((res.input_tokens - fixed_tokens) / max(1, len(items)), 1),
           "out_per_item": round(res.output_tokens / max(1, len(items)), 1),
           "stories_per_item": round(len(stories) / max(1, len(items)), 3), "check_tokens": round(check_tokens),
           # share of the new stories at the editor's floor for custom topics (first-pass 3+), and at 5+
           # (with a +2 cap, a story needs about 4-5 to pass the topic bar of 6; an upper bound for translation)
           "editor_floor_share": round(sum(1 for s in stories if s.importance >= 3) / max(1, len(stories)), 3),
           "bar_share": round(sum(1 for s in stories if s.importance >= 5) / max(1, len(stories)), 3),
           "examples": [{"summary": s.summary, "topics": s.topics, "importance": s.importance} for s in on_custom[:12]]}
    print(f"sandbox pass 1: {len(items)} Google items, {res.input_tokens} in ({fixed_tokens} fixed) / {res.output_tokens} out, "
          f"{len(stories)} stories ({len(on_custom)} on custom topics), {len(items) - placed} not news")
    return out


if __name__ == "__main__":
    raise SystemExit(main())
