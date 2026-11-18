# Step 16: your fixes, staging, and a safer production

Done 2026-11-17 and 2026-11-18. Production is still silent to users until launch (it has no real bot yet).

## Part 0: your fixes from the phone test

| # | Change | Where to see it |
|---|---|---|
| 1 | Setup starts with a **Language** step (the same flag buttons as Settings, your Telegram language chosen; a tap switches the whole setup at once). Setup is now 4 steps. | `reports/data/step-16/screenshots/setup-1-language-*.png` |
| 2 | Every text users read is rewritten in English, Russian, Armenian and French: short, one idea per line, with emojis. Help has 8 sections, each an emoji title and 2 to 4 lines that fit on one line of a 360 px phone. Russian keeps "сводка" and "на Украине". No dashes. | `help-*.png` |
| 3 | Help and Send feedback squares are brand red with a white glyph. | `settings-bottom-red-icons-*.png` |
| 4 | One hint under Add a topic: "e.g. Formula 1, Japan, AI" (your exception to the no-helper-text rule). It goes away at 3 topics. | `settings-my-topics-hint-*.png` |
| 5 | **No Pause.** Any topic can be off, even all of them; then nothing is sent at all and the card says "😴 All topics are off". Nobody was paused, so nothing had to be migrated. | `all-topics-off-*.png` |
| 6 | Topic emojis stay 🏛️ and 📈, as you chose. | |
| 7 | **Shorter digests.** The six main topics now need a topic score of 7 (was 6); your own topics keep 6. The editor's examples put routine Armenia court steps, meetings and local incidents at 3 to 5. | below |

Digest sizes, 48 hours of real stories replayed:

| Reader | Before | After |
|---|---|---|
| All six topics | 15.7 stories a digest (196 cut for length) | 10.4 (23 cut) |
| Armenia only | 13.6 (79 cut) | 6.4 (2 cut) |
| Your settings | 1.6 | 1.5 |

You checked items 1 to 6 on your phone and said OK.

## How staging works (in simple words)

There are now two copies of Axiom.

- **Production** is the real one: Worker `axiom-news`, database `axiom-d1`, the hourly news job, and the real bot @axiom_news_bot from launch. Until launch it sends nothing to users.
- **Staging** is your private test copy: Worker `axiom-news-staging`, its own database, and the TEST bot @justatia_bot (you and the two test users were copied there). It never runs the news job; every 3 hours it copies production's latest stories, with no AI calls of its own.

**How you ask for a change from now on:** tell me what you want. I build it, put it on staging, and send you a short note on the TEST bot saying what to try. You try it on your phone. When you are happy, say **"ship it"**, and that exact code goes to production. A guard refuses a production deploy unless the code is exactly what staging has and you said "ship it". These rules are written in `CLAUDE.md`, so every future session follows them.

Admin shows a big **STAGING** (amber) or **PRODUCTION** (red) label, so you always know where you are.

Also fixed while moving the TEST bot: it only received normal messages, so the /support buttons and Stars tips could not work on it. Now it receives those too.

## Database use (free limits: 5M reads, 100k writes a day)

| | Reads a day | Writes a day |
|---|---|---|
| Production news job (before the index) | about 3.6M (73%) | about 41k |
| Production Worker | about 0.1M | about 2.5k (every-minute ticks) |
| Staging sync (every 3 h) | about 0.05M | about 7k |
| Staging Worker | small | about 1.5k |
| **Total before the index** | **about 3.8M (76%)** | **about 52k (52%)** |

The biggest cause was one lookup: the editor fetched the articles of its candidates and read the whole articles table every time (16,918 rows for 50 stories). The new index makes the same lookup read 155 rows. The first hourly run with it read 130k rows (the 24 hours before averaged about 152k a run). One run is not enough to judge; the daily total shows in Admin by tomorrow. Other job queries still scan the whole story pool (about 5,300 rows each, several times a run); that is the next thing to look at, as a normal staging-first change.

## Load test (staging, 25 fake readers due at once, fake readers never reach Telegram)

| Version | CPU per cron tick | Last reader waited |
|---|---|---|
| Before (8 readers a tick, every 5 min) | 12 to 24 ms (median 13) | about 20 min |
| After the fix (3 readers a tick, every minute) | 5 to 15 ms (typical 6 to 9) | about 9 min |
| Tick with nobody due | 2 ms (production, after shipping) | |

25 Mini App opens at the same moment: all fine, 0.7 s for the whole batch, 1 to 8 ms CPU each.

**Honest result:** the fix brought ticks from about 13 ms to about 7 ms, but not every tick is clearly under 10 ms; the worst one seen afterwards was 15 ms. Cloudflare never marked a single tick as over the limit (in 41 digest ticks, also the 24 ms ones), and the leftover spread did not follow the amount of work. What the fix does:
- time zones without daylight saving (Yerevan, Dubai, Moscow and 25 more) are computed by hand instead of by the costly time-zone engine (about 10 ms the first time in a fresh Worker);
- the digest code is warmed up while the Worker starts, not inside the tick;
- one database statement per digest instead of one per story;
- the cron runs every minute with 3 readers a tick (was every 5 minutes with 8).

**Something that went wrong:** the first load test stopped when the session hit a usage limit, with the test switch (send stub) still on. It then also answered for real readers, so 5 real TEST-bot digests were marked sent but never delivered (yours at 02:00, 05:00 and 08:00 UTC; the two others at 05:00). I undid that on staging the next morning, so the missed stories came in your next digests, and changed the code so the stub can only ever touch fake readers.

## What was shipped to production (after your "ship it")

- The articles index (applied with `apply_schema.py`).
- The CPU fix above. The guard confirmed production got exactly staging's code (c71a7f93c649969c), version ebe43cdb.
- Health after shipping: ticks 2 to 7 ms, no CPU errors, the 12:07 news job ran on time and finished ok. Production still sends nothing to users.

## Accepted risk

You decided not to do the iPhone check. Rich-message digests and the Mini App were seen only on your Android phone and in a headless browser. If an iPhone reader reports a problem, it will be in the Mini App styles or the digest layout, both quick to change.

## Tests

Worker 296 tests, Python 164, Mini App click-through 140 of 140 (360, 390 and 430 px; English and Russian; light and dark), live API checks on both copies. 23 rules broken on purpose in Part 0; all caught.

## Next

The launch: the real bot's token on production, its webhook and menu, production switched to send, the old readers imported, and an announcement. Before that, a staging-first look at the job's remaining full scans of the story pool.
