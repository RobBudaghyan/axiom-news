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
