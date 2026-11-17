"""Step 14: write match keywords for the live custom topics that have none (one AI call each, the
job's own backfill: job/custom.py backfill_keywords), then list the stories of the last 24 hours
that the keyword rule would take off a custom topic. The list is read only (nothing changes in the
stories); the hourly job applies the rule from its next run.
Output: reports/data/step-14/keywords.json and a table on screen.

    venv/Scripts/python scripts/step14_keywords.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from job import custom, translate  # noqa: E402
from job.config import Settings, load_env  # noqa: E402
from job.d1 import insert_statements  # noqa: E402
from job.run import build_from_env  # noqa: E402

OUT = ROOT / "reports" / "data" / "step-14"


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    OUT.mkdir(parents=True, exist_ok=True)
    db, plans = build_from_env(load_env(), Settings())
    calls = []

    def on_call(p, ok, n, res, err, kind):
        calls.append((int(time.time()), p.name, p.model, 1 if ok else 0, n, res.input_tokens if res else None,
                      res.output_tokens if res else None, res.ms if res else None, err, kind))

    done = custom.backfill_keywords(db, plans, on_call=on_call)
    if calls:
        db.batch(insert_statements("ai_calls", ("at", "provider", "model", "ok", "items", "input_tokens", "output_tokens",
                                                "ms", "error", "kind"), calls))
    print(f"keywords written for: {done or 'none'} ({len(calls)} AI calls, "
          f"{sum(c[5] or 0 for c in calls)} in / {sum(c[6] or 0 for c in calls)} out tokens)")
    topics = db.query("SELECT id, tag, names, keywords FROM custom_topics WHERE tag IS NOT NULL ORDER BY id")
    rule_topics = []
    for t in topics:
        kw = json.loads(t["keywords"] or "{}")
        names = json.loads(t["names"])
        print(f"{t['tag']} {names['en']}: en {kw.get('en')} | ru {kw.get('ru')}")
        rule_topics.append({"tag": t["tag"], "custom": True, "names": names, "keywords": kw, "label": {"en": names["en"]}})
    rule = custom.KeywordRule(rule_topics)
    now = int(time.time())
    rows = db.query(custom.ENFORCE_SQL, [now - 24 * 3600])
    cfg = translate.load_digest_config()
    out = {"at": now, "topics": {t["tag"]: {"name": json.loads(t["names"])["en"], "keywords": json.loads(t["keywords"] or "{}")}
                                 for t in topics}, "stories": len(rows), "excluded": [], "kept": []}
    for r in rows:
        tags = json.loads(r["topics"])
        kept, main, moved = rule.apply(tags, r["main_topic"], custom.story_text(r["headline"], r["description"], r["summary"]))
        removed = [t for t in tags if t not in kept]
        reached = translate.qualifies({**r, "topics": tags, "importance": 0}, cfg, tags) if r["final_score"] is not None else False
        rec = {"id": r["id"], "headline": r["headline"] or r["summary"], "score": r["final_score"], "topic_score": r["topic_score"],
               "main": r["main_topic"], "tags": tags, "passed_before": reached}
        if removed:
            out["excluded"].append({**rec, "removed": removed, "new_main": main})
        else:
            out["kept"].append(rec)
    print(f"\n{len(rows)} stories of the last 24 h carry a custom tag; the rule takes {len(out['excluded'])} off:")
    for e in out["excluded"]:
        mark = "  (was in a digest)" if e["passed_before"] else ""
        print(f"   {e['removed']} {e['score']}/{e['topic_score']} main {e['main']} -> {e['new_main']}: {e['headline']}{mark}")
    (OUT / "keywords.json").write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
