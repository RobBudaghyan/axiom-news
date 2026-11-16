"""Step 13: custom topics in the hourly job (job/custom.py, job/run.py) and the AI budget guard
(job/guard.py): which topics are searched, the request and item caps, pre-dedupe against the pool,
Google items in pass 1 and the editor, the custom-topic digest rule (no cap, Step 13 fixes), the switch, link resolution,
the 7-day cleanup, the guard's order and that no custom-topic failure ever fails the run.

    venv/Scripts/python -m unittest tests.test_custom -v
"""
from __future__ import annotations

import json
import random
import sys
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job import ai, custom, editor, gnews, guard, translate  # noqa: E402
from job.config import Settings, load_prompt  # noqa: E402
from job.run import ProviderPlan  # noqa: E402
from tests.helpers import (Clock, FakeProvider, Feeds, ROOT, T0, TOPICS, entry, grouping_responder,  # noqa: E402
                           make_job, new_db)

H = 3600
CFG = custom.load_config()
BUDGET = guard.load_budget()


def add_user(db, uid, paused=0, blocked=0, lang="en"):
    db.query("INSERT INTO users (id, first_name, topics, created_at, paused, blocked, lang) VALUES (?,?,?,?,?,?,?)",
             [uid, f"U{uid}", json.dumps(["politics"]), 1, paused, blocked, lang])


def add_topic(db, tid, name, queries=None, boost=2, searched_at=None, orphan_since=None):
    queries = queries if queries is not None else [{"q": name, "ed": "en"}, {"q": f"{name} news", "ed": "en_gb"}]
    db.query("INSERT INTO custom_topics (id, tag, names, emoji, definition, queries, boost_max, created_at, searched_at, "
             "orphan_since) VALUES (?,?,?,?,?,?,?,?,?,?)",
             [tid, f"c{tid}", json.dumps({"en": name, "ru": name, "hy": name, "fr": name}), "📌",
              f"News about {name}.", json.dumps(queries), boost, 1, searched_at, orphan_since])


def follow(db, uid, tid, enabled=1):
    db.query("INSERT INTO custom_follows (user_id, topic_id, at, enabled) VALUES (?,?,?,?)", [uid, tid, 1, enabled])


def gi(title, n=0, age_min=10, now=T0, source="Reuters"):
    return gnews.GItem(guid=f"g-{abs(hash((title, n))) % 10**9}", title=title, source=source,
                       source_url="https://reuters.test", link=f"https://news.google.com/rss/articles/{abs(hash((title, n))) % 10**9}?oc=5",
                       published_at=int(now - age_min * 60), has_snippet=False)


class FakeGoogle:
    """results: query text -> list of GItem (or an int HTTP status for a failure)."""

    def __init__(self, results=None, default=None):
        self.results = results or {}
        self.default = default if default is not None else []
        self.calls: list[tuple[str, str, str]] = []

    def __call__(self, query, window):
        self.calls.append((query["q"], query["ed"], window))
        r = self.results.get(query["q"], self.default)
        if isinstance(r, int):
            return gnews.Fetched(query, [], r, 5, f"HTTP {r}")
        if isinstance(r, Exception):
            raise r
        return gnews.Fetched(query, list(r), 200, 5)


def job_with(db, google=None, responder=None, editor_enabled=False, feeds=None, clock=None, **kw):
    gem = FakeProvider("gemini", [responder or grouping_responder({})] * 6)
    groq = FakeProvider("groq", [])
    j = make_job(db, gem, groq, feeds or Feeds(), clock or Clock(), editor_enabled=editor_enabled)
    j.gnews_fetcher = google or FakeGoogle()
    j.translate_enabled = False
    for k, v in kw.items():
        setattr(j, k, v)
    return j, gem


# ---------------------------------------------------------------- which topics are searched

