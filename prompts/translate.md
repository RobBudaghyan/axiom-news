# Translation prompt (Step 9: reader languages)

The third AI step of the hourly run (`job/translate.py`), after the editor. It translates the
headline and description of every story that could reach a digest into each language that an
active user reads (`config/languages.json`), one call per language per run. The job checks every
answer in code (same numbers, glossary names, the right script, no dashes) and redoes a rejected
story next hour, with the reason as a note.

The job fills the `{placeholders}`: `{language}` (English name), `{style}` (that language's
line from "Language notes"), `{names}` (glossary entries whose English name is in this batch,
from `config/glossary.yaml`) and `{stories}` (a JSON list).

---

## Prompt template

```text
You translate a short, serious news digest from English into {language}. Its readers mostly
live in Armenia. Translate each story below: its headline and its description.

Rules:
1. Translate faithfully, like a professional news translator. Add nothing, leave nothing out,
   no comments, no explanations. Keep the tone neutral and the sentences short.
2. Numbers: keep every number from the English as digits, the same number (dates, years,
   amounts, percentages, counts, ages). Use the normal number style of {language} (for example
   3 500 or 3,5 where that is usual), but never write a number as a word, never turn a word into
   a number, never round and never add a number that is not in the English.
3. Names: use exactly the forms in NAMES below (decline them as the grammar needs). For other
   people, places and organisations use the spelling that quality media in {language} use.
   Common abbreviations take their usual form in {language} (NATO, EU, UN and so on).
4. Spelling: write correct, natural {language} with its full alphabet: every accent, every
   apostrophe, every letter the language needs. Keep the hyphen in every word that has one
   (compound words, names, 24-hour and the like).
5. Long dashes only: never use an em dash or an en dash between words. Use a colon, a comma or
   a new sentence instead. (This rule is about long dashes only; hyphens inside words stay.)
6. Grammar: check case, gender and number agreement, especially after numbers and in
   declined names.
7. The headline is one sentence with no full stop at the end, written the way headlines are
   written in {language}. The description keeps the same sentences as the English.
8. A story with "retry_note" was translated before and rejected by a check: read the note and
   fix exactly that.
{style}

NAMES:
{names}

STORIES (JSON):
{stories}

Answer with JSON only, one item for every story, with the same ids:
{"items": [{"id": "S12", "headline": "...", "description": "..."}]}
If a story has an empty description, give an empty description.
```

## Language notes

```json
{
  "ru": "Russian: standard press style (like RBC or Kommersant). The English word digest is always сводка (never дайджест). Headlines in the past tense for events that happened (Бахрейн перехватил, not перехватывает), as Russian news sites write them. In Russian typography a dash between subject and predicate is common: never use it, rephrase or use a colon. Quotation marks: «». Ukrainian place names in their usual Russian press form (Киев, Харьков, Запорожье). Ukraine always takes на, never в: на Украине, на Украину, с Украины (never в Украине, в Украину); the war is война на Украине. Armenia's Prime Minister is премьер-министр.",
  "hy": "Eastern Armenian, reformed (Soviet-era) orthography as used in Armenia today, standard press style (like Armenpress or Azatutyun): write և (never եւ), lower-case month names and adjectives (սեպտեմբեր, հայկական), only Armenian letters (no Latin, Greek or Cyrillic letter inside a word). Headlines in the past tense for events that happened, as Armenian news sites write them. End every sentence with the Armenian full stop ։ (never a colon). Write foreign names in Armenian letters as Armenian media do (Շարմազանով, not a new spelling). Quotation marks: «».",
  "fr": "French: standard press style (like Le Monde or AFP), with all accents (é, è, ê, à, ç, ô, î, ï) and apostrophes (l'ONU, d'Iran, qu'il). Use a no-break space before : ; ! ? and inside « ». Write Armenian names as French media do (Erevan, Pachinian)."
}
```

## Output schema

```json
{
  "type": "object",
  "properties": {
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {"type": "string"},
          "headline": {"type": "string"},
          "description": {"type": "string"}
        },
        "required": ["id", "headline", "description"]
      }
    }
  },
  "required": ["items"]
}
```
