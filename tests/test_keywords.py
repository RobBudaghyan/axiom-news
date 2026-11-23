"""Step 14: the custom-topic keyword rule, the keyword backfill and glossary spellings.

The rule (job/custom.py KeywordRule, owner): a story keeps a custom tag, and may have it as its
main topic, only if one of the topic's match keywords is in its English headline or description
(whole word, any case). Otherwise the tag goes and the main topic falls back to the best main topic,
with no boost. Checked where tags are written (pass 1, the editor) and once a run over the pool.

    venv/Scripts/python -m unittest tests.test_keywords -v
"""
from __future__ import annotations

import json
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job import ai, custom, editor, translate  # noqa: E402
from job.config import Settings  # noqa: E402
from job.run import ProviderPlan  # noqa: E402
from tests.helpers import T0, TOPICS, FakeProvider, grouping_responder, new_db  # noqa: E402
from tests.test_custom import CFG, FakeGoogle, add_topic, add_user, follow, gi, job_with  # noqa: E402

H = 3600
JAPAN = {"en": ["Japan", "Japanese", "Tokyo", "Takaichi", "BOJ", "Bank of Japan", "Yen", "Osaka"],
         "ru": ["Япония", "японский", "Токио"]}
# The owner's real Japan section of 2026-11-17 (06:00 and 09:00 digests)
NOT_JAPAN = ["US restricts China's remote access to advanced AI chips",
             "Canadian Prime Minister Carney arrives in China for meetings",
             "China and Canada expand tariff relief on agriculture and steel",
             "China and Canada slash tariffs"]
JAPAN_STORIES = ["Japan's economy shrinks in the third quarter", "Bank of Japan board member urges a rate rise",
                 "Kumamoto earthquake damage estimated at over one trillion yen",
                 "Putin and Japanese Prime Minister Takaichi may meet at APEC"]


def topic(tag="c1", keywords=None, names=None):
    names = names or {"en": "Japan", "ru": "Япония"}
    return {"tag": tag, "label": {"en": names["en"]}, "definition": f"News about {names['en']}.", "custom": True,
            "boost_max": 2, "floor": 3, "names": names, "keywords": JAPAN if keywords is None else keywords}


def story(db, summary, tags, imp=5, headline=None, description=None, main=None, final=None, ts=None, t=None):
    t = int(T0 - H) if t is None else t
    return db.query("INSERT INTO stories (summary, topics, importance, best_url, best_source, best_tier, source_count, "
                    "created_at, updated_at, headline, description, main_topic, final_score, topic_score, scored_at) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
                    [summary, json.dumps(tags), imp, "https://x.test", "X", 2, 1, t, t, headline, description, main,
                     final, ts, t if final is not None else None])[0]["id"]


def row(db, sid):
    r = db.query("SELECT * FROM stories WHERE id = ?", [sid])[0]
    return {**r, "topics": json.loads(r["topics"])}


def has_keyword(text, words):
    return custom.keyword_regex(words).search(text) is not None


