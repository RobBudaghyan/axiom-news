# Step 01: Foundation, design, sources

Date: 2026-11-13. Nothing was deployed and no accounts were created.

## Summary
The new project folder is now a git repository with the basic files, a full architecture document,
the topic list, the hourly AI prompt and a condensed list of old lessons. I tested 199 candidate RSS
feed URLs and kept **116 working feeds** in `config/sources.yaml`, each with region, language,
topics, paywall, state-ownership and quality-tier labels. A health-check script re-checks all of
them: the final run showed **116/116 OK in 12 seconds**. Real volume is about 8,900 items/day.
With a cap of 8 items per feed per hour, that comes to about 190 items per hourly AI call, roughly
26k tokens, so one call per hour is enough.

## What was done
- **A. Setup:** `git init` (branch `main`) with a repo-local git identity; `.gitignore` (blocks
  `.env`, `*.session`, `*.db`, `venv/` and others); `.gitattributes` (LF line endings);
  `.env.example` with every future variable explained; `requirements.txt` (pinned); `README.md`;
  `PROJECT_NOTES.md`; a local `venv/` (gitignored).
- **B. `docs/ARCHITECTURE.md`:** components, data flow, digest format, time zones and scheduling
  (with the expected delay), D1 tables, security between the parts, AI budget math from real feed
  volumes, the fallback design, free-tier limits with links to official docs, the planned repo
  layout, and design risks.
- **C. Carried over from the old project, cleaned up:**
  - `config/topics.yaml`: 6 topics with English labels, Russian labels kept for later, and a new
    scoped `definition` per topic.
  - `prompts/story_batch.md`: one batch prompt (group, filter, tag, score, summarize) with an
    output schema. It keeps the old calibration examples, the accuracy rule, the "same concrete event" rule and
    the dated current-facts block.
  - `docs/LESSONS.md`: 21 old lessons that still apply.
- **D. Sources:** 160 candidates in round 1, then 39 alternate or extra URLs in round 2. Labels
  were filled from my knowledge of each outlet and are listed in the file. `scripts/check_feeds.py`
  fetches every feed in parallel, checks it, validates the config fields, and prints a table with
  an estimated items/day.
- **E.** Four commits, this report, and PROJECT_NOTES updated.

Note: the old project is at `C:\Users\budag\VS_Code_Projects\OLD Axiom News`, not `...\Axiom News`
as the brief said. I only read `CLAUDE.md` (sections 1-7), `llm/provider.py` and
`config/topics.yaml` there. I did not open `.env`, session files or databases, and changed nothing.

## Files created / changed
`.gitignore`, `.gitattributes`, `.env.example`, `requirements.txt`, `README.md`, `PROJECT_NOTES.md`,
`config/topics.yaml`, `config/sources.yaml`, `prompts/story_batch.md`, `docs/ARCHITECTURE.md`,
`docs/LESSONS.md`, `scripts/check_feeds.py`, `reports/step-01-foundation.md`.

## Tests run and real results
1. **Candidate round 1** (160 URLs): 124 OK, 36 failed. Failures included: AP and Reuters (HTTP 403/401),
   CNN and the old WSJ feeds (stale for 1-3 years), Telegraph (402), ISW (403), Armenpress (404 on
   three URL patterns), Nikkei and Eurasianet (no dates), Press TV (SSL error), and Tasnim, Middle East Eye,
   Bellingcat, Fontanka and Aravot (connection errors).
2. **Round 2** (39 alternates): 17 OK. Recovered: Kyiv Independent (new URL), CivilNet (new URL),
   WSJ (new Dow Jones URLs), Asharq Al-Awsat, FT sections, and others.
3. **Selection:** 116 of the working feeds, with some dropped as redundant or too local (Lenta, Gazeta.ru,
   RT Russian, Suspilne, news.am Russian/Armenian, TIME, The Atlantic, Japan Times, ABC Australia
   "Just In", among others).
