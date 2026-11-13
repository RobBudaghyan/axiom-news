# Step 02: First real digest (local pipeline + cloud database)

Date: 2026-11-13. Everything ran on the owner's PC. The only cloud part is the Cloudflare D1
database. Nothing runs automatically yet; GitHub and the Worker come in Step 3.

## Summary
The whole pipeline now works end to end with real services:
- It fetches 116 feeds and makes one AI pass (Gemini, falling back to a second Gemini model and
  then Groq).
- It writes stories to the real D1 database and builds a digest from them.
- **One real digest (7 stories) was sent to the owner through the TEST bot**; Telegram accepted
  it with message id 2436. A second check right after showed only "Quiet period", so the
  never-twice rule works.

The job ran for real **5 times**. The last two were a normal hourly pair, 58 minutes apart, and
the final one took **60 s**: 211 new items, 83 stories created, 25 merged, one Gemini call plus
one resend.

Getting there exposed real problems, all now handled in code and covered by tests:
- Gemini was overloaded (HTTP 503) on about half the calls.
- One AI answer marked everything "not news".
- Answers to very large batches stopped early.
- One article was put in the wrong story.

**Quality is usable, but grouping is the weak spot.** Tags, scores and summaries are mostly
good. Some stories still get over-merged or near-duplicated, and a top-7 digest with all topics
on is dominated by the Ukraine war.

## What was done
1. **Secrets.** I created `.env` from `.env.example` and opened it in Notepad, and the owner
   filled in all 6 values. A check printed only "set"/"missing" plus format checks (never the
   values). It found everything set, the Telegram token and ids in the right format, and `.env`
   ignored by git.
   - The owner had also already created a D1 database `axiom-d1` and filled in its id. I used
     that instead of creating a new one.
   - The Cloudflare token is an account-scoped token, which works. Its user-level verify
     endpoint says "invalid"; the account-level one says "active".
2. **AI verified for real** with `scripts/ai_probe.py` (details under Tests).
3. **Database.** I wrote `db/schema.sql` and applied it through the D1 REST API
   (`scripts/apply_schema.py`): 8 tables and 3 indexes. **No Node.js/wrangler was needed**,
   because the database already existed and the REST API can apply SQL. Node.js is still needed
   in Step 3 for the Worker.
4. **The hourly job (`job/`):**
   - `config.py` reads `.env` and the YAML/prompt files.
   - `d1.py` is the REST client, plus a SQLite twin used by the tests.
   - `fetch.py` handles the feeds: lookback window, URL normalisation, 8 newest unseen per feed.
   - `ai.py` holds the Gemini and Groq clients, prompt rendering, chunking and output validation.
   - `run.py` runs the job: pending/retry/expiry, the fallback chain, partial answers, best
     link, daily prune, and logging to `job_runs`/`ai_calls`/`errors`.
5. **Tests:** 39 real tests in `tests/`, including the pending/retry and fallback branches
   (lesson 19).
6. **The job ran 5 times for real.** Each run's quality was judged, and the prompt and topic
   definitions were tuned 5 times.
7. **`scripts/send_test_digest.py`** works as the Worker will (owner, all 6 topics, top 7,
   importance >= 4, not sent before). The selection is a shared SQL file, `db/digest_query.sql`.
   Lines read `N. <summary> · <linked source>`, with no em dash anywhere, and the greeting
   follows Asia/Yerevan time. One dry run, then one real send.
8. **Docs.** I updated ARCHITECTURE (new format, measured AI limits, data-flow changes, risks),
   PROJECT_NOTES and README, and made 5 commits plus a final docs commit.

## Files created / changed
- **New:** `job/__init__.py`, `job/config.py`, `job/d1.py`, `job/fetch.py`, `job/ai.py`,
  `job/run.py`, `db/schema.sql`, `db/digest_query.sql`, `scripts/apply_schema.py`,
  `scripts/ai_probe.py`, `scripts/send_test_digest.py`, `tests/__init__.py`, `tests/helpers.py`,
  `tests/test_job.py`, `tests/test_digest.py`, `reports/step-02-first-digest.md`.
