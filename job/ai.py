"""AI providers (Gemini primary, Groq fallback), prompt rendering, chunking and validation
of the model's output. Both providers are called over plain HTTPS with `requests`.

Lesson 2: an empty, blocked, truncated or unparseable response is an AIError (so the
caller falls back), never "no news".
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import Callable, Protocol

import requests


class AIError(Exception):
    def __init__(self, provider: str, message: str, *, kind: str = "error",
                 status: int | None = None, retry_after: float | None = None):
        super().__init__(f"{provider}: {message}")
        self.provider = provider
        self.kind = kind            # http, rate_limit, too_large, network, blocked, empty, truncated, invalid
        self.status = status
        self.retry_after = retry_after


@dataclass
class CallResult:
    provider: str
    model: str
    text: str
    input_tokens: int | None
    output_tokens: int | None
    ms: int
    finish: str | None = None
    extra: dict = field(default_factory=dict)


class Provider(Protocol):
    name: str
    model: str

    def generate(self, prompt: str, schema: dict) -> CallResult: ...


def _error_detail(resp: requests.Response) -> str:
    try:
        err = resp.json().get("error", {})
    except ValueError:
        return resp.text[:300]
    if isinstance(err, str):
        return err[:300]
    msg = str(err.get("message", ""))[:300]
    quotas = []
    for d in err.get("details") or []:
        for v in d.get("violations") or []:
            if v.get("quotaId"):
                quotas.append(f"{v.get('quotaId')}={v.get('quotaValue')}")
    return msg + (f" [quota: {', '.join(quotas)}]" if quotas else "")


def _retry_delay(resp: requests.Response) -> float | None:
    if resp.headers.get("retry-after"):
        try:
            return float(resp.headers["retry-after"])
        except ValueError:
            pass
    try:
        for d in resp.json().get("error", {}).get("details") or []:
            if str(d.get("retryDelay", "")).endswith("s"):
                return float(d["retryDelay"][:-1])
    except (ValueError, AttributeError):
        pass
    return None


# ---------------------------------------------------------------- Gemini

class GeminiProvider:
    name = "gemini"
    BASE = "https://generativelanguage.googleapis.com/v1beta"
    BLOCK_FINISH = {"SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "OTHER",
                    "IMAGE_SAFETY", "LANGUAGE"}

    def __init__(self, api_key: str, model: str, *, timeout: float = 180,
                 max_output_tokens: int = 32768, thinking_level: str | None = "low",
                 session: requests.Session | None = None,
                 retry_delays: tuple[float, ...] = (5, 20), sleep: Callable[[float], None] = time.sleep):
        self.model = model
        self.retry_delays = retry_delays   # waits before retrying a 500/503 ("high demand")
        self.sleep = sleep
        self.retries = 0
        self.timeout = timeout
        self.max_output_tokens = max_output_tokens
        self.thinking_level = thinking_level
        self.session = session or requests.Session()
        # key goes in a header, never in the URL (keeps it out of logs and error text)
        self.session.headers.update({"x-goog-api-key": api_key})

    def list_models(self) -> list[dict]:
        models, token = [], None
        while True:
            params = {"pageSize": 1000, **({"pageToken": token} if token else {})}
            resp = self.session.get(f"{self.BASE}/models", params=params, timeout=30)
            if resp.status_code != 200:
                raise AIError(self.name, f"list models HTTP {resp.status_code}: {_error_detail(resp)}",
                              status=resp.status_code, kind="http")
            data = resp.json()
            models += data.get("models", [])
            token = data.get("nextPageToken")
            if not token:
                return models

    def count_tokens(self, prompt: str) -> int:
        resp = self.session.post(f"{self.BASE}/models/{self.model}:countTokens",
                                 json={"contents": [{"role": "user", "parts": [{"text": prompt}]}]},
                                 timeout=60)
        if resp.status_code != 200:
            raise AIError(self.name, f"countTokens HTTP {resp.status_code}: {_error_detail(resp)}",
                          status=resp.status_code, kind="http")
        return int(resp.json()["totalTokens"])

    def generate(self, prompt: str, schema: dict | None) -> CallResult:
        config: dict = {"temperature": 0.2, "maxOutputTokens": self.max_output_tokens}
        if schema is not None:
            config["responseMimeType"] = "application/json"
            config["responseJsonSchema"] = schema
        if self.thinking_level:
            config["thinkingConfig"] = {"thinkingLevel": self.thinking_level}
        body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "generationConfig": config}
        t0 = time.monotonic()
        for delay in (*self.retry_delays, None):
            try:
                resp = self.session.post(f"{self.BASE}/models/{self.model}:generateContent",
                                         json=body, timeout=self.timeout)
            except requests.RequestException as exc:
                raise AIError(self.name, f"network error {type(exc).__name__}", kind="network") from None
            if resp.status_code not in (500, 503) or delay is None:
                break
            self.retries += 1
            self.sleep(delay)
        ms = int((time.monotonic() - t0) * 1000)
        if resp.status_code != 200:
            kind = "rate_limit" if resp.status_code == 429 else "http"
            raise AIError(self.name, f"HTTP {resp.status_code}: {_error_detail(resp)}", kind=kind,
                          status=resp.status_code, retry_after=_retry_delay(resp))
        data = resp.json()
        usage = data.get("usageMetadata") or {}
        in_tok = usage.get("promptTokenCount")
        out_tok = (usage.get("candidatesTokenCount") or 0) + (usage.get("thoughtsTokenCount") or 0)
        block = (data.get("promptFeedback") or {}).get("blockReason")
        if block:
            raise AIError(self.name, f"prompt blocked: {block}", kind="blocked")
        cands = data.get("candidates") or []
        if not cands:
            raise AIError(self.name, "response has no candidates", kind="empty")
        cand = cands[0]
        finish = cand.get("finishReason")
        parts = (cand.get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
        if finish == "MAX_TOKENS":
            raise AIError(self.name, f"output truncated at {out_tok} tokens", kind="truncated")
        if finish in self.BLOCK_FINISH:
            raise AIError(self.name, f"response blocked: finishReason={finish}", kind="blocked")
        if not text.strip():
            raise AIError(self.name, f"empty response text (finishReason={finish})", kind="empty")
        return CallResult(self.name, self.model, text, in_tok, out_tok, ms, finish,
                          extra={"thoughts_tokens": usage.get("thoughtsTokenCount")})


# ---------------------------------------------------------------- Groq

def _parse_duration(value: str | None) -> float | None:
    """Groq reset headers look like '7.66s', '1m2.5s', '120ms', '2h3m'."""
    if not value:
        return None
    total, found = 0.0, False
    for num, unit in re.findall(r"([\d.]+)(ms|h|m|s)", value):
        found = True
        total += float(num) * {"ms": 0.001, "s": 1, "m": 60, "h": 3600}[unit]
    return total if found else None


class GroqProvider:
    name = "groq"
    URL = "https://api.groq.com/openai/v1/chat/completions"

    def __init__(self, api_key: str, model: str, *, timeout: float = 120,
                 max_output_tokens: int = 3000, reasoning_effort: str | None = "low",
                 session: requests.Session | None = None,
                 sleep: Callable[[float], None] = time.sleep):
        self.model = model
        self.timeout = timeout
        self.max_output_tokens = max_output_tokens
        self.reasoning_effort = reasoning_effort
        self.session = session or requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {api_key}"})
        self.sleep = sleep
        self.limits: dict = {}

    def _record_limits(self, resp: requests.Response) -> None:
        h = resp.headers
        for key in ("x-ratelimit-limit-requests", "x-ratelimit-limit-tokens",
                    "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens"):
            if h.get(key, "").isdigit():
                self.limits[key] = int(h[key])
        for key in ("x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"):
            if h.get(key):
                self.limits[key] = _parse_duration(h[key])
        self.limits["at"] = time.monotonic()

    def wait_for_tokens(self, needed: int) -> float:
        """Sleep until the tokens-per-minute window has room for `needed` tokens."""
        remaining = self.limits.get("x-ratelimit-remaining-tokens")
        reset = self.limits.get("x-ratelimit-reset-tokens")
        if remaining is None or reset is None or needed <= remaining:
            return 0.0
        waited = max(0.0, reset - (time.monotonic() - self.limits["at"])) + 1.0
        waited = min(waited, 65.0)
        self.sleep(waited)
        return waited

    def generate(self, prompt: str, schema: dict | None) -> CallResult:
        body: dict = {"model": self.model, "temperature": 0.2,
                      "max_completion_tokens": self.max_output_tokens,
                      "messages": [{"role": "user", "content": prompt}]}
        if schema is not None:
            body["response_format"] = {"type": "json_schema",
                                       "json_schema": {"name": "story_batch", "schema": schema}}
        if self.reasoning_effort:
            body["reasoning_effort"] = self.reasoning_effort
        t0 = time.monotonic()
        for attempt in range(3):
            try:
                resp = self.session.post(self.URL, json=body, timeout=self.timeout)
            except requests.RequestException as exc:
                raise AIError(self.name, f"network error {type(exc).__name__}", kind="network") from None
            self._record_limits(resp)
            # The TPM window rolls: a 429 with a short "try again in N s" is waited out.
            delay = _retry_delay(resp) if resp.status_code == 429 else None
            if delay is None or delay > 65 or attempt == 2:
                break
            self.sleep(delay + 1)
        ms = int((time.monotonic() - t0) * 1000)
        if resp.status_code != 200:
            kind = {429: "rate_limit", 413: "too_large"}.get(resp.status_code, "http")
            raise AIError(self.name, f"HTTP {resp.status_code}: {_error_detail(resp)}", kind=kind,
                          status=resp.status_code, retry_after=_retry_delay(resp))
        data = resp.json()
        usage = data.get("usage") or {}
        choice = (data.get("choices") or [{}])[0]
        finish = choice.get("finish_reason")
        text = (choice.get("message") or {}).get("content") or ""
        if finish == "length":
            raise AIError(self.name, "output truncated (finish_reason=length)", kind="truncated")
        if not text.strip():
            raise AIError(self.name, f"empty response text (finish_reason={finish})", kind="empty")
        return CallResult(self.name, self.model, text, usage.get("prompt_tokens"),
                          usage.get("completion_tokens"), ms, finish,
                          extra={"reasoning_tokens": (usage.get("completion_tokens_details") or {})
                                 .get("reasoning_tokens")})


# ---------------------------------------------------------------- prompt

def estimate_tokens(text: str) -> int:
    """Rough token count: ~4 characters per token for Latin text, ~2.5 for Cyrillic and other
    scripts (calibrated against Gemini countTokens in Step 2), ~1.6 for Armenian script
    (Step 7: 40 News.am headlines with snippets were 6,542 Gemini tokens, 1.8x the Russian ones)."""
    armenian = sum(1 for ch in text if 0x530 <= ord(ch) <= 0x58F)
    non_latin = sum(1 for ch in text if ord(ch) > 0x24F) - armenian
    return int((len(text) - non_latin - armenian) / 4 + non_latin / 2.5 + armenian / 1.6) + 1


def item_line(item: dict) -> str:
    snippet = f" :: {item['snippet']}" if item.get("snippet") else ""
    # Step 13: Google News results have no text beyond the headline
    marker = " [headline only]" if item.get("headline_only") else ""
    return f"{item['id']} | {item['source_name']}, tier {item['tier']} | {item['title']}{snippet}{marker}"


# Step 13: readers' own topics. Rendered right after the main topic list; empty when no custom
# topic is followed, so the prompt is then exactly what it was before Step 13.
READER_TOPICS = """
   READER TOPICS. Readers also follow these topics of their own (tag: what it covers):
{lines}
   Items about a reader topic ARE news here, even when they are outside the topics above
   (sport, technology, business, culture, science): this overrides the FILTER rule for them.
   Tag them with the reader topic's tag (and any other tag that applies). Their importance is
   still scored on the scale below, for a general reader, except: an item that is a notable
   development for the topic's followers (a race result, a title, an election, a new law, a big
   decision) gets at least 3, so the editor sees it. Routine items keep their low score."""


def reader_topics_block(custom: list[dict]) -> str:
    if not custom:
        return ""
    lines = "\n".join(f"   - {t['tag']}: {t['label']['en']}, {' '.join(str(t.get('definition') or '').split())}"
                      for t in custom)
    return READER_TOPICS.format(lines=lines)


def story_line(story: dict) -> str:
    topics = story["topics"] if isinstance(story["topics"], str) else json.dumps(story["topics"])
    topics = ",".join(json.loads(topics))
    return f"S{story['id']} | {topics} | {story['summary']}"   # S-prefix: never confused with item ids


def render_prompt(template: str, *, today: str, topics: list[dict], facts: list[str],
                  facts_checked: str, existing: list[dict], items: list[dict]) -> str:
    """topics: the main topics, then any custom topics (`custom: True`, Step 13), which go in
    their own READER TOPICS block."""
    main = [t for t in topics if not t.get("custom")]
    topic_list = "\n".join(f"   - {t['tag']}: {' '.join(t['definition'].split())}" for t in main)
    values = {
        "{today}": today,
        "{topic_list}": topic_list,
        "{reader_topics}": reader_topics_block([t for t in topics if t.get("custom")]),
        "{facts_checked_date}": facts_checked,
        "{calibration_facts}": "\n".join(f"- {f}" for f in facts),
        "{recent_stories}": "\n".join(story_line(s) for s in existing) or "(none)",
        "{new_items}": "\n".join(item_line(i) for i in items),
    }
    out = template
    for key, value in values.items():
        out = out.replace(key, value)
    return out


def make_chunks(items: list[dict], budget_tokens: int, fixed_tokens: int) -> list[list[dict]]:
    """Split items greedily so prompt (fixed part + item lines) stays under budget_tokens.
    Every chunk gets at least one item."""
    room = max(budget_tokens - fixed_tokens, 200)
    chunks: list[list[dict]] = []
    current, used = [], 0
    for item in items:
        cost = estimate_tokens(item_line(item)) + 1
        if current and used + cost > room:
            chunks.append(current)
            current, used = [], 0
        current.append(item)
        used += cost
    if current:
        chunks.append(current)
    return chunks


# ---------------------------------------------------------------- output validation

@dataclass
class StoryOut:
    item_ids: list[int]
    topics: list[str]
    importance: int
    summary: str
    existing_story_id: int | None


DASH_SPACED = re.compile(r"\s+[‒–—―]\s+")
DASH_ANY = re.compile(r"[‒–—―]")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")
WAR_TAGS = ("ukraine_war", "iran_war")
BROAD_TAG = "politics_conflicts"


def clean_summary(text: str) -> str:
    """One line, no em/en dashes (owner rule for user-facing text), max 300 chars."""
    text = CONTROL.sub(" ", text or "")
    text = DASH_SPACED.sub(", ", text)
    text = DASH_ANY.sub("-", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s+([,.;:])", r"\1", text)
    return text[:300].strip()


def parse_json_object(text: str, key: str) -> dict:
    """A JSON object (fences allowed) whose `key` is a list; ValueError otherwise."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    data = json.loads(text)
    if not isinstance(data, dict) or not isinstance(data.get(key), list):
        raise ValueError(f"JSON has no '{key}' list")
    return data


