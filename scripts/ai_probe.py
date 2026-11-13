"""Real-world AI check (dev tool). Stores nothing in the database.

Builds one realistic hourly batch from the live feeds: items from the last hour (8 per feed
cap) as NEW ITEMS, plus up to 250 older headlines (1-4 h old) standing in for EXISTING STORIES,
since the pool is empty before the first run. Then:

    small    one tiny real call to each provider
    gemini   count tokens, send the full batch to Gemini once
    groq     send the full batch to Groq (expected to be refused: TPM), then ~6k-token chunks

Usage:  venv/Scripts/python scripts/ai_probe.py small|gemini|groq [--out DIR] [--chunks N]
Never prints keys. Raw model output is written to --out (default: not saved).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job import ai  # noqa: E402
from job.config import Settings, load_env, load_prompt, load_sources, load_topics  # noqa: E402
from job.fetch import candidates, fetch_all, select_new  # noqa: E402


def build_batch(settings: Settings):
    now = int(time.time())
    results = fetch_all(load_sources(), workers=settings.fetch_workers, timeout=settings.fetch_timeout_s,
                        snippet_chars=settings.snippet_chars, now=now)
    failed = [r.source["key"] for r in results if r.error]
    new = select_new(candidates(results, now - 3600), set(), settings.max_items_per_feed)
    new_hashes = {e.url_hash for e in new}
    older = [e for e in candidates(results, now - 4 * 3600)
             if e.url_hash not in new_hashes and (e.published_at or now) < now - 3600]
    older = select_new(older, set(), 4)[:settings.existing_max]
    src_topics = {s["key"]: s["topics"] for s in load_sources()}
    items = [{"id": i + 1, "source_name": e.source_name, "tier": e.tier, "title": e.title,
              "snippet": e.snippet} for i, e in enumerate(new)]
    existing = [{"id": 10000 + i, "topics": json.dumps(src_topics[e.source_key][:2]), "summary": e.title}
                for i, e in enumerate(older)]
    return items, existing, failed


def render(items, existing):
    p = load_prompt()
    topics = load_topics()
    return ai.render_prompt(p.template, today=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
                            topics=topics, facts=p.facts, facts_checked=p.facts_checked,
                            existing=existing, items=items), p.schema


def report_result(label, res: ai.CallResult, items, existing, out: Path | None):
    data = ai.parse_json(res.text)
    stories = ai.validate_stories(data, {i["id"] for i in items}, {s["id"] for s in existing},
                                  [t["tag"] for t in load_topics()])
    placed = sum(len(s.item_ids) for s in stories)
    merged = sum(1 for s in stories if s.existing_story_id)
    placed_ids = {i for s in stories for i in s.item_ids}
    not_news = {int(i) for i in data.get("not_news_ids") or []} & ({i["id"] for i in items} - placed_ids)
    print(f"{label}: OK {res.ms} ms | in {res.input_tokens} out {res.output_tokens} "
          f"(extra {res.extra}) | finish {res.finish} | raw stories {len(data['stories'])}, valid "
          f"{len(stories)}, merged into existing {merged}, items placed {placed}/{len(items)}, "
          f"not-news {len(not_news)}, unaccounted {len(items) - placed - len(not_news)}, "
          f"empty summaries {sum(1 for s in stories if not s.summary and not s.existing_story_id)}")
    if out:
        out.mkdir(parents=True, exist_ok=True)
        (out / f"{label}.json").write_text(res.text, encoding="utf-8")
    return stories


def main() -> int:
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["small", "gemini", "groq"])
    ap.add_argument("--out", type=Path)
    ap.add_argument("--chunks", type=int, default=3, help="Groq chunks to send in 'groq' mode")
    args = ap.parse_args()
    env = load_env()
    settings = Settings()
    gem = ai.GeminiProvider(env["GEMINI_API_KEY"], env.get("GEMINI_MODEL") or "gemini-3.5-flash-lite")
    groq = ai.GroqProvider(env["GROQ_API_KEY"], env.get("GROQ_MODEL") or "openai/gpt-oss-120b")
    print("checked at", datetime.now(timezone.utc).isoformat(timespec="seconds"))

    if args.mode == "small":
        names = [m["name"] for m in gem.list_models()]
        print("gemini model listed:", f"models/{gem.model}" in names)
        schema = {"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"]}
        for p in (gem, groq):
            try:
                r = p.generate("Reply with JSON: the capital of Armenia.", schema)
                print(f"{p.name} {p.model}: OK {r.ms} ms, in {r.input_tokens} out {r.output_tokens}, "
                      f"finish {r.finish}, text {r.text.strip()[:80]!r}")
            except ai.AIError as e:
                print(f"{p.name} {p.model}: FAILED {e} (kind {e.kind})")
        print("groq limits:", groq.limits)
        return 0

    t0 = time.time()
    items, existing, failed = build_batch(settings)
    prompt, schema = render(items, existing)
    print(f"batch built in {time.time() - t0:.1f}s: {len(items)} new items, {len(existing)} existing "
          f"stand-ins, {len(failed)} feeds failed {failed}")
    print(f"prompt: {len(prompt)} chars, estimated {ai.estimate_tokens(prompt)} tokens")

    if args.mode == "gemini":
        print("gemini countTokens:", gem.count_tokens(prompt))
        try:
            report_result("gemini_full", gem.generate(prompt, schema), items, existing, args.out)
        except (ai.AIError, ValueError) as e:
            print("gemini_full: FAILED", e)
        return 0

    # groq
    try:
        report_result("groq_full", groq.generate(prompt, schema), items, existing, args.out)
    except (ai.AIError, ValueError) as e:
        print(f"groq_full: FAILED {e} | retry_after {getattr(e, 'retry_after', None)}")
    print("groq limits after full:", groq.limits)
    p = load_prompt()
    small_existing = existing[:settings.groq_existing_max]
    fixed = ai.estimate_tokens(render([], small_existing)[0])
    chunks = ai.make_chunks(items, settings.groq_chunk_tokens, fixed)
    print(f"groq chunking: fixed part ~{fixed} tokens, {len(chunks)} chunks of "
          f"{[len(c) for c in chunks]} items; sending first {args.chunks}")
    for n, chunk in enumerate(chunks[:args.chunks], 1):
        cp, _ = render(chunk, small_existing)
        est = ai.estimate_tokens(cp) + groq.max_output_tokens
        waited = groq.wait_for_tokens(est)
        try:
            report_result(f"groq_chunk{n}", groq.generate(cp, schema), chunk, small_existing, args.out)
        except (ai.AIError, ValueError) as e:
            print(f"groq_chunk{n}: FAILED {e} | retry_after {getattr(e, 'retry_after', None)}")
        print(f"   waited {waited:.0f}s before; limits now {groq.limits}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
