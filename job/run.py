"""Hourly job entry point.

    venv/Scripts/python -m job.run

Steps: sync topics -> fetch feeds -> store new items as 'pending' -> expire pending items
older than 24 h -> AI pass over every pending item (Gemini, then Groq for whatever is left)
-> write stories -> daily prune -> log the run. Items whose AI call failed stay 'pending'
and are retried next run (docs/ARCHITECTURE.md section 7).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from datetime import datetime, timezone
from typing import Callable

from job import ai
from job.config import Prompt, Settings, load_env, load_prompt, load_sources, load_topics
from job.d1 import D1, in_list_statements, insert_statements
from job.fetch import Entry, FeedResult, candidates, fetch_all, select_new

# Failures that say nothing about the provider itself, only this one chunk's output:
# the chunk is left for the next provider, but the same provider keeps going.
CONTENT_FAILURES = {"blocked", "empty", "truncated", "invalid", "too_large"}
# In every real answer seen in Step 2, 50-80% of items went into stories. Fewer than 10% of
# 20+ items means the model gave up (seen once: 0 of 435), so that answer is retried.
MIN_PLACED_SHARE = 0.10
# Answers to very large chunks sometimes stop early (190 of 516 items covered). Up to 10% of
# items left out counts as "not news"; more than that, the skipped items are sent again.
MAX_SKIPPED_SHARE = 0.10
ITEM_COLUMNS = ("url_hash", "source_key", "source_name", "tier", "url", "title", "snippet",
                "published_at", "fetched_at", "status")


@dataclass
class ProviderPlan:
    provider: ai.Provider
    budget_tokens: int      # max estimated prompt tokens per call
    existing_max: int       # existing stories shown per call
    max_chunks: int         # max calls per run
    reply_tokens: int = 0   # reserved reply size, for tokens-per-minute pacing (Groq)
    label: str = ""         # name used in job_runs.provider (default: provider name)

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
    ai_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    pruned: int | None = None
    failed_feeds: list[str] = field(default_factory=list)
    ai_errors: list[str] = field(default_factory=list)

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


class Job:
    def __init__(self, db, plans: list[ProviderPlan], *, settings: Settings | None = None,
                 topics: list[dict] | None = None, sources: list[dict] | None = None,
                 prompt: Prompt | None = None,
                 fetcher: Callable[[list[dict], int], list[FeedResult]] | None = None,
                 clock: Callable[[], float] = time.time, log: Callable[[str], None] = print,
                 debug_dir: str | None = None):
        self.db = db
        self.plans = plans
        self.s = settings or Settings()
        self.topics = topics if topics is not None else load_topics()
        self.topic_order = [t["tag"] for t in self.topics]
        self.sources = sources if sources is not None else load_sources()
        self.prompt = prompt or load_prompt()
        self.fetcher = fetcher or self._fetch
        self.clock = clock
        self.log = log
        self.calls_log: list[tuple] = []
        self.debug_dir = Path(debug_dir) if debug_dir else None   # saves raw prompts/answers

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
        stmts += in_list_statements("DELETE FROM topics WHERE tag NOT IN ({qs})", self.topic_order)
        self.db.batch(stmts)

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
        hashes = [e.url_hash for e in entries]
        seen: set[str] = set()
        for rows in self.db.batch(in_list_statements(
                "SELECT url_hash FROM items WHERE url_hash IN ({qs})", hashes)):
            seen.update(r["url_hash"] for r in rows)
        new = select_new(entries, seen, self.s.max_items_per_feed)
        rows = [(e.url_hash, e.source_key, e.source_name, e.tier, e.url, e.title, e.snippet,
                 e.published_at, now, "pending") for e in new]
        self.db.batch(insert_statements("items", ITEM_COLUMNS, rows,
                                        suffix="ON CONFLICT(url_hash) DO NOTHING"))
        return len(new)

    def expire_old_pending(self, now: int) -> int:
        cutoff = int(now - self.s.pending_max_age_h * 3600)
        rows = self.db.query("UPDATE items SET status = 'expired' WHERE status = 'pending' "
                             "AND fetched_at < ? RETURNING id", [cutoff])
        return len(rows)

    def load_pending(self) -> list[dict]:
        return self.db.query(
            "SELECT id, source_name, tier, url, title, snippet, published_at, fetched_at FROM items "
            "WHERE status = 'pending' ORDER BY coalesce(published_at, fetched_at), id")

    def load_existing(self, now: int, limit: int) -> list[dict]:
        if limit <= 0:
            return []
        since = int(now - self.s.existing_window_h * 3600)
        return self.db.query(
            "SELECT id, summary, topics, importance, best_url, best_source, best_tier, "
            "best_published_at FROM stories WHERE updated_at >= ? ORDER BY updated_at DESC LIMIT ?",
            [since, limit])

    def render(self, items: list[dict], existing: list[dict], now: int) -> str:
        return ai.render_prompt(
            self.prompt.template, today=datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d"),
            topics=self.topics, facts=self.prompt.facts, facts_checked=self.prompt.facts_checked,
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
        for plan in self.plans:
            if not queue:
                break
            p = plan.provider
            fixed = ai.estimate_tokens(self.render([], self.load_existing(now, plan.existing_max), now))
            work = [(c, False) for c in ai.make_chunks(queue, plan.budget_tokens, fixed)]
            leftover: list[dict] = []
            calls = 0
            while work:
                chunk, retried = work.pop(0)
                if calls >= plan.max_chunks:
                    leftover.extend(chunk)
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
                    else:                       # provider is down/limited: hand the rest on
                        leftover.extend(chunk)
                        for rest, _ in work:
                            leftover.extend(rest)
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
                    else:
                        work.insert(0, (missing, True))
                else:   # a few skipped items count as not news (items_unaccounted)
                    self.apply(stories, chunk, existing, not_news, now, stats)
                if plan.label not in stats.providers:
                    stats.providers.append(plan.label)
            queue = leftover
        return queue

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

    def _log_call(self, p, ok, n_items, res: ai.CallResult | None, error: str | None) -> None:
        self.calls_log.append((int(self.clock()), p.name, p.model, 1 if ok else 0, n_items,
                               res.input_tokens if res else None, res.output_tokens if res else None,
                               res.ms if res else None, (error or "")[:500] or None))

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
            summary = s.summary or ai.clean_summary(best_item(items)["title"])
            best = best_item(items, summary)
            inserts.append((
                "INSERT INTO stories (summary, topics, importance, best_url, best_source, best_tier, "
                "best_published_at, source_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) "
                "RETURNING id",
                [summary, json.dumps(s.topics), s.importance, best["url"], best["source_name"],
                 best["tier"], best["published_at"], len(items), now, now]))
        merge_stmts, item_updates = [], []
        for story_id, outs in merges.items():
            old = existing_by_id[story_id]
            items = [by_id[i] for o in outs for i in o.item_ids]
            tags = set(json.loads(old["topics"])) | {t for o in outs for t in o.topics}
            summary = next((o.summary for o in outs if o.summary), old["summary"])
            importance = max([old["importance"], *(o.importance for o in outs)])
            cand = best_item(items, summary)
            old_key = (0, old["best_tier"], old["best_published_at"] if old["best_published_at"] is not None
                       else float("inf"))
            if link_key(cand, summary)[:3] < old_key:
                url, source, tier, pub = cand["url"], cand["source_name"], cand["tier"], cand["published_at"]
            else:
                url, source, tier, pub = (old["best_url"], old["best_source"], old["best_tier"],
                                          old["best_published_at"])
            merge_stmts.append((
                "UPDATE stories SET summary=?, topics=?, importance=?, best_url=?, best_source=?, "
                "best_tier=?, best_published_at=?, source_count=source_count+?, updated_at=? WHERE id=?",
                [summary, json.dumps([t for t in self.topic_order if t in tags]), importance, url,
                 source, tier, pub, len(items), now, story_id]))
            item_updates.append((story_id, [i["id"] for i in items]))

        results = self.db.batch(inserts + merge_stmts)
        for s, rows in zip(new_stories, results[:len(inserts)]):
            item_updates.append((rows[0]["id"], s.item_ids))

        placed = {i for _, ids in item_updates for i in ids}
        dropped = [i for i in by_id if i not in placed]
        stmts = []
        for story_id, ids in item_updates:
            stmts += in_list_statements("UPDATE items SET status='done', story_id=? WHERE id IN ({qs})",
                                        ids, [story_id])
        stmts += in_list_statements("UPDATE items SET status='dropped' WHERE id IN ({qs})", dropped)
        self.db.batch(stmts)
        stats.stories_created += len(new_stories)
        stats.stories_merged += len(merges)
        stats.items_dropped += len(dropped)
        stats.items_unaccounted += sum(1 for i in dropped if i not in not_news)

    # ------------------------------------------------------------ housekeeping

    def prune_daily(self, now: int) -> int | None:
        row = self.db.query("SELECT max(started_at) AS t FROM job_runs WHERE pruned IS NOT NULL")
        last = row[0]["t"] if row else None
        if last is not None and now - last < 23 * 3600:
            return None
        cut = int(now - self.s.retention_days * 86400)
        log_cut = int(now - self.s.log_retention_days * 86400)
        results = self.db.batch([
            ("DELETE FROM sent WHERE story_id IN (SELECT id FROM stories WHERE updated_at < ?) "
             "RETURNING story_id", [cut]),
            ("DELETE FROM stories WHERE updated_at < ? RETURNING id", [cut]),
            ("DELETE FROM items WHERE fetched_at < ? RETURNING id", [cut]),
            ("DELETE FROM job_runs WHERE started_at < ? RETURNING id", [log_cut]),
            ("DELETE FROM ai_calls WHERE at < ? RETURNING id", [log_cut]),
            ("DELETE FROM errors WHERE at < ? RETURNING id", [log_cut]),
        ])
        return sum(len(r) for r in results)

    # ------------------------------------------------------------ main

    def run(self) -> RunStats:
        t0 = self.clock()
        now = int(t0)
        stats = RunStats()
        run_id = self.db.query("INSERT INTO job_runs (started_at, status) VALUES (?, 'running') "
                               "RETURNING id", [now])[0]["id"]
        status, error = "error", None
        try:
            self.sync_topics()
            since = self.lookback_since(now)
            results = self.fetcher(self.sources, now)
            stats.feeds_ok = sum(1 for r in results if not r.error)
            stats.failed_feeds = [f"{r.source['key']} ({r.error})" for r in results if r.error]
            stats.feeds_failed = len(stats.failed_feeds)
            entries = candidates(results, since)
            stats.items_fetched = len(entries)
            stats.items_new = self.store_new(entries, now)
            stats.items_expired = self.expire_old_pending(now)
            pending = self.load_pending()
            stats.items_pending_in = len(pending)
            left = self.run_ai(pending, now, stats)
            stats.items_left_pending = len(left)
            stats.ai_calls = len(self.calls_log)
            stats.pruned = self.prune_daily(now)
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
            self._finish(run_id, now, status, error, stats)
            stats_ms = int((self.clock() - t0) * 1000)
            self.log(self.summary(status, stats, stats_ms))
            self.log(f"D1: {getattr(self.db, 'calls', 0)} calls, rows read {getattr(self.db, 'rows_read', 0)}, "
                     f"rows written {getattr(self.db, 'rows_written', 0)}")
        return stats

    def _finish(self, run_id: int, now: int, status: str, error: str | None, stats: RunStats) -> None:
        stmts = [(
            "UPDATE job_runs SET finished_at=?, status=?, feeds_ok=?, feeds_failed=?, items_fetched=?, "
            "items_new=?, items_pending_in=?, stories_created=?, stories_merged=?, items_dropped=?, "
            "items_expired=?, items_left_pending=?, provider=?, ai_calls=?, input_tokens=?, "
            "output_tokens=?, pruned=?, error=? WHERE id=?",
            [int(self.clock()), status, stats.feeds_ok, stats.feeds_failed, stats.items_fetched,
             stats.items_new, stats.items_pending_in, stats.stories_created, stats.stories_merged,
             stats.items_dropped, stats.items_expired, stats.items_left_pending, stats.provider,
             len(self.calls_log), stats.input_tokens, stats.output_tokens, stats.pruned, error, run_id])]
        stmts += insert_statements(
            "ai_calls", ("at", "provider", "model", "ok", "items", "input_tokens", "output_tokens", "ms",
                         "error", "run_id"),
            [(*c, run_id) for c in self.calls_log])
        errors = list(stats.ai_errors) + ([error] if status == "error" and error else [])
        stmts += insert_statements("errors", ("at", "component", "message"),
                                   [(now, "job", e[:1000]) for e in errors])
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
        ]
        if s.failed_feeds:
            lines.append("failed feeds: " + ", ".join(s.failed_feeds))
        for e in s.ai_errors:
            lines.append("AI error: " + e[:300])
        return "\n".join(lines)


def build_from_env(env: dict[str, str], settings: Settings) -> tuple[D1, list[ProviderPlan]]:
    missing = [k for k in ("GEMINI_API_KEY", "GROQ_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID",
                           "CLOUDFLARE_D1_TOKEN") if not env.get(k)]
    if missing:
        raise SystemExit(f"missing settings: {', '.join(missing)} (see .env.example)")
    db = D1(env["CLOUDFLARE_ACCOUNT_ID"], env["D1_DATABASE_ID"], env["CLOUDFLARE_D1_TOKEN"])
    gemini = ai.GeminiProvider(env["GEMINI_API_KEY"], env.get("GEMINI_MODEL") or "gemini-3.5-flash-lite")
    gemini_b = ai.GeminiProvider(env["GEMINI_API_KEY"],
                                 env.get("GEMINI_FALLBACK_MODEL") or "gemini-3.1-flash-lite")
    groq = ai.GroqProvider(env["GROQ_API_KEY"], env.get("GROQ_MODEL") or "openai/gpt-oss-120b",
                           max_output_tokens=settings.groq_reply_tokens)
    plans = [
        ProviderPlan(gemini, settings.gemini_max_input_tokens, settings.existing_max, max_chunks=4),
        # A 503 "high demand" is per model, so a second Gemini model is tried before Groq.
        ProviderPlan(gemini_b, settings.gemini_max_input_tokens, settings.existing_max, max_chunks=4,
                     label="gemini-fallback"),
        ProviderPlan(groq, settings.groq_chunk_tokens, settings.groq_existing_max,
                     max_chunks=settings.groq_max_chunks_per_run, reply_tokens=groq.max_output_tokens),
    ]
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
