"""Translation pass (Step 9): the third AI step of every hourly run, after the editor.

Readers choose a language (users.lang; config/languages.json). Digests are built in the Worker
with no AI, so the headline and description of every story that could reach a digest are
translated here, ahead of time, and stored in `story_translations`:
- languages: only the enabled ones that at least one active (not paused, not blocked) user
  reads; English needs nothing. No such user: no call at all;
- stories: the last 24 h, not merged away, passing the editorial bar or the topic path of
  config/digest.json (the same rule as worker/src/digest.js qualifies() with every topic
  followed; tests/fixtures/eligible_cases.json keeps the two in step);
- batching: one call per language per run (up to translate_batch stories), same provider chain
  as the other passes (Groq in small chunks for its per-minute limit);
- guards, in code: the same numbers as the English (both ways), glossary names
  (config/glossary.yaml), the right script, a sane length, no dashes. A rejected story gets an
  ok = 0 row with the reason, which is shown to the model on the retry next hour;
- a row counts only while its `src` equals the story's current English text, so a story the
  editor rewrites is translated again.
Nothing here can fail the run: errors are logged and the stories are retried next hour. The
Worker sends a digest in a reader language only if EVERY story in it has a usable translation;
otherwise the whole digest goes out in English (never mixed).

    venv/Scripts/python -m job.translate --samples 15 --langs ru,hy,fr     Step 9 quality samples (writes nothing)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import yaml

from job import ai
from job.config import ROOT, Settings
from job.d1 import in_list_statements
from job.editor import clean_text

TRANSLATE_PROMPT = ROOT / "prompts" / "translate.md"
LANGUAGES = ROOT / "config" / "languages.json"
GLOSSARY = ROOT / "config" / "glossary.yaml"
DIGEST = ROOT / "config" / "digest.json"
DAY = 86400
MAX_HEADLINE = 260
MAX_DESCRIPTION = 600

# Stories that could reach a digest: the Worker's CANDIDATE_SQL rule (worker/src/digest.js) for a
# reader who follows every topic. ?1 since, ?2 unedited_offset, ?3 boost caps (JSON), ?4 editorial
# bar, ?5 topic bar, ?6 topic_needs_boost (0/1), ?7 the topic tags (JSON).
ELIGIBLE_SQL = """
SELECT id, summary, headline, description, g FROM (
  SELECT s.*, coalesce(s.final_score, s.importance - ?2) AS g,
         s.final_score + min(max(coalesce(s.topic_score, s.final_score) - s.final_score, 0),
                             coalesce(json_extract(?3, '$.' || s.main_topic), 10)) AS t
  FROM stories s
  WHERE max(s.updated_at, coalesce(s.scored_at, 0)) >= ?1
    AND s.merged_into IS NULL
    AND EXISTS (SELECT 1 FROM json_each(s.topics) x WHERE x.value IN (SELECT u.value FROM json_each(?7) u))
)
WHERE g >= ?4 OR (main_topic IN (SELECT u.value FROM json_each(?7) u) AND t >= ?5 AND (?6 = 0 OR t > final_score))
ORDER BY g DESC, id DESC"""

EXISTING_SQL = "SELECT story_id, ok, src, note FROM story_translations WHERE lang = ? AND story_id IN ({qs})"
UPSERT_SQL = ("INSERT INTO story_translations (story_id, lang, ok, headline, description, src, note, provider, "
              "created_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(story_id, lang) DO UPDATE SET ok=excluded.ok, "
              "headline=excluded.headline, description=excluded.description, src=excluded.src, "
              "note=excluded.note, provider=excluded.provider, created_at=excluded.created_at")

SCRIPT = {"ru": re.compile(r"[А-Яа-яЁё]"), "hy": re.compile(r"[Ա-և]"),
          "fr": re.compile(r"[A-Za-zÀ-ÿ]")}
FOREIGN_SCRIPT = {"fr": re.compile(r"[Ѐ-ӿԱ-և]")}
# A number with its group or decimal separators: 3,500 / 3 500 / 3.5 / 3,5 all compare as digits.
NUMBER = re.compile(r"\d+(?:[   .,'’]\d+)*")


# ---------------------------------------------------------------- config

def load_languages(path: Path = LANGUAGES) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_glossary(path: Path = GLOSSARY) -> list[dict]:
    return yaml.safe_load(path.read_text(encoding="utf-8"))["names"]


def load_digest_config(path: Path = DIGEST) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@dataclass
class TranslatePrompt:
    template: str
    schema: dict
    notes: dict


def load_translate_prompt(path: Path = TRANSLATE_PROMPT) -> TranslatePrompt:
    text = path.read_text(encoding="utf-8")
    template = re.search(r"## Prompt template\s+```text\r?\n(.*?)\r?\n```", text, re.S).group(1)
    notes = json.loads(re.search(r"## Language notes\s+```json\r?\n(.*?)\r?\n```", text, re.S).group(1))
    schema = json.loads(re.search(r"## Output schema\s+```json\r?\n(.*?)\r?\n```", text, re.S).group(1))
    return TranslatePrompt(template.replace("\r\n", "\n"), schema, notes)


# ---------------------------------------------------------------- which stories

def eligible_params(now: int, cfg: dict, tags: list[str], hours: float = 24) -> list:
    return [int(now - hours * 3600), cfg["unedited_offset"], json.dumps(cfg.get("topic_boost_max") or {}),
            cfg["editorial_bar"], cfg["topic_bar"], 1 if cfg.get("topic_needs_boost") else 0, json.dumps(tags)]


def qualifies(s: dict, cfg: dict, tags: list[str]) -> bool:
    """The digest rule for a reader who follows every topic, in Python (the fixture test checks it
    against ELIGIBLE_SQL here and against qualifies() in worker/src/digest.js)."""
    story_tags = json.loads(s["topics"]) if isinstance(s["topics"], str) else s["topics"]
    if not any(t in tags for t in story_tags):
        return False
    final = s.get("final_score")
    g = final if final is not None else (s.get("importance") or 0) - cfg["unedited_offset"]
    if g >= cfg["editorial_bar"]:
        return True
    if final is None or not s.get("main_topic") or s["main_topic"] not in tags:
        return False
    boost = max(0, (s.get("topic_score") if s.get("topic_score") is not None else final) - final)
    cap = (cfg.get("topic_boost_max") or {}).get(s["main_topic"], boost)
    t = final + min(boost, cap)
    return t >= cfg["topic_bar"] and (not cfg.get("topic_needs_boost") or t > final)


def english_headline(s: dict) -> str:
    return s["headline"] if s.get("headline") is not None else s["summary"]


def src_text(s: dict) -> str:
    """Exactly what the Worker's join compares: coalesce(headline, summary) || char(10) || coalesce(description, '')."""
    return f"{english_headline(s)}\n{s.get('description') or ''}"


