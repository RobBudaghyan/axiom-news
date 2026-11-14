"""Fetch all RSS/Atom feeds and turn entries into candidate items."""
from __future__ import annotations

import calendar
import hashlib
import html
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import feedparser
import requests

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)
ACCEPT = "application/rss+xml, application/atom+xml, application/xml, text/xml, */*"
TRACKING_PARAMS = re.compile(r"^(utm_.*|fbclid|gclid|ocid|cmpid|at_medium|at_campaign|"
                             r"at_link|at_ptr|at_format|at_bbc_team|ns_.*|guccounter|smid|rss)$", re.I)
TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")


@dataclass
class Entry:
    source_key: str
    source_name: str
    tier: int
    url: str
    url_hash: str
    title: str
    snippet: str
    published_at: int | None


@dataclass
class FeedResult:
    source: dict
    entries: list[Entry]
    error: str | None = None


def normalize_url(url: str) -> str:
    """Lower-case scheme/host, drop the #fragment, tracking parameters and a trailing slash,
    so the same article seen twice gets the same hash."""
    parts = urlsplit(url.strip())
    query = urlencode([(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                       if not TRACKING_PARAMS.match(k)])
    path = parts.path.rstrip("/") or "/"
    host = parts.netloc.lower()
    if host.endswith(":443") or host.endswith(":80"):
        host = host.rsplit(":", 1)[0]
    return urlunsplit((parts.scheme.lower(), host, path, query, ""))


def url_hash(url: str) -> str:
    return hashlib.sha256(normalize_url(url).encode("utf-8")).hexdigest()


def clean_text(value: str | None) -> str:
    text = TAG_RE.sub(" ", value or "")
    text = html.unescape(text)
    return SPACE_RE.sub(" ", text).strip()


def make_snippet(description: str, title: str, limit: int) -> str:
    text = clean_text(description)
    if text.lower().startswith(title.lower()):        # many feeds repeat the title
        text = text[len(title):].lstrip(" .:-")
    if len(text) <= limit:
        return text
    cut = text[:limit]
    if " " in cut[limit // 2:]:
        cut = cut[:cut.rfind(" ")]
    return cut + "..."


def entry_time(entry) -> int | None:
    for key in ("published_parsed", "updated_parsed"):
        parsed = entry.get(key)
        if parsed:
            return int(calendar.timegm(parsed))
    return None


def parse_feed(source: dict, content: bytes, content_type: str, snippet_chars: int,
               now: int) -> list[Entry]:
    feed = feedparser.parse(content, response_headers={"content-type": content_type})
    out = []
    for e in feed.entries:
        link = str(e.get("link", "")).strip()
        title = clean_text(e.get("title"))[:300]
        if not link.startswith(("http://", "https://")) or not title:
            continue
        published = entry_time(e)
        if published is not None and published > now + 3600:   # bogus future dates
            published = now
        out.append(Entry(
            source_key=source["key"], source_name=source["name"], tier=int(source["tier"]),
            url=link, url_hash=url_hash(link), title=title,
            snippet=make_snippet(e.get("summary") or e.get("description") or "", title, snippet_chars),
            published_at=published,
        ))
    return out


def fetch_feed(source: dict, *, timeout: float, snippet_chars: int, now: int,
               session: requests.Session | None = None) -> FeedResult:
    get = (session or requests).get
    try:
        resp = get(source["url"], timeout=timeout, headers={"User-Agent": USER_AGENT, "Accept": ACCEPT})
    except requests.RequestException as exc:
        return FeedResult(source, [], f"fetch error: {type(exc).__name__}")
    if resp.status_code != 200:
        return FeedResult(source, [], f"HTTP {resp.status_code}")
    try:
        entries = parse_feed(source, resp.content, resp.headers.get("content-type", ""), snippet_chars, now)
    except Exception as exc:  # feedparser is forgiving; this is a last resort
        return FeedResult(source, [], f"parse error: {type(exc).__name__}")
    if not entries:
        return FeedResult(source, [], "no usable entries")
    return FeedResult(source, entries)


def fetch_all(sources: list[dict], *, workers: int, timeout: float, snippet_chars: int,
              now: int) -> list[FeedResult]:
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(lambda s: fetch_feed(s, timeout=timeout, snippet_chars=snippet_chars,
                                                  now=now), sources))


def candidates(results: list[FeedResult], since: int) -> list[Entry]:
    """Entries inside the lookback window, de-duplicated by URL across feeds. Feeds are taken
    best tier first, so when two feeds carry the same URL the better-tier copy is kept.
    Undated entries are kept (they are still capped per feed and checked against seen URLs)."""
    seen: set[str] = set()
    out = []
    for r in sorted(results, key=lambda r: r.source["tier"]):
        for e in r.entries:
            if e.published_at is not None and e.published_at < since:
                continue
            if e.url_hash in seen:
                continue
            seen.add(e.url_hash)
            out.append(e)
    return out


def select_new(entries: list[Entry], already_seen: set[str], cap: int) -> list[Entry]:
    """Drop URLs already stored, then keep only the `cap` newest entries per feed."""
    by_feed: dict[str, list[Entry]] = {}
    for e in entries:
        if e.url_hash not in already_seen:
            by_feed.setdefault(e.source_key, []).append(e)
    out = []
    for feed_entries in by_feed.values():
        feed_entries.sort(key=lambda e: e.published_at or 0, reverse=True)
        out.extend(feed_entries[:cap])
    return out


def feed_health(prev: dict | None, results: list[FeedResult], now: int) -> dict:
    """Per-feed health for the Admin tab, kept in one `meta` row (key feed_health) so it costs one
    row write per run. Per feed key: n = name, ok = last successful fetch, item = newest entry date
    ever seen (silent feeds: none for 48 h), err = the current error or None, since = when the
    current error streak began, fails = failed runs in a row. Feeds no longer configured drop out."""
    old = (prev or {}).get("feeds", {})
    feeds = {}
    for r in results:
        key = r.source["key"]
        p = old.get(key, {})
        dated = [e.published_at for e in r.entries if e.published_at]
        newest = max(dated) if dated else (now if r.entries else None)
        item = max([t for t in (p.get("item"), newest) if t is not None], default=None)
        if r.error:
            streak = bool(p.get("err"))
            feeds[key] = {"n": r.source["name"], "ok": p.get("ok"), "item": item, "err": r.error,
                          "since": p.get("since", now) if streak else now,
                          "fails": (p.get("fails") or 0) + 1 if streak else 1}
        else:
            feeds[key] = {"n": r.source["name"], "ok": now, "item": item, "err": None, "since": None,
                          "fails": 0}
    return {"at": now, "feeds": feeds}
