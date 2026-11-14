"""Step 6 shadow collection (job/shadow.py) and the Google News parser (job/gnews.py)."""
from __future__ import annotations

import time
import unittest

from job import gnews, shadow
from tests.helpers import T0, Clock, new_db

FEED = """<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
<title>"Armenia when:2h" - Google News</title>
<item><title>Armenia and Turkey near deal to open border - JAMnews</title>
<link>https://news.google.com/rss/articles/CBMiAAA?oc=5</link><guid isPermaLink="false">CBMiAAA</guid>
<pubDate>Sat, 14 Nov 2026 03:34:27 GMT</pubDate>
<description>&lt;a href="https://news.google.com/rss/articles/CBMiAAA?oc=5"&gt;Armenia and Turkey near deal to open border&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;JAMnews&lt;/font&gt;</description>
<source url="https://jam-news.net">JAMnews</source></item>
<item><title>Пашинян описал будущее Армении - Вестник Кавказа</title>
<link>https://news.google.com/rss/articles/CBMiBBB?oc=5</link><guid isPermaLink="false">CBMiBBB</guid>
<pubDate>Sat, 14 Nov 2026 04:00:00 GMT</pubDate><description>x</description>
<source url="https://vestikavkaza.ru">Вестник Кавказа</source></item>
</channel></rss>""".encode("utf-8")

SOURCES = [{"key": "jam", "name": "Some Outlet", "url": "https://feeds.jam-news.net/rss", "tier": 2},
           {"key": "bbc", "name": "BBC News", "url": "https://feeds.bbci.co.uk/news/rss.xml", "tier": 1}]
CFG = {"enabled": True, "window": "2h", "timeout_s": 5,
       "editions": {"en": {"hl": "en-US", "gl": "US", "ceid": "US:en"}, "ru": {"hl": "ru", "gl": "RU", "ceid": "RU:ru"}},
       "topics": {"armenia": [{"q": "Armenia", "ed": "en"}, {"q": "Пашинян", "ed": "ru"}],
                  "politics": [{"q": "border deal", "ed": "en"}]}}
LIVE_TABLES = ("users", "topics", "items", "stories", "sent", "job_runs", "ai_calls", "meta", "errors")


def gi(guid: str, title: str, source: str = "Outlet", site: str = "https://outlet.test", age_min: float = 10) -> gnews.GItem:
    return gnews.GItem(guid, title, source, site, f"https://news.google.com/rss/articles/{guid}",
                       int(T0 - age_min * 60), False)


class FakeGoogle:
    """Per query text, the items Google 'returns'. A query listed in `fail` gets HTTP 503."""

    def __init__(self, results: dict[str, list[gnews.GItem]], fail: set[str] = frozenset(), slow: float = 0):
        self.results, self.fail, self.slow, self.calls = results, set(fail), slow, 0

    def __call__(self, q: dict, window):
        self.calls += 1
        if self.slow:
            time.sleep(self.slow)
        if q["q"] in self.fail:
            return gnews.Fetched(q, [], 503, 5, "HTTP 503")
        return gnews.Fetched(q, list(self.results.get(q["q"], [])), 200, 5)


def counts(db) -> dict[str, int]:
    return {t: db.query(f"SELECT count(*) AS n FROM {t}")[0]["n"] for t in LIVE_TABLES}


def add_live_item(db, title: str, fetched_at: int = T0 - 3600) -> int:
    return db.query("INSERT INTO items (url_hash, source_key, source_name, tier, url, title, fetched_at, status) "
                    "VALUES (?, 'k', 'K', 1, 'https://k.test/a', ?, ?, 'done') RETURNING id",
                    [f"h{title}", title, fetched_at])[0]["id"]


class TestParse(unittest.TestCase):
    def test_real_format(self):
        items = gnews.parse(FEED)
        self.assertEqual(len(items), 2)
        a, b = items
        self.assertEqual(a.title, "Armenia and Turkey near deal to open border")
        self.assertEqual((a.source, a.source_url, a.guid), ("JAMnews", "https://jam-news.net", "CBMiAAA"))
        self.assertFalse(a.has_snippet)                    # Google gives no snippet
        self.assertEqual(a.published_at, 1794627267)
        self.assertEqual(b.title, "Пашинян описал будущее Армении")

    def test_search_url(self):
        url = gnews.search_url("Karabakh OR \"Armenia Azerbaijan\"", "en-US", "US", "US:en", "2h")
        self.assertEqual(url, "https://news.google.com/rss/search?q=Karabakh+OR+%22Armenia+Azerbaijan%22+when%3A2h"
                              "&hl=en-US&gl=US&ceid=US%3Aen")

    def test_config_queries(self):
        qs = gnews.query_list(gnews.load_queries())
        self.assertGreaterEqual(len(qs), 20)
        self.assertEqual({q["topic"] for q in qs},
                         {"politics", "wars_conflicts", "armenia", "russia", "iran_war", "ukraine_war"})
        self.assertEqual(len({q["key"] for q in qs}), len(qs))


