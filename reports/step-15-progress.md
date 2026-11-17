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

## Part 2: done (2026-11-17, commit 6288d97, Worker 2f8e7cd1)
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

- After the first editor run with the new prompts (2026-11-17, run 102, "partial" from Gemini 503s): 15
  stories have Economy & Markets as their main topic. Replay re-run: all six 111 stories (15.9 a digest),
  Armenia only 95 (13.6), the owner 23 (2.1), Economy off 111 with no Economy story; before and after
  the same again, 0 stories from switched-off topics.
- Labelled preview digest sent (all six topics on, English, last 12 h): 15 stories, sections Armenia,
  Politics & Conflicts, Russia, Ukraine War, Iran War, the owner's custom topics, and Economy & Markets;
  3,882 of 3,900 characters, 41 cut for length. `digest-cli.mjs --preview` has two new options:
  `--topics all` and `--lang`.

## Part 3: done (2026-11-17, commit 681a447, Worker 44f7fa84)
- Settings: "Help" and "Send feedback" rows (48 px, blue and green squares, chevron) between Support and
  the time zone line; each opens its own page with Telegram's back button (no tabs on a page).
- Help: eight short sections (what Axiom is, how stories are chosen, topics and My topics, digest times,
  language, pause, Support Axiom, privacy) in English, Russian, Armenian and French.
- Feedback: table `feedback` (applied live); `POST /api/feedback`; 1,000 characters, 10 a reader in 24 h;
  forwarded to the owner with name and id (HTML escaped); a failed forward is kept (forwarded 0);
  success = haptic and a short "Thank you!". Admin: "Recent feedback" (latest 20). /help points to
  Settings with the button.
- Tests: Worker 242 (9 new in `test/feedback.test.mjs`), Python 180, click-through 111 of 111 (Help and
  Feedback flows, the limit, and both pages at 360/390/430 px, en/ru, light/dark). Mutations part 3:
  10 of 10 caught (app and dictionary mutations re-stamp first, so only the intended test can catch them).
- Message sent to the owner asking him to check Help and Feedback on his phone, and telling him Economy &
  Markets is now on for him.

## Waiting on the owner (also)
- His check of Help and Send feedback on his phone.

## Part 4: done (2026-11-17, commit 23bb24d, Worker 9ba3f936)
- /start from a new user: a short welcome in their Telegram language with a "Set up" button (opens the
  Mini App). A user who has not finished the setup gets it again; onboarded and imported users get the
  usual "welcome back".
- First Mini App open (`state.setup`): 3 steps, "Your topics" (1 of 3), "Digest times" (2 of 3), "All
  set" (3 of 3, the next digest and one line about the sample); Skip on step 1, Back on step 2. Every
  tap saves at once. Done or Skip calls `POST /api/onboard` once (`onboarded_at`, claimed with
  `UPDATE ... WHERE onboarded_at IS NULL RETURNING`), which sends the sample digest: the last 24 h,
  labelled "Sample digest: ...", normal rules, stories marked sent. The time zone is saved on open as
  before. The first open is recorded (`opened_at`).
- One reminder (`reminded_at`, claimed before sending): users who never opened the app, 24 h after
  /start, between 10:00 and 20:00 their time, 8 a tick; never for imported users.
- `worker/scripts/import-users.mjs users.json [--dry]`: the old bot's readers with defaults,
  `imported = 1`, `onboarded_at` set; an existing user is untouched; nothing is sent.
- Announcement tool (Admin, owner only): write in English, choose all users or one language,
  Translate (one AI call for every language the audience reads, kind `announce_translate`; each version
  checked: no dash, same numbers, the alphabet, сводка, на Украине; a failing one is left empty with a
  note), edit, Preview (each version to the owner), Send (only after a preview of exactly that text).
  The cron sends 25 a tick; each user is claimed in `announcement_sends` before the message goes out,
  so a retry or two overlapping ticks never send twice; 403 marks the user blocked.
- Live: schema applied (users columns, `announcements`, `announcement_sends`); the two existing users
  marked onboarded and opened (`migrate-onboarding.mjs`) BEFORE the deploy, so no reminder or setup.
- Sent to the owner (TEST bot, labelled, nothing recorded): the welcome in English and Russian with Set
  up, the three setup screenshots, a sample digest for a new reader (15 stories, 3,801 characters), and
  the reminder.
- Tests: Worker 261 (19 new in `test/welcome.test.mjs`), Python 180, click-through 136 of 136 (setup
  flow, Russian and dark, all sizes; announcement tool). Mutations part 4: 20 of 20 caught (the first
  run caught 16; four new tests close the gaps: reminder hours, overlapping announcement ticks, the
  Russian setup texts, the first-open switch).
- Fixed on the way: the Russian "в Украине" check (`` does not work with Cyrillic in JavaScript); the
  emoji tint now retries a grey result (the emoji font not ready yet), which made a Step 13 check flaky.
- CPU (`reports/data/step-15/cpu.txt`): tick with 8 digests 2.6 ms; plus 8 reminders and a batch of 25
  announcements 2.7 ms; /start welcome 0.01 ms; sample digest 0.34 ms; feedback 0.005 ms.
- Screenshots: `reports/data/step-15/screenshots/` (55 files).

## Waiting on the owner (also)
- His look at the simulated welcome, setup screenshots and sample digest.

## Next
Part 5: cleanup (archive one-off scripts, remove the Google News shadow leftovers, delete D1 test data,
docs), then the final report.
