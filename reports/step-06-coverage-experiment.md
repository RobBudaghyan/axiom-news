# Step 06: Coverage experiment with Google News search feeds (part A, interim)

Date: 2026-11-14. Still on the TEST bot (@justatia_bot). **This step only measures. Your digests,
the live story pool, the Mini App and the Admin tab are exactly as before.**

## Summary
- **The idea under test:** besides our ~115 curated news feeds, ask Google News every hour
  "what is new about Armenia / Pashinyan / Kremlin / Zelensky / ..." (30 searches over the 6
  topics, in English and Russian), so that medium-sized stories our feeds miss still reach us.
- **It works technically, from this PC and from GitHub's servers:** every one of about 300 test
  requests was answered (no blocking, no rate limit), most in 0.2-0.6 seconds (at most 1.3); all 30 searches
  together take about 1-3 seconds.
- **But Google gives headlines only**, no summary text, and its links point to Google, not to
  the article. Turning a link into the real article address costs two more requests (about 0.5-1.5
  seconds each link), so it is only worth doing for the few stories that reach a digest.
- **Armenian-language news is almost absent from Google News.** Searches in Armenian script found
  0 articles in 2 hours and 0-2 in a day; Google's "Armenia" edition answers in Russian. Armenia is
  covered well in English and Russian.
- **A plain warning about the rules:** every Google News feed carries a notice that it is for
  "personal, non-commercial use" in a personal feed reader, and that other use is prohibited. Our
  bot is free and private (about 20 people), but it is not a personal feed reader: it rewrites the
  headlines with AI and sends them to other people. Strictly read, full adoption would go beyond
  that notice. This is your decision, not a technical one (see Problems).
- **Shadow mode is running.** Since the 12:07 UTC run, every hourly run ends with an extra step
  that collects the Google results into separate tables that nothing else reads. It cannot make AI
  calls, cannot touch your digests, and if it fails the real run does not notice. The first real
  run: the real job finished normally in 52 seconds, then the shadow step took 6 seconds and
  stored 677 Google articles, of which 232 did not look like anything the live pool already had.
  The second run (13:07, a normal hour) took 4 seconds and found 432 new Google articles, 180 of
  them unique (26 about Armenia).
- **First AI test, in a sandbox (a throwaway copy, not the live pool):** of 120 of those 232
  articles, 54 were not news on our topics (sports, ads, analysis pieces), 34 were events the live
  pool already had in other words, and **32 were real events our feeds had not given us** (30
  stories), **9 of them about Armenia**. Most scored 4-5 out of 10, so they are "medium" news,
  exactly the layer you asked about. Each Google headline costs the AI about 37 input and about 48
  output tokens.
- **Part B (the real verdict) can run from 00:10 UTC on 2026-11-15** (04:10 Yerevan time),
  after 12 hourly runs. Better: **12:10 UTC (16:10 Yerevan) on 2026-11-15**, after 24 runs, so a
  whole day and night are in the numbers.

## What was done
1. **Feasibility checks** (`scripts/gnews_probe.py`, from this PC and from a GitHub runner with
   the new "gnews probe" workflow): 10 edition variants, every search with a 2-hour and a 1-day
   window, two bursts of all 30 searches at once, and 6 link resolutions.
2. **Search terms in a config file** (`config/gnews_queries.yaml`), not in code. Per topic:
   - Armenia: Armenia, Pashinyan, Yerevan, Karabakh OR "Armenia Azerbaijan" (English); Армения,
     Пашинян, Ереван (Russian); Երևան (the one Armenian-script search that finds anything);
   - Russia: Kremlin, Putin, "Russia" sanctions; Кремль, Госдума;
   - Ukraine war: Ukraine war, Zelensky, Ukraine peace talks; ВСУ, Зеленский;
   - Iran war: Iran strike OR Iran attack, Hormuz OR Houthis, Iran nuclear; Иран удар;
   - Wars & conflicts: airstrike OR shelling, ceasefire, Gaza OR Sudan OR Sahel, "armed clashes" OR
     rebels;
   - Politics: election results, "prime minister" OR president resigns OR parliament vote,
     sanctions OR tariffs; выборы.
3. **Shadow collection in the hourly job** (`job/shadow.py`, `job/gnews.py`), as the last step of
   the hourly workflow:
   - fetches all 30 searches, 8 at a time, with a hard 15-second limit;
   - keeps one row per article (the same article found by two searches is one row, with both
     topics noted), and skips articles stored in an earlier hour;
   - compares each headline, without AI, with the live pool's headlines of the last 24 hours and
     with the Google headlines of the last 24 hours (shared rare words; English and Russian), and
     stores the similarity, so part B can re-judge it;
   - writes only to two new tables, `shadow_items` and `shadow_runs`; errors go into
     `shadow_runs`, never into the error list you see in Admin; old rows are deleted after 3 days.
