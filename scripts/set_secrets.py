"""Copy secrets from .env to GitHub Actions and to the Cloudflare Worker, without ever
printing a value. Each value goes to the tool through stdin (never on a command line).

Usage (from the project folder):
    venv/Scripts/python scripts/set_secrets.py check      # which .env names are set (no values)
    venv/Scripts/python scripts/set_secrets.py webhook    # create TELEGRAM_WEBHOOK_SECRET in .env if empty
    venv/Scripts/python scripts/set_secrets.py github     # gh secret set (the 5 the job needs)
    venv/Scripts/python scripts/set_secrets.py worker-prod      # wrangler secret put, production Worker (6)
    venv/Scripts/python scripts/set_secrets.py worker-staging   # the staging Worker: .env with .env.staging on top
                                                                # (its own webhook secret; no GitHub dispatch token)

Each side gets only what it needs: the job never sees the Telegram token. Step 16: two Worker copies,
production and staging (wrangler.toml [env.staging]); staging never starts the job, so it gets no
GitHub token. Since Step 13 the Worker
also has the two AI keys (owner's choice): it checks a reader's new custom topic once, in a few
seconds, and logs every such call in ai_calls.
"""
from __future__ import annotations

import os
import re
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
GITHUB = ("GEMINI_API_KEY", "GROQ_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "D1_DATABASE_ID", "CLOUDFLARE_D1_TOKEN")
WORKER = ("TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "OWNER_TELEGRAM_ID", "GITHUB_DISPATCH_TOKEN",
          "GEMINI_API_KEY", "GROQ_API_KEY",   # Step 13: the custom-topic check
          # Step 17: the hourly check of the account's free limits (D1 rows, Worker CPU); a token with
          # Account Analytics Read only. Production only: the limits are per account, one check is enough.
          "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ANALYTICS_TOKEN")
WORKER_STAGING = tuple(k for k in WORKER if k not in ("GITHUB_DISPATCH_TOKEN", "CLOUDFLARE_ACCOUNT_ID",
                                                      "CLOUDFLARE_ANALYTICS_TOKEN"))
REPO = os.environ.get("AXIOM_REPO", "")   # owner/name; read from git remote if empty


def read_env(path: Path = ENV) -> dict[str, str]:
    env = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        m = re.match(r"\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$", line)
        if m and not line.lstrip().startswith("#"):
            v = m.group(2)
            if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                v = v[1:-1]
            env[m.group(1)] = v
    return env


def gh() -> str:
    return shutil.which("gh") or r"C:\Program Files\GitHub CLI\gh.exe"


def repo() -> str:
    if REPO:
        return REPO
    url = subprocess.run(["git", "remote", "get-url", "origin"], cwd=ROOT, capture_output=True,
                         text=True).stdout.strip()
    m = re.search(r"github\.com[/:]([^/]+/[^/.]+)", url)
    if not m:
        raise SystemExit("no GitHub remote 'origin' yet; set AXIOM_REPO=owner/name")
    return m.group(1)


def put(cmd: list[str], value: str, cwd: Path = ROOT) -> bool:
    r = subprocess.run(cmd, input=value, cwd=cwd, capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        # tool output never contains the value (it was sent on stdin), but trim it anyway
        print("   ", (r.stderr or r.stdout).strip().replace(value, "***")[:300])
    return r.returncode == 0


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    what = sys.argv[1] if len(sys.argv) > 1 else "check"
    env = read_env()
    if what == "check":
        for k in sorted(set(GITHUB) | set(WORKER)):
            print(f"{k:24} {'set' if env.get(k) else 'MISSING'}")
        return 0
    if what == "webhook":
        if env.get("TELEGRAM_WEBHOOK_SECRET"):
            print("TELEGRAM_WEBHOOK_SECRET already set; not changed")
            return 0
        value = secrets.token_urlsafe(36).replace("-", "A").replace("_", "B")   # Telegram allows A-Z a-z 0-9 _ -
        text = ENV.read_text(encoding="utf-8-sig")
        if re.search(r"^TELEGRAM_WEBHOOK_SECRET=.*$", text, flags=re.M):
            text = re.sub(r"^TELEGRAM_WEBHOOK_SECRET=.*$", f"TELEGRAM_WEBHOOK_SECRET={value}", text, flags=re.M)
        else:
            text = text.rstrip("\n") + f"\nTELEGRAM_WEBHOOK_SECRET={value}\n"
        ENV.write_text(text, encoding="utf-8")
        print("TELEGRAM_WEBHOOK_SECRET created in .env (value not shown)")
        return 0
    if what == "github":
        names, target = GITHUB, repo()
        cmd = lambda k: [gh(), "secret", "set", k, "--repo", target]  # noqa: E731
        cwd = ROOT
    elif what in ("worker-prod", "worker-staging"):
        staging = what == "worker-staging"
        names = WORKER_STAGING if staging else WORKER
        if staging:
            env.update(read_env(ROOT / ".env.staging"))
        wrangler = ROOT / "worker" / "node_modules" / "wrangler" / "bin" / "wrangler.js"
        node = shutil.which("node") or r"C:\Program Files\nodejs\node.exe"
        extra = ["--env", "staging"] if staging else []
        cmd = lambda k: [node, str(wrangler), "secret", "put", k, *extra]  # noqa: E731
        cwd = ROOT / "worker"
    else:
        print(__doc__)
        return 2
    failed = 0
    for k in names:
        if not env.get(k):
            print(f"{k:24} MISSING in .env, skipped")
            failed += 1
            continue
        ok = put(cmd(k), env[k], cwd)
        print(f"{k:24} {'ok' if ok else 'FAILED'}")
        failed += not ok
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
