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

## Waiting on the owner
- His check of items 1 to 6 on his phone (message sent on the TEST bot), and the labelled
  all-topics preview digest.

## Next
Part 1 (staging) after the owner's OK and any fixes he asks for.

## Sent to the owner (2026-11-17, TEST bot)
- Four screenshots (setup language step in English and after tapping Русский, the hint, the
  all-off card) and a check list for items 1 to 6, with the digest length numbers.
- A labelled preview, all six topics, since 20:00 (`digest-cli.mjs --preview --topics main`, new
  option: main topics only). It showed 16 stories because a preview has no "already sent" history:
  it also counts stories a real reader got at 20:00 that were updated since. A follow-up note told
  him a real all-topics reader gets about 8 new stories since 20:00 (the `--windows` replay).
- Today is a heavy news day: an all-topics reader would have had 17, 14 and 15 stories at 09, 14
  and 20 even with the new rule (the 48 h average is 10.4).
