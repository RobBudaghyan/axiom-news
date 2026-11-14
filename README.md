# Axiom News v2

A Telegram news digest bot for a small private group (~20 people). Every hour it collects
~115 RSS news feeds, groups duplicate stories with one AI pass, then an "editor" AI pass compares
the strongest stories side by side, merges duplicates, scores them strictly and writes the
headlines. Each user gets a short digest of what clears the bar at their chosen times in their own
time zone. It runs on free tiers only
(GitHub Actions + Cloudflare Workers/D1 + Gemini, with Groq as fallback).

**Status:** Step 5 done (the editor pass, new digest rules and format, Mini App in brand red).
Step 6 (a coverage experiment with Google News search feeds, in shadow mode only: it changes
nothing users see) is collecting data; see `reports/step-06-coverage-experiment.md`. Everything runs in the cloud with the owner's PC off, still on the TEST
bot: the Cloudflare Worker answers the bot, sends digests every 5 minutes, starts the hourly
GitHub Actions job at about :07, and serves the Telegram Mini App (settings for everyone, an
Admin tab for the owner; screenshots in [docs/screenshots](docs/screenshots)). See
[PROJECT_NOTES.md](PROJECT_NOTES.md) for status and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for the design.

## Layout

| Path | What |
|---|---|
| `config/topics.yaml` | the 6 topics users can pick |
| `config/sources.yaml` | the RSS feeds, with region/language/paywall/state-owned/tier labels; `enabled: false` switches one off |
| `config/digest.json` | digest settings (editorial and topic bars, max 12 stories, 40% topic cap, dedupe threshold, users per tick, allowed times) |
| `config/gnews_queries.yaml` | Step 6 experiment: Google News search terms per topic (shadow mode only) |
| `config/line_emoji.json` | fallback line emojis when the editor gave none (names, capitals, groups, subjects) |
| `prompts/story_batch.md` | the first hourly AI prompt (group, tag, score, summarize) and its output schema |
| `prompts/editor.md` | the editor prompt (merge, strict score, main topic, headline, description, emojis) |
| `db/schema.sql` | D1 tables |
| `job/` | the hourly job (`python -m job.run`), with near-duplicate grouping (`job/dupes.py`) and the editor pass (`job/editor.py`); Step 6 shadow collection `job/shadow.py` + `job/gnews.py` |
| `tests/` | Python unit tests for the job |
| `worker/` | the Cloudflare Worker (`src/`), the Mini App (`public/app/`), tests (`test/`) and tools (`scripts/`) |
| `docs/screenshots/` | the Mini App at phone width, light and dark, with invented demo data |
| `.github/workflows/` | `hourly.yml` (started by the Worker; its last step is the Step 6 shadow collection), `backup-schedule.yml`, `check-feeds.yml`, `gnews-probe.yml` |
| `scripts/check_feeds.py` | re-checks every feed and prints a health table |
| `scripts/apply_schema.py` | applies `db/schema.sql` (and column migrations) to D1 |
| `scripts/set_secrets.py` | copies `.env` values to GitHub and Worker secrets without printing them |
| `scripts/scan_secrets.py` | checks the whole git history and all files for secrets before a push |
| `scripts/ai_probe.py` | real batch-size test for Gemini and Groq |
| `scripts/gnews_probe.py`, `scripts/shadow_ai_sample.py` | Step 6: Google News feasibility probe; one-off AI pass over shadow items in a sandbox |
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
cd worker && node scripts/digest-cli.mjs --preview --dry      # print a preview of the last 24 h
cd worker && node scripts/digest-cli.mjs --windows            # replay the owner's digests of the last 24 h (--bars 7,6)
venv/Scripts/python -m job.editor --backfill                  # run the editor over the current pool (a few AI calls)
cd worker && npm run deploy                                   # stamp the Mini App files, deploy the Worker
cd worker && node scripts/dev-server.mjs                      # Mini App preview with demo data: localhost:8790/app/
cd worker && node scripts/ui-check.mjs                        # click through the preview (start it first)
cd worker && node scripts/screenshots.mjs                     # screenshots of the preview -> docs/screenshots
cd worker && node scripts/api-check.mjs                       # check the live Mini App API (TEST bot)
cd worker && node scripts/setup-bot.mjs                       # set the bot's menu button and commands
cd worker && node scripts/migrate-times.mjs --dry             # Step 5: half-hour digest times -> nearest hour
venv/Scripts/python -m job.shadow --dry-run --show 20         # Step 6: fetch Google News, compare, write nothing
venv/Scripts/python scripts/gnews_probe.py                    # Step 6: Google News feasibility probe (no keys)
venv/Scripts/python scripts/shadow_ai_sample.py --dry-run     # Step 6: sandbox AI sample (drop --dry-run: 1-2 AI calls)
venv/Scripts/python scripts/scan_secrets.py                   # run before every push
```

On GitHub: Actions tab -> "hourly job" -> Run workflow runs the job by hand; "check feeds" checks
the feeds from GitHub's servers. Setting `AXIOM_DEBUG_DIR` makes `job.run` save every AI prompt
and raw answer to that folder.