class TestSearchScope(unittest.TestCase):
    def test_only_topics_with_an_active_unpaused_follower(self):
        db = new_db()
        add_user(db, 1)
        add_user(db, 2, paused=1)
        add_user(db, 3, blocked=1)
        for tid, name in ((1, "Colombia"), (2, "Peru"), (3, "Chile"), (4, "Bolivia")):
            add_topic(db, tid, name)
        follow(db, 1, 1)
        follow(db, 2, 2)
        follow(db, 3, 3)          # topic 4: nobody
        google = FakeGoogle()
        j, gem = job_with(db, google)
        j.run()
        self.assertEqual(sorted({q for q, _, _ in google.calls}), ["Colombia", "Colombia news"])
        self.assertEqual(j.topic_order[-1:], ["c1"])
        self.assertIn("c1: Colombia", gem.prompts[0] if gem.prompts else ai.reader_topics_block([t for t in j.ai_topics if t.get("custom")]))
        searched = {r["id"]: r["searched_at"] for r in db.query("SELECT id, searched_at FROM custom_topics")}
        self.assertEqual(searched[1], T0)
        self.assertTrue(all(searched[t] is None for t in (2, 3, 4)))

    def test_a_switched_off_follower_is_not_searched_for(self):
        """Step 13 fixes: the switch. Off = still in the reader's list, but not searched for them;
        another reader with the switch on still gets the searches."""
        db = new_db()
        add_user(db, 1)
        add_user(db, 2)
        add_topic(db, 1, "Japan")
        add_topic(db, 2, "Colombia")
        follow(db, 1, 1, enabled=0)          # Japan: its only follower switched it off
        follow(db, 1, 2, enabled=0)          # Colombia: off for reader 1 ...
        follow(db, 2, 2, enabled=1)          # ... on for reader 2
        google = FakeGoogle()
        j, gem = job_with(db, google)
        j.run()
        self.assertEqual(sorted({q for q, _, _ in google.calls}), ["Colombia", "Colombia news"])
        self.assertEqual([t.tag for t in j.custom_topics], ["c2"])
        self.assertEqual(j.custom_topics[0].active, 1, "only the reader with the switch on counts")
        self.assertNotIn("Japan", ai.reader_topics_block([t for t in j.ai_topics if t.get("custom")]))

    def test_no_follower_no_request_and_the_prompt_is_unchanged(self):
        db = new_db()
        add_topic(db, 1, "Colombia")
        google = FakeGoogle()
        db_items = Feeds()
        db_items.entries = [entry("alpha", "POL: Parliament votes", 10, T0)]
        j, gem = job_with(db, google, feeds=db_items)
        j.run()
        self.assertEqual(google.calls, [])
        self.assertNotIn("READER TOPICS", gem.prompts[0])
        p = load_prompt()
        old = p.template.replace("{reader_topics}", "")
        args = dict(today="2027-01-15", topics=TOPICS, facts=p.facts, facts_checked=p.facts_checked, existing=[],
                    items=[{"id": 1, "source_name": "A", "tier": 1, "title": "t", "snippet": None}])
        self.assertEqual(ai.render_prompt(p.template, **args), ai.render_prompt(old, **args))


class TestRequestCap(unittest.TestCase):
    def test_cap_whole_topics_and_rotation(self):
        db = new_db()
        add_user(db, 1)
        for tid in range(1, 21):
            add_topic(db, tid, f"Topic{tid}", [{"q": f"t{tid}-{k}", "ed": "en"} for k in range(3)])
            follow(db, 1, tid)
        topics = custom.load_active(db)
        google = FakeGoogle()
        s = custom.Searcher(db, cfg=CFG, fetcher=google, log=lambda _m: None)
        st = s.run(topics, T0)
        self.assertEqual(st.requests, 39)            # 13 whole topics of 3 under the cap of 40
        self.assertLessEqual(len(google.calls), CFG["max_requests_per_run"])
        first = {q.split("-")[0] for q, _, _ in google.calls}
        self.assertEqual(len(first), 13)
        google.calls.clear()
        st = s.run(custom.load_active(db), T0 + H)
        second = {q.split("-")[0] for q, _, _ in google.calls}
        self.assertEqual(len(second & first), 6, "the 7 not searched go first, then the oldest")
        self.assertTrue({f"t{i}" for i in range(14, 21)} <= second)

    def test_window_since_the_last_search(self):
        self.assertEqual(custom.window_hours(None, T0, CFG), 12)
        self.assertEqual(custom.window_hours(T0 - H, T0, CFG), 2)
        self.assertEqual(custom.window_hours(T0 - 3 * H - 60, T0, CFG), 5)
        self.assertEqual(custom.window_hours(T0 - 40 * H, T0, CFG), 12)

    def test_a_google_refusal_stops_the_rest(self):
        db = new_db()
        add_user(db, 1)
        for tid in range(1, 4):
            add_topic(db, tid, f"T{tid}", [{"q": f"q{tid}", "ed": "en"}])
            follow(db, 1, tid)
        cfg = {**CFG, "search_workers": 1}
        google = FakeGoogle({"q1": 429})
        st = custom.Searcher(db, cfg=cfg, fetcher=google, log=lambda _m: None).run(custom.load_active(db), T0)
        self.assertEqual(len(google.calls), 1)
        self.assertEqual(st.stopped, "Google answered 429")


