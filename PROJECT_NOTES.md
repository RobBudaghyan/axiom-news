# Project notes

Keep this short and current. History lives in `reports/` and git.

## Goal
A Telegram news digest bot for about 20 people (the owner, his dad, friends). It must cost $0/month
and never need a credit card. During development it uses a separate TEST bot, switching to the real
bot @axiom_news_bot at the end.

## Spec (approved, v1)
- **Hourly pool.** Collect ~100 RSS feeds and make ONE AI pass for all users: group duplicates
  into stories, tag topics, score importance 1-10, write a one-line English summary, and use the
  best link (most prestigious outlet; paywalls are fine).
- **Editor pass (Step 5):** a second AI call per hour compares the strongest stories of the
  last 24 h side by side (the best few of every topic always included), merges duplicates, gives
  a strict final score 1-10, the main topic, a one-sentence headline, a 1-3 sentence description
  (only facts from the articles) and 2-3 emojis. If it fails, digests use the first-pass data.
  Step 8: it also gives a **topic score** (for followers of the main topic: the score plus a
  boost, capped in code at 0 for Politics and Wars & Conflicts, 1 for the two wars, 2 for Armenia
  and Russia), sees up to 90 new stories per call, and makes a second call on a backlog.
- **Digests per user** at chosen local times (on the hour, 06:00-23:00, 1 to 5; defaults
  09:00/14:00/20:00), time zone from the phone. **No fixed count (Step 8):** a story is in if its
  final score is 7+, or its main topic is followed and its topic score is 6+ and above its final
  score. No maximum, no topic cap: the digest is ONE message of at most 3,900 characters (never
  folded behind "Show more"); if longer, the lowest-ranked stories are cut, keeping each followed
  topic's best story. Building a digest is a database filter with no AI. The same story is never sent
  to a user twice; if nothing qualifies, a short "quiet period" note.
- **Topics:** Politics, Wars & Conflicts, Armenia, Russia, Iran war, Ukraine war.
- **Reader languages (Step 9):** English (default) and Russian; Armenian and French are built and
  approved on quality but hidden (`config/languages.json`). Everything a reader sees is in their
  language: digest text, greeting, headings, quiet note, bot replies, menu button, commands, the
  Mini App (Admin stays English). A new user starts in Telegram's language if supported, else
  English; then only the Mini App picker changes it. The hourly job translates, after the
  editor, the stories that could reach a digest into the languages active users read (one call
  per language per run, checks on numbers, names, alphabet). Never mixed (Step 10, owner): a
  story with no translation yet is held back, not marked sent, and goes out in a later digest
  once translated (inside its 24 h); only a digest left with no story at all goes out wholly in
  English. In Russian, "digest" is always сводка, and Ukraine always takes на (Step 11, owner):
  the topic is "Война на Украине", translations say "на Украине" (the job rejects "в Украине").
