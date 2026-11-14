# Step 05: The editor, new digest rules and format, Mini App polish

Date: 2026-11-14. Still on the TEST bot (@justatia_bot).

## Summary
- **Why:** in the last 24 hours the pool had 27 Armenia stories, including "Armenia and Turkey
  close to opening borders", but you saw none. The first AI pass scores too generously (364 of
  424 politics stories got 4 or more), digests simply took the top 7 by that score, and about 30%
  of duplicates slipped through.
- **New: an "editor" AI step every hour.** After the first pass, one more AI call looks at the
  strongest stories of the last 24 hours side by side, with the titles and snippets of their
  articles. It always includes the best few stories of every topic, so Armenia is never left out.
  It:
  - merges stories about the same event;
  - gives each story a strict score from 1 to 10 ("would a serious newsletter print this?");
  - names the one topic the story is mainly about;
  - writes a short headline, a 1-3 sentence description using only facts from the articles, and
    2-3 emojis (flags of the countries involved plus a subject emoji, e.g. 🇦🇲🇹🇷🤝).

  The code checks what it writes: a description with a number or a name that is not in the
  articles is thrown away. If the editor fails, digests still work from the first pass.
- **New digest rules, no fixed count:** stories that score 7 or more, plus, for every topic you
  follow, its best remaining story if it scores 6 or more. At most 12. No topic may fill more than
  40% of a digest (at least 2). On real data your digests would have had 9, 9 and 5 stories, with
  Armenia in every one.
- **New message format for everyone:** "Good evening, Rob. Since 2 PM, 6 stories for you:",
  topic headings underlined, each story with emojis, a bold headline, a short description and the
  outlet as a link. A digest too long for one Telegram message is split into two at a topic
  heading instead of dropping stories. Format A and the format setting are gone.
- **Mini App:** brand red #b1161c instead of blue; digest times are now a grid of hourly buttons
  (06:00 to 23:00, tap to choose, tap again to remove, 1 to 5); "Stories per digest", "Format" and
  the time zone picker are gone; the time zone is shown read-only and follows your phone. **The
  icons that were not centred are fixed:** they sat 6 px low because two parts of the app shared
  a style name.
- **Cost:** about 48 AI calls a day (24 + 24), all free. The editor call uses about 11k input and
  5k output tokens.
- **One thing went wrong** (details under Problems): the preview digest I sent you greets you as
  "Owner" instead of "Rob". Your name is fixed in the database; your real digests use it.

## What was done
1. **Editor pass in the hourly job** (`job/editor.py`, prompt `prompts/editor.md`):
   - Candidates: the best 3 new stories of each topic first, then the strongest new ones, up to
     45, plus up to 15 already-edited ones to compare against. Each shows its first-pass summary
     and its best 3 articles.
   - The answer is checked: unknown or repeated story numbers are ignored; a "roundup" event of
     more than 6 stories is ignored; an answer covering less than half of the candidates is
     retried, then handed to the next AI model; text is cleaned of em and en dashes.
   - Fact guard on headlines and descriptions (numbers and names must come from the articles; it
     understands acronyms like APEC, first names and words like "Iranian").
   - Merges keep the oldest story. Anyone who already got one of the merged stories will not get
     the kept one either.
   - Same fallback chain as the first pass (Gemini, second Gemini model, Groq with a smaller set).
   - New database columns: on stories `headline`, `description`, `emojis`, `final_score`,
     `main_topic`, `edited_at`, `merged_into`; on job runs `editor_status`, `editor_candidates`,
     `editor_merged`; on AI calls `kind`. They were added to the live database **before** any new
     code ran.
   - A one-off "backfill" ran the editor over the stories already in the pool (`python -m
     job.editor --backfill`), so digests had editor scores from the start.
2. **Digest selection** (`worker/src/digest.js`, settings in `config/digest.json`):
   editorial bar 7, topic bar 6, at most 12, 40% cap (at least 2) recomputed for the real size;
   stories the editor has not scored count as their first-pass score minus 2.