class TestItems(unittest.TestCase):
    def setUp(self):
        self.db = new_db()
        add_user(self.db, 1)
        add_topic(self.db, 1, "Colombia", [{"q": "Colombia", "ed": "en"}])
        follow(self.db, 1, 1)

    def test_per_topic_cap_keeps_the_newest(self):
        rnd = random.Random(3)
        word = lambda: "".join(rnd.choice("bcdfghklmnprstvz") + rnd.choice("aeiou") for _ in range(4))
        items = [gi(f"{word()} {word()} {word()} {word()}", n, age_min=n) for n in range(30)]
        st = custom.Searcher(self.db, cfg=CFG, fetcher=FakeGoogle({"Colombia": items}), log=lambda _m: None).run(
            custom.load_active(self.db), T0)
        cap = CFG["max_items_per_topic"]
        self.assertEqual(st.stored, cap)
        self.assertEqual(st.capped, 30 - cap)
        rows = self.db.query("SELECT title FROM items")
        self.assertEqual({r["title"] for r in rows}, {items[n].title for n in range(cap)})

    def test_pre_dedupe_against_the_pool_and_earlier_results(self):
        self.db.query("INSERT INTO items (url_hash, source_key, source_name, tier, url, title, fetched_at, status) "
                      "VALUES ('x', 'alpha', 'Alpha', 1, 'https://a.test/1', ?, ?, 'done')",
                      ["Colombia's Petro wins Senate majority in election", T0 - H])
        dup = gi("Petro wins Senate majority in Colombia election")
        same_run = [gi("Earthquake hits Bogota, buildings damaged"), gi("Bogota earthquake damages buildings", 1)]
        fresh = gi("Colombian peso falls to record low against the dollar")
        google = FakeGoogle({"Colombia": [dup, *same_run, fresh]})
        s = custom.Searcher(self.db, cfg=CFG, fetcher=google, log=lambda _m: None)
        st = s.run(custom.load_active(self.db), T0)
        self.assertEqual(st.dup_dropped, 2)
        self.assertEqual(st.stored, 2)
        # the same Google article an hour later is not stored again
        st2 = s.run(custom.load_active(self.db), T0 + H)
        self.assertEqual((st2.seen_before, st2.dup_dropped, st2.stored), (2, 2, 0))
        day = self.db.query("SELECT * FROM custom_topic_days")[0]
        self.assertEqual((day["searches"], day["fetched"], day["dup_dropped"], day["new_items"]), (2, 8, 4, 2))

    def test_google_items_are_marked_headline_only_and_tier_4(self):
        custom.Searcher(self.db, cfg=CFG, fetcher=FakeGoogle({"Colombia": [gi("Colombia signs trade deal")]}),
                        log=lambda _m: None).run(custom.load_active(self.db), T0)
        r = self.db.query("SELECT * FROM items")[0]
        self.assertEqual((r["source_key"], r["tier"], r["headline_only"], r["hint_topic"], r["status"], r["source_name"]),
                         ("gnews", 4, 1, "c1", "pending", "Reuters"))
        self.assertIsNone(r["snippet"])
        self.assertTrue(r["url"].startswith("https://news.google.com/"))
        line = ai.item_line({"id": 5, "source_name": "Reuters", "tier": 4, "title": "Colombia signs trade deal",
                             "headline_only": 1})
        self.assertEqual(line, "5 | Reuters, tier 4 | Colombia signs trade deal [headline only]")