- **Changed:**
  - `prompts/story_batch.md`: tuned, see Decisions.
  - `config/topics.yaml`: near-miss notes for politics and iran_war.
  - `.env.example`: `GEMINI_FALLBACK_MODEL`.
  - `requirements.txt`: `tzdata`, needed on Windows for time zones.
  - `docs/ARCHITECTURE.md`, `PROJECT_NOTES.md`, `README.md`.
- **Not committed:** `.env`, which is checked as gitignored before every commit.

## Tests run and real results

### AI providers (real calls, 2026-11-13 15:00-16:40 UTC)

**Gemini:**
- **Model list.** 64 models; `gemini-3.5-flash-lite` is listed (version `3.5-flash-lite-07-2026`).
- **Small real call:** first a 503 ("high demand"), then 3 successes in 0.7-9 s.
- **Full real batch.** 230-233 new items plus 250 existing-story stand-ins came to **23.1-23.6k
  input tokens** by `countTokens`, close to the Step 1 estimate of ~26k. **The free tier
  accepted it in one call; no 429 for size.** The first run's 435-item batch (29.1k tokens) was
  also accepted. Calls took 10-85 s.
- **Output was 11-18k tokens, not the 3-4k estimated.**
- **Failures seen:**
  - 503 "high demand" on the primary model about half the time, sometimes several in a row.
  - The second model, `gemini-3.1-flash-lite`, worked whenever it was needed.
  - No rate-limit error (429) at any point.
- **Free-tier TPM/RPD numbers are still not visible through the API**, and Google publishes
  them only in AI Studio. In practice, 29k tokens in one call and about 10 calls in one hour
  were accepted.

**Groq (`openai/gpt-oss-120b`):**
- **Small real call OK in 0.5 s.** The response headers show **1,000 requests/day and 8,000
  tokens/minute**. The account's other chat models (`gpt-oss-20b`, `qwen3.8-27b`) also show
  8,000.
- **The full batch was refused with HTTP 413** ("Limit 8000, Requested 22239"), so chunking is
  needed.
- **The 8,000 includes the reserved reply room:**
  - 5k-token chunks plus 3k reply room were refused at 8,162-8,277 tokens.
  - The first such chunk got cut off.
  - The final setting is ~3.5k estimated prompt tokens plus 3.5k reply room.
