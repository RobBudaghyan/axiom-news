# Step 20: AI resilience and translation quality (2026-11-24)

## Why
On 2026-11-23 Gemini's free tier answered 503 "high demand" for about 5 hours. The job fell back to one Groq
model, runs took 9 to 11 minutes, only 6 or 7 stories were made a run and 667 items piled up. Then, from
about 19:00 UTC, **the main Gemini key answered HTTP 402 "Your prepayment credits are depleted"** on every
model: its project is still a Prepay project (with $0 left), not the free tier. Since then production ran on
Groq alone and made **1 to 3 stories a run**; 3,446 items were waiting on 2026-11-24 13:00 UTC.

The real reason Groq was so slow (found in this step): the fixed part of the first-pass prompt has grown to
about 3,100 tokens, and Groq calls were limited to 3,500 tokens, so **each Groq call held only 2 or 3 items**.

## Key check (part 0)
- Both keys copied into GitHub (job), the staging Worker and the production Worker with `set_secrets.py`
  (never printed). `.env` holds them; the workflows pass `GEMINI_EMERGENCY_API_KEY` to the job.
- **The main key is NOT on the free tier.** Every call answers 402 "prepayment credits are depleted" (checked
  2026-11-23 18:51 and 19:17 UTC and 2026-11-24 13:23 UTC). A free-tier project never answers 402. The owner
  was told on the TEST bot at 18:52 UTC. Fix: AI Studio > Projects > the original project > remove billing
  (or a new project with no billing, and its key into `.env`, then `set_secrets.py`).
- The emergency key works on every model we use, `serviceTier: standard` (paid).
- **Billed since 2026-11-23 18:00 UTC:** the API does not show billing, and AI Studio needs the owner's
  sign-in (not done). Estimate from our own token counts: the 18:07 run on the main key (still Prepay then)
  used about 139k input and 56k output tokens on 3.5 Flash-Lite plus 83k in and 40k out on 3.1 Flash-Lite,
  about **$0.26** at Google's prices; that likely used up the last Prepay credits (402 from 19:00 on). On the
  emergency key: our tests on staging, about $0.15 in all (listed below), and production's own spend after
  the ship (Admin > AI shows it).

## What changed
1. **Retries:** a free Gemini 503 is retried after 5, 15 and 30 s while the run's 150 s of retry time
   lasts; then that model is tried once per call for the rest of the run (no long waits). A 402 stops every
   model on that key for the run at once.
2. **The chain:** free Gemini models one by one (3.5 Flash-Lite, 3.1 Flash-Lite, 3 Flash preview, 3.8 Flash),
   then Groq's three models in rotation (gpt-oss-120b, qwen3.8-27b, gpt-oss-20b: each has its own 8,000
   tokens a minute; a 429 moves on to the next one; a daily limit takes a model out), then the emergency key.
   Groq calls now hold about 30 items (5,000-token prompts with 10 existing stories, 2,800 reply tokens). A
   Groq answer that breaks the JSON schema (HTTP 400) is a bad answer, not an outage.
