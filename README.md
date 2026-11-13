# Axiom News v2

A Telegram news digest bot for a small private group (~20 people). Every hour it collects
~116 RSS news feeds, groups duplicate stories with one AI pass, and sends each user a short
digest at their chosen times in their own time zone. It runs on free tiers only
(GitHub Actions + Cloudflare Workers/D1 + Gemini, with Groq as fallback).

**Status:** Step 2 done. The hourly job runs on the owner's PC against a real Cloudflare D1
database, and a test digest has been delivered through the TEST bot. GitHub Actions, the Worker
and the Mini App come in Step 3. See [PROJECT_NOTES.md](PROJECT_NOTES.md) for status and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

## Layout

| Path | What |
|---|---|
| `config/topics.yaml` | the 6 topics users can pick |
| `config/sources.yaml` | the verified RSS feeds, with region/language/paywall/state-owned/tier labels |
| `prompts/story_batch.md` | the hourly AI prompt (group, tag, score, summarize) and its output schema |
| `db/schema.sql`, `db/digest_query.sql` | D1 tables; the digest selection shared with the future Worker |
| `job/` | the hourly job (`python -m job.run`) |
| `tests/` | unit tests for the job and the digest |
| `scripts/check_feeds.py` | re-checks every feed and prints a health table |
| `scripts/apply_schema.py` | applies `db/schema.sql` to D1 |
| `scripts/ai_probe.py` | real batch-size test for Gemini and Groq |
| `scripts/send_test_digest.py` | dev tool: sends the owner one digest via the TEST bot |
| `docs/` | architecture and lessons from the old project |
| `reports/` | one report per development step |

## Setup (Windows)

```bash
py -m venv venv
venv/Scripts/python -m pip install -r requirements.txt
```

Copy `.env.example` to `.env` and fill it in. `.env` is gitignored; never commit it or paste its
values anywhere.

## Commands

```bash
venv/Scripts/python -m unittest discover -s tests -t .        # tests (no keys needed)
venv/Scripts/python scripts/check_feeds.py                    # feed health check (no keys needed)
venv/Scripts/python -m job.run                                # one real hourly run
venv/Scripts/python scripts/send_test_digest.py --dry-run     # preview the owner's digest
venv/Scripts/python scripts/send_test_digest.py               # send it via the TEST bot
```

Setting `AXIOM_DEBUG_DIR` to a folder makes `job.run` save every AI prompt and raw answer there.
