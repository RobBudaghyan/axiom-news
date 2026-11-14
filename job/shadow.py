"""Coverage experiment, shadow mode (Step 6). Measures only; changes nothing users see.

    venv/Scripts/python -m job.shadow              # one shadow collection (the hourly workflow)
    venv/Scripts/python -m job.shadow --dry-run    # fetch and compare, print, write nothing

Runs as its own step of the hourly workflow, AFTER the real job, with only the D1 secrets
(no AI keys, so it cannot make an AI call) and `continue-on-error`, so whatever happens here
the real run and its digests are not affected.

Each run: fetch every Google News query in config/gnews_queries.yaml (8 in parallel, hard time
budget), drop articles already stored (Google's article id), then compare each new title with
  - the live pool's article titles of the last 24 h (`items`, read only), and
  - the shadow articles of the last 24 h (so one event is counted once, not every hour),
using rarity-weighted word overlap (job/gnews.py TitleIndex, no AI). Everything goes ONLY to
`shadow_items` and `shadow_runs`. The similarity scores are stored, so part B can re-judge them
with another threshold without fetching again. Errors go to shadow_runs.error, never to the
live `errors` table (that one is shown in Admin).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from typing import Callable

from job import gnews
from job.config import load_env, load_sources
from job.d1 import D1, in_list_statements, insert_statements

BUDGET_S = 15            # the whole fetch phase; queries not answered by then count as failed
WORKERS = 8
COMPARE_H = 24           # how far back titles are compared (live pool and shadow)
LIVE_SCAN = 8000         # newest live items read for comparison (24 h is ~3-5k)
SHADOW_SCAN = 15000      # newest shadow items read for comparison
MIN_GAP_MIN = 40         # a second trigger within the hour does nothing
RETENTION_DAYS = 3
DEFAULT_THRESHOLD = 0.6  # title similarity counted as "the same article/event"

ITEM_COLUMNS = ("guid", "run_id", "topic", "topics", "query_key", "hits", "edition", "title", "source",
                "source_domain", "curated_outlet", "link", "published_at", "fetched_at", "live_sim",
                "live_item_id", "shadow_sim", "shadow_dup_of", "dup")


def registrable(host: str) -> str:
    """news.bbc.co.uk -> bbc.co.uk, feeds.washingtonpost.com -> washingtonpost.com (rough)."""
    parts = [p for p in (host or "").lower().split(".") if p]
    if len(parts) >= 3 and len(parts[-1]) == 2 and parts[-2] in {"co", "com", "org", "net", "gov", "ac"}:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def curated_outlets(sources: list[dict]) -> tuple[set[str], set[str]]:
    """(site domains, outlet names) of our curated RSS feeds, to flag Google results from outlets
    we already read (Google's link points at google.com, so this is by outlet, not by article)."""
    domains = {registrable(gnews.domain(s["url"])) for s in sources}
    names = {s["name"].strip().lower() for s in sources}
    return domains, names


@dataclass
class ShadowStats:
    queries: int = 0
    queries_failed: int = 0
    codes: dict = field(default_factory=dict)
    fetched: int = 0          # items returned by all queries (with repeats)
    distinct: int = 0         # distinct articles this run
    seen_before: int = 0      # already stored by an earlier shadow run
    new_items: int = 0
    dup_live: int = 0
    dup_shadow: int = 0
    unique_items: int = 0     # new and not a title duplicate of the live pool or earlier shadow
    per_topic: dict = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    pruned: int | None = None
    ms: int = 0

    def line(self) -> str:
        return (f"shadow: {self.queries} queries ({self.queries_failed} failed, codes {self.codes}) in "
                f"{self.ms / 1000:.1f}s | items {self.fetched}, distinct {self.distinct}, seen before "
                f"{self.seen_before}, new {self.new_items}: title-dup live {self.dup_live}, shadow "
                f"{self.dup_shadow}, unique {self.unique_items}")


Fetcher = Callable[[dict, str | None], gnews.Fetched]


class Shadow:
    def __init__(self, db, *, cfg: dict | None = None, sources: list[dict] | None = None,
                 fetcher: Fetcher | None = None, clock: Callable[[], float] = time.time,
                 log: Callable[[str], None] = print, budget_s: float = BUDGET_S):
        self.db = db
        self.cfg = cfg if cfg is not None else gnews.load_queries()
        self.queries = gnews.query_list(self.cfg)
        self.domains, self.names = curated_outlets(sources if sources is not None else load_sources())
        self.timeout = float(self.cfg.get("timeout_s") or 8)
        self.fetcher = fetcher or (lambda q, w: gnews.fetch(q, w, timeout=self.timeout))
        self.clock = clock
        self.log = log
        self.budget_s = budget_s
        self.threshold = float(self.cfg.get("title_dup_threshold") or DEFAULT_THRESHOLD)

    # ------------------------------------------------------------ steps

    def fetch_all(self, stats: ShadowStats) -> list[gnews.Fetched]:
        window = self.cfg.get("window")
        pool = ThreadPoolExecutor(max_workers=WORKERS)
        futures = {pool.submit(self.fetcher, q, window): q for q in self.queries}
        done, not_done = wait(futures, timeout=self.budget_s)
        pool.shutdown(wait=False, cancel_futures=True)
        out = []
        for fut, q in futures.items():
            if fut in done and fut.exception() is None:
                out.append(fut.result())
            else:
                err = "over the time budget" if fut in not_done else f"error: {type(fut.exception()).__name__}"
                out.append(gnews.Fetched(q, [], None, int(self.budget_s * 1000), err))
        stats.queries = len(out)
        for f in out:
            code = str(f.status) if f.status else (f.error or "?").split(":")[0]
            stats.codes[code] = stats.codes.get(code, 0) + 1
            if f.error:
                stats.queries_failed += 1
        stats.fetched = sum(len(f.items) for f in out)
        return out

    def is_curated(self, item: gnews.GItem) -> int:
        dom = registrable(gnews.domain(item.source_url))
        return 1 if (dom and dom in self.domains) or item.source.strip().lower() in self.names else 0

    def compare_sets(self, now: int) -> tuple[gnews.TitleIndex, gnews.TitleIndex]:
        since = now - COMPARE_H * 3600
        live, shadow = self.db.batch([
            ("SELECT id, title FROM items WHERE id > (SELECT coalesce(max(id), 0) FROM items) - ? "
             "AND fetched_at >= ?", [LIVE_SCAN, since]),
            ("SELECT id, title FROM shadow_items WHERE id > (SELECT coalesce(max(id), 0) FROM shadow_items) "
             "- ? AND fetched_at >= ?", [SHADOW_SCAN, since]),
        ])
        return (gnews.TitleIndex([(r["id"], r["title"]) for r in live]),
                gnews.TitleIndex([(r["id"], r["title"]) for r in shadow]))

    def recent_run(self, now: int) -> int | None:
        rows = self.db.query("SELECT max(at) AS t FROM shadow_runs")
        t = rows[0]["t"] if rows else None
        return int(t) if t is not None and now - int(t) < MIN_GAP_MIN * 60 else None

    def build_rows(self, fetched: list[gnews.Fetched], run_id: int, now: int,
                   stats: ShadowStats) -> list[tuple]:
        # one entry per article; topics of every query that found it
        found: dict[str, dict] = {}
        for f in fetched:
            for it in f.items:
                e = found.get(it.guid)
                if e is None:
                    found[it.guid] = {"item": it, "query": f.query, "topics": [f.query["topic"]], "hits": 1}
                else:
                    e["hits"] += 1
                    if f.query["topic"] not in e["topics"]:
                        e["topics"].append(f.query["topic"])
        stats.distinct = len(found)
        seen: set[str] = set()
        for rows in self.db.batch(in_list_statements(
                "SELECT guid FROM shadow_items WHERE guid IN ({qs})", list(found))):
            seen.update(r["guid"] for r in rows)
        stats.seen_before = len(seen)
        live_ix, shadow_ix = self.compare_sets(now)
        new = sorted((e for g, e in found.items() if g not in seen),
                     key=lambda e: (e["item"].published_at or now, e["item"].guid))
        rows = []
        for e in new:
            it, q = e["item"], e["query"]
            live_sim, live_id = live_ix.best(it.title)
            sh_sim, sh_id = shadow_ix.best(it.title)
            dup = "live" if live_sim >= self.threshold else ("shadow" if sh_sim >= self.threshold else None)
            # later items this run are compared with this one too ("guid:<id>" until stored)
            shadow_ix.add(f"guid:{it.guid}", it.title)
            rows.append((it.guid, run_id, q["topic"], json.dumps(e["topics"]), q["key"], e["hits"], q["ed"],
                         it.title, it.source, gnews.domain(it.source_url), self.is_curated(it), it.link,
                         it.published_at, now, round(live_sim, 3), live_id if live_sim > 0 else None,
                         round(sh_sim, 3), sh_id if isinstance(sh_id, int) and sh_sim > 0 else None, dup))
            t = stats.per_topic.setdefault(q["topic"], {"new": 0, "dup_live": 0, "dup_shadow": 0, "unique": 0})
            t["new"] += 1
            if dup == "live":
                stats.dup_live += 1
                t["dup_live"] += 1
            elif dup == "shadow":
                stats.dup_shadow += 1
                t["dup_shadow"] += 1
            else:
                stats.unique_items += 1
                t["unique"] += 1
        stats.new_items = len(rows)
        for f in fetched:
            t = stats.per_topic.setdefault(f.query["topic"], {"new": 0, "dup_live": 0, "dup_shadow": 0,
                                                              "unique": 0})
            t["fetched"] = t.get("fetched", 0) + len(f.items)
            if f.error:
                t["failed"] = t.get("failed", 0) + 1
        return rows

    def prune(self, now: int) -> int | None:
        rows = self.db.query("SELECT max(at) AS t FROM shadow_runs WHERE pruned IS NOT NULL")
        last = rows[0]["t"] if rows else None
        if last is not None and now - int(last) < 23 * 3600:
            return None
        cut = now - RETENTION_DAYS * 86400
        res = self.db.batch([("DELETE FROM shadow_items WHERE fetched_at < ? RETURNING id", [cut]),
                             ("DELETE FROM shadow_runs WHERE at < ? RETURNING id", [now - 30 * 86400])])
        return sum(len(r) for r in res)

    # ------------------------------------------------------------ main

    def run(self, *, dry_run: bool = False) -> ShadowStats:
        t0 = self.clock()
        now = int(t0)
        stats = ShadowStats()
        if not self.cfg.get("enabled", True):
            self.log("shadow: disabled in config/gnews_queries.yaml")
            return stats
        run_id = 0
        if not dry_run:
            run_id = self.db.query("INSERT INTO shadow_runs (at) VALUES (?) RETURNING id", [now])[0]["id"]
        rows: list[tuple] = []
        try:
            fetched = self.fetch_all(stats)
            rows = self.build_rows(fetched, run_id, now, stats)
            if not dry_run:
                self.db.batch(insert_statements("shadow_items", ITEM_COLUMNS, rows,
                                                suffix="ON CONFLICT(guid) DO NOTHING"))
                stats.pruned = self.prune(now)
            for f in fetched:
                if f.error:
                    stats.errors.append(f"{f.query['key']}: {f.error}")
        except Exception as exc:
            stats.errors.append(f"{type(exc).__name__}: {exc}")
        stats.ms = int((self.clock() - t0) * 1000)
        if not dry_run:
            self._finish(run_id, rows, stats)
        self.log(stats.line())
        return stats

    def _finish(self, run_id: int, rows: list[tuple], stats: ShadowStats) -> None:
        first_id = None
        try:
            r = self.db.query("SELECT min(id) AS i FROM shadow_items WHERE run_id = ?", [run_id])
            first_id = r[0]["i"] if r else None
        except Exception:
            pass
        try:
            self.db.query(
                "UPDATE shadow_runs SET ms=?, queries=?, queries_failed=?, codes=?, fetched=?, distinct_items=?, "
                "seen_before=?, new_items=?, dup_live=?, dup_shadow=?, unique_items=?, per_topic=?, error=?, "
                "pruned=?, first_id=?, d1_rows_read=?, d1_rows_written=? WHERE id=?",
                [stats.ms, stats.queries, stats.queries_failed, json.dumps(stats.codes), stats.fetched,
                 stats.distinct, stats.seen_before, stats.new_items, stats.dup_live, stats.dup_shadow,
                 stats.unique_items, json.dumps(stats.per_topic, sort_keys=True),
                 " | ".join(stats.errors)[:1000] or None, stats.pruned, first_id,
                 getattr(self.db, "rows_read", 0), getattr(self.db, "rows_written", 0), run_id])
        except Exception as exc:
            self.log(f"shadow: could not write the run row: {exc}")


def main(argv: list[str] | None = None) -> int:
    """Always exits 0: a shadow failure must never mark the hourly workflow as failed."""
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="Coverage experiment: collect Google News results (shadow only).")
    ap.add_argument("--dry-run", action="store_true", help="fetch and compare, print, write nothing")
    ap.add_argument("--show", type=int, default=0, help="with --dry-run: print this many new titles")
    args = ap.parse_args(argv)
    try:
        env = load_env()
        db = D1(env["CLOUDFLARE_ACCOUNT_ID"], env["D1_DATABASE_ID"], env["CLOUDFLARE_D1_TOKEN"], timeout=20)
        sh = Shadow(db)
        if not args.dry_run and sh.recent_run(int(time.time())) is not None:
            print("shadow: skipped, a shadow run happened less than 40 min ago")
            return 0
        if args.dry_run and args.show:
            orig = sh.build_rows

            def show(*a, **k):
                rows = orig(*a, **k)
                for r in rows[:args.show]:
                    print(f"  {r[18] or 'UNIQUE':6} live {r[14]:.2f} shadow {r[16]:.2f}  [{r[2]}] {r[7]} | {r[8]}")
                return rows
            sh.build_rows = show
        sh.run(dry_run=args.dry_run)
        print(f"shadow D1: rows read {db.rows_read}, written {db.rows_written}")
    except Exception as exc:
        print(f"shadow: failed ({type(exc).__name__}: {exc}); the real job is not affected")
    return 0


if __name__ == "__main__":
    sys.exit(main())
