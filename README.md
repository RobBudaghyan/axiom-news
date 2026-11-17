# Axiom News v2

A Telegram news digest bot for a small group of readers (about 20). It costs $0 a month and needs
no credit card: GitHub Actions, Cloudflare Workers and D1, and the free tiers of Gemini (Groq as
the fallback).

**What a reader gets:** a short digest of the most important news, one Telegram message at the
times they choose (by default 09:00, 14:00 and 20:00 in their time zone), on the topics they
switch on: six main topics (Politics & Conflicts, Economy & Markets, Armenia, Russia, Iran War,
Ukraine War) and up to three of their own ("My topics", e.g. Japan). Everything is in their
language (English and Russian on; Armenian and French built but hidden). Settings, Help and Send
feedback live in a Telegram Mini App. New readers get a short welcome, a 3-step setup and a sample
digest.

**Status:** Step 15 done, still on the TEST bot (@justatia_bot); the next step is the switch to the
real bot. See [PROJECT_NOTES.md](PROJECT_NOTES.md) for the spec, decisions and status, and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it works. Each development step has a
report in `reports/`.

## How a story reaches a reader

1. **Every hour** (GitHub Actions, started by the Worker at about :07) the job reads about 120 RSS
   feeds plus Google News searches for readers' own topics, and makes one AI pass: group the
   articles into stories, tag topics, score 1 to 10, write a one-line summary (`job/run.py`).
2. **The editor pass** compares the strongest stories of the last 24 hours side by side, merges
   duplicates and gives each a strict score, a main topic, a topic score, a headline, a short
   description and emojis (`job/editor.py`). A fact guard drops text with names or numbers that
   are not in the articles.
3. **Translation** of the stories that could reach a digest, into the languages readers use
   (`job/translate.py`).
4. **Every 5 minutes** the Worker sends the digests that are due (`worker/src/cron.js`). A story is
   in if its score is 7+, or the reader follows its main topic and its topic score is 6+ (with a
   boost cap per topic); a story whose main topic the reader switched off never reaches them; the
   message is cut to 3,900 characters; the same story never twice (`worker/src/digest.js`).

## Layout

| Path | What |
|---|---|
| `config/topics.yaml` | the six main topics (tag, names, emoji, the definition the AI sees) |
| `config/digest.json` | digest rules: the bars, topic boost caps, topic order, length limit, default times |
| `config/sources.yaml` | the RSS feeds with region, language, paywall, state-owned and tier labels |
| `config/custom_topics.json`, `config/ai_budget.json` | readers' own topics; the daily AI budget guard |
| `config/languages.json`, `config/i18n/<lang>.json`, `config/glossary.yaml` | reader languages, every text a reader sees, name spellings |
| `config/common_words.txt` | ordinary English words for the editor's fact guard (from `scripts/make_common_words.py`) |
| `config/line_emoji.json`, `config/candidates/` | fallback line emojis; feeds tested but not added |
| `prompts/` | the AI prompts: `story_batch.md` (first pass), `editor.md`, `translate.md` |
| `db/schema.sql` | the D1 tables (applied with `scripts/apply_schema.py`) |
| `job/` | the hourly job (Python): `run.py`, `fetch.py`, `ai.py`, `editor.py`, `translate.py`, `custom.py` + `gnews.py` (readers' topics), `dupes.py`, `guard.py`, `d1.py` |
| `worker/src/` | the Worker (JavaScript): `index.js` (routes and crons), `bot.js`, `api.js` (Mini App API), `digest.js`, `cron.js`, `custom.js`, `onboard.js` (welcome, setup, reminder), `announce.js` (owner announcements), `feedback.js`, `tips.js`, `admin.js`, `i18n.js` |
| `worker/public/app/` | the Mini App (three static files, no framework) |
| `worker/test/`, `tests/` | Worker tests (node) and job tests (Python); `tests/fixtures/` are shared by both |
| `worker/scripts/` | tools: dev server, click-through, screenshots, digest CLI, bot setup, migrations, user import |
| `scripts/` | tools: schema, secrets, feed checks, fixture generators, dev measurements |
| `scripts/archive/`, `worker/scripts/archive/` | one-off scripts of past steps (measurements, replays, previews), kept for the record |
| `.github/workflows/` | `hourly.yml` (the job), `backup-schedule.yml`, `check-feeds.yml` |
| `reports/` | one report per step; `reports/data/` their numbers and screenshots |
| `docs/` | architecture, lessons from the old project, Mini App screenshots |

## Setup (Windows)

```bash
py -m venv venv
venv/Scripts/python -m pip install -r requirements.txt
cd worker && npm install
```

Copy `.env.example` to `.env` and fill it in. `.env` is gitignored; never commit it or paste its
values anywhere. Node.js LTS, `gh` (GitHub CLI) and wrangler (in `worker/node_modules`) are used
for deploys.

## Everyday commands

```bash
venv/Scripts/python -m unittest discover -s tests -t .        # job tests (no keys needed)
cd worker && npm test                                         # Worker tests (no keys needed)
cd worker && node scripts/dev-server.mjs                      # Mini App preview with demo data: localhost:8790/app/ (?as=owner|friend|new)
cd worker && node scripts/ui-check.mjs                        # click through the preview at 360/390/430 px, en/ru, light/dark
cd worker && npm run deploy                                   # stamp the Mini App files and deploy the Worker
venv/Scripts/python scripts/apply_schema.py                   # apply db/schema.sql and column migrations to D1
venv/Scripts/python scripts/scan_secrets.py                   # run before every push
venv/Scripts/python -m job.run                                # one real hourly run from this PC
cd worker && node scripts/digest-cli.mjs                      # print the owner's next digest (writes nothing)
cd worker && node scripts/digest-cli.mjs --preview --topics all --lang en   # send the owner a labelled preview (writes nothing)
cd worker && node scripts/digest-cli.mjs --windows --profile all --hours 48 # replay digests of the last 48 h for test readers
cd worker && node scripts/import-users.mjs users.json --dry   # import the old bot's readers (no welcome; drop --dry to write)
cd worker && node scripts/setup-bot.mjs                       # the bot's menu button and commands (each enabled language)
cd worker && node scripts/api-check.mjs                       # check the live Mini App API (TEST bot)
venv/Scripts/python scripts/check_feeds.py                    # feed health check (no keys needed)
venv/Scripts/python -m job.editor --backfill                  # run the editor over the current pool (a few AI calls)
venv/Scripts/python -m job.translate --samples 15 --langs ru  # translate real stories, write nothing
venv/Scripts/python scripts/make_eligible_cases.py            # regenerate the shared digest-rule fixture (also make_guard_cases, make_keyword_cases)
venv/Scripts/python scripts/make_common_words.py              # rebuild the fact guard's word list from the pool
```

On GitHub: Actions tab -> "hourly job" -> Run workflow runs the job by hand; "check feeds" checks
the feeds from GitHub's servers. Setting `AXIOM_DEBUG_DIR` makes `job.run` save every AI prompt and
raw answer to that folder. In the Mini App, the owner's Admin tab shows health, AI use, custom
topics, feedback, tips and languages, and has "Send me a digest now", "Run news job now" and the
announcement tool.