class TestMatch(unittest.TestCase):
    def setUp(self):
        self.rule = custom.KeywordRule([topic()])

    def test_the_owners_off_topic_stories_fail_and_japan_stories_pass(self):
        for h in NOT_JAPAN:
            self.assertFalse(self.rule.allows("c1", h), h)
        for h in JAPAN_STORIES:
            self.assertTrue(self.rule.allows("c1", h), h)

    def test_whole_words_any_case_plurals_and_phrases(self):
        ok = ["JAPAN votes", "japanese steel", "Japan's PM", "Bank of  Japan holds", "Tokyo-based firm", "the yen falls"]
        bad = ["Japanimation festival", "Osakan dish", "Bank of England", "Tokyoite says"]
        for h in ok:
            self.assertTrue(self.rule.allows("c1", h), h)
        for h in bad:
            self.assertFalse(self.rule.allows("c1", h), h)
        aus = custom.KeywordRule([topic("c2", {"en": ["Australian"], "ru": []}, {"en": "Australia", "ru": "Австралия"})])
        self.assertTrue(aus.allows("c2", "Australians vote early"))
        self.assertFalse(aus.allows("c2", "Austria votes"))

    def test_main_topics_and_unknown_custom_tags_are_never_touched(self):
        self.assertTrue(self.rule.allows("politics_conflicts", "anything"))
        self.assertTrue(self.rule.allows("c9", "anything"))       # no active reader: left alone
        self.assertEqual(self.rule.tags(["politics_conflicts", "c1", "c9"], "Canada and China"), ["politics_conflicts", "c9"])

    def test_no_keywords_yet_uses_the_names(self):
        r = custom.KeywordRule([topic(keywords={})])
        self.assertTrue(r.allows("c1", "Japan votes"))
        self.assertFalse(r.allows("c1", "Japanese steel"))

    def test_fallback_main_topic_is_the_most_specific(self):
        kept, main, moved = self.rule.apply(["politics_conflicts", "tech_ai", "c1"], "c1", "Putin meets Xi")
        self.assertEqual((kept, main, moved), (["politics_conflicts", "tech_ai"], "tech_ai", True))
        self.assertEqual(self.rule.apply(["c1"], "c1", "Canada and China"), ([], None, True))
        self.assertEqual(self.rule.apply(["c1"], "c1", "Japan votes"), (["c1"], "c1", False))

    def test_clean_keywords(self):
        kw = custom.clean_keywords({"en": ["japan", " Tokyo ", "x" * 41, "B.O.J.", "—", "", 7, "Bank  of Japan"] + [f"W{i}" for i in range(20)],
                                    "ru": "not a list"}, {"en": "Japan", "ru": "Япония"})
        self.assertEqual(kw["en"][:4], ["Japan", "Tokyo", "B.O.J", "Bank of Japan"])
        self.assertEqual(len(kw["en"]), custom.MAX_KEYWORDS)
        self.assertEqual(kw["ru"], ["Япония"])


class TestPass1(unittest.TestCase):
    def test_a_story_without_a_keyword_never_gets_the_custom_tag(self):
        db = new_db()
        add_user(db, 1)
        add_topic(db, 1, "Japan", keywords=JAPAN)
        follow(db, 1, 1)
        google = FakeGoogle({"Japan": [gi("CAN: Canadian PM Carney arrives in China"), gi("JAP: Japan economy shrinks")]})
        j, _ = job_with(db, google, responder=grouping_responder({"CAN": ["politics_conflicts", "c1"], "JAP": ["c1"]}))
        j.run_enforce = lambda *a: None          # pass 1 alone (the hourly sweep is tested apart)
        j.run()
        got = {r["summary"].split(":")[0]: json.loads(r["topics"]) for r in db.query("SELECT summary, topics FROM stories")}
        self.assertEqual(got, {"Summary of CAN": ["politics_conflicts"], "Summary of JAP": ["c1"]})

    def test_a_merge_keeps_the_tag_only_with_a_keyword(self):
        db = new_db()
        add_user(db, 1)
        add_topic(db, 1, "Japan", keywords=JAPAN)
        follow(db, 1, 1)
        old = story(db, "Xi meets Carney in Shenzhen", ["politics_conflicts", "c1"], t=int(T0 - 2 * H))
        google = FakeGoogle({"Japan": [gi("XI: Xi and Carney cut tariffs")]})
        j, _ = job_with(db, google, responder=grouping_responder({"XI": ["c1"]}, merge={"XI": "Xi meets"}))
        j.run_enforce = lambda *a: None
        j.run()
        self.assertEqual(row(db, old)["topics"], ["politics_conflicts"])


