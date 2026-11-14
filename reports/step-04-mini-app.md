# Step 04: The Mini App (Milestones 4 + 5)

Date: 2026-11-14. Still on the TEST bot (@justatia_bot).

## Summary
The bot now has a settings screen inside Telegram (a "Mini App"). It is served by the same
Cloudflare Worker, at `https://axiom-news.axiom-news-worker.workers.dev/app/`.

- **Ways to open it:**
  - the new **"Settings" button next to the message box** (the chat menu button);
  - the **"Open settings" button** under the `/start` welcome;
  - the new **`/settings`** command.
- **Everyone gets a Settings tab:** topics, digest times, stories per digest, format A or B, time
  zone (detected from the phone), pause, and "Next digest: Today at 14:00". Changes save the
  moment you make them, with a small "Saved" confirmation.
- **You (the owner) also get an Admin tab:**
  - health at a glance and pipeline numbers for 24 hours / 7 days;
  - failing and silent feeds, users, recent errors, database use today;
  - two buttons, "Send me a digest now" and "Run news job now". Both ask before they run.
- **Security:** every request is checked against Telegram's signature on the server. Admin
  requests from anyone but you are refused (403), whatever the app shows.
- **Speed:** every API call stays well under the 10 ms CPU limit, measured on Cloudflare: open
  3-6 ms, save 1-5 ms, admin data __ADMIN_CPU__.
- **Look:** it follows Telegram's light and dark themes, with one fixed blue accent, iOS-style
  rounded groups, haptic taps, and Telegram's own Back and bottom buttons. Screenshots are in
  `docs/screenshots/`.

## What was done
1. **Server side (`worker/src/`):**
   - `auth.js`: checks Telegram's `initData` the official way (HMAC with the bot token), refuses
     data older than 24 hours or dated in the future, and compares in constant time. The user id
     only ever comes from checked data.
   - `settings.js`: validates every setting with friendly messages and computes the next digest
     time.
   - `api.js`: five routes (`open`, `settings`, `admin`, `admin/digest`, `admin/run-job`). The
     owner check runs on every admin call.
   - `admin.js`: all Admin data in one database round trip, with the totals computed by the
     database rather than by the Worker (CPU).
2. **The Mini App (`worker/public/app/`):** three files, no framework, 64 KB (20 KB compressed).
   Cache rules from lesson 12:
   - the page is never cached;
   - the CSS and JS carry a content hash in their address (`npm run stamp`, run automatically
     by `npm run deploy`, and checked by a test).
3. **Bot:**
   - `/start` now ends with "Tap Open settings to change topics, times and more" and has the
     button;
   - new `/settings` command with the same button;
   - help replies mention `/settings`;
   - `scripts/setup-bot.mjs` set the chat menu button and the command list, then read them back.
4. **Hourly job** (needed for the Admin tab):
   - each run now saves per-feed health: last success, newest item, current error, and how many
     runs in a row it failed. It is one database row (`meta.feed_health`);
   - each run also saves its exact database row counts (`job_runs.d1_rows_read/_written`).
5. **Database:** new columns `users.format`, `job_runs.d1_rows_read`, `job_runs.d1_rows_written`,
   applied to the live D1 with `scripts/apply_schema.py`. They were applied **before** the new
   job code was pushed, so no run could fail on a missing column.
6. **Worker D1 counter:** the Worker adds up the rows D1 reports for its own queries and writes
   the day's total every 5-minute tick (`meta.d1_worker`).
7. **Tools:**
   - `dev-server.mjs`: a local preview running the real API code over invented demo data, with a
     stand-in for Telegram;
   - `screenshots.mjs`: headless Edge, 390 px, light and dark;
   - `ui-check.mjs`: a 23-step click-through;
   - `api-check.mjs`: checks the live API using data signed with the bot token from `.env`.
8. **Docs:** ARCHITECTURE (new §4a, plus the database, security, limits and layout sections),
   PROJECT_NOTES, README, and LESSONS 24-26.

## Files created / changed
- **New:**
  - `worker/src/`: `api.js`, `auth.js`, `settings.js`, `admin.js`;
  - `worker/public/`: `app/index.html`, `app/app.css`, `app/app.js`, `_headers`;
  - `worker/test/`: `api.test.mjs`, `app.test.mjs`;
  - `worker/scripts/`: `stamp-app.mjs`, `setup-bot.mjs`, `dev-server.mjs`,
    `dev/mock-telegram.js`, `dev/cdp.mjs`, `screenshots.mjs`, `ui-check.mjs`, `api-check.mjs`;
  - `docs/screenshots/` (8 PNGs) and this report.