- **Chunks work:** ~6 s each, ~4.5k in and ~2.5k out (of which ~1.4k is the model's reasoning),
  but only **about one chunk per minute**. A short 429 ("try again in 1.2 s") is now waited out
  automatically.

### Real job runs (D1 `job_runs`, times UTC)

| Run | Start | Status | Time | New items | Sent to AI | Created | Merged | Dropped | Left pending | Provider | AI calls | Tokens in / out |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 15:17 | ok* | 75 s | 435 | 435 | 0 | 0 | 435 | 0 | gemini | 1 | 29,097 / 2,262 |
| 2 | 15:24 | partial | 418 s | 119 | 554 | 38 | 8 | 38 | 467 | groq | 8 | 13,934 / 8,701 |
| 3 | 15:32 | partial | 441 s | 80 | 547 | 41 | 8 | 70 | 425 | gemini-fallback+groq | 12 | 99,051 / 36,245 |
| 4 | 15:41 | ok | 207 s | 70 | 495 | 119 | 47 | 244 | 0 | gemini-fallback | 5 | 61,866 / 44,353 |
| 5 | 16:39 | ok | **60 s** | 211 | 211 | 83 | 25 | 72 | 0 | gemini | 2 | 35,948 / 14,894 |

What happened in each run:
- **Run 1** passed the old checks but was wrong. Gemini answered with almost every item as "not
  news", so 0 stories were made. Sending the same prompt again gave 202 stories. I added a check
  for this kind of answer, then reset those 435 items to `pending`; every dropped item at that
  point came from run 1.
- **Runs 2-3** found Gemini overloaded. Groq took over and the rest stayed `pending`. This is the
  retry path working for real: nothing was lost.
  - Run 3 also showed that answers to one huge 516-item chunk covered only 30-40% of the items.
  - So partial answers are now kept, only the skipped items are resent, and Gemini calls are
    capped at ~25k tokens.
- **Run 4** cleared the backlog.
- **Run 5** is the normal case: one Gemini call, plus one resend of 89 items it skipped.

D1 usage in run 5 was **1,276 rows written and 2,674 read** (18 REST calls). Over 24 runs a day
that is about 30k writes and 65k reads, against free limits of 100k and 5M. The pool now holds
281 stories; 491 items are `done` and 424 `dropped`. 11 rows in `errors`, all AI fallback events.

### 10 sample stories (run 5, every 8th new story)

| Imp. | Topics | Chosen source (tier) | Summary |
|---|---|---|---|
| 7 | wars_conflicts, ukraine_war | Meduza (2) | Delegations from Russia, Ukraine, and the United States met in Abu Dhabi to discuss ending the war. |
| 6 | wars_conflicts, iran_war | Bloomberg (1) | Rebecca Patterson stated that Iran has won the war for now, with energy market pressures and high shipping costs lingering |
| 5 | wars_conflicts, iran_war | Anadolu Agency (2) | Yemeni military accused the Houthis of targeting Aden with ballistic missiles. |
| 5 | politics | France 24 (2) | France asked the European Commission to examine Algeria's non-compliance with its EU association agreement. |
| 5 | wars_conflicts, iran_war | Asharq Al-Awsat (2) | The Arab coalition announced the destruction of a drone in eastern Saudi Arabia. |
| 5 | politics | The Hill (2) | White House Chief of Staff Stephen Miller issued a memo requiring prior approval for staff to meet with lobbyists. |
| 4 | wars_conflicts, ukraine_war | Interfax (2) | Luhansk People's Republic head Leonid Pasechnik signed a decree restricting nighttime interregional bus transport... |
| 4 | politics, russia | The Insider (2) | The Russian government will ban third-party cadastral map websites used by investigators. |
| 4 | politics, armenia | The Armenian Weekly (3) | The ANCA welcomed a Senate hold placed on the confirmation of U.S. envoy to Baku Alexander Alden. |
| 4 | politics | Bloomberg (1) | Chicago Mayor Brandon Johnson's third chief financial officer this year resigned amid budget negotiations. |

### Honest quality judgment

**Good:**
- Summaries are concrete, neutral, one line, and in English even from Russian/Persian/Armenian
  sources.
- Tags are mostly right.
  - After tuning, Gaza went from `iran_war` to `wars_conflicts`, and the Microsoft outage and
    Nvidia CEO story went from "politics, 7" to not news.
  - Houthi and Gulf incidents go to `iran_war`, as the topic definition says.
- Scores spread from 3 to 7, with no inflation to 9-10.
- Merges are usually right: the German intelligence law (9 sources), the Bessent/Lutnick
  stories, and Russian-language copies of English news.
- Links are relevant (0 mismatches in run 5) and no dashes are in the pool.

**Weak:**
- **Over-merging remains.** One story ("EU leaders remain divided over Europe's role in Ukraine
  peace talks") has grown to 26 items covering several statements by different people. One
  arrest story absorbed a different person's arrest. The prompt now forbids roundups, which
  helped for new stories, but merges into existing stories still drift.
- **Near-duplicates.** The digest has 2 Zaporizhzhia strike lines and 2 Abu Dhabi talks lines.
- **Some scores ignore the rules.** An analyst's opinion ("Iran has won the war for now") got 6
  although the prompt says commentary is 3-4 at most. A Chicago city finance job is borderline
  news.
- **Topic balance.** In the sent digest, 6 of 7 lines are Ukraine/Russia, because 26 Russian and
  9 Ukrainian feeds dominate and the ranking is importance only.

**The digest that was sent** (links shortened here):
```
Good evening. In the last 24 hours, 7 stories on your topics:

1. Donald Trump's envoys offered Vladimir Putin room to stall during the Abu Dhabi peace talks · Politico Europe
2. Delegations from Russia, Ukraine, and the United States met in Abu Dhabi to discuss ending the war · Meduza
3. Russian strikes hit targets across Ukraine while Ukraine launched nearly 1,200 drones at Russian targets · ABC News
4. The number of people injured in the Russian strike on Zaporizhzhia increased to 50 people · Ukrinform
5. EU leaders remain divided over European participation and representation in US-backed Ukraine peace talks · The New York Times
6. Israeli strikes on Gaza's Nasser Hospital killed six people, including a surgeon, and injured 27 others · Le Monde
7. Russian strikes on Nov 13 hit multiple Ukrainian cities, killing three and injuring many, with casualties rising in Zaporizhzhia · Meduza
```
It is 1,946 characters, and a check right after the send gave "Quiet period: nothing important on
your topics since 20:41", so these 7 will not be sent again.

### Unit tests
`venv/Scripts/python -m unittest discover -s tests -t .` gives **39 tests, OK**. They use an
in-memory SQLite database built from the real `db/schema.sql`, with fake feeds and fake AI.

What they cover:
- **Fallback:** Gemini 429 goes to Groq, and blocked, empty, truncated and no-candidates answers
  are run through the real Gemini parsing code.
- **Bad answers:** invalid JSON is retried and then handed on; a degenerate all-"not news" answer
  is retried; a lazy answer keeps its work and resends the skipped items; a truncated answer or a
  Groq 413 splits the chunk.
- **Pending and retry:** when both providers fail, items stay pending and the next run processes
  them with no new fetch; items older than 24 h become expired and are not sent to the AI; items
  younger than 24 h are kept.
- **Partial failure:** only the failed chunk stays pending.
- **Merging:** merge into an existing story; an unknown story id becomes a new story.
- **Best link:** best tier, earliest on a tie, an unrelated article never wins.
- **Validation and feeds:** validation rules and dash cleanup; feed cap and seen-URL skip; URL
  normalisation; first-run lookback.
- **Providers:** the Gemini 503 retry, the Gemini 429 delay, the Groq 429 wait.
- **Digest:** topic filter, importance >= 4, not sent, order, limit, 24-hour cap, greeting by
  hour, quiet note, HTML escaping, no em dash, sent rows written, never twice even after an
  update, a failed send records nothing, a dry run writes nothing.

**Mutation check (lesson 19).** I broke the logic on purpose to see whether the tests notice:
- Removing "keep the failed chunk for retry" made **11 tests fail**.
- Inverting the 24 h expiry comparison made **18 tests fail**.

The code was then restored and all tests pass.

## Decisions I made and why
- **A second Gemini model before Groq** (`gemini-3.1-flash-lite`, the same key, set by
  `GEMINI_FALLBACK_MODEL`). The 503 overload is per model and was very frequent today, while Groq
  manages only ~1 chunk per minute. In run 4 the second model cleared a 495-item backlog in 3.5
  minutes.
- **The AI must account for every item,** either in a story or in `not_news_ids`. This makes a
  lazy or degenerate answer detectable instead of silently dropping news (lesson 2):
  - fewer than 10% of 20+ items in stories: retry;
  - more than 10% skipped: keep what was done and resend the rest once;
  - a cut-off or too-large answer: split the chunk.
- **Gemini calls are capped at ~25k estimated tokens.** That is one normal hour; only backlogs
  get split, because answers to huge chunks stop early.
- **Groq chunks are ~3.5k prompt tokens plus 3.5k reply room, max 8 per run** (~8 minutes).
  Groq counts the reserved reply against its 8,000/minute.
- **Story ids appear in the prompt as `S<id>`**, because the model once put item 46 into story 46.
- **The best link has a relevance check first**: an English title sharing no word with the
  summary ranks last. A side effect: within the same tier, an English article beats
  Russian-language copies. I think that is right for English readers, but it means TASS (tier 2,
  English) can beat a Russian-language tier-2 outlet.
- **Prompt and topic tuning,** all driven by real output:
  - off-topic examples (tech outages, CEO news, markets);
  - near-miss notes for politics and iran_war;
  - "same concrete event" examples and a no-roundup rule;
  - score caps for commentary, routine daily military claims, and claims only tier-3 outlets
    carry.
- **The lookback window** is the time since the last run plus 1 h (2-24 h), or 3 h on the first
  run. Without it, the Economist feeds' 300 archived entries would look new after pruning.
- **Prune once a day, not hourly**, to save D1 rows read.
- **The digest SQL lives in its own file** (`db/digest_query.sql`), so the Step 3 Worker uses
  exactly the same selection.
- **The test digest marks its 7 stories as sent for the owner** in the shared database, as a
  real digest would.
- **`tzdata` added to requirements,** because Windows Python has no built-in time-zone data.

## Problems / risks / open questions
- **Gemini overload.** If it lasts all day, the fallback chain is slow, and items can stay
  pending for a few hours. Nothing is lost unless all providers fail for 24 h.
- **Grouping quality** (over-merging, near-duplicates) is the main quality risk. Ideas if it
  stays weak:
  - cap how many items can be merged into one existing story;
  - show the AI fewer, more relevant existing stories;
  - run a small second "dedupe the top 7" pass over the digest candidates. This needs no AI: a
    title-similarity check in the Worker.
- **Topic balance:** see question 2 below.
- **Run time vs. GitHub minutes.** GitHub bills each job in whole minutes, rounding up. The
  normal run took 60 s here, so it bills 2 minutes, about 1,440 min/month: inside a private
  repo's ~2,000. A run over 2 minutes would bill 3 (2,160/month, over the limit). Fallback runs
  take 3-8 minutes. This has to be measured on GitHub's runners in Step 3.
- **Feeds are still checked only from this PC.**
- **Telegram accepted the digest, but I can't see the owner's screen.** Please confirm it arrived
  and the links open.
- **On a bad day the AI calls exceed the spec's 24-50/day target.** Normal is 24-30/day. With
  Gemini overloaded, retries, the second model and Groq chunks could reach ~60-80. All of these
  calls are free.

## What the owner must do
1. **Check Telegram:** open the chat with your TEST bot. You should see a message starting
   "Good evening. In the last 24 hours, 7 stories on your topics:". Tap 2-3 of the blue source
   names and check the articles open. Tell me if anything looks wrong.
2. **Answer two quick questions** (you or your advisor):
   1. Digest length: are 7 one-line stories right, or should it be shorter or longer?
   2. Topic balance: when someone follows all topics, should a digest show **at most 3 stories
      from the same topic**, so Armenia/Iran/politics also appear? Or keep pure "most important
      first" as the spec says now?
3. Nothing else. No new accounts were needed in this step.

## Suggested next step
**Step 3: automation and the bot.**
1. The owner creates a **private GitHub repo** (I will send click-by-click steps) and adds the
   secrets there.
2. Claude adds `.github/workflows/hourly.yml` and runs `check_feeds.py` and the job on GitHub's
   runners. That measures run time against whole-minute billing and finds feeds blocked from the
   US.
3. Install Node.js LTS and wrangler, and build the Worker:
   - the Telegram webhook (`/start`);
   - the digest cron every 5 minutes, using `db/digest_query.sql`, with users' local times;
   - the Mini App settings page and the Admin tab.

   All of this still uses the TEST bot.
4. Based on the owner's answers, adjust digest length and topic balance, and keep watching the
   grouping quality in real digests.
