# Hourly batch prompt (cluster + tag + score + summarize)

This is the single AI prompt the hourly job sends (once per hour, for all users).
The job fills the `{placeholders}` and asks for structured JSON output matching
the schema at the bottom (Gemini `response_schema`; for the fallback provider,
its JSON mode with the same schema in the prompt).

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
already in the digest pool from the last 36 hours. Today is {today} (UTC).

YOUR TASKS

1. GROUP. Put items that report the SAME concrete event into one story: the same
   incident, decision, statement, meeting, vote or development, even if worded
   differently, in different languages, or from different outlets. Different events
   involving the same countries or people are NOT the same story. If a new item
   reports the same event as an EXISTING story, attach it to that story by giving
   its existing_story_id instead of creating a new story.

2. FILTER. Leave out items that are not real news on any topic below: ads,
   lifestyle, sport, entertainment, celebrity, weather, horoscopes, podcasts/
   newsletters with no specific news, opinion pieces with no new facts, ceremonial
   events where nothing was decided ("minister visited a museum"), vague "officials
   discussed cooperation" with no outcome. When genuinely unsure whether something
   is significant real news, KEEP it: a missed story is worse than a marginal one.
   Credible developing reports (e.g. "explosions reported near base, cause
   unclear") are news; keep them and reflect the uncertainty in the wording.

3. TAG. Give each story one or more topic tags from this list (use the tag id):
{topic_list}
   A story matches a topic through direct or indirect connection: spillover from a
   conflict in another country still belongs to that conflict (e.g. "Jordan
   intercepts missile debris amid Iran-Israel strikes" -> iran_war,
   wars_conflicts). Use every tag that genuinely applies. Every story you return
   must have at least one tag.

4. SCORE importance 1-10 for a reader who follows these topics:
   9-10 historic or world-changing (a war starts or ends, a head of state is
        killed or removed, a nuclear strike)
   7-8  major development (big attack with many casualties, election result,
        major sanctions package, ceasefire agreed, government falls)
   5-6  clear, substantive news (official decision, notable strike, significant
        diplomatic step, important economic policy move)
   3-4  minor or incremental (routine statements, small incidents, follow-ups)
   1-2  barely news
   Score the event, not the number of outlets reporting it.

5. SUMMARIZE each NEW story in ONE line of plain English (max 25 words): the core
   fact, specific and concrete (who, what, numbers, outcome). Neutral, no opinion,
   no clickbait, no emoji, no source name, no trailing period needed. Translate
   from the original language if needed. For an existing story, write a summary
   only if the new items change the core fact (e.g. a casualty count rose a lot);
   otherwise return an empty summary.

ACCURACY RULE: use only the information in the items below. Do not add facts,
titles or context from your own knowledge (e.g. do not call someone "former"
unless the item says so). If items conflict, prefer the wording of the item with
the best (lowest) tier, or state the uncertainty.

CURRENT FACTS (checked {facts_checked_date}; the job maintainer keeps these current):
{calibration_facts}

EXISTING STORIES (id | topics | summary):
{recent_stories}

NEW ITEMS (id | source, tier | title — snippet):
{new_items}

Return JSON only, matching the schema. Every item id may appear in at most one
story. Items you leave out are treated as not news.
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
          "existing_story_id": {"type": "integer", "nullable": true},
          "item_ids":   {"type": "array", "items": {"type": "integer"}},
          "topics":     {"type": "array", "items": {"type": "string"}},
          "importance": {"type": "integer"},
          "summary":    {"type": "string"}
        },
        "required": ["item_ids", "topics", "importance", "summary"]
      }
    }
  },
  "required": ["stories"]
}
```

## Notes for the job code

- Validate everything: drop unknown topic tags, unknown item ids, ids used twice
  (keep first), clamp importance to 1-10, drop stories with no valid tag or items.
- Input size: send the title plus the first ~200 characters of the description per
  item (HTML stripped), and short integer ids (not URLs) to save tokens.
- An empty or safety-blocked response is an error (try the fallback provider), never
  "no stories". See docs/LESSONS.md.
