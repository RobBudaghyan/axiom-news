# Step 17c: database writes

The owner got Cloudflare's alert on 2026-11-19 (account at 76%). Goal: on a normal busy news day
(about 300 new items an hour at peak) the whole account stays under 50% of the free 100k D1 writes
and under 40% of the 5M reads.

## 1. Today (2026-11-19, UTC), Cloudflare's own numbers

At 15:19 UTC: **87.6k written, 2.10M read** for the account.

| | Rows read | Rows written |
|---|---|---|
| Production | 1.58M | 56.4k |
| Staging | 0.51M | 31.2k |

One-off parts of today:
- 00:07 catch-up run after yesterday's outage (569 items): about 5.4k writes.
- Step 17 index builds at 05:00: production about 21k writes, staging about 19k (with two test job runs).
- Today's staging tests (a 2-hour copy of production data, done twice because the first try stopped on
  a missing table, and one job run): about 6k writes.
- Normal part: production about 2.3k to 2.5k writes an hour at 250 to 310 new items.

Yesterday (2026-11-18): 119.9k written (over the limit), 5.63M read.

## 2. Where the writes went (production, last 24 h, `wrangler d1 insights`)

| Statement | Rows written | Why |
|---|---|---|
| `INSERT INTO items ...` (new item, status pending) | 13.3k + 1.5k (custom) | 3 rows each: the row, `url_hash`, the pending index |
| `UPDATE items SET status='done', story_id=?` | about 9k | 2 rows each |
| `UPDATE stories SET final_score=...` (editor) | 5.5k | 2.4 each |
| `INSERT INTO stories` | 4.0k | 2 each |
| `UPDATE items SET status='dropped'` | about 2.8k | 1 each |
| `UPDATE stories SET dup_group=?` | 2.3k | one per new story, even when it leads its own group |
| `UPDATE stories SET summary=...` (merge) | 1.6k | |
| Worker `meta.d1_worker` every minute | 1.5k (plus 1.4k on staging) | |

Measured on staging, cost per statement (rows written): insert an item 3, pending to done 2, pending to
dropped 1, delete any row 1 (indexes are not counted on delete), insert a not-news hash 1.

Per item over its whole life (insert, update, prune): a story item **6**, a not-news item **5**.
The daily prune is not large: 1 row per deleted row (it starts deleting on 2026-11-20, when the first
items reach 7 days; about 8k to 10k rows a day).

## 3. Changes

Shipped (owner's "ship it", 2026-11-19 15:19 UTC):
- **Items written once.** The job holds new items in memory, runs the AI pass, then writes each item once
  in its final state (a story item: 3 rows, then 1 at the prune = 4). Items whose AI call failed are
  stored as `pending` (retried next run, as before); a crash after the fetch also stores them as pending.
- **Not-news items keep only their URL hash** (new table `items_seen`, 1 row, then 1 at the prune = 2).
  The job checks both tables before taking an item, so it is never fetched again.
- **Group writes only on change.** `dup_group` stays NULL for a story that leads its own group (the Worker
  already reads NULL that way): about 1 row less per new story.
- **Worker usage row once an hour** (minute 0) instead of every minute: about 1.4k rows a day less per copy.
- **Staging sync on demand only** while staging shares production's account (`sync_staging.py --auto`
  does nothing; the script is ready for a separate account, see section 5).
