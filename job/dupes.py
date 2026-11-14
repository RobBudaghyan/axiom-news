"""Near-duplicate grouping for digests (no AI). Runs in the hourly job, which has no CPU limit,
so the Worker's digest cron only has to keep the first story of each `dup_group`.

How it works (tuned on the real pool on 2026-11-13, see reports/step-03-automation.md):
- each summary becomes a set of content words: lower case, accents removed, stop words out,
  cut to a 5-letter stem ("strikes" = "strike"). Names get no extra weight: tried, it merged
  different stories about the same person (Zelensky, Merz, Vance);
- words are weighted by inverse document frequency over the pool, so "Ukraine" (in every
  other line) says little and "Zaporizhzhia" says a lot;
- similarity = shared weight / the smaller line's total weight (0..1);
- stories are walked in digest rank order (importance, then most recent). A story at or above
  the threshold against an earlier group leader joins that leader's group; otherwise it leads a
  new group. So the more important line of a pair is the one a digest shows.

Settings come from config/digest.json (dedupe_threshold, min_importance), shared with the Worker.
"""
from __future__ import annotations

import json
import math
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

STOP = set((
    "the a an and or but of to in on at for from by with as is are was were be been being has have had "
    "its it this that these those their his her they them he she we you who whom which what when where "
    "after before over under amid against about into onto than then there here also not no new more most "
    "says said say will would could should may might can just one two three four five six first last "
    "year years day days week weeks month months people some all any other such while during between "
    "since until within without per via told according report reports reported including made make "
    "number increase increased increases rose rise rising percent"
).split())
WORD = re.compile(r"[A-Za-z0-9']+")


def digest_config() -> dict:
    return json.loads((ROOT / "config" / "digest.json").read_text(encoding="utf-8"))


def tokens(text: str) -> dict[str, int]:
    s = unicodedata.normalize("NFKD", text or "")
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    out: dict[str, int] = {}
    for raw in WORD.findall(s):
        w = raw.lower()
        if "'" in w:
            w = re.sub(r"'s$|'", "", w)
        if len(w) >= 3 and w not in STOP:
            out[w[:5]] = 1
    return out


def idf_table(maps: list[dict[str, int]]) -> dict[str, float]:
    df: dict[str, int] = {}
    for m in maps:
        for w in m:
            df[w] = df.get(w, 0) + 1
    n = len(maps)
    return {w: math.log(1 + n / d) for w, d in df.items()}


def total(m: dict[str, int], idf: dict[str, float]) -> float:
    return sum(x * idf.get(w, 1.0) for w, x in m.items())


def similarity(a: dict[str, int], b: dict[str, int], idf: dict[str, float]) -> float:
    small, big = (a, b) if len(a) <= len(b) else (b, a)
    shared = sum(min(x, big[w]) * idf.get(w, 1.0) for w, x in small.items() if w in big)
    lo = min(total(a, idf), total(b, idf))
    return shared / lo if lo > 0 else 0.0


def group(stories: list[dict], threshold: float) -> tuple[dict[int, int], list[tuple[float, int, int]]]:
    """stories: dicts with id and summary, already in digest rank order.
    Returns ({story id: group leader id}, [(score, leader id, duplicate id), ...])."""
    maps = [tokens(s["summary"]) for s in stories]
    idf = idf_table(maps)
    totals = [total(m, idf) for m in maps]
    leaders: list[int] = []          # indexes into stories
    out: dict[int, int] = {}
    pairs: list[tuple[float, int, int]] = []
    for i, s in enumerate(stories):
        best, of = 0.0, None
        for j in leaders:
            small, big = (maps[i], maps[j]) if len(maps[i]) <= len(maps[j]) else (maps[j], maps[i])
            shared = sum(min(x, big[w]) * idf.get(w, 1.0) for w, x in small.items() if w in big)
            lo = min(totals[i], totals[j])
            score = shared / lo if lo > 0 else 0.0
            if score > best:
                best, of = score, j
        if of is not None and best >= threshold:
            out[s["id"]] = stories[of]["id"]
            pairs.append((best, stories[of]["id"], s["id"]))
        else:
            leaders.append(i)
            out[s["id"]] = s["id"]
    return out, pairs


POOL_SQL = ("SELECT id, summary, dup_group FROM stories WHERE updated_at >= ? AND importance >= ? "
            "AND merged_into IS NULL "
            "ORDER BY importance DESC, updated_at DESC, id DESC")


def update_groups(db, now: int, cfg: dict | None = None) -> int:
    """Recompute dup_group for the last 24 h of digest-eligible stories; write only changes.
    Returns the number of stories whose group changed."""
    cfg = cfg or digest_config()
    pool = db.query(POOL_SQL, [now - int(cfg["max_lookback_hours"]) * 3600, cfg["min_importance"]])
    groups, _ = group(pool, float(cfg["dedupe_threshold"]))
    changed = [(groups[s["id"]], s["id"]) for s in pool
               if s.get("dup_group") is None or int(s["dup_group"]) != groups[s["id"]]]
    db.batch([("UPDATE stories SET dup_group = ? WHERE id = ?", [g, sid]) for g, sid in changed])
    return len(changed)


def main() -> int:
    """List the near-duplicate pairs in the current pool:  venv/Scripts/python -m job.dupes"""
    import sys
    import time
    from job.config import load_env
    from job.d1 import D1
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    env = load_env()
    db = D1(env["CLOUDFLARE_ACCOUNT_ID"], env["D1_DATABASE_ID"], env["CLOUDFLARE_D1_TOKEN"])
    cfg = digest_config()
    pool = db.query(POOL_SQL, [int(time.time()) - int(cfg["max_lookback_hours"]) * 3600, cfg["min_importance"]])
    _, pairs = group(pool, float(cfg["dedupe_threshold"]))
    by_id = {s["id"]: s["summary"] for s in pool}
    print(f"pool {len(pool)} stories, threshold {cfg['dedupe_threshold']}: {len(pairs)} grouped as duplicates")
    for score, lead, dup in sorted(pairs, reverse=True):
        print(f"{score:.2f}  keep [{lead}] {by_id[lead]}")
        print(f"      drop [{dup}] {by_id[dup]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