class TestEditor(unittest.TestCase):
    def run_editor(self, db, answer, topics=None):
        gem = FakeProvider("gemini", [answer])
        s = Settings()
        ed = editor.Editor(db, [ProviderPlan(gem, s.gemini_max_input_tokens, s.existing_max, 4)],
                           topics=topics or TOPICS + [topic()], facts=["f"], facts_checked="x", settings=s,
                           log=lambda _m: None)
        return ed.run(T0), gem

    def test_custom_main_topic_without_keyword_falls_back_with_no_boost(self):
        db = new_db()
        a = story(db, "China and Canada slash tariffs", ["politics_conflicts", "c1"], imp=6)
        b = story(db, "Japan economy shrinks", ["c1"], imp=5)
        c = story(db, "Kadena base gets F-15EX jets", ["economy_markets", "c1"], imp=5)
        answer = {"events": [
            {"ids": [f"S{a}"], "score": 6, "topic": "c1", "topic_score": 7, "headline": "China and Canada slash tariffs",
             "description": "", "emojis": ""},
            {"ids": [f"S{b}"], "score": 5, "topic": "c1", "topic_score": 7, "headline": "Japan economy shrinks",
             "description": "", "emojis": ""},
            # the keyword is only in the description: that counts
            {"ids": [f"S{c}"], "score": 5, "topic": "c1", "topic_score": 6, "headline": "Kadena base gets F-15EX jets",
             "description": "The US base in Japan gets its first jets.", "emojis": ""}]}
        db.query("INSERT INTO items (url_hash, source_key, source_name, tier, url, title, fetched_at, status, story_id) "
                 "VALUES ('k', 'a', 'A', 1, 'u', 'US base in Japan gets its first F-15EX jets', ?, 'done', ?)", [T0, c])
        res, _ = self.run_editor(db, answer)
        self.assertEqual(res.status, "ok")
        ra, rb, rc = row(db, a), row(db, b), row(db, c)
        self.assertEqual((ra["topics"], ra["main_topic"], ra["topic_score"]), (["politics_conflicts"], "politics_conflicts", 6))
        self.assertEqual((rb["topics"], rb["main_topic"], rb["topic_score"]), (["c1"], "c1", 7))
        self.assertEqual((rc["topics"], rc["main_topic"]), (["economy_markets", "c1"], "c1"))

    def test_only_custom_tags_and_no_keyword_leaves_the_custom_path(self):
        db = new_db()
        a = story(db, "Seattle Mariners eye Asian talent", ["c1"], imp=4)
        res, _ = self.run_editor(db, {"events": [{"ids": [f"S{a}"], "score": 2, "topic": "c1", "topic_score": 6,
                                                  "headline": "Seattle Mariners eye Asian talent", "description": "",
                                                  "emojis": ""}]})
        r = row(db, a)
        self.assertEqual((r["topics"], r["main_topic"], r["topic_score"]), ([], None, 2))
        cfg = translate.load_digest_config()
        self.assertFalse(translate.qualifies(r, cfg, [t["tag"] for t in TOPICS] + ["c1"]))


class TestEnforce(unittest.TestCase):
    def test_old_rows_are_fixed_once_and_good_ones_left_alone(self):
        db = new_db()
        bad = story(db, "s", ["politics_conflicts", "c1"], headline="US restricts China's access to AI chips", main="c1", final=6, ts=7)
        good = story(db, "s", ["c1"], headline="Japan scrambles jets", main="c1", final=6, ts=7)
        old = story(db, "s", ["c1"], headline="Canada and China", main="c1", final=6, ts=7, t=int(T0 - 30 * H))
        rule = custom.KeywordRule([topic()])
        changed = custom.enforce(db, rule, T0)
        self.assertEqual([c["id"] for c in changed], [bad])
        r = row(db, bad)
        self.assertEqual((r["topics"], r["main_topic"], r["topic_score"]), (["politics_conflicts"], "politics_conflicts", 6))
        self.assertEqual(row(db, good)["topics"], ["c1"])
        self.assertEqual(row(db, old)["topics"], ["c1"])      # outside the digest window: not read
        self.assertEqual(custom.enforce(db, rule, T0), [])

    def test_the_job_runs_it_every_hour(self):
        db = new_db()
        add_user(db, 1)
        add_topic(db, 1, "Japan", keywords=JAPAN)
        follow(db, 1, 1)
        bad = story(db, "s", ["politics_conflicts", "c1"], headline="China and Canada slash tariffs", main="c1", final=6, ts=6)
        j, _ = job_with(db)
        st = j.run()
        self.assertEqual(row(db, bad)["topics"], ["politics_conflicts"])
        self.assertEqual(st.custom_unkeyed, 1)


