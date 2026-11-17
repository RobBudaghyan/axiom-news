"""Writes config/common_words.txt: ordinary English words, for the editor's fact guard (Step 15).

A capitalised word at the start of a sentence ("Severe", "Recent", "Hundreds") is an ordinary
word, not an invented name, when the pool itself uses it in lower case. This reads the English
text of the pool from the live D1 (article titles and snippets, summaries, headlines, descriptions
of the last `--days` days) and keeps the words written in lower case at least 3 times and in lower
case at least 60% of the times they appear mid-sentence. Names ("Moscow", "Kyiv", "Pashinyan")
fail that test. Re-run only to refresh the list; review the diff.

    venv/Scripts/python scripts/make_common_words.py [--days 14]
"""
from __future__ import annotations

import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from job.config import load_env  # noqa: E402
from job.d1 import D1  # noqa: E402

WORD = re.compile(r"(?<![A-Za-z'’])[A-Za-z][a-z]{2,}(?![A-Za-z])")
OPENER = re.compile(r"(?:^|[.!?:\"'(]\s*)$")


def counts(texts: list[str]) -> tuple[Counter, Counter]:
    lower, upper = Counter(), Counter()
    for text in texts:
        for m in WORD.finditer(text):
            w = m.group(0)
            if OPENER.search(text[max(0, m.start() - 3):m.start()]) or m.start() == 0:
                continue                 # a sentence start says nothing about the word
            (lower if w[0].islower() else upper)[w.lower()] += 1
    return lower, upper


def common_words(texts: list[str], min_lower: int = 3, share: float = 0.6) -> list[str]:
    lower, upper = counts(texts)
    return sorted(w for w, n in lower.items() if n >= min_lower and n / (n + upper[w]) >= share)


def main() -> int:
    days = int(sys.argv[sys.argv.index("--days") + 1]) if "--days" in sys.argv else 14
    env = load_env()
    db = D1(env["CLOUDFLARE_ACCOUNT_ID"], env["D1_DATABASE_ID"], env["CLOUDFLARE_D1_TOKEN"])
    since = "strftime('%s','now') - " + str(days * 86400)
    texts = [r["t"] for r in db.query(f"SELECT title || '. ' || coalesce(snippet, '') AS t FROM items "
                                      f"WHERE fetched_at >= {since} AND source_key NOT IN ('gnews')")]
    texts += [r["t"] for r in db.query(f"SELECT coalesce(summary, '') || '. ' || coalesce(headline, '') || '. ' || "
                                       f"coalesce(description, '') AS t FROM stories WHERE updated_at >= {since}")]
    texts = [t for t in texts if t and not re.search(r"[Ѐ-ӿԱ-֏]", t)]      # English only
    words = common_words(texts)
    out = ROOT / "config" / "common_words.txt"
    head = ("# Ordinary English words for the editor's fact guard (job/editor.py), one per line.\n"
            "# Written by scripts/make_common_words.py from the pool's own lower-case text; edit by hand if needed.\n")
    out.write_text(head + "\n".join(words) + "\n", encoding="utf-8")
    print(f"{len(texts)} texts, {len(words)} words, written {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
