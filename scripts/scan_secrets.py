"""Before pushing to the PUBLIC repo: look for secrets in the whole git history and in every
file that would be pushed. Prints only key names and file/commit ids, never a value.

Checks:
  1. every real value in .env (8+ characters, except plain settings like model names) against
     the full text of every commit (`git log -p --all`) and every tracked + unignored file;
  2. token shapes (Telegram, Google, Groq, GitHub, Cloudflare-like) in the same text;
  3. that .env is ignored by git and never was committed.

Usage:  venv/Scripts/python scripts/scan_secrets.py      (exit 1 if anything is found)
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from scripts.set_secrets import read_env  # noqa: E402

NOT_SECRET = {"GEMINI_MODEL", "GEMINI_FALLBACK_MODEL", "GROQ_MODEL", "DEFAULT_TIMEZONE", "AXIOM_DEBUG_DIR"}
# Identifiers that are committed on purpose, and only where wrangler needs them. They grant no
# access on their own (the D1 token does, and it is a secret). Anywhere else they still count.
ALLOWED_IN = {"D1_DATABASE_ID": "worker/wrangler.toml"}
SHAPES = {
    "Telegram bot token": r"\b\d{8,10}:AA[A-Za-z0-9_-]{30,}",
    "Google API key": r"\bAIza[0-9A-Za-z_-]{35}\b",
    "Groq key": r"\bgsk_[A-Za-z0-9]{40,}",
    "GitHub token": r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}",
    "Cloudflare-style 40-char token after a key name": r"(?i)(token|api_key|secret)\s*[=:]\s*['\"]?[A-Za-z0-9_-]{40}\b",
}


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
                          errors="replace").stdout


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    found = 0
    env = read_env()
    values = {k: v for k, v in env.items() if k not in NOT_SECRET and len(v) >= 8}

    history = git("log", "-p", "--all", "--full-history", "--no-color", "--format=commit %H")
    files = [f for f in git("ls-files", "--cached", "--others", "--exclude-standard").splitlines() if f]
    texts = {"history": history}
    for f in files:
        p = ROOT / f
        if p.is_file() and p.stat().st_size < 5_000_000:
            texts[f] = p.read_text(encoding="utf-8", errors="replace")

    for where, text in texts.items():
        for k, v in values.items():
            if k in ALLOWED_IN:
                # history: allowed only inside the diff of the allowed file
                if where == ALLOWED_IN[k]:
                    continue
                if where == "history":
                    other = re.sub(r"(?ms)^diff --git a/" + re.escape(ALLOWED_IN[k]) + r" .*?(?=^diff --git |^commit |\Z)",
                                   "", text)
                    if v not in other:
                        continue
            if v in text:
                if where == "history":
                    commits = [c[7:15] for c in re.split(r"(?=^commit [0-9a-f]{40}$)", text, flags=re.M)
                               if v in c and c.startswith("commit ")]
                    print(f"FOUND value of {k} in git history (commits {', '.join(commits)})")
                else:
                    print(f"FOUND value of {k} in {where}")
                found += 1
        for name, rx in SHAPES.items():
            if re.search(rx, text):
                print(f"FOUND something shaped like a {name} in {where}")
                found += 1

    ignored = subprocess.run(["git", "check-ignore", "-q", ".env"], cwd=ROOT).returncode == 0
    ever = git("log", "--all", "--format=%h", "--", ".env").split()
    print(f".env ignored by git: {'yes' if ignored else 'NO'}; .env in any commit: {'NO' if not ever else ', '.join(ever)}")
    found += (not ignored) + bool(ever)
    print(f"checked {len(values)} .env values and {len(SHAPES)} token shapes against "
          f"{history.count(chr(10) + 'commit ') + 1} commits and {len(files)} files: "
          f"{'nothing found' if not found else f'{found} problem(s)'}")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