3. **Message format** (same file): greeting with your first name and a 12-hour time, underlined
   topic headings, emojis + headline + description + outlet link, numbering that runs on across
   topics, splitting into two messages at a topic heading. The 5-minute digest cron and the Admin
   "Send me a digest now" button send both parts in order.
4. **Mini App** (`worker/public/app/`): red accent with lighter shades in dark mode (contrast
   checked, see Decisions), hourly time grid with friendly limit messages, read-only time zone,
   removed controls, orange failure badges in Admin (amber for warnings), and an "Editor pass" line
   plus first-pass/editor AI usage in Admin. The server rules match the app: times only on the
   hour 06:00-23:00, 1 to 5, and the removed settings are refused.
5. **Tools:** `digest-cli.mjs --windows` replays your digests of the last 24 hours on real data
   (for tuning); `--preview` sends one labelled preview; `migrate-times.mjs` moves half-hour times
   to the nearest hour.
6. **Docs:** ARCHITECTURE (editor step, digest rules and format, Mini App, database, AI budget,
   risks), PROJECT_NOTES, README, LESSONS 27-32.

## Files created / changed
- **New:** `job/editor.py`, `prompts/editor.md`, `tests/test_editor.py`,
  `worker/scripts/migrate-times.mjs`, `docs/screenshots/times-limit-light.png` and `-dark.png`,
  this report.
- **Changed:**
  - job: `job/run.py` (calls the editor, logs its calls and tokens), `job/config.py` (editor
    settings), `job/dupes.py` (skips merged stories), `tests/helpers.py`;
  - database: `db/schema.sql`, `scripts/apply_schema.py`;
  - Worker: `src/digest.js`, `src/cron.js`, `src/api.js`, `src/settings.js`, `src/admin.js`,
    `src/bot.js`; tests `test/digest.test.mjs`, `test/worker.test.mjs`, `test/api.test.mjs`,
    `test/app.test.mjs`, `test/helpers.mjs`;
  - Mini App: `public/app/app.js`, `app.css`, `index.html` (new hashes);
  - tools: `scripts/digest-cli.mjs`, `api-check.mjs`, `ui-check.mjs`, `screenshots.mjs`,
    `dev-server.mjs`;
  - `config/digest.json`; screenshots; `docs/ARCHITECTURE.md`, `docs/LESSONS.md`,
    `PROJECT_NOTES.md`, `README.md`.
- **Removed:** `docs/screenshots/add-time-*.png` and `timezone-*.png` (those screens no longer
  exist).
- **Not committed:** `.env` (unchanged).

## Tests run and real results

### Unit tests
- **Python:** `venv/Scripts/python -m unittest discover -s tests -t .` gives **54 tests, OK**
  (36 before, 18 new). The editor tests cover:
  - candidates: a small topic (Armenia, the weakest story) is always included; edited stories only
    for comparison; nothing new = no AI call; merged, old and weak stories are not candidates; the
    prompt shows the articles but not the first-pass score;
  - validation: unknown and repeated ids, score clamping, dash cleaning, 3-sentence limit, emojis
    (flags, joined emojis, letters refused, at most 4), the roundup guard;
  - the fact guard drops an invented number and an invented name, and accepts acronyms, first
    names and demonyms;
  - merges: the oldest story is kept, earlier merges are re-pointed, the best link and all topics
    are kept, **`sent` rows are copied (never twice)**; an edited story keeps its text when the
    answer leaves it empty, field by field;
  - main topic: saved and added to the story's topics; an unknown topic is ignored;
  - **a failed editor call:** Gemini overloaded falls back to Groq (with a smaller prompt); when
    every model fails (overload, invalid answers twice, empty answers twice) the stories are left
    untouched; inside a real run the run still ends `ok` with `editor_status = failed`;
  - a first-pass update with a new core fact makes the story editable again.
