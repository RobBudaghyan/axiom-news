"""Step 19, one-off, STAGING ONLY: fills the staging pool with the last 48 h of the eight new
Technology & AI feeds, through the real hourly job (pass 1, editor, translation), so the 48 h digest
replay (worker/scripts/step19-replay.mjs) can count Technology & AI stories. Production gets these
feeds from its normal hourly runs; nothing here touches it.

    AXIOM_ENV=staging venv/Scripts/python scripts/step19_backfill.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from job.config import Settings, load_env, load_sources  # noqa: E402
from job.run import Job, build_from_env  # noqa: E402

TECH = {"ft_tech", "bloomberg_tech", "wsj_tech", "nyt_tech", "guardian_tech", "mit_tech_review",
        "ars_technica", "wired_ai"}
HOURS = 48


class Backfill(Job):
    def lookback_since(self, now: int) -> int:
        return int(now - HOURS * 3600)


def main() -> int:
    if os.environ.get("AXIOM_ENV") != "staging":
        raise SystemExit("refusing: run with AXIOM_ENV=staging (this is a staging-only backfill)")
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    settings = Settings()
    env = load_env()
    db, plans = build_from_env(env, settings)
    sources = [s for s in load_sources() if s["key"] in TECH]
    # The per-feed cap is per run; 48 h at once would cut most of it, so it is lifted to the
    # feed's own hourly cap times 48 (what 48 hourly runs would have taken at most).
    sources = [{**s, "max_items": int(s.get("max_items") or settings.max_items_per_feed) * HOURS} for s in sources]
    print(f"backfill: {len(sources)} feeds, last {HOURS} h, staging")
    Backfill(db, plans, settings=settings, sources=sources, custom_enabled=False).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
