# Step 07: More Armenian sources, per-feed caps

Date: 2026-11-14. Still on the TEST bot (@justatia_bot). Digest rules, the editor, the Worker and
the Mini App did not change.

## Headline numbers
| | Before (baseline) | After (first 2 real runs) |
|---|---|---|
| Armenian outlets we read in Armenian or Russian | 2 (Azatutyun, Sputnik Armenia) | 8 more (list below) |
| Items from Armenian feeds per hourly run | 8.8 | 44 (57, then 31 in a normal hour; the first run looked back 2 hours) |
| New Armenia stories per run | 1.6 | 17, then 4 in a normal hour |
| Armenia stories scored 6+ by the editor | 5 of 42 in 23 hours | 0 of 21 so far (12 not scored yet) |
| Armenia stories that reached your digests | 2 | 0 so far |
| First AI pass, input tokens per run | 31.9k (normal hours) | 33.8k, **+6%** (limit was +40%) |
| First AI pass, AI calls per run | 2.55 | 2.5 |
| Gemini "too busy" (503) / "limit" (429) | 3 of 61 calls / 0 | 1 of 5 calls / 0 |
| Run time | 53 s (normal hours) | 168 s (a 503 forced the slower backup model), then 48 s |

- **Extra AI cost is small:** about +2,000 to +2,400 input tokens and about +1,000 output tokens
  per hour, roughly +50k input tokens a day. Still one AI call per normal hour, all free.
- **Many more medium Armenian stories now enter the pool** (court cases, ministers' meetings,
  prisoners of war, Syunik road, illegal mining). But **almost none would reach your digest under
  today's rules:** they score 4-5, and Armenia's own section needs a 6. That is the job of Step 8
  (the dynamic digest), not of more sources.
- **Important correction to the starting assumption:** News.am's RSS feeds do not carry "dozens
  per hour". Measured: Russian and Armenian about 5-10 items an hour (up to 14 in a busy hour),
  English only 1-2 an hour. The 8-per-run cap never cut News.am English. The real gap was that we
  read only the English edition, which publishes about a tenth of the news.
- The Google News experiment is **paused** (switched off, code and data kept).

## Sources added (8)
All work from this PC and from GitHub's servers (checked 2026-11-14). "On topic" = share of the
latest headlines I read by hand that are news on our six topics (no AI).

| Feed | Language | Items/hour | On topic | Cap | Owner and alignment (factual) |
|---|---|---|---|---|---|
| News.am Russian | ru | 5-10 | ~70% (30% Armenia) | 20 | Private (News am LLC, since 2009), the most-read Armenian site; JAMnews (2021) listed it among outlets backing Artur Vanetsyan's opposition bloc; much world news |
| Factor.am | hy | ~3 | 8 of 10 | 10 | Run by the Factor Information Center NGO; RSF names it among independent watchdog sites |
| Aravot | hy | ~2 | 6-7 of 10 | 10 | Private daily (Aravot oratert LLC), editor Aram Abrahamyan; news and opinion |
| 168.am | hy | ~9 | ~90% (40% Armenia) | 20 | Private (168 Zham LLC, owned by founder and editor Satik Seyranyan); JAMnews (2021) listed it with News.am behind Vanetsyan's bloc; many opinion pieces. Tier 3 |
| A1+ | hy | ~1.7 | 16 of 20 | 12 | Private (Meltex LLC, founder Mesrop Movsesyan); A1+ TV lost its licence in 2002, now online |
| ArmInfo English | en | ~2 | 18 of 20 | 8 | Private news agency since 1991; English versions of its Russian wire |
| CivilNet Armenian | hy | ~0.5 | most | 8 | Same outlet as our CivilNet English feed, which publishes 3x fewer items |
| Hetq Armenian | hy | ~0.6 | most | 8 | Investigative journalists' association; 3x more items than its English feed |

## Sources checked and not added
- **News.am Armenian:** 86% the same articles as News.am Russian, and Armenian script costs
  almost twice the AI tokens (164 per item against 89 for Russian, 70 for English).
- **Armenpress, 1lurer.am (Public TV), Panorama.am, Shamshyan, Tert.am, Armtimes, Aysor,
  Iravunk, Yerkir, Zham, NewsArmenia, Epress, Novoe Vremya:** no RSS feed found (home page links,
  20+ usual addresses). Armenpress is the biggest loss (state agency).
- **Arka:** blocks automated requests (HTTP 403 from this PC; GitHub gets a non-feed page).
- **Mediamax:** feeds exist but GitHub's servers get HTTP 403, and they hold only 10 items, often
  days old.
- **Lragir:** site unreachable from this PC and from GitHub.
- **Azatutyun Russian:** rus.azatutyun.am now redirects to the Armenian site, which we already read.
- **Hraparak:** mostly opinion and attack pieces, sensational headlines, celebrity items, one
  "No Title" entry. Tabloid-leaning.