4. **One-off AI measurement** (`scripts/shadow_ai_sample.py`): the real first AI pass over 120
   sampled Google headlines (20 per topic), in an in-memory copy with the live pool's last 24 hours
   of stories, so the AI could say "this is story S123 we already have" or "this is new".
5. **Docs:** ARCHITECTURE (new section 3a, database, layout), README, PROJECT_NOTES, this report.

## Files created / changed
- **New:** `config/gnews_queries.yaml`, `job/gnews.py`, `job/shadow.py`, `tests/test_shadow.py`,
  `scripts/gnews_probe.py`, `scripts/shadow_ai_sample.py`, `.github/workflows/gnews-probe.yml`,
  this report.
- **Changed:** `.github/workflows/hourly.yml` (one new last step), `db/schema.sql` (two new
  tables, nothing changed in the old ones), `docs/ARCHITECTURE.md`, `README.md`,
  `PROJECT_NOTES.md`.
- **Not changed:** the real job (`job/run.py`, `job/editor.py`, ...), the Worker, the Mini App,
  the digest rules, `config/sources.yaml`.
- **Live database:** the two new tables were created with `scripts/apply_schema.py` (it only adds
  what is missing).

## Tests run and real results

### Unit tests
`venv/Scripts/python -m unittest discover -s tests -t .`: **71 tests, OK** (54 before, 17 new).
The new ones check:
- the parser on Google's real feed format (headline without " - Outlet", outlet, site, date, no
  snippet), the search address, and that the config has every topic and no repeated search;
- headline similarity: the same news in other words matches (also in Russian), different news
  does not;
- **the shadow step writes only its own tables** (row counts of all 9 live tables are identical
  before and after);
- one article found by two searches = one row; an article from an earlier hour is not stored
  again; a headline matching the live pool is marked "live", one matching an earlier Google
  result "shadow"; live items older than 24 hours are not compared; the "outlet we already read"
  flag;
- failures never escape: a search answering 503, a crashing fetcher, a broken database read and
  searches slower than the time limit are all recorded in `shadow_runs` and the step carries on;
  nothing is written to the live error log;
- dry run writes nothing; a second trigger within 40 minutes does nothing; rows older than 3 days
  are deleted; `enabled: false` switches it off.

One test failed at first, because I had computed the expected date of the sample article wrongly
by hand; the parser was right, and I fixed the test.

### Feasibility (real requests, 2026-11-14 about 11:50-12:00 UTC)
| Check | From this PC | From a GitHub runner |
|---|---|---|
| HTTP answers | all 200 (about 140 requests) | all 200 (about 140 requests) |
| One search | 0.3-0.7 s (1.3 s at most) | 0.2-0.5 s (0.8 s at most) |
| All 30 searches, 8 at a time | 1.1 s (twice) | 0.4-0.5 s (twice) |
| Rate limits or blocking | none seen | none seen |
| Resolving a Google link to the article | 6 of 6, 0.7-0.8 s (1.3-1.7 s in a first test) | 6 of 6, 0.3-0.5 s |
| Snippets (text beyond the headline) | 0 of about 1,600 items | 0 |

- **Freshness:** with a 2-hour window, the newest item was minutes old for busy searches (Putin,
  Зеленский: 0.1 h) and up to an hour for quiet ones (Yerevan 0.9 h). All items returned were
  inside the 2 hours.
- **Items per search:** at most 100. With a 2-hour window, 1 to 100 (Karabakh 1, Yerevan 5,
  Armenia 20, Армения 49, Putin 78, Зеленский 100). A 1-day window returns 100 "most relevant" of
  the day, and only about 10 of them are from the last 2 hours, so **the 2-hour window is the right
  one for an hourly job**. Зеленский hits the 100 cap even in 2 hours, so a few of its items are
  missed.
- **Editions:** English (US and UK) and Russian (Russia and Ukraine) work. The Armenian edition
  (`hl=hy&gl=AM`) is not real: an "Armenia" search there returned 102 Russian headlines. Armenian
  script searches: "Հայաստան" 0 in 2 h, 0-2 in a day, at most 11 in a week; "Փաշինյան" 0-2 in a
  week; "Երևան" 2 in 2 h in the English edition (Panorama.am), so only that one stays in the config.
- **Resolving links:** works through Google's own page (two requests). It is an unofficial method
  that Google could change; if it breaks, the fallback is the Google link itself, which still
  opens the article in a browser. It is only needed for stories that reach a digest (the AI only
  needs the headline), so about 10-20 links a day, not hundreds.