# ---------------------------------------------------------------- pass 1 and the editor

class TestAIPasses(unittest.TestCase):
    def test_pass1_sees_reader_topics_and_keeps_their_items(self):
        db = new_db()
        add_user(db, 1)
        add_topic(db, 1, "Colombia")
        add_topic(db, 2, "Formula 1", [{"q": "Formula 1", "ed": "en"}])
        follow(db, 1, 1)
        follow(db, 1, 2)
        google = FakeGoogle({"Formula 1": [gi("F1: Verstappen wins Abu Dhabi Grand Prix")],
                             "Colombia": [gi("COL: Colombia central bank cuts rates")]})
        j, gem = job_with(db, google, responder=grouping_responder({"F1": ["c2"], "COL": ["c1", "politics"]}))
        st = j.run()
        p = gem.prompts[0]
        self.assertIn("READER TOPICS", p)
        self.assertIn("   - c1: Colombia, News about Colombia.", p)
        self.assertIn("   - c2: Formula 1, News about Formula 1.", p)
        self.assertIn("this overrides the FILTER rule for them", p)
        self.assertIn("F1: Verstappen wins Abu Dhabi Grand Prix [headline only]", p)
        topics = sorted(json.loads(r["topics"]) for r in db.query("SELECT topics FROM stories"))
        self.assertEqual(topics, [["c2"], ["politics", "c1"]])
        self.assertEqual(st.stories_created, 2)

    def test_editor_prompt_floor_and_custom_main_topic(self):
        db = new_db()
        topics = TOPICS + [{"tag": "c1", "label": {"en": "Colombia"}, "definition": "News about Colombia.", "custom": True,
                            "boost_max": 2, "floor": 3}]
        t = int(T0 - H)
        ids = []
        for summary, tags, imp in (("Colombia peso slides", ["c1"], 3), ("Minor politics note", ["politics"], 3),
                                   ("Big vote", ["politics"], 6)):
            ids.append(db.query("INSERT INTO stories (summary, topics, importance, best_url, best_source, best_tier, "
                                "source_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id",
                                [summary, json.dumps(tags), imp, "https://x.test", "X", 2, 1, t, t])[0]["id"])
        answer = {"events": [{"ids": [f"S{ids[0]}"], "score": 4, "topic": "c1", "topic_score": 6, "headline": "Colombia peso slides",
                              "description": "", "emojis": "🇨🇴📉"},
                             {"ids": [f"S{ids[2]}"], "score": 6, "topic": "politics", "topic_score": 6, "headline": "Big vote",
                              "description": "", "emojis": "🗳️"}]}
        gem = FakeProvider("gemini", [answer])
        s = Settings()
        ed = editor.Editor(db, [ProviderPlan(gem, s.gemini_max_input_tokens, s.existing_max, 4)], topics=topics,
                           facts=["f"], facts_checked="2026-11-16", settings=s, log=lambda _m: None)
        res = ed.run(T0)
        p = gem.prompts[0]
        self.assertIn("and reader topics, which some readers added themselves", p)
        self.assertIn("   - c1: Colombia, News about Colombia.", p)
        # Step 13 fixes: no cap for reader topics; the topic score is "how important for someone who chose it"
        self.assertIn("reader topics (c1): the readers chose these subjects themselves", p)
        self.assertIn("ignore the boost rules above", p)
        self.assertIn("a sport (Formula 1): 8 a Grand Prix result", p)
        self.assertIn("a country (Japan, Colombia): 8 an election result", p)
        self.assertIn("a technology or field (AI regulation): 8 a major law passed", p)
        self.assertNotIn("up to the cap", p)
        self.assertIn(f"S{ids[0]} | c1", p)                     # importance 3 passes the custom floor
        self.assertNotIn(f"S{ids[1]} | politics", p)            # importance 3 politics does not
        self.assertEqual(res.status, "ok")
        row = db.query("SELECT main_topic, topic_score FROM stories WHERE id = ?", [ids[0]])[0]
        self.assertEqual((row["main_topic"], row["topic_score"]), ("c1", 6))

    def test_editor_prompt_unchanged_without_custom_topics(self):
        prompt = editor.load_editor_prompt()
        old = prompt.template.replace("{reader_topics}", "").replace("{reader_boost}", "")
        args = dict(today="2027-01-15", topics=TOPICS, facts=["f"], facts_checked="x", new=[], compare=[], items={})
        self.assertEqual(editor.render_prompt(prompt.template, **args), editor.render_prompt(old, **args))


