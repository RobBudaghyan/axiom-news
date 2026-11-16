"""Writes tests/fixtures/guard_cases.json: generated AI-call counts with the guard's verdict, and
timestamps with their Pacific day. Both test suites check it: tests/test_custom.py (job/guard.py)
and worker/test/custom.test.mjs (worker/src/guard.js), so the job and the Worker always agree on
when topic checks and translations wait. Re-run only to change the cases.

    venv/Scripts/python scripts/make_guard_cases.py
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from job.guard import assess, load_budget, pacific_day  # noqa: E402


def main() -> int:
    cfg = load_budget()
    rnd = random.Random(13)
    models = cfg["gemini_models"] + ["openai/gpt-oss-120b"]
    cases = []
    for _ in range(300):
        counts = {}
        for m in models:
            if rnd.random() < 0.85:
                calls = rnd.choice([0, 5, 100, 199, 200, 201, 249, 250, 251, 400, rnd.randint(0, 320)])
                r429 = rnd.choice([0, 0, 0, 1, 3])
                counts[m] = {"calls": calls, "r429": r429, "recent429": rnd.choice([0, r429]) if r429 else 0}
        cases.append({"counts": counts, **assess(counts, cfg)})
    days = []
    base = 1_767_225_600   # 2026-01-01 00:00 UTC
    for _ in range(300):
        ts = base + rnd.randint(0, 3 * 365 * 86400)
        day, start = pacific_day(ts)
        days.append({"ts": ts, "day": day, "start": start})
    for ts in (1_772_964_000, 1_772_960_400, 1_793_523_600, 1_793_520_000):   # around the 2026 switches
        day, start = pacific_day(ts)
        days.append({"ts": ts, "day": day, "start": start})
    out = {"_comment": __doc__.strip().splitlines()[0], "cfg": cfg, "cases": cases, "days": days}
    path = ROOT / "tests" / "fixtures" / "guard_cases.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=0), encoding="utf-8")
    levels = [c["level"] for c in cases]
    print(f"wrote {path}: {len(cases)} cases (levels 0/1/2: {levels.count(0)}/{levels.count(1)}/{levels.count(2)}), "
          f"{len(days)} days")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
