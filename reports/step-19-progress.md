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

## Next
- Part 4: welcome video. Part 5: alerts, daily stats, backups. Part 6: branding. Part 7: ship and check.

## Ship (owner pre-approved "ship it" for the whole step), in this order
1. Merge `step-19` into `main` and push (the job's new topics, prompts and feeds).
2. `cd worker; npm run deploy:staging`, then `SHIP_IT=yes npm run deploy:prod`.
3. `node scripts/migrate-step19.mjs --dry`, then without `--dry` (production users and stories).
4. `node scripts/setup-bot.mjs` (real bot) and `AXIOM_ENV=staging node scripts/setup-bot.mjs` (TEST
   bot): the new bot descriptions.

## Waiting on the owner
- The rest of the Step 19 brief (Parts 3 to 7, and the end of Part 2's examples).
