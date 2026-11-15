# Step 08: The dynamic digest

Date: 2026-11-15. Still on the TEST bot (@justatia_bot). Deployed (Worker version `577fe240`),
pushed (commits `db0bae1`, `c172140`, `fbc0964` and the docs commit).

## Headline numbers

**Digest sizes, before (Step 5 rules) and after (Step 8 rules, bars 7/6).** Replay of the last
48 hours on real stories (`node scripts/digest-cli.mjs --windows --profile all --hours 48`), each
story placed in the window where it first appeared, never twice.

| Profile | Digests in 48 h | Stories per digest, before | After | Armenia stories in 48 h, before | After |
|---|---|---|---|---|---|
| You (Wars & Conflicts, Armenia, Iran war; 06, 09, 12, 17, 20) | 11 | 2.3 (max 4) | **5.0** (max 12) | 5 | **33** |
| "Dad": all six topics, 09:00, 14:00, 20:00 | 7 | 5.7 (max 8) | **12.1** (max 16) | 4 | **29** |
| Armenia only, every 3 hours (09-21) | 11 | 0.4 (max 1) | **3.0** (max 7) | 4 | **33** |
| All topics, every 6 hours (06, 12, 18) | 7 | 5.0 (max 10) | **9.3** (max 15) | 3 | **21** |

- **Armenia stories per day:** about 2 before, about **15-16** now for someone who follows Armenia
  (court cases, judges, PACE statements, election commission decisions, mining damage, Russia
  visits). Big Armenia stories (CSTO, Turkey) still come for everyone.
- **Every digest is one message**, at most **3,900 characters**. Your phone folded none of the 5
  test messages, so this is just under Telegram's hard limit of 4,096.
- **Your first real digest with the new rules** went out at 17:00 your time: 6 stories in one
  message, 5 of them medium Armenia news.
- **Extra AI cost (all free):**
  - Normal hours: still **one editor call per hour**. A second call only comes on a backlog
    (more than 90 new stories). The editor prompt is about 1,000 tokens longer (the topic score
    examples). Expected: about +10% editor tokens, about +3% of all AI tokens. The first real
    hour (a catch-up) used 2 editor calls, 31.2k in / 14.4k out, and left **no story unscored**.
  - One-off today: 26 rescore calls (topic scores for 48 hours of stories, done twice; 439k input
    and 213k output tokens) and 4 sandbox calls (67k / 28k).
- **Worker CPU:** building one digest from a full 60-story pool takes about 0.4 ms on this PC. On
  Cloudflare, your real 17:00 digest tick took **9 ms** (the first tick after the deploy, a cold
  start; idle ticks 2 ms). 8 users at once could not be measured (you are the only user).

## What I chose

| Setting | Value | Why |
|---|---|---|
| Editorial bar (everyone) | **7** | unchanged; about 5-10 stories a day reach it |
| Topic bar (followers of the story's main topic) | **6** | lets the day's medium Armenia news through: 3 per digest for an Armenia-only reader instead of 0.9 with a bar of 7 |
| Topic path needs a real boost | **on** | see "One change to your rule" below |
| Boost caps per topic | Politics 0, Wars & Conflicts 0, Iran war +1, Ukraine war +1, Armenia +2, Russia +2 | the AI still raises statements and routine war news; the caps hold it in code |
| Length limit (one message) | **3,900** characters | no fold on your Android phone up to 3,993; the hard limit is 4,096 |
| 40% topic cap | **removed** | see below |
| Candidates per editor call | **90** (was 45) | one call covered 89 of 90; the second call is the safety net |

### One change to your rule (please confirm)
You asked: "in if global score >= editorial bar OR (main topic followed AND topic score >= topic
bar)". With a topic bar of 6, that also lets in **every** story with a global score of 6 for
anyone who follows its topic (about 56 a day). Someone who follows all topics, like dad, then
got a full digest every time (13.7 stories on average, 97 more cut in 48 hours) and fewer
Armenia stories (19), because Armenia had to compete with every other topic's 6s.

So the topic path now needs the topic score to be **above** the global score: the story must
matter more to followers than to everyone. Armenia's medium news (global 4-5, topic 6-7) still
gets in; a routine global-6 politics story does not. It is one setting
(`topic_needs_boost` in `config/digest.json`); switching it off gives your rule word for word.

