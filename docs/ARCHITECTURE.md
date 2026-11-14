# Architecture

Status: designed in Step 1, updated in Steps 2, 3 and 4 (2026-11-14). Running in the cloud since
Step 3, still on the TEST bot: the hourly job on GitHub Actions (public repo
`RobBudaghyan/axiom-news`), the D1 database, and the Worker `axiom-news` (webhook, digest cron,
hourly job trigger, alerts, and since Step 4 the Mini App and its API, §4a).

## 1. Components

```
   Worker cron "7 * * * *" ──workflow_dispatch──┐   (backup: GitHub schedule at :37,
                                                ▼    skips if a run started < 45 min ago)
 ┌─────────────────────────────────────────────────────────┐
 │ HOURLY JOB  (Python, ~2 min, then the VM is gone)        │
 │ 1. fetch ~115 RSS feeds (config/sources.yaml)            │
 │ 2. drop already-seen URLs, keep <= 8 newest per feed     │
 │ 3. AI pass, usually ONE call: group, tag, score, write   │
 │    (Gemini -> 2nd Gemini model -> Groq -> else pending)  │
 │ 4. write stories to D1, mark near-duplicates (dup_group),│
 │    prune old rows (daily)                                │
 └───────────────┬─────────────────────────────────────────┘
                 │ HTTPS: Cloudflare D1 REST API (scoped token)
                 ▼
        ┌─────────────────┐
        │   D1 database    │  story pool, users, sent log, stats
        └───────┬─────────┘
                │ D1 binding (inside Cloudflare)
 ┌──────────────┴──────────────────────────────────────────┐
 │ CLOUDFLARE WORKER  (JavaScript, one Worker)              │
 │ • POST /telegram   bot webhook (/start, /settings, help) │
 │ • cron */5 min     send due digests (<= 8 users/tick),   │
 │                    check job health, alert the owner     │
 │ • cron 7 * * * *   start the hourly GitHub job           │
 │ • /app/            Mini App files (static assets, free)  │
 │ • /api/*           Mini App API (initData checked)       │
 └──────────────┬──────────────────────────────────────────┘
                │ HTTPS: Telegram Bot API (sendMessage)
                ▼
            Telegram users (~20)
```

There is no server running 24/7. GitHub provides a short-lived VM each hour, and Cloudflare runs
the Worker only when a request or cron tick arrives.

## 2. Languages and why

| Part | Language | Why |
|---|---|---|
| Hourly job (GitHub Actions) | **Python 3** | `feedparser` is the most forgiving RSS parser available. It handles broken XML and odd encodings such as windows-1251 in Russian feeds without extra code. Python is already on the owner's PC and is what the old project and advisor know. Heavy work like XML parsing for 116 feeds stays out of Cloudflare's 10 ms CPU budget. |
| Worker + Mini App | **JavaScript** (ES modules, no build step, no framework) | Cloudflare Workers run JS natively; Python Workers exist but start slower and use more of the CPU limit. The Mini App runs in Telegram's browser view, so it has to be HTML/CSS/JS anyway. |

The two halves share **data, not code**. Both read the D1 schema (`db/schema.sql`). The job reads
`config/*.yaml` and syncs the topic list into D1, and the Worker reads topics from D1. Each piece
of logic lives in exactly one language:
- **Digest selection, topic cap, format and time slots:** `worker/src/digest.js` only. The Worker
  and the local tool `worker/scripts/digest-cli.mjs` both import it, so they pick and format
  exactly the same way.
- **Near-duplicate grouping:** `job/dupes.py` only. It runs in the job because the job has no CPU
  limit (see §8); the Worker reads the result (`stories.dup_group`).
- **Shared settings:** `config/digest.json` is read by both (format, story count, 40% cap,
  dedupe threshold, users per tick).

Tools: Node.js 26 LTS and `wrangler` (pinned in `worker/package.json`) deploy the Worker;
`gh` manages the GitHub repo and its secrets.

## 3. Data flow

1. **Collect.** The job fetches all feeds in parallel (10-15 s for 116 feeds). For each entry it
   computes `url_hash = sha256(normalized link)` (lower-case host, no `#fragment`, no `utm_*`
   and similar tracking parameters). Only entries published inside a **lookback window** count:
   back to the last run's start minus 1 h, clamped to 2-24 h (3 h on the very first run). URLs
   already in `items` are skipped, and at most **8 newest unseen entries per feed per run** are
   kept. This stops the very high-volume Russian state agencies (TASS ~1,600/day, RIA ~1,200/day)
   from swamping the batch. Each kept entry becomes an `items` row with `status='pending'`, the
   title, and a snippet of about 200 characters with HTML stripped. Pending items left over from
   failed earlier runs are included again; after 24 h they become `expired`.
