"""Feasibility probe for Google News RSS search feeds (Step 6). Read-only: touches no database.

    venv/Scripts/python scripts/gnews_probe.py [--json out.json] [--no-resolve]

Run on the PC and on a GitHub runner (workflow "gnews probe") to compare. It checks:
  1. editions: does an English, Russian and Armenian edition answer, and in which language;
  2. every query in config/gnews_queries.yaml with when:2h and when:1d: HTTP status, time,
     items, how fresh, whether there are snippets;
  3. a burst like the hourly job's (all queries at once, 8 in parallel): any 429/503 or block;
  4. resolving a few news.google.com links to the real article URL: success and time.
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from job import gnews  # noqa: E402

SCRIPTS = {"latin": re.compile(r"[A-Za-z]"), "cyrillic": re.compile(r"[Ѐ-ӿ]"),
           "armenian": re.compile(r"[԰-֏]")}
EDITION_TESTS = [
    ("Armenia", "en-US", "US", "US:en"),
    ("Armenia", "en-GB", "GB", "GB:en"),
    ("Армения", "ru", "RU", "RU:ru"),
    ("Армения", "ru", "UA", "UA:ru"),
    ("Армения", "en-US", "US", "US:en"),
    ("Հայաստան", "hy", "AM", "AM:hy"),
    ("Հայաստան", "hy-AM", "AM", "AM:hy"),
    ("Հայաստան", "en-US", "US", "US:en"),
    ("Armenia", "hy", "AM", "AM:hy"),
    ("Pashinyan", "en-US", "US", "US:en"),
]


def script_mix(titles: list[str]) -> dict[str, int]:
    out = {k: 0 for k in SCRIPTS}
    for t in titles:
        counts = {k: len(r.findall(t)) for k, r in SCRIPTS.items()}
        out[max(counts, key=counts.get)] += 1
    return out


def describe(f: gnews.Fetched, now: int) -> dict:
    ages = [(now - i.published_at) / 3600 for i in f.items if i.published_at]
    return {
        "key": f.query.get("key") or f.query["q"], "q": f.query["q"],
        "edition": f"{f.query['hl']}/{f.query['gl']}/{f.query['ceid']}",
        "status": f.status, "error": f.error, "ms": f.ms, "items": len(f.items),
        "within_1h": sum(1 for a in ages if a <= 1), "within_2h": sum(1 for a in ages if a <= 2),
        "within_24h": sum(1 for a in ages if a <= 24),
        "newest_h": round(min(ages), 2) if ages else None,
        "median_age_h": round(statistics.median(ages), 2) if ages else None,
        "with_snippet": sum(1 for i in f.items if i.has_snippet),
        "scripts": script_mix([i.title for i in f.items]),
        "sources": len({i.source for i in f.items}),
        "sample": [f"{i.title} | {i.source}" for i in f.items[:3]],
    }


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", help="write all results to this file")
    ap.add_argument("--no-resolve", action="store_true")
    args = ap.parse_args()
    cfg = gnews.load_queries()
    queries = gnews.query_list(cfg)
    s = requests.Session()
    now = int(time.time())
    out: dict = {"at": now, "editions": [], "queries_2h": [], "queries_1d": [], "burst": {}, "resolve": []}

    print("== 1. editions (no time window)")
    for q, hl, gl, ceid in EDITION_TESTS:
        f = gnews.fetch({"q": q, "hl": hl, "gl": gl, "ceid": ceid}, None, timeout=15, session=s)
        d = describe(f, now)
        out["editions"].append(d)
        print(f"  {q:10} {d['edition']:18} HTTP {d['status']} {d['ms']:5} ms  items {d['items']:3}  "
              f"scripts {d['scripts']}  newest {d['newest_h']} h  sample: {d['sample'][:1]}")
        time.sleep(1)

    for window, bucket in (("2h", "queries_2h"), ("1d", "queries_1d")):
        print(f"== 2. every configured query, when:{window} (one at a time)")
        for q in queries:
            f = gnews.fetch(q, window, timeout=15, session=s)
            d = describe(f, now)
            out[bucket].append(d)
            print(f"  {d['key']:18} HTTP {d['status']} {d['ms']:5} ms  items {d['items']:3}  "
                  f"<=1h {d['within_1h']:3} <=2h {d['within_2h']:3}  newest {d['newest_h']} h  "
                  f"snippets {d['with_snippet']}  {d['q']}")
            time.sleep(0.5)

    print("== 3. burst: all queries at once, 8 in parallel (like the hourly shadow step), twice")
    for rnd in (1, 2):
        t = time.time()
        with ThreadPoolExecutor(max_workers=8) as pool:
            res = list(pool.map(lambda q: gnews.fetch(q, cfg.get("window"), timeout=10), queries))
        codes: dict[str, int] = {}
        for r in res:
            codes[str(r.status or r.error)] = codes.get(str(r.status or r.error), 0) + 1
        out["burst"][f"round{rnd}"] = {"requests": len(res), "seconds": round(time.time() - t, 2),
                                       "codes": codes, "items": sum(len(r.items) for r in res),
                                       "max_ms": max(r.ms for r in res)}
        print(f"  round {rnd}: {len(res)} requests in {time.time() - t:.1f} s, codes {codes}, "
              f"items {sum(len(r.items) for r in res)}, slowest {max(r.ms for r in res)} ms")

    if not args.no_resolve:
        print("== 4. resolve news.google.com links to the article URL")
        f = gnews.fetch(queries[0], "1d", timeout=15, session=s)
        for item in f.items[:6]:
            t = time.time()
            try:
                url, err = gnews.resolve(item.link, session=s), None
            except Exception as exc:
                url, err = None, f"{type(exc).__name__}: {exc}"
            ms = int((time.time() - t) * 1000)
            match = bool(url) and gnews.domain(url).endswith(gnews.domain(item.source_url) or "?")
            out["resolve"].append({"source": item.source, "ms": ms, "url": url, "error": err,
                                   "domain_matches_source": match})
            print(f"  {ms:5} ms  {item.source:25} -> {url or err}  (domain matches source: {match})")
            time.sleep(1)

    if args.json:
        Path(args.json).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"written {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