class TestSimilarity(unittest.TestCase):
    def test_same_and_different(self):
        ix = gnews.TitleIndex([(1, "Armenia and Turkey close to opening border, Pashinyan says"),
                               (2, "Пашинян: Армения и Турция близки к открытию границы"),
                               (3, "Russian drones hit Kharkiv power plant")])
        self.assertGreaterEqual(ix.best("Pashinyan says Armenia, Turkey close to opening border")[0], 0.6)
        self.assertEqual(ix.best("Пашинян: Армения и Турция близки к открытию границы")[1], 2)
        self.assertLess(ix.best("Armenia wins football match against Cyprus")[0], 0.6)
        self.assertEqual(ix.best("Earthquake in Chile")[0], 0.0)


class TestShadow(unittest.TestCase):
    def make(self, google, db=None, clock=None, **kw):
        db = db or new_db()
        return db, shadow.Shadow(db, cfg=CFG, sources=SOURCES, fetcher=google, clock=clock or Clock(),
                                 log=lambda *_: None, **kw)

    def test_writes_only_shadow_tables(self):
        db = new_db()
        add_live_item(db, "Unrelated live story about Chile")
        before = counts(db)
        google = FakeGoogle({"Armenia": [gi("g1", "Armenia and Turkey near deal to open border")]})
        _, sh = self.make(google, db)
        st = sh.run()
        self.assertEqual(counts(db), before)               # no live table touched
        self.assertEqual(st.new_items, 1)
        self.assertEqual(db.query("SELECT count(*) AS n FROM shadow_items")[0]["n"], 1)
        run = db.query("SELECT * FROM shadow_runs")[0]
        self.assertEqual((run["queries"], run["new_items"], run["unique_items"]), (3, 1, 1))

    def test_same_article_from_two_queries_is_one_row(self):
        same = gi("g1", "Armenia and Turkey near deal to open border")
        db, sh = self.make(FakeGoogle({"Armenia": [same], "border deal": [same]}))
        st = sh.run()
        rows = db.query("SELECT topic, topics, hits FROM shadow_items")
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["topic"], rows[0]["topics"], rows[0]["hits"]), ("armenia", '["armenia", "politics"]', 2))
        self.assertEqual((st.fetched, st.distinct), (2, 1))

    def test_seen_in_an_earlier_run_is_not_stored_again(self):
        clock = Clock()
        google = FakeGoogle({"Armenia": [gi("g1", "Armenia and Turkey near deal to open border")]})
        db, sh = self.make(google, clock=clock)
        sh.run()
        clock.advance(1)
        google.results["Armenia"].append(gi("g2", "Yerevan hosts a regional energy summit"))
        st = sh.run()
        self.assertEqual((st.seen_before, st.new_items), (1, 1))
        self.assertEqual(db.query("SELECT count(*) AS n FROM shadow_items")[0]["n"], 2)

    def test_title_duplicates_of_live_pool_and_of_earlier_shadow(self):
        db = new_db()
        live_id = add_live_item(db, "Armenia and Turkey close to opening border, Pashinyan says")
        clock = Clock()
        google = FakeGoogle({"Armenia": [gi("g1", "Pashinyan says Armenia, Turkey close to opening border"),
                                         gi("g2", "Yerevan hosts a regional energy summit")]})
        _, sh = self.make(google, db, clock)
        st = sh.run()
        rows = {r["guid"]: r for r in db.query("SELECT * FROM shadow_items")}
        self.assertEqual(rows["g1"]["dup"], "live")
        self.assertEqual(rows["g1"]["live_item_id"], live_id)
        self.assertIsNone(rows["g2"]["dup"])
        self.assertEqual((st.dup_live, st.unique_items), (1, 1))
        clock.advance(1)                                   # another outlet, same summit, an hour later
        google.results["Armenia"] = [gi("g3", "Regional energy summit hosted in Yerevan", source="Other")]
        st = sh.run()
        row = db.query("SELECT * FROM shadow_items WHERE guid = 'g3'")[0]
        self.assertEqual((row["dup"], row["shadow_dup_of"]), ("shadow", rows["g2"]["id"]))
        self.assertEqual(st.dup_shadow, 1)

    def test_old_live_items_are_not_compared(self):
        db = new_db()
        add_live_item(db, "Yerevan hosts a regional energy summit", fetched_at=T0 - 30 * 3600)
        _, sh = self.make(FakeGoogle({"Armenia": [gi("g1", "Yerevan hosts a regional energy summit")]}), db)
        self.assertEqual(sh.run().unique_items, 1)

    def test_curated_outlet_flag(self):
        db, sh = self.make(FakeGoogle({"Armenia": [gi("g1", "Armenia news one", site="https://jam-news.net"),
                                                   gi("g2", "Armenia news two", source="BBC News", site="https://www.bbc.com"),
                                                   gi("g3", "Armenia news three", site="https://new-outlet.am")]}))
        sh.run()
        flags = {r["guid"]: r["curated_outlet"] for r in db.query("SELECT guid, curated_outlet FROM shadow_items")}
        self.assertEqual(flags, {"g1": 1, "g2": 1, "g3": 0})

    def test_failed_queries_are_recorded_not_raised(self):
        db, sh = self.make(FakeGoogle({"Armenia": [gi("g1", "Armenia news one")]}, fail={"Пашинян"}))
        st = sh.run()
        self.assertEqual((st.queries_failed, st.new_items), (1, 1))
        run = db.query("SELECT codes, error FROM shadow_runs")[0]
        self.assertIn('"503": 1', run["codes"])
        self.assertIn("HTTP 503", run["error"])
        self.assertEqual(db.query("SELECT count(*) AS n FROM errors")[0]["n"], 0)   # never the live log

    def test_crashing_fetcher_never_raises(self):
        def boom(q, w):
            raise RuntimeError("network gone")
        db, sh = self.make(boom)
        st = sh.run()
        self.assertEqual((st.queries_failed, st.new_items), (3, 0))
        self.assertIn("error: RuntimeError", db.query("SELECT error FROM shadow_runs")[0]["error"])

    def test_database_failure_never_raises(self):
        db, sh = self.make(FakeGoogle({"Armenia": [gi("g1", "Armenia news one")]}))
        db.executescript("DROP TABLE items")               # the comparison read fails
        st = sh.run()
        self.assertTrue(any("OperationalError" in e for e in st.errors))

    def test_time_budget(self):
        db, sh = self.make(FakeGoogle({"Armenia": [gi("g1", "Armenia news one")]}, slow=0.6), budget_s=0.3)
        t = time.time()
        st = sh.run()
        self.assertLess(time.time() - t, 0.55)             # does not wait for the slow answers
        self.assertEqual(st.queries_failed, 3)
        self.assertIn("over the time budget", " ".join(st.errors))

    def test_dry_run_writes_nothing(self):
        db, sh = self.make(FakeGoogle({"Armenia": [gi("g1", "Armenia news one")]}))
        st = sh.run(dry_run=True)
        self.assertEqual(st.new_items, 1)
        self.assertEqual(db.query("SELECT count(*) AS n FROM shadow_items")[0]["n"], 0)
        self.assertEqual(db.query("SELECT count(*) AS n FROM shadow_runs")[0]["n"], 0)

    def test_min_gap_and_prune(self):
        clock = Clock()
        db, sh = self.make(FakeGoogle({"Armenia": [gi("g1", "Armenia news one")]}), clock=clock)
        sh.run()
        self.assertIsNotNone(sh.recent_run(int(clock()) + 600))
        self.assertIsNone(sh.recent_run(int(clock()) + 3000))
        clock.advance(24 * 4)                              # 4 days later: g1 is older than 3 days
        sh.run()
        self.assertEqual(db.query("SELECT count(*) AS n FROM shadow_items WHERE guid='g1'")[0]["n"], 0)

    def test_disabled(self):
        db = new_db()
        sh = shadow.Shadow(db, cfg={**CFG, "enabled": False}, sources=SOURCES, fetcher=FakeGoogle({}),
                           log=lambda *_: None)
        sh.run()
        self.assertEqual(db.query("SELECT count(*) AS n FROM shadow_runs")[0]["n"], 0)


if __name__ == "__main__":
    unittest.main()
