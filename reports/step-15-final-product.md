# Step 15: the final product

Date: 2026-11-17. Still on the TEST bot (@justatia_bot). Cost: still $0, no card. No extra AI calls
beyond the normal hourly runs (every local test used a stand-in AI). The next run refreshes the
keywords of your three topics: one call each.
Commits: `7a21f46` (part 1), `6288d97` (part 2), `681a447` (part 3), `23bb24d` (part 4), `f178e13`
(part 5), plus progress commits. Worker versions: `2f8e7cd1`, `44f7fa84`, then `9ba3f936` (live now).
Progress log: `reports/step-15-progress.md`.

## Your decisions in this step
- Off means off: a story whose main topic you switched off never reaches you, even through another
  topic you have on. Otherwise one topic you have on is enough.
- A story with no topic you have on reaches nobody (this was already so).
- Old-bot readers come in through a script from a list, flagged as imported.

## 1. New main topics and "off means off"

**What users see.** Six main topics: Politics & Conflicts (Политика и конфликты), Economy & Markets
(Экономика и рынки), Armenia, Russia, Iran War (Война в Иране), Ukraine War (Война на Украине).
Armenian and French names are in place too. New readers start with all six on, at 09:00, 14:00 and
20:00. A switched-off topic sends nothing.

**What changed.**
- **The merge.** Politics and Wars & Conflicts became one tag, `politics_conflicts`. Tags are never
  renamed, so this was a migration, not a rename.
- **Economy & Markets.** A new tag, `economy_markets`. Pass 1 no longer calls economy news "not news";
  routine company news and a day's market wrap still are. The editor has examples for it at 8, 7, 6,
  4 and 2.