# ---------------------------------------------------------------- guards

def number_set(text: str) -> set[str]:
    return {re.sub(r"\D", "", m) for m in NUMBER.findall(text or "")}


def glossary_hits(english: str, glossary: list[dict]) -> list[dict]:
    out = []
    for g in glossary:
        if any(re.search(rf"(?<![\w-]){re.escape(n)}(?![\w])", english) for n in g["en"]):
            out.append(g)
    return out


def clean_translated_headline(text: str) -> str:
    return clean_text(text, MAX_HEADLINE).rstrip(".։ ").strip()


def check_translation(lang: str, english: dict, raw_head: str, raw_desc: str,
                      glossary: list[dict]) -> tuple[str, str | None, list[str]]:
    """Cleans one translated story and checks it. Returns (headline, description, problems);
    any problem means the translation is not used."""
    en_head, en_desc = english_headline(english), english.get("description") or ""
    head = clean_translated_headline(raw_head or "")
    desc = clean_text(raw_desc or "", MAX_DESCRIPTION) if en_desc else ""
    problems = []
    if not head:
        problems.append("empty headline")
    if en_desc and not desc:
        problems.append("empty description")
    both = f"{head}\n{desc}"
    script = SCRIPT.get(lang)
    if head and script and not script.search(head):
        problems.append(f"headline is not in {lang} script")
    if FOREIGN_SCRIPT.get(lang) and FOREIGN_SCRIPT[lang].search(both):
        problems.append("text in a foreign script")
    en_len = len(en_head) + len(en_desc)
    if head and en_len and not 0.5 <= len(head + desc) / en_len <= 3:
        problems.append(f"length {len(head + desc)} vs English {en_len}")
    en_nums, tr_nums = number_set(f"{en_head}\n{en_desc}"), number_set(both)
    if en_nums - tr_nums:
        problems.append(f"missing number(s) {', '.join(sorted(en_nums - tr_nums))}")
    if tr_nums - en_nums:
        problems.append(f"number(s) not in the English: {', '.join(sorted(tr_nums - en_nums))}")
    low = both.casefold()
    for g in glossary_hits(f"{en_head}\n{en_desc}", glossary):
        form = g.get(lang)
        stem = g.get(f"{lang}_check") or form
        if stem and stem.casefold() not in low:
            problems.append(f"name {g['en'][0]} must be written {form}")
    return head, desc or None, problems