class TestInvariant(unittest.TestCase):
    def test_random_pools_never_keep_a_custom_story_without_a_keyword(self):
        """1,000 random stories and editor answers: afterwards no story has a custom tag (and so
        no story can sit under a custom section, digest.js primaryTopic) without a keyword."""
        rnd = random.Random(14)
        words = ["Japan", "Tokyo", "yen", "China", "Canada", "tariffs", "Seoul", "steel", "Japanese", "Osaka",
                 "Japanimation", "Carney", "Xi", "AI", "chips", "Takaichi", "BOJ", "election"]
        aus = {"en": ["Australia", "Australian", "Albanese", "Sydney"], "ru": ["Австралия"]}
        topics = TOPICS + [topic("c1"), topic("c2", aus, {"en": "Australia", "ru": "Австралия"})]
        kws = {"c1": JAPAN["en"] + JAPAN["ru"], "c2": aus["en"] + aus["ru"]}
        for _ in range(20):
            db = new_db()
            ids, answer = [], {"events": []}
            for _ in range(50):
                text = " ".join(rnd.choice(words) for _ in range(5))
                tags = rnd.sample(["politics_conflicts", "tech_ai", "c1", "c2"], rnd.randint(1, 3))
                sid = story(db, text, tags, imp=5)
                ids.append(sid)
                head = " ".join(rnd.choice(words) for _ in range(4))
                answer["events"].append({"ids": [f"S{sid}"], "score": rnd.randint(2, 7), "topic": rnd.choice(tags),
                                         "topic_score": rnd.randint(4, 9), "headline": head,
                                         "description": rnd.choice(["", text]), "emojis": ""})
            gem = FakeProvider("gemini", [answer])
            s = Settings(editor_new=90)   # one answer covers every random story (the job uses 45 a call)
            editor.Editor(db, [ProviderPlan(gem, s.gemini_max_input_tokens, s.existing_max, 4)], topics=topics,
                          facts=["f"], facts_checked="x", settings=s, log=lambda _m: None).run(T0)
            for sid in ids:
                r = row(db, sid)
                text = custom.story_text(r["headline"], r["description"], r["summary"])
                for tag in r["topics"]:
                    if custom.is_custom(tag):
                        self.assertTrue(has_keyword(text, kws[tag]), (tag, text))
                if custom.is_custom(r["main_topic"]):
                    self.assertIn(r["main_topic"], r["topics"])


