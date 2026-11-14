"""What would the first AI pass cost this hour with and without the Step 7 feeds? (dev tool)

    venv/Scripts/python scripts/source_dry_run.py
    venv/Scripts/python scripts/source_dry_run.py --without news_am_ru,am168   # "old" = all minus these

Read only: fetches the real feeds once, reads from D1 which URLs are already stored and the real
existing stories (the same 250 the AI would see), and asks Gemini to COUNT the tokens of the real
prompts (countTokens; no answer is generated, nothing is written anywhere).

"old" = config/sources.yaml without the Step 7 feeds (or without --without), all at the old cap
of 8. "new" = the whole file with its per-feed caps. Feeds never stored before would look like a
first run (their whole 2 h window is new), so for a steady-state hour their items published
before the last real run are treated as already seen. Output tokens are estimated with the
Step 6 measurement (about 48 per item). Never prints keys.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job import ai  # noqa: E402
from job.config import Settings, load_env, load_sources  # noqa: E402
from job.d1 import D1, in_list_statements  # noqa: E402
from job.fetch import candidates, feed_caps, fetch_all, select_new  # noqa: E402
from job.run import Job  # noqa: E402

STEP7 = ["news_am_ru", "factor_am", "aravot", "am168", "a1plus", "arminfo_en", "civilnet_hy", "hetq_hy"]
OUT_PER_ITEM = 48


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--without", default=",".join(STEP7), help="feed keys left out of the 'old' set")
    ap.add_argument("--budget", type=int, default=None, help="per-call token budget to try (default: Settings)")
    args = ap.parse_args()
    s = Settings()
    budget = args.budget or s.gemini_max_input_tokens
    env = load_env()
    db = D1(env["CLOUDFLARE_ACCOUNT_ID"], env["D1_DATABASE_ID"], env["CLOUDFLARE_D1_TOKEN"], timeout=60)
    gem = ai.GeminiProvider(env["GEMINI_API_KEY"], env.get("GEMINI_MODEL") or "gemini-3.5-flash-lite")
    job = Job(db, [], settings=s, log=lambda *_: None)
    now = int(time.time())
    since = job.lookback_since(now)
    last = db.query("SELECT max(started_at) AS t FROM job_runs WHERE status IN ('ok','partial','ai_failed')")[0]["t"]
    new_keys = {k for k in args.without.split(",") if k}
    sources = load_sources()
    t0 = time.time()
    results = fetch_all(sources, workers=s.fetch_workers, timeout=s.fetch_timeout_s, snippet_chars=s.snippet_chars,
                        now=now)
    fetch_s = time.time() - t0
    failed = [r.source["key"] for r in results if r.error]
    entries = candidates(results, since)
    seen: set[str] = set()
    for rows in db.batch(in_list_statements("SELECT url_hash FROM items WHERE url_hash IN ({qs})",
                                            [e.url_hash for e in entries])):
        seen.update(r["url_hash"] for r in rows)
    steady = {e.url_hash for e in entries if e.source_key in new_keys and e.published_at and e.published_at < last}
    existing = job.load_existing(now, s.existing_max)
    fixed = ai.estimate_tokens(job.render([], existing, now))
    fixed_real = gem.count_tokens(job.render([], existing, now))
    print(f"now {time.strftime('%Y-%m-%d %H:%M', time.gmtime(now))} UTC, window {(now - since) / 3600:.1f} h, "
          f"last run {(now - last) / 60:.0f} min ago; fetch {fetch_s:.1f}s, failed feeds {failed or 'none'}")
    print(f"fixed part (prompt + {len(existing)} existing stories): {fixed_real} Gemini tokens (est {fixed})")

    def scenario(label: str, keys_out: set[str], caps: dict | None):
        es = [e for e in entries if e.source_key not in keys_out]
        cut: dict = {}
        picked = select_new(es, seen | steady, s.max_items_per_feed, caps, cut)
        items = [{"id": n + 1, "source_name": e.source_name, "tier": e.tier, "title": e.title, "snippet": e.snippet,
                  "source_key": e.source_key} for n, e in enumerate(picked)]
        chunks = ai.make_chunks(items, budget, fixed)
        real = [gem.count_tokens(job.render(c, existing, now)) for c in chunks]
        per_feed: dict[str, int] = {}
        for i in items:
            per_feed[i["source_key"]] = per_feed.get(i["source_key"], 0) + 1
        arm = {k: v for k, v in per_feed.items() if k in new_keys or k.startswith(("news_am", "azat"))}
        print(f"\n[{label}] items {len(items)}, calls {len(chunks)}, input tokens {sum(real)} "
              f"(per call {real}), est. output {len(items) * OUT_PER_ITEM}")
        print(f"   Armenian-language feeds' items: {arm}")
        if cut:
            print(f"   cap cut: {dict(sorted(cut.items()))}")
        return len(items), len(chunks), sum(real)

    a = scenario("old: without the Step 7 feeds, cap 8", new_keys, None)
    b = scenario("new: Step 7 feeds and per-feed caps", set(), feed_caps(sources))
    print(f"\nextra this hour: items +{b[0] - a[0]}, calls +{b[1] - a[1]}, input tokens +{b[2] - a[2]} "
          f"({(b[2] - a[2]) / a[2] * 100:+.0f}%), est. output +{(b[0] - a[0]) * OUT_PER_ITEM}")
    print(f"D1 rows read {db.rows_read}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