# ---------------------------------------------------------------- the pass

@dataclass
class LangResult:
    todo: int = 0
    ok: int = 0
    rejected: int = 0
    unanswered: int = 0
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    provider: str | None = None
    notes: list[str] = field(default_factory=list)


@dataclass
class TranslateResult:
    status: str = "skipped"       # ok, partial (some left for next hour), failed, skipped (nothing to do)
    langs: dict[str, LangResult] = field(default_factory=dict)
    eligible: int = 0
    errors: list[str] = field(default_factory=list)

    @property
    def calls(self) -> int:
        return sum(r.calls for r in self.langs.values())

    @property
    def input_tokens(self) -> int:
        return sum(r.input_tokens for r in self.langs.values())

    @property
    def output_tokens(self) -> int:
        return sum(r.output_tokens for r in self.langs.values())

    def line(self) -> str:
        if not self.langs:
            return f"translate: {self.status} (no reader languages besides English)"
        parts = [f"{lang} {r.ok} ok of {r.todo} to do, {r.rejected} rejected, {r.unanswered} unanswered, "
                 f"{r.calls} calls via {r.provider}, tokens in {r.input_tokens} out {r.output_tokens}"
                 for lang, r in self.langs.items()]
        return f"translate: {self.status}, {self.eligible} eligible stories; " + "; ".join(parts)


