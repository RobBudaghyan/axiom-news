"""AI budget guard (Step 13). Gemini's free tier has a daily request cap per model that resets at
midnight Pacific time. We count our own calls (`ai_calls`, written by the job and by the Worker's
topic checks) per model since that midnight, and the 429 answers. If Gemini starts refusing or a
model passes our soft limit (config/ai_budget.json), we degrade in a fixed order:

    level 1: new custom-topic checks wait ("try again in a few minutes", in the Worker)
    level 2: translations wait too (stories are held for their readers, Step 10 rule)
    never:   pass 1 and the editor (the job never asks the guard about them)

The same rules live in worker/src/guard.js; tests/fixtures/guard_cases.json keeps them identical.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from job.config import ROOT

BUDGET = ROOT / "config" / "ai_budget.json"
DAY = 86400

# ai_calls since a time, per model: calls, 429s, and 429s since a later time. `code` is the HTTP
# status of a failed call (Step 13); older rows only have the error text.
COUNT_SQL = """
SELECT model, count(*) AS calls,
       sum(CASE WHEN code = 429 OR (code IS NULL AND error LIKE '%HTTP 429%') THEN 1 ELSE 0 END) AS r429,
       sum(CASE WHEN at >= ?2 AND (code = 429 OR (code IS NULL AND error LIKE '%HTTP 429%')) THEN 1 ELSE 0 END) AS recent429
FROM ai_calls WHERE at >= ?1 GROUP BY model"""


def load_budget(path: Path = BUDGET) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


# ---------------------------------------------------------------- Pacific day (no tz database)

def _nth_sunday_utc(year: int, month: int, n: int, hour_utc: int) -> int:
    first = datetime(year, month, 1, tzinfo=timezone.utc)
    to_sunday = (6 - first.weekday()) % 7
    day = 1 + to_sunday + 7 * (n - 1)
    return int(datetime(year, month, day, hour_utc, tzinfo=timezone.utc).timestamp())


def pacific_offset(ts: int) -> int:
    """UTC offset in hours of US Pacific time at `ts`: -7 from the second Sunday of March 02:00
    local (10:00 UTC) to the first Sunday of November 02:00 local (09:00 UTC), else -8."""
    year = datetime.fromtimestamp(ts, timezone.utc).year
    start = _nth_sunday_utc(year, 3, 2, 10)
    end = _nth_sunday_utc(year, 11, 1, 9)
    return -7 if start <= ts < end else -8


def pacific_day(ts: int) -> tuple[str, int]:
    """(YYYY-MM-DD of the Pacific day containing ts, unix time of its midnight)."""
    off = pacific_offset(ts)
    day = (ts + off * 3600) // DAY
    start = day * DAY - off * 3600
    start = day * DAY - pacific_offset(start) * 3600   # midnight is before the 02:00 switch
    return datetime.fromtimestamp(day * DAY, timezone.utc).strftime("%Y-%m-%d"), int(start)


# ---------------------------------------------------------------- the rule

def assess(counts: dict, cfg: dict) -> dict:
    """counts: {model: {"calls", "r429", "recent429"}} since the Pacific midnight. Returns
    {"level": 0|1|2, "reasons": [...]}, the same as worker/src/guard.js assess()."""
    level, reasons = 0, []
    gem = cfg.get("gemini_models") or []
    limits = cfg.get("soft_limits") or {}
    ratio = cfg.get("check_ratio", 0.8)
    for model in gem:
        c = counts.get(model) or {}
        calls = int(c.get("calls") or 0)
        limit = limits.get(model)
        if limit:
            if calls >= limit:
                level = max(level, 2)
                reasons.append(f"{model}: {calls} calls today, soft limit {limit}")
            elif calls >= ratio * limit:
                level = max(level, 1)
                reasons.append(f"{model}: {calls} calls today, {round(100 * calls / limit)}% of the soft limit {limit}")
    refusing = [m for m in gem if int((counts.get(m) or {}).get("recent429") or 0) > 0]
    if gem and len(refusing) == len(gem):
        level = max(level, 2)
        reasons.append("every Gemini model answered 429 in the last hour")
    elif refusing:
        level = max(level, 1)
        reasons.append(f"{', '.join(refusing)} answered 429 in the last hour")
    return {"level": level, "reasons": reasons}


def read_counts(db, now: int, cfg: dict) -> tuple[dict, str]:
    day, start = pacific_day(now)
    recent = now - int(cfg.get("recent_429_minutes", 60)) * 60
    counts = {}
    for r in db.query(COUNT_SQL, [start, recent]):
        counts[r["model"] or "?"] = {"calls": int(r["calls"] or 0), "r429": int(r["r429"] or 0),
                                     "recent429": int(r["recent429"] or 0)}
    return counts, day


def check(db, now: int, cfg: dict | None = None, extra: dict | None = None) -> dict:
    """The guard's state now. `extra`: calls of the current run not yet written to ai_calls,
    {model: {"calls", "r429", "recent429"}}, added to the database counts."""
    cfg = cfg or load_budget()
    counts, day = read_counts(db, now, cfg)
    for model, c in (extra or {}).items():
        mine = counts.setdefault(model, {"calls": 0, "r429": 0, "recent429": 0})
        for k in ("calls", "r429", "recent429"):
            mine[k] += int(c.get(k) or 0)
    out = assess(counts, cfg)
    return {**out, "day": day, "at": now, "counts": counts}