- **Telegram Mini App settings:** the next digest, topics, digest times (hourly grid), language,
  pause, Support; the time zone is one quiet line at the bottom ("Yerevan · GMT+4"), from the phone
  (Step 5 removed stories per digest, the format choice and the zone picker). **Design (owner,
  Step 12: "design 1", iOS Settings):** iOS grouped colours (light #f2f2f7 with white cards, dark
  #000 with #1c1c1e), every row and button 48 px high with 12 px corners and 8 px gaps, button
  grids on six shared columns, a small coloured square and a red switch on every row, no helper
  texts, no "Saved" toast (a light haptic tap; errors still show). An Admin tab, visible only to
  the owner, in the same style, shows stats, errors and AI usage, plus a "Send me a digest now"
  button.
- **AI:** Gemini free tier, falling back to Groq; if both fail, items wait an hour. About 82
  calls/day (about 57 first pass + 25 editor), independent of user count; plus about 20 a day per
  reader language other than English while someone reads it (Step 9).
- **Hosting:** GitHub Actions hourly job, plus Cloudflare Worker + D1 (webhook, Mini App API,
  static Mini App, digest cron).
- **Tips (Step 10, amounts Step 11):** "Support Axiom" (always open near the bottom of the Mini App
  settings: the title and 100, 500 and 1000 Stars buttons, no text since Step 12) and /support (the same three buttons):
  voluntary Telegram Stars tips, the same for everyone (no test amount). Nothing is locked and a tip
  changes nothing else. /paysupport and /terms as Telegram requires; the owner refunds from Admin.
- **Custom topics (Step 13, "My topics"):** a reader adds up to 3 topics of their own in the Mini
  App. Shared: two readers with "Colombia" (or "Colombian news") follow one topic. The Worker checks
  each new name ONCE with AI (sensible news topic; not nonsense, offensive or a private person;
  normalised name in four languages, emoji, 2-5 Google News searches, a boost cap 0-2); 5 checks a
  reader a day (owner unlimited); a main topic is refused; blocked names cannot come back. The
  hourly job searches Google News for topics with an active, unpaused follower (40 requests a run,
  8 new headlines a topic, no-AI dedupe against the pool); pass 1 and the editor know the custom
  topics (sport and the like count as news for them); digests give them their own section. Each
  custom row looks like a main topic row (its emoji, the name, a red switch); Edit / Done with a red
  minus removes one (Step 13 fixes). Switched off: kept in the list and its slot, not searched or
  sent for that reader. Digest rule for custom topics (owner): the editor's topic score ("how
  important for someone who chose this topic") counts as it is against the bar of 6, no cap, no
  "above the score" rule. A topic no reader has in their list (on or off) for 7 days is deleted.
  **Keyword rule (Step 14, owner):** each custom topic has 5-15 match keywords in English and Russian
  (the topic check writes them; the job fills missing ones with one AI call that sees the topic's
  latest Google headlines). A story keeps a custom tag, and may sit under that topic, only if a
  keyword is in its English headline or description (whole word, any case); otherwise it falls
  back to its best main topic with no boost, or leaves the custom path. Checked in pass 1, in the
  editor and once a run over the last 26 h. Names: another English spelling of a glossary name
  ("Takaiti") becomes the glossary's ("Takaichi") in Google headlines, summaries and editor texts.
- **AI budget guard (Step 13):** calls and 429s per model since midnight Pacific time. A Gemini 429
  in the last hour or 80% of a soft limit (250 a day per model, `config/ai_budget.json`): new topic
  checks wait ("try again in a few minutes"). Every Gemini model refusing, or the limit reached:
  translations wait too. Pass 1 and the editor never wait. Admin shows it; the owner gets one
  alert a day.
- **Not in v1:** paid features, ads, user-added sources, instant alerts, channels.
- **Digest format (owner, Step 11: design "E5f").** A Telegram **rich message**
  (`sendRichMessage`). One line: "**Good evening, Sam** · 6 stories since 2 PM" (12-hour time in
  English, 24-hour in other languages; "in the last 24 hours" the first time). Each topic in a
  centred, bordered box with its emoji; a divider line between topics. Each story: the editor's
  2-3 emojis, the headline in bold, then " · Outlet" in italics as the link, then the description
  in a quote box. No numbers. The quiet note is the same greeting line. No button under digests or
  quiet notes (Step 14, owner; the chat's menu button and /settings open the Mini App). In Step 14
  the owner saw four plain newsletter layouts and four topic-heading variants and kept E5f as it is.
  Always one message of at most 3,900 characters
  (Telegram folds rich messages only after about 8,000), never an em dash. The word-rule emojis of
  `config/line_emoji.json` are only a fallback. The Step 5 format stays in code as `CLASSIC`
  (fold test only).

## Decisions (with reasons)
| Date | Decision | Why |
|---|---|---|
| 2026-11-13 | Python for the hourly job, plain JavaScript for the Worker and Mini App | feedparser copes with messy feeds; Workers and the Mini App need JS; the two halves share only data files |
| 2026-11-13 | One Worker serves the webhook, the API, the Mini App files and the digest cron | one deploy unit; static assets are free |
| 2026-11-13 | Digests are sent by a Worker cron every 5 min, not by GitHub | GitHub schedules can be delayed or dropped; delay is at most ~5 min |
| 2026-11-13 | The GitHub job writes to D1 via the REST API with a D1-only token | no Worker CPU used; the job connects outward only |
| 2026-11-13 | Best link is chosen by code: relevant title first, then lowest tier, then earliest; not by the AI | cheaper and predictable. The relevance check was added in Step 2 after the AI put an unrelated article in a story |
| 2026-11-13 | At most 8 new items per feed per run, inside a lookback window (last run + 1 h, 2-24 h; 3 h on the first run) | Russian state agencies publish 1,000+ items/day each; a normal hourly call is ~23k tokens |
| 2026-11-13 | AI order: `gemini-3.5-flash-lite`, then `gemini-3.1-flash-lite`, then Groq `openai/gpt-oss-120b` in chunks | measured: the primary Gemini model returned 503 "high demand" on about half the calls; Groq's 8k TPM (prompt + reply room) allows ~1 chunk/min. Cerebras (card), Mistral (billing) and OpenRouter (50 req/day) were rejected |
| 2026-11-13 | The AI must account for every item (story or `not_news_ids`). A partial answer is kept and the skipped items are resent; a degenerate answer is retried | seen for real: one answer placed 0 of 435 items, and answers to huge chunks covered 30-40% |
| 2026-11-13 | Existing stories appear in the prompt as `S<id>` | with plain numbers the model once put item 46 into story 46 |
| 2026-11-13 | Old rows are deleted once a day, not hourly | saves D1 rows read |
| 2026-11-13 | `state_owned` = a government owns or mainly funds the outlet; `note` says whether it is state-controlled or editorially independent | a factual label instead of a judgment call |
| 2026-11-13 | ~~Private GitHub repo~~ replaced in Step 3 by a **public** repo `RobBudaghyan/axiom-news` (owner) | unlimited free Actions minutes. The Worker starts the job via `workflow_dispatch`, so the 60-day schedule auto-disable only affects the backup schedule |
| 2026-11-13 | Default time zone `Asia/Yerevan` (owner) | most users are expected to be in Armenia |
| 2026-11-13 | D1 database `axiom-d1` (created by the owner in the dashboard), schema applied via REST | no Node.js/wrangler needed until the Worker in Step 3 |
| 2026-11-13 | Digest selection, cap and format live only in `worker/src/digest.js`; settings in `config/digest.json` (Step 3, owner: "one shared place") | the Worker and `worker/scripts/digest-cli.mjs` import the same module, so they behave identically. Replaced `db/digest_query.sql` and `scripts/send_test_digest.py` |
| 2026-11-13 | Topic cap: max `ceil(0.4 x N)` per topic (3 of 7), counted against the most specific topic, empty slots filled with the next most important (owner, Step 3) | Ukraine war filled 6 of 7 lines in Step 2 |
| 2026-11-13 | Near-duplicates are grouped by the hourly job (`job/dupes.py`, word overlap weighted by rarity, threshold 0.45), not in the Worker | measured on Cloudflare: doing it in the Worker cost ~1.5 ms CPU per user plus ~8 ms cold start against a 10 ms limit. Tuned on 365 real stories: ~70% of duplicates caught, 2 of 24 look-alikes wrongly merged |
| 2026-11-13 | At most 8 users per Worker tick, 40 candidates per user | measured: 1 due user 6 ms, 20 users 10-27 ms CPU. With ~20 users at 09:00 the last get it by ~09:10 |
| 2026-11-13 | The Worker starts the hourly job at :07 (cron `7 * * * *`, fine-grained token: this repo, Actions read/write, no expiration); backup GitHub schedule at :37 in its own file, skipping if a run started < 45 min ago; one run at a time | precise timing; the backup covers a failed trigger; its own file so an inactivity disable never hits `hourly.yml` |
| 2026-11-13 | Owner alerts: failed run, run stuck 30+ min, no successful run for 3 h, or failed dispatch; at most one per 3 h | the owner learns about outages without watching dashboards |
| 2026-11-13 | Commits use the owner's GitHub noreply email (history rewritten before the first push, owner) | the repo is public |
| 2026-11-14 | Format B is the default, with a context emoji on every line (owner) | owner liked B; per-line flags make a grouped digest easy to scan. Word rules, not AI: free, predictable, ~25 µs per line |
| 2026-11-13 | The Times of Israel feed disabled (`enabled: false`) | HTTP 403 from GitHub's runners; works from the PC |
| 2026-11-14 | Mini App as 3 static files (no framework, no build), served by the same Worker as free static assets; page `no-store`, files with a content hash | small and fast; lesson 12 (Telegram caches hard) |
| 2026-11-14 | Every setting saves instantly (one request at a time); the format (A/B) became a per-user setting (`users.format`) | spec; the owner's B stays the default |
| 2026-11-14 | Time zone: the phone's zone is saved on every open unless the user picked one by hand (`tz_detected` 2), then the app offers "Use it" | follows the phone when travelling, never overrides a deliberate choice |
| 2026-11-14 | A digest already due (slot < 15 min ago, not sent yet) survives a settings change | saving at 14:02 must not swallow the 14:00 digest |
| 2026-11-14 | Feed health is one JSON row in `meta` written by the job each run; the Worker counts its own D1 rows and writes them every tick (~288 rows/day) | per-feed rows would cost ~2,800 writes/day; D1's usage API needs a token the Worker does not have |
| 2026-11-14 | Editor pass: one more AI call per hourly run (merge, strict score, main topic, headline, description, emojis), same fallback chain; a failure never fails the run (advisor, Step 5) | first-pass scores were inflated (364 of 424 politics stories >= 4) and ranking by them hid 27 Armenia stories; ~30% of duplicates slipped through |
| 2026-11-14 | The editor does not see the first-pass score | with it, it copied the score for almost every story (lesson 27) |
| 2026-11-14 | A merge keeps the oldest story and copies `sent` rows to it | the oldest is most likely already sent; never twice across a merge |
| 2026-11-14 | Fact guard: numbers and names in editor text must appear in the articles | "only facts from the articles" checked in code, not just asked for; 5 of 452 real texts dropped |
| 2026-11-14 | Bars 7 (editorial) and 6 (topic), max 12, unedited = importance - 2 (`config/digest.json`) | tuned on the real pool: 7/6 gave 9, 9 and 5 stories; 6/6 always 12; 8/6 three |
| 2026-11-14 | Each followed topic gets its own section with its best *remaining* story | with "its best story" one summit tagged with four topics satisfied all four, and digests had 3-4 stories |
| 2026-11-14 | The editor names each story's main topic (`stories.main_topic`), used as its section | the first-pass tags put a Trump-Putin-Xi summit under "Iran War" |
| 2026-11-14 | Format A and the per-user format, stories per digest and the zone picker removed; times on the hour 06:00-23:00; the zone always follows the phone (owner) | simpler; `users.max_stories`/`format` kept unused in the table |
| 2026-11-14 | Brand red #b1161c; dark mode uses #d0232a fills and #ff6b6b text; Admin failures orange, warnings amber (owner) | #b1161c is only 2.4:1 on a dark cell |
| 2026-11-14 | Step 6 coverage experiment (Google News search feeds) runs in **shadow mode only**: last step of `hourly.yml`, D1 keys only, `continue-on-error`, own tables `shadow_items`/`shadow_runs` (owner: measure first) | must not change digests, the pool or users; no AI keys = no AI calls possible |
| 2026-11-14 | Google News searches use `when:2h`; English and Russian editions; Armenian script only "Երևան" | a 1-day window returns the day's 100 most relevant, ~10% of them recent; Armenian-language results are near zero and the hy/AM edition answers in Russian |
| 2026-11-14 | Google News shadow step **paused** (`enabled: false` in `config/gnews_queries.yaml`); code and `shadow_*` tables kept; the step exits before any D1 or Google request (Step 7) | the gap was our own feeds, not Google; kept for custom topics with no curated feed (e.g. "Colombia") |
| 2026-11-14 | Eight Armenian feeds added: News.am Russian, Factor.am, Aravot, 168.am, A1+, ArmInfo English, CivilNet and Hetq in Armenian (Step 7) | the pool had only News.am English (1-2 items/h) of the big outlets; News.am Russian/Armenian publish 5-10/h. Armenpress, 1lurer, Panorama, Shamshyan: no RSS; Arka, Mediamax blocked from GitHub; Lragir unreachable |
| 2026-11-14 | Russian over Armenian-script editions of the same outlet (News.am) | 86% the same articles; Armenian script costs 164 Gemini tokens per item, Russian 89, English 70 |
| 2026-11-14 | Per-feed cap `max_items` in `sources.yaml` (default 8): News.am Russian and 168.am 20, A1+ 12, Factor.am and Aravot 10; what a cap cuts is logged and kept in `feed_health.cut` | busiest Armenian feeds publish up to ~14 items in an hour; the 8 cap is still right for the rest |
| 2026-11-14 | Prefer English links (owner): in a merge, the story's current link is scored like a new article, so an English article that matches the summary takes over from a Russian/Armenian one | new stories already ranked a matching English title first; merges assumed the old link was perfect |
| 2026-11-14 | `ai.estimate_tokens` counts Armenian at 1.6 characters per token | it counted 2.5, 44% too low, so chunks of Armenian items would have been larger than planned |
| 2026-11-15 | Editor coverage: up to 90 new stories per call (was 45), a 2nd call in the same run only while unscored ones remain (not after Groq), Armenia candidates from first-pass 3 (Step 8) | measured: 97% of 4+ stories were scored, but 13 of 24 runs were full and 58 stories waited 3+ h; a 90-candidate sandbox call covered 89 (19.2k in / 8.4k out), one call instead of two |
| 2026-11-15 | `stories.scored_at`; a digest counts a story as new if it was updated OR first scored since the last digest | a story scored after a digest went out was lost for good (its `updated_at` was older than the next window) |
| 2026-11-15 | Topic score = score + boost; the boost is capped in code per topic (0 Politics, 0 Wars & Conflicts, 1 Iran war, 1 Ukraine war, 2 Armenia, 2 Russia) | the first calibration put 148 stories a day at topic 6+ (43 Ukraine, 26 Iran); the model still lifts statements and routine war news |
| 2026-11-15 | The topic path needs a real boost (`topic_needs_boost`: topic score above the global score); confirmed by the owner | without it every global-6 story reaches its topic's followers; a reader of all topics got a full digest every time (13.7 avg, 97 cut in 48 h) |
| 2026-11-15 | Bars 7 (editorial) and 6 (topic) (Step 8) | 48 h replay: Armenia-only reader 3.0 stories per digest (0.4 before), owner 5.0 (2.3), all topics 3x a day 12.1 (5.7); 7/7 gave the Armenia-only reader 0.9 |
| 2026-11-15 | One message, at most 3,900 characters; the two-message split and `max_stories` removed | the owner's Android phone folded none of 5 test messages up to 3,993 characters; Telegram's blog: only bot rich messages fold (about 8,000); plain messages are capped at 4,096 |
| 2026-11-15 | The 40% topic cap removed; the length cut keeps each followed topic's best story and breaks ties from the most crowded section | with no fixed size the cap held a one-topic reader to 2 stories; length is the real limit now |
| 2026-11-15 | Unedited stories qualify only through the editorial bar | an editor outage must not flood digests with first-pass scores |
| 2026-11-15 | Admin: average digest size per user over 24 h, from `sent` (rows of one digest share `sent_at`; merged-away stories skipped) | no new table; quiet notes are not counted |
| 2026-11-15 | Russian on; Armenian and French approved on quality but hidden (owner) | each used language adds about 20 Gemini calls a day; Gemini's daily request cap is the tight limit. One line in `config/languages.json` switches one on |
| 2026-11-15 | Translation in the hourly job after the editor, one call per language per run, only stories that could reach a digest, only languages an active user reads | measured: 70 stories in one call (5.5k in, 6.7k out); 18 of 24 hours have new stories; no reader, no call |
| 2026-11-15 | `users.lang` (the reader's choice) apart from `users.language` (Telegram's code, refreshed on every /start) | the language is set once from Telegram, then only by the picker |
| 2026-11-15 | A translation counts only while its `src` equals the story's current English text, compared in the digest SQL | an editor rewrite makes it stale at once, with no Worker CPU and no hashing |
| 2026-11-15 | Never mixed: one untranslated story makes the whole digest English; logged in `errors` (component `digest`), counted per language in Admin | spec; a quiet note has no stories and is always in the reader's language |
| 2026-11-15 | Checks on every translation: the same numbers both ways (an English number word may become digits), glossary names (`config/glossary.yaml`, a stem for declined forms), the alphabet, French accents and apostrophes, no дайджест; a rejected story is redone next hour with the reason; an answer mostly rejected is asked again at once | samples: French once had no accents in 14 of 15, Armenian had Greek letters and a misspelled name |
| 2026-11-15 | In Russian, "digest" is always сводка (owner, hard rule) | tests fail on дайджест in any Russian text; the job rejects it in translations |
| 2026-11-15 | One dictionary per language (`config/i18n/<lang>.json`); the Mini App's `i18n.js` is generated from them at deploy; the Admin tab and owner alerts stay English | no hard-coded user text; a test lists missing keys |
| 2026-11-15 | Plurals and times by hand, no Intl in the Worker; English keeps "2 PM", other languages "14:00" | Intl is the costly part of a cold Worker |
| 2026-11-15 | ~~One untranslated story makes the digest English~~ replaced in Step 10 (owner): untranslated stories are **held** (left out, not marked sent), the rest goes out in the reader's language; only zero stories left means a wholly English digest | readers of Russian got English digests whenever one story lagged |
| 2026-11-15 | A held story is kept a candidate by a `digest_holds` row (user, story, language, time), not by its timestamps; still only inside the 24 h window | a held story's `updated_at` is older than the next digest's window, so without the row it would be lost; the row also feeds Admin's "held for translation" count |
| 2026-11-15 | The length cut runs after the drop | the room a held story leaves goes to the next translated story |
| 2026-11-15 | Tips: Telegram Stars only (XTR, no card, no provider), amounts ~~50/100/250/500, 1 for the owner's tests~~ (100/500/1000 since Step 11); Mini App via createInvoiceLink + openInvoice, chat via /support buttons + sendInvoice (owner, Step 10) | $0 and no card; Stars are Telegram's required currency for digital goods |
| 2026-11-16 | Russian: Ukraine always takes на ("Война на Украине", "на Украине"); the translation check rejects "в/во Украине", "в Украину" (owner, Step 11) | owner's rule; a rejected story is redone next hour with the reason |
| 2026-11-16 | Tips: 100, 500, 1000 Stars for everyone; the owner's 1-Star test amount removed; the Mini App section is always open (owner, Step 11) | simpler; the test amount was only for the Step 10 live check |
| 2026-11-16 | Digests are Telegram rich messages, design "E5f" (owner, Step 11, after 6 rounds of previews on the TEST bot) | the owner found it the most elegant; real headings, boxes, quote boxes and dividers are not possible in a plain message |
| 2026-11-16 | One layout object (`LAYOUT` in `digest.js`) makes every piece of a digest, and the length cut measures those same pieces | the cut can never drift from the format; checked against Telegram: its stored text equals our count exactly (plain and rich) |
| 2026-11-16 | Rich-message length = the visible text in UTF-16 with no separators between blocks; limit still 3,900 | Telegram stores the blocks' text with no separators (checked on real messages); its own limit counts Unicode characters, never more than UTF-16 |
| 2026-11-16 | A "⚙️ Settings" web_app button under every digest and quiet note, in the reader's language | owner; one tap to the Mini App |
| 2026-11-16 | Mini App design "design 1" (owner, Step 12, from three versions live on the TEST bot): iOS Settings with coloured squares and red switches | the owner's choice over a pure minimal page and an all-buttons page |
| 2026-11-16 | One size for everything in the Mini App (`--h` 48 px, `--r` 12 px, `--gap` 8 px) and button grids on 6 columns (a time spans 1, a tip 2, a language 3); `ui-check.mjs` measures it at 360, 390 and 430 px in English and Russian | owner: homogeneous and symmetric; the columns of every grid line up |
| 2026-11-16 | No helper texts and no "Saved" toast; a saved change is one light haptic tap (`impactOccurred("light")`), errors still show (owner, Step 12) | owner: default is no text |
| 2026-11-16 | The Mini App uses its own iOS palette, light or dark as Telegram is, and sets Telegram's header, background and bottom bar to that exact colour (hex, Telegram 6.9+) | Telegram's theme greys differ per platform (Android's dark is blue-grey); the edges always match the page |
| 2026-11-16 | Language buttons carry a flag from `config/languages.json` (`flags`), passed to the Mini App in `i18n.js` | one place per language |
| 2026-11-16 | Custom topics (Step 13, owner): anyone may add up to 3; shared and normalised by one AI check; Google News search feeds as their source (owner accepts the terms-of-use risk); stories from our RSS feeds count too | readers asked for topics we do not curate (e.g. Colombia); one topic row per subject keeps searches and AI cost per topic, not per reader |
| 2026-11-16 | The topic check runs in the Worker with its own Gemini and Groq keys (owner): 5 checks a reader a day, owner exempt, input refused before any AI call, every call logged in `ai_calls` (kind `topic_check`) | an answer in a few seconds; the guard and Admin count these calls with the job's |
| 2026-11-16 | A main topic typed as a custom topic is refused with its name, not switched on (owner) | the reader stays in control of the main switches |
| 2026-11-16 | The check prompt says the model's knowledge may be out of date | the first version rejected "Pope Leo" ("there is no current Pope named Leo") |
| 2026-11-16 | Google searches: 40 requests a run (topics searched longest ago first, `when:` since the last search, 2-12 h), at most 8 new headlines a topic a search, no-AI title check against the pool at 0.5 (Step 6), tier 4, marked "headline only"; a Google 429/503 stops the rest of the run | measured: busy topics return 100+ results in 2 h, so the item cap sets the cost; 15 a topic cost twice as much for little gain |
| 2026-11-16 | Custom topics follow the main-topic rules: the AI's boost cap (0-2) in `topic_boost_max`, the topic path, the length cut, never twice; a custom section is the most specific | owner: same rules. Consequence: a niche topic (sport) reaches a digest only if its story scores 4+ globally |
| 2026-11-16 | Google links of stories that could reach a digest are resolved to the outlet (10 a run, one try each); a failure keeps the Google link | Step 6 method; a Google link still works |
| 2026-11-16 | `custom_topics.id` is AUTOINCREMENT | a deleted topic's tag (c12) must never be reused: old stories still carry it |
| 2026-11-16 | AI budget guard: level 1 (a Gemini 429 in the last hour, or 80% of a soft limit) delays topic checks; level 2 (every Gemini model 429 in the last hour, or the soft limit) also delays translations; never pass 1 or the editor; one owner alert a Pacific day | owner: safety without hurting users; the Pacific day computed by the US rule (no tz database in the Worker) |
| 2026-11-17 | Custom topics: a switch per reader (`custom_follows.enabled`); off keeps the slot and the list place, not searched or sent; deletion only when no reader has it, on or off (owner, after his test) | the owner wants to pause a topic without losing it |
| 2026-11-17 | Custom topic digest rule: the topic score counts as it is (no cap, no "above the score"), bar 6; the 6 main topics keep Step 8 (owner) | the reader chose the subject; with the cap a race result (global 1) could never reach Formula 1 followers |
| 2026-11-17 | Editor prompt for reader topics: "how important for someone who chose it", 4/6/8 examples, main topic only when mainly about it; pass 1 gives notable reader-topic items at least 3 | live, a looser version gave Japan 12 stories at 6+ in 13 h, some about China or Canada; this one halves it on the same stories |
| 2026-11-17 | My topics redesign: emoji square tinted from the emoji itself (canvas, snapped to the iOS hues), switch, iOS Edit/Done with a red minus, slide-in with the switch turning on; no "x", no "Joined" bubble (owner) | "no proper emoji, no on/off switch, it did not look added" |
| 2026-11-17 | Custom-topic keyword rule in code, not only the prompt (Step 14, owner): 5-15 keywords in en and ru per topic; a story keeps a custom tag only with a keyword in its English headline or description, else falls back to its most specific main topic with topic score = score | live, the editor put "US restricts China's AI chips", "Canadian PM Carney arrives in China" and "China and Canada expand tariff relief" under Japan despite the mainly-about rule; the rule takes all of them off (14 of 62 custom-tagged stories in 24 h) |
| 2026-11-17 | The rule runs in the job only (pass 1, editor writes, a sweep over 26 h each run), not in the Worker | one place; the Worker sees only tags the job kept, and its CPU is untouched |
| 2026-11-17 | Keyword backfill shows the AI the topic's latest Google headlines; the Worker stores keywords only if it got 5+ English ones, else NULL for the job to fill | the first live answer for Japan named Kishida and Ishiba, not Takaichi; with headlines it gave Takaichi and Okinawa |
| 2026-11-17 | Glossary: the first `en` form is ours, the others are replaced in Google headlines, pass-1 summaries and editor texts (after the fact guard); Takaichi/Takaiti and Sanae added in four languages | "Takaiti" came from the editor reading a Russian article (Такаити), not from a Google item |
| 2026-11-17 | Editor prompt: non-events ("remains", "continues", "unchanged") are 3-4, never 6, for main and reader topics | "China's naval presence near Japan remains normalized" got a topic score of 6 |
| 2026-11-17 | Digest design E5f kept; the "⚙️ Settings" button under digests and quiet notes removed (owner, Step 14) | the owner rejected four plain layouts and four heading variants; the menu button and /settings still open the Mini App |
| 2026-11-15 | pre_checkout_query is answered from the invoice payload alone (no database read) | Telegram cancels the payment after 10 s; measured a few microseconds |
| 2026-11-15 | Table `tips`: user, amount, Telegram charge id (UNIQUE), time, refunded time; nothing else | the owner's rule; the charge id is needed for refunds, and UNIQUE makes a repeated update count once |
| 2026-11-15 | /paysupport forwards the user's note to the owner; /terms states the tip terms; the owner refunds from Admin after a confirm (refundStarPayment) | Telegram's rules for bots that take Stars |

## Current status
- **Step 1 done:** repo, docs, topics, prompt, lessons, 116 verified feeds.
- **Step 2 done:** the hourly job, D1, measured AI limits, first test digest.
- **Step 3 done (2026-11-13): everything runs with the PC off, still on the TEST bot
  (@justatia_bot).**
  - GitHub: public repo `RobBudaghyan/axiom-news`, job secrets set, the hourly job ran on
    GitHub's runners (2 min). 115 of 116 feeds work from there.
  - Cloudflare Worker `axiom-news` (`axiom-news.axiom-news-worker.workers.dev`): webhook with
    secret check, `/start` and help replies, digest cron every 5 min, hourly job trigger at :07,
    health alerts to the owner.
  - Real tests: the owner's `/start`, one forced digest, previews of formats A and B, a
    Worker-started hourly run. Details in `reports/step-03-automation.md`.
- **Step 4 done (2026-11-14): the Mini App, still on the TEST bot.**
  - `https://axiom-news.axiom-news-worker.workers.dev/app/`, opened by the chat menu button
    "Settings", the "Open settings" button under `/start` and the new `/settings` command.
  - Settings for everyone (topics, times, stories, format, time zone, pause, next digest) and an
    Admin tab for the owner (health, pipeline stats, feeds, users, errors, D1 use, two buttons).
  - Tested: 115 Worker + 36 Python unit tests, a 23-step click-through in headless Edge, and
    8 checks against the live API (a real settings change saved in D1). Every API call measured
    under 10 ms CPU. Details in `reports/step-04-mini-app.md`.
- **Step 5 done (2026-11-14): the editor pass, editorial digests, the new format and the Mini App
  in brand red, still on the TEST bot.** Details in `reports/step-05-editor.md`.
  - Every hourly run now makes two AI calls; the editor ran on GitHub (60 candidates, 10.1k tokens
    in, 4.9k out) and over the last ~19 h of stories once from this PC.
  - Tests: 54 Python + 112 Worker unit tests, 28-step click-through, 9 live API checks, mutation
    checks for every new rule. One labelled preview digest was sent to the owner.
- **Step 6 part A done (2026-11-14): coverage experiment in shadow mode.** Google News RSS works
  from the PC and GitHub (all 200, no limits seen), titles only, links need 2 requests to resolve.
  The shadow step collects every hour since 12:07 UTC (first run: 677 articles, 232 unique after
  the headline check). A sandbox AI pass on 120 of them: 54 not news, 34 already in the pool, 32
  new events (9 Armenia, mostly score 4-5). Terms-of-use concern noted for the owner. Details in
  `reports/step-06-coverage-experiment.md`. **Paused in Step 7** (part B not run).
- **Step 7 done (2026-11-14): more Armenian sources and per-feed caps.** 8 feeds added (News.am
  Russian, Factor.am, Aravot, 168.am, A1+, ArmInfo English, CivilNet and Hetq in Armenian), 123
  feeds in all, all working from GitHub. Two real runs: Armenia stories 1.6 per run before, 17
  and then 4 after; first-pass input tokens 31.9k -> 33.8k per run (+6%). None of the new Armenia
  stories would reach a digest under today's rules (they score 4-5). English links preferred in
  merges (owner). Details in `reports/step-07-armenia-sources.md`.
- **Step 8 done (2026-11-15): the dynamic digest.** Two scores per story (global and topic),
  bars 7/6, one message of at most 3,900 characters with a length cut, no maximum and no topic
  cap; the editor sees up to 90 new stories per call and makes a second call on a backlog;
  late-scored stories reach the next digest. 48 h replay: owner 5.0 stories per digest (2.3
  before), Armenia-only reader 3.0 (0.4), reader of all topics 3x a day 12.1 (5.7). One-off: 26
  rescore calls (439k in / 213k out) and 4 sandbox calls. Admin shows the average digest size.
  Details in `reports/step-08-dynamic-digest.md`.
- **Step 9 done (2026-11-15): reader languages.** Russian on (Mini App picker, bot, digests);
  Armenian and French built and approved on quality, hidden to save Gemini calls. Samples of 15
  real stories in three languages, four labelled previews sent; the owner checked the Russian Mini
  App on his phone and chose сводка for "digest". The owner reads English. Details in
  `reports/step-09-languages.md`.
- **Step 10 done (2026-11-15): translation hold and tips.** Untranslated stories wait for their
  translation instead of turning a digest English; "Support Axiom ⭐" voluntary Stars tips with
  /support, /paysupport, /terms and refunds from Admin. Details in
  `reports/step-10-translation-hold-and-stars.md`.
- **Step 11 done (2026-11-16): Ukraine wording, simpler tips, new digest design.** Russian says
  "на Украине" (prompt, check, topic name); tips 100/500/1000 for everyone, section always open;
  digests are rich messages in the owner's design "E5f" with a Settings button, in every language.
  Worker 185 tests, Python 119; 11 rules broken on purpose, all caught. Details in
  `reports/step-11-design.md`.
- **Step 12 done (2026-11-16): the Mini App redesign.** Three Settings designs went live on the TEST bot
  with an owner-only switch; the owner chose design 1 (iOS Settings). The switch and the other two
  are removed; Admin uses the same style. Details in `reports/step-12-settings-design.md`.
- **Step 13 done (2026-11-16, fixes 2026-11-17): custom topics ("My topics") and the AI budget
  guard**, on the TEST bot. After the owner's test: the card redesigned (emoji, switch, Edit), the
  switch, the custom-topic digest rule and a tighter editor prompt; Worker `c1f8c148`. Live: Japan
  and Australia searched hourly, about 3 to 6 stories a day each reach the owner. Waiting for the
  owner's check on his phone (message and a labelled preview digest sent 2026-11-17). Details in `reports/step-13-custom-topics.md`.
- **Step 14 done (2026-11-17): custom-topic relevance and the digest button.** A keyword rule in code
  keeps off-topic stories out of custom sections (the five non-Japan stories of the owner's
  06:00 and 09:00 Japan sections are excluded); non-events at 3-4; glossary spellings (Takaichi). Digest
  design unchanged after two rounds of previews; the Settings button under digests removed.
  Python 172 tests, Worker 225; 24 of 24 rules broken on purpose caught. Details in
  `reports/step-14-relevance-and-design.md`.
- Two users: the owner and one more (Russian).

## Next step
Watch the custom topics for a few days with the keyword rule (Step 14): stories under each custom
section (Admin: Custom topics), real stories the rule drops because no keyword fits (seen for
Australia: Chalmers, New South Wales), and Google's 429s. Keywords are written once and never
refreshed, so a new leader is missed until someone resets the topic's keywords. Then switch to the real bot @axiom_news_bot (new token and webhook, `setup-bot.mjs`, which also sets
the Russian command list, then invite the first users). Watch the first real Russian reader's
digests: the first hourly run after they choose Russian translates about 70 stories in one call;
Admin's "Languages" section shows calls, tokens, stories held for translation and full English
fallbacks. Admin's "Tips" section shows Stars received. Before that: a few days of real digests with the Step 8 rules, and a look at the
fold on an iPhone if any user has one.

## Known issues / open questions
- **Translations (Step 9):** the code checks catch numbers, names, alphabets and accents, not a
  wrong word or an odd sentence (French and Armenian samples had 2 and 3 such errors in 15;
  Russian almost none). A story that keeps failing a check is held from Russian readers until it
  passes or its 24 h end (Step 10); if it is the only story of a digest, that digest is English.
  Russian digests run about 7% longer, so on busy days a story or two
  fewer fits. No real Russian reader yet: the first live Russian run is still to be seen.
- **Gemini 503 overloads** were frequent on 2026-11-13; fallback runs are slow (Groq ~1
  chunk/min).
- **AI grouping is the weakest part:** some over-merged stories and near-duplicates. Guarded by
  prompt and code, but it needs watching.
- **Worker CPU is the tightest free limit** (10 ms). Watch Cloudflare's Metrics > Errors for
  `exceededCpu` once there are ~20 users.
- **Duplicates:** the word-based check misses some; the editor now merges most of the rest
  (14 merges in its first 45 candidates). The Step 8 replay still showed one pair in two windows
  ("Pashinyan plans three visits to Russia").
- **The editor decides what users see.** Its scores are whole numbers clustered at 5-6, so one
  point changes a digest a lot; it sometimes rates big off-topic stories high (the US flight
  ground stop got a 7). Step 8 topic scores: it still lifts some Armenia/Russia statements and
  ceremonies by 1-2 points (capped at 2 in code). Readers of all six topics get long digests
  (about 12 stories) on busy days. Watch the first week; the bars, caps and examples are config
  and prompt changes.
- **Fold limit checked on Android only.** iPhone and Telegram Desktop were not tested; the limit
  (3,900) is under the hard 4,096 anyway.
- **Rich messages (Step 11) are new (Bot API 10.1, June 2026)** and were seen only on the owner's
  Android phone. Telegram documents no per-platform support; it says outdated apps show an "update
  the app" placeholder for new features. A reader on an old app version would see that instead of
  the digest. Ask new users to update Telegram; if one cannot, switching `LAYOUT` back to `CLASSIC`
  in `worker/src/digest.js` is a one-line change.
- **Line emojis** from word rules (`config/line_emoji.json`) are now only a fallback for stories
  the editor did not write emojis for.
- **No usable feeds** from Reuters, AP (both blocked), Armenpress, 1lurer, Panorama, Shamshyan
  (none found), Arka, Mediamax (blocked from GitHub), Lragir (unreachable) or ISW (403).
- **Step 7 wrong merges:** Armenian/Russian articles are sometimes attached to a related but
  different English story (3 in the first run). The link stays right, but that news is lost as
  its own story.
- **News.am and 168.am** (now big Armenia suppliers) were linked by JAMnews (2021) to one
  opposition bloc; 168.am is tier 3 so it is linked last.
- **The Mini App design (Step 12)** was checked in headless Edge with a stand-in for Telegram and
  chosen by the owner on the TEST bot; not seen on an iPhone. Telegram clients older than 6.9 keep
  their own header colour (the page itself is unchanged).
- **Step 6 shadow step (paused):** if switched on again, its D1 rows (about 15-20k written a day) are not in
  Admin's "D1 today", and Google News feeds are for "personal, non-commercial use" per their own
  notice (owner to decide before adoption). Its old rows stay in `shadow_items` (its prune only runs
  when it is on).
- **Tips (Step 10):** the per-chat command list of a reader who picked Russian before Step 10 keeps
  the old two commands until they change language again (none exist yet). Telegram may ask the bot
  to handle disputes; Stars received can be withdrawn only through Telegram's own rules (not set up).
- **Keyword rule (Step 14):** keywords come from the AI once and are not refreshed. They can be dated
  (the first Japan answer had Kishida and Ishiba; the backfill now shows recent headlines) and
  incomplete: 4 real Australian stories of 24 h (all scored 2-4, none in a digest) were dropped for
  lack of a keyword. Resetting a topic's `keywords` to NULL makes the next run ask again (one call).
  There is no Admin editor for keywords yet.
- **Custom topics (Step 13):** Google answers 429 to about one search a run from GitHub since there
  are 2 topics (10 searches); the searches not yet started then wait an hour. Both topics still fill
  their cap of 8 most runs; with more topics, try fewer parallel requests (`search_workers` 8). If
  Google blocks us fully, custom topics get only what our RSS feeds have. Its headlines have no
  text, so the editor's descriptions are short and the fact guard has little to check against. How
  many custom stories a reader gets now rests on the editor's topic score alone (no cap): watch
  Admin; the levers are the prompt, a per-digest limit or a bar of 7 (owner). Gemini answered 503
  on about a third of the test checks (the fallback model or Groq answered; up to 14 s).
- **Admin "D1 today" for the Worker is a slight undercount** (counts of short-lived Worker instances
  that end between ticks are lost). The job's numbers are exact and are most of the total.
