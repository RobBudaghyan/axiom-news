"""Step 20 test (d): the owner's bad Armenian translation through the REAL meaning check, next to a good one.
One check call on the strong chain (free models first, then the emergency key under its caps; its spend is
logged in ai_spend). Staging only.

    AXIOM_ENV=staging venv/Scripts/python scripts/step20_meaning_demo.py
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from job import chain, translate  # noqa: E402
from job.config import Settings, load_env  # noqa: E402
from job.d1 import insert_statements  # noqa: E402
from job.run import build_from_env  # noqa: E402

EN_HEAD = "Ukrainian intelligence says Russian special services posted 20 million espionage job ads on Discord"
EN_DESC = ("Defence Intelligence of Ukraine reported that Russian special services used Discord to post over 20 million "
           "disguised job ads offering cash for espionage and sabotage tasks in Europe.")
BAD = ("Ուկրաինական խաբեությունը ասում է, որ ռուսական հատուկ ծառայությունները Discord-ում տեղադրել են 20 միլիոն "
       "գուշակության աշխատանքի հայտարարություններ",
       "Ուկրաինայի պաշտպանական խաբեությունը հայտնել է, որ ռուսական հատուկ ծառայությունները Discord-ում տեղադրել են ավելի "
       "քան 20 միլիոն գուշակության աշխատանքի հայտարարություն Եվրոպայում։")
GOOD = ("Ուկրաինական հետախուզությունը հայտնում է, որ ռուսական հատուկ ծառայությունները Discord-ում տեղադրել են լրտեսության "
        "20 միլիոն աշխատանքի հայտարարություն",
        "Ուկրաինայի պաշտպանության հետախուզությունը հայտնել է, որ ռուսական հատուկ ծառայությունները Discord-ում տեղադրել են "
        "ավելի քան 20 միլիոն քողարկված աշխատանքի հայտարարություն՝ Եվրոպայում լրտեսության և դիվերսիոն առաջադրանքների համար "
        "կանխիկ գումար առաջարկելով։")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if os.environ.get("AXIOM_ENV") != "staging":
        raise SystemExit("staging only: AXIOM_ENV=staging")
    db, plans = build_from_env(load_env(), Settings())
    spend = []

    def on_call(p, ok, n, res, error, kind):
        usd = getattr(p, "last_cost", None) if p.name == "gemini_paid" else None
        print(f"call: {p.name} {p.model} ok={ok} {error or ''}"[:200])
        if usd:
            spend.append((int(time.time()), "job", p.model, "step20_test_d", res.input_tokens if res else None,
                          res.output_tokens if res else None, round(usd, 6), "Step 20 test (d) on staging"))

    tr = translate.Translator(db, plans.translate, on_call=on_call, log=print)
    story = {"id": 1, "summary": EN_HEAD, "headline": EN_HEAD, "description": EN_DESC}
    pairs = [(story, (1, "hy", 1, BAD[0], BAD[1])), ({**story, "id": 2}, (2, "hy", 1, GOOD[0], GOOD[1]))]
    res = translate.LangResult()
    answer = tr._ask_check(tr.plans[0], "hy", pairs, res)
    if answer is None:
        print("no provider could check")
        return 1
    verdict = tr._judge("hy", pairs, answer)
    out = {}
    for sid, label in ((1, "bad (the owner's example)"), (2, "good")):
        a = answer.get(sid, {})
        out[label] = {"back": a.get("back"), "same_meaning": a.get("same_meaning"), "problem": a.get("problem"),
                      "verdict": "REJECTED: " + "; ".join(verdict[sid]) if verdict[sid] else "accepted"}
        print(f"\n{label}\n  read back: {a.get('back')}\n  model says same meaning: {a.get('same_meaning')} {a.get('problem') or ''}"
              f"\n  verdict: {out[label]['verdict']}")
    if spend:
        db.batch(insert_statements("ai_spend", ("at", "source", "model", "kind", "input_tokens", "output_tokens", "usd", "reason"), spend))
    out["spent_usd"] = sum(s[6] for s in spend)
    (ROOT / "reports" / "data").mkdir(parents=True, exist_ok=True)
    (ROOT / "reports" / "data" / "step-20-meaning-check.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nspent ${out['spent_usd']:.4f}")
    return 0 if verdict[1] and not verdict[2] else 1


if __name__ == "__main__":
    raise SystemExit(main())
