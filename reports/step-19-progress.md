# Step 19 progress

Work is on branch `step-19` (pushed). It is merged into `main` only at ship time, because pushing to
`main` changes production's hourly job at once (CLAUDE.md rule 4), and the job, the Worker and the D1
migration must change together.

## Done
- **Part 1: main topics (2026-11-23).** Technology & AI in (💻, all four languages), Russia out,
  order Politics & Conflicts, Economy & Markets, Technology & AI, Armenia, Iran War, Ukraine War; eight
  tech feeds; boost cap 1; prompts, dictionaries, bot description, Mini App tint; migration script.
  Staging: Worker deployed (a7d0824e), migration run, one normal job run and one 48 h tech-feed
  backfill, 48 h replay. Details and numbers: `reports/step-19-topics.md`. Tests: Worker 343, Python 185,
  click-through 164 (one earlier run had 3 timing failures in edit mode; the rerun passed all).

- **Part 2: custom topic rule (2026-11-23).** Refused only when the name means a WHOLE main topic:
  labels in every language plus `main_aliases` (Economy, Markets, Tech, Technology, Armenian news,
  Politics, War in Ukraine and the like, in English and Russian) with no AI call; the check prompt has
  the same rule with narrower examples; `not_main` (AI, ИИ, artificial intelligence) wins over the
  model, which still called "AI" Technology & AI. Real model (`worker/scripts/step19-topic-check.mjs`):
  Stocks, Finance, Crypto, Oil, AI startups, AI, Banking, Chips, Cybersecurity, Armenian diaspora,
  Russia are added as custom topics; Economy, Markets, Economic news, Tech news, Новости технологий go
  to the main topic; "World news" is too broad. Staging Worker 1e149933, api-check 11 of 11. Tests:
  Worker 346 (two rules broken on purpose, both caught), Python 185.

- **Part 3: languages (2026-11-23).** French and Armenian on; order English, Russian, French, Armenian
  (🇬🇧 🇷🇺 🇫🇷 🇦🇲) in the picker (a 2x2 grid in Settings and setup: each button spans 3 of 6 columns),
  the dictionaries, setup-bot and Admin. TEST bot set up: commands, menu button, description and about in
  all four, English as the default with no language code (`AXIOM_ENV=staging node scripts/setup-bot.mjs`:
  OK). Found and fixed: Armenian main topic names wrapped to two lines (56 px rows): a name that does not
  fit now gets a smaller font (13 px at least); Armenian "Politics & Conflicts" (38 letters) did not fit
  360 px even at 12 px, so it is now "Քաղաքականություն" (Politics) **(owner: please confirm the
  wording)**. Click-through now covers en, ru, fr, hy at 360, 390, 430 px, light and dark: 248 checks
  pass. Worker 350 tests.
  **AI budget:** the primary Gemini model made 100 to 127 calls a day this week (pass 1, editor, Russian
  translation, topic checks), against our soft limit of 250 (the guard delays topic checks at 80%, 200).
  Each language someone reads adds one call per run with new stories, about 20 a day (Russian: 18 to 23).
  With French and Armenian readers: about 145 to 175 a day, 58% to 70%. No reader, no call. On a bad day
  (Gemini overloaded, many retries) the fallback model takes the rest; its limit is also 250.

- **Part 4: welcome video (2026-11-23).** `branding/marketing/source/howitworks.html` rebuilt: the logo
  animation (as `welcome-1280x720.mp4`), then a wide white Settings screen (560 of 640 px, was 183) with the
  six main topics (Technology & AI, no Russia) and Formula 1 in two columns, the times grid, a digest
  arriving; fades to plain red, its first frame (checked: first and last frames are plain red). 11 s,
  1280x720, 222 KB, no words. Installed as `worker/public/media/welcome.mp4`, sent with duration 11 and
  `?v=19` on the URL. Staging serves it (200, video/mp4). Worker 351 tests. Tools after the PC restart:
  Twemoji 15.0.0 and imageio-ffmpeg reinstalled in the session scratchpad (not in the repo).