4. **Final run** of `venv/Scripts/python scripts/check_feeds.py` on `config/sources.yaml`:
   exit code 0, 12 seconds, 116/116 OK, no config errors. Full output is below.
5. **Validator negative test:** I fed two deliberately bad entries to `validate()`. It reported all five planted errors: non-bool paywalled, tier 4, unknown topic, duplicate key, duplicate URL.

Balance of the final list: global/Western 44, of which 14 are financial (15 financial feeds in total, counting The Economist Middle East), Russia 26, Middle East/Iran 22,
Armenia/Caucasus 15, Ukraine 9.
- By language: en 91, ru 21, fa 2, hy 1, uk 1.
- 32 feeds are labelled state_owned, 26 are paywalled.
- Tiers: 30 feeds are tier 1, 70 tier 2, 16 tier 3.
- The "global" region also contains Russia/Ukraine/Iran section feeds from the Guardian, NYT,
  FT and others.

```
STATUS KEY                  NAME                       ITEMS  NEWEST  24H ~/DAY  NOTE
OK     bbc_world            BBC News                      22    0.3h   19    19  
OK     bbc_europe           BBC News                      23    0.7h    6     6  
OK     bbc_middle_east      BBC News                      26    1.4h    4     4  
OK     guardian_world       The Guardian                  45    0.0h   29    29  
OK     guardian_ukraine     The Guardian                  20    0.6h    7     7  
OK     guardian_russia      The Guardian                  20    0.6h    8     8  
OK     guardian_iran        The Guardian                  20    1.8h    5     5  
OK     nyt_world            The New York Times            56    1.3h   23    23  
OK     nyt_politics         The New York Times            20    1.9h   20    22  feed holds < 24h; ~/DAY estimated
OK     nyt_middle_east      The New York Times            23    4.1h    3     3  
OK     nyt_europe           The New York Times            20    1.3h   11    11  
OK     wapo_world           The Washington Post           11    3.9h    7     7  
OK     wapo_politics        The Washington Post           42    0.5h   20    20  
OK     npr_world            NPR                           10    1.8h    3     3  
OK     abc_us_intl          ABC News                      25    0.1h   10    10  
OK     cbs_world            CBS News                      30    0.6h   17    17  
OK     nbc_world            NBC News                      25   13.6h    2     2  
OK     france24_en          France 24                     24    1.2h   24    60  feed holds < 24h; ~/DAY estimated
OK     dw_en                DW                            12    1.4h   12    13  feed holds < 24h; ~/DAY estimated
OK     euronews             Euronews                      50    0.3h   21    21  
OK     politico_eu          Politico Europe               10    0.3h   10    23  feed holds < 24h; ~/DAY estimated
OK     politico_us          Politico                      30    3.1h    7     7  
OK     the_hill             The Hill                      15    0.2h   15   136  feed holds < 24h; ~/DAY estimated
OK     axios                Axios                        100    0.1h   19    19  
OK     foreign_policy       Foreign Policy                25    0.9h    7     7  
OK     foreign_affairs      Foreign Affairs               20    8.9h    3     3  
OK     sky_world            Sky News                       6   24.3h    0     0  
OK     independent_world    The Independent               68    0.2h   66    66  
OK     cbc_world            CBC News                      20    2.9h    7     7  
OK     le_monde_en          Le Monde                      14    0.6h   14    23  feed holds < 24h; ~/DAY estimated
OK     scmp_world           South China Morning Post      50    0.5h   50    93  feed holds < 24h; ~/DAY estimated
OK     rferl_news           RFE/RL                        20    2.1h    1     1  
OK     rferl_ukraine        RFE/RL                        20    6.1h    2     2  
OK     ft_world             Financial Times               25    0.0h   25    68  feed holds < 24h; ~/DAY estimated
OK     ft_europe            Financial Times               25    1.4h   24    24  
OK     ft_markets           Financial Times               25    0.9h   14    14  
OK     economist_leaders    The Economist                300   23.7h    3     3  minor XML issues
OK     economist_europe     The Economist                300   23.7h    3     3  minor XML issues
OK     economist_mea        The Economist                300   23.7h    3     3  minor XML issues
OK     economist_finance    The Economist                300   27.2h    0     0  minor XML issues
OK     wsj_world            The Wall Street Journal       72    4.2h   18    18  
OK     wsj_markets          The Wall Street Journal       61    2.3h   29    29  
OK     bloomberg_politics   Bloomberg                     20    0.5h   20    45  feed holds < 24h; ~/DAY estimated
OK     bloomberg_markets    Bloomberg                     20    0.6h   19    19  
OK     bloomberg_economics  Bloomberg                     20    0.3h   20    27  feed holds < 24h; ~/DAY estimated
OK     cnbc_world           CNBC                          30    0.1h   28    28  
OK     cnbc_economy         CNBC                          30    0.1h    3     3  
OK     marketwatch          MarketWatch                   10    0.2h   10    69  feed holds < 24h; ~/DAY estimated
OK     war_on_the_rocks     War on the Rocks             100   19.4h    1     1  
OK     breaking_defense     Breaking Defense              15   16.2h    9     9  
OK     defense_news         Defense News                  10   15.5h    7     7  
OK     twz                  The War Zone                  37   13.5h    5     5  
OK     long_war_journal     Long War Journal              30   22.1h    1     1  
OK     tass_ru              TASS                          98    0.0h   98  1577  feed holds < 24h; ~/DAY estimated
OK     tass_en              TASS                         100    0.0h  100   203  feed holds < 24h; ~/DAY estimated
OK     ria                  RIA Novosti                   96    0.0h   96  1211  feed holds < 24h; ~/DAY estimated
OK     rt_en                RT                           100    0.1h   39    39  
OK     rg                   Rossiyskaya Gazeta           100    0.1h  100  1107  feed holds < 24h; ~/DAY estimated
OK     kremlin              Kremlin.ru                    20    4.4h    5     5  
OK     izvestia             Izvestia                      50    0.2h   50   586  feed holds < 24h; ~/DAY estimated
OK     interfax             Interfax                      25    0.2h   25   375  feed holds < 24h; ~/DAY estimated
OK     kommersant           Kommersant                   547    0.1h  198   198  
OK     vedomosti            Vedomosti                    200    0.0h  134   134  minor XML issues
OK     rbc                  RBC                           30    0.2h   30   405  feed holds < 24h; ~/DAY estimated
OK     meduza_ru            Meduza                        30    0.4h   30    35  feed holds < 24h; ~/DAY estimated
OK     meduza_en            Meduza                        30    1.5h   23    23  
OK     novaya_europe        Novaya Gazeta Europe         100    0.0h   25    25  
OK     moscow_times         The Moscow Times              50    0.8h   11    11  
OK     tvrain               TV Rain                       60    0.1h   56    56  
OK     bbc_russian          BBC Russian                   34    0.1h   11    11  
OK     dw_russian           DW Russian                    75    0.4h   25    25  
OK     svoboda              Radio Svoboda                 20    0.3h    9     9  
OK     currenttime          Current Time                  20    0.3h   18    18  
OK     mediazona            Mediazona                     50    0.0h   18    18  
OK     agentstvo            Agentstvo                     10    1.8h   10    11  feed holds < 24h; ~/DAY estimated
OK     verstka              Verstka                       10    6.3h    3     3  
OK     the_insider          The Insider                   50    0.2h   47    47  
OK     news_am_en           News.am                      100    0.4h   42    42  
OK     azatutyun            Azatutyun                     20    0.4h   20    22  feed holds < 24h; ~/DAY estimated
OK     civilnet             CivilNet                     100   19.8h    3     3  
OK     evn_report           EVN Report                    50    2.8h    1     1  
OK     hetq                 Hetq                          50   20.8h    2     2  
OK     public_radio_am      Public Radio of Armenia       10    1.5h   10    11  feed holds < 24h; ~/DAY estimated
OK     oc_media             OC Media                      16    2.4h    9     9  
OK     jamnews              JAMnews                       10    0.3h   10    11  feed holds < 24h; ~/DAY estimated
OK     civil_ge             Civil.ge                      10    4.8h    3     3  
OK     armenian_weekly      The Armenian Weekly           10   21.5h    4     4  
OK     mirror_spectator     Armenian Mirror-Spectator     10   12.6h   10    24  feed holds < 24h; ~/DAY estimated
OK     massis_post          Massis Post                   25    9.0h    4     4  
OK     sputnik_armenia      Sputnik Armenia              100    0.2h   59    59  
OK     azertag              AZERTAC                       50    0.0h   50    54  feed holds < 24h; ~/DAY estimated
OK     trend_az             Trend                         25    0.3h   25   314  feed holds < 24h; ~/DAY estimated
OK     al_jazeera           Al Jazeera                    25    0.5h   25   100  feed holds < 24h; ~/DAY estimated
OK     times_of_israel      The Times of Israel           13    1.0h   13    43  feed holds < 24h; ~/DAY estimated
OK     jpost                The Jerusalem Post            26    0.0h   20    20  
OK     haaretz              Haaretz                      100    0.4h   41    41  
OK     al_monitor           Al-Monitor                    20    0.1h   20    23  feed holds < 24h; ~/DAY estimated
OK     aawsat               Asharq Al-Awsat              300    2.5h   66    66  minor XML issues
OK     the_national         The National                 100    0.2h   63    63  
OK     amwaj                Amwaj.media                   60    9.5h    4     4  
OK     iran_international   Iran International            50    0.3h   16    16  
OK     iranwire             IranWire                     463    0.2h   23    23  
OK     radio_farda          Radio Farda                   20    0.2h   13    13  
OK     bbc_persian          BBC Persian                   29    0.3h   10    10  
OK     tehran_times         Tehran Times                  30    0.8h   16    16  
OK     irna_en              IRNA                          30    0.8h   22    22  
OK     mehr_en              Mehr News                     30    0.6h   17    17  
OK     anadolu              Anadolu Agency                30    0.1h   30   299  feed holds < 24h; ~/DAY estimated
OK     daily_sabah          Daily Sabah                   50    0.7h    4     4  
OK     kyiv_independent     The Kyiv Independent          15    0.3h   15    22  feed holds < 24h; ~/DAY estimated
OK     ukrainska_pravda_en  Ukrainska Pravda              20    0.8h   20    93  feed holds < 24h; ~/DAY estimated
OK     kyiv_post            Kyiv Post                    100    0.9h   35    35  
OK     nv_en                NV                            40    0.5h   40    74  feed holds < 24h; ~/DAY estimated
OK     ukrinform_en         Ukrinform                     30    0.2h   30    83  feed holds < 24h; ~/DAY estimated
OK     radio_svoboda_ua     Radio Svoboda                 20    0.4h   20    73  feed holds < 24h; ~/DAY estimated
OK     euromaidan_press     Euromaidan Press              29    1.2h   14    14  

116/116 feeds OK. Across OK feeds: 2684 items seen from the last 24h; estimated total ~8922 items/day.
```
"ITEMS" is the number of entries in the feed now. "NEWEST" is the age of the newest entry.
"24H" counts entries from the last 24 h. "~/DAY" is estimated from the feed's time span when the
feed holds less than a day of entries. "minor XML issues" means feedparser noted small format
problems but parsed every entry.

