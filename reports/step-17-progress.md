# Step 17 progress (launch)

A new session continues from here. Plan: Part 1 (D1 reads and writes, alerts) on staging, then "ship it";
Part 2 (launch checklist, then STOP for "go"); Part 3 (the switch); Part 4 (Fly.io cleanup); Part 5 (docs);
final report `reports/step-17-launch.md`.

## Owner decision (2026-11-18)
The old Fly.io account is suspended and its database is down. No export or import of old users and no
announcement through the bot: the owner invites his dad and friends (about 20) with a forwarded
message; they go through the normal welcome and setup.

## Part 1: database use (code done, staging measurement waits for 00:00 UTC)

### Before (Cloudflare's own numbers, 2026-11-18)
- Last 24 h (`wrangler d1 info`): production 4.22M rows read, 71k written; staging 2.5M read (mostly the
  Step 16 load test), 58k written (52k of it my 48 h sync with items at 16:20 UTC, see below).
- Production job: about 150k rows read a run (job_runs, last 30 runs: 60k to 296k), so about 3.6M a day.
- Biggest readers, production, 24 h (`wrangler d1 insights`, saved in `reports/data/step-17/`):

| Query | Rows read | Why |
|---|---|---|
| editor merge `UPDATE stories SET merged_into=? WHERE merged_into=?` | 758k (133 runs) | no index: whole pool per merge |
| editor pool | 458k | indexed, about 4k a read |
| Worker digest (candidates) | 285k (21 runs, 13.5k each) | `max(updated_at, scored_at) >= ?` cannot use an index |
| translate eligible | 276k | same `max(...)` |
| Google title index (custom search) | 264k | reads the last 8,000 items (needed) |
| keyword enforce | 158k | same `max(...)` |
| Admin custom-topic counts | 123k | `created_at` has no index |
| sent copy in a merge | 72k | `sent` has no story index |

- Writes: about 3 rows per new item (table, url_hash, status and story indexes), then 2 to 3 more when it
  is marked done or dropped.

### Changes (staging first)
- Indexes (`db/schema.sql`): `idx_stories_merged` (partial, merged only), `idx_stories_scored` (partial,
  scored only), `idx_sent_story`. Item indexes made partial: `idx_items_pending` (pending only) and
  `idx_items_story_nn` (story set only) replace `idx_items_status` and `idx_items_story`: about 2 writes
  less per item.
- Queries: "new since" written as `updated_at >= ? OR scored_at >= ?` (SQLite uses both indexes) in
  the Worker digest, translate eligible and keyword enforce; the digest's held stories are a third
  indexed term. Admin custom counts also filter on `updated_at`.
- `job/d1.py` keeps a read profile per statement shape; every job run logs its top 12 readers.
- `scripts/d1_plan.py`: EXPLAIN QUERY PLAN for the heavy queries, `--local` (synthetic pool, no D1) or
  on staging with real rows read. Locally: 0 full scans (was 5).
- Owner alert (`worker/src/usage.js`): once an hour (production's :07 tick) one call to Cloudflare's
  analytics API: today's D1 rows for the whole account and Worker runs that ended `exceeded*` since the
  last check. At most one alert a UTC day for D1 (reads or writes at 80%) and one for CPU. Stored in
  meta `cf_usage`; Admin > Database today shows the account numbers and "Runs over the CPU limit today".
  **Needs a new token** with only Account Analytics Read, put in `.env` as `CLOUDFLARE_ANALYTICS_TOKEN`
  by the owner; then `set_secrets.py worker-prod`. Without it the check is skipped.
- Tests: Python 168 (new `tests/test_d1_reads.py`: no full scans, late-scored stories still found),
  Worker 305 (new `test/usage.test.mjs`). Mutations: 4 SQL and index mutations and 4 alert mutations, all
  caught; 2 digest-window mutations caught by the existing hold tests.
- Staging Worker deployed (c57b22df, code 1e264b9860245b75); api-check passes on staging.

### Why the staging measurement waits
D1's free limits are per account (both copies). Today (UTC) production's job had written about 34k rows
by 16:00 and my 48 h staging sync wrote 52k, so the account is near 100k writes. Creating the new
indexes on staging writes about 15k more. If the account passes 100k today, D1 refuses writes until
00:00 UTC: production's job fails for those hours (production is silent to users; the next run's
lookback picks the missed items up, busy feeds may lose some over their per-feed cap). So: indexes on
staging and the one staging job run right after 00:00 UTC. Lesson: a 48 h sync with `--items` costs
about 50k writes; use `--hours 6` for a job test.

### Next (Part 1)
1. After 00:00 UTC: `AXIOM_ENV=staging venv/Scripts/python scripts/apply_schema.py`, then
   `AXIOM_ENV=staging venv/Scripts/python scripts/d1_plan.py` (real rows read), then one job run
   `AXIOM_ENV=staging venv/Scripts/python -m job.run --min-gap-minutes 0` (log shows the top readers).
2. Report rows read a run before and after and the projected day; ask the owner for "ship it".
3. Ship: production `apply_schema.py`, push the job to main, `SHIP_IT=yes npm run deploy:prod`; watch 2
   hourly runs.

## Part 2 prep (done while waiting)
- Production health (2026-11-18 ~17:00 UTC): last 24 h 20 runs ok, 4 partial (AI fallbacks), none failed;
  ticks 3 to 5 ms CPU (wrangler tail, 3 ticks); errors are normal job notes (translation retries) and 2
  Google 429s.
- Production users: 3 (first names Rob, Ashot, and one shown as a flag). Owner to say which stay.
- Bot texts: `bot.description` and `bot.short_description` in en, ru (and hidden hy, fr);
  `setup-bot.mjs` now sets and checks them per language. Set on the TEST bot.
- Invite drafts: in the chat message to the owner (English and Russian).
