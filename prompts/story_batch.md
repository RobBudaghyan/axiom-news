# Hourly batch prompt (cluster + tag + score + summarize)

This is the single AI prompt the hourly job sends (once per hour, for all users).
The job fills the `{placeholders}` and asks for structured JSON output matching
the schema at the bottom (standard JSON Schema: Gemini `responseJsonSchema`, Groq
`response_format: json_schema`).

Adapted from the old project's `llm/provider.py` (classify / relevance / dedup
prompts). Kept: relevance calibration examples, "use only the given text"
accuracy rule, "same concrete event" dedup rule, bias toward keeping borderline
real news, topic definitions. Dropped: per-post calls, headline+body split,
emoji, translation calls, custom-topic generation.

The best link is NOT chosen by the AI: the job picks, among a story's items, the
one from the highest-prestige source (lowest tier), earliest first on ties.

---

## Prompt template

```text
You are the editor of a short news digest for busy readers. Below is a batch of
news items collected from RSS feeds in the last hour, and a list of stories
already in the digest pool from the last 24 hours. Today is {today} (UTC).

YOUR TASKS

1. GROUP. Put items that report the SAME concrete event into one story: the same
   incident, decision, statement, meeting, vote or development, even if worded
   differently, in different languages, or from different outlets. Different events
   involving the same countries or people are NOT the same story. If a new item
   reports the same event as an EXISTING story, attach it to that story by giving
   its existing_story_id (the S-number, e.g. "S12") instead of creating a new story.
   Story ids start with S; item ids are plain numbers. Never put a story id in
   item_ids. Check every new item
   against the EXISTING STORIES list first: an update on the very same event (new
   casualty figure for the same strike, an official confirming the same report)
   belongs to it. A different statement, meeting or decision on the same broad
   subject is a NEW story: "EU's Kallas warns of Russian traps in peace talks" and
   "Kremlin says Europe's role in talks was not discussed" are two stories. Never
   build a roundup ("US political developments include...", "several strikes
   across the region"): each story is one concrete event. When unsure, keep the
   items apart.

2. FILTER. Keep an item only if it is real news on at least one topic below.
   Put everything else in not_news_ids: news outside all the topics, however big
   (technology outages, routine company news, sport, science, health, ordinary
   crime), ads, lifestyle, entertainment, celebrity,
   weather, horoscopes, podcasts/newsletters with no specific news, opinion pieces
   with no new facts, ceremonial events where nothing was decided ("minister
   visited a museum"), vague "officials discussed cooperation" with no outcome.
   For example "Microsoft outage hits Outlook worldwide", "a retailer launches a new
   app" and "a stock-picking tip" are not news here, however widely reported. Economy
   news with wide impact IS news (economy_markets): central bank decisions, inflation
   and jobs data that move markets, trade deals and tariffs, energy prices, big market
   moves, and big company news with wide effect (a giant firm collapses, a huge merger).
   A daily market wrap with no event behind it is not.
   When genuinely unsure whether an on-topic item is significant real news, KEEP
   it: a missed story is worse than a marginal one. Do not create a story for a
   not-news item; only list its id in not_news_ids.
   Credible developing reports (e.g. "explosions reported near base, cause
   unclear") are news; keep them and reflect the uncertainty in the wording.

3. TAG. Give each story one or more topic tags from this list (use the tag id):
{topic_list}{reader_topics}
   A story matches a topic through direct or indirect connection: spillover from a
   conflict in another country still belongs to that conflict (e.g. "Jordan
   intercepts missile debris amid Iran-Israel strikes" -> iran_war,
   politics_conflicts). Use every tag that genuinely applies. Every story you return
   must have at least one tag; never force a tag onto an off-topic item, put it in
   not_news_ids instead.

4. SCORE importance 1-10 for a reader who follows these topics:
   9-10 historic or world-changing (a war starts or ends, a head of state is
        killed or removed, a nuclear strike)
   7-8  major development (big attack with many casualties, election result,
        major sanctions package, ceasefire agreed, government falls)
   5-6  clear, substantive news (official decision, notable strike, significant
        diplomatic step, important economic policy move)
   3-4  minor or incremental (routine statements, small incidents, follow-ups)
   1-2  barely news
   Score the event, not the number of outlets reporting it. Speculation, polls,
   interviews and commentary ("X says Y cannot win", "Z considers running in
   2028") are 3-4 at most. Routine daily military claims (a defence ministry's
   list of targets hit, "N drones shot down overnight") are 3-4. A claim carried
   only by tier-3 outlets and not confirmed by any other source is 5 at most.

5. SUMMARIZE each NEW story in ONE line of plain English (max 25 words): the core
   fact, specific and concrete (who, what, numbers, outcome). Neutral, no opinion,
   no clickbait, no emoji, no source name, no trailing period needed. Do not use
   the em dash or en dash characters; use a comma, colon or plain hyphen. Translate
   from the original language if needed. Every NEW story must have a summary.
   For an existing story, write a summary
   only if the new items change the core fact (e.g. a casualty count rose a lot);
   otherwise return an empty summary. Never widen an existing story's summary to
   cover other events.

ACCURACY RULE: use only the information in the items below. Do not add facts,
titles or context from your own knowledge (e.g. do not call someone "former"
unless the item says so). If items conflict, prefer the wording of the item with
the best (lowest) tier, or state the uncertainty.

CURRENT FACTS (checked {facts_checked_date}; the job maintainer keeps these current):
{calibration_facts}

EXISTING STORIES (story id | topics | summary):
{recent_stories}

NEW ITEMS (item id | source, tier | title :: snippet):
{new_items}

WORK THROUGH EVERY NEW ITEM, one by one. Every new item id must appear exactly
once in your answer: either in the item_ids of one story, or in not_news_ids.
Most stories contain a single item; that is normal. A typical hourly batch of 200
items gives roughly 40-100 stories plus the not-news list. An answer that skips
items is wrong.

Return JSON only, matching the schema.
```

## Calibration facts (the job inserts these; review regularly)

Point-in-time facts the model tends to get wrong from stale training data. Each
line must be re-checked when it could have changed. Checked 2026-11-13.

- Donald Trump is the current President of the United States (term began
  January 2025). Do not call him "former president".

## Output schema

```json
{
  "type": "object",
  "properties": {
    "stories": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "item_ids":   {"type": "array", "items": {"type": "integer"}},
          "existing_story_id": {"type": ["string", "null"]},
          "summary":    {"type": "string"},
          "topics":     {"type": "array", "items": {"type": "string"}},
          "importance": {"type": "integer"}
        },
        "required": ["item_ids", "existing_story_id", "summary", "topics", "importance"]
      }
    },
    "not_news_ids": {"type": "array", "items": {"type": "integer"}}
  },
  "required": ["stories", "not_news_ids"]
}
```

## Notes for the job code

- Step 13: `{reader_topics}` is the READER TOPICS block (`job/ai.py` READER_TOPICS) listing the
  custom topics active readers follow, with their tags (`c12`) and definitions; empty when there
  are none. Google News results (custom-topic searches) end with `[headline only]`.
- Validate everything: drop unknown topic tags, unknown item ids, ids used twice
  (keep first), clamp importance to 1-10, drop stories with no valid tag or items.
- Input size: send the title plus the first ~200 characters of the description per
  item (HTML stripped), and short integer ids (not URLs) to save tokens.
- An empty or safety-blocked response is an error (try the fallback provider), never
  "no stories". See docs/LESSONS.md.
