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

### What happened on 2026-11-18 evening (UTC)
The account passed the free **read** limit (5M) at about 17:44 UTC (Cloudflare's own count for the day:
5.63M rows read, 120k written, both copies). From then until 00:00 UTC every D1 call failed: production
missed 6 hourly job runs (18:07 to 23:07; the 00:07 run caught up 569 new items), staging's ticks and
Mini App opens failed (358 tick errors). Nobody outside the test users was affected (production is
silent). My 48 h staging sync with items (52k writes, 56k reads) added to it. Lesson: syncs for a job test
use `--hours 6`.

### After (staging, 2026-11-19 05:00 UTC, pool the same size as production's: 2,016 stories in 24 h)
- Indexes applied on staging (`apply_schema` content, staging only): one-off 47k reads, 13k writes.
  Production will cost about the same plus its larger items table: do it early in a UTC day.
- `d1_plan.py` on staging: 0 full scans. Rows read per query, before (yesterday) -> after:
  editor merge 5,080 per merge -> 0; Worker digest 13.5k (production) -> 2.0k; translate eligible 7.1k
  -> 5.4k; keyword enforce 5.1k -> 3.7k; sent copy 334 -> 0. Saved in `reports/data/step-17/`.
- One job run on staging (134 new items, 65 editor candidates, 4 merges): **38.5k rows read, 1,066
  written**. Comparable production runs before: 84k to 122k read (runs 128 to 131); busy runs with
  30+ merges read 230k to 330k, mostly the merge scan, now gone. Top readers now: translate eligible
  2x (10.9k), Google title index (7.7k), editor pool 2x (7.6k), enforce (3.7k), dupes pool (3.5k).
- Analytics token works (live query: today's and yesterday's totals; yesterday would have alerted).

| Per day | Before | After (projected) |
|---|---|---|
| Production job reads | 2.8M (11-17), 3.6M busy | 1.0M to 1.2M (24 runs x 40k to 50k) |
| Production Worker reads, 20 readers | 0.1M with no readers | about 0.25M (digests about 2k each) |
| Staging reads (sync every 3 h, its Worker) | 0.3M to 2.5M (load test) | about 0.2M |
| **Reads, both copies** | **4.0M (80%), 5.6M (113%)** | **about 1.5M to 1.7M (30% to 34%)** |
| Production job writes | 41k to 58k | 30k to 45k (3 writes less per item) |
| Other writes (Workers, staging sync) | 6k to 10k | about 14k |
| **Writes, both copies** | **47k to 120k** | **about 45k to 60k (45% to 60%)** |

Writes are now the tighter limit on busy news days. Not changed yet (owner to decide): staging sync every
6 h instead of 3 h (about 4k writes a day less); translate eligible read once a run instead of twice
(about 130k reads a day less).

### Shipped (owner's "ship it", 2026-11-19)
- 05:15 to 05:21 UTC: staging redeployed and checked (api-check 9 PASS); production `apply_schema.py`
  (indexes confirmed); `set_secrets.py worker-prod` (adds the analytics token); job pushed to main;
  `SHIP_IT=yes npm run deploy:prod` (guard passed). Ticks after: 2 to 4 ms CPU.
- The two savings (staging sync every 6 h; translate eligible read once a run) ran on staging first
  (32.1k read, 632 written; eligible read once, 11 Russian translations ok), then pushed to main
  (job only, no Worker deploy).
- `setup-bot.mjs` on production stays for the switch.

### Two hourly runs on production after the ship

| Run | Start (UTC) | New items | Editor candidates / merges | Rows read | Rows written | Written per item |
|---|---|---|---|---|---|---|
| 128 to 131 (before) | 01:07 to 04:07 | 95 to 124 | | 84k to 163k | 1,028 to 1,554 | 10.3 to 12.5 |
| 132 (before, old code) | 05:07 | 132 | 62 / 2 | 68,114 | 1,224 | 9.3 |
| **133** | 06:07 | 180 | 105 / 5 | **35,321** | 1,495 | 8.3 |
| **134** | 07:07 | 242 | 153 / 8 | **35,114** | 1,895 | 7.8 |

- Reads per run are about a third of before, with more news and more merges. Writes per new item are
  about a quarter lower; total writes per run follow the news volume.
- The hourly usage check works: meta `cf_usage` was written at 07:07 UTC (account today: 1.52M read,
  57.7k written, no runs over the CPU limit, no alert sent).
- Today is not a normal day: the account totals at 07:11 UTC (production 1.13M read, 37.1k written;
  staging 0.42M read, 22.5k written) include one-offs (index builds on both copies, the catch-up run
  at 00:07 with 569 items, two staging job runs). If the evening is as busy as yesterday's (about
  300 items an hour), today's writes could reach 90k to 100k: the 80% alert would fire, and the
  limit itself could be hit late in the UTC day. From tomorrow, without one-offs: about 45k to 80k
  writes a day (production job 24 runs x 1.2k to 2.4k, plus Workers and the staging sync).
  Writes stay the limit to watch.