2. **AI pass (one call per hour for everyone, more only for a backlog).** Input: all pending
   items, plus the stories created or updated in the last 24 h (newest 250) so the model can
   attach a new item to an existing story. Existing stories are shown as `S<id>` and items as
   plain numbers, because with plain numbers for both the model once put item 46 into story 46.
   Prompt: `prompts/story_batch.md`. Output: a list of stories (each with `item_ids`, `topics`,
   `importance` 1-10, a one-line English `summary`, and an optional `existing_story_id`), plus
   `not_news_ids`. **Every item must be accounted for**, either in a story or in not-news.
   A normal hour (~230 items, about 23k tokens) fits one Gemini call. A bigger backlog is split
   into chunks of about 25k estimated tokens, and each chunk's stories are written before the
   next chunk, so later chunks can merge into them.
   **Answer checks** (lesson 2):
   - An error, or an empty, blocked or invalid answer, is a failure, never "no news".
   - An answer that covers none of its items, or puts fewer than 10% of 20+ items into stories,
     is retried once and then handed to the next provider. Step 2 saw one answer place 0 of 435.
   - A cut-off answer, or one that is too large for Groq, splits the chunk in two.
   - An answer that skips more than 10% of its items is kept, and only the skipped items are sent
     again (once, then to the next provider).
3. **Best link** is chosen in code rather than by the AI. Among a story's items:
   1. An item whose English title shares no word with the story summary ranks last. This catches
      an item the AI put in the wrong story (seen once: a DraftKings article in a strike story).
   2. Then the lowest `tier` (1 = most prestigious) wins.
   3. Then the earliest published.

   As a side effect, within one tier an English article beats Russian-language copies of the same
   news, because the non-English copies can't be checked against the summary. Paywalled outlets
   are fine.
4. **Write.** Stories and item updates go to D1 in batched REST calls; a D1 batch is
   all-or-nothing (checked 2026-11-13). Old rows are deleted **once a day**, not every hour, to
   save D1 rows read: items and stories after 7 days, and log rows after 30 days.
5. **Near-duplicates (job, Step 3).** After the AI pass, `job/dupes.py` groups near-duplicate
   stories of the last 24 h (importance >= 4) without AI. Each summary becomes a set of content
   words (lower case, no accents, no stop words, 5-letter stems), weighted by rarity (IDF) over
   the pool. Similarity is the shared weight over the smaller line's weight. Walking in digest
   rank order, a story scoring >= 0.45 against an earlier group leader joins its group, so the
   more important line is the one shown. Only changed rows are written. Tuned on 365 real
   stories on 2026-11-13: catches about 16 of 23 hand-labelled duplicates and wrongly merged
   2 of 24 hard look-alikes. Giving names extra weight was tried and rejected, because it merged
   different stories about the same person.
6. **Digests.** The Worker cron runs every 5 minutes and takes up to 8 users whose
   `next_digest_at <= now` (earliest first; the rest go at the next tick). For each user:
   1. **Candidates (SQL):** on one of their topics, `importance >= 4`, created or updated since
      the last digest (at most 24 h back), **not in `sent`**, most important first, then most
      recent; at most 40.
   2. **Pick (JS, `pickStories`):** skip a story whose `dup_group` was already taken. Count each
      story against its **most specific topic** among the user's topics (order in
      `config/digest.json`: ukraine_war, iran_war, armenia, russia, wars_conflicts, politics). No
      topic may exceed `max(1, ceil(0.4 x N))` stories (3 of 7). If the cap leaves empty slots
      and nothing else qualifies, they are filled with the next most important stories.
   3. Send one Telegram message, then write `sent` rows, `last_digest_at` (the slot time) and
      the next `next_digest_at`.

   Building a digest makes no AI call.

### Digest message format (Step 3, owner's choice of the old project's style)

Format **B** (the default since the owner chose it, `"format": "B"` in `config/digest.json`):
```
Good evening. Since 14:00, 7 stories on your topics:

<b>🇺🇦 Ukraine War</b>
1. 🇷🇺 <b>Headline, one short sentence</b>
Source: <a href="...">Outlet</a>

2. 🇺🇸 <b>...</b>
Source: <a href="...">Outlet</a>

<b>🏛️ Politics</b>
1. 🇫🇷 <b>...</b>
Source: <a href="...">Outlet</a>
```
Groups are the topic each story counts against, ordered by each group's best story, numbered
from 1 inside each group. Format **A** is the same lines as one flat numbered list. Both use HTML
parse mode with link previews off.

**Line emoji** (`"line_emoji": true`, rules in `config/line_emoji.json`, code `lineEmoji` in
`digest.js`):
1. the flag of the **first** country, leader, capital, region or group the headline names
   (case-sensitive whole words and phrases up to 4 words, possessives allowed:
   "Donald Trump's envoys..." gets 🇺🇸, "Houthis..." 🇾🇪, "EU leaders..." 🇪🇺, NATO 🛡️, the ICC ⚖️);