- **Worker:** `cd worker && node --test test/` gives **112 tests, pass**. New or rewritten:
  - selection: only stories at 7+; each followed topic's best remaining story at 6+ under that
    topic; a topic whose best story is shown elsewhere still gets its own section; unedited
    stories use importance minus 2; at most 12; the cap `max(2, ceil(0.4 x N))` recomputed for the
    real size; the editor's main topic decides the section; near-duplicates once; quiet note;
  - format: the exact message (greeting with name, "Since 2 PM", underlined headings, emojis,
    description, link, HTML escaping), 12-hour times (2 PM, 2:30 PM, 12 PM, 12:05 AM), no name,
    first digest, one story, quiet note;
  - **length:** 12 long stories split into exactly 2 messages at a topic heading, none dropped,
    numbering continues; a single over-long topic splits between stories;
  - cron: a 2-message digest is sent in order; if the second message fails, only the first part's
    stories are recorded, the error is logged and the slot moves on;
  - settings: only hourly times 06:00-23:00, 1 to 5; stories, format and time zone settings are
    refused; old half-hour times round to the nearest hour (08:30 -> 09:00); opening the app always
    takes the phone's zone, also replacing a zone once chosen by hand.
- **Mutation checks** (I broke each rule on purpose, ran the tests, then restored it):

  | Broken on purpose | Tests that failed |
  |---|---|
  | editorial bar ignored | 4 |
  | topic guarantee removed | 4 |
  | topic cap removed | 2 |
  | 12-story maximum removed | 1 |
  | split at a topic heading removed | 2 |
  | second-message failure handling removed | 1 |
  | fact guard on descriptions off | 1 |
  | `sent` rows not copied on a merge | 1 |
  | old emojis wiped by an empty answer | 2 |
  | roundup guard off | 1 |
  | an editor failure allowed to fail the run | 1 |

### The editor on real data
- **Backfill from this PC** (the pool only reached back 19 hours, to 19:17 Yerevan yesterday):
  9 Gemini calls for 377 stories; per call 6.5-12.5k input and 2.5-6.2k output tokens, 10-30 s.
  It merged 28 stories into others, and the fact guard dropped 12 of about 450 texts (the
  headline then falls back to the first-pass summary).
- **First run on GitHub** (08:21 UTC, run 43575473178): status ok in 43 s. The first pass made
  10 new stories from 44 new articles (12.9k tokens in, 1.5k out); the editor saw 60 candidates
  and wrote 60 events (10.1k tokens in, 4.9k out). 2 AI calls; D1 rows read 6,642 (was about
  2,800 before the editor), written 407.
- **The 09:07 run** (the first regular run with the final code, run 43579063189): ok in 54 s,
  115 of 115 feeds, 118 new articles, 27 new stories and 27 merged into existing ones. 3 AI calls:
  the first pass twice (its answer skipped 18 items, which were resent once, as before) and the
  editor once (60 candidates, 10.6k tokens in, 5.9k out). In total 39.8k tokens in and 10.8k out;
  D1 rows read 7,562, written 866. The fact guard dropped 2 descriptions, one of them wrongly
  ("AI-generated" was read as a name); fixed and pushed (commit 41ab672).
- **What the editor changed:** of 712 stories in the last 32 hours, the first pass had given 129
  a 6 or more; the editor (350 stories edited, the rest too weak to be candidates) gave 53 a 6 and
  16 a 7 or more. Armenia's top stories: "Armenia and Turkey are close to
  establishing diplomatic relations, Pashinyan says" (7), "CSTO strips Armenia of voting rights"
  (7), "European leaders reaffirm support for Armenia's sovereignty" (6).