3. **The emergency key** is used ONLY for work every free option failed on (not for work a free provider had
   no time or calls left for: that waits for the next run). Hard caps in code: $0.10 a UTC day, $1 a month,
   the $10 credits and their expiry (2027-11-23), checked BEFORE each call against its worst case (the prompt
   plus its whole 12,000-token answer limit at Google's price). The cost of each call (from its token counts)
   is logged in a new table `ai_spend` with why the free options failed. If the ledger cannot be read, no paid
   call. Models: 3.1 Flash-Lite (pass 1, editor, topic checks: the cheapest that passes our checks), 3 Flash
   preview then 3.8 Flash (translations). Google's $2 monthly cap is the second lock.
4. **Degraded order:** when the main model is down, items of topics active readers follow go first, then the
   best sources (tier 1 first), then the newest; the rest waits.
5. **Alerts and Admin:** one Telegram alert on any UTC day the emergency key spent money (amount, calls, why).
   Admin > AI shows the provider of each of the last 12 runs, the emergency spend today and this month, the
   credits left (our own count) and the expiry date. The health line turns amber on a paid day.
6. **The Worker's topic check** uses the same order: each free Gemini model (a 503 tried once more after 1.5 s),
   Groq's three models, then the emergency key under the same caps (its spend goes to `ai_spend` too).
7. **Translations:** only the strong models (free Gemini 4 Hydrogen, then 3.8 Flash; then the emergency key),
   never Groq; if none can, the story waits (the Step 10 hold). The model gets the source's original title as
   context and a list of 21 news words with two meanings in four languages (`config/glossary.yaml` `terms`:
   intelligence, special services, espionage, sabotage, job ads, recruitment, sanctions, strike, ceasefire...).
   **The meaning check:** a second call reads each translation back into English, word for word, and compares
   it with the original; a story is rejected if the model says the meaning changed or if an ambiguous term
   (intelligence, espionage, sanctions...) is missing from the reading back. A rejected story is redone at
   once with the problem as its note, and checked again. A new code check: a Latin word inside Armenian or
   Russian must be in the English (3.5 Flash-Lite wrote the Polish word "że" inside **13 of 53** Armenian
   translations of the last 48 h).

## Tests
- Python 219 tests (34 new, `tests/test_step20.py`), Worker 373 (14 new, `worker/test/step20.test.mjs`).
  **36 of 36 new rules broken on purpose were caught** (`venv/Scripts/python scripts/step20_mutations.py`); two
  tests were too weak at first (a model whose retries ran out, an unreadable ledger in the Worker) and were
  strengthened; later live fixes added 3 more (36 of 36). Mini App click-through **248 of 248** (one Russian
  edit-mode check failed once and passed on the rerun: flaky, not touched by this step). Admin screenshot:
  `reports/step-20/admin-ai-emergency.jpg` (demo data).
- Staging, real AI (`AXIOM_ENV=staging`):
  - **(a) free Gemini forced to 503, paid key off:** pass 1 and the editor ran on Groq, **$0 spent**; the
    translations waited (no strong free model: the main key is 402). With the old Groq sizes this run made only
    16 stories in 8.5 min, which is how the 2-3 items a call problem was found.
  - **Today's real state (main key 402, nothing forced), new Groq sizes:** 73 stories in 135 s (production made
    1 to 3 a run); Russian translations through the emergency key with the meaning check (13 of 13, $0.0096).
    It also showed two problems, both fixed and tested: a Groq JSON 400 counted as an outage, and paid pass-1
    chunks too big for the 12k answer limit.
  - **(b) every free option forced to fail:** the emergency key served pass 1 (25 stories in 240 s), each paid
    call logged in `ai_spend` with why; the alert text the hourly tick sends (staging never sends alerts):
    "the paid emergency Gemini key was used today: $0.0999 so far (10 calls ...). Why: gemini-3.5-flash-lite:
    HTTP 402; ... openai/gpt-oss-20b: HTTP 400". The paid editor answer ran past the 12k limit (60 stories):
    fixed, the paid editor now asks for 20 + 5.
  - **(c) the cap:** staging's day stopped at **$0.0999** of $0.10; the next paid calls were refused before any
    request: "emergency key not used: daily cap $0.10 (spent $0.0999 today)".
  - **(d) the owner's bad Armenian example** through the real meaning check: read back as "Ukrainian
    deception says that Russian special services posted 20 million fortune-telling job announcements on
    Discord"; the model said the meaning changed ("intelligence" as "deception", "espionage" as
    "fortune-telling") and the term rule found intelligence, espionage and sabotage lost: **REJECTED**. The
    good version: accepted. $0.0009.

## Armenian and French, last 48 h
- **French:** no French reader yet, so there were no French translations to redo.
- **Armenian:** 80 current translations in 48 h; the new code checks alone reject 16 of them (13 with the Polish
  "że"). On 2026-11-24 the 12 worst (all made by Groq) were translated again with the new rules on production
  (`scripts/step20_retranslate.py`): **12 of 12 replaced**, 7 calls, **$0.0144** on the emergency key (the free key
  is still 402). The other 68 are next: `venv/Scripts/python scripts/step20_retranslate.py --langs hy --skip-done`
  (it stops at the daily cap; run it again the next day, or it goes fast once the main key is free).
- "Read back" is the meaning check's word-for-word reading of the OLD translation. Full record:
  `reports/data/step-20-retranslate.json`. **Please judge the Armenian.**