# ---------------------------------------------------------------- the custom-topic digest rule (Step 13 fixes)

class TestCustomRule(unittest.TestCase):
    """Owner: for a custom main topic the topic score counts as it is (no boost cap, no "topic score
    above the score" rule); the bar stays 6. The 6 main topics keep the Step 8 rule."""

    def test_translate_eligibility_python_and_sql(self):
        db = new_db()
        t = int(T0 - H)
        base = translate.load_digest_config()
        tags = [x["tag"] for x in TOPICS] + ["c1"]
        cases = [   # (main topic, score, topic score, eligible)
            ("c1", 1, 8, True),          # a Grand Prix result: global 1, topic 8
            ("c1", 6, 6, True),          # equal to the score: fine for a custom topic
            ("c1", 3, 5, False),         # below the bar
            ("c1", 5, None, False),      # no topic score: the score 5 is below the bar
            ("armenia", 6, 6, False),    # a main topic still needs a boost (Step 8)
            ("armenia", 4, 8, True),     # ... and keeps its cap of 2: 6, above 4
            ("armenia", 3, 8, False),    # capped to 5
        ]
        ids = []
        for main, final, topic, _ in cases:
            ids.append(db.query("INSERT INTO stories (summary, topics, importance, best_url, best_source, best_tier, source_count, "
                                "created_at, updated_at, final_score, topic_score, main_topic, scored_at) "
                                "VALUES ('s', ?, 5, 'u', 'X', 2, 1, ?, ?, ?, ?, ?, ?) RETURNING id",
                                [json.dumps([main]), t, t, final, topic, main, t])[0]["id"])
        got = {r["id"] for r in db.query(translate.ELIGIBLE_SQL, translate.eligible_params(T0, base, tags))}
        for sid, (main, final, topic, want) in zip(ids, cases):
            story = db.query("SELECT * FROM stories WHERE id = ?", [sid])[0]
            self.assertEqual(translate.qualifies(story, base, tags), want, (main, final, topic))
            self.assertEqual(sid in got, want, ("SQL", main, final, topic))

    def test_no_boost_cap_from_the_topic_row(self):
        """The topic's old boost_max (0-2 from the check) no longer limits anything."""
        base = translate.load_digest_config()
        tags = [x["tag"] for x in TOPICS] + ["c1"]
        s = {"topics": ["c1"], "final_score": 2, "topic_score": 7, "main_topic": "c1", "importance": 3}
        self.assertTrue(translate.qualifies(s, {**base, "topic_boost_max": {**base["topic_boost_max"], "c1": 0}}, tags))


