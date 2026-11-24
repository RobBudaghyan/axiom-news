"""Step 20: the resilient AI chain and translation quality.

- free Gemini 503s are retried with backoff inside the run's retry time, then the model is "down"
  for the run (one try per call, no long waits); a 402 (prepay credits depleted) stops every model
  on that key at once
- Groq's models in rotation (a 429 moves on, a daily limit takes a model out)
- the emergency key: only for work every free option FAILED on, hard caps checked against the
  call's worst case, its cost logged in ai_spend with the reason
- the degraded order: followed topics first, then the source tier
- translations: never Groq, the meaning check (reading back, terms), the redo, Latin words in
  Armenian, the source title and the terms in the prompt

    venv/Scripts/python -m unittest tests.test_step20 -v
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job import ai, chain, translate  # noqa: E402
from job.config import Settings  # noqa: E402
from job.run import Job, PlanList, ProviderPlan, degraded_order, parse_force  # noqa: E402
from tests.helpers import (SOURCES, T0, TOPICS, Clock, FakeProvider, FakeResponse, FakeSession, Feeds,  # noqa: E402
                           entry, grouping_responder, new_db)
from tests.test_translate import LANGS, add_story, add_user, responder, rows, stories_in  # noqa: E402

BUDGET = json.loads((Path(__file__).resolve().parent.parent / "config" / "ai_budget.json").read_text(encoding="utf-8"))
EM = BUDGET["emergency"]
OK_BODY = {"candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": '{"stories": []}'}]}}],
           "usageMetadata": {"promptTokenCount": 1000, "candidatesTokenCount": 500}}
DOWN = ai.AIError("gemini", "HTTP 503: high demand", kind="http", status=503)
GROQ_DOWN = ai.AIError("groq", "HTTP 503", kind="http", status=503)


class FakePaid(FakeProvider):
    """The emergency key in a Job test: costs `usd` a call, refuses (kind cap) once `budget` is spent."""

    def __init__(self, responses, usd=0.01, budget=1.0):
        super().__init__("gemini_paid", responses)
        self.model = EM["model"]
        self.usd, self.budget, self.spent, self.last_cost = usd, budget, 0.0, 0.0

    def generate(self, prompt, schema):
        self.last_cost = 0.0
        if self.spent + self.usd > self.budget:
            raise ai.AIError("gemini_paid", "emergency key not used: daily cap", kind="cap")
        res = super().generate(prompt, schema)
        self.spent += self.usd
        self.last_cost = self.usd
        return res


def job_with(db, plans, clock, **settings):
    s = Settings(**settings)
    return Job(db, PlanList(plans), settings=s, topics=TOPICS, sources=SOURCES, fetcher=FEEDS, clock=clock,
               log=lambda _m: None, editor_enabled=False, translate_enabled=False, custom_enabled=False)


FEEDS = Feeds()


def plan(p, s=None, **kw):
    s = s or Settings()
    return ProviderPlan(p, kw.pop("budget", s.gemini_max_input_tokens), kw.pop("existing", s.existing_max),
                        kw.pop("max_chunks", 4), **kw)


class GeminiRetries(unittest.TestCase):
    def test_503_backoff_inside_the_retry_budget_then_down_for_the_run(self):
        sleeps = []
        budget = ai.RetryBudget(20)
        g = ai.GeminiProvider("k", "m", retry_delays=(5, 15, 30), sleep=sleeps.append, budget=budget,
                              session=FakeSession([FakeResponse(503)] * 3 + [FakeResponse(503)]))
        with self.assertRaises(ai.AIError):
            g.generate("p", None)
        self.assertEqual(sleeps, [5, 15])          # the 30 s wait did not fit the 20 s budget
        self.assertTrue(g.down)
        with self.assertRaises(ai.AIError):         # later calls this run: one try, no waits
            g.generate("p", None)
        self.assertEqual(sleeps, [5, 15])

    def test_after_its_retries_ran_out_a_model_is_tried_once_with_no_waits(self):
        sleeps = []
        g = ai.GeminiProvider("k", "m", retry_delays=(5, 15, 30), sleep=sleeps.append, budget=ai.RetryBudget(150),
                              session=FakeSession([FakeResponse(503)] * 5))
        with self.assertRaises(ai.AIError):
            g.generate("p", None)
        self.assertEqual(sleeps, [5, 15, 30])
        with self.assertRaises(ai.AIError):
            g.generate("p", None)
        self.assertEqual((sleeps, g.session.posts), ([5, 15, 30], 5))

    def test_groq_400_failed_json_is_a_bad_answer_not_an_outage(self):
        body = {"error": {"message": "Failed to validate JSON. Please adjust your prompt.", "failed_generation": "{"}}
        g = ai.GroqProvider("k", "m", session=FakeSession([FakeResponse(400, body)]))
        with self.assertRaises(ai.AIError) as cm:
            g.generate("p", None)
        self.assertEqual(cm.exception.kind, "invalid")

    def test_a_503_storm_then_an_answer(self):
        sleeps = []
        g = ai.GeminiProvider("k", "m", retry_delays=(5, 15, 30), sleep=sleeps.append, budget=ai.RetryBudget(150),
                              session=FakeSession([FakeResponse(503), FakeResponse(503), FakeResponse(200, OK_BODY)]))
        self.assertEqual(g.generate("p", None).input_tokens, 1000)
        self.assertEqual((sleeps, g.down), ([5, 15], False))

    def test_the_run_deadline_stops_retries(self):
        clock = Clock(1000)
        budget = ai.RetryBudget(150, deadline=1000 + 70, clock=clock)   # 70 s left: no 5 s wait (60 s margin)...
        self.assertTrue(budget.take(5))
        self.assertFalse(budget.take(15))

    def test_402_prepay_depleted_stops_every_model_on_that_key(self):
        key = ai.KeyState("free")
        body = {"error": {"message": "Your prepayment credits are depleted."}}
        a = ai.GeminiProvider("k", "a", key=key, session=FakeSession([FakeResponse(402, body)]))
        b_session = FakeSession([])
        b = ai.GeminiProvider("k", "b", key=key, session=b_session)
        with self.assertRaises(ai.AIError) as cm:
            a.generate("p", None)
        self.assertEqual(cm.exception.kind, "billing")
        with self.assertRaises(ai.AIError):
            b.generate("p", None)
        self.assertEqual(b_session.posts, 0)        # no request at all

    def test_no_free_quota_takes_the_model_out_for_the_run(self):
        body = {"error": {"message": "Quota exceeded, limit: 0, model: x"}}
        s = FakeSession([FakeResponse(429, body)])
        g = ai.GeminiProvider("k", "m", session=s)
        for _ in range(2):
            with self.assertRaises(ai.AIError):
                g.generate("p", None)
        self.assertEqual(s.posts, 1)


GROQ_OK = {"choices": [{"finish_reason": "stop", "message": {"content": '{"stories": []}'}}],
           "usage": {"prompt_tokens": 9, "completion_tokens": 4}}


class GroqRotation(unittest.TestCase):
    def member(self, model, responses):
        return ai.GroqProvider("k", model, session=FakeSession(responses), wait_429=False, sleep=lambda s: None)

    def test_a_429_moves_on_to_the_next_model(self):
        a = self.member("a", [FakeResponse(429, {"error": {"message": "TPM"}}, {"retry-after": "7"})])
        b = self.member("b", [FakeResponse(200, GROQ_OK)])
        pool = chain.GroqPool([a, b], sleep=lambda s: None, clock=Clock(0))
        res = pool.generate("p", None)
        self.assertEqual((res.model, pool.model, pool.busy_until["a"]), ("b", "b", 7))

    def test_every_model_briefly_busy_waits_and_goes_round_again(self):
        busy = lambda: FakeResponse(429, {"error": {"message": "ITPM"}}, {"retry-after": "1"})  # noqa: E731
        a = self.member("a", [busy(), FakeResponse(200, GROQ_OK)])
        b = self.member("b", [busy()])
        sleeps = []
        pool = chain.GroqPool([a, b], sleep=sleeps.append, clock=Clock(0))
        self.assertEqual(pool.generate("p", None).model, "a")
        self.assertEqual(sleeps, [1.5])

    def test_too_large_for_one_model_tries_the_next(self):
        a = self.member("a", [FakeResponse(413, {"error": {"message": "Request too large"}})])
        b = self.member("b", [FakeResponse(200, GROQ_OK)])
        pool = chain.GroqPool([a, b], sleep=lambda s: None, clock=Clock(0))
        self.assertEqual(pool.generate("p", None).model, "b")
        only = chain.GroqPool([self.member("c", [FakeResponse(413, {"error": {"message": "big"}})])], sleep=lambda s: None, clock=Clock(0))
        with self.assertRaises(ai.AIError) as cm:
            only.generate("p", None)
        self.assertEqual(cm.exception.kind, "too_large")

    def test_a_daily_limit_takes_a_model_out(self):
        a = self.member("a", [FakeResponse(429, {"error": {"message": "Limit tokens per day (TPD)"}}, {"retry-after": "3600"})])
        b = self.member("b", [FakeResponse(200, GROQ_OK), FakeResponse(200, GROQ_OK)])
        pool = chain.GroqPool([a, b], sleep=lambda s: None, clock=Clock(0))
        pool.generate("p", None)
        self.assertEqual(a.dead, "daily limit")
        pool.current = a
        self.assertEqual(pool.generate("p", None).model, "b")

    def test_picks_the_model_with_room_instead_of_sleeping(self):
        clock = Clock(0)
        a, b = self.member("a", []), self.member("b", [])
        a.limits = {"x-ratelimit-remaining-tokens": 100, "x-ratelimit-reset-tokens": 40.0, "at": 0}
        b.limits = {"x-ratelimit-remaining-tokens": 7000, "x-ratelimit-reset-tokens": 2.0, "at": 0}
        sleeps = []
        pool = chain.GroqPool([a, b], sleep=sleeps.append, clock=clock)
        self.assertEqual((pool.wait_for_tokens(5000), pool.model, sleeps), (0.0, "b", []))

    def test_every_model_down_raises(self):
        pool = chain.GroqPool([self.member("a", [FakeResponse(503)]), self.member("b", [FakeResponse(503)])],
                              sleep=lambda s: None, clock=Clock(0))
        with self.assertRaises(ai.AIError):
            pool.generate("p", None)

    def test_reasoning_effort_only_for_gpt_oss(self):
        sent = []

        class S(FakeSession):
            def post(self, url, json=None, timeout=None):
                sent.append(json)
                return FakeResponse(200, GROQ_OK)
        ai.GroqProvider("k", "qwen/qwen3.8-27b", session=S([])).generate("p", None)
        ai.GroqProvider("k", "openai/gpt-oss-120b", session=S([])).generate("p", None)
        self.assertEqual(["reasoning_effort" in b for b in sent], [False, True])


class Caps(unittest.TestCase):
    def guard(self, day=0.0, month=0.0, total=0.0, at=T0, **cfg):
        return chain.SpendGuard({**EM, **cfg}, day, month, total, now=lambda: at)

    def test_prices_and_cost(self):
        self.assertEqual(chain.model_price("gemini-3.1-flash-lite", EM, T0), (0.25, 1.50))
        self.assertAlmostEqual(chain.call_cost("gemini-3.1-flash-lite", 1_000_000, 1_000_000, EM, T0), 1.75)
        jan = 1798761600   # 2027-01-01: the 3.8 Flash price doubles
        self.assertEqual(chain.model_price("gemini-3.8-flash", EM, jan), (1.50, 7.50))
        self.assertEqual(chain.model_price("gemini-unknown", EM, T0), (3.0, 15.0))

    def test_daily_monthly_credits_and_expiry(self):
        self.assertIsNone(self.guard().why_not(0.05))
        self.assertIn("daily cap", self.guard(day=0.06).why_not(0.05))
        self.assertIn("monthly cap", self.guard(day=0.0, month=0.97).why_not(0.05))
        self.assertIn("credits used up", self.guard(total=9.99).why_not(0.05))
        self.assertIn("expired", self.guard(at=1826928000).why_not(0.0))     # 2027-11-23
        self.assertIn("could not be read", chain.SpendGuard(EM, readable=False).why_not(0.0))

    def test_emergency_provider_refuses_on_the_worst_case_and_counts_the_real_cost(self):
        spend = self.guard()
        p = chain.EmergencyProvider("k", "gemini-3.1-flash-lite", spend, session=FakeSession([FakeResponse(200, OK_BODY)]))
        worst = p.worst_cost("x" * 4000)
        self.assertGreater(worst, 0.018)                   # 12,000 output tokens at $1.50 per million
        res = p.generate("x" * 4000, None)
        self.assertAlmostEqual(res.extra["cost_usd"], (1000 * 0.25 + 500 * 1.50) / 1e6)
        self.assertAlmostEqual((spend.day, p.last_cost), (res.extra["cost_usd"], res.extra["cost_usd"]))
        near = self.guard(day=0.10 - worst / 2)
        p2 = chain.EmergencyProvider("k", "gemini-3.1-flash-lite", near, session=FakeSession([]))
        with self.assertRaises(ai.AIError) as cm:
            p2.generate("x" * 4000, None)
        self.assertEqual((cm.exception.kind, p2.last_cost), ("cap", 0.0))

    def test_ledger_sums_per_utc_day_and_month(self):
        db = new_db()
        day = chain.utc_day_start(int(T0))
        for at, usd in [(day + 10, 0.02), (day - 10, 0.03), (chain.utc_month_start(int(T0)) - 10, 0.5)]:
            db.query("INSERT INTO ai_spend (at, source, model, usd) VALUES (?, 'job', 'm', ?)", [at, usd])
        g = chain.SpendGuard.load(db, EM, int(T0))
        self.assertAlmostEqual(g.day, 0.02)
        self.assertAlmostEqual(g.total, 0.55)
        self.assertAlmostEqual(g.month, 0.05 if chain.utc_month_start(int(T0)) <= day - 10 else 0.02)


class ChainInTheJob(unittest.TestCase):
    def setUp(self):
        self.db = new_db()
        self.clock = Clock()
        now = self.clock()
        FEEDS.entries = [entry("alpha", f"IRAN: item {i}", 10 + i, now, i) for i in range(6)]
        self.answer = grouping_responder({"IRAN": ["iran_war"]})

    def test_a_normal_run_never_touches_the_paid_key(self):
        paid = FakePaid([])
        job_with(self.db, [plan(FakeProvider("gemini", [self.answer])), plan(paid, paid=True)], self.clock).run()
        self.assertEqual((paid.prompts, self.db.query("SELECT * FROM ai_spend")), ([], []))

    def test_groq_rescues_a_free_gemini_outage_with_no_spend(self):
        paid = FakePaid([])
        groq = FakeProvider("groq", [self.answer])
        job_with(self.db, [plan(FakeProvider("gemini", [DOWN])), plan(FakeProvider("gemini-b", [DOWN])),
                           plan(groq, reply_tokens=0), plan(paid, paid=True)], self.clock).run()
        run = self.db.query("SELECT status, provider FROM job_runs")[0]
        self.assertEqual((run["status"], run["provider"], paid.prompts), ("ok", "groq", []))
        self.assertEqual(self.db.query("SELECT * FROM ai_spend"), [])

    def test_paid_key_only_after_every_free_option_failed_and_the_spend_is_logged_with_why(self):
        paid = FakePaid([self.answer], usd=0.012)
        job_with(self.db, [plan(FakeProvider("gemini", [DOWN])), plan(FakeProvider("groq", [GROQ_DOWN])),
                           plan(paid, paid=True, label="emergency")], self.clock).run()
        run = self.db.query("SELECT status, provider FROM job_runs")[0]
        self.assertEqual((run["status"], run["provider"]), ("ok", "emergency"))
        spend = self.db.query("SELECT source, model, kind, usd, reason FROM ai_spend")
        self.assertEqual(len(spend), 1)
        self.assertEqual((spend[0]["source"], spend[0]["kind"], spend[0]["usd"]), ("job", "batch", 0.012))
        self.assertIn("HTTP 503", spend[0]["reason"])

    def test_items_a_free_provider_had_no_calls_left_for_wait_and_never_go_to_the_paid_key(self):
        now = self.clock()
        FEEDS.entries = [entry("alpha", f"IRAN: item {i} " + "word " * 120, 10 + i, now, i) for i in range(12)]
        paid = FakePaid([])
        groq = FakeProvider("groq", [self.answer])
        job_with(self.db, [plan(FakeProvider("gemini", [DOWN])), plan(groq, budget=1500, existing=0, max_chunks=1),
                           plan(paid, paid=True)], self.clock).run()
        self.assertEqual(paid.prompts, [])
        pending = self.db.query("SELECT count(*) AS n FROM items WHERE status = 'pending'")[0]["n"]
        self.assertGreater(pending, 0)

    def test_the_cap_stops_paid_use_and_the_rest_waits(self):
        now = self.clock()
        FEEDS.entries = [entry("alpha", f"IRAN: item {i} " + "word " * 120, 10 + i, now, i) for i in range(12)]
        paid = FakePaid([self.answer, self.answer, self.answer], usd=0.06, budget=0.10)
        job_with(self.db, [plan(FakeProvider("gemini", [DOWN])), plan(FakeProvider("groq", [GROQ_DOWN])),
                           plan(paid, paid=True, budget=1500, existing=0, max_chunks=5)], self.clock).run()
        self.assertEqual(len(paid.prompts), 1)                 # the second call would pass $0.10
        self.assertAlmostEqual(sum(r["usd"] for r in self.db.query("SELECT usd FROM ai_spend")), 0.06)
        errors = " ".join(r["message"] for r in self.db.query("SELECT message FROM errors"))
        self.assertIn("emergency key not used: daily cap", errors)
        self.assertGreater(self.db.query("SELECT count(*) AS n FROM items WHERE status = 'pending'")[0]["n"], 0)


class DegradedOrder(unittest.TestCase):
    def test_followed_topics_then_tier_then_newest(self):
        items = [{"id": 1, "source_key": "x", "tier": 1, "published_at": 5},
                 {"id": 2, "source_key": "y", "tier": 3, "published_at": 9},
                 {"id": 3, "source_key": "x", "tier": 2, "published_at": 7},
                 {"id": 4, "source_key": "z", "tier": 4, "published_at": 1, "hint_topic": "c7"},
                 {"id": 5, "source_key": "x", "tier": 1, "published_at": 8}]
        got = degraded_order(items, {"armenia", "c7"}, {"x": ["politics_conflicts"], "y": ["armenia"], "z": []})
        self.assertEqual([i["id"] for i in got], [2, 4, 5, 1, 3])


class BuiltChain(unittest.TestCase):
    def test_the_order_and_sizes_from_config(self):
        from unittest import mock
        import job.run as run
        env = {"GEMINI_API_KEY": "f", "GROQ_API_KEY": "g", "GEMINI_EMERGENCY_API_KEY": "p", "CLOUDFLARE_ACCOUNT_ID": "a",
               "D1_DATABASE_ID": "d", "CLOUDFLARE_D1_TOKEN": "t"}
        with mock.patch.object(run, "D1"), mock.patch.object(chain.SpendGuard, "load", lambda db, cfg, now: chain.SpendGuard(cfg)):
            _, plans = run.build_from_env(env, Settings(), BUDGET)
        s = Settings()
        self.assertEqual([p.label for p in plans], ["gemini"] + ["gemini-fallback"] * 3 + ["groq", "emergency"])
        self.assertEqual(plans[-1].budget_tokens, s.emergency_chunk_tokens)
        self.assertLess(s.emergency_chunk_tokens, s.gemini_max_input_tokens)
        self.assertEqual((plans[4].budget_tokens, plans[4].existing_max), (s.groq_chunk_tokens, s.groq_existing_max))
        self.assertLessEqual(s.groq_chunk_tokens + s.groq_reply_tokens, 8000)
        self.assertLessEqual(s.editor_paid_new + s.editor_paid_compare, 25)   # fits the 12k answer limit
        self.assertEqual([p.provider.name for p in plans.translate], ["gemini", "gemini", "gemini_paid", "gemini_paid"])
        self.assertTrue(all(p.paid for p in plans.translate[2:]))

    def test_the_editor_asks_the_paid_key_for_a_smaller_batch(self):
        from job import editor
        down = ai.AIError("gemini_paid", "down", kind="http")
        db = new_db()
        for i in range(40):
            db.query("INSERT INTO stories (summary, topics, importance, best_url, best_source, best_tier, created_at, updated_at) "
                     "VALUES (?, ?, 6, 'u', 'A', 1, ?, ?)",
                     [f"Story number {i} about things", json.dumps(["politics_conflicts"]), int(T0) - 60, int(T0) - 60])
        sizes = []
        orig = editor.choose
        editor.choose = lambda pool, order, n, per, comp: (sizes.append((n, comp)) or orig(pool, order, n, per, comp))
        try:
            ed = editor.Editor(db, [ProviderPlan(FakeProvider("gemini_paid", [down]), 25000, 0, 1, paid=True)], topics=TOPICS, facts=[],
                               facts_checked="2026-01-01", log=lambda _m: None)
            ed.run(int(T0))
        finally:
            editor.choose = orig
        self.assertEqual(sizes[0], (Settings().editor_paid_new, Settings().editor_paid_compare))


class Force(unittest.TestCase):
    def test_forced_failures_are_staging_only(self):
        import os
        old = os.environ.pop("AXIOM_ENV", None)
        try:
            with self.assertRaises(SystemExit):
                parse_force("gemini503")
            self.assertEqual(parse_force(""), {"gemini503": False, "translate503": False, "groq503": False, "nopaid": False})
            os.environ["AXIOM_ENV"] = "staging"
            self.assertTrue(parse_force("gemini503,nopaid")["nopaid"])
        finally:
            os.environ.pop("AXIOM_ENV", None)
            if old is not None:
                os.environ["AXIOM_ENV"] = old


# ---------------------------------------------------------------- translation quality

HY_EN = "Ukrainian intelligence says Russian special services posted 20 million espionage job ads on Discord"
HY_BAD = "Ուկրաինական խաբեությունը ասում է, որ ռուսական հատուկ ծառայությունները Discord-ում տեղադրել են 20 միլիոն գուշակության աշխատանքի հայտարարություններ"
HY_GOOD = "Ուկրաինական հետախուզությունը հայտնում է, որ ռուսական հատուկ ծառայությունները Discord-ում տեղադրել են լրտեսության 20 միլիոն աշխատանքի հայտարարություն"
HY_LANGS = {**LANGS, "enabled": ["en", "ru", "fr", "hy"]}


def hy_translator(db, providers, terms=None):
    s = Settings()
    plans = [ProviderPlan(p, 25000, 0, 4, label=p.name) for p in providers]
    calls = []
    tr = translate.Translator(db, plans, settings=s, languages=HY_LANGS, glossary=[],
                              on_call=lambda p, ok, n, res, err, kind: calls.append((p.name, ok, kind)),
                              log=lambda _m: None, terms=translate.load_terms() if terms is None else terms)
    return tr, calls


def check_answer(back_by_text, same=True, problem=""):
    """A fake meaning check: reads each translation back with the given English."""
    def respond(prompt):
        items = json.loads(prompt.split("STORIES (JSON):\n", 1)[1].split("\n\nAnswer with JSON", 1)[0])
        out = []
        for it in items:
            back = next((v for k, v in back_by_text.items() if k in it["translation"]), it["english"])
            bad = "խաբեություն" in it["translation"]
            out.append({"id": it["id"], "back": back, "same_meaning": (not bad) and same,
                        "problem": "intelligence read as deception; espionage job ads as fortune-telling ads" if bad else problem})
        return {"items": out}
    return respond


def hy_reply(headline):
    def respond(prompt):
        return {"items": [{"id": s["id"], "headline": headline, "description": ""} for s in stories_in(prompt)]}
    return respond


class MeaningCheck(unittest.TestCase):
    def setUp(self):
        self.db = new_db()
        add_user(self.db, 1, "hy")
        self.sid = add_story(self.db, HY_EN, description="")

    def test_the_bad_armenian_example_is_rejected_then_redone_with_the_problem(self):
        back = {HY_BAD: "Ukrainian deception says Russian special services posted 20 million fortune-telling job ads on Discord",
                HY_GOOD: HY_EN}
        g = FakeProvider("gemini", [hy_reply(HY_BAD), check_answer(back), hy_reply(HY_GOOD), check_answer(back)])
        tr, calls = hy_translator(self.db, [g])
        res = tr.run(T0)
        r = rows(self.db, "hy")[self.sid]
        self.assertEqual((r["ok"], r["headline"]), (1, HY_GOOD))
        lr = res.langs["hy"]
        self.assertEqual((lr.check_calls, lr.drifted, lr.redone, lr.calls), (2, 1, 1, 4))
        self.assertIn("deception", json.dumps(stories_in(g.prompts[2]), ensure_ascii=False))   # the redo saw the problem
        self.assertEqual([c[2] for c in calls], ["translate_hy", "backcheck_hy", "translate_hy", "backcheck_hy"])

    def test_still_drifted_after_the_redo_is_rejected_with_the_reason(self):
        back = {HY_BAD: "Ukrainian deception says special services posted 20 million fortune-telling job ads on Discord"}
        g = FakeProvider("gemini", [hy_reply(HY_BAD), check_answer(back), hy_reply(HY_BAD), check_answer(back)])
        tr, _ = hy_translator(self.db, [g])
        tr.run(T0)
        r = rows(self.db, "hy")[self.sid]
        self.assertEqual(r["ok"], 0)
        self.assertIn("deception", r["note"])

    def test_the_term_rule_catches_a_lost_word_even_when_the_model_says_same(self):
        probs = translate.meaning_problems(HY_EN, "Ukrainian deception says Russian special services posted job ads",
                                           True, "", translate.load_terms())
        self.assertTrue(any("'intelligence'" in p for p in probs))
        self.assertTrue(any("'espionage'" in p for p in probs))
        self.assertEqual(translate.meaning_problems(HY_EN, HY_EN, True, "", translate.load_terms()), [])

    def test_no_provider_for_the_meaning_check_means_the_story_waits(self):
        g = FakeProvider("gemini", [hy_reply(HY_GOOD), DOWN])
        tr, _ = hy_translator(self.db, [g])
        res = tr.run(T0)
        self.assertEqual((rows(self.db, "hy"), res.langs["hy"].unanswered), ({}, 1))

    def test_terms_and_the_source_title_are_in_the_prompt(self):
        self.db.query("INSERT INTO items (id, url_hash, source_key, source_name, tier, url, title, fetched_at, status, story_id) "
                      "VALUES (1, 'h', 'up', 'Ukrainska Pravda', 2, 'https://a.test/x', 'Розвідка: спецслужби РФ розмістили оголошення', ?, 'done', ?)",
                      [int(T0), self.sid])
        g = FakeProvider("gemini", [hy_reply(HY_GOOD), check_answer({})])
        tr, _ = hy_translator(self.db, [g])
        tr.run(T0)
        prompt = g.prompts[0]
        self.assertIn("intelligence (spy agencies", prompt)
        self.assertIn(": հետախուզություն", prompt)
        self.assertEqual(stories_in(prompt)[0]["source_title"], "Розвідка: спецслужби РФ розмістили оголошення")

    def test_groq_never_translates_or_checks(self):
        groq = FakeProvider("groq", [hy_reply(HY_GOOD), check_answer({})])
        tr, _ = hy_translator(self.db, [FakeProvider("gemini", [DOWN]), groq])
        tr.run(T0)
        self.assertEqual((groq.prompts, rows(self.db, "hy")), ([], {}))


class LatinWords(unittest.TestCase):
    def test_a_polish_word_inside_armenian_is_rejected_but_names_from_the_english_pass(self):
        en = {"headline": "Poland says Russian missiles entered airspace", "description": "Prosecutors confirmed it on Discord."}
        _, _, probs = translate.check_translation(
            "hy", en, "Լեհաստանը հայտնել է, że ռուսական հրթիռները մուտք են գործել", "Դատախազները հաստատել են Discord-ում։", [])
        self.assertTrue(any("że" in p for p in probs))
        _, _, ok = translate.check_translation(
            "hy", en, "Լեհաստանը հայտնել է, որ ռուսական հրթիռները մուտք են գործել", "Դատախազները հաստատել են Discord-ում։", [])
        self.assertEqual(ok, [])


if __name__ == "__main__":
    unittest.main()