| # | English | Before (old) | Old, read back into English | After (new) |
|---|---|---|---|---|
| 1 | US intelligence chief warns of potential technology outages | ԱՄՆ-ի տեղեկատվական ղեկավարն զգուշացրել է հնարավոր տեխնոլոգիական անընդհատություններ | "The US information head has warned of possible technological continuities" | ԱՄՆ հետախուզության ղեկավարը զգուշացրել է տեխնոլոգիական հնարավոր խափանումների մասին |
| 2 | FSB arrests Russian citizen in Crimea suspected of spying for Ukrainian intelligence | ՖՍԲ-ն բռնել է քրիմիայում ռուս քաղաքացի, որը կասկածվում է ուկրաինյան գաղտնազգայնության համար | "The FSB has caught a Russian citizen in Crimea, who is suspected for Ukrainian secret-ness" | ԱԴԾ-ն Ղրիմում ձերբակալել է Ռուսաստանի քաղաքացու, որը կասկածվում է ուկրաինական հետախուզության օգտին լրտեսության մեջ |
| 3 | Global technology stocks and AI sector face sharp declines and market warnings | Աշխարհի տեխնոլոգիական և AI բաժինները հանդիպեցին խիստ իջեցումներով, և բանկը զգուշացրել է AI‑ի պարտքի պղպջակները | "The world's technological and AI sections met with severe decreases" | Տեխնոլոգիական բաժնետոմսերի համաշխարհային շուկան և AI ոլորտը բախվել են կտրուկ անկումների և շուկայական նախազգուշացումների |
| 4 | California sues OpenAI over model security and public safety | Կալիֆորնիա գործ է ներկայացրել OpenAI‑ի դեմ՝ մոդելի անվտանգության և հանրային անվտանգության համար | "California has presented a case against OpenAI" (and "law agent ... plotting" for "attorney general ... alleging") | Կալիֆոռնիան դատի է տվել OpenAI-ին մոդելների անվտանգության և հանրային ապահովության համար |
| 5 | Denmark expels Russian official over alleged assassination plot | Դանիա դուրս է հանել ռուս պաշտոնականին, կասկածելով սպանության պլանով | "Denmark has taken out a Russian official, suspecting with a murder plan" | Դանիան արտաքսել է ռուս պաշտոնյային սպանության ենթադրյալ դավադրության պատճառով |
| 6 | Moscow considers response options after attacks on ships in Benghazi | Մոսկվա կհաշվի արձագանքների տարբերակները Բենղազիում նավակների հարվածներից հետո | "Moscow will count response options after boat strikes in Benghazi" | Մոսկվան դիտարկել է պատասխան գործողությունների տարբերակները Բենգազիում նավերի վրա հարձակումներից հետո |
| 7 | Pashinyan pledges to resign if constitutional referendum fails | Փաշինյանը խոստացավ հրաժարվել, եթե սահմանադրական ռեֆերենդը չհաջողվի | (not read back) | Փաշինյանը խոստացել է հրաժարական տալ, եթե սահմանադրական հանրաքվեն ձախողվի |
| 8 | European Central Bank warns of debt bubble risks in artificial intelligence market | Եվրոպական կենտրոնական բանկը զգուշացրել է AI շուկայի պարտքի պղպջակները ռիսկերը | (rejected by the new Latin-word check: "AI" is not in the English) | Եվրոպական կենտրոնական բանկը զգուշացրել է արհեստական բանականության շուկայում պարտքային փուչիկի ռիսկերի մասին |
| 9 | EU and Indonesia sign comprehensive trade and tariff agreement | ԵՄ-ը և Ինդոնեզիան ստորագրեցին ամբողջական առևտրի և տարֆների համաձայնագիր | "signed a complete trade and tariffs agreement" (meaning kept; "տարֆների" is not a word) | ԵՄ-ն և Ինդոնեզիան ստորագրել են առևտրի և մաքսատուրքերի համապարփակ համաձայնագիր |
| 10 | Analytics warn AI compute provider CoreWeave faces risk of financial collapse | Անալիտիկները զգուշացնում են, որ CoreWeave-ի ֆինանսական անկման ռիսկը բարձր է | "Analysts warn that CoreWeave's financial collapse risk is high" (meaning kept) | Վերլուծաբանները զգուշացրել են AI հաշվարկային ծառայություններ մատուցող CoreWeave-ի ֆինանսական փլուզման ռիսկի մասին |

One new translation to look at with care: "European natural gas prices climb above 90 euros" became "... բարձրացել են
մեկ մեգավատտ-ժամի դիմաց 90 եվրոյից" ("rose from 90 euros"?); the meaning check accepted it.

## Production after shipping (2026-11-24)
- Shipped 13:43 UTC (owner approved in chat): Worker `bb45a898`, `ai_spend` in the production database, job code
  `8d3fab3`, then `5455256` (13:58, two fixes found in the first production run, below).
- First production run with Step 20 (13:43): **60 new stories in 128 s** (the runs before made 1 to 3). It showed
  that all three Groq models can answer a 1-second per-minute 429 at the same moment; the pool then gave up and
  the paid key took over ($0.023). Fixed (the pool waits and goes round again) and checked on staging: **152 new
  stories in one run on Groq alone, $0**. A Groq editor call refused as too large by one model now tries the next.
- 3,446 items had piled up; items older than 24 h expire as before, so news from the outage hours that was never
  processed is skipped, not sent late.