- **How I tuned it** (each change re-run on the whole pool):
  1. The editor first copied the first-pass score it was shown (every 7 stayed 7). I removed that
     number from what it sees.
  2. One answer lumped 44 unrelated stories into "various developments". I added the roundup
     guard and a prompt rule.
  3. With bars 7/6 digests had only 3-4 stories, because one summit story tagged with four topics
     counted as the best story of all four. Each topic now gets its own section.
  4. Headlines were long and in the past tense; the summit sat under "Iran War". The editor now
     writes newspaper-style headlines and names the main topic.

### Your digests on yesterday-style windows (real stories, bars 7/6, all six topics)
`node scripts/digest-cli.mjs --windows`. Stories are placed in the window where they first
appeared, and none twice. The pool started at 19:17 Yerevan yesterday, so the "yesterday 14:00"
window is empty and the 20:00 one holds only the first run's 3-hour backlog.

**20:00 (window 14:00-20:00): 9 stories**
1. 🇷🇺🛡️ Russia revives demands for NATO rollback during peace talks (7, Russia)
2. 🇷🇺🇺🇦💥 Russia strikes targets across Ukraine as Kyiv launches massive drone attack (7)
3. 🇮🇱🇺🇸🤝 Mossad chief visits Washington to discuss Iran regional tensions (7, Iran War)
4. 🇺🇦🇷🇺🛢️ Ukraine strikes major oil refinery in Volgograd region (7)
5. 🇪🇺🤝 European leaders agree to form joint team for Ukraine peace talks (7, Politics)
6. 🇵🇸🏥💥 Israeli strike on Gaza hospital kills six (7, Wars & Conflicts)
7. 🇦🇲🛡️ CSTO strips Armenia of voting rights (7, Armenia)
8. 🇷🇺🚨 Moscow car bomb severely injures former aide to ex-prime minister (7)
9. 🇷🇺🇺🇦🚗💥 Former Ukrainian official wounded in Moscow car bombing (6, Ukraine War's own story)

**09:00 (window 20:00-09:00): 9 stories**
1. 🇺🇸🇷🇺🇨🇳🤝 Trump to hold trilateral meeting with Putin and Xi in China (8, Politics)
2. 🇹🇷🇶🇦🤝 Turkey and Qatar sign mutual defense agreement (7)
3. 🇮🇶🚢💥 Oil tankers strike naval mines in Strait of Hormuz (7, Iran War)
4. 🇺🇸✈️ US grounds all departing flights due to technical disruption (7)
5. 🇺🇸⚖️ US Supreme Court to hear appeal on southern border asylum ban (7)
6. 🇷🇺🇺🇦🇺🇸🕊️ Delegations hold peace talks in Abu Dhabi to discuss ending war (7)
7. 🇷🇺🇺🇦💥 Ukrainian drone strike in Belgorod region kills three (6, Ukraine War)
8. 🇪🇺🇦🇲🗣️ European leaders reaffirm support for Armenia sovereignty in Dublin (6, Armenia)
9. 🇪🇺🇷🇺💰 EU to soon present 22nd sanctions package against Russia (6, Russia)

**14:00 (window 09:00-14:00, as of 12:39, still open): 5 stories so far**
1. 🇦🇲🇹🇷🤝 Armenia and Turkey are close to establishing diplomatic relations, Pashinyan says (7)
2. 🇷🇺✈️ Air defense systems shoot down 79 drones over Kursk Oblast (6)
3. 🇷🇺🇺🇦⚡ Russian forces strike electrical substation in Chernihiv Oblast (6)
4. 🇷🇺🇺🇦⚖️ Moscow court issues arrest warrant for Ukrainian commander (6)
5. 🇪🇺☢️ Eastern Europe accelerates nuclear investment to diversify energy away from Moscow (6)

Other bars on the same data: 6/6 gave 12 (the maximum) in every window, 8/6 gave 3, 7/5 gave
9, 9 and 6. 7/6 is the setting closest to "4-8, Armenia when it matters".

### The Mini App in a headless browser (local preview, invented demo data)
`node scripts/ui-check.mjs`: **all 28 checks pass**, no console errors. Among them:
- the time grid has 18 hourly buttons (06:00-23:00, no half hours) and shows the saved times;
- a tap chooses (red, `rgb(177, 22, 28)`) and saves; a second tap removes; the footnote lists
  the chosen times;
- a 6th time is refused with "Up to 5 times a day. Remove one first."; removing the last one is
  refused with "Keep at least one digest time"; the server refuses 09:30 as well;
- no stories stepper, format choice or time zone picker; the zone row reads "Yerevan time, From
  your phone, GMT+4";
- **every icon in a rounded square is centred to within 0.5 px** (measured: 0.0 px, light and
  dark; before the fix the time zone and pause icons were 6 px low);
- dark mode uses the brighter red fill and light red icons; Admin failure badges are orange;
  Admin shows the editor pass; both Admin buttons and the Cancel path work; a non-owner gets 403.

### Screenshots (`docs/screenshots/`, 390 px wide, invented demo data)
| File | What |
|---|---|
| `settings-light.png`, `settings-dark.png` | the Settings tab, full page |
| `times-limit-light.png`, `times-limit-dark.png` | five times chosen and the message after a sixth tap |
| `admin-light.png`, `admin-dark.png` | the Admin tab, full page |

I looked at each one and fixed what looked unpolished:
- the icons sat low in their squares (the shared style name, see above);
- the limit message wrapped over three lines, so I shortened it;
- the Afternoon and Evening labels were crowded against the buttons above;
- a dark-mode rule made orange failure badges green.

Contrast, computed with the WCAG formula for every pair that matters:

| Pair | Ratio | Needed |
|---|---|---|
| white text on #b1161c (chosen time, button) | 7.0:1 | 4.5 |
| #b1161c text or icon on white | 7.0:1 | 4.5 |
| #b1161c on a dark cell (why dark mode does not use it for text) | 2.4:1 | 4.5 |
| dark mode: white on #d0232a | 5.3:1 | 4.5 |
| dark mode: #d0232a switch or chip against the cell | 3.2:1 (3.0 on Android's #212121) | 3 |
| dark mode: #ff6b6b text and icons on the cell | 6.1:1 | 4.5 |
| orange failure badge text, light / dark | 5.2:1 / 6.0:1 | 4.5 |
| amber warning badge text, light / dark | 5.0:1 / 7.7:1 | 4.5 |

### Deploy and the live TEST bot
- **Deployed** (version `dba8244c`). What is served matches this PC: `/app/` with `no-store` and the
  security policy, `app.js?v=13a28fb7bc`, the new red CSS.
- **Live API** (`node scripts/api-check.mjs`): **9 of 9 pass**:
  - opened as you: 200, owner;
  - a real change saved in D1 (a 23:00 time added) and the returned next digest matched D1; then
    your times were put back to 09:00, 14:00, 20:00;
  - 09:30 refused ("Times must be on the hour, between 06:00 and 23:00."), the removed "stories"
    setting refused;
  - Admin data 200 for you, 403 for anyone else, 401 for a tampered signature.
  - Side effect, as designed: your time zone now counts as "from your phone" (it was "chosen by
    hand").
- **Time migration:** `node scripts/migrate-times.mjs`: your times were already on the hour, so
  nothing changed (it would move 08:30 to 09:00, and so on, for anyone else).
- **You used the new Mini App on your phone** at 08:57 UTC (before I asked): it opened, and 13
  saves went through (1-2 ms CPU each). You chose 12:00, 13:00, 16:00, 18:00 and 20:00. Your phone
  reports its time zone as **Asia/Dubai** (the same GMT+4 as Yerevan), so the app now says "Dubai
  time". If you prefer Yerevan, set your phone's time zone to Yerevan; the app follows it on the
  next open.
- **Your first real digest in the new format** went out at 13:00 your time (09:00 UTC): 7 stories:
  - 🇺🇦🇷🇺🛢️ Ukraine strikes major oil refinery in Volgograd region (7);
  - 🇮🇱🇺🇸🤝 Mossad chief visits Washington to discuss Iran regional tensions (7);
  - 🇹🇷🇶🇦🤝 Turkey and Qatar sign mutual defense agreement (7);
  - 🇮🇶🚢💥 Oil tankers strike naval mines in Strait of Hormuz (7);
  - 🇦🇲🇹🇷🤝 Armenia and Turkey are close to establishing diplomatic relations, Pashinyan says (7);
  - 🇷🇺✈️ Air defense systems shoot down 79 drones over Kursk Oblast (6);
  - 🇷🇺🇺🇦⚖️ Moscow court issues arrest warrant for Ukrainian commander (6).

  No error was logged. The stories in the preview were not marked as sent (a preview writes
  nothing), so some of them came again here; that is expected.
- **Preview digest:** one labelled preview was sent to you ("Preview of the new digest (last 24
  hours). Nothing is recorded."): 12 stories, one message, 2,922 characters. Nothing was written.
  It greets you as "Owner" (see Problems).

### Worker CPU against the 10 ms limit (measured on Cloudflare, `wrangler tail` cpuTime)
| Call | Calls measured | CPU |
|---|---|---|
| `POST /api/open` | 2 | 5, 7 ms |
| `POST /api/settings` (save) | 4 | 2-5 ms |
| `POST /api/settings` (refused) | 4 | 1-2 ms |
| `GET /api/admin` (with editor stats) | 2 | 3, 3 ms |
| `GET /api/admin` (403 / 401) | 4 | 0 ms |
| 5-minute tick, nothing due | 3 | 3, 4, 6 ms |
| hourly trigger tick (:07) | 1 | 3 ms |
| 5-minute tick that sent your real 13:00 digest (7 stories) | 1 | **11 ms** (over the 10 ms limit; Cloudflare let it through, outcome "ok") |
| the same after the fix below, your 16:00 digest | - | not yet run when this was written (12:00 UTC) |

The 11 ms tick worried me: Step 3 measured 6 ms for one user. Two costs were new: the old
word-rule emoji dictionary was built and searched for every story even when the editor had given
emojis, and the message length was re-measured from the start for every topic. Both are fixed
(the dictionary is now built only for stories without editor emojis; the length is kept as a
running total) and deployed as version `2947a8d6`. Part of the 11 ms may also be the first use of
a new time zone (your phone's "Asia/Dubai") in that Worker instance. With up to 8 users per tick
the limit could be exceeded on busy slots; if the next measurement is still near 10 ms, the next
step is fewer users per tick (a one-number change in `config/digest.json`).

## Decisions I made and why
- **The editor never sees the first-pass score.** With it, it copied the score; without it, its
  scores are independent and much stricter.
- **Bars 7 and 6.** Scores are whole numbers and most stories land on 5 or 6, so 7/6 is the only
  setting that gave about 4-9 stories per digest on real data (6/6 always hit 12).
- **"Each topic's best story" means its best story not already in the digest, shown in that
  topic's section.** Read literally, one summit story tagged with four topics counted as the best
  story of all four, and digests shrank to 3-4 stories with whole topics missing.
- **The editor also picks each story's main topic** (one more field in the same call). Without it
  the Trump-Putin-Xi summit sat under "Iran War", because the first pass tagged it that way.
- **A merge keeps the oldest story** and copies "already sent" marks to it, so an event is never
  sent twice even when its stories are merged after one was sent.
- **The fact guard checks numbers and names only.** Those are the facts an AI most often invents;
  checking every word would throw away good translations. It dropped about 3% of texts on real
  data; the story then shows the first-pass summary.
- **Dark-mode shades of the red.** #b1161c is too dark to read on a dark background (2.4:1), so
  dark mode uses #d0232a for fills and #ff6b6b for text and icons. Light mode uses #b1161c itself.
- **Admin colours:** failures orange, warnings amber, so neither looks like the brand red.
- **Half-hour times round up** (08:30 -> 09:00), so nobody gets a digest earlier than before.
- **The old columns `users.max_stories` and `users.format` stay in the database, unused.** No
  older code can break on them, and they cost nothing.
- **The one-off backfill used 9 extra AI calls** (plus trial rounds while tuning: 47 editor calls
  today in total, about 0.5M input and 0.2M output tokens, all on the free tier) so that the bars
  could be tuned on real scores.
- **Two-message digests:** if the second message fails, the stories in the first are recorded and
  the second part's stories wait for your next digest.

## Problems / risks / open questions
- **The preview greets you as "Owner".** My live API check opens the app in your name with the
  label "Owner", and opening the app saves the Telegram first name, so it overwrote "Rob" in the
  database just before the preview was built. Fixed: your name is restored, the check now uses
  the stored name, and your real digests will say "Rob" (the next time you open the app it also
  refreshes from Telegram). I did not send a second preview, since you asked for one (lesson 31).
- **I was not sure at first that the preview went out**, because I had piped its output into a
  command that stops reading early. A harmless test showed the script keeps going, so it was sent
  once (lesson 32). If you did not get it, tell me.
- **The editor's judgement.** It rated the nationwide US flight ground stop a 7 although the prompt
  says flight disruptions are 1-2, and some "topic's best" 6s are routine ("Air defense shoots
  down 79 drones over Kursk"). Watch the first days; the bars and the examples in
  `prompts/editor.md` are easy to adjust.
- **Only 19 hours of data.** The pool began at 19:17 Yerevan yesterday, so "yesterday 14:00" could
  not be replayed, and today is a Saturday. Weekday digests may be bigger.
- **A full 12-story digest is close to one Telegram message** (the 12 longest real stories: 3,837
  of 4,000 characters), so a long day will sometimes arrive as two messages. That is by design.
- **The Mini App was again only seen in desktop Edge** with a stand-in for Telegram.
- **More database reads:** the editor reads the articles of its 60 candidates, which costs about
  3,500 more rows per run (about 84,000 a day, under 2% of the free 5 million).
- **Earlier trial runs of the editor** merged some stories while I was tuning; I reset the editor
  fields before the final backfill. One bad trial merge (44 stories) touched no story that had
  been sent to you.

## What the owner must do
In the chat with the TEST bot **@justatia_bot**:

1. **Read the preview digest** (it says "Preview of the new digest" at the top). Tell me:
   - whether the headlines and descriptions read well;
   - whether the emojis fit;
   - whether the topics look right;
   - whether anything looks invented or wrong.
2. **Your next real digests** (16:00, 18:00 and 20:00 today, with the times you chose) use the
   new rules and format and greet you by name. Tell me whether the number of stories feels right
   (about 4-9; with five digests a day each one is smaller) and whether anything important is
   missing.
3. **Your phone says Dubai time.** If that is not what you want, change the phone's time zone; the
   app follows it the next time you open it.
4. **You already opened the new settings, thank you.** Please confirm on the phone:
   - the colour should be red, in light and dark mode;
   - the icons in the small rounded squares (time zone, pause) should sit exactly in the middle;
   - the times are a grid: tap 11:00 (it turns red), tap it again (it turns grey);
   - try to choose a 6th time: it should refuse with a short message;
   - the time zone should read "Yerevan time, From your phone".
5. **Admin tab:** "News pipeline" should show "Editor pass", and "AI by model" should list the
   first pass and the editor separately.

Nothing to install or pay.

## Suggested next step
**Step 6: switch to the real bot @axiom_news_bot.** Put the real token in `.env`, set the Worker
secrets and the webhook, run `node scripts/setup-bot.mjs`, check `/start` once, then invite the
first users. Before that, a few days of real digests with the editor, and any changes you want to
the bars or the writing style.
