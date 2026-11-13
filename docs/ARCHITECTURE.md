# Architecture

Status: designed in Step 1, updated in Step 2 (2026-11-13). Built and run locally: the hourly
job (`job/`), the D1 database and a test-digest script. Not built yet: the GitHub workflow, the
Worker and the Mini App (Step 3).

## 1. Components

```
                 every hour (GitHub Actions cron)
 ┌─────────────────────────────────────────────────────────┐
 │ HOURLY JOB  (Python, runs ~1-2 min, then the VM is gone) │
 │ 1. fetch ~116 RSS feeds (config/sources.yaml)            │
 │ 2. drop already-seen URLs, keep <= 8 newest per feed     │
 │ 3. AI pass, usually ONE call: group, tag, score, write   │
 │    (Gemini -> 2nd Gemini model -> Groq -> else pending)  │
 │ 4. write stories to D1, prune old rows                   │
 └───────────────┬─────────────────────────────────────────┘
                 │ HTTPS: Cloudflare D1 REST API (scoped token)
                 ▼
        ┌─────────────────┐
        │   D1 database    │  story pool, users, sent log, stats
        └───────┬─────────┘
                │ D1 binding (inside Cloudflare)
 ┌──────────────┴──────────────────────────────────────────┐
 │ CLOUDFLARE WORKER  (JavaScript, one Worker)              │
 │ • POST /telegram   bot webhook (/start, /settings)       │
 │ • /api/*           Mini App API (settings, admin)        │
 │ • static files     Mini App (HTML/CSS/JS, free assets)   │
 │ • cron */5 min     send digests that are due             │
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
of logic therefore lives in exactly one language. Tools: `wrangler` (Cloudflare CLI) needs Node.js,
which will be installed in Step 2; it is used to deploy, not as a runtime language.

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
5. **Digests.** The Worker cron runs every 5 minutes and finds users whose `next_digest_at <= now`.
   For each user it selects stories that match their topics, have `importance >= 4`, were created
   or updated since their last digest (at most 24 h back), and are **not in `sent`**. It sorts
   them by importance, then by recency, takes the top N and sends one Telegram message. It then
   inserts `sent` rows and computes the next `next_digest_at`. Building a digest is a database
   filter and makes no AI call. The selection is one SQL file, `db/digest_query.sql`, shared by
   the Worker and `scripts/send_test_digest.py`, so both pick the same stories.

### Digest message format

```
Good evening. Since 14:00, 6 stories on your topics:

