"""Custom topics in the hourly job (Step 13).

Readers add their own topics in the Mini App ("Colombia", "Formula 1"); the Worker checks each
one once with AI and stores it in `custom_topics` with 2-5 Google News searches
(worker/src/topiccheck.js). Here, every hour:

- `load_active`: the topics at least one active (not paused, not blocked) reader follows. Only
  these are searched, and only these are shown to pass 1 and the editor;
- `search`: their Google News searches (job/gnews.py), the topics searched longest ago first, at
  most `max_requests_per_run` requests per run. Each result is compared without AI with the
  pool's titles of the last 24 h (and the earlier results of this run) and dropped if it is the
  same headline (Step 6 similarity, 0.5); at most `max_items_per_topic` new items per topic.
  They become ordinary pending `items` (tier 4, so a curated outlet's link always wins; marked
  `headline_only`, since Google gives no snippet), and pass 1 handles them like any other item.
  Stories from our own RSS feeds count too: pass 1 tags them with a custom topic when they match;
- `resolve_links`: a story that could reach a digest and still links to news.google.com gets the
  outlet's own article URL (two requests, gnews.resolve); if that fails the Google link stays;
- `cleanup`: a topic with no follower for `orphan_days` is deleted with its searches and stats.

Nothing here can fail the run: Job wraps every call (job/run.py) and logs the error.
"""
from __future__ import annotations

import json
import math
import time
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from job import gnews
from job.config import ROOT
from job.d1 import in_list_statements, insert_statements
from job.fetch import url_hash

CONFIG = ROOT / "config" / "custom_topics.json"
GOOGLE_TIER = 4          # below every curated feed (tiers 1-3)
GOOGLE_SOURCE_KEY = "gnews"
COMPARE_H = 24
LIVE_SCAN = 8000

ACTIVE_SQL = """
SELECT t.id, t.tag, t.names, t.emoji, t.definition, t.queries, t.boost_max, t.searched_at,
       (SELECT count(*) FROM custom_follows f JOIN users u ON u.id = f.user_id
        WHERE f.topic_id = t.id AND f.enabled = 1 AND u.paused = 0 AND u.blocked = 0) AS active
FROM custom_topics t WHERE t.tag IS NOT NULL ORDER BY t.id"""

ITEM_COLUMNS = ("url_hash", "source_key", "source_name", "tier", "url", "title", "snippet",
                "published_at", "fetched_at", "status", "headline_only", "hint_topic")


def load_config(path: Path = CONFIG) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def utc_day(ts: int) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")


def _json(value, fallback):
    try:
        v = json.loads(value) if isinstance(value, str) else value
        return v if v is not None else fallback
    except ValueError:
        return fallback


@dataclass
class CustomTopic:
    id: int
    tag: str
    names: dict
    emoji: str
    definition: str
    queries: list[dict]
    boost_max: int
    searched_at: int | None
    active: int

    @property
    def name(self) -> str:
        return self.names.get("en") or self.tag

    def as_topic(self) -> dict:
        """The shape of a config/topics.yaml entry, plus `custom` (the AI passes treat both alike)."""
        return {"tag": self.tag, "label": {"en": self.name}, "emoji": self.emoji or "",
                "definition": self.definition or self.name, "custom": True, "boost_max": self.boost_max}


def load_active(db) -> list[CustomTopic]:
    out = []
    for r in db.query(ACTIVE_SQL):
        if not int(r["active"] or 0):
            continue
        out.append(CustomTopic(int(r["id"]), r["tag"], _json(r["names"], {}), r["emoji"] or "",
                               r["definition"] or "", _json(r["queries"], []),
                               max(0, min(2, int(r["boost_max"] or 0))), r["searched_at"], int(r["active"])))
    return out


# ---------------------------------------------------------------- search