2. otherwise the first subject icon: 🕊️ talks/ceasefire, ☢️ nuclear, 💥 strikes, 🗳️ elections,
   ⚖️ courts/arrests, ⚡ energy, 🛢️ oil/gas, 🌊 disasters, 🌍 climate, 💰 economy, 💻 tech;
3. otherwise the topic's emoji.

On 400 real headlines (2026-11-14): 378 flags, 17 subject icons, 5 topic fallbacks. It is a
dictionary lookup (a regex over the ~700 words cost 3.6 ms just to build), under 1 ms to set up
per Worker instance and ~25 µs per line. Rule-based, so "Russian strike on Zaporizhzhia" gets the
Russian flag (the actor), not the Ukrainian one (the place).

- **No em dash anywhere.** The job replaces any em or en dash the AI writes, the digest code
  cleans headlines again, and it refuses to send a message that still contains one.
- **Length.** Telegram's 4,096 limit counts the text after HTML parsing (tags and link URLs do
  not count). The code measures it that way, in UTF-16 units, against a budget of 4,000. If a
  message is too long, the lowest-ranked stories are dropped (the header count follows), and a
  single over-long headline is cut at a word with "...". The 15 longest real headlines came to
  about 2,600 visible characters (raw HTML ~4,500), so trimming should not happen in practice.

- **The header** depends on history. A first digest, or one after more than 24 h, says "In the
  last 24 hours, N stories on your topics:" instead of "Since HH:MM".
- **The quiet note.** If no story qualifies, the user gets one short line: "Good afternoon.
  Quiet period: nothing important on your topics since 09:00."
- **The greeting** depends on the local hour: morning before 12:00, afternoon until 18:00,
  evening after that.

**Never twice:** `sent` has primary key `(user_id, story_id)`, and stories are filtered against it. If
a story gains new sources after it was sent, it is still never sent again.

## 4. Time zones and scheduling

- Each user has `timezone` (IANA name, e.g. `Asia/Yerevan`) and `digest_times`, a list of local
  `"HH:MM"` values in 30-minute steps between 07:00 and 22:00 ("daytime only"). The defaults are
  09:00, 14:00 and 20:00.
- **Auto-detection:** every time the user opens the Mini App, it sends
  `Intl.DateTimeFormat().resolvedOptions().timeZone` from their device (`POST /api/open`).
  Telegram's user data does not include a time zone; the official Mini App docs list only id,
  name, username, language, premium and photo. `users.tz_detected` says where the zone came from:
  0 = the default (`Asia/Yerevan`, before the first open), 1 = the device, 2 = chosen by hand in
  the app. With 0 or 1 the device zone is saved on every open, so the zone follows the phone when
  the user travels; with 2 it is kept, and the app offers "Use it" if the phone's zone differs.
  `/start` creates the user with the defaults (all default topics, 09:00/14:00/20:00,
  `Asia/Yerevan`, 7 stories) and replies with a plain-English welcome naming the times, the next
  digest and an "Open settings" button. Opening the app before `/start` creates the same row.
  `/settings` replies with the same button. Any other message gets a short reply with the times
  and the next digest.
- `next_digest_at` is stored as a UTC timestamp. After each send, or after a settings change, the Worker
  computes the next local slot in the user's zone and converts it to UTC with `Intl`. This handles
  daylight-saving changes automatically. One exception on a settings change
  (`nextDigestAfterChange`, `src/settings.js`): a digest whose slot passed less than 15 minutes
  ago and that the 5-minute tick has not sent yet is kept, so saving a setting at 14:02 does not
  swallow the 14:00 digest. Pausing drops it; resuming starts at the next slot.
- **Why the Worker cron sends digests instead of GitHub:** GitHub documents that scheduled runs
  "can be delayed during periods of high loads" and that at high load "some queued jobs may
  be dropped", and the start of every hour is a known peak. Cloudflare cron is a separate, cheap
  trigger, and 288 runs a day is nothing against the request limit.
- **Expected delay:** a digest goes out at the first 5-minute tick at or after the chosen time, so
  0-5 minutes late. Cloudflare does not publish an accuracy figure, so add a little more for
  that. **At most 8 users per tick** (CPU limit, see §8): with ~20 users all at 09:00, the
  first 8 get it at about 09:00, the next 8 at 09:05 and the rest at 09:10.
- **A failing send** (not a block) is logged to `errors` and retried at the next tick; if the
  slot is more than an hour old it is skipped to the next slot. Telegram 403 (user blocked the
  bot) sets `blocked = 1`; `/start` clears it.
