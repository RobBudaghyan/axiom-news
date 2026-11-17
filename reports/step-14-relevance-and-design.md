# Step 14: custom-topic relevance and the digest design

Date: 2026-11-17. Still on the TEST bot (@justatia_bot). Cost: still $0, no card. About 19 free AI
calls were used for the keyword backfill and the replays (below).

## 0. Step 13 clean-up

Nothing real was left to commit. The Step 13 report was already in git (commit `4936350`). The 25
files git showed as modified were identical to the last commit, byte for byte, once line endings
were ignored: git's file cache was stale. After a refresh the tree was clean. The stale lock file
in `.git` was left alone, as asked. `.claude/` and `Claude outputs/` stay untracked (local files).

## 1. Japan: what was wrong and the fix

**What was wrong.** In your 06:00 and 09:00 digests, the Japan section held stories that are not
about Japan. The editor (the AI) chose Japan as their main topic even though its prompt already said
"only when the event is mainly about it". The prompt alone was not enough:

| Story (live) | Score / topic score | Why it was under Japan |
|---|---|---|
| US restricts China's remote access to advanced AI chips | 6 / 7 | the editor called it Japan |
| Canadian Prime Minister Carney arrives in China for meetings | 5 / 6 | the editor called it Japan |
| China and Canada expand tariff relief on agriculture and steel | 5 / 6 | a Bloomberg article on Japan's PM was merged into it |
| China and Canada slash tariffs | 6 / 6 | the editor called it Japan |
| Trump to meet with Xi and Putin in China | 8 / 8 | main topic Politics, which you do not follow, so it fell into your Japan section |
| China's naval presence near Japan remains normalized | 5 / 6 | about Japan, but nothing happened |

"Takaiti" came from the editor reading a Russian Interfax article ("премьер Японии Такаити") and
spelling the name back from Russian. It was not a Google item.

**The fix (in code, not only the prompt):**
- **Keywords.** Every custom topic now has 5 to 15 match keywords in English and in Russian. The
  topic check writes them when a topic is created. Existing topics got them from one AI call each.
  That call also sees the topic's latest Google headlines, so it uses today's names. The first try
  without headlines gave Japan "Kishida" and "Ishiba" but not Takaichi.
  - Japan today: Japan, Japanese, Tokyo, Yen, Okinawa, Osaka, Kishida, Takaichi, Hokkaido, Kyoto
    (Russian: Япония, японский, Токио, иена, Окинава, ...).
  - Australia: Australia, Australian, Canberra, Sydney, Melbourne, Albanese, Reserve Bank of
    Australia, AUD, NSW, Aussie.
- **The rule.** A story keeps a custom topic, and can sit under it, only if one keyword is in its
  English headline or description: whole word, any case. Otherwise the topic is taken off the
  story. Its main topic falls back to its best main topic, with no boost, or the story leaves the
  custom path. The job checks this in pass 1, in the editor and once every hour over the last 26
  hours, so older stories are fixed too.
- **Non-events.** The editor prompt now says a situation that "remains", "continues" or is
  "unchanged" is 3 or 4, never 6, for the main topics and for reader topics.
- **Names.** When a glossary name is spelled another way ("Takaiti"), it now gets the glossary
  spelling ("Takaichi"). This applies to Google headlines, pass-1 summaries and editor texts.
  Sanae Takaichi is added in four languages: Такаити / Санаэ (Russian), Տակաիչի / Սանաե
  (Armenian), Takaichi / Sanae (French).

**Checked on the last 24 hours** (`reports/data/step-14/keywords.json`): 62 stories carry Japan or
Australia. The rule takes 14 off:
- The first 5 stories in the table above. The naval story keeps Japan, because it is about Japan;
  the non-event rule handles it.
- 5 more weak Japan stories: Shenzhen traffic during APEC, Chinese tech leaders in Shenzhen,
  China's "home-court diplomacy", and a Kamakura item and a Nippon Ham item that were never scored.
- 4 Australian stories that are really Australian but have no keyword: Treasurer Chalmers, a gas
  bill, a Liberal MP in Bennelong, an inquest in New South Wales. All scored 2 to 4 and none
  reached a digest. This is the rule's weak side (see Risks).

**Replay, before and after** (`replay-first.json`, `replay.json`, `replay-again.json`). The same
24 hours of Japan and Australia stories, plus a simulated day of Colombia from real Google results
(nobody follows Colombia live). The editor ran three times "before" (old prompt, no rule) and
three times "after" (new prompt and the rule). Stories that reach a follower of only that topic:

| Topic | Live today | Before (3 runs) | After (3 runs) | Off-topic stories before | after |
|---|---|---|---|---|---|
| Japan | 14 | 21, 7, 8 | 8, 3, 2 | 6, 4, 4 | 0, 0, 0 |
| Australia | 6 | 9, 2, 2 | 7, 3, 1 | 0 | 0 |
| Colombia | | 3, 1, 1 | 0, 2, 0 | 0 | 0 |

The editor's scores swing a lot from one run to the next: Japan "before" was 21 once and 7 the
next time, on the same stories. That noise is why the code check matters. The clear result is the
last two columns: every "before" run had 4 to 6 non-Japan stories under Japan, and no "after" run
had any. (The naval non-event passed in the first "before" run only.)

Examples that pass after the fix: "Japan scrambles jets after Russian aircraft violate airspace",
"US deploys first F-15EX fighters to Kadena Air Base in Japan", "Former Bank of Japan chief Kuroda
sees risk of rates exceeding neutral", "Reserve Bank of Australia raised rates on inflation risks",
"Colombia and US conduct joint security operations". Examples kept out: the Canada/China stories,
the AI chips story, the Trump/Xi/Putin summit (now only under Politics), and "China has
normalized naval presence near Japan" (4/4 in the two "after" runs where I logged every score; it
had 5/6 live).

