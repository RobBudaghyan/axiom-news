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

## Next
- **Part 2: custom topic rule** (only a custom topic that means a WHOLE main topic is redirected;
  Stocks, Finance, Crypto, Oil, AI startups and the like become normal custom topics).
- Parts 3 to 7: the owner's message was cut off in the middle of Part 2, so they are not known yet.

## Ship (owner pre-approved "ship it" for the whole step), in this order
1. Merge `step-19` into `main` and push (the job's new topics, prompts and feeds).
2. `cd worker; npm run deploy:staging`, then `SHIP_IT=yes npm run deploy:prod`.
3. `node scripts/migrate-step19.mjs --dry`, then without `--dry` (production users and stories).
4. `node scripts/setup-bot.mjs` (real bot) and `AXIOM_ENV=staging node scripts/setup-bot.mjs` (TEST
   bot): the new bot descriptions.

## Waiting on the owner
- The rest of the Step 19 brief (Parts 3 to 7, and the end of Part 2's examples).
