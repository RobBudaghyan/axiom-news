# Step 03: Automation (GitHub Actions + Cloudflare Worker)

Date: 2026-11-13. Everything now runs with the owner's PC off, still on the TEST bot
(@justatia_bot). No Mini App yet (Step 4).

## Summary
The whole system now runs in the cloud:
- **GitHub Actions** (public repo `RobBudaghyan/axiom-news`) runs the hourly job. A normal run on
  GitHub's servers takes about 2 minutes.
- **One Cloudflare Worker** (`axiom-news`) answers the bot, sends due digests every 5 minutes,
  starts the GitHub job at about :07 each hour, and alerts the owner when the job fails.

Tested for real:
- the owner's `/start` and its welcome;
- one forced digest, end to end;
- previews of formats A and B;
- one test alert;
- an hourly run started by the Worker: it succeeded, in 58 s.

The owner's Step 2 decisions are in:
- **Topic cap:** no topic takes more than 40% of a digest (3 of 7), counted against its most
  specific topic.
- **Near-duplicates** are removed without AI.
- **The new readable format** (A by default, B as an option).
- **One shared place** for the selection logic: `worker/src/digest.js`.

**The biggest finding was CPU.** Measured on Cloudflare, building digests went well over the
Worker's 10 ms free limit, so the duplicate check moved into the GitHub job and the Worker now
serves at most 8 users per 5-minute tick. With ~20 users at the same time, the last ones get
their digest up to about 10 minutes after the hour.

## What was done
1. **Tools installed:** GitHub CLI 2.104 and Node.js 26.13 LTS (winget); wrangler 4.155.0,
   pinned in `worker/package.json`. That was the newest release at least two weeks old.
2. **Logins:** the owner logged in to GitHub (`gh auth login`, account RobBudaghyan) and to
   Cloudflare (`wrangler login`). Both needed a second try: the first GitHub code was never
   entered, and the first Cloudflare page timed out.
3. **Commit email:** all 14 existing commits carried the owner's personal Gmail. With the
   owner's OK, I rewrote the author and committer to his GitHub noreply address before the
   first push, and set it for this repo. "gmail" appears nowhere in the pushed history.
4. **Secret scan before the first push** (`scripts/scan_secrets.py`):
   - it checks every real `.env` value, plus Telegram/Google/Groq/GitHub token shapes, against
     the full history and all files;
   - result: nothing found; `.env` is ignored and was never committed;
   - I planted one real key in a throwaway file to prove the scanner catches it (it did, and
     the file was deleted).
5. **GitHub:**
   - created the public repo and pushed; GitHub push protection is on;
   - set the 5 job secrets with `scripts/set_secrets.py` (values go through stdin, never
     printed);
   - workflows:
     - `hourly.yml`: started by the Worker or by hand; one run at a time;
       `--min-gap-minutes` skips a run if one started recently;
     - `backup-schedule.yml`: at :37, skips if a run started in the last 45 minutes; it lives in
       its own file, so GitHub's 60-day inactivity disable can never switch off `hourly.yml`;
     - `check-feeds.yml`.
6. **Feeds from GitHub's servers:** 115 of 116 OK. **The Times of Israel returns HTTP 403**
   there (in the feed check and in the job), so it is now `enabled: false`, with a
   `disabled_note`. Not deleted.
7. **Shared digest module** (`worker/src/digest.js`) holds:
   - candidate SQL, topic cap, near-duplicate skip and fill rule;
   - formats A and B, and the length trim;
   - DST-safe time slots.

   Settings are in `config/digest.json`: format, 7 stories, `max_topic_share` 0.4, topic
   specificity order, dedupe threshold, 8 users per tick. `scripts/send_test_digest.py` and
   `db/digest_query.sql` are gone; the local tool is now `worker/scripts/digest-cli.mjs`, which
   imports the same module.
8. **Worker** (`worker/src/`):
   - `index.js`: routes and crons;
   - `bot.js`: `/start` and help replies;
   - `cron.js`: digests;
   - `health.js`: alerts;
   - `github.js`: starts the job;
   - `telegram.js`, `db.js`: Telegram and database helpers.

   Secrets were set with `wrangler secret put` through stdin. The webhook was registered with
   `secret_token`, only `message` updates, pending updates dropped.
9. **Database:**
   - new `meta` table (alert memory);
   - new `stories.dup_group` column, added through a migration list in `apply_schema.py`.
10. **CPU fix:** near-duplicate grouping moved to `job/dupes.py` (details under Decisions).
11. **Docs:** ARCHITECTURE (components, data flow, format, scheduling, alerts, security, measured
    limits, layout, risks), PROJECT_NOTES, README, and LESSONS 22-23.

