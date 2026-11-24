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
    "GEMINI_EMERGENCY_API_KEY", "AXIOM_AI_FORCE",
)


def _read_env_file(path: Path) -> dict[str, str]:
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
    return env


def load_env(path: Path = ROOT / ".env") -> dict[str, str]:
    """Read KEY=value lines from .env. A non-empty real environment variable wins.

    Step 16: with AXIOM_ENV=staging, .env.staging (the staging D1 id and webhook secret) is read on
    top of .env, so a job change can be run locally against the staging database first:
        AXIOM_ENV=staging venv/Scripts/python -m job.run
    """
    env = _read_env_file(path)
    if os.environ.get("AXIOM_ENV") == "staging":
        staging = path.with_name(".env.staging")
        if not staging.exists():
            raise SystemExit("AXIOM_ENV=staging but .env.staging is missing")
        env.update(_read_env_file(staging))
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
    # Step 20: the fixed prompt grew to ~2,600 tokens (10 existing stories) / ~3,100 (30), so 3,500-token
    # chunks held only 2 or 3 items (2026-11-23 outage: 6 or 7 stories a run). Now ~30 items a call;
    # prompt + reply room stays <= 8,000 tokens a minute per Groq model, and three models take turns.
    groq_chunk_tokens: int = 5000        # est. prompt tokens per Groq call (estimate runs ~10% low on Cyrillic)
    groq_reply_tokens: int = 2800        # answers to ~30 items were 1-2k tokens; a truncated one is split in two
    groq_existing_max: int = 10          # fewer existing stories per Groq chunk (TPM)
    groq_max_chunks_per_run: int = 16    # Step 20: 8 -> 16, three models in rotation (each its own 8k TPM)
    # Step 20: run time. The 503 retries stop well before run_budget_s; no new pass-1 call starts after
    # pass1_budget_s (the rest waits for the next run, so the editor and translations still get time).
    run_budget_s: float = 840
    pass1_budget_s: float = 480
    emergency_max_chunks: int = 2        # pass-1 calls on the paid key per run (the caps decide first)
    emergency_chunk_tokens: int = 14000  # ~100 items: the answer must fit the paid key's 12k output limit
                                         # (staging: 195 items ran past it and were cut off)
    retention_days: int = 7              # items, stories, sent
    log_retention_days: int = 30         # job_runs, ai_calls, errors
    fetch_workers: int = 16
    fetch_timeout_s: float = 20
    # Editor pass (Step 5, job/editor.py): one extra AI call per run over the strongest stories.
    editor_new: int = 45                 # not-yet-edited stories per call (Step 8: 45 -> 90; Step 17c: back to 45,
                                         # since 105-story answers (8k to 16k tokens) sometimes stopped early or ran
                                         # away to the 32k output limit and were retried, up to 15 min a run)
    editor_per_topic: int = 3            # ...of which the best few of every topic come first
    editor_compare: int = 15             # already-edited stories shown for comparison and merging
    editor_items_per_story: int = 3      # article titles/snippets shown per story
    editor_min_importance: int = 4       # first-pass score floor for candidates
    # Step 8: a lower floor for small topics whose medium news the first pass rates low
    # (19 Armenia stories a day at 2-3, e.g. a party switch in a local race).
    editor_topic_floor: dict = field(default_factory=lambda: {"armenia": 3})
    editor_max_calls: int = 4            # Step 8: a 2nd call in the same run only while unscored candidates remain
                                         # (Step 17c: 2 -> 4 with half the size, the same 180 a run)
    editor_groq_new: int = 8             # Groq's 8k tokens/minute (prompt + reply) fits far fewer (Step 20: 10 -> 8,
                                         # a 12-story editor prompt was 5,900 tokens and one model refused it, 413)
    editor_paid_new: int = 20            # Step 20: on the paid key (12k answer limit; 60 candidates ran past it)
    editor_paid_compare: int = 5
    editor_groq_per_topic: int = 1
    editor_groq_compare: int = 2
    editor_groq_items: int = 2
    # Step 9 translation pass (job/translate.py): one call per reader language per run.
    translate_batch: int = 80            # stories per Gemini call (a normal hour has 2-6; a catch-up about 70)
    translate_groq_batch: int = 12       # Groq's 8k tokens/minute fits far fewer
    translate_groq_max_chunks: int = 3
    translate_paid_batch: int = 12       # Step 20: stories per call on the paid key (its 12k answer limit; Armenian is long)


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