### The first real hourly run with the shadow step (12:07 UTC, run 43593276856)
- **Real job:** status ok in 52 s, 115 of 115 feeds, 142 new articles, 24 new stories, editor ok
  (60 candidates). It finished at 12:08:49, before the shadow step started.
- **Shadow step:** 12:08:49-12:08:55 (6 s, of which 5.0 s inside the script). 30 searches, all
  HTTP 200. 799 results, 677 distinct articles, all new (first run). Headline check: 343 look like
  live-pool articles, 102 like each other, **232 unique**. D1: 4,545 rows read, 1,355 written.
- Per topic (new / like the live pool / like another Google result / unique):

  | Topic | New | Like live | Like Google | Unique |
  |---|---|---|---|---|
  | Armenia | 84 | 26 | 11 | 47 |
  | Russia | 139 | 83 | 13 | 43 |
  | Ukraine war | 226 | 140 | 45 | 41 |
  | Iran war | 83 | 49 | 7 | 27 |
  | Wars & conflicts | 75 | 35 | 13 | 27 |
  | Politics | 70 | 10 | 13 | 47 |

  This first run looked back 2 hours with nothing seen before, so it is bigger than a normal hour.
- **The live error list** got 4 entries during this run, all from the real job's normal AI checks
  (one answer resent, one fact-guard drop), none from the shadow step.

### A normal hour: the second run (13:07 UTC, run 43598193597)
Here articles already stored an hour earlier are skipped, so these are the numbers to expect each hour.
- **Shadow step:** 13:13:05-13:13:09 (4 s, of which 3.4 s inside the script). 30 searches, all
  HTTP 200. 756 results, 642 distinct, 210 already seen at 12:07, **432 new**. Headline check:
  184 look like live-pool articles, 68 like other Google results, **180 unique**. D1: 5,538 rows
  read, 865 written.

  | Topic | New | Like live | Like Google | Unique |
  |---|---|---|---|---|
  | Armenia | 51 | 16 | 9 | 26 |
  | Russia | 84 | 43 | 10 | 31 |
  | Ukraine war | 147 | 88 | 21 | 38 |
  | Iran war | 36 | 19 | 2 | 15 |
  | Wars & conflicts | 68 | 13 | 19 | 36 |
  | Politics | 46 | 5 | 7 | 34 |

- **The real job took 5 minutes this hour (309 s, against 52 s at 12:07).** That was the real
  job's own AI pass: Gemini skipped 48 of 144 articles, and the three resends were rejected by the
  existing "implausible answer" check, so Groq finished them (13 AI calls instead of the usual
  2-4). The shadow step started only after the real job had finished and has no AI keys, so it
  played no part. The run still ended ok, with every article handled. I mention it because part B
  will compare Gemini error rates, and this hour will show up in them.

### The one-off AI measurement (sandbox, 12:10 UTC)
`venv/Scripts/python scripts/shadow_ai_sample.py`: 120 of the 232 unique Google headlines (20 per
topic), with the live pool's newest 250 stories of the last 24 hours. 2 Gemini calls
(`gemini-3.5-flash-lite`, the second resending 13 skipped items, as in normal runs), 13 s,
**25,077 tokens in and 5,806 out**. These 2 calls are not in the live `ai_calls` table.

| Topic | Sample | Not news | Already in the live pool | New event |
|---|---|---|---|---|
| Armenia | 20 | 9 | 2 | **9** |
| Iran war | 20 | 5 | 8 | 7 |
| Russia | 20 | 5 | 11 | 4 |
| Ukraine war | 20 | 1 | 13 | 6 |
| Wars & conflicts | 20 | 17 | 0 | 3 |
| Politics | 20 | 17 | 0 | 3 |
| **All** | 120 | 54 | 34 | 32 (30 stories) |

- **What "new" looked like** (first-pass score in brackets): Iran strikes a US site in Bahrain (7);
  Houthi drone strikes on Riyadh airport and a Saudi pipeline (6); 53 countries urge Israel to ease
  Gaza aid (6); Russia opens the door to Europe in peace talks (6). **Armenia:** Armenia did not
  sign a European security declaration over its wording on Russia (5); 107 PACE deputies concerned
  about Samvel Karapetyan's arrest (5); Pashinyan calls the Karabakh conflict an obstacle to
  sovereignty (5); Armenia-US talks on technology (4); the Russian-Armenian University board
  charter (4); Tikhanovskaya thanks Pashinyan (4); and low ones like AI Agora (3) and a football
  club dispute (2).
- **Caution:** these are first-pass scores, which run generous. The editor scores more strictly,
  and Armenia's own section needs a 6. So most of these would probably **not** reach your digest
  under today's rules. Part B and the "2 stories per followed topic" question address this.
