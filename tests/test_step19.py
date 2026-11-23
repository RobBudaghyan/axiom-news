"""Step 19 (owner): the main topics are Politics & Conflicts, Economy & Markets, Technology & AI,
Armenia, Iran War and Ukraine War. Russia is gone everywhere the job reads; Technology & AI has its
definition, boost cap, editor rules with 4/6/8 examples, pass-1 filter text and its own feeds."""
from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

import yaml

from job import ai, editor
from job.config import load_sources, load_topics

ROOT = Path(__file__).resolve().parent.parent
ORDER = ["politics_conflicts", "economy_markets", "tech_ai", "armenia", "iran_war", "ukraine_war"]
TECH_FEEDS = {"ft_tech", "bloomberg_tech", "wsj_tech", "nyt_tech", "guardian_tech", "mit_tech_review",
              "ars_technica", "wired_ai"}


class MainTopics(unittest.TestCase):
    def test_topics_yaml_order_defaults_and_labels(self):
        topics = load_topics()
        self.assertEqual([t["tag"] for t in topics], ORDER)
        self.assertTrue(all(t.get("default") for t in topics))
        tech = topics[2]
        self.assertEqual((tech["label"]["en"], tech["label"]["ru"], tech["emoji"]), ("Technology & AI", "Технологии и ИИ", "💻"))
        for word in ("artificial intelligence", "chips", "cybersecurity", "Not:"):
            self.assertIn(word, tech["definition"])

    def test_digest_config(self):
        cfg = json.loads((ROOT / "config" / "digest.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(cfg["topic_specificity"]), sorted(ORDER))
        self.assertEqual(sorted(cfg["topic_boost_max"]), sorted(ORDER))
        self.assertEqual(cfg["topic_boost_max"]["tech_ai"], 1)
        spec = cfg["topic_specificity"]
        self.assertLess(spec.index("tech_ai"), spec.index("economy_markets"))

    def test_no_russia_topic_left_in_what_the_job_reads(self):
        for rel in ("config/topics.yaml", "config/digest.json", "prompts/editor.md", "prompts/story_batch.md"):
            text = (ROOT / rel).read_text(encoding="utf-8")
            self.assertNotRegex(text, r"(?<![\w-])russia(?![\w-])", rel)
        for s in load_sources():
            self.assertNotIn("russia", s["topics"], s["key"])

    def test_editor_prompt_has_tech_rules_and_4_6_8_examples(self):
        text = (ROOT / "prompts" / "editor.md").read_text(encoding="utf-8")
        self.assertIn("- tech_ai: +1 at most", text)
        line = text[text.index('   - tech_ai: "'):]
        line = line[:line.index("\n   - ", 5)]
        topic_scores = {int(m) for m in re.findall(r'" \d+, (\d+)', line)}
        self.assertTrue({4, 6, 8} <= topic_scores, topic_scores)
        # the anchor examples themselves: an 8 (chip export ban), a 6 (a big chip deal), a 4 (a small funding round)
        for anchor in ('advanced AI chips to China" 8, 8;', 'chip designer for 20 billion dollars" 6, 6;', 'for AI\n     agents" 3, 4;'):
            self.assertIn(anchor, line)
        self.assertIn("Russia's domestic news is politics_conflicts", text)
        self.assertNotIn("armenia, russia", text)

    def test_pass1_filter_keeps_wide_impact_tech(self):
        text = (ROOT / "prompts" / "story_batch.md").read_text(encoding="utf-8")
        self.assertIn("Technology with wide impact IS\n   news (tech_ai)", text)
        self.assertIn("Gadget\n   reviews", text)
        self.assertNotIn("(technology outages", text)

    def test_tech_feeds_enabled_tier_and_caps(self):
        src = {s["key"]: s for s in load_sources()}
        self.assertTrue(TECH_FEEDS <= set(src), TECH_FEEDS - set(src))
        for k in TECH_FEEDS:
            self.assertEqual(src[k]["topics"], ["tech_ai"], k)
            self.assertIn(src[k]["tier"], (1, 2))
        self.assertEqual(src["bloomberg_tech"]["max_items"], 4)
        self.assertEqual(len(TECH_FEEDS), 8)

    def test_rendered_prompts_list_tech_not_russia(self):
        topics = load_topics()
        p1 = ai.render_prompt("{topic_list}", today="2026-11-23", topics=topics, facts=[], facts_checked="",
                              existing=[], items=[])
        ed = editor.render_prompt("{topic_list}", today="2026-11-23", topics=topics, facts=[], facts_checked="",
                                  new=[], compare=[], items={})
        self.assertIn("   - tech_ai: Technology with wide impact", p1)
        self.assertIn("   - tech_ai: Technology & AI", ed)
        for text in (p1, ed):
            self.assertNotIn("russia", text)

    def test_dictionaries(self):
        for lang in ("en", "ru", "fr", "hy"):
            d = json.loads((ROOT / "config" / "i18n" / f"{lang}.json").read_text(encoding="utf-8"))
            self.assertEqual(list(d["topics"]), ORDER, lang)
            self.assertNotRegex(d["bot"]["description"], "Russia|Россия|Russie|Ռուսաստան")
            self.assertLessEqual(len(d["bot"]["description"]), 512)


if __name__ == "__main__":
    unittest.main()
