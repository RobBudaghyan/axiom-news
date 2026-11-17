"""Tests for the editor pass (job/editor.py, Step 5): candidate choice, answer validation and the
fact guard, merge writes (never twice), the fallback chain and a failed editor call.

    venv/Scripts/python -m unittest tests.test_editor -v
"""
from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job import ai, editor  # noqa: E402
from job.config import Settings  # noqa: E402
from job.run import ProviderPlan  # noqa: E402
from tests.helpers import (Clock, FakeProvider, Feeds, T0, TOPICS, entry, grouping_responder,  # noqa: E402
                           make_job, new_db, prompt_items)

TOPIC_ORDER = [t["tag"] for t in TOPICS]
OVERLOAD = ai.AIError("gemini", "HTTP 503: high demand", kind="http", status=503)
H = 3600
CAND = re.compile(r"^S\d+ \|")


def add_story(db, summary, topics, importance=6, *, age_h=1.0, tier=2, source="Beta News", edited=None,
              items=(), now=T0):
    """A story plus its articles. items: (source_name, tier, title, snippet)."""
    t = int(now - age_h * H)
    sid = db.query(
        "INSERT INTO stories (summary, topics, importance, best_url, best_source, best_tier, best_published_at, "
        "source_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id",
        [summary, json.dumps(topics), importance, f"https://{source.split()[0].lower()}.test/{t}", source, tier,
         t, max(1, len(items)), t, t])[0]["id"]
    for n, (src, tr, title, snip) in enumerate(items or [(source, tier, summary, "")]):
        db.query("INSERT INTO items (url_hash, source_key, source_name, tier, url, title, snippet, published_at, "
                 "fetched_at, status, story_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                 [f"h{sid}-{n}", "k", src, tr, f"https://x.test/{sid}/{n}", title, snip, t, t, "done", sid])
    if edited:
        db.query("UPDATE stories SET final_score=?, headline=?, description=?, emojis=?, edited_at=? WHERE id=?",
                 [edited["score"], edited.get("headline"), edited.get("description"), edited.get("emojis"),
                  t, sid])
    return sid


def story(db, sid) -> dict:
    return db.query("SELECT * FROM stories WHERE id = ?", [sid])[0]


def make_editor(db, providers, settings=None):
    s = settings or Settings()
    plans = [ProviderPlan(p, s.gemini_max_input_tokens, s.existing_max, 4) for p in providers]
    calls = []
    ed = editor.Editor(db, plans, topics=TOPICS, facts=["fact"], facts_checked="2026-11-14", settings=s,
                       on_call=lambda p, ok, n, res, err: calls.append((p.name, ok, n, err)),
                       log=lambda _m: None)
    return ed, calls


def answer(*events, topic="") -> dict:
    return {"events": [{"ids": [f"S{i}" for i in ids], "score": score, "headline": head, "topic": topic,
                        "description": desc, "emojis": emo} for ids, score, head, desc, emo in events]}


class Candidates(unittest.TestCase):
    def setUp(self):
        self.db = new_db()

    def test_small_topic_always_represented_and_caps(self):
        for i in range(30):
            add_story(self.db, f"Politics story {i}", ["politics_conflicts"], 7, age_h=1 + i / 10)
        arm = add_story(self.db, "Armenia story", ["armenia", "politics_conflicts"], 4)
        pool = editor.Editor(self.db, [], topics=TOPICS, facts=[], facts_checked="x").pool(T0)
        new, compare = editor.choose(pool, TOPIC_ORDER, new_max=10, per_topic=3, compare_max=5)
        self.assertEqual(len(new), 10)
        self.assertIn(arm, [s["id"] for s in new])        # the weakest story, but the topic's best
        self.assertEqual(compare, [])

    def test_edited_stories_come_only_as_comparison_and_nothing_new_means_skip(self):
        a = add_story(self.db, "Edited high", ["politics_conflicts"], 6, edited={"score": 8, "headline": "H"})
        b = add_story(self.db, "Edited low", ["politics_conflicts"], 6, edited={"score": 3, "headline": "L"})
        pool = editor.Editor(self.db, [], topics=TOPICS, facts=[], facts_checked="x").pool(T0)
        self.assertEqual(editor.choose(pool, TOPIC_ORDER, 10, 3, 5), ([], []))   # nothing new: no call
        c = add_story(self.db, "New one", ["russia"], 5)
        pool = editor.Editor(self.db, [], topics=TOPICS, facts=[], facts_checked="x").pool(T0)
        new, compare = editor.choose(pool, TOPIC_ORDER, 10, 3, 1)
        self.assertEqual([s["id"] for s in new], [c])
        self.assertEqual([s["id"] for s in compare], [a])               # highest final score first
        self.assertNotIn(b, [s["id"] for s in compare])

    def test_merged_old_and_low_stories_are_not_candidates(self):
        add_story(self.db, "Old", ["politics_conflicts"], 7, age_h=30)
        add_story(self.db, "Low", ["politics_conflicts"], 3)
        m = add_story(self.db, "Merged", ["politics_conflicts"], 7)
        self.db.query("UPDATE stories SET merged_into = 1 WHERE id = ?", [m])
        pool = editor.Editor(self.db, [], topics=TOPICS, facts=[], facts_checked="x").pool(T0)
        self.assertEqual(pool, [])

    def test_prompt_shows_articles_and_edited_text_but_not_the_first_pass_score(self):
        new = add_story(self.db, "Armenia and Turkey near deal", ["armenia"], 9,
                        items=[("Alpha Times", 1, "Armenia, Turkey close to border deal", "Pashinyan said")])
        old = add_story(self.db, "Older", ["politics_conflicts"], 6, edited={"score": 7, "headline": "Kept headline"})
        ed, _ = make_editor(self.db, [])
        pool = ed.pool(T0)
        n, c = editor.choose(pool, TOPIC_ORDER, 10, 3, 5)
        items = editor.load_items(self.db, [new, old], 3)
        text = editor.render_prompt(ed.prompt.template, today="2026-11-14", topics=TOPICS, facts=["F1"],
                                    facts_checked="2026-11-14", new=n, compare=c, items=items)
        self.assertIn(f"S{new} | armenia\n", text)
        self.assertIn("- Alpha Times, tier 1 | Armenia, Turkey close to border deal :: Pashinyan said", text)
        self.assertIn(f"S{old} | politics_conflicts | EDITED: score 7, headline: Kept headline", text)
        self.assertNotIn(" | 9 |", text)


class Validation(unittest.TestCase):
    SRC = [("Alpha Times", 1, "Russia and US sign grain deal in Geneva", "The deal covers 1,200 tonnes")]

    def setUp(self):
        self.db = new_db()
        self.a = add_story(self.db, "Russia and US sign a grain deal", ["russia"], items=self.SRC)
        self.b = add_story(self.db, "Grain deal signed", ["politics_conflicts"], items=self.SRC)
        self.by_id = {s["id"]: s for s in editor.Editor(self.db, [], topics=TOPICS, facts=[],
                                                         facts_checked="x").pool(T0)}
        self.items = editor.load_items(self.db, list(self.by_id), 3)

    def check(self, data):
        return editor.validate_events(data, self.by_id, self.items)

    def test_ids_scores_and_text_cleanup(self):
        evs, left = self.check({"events": [
            {"ids": [f"S{self.a}", 999, f"S{self.a}"], "score": 15, "headline": "Russia and US sign grain deal — in Geneva.",
             "description": "The deal covers 1,200 tonnes. It was signed in Geneva. More. Even more.", "emojis": "🇷🇺 🇺🇸 🤝"},
            {"ids": [str(self.a), str(self.b)], "score": "x", "headline": "h", "description": "", "emojis": ""},
        ]})
        self.assertEqual(len(evs), 1)                      # the scoreless event is ignored
        e = evs[0]
        self.assertEqual(e.ids, [self.a])                  # unknown 999 and the repeat dropped
        self.assertEqual(e.score, 10)                      # clamped
        self.assertEqual(e.headline, "Russia and US sign grain deal, in Geneva")
        self.assertEqual(e.description, "The deal covers 1,200 tonnes. It was signed in Geneva. More.")
        self.assertEqual(e.emojis, "🇷🇺🇺🇸🤝")
        self.assertEqual(left, [])     # b was named (in the scoreless event): mentioned, stays unedited

    def test_fact_guard_drops_invented_numbers_and_names(self):
        evs, _ = self.check(answer(
            ([self.a], 6, "Russia and US sign grain deal", "The deal covers 5,000 tonnes.", "🇷🇺"),
            ([self.b], 6, "Macron hails grain deal", "Officials in Geneva said the deal covers 1,200 tonnes.", "🌾")))
        self.assertIsNone(evs[0].description)              # 5,000 is not in the articles
        self.assertEqual(evs[0].headline, "Russia and US sign grain deal")
        self.assertIsNone(evs[1].headline)                 # Macron is not in the articles -> summary used
        self.assertEqual(evs[1].description, "Officials in Geneva said the deal covers 1,200 tonnes.")
        self.assertEqual(len(evs[0].dropped) + len(evs[1].dropped), 2)

    def test_fact_guard_accepts_acronyms_first_names_and_demonyms(self):
        src = ("Tayyip Erdogan met officials at the Asia-Pacific Economic Cooperation summit. "
               "The F.A.A. grounded flights. Iran said so. AI-generated images spread.")
        for text in ["Officials said Recep Tayyip Erdogan spoke at the APEC summit.",
                     "Flights were grounded by The Federal Aviation Administration.",
                     "Officials said Iranian ships left.",
                     "Officials said AI-made images spread."]:
            self.assertEqual(editor.unknown_facts(text, src, True), [], text)
        self.assertEqual(editor.unknown_facts("Officials said Macron came.", src, False), [])  # non-Latin: numbers only

    def test_step15_ordinary_capitalised_words_at_a_sentence_start_pass(self):
        # Real drops from the live errors log (2026-11), with the stories' own article texts.
        cases = [
            ("Severe air pollution left residents with headaches and breathing difficulties.",
             "Toxic air chokes Iranian cities, residents report health problems :: Worsening air pollution "
             "across Iran has left citizens reporting headaches, nausea and breathing difficulties"),
            ("Recent central bank minutes temper expectations for rate cuts.",
             "Australian Dollar: RBA minutes temper easing bets. RBA minutes suggest the central bank is "
             "tempering expectations for interest rate cuts."),
            ("Hundreds of residential buildings in Kyiv's Darnytskyi district remain without heating.",
             "317 Buildings in Kyiv's Darnytskyi District left without heating after Russian attack :: A total "
             "of 317 residential buildings in Kyiv's Darnytskyi district remain without heating"),
            ("Escalating border clashes raise fears of a regional war.",
             "Ethiopia-Eritrea border clashes raise fears of regional war :: As Ethiopian troops push Tigrayan "
             "forces toward the Eritrean border, fears of a new regional war are growing."),
            ("Investors moved into megacap tech before the drawdown.",
             "Tepper, Loeb among fund managers piling into Nvidia and other megacap tech on the eve of October drawdown"),
            ("Growing air links create a favourable climate for Boeing orders.",
             "Can Xi-Trump talks at Apec turn China's pledge to buy 200 Boeing jets into firm orders? :: China's "
             "expanding air links ... creating a more favourable"),
            ("Official data show wage growth slowed to 3.5%.", "UK Wage Growth Slows to 3.5% in Three Months to September"),
            ("Pence said the Republican Party must return to high standards.",
             "Pence says Trump administration has 'air of corruption' and GOP must return to 'high standards'"),
            ("The Russian Foreign Ministry says the West uses education against sovereignty.",
             "Color revolutions now built into Western playbook, Russian MFA :: education as instruments for "
             "undermining sovereignty, Russian Deputy Foreign Minister"),
        ]
        for text, src in cases:
            self.assertEqual(editor.unknown_facts(text, src, True), [], text)

    def test_step15_invented_names_are_still_dropped(self):
        src = "Toxic air chokes Iranian cities :: Worsening air pollution across Iran has left citizens with headaches"
        self.assertEqual(editor.unknown_facts("Erdogan said the air is toxic.", src, True), ["Erdogan"])
        self.assertEqual(editor.unknown_facts("Severe smog hit Tehran and Isfahan.", src, True), ["Tehran", "Isfahan"])
        self.assertEqual(editor.unknown_facts("Moscow blamed the smog on Washington.", src, True), ["Moscow", "Washington"])
        self.assertEqual(editor.unknown_facts("Severe smog left 40 people ill.", src, True), ["40"])
        self.assertIn("severe", editor.COMMON_WORDS)
        self.assertFalse({"moscow", "kyiv", "pashinyan", "trump", "putin"} & editor.COMMON_WORDS)

    def test_emojis(self):
        self.assertEqual(editor.clean_emojis("🇷🇺🇺🇸🤝📝🎉"), "🇷🇺🇺🇸🤝📝")      # at most 4
        self.assertEqual(editor.clean_emojis("🗣️ ☢️"), "🗣️☢️")               # VS16 kept
        self.assertEqual(editor.clean_emojis("👩‍⚕️"), "👩‍⚕️")                 # ZWJ sequence is one
        self.assertEqual(editor.clean_emojis("RU 🤝"), "")                    # letters: rejected
        self.assertEqual(editor.clean_emojis("🇷"), "")                       # half a flag

    def test_roundup_event_is_ignored(self):
        ids = [add_story(self.db, f"Story {i}", ["politics_conflicts"]) for i in range(7)]
        by_id = {s["id"]: s for s in editor.Editor(self.db, [], topics=TOPICS, facts=[],
                                                    facts_checked="x").pool(T0)}
        evs, left = editor.validate_events(answer((ids, 5, "Various developments", "", "")), by_id, {})
        self.assertEqual(evs, [])
        self.assertEqual(set(ids) <= set(left), True)

    def test_an_edited_story_keeps_its_text_when_the_answer_leaves_it_empty(self):
        e = add_story(self.db, "Edited", ["politics_conflicts"], edited={"score": 7, "headline": "Old head",
                                                                 "description": "Old desc.", "emojis": "🏛️"})
        ed, _ = make_editor(self.db, [FakeProvider("gemini", [lambda p: answer(([e], 6, "", "", ""),
                                                                                 ([self.a, self.b], 5, "Grain deal", "", "🌾"))])])
        res = ed.run(T0)
        self.assertEqual(res.status, "ok")
        s = story(self.db, e)
        self.assertEqual((s["final_score"], s["headline"], s["description"], s["emojis"]), (6, "Old head", "Old desc.", "🏛️"))

    def test_a_repeated_headline_with_empty_fields_does_not_wipe_them(self):
        e = add_story(self.db, "Edited", ["politics_conflicts"], edited={"score": 7, "headline": "Old head",
                                                                 "description": "Old desc.", "emojis": "🏛️"})
        ed, _ = make_editor(self.db, [FakeProvider("gemini", [lambda p: answer(([e], 7, "Edited", "", ""),
                                                                                 ([self.a, self.b], 5, "Grain deal", "", "🌾"))])])
        ed.run(T0)
        s = story(self.db, e)
        self.assertEqual((s["headline"], s["description"], s["emojis"]), ("Edited", "Old desc.", "🏛️"))


class MainTopic(unittest.TestCase):
    def test_the_editor_names_the_main_topic_which_is_added_to_the_tags(self):
        db = new_db()
        s = add_story(db, "Trump, Putin and Xi to meet in China", ["iran_war", "economy_markets"], 8)
        bad = add_story(db, "Other", ["russia"], 6)
        ed, _ = make_editor(db, [FakeProvider("gemini", [{"events": [
            {"ids": [f"S{s}"], "score": 8, "topic": "politics_conflicts", "headline": "Trump, Putin and Xi to meet in China",
             "description": "", "emojis": ""},
            {"ids": [f"S{bad}"], "score": 5, "topic": "sports", "headline": "Other", "description": "", "emojis": ""}]}])])
        ed.run(T0)
        row = story(db, s)
        self.assertEqual(row["main_topic"], "politics_conflicts")
        self.assertEqual(json.loads(row["topics"]), ["politics_conflicts", "economy_markets", "iran_war"])
        self.assertIsNone(story(db, bad)["main_topic"])                # unknown tag ignored


class Writes(unittest.TestCase):
    def setUp(self):
        self.db = new_db()
        self.old = add_story(self.db, "Strike on Kharkiv kills 3", ["ukraine_war", "economy_markets"], 6,
                             age_h=5, tier=2, source="Beta News",
                             items=[("Beta News", 2, "Russian strike on Kharkiv kills 3", "")])
        self.new = add_story(self.db, "Kharkiv strike death toll rises to 3", ["russia"], 7, age_h=1, tier=1,
                             source="Alpha Times", items=[("Alpha Times", 1, "Kharkiv strike toll rises to 3", "")])
        self.other = add_story(self.db, "Armenia budget passed", ["armenia"], 5)
        self.db.query("INSERT INTO sent (user_id, story_id, sent_at) VALUES (7, ?, ?)", [self.new, T0 - 600])

    def test_merge_keeps_the_oldest_copies_sent_rows_and_best_link(self):
        third = add_story(self.db, "Earlier merged dup", ["ukraine_war"], 5, age_h=2)
        self.db.query("UPDATE stories SET merged_into = ? WHERE id = ?", [self.new, third])
        gem = FakeProvider("gemini", [answer(([self.new, self.old], 7, "Russian strike on Kharkiv kills 3",
                                              "The death toll rose to 3.", "🇷🇺🇺🇦💥"),
                                             ([self.other], 4, "Armenia passes its budget", "", "🇦🇲💰"))])
        ed, calls = make_editor(self.db, [gem])
        res = ed.run(T0)
        self.assertEqual((res.status, res.edited, res.merged, res.provider), ("ok", 2, 1, "gemini"))
        lead, kid = story(self.db, self.old), story(self.db, self.new)
        self.assertEqual(kid["merged_into"], self.old)                 # the oldest story is kept
        self.assertEqual(story(self.db, third)["merged_into"], self.old)   # re-pointed
        self.assertIsNone(lead["merged_into"])
        self.assertEqual((lead["final_score"], lead["headline"], lead["emojis"]), (7, "Russian strike on Kharkiv kills 3", "🇷🇺🇺🇦💥"))
        self.assertEqual(lead["best_source"], "Alpha Times")           # best link of the group (tier 1)
        self.assertEqual(lead["source_count"], 2)
        self.assertEqual(lead["updated_at"], int(T0 - H))              # the newest of the group
        self.assertEqual(json.loads(lead["topics"]), ["economy_markets", "russia", "ukraine_war"])
        self.assertEqual(lead["edited_at"], T0)
        self.assertIsNone(lead["main_topic"])                          # the answer named no topic
        # user 7 got the merged-away story: the kept one counts as sent too (never twice)
        sent = self.db.query("SELECT story_id, sent_at FROM sent WHERE user_id = 7 ORDER BY story_id")
        self.assertEqual(sent, [{"story_id": self.old, "sent_at": T0 - 600}, {"story_id": self.new, "sent_at": T0 - 600}])
        self.assertEqual(calls, [("gemini", True, 3, None)])
        self.assertEqual(ed.run(T0).status, "skipped")              # everything edited: no call

    def test_failed_editor_falls_back_then_gives_up_without_touching_stories(self):
        groq = FakeProvider("groq", [answer(([self.old], 6, "Kharkiv strike kills 3", "", "💥"),
                                            ([self.new], 6, "Kharkiv toll 3", "", ""), ([self.other], 4, "Budget", "", ""))])
        ed, calls = make_editor(self.db, [FakeProvider("gemini", [OVERLOAD]), groq])
        res = ed.run(T0)
        self.assertEqual((res.status, res.provider), ("ok", "groq"))
        self.assertIn("HTTP 503", calls[0][3])
        self.assertEqual(len(groq.prompts), 1)

        db2 = new_db()
        s = add_story(db2, "Untouched", ["politics_conflicts"], 8)
        bad = [OVERLOAD, "not json", "still not json", {"events": []}, {"events": []}]
        ed, calls = make_editor(db2, [FakeProvider("gemini", bad[:1]), FakeProvider("gemini-b", bad[1:3]),
                                      FakeProvider("groq", bad[3:])])
        res = ed.run(T0)
        self.assertEqual(res.status, "failed")
        self.assertEqual([c[1] for c in calls], [False] * 5)           # 503; invalid twice; covers none twice
        row = story(db2, s)
        self.assertEqual((row["final_score"], row["headline"], row["edited_at"]), (None, None, None))

    def test_groq_gets_a_smaller_prompt(self):
        for i in range(20):
            add_story(self.db, f"Politics story {i}", ["politics_conflicts"], 6)
        groq = FakeProvider("groq", [lambda p: {"events": [{"ids": [l.split(" |")[0]], "score": 5, "headline": "x",
                                                             "description": "", "emojis": ""}
                                                            for l in p.splitlines() if CAND.match(l)]}])
        ed, calls = make_editor(self.db, [FakeProvider("gemini", [OVERLOAD]), groq])
        res = ed.run(T0)
        self.assertEqual(res.status, "ok")
        self.assertEqual(res.candidates, Settings().editor_groq_new)
        self.assertEqual(calls[-1][2], Settings().editor_groq_new)


def score_all(score=5, topic_score=None):
    """An editor answer that scores every candidate in the prompt on its own."""
    def respond(prompt):
        ids = [l.split(" |")[0] for l in prompt.splitlines() if CAND.match(l)]
        return {"events": [{"ids": [i], "score": score, "topic_score": topic_score, "topic": "", "headline": "",
                            "description": "", "emojis": ""} for i in ids]}
    return respond


class Step8(unittest.TestCase):
    """Topic score, coverage (second call, Armenia floor), scored_at, the topic-only rescore."""

    def setUp(self):
        self.db = new_db()

    def test_topic_score_is_clamped_never_below_the_score_and_kept_when_missing(self):
        a = add_story(self.db, "Armenian judges suspended", ["armenia"], 5)
        b = add_story(self.db, "Big summit", ["politics_conflicts"], 7)
        c = add_story(self.db, "Odd answer", ["russia"], 5)
        gem = FakeProvider("gemini", [{"events": [
            {"ids": [f"S{a}"], "score": 4, "topic_score": 6, "topic": "armenia", "headline": "", "description": "",
             "emojis": ""},
            {"ids": [f"S{b}"], "score": 8, "topic_score": 5, "topic": "politics_conflicts", "headline": "", "description": "",
             "emojis": ""},
            {"ids": [f"S{c}"], "score": 5, "topic_score": 40, "topic": "russia", "headline": "", "description": "",
             "emojis": ""}]}])
        ed, _ = make_editor(self.db, [gem])
        ed.run(T0)
        self.assertEqual((story(self.db, a)["final_score"], story(self.db, a)["topic_score"]), (4, 6))
        self.assertEqual(story(self.db, b)["topic_score"], 8)       # never below the global score
        self.assertEqual(story(self.db, c)["topic_score"], 10)      # clamped
        # the answer check itself raises a low topic score (the write clamps it a second time)
        by_id = {s["id"]: s for s in editor.Editor(self.db, [], topics=TOPICS, facts=[], facts_checked="x").pool(T0 + H)}
        if b in by_id:
            evs, _ = editor.validate_events({"events": [{"ids": [f"S{b}"], "score": 8, "topic_score": 5}]}, by_id, {})
            self.assertEqual((evs[0].topic_score, evs[0].topic_raw), (8, 5))
        evs, _ = editor.validate_events({"events": [{"ids": [f"S{a}"], "score": 7, "topic_score": 3}]},
                                        {a: story(self.db, a)}, {})
        self.assertEqual((evs[0].topic_score, evs[0].topic_raw), (7, 3))
        # a later answer without a topic score keeps the old one (raised to a higher new score)
        self.db.query("UPDATE stories SET edited_at = NULL WHERE id = ?", [a])
        ed, _ = make_editor(self.db, [FakeProvider("gemini", [score_all(5)])])
        ed.run(T0 + H)
        self.assertEqual((story(self.db, a)["final_score"], story(self.db, a)["topic_score"]), (5, 6))

    def test_scored_at_is_the_first_score_time_and_survives_re_edits(self):
        a = add_story(self.db, "Armenia story", ["armenia"], 5)
        ed, _ = make_editor(self.db, [FakeProvider("gemini", [score_all(5, 6)])])
        ed.run(T0)
        self.assertEqual(story(self.db, a)["scored_at"], T0)
        b = add_story(self.db, "New one", ["russia"], 5, now=T0 + H)
        ed, _ = make_editor(self.db, [FakeProvider("gemini", [score_all(5, 5)])])
        ed.run(T0 + H)                                              # `a` comes back only to compare
        self.assertEqual(story(self.db, a)["edited_at"], T0 + H)
        self.assertEqual(story(self.db, a)["scored_at"], T0)        # unchanged
        self.assertEqual(story(self.db, b)["scored_at"], T0 + H)

    def test_a_second_call_only_while_unscored_candidates_remain(self):
        for i in range(7):
            add_story(self.db, f"Politics story {i}", ["politics_conflicts"], 6)
        s = Settings(editor_new=5, editor_compare=2)
        gem = FakeProvider("gemini", [score_all(5), score_all(5)])
        ed, calls = make_editor(self.db, [gem], s)
        res = ed.run(T0)
        self.assertEqual((res.status, res.rounds, res.calls), ("ok", 2, 2))
        self.assertEqual(self.db.query("SELECT count(*) n FROM stories WHERE final_score IS NULL")[0]["n"], 0)
        self.assertEqual([c[2] for c in calls], [5, 4])             # 5 new; then 2 new + 2 to compare
        # no backlog: one call
        add_story(self.db, "One more", ["russia"], 6)
        gem = FakeProvider("gemini", [score_all(5)])
        res = make_editor(self.db, [gem], s)[0].run(T0)
        self.assertEqual((res.rounds, len(gem.prompts)), (1, 1))
        # never more than editor_max_calls
        for i in range(20):
            add_story(self.db, f"Wave {i}", ["politics_conflicts"], 6)
        gem = FakeProvider("gemini", [score_all(5), score_all(5)])
        res = make_editor(self.db, [gem], s)[0].run(T0)
        self.assertEqual(res.rounds, 2)
        self.assertGreater(self.db.query("SELECT count(*) n FROM stories WHERE final_score IS NULL")[0]["n"], 0)

    def test_no_second_call_after_falling_back_to_groq(self):
        for i in range(15):
            add_story(self.db, f"Politics story {i}", ["politics_conflicts"], 6)
        groq = FakeProvider("groq", [score_all(5)])
        ed, _ = make_editor(self.db, [FakeProvider("gemini", [OVERLOAD]), groq])
        res = ed.run(T0)
        self.assertEqual((res.status, res.rounds, len(groq.prompts)), ("ok", 1, 1))

    def test_armenia_stories_at_first_pass_3_are_candidates_other_topics_are_not(self):
        arm = add_story(self.db, "Party switch in Amasia race", ["politics_conflicts", "armenia"], 3)
        add_story(self.db, "Football friendly", ["politics_conflicts"], 3)
        add_story(self.db, "Armenian poem", ["armenia"], 2)
        pool = make_editor(self.db, [])[0].pool(T0)
        self.assertEqual([s["id"] for s in pool], [arm])
        self.assertEqual(len(make_editor(self.db, [])[0].pool(T0, min_importance=4)), 0)   # explicit floor wins

    def test_topic_only_rescore_writes_only_topic_scores(self):
        a = add_story(self.db, "Judges suspended", ["armenia"], 5, edited={"score": 4, "headline": "Judges suspended"})
        self.db.query("UPDATE stories SET main_topic = 'armenia' WHERE id = ?", [a])
        b = add_story(self.db, "Summit", ["politics_conflicts"], 7, edited={"score": 7, "headline": "Summit"})
        new = add_story(self.db, "Not edited yet", ["russia"], 6)
        before = {i: story(self.db, i) for i in (a, b, new)}
        gem = FakeProvider("gemini", [{"events": [
            {"ids": [f"S{a}", f"S{b}"], "score": 9, "topic_score": 6, "topic": "politics_conflicts", "headline": "Changed",
             "description": "Changed.", "emojis": "💥"}]}])
        ed, _ = make_editor(self.db, [gem])
        res, mismatch = ed.rescore_topics(T0)
        self.assertEqual((res.status, res.edited, mismatch), ("ok", 2, 1))
        self.assertIn(f"S{a} | armenia | EDITED: score 4, topic armenia, headline: Judges suspended", gem.prompts[0])
        self.assertNotIn(f"S{new} |", gem.prompts[0])                # only edited stories
        self.assertEqual(story(self.db, a)["topic_score"], 6)
        self.assertEqual(story(self.db, b)["topic_score"], 7)        # never below its own final score
        for i in (a, b, new):
            row = story(self.db, i)
            for k in ("final_score", "headline", "description", "emojis", "topics", "merged_into", "edited_at",
                      "main_topic"):
                self.assertEqual(row[k], before[i][k], k)
        self.assertEqual(ed.rescore_topics(T0)[0].status, "skipped")  # nothing left to rescore

    def test_dry_run_calls_the_ai_but_writes_nothing(self):
        a = add_story(self.db, "Story", ["politics_conflicts"], 6)
        gem = FakeProvider("gemini", [score_all(6, 7)])
        ed, calls = make_editor(self.db, [gem])
        ed.dry_run = True
        res = ed.run(T0)
        self.assertEqual((res.status, res.edited, len(calls)), ("ok", 1, 1))
        self.assertIsNone(story(self.db, a)["final_score"])


class InTheJob(unittest.TestCase):
    def test_a_run_edits_new_stories_and_logs_editor_calls(self):
        db, clock, feeds = new_db(), Clock(), Feeds()
        now = clock()
        feeds.entries = [entry("alpha", "IRAN: base strike confirmed", 20, now),
                         entry("gamma", "ARM: Yerevan passes budget", 30, now)]

        def edit(prompt):
            ids = [l.split(" |")[0] for l in prompt.splitlines() if CAND.match(l)]
            return {"events": [{"ids": [i], "score": 7, "headline": "Strike on base confirmed", "description": "",
                                "emojis": "💥"} for i in ids]}
        gem = FakeProvider("gemini", [grouping_responder({"IRAN": ["iran_war"], "ARM": ["armenia"]}), edit])
        job = make_job(db, gem, FakeProvider("groq", []), feeds, clock, editor_enabled=True)
        stats = job.run()
        run = db.query("SELECT * FROM job_runs")[0]
        self.assertEqual((run["status"], run["editor_status"], run["editor_candidates"], run["editor_merged"]),
                         ("ok", "ok", 2, 0))
        kinds = [r["kind"] for r in db.query("SELECT kind FROM ai_calls ORDER BY id")]
        self.assertEqual(kinds, ["batch", "editor"])
        self.assertEqual(run["ai_calls"], 2)
        self.assertEqual(stats.input_tokens, 2000)                    # both calls counted
        self.assertEqual(db.query("SELECT count(*) n FROM stories WHERE final_score = 7")[0]["n"], 2)

    def test_editor_failure_never_fails_the_run(self):
        db, clock, feeds = new_db(), Clock(), Feeds()
        feeds.entries = [entry("alpha", "IRAN: base strike confirmed", 20, clock())]
        gem = FakeProvider("gemini", [grouping_responder({"IRAN": ["iran_war"]}), OVERLOAD])
        groq = FakeProvider("groq", [OVERLOAD])
        make_job(db, gem, groq, feeds, clock, editor_enabled=True).run()
        run = db.query("SELECT * FROM job_runs")[0]
        self.assertEqual((run["status"], run["editor_status"]), ("ok", "failed"))
        self.assertIn("editor", run["error"])
        s = db.query("SELECT importance, final_score FROM stories")[0]
        self.assertEqual((s["importance"], s["final_score"]), (6, None))   # first-pass data kept

    def test_a_new_core_fact_from_pass_one_makes_the_story_editable_again(self):
        db, clock, feeds = new_db(), Clock(), Feeds()
        sid = add_story(db, "Old summary", ["iran_war"], 6, edited={"score": 7, "headline": "H"}, now=clock())
        feeds.entries = [entry("alpha", "IRAN: toll rises", 5, clock())]

        def merge(prompt):
            item = next(iter(prompt_items(prompt).values()))
            return {"stories": [{"item_ids": [item], "existing_story_id": f"S{sid}", "summary": "New core fact",
                                 "topics": ["iran_war"], "importance": 7}], "not_news_ids": []}
        make_job(db, FakeProvider("gemini", [merge]), FakeProvider("groq", []), feeds, clock).run()
        row = story(db, sid)
        self.assertEqual((row["summary"], row["edited_at"]), ("New core fact", None))


if __name__ == "__main__":
    unittest.main()