- **Changed:**
  - `worker/src/`: `index.js` (API route, app URL), `bot.js` (`/settings`, buttons),
    `telegram.js` (buttons), `cron.js` (D1 counter), `db.js` (row counting), `digest.js`
    (per-user format), `health.js` (alert text kept for the Admin tab);
  - `worker/wrangler.toml` (static assets, `APP_URL`), `worker/package.json` (scripts);
  - `config/digest.json` (settings limits, formats, 20-minute job gap, 48 h silent feeds);
  - `db/schema.sql`, `scripts/apply_schema.py`;
  - `job/fetch.py` (`feed_health`), `job/run.py` (writes it and the D1 counts),
    `tests/test_job.py`;
  - `docs/ARCHITECTURE.md`, `docs/LESSONS.md`, `PROJECT_NOTES.md`, `README.md`.
- **Not committed:** `.env` (unchanged).

## Tests run and real results

### Unit tests
- **Worker:** `cd worker && node --test test/` gives **115 tests, pass** (58 before, 57 new).
  The new ones cover:
  - **initData:**
    - valid data passes;
    - Telegram's exact check string (all fields except `hash`, sorted);
    - **tampered** data is refused: a changed user id, a changed date, the wrong bot token, or a
      missing hash;
    - **expired** data (over 24 h) and future dates are refused;
    - without valid data the API answers 401, and an id in the request body is ignored.
  - **Admin gating:** for each of the 3 admin routes, a non-owner gets **403** and nothing is
    sent or started; the owner gets 200. `is_owner` is true only for the owner.
  - **Settings validation:** 21 bad inputs refused with friendly messages, among them:
    - no topics, an unknown topic;
    - 06:30, 22:30, 09:15, 6 times;
    - 2 or 16 stories;
    - format C, an unknown zone, an injection attempt in the zone, `blocked` or
      `next_digest_at` sent as "settings".

    Good inputs are normalised (sorted times, topic order, duplicates removed). A bad save
    through the API is a 400 and writes nothing.
  - **next_digest_at recompute:**
    - new times, and a new zone (09:00 Berlin = 12:00 Yerevan);
    - a due digest is kept; pausing drops it; resuming starts at the next slot;
    - the API writes the same value it returns;
    - a user's format A is used by the real cron digest.
  - **Open:**
    - a new user gets the defaults plus the phone's zone;
    - a default zone follows the phone, while a zone chosen by hand is kept;
    - a junk zone is ignored.
  - **Admin data:** health, 24 h / 7 d stats, model stats, users, failing and silent feeds, D1
    use; a late trigger and a recent alert give "needs a look".
  - **Admin buttons:**
    - the digest is real and never repeats;
    - the job dispatch respects the 20-minute gap and a running job;
    - a GitHub failure is reported and logged.
  - **Bot:** `/start` and `/settings` carry the `web_app` button.
  - **D1 counter:** it adds up per UTC day and starts over the next day, and every cron tick
    writes it.
  - **Mini App files:**
    - the hash stamps are current;
    - the page is `no-store`, with no wildcard header rule;
    - no em/en dash anywhere;
    - the accent is fixed, never Telegram's button colour.
- **Python:** `venv/Scripts/python -m unittest discover -s tests -t .` gives **36 tests, OK**.
  New: feed-health streaks and recovery, removed feeds, undated entries, and a run that writes
  `meta.feed_health` and the D1 counts.
- **Mutation checks** (I broke the code on purpose, ran the tests, then restored it):

  | Broken on purpose | Tests that failed |
  |---|---|
  | owner check removed from the admin API | 3 |
  | 24-hour expiry removed | 2 |
  | signature comparison removed | 1 |
  | "keep a due digest" rule removed | 1 |
  | 5-times limit removed | 1 |

### The Mini App in a headless browser (local preview, invented demo data)
`node scripts/ui-check.mjs` drives headless Microsoft Edge at 390 px through the preview, which
runs the real API code. All **23 checks pass**, with no console errors:
- **Topics:**
  - switching a topic on is saved and shows "Saved";
  - the last topic cannot be switched off ("Keep at least one topic").
- **Times:**
  - Add a time shows Telegram's Back button, and the bottom button reads "Add 18:30";
  - adding saves, closes the screen and hides the Back button;
  - the next digest moves earlier (18:30 before 19:00);
  - removing a time is saved.
- **Stories and format:** two quick + taps save +2 in one request, and format A is saved.
- **Time zone:**
  - the search finds Berlin;
  - picking it saves it as "chosen by hand", and "Use it" then restores the phone's zone.
- **Pause:** pause and resume are saved, and the top card shows "Paused" / "Next digest".
- **Admin:**
  - a non-owner sees no Admin tab, and the admin API answers them 403;
  - for the owner, "Send me a digest now" asks first, then sends 3 stories;
  - "Run news job now" answered "The news job last ran at 10:07. You can start it again from
    10:27.";
  - Cancel in the confirm popup does nothing.

