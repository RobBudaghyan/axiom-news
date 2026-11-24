"""Step 20: translate the recent Armenian and French stories again with the new rules (the strong
models only, the terms, the source title, the meaning check) and keep a before/after record.

    AXIOM_ENV=staging venv/Scripts/python scripts/step20_retranslate.py --dry      # staging, writes nothing
    venv/Scripts/python scripts/step20_retranslate.py --langs hy,fr --hours 48    # production, after "ship it"

Order: stories Groq translated first, then those the new code checks reject (the Polish "że" inside
Armenian), then the rest, newest first. A new translation replaces the old one only if it passed
every check and the meaning check. If it did not: an old one that fails the new checks is marked
for a redo (the hourly job does it); an old one that passes stays. The emergency key's caps hold
here too (its spend is logged in ai_spend), so a day without free Gemini may do only part of it;
run it again later and it goes on with the stories not done yet (`--skip-done`).
`--examples N` also reads the OLD translation back into English for N stories (one more check call
each batch), for the report.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from job import chain, translate  # noqa: E402
from job.config import Settings, load_env  # noqa: E402
from job.d1 import insert_statements  # noqa: E402
from job.run import HTTP_CODE, build_from_env  # noqa: E402

ROWS_SQL = ("SELECT t.story_id, t.lang, t.headline AS old_headline, t.description AS old_description, t.provider AS old_provider, "
            "t.src, t.created_at, s.id, s.summary, s.headline, s.description FROM story_translations t "
            "JOIN stories s ON s.id = t.story_id WHERE t.lang = ? AND t.ok = 1 AND t.created_at >= ? AND s.merged_into IS NULL "
            "ORDER BY t.created_at DESC")


def main(argv=None) -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--langs", default="hy,fr")
    ap.add_argument("--hours", type=float, default=48)
    ap.add_argument("--limit", type=int, default=400)
    ap.add_argument("--examples", type=int, default=10)
    ap.add_argument("--dry", action="store_true", help="write nothing to story_translations (AI spend is still logged)")
    ap.add_argument("--skip-done", action="store_true", help="leave stories already re-translated by Step 20 rules")
    ap.add_argument("--out", default=str(ROOT / "reports" / "data" / "step-20-retranslate.json"))
    args = ap.parse_args(argv)
    settings = Settings()
    db, plans = build_from_env(load_env(), settings)
    now = int(time.time())
    calls: list[tuple] = []
    spend_rows: list[tuple] = []

    def on_call(p, ok, n, res, error, kind):
        m = HTTP_CODE.search(error or "")
        calls.append((int(time.time()), p.name, p.model, 1 if ok else 0, n, res.input_tokens if res else None,
                      res.output_tokens if res else None, res.ms if res else None, (error or "")[:500] or None, kind,
                      int(m.group(1)) if m else None))
        usd = getattr(p, "last_cost", None) if p.name == "gemini_paid" else None
        if usd:
            spend_rows.append((int(time.time()), "job", p.model, f"retranslate_{kind}", res.input_tokens if res else None,
                               res.output_tokens if res else None, round(float(usd), 6),
                               "Step 20 re-translation (owner request); free models: " + chain.free_failures(calls[:-1])[:200]))

    tr = translate.Translator(db, plans.translate, settings=settings, on_call=on_call, log=print)
    glossary = translate.load_glossary()
    out = {"made_at": now, "hours": args.hours, "langs": {}}
    for lang in [x.strip() for x in args.langs.split(",") if x.strip()]:
        rows = [r for r in db.query(ROWS_SQL, [lang, now - int(args.hours * 3600)]) if r["src"] == translate.src_text(r)]
        if args.skip_done:
            rows = [r for r in rows if not str(r["old_provider"] or "").startswith(("gemini-4", "gemini-3.8", "emergency"))]

        def order(r):
            _, _, probs = translate.check_translation(lang, r, r["old_headline"] or "", r["old_description"] or "", glossary)
            r["old_problems"] = probs
            return (0 if r["old_provider"] == "groq" else 1 if probs else 2, -r["created_at"])
        rows.sort(key=order)
        rows = rows[:args.limit]
        print(f"{lang}: {len(rows)} current translations of the last {args.hours:g} h")
        lres = translate.LangResult(todo=len(rows))
        done: dict[int, tuple] = {}
        batch = settings.translate_paid_batch     # small batches: they also fit the paid key's answer limit
        for i in range(0, len(rows), batch):
            part = [{**r, "retry_note": None} for r in rows[i:i + batch]]
            got = tr.translate(lang, part, now, lres)
            for t in got:
                done[t[0]] = t
            if not got:
                print("  stopped: no provider answered (or the emergency key's cap); run it again later")
                break
        # before/after record; the old translation read back into English for the examples
        examples = [r for r in rows if r["id"] in done][:args.examples]
        old_back = {}
        if examples:
            pairs = [(r, (r["id"], lang, 1, r["old_headline"], r["old_description"])) for r in examples]
            ans = tr._ask_check(tr.plans[0], lang, pairs, lres)
            old_back = {sid: a for sid, a in (ans or {}).items()}
        writes, record = [], []
        for r in rows:
            new = done.get(r["id"])
            item = {"id": r["id"], "english": translate.src_text(r), "old_provider": r["old_provider"],
                    "old": f"{r['old_headline']}\n{r['old_description'] or ''}".strip(), "old_problems": r["old_problems"]}
            if r["id"] in old_back:
                item["old_back"] = old_back[r["id"]].get("back")
                item["old_same_meaning"] = old_back[r["id"]].get("same_meaning")
                item["old_check_problem"] = old_back[r["id"]].get("problem")
            if new is None:
                item["result"] = "not done (no provider or the cap)"
            elif new[2]:
                item.update(result="replaced", new=f"{new[3]}\n{new[4] or ''}".strip(), new_provider=new[7])
                writes.append((translate.UPSERT_SQL, list(new)))
            elif r["old_problems"]:
                item.update(result="old one fails the new checks: marked for a redo", note=new[6])
                writes.append((translate.UPSERT_SQL, list(new)))
            else:
                item.update(result="new one rejected, old one kept", note=new[6])
            record.append(item)
        if writes and not args.dry:
            db.batch(writes)
        print(f"  {sum(1 for x in record if x['result'] == 'replaced')} replaced, "
              f"{sum(1 for x in record if x['result'].startswith('old one fails'))} marked for a redo, "
              f"{sum(1 for x in record if x['result'].startswith('new one rejected'))} kept, "
              f"{sum(1 for x in record if x['result'].startswith('not done'))} not done; {lres.calls} calls "
              f"({lres.check_calls} meaning checks, {lres.drifted} drifted, {lres.redone} redone)")
        out["langs"][lang] = {"result": lres.__dict__, "rows": record}
    stmts = insert_statements("ai_calls", ("at", "provider", "model", "ok", "items", "input_tokens", "output_tokens", "ms",
                                           "error", "kind", "code"), calls)
    stmts += insert_statements("ai_spend", ("at", "source", "model", "kind", "input_tokens", "output_tokens", "usd", "reason"),
                               spend_rows)
    if stmts:
        db.batch(stmts)
    out["spent_usd"] = round(sum(r[6] for r in spend_rows), 6)
    out["calls"] = len(calls)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"spent ${out['spent_usd']:.4f} on the emergency key; {len(calls)} AI calls; written {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
