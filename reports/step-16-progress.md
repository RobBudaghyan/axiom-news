# Step 16 progress

A new session continues from here. Plan: Part 0 (owner fixes from his phone test, then STOP for his
check), Part 1 (staging), Part 2 (load test on staging), Part 3 (iPhone check), then
`reports/step-16-fixes-staging-safety.md`.

## Owner decisions (2026-11-17)
- Topic emojis stay 🏛️ Politics & Conflicts and 📈 Economy & Markets (no change needed).
- Until launch, production is silent to users (owner alerts only); the TEST bot moves to staging
  with a copy of the users (Part 1).

## Part 0: done, waiting for the owner's check (2026-11-17)
1. Setup starts with a Language step (1 of 4): the Settings flag buttons, Telegram's language
   chosen; a tap saves at once and the whole flow switches language. Then topics, times, all set.
2. Texts rewritten in en, ru, hy, fr: short, one idea per line, emojis (bot replies, welcome,
   reminder, /help, tips, errors, setup, Help). Help: 8 sections, each an emoji title and 2 to 4
   lines of at most 40 characters (one line on a 360 px phone). Russian keeps сводка and на Украине.
3. Help and Send feedback squares are brand red (#b1161c, dark #d0232a) with a white glyph.
4. One hint under Add a topic: "e.g. Formula 1, Japan, AI" (localised); gone at 3 topics.
5. Pause removed. Every topic may be off; then no digest, no quiet note, no sample digest; the
   cron moves the slot on. Card: "😴 All topics are off / Switch one on to get digests."
   Admin: "All off" instead of "Paused". `worker/scripts/migrate-pause.mjs`: live dry run found
   0 paused users, so nothing to migrate.
6. Emojis: unchanged (owner kept 🏛️ and 📈).
7. Digest length: main-topic bar 7 (was 6), custom topics keep 6 (`custom_topic_bar`), in the
   Worker (SQL and `qualifies`) and the job (SQL and `qualifies`); editor examples put routine
   Armenia court steps, meetings and local incidents at 3 to 5. 48 h replay
   (`worker/scripts/step16-replay.mjs`, `reports/data/step-16/replay-{before,after}.*`):
   all six topics 15.7 a digest (15-17, 196 cut) -> 10.4 (4-16, 23 cut); Armenia only 13.6
   (4-19, 79 cut) -> 6.4 (1-16, 2 cut); the owner 1.6 -> 1.5. Boost caps alone: Armenia only 12.
- Tests: Worker 287 (new `test/step16.test.mjs`), Python 164, click-through 139 of 139.
  Mutations `scripts/step16_mutations.py`: 23 of 23 caught.
- Screenshots: `reports/data/step-16/screenshots/` (48 files).
- Worker deployed: version 95e38a2b.
- Fixed on the way: `api-check.mjs` sent a Yerevan device zone and moved the owner's zone from
  Asia/Dubai; restored in D1 (same GMT+4, next digest unchanged) and the check now sends the
  stored zone.

## Owner check of Part 0: OK (2026-11-17, "OK, go to staging")

## Sent to the owner (2026-11-17, TEST bot)
- Four screenshots (setup language step in English and after tapping Русский, the hint, the
  all-off card) and a check list for items 1 to 6, with the digest length numbers.
- A labelled preview, all six topics, since 20:00 (`digest-cli.mjs --preview --topics main`, new
  option: main topics only). It showed 16 stories because a preview has no "already sent" history:
  it also counts stories a real reader got at 20:00 that were updated since. A follow-up note told
  him a real all-topics reader gets about 8 new stories since 20:00 (the `--windows` replay).
- Today is a heavy news day: an all-topics reader would have had 17, 14 and 15 stories at 09, 14
  and 20 even with the new rule (the 48 h average is 10.4).

## Part 1: done (2026-11-17)
- Staging: Worker `axiom-news-staging` (https://axiom-news-staging.axiom-news-worker.workers.dev), D1
  `axiom-d1-staging` (same 20 tables and columns, `worker/scripts/schema-diff.mjs`). wrangler.toml
  `[env.staging]`: crons */5 only, `JOB_DISPATCH off`, `HEALTH_ALERTS off`, `SEND_STUB off`.
- Production: `USER_SENDS = "off"` until launch (no digests, reminders or announcements; owner alerts
  still on). Deployed 0f0c62a1 through the guard (same code d54c4ad73000c8f9 as staging a3111df8).
- Deploys: `npm run deploy:staging` (records the code hash), `SHIP_IT=yes npm run deploy:prod`
  (`ship-check.mjs` refuses without SHIP_IT, with code staging does not have, or uncommitted code).
- Secrets: `set_secrets.py worker-staging` / `worker-prod`; `.env.staging` (git-ignored) holds the
  staging D1 id and its own webhook secret; `AXIOM_ENV=staging` makes every script and the job use it.
- TEST bot moved: webhook and every user's chat menu point at staging (`point-bot.mjs`, `setup-bot.mjs`);
  the webhook now also takes callback_query and pre_checkout_query (it had only message).
- Users copied (3), with custom follows, sent (7 days) and holds; stories: `scripts/sync_staging.py`
  (on demand `--hours 48`; the hourly job runs `--auto`: every 3 hours since the last sync; secret
  `STAGING_D1_DATABASE_ID`; `--items` before a local job test).
- Job tested locally against staging: 190 s, 10 AI calls, 67 stories, production untouched.
- D1 a day (estimate from today): reads job 2.65M + prod Worker 0.1M + sync 0.05M = about 2.8M of 5M
  (57%); writes job 40k + sync about 7k + Workers about 1k = about 48k of 100k (48%).
- `CLAUDE.md` (rules) and PROJECT_NOTES updated. Admin shows STAGING (amber) or PRODUCTION (red).
- Tests: Worker 294 (new `test/staging.test.mjs`), Python 164, click-through 140 of 140, live
  `api-check.mjs` on both copies.

## Part 2: in progress
- First run (2026-11-17 19:56 UTC): the 25 fake readers were all served, but the CPU capture was
  empty (wrangler under `timeout`/npx recorded nothing) and the session stopped on a usage limit
  with SEND_STUB still on. **Incident:** the stub then also answered for real readers, so 5 real
  TEST-bot digests were recorded as sent but never delivered (the owner at 02:00, 05:00 and
  08:00 UTC; the two other users at 05:00). Fixed on 2026-11-18 09:30 UTC: stub off, those sent and
  hold rows deleted on staging and each user's last digest time put back, so their next digest
  (10:00 UTC; the owner 14:00 UTC) brings the missed stories. Safety fix: the stub now only ever
  answers for fake readers (negative ids); a real reader is always sent for real (test added).
- D1 finding: the editor's article lookup (`items WHERE story_id IN ...`) read the whole items table
  each time (16,918 rows for 50 stories, measured on production with one read-only query). Index
  `idx_items_story` added to `db/schema.sql` and applied to staging only: the same lookup reads 153
  rows. Production needs the owner's "ship it" (then `venv/Scripts/python scripts/apply_schema.py`).
- Second run: started 2026-11-18 09:32 UTC with the safe stub and a working capture.

- Load test results, before and after the CPU fix: see `reports/step-16-fixes-staging-safety.md`.

## Owner decisions (2026-11-18)
- Part 3 (iPhone check) skipped: accepted risk.
- "Ship it" for the items index and the CPU fix.

## Shipped (2026-11-18)
- Index applied to production; CPU fix deployed (code c71a7f93c649969c, version ebe43cdb). Production
  health: ticks 2 to 7 ms, 12:07 job ok (130k rows read, first run with the index). USER_SENDS still off.
- Staging clean: fake readers removed, SEND_STUB off, the three users' next digests normal.

## Step 16 is complete
Final report: `reports/step-16-fixes-staging-safety.md`. Next: the launch, and a staging-first fix of
the job's remaining full scans.