### Screenshots (`docs/screenshots/`, 390 px wide, made with `node scripts/screenshots.mjs`)
| File | What |
|---|---|
| `settings-light.png`, `settings-dark.png` | the Settings tab, full page (a demo user with 3 of 6 topics on) |
| `add-time-light.png`, `add-time-dark.png` | the Add a time screen with 18:30 picked and Telegram's bottom button |
| `timezone-light.png`, `timezone-dark.png` | the time zone screen (Suggested, Popular, search) |
| `admin-light.png`, `admin-dark.png` | the Admin tab, full page |

I looked at every one and fixed what looked unpolished before deploying:
- squashed user avatars and invisible feed status dots (a CSS width bug);
- red "failed" badges that showed green in dark mode;
- "111 s" became "1 min 51 s";
- technical feed errors became plain words ("Blocked by the site (HTTP 403)", "Timed out");
- the AI tokens row was split oddly;
- the time zone list started at "Abidjan, Africa", so it now shows a short Popular list;
- Yerevan was listed twice;
- "Newest first" errors were not sorted by time.

All names and numbers in the screenshots are **invented demo data**, never real users, because
the repo is public. Windows has no flag emoji, so the preview loads a flag-only font; on a phone,
the phone's own flags are used (lesson 25). The bottom blue button in `add-time-*` is the
preview's imitation of Telegram's button.

### Deploy and the live TEST bot
- **Deployed** (version `29467acf`). Checked what is actually served (lesson 12):
  - `/app/` comes with `Cache-Control: no-store` and the security policy;
  - `app.js` is served with the same hash as on this PC (`c14e21ecf2`);
  - `/_headers` is not exposed;
  - `/app` redirects to `/app/`.
- **Live API** (`node scripts/api-check.mjs`, initData signed with the TEST bot token from
  `.env`, never printed): **8 of 8 pass**.
  - opened as the owner: 200, `is_owner` true;
  - **a real settings change was saved in D1:** your "stories per digest" went 7 → 8, confirmed
    by reading the `users` row through the D1 REST API. The returned next digest matched D1
    (14:00 Yerevan), and the value was then **restored to 7**;
  - a 23:00 digest time was refused with the friendly message (400);
  - Admin data for you: 200. For a different, correctly signed user: **403**. A tampered
    signature: **401**.
  - Side effect: your row now says the time zone came from the device (`tz_detected` 1, still
    `Asia/Yerevan`). Your phone will do the same on first open.
- **Menu button:** set, and read back from Telegram with `getChatMenuButton`:
  `{"type":"web_app","text":"Settings","web_app":{"url":"https://axiom-news.axiom-news-worker.workers.dev/app/"}}`.
  The command list reads back as `/start` and `/settings`.
- **`/settings`:** I sent the live webhook one `/settings` update in your name, signed with the
  webhook secret. Telegram accepted the reply with the "Open settings" `web_app` button: webhook
  200, 2 ms CPU, no error logged. **You should have that message in the chat:** "Choose your
  topics, digest times and how many stories you get. Changes are saved as soon as you make
  them."
- **What I could not do from here:** open the app inside the real Telegram on a phone. Whether
  it renders, vibrates and accepts your signature on your phone is on your list below.

### Worker CPU against the 10 ms limit (measured on Cloudflare, `wrangler tail` cpuTime)
| Call | Calls measured | CPU |
|---|---|---|
| `POST /api/open` (open the app) | 4 | 3, 3, 4, **6** ms (6 = a cold start) |
| `POST /api/settings` (save a change) | 12 | 1-5 ms |
| `GET /api/admin` (Admin tab) | 12 | 0-3 ms (before any feed data existed) |
| `GET /api/admin` with real feed health | __N_ADMIN2__ | __ADMIN2__ |
| `POST /telegram` `/settings` | 1 | 2 ms |
| 5-minute tick (with the new D1 counter) | 2 | 2 ms |

"Send me a digest now" does the same work as the cron's single-user digest, which was measured
at 6 ms in Step 3. I did not press either admin button on the live system: those are yours to
try (see below).

### The first hourly run with the new job code
__RUN__

## Decisions I made and why
- **No framework, three files.** The whole app is 20 KB compressed and opens instantly. It is
  also small enough to read.
- **The format became a per-user setting.** The spec asks for it in the app. Your choice of B
  stays the default for everyone who never touches it.
- **Time zone rule.** The phone's zone is saved on every open, so it follows you when you
  travel, unless you picked a zone by hand. Then it is kept, and the app offers "Use it" when
  the phone's zone differs.
- **A due digest survives a settings change.** Saving at 14:02 keeps the 14:00 digest, which the
  next 5-minute tick sends.
- **"Run news job now" refuses within 20 minutes of the last run** and says from when it is
  possible. That is the same gap the dispatched job already enforces, so you get a clear answer
  instead of a silent skip on GitHub.