@dataclass
class SearchStats:
    topics: int = 0                # active topics
    searched: int = 0              # topics searched this run
    requests: int = 0
    failed: int = 0
    stopped: str | None = None     # why the run stopped early (Google refused)
    fetched: int = 0
    seen_before: int = 0
    dup_dropped: int = 0
    capped: int = 0
    stored: int = 0
    per_topic: dict = field(default_factory=dict)   # tag -> {searches, fetched, dup_dropped, new_items}
    ms: int = 0

    def line(self) -> str:
        return (f"custom topics: {self.topics} active, {self.searched} searched, {self.requests} requests "
                f"({self.failed} failed{', stopped: ' + self.stopped if self.stopped else ''}), "
                f"{self.fetched} results, {self.seen_before} seen before, {self.dup_dropped} same as the pool, "
                f"{self.capped} over the per-topic cap, {self.stored} new items, {self.ms / 1000:.1f}s")


def window_hours(searched_at: int | None, now: int, cfg: dict) -> int:
    """Google's when:Nh window: since the topic's last search plus an hour, 2..max_window_hours.
    A topic never searched gets the widest window, so its first digest has something."""
    top = int(cfg.get("max_window_hours", 12))
    if searched_at is None:
        return top
    return max(2, min(top, math.ceil((now - int(searched_at)) / 3600) + 1))


def plan_requests(topics: list[CustomTopic], cfg: dict, now: int) -> list[tuple[CustomTopic, dict, str]]:
    """(topic, query with its edition, window) in search order: the topic searched longest ago
    first (never searched before everything), whole topics only, until the request cap."""
    editions = cfg["editions"]
    cap = int(cfg.get("max_requests_per_run", 40))
    order = sorted(topics, key=lambda t: (t.searched_at is not None, t.searched_at or 0, t.id))
    out: list[tuple[CustomTopic, dict, str]] = []
    for t in order:
        qs = [q for q in t.queries if isinstance(q, dict) and str(q.get("q") or "").strip()]
        if not qs:
            continue
        if len(out) + len(qs) > cap:
            break
        win = f"{window_hours(t.searched_at, now, cfg)}h"
        for n, q in enumerate(qs):
            ed = q.get("ed") if q.get("ed") in editions else "en"
            out.append((t, {"key": f"{t.tag}:{ed}:{n}", "topic": t.tag, "q": str(q["q"]).strip(), "ed": ed,
                            **{k: editions[ed][k] for k in ("hl", "gl", "ceid")}}, win))
    return out


Fetcher = Callable[[dict, str], gnews.Fetched]


