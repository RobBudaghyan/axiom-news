"""Tests for the translation pass (job/translate.py, Step 9): the language filter, which stories,
batching (one call per language), nothing redone for an unchanged English text, the guards
(numbers both ways, glossary names, script, dashes), retries with the rejection note, the
provider chain and the eligibility rule shared with the Worker.

    venv/Scripts/python -m unittest tests.test_translate -v
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job import ai, translate  # noqa: E402
from job.config import Settings  # noqa: E402
from job.run import ProviderPlan  # noqa: E402
from tests.helpers import ROOT, T0, FakeProvider, new_db  # noqa: E402

H = 3600
LANGS = {"default": "en", "enabled": ["en", "ru", "fr"], "available": ["en", "ru", "hy", "fr"],
         "english_names": {"en": "English", "ru": "Russian", "hy": "Armenian", "fr": "French"}}
GLOSSARY = [{"en": ["Pashinyan"], "ru": "Пашинян", "hy": "Փաշինյան", "fr": "Pachinian"},
            {"en": ["Zelensky"], "ru": "Зеленский", "ru_check": "Зеленск", "fr": "Zelensky"}]
DOWN = ai.AIError("gemini", "HTTP 429: quota", kind="rate_limit", status=429)


def add_user(db, uid, lang, paused=0, blocked=0):
    db.query("INSERT INTO users (id, first_name, lang, paused, blocked, created_at) VALUES (?,?,?,?,?,?)",
             [uid, f"U{uid}", lang, paused, blocked, T0])


def add_story(db, headline, *, final=7, topic=None, main="politics", topics=("politics",), importance=6,
              age_h=1.0, description="A description.", merged_into=None):
    t = int(T0 - age_h * H)
    return db.query(
        "INSERT INTO stories (summary, topics, importance, best_url, best_source, best_tier, created_at, updated_at, "
        "headline, description, final_score, topic_score, main_topic, merged_into, edited_at, scored_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
        [f"summary of {headline}", json.dumps(list(topics)), importance, "https://a.test/x", "Alpha", 1, t, t,
         headline, description, final, topic, main, merged_into, t if final is not None else None,
         t if final is not None else None])[0]["id"]


def stories_in(prompt: str) -> list[dict]:
    return json.loads(prompt.split("STORIES (JSON):\n", 1)[1].split("\n\nAnswer with JSON", 1)[0])


RU_NAMES = {"Pashinyan": "Пашиняна", "Zelensky": "Зеленского"}


def ru(text: str) -> str:
    for en, r in RU_NAMES.items():
        text = text.replace(en, r)
    return f"Перевод {text}"


def responder(fix=lambda item: item, lang_fn=ru):
    """A fake model: translates every story it is given (prefix + names), then lets `fix` change it."""
    def respond(prompt):
        return {"items": [fix({"id": s["id"], "headline": lang_fn(s["headline"]),
                               "description": lang_fn(s["description"]) if s["description"] else ""})
                          for s in stories_in(prompt)]}
    return respond


def make(db, providers, settings=None, languages=LANGS, dry_run=False):
    s = settings or Settings()
    plans = [ProviderPlan(p, 25000, 0, 4, label=p.name) for p in providers]
    calls = []
    tr = translate.Translator(db, plans, settings=s, languages=languages, glossary=GLOSSARY,
                              on_call=lambda p, ok, n, res, err, kind: calls.append((p.name, ok, n, kind, err)),
                              log=lambda _m: None, dry_run=dry_run)
    return tr, calls


def rows(db, lang="ru"):
    return {r["story_id"]: r for r in db.query("SELECT * FROM story_translations WHERE lang = ?", [lang])}


class LanguageFilter(unittest.TestCase):
    def test_only_enabled_languages_of_active_users(self):
        db = new_db()
        add_user(db, 1, "en")
        add_user(db, 2, "ru", paused=1)
        add_user(db, 3, "ru", blocked=1)
        add_user(db, 4, "hy")              # hidden (not enabled): reads English, nothing translated
        add_story(db, "Big story")
        tr, calls = make(db, [FakeProvider("gemini", [])])   # any call would fail the test
        self.assertEqual(tr.reader_languages(), [])
        res = tr.run(T0)
        self.assertEqual((res.status, calls, rows(db)), ("skipped", [], {}))

    def test_one_call_per_language_per_run(self):
        db = new_db()
        add_user(db, 1, "ru")
        add_user(db, 2, "ru")
        add_user(db, 3, "fr")
        for i in range(5):
            add_story(db, f"Story {i}")
        g = FakeProvider("gemini", [responder(), responder(lang_fn=lambda t: f"Traduction {t}")])
        tr, calls = make(db, [g])
        res = tr.run(T0)
        self.assertEqual([c[3] for c in calls], ["translate_ru", "translate_fr"])
        self.assertEqual([len(stories_in(p)) for p in g.prompts], [5, 5])
        self.assertEqual((len(rows(db, "ru")), len(rows(db, "fr"))), (5, 5))
        self.assertEqual(res.status, "ok")
        self.assertTrue(all(r["ok"] == 1 for r in rows(db).values()))

    def test_only_stories_that_could_reach_a_digest(self):
        db = new_db()
        add_user(db, 1, "ru")
        yes = [add_story(db, "Editorial bar", final=7),
               add_story(db, "Topic path", final=5, topic=7, main="armenia", topics=("armenia",)),
               add_story(db, "Unedited but huge", final=None, importance=9, main=None)]
        no = [add_story(db, "Weak", final=5, topic=5),
              add_story(db, "Boost capped at 0 for politics", final=5, topic=8, main="politics"),
              add_story(db, "Too old", final=8, age_h=25),
              add_story(db, "Unedited medium", final=None, importance=8, main=None)]
        no.append(add_story(db, "Merged away", final=8, merged_into=yes[0]))
        g = FakeProvider("gemini", [responder()])
        tr, _ = make(db, [g])
        tr.run(T0)
        sent = {int(s["id"][1:]) for s in stories_in(g.prompts[0])}
        self.assertEqual(sent, set(yes))
        self.assertFalse(set(no) & set(rows(db)))

    def test_batch_size_cap_leaves_the_rest_for_next_hour(self):
        db = new_db()
        add_user(db, 1, "ru")
        for i in range(7):
            add_story(db, f"Story {i}", final=7 + i % 3)
        s = Settings()
        s.translate_batch = 4
        g = FakeProvider("gemini", [responder(), responder()])
        tr, calls = make(db, [g], s)
        self.assertEqual(tr.run(T0).status, "partial")
        self.assertEqual(len(rows(db)), 4)
        tr.run(T0 + H)
        self.assertEqual((len(rows(db)), len(calls)), (7, 2))


class NotRedone(unittest.TestCase):
    def test_unchanged_english_is_not_translated_again_and_a_rewrite_is(self):
        db = new_db()
        add_user(db, 1, "ru")
        a = add_story(db, "First headline")
        add_story(db, "Second headline")
        g = FakeProvider("gemini", [responder()])
        tr, calls = make(db, [g])
        tr.run(T0)
        tr.run(T0 + 600)                    # nothing new: no call (a call would fail: no response left)
        self.assertEqual(len(calls), 1)
        db.query("UPDATE stories SET headline = 'First headline, rewritten' WHERE id = ?", [a])
        g.responses.append(responder())
        tr.run(T0 + 1200)
        self.assertEqual([int(s["id"][1:]) for s in stories_in(g.prompts[1])], [a])
        self.assertEqual(rows(db)[a]["headline"], "Перевод First headline, rewritten")
        self.assertEqual(rows(db)[a]["src"], "First headline, rewritten\nA description.")

    def test_src_matches_the_worker_join_exactly(self):
        db = new_db()
        add_user(db, 1, "ru")
        a = add_story(db, None, description=None)        # no editor headline: the summary is the text
        tr, _ = make(db, [FakeProvider("gemini", [responder()])])
        tr.run(T0)
        joined = db.query(
            "SELECT count(*) AS n FROM stories s JOIN story_translations tr ON tr.story_id = s.id AND tr.lang = 'ru' "
            "AND tr.ok = 1 AND tr.src = coalesce(s.headline, s.summary) || char(10) || coalesce(s.description, '')")
        self.assertEqual(joined[0]["n"], 1, rows(db)[a])

    def test_dry_run_writes_nothing(self):
        db = new_db()
        add_user(db, 1, "ru")
        add_story(db, "Story")
        tr, calls = make(db, [FakeProvider("gemini", [responder()])], dry_run=True)
        tr.run(T0)
        self.assertEqual((len(calls), rows(db)), (1, {}))


class Guards(unittest.TestCase):
    EN = {"headline": "Armenia gets 3,500 tonnes of grain", "summary": "", "description": "Prices rose 3.5% in 2026."}

    def check(self, head, desc, lang="ru", en=None):
        return translate.check_translation(lang, en or self.EN, head, desc, GLOSSARY)

    def test_numbers_written_the_local_way_pass(self):
        _, _, problems = self.check("Армения получает 3 500 тонн зерна", "Цены выросли на 3,5% в 2026 году.")
        self.assertEqual(problems, [])
        _, _, problems = self.check("Армения получает 3 500 тонн зерна", "Цены выросли на 3,5% в 2026 году.")
        self.assertEqual(problems, [])

    def test_a_missing_number_is_rejected(self):
        _, _, problems = self.check("Армения получает тысячи тонн зерна", "Цены выросли на 3,5% в 2026 году.")
        self.assertEqual(problems, ["missing number(s) 3500"])

    def test_an_added_number_is_rejected(self):
        _, _, problems = self.check("Армения получает 3 500 тонн зерна", "Цены выросли на 3,5% в 2026 году, на 2 месяца.")
        self.assertEqual(problems, ["number(s) not in the English: 2"])

    def test_glossary_names_declined_forms_pass_others_fail(self):
        en = {"headline": "Pashinyan meets Zelensky", "summary": "", "description": ""}
        self.assertEqual(self.check("Пашинян встретился с Зеленским", "", en=en)[2], [])
        problems = self.check("Пашинян встретился с Зелинским", "", en=en)[2]
        self.assertEqual(problems, ["name Zelensky must be written Зеленский"])
        self.assertEqual(self.check("Pachinian rencontre Zelensky", "", "fr", en)[2], [])
        self.assertEqual(self.check("Pashinyan rencontre Zelensky", "", "fr", en)[2],
                         ["name Pashinyan must be written Pachinian"])

    def test_wrong_script_and_empty_text_are_rejected(self):
        en = {"headline": "Talks resume", "summary": "", "description": "Both sides met."}
        self.assertIn("headline is not in ru script", self.check("Talks resume", "Стороны встретились.", en=en)[2])
        self.assertIn("empty description", self.check("Переговоры возобновились", "", en=en)[2])
        self.assertIn("letters of another alphabet: Снорты", self.check("Reprise des pourparlers", "Стороны", "fr", en)[2])

    def test_letters_of_another_alphabet_inside_a_word_are_rejected(self):
        en = {"headline": "Strike in Rakhine state kills 12", "summary": "", "description": ""}
        self.assertEqual(self.check("Հարված Ռախին նահանգում, զոհվել է 12 մարդ", "", "hy", en)[2], [])
        self.assertEqual(self.check("Հարված Ռαխին նահանգում, զոհվել է 12 մարդ", "", "hy", en)[2],
                         ["letters of another alphabet: α"])

    def test_french_without_accents_or_apostrophes_is_rejected(self):
        en = {"headline": "Silence on Karabakh undermines the UN system", "summary": "",
              "description": "He said international inaction damages global legal structures."}
        good = ("Le silence sur le Karabakh sape le système de l'ONU",
                "Il a déclaré que l'inaction internationale nuit aux structures juridiques mondiales.")
        self.assertEqual(self.check(*good, "fr", en)[2], [])
        self.assertIn("French written without accents",
                      self.check("Le silence sur le Karabakh sape le systeme de l'ONU",
                                 "Il a declare que l'inaction internationale nuit aux structures juridiques mondiales.",
                                 "fr", en)[2])
        self.assertIn("missing apostrophe: 'l ...'",
                      self.check("Le silence sur le Karabakh sape le système de l ONU", good[1], "fr", en)[2])

    def test_an_english_number_word_may_become_digits_but_not_the_other_way(self):
        en = {"headline": "Iran launches six drones at 2 bases", "summary": "", "description": ""}
        self.assertEqual(self.check("Իրանը 6 անօդաչու է արձակել 2 բազայի ուղղությամբ", "", "hy", en)[2], [])
        self.assertEqual(self.check("Իրանը 7 անօդաչու է արձակել 2 բազայի ուղղությամբ", "", "hy", en)[2],
                         ["number(s) not in the English: 7"])
        self.assertEqual(self.check("Иран запустил шесть беспилотников по двум базам", "", "ru", en)[2],
                         ["missing number(s) 2"])
        en6 = {"headline": "Iran launches 6 drones at bases", "summary": "", "description": ""}
        self.assertEqual(self.check("L'Iran lance six drones contre des bases", "", "fr", en6)[2],
                         ["missing number(s) 6"])      # French "six" looks like the English word

    def test_armenian_classical_spelling_becomes_reformed(self):
        self.assertEqual(translate.armenian_reformed("Երեւանը եւ Եւրոպան, Գեւորգ. Եւ նա"),
                         "Երևանը և Եվրոպան, Գևորգ. Եվ նա")
        en = {"headline": "Yerevan and Europe", "summary": "", "description": ""}
        self.assertEqual(self.check("Երեւանը եւ Եւրոպան", "", "hy", en)[0], "Երևանը և Եվրոպան")

    def test_an_armenian_sentence_ending_in_a_colon_gets_the_armenian_full_stop(self):
        en = {"headline": "Talks resume", "summary": "", "description": "Both sides met. They agreed."}
        _, desc, problems = self.check("Բանակցությունները վերսկսվել են", "Կողմերը հանդիպել են: Նրանք համաձայնել են:",
                                       "hy", en)
        self.assertEqual((desc, problems), ("Կողմերը հանդիպել են։ Նրանք համաձայնել են։", []))

    def test_dashes_are_removed_and_the_final_period_dropped(self):
        en = {"headline": "Moscow is the capital", "summary": "", "description": "It is big."}
        head, desc, problems = self.check("Москва — столица.", "Она – большая.", en=en)
        self.assertEqual((head, desc, problems), ("Москва, столица", "Она, большая.", []))
        for text in (head, desc):
            self.assertNotRegex(text, "[‒–—―]")

    def test_rejected_story_is_stored_unusable_and_retried_with_its_note(self):
        db = new_db()
        add_user(db, 1, "ru")
        a = add_story(db, "Strike kills 12", description="")
        drop = responder(fix=lambda it: {**it, "headline": "Удар унёс жизни людей"})
        g = FakeProvider("gemini", [drop])
        tr, _ = make(db, [g])
        res = tr.run(T0)
        self.assertEqual((rows(db)[a]["ok"], rows(db)[a]["headline"]), (0, None))
        self.assertIn("missing number(s) 12", rows(db)[a]["note"])
        self.assertEqual(res.status, "failed")
        self.assertTrue(any("rejected" in e for e in res.errors))
        g.responses.append(responder())
        tr.run(T0 + H)
        self.assertIn("missing number(s) 12", stories_in(g.prompts[1])[0]["retry_note"])
        self.assertEqual(rows(db)[a]["ok"], 1)


class WholeAnswerRetry(unittest.TestCase):
    def test_an_answer_with_most_stories_rejected_is_asked_again_at_once_with_the_notes(self):
        db = new_db()
        add_user(db, 1, "fr")
        for i in range(3):
            add_story(db, f"Talks on the {i} border crossings resumed today in the capital",
                      description="Both delegations met for a long session and agreed on the next steps.")
        plain = responder(lang_fn=lambda t: f"Les negociations ont repris {t}")         # no accents
        good = responder(lang_fn=lambda t: f"Les négociations ont repris {t}")
        g = FakeProvider("gemini", [plain, good])
        tr, calls = make(db, [g], languages={**LANGS, "enabled": ["en", "fr"]})
        res = tr.run(T0)
        self.assertEqual(len(calls), 2)
        self.assertEqual((res.langs["fr"].ok, res.langs["fr"].rejected), (3, 0))
        self.assertIn("French written without accents", stories_in(g.prompts[1])[0]["retry_note"])
        self.assertTrue(all(r["ok"] for r in rows(db, "fr").values()))

    def test_a_worse_second_answer_does_not_replace_the_first(self):
        db = new_db()
        add_user(db, 1, "ru")
        for i in range(3):
            add_story(db, f"Story {i}", description="")
        two_bad = responder(fix=lambda it: it if it["id"] == "S1" else {**it, "headline": "Story in English"})
        all_bad = responder(fix=lambda it: {**it, "headline": "Story in English"})
        tr, calls = make(db, [FakeProvider("gemini", [two_bad, all_bad])])
        res = tr.run(T0)
        self.assertEqual((len(calls), res.langs["ru"].ok, res.langs["ru"].rejected), (2, 1, 2))


class Providers(unittest.TestCase):
    def test_fallback_chain_and_groq_chunks(self):
        db = new_db()
        add_user(db, 1, "ru")
        for i in range(30):
            add_story(db, f"Story {i}")
        g1, g2 = FakeProvider("gemini", [DOWN]), FakeProvider("gemini-b", [DOWN])
        groq = FakeProvider("groq", [responder(), responder(), responder()])
        tr, calls = make(db, [g1, g2, groq])
        res = tr.run(T0)
        self.assertEqual([len(stories_in(p)) for p in groq.prompts], [12, 12, 6])
        self.assertEqual((len(rows(db)), res.langs["ru"].provider), (30, "groq"))
        self.assertEqual([c[1] for c in calls], [False, False, True, True, True])

    def test_every_provider_down_writes_nothing_and_says_so(self):
        db = new_db()
        add_user(db, 1, "ru")
        add_story(db, "Story")
        tr, _ = make(db, [FakeProvider("gemini", [DOWN]), FakeProvider("groq", [DOWN])])
        res = tr.run(T0)
        self.assertEqual((res.status, rows(db)), ("failed", {}))
        self.assertIn("no provider answered", res.errors[0])

    def test_invalid_answer_is_retried_once(self):
        db = new_db()
        add_user(db, 1, "ru")
        add_story(db, "Story")
        tr, calls = make(db, [FakeProvider("gemini", ["not json", responder()])])
        tr.run(T0)
        self.assertEqual(([c[1] for c in calls], len(rows(db))), ([False, True], 1))


class InTheJob(unittest.TestCase):
    def test_a_translate_failure_never_fails_the_run_and_calls_are_logged(self):
        from tests.helpers import Clock, Feeds, make_job
        db = new_db()
        add_user(db, 1, "ru")
        add_story(db, "Story")
        job = make_job(db, FakeProvider("gemini", [DOWN]), FakeProvider("groq", [DOWN]), Feeds(), Clock())
        stats = job.run()
        self.assertEqual(stats.translate.status, "failed")
        kinds = {r["kind"] for r in db.query("SELECT kind FROM ai_calls")}
        self.assertIn("translate_ru", kinds)
        self.assertEqual(db.query("SELECT status FROM job_runs")[0]["status"], "ok")

    def test_a_crash_inside_the_translate_step_never_fails_the_run(self):
        from unittest import mock
        from tests.helpers import Clock, Feeds, make_job
        db = new_db()
        job = make_job(db, FakeProvider("gemini", []), FakeProvider("groq", []), Feeds(), Clock())
        with mock.patch.object(translate.Translator, "run", side_effect=RuntimeError("D1 is down")):
            stats = job.run()
        self.assertEqual(stats.translate.status, "failed")
        run = db.query("SELECT status, error FROM job_runs")[0]
        self.assertEqual(run["status"], "ok")
        self.assertIn("translate: RuntimeError: D1 is down", run["error"])

    def test_prune_removes_translations_of_old_stories(self):
        from tests.helpers import Clock, Feeds, make_job
        db = new_db()
        old = add_story(db, "Old", age_h=24 * 8)
        db.query("INSERT INTO story_translations (story_id, lang, ok, headline, src, created_at) VALUES (?,?,?,?,?,?)",
                 [old, "ru", 1, "Старое", "x", T0])
        job = make_job(db, FakeProvider("gemini", []), FakeProvider("groq", []), Feeds(), Clock())
        job.prune_daily(T0)
        self.assertEqual(rows(db), {})


class SharedRule(unittest.TestCase):
    """tests/fixtures/eligible_cases.json is also checked by worker/test/i18n.test.mjs."""

    def test_python_rule_and_sql_agree_with_the_fixture(self):
        data = json.loads((ROOT / "tests" / "fixtures" / "eligible_cases.json").read_text(encoding="utf-8"))
        cfg, tags = data["cfg"], data["tags"]
        db = new_db()
        for c in data["cases"]:
            self.assertEqual(translate.qualifies(c, cfg, tags), c["eligible"], c)
            db.query("INSERT INTO stories (id, summary, topics, importance, best_url, best_source, best_tier, "
                     "created_at, updated_at, final_score, topic_score, main_topic) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                     [c["id"], "s", json.dumps(c["topics"]), c["importance"], "u", "src", 1, T0, T0,
                      c["final_score"], c["topic_score"], c["main_topic"]])
        got = {r["id"] for r in db.query(translate.ELIGIBLE_SQL, translate.eligible_params(T0, cfg, tags))}
        self.assertEqual(got, {c["id"] for c in data["cases"] if c["eligible"]})


class Prompt(unittest.TestCase):
    def test_prompt_and_config_files_load_and_have_no_dash(self):
        p = translate.load_translate_prompt()
        self.assertEqual(set(p.notes), {"ru", "hy", "fr"})
        self.assertIn("items", p.schema["properties"])
        for path in ("prompts/translate.md", "config/glossary.yaml", "config/languages.json"):
            self.assertNotRegex((ROOT / path).read_text(encoding="utf-8"), "[‒–—―]", path)
        names = translate.load_glossary()
        self.assertTrue(all(g.get("ru") and g.get("hy") and g.get("fr") for g in names))

    def test_only_glossary_names_in_the_batch_go_into_the_prompt(self):
        db = new_db()
        tr, _ = make(db, [])
        text = tr.render("ru", [{"id": 5, "headline": "Pashinyan visits Paris", "summary": "",
                                 "description": "", "retry_note": None}])
        self.assertIn("- Pashinyan: Пашинян", text)
        self.assertNotIn("Зеленский", text)
        self.assertIn('"id": "S5"', text)


if __name__ == "__main__":
    unittest.main()
