"""Step 17: D1 reads. The heavy queries must use an index (no full scan of the story pool, the items
or `sent`), the rewritten "new since" windows must still find a story whose score came late, and
the read profile must fold IN-lists into one shape."""
from __future__ import annotations

import io
import json
import time
import unittest
from contextlib import redirect_stdout

from job import custom, translate
from job.d1 import profile_key
from job.translate import load_digest_config
from scripts import d1_plan
from tests.helpers import T0, new_db

DAY = 86400


def add_story(db, sid: int, updated_at: int, scored_at: int | None, *, topics=("armenia",), final=8,
              main="armenia", headline="Yerevan story"):
    db.conn.execute(
        "INSERT INTO stories (id, summary, topics, importance, best_url, best_source, best_tier, created_at, "
        "updated_at, final_score, topic_score, scored_at, main_topic, headline) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [sid, f"s{sid}", json.dumps(list(topics)), 8, "https://x.test", "X", 1, updated_at - 60, updated_at,
         final, final, scored_at, main, headline])
    db.conn.commit()


class NoFullScans(unittest.TestCase):
    def test_heavy_queries_use_an_index(self):
        out = io.StringIO()
        with redirect_stdout(out):
            db = d1_plan.local_db(int(time.time()), stories=1500, items=3000)
            now = int(time.time())
            ids = [r["id"] for r in db.query("SELECT id FROM stories ORDER BY id DESC LIMIT 50")]
            for name, sql, params in d1_plan.cases(now, ids):
                plan = " | ".join(str(p["detail"]) for p in db.query("EXPLAIN QUERY PLAN " + sql, params))
                with self.subTest(query=name):
                    for table in ("stories", "items", "sent", "s"):
                        self.assertNotRegex(plan, rf"(^| \| )SCAN {table}( |$)(?!USING INDEX idx_items_pending)",
                                            f"{name} reads the whole table: {plan}")


class LateScoreWindow(unittest.TestCase):
    """updated_at long ago, scored_at inside the window: still found (the Step 8 rule), via the
    two indexed terms that replaced max(updated_at, scored_at)."""

    def setUp(self):
        self.db = new_db()
        add_story(self.db, 1, T0 - 3 * DAY, T0 - 3600)          # old story, scored an hour ago
        add_story(self.db, 2, T0 - 3 * DAY, T0 - 3 * DAY)       # old and scored long ago
        add_story(self.db, 3, T0 - 600, None)                   # fresh, not scored yet

    def test_translation_eligible(self):
        cfg = load_digest_config()
        tags = ["armenia", "russia"]
        rows = self.db.query(translate.ELIGIBLE_SQL, translate.eligible_params(T0, cfg, tags))
        self.assertIn(1, [r["id"] for r in rows])
        self.assertNotIn(2, [r["id"] for r in rows])

    def test_keyword_enforce_window(self):
        db = new_db()
        add_story(db, 1, T0 - 3 * DAY, T0 - 3600, topics=("armenia", "c7"), main="c7")
        add_story(db, 2, T0 - 3 * DAY, T0 - 3 * DAY, topics=("armenia", "c7"), main="c7")
        add_story(db, 3, T0 - 600, None, topics=("armenia", "c7"), main="c7")
        got = sorted(r["id"] for r in db.query(custom.ENFORCE_SQL, [T0 - 26 * 3600]))
        self.assertEqual(got, [1, 3])


class Profile(unittest.TestCase):
    def test_in_lists_fold(self):
        a = profile_key("SELECT a FROM t WHERE id IN (?,?,?)")
        b = profile_key("SELECT a FROM t WHERE id IN (?, ?)")
        self.assertEqual(a, b)
        self.assertEqual(profile_key("INSERT INTO t (a,b) VALUES (?,?),(?,?) ON CONFLICT DO NOTHING"),
                         profile_key("INSERT INTO t (a,b) VALUES (?,?) ON CONFLICT DO NOTHING"))


if __name__ == "__main__":
    unittest.main()
