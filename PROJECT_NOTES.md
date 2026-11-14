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
- **Digests per user** at chosen local times: defaults 09:00/14:00/20:00, top 7, daytime only,
  time zone auto-detected. Building a digest is a database filter with no AI. The message is a
  greeting line plus numbered one-line stories with source links, or a short "quiet period"
  note. The same story is never sent to a user twice.
- **Topics:** Politics, Wars & Conflicts, Armenia, Russia, Iran war, Ukraine war. English only,
  designed so Russian can be added later.
- **Telegram Mini App settings:** topics, times, number of stories, pause. An Admin tab, visible
  only to the owner, shows stats, errors and AI usage, plus a "Send me a digest now" button.
- **AI:** Gemini free tier, falling back to Groq; if both fail, items wait an hour. Target is
  about 24-50 calls/day in total, independent of user count.
- **Hosting:** GitHub Actions hourly job, plus Cloudflare Worker + D1 (webhook, Mini App API,
  static Mini App, digest cron).
- **Not in v1:** payments, ads, multiple languages, user-added sources, instant alerts, channels.
- **Digest format (owner, Step 3): format B.** Greeting line, then the stories grouped under bold
  topic headings with the topic emoji (`<b>🇺🇦 Ukraine War</b>`), numbered inside each group:
  `N. <context emoji> <b>headline</b>` and `Source: <linked outlet>`, blank line between stories.
  The context emoji is the flag of the first country/leader/group the headline names, else a
  subject icon, else the topic emoji (`config/line_emoji.json`). HTML, link previews off, never an
  em dash. At most 40% of a digest from one topic; near-duplicates removed.

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
- The owner is the only user.

## Next step
Owner tries the Mini App on his phone (list in the Step 4 report). Then Step 5: switch to the
real bot @axiom_news_bot (new token and webhook, `setup-bot.mjs`, then invite the first users).

## Known issues / open questions
- **Gemini 503 overloads** were frequent on 2026-11-13; fallback runs are slow (Groq ~1
  chunk/min).
- **AI grouping is the weakest part:** some over-merged stories and near-duplicates. Guarded by
  prompt and code, but it needs watching.
- **Worker CPU is the tightest free limit** (10 ms). Watch Cloudflare's Metrics > Errors for
  `exceededCpu` once there are ~20 users.
- **Duplicate check is word-based:** it misses duplicates worded very differently (e.g. two lines
  on the same Abu Dhabi talks) and rarely merges two different stories.
- **Line emojis are word rules,** not AI: the first actor named wins, so "Russian strike on
  Zaporizhzhia" gets the Russian flag. Edit `config/line_emoji.json` to add names.
- **No usable feeds** from Reuters, AP (both blocked), Armenpress (none found) or ISW (403).
- **The Mini App was only seen in a desktop browser with a stand-in for Telegram.** Real iPhone and
  Android rendering, haptics and the MainButton still need the owner's eyes.
- **Admin "D1 today" for the Worker is a slight undercount** (counts of short-lived Worker instances
  that end between ticks are lost). The job's numbers are exact and are most of the total.
