"""Step 14: break each new rule once on purpose and check that the tests catch it. Every change is
undone right after its test run (the file is restored byte for byte, also on an error).
Output: reports/data/step-14/mutations.txt and a table on screen.

    venv/Scripts/python scripts/step14_mutations.py
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = [str(ROOT / "venv" / "Scripts" / "python"), "-m", "unittest", "discover", "-s", "tests"]
JS = ["node", "--test", "test/"]

MUTATIONS = [
    ("keyword rule: a custom tag always allowed", "job/custom.py",
     "        return bool(p and p.search(text or \"\"))", "        return True", PY),
    ("keyword rule: substring instead of whole word", "job/custom.py",
     "return re.compile(rf\"(?<!\\w)(?:{'|'.join(parts)})(?:e?s)?(?!\\w)\", re.I)",
     "return re.compile(rf\"(?:{'|'.join(parts)})\", re.I)", PY),
    ("keyword rule: case-sensitive", "job/custom.py",
     "(?:e?s)?(?!\\w)\", re.I)", "(?:e?s)?(?!\\w)\")", PY),
    ("pass 1 ignores the rule for new stories", "job/run.py",
     "            tags = self.rule.tags(list(s.topics), summary)", "            tags = list(s.topics)", PY),
    ("pass 1 ignores the rule in merges", "job/run.py",
     "            tags = set(self.rule.tags(sorted(tags), ", "            tags = set((lambda x, y: x)(sorted(tags), ", PY),
    ("editor ignores the rule", "job/editor.py",
     "            stmts, merged = write_statements(events, by_id, self.topic_order, now, self.rule)",
     "            stmts, merged = write_statements(events, by_id, self.topic_order, now)", PY),
    ("fallback keeps the boosted topic score", "job/editor.py",
     "            if moved:\n                ts = ev.score", "            if moved:\n                pass", PY),
    ("fallback: the custom tag stays the main topic", "job/custom.py",
     "        return kept, self.fallback(kept), True", "        return kept, main, True", PY),
    ("the hourly sweep never runs", "job/run.py",
     "                self.run_enforce(now, stats)\n", "", PY),
    ("backfill never runs in the job", "job/run.py",
     "                self.run_keywords(stats)\n", "", PY),
    ("backfill without the recent headlines", "job/custom.py",
     "        prompt = keywords_prompt(names, r[\"definition\"], recent)",
     "        prompt = keywords_prompt(names, r[\"definition\"])", PY),
    ("backfill does not try the next provider", "job/custom.py",
     "                on_call(p, False, 1, res, f\"{p.name}: keywords: {type(exc).__name__}: {exc}\"[:300], kind=\"topic_keywords\")\n                continue",
     "                on_call(p, False, 1, res, f\"{p.name}: keywords: {type(exc).__name__}: {exc}\"[:300], kind=\"topic_keywords\")\n                break", PY),
    ("backfill: the topic's own name not first", "job/custom.py",
     "        for w in [names.get(lang), *given]:", "        for w in [*given]:", PY + [], ),
    ("glossary spelling off for Google headlines", "job/custom.py",
     "            it.title = spell_names(it.title)", "            pass", PY),
    ("glossary spelling off for the editor", "job/editor.py",
     "            ev.headline = custom.spell_names(head) or None", "            ev.headline = head or None", PY),
    ("glossary: Takaichi entry gone", "config/glossary.yaml",
     "  - {en: [Takaichi, Takaiti], ru: Такаити, hy: Տակաիչի, fr: Takaichi}\n", "", PY),
    ("editor prompt: non-event line gone", "prompts/editor.md",
     "is 3 or 4, never 6, however serious the subject", "is 6", PY),
    ("Worker: keywords not saved with a new topic", "worker/src/custom.js",
     "a.keywords ? JSON.stringify(a.keywords) : null] },", "null] },", JS),
    ("Worker: too few keywords still saved", "worker/src/custom.js",
     "    keywords: kw.en.length >= MIN_KEYWORDS ? kw : null,", "    keywords: kw,", JS),
    ("Worker: keyword cleaning differs from the job (no dedupe)", "worker/src/custom.js",
     "      if (seen.has(w.toLowerCase())) continue;", "", JS),
    ("Worker: the check prompt does not ask for keywords", "worker/src/custom.js",
     "   - ${KEYWORDS_INSTRUCTION}\n", "", JS),
    ("Worker: the Settings button back under digests", "worker/src/cron.js",
     "  return { kind: plan.kind ?? \"html\" };",
     "  return { kind: plan.kind ?? \"html\", ...(appUrl ? { reply_markup: { inline_keyboard: [[{ text: \"⚙️ Settings\", web_app: { url: appUrl } }]] } } : {}) };", JS),
    ("Worker: an em dash in a Russian digest text", "config/i18n/ru.json",
     "\"quiet_line\": \"Спокойный период:", "\"quiet_line\": \"Спокойный период —", JS),
    ("Worker: length limit ignored", "worker/src/digest.js",
     "  while (keep.length > 1 && size(keep) > limit) {", "  while (false) {", JS),
]


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    lines, caught = [], 0
    for name, rel, old, new, cmd in MUTATIONS:
        path = ROOT / rel
        orig = path.read_bytes()
        text = orig.decode("utf-8")
        if text.count(old) != 1:
            lines.append(f"SKIPPED (pattern found {text.count(old)} times): {name}")
            print(lines[-1])
            continue
        try:
            path.write_bytes(text.replace(old, new).encode("utf-8"))
            cwd = ROOT / "worker" if cmd is JS else ROOT
            r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
            out = r.stdout + r.stderr
            if cmd is JS:
                fails = next((ln.split()[-1] for ln in out.splitlines() if ln.startswith("ℹ fail")), "?")
            else:
                last = [ln for ln in out.splitlines() if ln.startswith("FAILED") or ln.strip() == "OK"]
                fails = last[-1] if last else "?"
            ok = r.returncode != 0
        finally:
            path.write_bytes(orig)
        caught += ok
        lines.append(f"{'CAUGHT' if ok else 'NOT CAUGHT'}: {name} ({rel}): {fails}")
        print(lines[-1])
    lines.append(f"\n{caught} of {len(MUTATIONS)} caught")
    print(lines[-1])
    out = ROOT / "reports" / "data" / "step-14" / "mutations.txt"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
