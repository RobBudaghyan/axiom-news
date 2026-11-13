# Axiom News v2

A Telegram news digest bot for a small private group (~20 people). Every hour it collects
~115 RSS news feeds, groups duplicate stories with one AI pass, and sends each user a short
digest at their chosen times in their own time zone. It runs on free tiers only
(GitHub Actions + Cloudflare Workers/D1 + Gemini, with Groq as fallback).

**Status:** Step 3 done. Everything runs in the cloud with the owner's PC off, still on the TEST
bot: the Cloudflare Worker answers the bot, sends digests every 5 minutes and starts the hourly
GitHub Actions job at about :07. The Mini App comes in Step 4. See
[PROJECT_NOTES.md](PROJECT_NOTES.md) for status and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for the design.

## Layout

| Path | What |
|---|---|
| `config/topics.yaml` | the 6 topics users can pick |
| `config/sources.yaml` | the RSS feeds, with region/language/paywall/state-owned/tier labels; `enabled: false` switches one off |
| `config/digest.json` | digest settings (format B, line emojis, stories, 40% topic cap, dedupe threshold, users per tick) |
| `config/line_emoji.json` | which flag or icon starts each digest line (names, capitals, groups, subjects) |
| `prompts/story_batch.md` | the hourly AI prompt (group, tag, score, summarize) and its output schema |
| `db/schema.sql` | D1 tables |
| `job/` | the hourly job (`python -m job.run`), including near-duplicate grouping (`job/dupes.py`) |
| `tests/` | Python unit tests for the job |
| `worker/` | the Cloudflare Worker (`src/`), its tests (`test/`) and `scripts/digest-cli.mjs` |
| `.github/workflows/` | `hourly.yml` (started by the Worker), `backup-schedule.yml`, `check-feeds.yml` |
| `scripts/check_feeds.py` | re-checks every feed and prints a health table |
| `scripts/apply_schema.py` | applies `db/schema.sql` (and column migrations) to D1 |
| `scripts/set_secrets.py` | copies `.env` values to GitHub and Worker secrets without printing them |
| `scripts/scan_secrets.py` | checks the whole git history and all files for secrets before a push |
| `scripts/ai_probe.py` | real batch-size test for Gemini and Groq |
| `docs/` | architecture and lessons from the old project |
| `reports/` | one report per development step |

## Setup (Windows)

```bash
py -m venv venv
venv/Scripts/python -m pip install -r requirements.txt
cd worker && npm install
```

Copy `.env.example` to `.env` and fill it in. `.env` is gitignored; never commit it or paste its
values anywhere. Node.js LTS, `gh` (GitHub CLI) and wrangler (in `worker/node_modules`) are used
for deploys.

## Commands

```bash
venv/Scripts/python -m unittest discover -s tests -t .        # Python tests (no keys needed)
cd worker && node --test test/                                # Worker tests (no keys needed)
venv/Scripts/python scripts/check_feeds.py                    # feed health check (no keys needed)
venv/Scripts/python -m job.run                                # one real hourly run from this PC
venv/Scripts/python -m job.dupes                              # show near-duplicate pairs in the pool
cd worker && node scripts/digest-cli.mjs                      # print the owner's next digest (writes nothing)
cd worker && node scripts/digest-cli.mjs --preview B --dry    # print a format-B preview
cd worker && node node_modules/wrangler/bin/wrangler.js deploy  # deploy the Worker
venv/Scripts/python scripts/scan_secrets.py                   # run before every push
```

On GitHub: Actions tab -> "hourly job" -> Run workflow runs the job by hand; "check feeds" checks
the feeds from GitHub's servers. Setting `AXIOM_DEBUG_DIR` makes `job.run` save every AI prompt
and raw answer to that folder.