### The 40% topic cap
It was there to stop one topic filling a fixed 7-12 slots. With no fixed size it does harm: for
an Armenia-only reader every story is Armenia, so the cap (at least 2, recalculated for the
size) would hold their digest at 2 stories. The real limit is now the message length. What the
cap was for survives in the length cut: when two stories are equally important, the one from the
topic with the most stories is cut first, and each followed topic keeps its best story. The
boost caps also keep the two wars from taking over through topic scores.

## Risks
- **Dad-style digests are long.** A reader of all six topics gets about 12 stories (up to 16, at
  the 3,900 limit) on busy days, with some cut. If that feels too much, raise the topic bar to 7
  (dad 6.7 per digest, but only 10 Armenia stories in 48 hours instead of 29).
- **The AI's topic judgement.** It still gives a point to some ceremonies and statements on
  Armenia (today's 17:00 digest had "Days of Armenian Culture in Russia conclude with a gala
  concert" and "Sharmazanov says silence on Karabakh undermines UN system"). The caps limit the
  damage to +2. Watch the first days; the examples in `prompts/editor.md` are easy to adjust.
- **Fold checked on Android only.** iPhone and Telegram Desktop were not tested. Telegram's own
  June 2026 blog says only the new bot "rich messages" fold (after about 8,000 characters); ours
  are plain messages capped at 4,096, so a fold is unlikely, but not proven on iPhone.
- **Worker CPU is close to the limit on a cold start** (9 ms of 10 for one user, measured once).
  See the CPU section; the safety lever is fewer users per tick (one number in the config).
- **The replay is optimistic about timing.** It uses today's scores; in real life a story scored
  an hour late reaches the *next* digest (new in Step 8; before it was lost for good).
- **Stories cut for length do not come back** in a later digest. They are the least important of
  that window.
- **The fact guard dropped 5 descriptions in the first run** for capitalised ordinary words at
  the start of a sentence ("Severe", "Recent", "Republican"). Those stories show the headline
  only. An old weakness of the guard, not new in this step; worth a small fix later.
- **The editor's main topic differs from the stored one** for about 1 in 8 stories in the rescore;
  then the topic score was judged for another topic. Small effect, but it exists.

## Details

### 1. Editor coverage (the most important part)
**What I measured first (last 24 h, 2026-11-15 12:08 UTC, read-only).**
- 617 stories with a first-pass score of 4+: the editor had scored **596 (97%)**. The Step 7
  "12 of 21 unscored" was a backlog that cleared later.
- But 13 of 24 runs were full (60 candidates) and **58 stories waited 3 hours or more** for a score.
- Worse, a story scored after a digest went out was **lost for good**: digests looked only at
  stories *updated* since the last digest, and scoring did not count as an update.
- Stories with a first-pass score of 2-3 were never shown to the editor: 132 a day, 19 of them
  Armenia (mostly football and ceremonies, a few real local news such as a party switch in the
  Amasia race).

**Options, with measured costs** (editor call before: 24 a day, 9.9k input / 4.4k output tokens
for about 50 stories):

| Option | Extra calls | Extra tokens | Covers every candidate? |
|---|---|---|---|
| A. One bigger call (90 new + 15 to compare) | 0 | about 0 (same per story); 19.2k in / 8.4k out measured | yes: 89 of 90 covered in the sandbox |
| B. A second small call in the same run while unscored stories remain | about 10 a day on busy days | about +55k input a day (the fixed part repeated) | yes, up to 180 per run |
| C. A topic score in the first pass, checked by the editor | 0 | about +5k output a day | no: first-pass scores are inflated, and the editor would have to see them (it copies them, lesson 27) |

**Chosen: A, with B as the safety net.** 90 new stories per call (one call covers a normal or a
busy hour), and a second call only if stories are still unscored (more than 90, or ids the answer
left out). No second call after a fall back to Groq (its per-minute limit). Plus:
- Armenia stories are candidates from a first-pass score of 3 (about 18 more a day).
- New column `scored_at`: a story scored after a digest went out now reaches the next digest.
- The editor still never sees first-pass scores.

### 2. The topic score and its calibration
- The editor now gives each story a `topic_score` next to its global score: the score plus a
  boost for followers of its main topic. The prompt has examples for each topic. Each example
  gives a score and a topic score, e.g. "Supreme Judicial Council suspends the powers of two
  judges": 4, then 6.
- **First attempt, too generous:** 148 stories a day reached topic 6+, including 43 Ukraine war
  and 26 Iran war, because the AI added a point to routine war news.
- **Second attempt:** a boost of 0 for most things and for the broad topics, at most +1 for the
  wars, +1/+2 for real Armenia and Russia news, and the old topic score hidden while rescoring
  (the AI had copied it). On a 90-story sample, the war-topic boosts fell from 28 points to 5
  while Armenia's stayed. Even so the AI still raised some statements, so the caps are also
  enforced in code.
- **Rescored for real** (topic scores only; global scores, headlines and merges untouched): all
  1,107 stories of the last 48 hours, 13 calls each time (two rounds: before and after the
  calibration fix).

### 3. Bars (replay, 48 hours, length limit 3,900)
Stories per digest (average, max), stories cut for length, Armenia stories in 48 hours:

| Profile | 7/5 | **7/6** | 7/7 | 7/6 without the boost rule |
|---|---|---|---|---|
| You | 5.4 (13), 0 cut, 34 | **5.0 (12), 0 cut, 33** | 2.5 (9), 0 cut, 10 | 8.2 (16), 4 cut, 33 |
| Dad (all topics, 3x a day) | 13.9 (16), 34 cut, 30 | **12.1 (16), 18 cut, 29** | 6.7 (14), 0 cut, 10 | 13.7 (16), 97 cut, 19 |
| Armenia only, every 3 h | 3.2 (8), 0 cut, 35 | **3.0 (7), 0 cut, 33** | 0.9 (3), 0 cut, 10 | 3.0 (7), 0 cut, 33 |
| All topics, every 6 h | 10.7 (16), 54 cut, 21 | **9.3 (15), 37 cut, 21** | 5.6 (15), 8 cut, 10 | 11.6 (16), 111 cut, 17 |

The full lists (every digest, every Armenia story) are in `reports/data/step-08-after.txt`;
the "before" replay is in `reports/data/step-08-before.txt`.

**Armenia stories dad would have got in the last 48 hours (7/6), a sample:** CSTO strips Armenia of
voting rights; Armenia and Turkey close to diplomatic relations; Supreme Judicial Council suspends
two judges; prosecutors start proceedings against two judges; PACE group concerned over political
persecutions; European leaders back Armenia's sovereignty in Dublin; illegal mining in Aragatsotn
causes 500 million drams of damage; court awards judge David Grigoryan compensation; the new
constitution drops the Security Council Secretary post; the 24-hour biometric passport service;
Pashinyan's three visits to Russia in December. Weak ones that also got in: a chess win over
Carlsen, a gala concert in Moscow.

### 4. Telegram fold limit
- **Research:** Telegram's June 2026 update ("Smartwatch Apps, Rich Text for Bots...") lets bots
  send rich messages of up to 32,768 characters "with a merciful Show More button after the first
  8,000 or so" (Bot API 10.1, `sendRichMessage`). Our digests are plain `sendMessage` text, which
  is still capped at 4,096 characters. I found nothing saying iOS, Android or Desktop fold plain
  messages under that.
- **Test on your phone:** 5 labelled messages in the real format from the TEST bot, at 1,400,
  2,412, 3,111, 3,750 and 3,993 characters (the labels read about 6 characters high). You saw no
  "Show more" on any of them (Android).
- **Limit: 3,900 characters**, under the hard 4,096 and the largest tested size. The cut keeps
  each followed topic's best story while it can, then cuts the lowest scores first.

### 5. Admin tab
The Users list now shows, per user, "avg N stories (M digests, 24 h)", worked out from the `sent`
table: all stories of one digest share its send time. Quiet notes are not counted (they send no
stories). No new table.

### 6. Message format
Unchanged: greeting, topic headings, numbering across topics, outlet link, the quiet-period note,
digest times, never the same story twice. Only the split into two messages is gone.

### 7. Worker CPU (10 ms limit, 8 users per tick)
- On this PC: 800 digests from full 60-story pools (the four profiles in turn) took 328 ms, so
  **0.41 ms per digest**; 8 users is about 3.3 ms of digest work per tick.
- On Cloudflare (`wrangler tail`): your real 17:00 digest tick, the first after the deploy: **9 ms**
  (1 user, 6 stories). Step 5 measured 11 ms for its first real digest tick, also a cold start.
  Idle ticks on the new version: 2 ms; the hourly trigger tick: 3 ms. So one digest on a cold
  Worker costs about 6-7 ms, most of it start-up (loading the code and the time zone data), as
  in Step 3 (1 user: 6 ms) and Step 5 (11 ms on its first tick). The new pick and cut cost about
  the same as the old pick and split. **Not measured with 8 users at once** (there is only one
  user). Estimate: start-up plus 8 x 0.4-1 ms, about 9-14 ms on a cold tick, so near the limit
  as before. If Cloudflare shows `exceededCpu`, lower `max_users_per_tick` to 4 (the last users
  then get their digest 5 minutes later).

### 8. AI use before and after
| | 24 h before (to 12:00 UTC) | After |
|---|---|---|
| First pass | 63 calls, 750k in / 196k out | unchanged |
| Editor | 24 calls, 238k in / 105k out (9.9k / 4.4k per call, at most 60 stories) | first real run (13:07): 2 calls, 31.2k in / 14.4k out (144 candidates; the second call was a
one-off catch-up of older Armenia stories with first-pass score 3). After it, **0 stories of
the last 24 h were unscored** (before: up to 21, and 58 waited 3+ h). A normal hour: 1 call,
about 12-20k in / 5-9k out |
| One-off | | rescore 26 calls (439k / 213k), sandbox 4 calls (67k / 28k) |

### Tests
- **Python: 86 tests OK** (79 before). New: topic score clamped and never below the score; a
  missing one keeps the old one; `scored_at` set once; a second call only while unscored stories
  remain, never more than two, none after Groq; Armenia from first-pass 3; the topic-only rescore
  writes only topic scores; the sandbox writes nothing.
- **Worker: 115 tests pass** (112 before; the old split, cap and 12-maximum tests were replaced).
  New: the two-score rule; the boost caps; **the SQL and the code agree** on who qualifies (300
  random stories, 4 readers, 4 settings); unedited stories only through the editorial bar; **the
  length cut never goes over the limit on 300 random pools**; each topic's best story is kept; ties
  go from the most crowded topic; never twice (also after a re-score); the late-score window; the
  quiet note; the Admin digest size (with a merged story counted once).
- **Mutation checks** (each rule broken once on purpose, tests run, then restored):

| Broken on purpose | Tests that failed |
|---|---|
| topic path without "main topic followed" | 2 |
| editorial bar ignored | 16 |
| topic bar ignored | 4 |
| boost caps removed | 2 |
| boost rule removed (code / SQL) | 2 / 14 |
| unedited stories get a topic path | 2 |
| length cut removed | 6 |
| length estimate too low | 3 |
| each topic's best story not protected | 1 |
| tie rule (crowded topic first) removed | 1 |
| never twice: sent filter removed | 4 |
| late-score window removed | 1 |
| quiet note removed | 3 |
| Admin counts merged-away stories | 1 |
| editor: topic score allowed below the score | 1 (0 at first: the database write clamps it a second time; I added a direct test) |
| editor: no second call on a backlog | 1 |
| editor: second call after Groq | 2 |
| editor: `scored_at` overwritten | 1 |
| editor: Armenia floor removed | 1 |
| editor: rescore also writes global scores | 1 |

### Files
- **New:** `worker/scripts/fold-test.mjs`, `worker/scripts/step8-numbers.mjs` (the numbers message), `reports/data/step-08-before.txt`,
  `reports/data/step-08-after.txt`, this report.
- **Changed:** `job/editor.py`, `job/config.py`, `prompts/editor.md`, `db/schema.sql`,
  `scripts/apply_schema.py` (columns `topic_score`, `scored_at`, added to the live database first),
  `config/digest.json`, `worker/src/digest.js`, `cron.js`, `api.js`, `admin.js`,
  `worker/public/app/` (Admin line, new hashes), `worker/scripts/digest-cli.mjs` (profiles,
  `--hours`, several `--bars`, `--limit`), tests, `docs/ARCHITECTURE.md`, `PROJECT_NOTES.md`,
  `README.md`.

## What you need to do
1. **Read the preview digest** I sent ("Preview of the new dynamic digest": the last 24 hours as
   if nothing had been sent, 14 stories, 3,853 characters, 35 more cut for length) and the short
   message with the numbers after it. Does the amount of Armenia news feel right? Is anything noise?
2. **Confirm the one change to your rule** (the topic path needs a real boost), or tell me to
   switch it off.
3. If anyone with an **iPhone** can look at the 5 fold test messages, tell me whether any shows
   "Show more".