## Files created / changed
- **New:**
  - `worker/` with `package.json`, `package-lock.json`, `wrangler.toml`, `src/*.js` (8 files),
    `test/helpers.mjs`, `test/digest.test.mjs`, `test/worker.test.mjs` and
    `scripts/digest-cli.mjs`;
  - `config/digest.json`, `job/dupes.py`, `tests/test_dupes.py`;
  - `.github/workflows/hourly.yml`, `backup-schedule.yml`, `check-feeds.yml`;
  - `scripts/set_secrets.py`, `scripts/scan_secrets.py`, `scripts/__init__.py`, and this report.
- **Changed:**
  - `job/run.py`: `--min-gap-minutes`, dup grouping after the AI pass;
  - `job/config.py`: skip disabled feeds;
  - `scripts/check_feeds.py`: `enabled`/`disabled_note`, `--all`;
  - `scripts/apply_schema.py`: migrations;
  - `config/sources.yaml`, `db/schema.sql`, `tests/test_job.py`, `.env.example`
    (`GITHUB_DISPATCH_TOKEN`);
  - `docs/ARCHITECTURE.md`, `docs/LESSONS.md`, `PROJECT_NOTES.md`, `README.md`.
- **Removed:** `scripts/send_test_digest.py`, `db/digest_query.sql`, `tests/test_digest.py`
  (ported to `worker/test/`).
- **Not committed:** `.env`, which now also holds `GITHUB_DISPATCH_TOKEN`.

## Tests run and real results

### Unit tests
- **Python:** `venv/Scripts/python -m unittest discover -s tests -t .` gives **34 tests, OK**.
  New tests cover the min-gap skip, disabled feeds, and dup grouping on real lines.
- **Worker:** `cd worker && node --test test/` gives **42 tests, pass**. They use `node:sqlite`
  with the real `db/schema.sql` behind a fake D1 binding. They cover:
  - selection and the topic cap: ceil, most specific topic, the fill rule, the config value;
  - dup groups;
  - formats A and B, greetings, the quiet note, 15-story length, trimming, the dash ban;
  - slot math across DST in Berlin and New York;
  - the webhook: secret check, `/start` new and returning, help, errors;
  - the cron: send, never twice, paused/blocked, 403, retry then skip, per-tick limit;
  - the GitHub dispatch and its failure;
  - alerts: failed run once, stuck run, 3 h without success, 3 h throttle.
- **Mutation checks** (I broke the code on purpose, then restored it):

  | Broken on purpose | Tests that failed |
  |---|---|
  | topic cap removed | 2 |
  | fill rule removed | 1 |
  | Worker group check removed | 2 |
  | job grouping threshold broken | 2 |

### On GitHub's servers
| Run | Started (UTC) | Trigger | Result | Time | Notes |
|---|---|---|---|---|---|
| check feeds | 19:03 | manual | success | 27 s | 115/116 OK, Times of Israel 403 |
| hourly job | 19:03 | manual | **ok** | **2 min 0 s** (job 114.5 s) | 342 new items (2.5 h backlog), 142 stories created, 43 merged, 5 AI calls (Gemini + 2nd Gemini model; 3 "skipped items" resends), D1: 28 calls, 4,570 rows read, 2,091 written |
| hourly job | **20:07** | **the Worker** (`7 * * * *` tick, fine-grained token) | **ok** | **58 s** (job 46.3 s) | 115/115 feeds OK, 145 new items, 41 stories created, 16 merged, 3 AI calls (Gemini + 2nd model), dup groups updated for 48 stories, D1: 23 calls, 3,521 rows read, 894 written |
| hourly job | 20:09 | manual, `min_gap_minutes=45` (what the backup schedule uses) | skipped as designed | 13 s | "skipped: a run started 2 min ago"; nothing written |

### The bot, for real (TEST bot @justatia_bot)
- **Webhook security:** a POST without the secret header, or with a wrong one, gets **403**.
- **`/start` from the owner's account.** I first deleted the owner's Step 2 test user row, so
  the real new-user path ran; his `sent` rows were kept, so old stories never repeat. The reply:
  > Welcome to Axiom News, Rob! I send you a short digest of the most important news at 09:00,
  > 14:00 and 20:00 (Yerevan time). ... Your next digest comes tomorrow at 09:00.

  The D1 row has the defaults: all 6 topics, 09:00/14:00/20:00, Asia/Yerevan, 7 stories, and
  next digest 2026-11-14 09:00 +04:00.