- **24news.am:** copies 168.am headlines word for word.
- **Pastinfo, Golos Armenii:** content overlaps 168.am/Aravot heavily; I found no public ownership
  data for Pastinfo, and Golos Armenii changed to a little-known owner in 2025. Easy to add later.
- **ArmInfo Russian:** the English feed carries the same wire and costs fewer tokens.

## Risks
- **Wrong merges.** In the first run 3 Armenian/Russian articles were attached to a different
  English story: Bulgaria halting arms to Ukraine went into "Poland suspends funding for US
  weapons"; an EU call to open Gaza crossings went into "18 nations condemn strike on Gaza
  hospital"; the lawyer Robert Amsterdam's statement went into the PACE statement on Samvel
  Karapetyan. The editor also merged an Artsakh minister's prisoner proposal into a Pashinyan
  prisoner quote. Effect: the story's link and text stay correct, but that article's news is lost
  as a separate story. More non-English articles mean more of these.
- **The editor sees at most 60 stories per run.** With more Armenia stories, 12 of the 21 new
  ones were not scored after 2 runs; unscored stories count as first-pass score minus 2, so they
  cannot reach a digest. Step 8 should look at this.
- **Opposition-aligned sources.** News.am and 168.am were linked to one opposition bloc (JAMnews,
  2021). The AI summarises facts, and the link prefers the outlet with the lowest tier, but these
  two now supply many Armenia articles. 168.am is tier 3 so it is linked last.
- **A busier weekday hour** could push the first pass over one call's budget (25k estimated
  tokens), adding a second call that repeats the ~10k fixed part. Measured hours were Saturday
  afternoon. The lever is in config: lower `max_items` for News.am Russian or 168.am, or lower the
  noisy Azerbaijani feed Trend (89% of its items are not news).
- **Runs are slower when Gemini is busy** (the first run took 168 s on the backup model). Same as
  before, only with more items.
- **Feeds can change.** Five Armenian sites have no feed at all; the ones we use can drop theirs.
  The Admin tab shows failing and silent feeds.

## Details

### What was done
1. **Google News shadow step paused:** `enabled: false` in `config/gnews_queries.yaml`. The step
   stays in the hourly workflow but exits before any database or Google request (both real runs
   logged "disabled (no requests made)"). Code, tables and rows are kept. Nothing else from Step 6
   runs on a schedule: the probe workflow is manual only.
2. **Baseline** from the database (`scripts/armenia_stats.py`, saved as
   `reports/data/step-07-baseline.csv`). Note: the window was 48 hours, but the job only started
   on 2026-11-13 15:17 UTC, so it covers 26 runs in about 23 hours.
3. **Source search:** `scripts/discover_feeds.py` read 40 Armenian sites' home pages for feed
   links and tried about 20 usual feed addresses each. Candidates in
   `config/candidates/armenia.yaml`, tested with `scripts/check_feeds.py` from this PC and with
   the "check feeds" workflow on GitHub (it now takes a file to check). Ownership from the Media
   Ownership Monitor Armenia, RSF and JAMnews.
4. **Per-feed caps:** a feed in `config/sources.yaml` can have `max_items` (default stays 8). The
   run log prints what each cap cut ("cap cut") and the feed health record keeps it.
5. **English links (your choice):** when an article joins an existing story, the story's current
   link is now scored like a new one, so an English article that matches the story takes over from
   a Russian or Armenian one. New stories already worked this way.
6. **Token estimate fixed for Armenian script** (it was 44% too low), so the job splits big hours
   correctly.
7. **Measurement tools:** `scripts/source_dry_run.py` (real feeds, real prompt, Gemini only counts
   tokens), `scripts/armenia_grouping.py` (cross-language grouping check).

### Baseline (26 runs, 2026-11-12 14:44 to 11-14 14:44 UTC)
- Items from Armenian feeds: 228. Armenia stories created: 42; editor scores: 20 at 5, 3 at 6,
  2 at 7+, 2 lower, 15 never scored. Sent in your digests: 2 (of 34 stories sent in total).
- Per feed, items taken and runs where the 8 cap was hit: News.am English 11 (0 runs),
  Azatutyun 21 (0), Sputnik Armenia 44 (1 run), AZERTAC 35 (2), Trend 84 (4 runs, 15%), the rest
  0-6 items and never capped. Feeds' own volume (live snapshot): News.am English 1.4/h, Russian
  4.6/h, Armenian 5.2/h, with single hours up to 9-14.
- First pass: 84 calls, 957k input and 262k output tokens; mean per run 36.8k in (31.9k over the
  20 normal hours after setup), 10.1k out (6.5k normal hours); Gemini 61 calls with 3 HTTP 503,
  no 429; Groq 23 calls. Mean run time 91 s (53 s normal hours).

