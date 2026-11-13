"""Test doubles: in-memory database with the real schema, fake feeds, fake AI providers,
fake HTTP sessions and a controllable clock."""
from __future__ import annotations

import json
import re
from pathlib import Path

from job import ai
from job.config import Settings
from job.d1 import SqliteDB
from job.fetch import Entry, FeedResult, url_hash
from job.run import Job, ProviderPlan

ROOT = Path(__file__).resolve().parent.parent
T0 = 1_800_000_000  # a fixed "now" (2027-01-15) so tests never depend on the real time

SOURCES = [
    {"key": "alpha", "name": "Alpha Times", "url": "https://alpha.test/rss", "tier": 1},
    {"key": "beta", "name": "Beta News", "url": "https://beta.test/rss", "tier": 2},
    {"key": "gamma", "name": "Gamma Wire", "url": "https://gamma.test/rss", "tier": 3},
]
TOPICS = [
    {"tag": "politics", "label": {"en": "Politics"}, "emoji": "P", "default": True, "definition": "politics"},
    {"tag": "wars_conflicts", "label": {"en": "Wars"}, "emoji": "W", "default": True, "definition": "wars"},
    {"tag": "armenia", "label": {"en": "Armenia"}, "emoji": "A", "default": True, "definition": "armenia"},
    {"tag": "russia", "label": {"en": "Russia"}, "emoji": "R", "default": True, "definition": "russia"},
    {"tag": "iran_war", "label": {"en": "Iran"}, "emoji": "I", "default": True, "definition": "iran"},
    {"tag": "ukraine_war", "label": {"en": "Ukraine"}, "emoji": "U", "default": True, "definition": "ukraine"},
]


def new_db() -> SqliteDB:
    db = SqliteDB()
    db.executescript((ROOT / "db" / "schema.sql").read_text(encoding="utf-8"))
    return db


class Clock:
    def __init__(self, t: float = T0):
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, hours: float) -> None:
        self.t += hours * 3600


def entry(source_key: str, title: str, age_min: float, now: float, n: int = 0) -> Entry:
    src = next(s for s in SOURCES if s["key"] == source_key)
    url = f"https://{source_key}.test/{re.sub(r'[^a-z0-9]+', '-', title.lower())}-{n}"
    return Entry(source_key, src["name"], src["tier"], url, url_hash(url), title, "snippet",
                 int(now - age_min * 60))


class Feeds:
    """Fake fetcher: returns whatever entries are set, grouped per source."""

    def __init__(self):
        self.entries: list[Entry] = []
        self.calls = 0

    def __call__(self, sources, now):
        self.calls += 1
        out = []
        for s in sources:
            mine = [e for e in self.entries if e.source_key == s["key"]]
            out.append(FeedResult(s, mine, None if mine else "no usable entries"))
        return out


ITEM_RE = re.compile(r"^(\d+) \| .+?, tier \d \| (.+?)(?: :: .*)?$", re.M)
STORY_RE = re.compile(r"^S(\d+) \| ([^|]*) \| (.*)$", re.M)


def prompt_items(prompt: str) -> dict[str, int]:
    """title -> item id, from the NEW ITEMS section of a rendered prompt."""
    section = prompt.split("NEW ITEMS (", 1)[1]
    return {m.group(2): int(m.group(1)) for m in ITEM_RE.finditer(section)}


def prompt_existing(prompt: str) -> dict[str, int]:
    """summary -> story id, from the EXISTING STORIES section."""
    section = prompt.split("EXISTING STORIES (", 1)[1].split("NEW ITEMS (", 1)[0]
    return {m.group(3): int(m.group(1)) for m in STORY_RE.finditer(section)}


def grouping_responder(topics_by_key: dict[str, list[str]], importance: int = 6,
                       merge: dict[str, str] | None = None):
    """Fake 'model': titles look like 'KEY: text'. Items with the same KEY become one story;
    KEY 'OFF' goes to not_news_ids; `merge` maps KEY -> the start of an existing story's
    summary to attach to."""
    merge = merge or {}

    def respond(prompt: str) -> dict:
        items = prompt_items(prompt)
        existing = prompt_existing(prompt)
        groups: dict[str, list[int]] = {}
        not_news = []
        for title, item_id in items.items():
            key = title.split(":", 1)[0]
            if key == "OFF":
                not_news.append(item_id)
            else:
                groups.setdefault(key, []).append(item_id)
        stories = []
        by_id = {v: k for k, v in items.items()}
        for key, ids in groups.items():
            target = next((sid for summ, sid in existing.items()
                           if key in merge and summ.startswith(merge[key])), None)
            words = by_id[ids[0]].split(":", 1)[1].strip()      # like a real summary: reuses title words
            stories.append({"item_ids": ids, "existing_story_id": f"S{target}" if target else None,
                            "summary": "" if target else f"Summary of {key}: {words}",
                            "topics": topics_by_key.get(key, ["politics"]), "importance": importance})
        return {"stories": stories, "not_news_ids": not_news}
    return respond


class FakeProvider:
    """Each call takes the next response: an Exception (raised), a callable(prompt) or a dict."""

    def __init__(self, name: str, responses: list):
        self.name = name
        self.model = f"{name}-fake"
        self.responses = list(responses)
        self.prompts: list[str] = []

    def generate(self, prompt: str, schema: dict) -> ai.CallResult:
        self.prompts.append(prompt)
        if not self.responses:
            raise AssertionError(f"{self.name}: unexpected extra call")
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        if callable(r):
            r = r(prompt)
        return ai.CallResult(self.name, self.model, r if isinstance(r, str) else json.dumps(r), 1000, 200, 5)


def make_job(db, gemini, groq, feeds, clock, **settings_overrides) -> Job:
    s = Settings(**settings_overrides)
    plans = [ProviderPlan(gemini, s.gemini_max_input_tokens, s.existing_max, 4),
             ProviderPlan(groq, s.groq_chunk_tokens, s.groq_existing_max, s.groq_max_chunks_per_run)]
    return Job(db, plans, settings=s, topics=TOPICS, sources=SOURCES, fetcher=feeds, clock=clock,
               log=lambda _msg: None)


class FakeResponse:
    def __init__(self, status: int, body: dict | None = None, headers: dict | None = None):
        self.status_code = status
        self._body = body or {}
        self.headers = headers or {}
        self.text = json.dumps(self._body)

    def json(self):
        return self._body


class FakeSession:
    def __init__(self, responses: list[FakeResponse]):
        self.responses = list(responses)
        self.headers: dict = {}
        self.posts = 0

    def post(self, url, json=None, timeout=None):
        self.posts += 1
        return self.responses.pop(0)

    def get(self, url, params=None, timeout=None):
        return self.responses.pop(0)
