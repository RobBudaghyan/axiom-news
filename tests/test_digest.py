"""Tests for the digest selection (db/digest_query.sql) and message format, using the
real SQL on an in-memory database with the real schema."""
from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from tests.helpers import new_db  # noqa: E402

spec = importlib.util.spec_from_file_location("send_test_digest", ROOT / "scripts" / "send_test_digest.py")
digest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(digest)

TZ = "Asia/Yerevan"
ALL = ["politics", "wars_conflicts", "armenia", "russia", "iran_war", "ukraine_war"]
OWNER = 42


def yerevan(h: int, m: int = 0) -> int:
    return int(datetime(2026, 11, 13, h, m, tzinfo=ZoneInfo(TZ)).timestamp())


def add_story(db, summary, topics, importance, updated_at, source="Alpha Times", url="https://a.test/x"):
    return db.query(
        "INSERT INTO stories (summary, topics, importance, best_url, best_source, best_tier, "
        "best_published_at, source_count, created_at, updated_at) VALUES (?,?,?,?,?,1,NULL,1,?,?) "
        "RETURNING id", [summary, json.dumps(topics), importance, url, source, updated_at, updated_at])[0]["id"]


class Selection(unittest.TestCase):
    def setUp(self):
        self.db = new_db()
        self.now = yerevan(14, 5)
        t = self.now - 3600
        self.ids = {
            "big": add_story(self.db, "Big", ["iran_war", "wars_conflicts"], 8, t),
            "mid_new": add_story(self.db, "Mid newer", ["armenia"], 5, t + 60),
            "mid_old": add_story(self.db, "Mid older", ["russia"], 5, t),
            "low": add_story(self.db, "Low", ["politics"], 3, t),                     # importance < 4
            "old": add_story(self.db, "Old", ["politics"], 9, self.now - 25 * 3600),  # > 24 h
            "sent": add_story(self.db, "Already sent", ["politics"], 9, t),
        }
        self.db.query("INSERT INTO sent (user_id, story_id, sent_at) VALUES (?, ?, ?)",
                      [OWNER, self.ids["sent"], t])

    def summaries(self, topics=ALL, limit=7, since=None):
        since = since if since is not None else digest.digest_since(None, self.now)
        return [r["summary"] for r in digest.select_stories(self.db, OWNER, topics, since, limit)]

    def test_filters_and_order(self):
        self.assertEqual(self.summaries(), ["Big", "Mid newer", "Mid older"])

    def test_topic_filter(self):
        self.assertEqual(self.summaries(topics=["armenia", "ukraine_war"]), ["Mid newer"])

    def test_limit(self):
        self.assertEqual(self.summaries(limit=2), ["Big", "Mid newer"])

    def test_since_last_digest(self):
        self.assertEqual(self.summaries(since=self.now - 3600 + 30), ["Mid newer"])

    def test_sent_to_other_user_does_not_block(self):
        self.assertIn("Already sent",
                      [r["summary"] for r in digest.select_stories(self.db, 7, ALL, self.now - 86400, 7)])

    def test_since_is_capped_at_24h(self):
        self.assertEqual(digest.digest_since(None, self.now), self.now - 86400)
        self.assertEqual(digest.digest_since(self.now - 5 * 86400, self.now), self.now - 86400)
        self.assertEqual(digest.digest_since(self.now - 3600, self.now), self.now - 3600)


class Message(unittest.TestCase):
    STORY = {"id": 1, "summary": "Israel and Iran agree a 30-day ceasefire — Qatar mediated.",
             "best_url": "https://ft.test/a?x=1&y=2", "best_source": "Financial Times"}

    def test_format_greeting_and_link(self):
        text = digest.build_message([self.STORY, {**self.STORY, "summary": "A <b> & C"}],
                                    now=yerevan(20, 30), tz=TZ, last_digest_at=yerevan(14, 0))
        lines = text.split("\n")
        self.assertEqual(lines[0], "Good evening. Since 14:00, 2 stories on your topics:")
        self.assertEqual(lines[2], '1. Israel and Iran agree a 30-day ceasefire, Qatar mediated · '
                                   '<a href="https://ft.test/a?x=1&amp;y=2">Financial Times</a>')
        self.assertTrue(lines[3].startswith("2. A &lt;b&gt; &amp; C · <a "))
        self.assertNotIn("—", text)
        self.assertNotIn("–", text)

    def test_greetings_by_local_hour(self):
        for hour, word in ((9, "Good morning"), (11, "Good morning"), (12, "Good afternoon"),
                           (17, "Good afternoon"), (18, "Good evening")):
            with self.subTest(hour=hour):
                self.assertTrue(digest.build_message([self.STORY], now=yerevan(hour), tz=TZ,
                                                     last_digest_at=None).startswith(word))

    def test_first_digest_and_quiet_period(self):
        first = digest.build_message([self.STORY], now=yerevan(9), tz=TZ, last_digest_at=None)
        self.assertTrue(first.startswith("Good morning. In the last 24 hours, 1 story on your topics:"))
        quiet = digest.build_message([], now=yerevan(14, 5), tz=TZ, last_digest_at=yerevan(9))
        self.assertEqual(quiet, "Good afternoon. Quiet period: nothing important on your topics since 09:00.")


class SendAndNeverTwice(unittest.TestCase):
    def test_send_records_sent_and_second_digest_is_quiet(self):
        db = new_db()
        now = yerevan(14, 5)
        add_story(db, "One", ["politics"], 6, now - 600)
        add_story(db, "Two", ["armenia"], 5, now - 300)
        outbox = []
        send = lambda text: outbox.append(text) or {"message_id": len(outbox)}  # noqa: E731
        stories = digest.run(db, owner_id=OWNER, tz=TZ, now=now, dry_run=False, send=send, log=lambda m: None)
        self.assertEqual([s["summary"] for s in stories], ["One", "Two"])
        self.assertEqual(len(db.query("SELECT * FROM sent WHERE user_id=?", [OWNER])), 2)
        self.assertEqual(db.query("SELECT last_digest_at FROM users")[0]["last_digest_at"], now)
        # the same stories are never sent again, even if they are updated later
        db.query("UPDATE stories SET updated_at = ?", [now + 60])
        again = digest.run(db, owner_id=OWNER, tz=TZ, now=now + 120, dry_run=False, send=send,
                           log=lambda m: None)
        self.assertEqual(again, [])
        self.assertIn("Quiet period", outbox[-1])

    def test_failed_send_records_nothing(self):
        db = new_db()
        now = yerevan(14, 5)
        add_story(db, "One", ["politics"], 6, now - 600)
        def boom(text):
            raise RuntimeError("Telegram HTTP 400")
        with self.assertRaises(RuntimeError):
            digest.run(db, owner_id=OWNER, tz=TZ, now=now, dry_run=False, send=boom, log=lambda m: None)
        self.assertEqual(db.query("SELECT * FROM sent"), [])

    def test_dry_run_writes_nothing(self):
        db = new_db()
        add_story(db, "One", ["politics"], 6, yerevan(14))
        digest.run(db, owner_id=OWNER, tz=TZ, now=yerevan(14, 5), dry_run=True, send=None, log=lambda m: None)
        self.assertEqual((db.query("SELECT * FROM users"), db.query("SELECT * FROM sent")), ([], []))


if __name__ == "__main__":
    unittest.main()