- **The hourly job is started by the Worker** (cron `7 * * * *`, GitHub `workflow_dispatch`
  with a fine-grained token limited to this repo, Actions read/write). A backup GitHub schedule
  at :37 (`backup-schedule.yml`) calls the same workflow with `--min-gap-minutes 45`, so it does
  nothing when the :07 run happened. Only one run at a time (job-level concurrency group
  `hourly-job`); a dispatched run also skips if another started in the last 20 minutes. The
  backup lives in its own file because GitHub disables scheduled workflows in a public repo after
  60 days without commits, and that must never disable `hourly.yml` itself.
- **Content freshness:** the pool updates once an hour, at about :07-:09. A story is typically
  in the pool 10-70 minutes after the outlet publishes it.
- **Health alerts** (every 5-minute tick, `src/health.js`): the owner gets a short Telegram
  message if the newest finished run is `error`/`ai_failed`, a run is stuck in `running` for
  30+ minutes, there was no `ok`/`partial` run in 3 hours, or the GitHub dispatch failed. At most
  one alert per 3 hours, and the same failed run is never reported twice (`meta` table).
- Pause: `paused=1` skips the user. When they resume, the next digest covers at most the last 24 h.

## 4a. The Mini App (Step 4)

**Files.** `worker/public/app/` holds `index.html`, `app.css` and `app.js`: plain HTML, CSS and
JavaScript, no framework, about 64 KB before compression (20 KB gzipped). Cloudflare serves them
as static assets (free and unlimited) before the Worker code runs, at
`https://axiom-news.axiom-news-worker.workers.dev/app/`. Cache rules (lesson 12):
`public/_headers` sends `Cache-Control: no-store` for the page, and the page loads
`app.css?v=<hash>` / `app.js?v=<hash>`. `npm run stamp` (`scripts/stamp-app.mjs`, also run by
`npm run deploy`) writes the content hash; a test fails if it is stale. No wildcard rule under
`/app/`, because Cloudflare merges every matching rule and would mix two Cache-Control values.
The page also gets a Content-Security-Policy: scripts only from itself and telegram.org, API
calls only to itself.

**Look.** iOS-Settings style: grouped rounded sections on Telegram's `secondary_bg_color`, rows on
`section_bg_color`, text and hints from the theme, so light and dark both follow Telegram.
One fixed brand accent `#2f7bf6` for switches, buttons and links (lesson 13: never Telegram's
`button_color`/`link_color`). System font, 17 px rows, safe-area insets
(`--tg-safe-area-inset-*`, `--tg-content-safe-area-inset-*`), subtle 0.25-0.35 s transitions,
honouring "reduce motion". Telegram haptics on taps (selection on toggles, light impact on
buttons, success/warning/error on results). The BackButton closes a sub-screen; the MainButton
(in the accent colour) confirms "Add 18:30" on the time picker. The header and background are set
to the theme's secondary colour, and vertical swipes are disabled so scrolling never closes it.

**Settings tab (everyone).** Next digest card ("Today at 14:00", or "Paused"); topics (switches
with emoji, at least one); digest times (remove; add from a 07:00-22:00 grid in 30-minute steps;
1 to 5 times); stories per digest (stepper 3-15); format B "By topic" or A "Simple list" with a
small drawing of each; time zone (city and GMT offset, a search over every IANA zone, a short
"Popular" list); pause. Every change is saved at once (`POST /api/settings`, one request at a
time, the stepper waits 0.45 s for more taps) and confirmed with a small "Saved" toast; on an
error the change is undone and the reason shown.

**Admin tab (owner only).** Visible only when the API says `is_owner`; every admin call is
checked again on the server (403 otherwise). One D1 batch (`src/admin.js`, aggregates done in
SQL) gives:
- health: last run (time, status, duration, providers), last successful run, whether the hourly
  trigger is on time (a run started in the last 70 minutes), the last alert in 24 h
  (`meta.last_alert_text`, new);
- pipeline for 24 h / 7 days: runs, articles, new items, stories created/merged, dropped, AI
  calls, tokens, failed runs, runs that needed a backup model; and AI calls per model;
- feeds: failing feeds (with the reason in plain words and since when) and silent feeds (no new
  item for 48 h), from `meta.feed_health`, which the job writes each run (one row: per feed the
  last success, newest entry date, current error and how many runs in a row);
