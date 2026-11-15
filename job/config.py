"""Settings, secrets and the shared data files (topics, sources, prompt)."""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent

# Names read from .env (locally) or from real environment variables (GitHub secrets).
ENV_KEYS = (
    "TELEGRAM_BOT_TOKEN", "OWNER_TELEGRAM_ID", "GEMINI_API_KEY", "GEMINI_MODEL",
    "GROQ_API_KEY", "GROQ_MODEL", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID",
    "CLOUDFLARE_D1_TOKEN", "DEFAULT_TIMEZONE", "AXIOM_DEBUG_DIR", "GEMINI_FALLBACK_MODEL",
)


def load_env(path: Path = ROOT / ".env") -> dict[str, str]:
    """Read KEY=value lines from .env. A non-empty real environment variable wins."""
    env: dict[str, str] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            env[key.strip()] = value
    for key in ENV_KEYS:
        if os.environ.get(key):
            env[key] = os.environ[key]
    return env


@dataclass
class Settings:
    """Tuning knobs. Defaults are the values measured/decided in Steps 1-2."""
    max_items_per_feed: int = 8          # newest unseen items taken per feed per run
    snippet_chars: int = 200             # description characters sent to the AI
    first_run_lookback_h: float = 3      # no earlier run: take items from the last 3 h
    min_lookback_h: float = 2            # otherwise: since last run + 1 h, clamped to 2..24 h
    max_lookback_h: float = 24
    pending_max_age_h: float = 24        # pending items older than this become 'expired'
    existing_window_h: float = 24        # stories shown to the AI as "existing"
    existing_max: int = 250
    gemini_max_input_tokens: int = 25000  # est. prompt tokens per Gemini call: one normal hour
                                          # (~230 items); bigger backlogs are split
    groq_chunk_tokens: int = 3500        # est. prompt tokens per Groq call (estimate runs ~10% low
    groq_reply_tokens: int = 3500        # on Cyrillic); prompt + reply room must stay <= 8000 TPM
    groq_existing_max: int = 30          # fewer existing stories per Groq chunk (TPM)
    groq_max_chunks_per_run: int = 8     # keeps a fallback run to a few minutes
    retention_days: int = 7              # items, stories, sent
    log_retention_days: int = 30         # job_runs, ai_calls, errors
    fetch_workers: int = 16
    fetch_timeout_s: float = 20
    # Editor pass (Step 5, job/editor.py): one extra AI call per run over the strongest stories.
    editor_new: int = 90                 # not-yet-edited stories per call (Step 8: 45 -> 90; measured 89 of 90 covered)
    editor_per_topic: int = 3            # ...of which the best few of every topic come first
    editor_compare: int = 15             # already-edited stories shown for comparison and merging
    editor_items_per_story: int = 3      # article titles/snippets shown per story
    editor_min_importance: int = 4       # first-pass score floor for candidates
    # Step 8: a lower floor for small topics whose medium news the first pass rates low
    # (19 Armenia stories a day at 2-3, e.g. a party switch in a local race).
    editor_topic_floor: dict = field(default_factory=lambda: {"armenia": 3})
    editor_max_calls: int = 2            # Step 8: a 2nd call in the same run only while unscored candidates remain
    editor_groq_new: int = 10            # Groq's 8k tokens/minute (prompt + reply) fits far fewer
    editor_groq_per_topic: int = 1
    editor_groq_compare: int = 2
    editor_groq_items: int = 2


def load_topics() -> list[dict]:
    return yaml.safe_load((ROOT / "config" / "topics.yaml").read_text(encoding="utf-8"))["topics"]


def load_sources(include_disabled: bool = False) -> list[dict]:
    """Feeds from config/sources.yaml. A feed with `enabled: false` is skipped (kept in the file
    with a `disabled_note`, e.g. when it fails from GitHub's servers)."""
    sources = yaml.safe_load((ROOT / "config" / "sources.yaml").read_text(encoding="utf-8"))["sources"]
    return sources if include_disabled else [s for s in sources if s.get("enabled", True)]


@dataclass
class Prompt:
    template: str
    facts: list[str]
    facts_checked: str
    schema: dict


def load_prompt(path: Path = ROOT / "prompts" / "story_batch.md") -> Prompt:
    """Pull the prompt template, the calibration facts and the output schema out of the
    markdown file, so the file stays the single place to edit them."""
    text = path.read_text(encoding="utf-8")
    template = re.search(r"## Prompt template\s+```text\n(.*?)\n```", text, re.S).group(1)
    facts_section = re.search(r"## Calibration facts[^\n]*\n(.*?)\n## ", text, re.S).group(1)
    checked = re.search(r"Checked (\d{4}-\d{2}-\d{2})", facts_section).group(1)
    facts, current = [], None
    for line in facts_section.splitlines():
        if line.startswith("- "):
            current = line[2:].strip()
            facts.append(current)
        elif current is not None and line.startswith("  ") and line.strip():
            facts[-1] = f"{facts[-1]} {line.strip()}"
        else:
            current = None
    schema = json.loads(re.search(r"## Output schema\s+```json\n(.*?)\n```", text, re.S).group(1))
    return Prompt(template=template, facts=facts, facts_checked=checked, schema=schema)
