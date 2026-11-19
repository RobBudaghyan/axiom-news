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
- `cleanup`: a topic with no follower for `orphan_days` is deleted with its searches and stats;
- Step 14, the keyword rule (`KeywordRule`): every custom topic has 5-15 match keywords in English
  and Russian (written by the Worker's topic check, or by `backfill_keywords`, one AI call a topic).
  A story keeps a custom tag (and may have it as its main topic) only if one of them is in its
  English headline or description, as a whole word, any case. Otherwise the tag goes and the main
  topic falls back to the story's best main topic, with no boost. Applied where tags are written
  (pass 1 in job/run.py, the editor in job/editor.py) and once a run over the pool (`enforce`);
- Step 14, `spell_names`: a Google headline, a pass-1 summary or an editor text that spells a
  glossary name another way (config/glossary.yaml, "Takaiti") gets the glossary spelling ("Takaichi").

Nothing here can fail the run: Job wraps every call (job/run.py) and logs the error.
"""
from __future__ import annotations

import json
import math
import re
import time
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from job import gnews
from job.config import ROOT
from job.d1 import in_list_statements, insert_statements, seen_hashes
from job.fetch import url_hash

CONFIG = ROOT / "config" / "custom_topics.json"
GOOGLE_TIER = 4          # below every curated feed (tiers 1-3)
GOOGLE_SOURCE_KEY = "gnews"
COMPARE_H = 24
LIVE_SCAN = 8000

ACTIVE_SQL = """
SELECT t.id, t.tag, t.names, t.emoji, t.definition, t.queries, t.boost_max, t.searched_at, t.keywords,
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
    keywords: dict = field(default_factory=dict)    # Step 14: {en: [...], ru: [...]}, {} if not written yet

    @property
    def name(self) -> str:
        return self.names.get("en") or self.tag

    def as_topic(self) -> dict:
        """The shape of a config/topics.yaml entry, plus `custom` (the AI passes treat both alike)."""
        return {"tag": self.tag, "label": {"en": self.name}, "emoji": self.emoji or "",
                "definition": self.definition or self.name, "custom": True, "boost_max": self.boost_max,
                "names": self.names, "keywords": self.keywords}


def load_active(db) -> list[CustomTopic]:
    out = []
    for r in db.query(ACTIVE_SQL):
        if not int(r["active"] or 0):
            continue
        out.append(CustomTopic(int(r["id"]), r["tag"], _json(r["names"], {}), r["emoji"] or "",
                               r["definition"] or "", _json(r["queries"], []),
                               max(0, min(2, int(r["boost_max"] or 0))), r["searched_at"], int(r["active"]),
                               _json(r.get("keywords"), {})))
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
                 clock: Callable[[], float] = time.time, log: Callable[[str], None] = print,
                 hold: Callable[[dict], None] | None = None, held: dict[str, str] | None = None):
        self.db = db
        # Step 17c: the hourly job passes `hold` (new items go to it and are written once, after the
        # AI pass) and `held` (url hash -> title of the items it holds, not in D1 yet). Without them
        # (tools, old tests) new items are stored as 'pending' at once, as before.
        self.hold = hold
        self.held = held or {}
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
        index = gnews.TitleIndex([(r["id"], r["title"]) for r in rows])
        for h, title in self.held.items():     # this run's feed items, not written yet
            index.add(f"held:{h}", title)
        return index

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
        seen = seen_hashes(self.db, list(found)) | (set(found) & set(self.held))
        stats.seen_before = len(seen)
        index = self.pool_index(now)
        threshold = float(self.cfg.get("title_dup_threshold", 0.5))
        cap = int(self.cfg.get("max_items_per_topic", 8))
        # newest first, so the per-topic cap keeps the freshest
        fresh = sorted(((h, it, tag) for h, (it, tag) in found.items() if h not in seen),
                       key=lambda x: (-(x[1].published_at or now), x[1].guid))
        rows, kept = [], {tag: 0 for tag in searched}
        for h, it, tag in fresh:
            it.title = spell_names(it.title)     # Step 14: "Takaiti" -> "Takaichi"
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
        if self.hold:
            for r in rows:
                self.hold(dict(zip(ITEM_COLUMNS, r)))
            stmts = []
        else:
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


