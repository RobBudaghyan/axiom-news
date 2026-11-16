"""Writes tests/fixtures/eligible_cases.json: 400 generated stories (100 on two custom topics, Step 13 fixes) and whether each could reach a
digest (the two-score rule for a reader who follows every topic), with the digest settings used.
Both test suites check it: tests/test_translate.py (job/translate.py: the Python rule and its
SQL) and worker/test/i18n.test.mjs (worker/src/digest.js qualifies()), so the job never
translates a different set of stories than the Worker can pick. Re-run only to change the cases.

    venv/Scripts/python scripts/make_eligible_cases.py
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from job.translate import load_digest_config, qualifies  # noqa: E402


def main() -> int:
    cfg = load_digest_config()
    keep = ("editorial_bar", "topic_bar", "topic_needs_boost", "topic_boost_max", "unedited_offset")
    cfg = {k: cfg[k] for k in keep}
    tags = ["politics", "wars_conflicts", "armenia", "russia", "iran_war", "ukraine_war"]
    rnd = random.Random(9)
    cases = []
    for i in range(300):
        topics = rnd.sample(tags, rnd.randint(1, 3)) if rnd.random() > 0.03 else ["sports"]
        final = rnd.choice([None, None] + list(range(2, 10)))
        topic = None if final is None or rnd.random() < 0.2 else min(10, final + rnd.choice([0, 0, 1, 2, 3, -1]))
        main = rnd.choice(topics + [None, "unknown_tag"]) if final is not None else None
        s = {"id": i + 1, "topics": topics, "importance": rnd.randint(3, 10), "final_score": final,
             "topic_score": topic, "main_topic": main}
        cases.append({**s, "eligible": qualifies(s, cfg, tags)})
    # Step 13 fixes: 100 stories on two custom topics (c1, c2), whose topic score counts as it is
    # (no cap, no "above the score" rule); a custom topic score may be far above the score.
    tags = tags + ["c1", "c2"]
    rc = random.Random(13)
    for i in range(300, 400):
        topics = rc.sample(["c1", "c2", "politics", "armenia"], rc.randint(1, 2))
        final = rc.choice([None] + list(range(1, 10)))
        topic = None if final is None or rc.random() < 0.15 else min(10, max(1, final + rc.choice([-1, 0, 0, 1, 2, 3, 4, 5, 6])))
        main = rc.choice(topics + [None]) if final is not None else None
        s = {"id": i + 1, "topics": topics, "importance": rc.randint(1, 8), "final_score": final,
             "topic_score": topic, "main_topic": main}
        cases.append({**s, "eligible": qualifies(s, cfg, tags)})
    out ={"_comment": __doc__.split("\n\n")[0], "cfg": cfg, "tags": tags, "cases": cases}
    path = ROOT / "tests" / "fixtures" / "eligible_cases.json"
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
    print(f"{sum(c['eligible'] for c in cases)} of {len(cases)} eligible, written {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
