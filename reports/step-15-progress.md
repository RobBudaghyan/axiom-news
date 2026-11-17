# Step 15 progress

A new session continues from here. Plan: 5 parts in order (topics, tuning, Help and Feedback,
welcome and announcements, cleanup), then `reports/step-15-final-product.md`.

## Owner decisions (2026-11-17)
- **Off means off:** if a story's main topic is one of the six main topics and the reader has it
  off, the story never reaches them, even through another tag they have on. Otherwise one tag
  they have on is enough (the gate that already existed). A story with no tag the reader has on
  reaches nobody.
- **Old-bot users:** imported later by a script from a list, with an `imported` flag (no welcome,
  they get the announcement).

## Part 1: done (2026-11-17)
- Topics: `politics_conflicts` (Politics & Conflicts / Политика и конфликты) replaces Politics and
  Wars & Conflicts; `economy_markets` (Economy & Markets / Экономика и рынки) is new. Armenian and
  French names too. The four others are unchanged.
- `config/digest.json`: boost cap 0 for Politics & Conflicts (broad, like both old topics), 1 for
  Economy & Markets (a big rate decision may go from 5 to 6 for its followers; routine market news
  stays +0); specificity puts Economy above Politics & Conflicts.
- Prompts: pass 1 no longer calls economy news "not news" (routine company news and a day's market
  wrap still are); the editor has 4/6/8 examples for Economy & Markets, a merged Politics &
  Conflicts list, and a culture and sport line (below 6 on main topics; this is also Part 2's item).
- Off means off in `worker/src/digest.js` (SQL and `qualifies`) and `job/translate.py` (SQL and
  `qualifies`); the shared fixture `tests/fixtures/eligible_cases.json` now has five readers with
  topics off, checked by both suites and by the SQL on sqlite.
- Migration script `worker/scripts/migrate-topics.mjs` (`--dry` first). Test: all 63 subsets of the
  old topics, no topic lost.
- Economy feeds: no clear gap, so no feed added and no extra tokens. In 48 h: Bloomberg markets 232
  items, Bloomberg economics 50, WSJ markets 50, CNBC 47, MarketWatch 46, FT markets 12, plus
  Interfax, Kommersant, RBC and Vedomosti 220 to 320 each. The new prompt keeps more of them, but
  they are already in the AI calls.
- Tests: Python 174, Worker 232, click-through 94 of 94. Mutations 9 of 9 caught
  (`scripts/step15_mutations.py 1`).
- CPU: one digest 0.31 ms, a tick with 8 readers 4.7 ms (Step 14: 0.25-0.28 and 4.3-5.0).

## Waiting on the owner
- The emoji for the two topics (message sent on the TEST bot: A1 🏛️ / A2 🌐 / A3 ⚖️ and
  B1 📈 / B2 💹 / B3 🏦). Until he answers: 🏛️ and 📈. To apply his pick, change `emoji:` in
  `config/topics.yaml`; the next hourly run syncs the topics table.

## Next
Part 2: the fact guard fix (real examples from `errors`), keyword refresh (`keywords_at`, weekly,
Admin button), replays before and after, a labelled preview digest.