# ---------------------------------------------------------------- Step 14: glossary spellings

def name_fixer(glossary: list[dict] | None = None) -> list[tuple[re.Pattern, str]]:
    """(pattern, spelling) for every other English spelling of a glossary name: the first `en`
    form is the one we use ("Takaichi"), the others are found as whole words ("Takaiti")."""
    if glossary is None:
        from job.translate import load_glossary   # not at the top: translate imports the editor, which imports this
        glossary = load_glossary()
    out = []
    for g in glossary:
        forms = [str(x) for x in g.get("en") or []]
        for other in forms[1:]:
            out.append((re.compile(rf"(?<!\w){re.escape(other)}(?!\w)"), forms[0]))
    return out


def fix_names(title: str, fixer: list[tuple[re.Pattern, str]]) -> str:
    for pattern, spelling in fixer:
        title = pattern.sub(spelling, title)
    return title


_FIXER: list | None = None


def spell_names(text: str | None) -> str | None:
    """fix_names with config/glossary.yaml (read once). Used on Google headlines, pass 1's summary
    and the editor's headline and description: "Takaiti" came from the editor reading a Russian
    article (премьер Японии Такаити)."""
    global _FIXER
    if not text:
        return text
    if _FIXER is None:
        _FIXER = name_fixer()
    return fix_names(text, _FIXER)


# ---------------------------------------------------------------- Step 14: the keyword rule

KEYWORD_LANGS = ("en", "ru")
MIN_KEYWORDS, MAX_KEYWORDS, MAX_KEYWORD_CHARS = 5, 15, 40
KEYWORD_OK = re.compile(r"^\w[\w .'’&-]*$")
CUSTOM_TAG = re.compile(r"^c\d+$")
DIGEST = ROOT / "config" / "digest.json"


def is_custom(tag) -> bool:
    return isinstance(tag, str) and bool(CUSTOM_TAG.match(tag))


def clean_keywords(raw, names: dict | None = None) -> dict:
    """{en: [...], ru: [...]}: the topic's own name first, then the AI's words; one line each, 1-40
    characters of letters, digits, spaces and . ' & -, with a letter; no repeats (any case); at most
    15 a language. The same rules as cleanKeywords in worker/src/custom.js."""
    raw = raw if isinstance(raw, dict) else {}
    names = names or {}
    out = {}
    for lang in KEYWORD_LANGS:
        given = raw.get(lang) if isinstance(raw.get(lang), list) else []
        seen, words = set(), []
        for w in [names.get(lang), *given]:
            w = " ".join(str(w or "").split()).strip(" .-")
            if not w or len(w) > MAX_KEYWORD_CHARS or not KEYWORD_OK.match(w) or not re.search(r"[^\W\d_]", w):
                continue
            if w.lower() in seen:
                continue
            seen.add(w.lower())
            words.append(w)
            if len(words) == MAX_KEYWORDS:
                break
        out[lang] = words
    return out


def keyword_regex(words: list[str]) -> re.Pattern | None:
    """Any of the words as a whole word, any case; a plural s or es is allowed ("Australians")."""
    parts = sorted({r"\s+".join(re.escape(x) for x in w.split()) for w in words if w.strip()}, key=len, reverse=True)
    if not parts:
        return None
    return re.compile(rf"(?<!\w)(?:{'|'.join(parts)})(?:e?s)?(?!\w)", re.I)


def story_text(headline, description, summary=None) -> str:
    """The English text the rule reads: the headline (the first-pass summary while there is none)
    and the description."""
    return f"{headline or summary or ''}\n{description or ''}"


