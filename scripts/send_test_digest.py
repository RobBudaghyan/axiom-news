"""Local dev tool: build one digest from the D1 story pool and send it to the owner through
the TEST bot. It does what the Step 3 Worker cron will do for every user:

  - owner settings: all 6 topics, top 7, time zone DEFAULT_TIMEZONE (Asia/Yerevan)
  - stories: db/digest_query.sql (topics match, importance >= 4, since the last digest or
    at most 24 h, never sent before), most important first
  - message: greeting by local time, then "N. <summary> · <linked source name>" lines,
    HTML parse mode, link previews off; a one-line "Quiet period" note if nothing qualifies
  - after a successful send: `sent` rows (never twice) and users.last_digest_at

Usage:
    venv/Scripts/python scripts/send_test_digest.py --dry-run   # print only, writes nothing
    venv/Scripts/python scripts/send_test_digest.py             # send for real

Only ever run this with the TEST bot token in .env (lesson 11).
"""
from __future__ import annotations

import argparse
import html
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Callable
from zoneinfo import ZoneInfo

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from job.ai import clean_summary  # noqa: E402
from job.config import load_env, load_topics  # noqa: E402

DIGEST_SQL = (ROOT / "db" / "digest_query.sql").read_text(encoding="utf-8")
MAX_LOOKBACK_S = 24 * 3600
TELEGRAM_LIMIT = 4096
FORBIDDEN = ("—", "–")   # owner rule: no em dash (or en dash) in user-facing text


def greeting(local: datetime) -> str:
    if local.hour < 12:
        return "Good morning"
    if local.hour < 18:
        return "Good afternoon"
    return "Good evening"


def digest_since(last_digest_at: int | None, now: int) -> int:
    floor = now - MAX_LOOKBACK_S
    return max(last_digest_at, floor) if last_digest_at else floor


def select_stories(db, user_id: int, topics: list[str], since: int, limit: int) -> list[dict]:
    return db.query(DIGEST_SQL, [user_id, json.dumps(topics), since, limit])


def story_line(n: int, story: dict) -> str:
    summary = clean_summary(story["summary"]).rstrip(". ")
    url = html.escape(story["best_url"], quote=True)
    return f'{n}. {html.escape(summary, quote=False)} · <a href="{url}">{html.escape(story["best_source"], quote=False)}</a>'


def build_message(stories: list[dict], *, now: int, tz: str, last_digest_at: int | None) -> str:
    local_now = datetime.fromtimestamp(now, ZoneInfo(tz))
    hello = greeting(local_now)
    recent_last = last_digest_at is not None and now - last_digest_at <= MAX_LOOKBACK_S
    when = (f"since {datetime.fromtimestamp(last_digest_at, ZoneInfo(tz)):%H:%M}" if recent_last
            else "in the last 24 hours")
    if not stories:
        text = f"{hello}. Quiet period: nothing important on your topics {when}."
    else:
        count = f"{len(stories)} {'story' if len(stories) == 1 else 'stories'}"
        head = f"{hello}. {when[0].upper()}{when[1:]}, {count} on your topics:"
        text = "\n\n".join([head, "\n".join(story_line(n, s) for n, s in enumerate(stories, 1))])
    for ch in FORBIDDEN:
        assert ch not in text, "em/en dash in user-facing text"
    assert len(text) <= TELEGRAM_LIMIT, f"message too long ({len(text)} chars)"
    return text


def telegram_send(token: str, chat_id: int, text: str, session: requests.Session | None = None) -> dict:
    """sendMessage in HTML mode with link previews off. The token is part of Telegram's URL,
    so the URL is never printed; errors show only Telegram's status and description."""
    resp = (session or requests).post(
        f"https://api.telegram.org/bot{token}/sendMessage", timeout=30,
        json={"chat_id": chat_id, "text": text, "parse_mode": "HTML",
              "link_preview_options": {"is_disabled": True}})
    data = resp.json() if resp.content else {}
    if resp.status_code != 200 or not data.get("ok"):
        raise RuntimeError(f"Telegram HTTP {resp.status_code}: {data.get('description', '')}")
    return data["result"]


def ensure_owner(db, owner_id: int, topics: list[str], tz: str, now: int) -> dict:
    db.query("INSERT INTO users (id, first_name, timezone, topics, max_stories, created_at) "
             "VALUES (?, 'Owner', ?, ?, 7, ?) ON CONFLICT(id) DO UPDATE SET topics = excluded.topics, "
             "max_stories = excluded.max_stories", [owner_id, tz, json.dumps(topics), now])
    return db.query("SELECT * FROM users WHERE id = ?", [owner_id])[0]


def record_sent(db, user_id: int, story_ids: list[int], now: int) -> None:
    stmts = [("INSERT INTO sent (user_id, story_id, sent_at) VALUES (?, ?, ?) "
              "ON CONFLICT(user_id, story_id) DO NOTHING", [user_id, sid, now]) for sid in story_ids]
    stmts.append(("UPDATE users SET last_digest_at = ? WHERE id = ?", [now, user_id]))
    db.batch(stmts)


def run(db, *, owner_id: int, tz: str, now: int, dry_run: bool,
        send: Callable[[str], dict] | None, log: Callable[[str], None] = print) -> list[dict]:
    topics = [t["tag"] for t in load_topics()]
    if dry_run:
        rows = db.query("SELECT * FROM users WHERE id = ?", [owner_id])
        user = rows[0] if rows else {"last_digest_at": None, "max_stories": 7, "timezone": tz}
    else:
        user = ensure_owner(db, owner_id, topics, tz, now)
    since = digest_since(user["last_digest_at"], now)
    stories = select_stories(db, owner_id, topics, since, user["max_stories"])
    text = build_message(stories, now=now, tz=user["timezone"], last_digest_at=user["last_digest_at"])
    log(text)
    log(f"\n[{len(stories)} stories, {len(text)} chars]")
    if dry_run:
        log("[dry run: nothing sent, nothing written]")
        return stories
    result = send(text)
    log(f"[sent: Telegram message_id {result.get('message_id')}]")
    record_sent(db, owner_id, [s["id"] for s in stories], now)
    return stories


def main() -> int:
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    from job.d1 import D1
    env = load_env()
    db = D1(env["CLOUDFLARE_ACCOUNT_ID"], env["D1_DATABASE_ID"], env["CLOUDFLARE_D1_TOKEN"])
    owner = int(env["OWNER_TELEGRAM_ID"])
    token = env["TELEGRAM_BOT_TOKEN"]
    run(db, owner_id=owner, tz=env.get("DEFAULT_TIMEZONE") or "Asia/Yerevan", now=int(time.time()),
        dry_run=args.dry_run, send=lambda text: telegram_send(token, owner, text))
    return 0


if __name__ == "__main__":
    sys.exit(main())
