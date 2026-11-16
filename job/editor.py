"""Editor pass (Step 5): the second AI call of every hourly run.

The first pass (job/run.py) groups articles into stories and scores them quickly, but its scores
are generous (in 24 h, 364 of 424 politics stories scored 4 or more) and word-based duplicate
grouping (job/dupes.py) misses about 30% of duplicates. The editor sees the strongest stories of
the last 24 hours side by side, with the titles and snippets of their articles, and:
- merges stories about the same concrete event (the oldest story is kept, the others get
  `merged_into`; users who got one of them never get the kept one either);
- gives a strict `final_score` 1-10 (global importance) and, Step 8, a `topic_score` 1-10 (importance
  for readers who follow the story's main topic, never below the final score); digests measure
  them against the two bars in config/digest.json;
- writes the `headline`, a 1-3 sentence `description` (only facts from the given articles, checked
  by a fact guard here) and 2-4 `emojis`.

Same provider chain as the first pass. If every provider fails, the stories keep their first-pass
data and digests still work from it (worker/src/digest.js). Prompt: prompts/editor.md.

    venv/Scripts/python -m job.editor --backfill     edit the last 24 h pool once (a few calls)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from job import ai
from job.config import ROOT, Settings
from job.d1 import in_list_statements

EDITOR_PROMPT = ROOT / "prompts" / "editor.md"
DAY = 86400
MIN_COVERED_SHARE = 0.5     # an answer that mentions fewer candidates than this is a failed answer
MAX_HEADLINE = 200
MAX_DESCRIPTION = 420
MAX_EMOJIS = 4
MAX_EVENT_STORIES = 6       # more stories in one event is a roundup, not one event

POOL_SQL = ("SELECT id, summary, topics, importance, best_url, best_source, best_tier, best_published_at, "
            "source_count, created_at, updated_at, headline, description, emojis, final_score, edited_at, main_topic, "
            "topic_score, scored_at "
            "FROM stories WHERE updated_at >= ? AND merged_into IS NULL AND importance >= ? "
            "ORDER BY importance DESC, updated_at DESC, id DESC")
ITEMS_SQL = ("SELECT story_id, source_name, tier, title, snippet, published_at, headline_only FROM items "
             "WHERE story_id IN ({qs})")


@dataclass
class EditorPrompt:
    template: str
    schema: dict


def load_editor_prompt(path: Path = EDITOR_PROMPT) -> EditorPrompt:
    text = path.read_text(encoding="utf-8")
    template = re.search(r"## Prompt template\s+```text\r?\n(.*?)\r?\n```", text, re.S).group(1)
    schema = json.loads(re.search(r"## Output schema\s+```json\r?\n(.*?)\r?\n```", text, re.S).group(1))
    return EditorPrompt(template.replace("\r\n", "\n"), schema)


def tags(story: dict) -> list[str]:
    t = story["topics"]
    return json.loads(t) if isinstance(t, str) else list(t)


# ---------------------------------------------------------------- candidates

def choose(pool: list[dict], topic_order: list[str], new_max: int, per_topic: int,
           compare_max: int) -> tuple[list[dict], list[dict]]:
    """pool: stories in first-pass rank order. Returns (new, compare):
    new = not-yet-edited stories, the best `per_topic` of every topic first (so a small topic
    like Armenia is always represented), then the strongest overall, up to `new_max`;
    compare = the highest-scored already-edited stories, so the editor can merge a new story
    into an existing one and keep its scores consistent. Nothing new: nothing to do."""
    fresh = [s for s in pool if s.get("edited_at") is None]
    chosen: list[dict] = []
    seen: set[int] = set()

    def take(s: dict) -> None:
        if s["id"] not in seen and len(chosen) < new_max:
            seen.add(s["id"])
            chosen.append(s)

    for tag in topic_order:
        for s in [s for s in fresh if tag in tags(s)][:per_topic]:
            take(s)
    for s in fresh:
        take(s)
    if not chosen:
        return [], []
    chosen.sort(key=lambda s: (-s["importance"], -s["updated_at"], -s["id"]))
    edited = [s for s in pool if s.get("edited_at") is not None]
    edited.sort(key=lambda s: (-(s.get("final_score") or 0), -s["updated_at"], -s["id"]))
    return chosen, edited[:compare_max]


def load_items(db, story_ids: list[int], per_story: int) -> dict[int, list[dict]]:
    """The best `per_story` articles of each story: lowest tier first, then earliest."""
    out: dict[int, list[dict]] = {}
    if not story_ids:
        return out
    for rows in db.batch(in_list_statements(ITEMS_SQL, story_ids)):
        for r in rows:
            out.setdefault(int(r["story_id"]), []).append(r)
    for sid, rows in out.items():
        rows.sort(key=lambda r: (r["tier"], r["published_at"] if r["published_at"] is not None else float("inf")))
        out[sid] = rows[:per_story]
    return out


def candidate_block(s: dict, items: list[dict], edited: bool) -> str:
    # The first-pass score is NOT shown: with it in the prompt, the editor mostly copied it
    # (measured in the backfill on 2026-11-14), which is the inflated number we want to replace.
    head = f"S{s['id']} | {','.join(tags(s))}"
    if edited:
        ts = f", topic score {s['topic_score']}" if s.get("topic_score") is not None else ""
        main = f", topic {s['main_topic']}" if s.get("main_topic") else ""
        head += f" | EDITED: score {s.get('final_score')}{ts}{main}, headline: {s.get('headline') or s['summary']}"
    lines = [head, f"  first-pass summary: {s['summary']}"]
    for it in items:
        snippet = f" :: {it['snippet']}" if it.get("snippet") else ""
        marker = " [headline only]" if it.get("headline_only") else ""   # Step 13: Google News result
        lines.append(f"  - {it['source_name']}, tier {it['tier']} | {it['title']}{snippet}{marker}")
    return "\n".join(lines)


# Step 13: readers' own topics (custom topics). Both blocks are empty when none is followed, so the
# prompt is then exactly what it was before.
READER_TOPICS = """
   and reader topics, which some readers added themselves (tag: name, what it covers):
{lines}
   An event about a reader topic may take its tag as its topic even when it is sport,
   technology, business or culture. Its score stays the score for a general reader."""
READER_BOOST = """
   - reader topics: +0 for routine news; for a notable development that the topic's followers
     would want to know, up to the cap: {caps}."""


def reader_blocks(custom: list[dict]) -> tuple[str, str]:
    if not custom:
        return "", ""
    lines = "\n".join(f"   - {t['tag']}: {t['label']['en']}, {' '.join(str(t.get('definition') or '').split())}"
                      for t in custom)
    caps = ", ".join(f"{t['tag']} +{int(t.get('boost_max') or 0)}" for t in custom)
    return READER_TOPICS.format(lines=lines), READER_BOOST.format(caps=caps)


def render_prompt(template: str, *, today: str, topics: list[dict], facts: list[str], facts_checked: str,
                  new: list[dict], compare: list[dict], items: dict[int, list[dict]]) -> str:
    main = [t for t in topics if not t.get("custom")]
    topic_list = "\n".join(f"   - {t['tag']}: {t['label']['en']}" for t in main)
    reader_topics, reader_boost = reader_blocks([t for t in topics if t.get("custom")])
    blocks = [candidate_block(s, items.get(s["id"], []), False) for s in new]
    blocks += [candidate_block(s, items.get(s["id"], []), True) for s in compare]
    values = {
        "{today}": today,
        "{topic_list}": topic_list,
        "{reader_topics}": reader_topics,
        "{reader_boost}": reader_boost,
        "{facts_checked_date}": facts_checked,
        "{calibration_facts}": "\n".join(f"- {f}" for f in facts),
        "{candidates}": "\n\n".join(blocks),
    }
    out = template
    for key, value in values.items():
        out = out.replace(key, value)
    return out


# ---------------------------------------------------------------- output validation

CONTROL = re.compile(r"[\x00-\x1f\x7f]")
NON_LATIN = re.compile(r"[Ͱ-῿؀-ۿ]")   # Greek, Cyrillic, Armenian, Hebrew, Arabic...
NUMBER = re.compile(r"\d+(?:[.,]\d+)*")
NAME = re.compile(r"[A-Z][A-Za-z'’.\-]*[A-Za-z]|[A-Z]")
WORDS = re.compile(r"[A-Za-z][A-Za-z'’]*")
# Capitalised words that are not facts about the event (titles, days, common aliases).
ALWAYS_OK = set("""
I US U.S UN EU UK NATO American Americans European Europeans Western President Prime Minister
Ministry Foreign Defence Defense Secretary Parliament Government State States United Department
Army Navy Air Force Forces Court Supreme Council Security Republic Federation National Office
General Affairs Committee Agency Union
Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June
July August September October November December
""".split())


def clean_text(text: str, limit: int) -> str:
    """One line, no em/en dash (owner rule), cut at a word to `limit` characters."""
    text = CONTROL.sub(" ", text or "")
    text = ai.DASH_SPACED.sub(", ", text)
    text = ai.DASH_ANY.sub("-", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s+([,.;:])", r"\1", text)
    if len(text) > limit:
        text = text[:limit].rsplit(" ", 1)[0].rstrip(",;:") + "..."
    return text


def clean_headline(text: str) -> str:
    return clean_text(text, MAX_HEADLINE).rstrip(". ").strip()


SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'])")


def clean_description(text: str) -> str:
    text = clean_text(text, 10_000)
    sentences = [s for s in SENTENCE_END.split(text) if s.strip()][:3]
    text = " ".join(sentences)
    if len(text) > MAX_DESCRIPTION:
        text = text[:MAX_DESCRIPTION].rsplit(" ", 1)[0].rstrip(",;:") + "..."
    if text and text[-1] not in ".!?":
        text += "."
    return text


def _numbers(text: str) -> set[str]:
    return {n.replace(",", "") for n in NUMBER.findall(text)}


def _stem(word: str) -> str:
    return re.sub(r"['’]s?$", "", word.lower())[:5]


# Ordinary words that often start a sentence. Any other capitalised first word is checked like a
# name (a headline usually starts with its actor, which must come from the articles). Other
# ordinary words pass anyway when the articles use them in lower case.
SENTENCE_OPENERS = set("""
A An The This That These Those It Its He She They We His Her Their Both All Some Many Most No One Two
Three Four Five Several Few Other Another Each Every After Before During Following Amid Despite Since
Until While When Where As At By For From In On Of Over Under With Without Meanwhile Separately
However Also Additionally Earlier Later Today Yesterday Tomorrow Overnight According Officials
Authorities Police Troops Forces Talks Strikes Protesters Voters Lawmakers Residents Analysts Critics
Experts Rescuers Prosecutors Investigators Leaders Ministers Delegations Sources Reports Satellite
More Even Further Then Now Here There Such Only Representatives Analyst Observers Commentators
Polls Polling Surveys Data Conditions Military Workers Witnesses Footage Images Video Documents
Diplomats Soldiers Civilians Families Negotiators Envoys
New Former Top Senior Local Regional Global International Western Eastern Northern Southern
""".split())

# Demonyms that do not start with the country's name (regular ones like Iranian/Iran, Russian/
# Russia pass by prefix): country (lower case) -> demonym prefix.
DEMONYMS = {"poland": "polish", "britain": "british", "london": "british", "finland": "finnish",
            "sweden": "swedish", "denmark": "danish", "turkey": "turkish", "türkiye": "turkish",
            "spain": "spanish", "netherlands": "dutch", "france": "french", "paris": "french",
            "greece": "greek", "switzerland": "swiss", "ireland": "irish", "dublin": "irish",
            "china": "chinese", "beijing": "chinese", "japan": "japanese", "lebanon": "lebanese",
            "afghanistan": "afghan", "emirates": "emirati", "kazakhstan": "kazakh", "uzbekistan": "uzbek",
            "philippines": "filipino", "thailand": "thai", "vietnam": "vietnamese", "portugal": "portuguese",
            "norway": "norwegian", "belgium": "belgian", "kremlin": "russian", "moscow": "russian",
            "kyiv": "ukrainian", "tehran": "iranian", "washington": "american", "berlin": "german",
            "yerevan": "armenian", "baku": "azerbaijani", "tbilisi": "georgian", "ankara": "turkish"}

CAP_RUN = re.compile(r"(?:[A-Z][A-Za-z'’]*[\s-]+(?:(?:of|and|the|for|on)\s+)?)*[A-Z][A-Za-z'’]*")
FILLER = {"of", "and", "the", "for", "on"}


def _initials(run: str) -> str:
    return "".join(w[0] for w in re.split(r"[\s-]+", run) if w and w not in FILLER).upper()


def _acronyms(text: str) -> set[str]:
    """Initials of every run of capitalised words, and of each tail of it:
    "the Asia-Pacific Economic Cooperation summit" gives APEC (and PEC, EC, C)."""
    out = set()
    for m in CAP_RUN.finditer(text):
        ini = _initials(m.group(0))
        out.update(ini[i:] for i in range(len(ini)))
        out.update(ini[:i] for i in range(2, len(ini) + 1))
    return out


def unknown_facts(text: str, source: str, check_names: bool) -> list[str]:
    """Numbers (and, for Latin-script sources, capitalised names) in `text` that the source text
    does not contain. Sentence-initial words are not checked as names (they are often ordinary
    words). An acronym matches the spelled-out name in the source and the other way round
    (APEC = Asia-Pacific Economic Cooperation). Keeps invented facts out of what users read."""
    bad = sorted(_numbers(text) - _numbers(source))
    if not check_names:
        return bad
    known = {_stem(w) for w in WORDS.findall(source)}
    known4 = {w.lower()[:4] for w in WORDS.findall(source) if len(w) >= 4}
    roots = {w.lower() for w in WORDS.findall(source) if w[0].isupper() and len(w) >= 4}
    roots |= {d for country, d in DEMONYMS.items() if country in roots}
    src_acronyms = {w for w in re.findall(r"\b[A-Z]{2,}\b", source.replace(".", ""))}
    spelled = _acronyms(source)
    # Text positions inside a run of capitalised words whose initials (of the whole run or any
    # part of it) are an acronym in the source: "The Federal Aviation Administration" when the
    # source says "F.A.A.".
    expanded_ok: set[int] = set()
    for m in CAP_RUN.finditer(text):
        words = [(w.start() + m.start(), w.group(0)) for w in re.finditer(r"[A-Za-z'’]+", m.group(0))]
        for i in range(len(words)):
            for j in range(i + 2, len(words) + 1):
                if _initials(" ".join(w for _, w in words[i:j])) in src_acronyms:
                    expanded_ok.update(range(words[i][0], words[j - 1][0] + len(words[j - 1][1])))
    names = list(NAME.finditer(text))
    for k, m in enumerate(names):
        before = text[:m.start()].rstrip()
        opener = not before or before[-1] in ".!?:\"'("
        if opener and (m.group(0) in SENTENCE_OPENERS or m.group(0).lower()[:4] in known4):
            continue      # an ordinary word starting a sentence ("Polls show...", "Workers voted...")
        if m.start() in expanded_ok:
            continue
        word = m.group(0)
        if re.fullmatch(r"[A-Z]{2,}s?", word) and word.rstrip("s") in spelled:
            continue
        # A first name in front of a known surname ("Recep Tayyip Erdogan", "Donald Trump").
        nxt = names[k + 1] if k + 1 < len(names) else None
        if nxt and text[m.end():nxt.start()] == " " and _stem(nxt.group(0)) in known:
            continue
        prv = names[k - 1] if k else None     # a given name after a known family name ("Xi Jinping")
        if prv and text[prv.end():m.start()] == " " and _stem(prv.group(0)) in known:
            continue
        for part in re.split(r"[-.]", word):
            if len(part) <= 1 or part in ALWAYS_OK or not part[0].isupper():
                continue          # "AI-generated": only capitalised parts can be names
            low = part.lower()
            # a demonym of a name in the source: "Iranian" for "Iran", "Azerbaijani" for "Azerbaijan"
            if _stem(part) not in known and not any(low.startswith(w) for w in roots):
                bad.append(part)
    return bad


def _pictograph(c: int) -> bool:
    return (0x1F000 <= c <= 0x1FAFF or 0x2600 <= c <= 0x27BF or 0x2300 <= c <= 0x23FF
            or 0x2B00 <= c <= 0x2BFF or 0x2190 <= c <= 0x21FF or 0x25A0 <= c <= 0x25FF
            or c in (0x00A9, 0x00AE, 0x203C, 0x2049, 0x2122, 0x2139, 0x24C2, 0x2934, 0x2935,
                     0x3030, 0x303D, 0x3297, 0x3299))


def _modifier(c: int) -> bool:
    return c in (0xFE0F, 0x20E3) or 0x1F3FB <= c <= 0x1F3FF or 0xE0020 <= c <= 0xE007F


def emoji_units(text: str) -> list[str] | None:
    """Split into emoji (a flag pair, or a pictograph with its modifiers and ZWJ parts).
    None if anything that is not an emoji is in the text."""
    s = re.sub(r"\s+", "", text or "")
    units, i = [], 0
    while i < len(s):
        c = ord(s[i])
        if 0x1F1E6 <= c <= 0x1F1FF:
            if i + 1 < len(s) and 0x1F1E6 <= ord(s[i + 1]) <= 0x1F1FF:
                units.append(s[i:i + 2])
                i += 2
                continue
            return None
        if not _pictograph(c):
            return None
        j = i + 1
        while j < len(s):
            d = ord(s[j])
            if _modifier(d):
                j += 1
            elif d == 0x200D and j + 1 < len(s) and _pictograph(ord(s[j + 1])):
                j += 2
            else:
                break
        units.append(s[i:j])
        i = j
    return units


def clean_emojis(text: str) -> str:
    units = emoji_units(text)
    return "".join(units[:MAX_EMOJIS]) if units else ""


@dataclass
class Event:
    ids: list[int]
    score: int
    rewrite: bool                 # False: keep an edited story's current text
    headline: str | None
    description: str | None
    emojis: str | None
    topic: str | None = None      # the one topic it is mainly about (its digest section)
    topic_score: int | None = None   # Step 8: for followers of that topic; always >= score
    topic_raw: int | None = None     # the answer's own topic score (clamped to 1-10 only)
    dropped: list[str] = field(default_factory=list)   # fact-guard notes


def parse_answer(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    data = json.loads(text)
    if not isinstance(data, dict) or not isinstance(data.get("events"), list):
        raise ValueError("JSON has no 'events' list")
    return data


def _ids(raw, known: set[int], used: set[int]) -> list[int]:
    out = []
    for v in raw if isinstance(raw, list) else []:
        m = re.fullmatch(r"\s*[Ss]?(\d+)\s*", str(v))
        if m and int(m.group(1)) in known and int(m.group(1)) not in used and int(m.group(1)) not in out:
            out.append(int(m.group(1)))
    return out


def source_text(stories: list[dict], items: dict[int, list[dict]]) -> tuple[str, bool]:
    """All text the editor was given for these stories; and whether every title is Latin script."""
    parts, latin = [], True
    for s in stories:
        parts.append(s["summary"])
        if s.get("headline"):
            parts.append(s["headline"])
        if s.get("description"):
            parts.append(s["description"])
        for it in items.get(s["id"], []):
            parts += [it["title"], it.get("snippet") or ""]
            if NON_LATIN.search(it["title"]):
                latin = False
    return "\n".join(parts), latin


def validate_events(data: dict, by_id: dict[int, dict], items: dict[int, list[dict]],
                    topic_order: list[str] | None = None) -> tuple[list[Event], list[int]]:
    """Check one answer. Returns (events, candidate ids the answer left out). Unknown or repeated
    ids are dropped (the first use wins); an event without a usable score is ignored, so its
    stories stay unedited. Text is cleaned and fact-checked against the articles."""
    used: set[int] = set()
    events = []
    for raw in data["events"]:
        if not isinstance(raw, dict):
            continue
        ids = _ids(raw.get("ids"), set(by_id), used)
        if not ids or len(ids) > MAX_EVENT_STORIES:
            continue      # a "roundup" of unrelated stories (seen once: 44 in one event): ignored
        used.update(ids)
        try:
            score = min(10, max(1, int(round(float(raw.get("score"))))))
        except (TypeError, ValueError):
            continue
        topic_raw = None
        try:
            topic_raw = min(10, max(1, int(round(float(raw.get("topic_score"))))))
        except (TypeError, ValueError):
            pass          # missing: the story keeps its old topic score, or digests use the final score
        group = [by_id[i] for i in ids]
        leader = min(group, key=lambda s: (s["created_at"], s["id"]))
        raw_head = str(raw.get("headline") or "").strip()
        rewrite = bool(raw_head) or leader.get("edited_at") is None
        ev = Event(ids, score, rewrite, None, None, None,
                   topic_score=None if topic_raw is None else max(score, topic_raw), topic_raw=topic_raw)
        topic = str(raw.get("topic") or "").strip()
        ev.topic = topic if topic_order and topic in topic_order else None
        if rewrite:
            src, latin = source_text(group, items)
            head = clean_headline(raw_head)
            desc = clean_description(str(raw.get("description") or ""))
            bad = unknown_facts(head, src, latin)
            if bad:
                ev.dropped.append(f"headline S{leader['id']}: {', '.join(bad)}")
                head = ""
            bad = unknown_facts(desc, src, latin)
            if bad:
                ev.dropped.append(f"description S{leader['id']}: {', '.join(bad)}")
                desc = ""
            ev.headline = head or None
            ev.description = desc or None
            ev.emojis = clean_emojis(str(raw.get("emojis") or "")) or None
        events.append(ev)
    return events, [i for i in by_id if i not in used]


# ---------------------------------------------------------------- writes

def write_statements(events: list[Event], by_id: dict[int, dict], topic_order: list[str],
                     now: int) -> tuple[list, int]:
    """D1 statements for the validated events; returns (statements, stories merged away).
    The oldest story of a group is kept (the one most likely already sent). Users who received
    a merged-away story get a `sent` row for the kept one, so they never get the event twice."""
    stmts, merged = [], 0
    for ev in events:
        group = [by_id[i] for i in ev.ids]
        leader = min(group, key=lambda s: (s["created_at"], s["id"]))
        kids = [s for s in group if s is not leader]
        tagset = {t for s in group for t in tags(s)} | ({ev.topic} if ev.topic else set())
        main = ev.topic or leader.get("main_topic")
        best = min(group, key=lambda s: (s["best_tier"], s["best_published_at"] if s["best_published_at"]
                                         is not None else float("inf"), s["id"]))
        # Field by field: a new valid value wins, otherwise the story keeps what it had. Seen on
        # 2026-11-14: the editor repeated an edited story's headline but left its emojis and
        # description empty, which wiped them.
        head = ev.headline or leader.get("headline")
        desc = ev.description or leader.get("description")
        emo = ev.emojis or leader.get("emojis")
        ts = ev.topic_score if ev.topic_score is not None else leader.get("topic_score")
        ts = None if ts is None else max(int(ts), ev.score)
        # scored_at: the first time the editor scored this story (kept on later re-edits). Digests
        # look at it, so a story scored after a digest went out still reaches the next one.
        stmts.append((
            "UPDATE stories SET final_score=?, headline=?, description=?, emojis=?, edited_at=?, topics=?, "
            "best_url=?, best_source=?, best_tier=?, best_published_at=?, updated_at=?, source_count=?, "
            "main_topic=?, topic_score=?, scored_at=coalesce(scored_at, ?) WHERE id=?",
            [ev.score, head, desc, emo, now, json.dumps([t for t in topic_order if t in tagset]),
             best["best_url"], best["best_source"], best["best_tier"], best["best_published_at"],
             max(s["updated_at"] for s in group), sum(s["source_count"] or 1 for s in group), main,
             ts, now, leader["id"]]))
        for k in kids:
            merged += 1
            stmts += [
                ("UPDATE stories SET merged_into=?, edited_at=? WHERE id=?", [leader["id"], now, k["id"]]),
                ("UPDATE stories SET merged_into=? WHERE merged_into=?", [leader["id"], k["id"]]),
                ("INSERT INTO sent (user_id, story_id, sent_at) SELECT user_id, ?, sent_at FROM sent "
                 "WHERE story_id=? ON CONFLICT(user_id, story_id) DO NOTHING", [leader["id"], k["id"]]),
            ]
    return stmts, merged


# ---------------------------------------------------------------- the pass

@dataclass
class EditorResult:
    status: str = "skipped"       # ok, failed, skipped (nothing new to edit)
    candidates: int = 0
    edited: int = 0
    merged: int = 0
    left_out: int = 0             # candidates the last answer did not mention (stay unedited)
    guard_dropped: list[str] = field(default_factory=list)
    provider: str | None = None
    calls: int = 0
    rounds: int = 0               # Step 8: successful editor answers in this run (1, or 2 on a backlog)
    input_tokens: int = 0
    output_tokens: int = 0
    errors: list[str] = field(default_factory=list)

    def line(self) -> str:
        return (f"editor: {self.status}, provider {self.provider}, {self.rounds} round(s), {self.candidates} "
                f"candidates, {self.edited} events written, {self.merged} merged away, {self.left_out} left out, "
                f"{len(self.guard_dropped)} texts dropped by the fact guard, calls {self.calls}, "
                f"tokens in {self.input_tokens} out {self.output_tokens}")


class Editor:
    """plans: the job's ProviderPlan list (same chain as the first pass).
    on_call(provider, ok, n_candidates, CallResult|None, error|None) records each AI call.
    dry_run: call the AI and validate, but write nothing (sandbox measurements)."""

    def __init__(self, db, plans, *, topics: list[dict], facts: list[str], facts_checked: str,
                 settings: Settings | None = None, prompt: EditorPrompt | None = None,
                 on_call: Callable | None = None, log: Callable[[str], None] = print,
                 debug_dir: str | Path | None = None, dry_run: bool = False):
        self.db = db
        self.plans = plans
        self.topics = topics
        self.topic_order = [t["tag"] for t in topics]
        self.facts = facts
        self.facts_checked = facts_checked
        self.s = settings or Settings()
        self.prompt = prompt or load_editor_prompt()
        self.on_call = on_call or (lambda *a: None)
        self.log = log
        self.debug_dir = Path(debug_dir) if debug_dir else None
        self.dry_run = dry_run
        # Step 13: a custom topic carries its own candidate floor (like Armenia's 3)
        self.floors = {**(self.s.editor_topic_floor or {}),
                       **{t["tag"]: t["floor"] for t in topics if t.get("floor") is not None}}

    def pool(self, now: int, min_importance: int | None = None, hours: float = 24) -> list[dict]:
        """Stories of the last `hours` the editor may see. The floor is editor_min_importance,
        lower for the topics in editor_topic_floor (Armenia: 3). An explicit floor overrides both."""
        if min_importance is not None:
            return self.db.query(POOL_SQL, [int(now - hours * 3600), min_importance])
        base = self.s.editor_min_importance
        floors = self.floors
        low = min([base, *floors.values()])
        rows = self.db.query(POOL_SQL, [int(now - hours * 3600), low])
        return [r for r in rows if r["importance"] >= base
                or any(r["importance"] >= floors[t] for t in tags(r) if t in floors)]

    def _today(self, now: int) -> str:
        return datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d")

    def _ask(self, plan, prompt: str, by_id: dict[int, dict], items: dict[int, list[dict]],
             out: EditorResult) -> tuple[list[Event], list[int]] | None:
        """One provider, with one retry on an invalid or empty answer. None = this provider failed."""
        p = plan.provider
        n = len(by_id)
        for attempt in range(2):
            if plan.reply_tokens and hasattr(p, "wait_for_tokens"):
                p.wait_for_tokens(ai.estimate_tokens(prompt) + plan.reply_tokens)
            res = None
            out.calls += 1
            try:
                res = p.generate(prompt, self.prompt.schema)
                out.input_tokens += res.input_tokens or 0
                out.output_tokens += res.output_tokens or 0
                self._dump(p.name, out.calls, prompt, res.text)
                try:
                    data = parse_answer(res.text)
                except ValueError as exc:
                    raise ai.AIError(p.name, f"editor: invalid JSON: {exc}", kind="invalid") from None
                events, left_out = validate_events(data, by_id, items, self.topic_order)
                covered = n - len(left_out)
                if covered < n * MIN_COVERED_SHARE:
                    raise ai.AIError(p.name, f"editor: answer covers only {covered} of {n} candidates",
                                     kind="invalid")
            except ai.AIError as exc:
                self.on_call(p, False, n, res, str(exc))
                out.errors.append(str(exc) if str(exc).startswith(f"{p.name}: editor") else f"editor {exc}")
                if exc.kind in ("invalid", "empty") and attempt == 0:
                    continue                # one retry on the same model
                return None                 # next provider
            self.on_call(p, True, n, res, None)
            return events, left_out
        return None

    def _round(self, now: int, pool: list[dict], out: EditorResult) -> tuple[str, bool]:
        """One editor answer over the best unscored stories. Returns (status, used_small_model)."""
        for plan in self.plans:
            p = plan.provider
            small = p.name == "groq"
            new, compare = choose(
                pool, self.topic_order,
                self.s.editor_groq_new if small else self.s.editor_new,
                self.s.editor_groq_per_topic if small else self.s.editor_per_topic,
                self.s.editor_groq_compare if small else self.s.editor_compare)
            if not new:
                return "skipped", small     # everything is edited already
            cands = new + compare
            by_id = {s["id"]: s for s in cands}
            items = load_items(self.db, list(by_id),
                               self.s.editor_groq_items if small else self.s.editor_items_per_story)
            prompt = render_prompt(
                self.prompt.template, today=self._today(now), topics=self.topics, facts=self.facts,
                facts_checked=self.facts_checked, new=new, compare=compare, items=items)
            got = self._ask(plan, prompt, by_id, items, out)
            if got is None:
                continue
            events, left_out = got
            stmts, merged = write_statements(events, by_id, self.topic_order, now)
            if not self.dry_run:
                self.db.batch(stmts)
            out.candidates += len(cands)
            out.provider = plan.label if out.provider in (None, plan.label) else f"{out.provider}+{plan.label}"
            out.edited += len(events)
            out.merged += merged
            out.left_out = len(left_out)
            out.guard_dropped += [d for e in events for d in e.dropped]
            out.rounds += 1
            if left_out:
                out.errors.append(f"editor: answer left out {len(left_out)} of {len(cands)} candidates")
            return "ok", small
        return "failed", False

    def run(self, now: int, min_importance: int | None = None, hours: float = 24) -> EditorResult:
        """Up to editor_max_calls answers per run: the next one only while unscored candidates
        remain (a busy hour, or ids the last answer left out) and only on Gemini (Groq's
        per-minute limit makes a second Groq call slow; the backlog waits for the next hour)."""
        out = EditorResult()
        rounds = 1 if self.dry_run else max(1, self.s.editor_max_calls)
        for _ in range(rounds):
            status, small = self._round(now, self.pool(now, min_importance, hours), out)
            if status == "skipped":
                break
            if status == "failed":
                if out.status != "ok":
                    out.status = "failed"
                break
            out.status = "ok"
            if small:
                break
        return out

    # ------------------------------------------------------------ Step 8: topic scores only

    def rescore_topics(self, now: int, hours: float = 24, redo: bool = False) -> tuple[EditorResult, int]:
        """One call over edited stories that have no topic score yet, shown as EDITED (with their
        score and main topic). Writes ONLY topic_score: final scores, text, topics and merges stay
        as they are, so live digests do not move. Returns (result, answers whose topic differs
        from the stored main topic). redo: also stories that have a topic score, in a spread
        (pseudo-random, repeatable) order: for sandbox checks of a new calibration."""
        out = EditorResult()
        todo = [s for s in self.pool(now, hours=hours)
                if s.get("edited_at") is not None and (redo or s.get("topic_score") is None)]
        if redo:
            todo.sort(key=lambda s: (s["id"] * 2654435761) % 2 ** 32)
        else:
            todo.sort(key=lambda s: (-(s.get("final_score") or 0), -s["updated_at"], -s["id"]))
        if not todo:
            return out, 0
        for plan in self.plans:
            small = plan.provider.name == "groq"
            batch = todo[:self.s.editor_groq_new if small else self.s.editor_new]
            by_id = {s["id"]: s for s in batch}
            items = load_items(self.db, list(by_id),
                               self.s.editor_groq_items if small else self.s.editor_items_per_story)
            # The old topic score is NOT shown: the editor would copy it (as with first-pass scores).
            prompt = render_prompt(
                self.prompt.template, today=self._today(now), topics=self.topics, facts=self.facts,
                facts_checked=self.facts_checked, new=[], compare=[{**s, "topic_score": None} for s in batch],
                items=items)
            got = self._ask(plan, prompt, by_id, items, out)
            if got is None:
                continue
            events, left_out = got
            stmts, mismatch = [], 0
            for ev in events:
                if ev.topic_raw is None:
                    continue
                for i in ev.ids:
                    st = by_id[i]
                    if ev.topic and st.get("main_topic") and ev.topic != st["main_topic"]:
                        mismatch += 1
                    stmts.append(("UPDATE stories SET topic_score=? WHERE id=?",
                                  [max(ev.topic_raw, st.get("final_score") or 0), i]))
            if not self.dry_run:
                self.db.batch(stmts)
            out.status, out.provider, out.rounds = "ok", plan.label, 1
            out.candidates, out.edited, out.left_out = len(batch), len(stmts), len(left_out)
            return out, mismatch
        out.status = "failed"
        return out, 0

    def _dump(self, provider: str, n: int, prompt: str, text: str) -> None:
        if not self.debug_dir:
            return
        self.debug_dir.mkdir(parents=True, exist_ok=True)
        stem = f"{int(time.time())}_editor_{provider}_{n}"
        (self.debug_dir / f"{stem}_prompt.txt").write_text(prompt, encoding="utf-8")
        (self.debug_dir / f"{stem}_answer.json").write_text(text, encoding="utf-8")


# ---------------------------------------------------------------- one-off backfill

def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Run the editor pass over the current pool (no feed fetch).")
    parser.add_argument("--backfill", action="store_true", help="repeat until the pool is edited")
    parser.add_argument("--rounds", type=int, default=8, help="max calls in --backfill mode")
    parser.add_argument("--min-importance", type=int, default=None, help="first-pass score floor")
    parser.add_argument("--hours", type=float, default=24, help="pool window (default 24 h, like the job)")
    parser.add_argument("--debug-dir", default=None, help="save prompts and answers here")
    parser.add_argument("--topic-only", action="store_true",
                        help="Step 8: give edited stories a topic score; writes only topic_score")
    parser.add_argument("--dry-run", action="store_true", help="call the AI, write nothing (sandbox)")
    parser.add_argument("--new", type=int, default=None, help="candidates per call (default editor_new)")
    parser.add_argument("--redo", action="store_true",
                        help="with --topic-only --dry-run: a spread sample of stories that already have one")
    parser.add_argument("--fresh-sim", action="store_true",
                        help="with --dry-run: treat edited stories as unscored (to measure a big call)")
    args = parser.parse_args(argv)
    from job.config import load_env, load_prompt, load_topics
    from job.d1 import insert_statements
    from job.run import build_from_env
    settings = Settings()
    if args.new:
        settings.editor_new = args.new
    db, plans = build_from_env(load_env(), settings)
    calls: list[tuple] = []

    def on_call(p, ok, n, res, error):
        calls.append((int(time.time()), p.name, p.model, 1 if ok else 0, n, res.input_tokens if res else None,
                      res.output_tokens if res else None, res.ms if res else None, (error or "")[:500] or None,
                      kind))

    # Measurements and the one-off rescore are logged apart from the hourly editor calls.
    kind = "editor_sandbox" if args.dry_run else "editor_rescore" if args.topic_only else "editor"
    batch_prompt = load_prompt()
    ed = Editor(db, plans, topics=load_topics(), facts=batch_prompt.facts,
                facts_checked=batch_prompt.facts_checked, settings=settings, on_call=on_call,
                debug_dir=args.debug_dir, dry_run=args.dry_run)
    if args.fresh_sim:
        if not args.dry_run:
            parser.error("--fresh-sim needs --dry-run")
        real_pool = ed.pool
        ed.pool = lambda now, mi=None, h=24: [{**s, "edited_at": None} for s in real_pool(now, mi, h)]
    rounds = args.rounds if args.backfill else 1
    for n in range(rounds):
        if args.topic_only:
            if args.redo and not args.dry_run:
                parser.error("--redo needs --dry-run (to redo for real, clear topic_score first)")
            res, mismatch = ed.rescore_topics(int(time.time()), args.hours, redo=args.redo)
            print(f"round {n + 1}: {res.line()}, topic differs from the stored one: {mismatch}")
        else:
            res = ed.run(int(time.time()), args.min_importance, args.hours)
            print(f"round {n + 1}: {res.line()}")
        for e in res.errors + res.guard_dropped:
            print(f"  note: {e[:300]}")
        if res.status != "ok" or args.dry_run:
            break
    db.batch(insert_statements("ai_calls", ("at", "provider", "model", "ok", "items", "input_tokens",
                                            "output_tokens", "ms", "error", "kind"), calls))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