- users: total/active/paused/blocked and a list (name, zone, times, last digest);
- the last 50 errors; D1 rows today against the free limits: the job's exact counts
  (`job_runs.d1_rows_read/_written`, from D1's own per-query meta) plus the Worker's, which the
  binding adds up and every cron tick writes to `meta.d1_worker` (instances that end between
  ticks lose their count, so this part can be slightly low);
- two buttons, each behind a Telegram confirm popup: "Send me a digest now" (a real digest from
  the current pool, recorded in `sent` like a scheduled one) and "Run news job now" (GitHub
  dispatch; refused with the time it becomes possible if a run started less than 20 minutes ago,
  or one is still running).

**API** (`src/api.js`; every request `Authorization: tma <initData>`):

| Route | What | CPU on Cloudflare (2026-11-14) |
|---|---|---|
| `POST /api/open` `{tz}` | create the user if new, save the device zone, return settings | 3-6 ms (6 = cold start) |
| `POST /api/settings` | validate (`src/settings.js`), save, recompute `next_digest_at` | 1-5 ms |
| `GET /api/admin` | owner only: everything above | 0-3 ms; 2 ms with real health data for all 115 feeds (4 calls) |
| `POST /api/admin/digest`, `/run-job` | owner only: the two buttons | not run against production by me |

**Bot.** `/start` and `/settings` carry an inline "Open settings" `web_app` button. The chat menu
button (next to the message box) opens the app for every user; it and the command list are set
once with `node scripts/setup-bot.mjs` (run again after switching to the real bot).

**Local preview and checks** (no Telegram, no real data): `node scripts/dev-server.mjs` runs the
real API code over an in-memory database with invented demo users and a stand-in for Telegram's
script (`scripts/dev/mock-telegram.js`). `node scripts/screenshots.mjs` renders it in headless
Edge at 390 px, light and dark, user and admin (`docs/screenshots/`). `node scripts/ui-check.mjs`
taps through every setting and both admin buttons and checks the saved values (23 checks).
`node scripts/api-check.mjs` checks the LIVE API with initData signed by the bot token from
`.env`.

## 5. Database (Cloudflare D1, SQLite)

| Table | Key columns | Notes |
|---|---|---|
| `users` | `id` (Telegram user id) PK, `first_name`, `language`, `timezone`, `tz_detected` 0/1/2, `digest_times` JSON, `max_stories` (default 7, range 3-15), `topics` JSON, `paused`, `blocked`, `created_at`, `last_digest_at`, `next_digest_at`, `format` (Step 4: `A`/`B`, NULL = config default) | index on `next_digest_at`. `blocked=1` when Telegram returns 403 because the user blocked the bot. `tz_detected`: 0 default, 1 device, 2 chosen by hand (§4) |
| `topics` | `tag` PK, `label_en`, `emoji`, `sort`, `is_default` | synced from `config/topics.yaml` by the job, read by the Worker |
| `items` | `id` PK, `url_hash` UNIQUE, `source_key`, `source_name`, `tier`, `url`, `title`, `snippet`, `published_at`, `fetched_at`, `status` (pending/done/dropped/expired), `story_id` | index on `status`; pruned after 7 days |
| `stories` | `id` PK, `summary`, `topics` JSON, `importance`, `best_url`, `best_source`, `best_tier`, `best_published_at`, `source_count`, `created_at`, `updated_at`, `dup_group` | index on `updated_at`; pruned after 7 days. `best_tier`/`best_published_at` let a merge update the link without re-reading items. `dup_group` (Step 3) = id of the near-duplicate group's leader, written by the job |
| `meta` | `key` PK, `value` | Worker: `last_alert_at`, `last_alerted_run_id` (Step 3), `last_alert_text`, `d1_worker` (its D1 rows today, Step 4). Job: `feed_health` (Step 4, one JSON row) |
| `sent` | (`user_id`, `story_id`) PK, `sent_at` | the "never twice" guarantee; pruned with stories |
| `job_runs` | `id`, `started_at`, `finished_at`, `status` (running/ok/partial/ai_failed/error), counts, `provider`, tokens, `pruned`, `error`, `d1_rows_read`, `d1_rows_written` (Step 4) | Admin tab |
| `ai_calls` | `id`, `at`, `provider`, `model`, `ok`, `input_tokens`, `output_tokens`, `ms`, `error` | Admin tab: AI usage |
| `errors` | `id`, `at`, `component` (job/worker), `message` | Admin tab: recent errors |

`sent` is the only per-user table besides `users`, and deleting a user must also delete their `sent`
rows (lesson 16 in LESSONS.md). Indexes are kept to a minimum because every index update counts as
an extra "row written" on D1. Times are INTEGER unix seconds. The schema is `db/schema.sql`,
applied with `scripts/apply_schema.py` through the REST API; columns added to existing tables
are listed in that script's `MIGRATIONS` (an `ALTER TABLE` whose "duplicate column" error is
ignored). The owner created the database (`axiom-d1`) in the dashboard. Note that the REST API
passes numbers as REAL, so INTEGER columns convert them back.

## 6. Security: how the parts talk

