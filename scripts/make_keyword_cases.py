"""Step 14: tests/fixtures/keyword_cases.json, cases of the keyword cleaning (job/custom.py
clean_keywords) that worker/test/keywords.test.mjs checks cleanKeywords in worker/src/custom.js
against, so the job and the Worker clean the AI's keywords the same way.

    venv/Scripts/python scripts/make_keyword_cases.py
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from job import custom  # noqa: E402

PIECES = ["Japan", "japan", "JAPAN", " Tokyo ", "Bank  of Japan", "B.O.J.", "Yen", "x" * 41, "-", "—", "", "7", "42nd",
          "Toyota & Honda", "O'Brien", "Kyōto", "Япония", "японский", "Токио", "Банк Японии", "...", "Seoul\nKorea",
          "AI-chips", "#tag", "a/b", "Ճապոնիա", "日本", "ok_word", " .Lead. "]


def main() -> int:
    rnd = random.Random(14)
    cases = []
    for n in range(300):
        names = {"en": rnd.choice(["Japan", "Colombia", "", "Formula 1"]), "ru": rnd.choice(["Япония", "", "Japan"])}
        raw = {lang: [rnd.choice(PIECES) for _ in range(rnd.randint(0, 20))] for lang in ("en", "ru")}
        if n % 25 == 0:
            raw = {"en": "not a list", "ru": None}
        cases.append({"raw": raw, "names": names, "want": custom.clean_keywords(raw, names)})
    path = ROOT / "tests" / "fixtures" / "keyword_cases.json"
    path.write_text(json.dumps(cases, ensure_ascii=False, indent=0) + "\n", encoding="utf-8")
    print(f"wrote {len(cases)} cases to {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