## 2. The digest design

I sent you two rounds of labelled previews on the TEST bot, with the same 10 real stories (seven
on the main topics, three on Japan):
- **Round 1** (7 messages): four plain newsletter layouts. A Clean, B Editorial, C Brief, D
  Briefing (a newspaper's briefs column, my pick). All had no story emojis and no quote boxes. B and
  D also came in Russian, plus the quiet note. Your answer: do not change the stories, only the
  topic heading.
- **Round 2** (6 messages): today's design with only the topic heading changed, with no box. H1
  bold text with the flag, H2 a heading with the flag (my pick), H3 bold capitals, H4 small
  capitals with the flag. H3 and H2 also came in Russian.

**Your choice:** keep the design exactly as it was before Step 14 (E5f: the centred box per topic,
the editor's emojis, the bold headline, the outlet link, the quote box). The only change: no
"⚙️ Settings" button under the digests any more. This also covers the quiet note, which is sent the
same way. The chat's menu button and /settings still open the Mini App. In every language the button
text is gone from the dictionaries.

Because the stories keep their emojis, the editor still writes 2 or 3 per story (no tokens to
save). The format and the length cut are unchanged: still one message of at most 3,900 characters,
no folding, no em dash.

## Tests

- **Python: 172 pass** (149 before). 23 new in `tests/test_keywords.py`:
  - your six real stories against the Japan keywords;
  - whole words, any case and plurals;
  - pass 1 for new stories and for merges;
  - the editor's fallback with no boost; a story with only a custom tag leaves the custom path;
  - the hourly sweep;
  - 1,000 random stories and editor answers, after which no custom tag sits on a story without a
    keyword;
  - the backfill: one call a topic, the next provider on a failure, the recent headlines, its own
    name first, logged as `topic_keywords`;
  - the glossary spelling in Google headlines and editor texts, and the Russian form in
    translations;
  - the non-event lines in the prompt.

  Four Step 13 tests now give their topics keywords.
- **Worker: 225 pass** (219 before). 6 new in `worker/test/keywords.test.mjs`:
  - the check asks for keywords with the job's exact words;
  - a topic is saved with them, or with NULL if fewer than 5;
  - the cleaning matches the job on 300 shared cases (`tests/fixtures/keyword_cases.json`);
  - no dash in a keyword.

  The button tests in 7 files now check there is NO button, in every language, for digests and
  quiet notes. Admin's "digest now" is checked too.
- **Rules broken on purpose: 24 of 24 caught** (`reports/data/step-14/mutations.txt`). These
  include:
  - the keyword check off, substring or case-sensitive;
  - pass 1, the editor or the sweep ignoring the rule;
  - the boost kept on the fallback;
  - the backfill off, without headlines, or giving up after one provider;
  - the glossary entry or spelling gone;
  - the non-event line gone;
  - the Worker not saving keywords, or saving too few;
  - the button back;
  - an em dash in Russian;
  - the length limit ignored.

  The first run caught 21 of 24: the pass-1 tests went through the whole run, where the hourly
  sweep cleans up anyway. They now test pass 1 alone.

## CPU (10 ms limit)

Measured on this PC, with the last commit and this one on the same data, three runs each
(`reports/data/step-14/cpu.txt`):
- One digest, 40 candidates: before 0.25 to 0.28 ms, after 0.24 to 0.27 ms (English and Russian).
- One cron tick with 8 due readers: before 4.4 to 5.2 ms, after 4.3 to 5.0 ms.

There is no real change: the format is the same, and the keyword rule runs in the hourly job, not
the Worker.

## Risks

- **Keywords can miss real stories.** They come from the AI once and are never refreshed. A new
  leader or a region not in the list means a real story drops off the topic (4 weak Australian
  stories in 24 h). Fix by hand: set the topic's `keywords` to NULL and the next run asks again. An
  Admin editor for keywords would be the next step if this happens often.
- **The editor's scores are noisy.** The rule removes the off-topic stories, but how many real
  stories pass still swings from run to run (Japan 2 to 8 a day after the fix).
- **Google 429s** stopped one of Colombia's two searches in both replays (as in Step 13).

## Files

- New:
  - `tests/test_keywords.py`, `worker/test/keywords.test.mjs`, `tests/fixtures/keyword_cases.json`;
  - `scripts/make_keyword_cases.py`, `scripts/step14_keywords.py`, `scripts/step14_replay.py`,
    `scripts/step14_mutations.py`;
  - `worker/scripts/step14-designs.mjs` (both preview rounds), `worker/scripts/step14-cpu.mjs`;
  - `reports/data/step-14/`.
- Changed:
  - code: `job/custom.py`, `job/editor.py`, `job/run.py`, `worker/src/custom.js`,
    `worker/src/cron.js`, `worker/src/digest.js`;
  - prompts and config: `prompts/editor.md`, `config/glossary.yaml`, `config/i18n/*.json`;
  - database: `db/schema.sql` (`custom_topics.keywords`), `scripts/apply_schema.py`;
  - tests: `tests/test_custom.py`, Worker tests;
  - scripts and docs: `worker/scripts/{digest-cli,step11-designs}.mjs`, `docs/ARCHITECTURE.md`,
    `PROJECT_NOTES.md`.
- D1: one new column, applied live (additive). Japan and Australia have their keywords. The live
  stories themselves are fixed by the first hourly run with this code.
