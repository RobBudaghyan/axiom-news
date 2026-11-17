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
- **Live (2026-11-17):** Worker deployed, migration run. The owner: politics, wars_conflicts,
  armenia, russia, iran_war, ukraine_war became politics_conflicts, economy_markets, armenia,
  russia, iran_war, ukraine_war. The second user had no main topic on (only `[]`) and now has
  economy_markets. 4,716 stories re-tagged, 0 left on old tags; the topics table holds the six
  new rows.
- Tests: Python 174, Worker 232, click-through 94 of 94. Mutations 9 of 9 caught
  (`scripts/step15_mutations.py 1`).
- CPU: one digest 0.31 ms, a tick with 8 readers 4.7 ms (Step 14: 0.25-0.28 and 4.3-5.0).

## Waiting on the owner
- The emoji for the two topics (message sent on the TEST bot: A1 🏛️ / A2 🌐 / A3 ⚖️ and
  B1 📈 / B2 💹 / B3 🏦). Until he answers: 🏛️ and 📈. To apply his pick, change `emoji:` in
  `config/topics.yaml`; the next hourly run syncs the topics table.

## Part 2: done except the preview digest (2026-11-17, commit 6288d97, Worker 2f8e7cd1)
- Fact guard: 166 texts dropped in 30 days (errors log). 62 of them were only ordinary words at a
  sentence start (Recent, Severe, Hundreds, Analysis, Escalating, Investors...) or party names
  (Republican, Party); those now pass. 30 number drops and 74 real name drops (Moscow, Kyiv,
  Washington...) are still dropped, as they should be. How: `config/common_words.txt` (7,192 words the
  pool writes in lower case, `scripts/make_common_words.py`), party names in `ALWAYS_OK`, and "West"
  passes when the articles say "Western". 11 tests from the real cases (`tests/test_editor.py`).
- Culture and sport below 6 on main topics: editor prompt line and examples (done in Part 1).
- Keywords: `custom_topics.keywords_at` (applied live); the job refreshes keywords older than 7 days
  (at most 5 a run, recent Google headlines), keeps the old ones if the new answer has fewer than 5;
  Admin's "Keywords" button per custom topic marks it for the next run. Live: the existing topics have
  no `keywords_at` yet, so the next run refreshes them once (one call each).
- Replay (`worker/scripts/step15-replay.mjs`, `reports/data/step-15/replay.{json,txt}`, 48 h): all six
  topics 105 stories (15 a digest), Armenia only 87 (12.4), the owner 22 (2.0), Economy off 105, before
  and after the same: only 11 stories reached 7+ in 48 h, none whose only route was a switched-off main
  topic, and no story had Economy as its main topic yet (the first run with the new prompts was still
  running). Switched-off topics sent nothing in every "after" run.
- Note for the owner: Armenia-only readers get about 12 stories a digest because the editor gives 167
  Armenia stories in 48 h a topic score of 6+ (the Step 8 topic path). Not changed here.
- The owner's main topics were all off (custom topics only); the migration switched Economy & Markets
  on for him, as the brief says for every user.
- Tests: Python 180, Worker 233, click-through 94 of 94. Mutations part 2: 13 of 13 caught.

## Still to do in Part 2
- Re-run `node worker/scripts/step15-replay.mjs` after the first editor run with the new prompts
  (economy stories), then send the owner one labelled preview digest
  (`node worker/scripts/digest-cli.mjs --preview --label "..."`).

## Next
Part 3: Help and Feedback rows in Settings.
