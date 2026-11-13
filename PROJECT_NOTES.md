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
- **Digest line format (owner, Step 2):** `N. <summary> · <linked source name>`. No em dash
  anywhere in user-facing text.

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
| 2026-11-13 | Private GitHub repo (owner) | public repos lose their schedules after 60 days without activity. Private fits ~2,000 min/month only if runs stay under 2 min, because each job is billed in whole minutes |
| 2026-11-13 | Default time zone `Asia/Yerevan` (owner) | most users are expected to be in Armenia |
| 2026-11-13 | D1 database `axiom-d1` (created by the owner in the dashboard), schema applied via REST | no Node.js/wrangler needed until the Worker in Step 3 |
| 2026-11-13 | The digest selection SQL lives in `db/digest_query.sql` | the Step 3 Worker and the local test script pick exactly the same stories |

## Current status
- **Step 1 done:** repo, docs, topics, prompt, lessons, 116 verified feeds.
- **Step 2 done:**
  - The hourly job runs on the owner's PC against the real D1 database: 5 real runs; the normal
    hourly run took 60 s.
  - Real AI limits were measured, and 39 tests pass.
  - One test digest went to the owner through the TEST bot; the owner confirmed it arrived
    (2026-11-13).
- Nothing runs automatically yet. Data from the dev runs is in D1, including `sent` rows for the
  owner from the test digest.

## Next step
Step 3:
- A private GitHub repo with the hourly workflow (secrets: AI keys, D1 token and ids). Run
  `check_feeds.py` and the job on GitHub's runners, and measure the run time against the
  whole-minute billing.
- Install Node.js and wrangler, then build the Worker (webhook, digest cron using
  `db/digest_query.sql`, Mini App API) and the Mini App.

## Known issues / open questions
- **Feeds were verified from the owner's PC only;** GitHub's US runners may be blocked by some
  sites.
- **Gemini 503 overloads** were frequent on 2026-11-13; fallback runs are slow (Groq ~1
  chunk/min).
- **AI grouping is the weakest part:** some over-merged stories and near-duplicates. Guarded by
  prompt and code, but it needs watching.
- **Topic balance:** with all topics on, the Ukraine war fills most of a top-7 digest. Ask the
  owner whether to cap stories per topic.
- **No usable feeds** from Reuters, AP (both blocked), Armenpress (none found) or ISW (403).
