"""The Google News parser and the no-AI title check (job/gnews.py), used by custom topics (Step 13).
Moved here from tests/test_shadow.py when the Step 6 shadow experiment was removed (Step 15)."""
from __future__ import annotations

import unittest

from job import gnews

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


class TestSimilarity(unittest.TestCase):
    def test_same_and_different(self):
        ix = gnews.TitleIndex([(1, "Armenia and Turkey close to opening border, Pashinyan says"),
                               (2, "Пашинян: Армения и Турция близки к открытию границы"),
                               (3, "Russian drones hit Kharkiv power plant")])
        self.assertGreaterEqual(ix.best("Pashinyan says Armenia, Turkey close to opening border")[0], 0.6)
        self.assertEqual(ix.best("Пашинян: Армения и Турция близки к открытию границы")[1], 2)
        self.assertLess(ix.best("Armenia wins football match against Cyprus")[0], 0.6)
        self.assertEqual(ix.best("Earthquake in Chile")[0], 0.0)


if __name__ == "__main__":
    unittest.main()
