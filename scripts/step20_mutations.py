"""Step 20: break each new rule once and check that a test catches it. Restores every file.

    venv/Scripts/python scripts/step20_mutations.py [part ...]      parts: job, translate, worker
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = [str(ROOT / "venv" / "Scripts" / "python"), "-m", "unittest", "discover", "-s", "tests", "-t", "."]
NODE = ["node", "--test", "test/"]

# (name, file, old text, new text, which tests: "node" or "py")
MUTATIONS = {
    "job": [
        ("503 retried without the run's retry budget", "job/ai.py",
         "            if self.budget is not None and not self.budget.take(delay):\n                break",
         "            if False:\n                break", "py"),
        ("a model whose retries ran out keeps waiting", "job/ai.py",
         "        delays = () if self.down else self.retry_delays", "        delays = self.retry_delays", "py"),
        ("402 does not stop the other models on the key", "job/ai.py",
         "                self.key.dead = f\"HTTP {resp.status_code}\"\n            elif resp.status_code in (400, 401, 403)",
         "                pass\n            elif resp.status_code in (400, 401, 403)", "py"),
        ("Groq pool sleeps on a 429 instead of moving on", "job/chain.py",
         "                        self.busy_until[m.model] = self.clock() + ra\n                    continue",
         "                        self.busy_until[m.model] = self.clock() + ra\n                    raise", "py"),
        ("Groq pool ignores daily limits", "job/chain.py", '                        m.dead = "daily limit"', "                        pass", "py"),
        ("reasoning_effort sent to every Groq model", "job/ai.py",
         'if self.reasoning_effort and self.model.startswith("openai/gpt-oss"):', "if self.reasoning_effort:", "py"),
        ("daily cap not checked", "job/chain.py",
         "        if self.day + worst > float(c.get(\"daily_cap_usd\", 0)):", "        if False:", "py"),
        ("monthly cap not checked", "job/chain.py",
         "        if self.month + worst > float(c.get(\"monthly_cap_usd\", 0)):", "        if False:", "py"),
        ("credits expiry not checked", "job/chain.py",
         "        if c.get(\"credits_expire\") and today >= c[\"credits_expire\"]:", "        if False:", "py"),
        ("unreadable ledger allows paid calls", "job/chain.py",
         "        if not self.readable:\n            return", "        if False:\n            return", "py"),
        ("cap checked on the expected, not the worst case", "job/chain.py",
         "self.max_output_tokens,\n                         self.spend.cfg, int(self.spend.now()))",
         "0,\n                         self.spend.cfg, int(self.spend.now()))", "py"),
        ("paid key gets items a free provider only deferred", "job/run.py",
         "                waiting = [i for i in queue if i[\"id\"] not in failed_ids]\n                queue = [i for i in queue if i[\"id\"] in failed_ids]",
         "                waiting = []", "py"),
        ("paid spend not logged", "job/run.py", "        if usd:\n            self.spend_log.append(", "        if False:\n            self.spend_log.append(", "py"),
        ("degraded order ignores followed topics", "job/run.py",
         "        return (0 if tags & followed else 1, int(i.get(\"tier\") or 9)", "        return (0, int(i.get(\"tier\") or 9)", "py"),
        ("forced failures allowed on production", "job/run.py",
         "    if parts and os.environ.get(\"AXIOM_ENV\") != \"staging\":", "    if False:", "py"),
        ("3.8 Flash price change ignored", "config/ai_budget.json", '"2027-01-01": {"gemini-3.8-flash": [1.50, 7.50]}', '"2027-01-01": {}', "py"),
    ],
    "translate": [
        ("Groq translates again", "job/translate.py",
         "            if p.name == \"groq\":\n                continue          # Step 20", "            if False:\n                continue          # Step 20", "py"),
        ("meaning check verdict ignored", "job/translate.py", "    if not same:\n        out.append(f\"meaning changed:", "    if False:\n        out.append(f\"meaning changed:", "py"),
        ("term rule off", "job/translate.py", "        if t.get(\"back\") and not any(b in low for b in t[\"back\"]):", "        if False:", "py"),
        ("no redo after a drift", "job/translate.py",
         "            again = self._call(plan, lang, redo, res, f\"translate_{lang}\")", "            again = None", "py"),
        ("unchecked translation is stored as good", "job/translate.py",
         "            keep = {r[0] for r in checked if not r[2]}\n            return [r for r in checked if r[0] in keep]",
         "            return checked", "py"),
        ("Latin words in Armenian pass", "job/translate.py", "    if lang in (\"hy\", \"ru\"):\n        english_words", "    if False:\n        english_words", "py"),
        ("source title not given to the model", "job/translate.py",
         "                item[\"source_title\"] = s[\"source_title\"]       # Step 20: context only", "                pass", "py"),
        ("terms not in the prompt", "job/translate.py", '            "{terms}": term_lines,', '            "{terms}": "(none)",', "py"),
        ("intelligence loses its back-check stems", "config/glossary.yaml",
         "back: [intelligence, spy, spies, espionage, reconnaissance]}", "}", "py"),
    ],
    "worker": [
        ("Worker: paid key before Groq", "worker/src/custom.js",
         "  if (env.GROQ_API_KEY) {\n    for (const model of ch.groq",
         "  if (env.GEMINI_EMERGENCY_API_KEY && cfg.emergency?.model) out.push({ name: \"gemini_paid\", model: cfg.emergency.model, paid: true });\n  if (env.GROQ_API_KEY) {\n    for (const model of ch.groq", "node"),
        ("Worker: no 503 retry", "worker/src/custom.js", '    if (p.name === "gemini" && (r.code === 503 || r.code === 500)) {', "    if (false) {", "node"),
        ("Worker: cap not checked", "worker/src/custom.js", "      if (why) {\n        calls.push(", "      if (false) {\n        calls.push(", "node"),
        ("Worker: unreadable ledger allows paid calls", "worker/src/spend.js",
         '  if (!sums) return "the spend ledger could not be read";', "  if (!sums) return null;", "node"),
        ("Groq schema 400 counted as an outage", "job/ai.py", '                kind = "invalid"   # Step 20', '                kind = "http"   # Step 20', "py"),
        ("paid pass-1 chunks as big as free ones", "job/run.py", "                                  settings.emergency_chunk_tokens, settings.existing_max,",
         "                                  settings.gemini_max_input_tokens, settings.existing_max,", "py"),
        ("Worker: spend not written", "worker/src/custom.js", "...(c.usd ? [spendInsert({ ...c, kind })] : [])", "...[]", "node"),
        ("Worker: alert every hour", "worker/src/spend.js", "  if (!rows?.length || metaRows?.[0]?.value === day) return null;", "  if (!rows?.length) return null;", "node"),
        ("Worker: daily cap ignored", "worker/src/spend.js",
         "  if (Number(sums.day) + worst > Number(cfg.daily_cap_usd ?? 0))", "  if (false)", "node"),
        ("Worker: Admin loses the runs list", "worker/src/admin.js", "[spend0] = [], runs = []] = rows;", "[spend0] = []] = rows; const runs = [];", "node"),
    ],
}


def run(kind: str) -> bool:
    if kind == "py":
        r = subprocess.run(PY, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    else:
        r = subprocess.run(NODE, cwd=ROOT / "worker", capture_output=True, text=True, encoding="utf-8", errors="replace", shell=True)
    return r.returncode == 0


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parts = sys.argv[1:] or list(MUTATIONS)
    caught = total = 0
    for part in parts:
        for name, rel, old, new, kind in MUTATIONS[part]:
            path = ROOT / rel
            text = path.read_text(encoding="utf-8")
            if old not in text:
                print(f"  SKIP (text not found): {part}: {name}")
                total += 1
                continue
            path.write_text(text.replace(old, new, 1), encoding="utf-8", newline="\n")
            try:
                ok = run(kind)
            finally:
                path.write_text(text, encoding="utf-8", newline="\n")
            total += 1
            caught += not ok
            print(f"  {'caught' if not ok else 'MISSED'}: {part}: {name}")
    print(f"{caught} of {total} caught")
    return 0 if caught == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