class TestBackfill(unittest.TestCase):
    def plans(self, *providers):
        s = Settings()
        return [ProviderPlan(p, s.gemini_max_input_tokens, s.existing_max, 4) for p in providers]

    def test_one_call_per_topic_without_keywords(self):
        db = new_db()
        add_topic(db, 1, "Japan", keywords=None)
        add_topic(db, 2, "Australia", keywords=None)
        add_topic(db, 3, "Colombia")                      # has keywords already: no call
        answers = [{"keywords": {"en": ["Japanese", "Tokyo", "Takaichi", "BOJ", "Yen"], "ru": ["японский", "Токио"]}},
                   {"keywords": {"en": ["Australian", "Albanese", "Canberra", "Sydney", "RBA"], "ru": ["Канберра"]}}]
        gem = FakeProvider("gemini", answers)
        calls = []
        done = custom.backfill_keywords(db, self.plans(gem), on_call=lambda p, ok, n, res, err, kind: calls.append((ok, kind)))
        self.assertEqual(done, ["c1", "c2"])
        self.assertEqual(len(gem.prompts), 2)
        self.assertEqual(calls, [(True, "topic_keywords")] * 2)
        self.assertIn("Topic: Japan", gem.prompts[0])
        self.assertIn("5 to 15 match keywords in English (en) and 5 to 15 in Russian (ru)", gem.prompts[0])
        kw = json.loads(db.query("SELECT keywords FROM custom_topics WHERE id = 1")[0]["keywords"])
        self.assertEqual(kw["en"], ["Japan", "Japanese", "Tokyo", "Takaichi", "BOJ", "Yen"])   # its name first
        self.assertEqual(kw["ru"], ["Japan", "японский", "Токио"])   # the test topic's Russian name is "Japan"
        self.assertEqual(custom.backfill_keywords(db, self.plans(FakeProvider("gemini", []))), [])   # nothing left

    def test_the_prompt_shows_the_topics_recent_google_headlines(self):
        """The model's knowledge is dated (the first live answer gave Kishida and Ishiba, not Takaichi)."""
        db = new_db()
        add_topic(db, 1, "Japan", keywords=None)
        for n, (title, at) in enumerate([("Japan PM Takaichi visits Manila", T0 - H), ("Old Japan story", T0 - 3 * 86400)]):
            db.query("INSERT INTO items (url_hash, source_key, source_name, tier, url, title, fetched_at, status, hint_topic, "
                     "headline_only) VALUES (?, 'gnews', 'G', 4, 'u', ?, ?, 'done', 'c1', 1)", [f"h{n}", title, at])
        gem = FakeProvider("gemini", [{"keywords": {"en": ["Takaichi"], "ru": []}}])
        custom.backfill_keywords(db, self.plans(gem), now=T0)
        self.assertIn("RECENT HEADLINES:\n   - Japan PM Takaichi visits Manila", gem.prompts[0])
        self.assertNotIn("Old Japan story", gem.prompts[0])
        self.assertIn("the people in office now", gem.prompts[0])

    def test_a_failure_tries_the_next_provider_then_waits(self):
        db = new_db()
        add_topic(db, 1, "Japan", keywords=None)
        gem = FakeProvider("gemini", [ai.AIError("gemini", "HTTP 503: busy", kind="http", status=503)])
        groq = FakeProvider("groq", ["not json"])
        calls = []
        done = custom.backfill_keywords(db, self.plans(gem, groq), on_call=lambda p, ok, n, res, err, kind: calls.append((p.name, ok)))
        self.assertEqual(done, [])
        self.assertEqual(calls, [("gemini", False), ("groq", False)])
        self.assertIsNone(db.query("SELECT keywords FROM custom_topics")[0]["keywords"])
        gem2 = FakeProvider("gemini", [{"keywords": {"en": ["Japanese", "Tokyo"], "ru": []}}])
        self.assertEqual(custom.backfill_keywords(db, self.plans(gem2)), ["c1"])

    def test_step15_keywords_are_refreshed_after_a_week_not_before(self):
        db = new_db()
        old = {"en": ["Japan", "Kishida", "Ishiba", "Tokyo", "Yen"], "ru": ["Япония"]}
        add_topic(db, 1, "Japan", keywords=old, keywords_at=T0 - 6 * 86400)
        add_topic(db, 2, "Australia", keywords={"en": ["Australia"], "ru": []}, keywords_at=T0 - 8 * 86400)
        gem = FakeProvider("gemini", [{"keywords": {"en": ["Australian", "Albanese", "Canberra", "Sydney", "RBA"], "ru": []}}])
        self.assertEqual(custom.backfill_keywords(db, self.plans(gem), now=T0), ["c2"])
        self.assertEqual(len(gem.prompts), 1, "one call, only for the topic 7+ days old")
        rows = {r["id"]: r for r in db.query("SELECT id, keywords, keywords_at FROM custom_topics")}
        self.assertEqual(json.loads(rows[1]["keywords"]), old)
        self.assertEqual(rows[2]["keywords_at"], T0)
        self.assertIn("Albanese", json.loads(rows[2]["keywords"])["en"])
        # a day later Japan is due
        gem2 = FakeProvider("gemini", [{"keywords": {"en": ["Japanese", "Takaichi", "Tokyo", "Yen", "BOJ"], "ru": []}}])
        self.assertEqual(custom.backfill_keywords(db, self.plans(gem2), now=T0 + 86400 + 1), ["c1"])
        self.assertIn("Takaichi", json.loads(db.query("SELECT keywords FROM custom_topics WHERE id = 1")[0]["keywords"])["en"])

    def test_step15_a_weak_refresh_keeps_the_old_keywords(self):
        db = new_db()
        old = {"en": ["Japan", "Takaichi", "Tokyo", "Yen", "Osaka"], "ru": ["Япония"]}
        add_topic(db, 1, "Japan", keywords=old, keywords_at=0)       # Admin: "Keywords" pressed
        gem = FakeProvider("gemini", [{"keywords": {"en": ["Japanese"], "ru": []}}])
        self.assertEqual(custom.backfill_keywords(db, self.plans(gem), now=T0), [])
        r = db.query("SELECT keywords, keywords_at FROM custom_topics")[0]
        self.assertEqual(json.loads(r["keywords"]), old)
        self.assertEqual(r["keywords_at"], T0, "not asked again every hour")
        self.assertEqual(custom.backfill_keywords(db, self.plans(FakeProvider("gemini", [])), now=T0 + 3600), [])

    def test_the_job_backfills_before_the_ai_passes_and_logs_the_call(self):
        db = new_db()
        add_user(db, 1)
        add_topic(db, 1, "Japan", keywords=None)
        follow(db, 1, 1)
        j, gem = job_with(db)
        gem.responses.insert(0, {"keywords": {"en": ["Japanese", "Tokyo", "Takaichi", "BOJ", "Yen"], "ru": ["Токио"]}})
        j.run()
        self.assertIn("Takaichi", db.query("SELECT keywords FROM custom_topics")[0]["keywords"])
        self.assertIn("Takaichi", json.dumps(j.ai_topics, ensure_ascii=False))     # loaded for this run already
        kinds = [r["kind"] for r in db.query("SELECT kind FROM ai_calls")]
        self.assertEqual(kinds, ["topic_keywords"])


