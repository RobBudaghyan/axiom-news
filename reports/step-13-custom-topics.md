# Step 13: custom topics ("My topics") and the AI budget guard

Date: 2026-11-16, fixes after your test 2026-11-17. Still on the TEST bot (@justatia_bot). Cost:
still $0, no card. Commits: `02c3c3b` (the feature); `804b17b`, `94dcada`, `763d739`, `296d7c4`,
`236d057` (the fixes) and the final commit with this report. Worker version `c1f8c148` (deployed
2026-11-16 at about 17:20 UTC with the fixes; the first Step 13 version was `e5af8076`). The live
page serves the new files (same content hash as the repo).

## Headline numbers

**Extra AI use per day, by number of custom topics** (measured with real Google searches and a
real AI test call on this pool; details below):

| Custom topics | New Google headlines a day | New stories a day | Extra AI calls a day | Extra tokens a day | One-time topic checks |
|---|---|---|---|---|---|
| 1 | 192 | 72 | 0 | 39,000 (+2%) | 1 call, 1,200 tokens |
| 5 | 960 | 358 | about 1 | 196,000 (+12%) | 5 calls, 6,100 tokens |
| 20 | 1,824 | 680 | about 1.5 | 373,000 (+22%) | 20 calls, 24,400 tokens |

For scale: today the job makes about 114 AI calls and uses about 1.65 million tokens a day. Extra
calls stay tiny because the extra headlines fit into calls the job makes anyway; tokens grow with
the headlines. The cap of 8 new headlines a topic per search is what keeps this down (with 15 it was
about twice as much).

