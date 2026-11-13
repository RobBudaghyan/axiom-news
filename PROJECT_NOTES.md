# Project notes

Keep this short and current. History lives in `reports/` and git.

## Goal
A Telegram news digest bot for about 20 people (the owner, his dad, friends). It must cost $0/month
and never need a credit card. During development it uses a separate TEST bot, switching to the real
bot @axiom_news_bot at the end.

## Spec (approved, v1)
- Hourly: collect ~100 RSS feeds and make ONE AI pass for all users: group duplicates into stories,
  tag topics, score importance 1-10, write a one-line English summary, and use the best link
  (most prestigious outlet; paywalls are fine).
- Per user: digests at chosen local times (defaults 09:00/14:00/20:00, top 7, daytime only, time
  zone auto-detected). Building a digest is a database filter with no AI. The message has a greeting
  line plus a numbered list of one-line stories with source links, or a short "quiet period" note.
  The same story is never sent to a user twice.
- Topics: Politics, Wars & Conflicts, Armenia, Russia, Iran war, Ukraine war. English only, designed
  so Russian can be added later.
- Telegram Mini App settings: topics, times, number of stories, pause. An Admin tab, visible only to
  the owner, shows stats, errors and AI usage, plus a "Send me a digest now" button.
- AI: Gemini free tier, falling back to Groq; if both fail, items wait an hour. Target is about 24-50
  calls/day in total, independent of user count.
- Hosting: GitHub Actions hourly job, plus Cloudflare Worker + D1 (webhook, Mini App API, static
  Mini App, digest cron).
- Not in v1: payments, ads, multiple languages, user-added sources, instant alerts, channels.

## Decisions (with reasons)
| Date | Decision | Why |
|---|---|---|
| 2026-11-13 | Python for the hourly job, plain JavaScript for the Worker and Mini App | feedparser copes with messy feeds; Workers and the Mini App need JS; the two halves share only data files |
| 2026-11-13 | One Worker serves the webhook, the API, the Mini App files and the digest cron | one deploy unit; static assets are free |
| 2026-11-13 | Digests are sent by a Worker cron every 5 min, not by GitHub | GitHub schedules can be delayed or dropped; delay is at most ~5 min |
| 2026-11-13 | The GitHub job writes to D1 via the REST API with a D1-only token | no Worker CPU used; the job connects outward only |
| 2026-11-13 | Best link is chosen by code (lowest tier, then earliest), not by the AI | cheaper and predictable |
| 2026-11-13 | At most 8 new items per feed per run | Russian state agencies publish 1,000+ items/day each; this keeps one call at ~26k tokens |
| 2026-11-13 | Primary model `gemini-3.5-flash-lite`; fallback Groq `openai/gpt-oss-120b`, sent in chunks | the Gemini model is stable and free. Groq needs no card, but its 8k TPM limit means chunking. Cerebras (card), Mistral (billing) and OpenRouter (50 req/day) were rejected |
| 2026-11-13 | `state_owned` = a government owns or mainly funds the outlet; `note` says whether it is state-controlled or editorially independent | a factual label instead of a judgment call |
| 2026-11-13 | Recommend a private GitHub repo | public repos lose their schedules after 60 days without activity; private fits about 2,000 min/month if runs stay under 2 min |
| 2026-11-13 | Default time zone `Asia/Yerevan` until the Mini App detects the real one | most users are expected to be in Armenia; the owner can change it |

## Current status
Step 1 done: repo, docs, topics, prompt template, lessons, and 116 verified feeds with a health checker.
Nothing is deployed and no accounts have been created.

## Next step
Step 2: the owner creates the TEST bot, a Cloudflare account, a Google AI Studio key (project with
no billing), a Groq key and a private GitHub repo, then installs Node.js. Claude then writes
`db/schema.sql`, the hourly job, and the GitHub workflow, and runs the feed check from GitHub's runners.

## Known issues / open questions
- Feeds were verified from the owner's PC only; GitHub's US runners may be blocked by some sites.
- Gemini per-model free-tier TPM is not published; check it in AI Studio once the key exists.
- No usable feeds from Reuters, AP (both blocked), Armenpress (none found) or ISW (403). Asbarez was down (504) on both tries.
- Repo visibility (private recommended) and the default time zone need the owner's OK.
