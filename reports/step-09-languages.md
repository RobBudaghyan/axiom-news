# Step 09: Reader languages

Date: 2026-11-15. Still on the TEST bot (@justatia_bot). Deployed (Worker version `19cf2380`),
pushed (commits `5cf4322`, `da76398`, `a5bc249` and the docs commit).

## Headline numbers

**What you decided (2026-11-15):**
- **Russian: on.** In the Mini App's new Language picker; new users whose Telegram is in Russian
  start in Russian. In Russian, "digest" is always **сводка** (your hard rule, checked by tests).
- **Armenian and French: quality approved, kept hidden for now** (your call: they would add
  Gemini calls). All their code, texts and checks stay; switching one on is one line (see "How to
  switch on Armenian or French").
- **Your own language: English.** Your account, chat menu and command list are back to English.

**Extra AI use per day, per language** (measured on today's real stories; only spent while at
least one active reader uses that language; English costs nothing):

| Language | Calls a day | Tokens in a day | Tokens out a day | Status |
|---|---|---|---|---|
| Russian | about 18 to 21 | about 17,000 | about 8,000 | **on** (0 today: nobody reads Russian right now) |
| Armenian | about 18 to 21 | about 17,000 | about 13,000 | hidden |
| French | about 18 to 21 | about 17,000 | about 8,000 | hidden |
| For comparison: everything today | about 82 | about 970,000 | about 310,000 | |

- One call per language per hourly run, and only in an hour that brings new or rewritten stories
  that could reach a digest: that was **18 of the last 24 hours**. So a language adds about
  **+25% AI calls** but only **about +2% tokens**. Calls are the tighter free limit (Gemini's
  daily request cap is shown only in AI Studio; we already make about 82 a day). All free.
- **The first call for a new language** (a catch-up of the whole day) was measured: all
  **70 stories in one call, 5,549 tokens in, 6,681 out, 16 seconds, 70 of 70 passed the checks.**
- **Quality** (15 real stories you received, side by side in `reports/data/step-09-samples.md`):
  Russian very good (1 small omission); French good (2 errors: a non-word in one headline, one
  wrong term); Armenian the weakest (3 errors: a missing space, one garbled headline, "refugee" for
  "displaced"). The code checks caught every number, name and alphabet problem.
- **Worker CPU:** building one digest takes **0.47 ms in English and 0.58 ms in Russian** on this
  PC; loading the four dictionaries takes 0.03 ms. On Cloudflare: see "Worker CPU" below.
- **Tests:** Python 86 -> **117**, Worker 115 -> **144**, all pass. 39 rules broken on purpose;
  every one is caught by at least one test (one is held twice in the code, explained below).

## What a reader sees

- **The Mini App** has a **Language** section (English, Русский), saved at once like every other
  setting; the whole page switches language immediately. Everything in Settings is translated:
  the next-digest card, topic names, times ("2 сводки в день, в 09:00 и 19:00"), pause, the time
  zone ("Часовой пояс: Ереван"), messages and errors. The Admin tab stays English (only you).
- **The first /start:** a user whose Telegram is in Russian starts in Russian, everyone else in
  English. After that only the picker changes it (a later /start never does).
- **The digest** in Russian: "Добрый вечер, Rob. С 14:00 для вас 6 историй:" with 24-hour times,
  the right greeting for the time of day, correct plurals (1 история, 2 истории, 5 историй,
  21 история), Russian topic headings, the quiet note in Russian. The first name, the outlet
  names and the emojis stay exactly as they are.
- **Never mixed:** if even one story in a digest has no translation yet, the **whole** digest
  (greeting and headings too) goes out in English. Each time is logged, and Admin shows the count
  per language ("2 in English"). A quiet note is always in the reader's language.
- **Switching language:** the next digest is in the new language if its stories are already
  translated; otherwise it comes in English once, and the next hourly run translates them.
- **Bot replies** (/start, /help, /settings, the "Открыть настройки" button), the chat menu
  button ("Настройки") and the command list are in the reader's language. Telegram also shows
  the Russian command list to anyone whose Telegram app is in Russian.

## Risks

- **A story that keeps failing a check keeps Russian readers on English digests** until it
  passes (it is retried every hour with the reason) or leaves the 24-hour window. In the samples
  1 story in 15 failed the first time (the AI wrote "круглосуточный" instead of keeping the number
  24) and passed on the retry.
- **The checks catch facts, not style.** Numbers, glossary names, the alphabet, accents and
  dashes are checked in code. A wrong word or an odd sentence is not (French "isterne", Armenian
  "refugee camp"). Russian had almost none of these.
- **Russian digests are longer** (the same 13 stories: 3,169 characters in English, 3,384 in
  Russian, 3,584 Armenian, 3,704 French), so on a busy day a Russian reader may get a story or two
  fewer under the 3,900-character limit.
- **Gemini's daily request cap** is the limit to watch. Russian adds about 20 calls a day once
  someone reads it; Armenian and French would add 20 each. Admin now shows calls and tokens per
  language.
- **The model is not always consistent:** once it wrote French with no accents at all; the
  check rejected it and the job now asks again at once when most of an answer fails.
- **The Armenian and French bot and Mini App texts were written by me** (not by the AI). You
  looked at the previews and approved, but they have not been used by real readers.

## How to switch on Armenian or French later

In `config/languages.json`, add the code to `"enabled"` (for example `["en", "ru", "hy"]`), then
redeploy the Worker (`cd worker && npm run deploy`), run `node scripts/setup-bot.mjs` (command
list in that language) and push (the hourly job reads the same file).

## Details

### 1. Where translation happens
- **In the hourly job, right after the editor** (`job/translate.py`). It is the third AI step:
  first pass, editor, translation. A failure never fails the run.
- **Which languages:** only enabled ones that at least one active (not paused, not blocked) user
  has chosen. No Russian reader, no call.
- **Which stories:** only those that could reach a digest: the last 24 hours, passing the
  editorial bar or the topic path (the same rule as the Worker; a shared test file with 300
  stories checks both sides agree).
- **Batching:** one call per language per run with every story that needs it (up to 80; Groq,
  the fallback, in chunks of 12). Same fallback chain as the other passes.
- **Stored** in a new table `story_translations` (story, language, headline, description, and the
  English text it was made from). If the editor rewrites a headline, the old translation stops
  counting at once and the story is translated again next hour.

### 2. The checks on every translated story
| Check | What it rejects |
|---|---|
| Numbers | any number of the English missing, or a number the English does not have (3,500 = 3 500 and 3.5 = 3,5 are fine; "six" may become 6) |
| Glossary names (`config/glossary.yaml`, 35 names) | Pashinyan not written Пашинян (any case ending), Sharmazanov not Շարմազանով, and so on |
| Alphabet | a headline not in the language's alphabet, or letters of another alphabet inside the text (the samples once had a Greek α inside an Armenian word) |
| French | no accented letter at all, or "l ONU" instead of "l'ONU" |
| Russian | the word дайджест (your rule: сводка) |
| Length | shorter than half or longer than three times the English |
| Dashes | em and en dashes are turned into a comma or a hyphen, in every language |
Armenian is also cleaned in code: the old spelling "եւ" becomes "և", and a sentence ending in a
colon gets the Armenian full stop "։". If most of one answer fails the checks, the job asks
again at once with the reasons (seen: French with no accents in 14 of 15 stories, then fine).

### 3. The quality samples (task 3)
`reports/data/step-09-samples.md` has all 15 stories in English, Russian, Armenian and French,
with my notes. The first two rounds showed problems that are now fixed in the prompt or the
checks: French without accents and apostrophes; hyphens dropped in all three languages; Russian
headlines in the English-style present tense; Armenian with a misspelled name, foreign letters and
old spelling. The final round: Russian 14 of 15 on the first try and 15 of 15 after the retry,
Armenian and French 15 of 15. Each language took 1 call of about 1,600 tokens in and 1,400 out
(Armenian 2,300 out: its script costs more tokens).

### 4. What you were sent (task 4)
Four messages on the TEST bot, each labelled "TEST preview, Step 9": the same 13 real stories as a
digest in Russian (3,508 characters), Armenian (3,727) and French (3,845), and the /start reply a
new Russian-speaking user gets. You also switched the Mini App to Russian on your phone and found
it right; your only change was сводка for "digest", now done.

### 5. Worker CPU (10 ms limit, 8 users per tick)
- On this PC: 800 digests from full pools, three runs each: **0.43 to 0.49 ms per English digest,
  0.53 to 0.61 ms per Russian one** (Russian text is longer, so the length cut has more to do).
  8 Russian readers in one tick: about 5 ms of digest work. The translations are joined to the
  stories inside the database query, which costs the Worker nothing.
- Loading the four dictionaries: 0.03 ms. The Mini App gets its texts as a static file
  (`i18n.js`, 17 KB, cached), not from the Worker.
- On Cloudflare (`wrangler tail` on the new version): the first tick after the deploy, with no
  digest due, took **5 ms** (it includes the start-up: loading the code and the dictionaries;
  Step 8's idle ticks took 2 ms, its first digest tick after a deploy 9 ms). **A tick that sends
  a Russian digest was not measured on Cloudflare:** nobody reads Russian now, and your next
  digest (20:00 your time) is in English. Estimate from the numbers above: start-up plus about
  0.1 ms more per Russian digest than an English one, so the same margin as Step 8. If
  Cloudflare ever shows `exceededCpu`, lower `max_users_per_tick` in `config/digest.json`.

### 6. Database cost
One new table, one new column (`users.lang`). Per language per day about 70 to 100 rows written
(translations and retries) and a few thousand rows read by the job; each digest reads its
translations with the stories. Well under 1% of the free daily limits.

### 7. Admin tab
A new "Languages, last 24 h" section: per language the active readers, stories translated (and
rejected by the checks), translation calls and tokens, and how many digests went out in English
instead. Each user row shows their language.

### Tests
- **Python: 117** (86 before). New: language filter (paused, blocked, hidden and English readers add
  nothing), one call per language, only stories that can reach a digest, the per-run cap, nothing
  redone while the English is unchanged, redone when it changes, retry with the note, the whole-answer
  retry (and a worse second answer is not used), the fallback chain and Groq chunks, a provider
  failure writes nothing, a crash in the step never fails the run, the prune, every check above,
  the Armenian clean-up, the shared eligibility file.
- **Worker: 144** (115 before). New: every language has every English key and no extra key (the
  test prints the list), placeholders and plural forms, the English fallback for a missing key,
  `i18n.js` up to date, no em dash in any dictionary, prompt or outgoing text in any language, no
  дайджест in Russian, Russian plurals (0 to 130, also the Mini App's copy of the rule), greetings
  by hour and 24-hour times, Armenian and French headers, never mixed (one missing translation
  makes everything English; logged; counted in Admin), stale and rejected translations ignored,
  /start and first Mini App open defaults (ru, ru-RU, de, hy while hidden, none), a later /start
  never changes the language, the language setting (enabled only, menu and commands follow, a
  Telegram failure is logged), translated error messages, the shared eligibility file.
- **Mini App click-through** in headless Edge: all 28 checks pass; the Russian page was checked by
  hand in the preview and by you on your phone. **Live API check:** all pass.

**Rules broken on purpose** (tests run, then the code restored):

| Broken on purpose | Tests that failed |
|---|---|
| paused and blocked users count as readers | 1 |
| hidden languages translated | 1 |
| one story per call | 5 |
| no per-run cap | 0 (the cap is also held by the per-call batch size, so nothing changes) |
| unchanged English translated again / rewritten English not redone | 2 / 1 |
| number check: a dropped number / an added number / separators not ignored | 2 / 1 / 1 |
| number words also excuse a missing digit | 1 (0 at first: French "six" looks like the English word; test added) |
| glossary check / alphabet check / headline script check off | 1 / 2 / 1 |
| French accent check / apostrophe check off | 2 / 1 |
| dashes not removed from translations | 1 |
| no immediate retry of a mostly rejected answer / a worse retry replaces the first | 2 / 1 |
| Armenian old spelling kept / colon at sentence end kept | 1 / 1 |
| дайджест allowed: in the Russian texts / in a translation | 3 / 1 |
| job rule differs from the Worker (Python / SQL / Worker side) | 1 / 1 / 3 |
| a crash in the translation step fails the run | 1 (0 at first; test added) |
| never-mixed rule off | 2 |
| stale translations used / rejected translations used | 1 / 1 |
| Russian plurals: 12 to 14 as "few" / the Mini App's rule differs | 2 / 1 |
| no English fallback for a missing key / a key missing in French | 1 / 3 |
| an em dash in a Russian text | 2 |
| /start ignores Telegram's language / a later /start changes it / first Mini App open ignores it | 2 / 1 / 1 |
| any language accepted in settings | 1 |
| an English fallback not logged | 1 |

### Files
- **New:** `config/languages.json`, `config/i18n/en.json`, `ru.json`, `hy.json`, `fr.json`,
  `config/glossary.yaml`, `prompts/translate.md`, `job/translate.py`, `worker/src/i18n.js`,
  `worker/public/app/i18n.js` (generated), `worker/scripts/step9-previews.mjs`,
  `scripts/make_eligible_cases.py`, `tests/fixtures/eligible_cases.json`, `tests/test_translate.py`,
  `worker/test/i18n.test.mjs`, `reports/data/step-09-samples.md` and `.json`, this report.
- **Changed:** `db/schema.sql`, `scripts/apply_schema.py` (applied to the live database first),
  `job/run.py`, `job/config.py`, `job/ai.py`, `worker/src/digest.js`, `bot.js`, `api.js`,
  `settings.js`, `cron.js`, `admin.js`, `index.js`, `worker/public/app/` (picker, texts),
  `worker/scripts/stamp-app.mjs`, `setup-bot.mjs`, `digest-cli.mjs` (`--cpu 800 --lang ru`), tests,
  `PROJECT_NOTES.md`, `README.md`, `docs/ARCHITECTURE.md`.

## What you need to do
Nothing now. When someone you invite reads Russian, the next hourly run makes the first Russian
call (about 70 stories); Admin's "Languages" section then shows the real numbers. If you want
Armenian or French later, tell me and I will switch it on.