class KeywordRule:
    """topics: the AI passes' topic dicts (custom ones carry `keywords` and `names`). A custom
    topic with no keywords yet uses its names (English and Russian) until the backfill writes them."""

    def __init__(self, topics: list[dict], specificity: list[str] | None = None):
        self.patterns: dict[str, re.Pattern | None] = {}
        for t in topics:
            if not t.get("custom"):
                continue
            kw = t.get("keywords") or {}
            words = [w for lang in KEYWORD_LANGS for w in (kw.get(lang) or [])]
            if not words:
                names = t.get("names") or {"en": (t.get("label") or {}).get("en")}
                words = [w for lang in KEYWORD_LANGS for w in clean_keywords({}, names)[lang]]
            self.patterns[t["tag"]] = keyword_regex(words)
        if specificity is None:
            specificity = json.loads(DIGEST.read_text(encoding="utf-8"))["topic_specificity"]
        self.specificity = specificity

    def __bool__(self) -> bool:
        return bool(self.patterns)

    def allows(self, tag: str, text: str) -> bool:
        """A main topic always; a custom topic only with one of its keywords in the text. A custom
        tag the rule does not know (no active reader follows it) is left alone."""
        if not is_custom(tag) or tag not in self.patterns:
            return True
        p = self.patterns[tag]
        return bool(p and p.search(text or ""))

    def tags(self, tags: list[str], text: str) -> list[str]:
        return [t for t in tags if self.allows(t, text)]

    def fallback(self, kept: list[str]) -> str | None:
        """The best main topic among the tags left: the most specific of the six, else a custom
        tag that passed, else none (the story leaves the custom path)."""
        rank = {t: i for i, t in enumerate(self.specificity)}
        mains = sorted((t for t in kept if not is_custom(t)), key=lambda t: rank.get(t, len(rank)))
        return (mains or [t for t in kept if is_custom(t)] or [None])[0]

    def apply(self, tags: list[str], main: str | None, text: str) -> tuple[list[str], str | None, bool]:
        """(tags kept, main topic, whether the main topic was replaced)."""
        kept = self.tags(tags, text)
        if main is None or main in kept or not is_custom(main):
            return kept, main, False
        return kept, self.fallback(kept), True


ENFORCE_SQL = ("SELECT id, topics, main_topic, final_score, topic_score, headline, summary, description FROM stories "
               "WHERE (updated_at >= ?1 OR scored_at >= ?1) AND merged_into IS NULL AND topics GLOB '*\"c[0-9]*'")
# Step 17: "updated_at >= ? OR scored_at >= ?" (both indexed) instead of max(...), which read the whole pool


def enforce(db, rule: KeywordRule, now: int, hours: int = 26) -> list[dict]:
    """Once a run: every story of the digest window that carries a custom tag is checked again
    (stories written before the rule, or before their topic had keywords). Returns the changed
    stories: {id, headline, removed, main_from, main_to}."""
    if not rule:
        return []
    changed, stmts = [], []
    for r in db.query(ENFORCE_SQL, [now - hours * 3600]):
        tags = _json(r["topics"], [])
        kept, main, moved = rule.apply(tags, r["main_topic"], story_text(r["headline"], r["description"], r["summary"]))
        if kept == tags and not moved:
            continue
        ts = r["final_score"] if moved else r["topic_score"]   # the topic score was for the custom topic
        stmts.append(("UPDATE stories SET topics = ?, main_topic = ?, topic_score = ? WHERE id = ?",
                      [json.dumps(kept), main, ts, r["id"]]))
        changed.append({"id": r["id"], "headline": r["headline"] or r["summary"],
                        "removed": [t for t in tags if t not in kept], "main_from": r["main_topic"], "main_to": main})
    if stmts:
        db.batch(stmts)
    return changed


# ---------------------------------------------------------------- Step 14: keyword backfill

# The same instruction as the Worker's topic check (worker/src/custom.js checkPrompt, item 4).
KEYWORDS_INSTRUCTION = """keywords: 5 to 15 match keywords in English (en) and 5 to 15 in Russian (ru): words or
     short names that a news headline about this topic almost always contains, so that code can
     check a story is really about it: the name and its adjective, the capital, main cities and
     regions, the people in office now (leader, key ministers) and other key people, the main
     institutions and the currency (Japan: Japan, Japanese, Tokyo, Okinawa, Takaichi, BOJ, Yen;
     Япония, японский, Токио). Each 1 to 3 words. No word that is common in other news (not Asia,
     Pacific, China, government, minister)."""

