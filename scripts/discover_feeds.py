"""Find RSS/Atom feeds of news sites (dev tool, Step 7). Reads, never writes to the database.

    venv/Scripts/python scripts/discover_feeds.py https://news.am https://armenpress.am ...
    venv/Scripts/python scripts/discover_feeds.py --paths /ru/rss /hy/rss -- https://example.am

For each site: fetch the home page (and any extra --pages), collect <link rel="alternate">
feed links and every link whose address mentions rss/feed, add common feed paths, then fetch each
candidate and keep the ones that parse as RSS/Atom with entries. Prints, per working feed: the
final URL, entries, newest entry age, items per hour over the feed's own time span, and a few
titles. With --save DIR, the raw pages are saved there (keep that outside the repo).
"""
from __future__ import annotations

import argparse
import calendar
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import feedparser
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from job.fetch import ACCEPT, USER_AGENT  # noqa: E402

COMMON = ["/rss", "/rss/", "/feed", "/feed/", "/rss.xml", "/feed.xml", "/index.xml", "/rss/all",
          "/en/rss", "/ru/rss", "/hy/rss", "/am/rss", "/arm/rss", "/rus/rss", "/eng/rss",
          "/ru/feed", "/hy/feed", "/en/feed", "/rss/news", "/export/rss2/archive/index.xml"]
LINK_RE = re.compile(r"""<link[^>]+>""", re.I)
HREF_RE = re.compile(r"""href\s*=\s*["']([^"']+)["']""", re.I)
A_RE = re.compile(r"""<a[^>]+href\s*=\s*["']([^"']*(?:rss|feed)[^"']*)["']""", re.I)


def get(url: str, timeout: float):
    try:
        return requests.get(url, timeout=timeout, headers={"User-Agent": USER_AGENT, "Accept": ACCEPT})
    except requests.RequestException as exc:
        return exc


def candidates_from(page_url: str, html: str) -> set[str]:
    out = set()
    for tag in LINK_RE.findall(html):
        low = tag.lower()
        if "alternate" in low and ("rss" in low or "atom" in low):
            m = HREF_RE.search(tag)
            if m:
                out.add(urljoin(page_url, m.group(1)))
    for href in A_RE.findall(html):
        if not href.startswith(("mailto:", "javascript:")):
            out.add(urljoin(page_url, href))
    return out


def probe(url: str, timeout: float) -> dict | None:
    resp = get(url, timeout)
    if isinstance(resp, Exception) or resp.status_code != 200:
        return None
    feed = feedparser.parse(resp.content, response_headers={"content-type": resp.headers.get("content-type", "")})
    if not feed.version or not feed.entries:
        return None
    now = time.time()
    times = sorted((calendar.timegm(e[k]) for e in feed.entries for k in ("published_parsed", "updated_parsed")
                    if e.get(k)), reverse=True)
    times = sorted(set(times), reverse=True)
    span_h = (times[0] - times[-1]) / 3600 if len(times) > 1 else 0
    return {"url": url, "final_url": resp.url, "entries": len(feed.entries), "lang": feed.feed.get("language"),
            "newest_h": round((now - times[0]) / 3600, 1) if times else None,
            "per_hour": round(len(times) / span_h, 1) if span_h > 0.2 else None,
            "last_24h": sum(1 for t in times if now - t <= 86400),
            "titles": [str(e.get("title", ""))[:90] for e in feed.entries[:5]]}


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sites", nargs="+")
    ap.add_argument("--paths", nargs="*", default=[], help="extra paths to try on every site")
    ap.add_argument("--pages", nargs="*", default=[], help="extra pages to scan for feed links")
    ap.add_argument("--timeout", type=float, default=15)
    ap.add_argument("--save", help="save raw home pages to this folder (outside the repo)")
    ap.add_argument("--json", help="write results to this JSON file")
    args = ap.parse_args()
    results = {}
    for site in args.sites:
        cands: set[str] = set()
        for page in [site, *[urljoin(site, p) for p in args.pages]]:
            resp = get(page, args.timeout)
            if isinstance(resp, Exception):
                print(f"{page}: {type(resp).__name__}")
                continue
            print(f"{page}: HTTP {resp.status_code} -> {resp.url}")
            if args.save:
                Path(args.save).mkdir(parents=True, exist_ok=True)
                (Path(args.save) / (urlsplit(page).netloc + urlsplit(page).path.replace("/", "_") + ".html")
                 ).write_bytes(resp.content)
            cands |= candidates_from(resp.url, resp.text)
        base = f"{urlsplit(site).scheme}://{urlsplit(site).netloc}"
        cands |= {base + p for p in COMMON + args.paths}
        with ThreadPoolExecutor(max_workers=12) as pool:
            found = [r for r in pool.map(lambda u: probe(u, args.timeout), sorted(cands)) if r]
        seen, uniq = set(), []
        for r in found:
            key = (r["final_url"], r["titles"][0] if r["titles"] else "")
            if key not in seen:
                seen.add(key)
                uniq.append(r)
        results[site] = uniq
        print(f"  {len(cands)} candidates, {len(uniq)} working feeds")
        for r in uniq:
            print(f"  FEED {r['final_url']}  entries {r['entries']}  newest {r['newest_h']}h  "
                  f"{r['per_hour']}/h  24h {r['last_24h']}  lang {r['lang']}")
            for t in r["titles"][:3]:
                print(f"       - {t}")
    if args.json:
        Path(args.json).write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
