# Axiom News v2

A Telegram news digest bot for a small private group (~20 people). Every hour it collects
~116 RSS news feeds, groups duplicate stories with one AI pass, and sends each user a short
digest at their chosen times in their own time zone. It runs on free tiers only
(GitHub Actions + Cloudflare Workers/D1 + Gemini, with Groq as fallback).

**Status:** Step 1 done (foundation, design, sources). Nothing is deployed yet.
See [PROJECT_NOTES.md](PROJECT_NOTES.md) for status and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for the design.

## Layout

| Path | What |
|---|---|
| `config/topics.yaml` | the 6 topics users can pick |
| `config/sources.yaml` | the verified RSS feeds, with region/language/paywall/state-owned/tier labels |
| `prompts/story_batch.md` | the hourly AI prompt (group, tag, score, summarize) |
| `scripts/check_feeds.py` | re-checks every feed and prints a health table |
| `docs/` | architecture and lessons from the old project |
| `reports/` | one report per development step |

## Run the feed health check (Windows)

```bash
py -m venv venv
venv/Scripts/python -m pip install -r requirements.txt
venv/Scripts/python scripts/check_feeds.py
```

It exits with code 0 when every feed is OK. It also validates the fields in `config/sources.yaml`.
No keys are needed. For later steps, copy `.env.example` to `.env` and fill it in; never commit `.env`.