KEYWORDS_PROMPT = """You help a small news digest sort stories into a topic that its readers chose.
Topic: {name} ({names}). What it covers: {definition}
Your knowledge may be out of date: the people in office may have changed. Use the recent headlines
below for the current names; they are real search results for this topic, some of them off-topic.
{headlines}
Give:
   - {instruction}
Return JSON only, matching the schema."""

KEYWORDS_SCHEMA = {
    "type": "object",
    "properties": {"keywords": {"type": "object", "properties": {
        "en": {"type": "array", "items": {"type": "string"}},
        "ru": {"type": "array", "items": {"type": "string"}}}, "required": ["en", "ru"]}},
    "required": ["keywords"],
}


def keywords_prompt(names: dict, definition: str, headlines: list[str] | None = None) -> str:
    lines = "\n".join(f"   - {h}" for h in (headlines or [])) or "   (none yet)"
    return KEYWORDS_PROMPT.format(name=names.get("en") or "", names=", ".join(v for v in names.values() if v),
                                  definition=definition or "", headlines=f"RECENT HEADLINES:\n{lines}",
                                  instruction=KEYWORDS_INSTRUCTION)


HEADLINES_SQL = ("SELECT title FROM items WHERE hint_topic = ? AND fetched_at >= ? AND title IS NOT NULL "
                 "ORDER BY id DESC LIMIT ?")


def _answer(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    return json.loads(text)


KEYWORDS_REFRESH_DAYS = 7
MIN_REFRESH_KEYWORDS = 5     # a refresh keeps the old keywords unless the new answer has this many


def backfill_keywords(db, plans, *, limit: int = 5, on_call: Callable | None = None, now: int | None = None,
                      headlines: int = 30) -> list[str]:
    """Topics with no keywords yet (made before Step 14, or the check gave too few), and (Step 15)
    topics whose keywords are 7+ days old or marked for a refresh in Admin (keywords_at 0): one AI
    call each, the providers in order until one answers, with the topic's latest Google headlines
    (the last 2 days) so the model sees today's names. A refresh keeps the old keywords if the new
    answer has fewer than 5 English ones (it only moves keywords_at on). A topic whose every call
    fails waits for the next run. Returns the tags filled."""
    now = int(time.time()) if now is None else now
    on_call = on_call or (lambda *a, **k: None)
    rows = db.query("SELECT id, tag, names, definition, keywords FROM custom_topics WHERE tag IS NOT NULL AND "
                    "(keywords IS NULL OR keywords_at IS NULL OR keywords_at <= ?) "
                    "ORDER BY keywords IS NOT NULL, coalesce(keywords_at, 0), id LIMIT ?",
                    [now - KEYWORDS_REFRESH_DAYS * 86400, limit])
    done = []
    for r in rows:
        names = _json(r["names"], {})
        recent = [h["title"] for h in db.query(HEADLINES_SQL, [r["tag"], now - 2 * 86400, headlines])]
        prompt = keywords_prompt(names, r["definition"], recent)
        for plan in plans:
            p = plan.provider
            res = None
            try:
                res = p.generate(prompt, KEYWORDS_SCHEMA)
                kw = clean_keywords((_answer(res.text) or {}).get("keywords"), names)
                if len(kw["en"]) < 2:
                    raise ValueError("no usable keywords")
            except Exception as exc:
                on_call(p, False, 1, res, f"{p.name}: keywords: {type(exc).__name__}: {exc}"[:300], kind="topic_keywords")
                continue
            on_call(p, True, 1, res, None, kind="topic_keywords")
            if r.get("keywords") and len(kw["en"]) < MIN_REFRESH_KEYWORDS:
                db.query("UPDATE custom_topics SET keywords_at = ? WHERE id = ?", [now, r["id"]])   # keep the old ones
            else:
                db.query("UPDATE custom_topics SET keywords = ?, keywords_at = ? WHERE id = ?",
                         [json.dumps(kw, ensure_ascii=False), now, r["id"]])
                done.append(r["tag"])
            break
    return done