class TestLinks(unittest.TestCase):
    def add(self, db, url, state=None):
        return db.query("INSERT INTO stories (summary, topics, importance, best_url, best_source, best_tier, source_count, "
                        "created_at, updated_at, link_state) VALUES ('s', '[\"c1\"]', 5, ?, 'X', 4, 1, 1, 1, ?) RETURNING id",
                        [url, state])[0]["id"]

    def test_resolved_or_kept_and_tried_once(self):
        db = new_db()
        ok = self.add(db, "https://news.google.com/rss/articles/AAA?oc=5")
        bad = self.add(db, "https://news.google.com/rss/articles/BBB?oc=5")
        curated = self.add(db, "https://reuters.test/x")
        seen = []

        def resolver(link):
            seen.append(link)
            if "BBB" in link:
                raise ValueError("article page without signature")
            return "https://www.eltiempo.test/colombia/article-1"

        st = custom.resolve_links(db, [ok, bad, curated], cfg=CFG, resolver=resolver)
        self.assertEqual((st.tried, st.resolved, st.failed), (2, 1, 1))
        rows = {r["id"]: r for r in db.query("SELECT id, best_url, link_state FROM stories")}
        self.assertEqual((rows[ok]["best_url"], rows[ok]["link_state"]), ("https://www.eltiempo.test/colombia/article-1", 1))
        self.assertEqual((rows[bad]["best_url"], rows[bad]["link_state"]), ("https://news.google.com/rss/articles/BBB?oc=5", 2))
        self.assertIsNone(rows[curated]["link_state"])
        seen.clear()
        custom.resolve_links(db, [ok, bad, curated], cfg=CFG, resolver=resolver)
        self.assertEqual(seen, [], "each story is tried once")

    def test_a_google_answer_is_not_an_outlet_url_and_the_cap(self):
        db = new_db()
        ids = [self.add(db, f"https://news.google.com/rss/articles/X{n}") for n in range(14)]
        st = custom.resolve_links(db, ids, cfg=CFG, resolver=lambda link: "https://news.google.com/still")
        self.assertEqual((st.tried, st.failed), (10, 10))

    def test_only_digest_eligible_stories_in_the_job(self):
        db = new_db()
        add_user(db, 1)
        add_topic(db, 1, "Colombia")
        follow(db, 1, 1)
        t = int(T0 - H)
        weak = db.query("INSERT INTO stories (summary, topics, importance, best_url, best_source, best_tier, source_count, "
                        "created_at, updated_at, final_score) VALUES ('w', '[\"c1\"]', 3, 'https://news.google.com/rss/articles/W', "
                        "'X', 4, 1, ?, ?, 3) RETURNING id", [t, t])[0]["id"]
        strong = db.query("INSERT INTO stories (summary, topics, importance, best_url, best_source, best_tier, source_count, "
                          "created_at, updated_at, final_score, topic_score, main_topic, scored_at) VALUES ('s', '[\"c1\"]', 6, "
                          "'https://news.google.com/rss/articles/S', 'X', 4, 1, ?, ?, 5, 7, 'c1', ?) RETURNING id",
                          [t, t, t])[0]["id"]
        # a routine story (topic score 5, below the bar of 6) stays out of digests, so it is not resolved
        add_topic(db, 2, "Peru", boost=0)
        follow(db, 1, 2)
        db.query("INSERT INTO stories (summary, topics, importance, best_url, best_source, best_tier, source_count, "
                 "created_at, updated_at, final_score, topic_score, main_topic, scored_at) VALUES ('p', '[\"c2\"]', 6, "
                 "'https://news.google.com/rss/articles/P', 'X', 4, 1, ?, ?, 5, 5, 'c2', ?)", [t, t, t])
        seen = []
        j, _ = job_with(db, link_resolver=lambda link: seen.append(link) or "https://outlet.test/a")
        j.run()
        self.assertEqual(seen, ["https://news.google.com/rss/articles/S"])
        self.assertEqual(db.query("SELECT best_url FROM stories WHERE id = ?", [strong])[0]["best_url"], "https://outlet.test/a")
        self.assertIsNone(db.query("SELECT link_state FROM stories WHERE id = ?", [weak])[0]["link_state"])


# ---------------------------------------------------------------- cleanup

