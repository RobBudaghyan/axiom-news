# Owner guide

Short, practical notes for running Axiom News. Commands run from the project folder in PowerShell unless
it says `cd worker` first. Nothing here needs a card or costs money.

## Alerts (Step 19)
The bot sends you no regular reports. It writes only when something needs you, at most once a day per
kind, and every alert ends with a "What to do:" line.

| Alert | When | What to do (short) |
|---|---|---|
| The news job failed | an hourly run ended with an error | read that run's log in GitHub Actions > hourly; one failure usually clears at the next run |
| A run never finished | still "running" after 30 minutes | cancel it in GitHub Actions; the next run starts by itself |
| No news run for 2+ hours | no successful run in 2 hours | check GitHub Actions, then Admin > Run news job now |
| GitHub start failed | the Worker could not start the job | check the GitHub token; the backup schedule (:37) keeps going |
| Digests failing | 3 or more failed today and at least 20% of tries | Admin > Errors ("digest for user"); Telegram outages clear by themselves |
| Many feeds down | 10 or more feeds failed 3 runs in a row | Admin > Feeds; switch dead feeds off in `config/sources.yaml` |
| AI budget | Gemini near its free daily limit, or refusing | nothing if rare; if daily, fewer languages or lower limits in `config/ai_budget.json` |
| Google blocking custom topics | no custom-topic search answered for 24 hours | nothing urgent; if it lasts days, lower `search_workers` in `config/custom_topics.json` |
| Database near its limit | D1 at 80% of the free daily rows | stop staging tests for today; if it repeats, switch off busy low-value feeds |
| Worker CPU | Cloudflare stopped runs over 10 ms | nothing if rare; if daily, see plan B below |

Admin shows the last alert at the top for a day.

## Daily stats
Table `daily_stats` in the production database: one row per day (UTC), written just after midnight UTC,
never deleted. Columns: users, active, new, deleted, digests sent / failed / blocked, stories per main
topic, languages in use, custom topics added and refused, feedback, AI calls and errors, D1 rows read and
written. Feedback is never deleted by age either (only when that reader deletes their data). To look:
```
cd worker; npx wrangler d1 execute axiom-d1 --remote --command "SELECT * FROM daily_stats ORDER BY day DESC LIMIT 14"
```

## Backups and restore (D1 Time Travel)
Cloudflare keeps every change to the database. It is always on, needs no setup and costs nothing.
**On our free plan you can go back to any minute in the last 7 days** (30 days needs the paid plan).
A restore overwrites the whole database in place (users, settings, stories, everything) and can itself be
undone, as long as you stay inside the 7 days.

1. Find the moment to go back to (before the mistake), as a Unix time or ISO date, and see its bookmark:
   ```
   cd worker; npx wrangler d1 time-travel info axiom-d1 --timestamp=2026-11-23T08:00:00Z
   ```
2. Write down the current bookmark first (the "undo" point):
   ```
   npx wrangler d1 time-travel info axiom-d1
   ```
3. Restore (it asks to confirm; queries running at that moment are cancelled):
   ```
   npx wrangler d1 time-travel restore axiom-d1 --timestamp=2026-11-23T08:00:00Z
   ```
4. Check: open Admin (users, stories today), or `npx wrangler d1 execute axiom-d1 --remote --command "SELECT count(*) FROM users"`.
5. Changed your mind? Restore to the bookmark from step 2:
   `npx wrangler d1 time-travel restore axiom-d1 --bookmark=<bookmark from step 2>`.

Staging is the same with `axiom-d1-staging`. Practise there first if you have never done it. Digests sent
between the restore point and now are not "unsent": readers may get a story again once.

**A copy older than 7 days:** export the database to a file now and then (keep it private, it holds user ids):
```
cd worker; npx wrangler d1 export axiom-d1 --remote --output=../backups/axiom-d1-2026-11-23.sql
```
(`backups/` is not committed). To load such a file into an empty database: `npx wrangler d1 execute <db> --remote --file=<file>`.

## Plan B for Worker CPU
If CPU alerts come daily: lower `max_users_per_tick` in `config/digest.json` (3 now; 2 halves the work per
minute, readers due at the same minute get their digest a minute or two later), deploy to staging, check,
then ship. Watch Cloudflare > Workers > axiom-news > Metrics > Errors (exceededCpu).

## Shipping a change
Every change goes to staging first; production only after you say "ship it" (see `CLAUDE.md`).