- **The headline check misses some duplicates:** 34 of the 120 "unique" headlines were events
  the live pool already had (28%). In production the AI pass merges them anyway (that is its job),
  so this only affects cost, not what you see.
- **Cost per Google headline:** 37 input tokens (Gemini's own count: 14,513 tokens with the 120
  headlines, 10,062 without) and about 48 output tokens.

### Gemini so far (from the live `ai_calls` table, for comparison in part B)
- 2026-11-13: 44 calls (29 Gemini, 15 Groq), 3 Gemini HTTP 503 "high demand", no 429.
- 2026-11-14 until 12:08 UTC: 73 Gemini calls (including the Step 5 tuning and backfill done that
  morning), no 429 and no 503 logged.

## Decisions I made and why
- **The shadow step runs after the real job, as its own step, with only the database keys.**
  You asked that it must not slow the real job by more than a few seconds and that a failure must
  not affect it. As a separate step it does not slow the real job at all (the workflow takes about
  6 seconds longer), it cannot make an AI call because it has no AI keys, and it is marked "may
  fail" so even a crash leaves the run green. It also always exits normally by itself.
- **2-hour window.** A 1-day window returns the 100 "most relevant" items of the day, and only
  about a tenth of them are new in the last hour.
- **Armenian-script searches dropped except one.** They return almost nothing (see above).
- **Headline-similarity threshold 0.5.** I read 668 real pairs: 0.5-0.7 were mostly the same event
  from another outlet, below 0.5 mixed. All scores are stored, so part B can test other values.
- **Compared against the last 24 hours** of the live pool, like the AI pass sees it.
- **Google links are not resolved in the hourly step.** It would cost about 1 second per link for
  hundreds of links an hour; it only matters for stories that reach a digest.
- **Shadow rows are kept 3 days.** Enough for part B; keeps the database small.
- **The sandbox AI sample used only "unique" headlines**, because those are the ones adoption
  would add to the AI's work.

## Problems / risks / open questions
- **Terms of use (please read).** Each Google News feed says, in its own copyright notice, that it
  is made available "solely" for a personal feed reader for personal, non-commercial use, and that
  any other use is "expressly prohibited". Our bot is non-commercial and private, but it reads the
  feed automatically, rewrites the headlines with AI and sends them to other people. That is not
  clearly allowed. The realistic risk for a 20-person bot is Google blocking our requests (which
  would just switch the extra source off), not legal action, but you should decide knowingly. A
  safer variant: use Google only to **discover** that a story exists, and link and quote only the
  outlet's own article (after resolving the link).
- **Only headlines.** The AI judges Google items from the headline alone, so its summaries and the
  editor's descriptions have less to work with, and the fact guard has less to check against.
- **Link resolution is unofficial.** It reads Google's own page; Google could change it.
- **Noise:** sports ("Armenia vs Cyprus"), ads and opinion pieces come with the searches. The AI
  marked 45% of the unique sample as not news.
- **Volume and limits:**
  - D1: the first shadow run wrote 1,355 rows (each article plus its index row) and the second, a
    normal hour, 865. That is roughly 20,000 rows written a day, against 100,000 free (the live job
    uses roughly 20,000-35,000), and about 130,000 rows read a day, against 5 million free. Fine for an experiment, but it should be switched off
    after part B if not adopted (`enabled: false` in `config/gnews_queries.yaml`).
  - The Admin tab's "D1 today" does not include the shadow step's rows (they are in
    `shadow_runs`), so during the experiment it shows slightly less than the real use.
- **One run is not a day.** The numbers above come from two runs (the first a 2-hour backlog) and one
  sample at midday Saturday. Part B uses all runs.
- **Russian state media** (and Azerbaijani state media) are a large share of Google's Russian
  results, as in our own feeds.

## What the owner must do
Nothing right now. Nothing changed for you: your digests come from the same feeds as before.

When you are ready (from **2026-11-15 04:10 Yerevan time** at the earliest, better after
**16:10 Yerevan time**), tell me to "run Step 6 part B". Before or then, please think about the
terms-of-use question above: are you comfortable using Google News this way for a private,
free bot, or should it only be used to discover stories, with links to the outlets themselves?

## Suggested next step
**Part B (you trigger it):** from all shadow runs, report the extra unique items per hour per
topic, how many are genuinely new events versus the live pool (with up to 10 real Armenia
examples the curated feeds missed), the extra AI calls and tokens per day for full adoption,
Gemini's headroom (calls per day, 429/503 rates), the risks, and a recommendation: which searches
to keep, caps per search, a weekly self-check of feeds and coverage shown in Admin, and whether
followed topics should guarantee 2 stories instead of 1. Then switch the shadow step off or turn
the recommendation into Step 7.
