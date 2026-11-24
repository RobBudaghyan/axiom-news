"""Hourly job entry point.

    venv/Scripts/python -m job.run

Steps: sync topics -> fetch feeds -> hold new items in memory -> expire pending items
older than 24 h -> AI pass over every pending and held item (Gemini, then Groq for whatever is
left) -> write stories and each held item once, in its final state -> daily prune -> log the run.
Step 17c: a story item is written once (no 'pending' insert and later update); a not-news item
leaves only its URL hash in `items_seen`. Items whose AI call failed are stored as 'pending' and
retried next run (docs/ARCHITECTURE.md section 7).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from datetime import datetime, timezone
from typing import Callable

import requests

from job import ai, chain, custom, dupes, editor, guard, translate
from job.config import Prompt, Settings, load_env, load_prompt, load_sources, load_topics
from job.d1 import D1, in_list_statements, insert_statements, seen_hashes
from job.fetch import (Entry, FeedResult, candidates, feed_caps, feed_health, fetch_all, select_new,
                       url_hash)

# Failures that say nothing about the provider itself, only this one chunk's output:
# the chunk is left for the next provider, but the same provider keeps going.
CONTENT_FAILURES = {"blocked", "empty", "truncated", "invalid", "too_large"}
# In every real answer seen in Step 2, 50-80% of items went into stories. Fewer than 10% of
# 20+ items means the model gave up (seen once: 0 of 435), so that answer is retried.
MIN_PLACED_SHARE = 0.10
# Answers to very large chunks sometimes stop early (190 of 516 items covered). Up to 10% of
# items left out counts as "not news"; more than that, the skipped items are sent again.
MAX_SKIPPED_SHARE = 0.10
# Step 17c: every item is written with its id (taken after the highest in D1), so the AI pass can
# use held items before they are stored.
ITEM_COLUMNS = ("id", "url_hash", "source_key", "source_name", "tier", "url", "title", "snippet",
                "published_at", "fetched_at", "status", "story_id", "headline_only", "hint_topic")
PENDING_COLUMNS = ("id", "source_name", "tier", "url", "title", "snippet", "published_at", "fetched_at",
                   "headline_only", "source_key", "hint_topic")
HTTP_CODE = re.compile(r"HTTP (\d{3})")


@dataclass
class ProviderPlan:
    provider: ai.Provider
    budget_tokens: int      # max estimated prompt tokens per call
    existing_max: int       # existing stories shown per call
    max_chunks: int         # max calls per run
    reply_tokens: int = 0   # reserved reply size, for tokens-per-minute pacing (Groq)
    label: str = ""         # name used in job_runs.provider (default: provider name)
    paid: bool = False      # Step 20: the emergency key; gets only work every free option failed on

    def __post_init__(self):
        self.label = self.label or self.provider.name


@dataclass
class RunStats:
    feeds_ok: int = 0
    feeds_failed: int = 0
    items_fetched: int = 0
    items_new: int = 0
    items_pending_in: int = 0
    stories_created: int = 0
    stories_merged: int = 0
    items_dropped: int = 0
    items_unaccounted: int = 0   # neither placed nor listed as not-news (counted in dropped)
    items_expired: int = 0
    items_left_pending: int = 0
    providers: list[str] = field(default_factory=list)
    editor: "editor.EditorResult | None" = None
    translate: "translate.TranslateResult | None" = None
    ai_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    pruned: int | None = None
    failed_feeds: list[str] = field(default_factory=list)
    cap_cut: dict[str, int] = field(default_factory=dict)   # feed key -> new items its cap left out
    ai_errors: list[str] = field(default_factory=list)
    # Step 13: custom topics and the AI budget guard
    custom: "custom.SearchStats | None" = None
    links: "custom.ResolveStats | None" = None
    custom_deleted: int | None = None
    custom_unkeyed: int = 0          # Step 14: stories the keyword rule took off a custom topic this run
    custom_errors: list[str] = field(default_factory=list)   # written to `errors` as component 'custom'
    guard: dict | None = None
    translate_delayed: bool = False

    @property
    def provider(self) -> str | None:
        return "+".join(self.providers) or None


WORD = re.compile(r"[a-z]{4,}")
NON_LATIN = re.compile(r"[Ͱ-῿؀-ۿ]")   # Greek, Cyrillic, Armenian, Hebrew, Arabic...
STOPWORDS = {"that", "this", "with", "from", "have", "were", "been", "will", "into", "over", "after",
             "about", "their", "they", "them", "than", "what", "when", "which", "said", "says",
             "also", "more", "most", "amid", "could", "would", "news", "live", "latest", "update"}


def _stems(text: str) -> set[str]:
    return {w[:5] for w in WORD.findall(text.lower()) if w not in STOPWORDS}


def relevance(item: dict, summary: str) -> int:
    """0 = the item's title shares a word with the summary, 1 = can't tell (non-Latin title),
    2 = an English title with no word in common: probably put in the story by mistake
    (seen in Step 2: a DraftKings article inside a Zaporizhzhia strike story)."""
    title = f"{item['title']} {item.get('snippet') or ''}"
    if NON_LATIN.search(item["title"]):
        return 1
    return 0 if _stems(title) & _stems(summary) else 2


def link_key(item: dict, summary: str | None) -> tuple:
    rel = relevance(item, summary) if summary else 0
    pub = item["published_at"] if item["published_at"] is not None else float("inf")
    return (rel, item["tier"], pub, item["id"])


def best_item(items: list[dict], summary: str | None = None) -> dict:
    """The link users see: an item that matches the summary, then lowest tier, then the
    earliest published, then lowest id."""
    return min(items, key=lambda i: link_key(i, summary))


class PlanList(list):
    """Step 20: the provider chain for pass 1, the editor and keywords (the list itself), plus the
    strong chain for translations (`translate`, never Groq), the emergency key's SpendGuard and the
    run's retry budget. Plain lists still work where only the main chain is needed (tests)."""

    def __init__(self, plans=(), translate=None, spend=None, budget=None, forced=""):
        super().__init__(plans)
        self.translate = translate if translate is not None else [p for p in plans if p.provider.name != "groq"]
        self.spend = spend
        self.budget = budget
        self.forced = forced


def degraded_order(items: list[dict], followed: set[str], source_topics: dict[str, list[str]]) -> list[dict]:
    """Step 20: when the main model is down, the most important items go first and the rest waits:
    items of a topic some active reader follows (a custom topic's Google items, or a feed whose topics
    are followed), then by source tier (1 is the best), then the newest."""
    def key(i):
        tags = set(source_topics.get(i.get("source_key") or "", []))
        if i.get("hint_topic"):
            tags.add(i["hint_topic"])
        when = i.get("published_at") if i.get("published_at") is not None else i.get("fetched_at") or 0
        return (0 if tags & followed else 1, int(i.get("tier") or 9), -int(when), i["id"])
    return sorted(items, key=key)