- **Boost caps** (how far the editor may lift a story for a topic's followers):
  - Politics & Conflicts: 0, as both old topics were. It is a broad topic, so its readers already
    get the world-scale score.
  - Economy & Markets: 1. A big rate decision may go from 5 to 6 for its followers, but routine
    market moves stay where they are.
- **Culture and sport.** The editor prompt now says ceremonies, concerts, festivals, chess and sport
  results stay below 6 on the main topics. Your own topics keep their own rule.
- **Emoji.** I sent you three options per topic. Until you answer, 🏛️ and 📈 are used.
- **Feeds.** I added no new economy feeds. FT, WSJ, Bloomberg, The Economist, CNBC and MarketWatch
  were already in, plus Interfax, Kommersant, RBC and Vedomosti: about 440 items in 48 hours. The gap
  was the prompt, not the feeds, so there are no extra tokens.

**The off rule.** It lives in the Worker's query and in the job's copy of it. A shared test file
with five readers who have topics switched off checks that both give the same result.

**Migration (live, 2026-11-17).**

| Reader | Before | After |
|---|---|---|
| You | all main topics off (only your own topics) | Economy & Markets on (the brief: every user), your own topics unchanged |
| The other reader | Politics, Wars & Conflicts, Armenia, Russia, Iran War, Ukraine War | Politics & Conflicts, Economy & Markets, Armenia, Russia, Iran War, Ukraine War |

Nobody lost a topic: a test covers all 63 combinations of the old topics. 4,716 stories were
re-tagged, and none is left on an old tag.

## 2. Tuning

- **Fact guard.** The editor's description is dropped when it names something the articles do not
  contain. The bug: an ordinary word at the start of a sentence ("Severe", "Recent", "Hundreds",
  "Republican") counted as an unknown name.
  - The errors log had 166 drops in 30 days. 62 of them were only such words; those now pass.
  - The other 104 are still dropped, as they should be: 30 wrong numbers and 74 real names the
    articles did not contain (Moscow, Kyiv, Washington...).
  - How: a list of 7,192 ordinary words built from the pool's own lower-case text, plus party names.
  - Tests use the real examples.
- **Keywords for your own topics.** They are refreshed after 7 days (one AI call a topic, with its
  recent headlines). Admin has a "Keywords" button per topic. A weak answer keeps the old keywords.
  Your three topics get their first refresh on the next run.
- **Replays, last 48 hours.** Real stories, digests at 09:00, 14:00 and 20:00
  (`reports/data/step-15/replay.json` and `replay.txt`):

| Reader | Before (old rule) | After (off means off) | Stories from switched-off topics, after |
|---|---|---|---|
| All six topics | 111 stories, 15.9 a digest | the same | 0 |
| Armenia only | 95, 13.6 a digest | the same | 0 |
| Your settings | 23, 2.1 a digest | the same | 0 |
| Economy off | 111, 15.9 a digest | the same | 0 |

Before and after are the same in these 48 hours:
- Only 11 stories reached a score of 7 or more.
- None of them came in only through a topic the reader had switched off.
- The rule matters when a big war story carries the broad tag and the reader has that war off. The
  shared test file covers that case (2 to 13 stories removed per test reader).
- Economy stories began with the first run on the new prompts: 15 in that run, 1 of them in an
  all-topics digest.

**Preview.** You got a labelled preview digest with all six topics on: 15 stories, with Politics &
Conflicts and Economy & Markets sections, 3,882 of 3,900 characters.

## 3. Help and Send feedback

**What users see.** At the bottom of Settings, between Support and the time zone line, there are two
48 px rows: Help (a blue square) and Send feedback (a green square).
- **Help** opens its own page with Telegram's back arrow. It has eight short sections: what Axiom is,
  how stories are chosen, topics and My topics, digest times, language, pause, Support Axiom, and
  privacy.
- **The privacy section says:** we store your Telegram id, first name and settings; a topic you add
  is sent to an AI to check it; nothing is sold or shared.
- **Send feedback** is a text field and a full-width Send button. It takes up to 1,000 characters
  and 10 messages a day. Success is a tap and "Thank you!".
- Each message is stored and forwarded to you with the reader's first name and id. Admin shows the
  latest 20.
- /help now points to Settings.
- You already tried it: one message of yours is in the table, and it was forwarded.

Screenshots: `reports/data/step-15/screenshots/settings-bottom-*.png`, `help-*.png`,
`help-end-*.png`, `feedback-*.png` (English and Russian, light and dark).

## 4. Welcome flow and the announcement tool

**What a new reader sees.**
1. **/start:** "Welcome to Axiom News, Nora! I send a short digest of the most important news a few
   times a day. Tap Set up to choose your topics and times. It takes a minute." It comes in their
   Telegram language, with a "Set up" button.
2. **First open of the app:** "Your topics" (1 of 3), then "Digest times" (2 of 3), then "All set"
   (3 of 3), which shows the next digest and one line about the sample. Skip and Back are there.
   Every tap saves at once, and the time zone is saved as before.
3. **Done or Skip:** a sample digest of the last 24 hours, labelled "Sample digest: ...". It follows
   every normal rule, and its stories count as sent, so they never come again.
4. **A reader who never opens the app** gets the defaults (Asia/Yerevan, 09/14/20, all six topics)
   and exactly one gentle reminder the next day, between 10:00 and 20:00 their time.

**Readers imported from the old bot** get none of this: no welcome, setup or reminder. To import
them, give me a list of their ids (names and languages if known) and run
`node worker/scripts/import-users.mjs users.json --dry`, then the same without `--dry`. An id that is
already a user is left as it is. Nothing is sent.

**The announcement tool (Admin, only you).**
1. Write in English and pick "All users" or one language, then tap Translate.
2. One AI call makes a version in every language the audience reads. Each version is checked: no
   dash, the same numbers, the right alphabet, сводка, на Украине. A version that fails is left empty
   with a note, for you to write.
3. Edit any version, then tap Preview: every version comes to your chat.
4. Send unlocks only after a preview of exactly that text.
5. The bot sends 25 messages every 5 minutes. Each reader gets their own language, or English if
   theirs has no version. Each reader is recorded before their message goes out, so a retry never
   sends twice.

**Sent to you on the TEST bot, labelled, nothing recorded:** the welcome in English and Russian with
Set up, the three setup screenshots, a sample digest for a new reader (15 stories, 3,801
characters), and the reminder.

Screenshots: `reports/data/step-15/screenshots/setup-{1,2,3}-{360,390,430}-{en,ru}-{light,dark}.png`
(36 files) and `admin-announce-{new,translated,previewed}.png`.

**Live:** the new columns and tables were added first. Then both existing readers were marked as set
up, before the deploy, so neither gets a setup or a reminder. The live error log is clean since the
deploy.

## 5. Cleanup

- **Archived** (moved, paths fixed, they still run):
  - `scripts/archive/` (7): custom_topics_measure, step13_replay, step13_rescore_live,
    step14_keywords, step14_mutations, step14_replay, step15_mutations.
  - `worker/scripts/archive/` (25): migrate-times, migrate-onboarding, fold-test, step8-numbers,
    step9-previews, the step 10 to 14 scripts, and the step 15 one-offs (cpu, emoji, message,
    replay, screenshots, welcome, cleanup-d1).
  - Kept in place because they are still used: digest-cli, dev-server, ui-check, screenshots,
    api-check, setup-bot, stamp-app, migrate-topics (its test uses it), import-users, and the fixture
    generators.
- **Removed: the Google News shadow leftovers.**
  - Files: `job/shadow.py`, `tests/test_shadow.py` (its 3 parser tests moved to
    `tests/test_gnews.py`), `scripts/gnews_probe.py`, `scripts/shadow_ai_sample.py`,
    `.github/workflows/gnews-probe.yml`, `config/gnews_queries.yaml`.
  - The shadow step in `hourly.yml`, and the shadow-only functions in `job/gnews.py`.
  - `job/gnews.py` itself stays: your own topics use it.
- **Deleted from D1:**
  - The custom topic Japan (no follower left) and its day counts.
  - Three topic-check rows for the Japan and Georgia trials.
  - The tables `shadow_items` (1,494 rows) and `shadow_runs` (3 rows).
  - There were no test tips and no preview rows to delete.
- **Kept in D1:** both readers and their settings; your topics Australia, TRIPP Armenia and Finance
  with their checks; your feedback message; all news data.
- **Docs.** README, docs/ARCHITECTURE.md and PROJECT_NOTES.md are rewritten for a newcomer. The README
  explains how a story reaches a reader. ARCHITECTURE opens with a one-paragraph overview and has a
  new section, §4d.

## Tests

- **Python: 164 pass.** That is 172 at the start, plus 8 new, minus the 19 tests of the shadow file
  that went with the shadow code, plus its 3 parser tests moved to `tests/test_gnews.py`.
- **Worker: 261 pass** (225 at the start). New files: `migrate.test.mjs`, `feedback.test.mjs` and
  `welcome.test.mjs`, plus new cases in the digest, custom-topic and dictionary tests.
- **Mini App click-through: 136 of 136** (94 at the start).
  - It covers Help, Feedback and its limit, the setup in English and Russian, and the announcement
    tool.
  - Every new page is checked at 360, 390 and 430 px, in English and Russian, light and dark.
- **Rules broken on purpose: 52 of 52 caught** (`scripts/archive/step15_mutations.py`):
  - Part 1: 9, Part 2: 13, Part 3: 10, Part 4: 20.
  - The first Part 4 run caught 16. Four new tests closed the gaps: reminder hours, two overlapping
    announcement ticks, the Russian setup texts, and the switch that opens the setup.
- **Fixed on the way:**
  - The Russian "в Украине" check never fired: `\b` does not work with Cyrillic in JavaScript.
  - A Step 13 click-through check was flaky. The emoji tint could stay grey if the emoji font
    loaded late; a grey result is now tried again before it is kept.

## CPU (Worker limit 10 ms)

Measured on this PC, three runs (`reports/data/step-15/cpu.txt`):

| Path | Time |
|---|---|
| One digest, 40 stories | 0.30 to 0.33 ms |
| A cron tick with 8 digests | 2.6 ms |
| The same tick plus 8 reminders and an announcement batch of 25 | 2.7 ms |
| /start welcome | 0.01 ms |
| The sample digest after setup | 0.33 to 0.34 ms |
| Feedback | 0.005 ms |

Step 14's own script gives 2.55 ms today for the 8-digest tick. Its 4.3 to 5.0 ms in Step 14 was a
busier PC.

## Risks

- **Economy & Markets is new.** Its volume is unknown: one run so far, 15 stories, 1 in a digest.
  Watch it for a few days. The levers are the prompt examples and its boost cap of 1.
- **Armenia-only readers get long digests.** In the replay it was 13 to 14 stories a digest. The
  editor gives many Armenia stories a topic score of 6 or more (the Step 8 topic path). This step did
  not change it; a tighter Armenia cap or examples would.
- **Economy was switched on for you,** because the brief says every existing user. You had all main
  topics off. Switch it off in Settings if you do not want it.
- **Announcement translations are AI.** Every version is checked and you preview them all, but only
  English and Russian are in use. Armenian and French would appear only if a reader used them.
- **The welcome flow is tested on the TEST bot with a simulated new reader.** No real new user has
  gone through it yet, so watch the first sample digest and the first reminder live.
- **Importing old readers needs their ids,** and the real bot token. That is the switch step.
