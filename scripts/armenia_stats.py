"""Armenia coverage numbers from D1 (read only). Step 7 baseline and after-numbers.

    venv/Scripts/python scripts/armenia_stats.py --hours 48 --csv reports/data/step-07-baseline.csv
    venv/Scripts/python scripts/armenia_stats.py --since 2026-11-14T18:00 --until 2026-11-15T06:00

An "Armenia story" is a story whose first-pass topic tags include `armenia` (the editor's
`main_topic = 'armenia'` is counted too). Runs are hourly job runs (`job_runs`) started in the
window; pass-1 AI calls are `ai_calls` of kind 'batch' (or NULL) that belong to those runs, so
calls made from the PC for tuning are not counted.

Per Armenian feed (region armenia in config/sources.yaml): items stored per run and the runs in
which the feed hit its per-run cap. D1 never stores the items the cap cut off, so the feed's own
publishing rate comes from a live snapshot (scripts/feed_rates.py), not from here.
Never prints secrets.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job.config import Settings, load_env, load_sources  # noqa: E402
from job.d1 import D1  # noqa: E402

ARMENIA = '%"armenia"%'


def parse_time(text: str) -> int:
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def stats(db, since: int, until: int, sources: list[dict], default_cap: int) -> list[tuple]:
    rows: list[tuple] = []

    def add(section, key, metric, value):
        rows.append((section, key, metric, value))

    hours = (until - since) / 3600
    add("window", "", "since_utc", datetime.fromtimestamp(since, timezone.utc).isoformat(timespec="minutes"))
    add("window", "", "until_utc", datetime.fromtimestamp(until, timezone.utc).isoformat(timespec="minutes"))
    add("window", "", "hours", round(hours, 1))

    # ---- runs and AI
    runs = db.query("SELECT id, started_at, finished_at, status, items_new, items_pending_in FROM job_runs "
                    "WHERE started_at >= ? AND started_at < ? AND status != 'running' ORDER BY id",
                    [since, until])
    ids = [r["id"] for r in runs]
    add("runs", "", "runs", len(runs))
    for status in sorted({r["status"] for r in runs}):
        add("runs", "", f"status_{status}", sum(1 for r in runs if r["status"] == status))
    secs = [r["finished_at"] - r["started_at"] for r in runs if r["finished_at"]]
    add("runs", "", "run_seconds_mean", round(sum(secs) / len(secs), 1) if secs else "")
    add("runs", "", "run_seconds_max", max(secs) if secs else "")
    add("runs", "", "items_new_per_run", round(sum(r["items_new"] or 0 for r in runs) / len(runs), 1) if runs else "")
    calls = []
    if ids:
        calls = db.query(f"SELECT run_id, provider, model, ok, items, input_tokens, output_tokens, ms, error, "
                         f"coalesce(kind, 'batch') AS kind FROM ai_calls WHERE run_id >= ? AND run_id <= ?",
                         [min(ids), max(ids)])
        calls = [c for c in calls if c["run_id"] in set(ids)]
    for kind in ("batch", "editor"):
        cs = [c for c in calls if c["kind"] == kind]
        label = "pass1" if kind == "batch" else "editor"
        add("ai", label, "calls", len(cs))
        add("ai", label, "calls_per_run", round(len(cs) / len(runs), 2) if runs else "")
        tin = sum(c["input_tokens"] or 0 for c in cs)
        tout = sum(c["output_tokens"] or 0 for c in cs)
        add("ai", label, "tokens_in", tin)
        add("ai", label, "tokens_out", tout)
        add("ai", label, "tokens_in_per_run", round(tin / len(runs)) if runs else "")
        add("ai", label, "tokens_out_per_run", round(tout / len(runs)) if runs else "")
        gem = [c for c in cs if c["provider"].startswith("gemini")]
        add("ai", label, "gemini_calls", len(gem))
        add("ai", label, "gemini_503", sum(1 for c in gem if "503" in (c["error"] or "")))
        add("ai", label, "gemini_429", sum(1 for c in gem if "429" in (c["error"] or "")))
        add("ai", label, "gemini_failed", sum(1 for c in gem if not c["ok"]))
        add("ai", label, "groq_calls", sum(1 for c in cs if c["provider"].startswith("groq")))

    # ---- Armenian feeds: items stored per run, cap hits
    arm = [s for s in sources if s.get("region") == "armenia"]
    caps = {s["key"]: int(s.get("max_items") or default_cap) for s in arm}
    keys = list(caps)
    qs = ",".join("?" * len(keys))
    per_run = db.query(f"SELECT source_key, fetched_at, count(*) AS n, "
                       f"sum(status = 'done') AS done, sum(status = 'dropped') AS dropped FROM items "
                       f"WHERE fetched_at >= ? AND fetched_at < ? AND source_key IN ({qs}) "
                       f"GROUP BY source_key, fetched_at", [since, until, *keys])
    run_times = {r["started_at"] for r in runs}
    total_items = 0
    for s in arm:
        k = s["key"]
        rs = [r for r in per_run if r["source_key"] == k]
        n = sum(r["n"] for r in rs)
        total_items += n
        at_cap = sum(1 for r in rs if r["n"] >= caps[k])
        add("feed", k, "language", s.get("language", ""))
        add("feed", k, "cap", caps[k])
        add("feed", k, "items_taken", n)
        add("feed", k, "items_placed_in_stories", sum(r["done"] or 0 for r in rs))
        add("feed", k, "items_not_news", sum(r["dropped"] or 0 for r in rs))
        add("feed", k, "runs_with_items", len(rs))
        add("feed", k, "runs_at_cap", at_cap)
        add("feed", k, "share_of_runs_at_cap", round(at_cap / len(run_times), 3) if run_times else "")
        add("feed", k, "max_items_in_one_run", max((r["n"] for r in rs), default=0))
    add("armenia", "", "items_from_armenian_feeds", total_items)

    # ---- Armenia stories
    stories = db.query("SELECT id, importance, final_score, main_topic, merged_into, source_count, created_at "
                       "FROM stories WHERE created_at >= ? AND created_at < ? AND topics LIKE ?",
                       [since, until, ARMENIA])
    live = [s for s in stories if s["merged_into"] is None]
    add("armenia", "", "stories_created", len(stories))
    add("armenia", "", "stories_merged_away_by_editor", len(stories) - len(live))
    add("armenia", "", "stories_live", len(live))
    add("armenia", "", "stories_main_topic_armenia", sum(1 for s in live if s["main_topic"] == "armenia"))
    add("armenia", "", "stories_unedited", sum(1 for s in live if s["final_score"] is None))
    for label, test in (("score_1_4", lambda x: x <= 4), ("score_5", lambda x: x == 5),
                        ("score_6", lambda x: x == 6), ("score_7plus", lambda x: x >= 7)):
        add("armenia", "", f"stories_{label}",
            sum(1 for s in live if s["final_score"] is not None and test(s["final_score"])))
    add("armenia", "", "stories_multi_source", sum(1 for s in live if (s["source_count"] or 0) >= 2))
    all_new = db.query("SELECT count(*) AS n FROM stories WHERE created_at >= ? AND created_at < ?",
                       [since, until])[0]["n"]
    add("pool", "", "stories_created_all_topics", all_new)

    # ---- sent in digests (all users; today only the owner)
    sent = db.query(f"SELECT count(DISTINCT s.story_id) AS n, count(*) AS deliveries FROM sent s "
                    f"JOIN stories st ON st.id = s.story_id WHERE s.sent_at >= ? AND s.sent_at < ? "
                    f"AND st.topics LIKE ?", [since, until, ARMENIA])[0]
    add("armenia", "", "stories_sent_in_digests", sent["n"])
    add("armenia", "", "deliveries", sent["deliveries"])
    sent_main = db.query("SELECT count(DISTINCT s.story_id) AS n FROM sent s JOIN stories st ON st.id = s.story_id "
                         "WHERE s.sent_at >= ? AND s.sent_at < ? AND st.main_topic = 'armenia'",
                         [since, until])[0]["n"]
    add("armenia", "", "stories_sent_main_topic_armenia", sent_main)
    sent_all = db.query("SELECT count(DISTINCT story_id) AS n FROM sent WHERE sent_at >= ? AND sent_at < ?",
                        [since, until])[0]["n"]
    add("pool", "", "stories_sent_all_topics", sent_all)
    return rows


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--hours", type=float, default=48, help="window ending now (ignored with --since)")
    ap.add_argument("--since", help="window start, ISO time (UTC if no zone)")
    ap.add_argument("--until", help="window end, ISO time (default now)")
    ap.add_argument("--csv", help="write the rows to this CSV file")
    args = ap.parse_args()
    until = parse_time(args.until) if args.until else int(time.time())
    since = parse_time(args.since) if args.since else int(until - args.hours * 3600)
    env = load_env()
    db = D1(env["CLOUDFLARE_ACCOUNT_ID"], env["D1_DATABASE_ID"], env["CLOUDFLARE_D1_TOKEN"], timeout=60)
    rows = stats(db, since, until, load_sources(include_disabled=True), Settings().max_items_per_feed)
    for r in rows:
        print(f"{r[0]:8} {r[1]:18} {r[2]:32} {r[3]}")
    if args.csv:
        Path(args.csv).parent.mkdir(parents=True, exist_ok=True)
        with open(args.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["section", "feed_key", "metric", "value"])
            w.writerows(rows)
        print(f"wrote {args.csv}")
    print(f"D1: rows read {db.rows_read}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
