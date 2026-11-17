"""Step 15: break each new rule once and check that a test catches it. Restores every file.

    venv/Scripts/python scripts/step15_mutations.py [part]
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = [str(ROOT / "venv" / "Scripts" / "python"), "-m", "unittest", "discover", "-s", "tests", "-t", "."]
NODE = ["node", "--test", "test/"]

MUTATIONS = {
    "1": [
        ("off rule gone from the digest SQL", "worker/src/digest.js",
         "    AND NOT (coalesce(s.main_topic, '') IN (SELECT m.value FROM json_each(?12) m)\n"
         "             AND coalesce(s.main_topic, '') NOT IN (SELECT u.value FROM json_each(?2) u))\n", "", "node"),
        ("off rule gone from the Worker's qualifies()", "worker/src/digest.js",
         "  if (s.main_topic && mainTags(cfg).includes(s.main_topic) && !userTopics.includes(s.main_topic)) return false;\n",
         "", "node"),
        ("off rule gone from the job's qualifies()", "job/translate.py",
         "    if main and main in main_tags(cfg) and main not in tags:\n        return False", "    pass", "py"),
        ("off rule gone from the job's SQL", "job/translate.py",
         "    AND NOT (coalesce(s.main_topic, '') IN (SELECT m.value FROM json_each(?8) m)\n"
         "             AND coalesce(s.main_topic, '') NOT IN (SELECT u.value FROM json_each(?7) u))\n", "", "py"),
        ("migration forgets Economy & Markets", "worker/scripts/migrate-topics.mjs", "  out.add(NEW_TOPIC);\n", "", "node"),
        ("migration drops Wars & Conflicts followers", "worker/scripts/migrate-topics.mjs",
         'wars_conflicts: "politics_conflicts"', 'wars_conflicts: "wars_conflicts"', "node"),
        ("war stories no longer get the broad tag", "job/ai.py", "            tags.add(BROAD_TAG)", "            pass", "py"),
        ("Russian topic name wrong", "config/i18n/ru.json", '"economy_markets": "Экономика и рынки"',
         '"economy_markets": "Экономика"', "node"),
        ("Economy & Markets boost cap lifted", "config/digest.json", '"economy_markets": 1,', '"economy_markets": 3,', "node"),
    ],
    "2": [
        ("fact guard ignores the common words", "job/editor.py",
         "\n                       or m.group(0).lower() in COMMON_WORDS):", "):", "py"),
        ("fact guard takes any opener as ordinary (names pass too)", "job/editor.py",
         "        if opener and (m.group(0) in SENTENCE_OPENERS", "        if opener or (m.group(0) in SENTENCE_OPENERS", "py"),
        ("party names no longer accepted", "job/editor.py",
         "Republican Republicans Democrat Democrats", "Democrats", "py"),
        ("West/Western rule gone", "job/editor.py",
         "\n                    and not (len(low) >= 4 and any(w.startswith(low) for w in roots))):", "):", "py"),
        ("common word list emptied", "config/common_words.txt", "\nsevere\n", "\n", "py"),
        ("keywords never refreshed", "job/custom.py",
         '"(keywords IS NULL OR keywords_at IS NULL OR keywords_at <= ?) "', '"(keywords IS NULL OR 0 = ?) "', "py"),
        ("a weak refresh overwrites good keywords", "job/custom.py",
         'if r.get("keywords") and len(kw["en"]) < MIN_REFRESH_KEYWORDS:', "if False:", "py"),
        ("refresh every day instead of weekly", "job/custom.py", "KEYWORDS_REFRESH_DAYS = 7", "KEYWORDS_REFRESH_DAYS = 0", "py"),
        ("Admin Keywords button does nothing", "worker/src/custom.js",
         'if (action === "keywords") return [{ sql: "UPDATE custom_topics SET keywords_at = 0 WHERE id = ?1", params: [topic.id] }];',
         'if (action === "keywords") return [];', "node"),
        ("the topic check stores no keywords time", "worker/src/custom.js", "a.keywords ? now : null] },", "null] },", "node"),
        ("culture line gone from the editor prompt", "prompts/editor.md", "   CULTURE AND SPORT stay below 6", "   CULTURE stays low", "py"),
        ("economy examples gone", "prompts/editor.md", '"Global stocks plunge as a major bank collapses" 8, 8;', "", "py"),
        ("pass 1 calls economy news not news again", "prompts/story_batch.md",
         "Economy\n   news with wide impact IS news (economy_markets)", "Economy\n   news is not news (economy_markets)", "py"),
    ],
}


def run(kind: str) -> bool:
    if kind == "py":
        r = subprocess.run(PY, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    else:
        r = subprocess.run(NODE, cwd=ROOT / "worker", capture_output=True, text=True, encoding="utf-8", errors="replace", shell=True)
    return r.returncode == 0


def main() -> int:
    parts = sys.argv[1:] or sorted(MUTATIONS)
    caught = total = 0
    for part in parts:
        for name, rel, old, new, kind in MUTATIONS[part]:
            path = ROOT / rel
            text = path.read_text(encoding="utf-8")
            if old not in text:
                print(f"SKIP  {name}: pattern not found")
                continue
            total += 1
            path.write_text(text.replace(old, new, 1), encoding="utf-8", newline="")
            try:
                ok = run(kind)
            finally:
                path.write_text(text, encoding="utf-8", newline="")
            caught += not ok
            print(f"{'CAUGHT' if not ok else 'MISSED'}  {name}")
    print(f"{caught} of {total} caught")
    return 0 if caught == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