class Translator:
    """plans: the job's ProviderPlan list. on_call(provider, ok, n, CallResult|None, error|None, kind)
    records each AI call (kind = translate_<lang>). dry_run: call the AI and check, write nothing."""

    def __init__(self, db, plans, *, settings: Settings | None = None, languages: dict | None = None,
                 glossary: list[dict] | None = None, prompt: TranslatePrompt | None = None,
                 digest_cfg: dict | None = None, topic_tags: list[str] | None = None,
                 on_call: Callable | None = None, log: Callable[[str], None] = print,
                 debug_dir: str | Path | None = None, dry_run: bool = False):
        self.db = db
        self.plans = plans
        self.s = settings or Settings()
        self.languages = languages or load_languages()
        self.glossary = glossary if glossary is not None else load_glossary()
        self.prompt = prompt or load_translate_prompt()
        self.cfg = digest_cfg or load_digest_config()
        self.tags = topic_tags or list(self.cfg["topic_specificity"])
        self.on_call = on_call or (lambda *a: None)
        self.log = log
        self.debug_dir = Path(debug_dir) if debug_dir else None
        self.dry_run = dry_run

    # ------------------------------------------------------------ what to do

    def reader_languages(self) -> list[str]:
        """Enabled languages, other than English, that at least one active user reads."""
        rows = self.db.query("SELECT DISTINCT lang FROM users WHERE paused = 0 AND blocked = 0")
        used = {r["lang"] for r in rows}
        return [lang for lang in self.languages["enabled"] if lang != "en" and lang in used]

    def eligible(self, now: int) -> list[dict]:
        return self.db.query(ELIGIBLE_SQL, eligible_params(now, self.cfg, self.tags))

    def todo(self, lang: str, stories: list[dict]) -> list[dict]:
        """Stories with no usable translation for their current English text, each with the
        last rejection note (if the last try was rejected)."""
        have: dict[int, dict] = {}
        for rows in self.db.batch(in_list_statements(EXISTING_SQL, [s["id"] for s in stories], [lang])):
            for r in rows:
                have[int(r["story_id"])] = r
        out = []
        for s in stories:
            row = have.get(s["id"])
            if row and row["ok"] and row["src"] == src_text(s):
                continue
            note = row["note"] if row and not row["ok"] and row["src"] == src_text(s) else None
            out.append({**s, "retry_note": note})
        return out

    # ------------------------------------------------------------ one call

    def render(self, lang: str, stories: list[dict]) -> str:
        english = " ".join(f"{s.get('headline') or s['summary']} {s.get('description') or ''}" for s in stories)
        names = [g for g in glossary_hits(english, self.glossary) if g.get(lang)]
        name_lines = "\n".join(f"- {' / '.join(g['en'])}: {g[lang]}" for g in names) or "(none)"
        items = []
        for s in stories:
            item = {"id": f"S{s['id']}", "headline": english_headline(s), "description": s.get("description") or ""}
            if s.get("retry_note"):
                item["retry_note"] = s["retry_note"]
            items.append(item)
        values = {
            "{language}": self.languages["english_names"][lang],
            "{style}": self.prompt.notes.get(lang, ""),
            "{names}": name_lines,
            "{stories}": json.dumps(items, ensure_ascii=False, indent=1),
        }
        out = self.prompt.template
        for key, value in values.items():
            out = out.replace(key, value)
        return out

    def _parse(self, provider: str, text: str) -> dict[int, dict]:
        try:
            data = ai.parse_json_object(text, "items")
        except ValueError as exc:
            raise ai.AIError(provider, f"translate: invalid JSON: {exc}", kind="invalid") from None
        out: dict[int, dict] = {}
        for raw in data["items"]:
            if not isinstance(raw, dict):
                continue
            m = re.fullmatch(r"\s*[Ss]?(\d+)\s*", str(raw.get("id")))
            if m and int(m.group(1)) not in out:
                out[int(m.group(1))] = raw
        return out

    def translate(self, lang: str, stories: list[dict], now: int, res: LangResult) -> list[tuple]:
        """Translates `stories` (at most one batch per provider) and returns the rows to write:
        (story_id, lang, ok, headline, description, src, note, provider, created_at). Stories no
        provider answered get no row (they are retried next hour)."""
        rows: list[tuple] = []
        queue = list(stories)
        kind = f"translate_{lang}"
        for plan in self.plans:
            if not queue:
                break
            p = plan.provider
            small = p.name == "groq"
            size = self.s.translate_groq_batch if small else self.s.translate_batch
            max_chunks = self.s.translate_groq_max_chunks if small else 1
            chunks = [queue[i:i + size] for i in range(0, len(queue), size)][:max_chunks]
            done: set[int] = set()
            for chunk in chunks:
                answer = self._call(plan, lang, chunk, res, kind)
                if answer is None:
                    break             # this provider is down or keeps failing: next provider
                by_id = {s["id"]: s for s in chunk}
                for sid, s in by_id.items():
                    raw = answer.get(sid)
                    if raw is None:
                        continue      # not answered: the next provider, or next hour
                    done.add(sid)
                    head, desc, problems = check_translation(
                        lang, s, str(raw.get("headline") or ""), str(raw.get("description") or ""), self.glossary)
                    if problems:
                        res.rejected += 1
                        note = "; ".join(problems)[:300]
                        res.notes.append(f"S{sid}: {note}")
                        rows.append((sid, lang, 0, None, None, src_text(s), note, plan.label, now))
                    else:
                        res.ok += 1
                        rows.append((sid, lang, 1, head, desc, src_text(s), None, plan.label, now))
                res.provider = plan.label if res.provider in (None, plan.label) else f"{res.provider}+{plan.label}"
            queue = [s for s in queue if s["id"] not in done]
        res.unanswered += len(queue)
        return rows

    def _call(self, plan, lang: str, chunk: list[dict], res: LangResult, kind: str) -> dict[int, dict] | None:
        p = plan.provider
        prompt = self.render(lang, chunk)
        for attempt in range(2):
            if plan.reply_tokens and hasattr(p, "wait_for_tokens"):
                p.wait_for_tokens(ai.estimate_tokens(prompt) + plan.reply_tokens)
            out = None
            res.calls += 1
            try:
                out = p.generate(prompt, self.prompt.schema)
                res.input_tokens += out.input_tokens or 0
                res.output_tokens += out.output_tokens or 0
                self._dump(p.name, lang, res.calls, prompt, out.text)
                answer = self._parse(p.name, out.text)
                if not answer:
                    raise ai.AIError(p.name, "translate: answer has no usable items", kind="invalid")
            except ai.AIError as exc:
                self.on_call(p, False, len(chunk), out, str(exc), kind)
                res.notes.append(str(exc)[:300])
                if exc.kind in ("invalid", "empty") and attempt == 0:
                    continue
                return None
            self.on_call(p, True, len(chunk), out, None, kind)
            return answer
        return None

    def _dump(self, provider: str, lang: str, n: int, prompt: str, text: str) -> None:
        if not self.debug_dir:
            return
        self.debug_dir.mkdir(parents=True, exist_ok=True)
        stem = f"{int(time.time())}_translate_{lang}_{provider}_{n}"
        (self.debug_dir / f"{stem}_prompt.txt").write_text(prompt, encoding="utf-8")
        (self.debug_dir / f"{stem}_answer.json").write_text(text, encoding="utf-8")

    # ------------------------------------------------------------ the run

    def run(self, now: int) -> TranslateResult:
        out = TranslateResult()
        langs = self.reader_languages()
        if not langs:
            return out
        stories = self.eligible(now)
        out.eligible = len(stories)
        left = False
        for lang in langs:
            res = out.langs.setdefault(lang, LangResult())
            todo = self.todo(lang, stories) if stories else []
            res.todo = len(todo)
            if not todo:
                continue
            batch = todo[:self.s.translate_batch]
            rows = self.translate(lang, batch, now, res)
            if rows and not self.dry_run:
                self.db.batch([(UPSERT_SQL, list(r)) for r in rows])
            if res.unanswered or res.rejected or len(todo) > len(batch):
                left = True
            if res.unanswered == len(batch):
                out.errors.append(f"translate {lang}: no provider answered ({len(batch)} stories wait for next hour)")
            elif res.rejected:
                out.errors.append(f"translate {lang}: {res.rejected} rejected by the checks, retried next hour: "
                                  + "; ".join(n for n in res.notes if n.startswith("S"))[:400])
        answered = any(r.ok for r in out.langs.values())
        todo_any = any(r.todo for r in out.langs.values())
        out.status = "skipped" if not todo_any else ("partial" if left and answered else "failed" if left else "ok")
        return out