class Searcher:
    def __init__(self, db, *, cfg: dict | None = None, fetcher: Fetcher | None = None,
                 clock: Callable[[], float] = time.time, log: Callable[[str], None] = print):
        self.db = db
        self.cfg = cfg if cfg is not None else load_config()
        timeout = float(self.cfg.get("search_timeout_s", 8))
        self.fetcher = fetcher or (lambda q, w: gnews.fetch(q, w, timeout=timeout))
        self.clock = clock
        self.log = log

    def fetch_all(self, plan: list[tuple[CustomTopic, dict, str]], stats: SearchStats) -> list[gnews.Fetched]:
        """In parallel with a hard time budget. Once Google answers 429 or 503 the requests not
        yet started are dropped (a refusal is not hammered)."""
        refused = {"flag": False}

        def one(q, w):
            if refused["flag"]:
                return gnews.Fetched(q, [], None, 0, "skipped after a Google refusal")
            f = self.fetcher(q, w)
            if f.status in (429, 503):
                refused["flag"] = True
            return f

        budget = float(self.cfg.get("search_budget_s", 20))
        pool = ThreadPoolExecutor(max_workers=int(self.cfg.get("search_workers", 8)))
        futures = {pool.submit(one, q, w): q for _, q, w in plan}
        done, not_done = wait(futures, timeout=budget)
        pool.shutdown(wait=False, cancel_futures=True)
        out = []
        for fut, q in futures.items():
            if fut in done and fut.exception() is None:
                out.append(fut.result())
            else:
                err = "over the time budget" if fut in not_done else f"error: {type(fut.exception()).__name__}"
                out.append(gnews.Fetched(q, [], None, int(budget * 1000), err))
        stats.requests = sum(1 for f in out if f.error != "skipped after a Google refusal")
        stats.failed = sum(1 for f in out if f.error)
        if refused["flag"]:
            codes = sorted({str(f.status) for f in out if f.status in (429, 503)})
            stats.stopped = f"Google answered {'/'.join(codes)}"
        return out

    def pool_index(self, now: int) -> gnews.TitleIndex:
        rows = self.db.query(
            "SELECT id, title FROM items WHERE id > (SELECT coalesce(max(id), 0) FROM items) - ? "
            "AND fetched_at >= ?", [LIVE_SCAN, now - COMPARE_H * 3600])
        return gnews.TitleIndex([(r["id"], r["title"]) for r in rows])

    def run(self, topics: list[CustomTopic], now: int) -> SearchStats:
        t0 = self.clock()
        stats = SearchStats(topics=len(topics))
        plan = plan_requests(topics, self.cfg, now)
        if not plan:
            return stats
        searched = {t.tag: t for t, _, _ in plan}
        stats.searched = len(searched)
        fetched = self.fetch_all(plan, stats)
        per = {tag: {"searches": 0, "fetched": 0, "dup_dropped": 0, "new_items": 0} for tag in searched}
        found: dict[str, tuple[gnews.GItem, str]] = {}     # url hash -> (item, the first topic that found it)
        for f in fetched:
            tag = f.query["topic"]
            if f.error != "skipped after a Google refusal":
                per[tag]["searches"] += 1
            per[tag]["fetched"] += len(f.items)
            stats.fetched += len(f.items)
            for it in f.items:
                found.setdefault(url_hash(it.link), (it, tag))
        seen: set[str] = set()
        for rows in self.db.batch(in_list_statements("SELECT url_hash FROM items WHERE url_hash IN ({qs})",
                                                     list(found))):
            seen.update(r["url_hash"] for r in rows)
        stats.seen_before = len(seen)
        index = self.pool_index(now)
        threshold = float(self.cfg.get("title_dup_threshold", 0.5))
        cap = int(self.cfg.get("max_items_per_topic", 8))
        # newest first, so the per-topic cap keeps the freshest
        fresh = sorted(((h, it, tag) for h, (it, tag) in found.items() if h not in seen),
                       key=lambda x: (-(x[1].published_at or now), x[1].guid))
        rows, kept = [], {tag: 0 for tag in searched}
        for h, it, tag in fresh:
            sim, _ = index.best(it.title)
            if sim >= threshold:
                stats.dup_dropped += 1
                per[tag]["dup_dropped"] += 1
                continue
            if kept[tag] >= cap:
                stats.capped += 1
                continue
            index.add(f"new:{h}", it.title)
            kept[tag] += 1
            per[tag]["new_items"] += 1
            rows.append((h, GOOGLE_SOURCE_KEY, (it.source or "Google News")[:120], GOOGLE_TIER, it.link, it.title,
                         None, it.published_at, now, "pending", 1, tag))
        stmts = insert_statements("items", ITEM_COLUMNS, rows, suffix="ON CONFLICT(url_hash) DO NOTHING")
        day = utc_day(now)
        for tag, t in searched.items():
            p = per[tag]
            stmts.append(("UPDATE custom_topics SET searched_at = ? WHERE id = ?", [now, t.id]))
            stmts.append((
                "INSERT INTO custom_topic_days (topic_id, day, searches, fetched, dup_dropped, new_items) "
                "VALUES (?,?,?,?,?,?) ON CONFLICT(topic_id, day) DO UPDATE SET searches = searches + excluded.searches, "
                "fetched = fetched + excluded.fetched, dup_dropped = dup_dropped + excluded.dup_dropped, "
                "new_items = new_items + excluded.new_items",
                [t.id, day, p["searches"], p["fetched"], p["dup_dropped"], p["new_items"]]))
        self.db.batch(stmts)
        stats.stored = len(rows)
        stats.per_topic = per
        stats.ms = int((self.clock() - t0) * 1000)
        return stats


