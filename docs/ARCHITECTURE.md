# Architecture

Status: design written in Step 1 (2026-11-13). Nothing below is built yet unless the README says so.

## 1. Components

```
                 every hour (GitHub Actions cron)
 ┌─────────────────────────────────────────────────────────┐
 │ HOURLY JOB  (Python, runs ~1-2 min, then the VM is gone) │
 │ 1. fetch ~116 RSS feeds (config/sources.yaml)            │
 │ 2. drop already-seen URLs, keep <= 8 newest per feed     │
 │ 3. ONE AI call: group duplicates, tag, score, summarize  │
 │    (Gemini -> fallback Groq -> else leave items pending) │
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

1. **Collect.** The job fetches all feeds in parallel (measured: 116 feeds in 12 s from the owner's PC).
   For each entry it computes `url_hash = sha256(normalized link)` and skips URLs already in
   `items`. It keeps at most **8 newest new entries per feed per run**, which stops the very high-volume
   Russian state agencies (TASS ~1,600/day, RIA ~1,200/day) from swamping the batch. It stores the
   title plus a snippet of about 200 characters (HTML stripped) as `items` rows with `status='pending'`.
   Pending items left over from a failed earlier run are included as well, up to 24 h old.
2. **AI pass (one call per hour for everyone).** Input: all pending items, plus summaries of the
   stories created or updated in the last 24 h (newest 250), so the model can attach a new
   item to an existing story. Prompt: `prompts/story_batch.md`. Output: a list of stories, each with
   `item_ids`, `topics`, `importance` 1-10, a one-line English `summary`, and an optional
   `existing_story_id`. Items not placed in any story are "not news" and get `status='dropped'`.
3. **Best link** is chosen in code rather than by the AI. Among a story's items, the lowest `tier`
   (1 = most prestigious) wins, and the earliest one breaks a tie. Paywalled outlets are fine. This
   means a cheaper AI response and a predictable result.
4. **Write.** Stories and item updates go to D1 in a few batched REST calls. Then the job deletes
   items and stories older than 7 days, and log rows older than 30 days.
5. **Digests.** The Worker cron runs every 5 minutes and finds users whose `next_digest_at <= now`. For
   each user it selects stories that match their topics, have `importance >= 4`, were created or
   updated since their last digest, and are **not in `sent`**. It sorts them by importance, then by
   recency, takes the top N, and sends one Telegram message. It inserts `sent` rows and computes
   the next `next_digest_at`. Building a digest is a database filter and makes no AI call.

### Digest message format

```
Good evening. Since 14:00, 6 stories on your topics:

1. Israel and Iran agree a 30-day ceasefire mediated by Qatar — Financial Times
2. ...
```
Each line holds the summary, an em dash, and the source name linked to the article (HTML parse mode, link previews
off). Ten stories fit easily within Telegram's 4,096-character limit. If no story qualifies, the user gets
one short line: "Quiet period: nothing important on your topics since 14:00." The greeting depends on
the local hour: morning before 12:00, afternoon until 18:00, evening after that.

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
| `items` | `id` PK, `url_hash` UNIQUE, `source_key`, `source_name`, `tier`, `url`, `title`, `snippet`, `published_at`, `fetched_at`, `status` (pending/done/dropped), `story_id` | pruned after 7 days |
| `stories` | `id` PK, `summary`, `topics` JSON, `importance`, `best_url`, `best_source`, `source_count`, `created_at`, `updated_at` | index on `updated_at`; pruned after 7 days |
| `sent` | (`user_id`, `story_id`) PK, `sent_at` | the "never twice" guarantee; pruned with stories |
| `job_runs` | `id`, `started_at`, `finished_at`, `status`, counts, `provider`, `error` | Admin tab |
| `ai_calls` | `id`, `at`, `provider`, `model`, `ok`, `input_tokens`, `output_tokens`, `ms`, `error` | Admin tab: AI usage |
| `errors` | `id`, `at`, `component` (job/worker), `message` | Admin tab: recent errors |

`sent` is the only per-user table besides `users`, and deleting a user must also delete their `sent`
rows (lesson 16 in LESSONS.md). Indexes are kept to a minimum because every index update counts as
an extra "row written" on D1.

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

**Primary: Gemini free tier**, using a key from a Google project with no billing account. Proposed model:
`gemini-3.5-flash-lite`, listed as Stable and "Free of charge" on the official pricing page
(checked 2026-11-13). `gemini-2.5-flash` is deprecated and gets re-routed on 2026-12-01, so we avoid
it. The model is set by `GEMINI_MODEL` so it can be swapped without a code change (lesson 1).

**Budget math (real numbers from the Step 1 feed check):**
- Raw volume across the 116 feeds is about **8,900 items/day**. Most of it comes from TASS, RIA,
  Rossiyskaya Gazeta, Izvestia, RBC, Interfax, Trend and Anadolu.
- With the 8-per-feed-per-run cap: about **4,600 items/day, roughly 190 new items per hour**.
- Input per item is about 85 tokens (title plus a 200-character snippet; Cyrillic costs more tokens),
  so about 16k tokens for the items. Existing stories add about 8k (250 × ~30). Instructions add about 1.5k.
  Total: **about 26k input tokens per hourly call**.
- Output is roughly 40-70 stories × ~50 tokens ≈ **3-4k output tokens**.
- Normal operation is **24 calls/day**, one per hour regardless of user count, or about 0.6M input tokens/day.
- If the cap proves too low or high, it is one number in config. Lowering it to 5 per feed gives
  about 3,800 items/day.

**Fallback: Groq free plan** (`openai/gpt-oss-120b`). Sample Free-plan limits are 30 RPM,
1,000 RPD, **8,000 TPM** and 200,000 TPD. Groq's docs say the exact limits for an account are on
its console limits page, and third-party sources agree with these numbers.
- An 8k-tokens-per-minute cap cannot take a 26k batch in one call. In fallback mode the job splits the items into
  chunks of about 6k tokens and sends them **sequentially, about one per minute**. Each chunk includes the
  stories created by the previous chunks, so duplicates across chunks still merge.
- That is about 4 calls per fallback hour. The 200k tokens/day limit covers about 7 fallback hours a day.
- **Worst case is roughly 24 + 28 ≈ 50 calls/day**, which stays inside the spec's 24-50 range.
- If Gemini and Groq both fail, items stay `pending` and go into the next hour's batch (they are
  kept up to 24 h). An empty or safety-blocked response counts as a failure, never as "no news"
  (lesson 2).

Other free options checked and **rejected** (2026-11-13):
- **Cerebras:** only a one-time $5 credit that "expires 30 days after activation" and requires a
  payment method.
- **Mistral:** the current docs say API use needs billing activation.
- **OpenRouter `:free` models:** they need no card and allow 20 RPM, but only **50 requests/day**
  without buying credits, and free-model availability changes often. This is a possible third fallback
  later, but it is not in v1.

**Not yet verified:** Google no longer publishes per-model free-tier RPM/TPM/RPD numbers. The docs
say to check them in AI Studio for your own project, and third-party figures for
`gemini-3.5-flash-lite` disagree (10-30 RPM, 500-1,500 RPD). Even the lowest figure is 20× more requests
than we need, but **TPM must be checked once the owner creates the key in Step 2**. If it is below
about 30k, the job uses the same chunking as the Groq fallback.

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
| GitHub Actions | private repo: $12/month included compute ≈ 2,000 min on standard Linux at $0.006/min; with no payment method, usage is **blocked** (never billed) once used up. Public repos: free and unlimited. | 720 runs × 1-2 min ≈ 720-1,440 min/month | [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) |
| GitHub Actions schedule | minimum every 5 min; can be delayed or dropped under load; runs on the default branch only; **public repos: schedules auto-disabled after 60 days without repo activity** | hourly at :07 | [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) |
| Gemini free tier | per-model limits shown in AI Studio only; RPD resets at midnight Pacific; free-tier content is used to improve Google's products | 24 calls/day, about 26k tokens each | [Rate limits](https://aistudio.google.com/docs/rate-limits), [Pricing](https://aistudio.google.com/docs/pricing), [Models](https://aistudio.google.com/docs/models) |
| Groq free | gpt-oss-120b: 30 RPM, 1K RPD, 8K TPM, 200K TPD (sample limits; the console has exact values) | fallback only | [Groq rate limits](https://console.groq.com/docs/rate-limits) |
| Telegram Bot API | ≤ 1 message/sec per chat; about 30 messages/sec bulk; 4,096 characters per message | ≤ 20 users per tick, 1 message each | [Bots FAQ](https://core.telegram.org/bots/faq) |

Repo visibility recommendation: **private**. It fits the 2,000 included minutes if each run stays
under about 2 minutes, which Step 2 will measure. A public repo would make the 60-day auto-disable
a silent outage risk. If usage ever runs out, the job is blocked rather than billed, so the $0 rule
holds either way.

## 9. Planned repository layout (built in later steps)

```
config/topics.yaml, config/sources.yaml   shared data (Step 1, done)
prompts/story_batch.md                    AI prompt template (Step 1, done)
db/schema.sql                             D1 tables (one file, applied with wrangler)
job/                                      Python hourly job (fetch, ai, d1, run.py)
worker/                                   Cloudflare Worker (src/*.js, public/ Mini App, wrangler.toml)
.github/workflows/hourly.yml              the schedule
scripts/check_feeds.py                    feed health check (Step 1, done)
```

## 10. Known design risks

- **Feeds checked only from the owner's PC.** GitHub's US runners may be blocked by some sites,
  especially Russian ones (geo-blocking) or bot protection. Re-run `check_feeds.py` inside GitHub Actions in Step 2.
- **Worker 10 ms CPU** should be ample for the digest cron, but this has not been measured yet. If
  it is exceeded, send fewer users per tick.
- **GitHub schedule delays** only affect pool freshness, not digest timing. If delays get bad, a
  Worker cron can trigger the workflow through the GitHub API (`workflow_dispatch`) at a precise
  time; this needs a fine-grained GitHub token.
- **The per-feed cap drops some items** from the biggest Russian state feeds. Major stories still
  arrive through other outlets; minor TASS/RIA items are the main loss, and that is intended.