- **"Send me a digest now" is a real digest.** It is recorded in `sent` like a scheduled one,
  as the spec says. The next scheduled digest then starts "Since <that time>".
- **Silent feed** means the newest item in the feed itself is more than 48 hours old, whether
  or not we stored it. That separates a dead feed from one that only repeats old items.
- **Database use.**
  - The job's numbers are exact, from D1's own per-query counts.
  - The Worker's numbers are added up by the Worker and written every tick (about 288 rows a
    day, 0.3% of the write limit).
  - Cloudflare's usage API would need a new token with more rights, so I did not use it.
- **Admin text in plain words.**
  - Errors: "Blocked by the site (HTTP 403)", "Timed out".
  - The provider label "gemini-fallback" is shown as "Gemini backup".
  - The job's routine "answer skipped N items" notes stay in Recent errors, with a footnote that
    they are normal.
- **The demo data in screenshots is invented.** The repo is public, and the Admin tab lists
  users by name.

## Problems / risks / open questions
- **Not yet seen on a real phone.** I tested in desktop Edge with a stand-in for Telegram.
  Telegram on iOS and Android may differ in small ways: fonts, the bottom button, the safe area
  on phones with a notch. Your check below is the real test.
- **If the app says "Please close and reopen the settings from the bot"**, the server refused the
  signature. I followed Telegram's documented rule (every field except `hash`) and tested it
  with data signed the same way. A real phone is the first chance to see Telegram's own
  signature, though, so tell me at once if this appears.
- **My mistakes, caught and fixed:**
  - Two scripted edits did nothing, because some files have Windows line endings, and a
    third lost its backslashes. A test caught one, and reading the diff caught the others
    (lesson 24).
  - The first version of the Worker's D1 counter waited for a later tick in the same instance
    and wrote nothing on Cloudflare. It now writes every tick (lesson 26).
- **The Worker's D1 count is a slight undercount** (a short-lived instance that serves Mini App
  calls and then ends loses its count). The job's exact numbers are most of the total.
- **The session was interrupted once by a restart.** Afterwards I re-checked the working tree and
  re-ran all tests before continuing; nothing was lost.
- **The backup schedule (:37)** from Step 3 is unchanged by this step.

## What the owner must do
On your phone, in the chat with the TEST bot **@justatia_bot**:

1. **Open the app three ways:**
   - tap **Settings** next to the message box;
   - tap **Open settings** under my `/settings` message;
   - send `/settings` yourself and tap the button.

   It should open in a second, with the title "Settings" and a card saying **"Next digest: Today
   at 14:00"** (or the next time that applies).
2. **Light and dark:** switch Telegram to night mode (Settings > Appearance) and back. The app
   should follow both, with nothing hard to read.
3. **Topics:** switch one topic off and on again. You should feel a light tap, and a small
   "Saved" appears at the bottom. Then try to switch all of them off: the last one refuses with
   "Keep at least one topic".
4. **Times:**
   - tap **Add a time** and pick 11:30;
   - press the blue **Add 11:30** button at the bottom; 11:30 should appear in the list;
   - remove it again with the grey minus;
   - open Add a time once more and leave with Telegram's **Back** arrow (top left): nothing
     should be added.
5. **Stories per digest:** tap + and then −. It should end where it started.
6. **Format:** tap **Simple list**, then **By topic** again (or keep the one you like; the next
   digest uses it).
7. **Time zone:** it should say **Yerevan, GMT+4** and "Set automatically from your phone".
   - Open it, search **London** and pick it. The next digest time should change.
   - Then tap **Use it** under the row to go back to Yerevan.
8. **Pause:** switch it on. The top card says "Paused". Switch it off again: the next digest is
   back.
9. **Admin tab** (the switch at the top, only you have it):
   - it should say **"All systems normal"** and show the feeds, you as the only user, and the
     database bars;
   - tap **Send me a digest now** and confirm. A real digest arrives in the chat. It counts as
     real, so those stories will not come again at 14:00;
   - tap **Run news job now** and confirm. Within 20 minutes of the last run it tells you from
     what time it is possible; otherwise it says "Started". Tap **Refresh** after 2 minutes.
10. **Close the app and open it again:** your settings should still be there.
11. **Tell me:**
    - anything that looks off, feels slow, or reads unclearly (a phone screenshot helps);
    - whether you felt the taps;
    - whether you ever saw "Please close and reopen the settings from the bot".

Nothing to install or pay. Leave your settings the way you want them: the next digests follow
them.

## Suggested next step
**Step 5: switch to the real bot @axiom_news_bot.**
- Put the real token in `.env`, then set the Worker secrets and the webhook.
- Run `node scripts/setup-bot.mjs` for the menu button.
- Check once with `/start`, then invite the first users.

Before that, fix anything you find on your phone in this step.