class Job:
    def __init__(self, db, plans: list[ProviderPlan], *, settings: Settings | None = None,
                 topics: list[dict] | None = None, sources: list[dict] | None = None,
                 prompt: Prompt | None = None,
                 fetcher: Callable[[list[dict], int], list[FeedResult]] | None = None,
                 clock: Callable[[], float] = time.time, log: Callable[[str], None] = print,
                 debug_dir: str | None = None, editor_enabled: bool = True, translate_enabled: bool = True,
                 custom_enabled: bool = True, custom_cfg: dict | None = None, gnews_fetcher=None,
                 link_resolver=None, budget_cfg: dict | None = None, digest_cfg: dict | None = None):
        self.db = db
        self.plans = plans
        self.s = settings or Settings()
        self.topics = topics if topics is not None else load_topics()
        self.main_order = [t["tag"] for t in self.topics]
        # Step 13: the topics the AI passes see = the main topics + the custom topics active readers
        # follow (set at the start of each run); topic_order is their tags.
        self.ai_topics = list(self.topics)
        self.topic_order = list(self.main_order)
        self.custom_topics: list[custom.CustomTopic] = []
        self.rule = custom.KeywordRule([])     # Step 14: the keyword rule (set with the custom topics)
        self.custom_enabled = custom_enabled
        self.custom_cfg = custom_cfg
        self.gnews_fetcher = gnews_fetcher
        self.link_resolver = link_resolver
        self.budget_cfg = budget_cfg
        self.digest_cfg = digest_cfg
        self.sources = sources if sources is not None else load_sources()
        self.prompt = prompt or load_prompt()
        self.fetcher = fetcher or self._fetch
        self.clock = clock
        self.log = log
        self.calls_log: list[tuple] = []
        self.feed_health: dict | None = None   # written to meta.feed_health with the run log
        self.cap_cut: dict[str, int] = {}
        self.held: dict[int, dict] = {}        # Step 17c: new items of this run, not in D1 yet (id -> row)
        self.held_hashes: set[str] = set()
        self.next_id: int | None = None
        self.debug_dir = Path(debug_dir) if debug_dir else None   # saves raw prompts/answers
        self.editor_enabled = editor_enabled   # tests of the first pass alone switch it off
        self.translate_enabled = translate_enabled
        self.spend_log: list[tuple] = []       # Step 20: ai_spend rows (paid calls) of this run
        self.followed: set[str] | None = None
        self.t_start = clock()

    # ------------------------------------------------------------ steps

    def _fetch(self, sources: list[dict], now: int) -> list[FeedResult]:
        return fetch_all(sources, workers=self.s.fetch_workers, timeout=self.s.fetch_timeout_s,
                         snippet_chars=self.s.snippet_chars, now=now)

    def sync_topics(self) -> None:
        desired = [(t["tag"], t["label"]["en"], t["label"].get("ru"), t.get("emoji"), n,
                    1 if t.get("default") else 0) for n, t in enumerate(self.topics)]
        current = self.db.query("SELECT tag, label_en, label_ru, emoji, sort, is_default FROM topics")
        if {tuple(r.values()) for r in current} == set(desired):
            return
        stmts = [("INSERT INTO topics (tag, label_en, label_ru, emoji, sort, is_default) "
                  "VALUES (?,?,?,?,?,?) ON CONFLICT(tag) DO UPDATE SET label_en=excluded.label_en, "
                  "label_ru=excluded.label_ru, emoji=excluded.emoji, sort=excluded.sort, "
                  "is_default=excluded.is_default", list(row)) for row in desired]
        stmts += in_list_statements("DELETE FROM topics WHERE tag NOT IN ({qs})", self.main_order)
        self.db.batch(stmts)

    def load_feed_health(self) -> dict | None:
        rows = self.db.query("SELECT value FROM meta WHERE key = 'feed_health'")
        try:
            return json.loads(rows[0]["value"]) if rows else None
        except (ValueError, TypeError):
            return None

    def lookback_since(self, now: int) -> int:
        row = self.db.query("SELECT max(started_at) AS t FROM job_runs "
                            "WHERE status IN ('ok', 'partial', 'ai_failed')")
        last = row[0]["t"] if row else None
        if last is None:
            hours = self.s.first_run_lookback_h
        else:
            hours = min(self.s.max_lookback_h, max(self.s.min_lookback_h, (now - last) / 3600 + 1))
        return int(now - hours * 3600)

    def store_new(self, entries: list[Entry], now: int) -> int:
        """Takes the new entries (not in items or items_seen, under the per-feed caps) and holds
        them in memory; they are written once the AI pass has placed or dropped them."""
        seen = seen_hashes(self.db, [e.url_hash for e in entries])
        self.cap_cut = {}
        new = select_new(entries, seen, self.s.max_items_per_feed, feed_caps(self.sources), self.cap_cut)
        for e in new:
            self.hold({"url_hash": e.url_hash, "source_key": e.source_key, "source_name": e.source_name,
                       "tier": e.tier, "url": e.url, "title": e.title, "snippet": e.snippet,
                       "published_at": e.published_at, "fetched_at": now, "headline_only": 0, "hint_topic": None})
        return len(new)

    def hold(self, row: dict) -> None:
        """Step 17c: a new item gets its id now (after the highest in D1) and waits in memory."""
        if self.next_id is None:
            got = self.db.query("SELECT coalesce(max(id), 0) AS m FROM items")
            self.next_id = int(got[0]["m"]) + 1 if got else 1
        if row["url_hash"] in self.held_hashes:
            return
        r = {**row, "id": self.next_id, "status": "pending", "story_id": None}
        r.setdefault("headline_only", 0)
        r.setdefault("hint_topic", None)
        self.held[self.next_id] = r
        self.held_hashes.add(row["url_hash"])
        self.next_id += 1

    def item_insert_statements(self, rows: list[dict]) -> list:
        return insert_statements("items", ITEM_COLUMNS, [tuple(r[c] for c in ITEM_COLUMNS) for r in rows],
                                 suffix="ON CONFLICT DO NOTHING")

    def flush_held(self) -> int:
        """Held items the AI pass did not settle (provider failures) are stored as 'pending'."""
        rows = list(self.held.values())
        self.held = {}
        if rows:
            self.db.batch(self.item_insert_statements(rows))
        return len(rows)

    def expire_old_pending(self, now: int) -> int:
        cutoff = int(now - self.s.pending_max_age_h * 3600)
        rows = self.db.query("UPDATE items SET status = 'expired' WHERE status = 'pending' "
                             "AND fetched_at < ? RETURNING id", [cutoff])
        return len(rows)

    def load_pending(self) -> list[dict]:
        """Pending items in D1 (earlier runs' failures) and this run's held items."""
        rows = self.db.query(
            "SELECT id, source_name, tier, url, title, snippet, published_at, fetched_at, headline_only, "
            "source_key, hint_topic FROM items "
            "WHERE status = 'pending' ORDER BY coalesce(published_at, fetched_at), id")
        rows += [{c: h[c] for c in PENDING_COLUMNS} for h in self.held.values()]
        rows.sort(key=lambda r: (r["published_at"] if r["published_at"] is not None else r["fetched_at"], r["id"]))
        return rows

    def load_existing(self, now: int, limit: int) -> list[dict]:
        if limit <= 0:
            return []
        since = int(now - self.s.existing_window_h * 3600)
        return self.db.query(
            "SELECT id, summary, topics, importance, best_url, best_source, best_tier, "
            "best_published_at, headline, description FROM stories WHERE updated_at >= ? AND merged_into IS NULL "
            "ORDER BY updated_at DESC LIMIT ?",
            [since, limit])

    def render(self, items: list[dict], existing: list[dict], now: int) -> str:
        return ai.render_prompt(
            self.prompt.template, today=datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d"),
            topics=self.ai_topics, facts=self.prompt.facts, facts_checked=self.prompt.facts_checked,
            existing=existing, items=items)

    # ------------------------------------------------------------ AI pass

    def run_ai(self, pending: list[dict], now: int, stats: RunStats) -> list[dict]:
        """Process all pending items; returns the items still pending afterwards.

        Per provider: split into chunks and call it chunk by chunk. A provider-level failure
        (rate limit, HTTP error, network) hands that chunk and all later ones to the next
        provider. A failure of one answer: 'truncated'/'too_large' splits the chunk in two,
        'invalid'/'empty' retries the chunk once, anything else (or a second failure) hands
        just that chunk on. An answer that covers only part of its chunk is kept, and the
        skipped items are sent once more (then handed on)."""
        queue = pending
        failed_ids: set[int] = set()      # Step 20: items whose call failed on the last free provider
        for n_plan, plan in enumerate(self.plans):
            if not queue:
                break
            waiting: list[dict] = []
            if plan.paid:
                # Step 20: the emergency key only for items every free option FAILED on; items a free
                # provider had no time or calls left for are not failures: they wait for the next run.
                waiting = [i for i in queue if i["id"] not in failed_ids]
                queue = [i for i in queue if i["id"] in failed_ids]
                if not queue:
                    queue = waiting
                    continue
            if n_plan > 0:
                queue = degraded_order(queue, self.followed_topics(), self.source_topics())
            p = plan.provider
            fixed = ai.estimate_tokens(self.render([], self.load_existing(now, plan.existing_max), now))
            work = [(c, False) for c in ai.make_chunks(queue, plan.budget_tokens, fixed)]
            leftover: list[dict] = []
            failed_now: set[int] = set()
            calls = 0
            while work:
                chunk, retried = work.pop(0)
                if calls >= plan.max_chunks or self.clock() - self.t_start > self.s.pass1_budget_s:
                    leftover.extend(chunk)      # out of calls or time: not a failure
                    continue
                existing = self.load_existing(now, plan.existing_max)
                prompt = self.render(chunk, existing, now)
                if plan.reply_tokens and hasattr(p, "wait_for_tokens"):
                    p.wait_for_tokens(ai.estimate_tokens(prompt) + plan.reply_tokens)
                calls += 1
                res = None
                try:
                    res = p.generate(prompt, self.prompt.schema)
                    stats.input_tokens += res.input_tokens or 0
                    stats.output_tokens += res.output_tokens or 0
                    self._debug_dump(p.name, calls, prompt, res.text)
                    stories, not_news, missing = self.check_answer(p.name, res.text, chunk, existing)
                except ai.AIError as exc:
                    self._log_call(p, False, len(chunk), res, str(exc))
                    stats.ai_errors.append(str(exc))
                    if exc.kind in ("truncated", "too_large") and len(chunk) > 1:
                        half = len(chunk) // 2
                        work[:0] = [(chunk[:half], retried), (chunk[half:], retried)]
                    elif exc.kind in ("invalid", "empty") and not retried:
                        work.insert(0, (chunk, True))
                    elif exc.kind in CONTENT_FAILURES:
                        leftover.extend(chunk)
                        failed_now.update(i["id"] for i in chunk)
                    else:                       # provider is down/limited: hand the rest on
                        leftover.extend(chunk)
                        failed_now.update(i["id"] for i in chunk)
                        for rest, _ in work:
                            leftover.extend(rest)
                            failed_now.update(i["id"] for i in rest)
                        work = []
                    continue
                self._log_call(p, True, len(chunk), res, None)
                if len(missing) > max(2, len(chunk) * MAX_SKIPPED_SHARE):
                    # keep the work done, send the skipped items again
                    gone = {i["id"] for i in missing}
                    self.apply(stories, [i for i in chunk if i["id"] not in gone], existing, not_news,
                               now, stats)
                    stats.ai_errors.append(f"{p.name}: answer skipped {len(missing)} of {len(chunk)} "
                                           f"items; {'handing them on' if retried else 'resending them'}")
                    if retried:
                        leftover.extend(missing)
                        failed_now.update(i["id"] for i in missing)
                    else:
                        work.insert(0, (missing, True))
                else:   # a few skipped items count as not news (items_unaccounted)
                    self.apply(stories, chunk, existing, not_news, now, stats)
                if plan.label not in stats.providers:
                    stats.providers.append(plan.label)
            if not plan.paid:
                failed_ids = failed_now
            queue = leftover + waiting
        return queue

    def followed_topics(self) -> set[str]:
        """Step 20: the topics active readers follow (main topics on, custom topics in the run)."""
        if self.followed is None:
            tags: set[str] = {t.tag for t in self.custom_topics}
            try:
                for r in self.db.query("SELECT DISTINCT topics FROM users WHERE blocked = 0"):
                    try:
                        tags.update(json.loads(r["topics"] or "[]"))
                    except (TypeError, ValueError):
                        pass
            except Exception:
                tags.update(self.main_order)
            self.followed = tags
        return self.followed

    def source_topics(self) -> dict[str, list[str]]:
        return {s["key"]: list(s.get("topics") or []) for s in self.sources}

    def check_answer(self, provider: str, text: str, chunk: list[dict],
                     existing: list[dict]) -> tuple[list[ai.StoryOut], set[int], list[dict]]:
        """Parse and validate one answer; returns (stories, not-news ids, skipped items).
        Lesson 2: an answer that covers none of the items, or puts almost everything in
        not-news, is a failed answer, not "no news"."""
        try:
            data = ai.parse_json(text)
        except ValueError as exc:
            raise ai.AIError(provider, f"invalid JSON: {exc}", kind="invalid") from None
        chunk_ids = {i["id"] for i in chunk}
        stories = ai.validate_stories(data, chunk_ids, {s["id"] for s in existing}, self.topic_order)
        placed = {i for s in stories for i in s.item_ids}
        not_news = {int(i) for i in data.get("not_news_ids") or []
                    if str(i).lstrip("-").isdigit()} & (chunk_ids - placed)
        covered = placed | not_news
        if len(chunk) >= 3 and not covered:
            raise ai.AIError(provider, f"answer covers none of the {len(chunk)} items", kind="invalid")
        if len(covered) >= 20 and len(placed) < len(covered) * MIN_PLACED_SHARE:
            raise ai.AIError(provider, f"answer puts only {len(placed)} of {len(covered)} items in "
                             f"stories ({len(not_news)} not-news): implausible, treated as a failed "
                             f"answer", kind="invalid")
        return stories, not_news, [i for i in chunk if i["id"] not in covered]

    def _debug_dump(self, provider: str, n: int, prompt: str, text: str) -> None:
        if not self.debug_dir:
            return
        self.debug_dir.mkdir(parents=True, exist_ok=True)
        stem = f"{int(self.clock())}_{provider}_{n}"
        (self.debug_dir / f"{stem}_prompt.txt").write_text(prompt, encoding="utf-8")
        (self.debug_dir / f"{stem}_answer.json").write_text(text, encoding="utf-8")

    def _log_call(self, p, ok, n_items, res: ai.CallResult | None, error: str | None,
                  kind: str = "batch") -> None:
        m = HTTP_CODE.search(error or "")   # Step 13: the guard counts 429s by this code
        self.calls_log.append((int(self.clock()), p.name, p.model, 1 if ok else 0, n_items,
                               res.input_tokens if res else None, res.output_tokens if res else None,
                               res.ms if res else None, (error or "")[:500] or None, kind,
                               int(m.group(1)) if m else None))
        # Step 20: every paid call that cost money goes to ai_spend, with why the free options failed
        usd = getattr(p, "last_cost", None) if p.name == "gemini_paid" else None
        if usd:
            self.spend_log.append((int(self.clock()), "job", p.model, kind,
                                   res.input_tokens if res else None, res.output_tokens if res else None,
                                   round(float(usd), 6), chain.free_failures(self.calls_log[:-1])[:300]))

    def apply(self, stories: list[ai.StoryOut], chunk: list[dict], existing: list[dict],
              not_news: set[int], now: int, stats: RunStats) -> None:
        by_id = {i["id"]: i for i in chunk}
        existing_by_id = {s["id"]: s for s in existing}
        new_stories, merges = [], {}
        for s in stories:
            if s.existing_story_id is not None:
                merges.setdefault(s.existing_story_id, []).append(s)
            else:
                new_stories.append(s)

        inserts = []
        for s in new_stories:
            items = [by_id[i] for i in s.item_ids]
            summary = custom.spell_names(s.summary or ai.clean_summary(best_item(items)["title"]))
            best = best_item(items, summary)
            # Step 14: a custom tag only with one of its keywords in the summary (job/custom.py)
            tags = self.rule.tags(list(s.topics), summary)
            inserts.append((
                "INSERT INTO stories (summary, topics, importance, best_url, best_source, best_tier, "
                "best_published_at, source_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) "
                "RETURNING id",
                [summary, json.dumps(tags), s.importance, best["url"], best["source_name"],
                 best["tier"], best["published_at"], len(items), now, now]))
        merge_stmts, item_updates = [], []
        old_items = self.old_best_items(merges, existing_by_id)
        for story_id, outs in merges.items():
            old = existing_by_id[story_id]
            items = [by_id[i] for o in outs for i in o.item_ids]
            tags = set(json.loads(old["topics"])) | {t for o in outs for t in o.topics}
            summary = custom.spell_names(next((o.summary for o in outs if o.summary), old["summary"]))
            # Step 14: the new summary or the story's current headline and description
            tags = set(self.rule.tags(sorted(tags), "\n".join(
                [summary, old.get("headline") or "", old.get("description") or ""])))
            importance = max([old["importance"], *(o.importance for o in outs)])
            cand = best_item(items, summary)
            # The old link is scored like a new one (Step 7): an English title that matches the
            # summary beats a Russian/Armenian one, so a later English article can take over.
            old_rel = relevance(old_items[story_id], summary) if story_id in old_items else 0
            old_key = (old_rel, old["best_tier"], old["best_published_at"] if old["best_published_at"] is not None
                       else float("inf"))
            if link_key(cand, summary)[:3] < old_key:
                url, source, tier, pub = cand["url"], cand["source_name"], cand["tier"], cand["published_at"]
            else:
                url, source, tier, pub = (old["best_url"], old["best_source"], old["best_tier"],
                                          old["best_published_at"])
            # A new core fact (new summary) makes the editor's headline stale: edit it again.
            merge_stmts.append((
                "UPDATE stories SET summary=?, topics=?, importance=?, best_url=?, best_source=?, "
                "best_tier=?, best_published_at=?, source_count=source_count+?, updated_at=?, "
                "edited_at = CASE WHEN ? THEN NULL ELSE edited_at END WHERE id=?",
                [summary, json.dumps([t for t in self.topic_order if t in tags]), importance, url,
                 source, tier, pub, len(items), now, 1 if summary != old["summary"] else 0, story_id]))
            item_updates.append((story_id, [i["id"] for i in items]))

        results = self.db.batch(inserts + merge_stmts)
        for s, rows in zip(new_stories, results[:len(inserts)]):
            item_updates.append((rows[0]["id"], s.item_ids))

        placed = {i for _, ids in item_updates for i in ids}
        dropped = [i for i in by_id if i not in placed]
        # Step 17c: held items are written once, in their final state; items already in D1
        # (pending from an earlier run) are updated as before.
        stmts, new_rows = [], []
        for story_id, ids in item_updates:
            stored = []
            for i in ids:
                h = self.held.pop(i, None)
                if h is not None:
                    new_rows.append({**h, "status": "done", "story_id": story_id})
                elif not any(r["id"] == i for r in new_rows):
                    stored.append(i)
            stmts += in_list_statements("UPDATE items SET status='done', story_id=? WHERE id IN ({qs})",
                                        stored, [story_id])
        stmts += self.item_insert_statements(new_rows)
        gone = [self.held.pop(i) for i in dropped if i in self.held]
        stmts += insert_statements("items_seen", ("url_hash", "source_key", "at"),
                                   [(h["url_hash"], h["source_key"], now) for h in gone],
                                   suffix="ON CONFLICT DO NOTHING")
        gone_ids = {h["id"] for h in gone}
        stmts += in_list_statements("UPDATE items SET status='dropped' WHERE id IN ({qs})",
                                    [i for i in dropped if i not in gone_ids])
        self.db.batch(stmts)
        stats.stories_created += len(new_stories)
        stats.stories_merged += len(merges)
        stats.items_dropped += len(dropped)
        stats.items_unaccounted += sum(1 for i in dropped if i not in not_news)

    def old_best_items(self, merges: dict, existing_by_id: dict) -> dict[int, dict]:
        """Title and snippet of the current best link of each story that gains items, looked up
        by URL hash (indexed; one small read per merged story)."""
        hashes = {url_hash(existing_by_id[sid]["best_url"]): sid for sid in merges}
        out: dict[int, dict] = {}
        if not hashes:
            return out
        for rows in self.db.batch(in_list_statements(
                "SELECT url_hash, title, snippet FROM items WHERE url_hash IN ({qs})", list(hashes))):
            for r in rows:
                out[hashes[r["url_hash"]]] = r
        return out

    # ------------------------------------------------------------ editor pass

    def run_editor(self, now: int, stats: RunStats) -> "editor.EditorResult":
        """The second AI call (job/editor.py). Never fails the run: if it cannot edit, the
        stories keep their first-pass data and digests still work from it."""
        ed = editor.Editor(
            self.db, self.plans, topics=self.ai_topics, facts=self.prompt.facts,
            facts_checked=self.prompt.facts_checked, settings=self.s, log=self.log,
            on_call=lambda p, ok, n, res, err: self._log_call(p, ok, n, res, err, kind="editor"),
            debug_dir=self.debug_dir)
        try:
            res = ed.run(now)
        except Exception as exc:
            res = editor.EditorResult(status="failed", errors=[f"editor: {type(exc).__name__}: {exc}"])
        stats.input_tokens += res.input_tokens
        stats.output_tokens += res.output_tokens
        stats.ai_errors += res.errors
        if res.status == "failed" and not res.errors:
            stats.ai_errors.append("editor: no provider gave a usable answer")
        if res.guard_dropped:
            stats.ai_errors.append(f"editor: fact guard dropped {len(res.guard_dropped)} texts: "
                                   + "; ".join(res.guard_dropped)[:400])
        self.log(res.line())
        return res

    # ------------------------------------------------------------ translation pass

    def run_translate(self, now: int, stats: RunStats) -> "translate.TranslateResult":
        """Step 9 (job/translate.py): reader-language headlines and descriptions. Never fails the
        run: stories without a translation are retried next hour, and their digests go out in
        English meanwhile."""
        tr = translate.Translator(
            self.db, getattr(self.plans, "translate", self.plans), settings=self.s, topic_tags=self.topic_order,
            log=self.log, digest_cfg=self.merged_digest_cfg(),
            on_call=lambda p, ok, n, res, err, kind: self._log_call(p, ok, n, res, err, kind=kind),
            debug_dir=self.debug_dir)
        try:
            res = tr.run(now, getattr(self, "eligible_rows", None))
        except Exception as exc:
            res = translate.TranslateResult(status="failed", errors=[f"translate: {type(exc).__name__}: {exc}"])
        stats.input_tokens += res.input_tokens
        stats.output_tokens += res.output_tokens
        stats.ai_errors += res.errors
        self.log(res.line())
        return res

    # ------------------------------------------------------------ Step 13: custom topics

    def _custom_cfg(self) -> dict:
        if self.custom_cfg is None:
            self.custom_cfg = custom.load_config()
        return self.custom_cfg

    def merged_digest_cfg(self) -> dict:
        """config/digest.json for translate's eligibility and link resolution (the same rule as the
        Worker's digest). Step 13 fixes: custom topics have no boost cap; the rule in
        translate.ELIGIBLE_SQL / qualifies() uses their topic score as it is."""
        return dict(self.digest_cfg or translate.load_digest_config())

    def load_custom(self, stats: RunStats) -> None:
        """The custom topics active readers follow join the AI passes' topic list. A failure
        leaves the run with the main topics only."""
        try:
            self.custom_topics = custom.load_active(self.db)
        except Exception as exc:
            self.custom_topics = []
            stats.custom_errors.append(f"custom topics: load failed: {type(exc).__name__}: {exc}")
        floor = self._custom_cfg().get("editor_floor") if self.custom_topics else None
        self.ai_topics = list(self.topics) + [{**t.as_topic(), "floor": floor} for t in self.custom_topics]
        self.topic_order = self.main_order + [t.tag for t in self.custom_topics]
        self.rule = custom.KeywordRule(self.ai_topics)

    def run_keywords(self, stats: RunStats) -> None:
        """Step 14: match keywords for custom topics that have none yet; Step 15: refreshed weekly and
        on the owner's Admin button (one AI call a topic, at most 5 a run)."""
        try:
            done = custom.backfill_keywords(
                self.db, self.plans, on_call=lambda p, ok, n, res, err, kind: self._log_call(p, ok, n, res, err, kind=kind))
            if done:
                self.log(f"custom topics: keywords written for {', '.join(done)}")
        except Exception as exc:
            stats.custom_errors.append(f"custom topics: keywords failed: {type(exc).__name__}: {exc}")

    def run_enforce(self, now: int, stats: RunStats) -> None:
        """Step 14: the keyword rule over the digest window (stories written before it, or before
        their topic had keywords)."""
        try:
            changed = custom.enforce(self.db, self.rule, now)
            stats.custom_unkeyed = len(changed)
            if changed:
                self.log(f"custom topics: keyword rule took {len(changed)} stories off a custom topic")
        except Exception as exc:
            stats.custom_errors.append(f"custom topics: keyword rule failed: {type(exc).__name__}: {exc}")

    def run_custom_search(self, now: int, stats: RunStats) -> None:
        if not self.custom_topics:
            return
        try:
            res = custom.Searcher(self.db, cfg=self._custom_cfg(), fetcher=self.gnews_fetcher,
                                  clock=self.clock, log=self.log, hold=self.hold,
                                  held={h["url_hash"]: h["title"] for h in self.held.values()}
                                  ).run(self.custom_topics, now)
            stats.custom = res
            self.log(res.line())
            if res.stopped:
                stats.custom_errors.append(f"custom topics: {res.stopped}; the other searches wait for the next run")
        except Exception as exc:
            stats.custom_errors.append(f"custom topics: search failed: {type(exc).__name__}: {exc}")

    def run_resolve_links(self, now: int, stats: RunStats) -> None:
        try:
            cfg = self.merged_digest_cfg()
            rows = self.db.query(translate.ELIGIBLE_SQL, translate.eligible_params(now, cfg, self.topic_order))
            self.eligible_rows = rows   # Step 17: the translation step reuses them (one read a run, not two)
            res = custom.resolve_links(self.db, [int(r["id"]) for r in rows], cfg=self._custom_cfg(),
                                       resolver=self.link_resolver, clock=self.clock)
            stats.links = res
            if res.tried:
                self.log(res.line())
            if res.failed:
                stats.custom_errors.append(f"{res.line()}: " + "; ".join(res.errors)[:400])
        except Exception as exc:
            stats.custom_errors.append(f"google links: {type(exc).__name__}: {exc}")

    def run_cleanup(self, now: int, stats: RunStats) -> None:
        try:
            stats.custom_deleted = custom.cleanup(self.db, now, self._custom_cfg())
            if stats.custom_deleted:
                self.log(f"custom topics: {stats.custom_deleted} deleted after 7 days without followers")
        except Exception as exc:
            stats.custom_errors.append(f"custom topics: cleanup failed: {type(exc).__name__}: {exc}")

    def check_guard(self, now: int, stats: RunStats) -> dict:
        """The AI budget guard (job/guard.py), counting this run's calls not yet written too. Never
        stops pass 1 or the editor: it is asked only before translation."""
        cfg = self.budget_cfg or guard.load_budget()
        recent = now - int(cfg.get("recent_429_minutes", 60)) * 60
        extra: dict = {}
        for c in self.calls_log:
            e = extra.setdefault(c[2], {"calls": 0, "r429": 0, "recent429": 0})
            e["calls"] += 1
            if c[10] == 429:
                e["r429"] += 1
                if c[0] >= recent:
                    e["recent429"] += 1
        try:
            state = guard.check(self.db, now, cfg, extra)
        except Exception as exc:   # an unreadable count never delays anything
            stats.custom_errors.append(f"ai guard: {type(exc).__name__}: {exc}")
            state = {"level": 0, "reasons": [], "day": guard.pacific_day(now)[0], "at": now, "counts": {}}
        stats.guard = state
        return state

    # ------------------------------------------------------------ housekeeping

    def prune_daily(self, now: int) -> int | None:
        row = self.db.query("SELECT max(started_at) AS t FROM job_runs WHERE pruned IS NOT NULL")
        last = row[0]["t"] if row else None
        if last is not None and now - last < 23 * 3600:
            return None
        cut = int(now - self.s.retention_days * 86400)
        log_cut = int(now - self.s.log_retention_days * 86400)
        results = self.db.batch([
            ("DELETE FROM story_translations WHERE story_id IN (SELECT id FROM stories WHERE updated_at < ?) "
             "RETURNING story_id", [cut]),
            ("DELETE FROM sent WHERE story_id IN (SELECT id FROM stories WHERE updated_at < ?) "
             "RETURNING story_id", [cut]),
            ("DELETE FROM stories WHERE updated_at < ? RETURNING id", [cut]),
            ("DELETE FROM items WHERE fetched_at < ? RETURNING id", [cut]),
            ("DELETE FROM items_seen WHERE at < ? RETURNING url_hash", [cut]),   # Step 17c
            ("DELETE FROM job_runs WHERE started_at < ? RETURNING id", [log_cut]),
            ("DELETE FROM ai_calls WHERE at < ? RETURNING id", [log_cut]),
            ("DELETE FROM errors WHERE at < ? RETURNING id", [log_cut]),
            ("DELETE FROM digest_holds WHERE at < ? RETURNING story_id", [log_cut]),   # Step 10
        ])
        return sum(len(r) for r in results)

    # ------------------------------------------------------------ main

    def run(self) -> RunStats:
        t0 = self.clock()
        now = int(t0)
        stats = RunStats()
        self.held, self.held_hashes, self.next_id = {}, set(), None
        run_id = self.db.query("INSERT INTO job_runs (started_at, status) VALUES (?, 'running') "
                               "RETURNING id", [now])[0]["id"]
        status, error = "error", None
        try:
            self.sync_topics()
            if self.custom_enabled:
                self.run_keywords(stats)
                self.load_custom(stats)
            since = self.lookback_since(now)
            results = self.fetcher(self.sources, now)
            self.feed_health = feed_health(self.load_feed_health(), results, now)
            stats.feeds_ok = sum(1 for r in results if not r.error)
            stats.failed_feeds = [f"{r.source['key']} ({r.error})" for r in results if r.error]
            stats.feeds_failed = len(stats.failed_feeds)
            entries = candidates(results, since)
            stats.items_fetched = len(entries)
            stats.items_new = self.store_new(entries, now)
            stats.cap_cut = dict(self.cap_cut)
            for key, n in self.cap_cut.items():   # shown nowhere yet; kept for tuning the caps
                if key in self.feed_health["feeds"]:
                    self.feed_health["feeds"][key]["cut"] = n
            if self.custom_enabled:
                self.run_custom_search(now, stats)
            stats.items_expired = self.expire_old_pending(now)
            pending = self.load_pending()
            stats.items_pending_in = len(pending)
            left = self.run_ai(pending, now, stats)
            self.flush_held()
            stats.items_left_pending = len(left)
            for plan in self.plans:   # Step 20: what the Groq pool did (busy, bad answers, models out)
                ev = getattr(plan.provider, "events", None)
                if ev:
                    counts: dict[str, int] = {}
                    for e in ev:
                        k = e if "out for the run" in e else e.split(" ")[0] + " " + e.split(": ", 1)[1].split(" ")[0]
                        counts[k] = counts.get(k, 0) + 1
                    stats.ai_errors.append("groq pool: " + "; ".join(f"{k} x{n}" for k, n in counts.items())[:600])
            stats.ai_calls = len(self.calls_log)
            try:   # a grouping failure must not fail the run; digests then just skip dedupe
                regrouped = dupes.update_groups(self.db, now)
                self.log(f"near-duplicate groups: {regrouped} stories changed group")
            except Exception as exc:
                stats.ai_errors.append(f"dupes: {type(exc).__name__}: {exc}")
            stats.editor = self.run_editor(now, stats) if self.editor_enabled else None
            if self.custom_enabled:
                self.run_enforce(now, stats)
                self.run_resolve_links(now, stats)
            state = self.check_guard(now, stats)
            if self.translate_enabled and state["level"] >= 2:
                stats.translate_delayed = True
                self.log("translate: delayed by the AI guard: " + "; ".join(state["reasons"]))
            elif self.translate_enabled:
                stats.translate = self.run_translate(now, stats)
            stats.ai_calls = len(self.calls_log)
            stats.pruned = self.prune_daily(now)
            if self.custom_enabled:
                self.run_cleanup(now, stats)
            processed = stats.items_pending_in - stats.items_left_pending
            if not left:
                status = "ok"
            else:
                status = "partial" if processed else "ai_failed"
            if stats.ai_errors:
                error = " | ".join(stats.ai_errors)[:1000]
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"[:1000]
            self.log(traceback.format_exc())
            raise
        finally:
            try:   # a crash before the AI pass ended: keep what was fetched as 'pending'
                self.flush_held()
            except Exception as exc:
                self.log(f"could not store the held items: {exc}")
            self._finish(run_id, now, status, error, stats)
            stats_ms = int((self.clock() - t0) * 1000)
            self.log(self.summary(status, stats, stats_ms))
            self.log(f"D1: {getattr(self.db, 'calls', 0)} calls, rows read {getattr(self.db, 'rows_read', 0)}, "
                     f"rows written {getattr(self.db, 'rows_written', 0)}")
            if hasattr(self.db, "top_reads"):   # Step 17: where the reads go (GitHub log only)
                for shape, times, rows in self.db.top_reads():
                    self.log(f"  D1 read {rows:>7} rows in {times:>3}x: {shape}")
        return stats

    def _finish(self, run_id: int, now: int, status: str, error: str | None, stats: RunStats) -> None:
        stmts = [(
            "UPDATE job_runs SET finished_at=?, status=?, feeds_ok=?, feeds_failed=?, items_fetched=?, "
            "items_new=?, items_pending_in=?, stories_created=?, stories_merged=?, items_dropped=?, "
            "items_expired=?, items_left_pending=?, provider=?, ai_calls=?, input_tokens=?, "
            "output_tokens=?, pruned=?, error=?, d1_rows_read=?, d1_rows_written=?, editor_status=?, "
            "editor_candidates=?, editor_merged=? WHERE id=?",
            [int(self.clock()), status, stats.feeds_ok, stats.feeds_failed, stats.items_fetched,
             stats.items_new, stats.items_pending_in, stats.stories_created, stats.stories_merged,
             stats.items_dropped, stats.items_expired, stats.items_left_pending, stats.provider,
             len(self.calls_log), stats.input_tokens, stats.output_tokens, stats.pruned, error,
             getattr(self.db, "rows_read", 0), getattr(self.db, "rows_written", 0),
             stats.editor.status if stats.editor else None,
             stats.editor.candidates if stats.editor else None,
             stats.editor.merged if stats.editor else None, run_id])]
        if self.feed_health is not None:
            stmts.append(("INSERT INTO meta (key, value) VALUES ('feed_health', ?) "
                          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                          [json.dumps(self.feed_health, separators=(",", ":"), ensure_ascii=False)]))
        stmts += insert_statements(
            "ai_calls", ("at", "provider", "model", "ok", "items", "input_tokens", "output_tokens", "ms",
                         "error", "kind", "code", "run_id"),
            [(*c, run_id) for c in self.calls_log])
        stmts += insert_statements(   # Step 20: the paid key's spend (a normal run has none)
            "ai_spend", ("at", "source", "model", "kind", "input_tokens", "output_tokens", "usd", "reason"),
            self.spend_log)
        errors = list(stats.ai_errors) + ([error] if status == "error" and error else [])
        stmts += insert_statements("errors", ("at", "component", "message"),
                                   [(now, "job", e[:1000]) for e in errors]
                                   + [(now, "custom", e[:1000]) for e in stats.custom_errors])
        if stats.guard is not None:
            # the Worker shows it in Admin and alerts the owner once a day when level > 0
            g = {**stats.guard, "translate_delayed": stats.translate_delayed}
            stmts.append(("INSERT INTO meta (key, value) VALUES ('ai_guard', ?) "
                          "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                          [json.dumps(g, separators=(",", ":"), ensure_ascii=False)]))
        try:
            self.db.batch(stmts)
        except Exception as exc:  # never hide the original error behind a logging failure
            self.log(f"could not write run log: {exc}")

    @staticmethod
    def summary(status: str, s: RunStats, ms: int) -> str:
        lines = [
            f"status {status} in {ms / 1000:.1f}s | feeds ok {s.feeds_ok}, failed {s.feeds_failed}",
            f"items: in window {s.items_fetched}, new {s.items_new}, sent to AI {s.items_pending_in}, "
            f"expired {s.items_expired}, left pending {s.items_left_pending}",
            f"stories: created {s.stories_created}, merged into existing {s.stories_merged}; "
            f"items dropped {s.items_dropped} (of which unaccounted {s.items_unaccounted})",
            f"AI: provider {s.provider}, calls {s.ai_calls}, tokens in {s.input_tokens} out {s.output_tokens}"
            f" | pruned {s.pruned}",
            s.editor.line() if s.editor else "editor: not run",
            s.translate.line() if s.translate else
            ("translate: delayed by the AI guard" if s.translate_delayed else "translate: not run"),
        ]
        if s.custom:
            lines.append(s.custom.line())
        if s.links and s.links.tried:
            lines.append(s.links.line())
        if s.guard and s.guard.get("level"):
            lines.append(f"AI guard: level {s.guard['level']}: " + "; ".join(s.guard.get("reasons") or []))
        for e in s.custom_errors:
            lines.append("custom: " + e[:300])
        if s.failed_feeds:
            lines.append("failed feeds: " + ", ".join(s.failed_feeds))
        if s.cap_cut:
            lines.append("cap cut (new items left out by the per-feed cap): "
                         + ", ".join(f"{k} {n}" for k, n in sorted(s.cap_cut.items())))
        for e in s.ai_errors:
            lines.append("AI error: " + e[:300])
        return "\n".join(lines)


class ForcedFailSession(requests.Session):
    """Step 20 tests on staging only (AXIOM_AI_FORCE): every POST answers this HTTP status without
    reaching the provider, so the real chain code handles a real-looking outage."""

    def __init__(self, status: int):
        super().__init__()
        self.status = status

    def post(self, url, *args, **kwargs):   # noqa: D401
        resp = requests.Response()
        resp.status_code = self.status
        resp._content = json.dumps({"error": {"code": self.status, "message": f"forced {self.status} (AXIOM_AI_FORCE test)",
                                              "status": "UNAVAILABLE"}}).encode()
        resp.headers["content-type"] = "application/json"
        resp.url = url
        return resp


def parse_force(value: str | None) -> dict:
    """AXIOM_AI_FORCE (staging tests only): comma list of gemini503 (every free Gemini model of pass 1,
    the editor and keywords), translate503 (the free translation models too), groq503, nopaid."""
    parts = {x.strip() for x in (value or "").split(",") if x.strip()}
    if parts and os.environ.get("AXIOM_ENV") != "staging":
        raise SystemExit("AXIOM_AI_FORCE is for staging tests only (AXIOM_ENV=staging)")
    return {k: k in parts for k in ("gemini503", "translate503", "groq503", "nopaid")}


def build_from_env(env: dict[str, str], settings: Settings, budget_cfg: dict | None = None,
                   now: int | None = None) -> tuple[D1, "PlanList"]:
    """Step 20: the chain from config/ai_budget.json. Pass 1, editor, keywords: each free Gemini model,
    Groq's models in rotation, then the emergency key (only if every free option failed for a call,
    under hard caps). Translations: the strong free models, then the emergency key's translation
    models; never Groq."""
    missing = [k for k in ("GEMINI_API_KEY", "GROQ_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID",
                           "CLOUDFLARE_D1_TOKEN") if not env.get(k)]
    if missing:
        raise SystemExit(f"missing settings: {', '.join(missing)} (see .env.example)")
    cfg = budget_cfg or guard.load_budget()
    ch, em = cfg.get("chain") or {}, cfg.get("emergency") or {}
    force = parse_force(env.get("AXIOM_AI_FORCE"))
    now = int(time.time()) if now is None else now
    db = D1(env["CLOUDFLARE_ACCOUNT_ID"], env["D1_DATABASE_ID"], env["CLOUDFLARE_D1_TOKEN"])
    budget = ai.RetryBudget(float(ch.get("retry_budget_s", 150)), time.monotonic() + settings.run_budget_s)
    delays = tuple(float(x) for x in ch.get("retry_503_s", (5, 15, 30)))
    free_key = ai.KeyState("free")

    def gemini(model, failing=False):
        return ai.GeminiProvider(env["GEMINI_API_KEY"], model, retry_delays=delays, budget=budget, key=free_key,
                                 session=ForcedFailSession(503) if failing else None)

    models = list(ch.get("gemini_free") or ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"])
    if env.get("GEMINI_MODEL"):           # the workflow may pin the first two (as before Step 20)
        models[0] = env["GEMINI_MODEL"]
    if env.get("GEMINI_FALLBACK_MODEL") and len(models) > 1:
        models[1] = env["GEMINI_FALLBACK_MODEL"]
    models = list(dict.fromkeys(models))
    plans = PlanList(forced=",".join(k for k, v in force.items() if v))
    for i, m in enumerate(models):
        plans.append(ProviderPlan(gemini(m, force["gemini503"]), settings.gemini_max_input_tokens,
                                  settings.existing_max, max_chunks=4, label="gemini" if i == 0 else "gemini-fallback"))
    groq_models = list(ch.get("groq") or [env.get("GROQ_MODEL") or "openai/gpt-oss-120b"])
    pool = chain.GroqPool([ai.GroqProvider(env["GROQ_API_KEY"], m, max_output_tokens=settings.groq_reply_tokens,
                                           wait_429=False, session=ForcedFailSession(503) if force["groq503"] else None)
                           for m in groq_models])
    plans.append(ProviderPlan(pool, settings.groq_chunk_tokens, settings.groq_existing_max,
                              max_chunks=settings.groq_max_chunks_per_run, reply_tokens=settings.groq_reply_tokens))
    translate_plans = [ProviderPlan(gemini(m, force["translate503"]), settings.gemini_max_input_tokens,
                                    settings.existing_max, max_chunks=1, label=m)
                       for m in ch.get("translate_free") or ["gemini-3.8-flash"]]
    spend = None
    if env.get("GEMINI_EMERGENCY_API_KEY") and em and not force["nopaid"]:
        spend = chain.SpendGuard.load(db, em, now)
        paid_key = ai.KeyState("paid")
        plans.append(ProviderPlan(chain.EmergencyProvider(env["GEMINI_EMERGENCY_API_KEY"], em["model"], spend, key=paid_key),
                                  settings.emergency_chunk_tokens, settings.existing_max,
                                  max_chunks=settings.emergency_max_chunks, label="emergency", paid=True))
        for m in em.get("translate_models") or [em["model"]]:
            translate_plans.append(ProviderPlan(chain.EmergencyProvider(env["GEMINI_EMERGENCY_API_KEY"], m, spend, key=paid_key),
                                                settings.gemini_max_input_tokens, settings.existing_max, max_chunks=1,
                                                label=f"emergency:{m}", paid=True))
    plans.translate = translate_plans
    plans.spend = spend
    plans.budget = budget
    return db, plans


def recent_run_started(db, now: int, min_gap_minutes: float) -> int | None:
    """Start time of a run that began less than `min_gap_minutes` ago, else None. Lets the
    Worker trigger and the backup GitHub schedule overlap safely: the later one does nothing."""
    if min_gap_minutes <= 0:
        return None
    rows = db.query("SELECT started_at FROM job_runs ORDER BY id DESC LIMIT 1")
    if rows and now - int(rows[0]["started_at"]) < min_gap_minutes * 60:
        return int(rows[0]["started_at"])
    return None


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="One hourly run: fetch feeds, AI pass, write stories to D1.")
    parser.add_argument("--min-gap-minutes", type=float, default=0,
                        help="do nothing if a run started less than this many minutes ago (default 0: always run)")
    args = parser.parse_args(argv)
    settings = Settings()
    db, plans = build_from_env(load_env(), settings)
    started = recent_run_started(db, int(time.time()), args.min_gap_minutes)
    if started is not None:
        print(f"skipped: a run started {(int(time.time()) - started) / 60:.0f} min ago "
              f"(min gap {args.min_gap_minutes:g} min)")
        return 0
    try:
        Job(db, plans, settings=settings, debug_dir=load_env().get("AXIOM_DEBUG_DIR")).run()
    except Exception:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