# ---------------------------------------------------------------- Step 9 quality samples

def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Translate real recent digest stories (writes nothing to D1).")
    parser.add_argument("--samples", type=int, default=15, help="how many of the owner's most recent digest stories")
    parser.add_argument("--langs", default="ru,hy,fr")
    parser.add_argument("--out", default=str(ROOT / "reports" / "data" / "step-09-samples.json"))
    parser.add_argument("--debug-dir", default=None)
    args = parser.parse_args(argv)
    from job.config import load_env
    from job.run import build_from_env
    settings = Settings()
    env = load_env()
    db, plans = build_from_env(env, settings)
    calls: list[dict] = []

    def on_call(p, ok, n, res, error, kind):
        calls.append({"kind": kind, "provider": p.name, "model": p.model, "ok": ok, "items": n,
                      "input_tokens": res.input_tokens if res else None,
                      "output_tokens": res.output_tokens if res else None, "error": error})

    owner = int(env["OWNER_TELEGRAM_ID"])
    stories = db.query(
        "SELECT s.id, s.summary, s.headline, s.description, s.emojis, s.best_source, s.best_url, s.topics, "
        "s.main_topic, s.final_score, x.sent_at FROM sent x JOIN stories s ON s.id = x.story_id "
        "WHERE x.user_id = ? AND s.merged_into IS NULL ORDER BY x.sent_at DESC, s.id DESC LIMIT ?",
        [owner, args.samples])
    tr = Translator(db, plans, settings=settings, on_call=on_call, debug_dir=args.debug_dir, dry_run=True)
    out = {"made_at": int(time.time()), "stories": stories, "langs": {}, "calls": calls}
    for lang in [x.strip() for x in args.langs.split(",") if x.strip()]:
        res = LangResult()
        rows = tr.translate(lang, [{**s, "retry_note": None} for s in stories], int(time.time()), res)
        out["langs"][lang] = {
            "result": res.__dict__,
            "rows": {str(r[0]): {"ok": r[2], "headline": r[3], "description": r[4], "note": r[6], "provider": r[7]}
                     for r in rows},
        }
        print(f"{lang}: {res.ok} ok, {res.rejected} rejected, {res.unanswered} unanswered, {res.calls} calls, "
              f"tokens in {res.input_tokens} out {res.output_tokens}, via {res.provider}")
        for n in res.notes:
            print(f"  note: {n}")
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"written: {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