class TestCleanup(unittest.TestCase):
    def test_seven_days_without_followers(self):
        db = new_db()
        add_user(db, 1)
        add_topic(db, 1, "Six days", orphan_since=T0 - 6 * 86400)
        add_topic(db, 2, "Seven days", orphan_since=T0 - 7 * 86400)
        add_topic(db, 3, "Followed again", orphan_since=T0 - 9 * 86400)
        add_topic(db, 4, "Just left")
        follow(db, 1, 3)
        db.query("INSERT INTO custom_topic_days (topic_id, day, searches) VALUES (2, '2027-01-14', 3), (1, '2027-01-14', 2)")
        deleted = custom.cleanup(db, T0, CFG)
        self.assertEqual(deleted, 1)
        rows = {r["id"]: r["orphan_since"] for r in db.query("SELECT id, orphan_since FROM custom_topics")}
        self.assertEqual(sorted(rows), [1, 3, 4])
        self.assertIsNone(rows[3], "a follower stops the clock")
        self.assertEqual(rows[4], T0, "a topic with no follower starts its clock")
        self.assertEqual([r["topic_id"] for r in db.query("SELECT topic_id FROM custom_topic_days")], [1])
        self.assertEqual(custom.cleanup(db, T0 + 86400, CFG), 1)    # "Six days" is now seven

    def test_a_switched_off_follower_keeps_the_topic(self):
        """Step 13 fixes: deleted after 7 days only when NO reader has it in their list, on or off."""
        db = new_db()
        add_user(db, 1)
        add_topic(db, 1, "Off for its only reader", orphan_since=T0 - 9 * 86400)
        add_topic(db, 2, "Off, never orphaned")
        add_topic(db, 3, "Nobody", orphan_since=T0 - 8 * 86400)
        follow(db, 1, 1, enabled=0)
        follow(db, 1, 2, enabled=0)
        self.assertEqual(custom.cleanup(db, T0, CFG), 1)
        rows = {r["id"]: r["orphan_since"] for r in db.query("SELECT id, orphan_since FROM custom_topics")}
        self.assertEqual(sorted(rows), [1, 2])
        self.assertIsNone(rows[1], "a switched-off follower stops the clock")
        self.assertIsNone(rows[2], "and never starts it")
        self.assertEqual(custom.cleanup(db, T0 + 30 * 86400, CFG), 0)


# ---------------------------------------------------------------- the AI guard

class TestGuard(unittest.TestCase):
    def test_fixture_agrees_with_the_worker(self):
        data = json.loads((ROOT / "tests" / "fixtures" / "guard_cases.json").read_text(encoding="utf-8"))
        for c in data["cases"]:
            g = guard.assess(c["counts"], data["cfg"])
            self.assertEqual((g["level"], g["reasons"]), (c["level"], c["reasons"]))
        for d in data["days"]:
            self.assertEqual(guard.pacific_day(d["ts"]), (d["day"], d["start"]))

    def test_pacific_day_matches_the_tz_database(self):
        rnd = random.Random(5)
        la = ZoneInfo("America/Los_Angeles")
        for _ in range(3000):
            ts = 1_767_225_600 + rnd.randint(0, 4 * 365 * 86400)
            day, start = guard.pacific_day(ts)
            local = datetime.fromtimestamp(ts, la)
            self.assertEqual(day, local.strftime("%Y-%m-%d"))
            self.assertEqual(start, int(local.replace(hour=0, minute=0, second=0).timestamp()))

    def _calls(self, db, n, model="gemini-3.5-flash-lite", code=None, at=None):
        for _ in range(n):
            db.query("INSERT INTO ai_calls (at, provider, model, ok, kind, code) VALUES (?, 'gemini', ?, ?, 'batch', ?)",
                     [T0 if at is None else at, model, 0 if code else 1, code])

    def _run(self, db):
        feeds = Feeds()
        feeds.entries = [entry("alpha", "POL: Parliament votes", 10, T0)]
        j, gem = job_with(db, feeds=feeds)
        j.translate_enabled = True
        ran = []
        j.run_translate = lambda now, stats: ran.append(now)
        st = j.run()
        return st, ran, gem

    def test_level_1_delays_topic_checks_only(self):
        db = new_db()
        self._calls(db, 200)
        st, ran, gem = self._run(db)
        self.assertEqual(st.guard["level"], 1)
        self.assertEqual(len(ran), 1, "translations still run at level 1")
        self.assertFalse(st.translate_delayed)

    def test_level_2_delays_translations_never_pass1_or_the_editor(self):
        db = new_db()
        self._calls(db, 250)
        st, ran, gem = self._run(db)
        self.assertEqual(st.guard["level"], 2)
        self.assertEqual(ran, [])
        self.assertTrue(st.translate_delayed)
        self.assertEqual(len(gem.prompts), 1, "pass 1 ran")
        meta = json.loads(db.query("SELECT value FROM meta WHERE key = 'ai_guard'")[0]["value"])
        self.assertEqual((meta["level"], meta["translate_delayed"]), (2, True))

    def test_both_gemini_models_refusing_this_hour(self):
        db = new_db()
        self._calls(db, 1, code=429)
        self._calls(db, 1, model="gemini-3.1-flash-lite", code=429)
        st, ran, _ = self._run(db)
        self.assertEqual(st.guard["level"], 2)
        self.assertEqual(ran, [])

    def test_yesterday_does_not_count_and_the_run_s_own_calls_do(self):
        db = new_db()
        _, start = guard.pacific_day(T0)
        self._calls(db, 300, at=start - 60)
        self.assertEqual(guard.check(db, T0, BUDGET)["level"], 0)
        self.assertEqual(guard.check(db, T0, BUDGET, {"gemini-3.5-flash-lite": {"calls": 260}})["level"], 2)

    def test_an_editor_run_with_a_429_is_counted_by_code(self):
        db = new_db()
        feeds = Feeds()
        feeds.entries = [entry("alpha", "POL: Parliament votes", 10, T0)]
        gem = FakeProvider("gemini", [ai.AIError("gemini", "HTTP 429: quota", kind="rate_limit", status=429)])
        gem.model = "gemini-3.5-flash-lite"
        groq = FakeProvider("groq", [grouping_responder({})])
        j = make_job(db, gem, groq, feeds, Clock())
        j.translate_enabled = False
        st = j.run()
        rows = db.query("SELECT provider, code FROM ai_calls ORDER BY id")
        self.assertEqual([(r["provider"], r["code"]) for r in rows], [("gemini", 429), ("groq", None)])
        self.assertEqual(st.guard["level"], 1)