- **Admin "Free limit used" line** (Database today): the account's reads and writes as % of the free limit,
  today and yesterday (the hourly check now also asks Cloudflare for yesterday's totals). The 80% alert
  stays as it was.

Owner's feed decision (2026-11-19), on staging first, waiting for its own "ship it":
- Disabled: trend_az, azertag, rt_en, marketwatch, politico_eu, wapo_politics (48 h: 0 to 2 stories
  scored 7+ each). hetq_hy kept (Armenian source; its value is the Armenia topic path).
- tass_ru, ria, rg, izvestia: 8 -> 4 new items a run (they hit the cap every run).

Not changed: the editor's update (needed), the story indexes (needed by the reads fixed in Step 17),
`idx_items_story_nn` (dropping it would save about 1 write per story item but cost about 0.3M reads a day).

## 4. Measured

Per-feed table (48 h, production): `reports/data/step-17c/feeds-48h-production.json`.
Staging job run (before the feed change): `reports/data/step-17c/staging-job-run.txt`.

| Run | New items | Not news | Rows written | Written per item |
|---|---|---|---|---|
| Production 137 to 141 (before) | 288 to 309 | 55 to 115 | 2,297 to 2,536 | 7.8 to 8.2 |
| Staging, new code | 255 | 136 | 1,195 (170 of them one-off group rewrites, staging's partial pool) | 4.7 (4.0 without the one-off) |
| **Production 143** (16:07, new code) | 284 | 77 | **1,209** | 4.3 |
| **Production 144** (17:07, new code) | 249 | 42 | **1,062** | 4.3 |

- Per account hour: production 2.3k to 2.5k writes before, **1.24k and 1.11k** after; staging's idle
  Worker 60 an hour before, 3 to 25 after.
- Fair note: in runs 143 and 144 the editor had only 12 candidates (210 in most runs before), so it
  wrote about 200 rows less than usual. With a full editor pass a 290-item run is about 1.4k (was 2.35k).
- Run 144 was `partial` (Gemini 503s): 84 items were stored as pending and are retried next run, as
  designed. The hourly usage check stored yesterday's totals (5.63M read, 119.9k written).
- Today ends near 98k writes (90.0k at 17:20 UTC, 6 runs left at about 1.2k to 1.4k). Tight, but under.

## 5. Projection per day (whole account, from 2026-11-20)

The prune starts on 2026-11-20 (first items reach 7 days): about 8k to 10k deletes a day, before and after.

| | Before | After | After + feed change |
|---|---|---|---|
| Normal day (about 5.5k new items) | 54k to 89k (staging tests, sync, Worker every minute) | **about 34k (34%)** | about 31k |
| Busy day (300 items every hour, 7.2k) | 78k to 95k | **about 42k (42%)** | about 39k |
| Reads, normal day | 1.5M to 1.7M | about 1.0M to 1.2M (20% to 24%) | a little less |

After = production job (about 3.6 rows per new item plus about 200 a run) + the prune + Workers
(about 0.5k) + staging with no automatic sync. A staging test day adds what the tests write (a job test
about 1.2k plus its copy of production data, 2k to 2.5k for 2 hours) until staging has its own account.

## 6. Staging in its own Cloudflare account (owner: later)

D1's free limits are per account, so a staging account of its own means testing never uses
production's limits. Until then the staging sync runs only by hand. When the owner wants it:

1. Owner: sign up at dash.cloudflare.com with a second email (a Gmail "+staging" address works), free
   plan, no card. Open Workers & Pages once so Cloudflare gives the account a workers.dev subdomain.
2. Owner: in that account create two API tokens: "Edit Cloudflare Workers" (for deploys) and one with
   Account > D1 > Edit (for the sync). Put them in `.env.staging` as `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_D1_TOKEN`, with the new `CLOUDFLARE_ACCOUNT_ID`. Never in chat.
3. Me: create the D1 there, apply the schema, copy 48 h of stories and the users (`sync_staging.py`
   reads `.env.staging`), point `wrangler.toml [env.staging]` at the new D1 and the new address, make
   `deploy:staging` use the staging token, deploy, `set_secrets.py worker-staging`, point the TEST bot
   (`point-bot.mjs`, `setup-bot.mjs` with AXIOM_ENV=staging), add the GitHub secrets
   `STAGING_CLOUDFLARE_ACCOUNT_ID` and `STAGING_D1_TOKEN` (the automatic 6-hour sync then starts again),
   then delete the old staging Worker and D1 from the main account.
