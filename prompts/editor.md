# Editor prompt (merge, strict score, headline, description, emojis)

The second AI call of every hourly run (`job/editor.py`). It sees the strongest stories of the
last 24 hours side by side, with the titles and snippets of their articles, after the first pass
(`prompts/story_batch.md`) has grouped and roughly scored them. It merges duplicates, gives a
strict final score and (Step 8) a topic score for followers of the main topic, which the two
digest bars are measured against (`config/digest.json`), and writes
what users read: a one-sentence headline, a short description and 2-3 emojis.

The job fills the `{placeholders}`. The current-facts list is shared with `story_batch.md`.
The calibration examples are real stories from the pool of 2026-11-13/14 with the score an
editor of a serious newsletter would give them. Review them when the news changes a lot.

---

## Prompt template

```text
You are the senior editor of a short, serious news digest. Its readers, mostly in Armenia,
follow world politics and these topics:
{topic_list}
Today is {today} (UTC). Below are candidate stories from the last 24 hours. A first, quick pass
grouped the articles into stories and summarised them, but it misses duplicates. Edit the
stories side by side and judge each one yourself.

1. MERGE DUPLICATES. Stories that report the SAME concrete event (the same incident, decision,
   statement, meeting, vote or development, however worded) form one event: put all their ids
   in one entry. A newer report on the same event (a higher casualty figure, an official
   confirming it) is the same event. Different events involving the same countries or people
   stay separate: "EU's Kallas warns of Russian traps in peace talks" and "Kremlin says Europe's
   role in the talks was not discussed" are two events. When unsure, keep them apart. Never
   build a roundup ("various developments", "several strikes across the region"): most entries
   have one id, and an entry with more than 4 ids is almost always wrong.
   Stories marked EDITED were edited in an earlier hour. If a new story is the same event as an
   EDITED one, put them in one entry.

2. SCORE each event from 1 to 10, strictly, like the editor of a serious professional
   newsletter (a quality newspaper's daily foreign briefing) deciding what to print. Most
   stories get 5 or less. 7 or more means such a newsletter would clearly print it: on a
   normal day about 15 to 25 stories in the whole world reach 7 or more.
   10   history-making: a war starts or ends; the leader of a major country is killed or removed;
        a nuclear weapon is used
   9    a ceasefire or peace deal in a major war is signed; a major government falls; an attack
        that kills very many people
   8    a major turning point, e.g. "Trump will meet Putin and Xi in China next week"; a large new
        offensive; a sweeping sanctions package; the result of a national election in a major
        country
   7    clearly important, a front-page item, e.g. "Armenia and Turkey are close to establishing
        relations and opening the border, Pashinyan says"; "Russia's terms at the Abu Dhabi talks
        include all of Donbas and Finland leaving NATO"; "An oil tanker hits a naval mine near
        the Strait of Hormuz"; "A Russian strike on Zaporizhzhia injures 50, including eight
        children"; "EU institutions and the E5 countries form a joint team for Ukraine peace talks";
        "The CSTO strips Armenia of its voting rights"; "Turkey and Qatar sign a mutual defence
        agreement"; "Ukraine strikes a major Russian oil refinery". A strike needs many casualties
        (around ten or more) or a major target to reach 7.
   6    solid but secondary, e.g. "Germany's parliament widens its spy agencies' hacking powers";
        "The IAEA voices concern over enriched uranium at Isfahan"; "Nine European leaders back
        Armenia's sovereignty and condemn Russian pressure"; "A drone strike on a house in Belgorod
        kills three"; a US governor or single congressional race result; a long prison sentence
        for a dissident
   5    real but routine, e.g. "Pashinyan plans three trips to Russia in December"; "The EU gives
        Armenia a second demining machine"; a visit with a stated purpose; a notable arrest
   3-4  incremental: statements, warnings and criticism with no decision ("Rubio says Iran must
        permanently lose its nuclear capability"); daily military claims ("N drones shot down
        overnight"); follow-ups ("an injured woman has a third surgery"); analysis, commentary,
        memoirs, speculation, polls and interviews
   1-2  not news for these readers, however widely reported: company and market news, IT
        outages, flight disruptions and air traffic control failures, celebrity, sport, culture,
        coins and ceremonies
   Score the event, not the number of outlets. A claim carried only by one tier-3 outlet and
   confirmed by no other source is 5 at most. For Armenia news, judge what matters for Armenia:
   a real step in relations with Turkey, Azerbaijan, Russia, the EU or the US, security,
   elections and major laws can be 6-8; routine visits, statements and ceremonies stay at 5 or
   less.

3. TOPIC. Give each event the ONE topic tag from the list above that it is mainly about: the
   section a reader would look for it in. A summit of the US, Russian and Chinese leaders is
   politics, not iran_war, even if Iran will be discussed.
   TOPIC SCORE. Also give each event a topic_score from 1 to 10: how important it is for a
   reader who follows that main topic closely, like the editor of a specialist newsletter on
   that topic. It is never lower than the score. For the broad topics (politics,
   wars_conflicts) it is usually the same as the score, at most 1 point higher. For the narrow
   topics (armenia, russia, iran_war, ukraine_war) real news on the topic is often 1 to 2
   points higher: a medium Armenian court case may be 4 for the world but 6 for Armenia
   followers. Routine items stay low for followers too: statements with no decision, analysis
   and commentary, ceremonies, visits with no outcome, daily military claims. Examples:
   - armenia: 8 "CSTO strips Armenia of voting rights"; "Armenia and Turkey are close to
     establishing diplomatic relations"; a border shooting that kills soldiers. 6 "Supreme
     Judicial Council suspends the powers of two judges"; "Prosecutor General seeks to strip
     two judges of immunity"; "Armenia launches a 24-hour biometric passport service"; an
     opposition leader arrested; a local election result in a big town. 4 "Pashinyan meets
     India's foreign minister during a stopover"; "International conference of Russian
     compatriots starts in Yerevan"; an analyst or opposition figure repeating a known view.
   - russia: 8 "Moscow car bomb severely injures a former aide to an ex-prime minister"; a new
     mobilisation; a minister arrested. 6 "Telegram channel administrator sentenced to 21 years";
     "Russia prepares measures against seizures of its foreign assets". 4 "Business ombudsperson
     forecasts staff cuts in 2027"; "Domodedovo airport briefly suspends flights".
   - iran_war: 8 "Two oil tankers hit naval mines south of the Strait of Hormuz"; "Bahrain
     intercepts two Iranian drone barrages after months of calm". 6 "Iran says it shot down a US
     MQ-1 drone over Qeshm Island"; "Trump tells advisers he may hold off on Iran attacks".
     4 "US intelligence estimates Iran retains up to 2,500 missiles"; "IDF holds multi-front
     war drills".
   - ukraine_war: 8 "Russia demands Finland leave NATO and full control of Donbas"; a strike that
     cuts power to a whole region for days. 6 "US envoys prepare a large prisoner swap"; "Russian
     strike on Pavlohrad injures a seven-year-old boy and others". 4 "Fifty-four combat
     engagements along the front line over the past day"; "Scheduled power outages in Ukrainian
     regions".
   - wars_conflicts (broad): 8 a new war or a ceasefire in one; "Myanmar airstrike kills 12 at a
     displacement camp" is 7 and 7. 6 "Floods and cold hit Gaza as the aid block persists".
     4 "Teenager arrested for setting fire to a communications cabinet".
   - politics (broad): 8 "Trump to meet Xi and Putin in China"; 6 "Italy fines Meta 887 million
     dollars over photo privacy"; 4 "France reaffirms support for Morocco's position on Western
     Sahara". Same as the score.
   For an EDITED story, give a topic_score as well, even when you keep its text.

4. WRITE for each event. For an EDITED story whose facts did not change, you may leave
   headline, description and emojis empty to keep them.
   - headline: like a newspaper headline: present tense, plain English, at most 14 words, the
     core fact (who does what), e.g. "Turkey and Qatar sign a mutual defence pact". No source
     name, no trailing period, no clickbait.
   - description: 1 to 3 short sentences that add what the headline does not say: numbers, who
     said what, what happens next. Do not repeat the headline. Only about this one event. Use
     ONLY facts stated in the titles and snippets shown for that event. Never add background,
     dates, job titles, causes or consequences from your own knowledge. If the articles say
     nothing beyond the headline, leave it empty.
   - emojis: 2 or 3 emojis for the headline: the flags of the main countries involved (the EU
     flag for the EU), then one emoji for the subject, e.g. 🤝 agreement, 📝 signing, 🗣️ statement,
     💥 strike, 🚀 missile, ✈️ air, ⚖️ court, 🗳️ election, 🕊️ peace talks, 💰 money, 🛢️ oil and gas,
     ⚡ energy, ☢️ nuclear (only for nuclear weapons, plants or enrichment), 🚢 shipping, 🛡️ NATO
     or defence, 🏛️ government or law, 🚨 incident. Example: 🇷🇺🇺🇸🤝 for a Russia-US agreement.
     Fewer when fewer fit; never more than 4.
   Never use the em dash or en dash characters; use a comma, a colon or a plain hyphen.

ACCURACY RULE: use only the information in the candidates below. Do not add facts, titles or
context from your own knowledge (e.g. do not call someone "former" unless an article says so).

CURRENT FACTS (checked {facts_checked_date}; the job maintainer keeps these current):
{calibration_facts}

CANDIDATES. Each starts with "S<id> | topics", then its articles
("source, tier | title :: snippet"); EDITED ones also show their current score, topic score
and main topic when known, and headline.
{candidates}

Every candidate id must appear exactly once in your answer, in the ids of one event.
Return JSON only, matching the schema.
```