1. Israel and Iran agree a 30-day ceasefire mediated by Qatar · Financial Times
2. ...
```
Each line is `N. <summary> · <source name>`, with the source name linked to the article (HTML
parse mode, link previews off). Changed in Step 2 at the owner's request: no em dash anywhere in
user-facing text. The job replaces any em or en dash the AI writes, and the digest code refuses
to send a message that still contains one. Seven stories came to about 1,900 characters, well
within Telegram's 4,096-character limit.

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
- **Auto-detection:** when the user opens the Mini App, it reads
  `Intl.DateTimeFormat().resolvedOptions().timeZone` from their device and saves it. Telegram's
  user data does not include a time zone; the official Mini App docs list only id, name, username,
  language, premium and photo. Before the first open, `DEFAULT_TIMEZONE` applies (proposed:
  `Asia/Yerevan`). `/start` replies with an "Open settings" button so most users open it on day one.
- `next_digest_at` is stored as a UTC timestamp. After each send, or after a settings change, the Worker
  computes the next local slot in the user's zone and converts it to UTC with `Intl`. This handles
  daylight-saving changes automatically.
- **Why the Worker cron sends digests instead of GitHub:** GitHub documents that scheduled runs
  "can be delayed during periods of high loads" and that at high load "some queued jobs may
  be dropped", and the start of every hour is a known peak. Cloudflare cron is a separate, cheap
  trigger, and 288 runs a day is nothing against the request limit.
- **Expected delay:** a digest goes out at the first 5-minute tick at or after the chosen time, so
  0-5 minutes late. Cloudflare does not publish an accuracy figure, so add a little more for
  that. If more users are due at once than one run can handle (see the subrequest budget in §8),
  the rest go at the next tick, 5 minutes later.
- **Content freshness:** the pool updates once an hour. The job runs at minute :07, off the
  hour peak, plus any GitHub delay. A story is typically in the pool 10-70 minutes after the
  outlet publishes it.
- Pause: `paused=1` skips the user. When they resume, the next digest covers at most the last 24 h.

## 5. Database (Cloudflare D1, SQLite)

| Table | Key columns | Notes |
|---|---|---|
| `users` | `id` (Telegram user id) PK, `first_name`, `language`, `timezone`, `tz_detected` 0/1, `digest_times` JSON, `max_stories` (default 7, range 3-15), `topics` JSON, `paused`, `blocked`, `created_at`, `last_digest_at`, `next_digest_at` | index on `next_digest_at`. `blocked=1` when Telegram returns 403 because the user blocked the bot. |
| `topics` | `tag` PK, `label_en`, `emoji`, `sort`, `is_default` | synced from `config/topics.yaml` by the job, read by the Worker |
| `items` | `id` PK, `url_hash` UNIQUE, `source_key`, `source_name`, `tier`, `url`, `title`, `snippet`, `published_at`, `fetched_at`, `status` (pending/done/dropped/expired), `story_id` | index on `status`; pruned after 7 days |
| `stories` | `id` PK, `summary`, `topics` JSON, `importance`, `best_url`, `best_source`, `best_tier`, `best_published_at`, `source_count`, `created_at`, `updated_at` | index on `updated_at`; pruned after 7 days. `best_tier`/`best_published_at` let a merge update the link without re-reading items |
| `sent` | (`user_id`, `story_id`) PK, `sent_at` | the "never twice" guarantee; pruned with stories |
| `job_runs` | `id`, `started_at`, `finished_at`, `status` (running/ok/partial/ai_failed/error), counts, `provider`, tokens, `pruned`, `error` | Admin tab |
| `ai_calls` | `id`, `at`, `provider`, `model`, `ok`, `input_tokens`, `output_tokens`, `ms`, `error` | Admin tab: AI usage |
| `errors` | `id`, `at`, `component` (job/worker), `message` | Admin tab: recent errors |

`sent` is the only per-user table besides `users`, and deleting a user must also delete their `sent`
rows (lesson 16 in LESSONS.md). Indexes are kept to a minimum because every index update counts as
an extra "row written" on D1. Times are INTEGER unix seconds. The schema is `db/schema.sql`,
applied with `scripts/apply_schema.py` through the REST API. No wrangler or Node.js was needed in
Step 2: the owner created the database (`axiom-d1`) in the dashboard. Note that the REST API
passes numbers as REAL, so INTEGER columns convert them back.

## 6. Security: how the parts talk

| Link | Protection |
|---|---|
| GitHub job → D1 | Cloudflare D1 REST API `POST /accounts/{id}/d1/database/{id}/query`, using an API token limited to **D1 Edit** permission only. Stored as a GitHub Actions secret. The job only connects outward; nothing can call into it. |
| Telegram → Worker webhook | registered with a `secret_token`. The Worker rejects any request whose `X-Telegram-Bot-Api-Secret-Token` header doesn't match `TELEGRAM_WEBHOOK_SECRET`. |
| Mini App → Worker API | every request carries Telegram's `initData`. The Worker checks it the official way (HMAC-SHA256 of the bot token with key `"WebAppData"`, then HMAC of the sorted data-check-string), compares it to `hash`, and rejects data older than 24 h (`auth_date`). The user id comes only from verified data. |
| Admin tab / admin API | shown and allowed only when the verified user id equals `OWNER_TELEGRAM_ID`. Hiding the tab is cosmetic; the API checks the id on every admin call. |
| Secrets | `.env` locally (gitignored). In production: GitHub Actions secrets (AI keys, D1 token, account/database ids) and Cloudflare Worker secrets (bot token, webhook secret, owner id). Each side holds only what it needs. The job never sees the Telegram token, and the Worker never sees the AI keys. |
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
| Workers Free | **10 ms CPU** per HTTP request and per Cron Trigger | light: verify initData, a few queries, build a ≤4 KB message per user | same |
| Workers Free | 50 subrequests per invocation (D1 calls and `fetch` count) | per cron tick: about 3 D1 calls (one batched read for all due users, one batched write) plus 1 Telegram call per user, so about 40 users per tick; the rest wait 5 min | same; [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) ("a `db.batch()` call counts as one query") |
| Workers Free | 5 Cron Triggers per account | 1 (`*/5 * * * *`) | Workers limits |
| Workers static assets | "Requests to static assets are free and unlimited" | Mini App files | [Static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) |
| D1 Free | 5M rows read/day, 100k rows written/day, 5 GB total, 500 MB per DB; resets 00:00 UTC; when a limit is hit, queries fail until reset | writes about 35k/day (items ~4.6k × ~3 including index rows, stories, sent, plus deletes from pruning); reads well under 0.5M/day with indexes; DB < 50 MB with 7-day pruning | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 | 100 bound parameters per query, 100 KB per SQL statement | the job batches inserts to stay under both | D1 limits |
| Cloudflare API | 1,200 requests per 5 min per user | about 10-20 REST calls per hourly run | [API limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/) |
| GitHub Actions | private repo: $12/month included compute ≈ 2,000 min on standard Linux at $0.006/min; with no payment method, usage is **blocked** (never billed) once used up. Public repos: free and unlimited. Each job is **rounded up to a whole minute** ([runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)) | runs measured on the PC: 75-210 s; a run under 2 min bills 2 min, so 720 runs ≈ 1,440 min/month. Fallback runs take 3-8 min | [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) |
| GitHub Actions schedule | minimum every 5 min; can be delayed or dropped under load; runs on the default branch only; **public repos: schedules auto-disabled after 60 days without repo activity** | hourly at :07 | [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) |
| Gemini free tier | per-model limits shown in AI Studio only; RPD resets at midnight Pacific; free-tier content is used to improve Google's products. Measured 2026-11-13: 29k-token calls accepted, frequent 503 "high demand" | 24 calls/day, about 23k input + 15k output tokens each | [Rate limits](https://aistudio.google.com/docs/rate-limits), [Pricing](https://aistudio.google.com/docs/pricing), [Models](https://aistudio.google.com/docs/models) |
| Groq free | gpt-oss-120b: 1K RPD and 8K TPM read from response headers 2026-11-13 (TPM counts prompt + reserved reply); 200K TPD per docs | fallback only, ~1 chunk/min | [Groq rate limits](https://console.groq.com/docs/rate-limits) |
| Telegram Bot API | ≤ 1 message/sec per chat; about 30 messages/sec bulk; 4,096 characters per message | ≤ 20 users per tick, 1 message each | [Bots FAQ](https://core.telegram.org/bots/faq) |

Repo visibility: **private** (owner's decision, 2026-11-13). It fits the 2,000 included minutes
only if a normal run stays under 2 minutes, because each job is billed in whole minutes.
On the PC, a normal one-call run took 75 s plus Gemini's 45-85 s answer time. Step 3 must measure
this on GitHub's runners. A public repo would make the 60-day auto-disable
a silent outage risk. If usage ever runs out, the job is blocked rather than billed, so the $0 rule
holds either way.

## 9. Repository layout

```
config/topics.yaml, config/sources.yaml   shared data (Step 1, done)
prompts/story_batch.md                    AI prompt template (Step 1, done)
db/schema.sql                             D1 tables (Step 2, applied via REST: scripts/apply_schema.py)
db/digest_query.sql                       digest selection, shared by Worker and test script (Step 2)
job/                                      Python hourly job: config, fetch, ai, d1, run (Step 2)
tests/                                    unittest suite for the job and the digest (Step 2)
scripts/check_feeds.py                    feed health check (Step 1)
scripts/ai_probe.py                       real batch-size test for Gemini and Groq (Step 2)
scripts/send_test_digest.py               dev tool: owner's digest via the TEST bot (Step 2)
worker/                                   Cloudflare Worker (src/*.js, public/ Mini App, wrangler.toml) (Step 3)
.github/workflows/hourly.yml              the schedule (Step 3)
```

## 10. Known design risks

- **Feeds checked only from the owner's PC.** GitHub's US runners may be blocked by some sites,
  especially Russian ones (geo-blocking) or bot protection. Re-run `check_feeds.py` inside GitHub Actions in Step 3.
- **Worker 10 ms CPU** should be ample for the digest cron, but this has not been measured yet. If
  it is exceeded, send fewer users per tick.
- **GitHub schedule delays** only affect pool freshness, not digest timing. If delays get bad, a
  Worker cron can trigger the workflow through the GitHub API (`workflow_dispatch`) at a precise
  time; this needs a fine-grained GitHub token.
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
- **Run time vs. GitHub minutes.** Each job is billed in whole minutes. A normal run must stay
  under 2 minutes, or a private repo goes over its ~2,000 included minutes a month (720 runs × 3
  min = 2,160). Gemini's answer alone takes 45-85 s.
- **Topic balance.** Many feeds are Russian and Ukrainian, so the Ukraine war fills most of a top-7
  digest for a user who follows all topics. Ranking is importance only, as specified.
