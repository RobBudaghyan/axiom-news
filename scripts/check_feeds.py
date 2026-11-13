"""Re-check every RSS/Atom feed in config/sources.yaml and print a health table.

A feed is OK when: HTTP 200, it parses as RSS or Atom, it has entries, its newest
entry is at most --max-age-days old, and at least 80% of entries have an http(s) link.

Usage (from the project folder):
    venv/Scripts/python scripts/check_feeds.py                 # check config/sources.yaml
    venv/Scripts/python scripts/check_feeds.py --file other.yaml --json out.json

Exit code: 0 if every feed is OK, 1 if any failed.
"""
from __future__ import annotations

import argparse
import calendar
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import feedparser
import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)
MIN_LINK_SHARE = 0.8
DEFAULT_FILE = ROOT / "config" / "sources.yaml"
REQUIRED = {"key": str, "name": str, "url": str, "region": str, "language": str,
            "topics": list, "paywalled": bool, "state_owned": bool, "tier": int}


def validate(sources: list[dict]) -> list[str]:
    """Check config/sources.yaml fields: required keys/types, unique keys and URLs,
    tier 1-3, topic tags that exist in config/topics.yaml."""
    topics = {t["tag"] for t in yaml.safe_load(
        (ROOT / "config" / "topics.yaml").read_text(encoding="utf-8"))["topics"]}
    problems, keys, urls = [], set(), set()
    for s in sources:
        label = s.get("key", s.get("name", "?"))
        for field, typ in REQUIRED.items():
            if not isinstance(s.get(field), typ):
                problems.append(f"{label}: field '{field}' missing or not {typ.__name__}")
        if s.get("tier") not in (1, 2, 3):
            problems.append(f"{label}: tier must be 1, 2 or 3")
        for tag in s.get("topics") or []:
            if tag not in topics:
                problems.append(f"{label}: unknown topic '{tag}'")
        for seen, value, what in ((keys, s.get("key"), "key"), (urls, s.get("url"), "url")):
            if value in seen:
                problems.append(f"{label}: duplicate {what}")
            seen.add(value)
    return problems


def entry_time(entry) -> float | None:
    """Entry timestamp (UTC epoch seconds) from published or updated date, if any."""
    for key in ("published_parsed", "updated_parsed"):
        parsed = entry.get(key)
        if parsed:
            return calendar.timegm(parsed)
    return None


def check(source: dict, timeout: float, max_age_days: float) -> dict:
    result = {"key": source.get("key"), "name": source["name"], "url": source["url"],
              "region": source.get("region", ""), "ok": False, "entries": 0,
              "newest_h": None, "last_24h": 0, "note": ""}
    try:
        resp = requests.get(source["url"], timeout=timeout,
                            headers={"User-Agent": USER_AGENT,
                                     "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*"})
    except requests.RequestException as exc:
        result["note"] = f"fetch error: {type(exc).__name__}"
        return result
    if resp.status_code != 200:
        result["note"] = f"HTTP {resp.status_code}"
        return result

    feed = feedparser.parse(resp.content, response_headers={
        "content-type": resp.headers.get("content-type", "")})
    entries = feed.entries
    result["entries"] = len(entries)
    if not feed.version:
        result["note"] = "not RSS/Atom"
        return result
    if not entries:
        result["note"] = "no entries"
        return result

    now = time.time()
    times = [t for t in (entry_time(e) for e in entries) if t is not None]
    if not times:
        result["note"] = "entries have no dates"
        return result
    newest_h = max(0.0, (now - max(times)) / 3600)
    result["newest_h"] = round(newest_h, 1)
    result["last_24h"] = sum(1 for t in times if now - t <= 86400)
    # Estimated items/day. If the whole feed fits inside 24h, the 24h count is capped by
    # the feed's length, so extrapolate from the time span the feed covers instead.
    span_h = (max(times) - min(times)) / 3600
    if result["last_24h"] == len(times) and len(times) > 5 and span_h > 0.5:
        result["per_day"] = round(len(times) / span_h * 24)
    else:
        result["per_day"] = result["last_24h"]

    with_links = sum(1 for e in entries if str(e.get("link", "")).startswith(("http://", "https://")))
    if with_links / len(entries) < MIN_LINK_SHARE:
        result["note"] = f"only {with_links}/{len(entries)} entries have links"
        return result
    if newest_h > max_age_days * 24:
        result["note"] = f"stale: newest item {newest_h / 24:.0f} days old"
        return result

    result["ok"] = True
    notes = []
    if feed.bozo:
        notes.append("minor XML issues")
    if result["per_day"] != result["last_24h"]:
        notes.append("feed holds < 24h; ~/DAY estimated")
    result["note"] = ", ".join(notes)
    return result


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--file", default=str(DEFAULT_FILE))
    parser.add_argument("--timeout", type=float, default=20)
    parser.add_argument("--max-age-days", type=float, default=7)
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--json", help="also write full results to this JSON file")
    args = parser.parse_args()

    sources = yaml.safe_load(Path(args.file).read_text(encoding="utf-8"))["sources"]
    problems = validate(sources) if Path(args.file).resolve() == DEFAULT_FILE else []
    for p in problems:
        print(f"CONFIG ERROR: {p}")
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(lambda s: check(s, args.timeout, args.max_age_days), sources))

    print(f"{'STATUS':6} {'KEY':20} {'NAME':26} {'ITEMS':>5} {'NEWEST':>7} {'24H':>4} {'~/DAY':>5}  NOTE")
    for r in results:
        newest = f"{r['newest_h']}h" if r["newest_h"] is not None else "-"
        print(f"{'OK' if r['ok'] else 'FAIL':6} {str(r['key'])[:20]:20} {r['name'][:26]:26} "
              f"{r['entries']:>5} {newest:>7} {r['last_24h']:>4} {r.get('per_day', 0):>5}  {r['note']}")
    ok = [r for r in results if r["ok"]]
    print(f"\n{len(ok)}/{len(results)} feeds OK. Across OK feeds: "
          f"{sum(r['last_24h'] for r in ok)} items seen from the last 24h; "
          f"estimated total ~{sum(r['per_day'] for r in ok)} items/day.")

    if args.json:
        Path(args.json).write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0 if len(ok) == len(results) and not problems else 1


if __name__ == "__main__":
    sys.exit(main())