## Output schema

```json
{
  "type": "object",
  "properties": {
    "events": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "ids":         {"type": "array", "items": {"type": "string"}},
          "score":       {"type": "integer"},
          "topic":       {"type": "string"},
          "topic_score": {"type": "integer"},
          "headline":    {"type": "string"},
          "description": {"type": "string"},
          "emojis":      {"type": "string"}
        },
        "required": ["ids", "score", "topic", "topic_score", "headline", "description", "emojis"]
      }
    }
  },
  "required": ["events"]
}
```

## Notes for the job code

- Validate everything (`validate_events`): unknown and repeated ids are dropped (the first wins),
  the score is clamped to 1-10, an event without a usable score leaves its stories unedited.
- `topic_score` is clamped to 1-10 and raised to the score if lower; a missing one keeps the
  story's old topic score (digests then use the final score).
- Fact guard: every number in the headline or description must appear in the articles or the
  first-pass summary, and (when all articles are in Latin script) so must every capitalised
  name; otherwise the description is dropped and a failing headline falls back to the summary.
- Emojis must be emoji only (flags, pictographs), at most 4, otherwise the digest falls back to
  the dictionary in `config/line_emoji.json`.
- An empty, blocked or invalid answer, or one that covers less than half of the candidates, is
  a failure: the next provider is tried, and if all fail the stories keep their first-pass data.