## Decisions I made and why
- **Python (job) + JavaScript (Worker/Mini App)**, sharing only data files. See ARCHITECTURE §2.
- **Digests are sent by a Cloudflare cron every 5 min**, not GitHub, because GitHub documents that
  scheduled runs can be delayed or dropped. Delay is 0-5 min plus Cloudflare's small, unpublished variance.
- **The job writes to D1 via the REST API** with a D1-only token, so Worker CPU stays free and nothing
  can call into the job.
- **Best link is chosen by code** (lowest tier, then earliest), not by the AI. It is cheaper and
  predictable, and still meets the spec's goal of the most prestigious outlet.
- **Cap of 8 new items per feed per run.** TASS (~1,600/day), RIA (~1,200) and Rossiyskaya Gazeta
  (~1,100) would otherwise dominate every batch.
- **Fallback is Groq**, with the batch split into chunks of about 6k tokens to fit Groq's 8k-tokens-per-minute
  limit. I rejected Cerebras (needs a payment method), Mistral (the docs say API use needs billing)
  and OpenRouter free (50 requests/day).
- **Primary model `gemini-3.5-flash-lite`**: listed Stable and free on Google's pricing page today.
- **`state_owned` means government-owned or mainly government-funded**, with `note` saying whether
  the outlet is state-controlled (TASS, RT, IRNA) or editorially independent (BBC, DW, RFE/RL).
  This avoids subjective labels, but it means the BBC is marked `true`.