class TestGlossarySpelling(unittest.TestCase):
    def test_glossary_has_takaichi_in_four_languages(self):
        g = next(x for x in translate.load_glossary() if "Takaichi" in x["en"])
        self.assertEqual(g["en"][0], "Takaichi")
        self.assertIn("Takaiti", g["en"])
        self.assertEqual((g["ru"], g["hy"], g["fr"]), ("Такаити", "Տակաիչի", "Takaichi"))
        sanae = next(x for x in translate.load_glossary() if "Sanae" in x["en"])
        self.assertEqual((sanae["ru"], sanae["hy"], sanae["fr"]), ("Санаэ", "Սանաե", "Sanae"))

    def test_other_spellings_become_the_glossary_spelling(self):
        self.assertEqual(custom.spell_names("Putin and Japanese Prime Minister Takaiti may meet"),
                         "Putin and Japanese Prime Minister Takaichi may meet")
        self.assertEqual(custom.spell_names("Pashinian meets Aliev"), "Pashinyan meets Aliyev")
        self.assertEqual(custom.spell_names("Takaitira Takaichi"), "Takaitira Takaichi")   # whole words only

    def test_google_headlines_are_stored_with_the_glossary_spelling(self):
        db = new_db()
        add_user(db, 1)
        add_topic(db, 1, "Japan", [{"q": "Japan", "ed": "en"}], keywords=JAPAN)
        follow(db, 1, 1)
        custom.Searcher(db, cfg=CFG, fetcher=FakeGoogle({"Japan": [gi("Japan PM Takaiti visits Manila")]}),
                        log=lambda _m: None).run(custom.load_active(db), T0)
        self.assertEqual(db.query("SELECT title FROM items")[0]["title"], "Japan PM Takaichi visits Manila")

    def test_the_editor_text_gets_it_after_the_fact_guard(self):
        """The real case: the editor wrote "Takaiti" from a Russian article (Такаити)."""
        db = new_db()
        sid = story(db, "Putin and Japanese Prime Minister Takaiti may meet", ["politics_conflicts", "c1"])
        db.query("INSERT INTO items (url_hash, source_key, source_name, tier, url, title, fetched_at, status, story_id) "
                 "VALUES ('k', 'a', 'Interfax', 1, 'u', 'Putin and Japan PM Sanae Takaiti may meet at APEC in Shenzhen', ?, 'done', ?)", [T0, sid])
        gem = FakeProvider("gemini", [{"events": [{"ids": [f"S{sid}"], "score": 5, "topic": "politics_conflicts", "topic_score": 5,
                                                   "headline": "Putin and Japanese Prime Minister Takaiti may meet at APEC",
                                                   "description": "Putin and Sanae Takaiti could meet in Shenzhen.",
                                                   "emojis": ""}]}])
        s = Settings()
        editor.Editor(db, [ProviderPlan(gem, s.gemini_max_input_tokens, s.existing_max, 4)], topics=TOPICS + [topic()],
                      facts=["f"], facts_checked="x", settings=s, log=lambda _m: None).run(T0)
        r = row(db, sid)
        self.assertEqual(r["headline"], "Putin and Japanese Prime Minister Takaichi may meet at APEC")
        self.assertEqual(r["description"], "Putin and Sanae Takaichi could meet in Shenzhen.")

    def test_translations_must_use_the_russian_form(self):
        hits = translate.glossary_hits("Putin and Takaichi may meet", translate.load_glossary())
        self.assertIn("Такаити", [h["ru"] for h in hits])