| Link | Protection |
|---|---|
| GitHub job → D1 | Cloudflare D1 REST API `POST /accounts/{id}/d1/database/{id}/query`, using an API token limited to **D1 Edit** permission only. Stored as a GitHub Actions secret. The job only connects outward; nothing can call into it. |
| Telegram → Worker webhook | registered with a `secret_token`. The Worker rejects any request whose `X-Telegram-Bot-Api-Secret-Token` header doesn't match `TELEGRAM_WEBHOOK_SECRET`. |
| Mini App → Worker API | every request carries Telegram's `initData` (`Authorization: tma ...`). The Worker checks it the official way (`src/auth.js`: secret key = HMAC-SHA256 of the bot token with key `"WebAppData"`; the hash must equal the HMAC of every other field, sorted, as `key=value` lines), compares in constant time, and rejects data older than 24 h or dated in the future (`auth_date`). The user id comes only from verified data; the body can never name a user. Wrong data gets 401 "Please close and reopen the settings from the bot." |
| Admin tab / admin API | shown only when the verified user id equals `OWNER_TELEGRAM_ID`. Hiding the tab is cosmetic; the API checks the id on every admin call and answers 403 to anyone else (tested for all three admin routes, and against the live Worker). |
| Mini App page | served with a Content-Security-Policy (scripts from itself and telegram.org only, API calls to itself only), `nosniff`, no referrer. All text from the database is HTML-escaped before display. |
| Worker → GitHub | fine-grained personal access token: only `RobBudaghyan/axiom-news`, only "Actions: read and write", no expiration (owner's choice, 2026-11-13). It can start workflows; it cannot read or change code or secrets. A Worker secret. |
| Secrets | `.env` locally (gitignored). In production: GitHub Actions secrets (`GEMINI_API_KEY`, `GROQ_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `CLOUDFLARE_D1_TOKEN`) and Cloudflare Worker secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `OWNER_TELEGRAM_ID`, `GITHUB_DISPATCH_TOKEN`). Each side holds only what it needs. The job never sees the Telegram token, and the Worker never sees the AI keys. Values are copied from `.env` by `scripts/set_secrets.py` through stdin, never printed. |
| Public repo | `scripts/scan_secrets.py` checks every `.env` value and common token shapes against the whole git history and every file before a push (run on its own, never piped). GitHub push protection is on. Commits use the owner's GitHub noreply address. The D1 database id is committed on purpose in `worker/wrangler.toml` (wrangler needs it; it grants nothing without the D1 token). |
| Data sent to AI | only public news titles and snippets. No user data ever goes to an AI provider. This matters because Gemini's free tier states content is "used to improve our products". |

## 7. AI design, budget and fallback

**Primary: Gemini free tier**, using a key from a Google project with no billing account. Model:
`gemini-3.5-flash-lite`, listed as Stable and "Free of charge" on the official pricing page
(checked 2026-11-13). `gemini-2.5-flash` is deprecated and gets re-routed on 2026-12-01, so we avoid
it. The model is set by `GEMINI_MODEL` so it can be swapped without a code change (lesson 1).
**Second Gemini model:** `gemini-3.1-flash-lite` (`GEMINI_FALLBACK_MODEL`) is tried before Groq.
On 2026-11-13 the primary model returned HTTP 503 "high demand" on about half of all calls, and
an overload like that is per model.

**Measured on 2026-11-13 (real calls with the owner's key):**
- **Model check.** `gemini-3.5-flash-lite` is in the model list (version `3.5-flash-lite-07-2026`)
  and answered a small real call. `thinkingLevel: low` is accepted, and no thought tokens were
  reported.
- **A real hourly batch fits in one call.** 230-233 new items plus 250 existing-story stand-ins
  came to 87-90k characters and **23.1-23.6k input tokens** by `countTokens`, close to the Step 1
  estimate of ~26k. The free tier accepted it in one call; size never caused a 429. The first
  run's 435 items (29.1k tokens) were also accepted.
- **Output is much bigger than planned:** **11-18k tokens** instead of 3-4k, because the model
  writes 120-200 stories plus the not-news list. One call takes **45-85 s**.
- **Failures seen, all now handled:**
  - HTTP 503 "This model is currently experiencing high demand" on about half of ~20 calls,
    sometimes several in a row.
  - One degenerate answer: 0 of 435 items placed.
  - Answers to 500+ item chunks that covered only 30-40% of the items.
- **Limits are still not published.** Google shows per-model TPM/RPD only in AI Studio. A
  29k-token call, and about 10 calls within one hour, went through without a rate-limit error.

**Budget math (measured volume):**
- Raw volume across the 116 feeds is about **8,900 items/day**. Most of it comes from TASS, RIA,
  Rossiyskaya Gazeta, Izvestia, RBC, Interfax, Trend and Anadolu.
- With the 8-per-feed-per-run cap, a normal hour brings about **70-230 new items**. The first
  run, looking back 3 h, brought 435.
- Normal operation is **24 calls/day**, one per hour regardless of user count: about 0.55M input
  and 0.35M output tokens/day. Only a backlog makes 2-4 calls in one run, in chunks of about 25k
  estimated tokens.
- If the cap proves too low or too high, it is one number in config. Lowering it to 5 per feed
  gives about 3,800 items/day.

**Fallback: Groq free plan** (`openai/gpt-oss-120b`).
- **Limits read from Groq's response headers on 2026-11-13:** **1,000 requests/day and 8,000
  tokens/minute.** The other chat models on the account (`openai/gpt-oss-20b`,
  `qwen/qwen3.8-27b`) have the same 8,000 TPM. Tokens per day is not in the headers; the docs
  say 200,000.
- **The 8,000 counts the prompt plus the reserved reply room** (`max_completion_tokens`):
  - A full batch was refused with HTTP 413 ("Requested 22239").
  - Chunks of 5k estimated tokens plus 3k reply room were refused at 8,162-8,277.
  - Chunks of 5k plus 3k reply room got cut off.
- **Chunks now:** about 3.5k estimated prompt tokens (~30 items plus the newest 30 existing
  stories) and 3.5k reply room. A chunk takes ~6 s, of which ~1.4k tokens are the model's own
  reasoning. The next chunk must wait for the per-minute window, so the pace is **about one chunk
  per minute**.
  - A short 429 is waited out.
  - A 413 or a cut-off answer splits the chunk.
  - Each chunk's stories are written before the next one, so duplicates across chunks still
    merge.
- **At most 8 Groq chunks per run** (~240 items, ~8 minutes). A normal hour fits; a bigger
  backlog leaves the rest pending for the next run. 200k tokens/day is about 28 chunks, or 3-4
  full fallback hours a day.
- **Calls per day:** normally 24. On a day when Gemini is overloaded, the retries, the second
  model and Groq chunks can bring this to roughly 60-80 calls, above the spec's 24-50 target.
  All of these are free calls.
- **If every provider fails**, items stay `pending` and go into the next run (they are kept up to
  24 h, then `expired`). An empty or safety-blocked response counts as a failure, never as "no
  news" (lesson 2).

Other free options checked and **rejected** (2026-11-13):
- **Cerebras:** only a one-time $5 credit that "expires 30 days after activation" and requires a
  payment method.
- **Mistral:** the current docs say API use needs billing activation.
- **OpenRouter `:free` models:** they need no card and allow 20 RPM, but only **50 requests/day**
  without buying credits, and free-model availability changes often. This is a possible third fallback
  later, but it is not in v1.

## 8. Free-tier limits we rely on (verified 2026-11-13 from official docs)

| Service | Limit | Our expected use | Source |
|---|---|---|---|
| Workers Free | 100,000 requests/day | < 1,000/day (288 cron ticks, plus webhook and Mini App calls) | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Workers Free | **10 ms CPU** per HTTP request and per Cron Trigger. Waiting on D1/fetch does not count. "Each isolate has some built-in flexibility" for infrequent overruns; consistent overruns are terminated (error 1102, `exceededCpu`) | **measured on Cloudflare 2026-11-13** (`wrangler tail` cpuTime): idle tick 4 ms; tick with 1 due user 6 ms; 20 users 10-27 ms; 40 users 46 ms. Hence **8 users per tick** (≈6-12 ms) and dedupe moved into the job. **Mini App API, measured 2026-11-14:** open 3-6 ms, save 1-5 ms, admin data 0-3 ms, 2 ms with all 115 feeds' health (see §4a) | same |
| Workers Free | 50 subrequests per invocation (D1 calls and `fetch` count) | per cron tick: 1 batched read, 1 batched candidate read, 1 Telegram call per user, 1 batched write (+1 alert): about 12 with 8 users | same; [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) ("a `db.batch()` call counts as one query") |
| Workers Free | 5 Cron Triggers per account | 2 (`*/5 * * * *`, `7 * * * *`) | Workers limits |
| Workers static assets | "Requests to static assets are free and unlimited" | Mini App files | [Static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) |
| D1 Free | 5M rows read/day, 100k rows written/day, 5 GB total, 500 MB per DB; resets 00:00 UTC; when a limit is hit, queries fail until reset | writes about 35k/day (items ~4.6k × ~3 including index rows, stories, sent, plus deletes from pruning); reads well under 0.5M/day with indexes; DB < 50 MB with 7-day pruning | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 | 100 bound parameters per query, 100 KB per SQL statement | the job batches inserts to stay under both | D1 limits |
| Cloudflare API | 1,200 requests per 5 min per user | about 10-20 REST calls per hourly run | [API limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/) |
| GitHub Actions | **public repo: standard runners free and unlimited** (our case since Step 3). Private repos: ≈2,000 included min, blocked (never billed) when used up | first run on GitHub: 2 min 0 s (job 114 s, a 2.5 h backlog of 342 items). About 24-25 runs/day | [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) |
| GitHub Actions schedule | minimum every 5 min; can be delayed or dropped under load; runs on the default branch only; **public repos: schedules auto-disabled after 60 days without repo activity** | backup only, at :37, in its own workflow file; the main trigger is the Worker | [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) |
| Gemini free tier | per-model limits shown in AI Studio only; RPD resets at midnight Pacific; free-tier content is used to improve Google's products. Measured 2026-11-13: 29k-token calls accepted, frequent 503 "high demand" | 24 calls/day, about 23k input + 15k output tokens each | [Rate limits](https://aistudio.google.com/docs/rate-limits), [Pricing](https://aistudio.google.com/docs/pricing), [Models](https://aistudio.google.com/docs/models) |
| Groq free | gpt-oss-120b: 1K RPD and 8K TPM read from response headers 2026-11-13 (TPM counts prompt + reserved reply); 200K TPD per docs | fallback only, ~1 chunk/min | [Groq rate limits](https://console.groq.com/docs/rate-limits) |
| Telegram Bot API | ≤ 1 message/sec per chat; about 30 messages/sec bulk; 4,096 characters per message | ≤ 20 users per tick, 1 message each | [Bots FAQ](https://core.telegram.org/bots/faq) |

Repo visibility: **public** (owner's decision in Step 3, changed from private), for unlimited free
Actions minutes. The 60-day schedule auto-disable no longer matters for the main trigger, because
the Worker starts the job through the API; only the backup schedule can be disabled, and the
Worker's health alert would report missing runs.

## 9. Repository layout

```
config/topics.yaml, config/sources.yaml   shared data (Step 1)
config/digest.json                        digest settings read by the Worker and the job (Step 3)
prompts/story_batch.md                    AI prompt template (Step 1)
db/schema.sql                             D1 tables (applied via REST: scripts/apply_schema.py)
job/                                      Python hourly job: config, fetch, ai, d1, dupes, run
tests/                                    unittest suite for the job and the dupes grouping
scripts/check_feeds.py                    feed health check (--all re-tests disabled feeds)
scripts/ai_probe.py                       real batch-size test for Gemini and Groq (Step 2)
scripts/set_secrets.py, scan_secrets.py   copy .env to GitHub/Worker secrets; pre-push secret scan
worker/src/                               the Worker: index, bot, cron, digest, health, github, telegram, db,
                                          and (Step 4) api, auth, settings, admin
worker/public/app/                        the Mini App: index.html, app.css, app.js; public/_headers (cache)
worker/test/                              node:test suite (node:sqlite with the real schema)
worker/scripts/digest-cli.mjs             dev tool: owner's digest / previews / length / CPU checks
worker/scripts/stamp-app.mjs              content hashes for the Mini App files (run by npm run deploy)
worker/scripts/setup-bot.mjs              chat menu button + command list (once per bot)
worker/scripts/dev-server.mjs, dev/       local Mini App preview with demo data and a Telegram stand-in
worker/scripts/screenshots.mjs, ui-check.mjs   headless Edge screenshots and click-through check
worker/scripts/api-check.mjs              checks the live API (signed with the token in .env)
worker/wrangler.toml                      Worker config: D1 binding, crons, assets, vars (no secrets)
docs/screenshots/                         the Mini App at 390 px, light and dark (demo data)
.github/workflows/                        hourly.yml, backup-schedule.yml, check-feeds.yml
```

## 10. Known design risks

- **Feeds from GitHub's runners:** checked in Step 3. 115 of 116 work; The Times of Israel returns
  403 there and is disabled with a note. Re-run the "check feeds" workflow if many feeds start
  failing.
- **Worker 10 ms CPU** is the tightest limit. Measured: 6 ms for one due user, 10-27 ms for 20.
  Mitigated by doing dedupe in the job, 40 candidates per user and 8 users per tick; with ~20
  users at the same time some get their digest up to 10 minutes late. The per-tick log line
  (Workers Logs) shows counts; watch Metrics > Errors for `exceededCpu`.
- **The GitHub token** has no expiration, but it can be revoked or the owner's account settings
  can change. A failed dispatch is logged and alerted, and the backup schedule keeps the pool
  updating in the meantime.
- **Duplicate check is word-based.** It misses duplicates worded very differently (two lines on
  the same Abu Dhabi talks share only the place name) and sometimes merges two different stories
  about the same thing (two separate "undesirable organisation" rulings).
- **The per-feed cap drops some items** from the biggest Russian state feeds. Major stories still
  arrive through other outlets; minor TASS/RIA items are the main loss, and that is intended.
- **Gemini overload (HTTP 503)** was frequent on 2026-11-13. A second Gemini model and then Groq
  take over, but Groq is slow (about 1 chunk per minute). A long overload makes runs take several
  minutes and can leave items pending.
- **AI grouping errors.** Seen in Step 2:
  - Over-merged "roundup" stories, where several events were folded into one summary.
  - One item placed in the wrong story.

  The prompt and code now guard against both, but grouping stays the weakest part of the
  quality. Watch the first days of real digests.
- **Topic balance.** Many feeds are Russian and Ukrainian. Since Step 3 no topic may take more
  than 40% of a digest (3 of 7), counted against each story's most specific topic.