- **Part 5: alerts, daily stats, backups (2026-11-23).** No regular reports exist (checked: Admin is
  pull-only). `worker/src/watch.js`: every alert kind at most once a UTC day with a "What to do:" line;
  kept: D1, CPU, failed run, stuck run, AI guard; added: digests failing (3+ failed and 20% of tries
  today), many feeds down (10+ feeds failing 3 runs in a row), no news run for 2+ hours (was 3), Google
  silent for 24 h with active custom topics. Table `daily_stats` (schema in `db/schema.sql`, applied to
  staging): one row per UTC day, written once by the first hourly tick after 00:00 UTC; digests and
  deletions counted live; not in the prune; feedback is not pruned by age either. **Backups:** D1 Time
  Travel is on for both databases (checked with `wrangler d1 time-travel info`); Cloudflare's docs: any
  minute in the last 7 days on the free plan (30 on paid), always on, a restore overwrites in place and
  can be undone. Restore steps in `OWNER_GUIDE.md` (new) and `docs/ARCHITECTURE.md`. Worker 359 tests.
  **At ship:** apply the schema to production (`venv/Scripts/python scripts/apply_schema.py`).

- **Part 6: branding (2026-11-23).** Texts in four languages: the bot description names Politics, Economy,
  Technology & AI, Armenia, Iran, Ukraine and "custom topics of your own (e.g. Stocks or Formula 1)", keeps
  "Available in several languages", no Russia; Help "Topics" opens with the six main topics; the Add a topic
  hint is "e.g. Stocks, Formula 1, Japan". Re-rendered from fresh staging data (French and Armenian
  translations made once with the job's Translator on staging, 2 AI calls) and fresh Mini App shots: profile
  previews `branding/out/preview-{en,ru,fr,hy}-{setup,settings,digest}.png` (setup crop fixed for the 2x2
  grid), share cards `branding/out/share-{en,ru,fr,hy}-1080x{1080,1920}.png`, all 60 Story videos
  `branding/marketing/story/<len>/<look>/axiom-story-*-{en,ru,fr,hy}.mp4` (topics with Technology & AI,
  four flags 2x2), feed post and carousel `branding/marketing/feed/*-{en,ru,fr,hy}-*.png`, the What's new
  card (now announcing Technology & AI and the two languages), `review.html` (four-language switch) and the
  README captions (French and Armenian added). The kits now fall back to Segoe UI for Armenian. Click-through
  248 of 248; 33 of 33 rules broken on purpose caught (`scripts/step19_mutations.py`; three weak tests were
  strengthened first).

### What the owner must redo by hand (everything else is automatic)
1. **BotFather > your bot > Edit Mini App (Main Mini App) > Previews**, one set per language (en, ru, fr,
   hy): replace the old images with `branding/out/preview-<lang>-setup.png`,
   `branding/out/preview-<lang>-settings.png`, `branding/out/preview-<lang>-digest.png`. French and
   Armenian are new sets.
2. Nothing for the description and about: `setup-bot.mjs` sets them in all four languages (run at ship).
   The description picture (`branding/out/description-640x360.mp4`) and the profile photo show only the
   logo, so they stay.
3. **Phone / Instagram:** post or schedule from `branding/marketing/` (open `review.html`): Stories
   `story/...-<lang>.mp4`, feed `feed/axiom-post-<lang>-1080x1350.png` and the carousel
   `feed/axiom-carousel-<lang>-<1..4>-1080x1350.png`, the What's new card `whats-new/whats-new-1080x1350.png`
   or `-1080x1920.png`; captions in `branding/marketing/README.md`. Share cards to send to friends:
   `branding/out/share-<lang>-1080x1080.png` and `-1080x1920.png`.
4. Confirm the Armenian name of Politics & Conflicts: now just "Քաղաքականություն" (the long form did not
   fit a phone row).

## Next
- Part 7: ship and check.

## Ship (owner pre-approved "ship it" for the whole step), in this order
1. Merge `step-19` into `main` and push (the job's new topics, prompts and feeds).
2. `cd worker; npm run deploy:staging`, then `SHIP_IT=yes npm run deploy:prod`.
3. `venv/Scripts/python scripts/apply_schema.py` (production: the new `daily_stats` table), then
   `node scripts/migrate-step19.mjs --dry`, then without `--dry` (production users and stories).
4. `node scripts/setup-bot.mjs` (real bot) and `AXIOM_ENV=staging node scripts/setup-bot.mjs` (TEST
   bot): the new bot descriptions.

## Waiting on the owner
- The rest of the Step 19 brief (Parts 3 to 7, and the end of Part 2's examples).

## Baseline before shipping (production, read-only, 2026-11-23, last 24 h)
24 runs, average 105 s (longest 353 s); job D1 writes 22,720, reads 575,294; 3,201 new items; tokens
1,611,328 in, 470,638 out; 148 job AI calls. Account D1 today (UTC, so far, staging tests included): 611k
reads, 31.3k writes; yesterday 593k reads, 17.9k writes.