- **Forced digest.** I set the owner's `next_digest_at` to now. The 19:25 UTC tick sent 7
  stories (format A), wrote 7 `sent` rows, and moved `next_digest_at` back to the normal slot
  (**2026-11-14 09:00 Yerevan**). The topic cap was visible: 3 Ukraine war, 2 politics, 1 Iran
  war, 1 wars & conflicts.
- **Previews A and B** were sent once (Telegram message ids 2440 and 2441), labelled
  "Preview A: flat list (default)" and "Preview B: grouped by topic". They draw from the last
  24 h as if nothing had been sent yet, and they wrote nothing.
- **Test alert.** I inserted a fake failed run. The 19:50 tick alerted the owner ("the hourly
  news job failed (status error, started 23:43)"), using 3 ms CPU. I then deleted the fake row
  and reset the alert memory.
- **Worker errors table:** empty after all of the above.

### Message length
The 15 longest real headlines came to **2,621 visible characters (A) and 2,594 (B)**, against
4,096. Telegram counts text after HTML parsing; the raw HTML with link URLs was ~4,500. The code
counts the way Telegram does, keeps a 4,000 budget, and drops the lowest-ranked stories if it
were ever too long.

### Worker CPU against the 10 ms free limit (measured on Cloudflare, `wrangler tail` cpuTime)
| What | CPU |
|---|---|
| idle 5-minute tick (health check only) | 3-4 ms |
| the forced digest tick, **before** the fix (dedupe in the Worker, 100 candidates) | **11 ms** |
| build 1 digest, before the fix | 8-17 ms |
| build 10 digests, before the fix | 20 ms |
| **after the fix** (dedupe in the job, 40 candidates), 1 due user | 6 ms |
| after the fix, 20 users at once | 10-27 ms |
| after the fix, 40 users at once | 46 ms |
| hourly tick at 20:07 (GitHub dispatch + health check) | 2 ms |

Cloudflare's docs say an isolate has "some built-in flexibility" for occasional overruns, but
consistent overruns are terminated (error 1102). So I capped the cron at **8 users per tick**
(about 6-12 ms). Times on this PC were misleading (lesson 22): a cold time-zone lookup cost
10-17 ms in Node but only 1-3 ms on Cloudflare.

## Decisions I made and why
- **Duplicate check in the job, not the Worker.** This is the CPU finding above.
  - The method is word overlap weighted by how rare each word is in the day's pool, with
    5-letter stems and stop words removed. A story at 0.45 or more against a more important
    earlier one joins its group.
  - **Tuned on the real pool** (365 stories): with 23 true duplicate pairs and 24 tricky
    look-alike pairs that I labelled by hand, it catches **16 of 23** and wrongly merges
    **2 of 24**. The two are two different "undesirable organisation" rulings, and two unrelated
    Zelensky lines.
  - Giving names extra weight was tried. It caught a few more but merged different stories about
    the same person (Merz, Vance, Nvidia's CEO), so I dropped it. Missing a duplicate is less bad
    than hiding a real story (lesson 5).
  - Known miss: two lines on the same Abu Dhabi talks that share only the place name. You can
    see such a pair in both previews (lines 2 and 3).
- **"Most specific topic" order:** ukraine_war, iran_war, armenia, russia, wars_conflicts,
  politics (a config value). The topic emoji in format A, and the heading in format B, are that
  topic's.
- **8 users per tick, 40 candidates per user.** These are the CPU limits above. Users due at the
  same time are served earliest-first: ~20 users at 09:00 means 09:00 / 09:05 / 09:10.
- **`last_digest_at` stores the slot time,** so the header says "Since 14:00", not "Since 14:03".
- **A failed send is retried at the next tick;** after an hour the slot is skipped. Telegram
  403 marks the user blocked, and `/start` unblocks.
- **The Worker trigger runs at :07 via its own cron entry** (`7 * * * *`, 2 of the 5 allowed
  cron triggers). That is more precise than piggy-backing on the 5-minute cron.
- **Health checks run every 5 minutes** (about 10 rows read), so a failed run is reported within
  minutes, not an hour later.
- **The D1 database id is committed in `worker/wrangler.toml`.** Wrangler needs it, and it grants
  nothing without the D1 token. The scanner allows it only in that file.
- **The webhook accepts `message` updates only;** group chats are ignored.

## Problems / risks / open questions
- **My mistake, caught and fixed:** one `git push` ran even though the secret scan had reported
  2 hits, because I piped the scan into `tail` and the pipe hid its failure code. Both hits were
  the D1 database id in `wrangler.toml`, which is intentionally public (no secret leaked; the new
  GitHub token is in no file or commit). Since then the scan runs on its own before every push,
  and lesson 23 records it.
- **CPU headroom is thin.** With 20+ users, some ticks will still be close to 10 ms. Watch
  Cloudflare's Metrics > Errors for "Exceeded CPU". If it shows up, lower `max_users_per_tick`
  to 5.
- **The backup schedule (:37) has not fired yet.** GitHub often waits a while before it
  starts a brand-new schedule; the 19:37 and 20:37 slots passed without a run, though the
  workflow shows as "active". Its skip logic was tested by
  hand (the 20:09 run above). If it still never fires, nothing breaks, because the Worker is the
  main trigger.
- **The duplicate check is imperfect** (see Decisions). If repeats annoy you, the next step is a
  cheap AI check on the top candidates once an hour in the job.
- **The workers.dev address** (`axiom-news.axiom-news-worker.workers.dev`) was created by wrangler
  automatically. Its HTTPS certificate took about 2 minutes to appear.
- **Gemini still skips items** in large answers (3 resends in the first GitHub run). The existing
  resend logic handled it.

## What the owner must do
1. **Over the next day, check on your phone** (the TEST bot @justatia_bot):
   - **Tomorrow at about 09:00, 14:00 and 20:00 (Yerevan),** a digest should arrive, at most
     ~5 minutes late. Each should:
     - start with "Good morning/afternoon/evening. Since …";
     - have numbered lines, each with a topic emoji and a **bold** headline, and a "Source:"
       line underneath;
     - show **no more than 3 stories from one topic** and no repeats of earlier digests.
   - **Tap 2-3 "Source" links** and check the articles open.
   - **You should get no alert messages.** An alert starts with "Axiom News alert:". If one
     comes, forward it to me (it contains no secrets). Expect at most one every 3 hours.
   - **Send the bot any text** (e.g. "hi"). It should answer with your digest times.
2. **Format:** done, B with line emojis (see the follow-up above). Tell me if any flag looks wrong;
   names are easy to add in `config/line_emoji.json`.
3. **Tell me if** tonight's forced digest (7 stories, about 23:25), the two previews and the test
   alert (about 23:50) all arrived.
4. **Nothing to install or pay.** The GitHub token has no expiration. If you ever delete it on
   GitHub, the Worker will alert you and the backup schedule keeps the news flowing until a new
   token is set.

## Follow-up (2026-11-14): format B with a context emoji on every line
The owner chose **format B** and asked for a fitting emoji at the start of each line.
- **The rule:** the flag of the **first** country, leader, capital, region or group the headline
  names (`config/line_emoji.json`, about 100 actors). If none, a subject icon (🕊️ 💥 🗳️ ⚖️ ⚡ 🛢️
  ☢️ 🌊 🌍 💰 💻). If none, the topic's emoji. The topic heading of format B keeps its emoji.
- **Real check** (400 headlines from the last 24 h): **378 flags, 17 subject icons, 5 topic
  fallbacks**. I read the first 70 by hand; they fit ("Mossad chief visited Washington" 🇮🇱,
  "Finnish Defense Minister..." 🇫🇮, "Houthis..." 🇾🇪). I removed traps found on the way: "Abbas"
  (would have tagged Iran's minister Abbas Araghchi as Palestinian), "Costa", "Congress", "RSF".
- **A known quirk:** the first actor wins, so "Russian strike on Zaporizhzhia" shows 🇷🇺 (who
  acted), not 🇺🇦 (where).
- **CPU:** a single big regex cost 3.6 ms just to build (a third of the Worker budget), so it is a
  word/phrase dictionary lookup instead: under 1 ms to set up, ~25 µs per line.
- **Length:** 15 of the longest headlines in format B with emojis: 2,812 visible characters
  (limit 4,096).
- **Tests:** 58 Worker tests (15 new emoji cases plus the format updates) and 34 Python tests pass.
- A new preview ("Preview B: grouped by topic (default), with line emojis", message id 2443) was
  sent to the owner. The Worker is redeployed; tomorrow's 09:00 digest uses this format.

## Suggested next step
**Step 4: the Mini App.**
- Settings: topics, times, number of stories, pause, and time zone auto-detection.
- An Admin tab for the owner: stats, errors, AI usage, "Send me a digest now".

All of it is served by the same Worker, with a "Settings" button in the `/start` reply. After
that, switch from the TEST bot to @axiom_news_bot.