class TestNonEvents(unittest.TestCase):
    def test_the_editor_prompt_scores_non_events_at_3_to_4(self):
        prompt = editor.load_editor_prompt()
        text = editor.render_prompt(prompt.template, today="2027-01-15", topics=TOPICS + [topic()], facts=["f"],
                                    facts_checked="x", new=[], compare=[], items={})
        self.assertIn('NON-EVENTS, where nothing new happened', text)
        self.assertIn('("China\'s naval\n        presence near Japan remains normalized"', text)
        self.assertIn("is 3 or 4, never 6, however serious the subject", text)
        self.assertIn('A non-event (a situation that "remains", "continues" or is "unchanged"', text)


class TestStep15Prompts(unittest.TestCase):
    def render(self):
        prompt = editor.load_editor_prompt()
        return " ".join(editor.render_prompt(prompt.template, today="2027-01-15", topics=TOPICS + [topic()], facts=["f"],
                                             facts_checked="x", new=[], compare=[], items={}).split())

    def test_culture_and_sport_stay_below_6_on_main_topics(self):
        text = self.render()
        self.assertIn("CULTURE AND SPORT stay below 6 on the six main topics, in the score AND the topic score", text)
        self.assertIn("chess and sport results are 5 at most", text)
        self.assertIn('"Armenian grandmaster beats Carlsen" 3, 4', text)
        self.assertIn('"Gala concert in Moscow marks Unity Day" 2, 2', text)
        self.assertIn("A reader topic about a sport or culture is scored by its own rule", text)

    def test_economy_and_markets_has_4_6_8_examples_and_its_boost_rule(self):
        text = self.render()
        self.assertIn('economy_markets: "Global stocks plunge as a major bank collapses" 8, 8', text)
        self.assertIn('"Oil jumps 6% after OPEC+ announces a surprise output cut" 6, 6', text)
        self.assertIn('"The European Central Bank holds rates, as expected" 4, 4', text)
        self.assertIn("economy_markets: +1 at most", text)
        self.assertIn("Always +0 for politics_conflicts", text)
        self.assertNotIn("wars_conflicts", text)
        pass1 = " ".join(open(ROOT / "prompts" / "story_batch.md", encoding="utf-8").read().split())
        self.assertIn("Economy news with wide impact IS news (economy_markets)", pass1)
        self.assertNotIn('"stocks rise after inflation data" are not news', pass1)
        self.assertNotIn("wars_conflicts", pass1)


if __name__ == "__main__":
    unittest.main()