**Colombia:** not added live yet. You added Japan, then Georgia (removed again) and Australia; the
test message of 2026-11-17 asks you to add Colombia. Replayed on a real day of Google results
(2026-11-16): the hourly searches would bring 91 new Colombia headlines a day, pass 1 keeps about
1 in 10 as news, and under the new rule and today's editor prompt 1 to 5 Colombia stories a day
reach a follower (1 in the last run). Live, Japan and Australia get 3 to 6 a day each (see "Fixes
after the owner's test").

**Japan (checked in D1):** saved at 16:32 UTC on 2026-11-16 as topic `c2`, emoji 🇯🇵, boost cap 2,
5 searches (Japan news in English, Japan politics economy in UK English, Япония in Russian, 日本
ニュース in Japanese, Japon actualité in French), checked once by AI ("accepted"). You follow it
(switch on). It was first searched by the 17:07 run; since then every hour: about 8 new headlines a
run (the cap), 104 in the first 13 runs, 25 stories with Japan as the main topic in 13 hours. What
went wrong was only the Mini App: it showed a grey 📌 and an "x", not the topic's emoji and a
switch.

## What users see

- In Settings, right under **Topics**, a card **My topics**, in the Step 12 design (48 px rows,
  12 px corners, no helper texts, no toast on success). Since the fixes:
  - Each custom topic row looks exactly like a main topic row: the topic's own emoji from the AI
    check (🇯🇵, 🇦🇺) in a tinted square, the name in the reader's language (cut with "..." if long)
    and a red switch. The tint is taken from the emoji itself (Japan red, Colombia yellow, a grey
    newspaper for a topic without a coloured emoji). 📌 never shows; a topic with no emoji gets 🗞️.
  - **Switch off:** the topic stays in the list and keeps its slot (it still counts toward the 3),
    but it is not searched for that reader and not in their digests. The last topic switched on
    (main or custom) cannot be switched off ("Keep at least one topic").
  - **Edit** ("Изменить") at the right of the section title: each custom topic gets a red minus
    on the left and its switch hides; tapping the minus removes it at once with a light tap.
    **Done** ("Готово") leaves edit mode. No "x" buttons any more. Edit shows only when there is a
    topic.
  - The last row adds one: a red "+", the text "Add a topic" ("Добавить тему") in red so it reads
    as a button (the whole row opens the field), and a red **Add** once something is typed (Enter
    works too). It disappears at 3 topics and in edit mode.
  - While the AI checks (about 2 to 5 seconds, at worst about 15), a small spinner stands where
    Add was. Then:
    - **added**, or **joined** (someone had made it): the row slides in, its switch turns on as
      it lands, a light tap; no message;
    - **rejected:** a short reason in the reader's language, for example "This does not look like a
      news topic." The text stays so they can fix it;
    - **a main topic** ("Armenia", "Armenian news"): "Armenia is already a main topic. Switch it on
      above.";
    - **AI busy** (the guard): "Try again in a few minutes."
  - At 3 topics the add row disappears. 5 AI checks a reader a day ("Up to 5 new topics a day.
    Try again tomorrow."); you have no limit.
- **Digests:** a custom topic gets its own section like Armenia or Russia: its emoji and name in
  the reader's language in the bordered box. Since the fixes (your decision) a custom topic has its
  own rule: the editor's topic score counts as it is, against the bar of 6, with no boost cap and
  no "topic score above the global score" rule. The length cut and never-twice are the same.
- **Admin** (you only): "Custom topics" (each topic's followers, searches, new headlines today,
  stories and sent stories in 24 h, Delete and Block buttons, the last 10 checks, blocked names)
  and "AI budget, today" (calls and 429 answers per model against the soft limit, and what waits).

Screenshots: `reports/data/step-13/` (all redone after the fixes, headless Edge over the local
preview with demo data):
- `my-topics-{360,390,430}-{en,ru}-{light,dark}.png` and the same with `-edit` (24 in all):
  Japan on, Colombia switched off, one long name;
- `state-{empty,typed,checking,added-sliding,added,switched-off,edit,rejected,main-topic,full,full-dark,edit-dark}.png`;
- `admin-custom-topics.png`.
- Not taken on your phone: the live check on Android is yours (the message of 2026-11-17).

## Risks

1. **Google is already refusing some searches.** Since the second topic (Australia, 10 searches a
   run) Google has answered 429 to about one search in every run from GitHub (every run from 20:07
   UTC on 2026-11-16; 57 of about 60 searches went through on 2026-11-17). One 429 stops the
   searches not yet started in that run, and Admin's errors show it. Both topics still reach their
   cap of 8 new headlines most runs, but with more topics more would be lost. Fewer parallel
   requests (8 today) is the first thing to try. If Google blocks us fully, custom topics get only
   what our own RSS feeds have. The terms-of-use risk ("personal, non-commercial use") is yours.
2. **Headlines only.** Google gives no article text, so the editor's descriptions for these stories
   are short or empty, and the fact guard has little to check against. Links are resolved to the
   outlet for stories that may reach a digest; if that fails, the Google link still works.
3. **The editor decides how much a custom topic gets.** Fixed for niche topics (no cap any more:
   a race result can reach Formula 1 followers with a global score of 1), but the count now depends
   on the editor's topic score alone, and the model is not precise: the first live prompt gave Japan
   12 stories at 6+ in 13 hours, some not about Japan. The tightened prompt halves that on the same
   stories. If it is still too much, the levers are the prompt's examples, a per-digest limit for a
   custom section, or a bar of 7 for custom topics (your call).
4. **Gemini was busy:** about a third of the test checks got "high demand" (503) first; the second
   model or Groq answered. A check can then take up to about 15 seconds. If every provider fails,
   the reader sees "Try again in a few minutes."
5. **Reader text goes to the AI.** The typed topic (never a name or id) is sent to Gemini or Groq.
   The Worker now holds the two AI keys (your choice); each call is logged.
6. **AI knowledge is dated.** The first test rejected "Pope Leo" ("there is no current Pope named
   Leo"). The prompt now says its knowledge may be out of date; the retest accepted Pope Leo and Pope
   Leo XIV and still refused a private name and nonsense.

## Fixes after the owner's test (2026-11-16 and 17)

**What was wrong** (your test on Android): the topics were saved correctly, but the card showed a
grey 📌 instead of the topic's emoji, an "x" instead of a switch, and nothing made it obvious a
topic had been added. Behind it: custom topics followed the main topics' boost rule (a cap of 2 and
"topic score above the global score"), so a niche topic almost never reached a digest.

**What changed:**
1. **The card:** each custom topic row is a main topic row (its emoji on a tint taken from the
   emoji, the name, a red switch). Adding slides the row in and turns its switch on with a light
   tap. iOS edit mode: Edit / Done at the section title, a red minus removes. No "x", no "Joined"
   bubble. Same 48 px rows, 12 px corners and colours as Step 12.
2. **The switch** (`custom_follows.enabled`, `POST /api/topics/switch`): off keeps the topic in the
   list and its slot; it is not searched for that reader (the job counts only followers with the
   switch on) and not in their digests. A topic is deleted after 7 days only when no reader has it
   in their list, on or off.
3. **The digest rule** (your decision; the 6 main topics keep the Step 8 rule): for a custom main
   topic the editor's topic score counts as it is, against the bar of 6: no cap, no "above the
   global score" rule. Worker (`digest.js`, SQL and JS) and job (`translate.py`, SQL and Python)
   agree on the shared fixture.
4. **The editor prompt** (`job/editor.py`, READER_BOOST): the topic score of a reader topic answers
   only "how important is this for someone who chose this topic", with 4 / 6 / 8 examples for a
   sport, a country and a field, and a reader topic is the main topic only when the event is
   mainly about it. Pass 1 now gives a notable item for a reader topic at least 3, so the editor
   sees it (a race result used to be 1-2 and never reached the editor).

**Japan and Colombia under the new rule** (stories a day that reach a follower, topic score 6+ or
a global 7+):

| Run | Prompt | Japan | Colombia | Australia |
|---|---|---|---|---|
| Replay of 2026-11-16 (`replay*.json`) | first version (topic score copied the score) | 1 | 2 | |
| same | "do not copy the score" | 5, then 3 on a second editor run | 5, then 3 | |
| same | today's (mainly-about rule, routine at 4-5) | 3 | 1 | |
| Live, 13 h from 17:07 UTC (`rescore-live.json`) | "do not copy the score" (what ran live) | 12 in 13 h | | 6 in 13 h |
| same live stories, re-scored | today's | 6 in 13 h | | 4 in 13 h |

The live 13 hours include each topic's first search (a 12-hour window), so the steady rate is
lower: about 3 to 6 a day for an active country. Under the old rule (cap 2, "above the score") the
first replay gave 0 for both. Examples that pass today: "Japan economy shrinks in third quarter",
"Bank of Japan board member urges raising interest rates", "Japan lodges diplomatic protest after
two Russian aircraft violate airspace", "Colombia rules out extending VAT to basic goods", "Reserve
Bank of Australia cites upside inflation risks". Examples kept out: friendly matches, a princess's
visit, a racehorse, product launches, "Canadian PM arrives in China" (not about Japan).
Pass 1 keeps about 1 Google headline in 10 as news for a country topic (252 of a day's headlines
gave 13 to 28 stories); the rest is sport, lifestyle and TV listings.

## Details

### How it works

- **The check (Worker, `worker/src/custom.js`):** before any AI call: the input (2 to 40
  characters, with a letter), the limit of 3, 5 AI checks a day (owner exempt), the block list, an
  exact match with an existing topic's name or alias in any language (joined with no AI call), a
  main topic's label (refused), and the AI guard. Then one call (Gemini, its second model, Groq):
  verdict and reason code, a short reason in the reader's language, `same_as` (an existing topic
  or a main topic), the name in en/ru/hy/fr, an emoji, a one-sentence definition, 2-5 Google News
  searches with an edition from an allowlist of 16, and a boost cap 0-2. Code checks everything
  (no dashes, caps clamped, editions allowlisted, at least two searches). Every call is logged in
  `ai_calls` (kind `topic_check`, with the HTTP code) and every request in `topic_checks`.
- **Shared topics:** one row per subject (`custom_topics`, tag `c<id>`, ids never reused); a
  synonym joins through the AI's `same_as` or a matching name, and the typed text becomes an alias
  so the next person typing it joins with no AI call.
- **Hourly job (`job/custom.py`):** only topics with an active, unpaused follower are searched and
  shown to the AI. The topic searched longest ago goes first; at most 40 Google requests a run;
  the window is the time since its last search (2-12 hours). Each headline is compared, without
  AI, with the pool's titles of the last 24 hours (Step 6, similarity 0.5); at most 8 new ones a
  topic. They enter pass 1 as normal items (tier 4, marked "[headline only]"). Pass 1 and the
  editor have a READER TOPICS list that says items about them are news even if sport or business;
  the editor may make a custom topic the main topic and give a topic score. After the editor,
  Google links of stories that could reach a digest are resolved (10 a run). A topic with no
  follower for 7 days is deleted with its searches. Any failure in these parts is logged (Admin,
  errors) and the run carries on.
- **AI budget guard (`job/guard.py`, `worker/src/guard.js`, `config/ai_budget.json`):** calls and
  429s per model since midnight Pacific time (when Gemini's free day resets).
  - Level 1 (a Gemini 429 in the last hour, or 80% of a soft limit of 250 calls a model): new topic
    checks wait.
  - Level 2 (every Gemini model refusing in the last hour, or the soft limit reached): translations
    wait too (stories are held, Step 10 rule).
  - Never: pass 1 and the editor.
  - Admin shows it; you get one Telegram alert a Pacific day when it is above level 0.

### Measurements

**AI check of 24 names** (real Gemini, `reports/data/step-13/checks.json`): 20 realistic topics,
nonsense, a private name, "Armenian news" (recognised as the main topic Armenia) and "Colombian
news" (recognised as the same as Colombia). Average 954 tokens in and 268 out (1,222 a check);
2 to 5 seconds, 14 at worst when Gemini was busy (35 calls for 24 checks because of 503s).
Examples: Colombia 🇨🇴, searches "Colombia" (Colombian edition) and "Colombia news" (English), cap 2;
Formula 1 🏎️, 5 searches, cap 1; Japan 🇯🇵 with a Japanese search. "Pope Leo" was wrongly rejected;
fixed in the prompt, see risk 6 (`checks-retest.json`).

**Google searches** (real, the way the job runs them in a steady state, `cost.json`):

| Topics | Searches | How often each topic | Results | Same as the pool | Over the cap | New headlines a run |
|---|---|---|---|---|---|---|
| 1 (Colombia) | 2 | every hour, last 2 h | 120 | 1 | 111 | 8 |
| 5 | 17 | every hour, last 2 h | 513 | 32 | 408 | 40 |
| 19 | 68 | every 2 hours, last 3 h | 2,257 | 270 | 1,632 | 76 |

(The 20-topic set has 19: the first check refused Pope Leo.) A busy topic has over 100 results in
2 hours, so the cap of 8 decides the cost.

**One sandbox pass-1 call** on the 5-topic set's 75 headlines (real Gemini, nothing written):
38 tokens in and 39 out per headline; 28 stories, 26 of them on the custom topics, 28 headlines
judged not news; first-pass scores 2 to 6 (most 4-5).

**How the per-day table is made:** headlines a day times those tokens (pass 1); the new stories
that reach the editor's floor times 269 tokens a candidate (this pool's average); stories that may
pass a bar times 179 tokens a story (translation, per reader language; an upper bound). Extra calls:
for each of the last 48 real runs, whether the extra tokens push pass 1 over its 25k-token call or
the editor over 90 new candidates (a second call).

**Worker CPU** (this PC, `cpu.txt`; limit 10 ms):

| What | Before | With custom topics |
|---|---|---|
| One digest (40 candidates, Russian) | 0.16 ms | 0.18 ms (3 custom sections) |
| A cron tick with 8 due readers | 1.36 ms | 1.56 ms (3 custom topics each) |
| Add a topic (60 topics exist; the AI wait is not CPU) | | 1.67 ms |
| Join an existing topic (no AI call) | | 0.30 ms |
| Admin, 60 custom topics | | 0.07 ms |
| AI guard alert check (hourly) | | 0.002 ms |

**Worker CPU after the fixes** (this PC, `cpu-fixes.txt`; the whole request with the initData
check, the database a stand-in): `/api/open` with 3 custom topics (one off) 0.14 ms, the switch
0.07 to 0.09 ms, remove 0.05 ms, a settings save 0.08 ms; a digest with 2 custom sections under the
new rule 0.18 ms (0.16 ms with none); a cron tick with 8 due readers 1.62 ms. All far under 10 ms.
Live: no Worker errors logged since the fixes were deployed.

**D1:** one new column (`custom_follows.enabled`, applied with `scripts/apply_schema.py`, additive).
Live, the 13 hourly runs with Japan and Australia wrote on average 1,142 rows and read 68,800 (the
12 runs before: 1,779 and 71,400; the pool's own volume moves more than custom topics do). A run
takes about 194 seconds (180 before), the searches included.

### Tests

- **Python: 146 pass** (119 before; 27 new in `tests/test_custom.py`).
- **Worker: 211 pass** (185 before; 26 new in `worker/test/custom.test.mjs`, one changed in
  `api.test.mjs` for the two new limits). A stand-in for Gemini (`worker/test/fake-ai.mjs`) answers
  in tests and in the local preview, so they never call the real AI.
- **Mini App click-through: 77 of 77** (47 before): the card under Topics, Add hidden until
  something is typed, the spinner while checking, added, joined, rejected, main topic, the 5-a-day
  limit, the AI guard's "try again", remove, the limit of 3, all main topics off with a custom one
  on; and the layout rules with My topics at 360, 390 and 430 px, English and Russian, light and
  dark.
- The job/Worker twins: `tests/fixtures/guard_cases.json` (300 guard cases and 304 Pacific days,
  checked by both suites; the Pacific day also against the time-zone database on 3,000 times).

**After the fixes:** Python 149 (+4 net: the switch and search, the 7-day rule with switched-off
followers, two for the custom digest rule; the old cap test replaced), Worker 219 (+8: the emoji,
the switch saved and its slot, off means not in digests, the last topic on, edit-mode delete and
the 7-day clock, the custom rule in JS and in SQL on the shared fixture), click-through 94 (+17).
The shared rule fixture `tests/fixtures/eligible_cases.json` has 100 new custom-topic cases,
checked by both suites. **New rules broken on purpose: 25 of 26 caught** (`mutations-fixes.txt`);
the one not caught is the cron's own "switch on" filter, a second guard behind
`withCustomTopics`: breaking it alone changes nothing a reader sees, breaking both is caught.

**Rules broken on purpose (first version): 42 of 42 caught** (`mutations.txt`):

| Broken on purpose | Tests that failed |
|---|---|
| max 3 topics a reader; rejected topic not created; synonym join; exact-name join; main topic refused; input checked before AI; 5 checks a day; block list | 1-3 each (Worker) |
| guard delays topic checks; every AI call logged; orphan clock; custom caps in digests; names in the reader's language; custom section most specific; cron adds custom topics; one alert a day; guard ratio; Pacific day rule | 1-5 each (Worker) |
| only followed active topics searched; request cap; rotation; Google refusal stops the rest; item cap; dedupe; tier 4; "[headline only]"; custom topics in the pass-1 and editor prompts; custom tags accepted; editor floor; custom caps in translation; link fallback; only digest stories resolved; 7-day cleanup | 1-3 each (Python) |
| guard level 2 skips translation; guard twin; a custom failure never fails the run | 1-2 each (Python) |
| Mini App: Add hidden while empty; 44 px x; no message on add; the spinner; "..." on long names | 2-21 each (click-through) |

### Live check

- Your first test (2026-11-16, 16:32 to 19:04 UTC): Georgia and Japan added (both accepted, the
  right flags in D1), Georgia removed, Georgia joined again and removed, Australia added (🇦🇺, 5
  searches). The old card showed 📌 and "x" for all of them: that was the bug.
- After the fixes: the live page serves the new design; `/api/topics/switch` answers 401 without
  Telegram's data. The message of 2026-11-17 asks you to check the flags and switches, add
  Colombia, switch Japan off and on, remove and re-add a topic with Edit, and try asdfgh.
- **Preview digest** (sent 2026-11-17 at about 06:15 UTC after the 06:07 run, labelled "PREVIEW",
  nothing recorded; `digest-cli.mjs --preview --since-hours 9`, a new option that shows a 9-hour
  window like your 21:00 to 06:00 gap): 16 stories, 1 cut for length, 3,874 of 3,900 characters.
  Sections: Japan 5, Iran War 3, Australia 4, Armenia 4. Colombia is not in it because you have
  not added it yet. Honest note: most of that window was scored before the tighter prompt went
  live at 06:07, so it still shows the noise the fix targets ("Melbourne skyscraper retrofitted
  with solar panels", a backpacker visa cap, "China and Canada slash tariffs" under Japan).
- **The first run with today's prompt (06:07):** routine items now get 4 to 5 (a red crab
  migration, the share market close, an inquest), Japan's security overhaul 5. One miss: "China
  and Canada slash tariffs" still went to Japan at 6/6 (the model ignored the mainly-about rule
  there). Also seen in the preview: "Trump to meet Xi and Putin" sits under Japan, because its main
  topic is Politics, which you do not follow, so it falls into your most specific followed tag.

### Deploy

- D1: 5 new tables, 4 new columns, 1 index (`scripts/apply_schema.py`, additive).
- Worker secrets: `GEMINI_API_KEY` and `GROQ_API_KEY` added (`scripts/set_secrets.py worker`,
  values never printed); model names in `wrangler.toml`.
- Worker deployed; the live API check passed 9 of 9 (it saved this PC's zone over yours again;
  put back to Asia/Dubai at once, both GMT+4).
- `setup-bot.mjs`: no change needed (no bot text mentions topics beyond "Choose your topics").
- Secrets scan: nothing found.

### Files

- **New:** `job/custom.py`, `job/guard.py`, `worker/src/custom.js`, `worker/src/guard.js`,
  `config/custom_topics.json`, `config/ai_budget.json`, `tests/test_custom.py`,
  `tests/fixtures/guard_cases.json`, `worker/test/custom.test.mjs`, `worker/test/fake-ai.mjs`,
  `scripts/custom_topics_measure.py`, `scripts/make_guard_cases.py`,
  `worker/scripts/step13-{checks,cpu,screenshots,message}.mjs`, `reports/data/step-13/`.
- **Changed:** `db/schema.sql`, `scripts/apply_schema.py`, `job/{run,ai,editor}.py`,
  `prompts/{story_batch,editor}.md`, `worker/src/{api,cron,digest,settings,index}.js`,
  `worker/public/app/{app.js,app.css,i18n.js,index.html}`, `config/i18n/*.json`,
  `worker/scripts/{ui-check,dev-server,digest-cli}.mjs`, `worker/wrangler.toml`,
  `scripts/set_secrets.py`, `docs/ARCHITECTURE.md` (new section 4c), `README.md`, `PROJECT_NOTES.md`.
- **The fixes:** new `scripts/step13_replay.py`, `scripts/step13_rescore_live.py`,
  `worker/scripts/step13-fixes-cpu.mjs`, `reports/data/step-13/{replay,replay-full-run,replay-editor-rerun-sharpened,rescore-live}.json`,
  `cpu-fixes.txt`, `mutations-fixes.txt`; changed `db/schema.sql`, `scripts/apply_schema.py`,
  `scripts/make_eligible_cases.py`, `tests/fixtures/eligible_cases.json`, `job/{ai,custom,editor,run,translate}.py`,
  `prompts/editor.md`, `worker/src/{api,cron,custom,digest}.js`, `worker/public/app/{app.js,app.css,i18n.js,index.html}`,
  `config/i18n/*.json`, `worker/scripts/{ui-check,step13-screenshots,step13-message,step13-cpu,digest-cli}.mjs`,
  `worker/test/{custom.test.mjs,fake-ai.mjs}`, `tests/test_custom.py`.