### Choosing the caps
Busiest measured hours: News.am Russian 9, News.am Armenian 14, 168.am about 9 (its feed holds
only the last ~3 hours). A run normally takes the last hour, but after a missed run the window is
2 hours or more, so the busy feeds got 20. Factor.am and Aravot feeds hold only 10 items, so 10.
A1+ posts interview clips in bursts of 8-10, so 12. In the two real runs no Armenian feed was cut;
only the Russian state agencies were (TASS, RIA, RG, Izvestia, RBC), as intended.

### Dry run from this PC (15:00 UTC, real feeds, Gemini countTokens)
Old set: 116 items, 1 call, 17,577 input tokens. New set: 138 items, 1 call, 19,988 tokens.
**+22 items, +2,411 input tokens (+14% of that hour), no extra call**, about +1,050 output tokens.
The fixed part of every prompt (instructions and 250 existing stories) is 10,270 tokens.

### The two real runs on GitHub
| | 15:07 UTC (run 43608484041) | 16:07 UTC (run 43613894866) |
|---|---|---|
| Status, time | ok, 168 s | ok, 48 s |
| Feeds | 123 of 123 | 123 of 123 |
| New items (from the 8 new feeds) | 168 (51) | 160 (24) |
| First pass calls | 503 on the main model, then 2 on the backup model | 2 |
| First pass tokens in / out | 33,980 / 15,085 | 33,694 / 7,920 |
| Editor tokens in / out | 12,098 / 5,940 | 11,947 / 5,295 |
| Stories created / merged | 46 / 29 | 55 / 33 |

Both runs made a second first-pass call because the answer skipped 21-22 items (it was resent,
as often happened before too: 12 of the 20 normal baseline hours had 2+ calls). Most of a second
call's tokens are the fixed part.

### Same event in Armenian, Russian and English
21 Armenia stories in the two runs; 5 hold articles in 2+ languages, and more were joined
within one language. Real examples of good grouping:
- PACE group statement on Samvel Karapetyan's arrest: News.am (ru) + ArmInfo (en) + 168.am (hy).
- Illegal mining in Aragatsotn, 500 million drams of damage: News.am (ru) + Factor.am (hy), and an
  hour later A1+ (hy) joined the same story.
- SINJAR NGO statement on Boris Murazi: News.am English + News.am Russian.
- Pashinyan meets India's foreign minister: Factor.am + Aravot + A1+ + 168.am (all hy), one story.
- State compensation to judge David Grigoryan: Aravot, then News.am (ru) and 168.am (hy) an hour
  later.
- Arsen Gevorgyan's death in custody: News.am (ru) + 168.am (hy).

Missed or wrong (see Risks): Bulgaria arms into a Poland story, EU Gaza-crossings call into a
Gaza hospital story, Robert Amsterdam into the PACE story, and the editor's prisoner-quote merge.
I found no case where the same event stayed as two separate stories: no similar pair by the
word check and none in the near-duplicate groups.

### Would the new Armenia stories reach a digest today?
**0 of 21.** None has an editor score of 6+ (scored so far: three 4s and four 5s; 12 not scored
yet, and unscored stories count as first-pass score minus 2, at most 4 here). Your digest replay
(`digest-cli --windows`) shows Armenia only through big stories: "CSTO strips Armenia of voting
rights" (7) and "Armenia and Turkey close to diplomatic relations" (7). For Step 8: about 4-17 new
Armenia stories an hour, mostly scored 4-5, so a topic score with its own bar is what would let
them through.

### Tests
- Python: 79 tests OK (73 before; new: per-feed cap and cut counts, caps from the config file and
  their validation, the job storing per-feed caps and the "cut" record, English link taking over
  in a merge and staying when a Russian article joins, Armenian token estimate, shadow step
  making no request when paused). I broke the new code on purpose once each (cap ignored, old
  link scoring) and the new tests failed, then restored it.
- Worker: 112 tests OK (unchanged).
- `scripts/check_feeds.py`: 123 of 123 feeds OK, config valid. Secret scan: nothing found.

## Files created / changed
- **New:** `config/candidates/armenia.yaml`, `scripts/armenia_stats.py`,
  `scripts/discover_feeds.py`, `scripts/source_dry_run.py`, `scripts/armenia_grouping.py`,
  `reports/data/step-07-baseline.csv`, `reports/data/step-07-after.csv`, this report.
- **Changed:** `config/sources.yaml` (8 feeds, `max_items`, News.am note), `config/gnews_queries.yaml`
  (paused), `job/fetch.py`, `job/run.py`, `job/ai.py`, `job/shadow.py`, `scripts/check_feeds.py`,
  `.github/workflows/check-feeds.yml`, `.gitignore` (report data is committed), tests, README,
  ARCHITECTURE, PROJECT_NOTES.

## What the owner must do
Nothing. Your digests work as before; the pool simply has more Armenian news in it. When you are
ready, Step 8 (the dynamic digest) is the step that decides how much of it you see.