### Next
Owner (2026-11-19): STOP before Part 2; a branding step comes first (Step 17b below).

## Part 2 prep (done while waiting)
- Production health (2026-11-18 ~17:00 UTC): last 24 h 20 runs ok, 4 partial (AI fallbacks), none failed;
  ticks 3 to 5 ms CPU (wrangler tail, 3 ticks); errors are normal job notes (translation retries) and 2
  Google 429s.
- Production users: 3 (first names Rob, Ashot, and one shown as a flag). **Owner (2026-11-19): keep only
  Rob**; the other two are removed from production at the switch (staging keeps its own copy).
- Bot texts: `bot.description` and `bot.short_description` in en, ru (and hidden hy, fr);
  `setup-bot.mjs` now sets and checks them per language. Set on the TEST bot.
- Invite drafts: in the chat message to the owner (English and Russian).

## Part 4: Fly.io (done by the owner)
The owner deleted the whole Fly.io account himself (2026-11-19). Nothing left to clean up; note it in the
docs and the final report.

## Step 17b: branding (2026-11-19)
Done on staging and the TEST bot; details in `reports/step-17b-branding.md`. New texts (about, description,
welcome, reminder, calmer wording), the welcome animation, the Mini App loading screen, BotFather files
and share cards in `branding/out/`. Sent to the owner on the TEST bot with the BotFather taps.
**Waiting on the owner:** his OK after checking on his phone, and the BotFather steps on the TEST bot.
At the launch switch: `setup-bot.mjs` on production plus BotFather steps A to D for @axiom_news_bot
(listed in the 17b report). Production not touched.
Round 2 (owner remarks, same day): new description, about and welcome line; "a few times a day",
"English or Russian", News.am and RFE/RL removed; single-path splash icon; previews and cards re-made;
the production BotFather list with file paths is in the 17b report. On staging and the TEST bot.

## Step 17c: D1 writes (2026-11-19)
Owner got Cloudflare's 76% alert. Items written once, not-news as hashes, fewer small writes, staging
sync on demand, Admin "Free limit used" line. Shipped 15:19 UTC (owner's "ship it"); production runs
143 and 144: 1,209 and 1,062 writes (2.3k to 2.4k before). Details in `reports/step-17c-database-writes.md`.
**Waiting on the owner:** the feed change (6 feeds off, 4 caps at 4) is made locally, not pushed: it needs
one staging job run after 00:00 UTC (today's writes end near 98k), then his "ship it". Staging account: later.

## 2026-11-20 (Step 17c follow-up, Part 2)
- Yesterday (2026-11-19 UTC), the whole day: 96.7k rows written (97%), 2.42M read (48%); production 65.4k
  written, staging 31.2k (index builds and tests). Today 00:00 to 04:59: 3.4k written (production 500 to
  960 an hour overnight).
- Shipped 04:40 UTC (owner's "ship it", job only): the feed change (staging run: 117 feeds, caps cut) and
  the editor fix: an event of more than 6 stories is kept when its stories share a core (40 Shenzhen summit
  stories were refused in every run, so every second editor call failed 6 times); 45 stories a call, up to 4
  calls; stories an answer left out wait for the next run. Staging run: 82 s, editor 3 calls, 0 failed.
- Part 2: `reports/step-17-launch-checklist.md`. The TEST token is now also in `.env.staging`; the bot scripts
  refuse the TEST bot on production. **STOP: waiting for the owner's branding OK, the real token in `.env`,
  and "go".**

## 2026-11-20: delete user, delete my data, blocked readers (staging, waiting for "ship it, go")
- `worker/src/account.js`: one batch deletes a user and every row about them (users, sent, digest_holds,
  custom_follows, feedback, announcement_sends, topic_checks, error notes naming them); tips stay with
  user_id 0 (totals; no refund possible after); custom topics they created lose created_by; a topic with no
  follower left starts the 7-day clock.
- Admin > Users: Delete on every row but the owner's (confirm; the server refuses the owner's id).
  Help, under Privacy: "🗑 Delete my data" (confirm, a second one for the owner), then one line and the app
  closes; nothing more is called. en, ru, hy, fr.
- `my_chat_member` kicked: the reader is marked blocked at once; `point-bot.mjs` asks Telegram for it.
- Tests: Worker 320 (11 new in `test/account.test.mjs`), Python 177; 8 rules broken on purpose, all caught.
  Preview checked (Help row 48 px, done line, Admin Delete, no Delete on the owner's row).
- Staging deployed (2cd63495), TEST bot webhook updated (my_chat_member), api-check 9 PASS, note sent to the
  owner on the TEST bot. Commit eabb91d (not pushed).
- Owner: branding OK; real token in `.env` (checked: @axiom_news_bot, no webhook, nothing pending); BotFather
  done except the profile previews. **STOP: waiting for "ship it, go".**