# ---------------------------------------------------------------- failures never fail the run

class TestNeverFails(unittest.TestCase):
    def _base(self):
        db = new_db()
        add_user(db, 1)
        add_topic(db, 1, "Colombia")
        follow(db, 1, 1)
        feeds = Feeds()
        feeds.entries = [entry("alpha", "POL: Parliament votes", 10, T0)]
        return db, feeds

    def _errors(self, db):
        return [r["message"] for r in db.query("SELECT message FROM errors WHERE component = 'custom'")]

    def test_a_crashing_google_fetcher(self):
        db, feeds = self._base()
        j, _ = job_with(db, FakeGoogle(default=RuntimeError("boom")), feeds=feeds)
        st = j.run()
        self.assertEqual(db.query("SELECT status FROM job_runs")[0]["status"], "ok")
        self.assertEqual(st.stories_created, 1)
        self.assertTrue(any("failed" in e or "error" in e for e in self._errors(db)) or st.custom.failed == 2)

    def test_a_broken_custom_table(self):
        db, feeds = self._base()
        db.query("DROP TABLE custom_follows")
        j, _ = job_with(db, feeds=feeds)
        st = j.run()
        self.assertEqual(db.query("SELECT status FROM job_runs")[0]["status"], "ok")
        self.assertEqual(j.topic_order, [t["tag"] for t in TOPICS])
        self.assertTrue(any("load failed" in e for e in self._errors(db)))
        self.assertTrue(any("cleanup failed" in e for e in self._errors(db)))

    def test_a_crashing_searcher_and_resolver(self):
        db, feeds = self._base()
        j, _ = job_with(db, feeds=feeds)
        orig = custom.Searcher.run
        custom.Searcher.run = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("search exploded"))
        try:
            j.run_resolve_links = lambda now, stats: stats.custom_errors.append("google links: x")
            st = j.run()
        finally:
            custom.Searcher.run = orig
        self.assertEqual(db.query("SELECT status FROM job_runs")[0]["status"], "ok")
        self.assertTrue(any("search exploded" in e for e in self._errors(db)))

    def test_a_google_429_is_reported_to_admin_not_fatal(self):
        db, feeds = self._base()
        j, _ = job_with(db, FakeGoogle({"Colombia": 429}), feeds=feeds)
        j.custom_cfg = {**CFG, "search_workers": 1}
        j.run()
        self.assertEqual(db.query("SELECT status FROM job_runs")[0]["status"], "ok")
        self.assertTrue(any("Google answered 429" in e for e in self._errors(db)))


if __name__ == "__main__":
    unittest.main()
