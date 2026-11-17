# Axiom News: rules for every session

Read `PROJECT_NOTES.md` first (spec, decisions, status). The repo is public: no secrets in code, logs
or reports. Never write an em or en dash, in any language. $0 a month, no card; Worker CPU under 10 ms.

## Two copies (Step 16): staging first, production only after "ship it"

| | Production | Staging |
|---|---|---|
| Worker | `axiom-news` | `axiom-news-staging` |
| D1 | `axiom-d1` (real story pool and users) | `axiom-d1-staging` (its own) |
| Bot | the real bot @axiom_news_bot (from launch) | the TEST bot @justatia_bot |
| Deploy | `npm run deploy:prod` (in `worker/`) | `npm run deploy:staging` |
| Hourly news job | yes (GitHub Actions) | never; it gets production's stories from `scripts/sync_staging.py` |

Rules, always:
1. **Every change goes to staging first.** Deploy it with `npm run deploy:staging`, check it there
   (tests, `AXIOM_ENV=staging node scripts/api-check.mjs`, the TEST bot), and tell the owner what to try.
2. **Production only after the owner says "ship it"** for that change, in his own words in chat. Then
   `SHIP_IT=yes npm run deploy:prod`. Never set SHIP_IT on your own. The guard
   (`worker/scripts/ship-check.mjs`) refuses unless the code is exactly what staging has and is committed.
3. **Never test on production**: no test users, test messages, previews, load tests or experiments
   against the production Worker, its D1 or the real bot. Scripts that write take `AXIOM_ENV=staging`.
4. **Job changes** (`job/`, `prompts/`, `config/` used by the job, `.github/workflows/`) run locally
   against staging before they are pushed to `main` (pushing to `main` is what changes production's
   hourly job):
   `AXIOM_ENV=staging venv/Scripts/python -m job.run --min-gap-minutes 0`
   Look at the result on staging (Admin on the TEST bot, `AXIOM_ENV=staging node scripts/digest-cli.mjs`),
   then push. A job run on staging makes real AI calls on the owner's free quota: one run, not many.
5. Secrets per copy: `venv/Scripts/python scripts/set_secrets.py worker-staging` / `worker-prod`.
   `.env` holds production values; `.env.staging` (never committed) holds only what differs for staging
   (its D1 id and webhook secret). Every script reads `.env.staging` on top when `AXIOM_ENV=staging`.
6. Fresh stories on staging on demand: `venv/Scripts/python scripts/sync_staging.py --hours 48`
   (the hourly job also syncs every 3 hours).

## How the owner asks for a change
He describes it. You make it, deploy it to staging, and send him a short note on the TEST bot saying
what to try. He tries it on his phone. When he says "ship it", you deploy that exact code to
production. If he asks for more changes, they go to staging again first.

## Working style
- Commits use the owner's GitHub noreply email. Reports in plain, short English.
- Each step keeps `reports/step-NN-progress.md` current (done, next, waiting on the owner).