- **Tiers:** Kremlin-controlled, Iranian state and partisan outlets are tier 3, so they are kept for
  coverage but never chosen as the link when a better outlet has the same story. TASS is tier 2 as the main wire agency.
- **116 feeds rather than exactly 100.** Low-volume feeds cost almost nothing under the batch design,
  and they add regional coverage.
- **Topics now have short definitions** for the AI (an old lesson). The `ru` labels are kept for later.
  The `iran_war` emoji is simplified from 🇮🇷💥 to 🇮🇷.

## Problems / risks / open questions
- **Feeds were checked only from the owner's PC.** GitHub's US servers may see different results,
  especially Russian sites (geo-blocking) or Cloudflare-protected sites. In Step 2, run the same
  check inside GitHub Actions before relying on the list.
- **Missing major sources.** Reuters and AP have no public RSS that works (403/401). Armenpress
  (Armenia's state agency) has no RSS URL that I could find. ISW returns 403. Asbarez returned 504
  twice and may be temporarily down.
- **Gemini free-tier per-model limits are not published.** Google now shows them only in AI Studio,
  and third-party figures for `gemini-3.5-flash-lite` disagree (10-30 RPM, 500-1,500 RPD). We need
  only 24 requests/day, but the tokens-per-minute figure must be checked in Step 2. If it is under about 30k,
  the job will use chunking.
- **Groq limits are "sample" values.** The exact numbers appear on the account's console. Third-party
  sources disagree on whether Groq's free plan asks for a card; check this when signing up and stop if it does.
- **Labels (paywall, ownership, tier) come from my knowledge**, not from a verified database.
  Ownership details for Gazeta.ru/Lenta (via Sber) did not matter because both were dropped. The ones most
  worth a second look: Iran International (funding note), The National, and Asharq Al-Awsat.
- **The Economist feeds** contain 300 archived entries each. Fine for the URL-seen check, but the
  hourly job must only take recent items. It already will: newest 8, and only unseen URLs.
- The Worker's 10 ms CPU limit for the digest cron is expected to be fine, but it has not been measured yet.
- **Open questions for the owner:** a private GitHub repo (recommended)? `Asia/Yerevan` as the
  default time zone until a user opens the Mini App?

## What the owner must do
Nothing for this step. The next step will need some sign-ups. I will send click-by-click
instructions then; no keys should ever be pasted into chat.

Two quick answers would help, and you can tell your advisor or me:
1. Should the GitHub repository be **private**? (Recommended.)
2. Is **Armenia time (Asia/Yerevan)** right as the default until each person opens settings?

## Suggested next step
**Step 2: accounts + database + hourly job (local first).**
1. The owner creates the TEST bot (@BotFather), a Cloudflare account, a Google AI Studio API key in
   a project with no billing, a Groq key and a private GitHub repo, and installs Node.js LTS.
   I will write instructions.
2. Claude writes `db/schema.sql` and the Python hourly job (fetch, AI call with fallback, D1 writes),
   and runs it locally against a real D1 database.
3. Claude adds the GitHub Actions workflow and runs `check_feeds.py` on GitHub's runners to confirm
   the feeds work from there.