def parse_json(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    data = json.loads(text)
    if not isinstance(data, dict) or not isinstance(data.get("stories"), list):
        raise ValueError("JSON has no 'stories' list")
    return data


def validate_stories(data: dict, item_ids: set[int], existing_ids: set[int],
                     topic_order: list[str]) -> list[StoryOut]:
    """Apply the rules from prompts/story_batch.md 'Notes for the job code': drop unknown tags
    and item ids, ids used twice (first wins), clamp importance, drop stories without a valid
    tag or item, add politics_conflicts next to a specific war tag (lesson 8; Step 15 merged
    wars_conflicts into it)."""
    used: set[int] = set()
    known = set(topic_order)
    out = []
    for raw in data["stories"]:
        if not isinstance(raw, dict):
            continue
        ids = []
        for v in raw.get("item_ids") or []:
            try:
                v = int(v)
            except (TypeError, ValueError):
                continue
            if v in item_ids and v not in used and v not in ids:
                ids.append(v)
        tags = {str(t).strip() for t in raw.get("topics") or []} & known
        if tags & set(WAR_TAGS):
            tags.add(BROAD_TAG)
        if not ids or not tags:
            continue
        try:
            importance = min(10, max(1, int(round(float(raw.get("importance") or 1)))))
        except (TypeError, ValueError):
            importance = 1
        existing = raw.get("existing_story_id")
        match = re.fullmatch(r"\s*[Ss]?(\d+)\s*", str(existing)) if existing is not None else None
        existing = int(match.group(1)) if match else None
        if existing is not None and existing not in existing_ids:
            existing = None      # unknown id: treat as a new story
        summary = clean_summary(str(raw.get("summary") or ""))
        used.update(ids)
        out.append(StoryOut(ids, [t for t in topic_order if t in tags], importance, summary, existing))
    return out