# ---------------------------------------------------------------- links

GOOGLE_LINK = "https://news.google.com/%"


@dataclass
class ResolveStats:
    tried: int = 0
    resolved: int = 0
    failed: int = 0
    errors: list[str] = field(default_factory=list)

    def line(self) -> str:
        return f"google links: {self.tried} tried, {self.resolved} resolved, {self.failed} kept as Google links"


def resolve_links(db, story_ids: list[int], *, cfg: dict | None = None,
                  resolver: Callable[[str], str] | None = None,
                  clock: Callable[[], float] = time.time) -> ResolveStats:
    """For the given stories (those that could reach a digest), replace a news.google.com best link
    with the outlet's own article. One try per story: link_state 1 = resolved, 2 = failed (the
    Google link stays and works; it just opens through Google)."""
    cfg = cfg if cfg is not None else load_config()
    resolver = resolver or (lambda link: gnews.resolve(link, timeout=10))
    stats = ResolveStats()
    if not story_ids:
        return stats
    rows = []
    for part in db.batch(in_list_statements(   # extra params are bound before the IN list
            # not "IS NULL": an editor merge can bring a Google link into a story resolved earlier
            "SELECT id, best_url FROM stories WHERE coalesce(link_state, 0) <> 2 AND best_url LIKE ? "
            "AND id IN ({qs})",
            story_ids, [GOOGLE_LINK])):
        rows += part
    rows = sorted(rows, key=lambda r: -int(r["id"]))[: int(cfg.get("resolve_per_run", 10))]
    budget = float(cfg.get("resolve_budget_s", 25))
    t0 = clock()
    stmts = []
    for r in rows:
        if clock() - t0 > budget:
            break
        stats.tried += 1
        try:
            url = resolver(r["best_url"])
            if not str(url).startswith("http") or "news.google.com" in str(url):
                raise ValueError("not an outlet URL")
            stmts.append(("UPDATE stories SET best_url = ?, link_state = 1 WHERE id = ?", [url, r["id"]]))
            stats.resolved += 1
        except Exception as exc:   # any failure: keep the Google link
            stmts.append(("UPDATE stories SET link_state = 2 WHERE id = ?", [r["id"]]))
            stats.failed += 1
            stats.errors.append(f"S{r['id']}: {type(exc).__name__}: {str(exc)[:120]}")
    if stmts:
        db.batch(stmts)
    return stats


# ---------------------------------------------------------------- cleanup

def cleanup(db, now: int, cfg: dict | None = None) -> int:
    """Marks topics that lost their last follower (orphan_since) and deletes those orphaned for
    `orphan_days` or more, with their stats. Returns the number deleted. The Worker sets
    orphan_since when a reader removes a topic; this also catches anything it missed.
    Step 13 fixes: a follower counts whether their switch is on or off (a switched-off topic stays in
    the reader's list), so a topic is deleted only when NO reader has it in their list."""
    cfg = cfg if cfg is not None else load_config()
    cut = now - int(cfg.get("orphan_days", 7)) * 86400
    no_followers = "NOT EXISTS (SELECT 1 FROM custom_follows f WHERE f.topic_id = custom_topics.id)"
    results = db.batch([
        (f"UPDATE custom_topics SET orphan_since = ? WHERE orphan_since IS NULL AND {no_followers}", [now]),
        ("UPDATE custom_topics SET orphan_since = NULL WHERE orphan_since IS NOT NULL AND EXISTS "
         "(SELECT 1 FROM custom_follows f WHERE f.topic_id = custom_topics.id)", []),
        (f"DELETE FROM custom_topic_days WHERE topic_id IN (SELECT id FROM custom_topics WHERE orphan_since <= ? "
         f"AND {no_followers})", [cut]),
        (f"DELETE FROM custom_topics WHERE orphan_since <= ? AND {no_followers} RETURNING id", [cut]),
        ("DELETE FROM custom_topic_days WHERE day < ?", [utc_day(now - 30 * 86400)]),
    ])
    return len(results[3])
