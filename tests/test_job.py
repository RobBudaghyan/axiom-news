"""Real tests for the hourly job's branches (lesson 19): fallback, pending/retry, expiry,
partial failure, merges, best link, validation, feed cap. Run:

    venv/Scripts/python -m unittest discover tests -v
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job import ai  # noqa: E402
from job.fetch import normalize_url, select_new  # noqa: E402
from tests.helpers import (Clock, FakeProvider, FakeResponse, FakeSession, Feeds, entry,  # noqa: E402
                           grouping_responder, make_job, new_db)

RATE_LIMIT = ai.AIError("gemini", "HTTP 429: quota", kind="rate_limit", status=429)
GROQ_DOWN = ai.AIError("groq", "HTTP 503", kind="http", status=503)


def item_statuses(db) -> dict[str, str]:
    return {r["title"]: r["status"] for r in db.query("SELECT title, status FROM items")}


def last_run(db) -> dict:
    return db.query("SELECT * FROM job_runs ORDER BY id DESC LIMIT 1")[0]


class Base(unittest.TestCase):
    def setUp(self):
        self.db = new_db()
        self.clock = Clock()
        self.feeds = Feeds()
        now = self.clock()
        self.feeds.entries = [
            entry("beta", "IRAN: strike on base reported", 50, now),      # tier 2, earlier
            entry("alpha", "IRAN: base strike confirmed", 20, now),       # tier 1, later -> best link
            entry("gamma", "ARM: Yerevan passes budget", 30, now),
            entry("beta", "OFF: football result", 10, now),
        ]
        self.responder = grouping_responder({"IRAN": ["iran_war"], "ARM": ["armenia", "politics"]})


class HappyPath(Base):
    def test_gemini_creates_stories_best_link_and_drops_not_news(self):
        gem = FakeProvider("gemini", [self.responder])
        groq = FakeProvider("groq", [])
        stats = make_job(self.db, gem, groq, self.feeds, self.clock).run()

        stories = {r["summary"].split(":")[0]: r for r in self.db.query("SELECT * FROM stories")}
        self.assertEqual(set(stories), {"Summary of IRAN", "Summary of ARM"})
        iran = stories["Summary of IRAN"]
        self.assertEqual(iran["best_source"], "Alpha Times")            # tier 1 beats earlier tier 2
        self.assertIn("alpha.test", iran["best_url"])
        self.assertEqual(iran["source_count"], 2)
        self.assertEqual(json.loads(iran["topics"]), ["wars_conflicts", "iran_war"])  # lesson 8
        self.assertEqual(item_statuses(self.db)["OFF: football result"], "dropped")
        self.assertEqual(stats.items_unaccounted, 0)
        run = last_run(self.db)
        self.assertEqual((run["status"], run["provider"], run["stories_created"]), ("ok", "gemini", 2))
        calls = self.db.query("SELECT provider, ok FROM ai_calls")
        self.assertEqual(calls, [{"provider": "gemini", "ok": 1}])
        self.assertEqual(len(self.db.query("SELECT * FROM topics")), 6)

    def test_unrelated_item_never_wins_the_link(self):
        """Step 2 real case: an unrelated tier-1 article placed in a strike story by mistake."""
        from job.run import best_item
        items = [
            {"id": 1, "tier": 1, "published_at": 10, "title": "DraftKings bet has bulls reeling", "snippet": ""},
            {"id": 2, "tier": 2, "published_at": 20, "title": "Удар по Запорожью", "snippet": ""},
            {"id": 3, "tier": 2, "published_at": 30, "title": "Russian strike on Zaporizhzhia injures 30", "snippet": ""},
        ]
        summary = "Russian strikes on a residential building in Zaporizhzhia injured 30 people"
        self.assertEqual(best_item(items, summary)["id"], 3)       # matching English title
        self.assertEqual(best_item(items[:2], summary)["id"], 2)   # non-Latin beats a mismatch
        self.assertEqual(best_item(items)["id"], 1)                # no summary: plain tier order

    def test_tie_on_tier_picks_earliest(self):
        now = self.clock()
        self.feeds.entries = [entry("beta", "X: later", 5, now), entry("beta", "X: earlier", 40, now)]
        make_job(self.db, FakeProvider("gemini", [grouping_responder({})]), FakeProvider("groq", []),
                 self.feeds, self.clock).run()
        self.assertIn("x-earlier", self.db.query("SELECT best_url FROM stories")[0]["best_url"])


class Fallback(Base):
    def test_gemini_429_falls_back_to_groq(self):
        gem = FakeProvider("gemini", [RATE_LIMIT])
        groq = FakeProvider("groq", [self.responder])
        make_job(self.db, gem, groq, self.feeds, self.clock).run()
        run = last_run(self.db)
        self.assertEqual((run["status"], run["provider"], run["stories_created"]), ("ok", "groq", 2))
        calls = self.db.query("SELECT provider, ok FROM ai_calls ORDER BY id")
        self.assertEqual(calls, [{"provider": "gemini", "ok": 0}, {"provider": "groq", "ok": 1}])
        self.assertEqual(len(self.db.query("SELECT * FROM errors")), 1)
        self.assertNotIn("pending", item_statuses(self.db).values())

    def _gemini_with_body(self, body: dict) -> ai.GeminiProvider:
        # the same bad answer every time: 'empty' answers are retried once and 'truncated'
        # ones split in halves (bounded by the 4-call Gemini limit) before falling back
        session = FakeSession([FakeResponse(200, body) for _ in range(4)])
        return ai.GeminiProvider("k", "m", session=session, sleep=lambda s: None)

    def test_real_gemini_parser_blocked_or_empty_falls_back(self):
        """Lesson 2 with the real GeminiProvider code: empty/blocked responses are errors."""
        bodies = [
            {"promptFeedback": {"blockReason": "SAFETY"}},
            {"candidates": [{"finishReason": "SAFETY", "content": {"parts": []}}]},
            {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "  "}]}}]},
            {"candidates": []},
            {"candidates": [{"finishReason": "MAX_TOKENS", "content": {"parts": [{"text": "{\"sto"}]}}]},
        ]
        for body in bodies:
            with self.subTest(body=body):
                self.setUp()
                groq = FakeProvider("groq", [self.responder])
                make_job(self.db, self._gemini_with_body(body), groq, self.feeds, self.clock).run()
                run = last_run(self.db)
                self.assertEqual((run["status"], run["provider"]), ("ok", "groq"))
                self.assertEqual(len(groq.prompts), 1)

    def test_answer_that_skips_items_keeps_partial_work_and_resends_the_rest(self):
        now = self.clock()
        self.feeds.entries = [entry(("alpha", "beta", "gamma")[n % 3], f"K{n}: thing {n}", n, now)
                              for n in range(12)]
        # one story for 2 of 12 items, nothing listed as not-news: 10 items silently skipped
        def lazy(prompt):
            from tests.helpers import prompt_items
            ids = sorted(prompt_items(prompt).values())[:2]
            return {"stories": [{"item_ids": ids, "existing_story_id": None, "summary": "S",
                                 "topics": ["politics"], "importance": 5}], "not_news_ids": []}
        gem = FakeProvider("gemini", [lazy, lazy])
        groq = FakeProvider("groq", [grouping_responder({})])
        make_job(self.db, gem, groq, self.feeds, self.clock).run()
        run = last_run(self.db)
        # call 1 places 2 of 12 (kept), resends 10; call 2 places 2 of 10 (kept); Groq gets 8
        self.assertEqual([len(prompt_items_ids(pr)) for pr in gem.prompts], [12, 10])
        self.assertEqual(len(prompt_items_ids(groq.prompts[0])), 8)
        self.assertEqual((run["status"], run["provider"], run["stories_created"]), ("ok", "gemini+groq", 10))
        self.assertNotIn("pending", item_statuses(self.db).values())
        self.assertEqual(run["items_dropped"], 0)              # skipped items were never dropped

    def test_degenerate_all_not_news_answer_is_retried(self):
        """Seen for real in Step 2 run 1: 435 items, 0 stories, everything 'not news'."""
        now = self.clock()
        self.feeds.entries = [entry(("alpha", "beta", "gamma")[n % 3], f"K{n}: thing {n}", n, now)
                              for n in range(24)]
        def give_up(prompt):
            from tests.helpers import prompt_items
            return {"stories": [], "not_news_ids": list(prompt_items(prompt).values())}
        gem = FakeProvider("gemini", [give_up, grouping_responder({})])
        make_job(self.db, gem, FakeProvider("groq", []), self.feeds, self.clock).run()
        run = last_run(self.db)
        self.assertEqual((run["status"], run["provider"], run["stories_created"]), ("ok", "gemini", 24))
        self.assertEqual(self.db.query("SELECT ok FROM ai_calls ORDER BY id"), [{"ok": 0}, {"ok": 1}])

    def test_truncated_answer_splits_the_chunk(self):
        truncated = ai.AIError("gemini", "output truncated", kind="truncated")
        gem = FakeProvider("gemini", [truncated, self.responder, self.responder])
        make_job(self.db, gem, FakeProvider("groq", []), self.feeds, self.clock).run()
        self.assertEqual(len(gem.prompts), 3)
        self.assertEqual([len(prompt_items_ids(pr)) for pr in gem.prompts], [4, 2, 2])
        self.assertEqual(last_run(self.db)["status"], "ok")

    def test_all_not_news_is_a_valid_answer(self):
        def all_off(prompt):
            from tests.helpers import prompt_items
            return {"stories": [], "not_news_ids": list(prompt_items(prompt).values())}
        make_job(self.db, FakeProvider("gemini", [all_off]), FakeProvider("groq", []), self.feeds,
                 self.clock).run()
        run = last_run(self.db)
        self.assertEqual((run["status"], run["provider"], run["items_dropped"]), ("ok", "gemini", 4))

    def test_groq_413_splits_the_chunk_instead_of_giving_up(self):
        too_big = ai.AIError("groq", "HTTP 413: Request too large", kind="too_large", status=413)
        groq = FakeProvider("groq", [too_big, self.responder, self.responder])
        make_job(self.db, FakeProvider("gemini", [RATE_LIMIT]), groq, self.feeds, self.clock).run()
        run = last_run(self.db)
        self.assertEqual((run["status"], run["provider"]), ("ok", "groq"))
        self.assertEqual([len(prompt_items_ids(pr)) for pr in groq.prompts], [4, 2, 2])

    def test_invalid_json_falls_back(self):
        gem = FakeProvider("gemini", ["this is not json", "still not json"])
        groq = FakeProvider("groq", [self.responder])
        make_job(self.db, gem, groq, self.feeds, self.clock).run()
        self.assertEqual(last_run(self.db)["provider"], "groq")


class PendingAndRetry(Base):
    def test_both_fail_items_stay_pending_and_next_run_retries_them(self):
        job1 = make_job(self.db, FakeProvider("gemini", [RATE_LIMIT]), FakeProvider("groq", [GROQ_DOWN]),
                        self.feeds, self.clock)
        job1.run()
        run1 = last_run(self.db)
        self.assertEqual((run1["status"], run1["items_left_pending"], run1["stories_created"]),
                         ("ai_failed", 4, 0))
        self.assertEqual(set(item_statuses(self.db).values()), {"pending"})

        # One hour later: the feeds hold the same entries (nothing new), Gemini is back.
        self.clock.advance(1)
        gem = FakeProvider("gemini", [self.responder])
        make_job(self.db, gem, FakeProvider("groq", []), self.feeds, self.clock).run()
        run2 = last_run(self.db)
        self.assertEqual((run2["items_new"], run2["items_pending_in"]), (0, 4))
        self.assertEqual((run2["status"], run2["stories_created"], run2["items_left_pending"]), ("ok", 2, 0))
        self.assertEqual(len(gem.prompts), 1)                  # one call covered all retried items
        self.assertNotIn("pending", item_statuses(self.db).values())

    def test_pending_older_than_24h_expires_and_is_not_sent_to_ai(self):
        make_job(self.db, FakeProvider("gemini", [RATE_LIMIT]), FakeProvider("groq", [GROQ_DOWN]),
                 self.feeds, self.clock).run()
        self.clock.advance(25)
        self.feeds.entries = []
        gem = FakeProvider("gemini", [])           # must not be called: nothing left to process
        make_job(self.db, gem, FakeProvider("groq", []), self.feeds, self.clock).run()
        run = last_run(self.db)
        self.assertEqual((run["status"], run["items_expired"], run["items_pending_in"]), ("ok", 4, 0))
        self.assertEqual(set(item_statuses(self.db).values()), {"expired"})
        self.assertEqual(gem.prompts, [])

    def test_pending_younger_than_24h_is_kept(self):
        make_job(self.db, FakeProvider("gemini", [RATE_LIMIT]), FakeProvider("groq", [GROQ_DOWN]),
                 self.feeds, self.clock).run()
        self.clock.advance(23)
        make_job(self.db, FakeProvider("gemini", [RATE_LIMIT]), FakeProvider("groq", [GROQ_DOWN]),
                 self.feeds, self.clock).run()
        self.assertEqual(set(item_statuses(self.db).values()), {"pending"})

    def test_partial_failure_keeps_only_failed_chunk_pending(self):
        now = self.clock()
        self.feeds.entries = [entry("beta", f"K{n}: item number {n} " + "x" * 700, n, now) for n in range(6)]
        # tiny Gemini budget -> several chunks; first chunk OK, then rate limited; Groq down too
        gem = FakeProvider("gemini", [grouping_responder({}), RATE_LIMIT])
        groq = FakeProvider("groq", [GROQ_DOWN])
        make_job(self.db, gem, groq, self.feeds, self.clock, gemini_max_input_tokens=1,
                 groq_chunk_tokens=1).run()
        run = last_run(self.db)
        statuses = list(item_statuses(self.db).values())
        self.assertEqual(run["status"], "partial")
        self.assertEqual(statuses.count("done"), 1)            # chunk 1 = 1 item (budget forces 1/chunk)
        self.assertEqual(statuses.count("pending"), 5)
        self.assertEqual(run["items_left_pending"], 5)
        self.assertEqual(len(gem.prompts), 2)                  # stopped Gemini after the 429

    def test_content_failure_moves_only_that_chunk_to_groq(self):
        now = self.clock()
        self.feeds.entries = [entry("beta", f"K{n}: item {n} " + "x" * 700, n, now) for n in range(3)]
        truncated = ai.AIError("gemini", "output truncated", kind="truncated")
        gem = FakeProvider("gemini", [truncated, grouping_responder({}), grouping_responder({})])
        groq = FakeProvider("groq", [grouping_responder({})])
        make_job(self.db, gem, groq, self.feeds, self.clock, gemini_max_input_tokens=1,
                 groq_chunk_tokens=1).run()
        run = last_run(self.db)
        self.assertEqual((run["status"], run["provider"], run["stories_created"]), ("ok", "gemini+groq", 3))
        self.assertEqual((len(gem.prompts), len(groq.prompts)), (3, 1))


class Merge(Base):
    def test_new_item_merges_into_existing_story(self):
        now = self.clock()
        self.feeds.entries = [entry("gamma", "UA: drone strike on Kharkiv", 30, now)]
        make_job(self.db, FakeProvider("gemini", [grouping_responder({"UA": ["ukraine_war"]}, importance=5)]),
                 FakeProvider("groq", []), self.feeds, self.clock).run()
        story = self.db.query("SELECT * FROM stories")[0]
        self.assertEqual(story["best_source"], "Gamma Wire")

        self.clock.advance(1)
        self.feeds.entries.append(entry("alpha", "UA: Kharkiv strike toll rises", 10, self.clock()))
        gem = FakeProvider("gemini", [grouping_responder({"UA": ["ukraine_war", "russia"]}, importance=7,
                                                         merge={"UA": "Summary of UA"})])
        make_job(self.db, gem, FakeProvider("groq", []), self.feeds, self.clock).run()
        self.assertIn("Summary of UA", gem.prompts[0])        # existing story shown to the AI
        rows = self.db.query("SELECT * FROM stories")
        self.assertEqual(len(rows), 1)
        s = rows[0]
        self.assertEqual((s["source_count"], s["importance"], s["best_source"]), (2, 7, "Alpha Times"))
        self.assertEqual(s["summary"], "Summary of UA: drone strike on Kharkiv")  # empty AI summary keeps it
        self.assertEqual(json.loads(s["topics"]), ["wars_conflicts", "russia", "ukraine_war"])
        self.assertEqual(s["updated_at"], int(self.clock()))
        self.assertEqual(last_run(self.db)["stories_merged"], 1)

    def test_unknown_existing_id_becomes_new_story(self):
        def respond(prompt):
            ids = list(prompt_items_ids(prompt))
            return {"stories": [{"item_ids": ids, "existing_story_id": "S999", "summary": "S",
                                 "topics": ["politics"], "importance": 5}], "not_news_ids": []}
        make_job(self.db, FakeProvider("gemini", [respond]), FakeProvider("groq", []), self.feeds,
                 self.clock).run()
        self.assertEqual(len(self.db.query("SELECT * FROM stories")), 1)
        self.assertEqual(last_run(self.db)["stories_merged"], 0)


def prompt_items_ids(prompt):
    from tests.helpers import prompt_items
    return prompt_items(prompt).values()


class Validation(unittest.TestCase):
    ORDER = ["politics", "wars_conflicts", "armenia", "russia", "iran_war", "ukraine_war"]

    def test_rules(self):
        data = {"stories": [
            {"item_ids": [1, 2, 99], "topics": ["ukraine_war", "sport"], "importance": 15,
             "summary": "Strikes hit Kyiv — officials say 5 dead – more feared"},
            {"item_ids": [2, 3], "topics": ["politics"], "importance": 0, "summary": "dup id 2"},
            {"item_ids": [4], "topics": ["sport"], "importance": 5, "summary": "no valid tag"},
            {"item_ids": [], "topics": ["politics"], "importance": 5, "summary": "no items"},
            {"item_ids": [5], "topics": ["armenia"], "importance": "6", "existing_story_id": 77,
             "summary": "years 2024—2025"},
        ], "not_news_ids": []}
        out = ai.validate_stories(data, {1, 2, 3, 4, 5}, {77}, self.ORDER)
        self.assertEqual([s.item_ids for s in out], [[1, 2], [3], [5]])
        self.assertEqual(out[0].topics, ["wars_conflicts", "ukraine_war"])
        self.assertEqual((out[0].importance, out[1].importance, out[2].importance), (10, 1, 6))
        self.assertEqual(out[0].summary, "Strikes hit Kyiv, officials say 5 dead, more feared")
        self.assertEqual(out[2].summary, "years 2024-2025")
        self.assertEqual(out[2].existing_story_id, 77)
        for s in out:
            self.assertNotIn("—", s.summary)
            self.assertNotIn("–", s.summary)

    def test_parse_json_strips_fences_and_requires_stories(self):
        self.assertEqual(ai.parse_json('```json\n{"stories": []}\n```'), {"stories": []})
        with self.assertRaises(ValueError):
            ai.parse_json('{"items": []}')


class FeedSelection(unittest.TestCase):
    def test_cap_newest_per_feed_and_seen_skip(self):
        now = 1_800_000_000
        es = [entry("beta", f"T{n}", n, now, n) for n in range(12)]   # T0 newest
        picked = select_new(es, set(), 8)
        self.assertEqual([e.title for e in picked], [f"T{n}" for n in range(8)])
        seen = {e.url_hash for e in picked}
        self.assertEqual([e.title for e in select_new(es, seen, 8)], ["T8", "T9", "T10", "T11"])

    def test_normalize_url(self):
        self.assertEqual(normalize_url("HTTPS://Example.com/a/b/?utm_source=x&id=5#frag"),
                         "https://example.com/a/b?id=5")

    def test_lookback_window_on_first_and_later_runs(self):
        db, clock, feeds = new_db(), Clock(), Feeds()
        now = clock()
        feeds.entries = [entry("beta", "A: fresh", 60, now), entry("beta", "A: four hours old", 240, now)]
        make_job(db, FakeProvider("gemini", [grouping_responder({})]), FakeProvider("groq", []),
                 feeds, clock).run()
        self.assertEqual(set(item_statuses(db)), {"A: fresh"})       # first run: last 3 h only


class Providers(unittest.TestCase):
    def test_gemini_retries_503_then_succeeds(self):
        ok = {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": '{"stories": []}'}]}}],
              "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 3}}
        sleeps = []
        g = ai.GeminiProvider("k", "m", session=FakeSession([FakeResponse(503), FakeResponse(200, ok)]),
                              sleep=sleeps.append)
        res = g.generate("p", None)
        self.assertEqual((res.input_tokens, res.output_tokens, sleeps), (10, 3, [5]))

    def test_gemini_429_is_rate_limit_with_retry_delay(self):
        body = {"error": {"message": "quota", "details": [{"retryDelay": "23s"}]}}
        g = ai.GeminiProvider("k", "m", session=FakeSession([FakeResponse(429, body)]), sleep=lambda s: None)
        with self.assertRaises(ai.AIError) as cm:
            g.generate("p", None)
        self.assertEqual((cm.exception.kind, cm.exception.retry_after), ("rate_limit", 23.0))

    def test_groq_waits_out_short_429_then_succeeds(self):
        ok = {"choices": [{"finish_reason": "stop", "message": {"content": '{"stories": []}'}}],
              "usage": {"prompt_tokens": 9, "completion_tokens": 4}}
        sleeps = []
        session = FakeSession([FakeResponse(429, {"error": {"message": "TPM"}}, {"retry-after": "2"}),
                               FakeResponse(200, ok, {"x-ratelimit-remaining-tokens": "7000",
                                                      "x-ratelimit-reset-tokens": "7.5s"})])
        g = ai.GroqProvider("k", "m", session=session, sleep=sleeps.append)
        res = g.generate("p", None)
        self.assertEqual((res.input_tokens, sleeps, g.limits["x-ratelimit-reset-tokens"]), (9, [3.0], 7.5))

    def test_groq_413_is_too_large(self):
        g = ai.GroqProvider("k", "m", session=FakeSession([FakeResponse(413, {"error": {"message": "big"}})]))
        with self.assertRaises(ai.AIError) as cm:
            g.generate("p", None)
        self.assertEqual(cm.exception.kind, "too_large")


if __name__ == "__main__":
    unittest.main()
