// Step 20: the Worker's side of the resilient AI chain (src/spend.js, askAI in src/custom.js, the hourly
// alert, Admin): the same order as the job, the paid emergency key only after every free option failed,
// hard caps checked against the worst case, one alert a day when money was spent.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { askAI, aiCallStatements, freeFailures, providers } from "../src/custom.js";
import { EM, callCost, modelPrice, shapeSpend, spendAlert, spendStatement, utcDayStart, utcMonthStart, whyNot, worstCost } from "../src/spend.js";
import { runTick } from "../src/cron.js";
import { adminStatements, adminSummary, shapeAdmin } from "../src/admin.js";
import { fakeD1, mockFetch } from "./helpers.mjs";
import { geminiResponse, isGemini, isGroq, promptOf, topicAnswer } from "./fake-ai.mjs";

let fetchMock;
afterEach(() => fetchMock?.restore());
const NOW = 1795464000;   // 2026-11-23 16:00 UTC
const ENV = { GEMINI_API_KEY: "free-key", GROQ_API_KEY: "groq-key", GEMINI_EMERGENCY_API_KEY: "paid-key" };
const noWait = async () => {};
const keyOf = (c) => c.init.headers?.["x-goog-api-key"] ?? (c.init.headers?.authorization ? "groq" : "?");

// free Gemini and Groq answer `free` (an HTTP status or "ok"); the paid key always answers well
function chain(free) {
  return mockFetch((url, init, body) => {
    const paid = init.headers?.["x-goog-api-key"] === "paid-key";
    if (isGemini(url) || isGroq(url)) {
      if (!paid && free !== "ok") return { status: free, body: { error: { message: "This model is currently experiencing high demand" } } };
      return { status: 200, body: geminiResponse(topicAnswer(promptOf(body))) };
    }
    return undefined;
  });
}
const PROMPT = 'The reader typed: "Colombia"\nThe reader\'s language: English\n';

describe("Step 20: prices and caps (twin of job/chain.py)", () => {
  test("prices, cost and the 2027 price change", () => {
    assert.deepEqual(modelPrice("gemini-3.1-flash-lite", NOW), [0.25, 1.5]);
    assert.equal(Math.round(callCost("gemini-3.1-flash-lite", 1e6, 1e6, NOW) * 100) / 100, 1.75);
    assert.deepEqual(modelPrice("gemini-3.8-flash", 1798761600), [1.5, 7.5]);
    assert.ok(worstCost("gemini-3.1-flash-lite", "x".repeat(4000), 2048, NOW) > 2048 * 1.5 / 1e6);
  });
  test("day, month, credits, expiry and an unreadable ledger (fail closed)", () => {
    assert.equal(whyNot({ day: 0, month: 0, total: 0 }, 0.01, NOW), null);
    assert.match(whyNot({ day: 0.095, month: 0.1, total: 0.1 }, 0.01, NOW), /daily cap/);
    assert.match(whyNot({ day: 0, month: 0.995, total: 1 }, 0.01, NOW), /monthly cap/);
    assert.match(whyNot({ day: 0, month: 0, total: 9.995 }, 0.01, NOW), /credits used up/);
    assert.match(whyNot({ day: 0, month: 0, total: 0 }, 0, 1826928000), /expired/);
    assert.match(whyNot(null, 0, NOW), /could not be read/);
  });
  test("UTC day and month starts", () => {
    assert.equal(utcDayStart(NOW), Date.UTC(2026, 10, 23) / 1000);
    assert.equal(utcMonthStart(NOW), Date.UTC(2026, 10, 1) / 1000);
    assert.deepEqual(spendStatement(NOW).params, [Date.UTC(2026, 10, 23) / 1000, Date.UTC(2026, 10, 1) / 1000]);
  });
});

describe("Step 20: the topic check's chain", () => {
  test("the order: free Gemini models, Groq's models, then the paid key", () => {
    const p = providers(ENV);
    assert.deepEqual(p.map((x) => x.name), ["gemini", "gemini", "groq", "groq", "groq", "gemini_paid"]);
    assert.equal(new Set(p.filter((x) => x.name === "groq").map((x) => x.model)).size, 3);
    assert.equal(p.at(-1).model, EM.model);
    assert.equal(providers({ GEMINI_API_KEY: "k", GROQ_API_KEY: "g" }).some((x) => x.paid), false);
  });

  test("a normal day: Gemini answers, the paid key is never called, nothing is spent", async () => {
    const { db, sqlite } = fakeD1();
    fetchMock = chain("ok");
    const r = await askAI(ENV, PROMPT, "en", NOW, { db, sleep: noWait });
    assert.ok(r.answer);
    assert.deepEqual(fetchMock.calls.map(keyOf), ["free-key"]);
    await db.batch(aiCallStatements(r.calls));
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM ai_spend").get().n, 0);
  });

  test("a free Gemini 503 is tried once more before the next model", async () => {
    const { db } = fakeD1();
    let n = 0;
    fetchMock = mockFetch((url, init, body) => {
      if (!isGemini(url)) return undefined;
      n++;
      return n === 1 ? { status: 503, body: { error: { message: "high demand" } } } : { status: 200, body: geminiResponse(topicAnswer(promptOf(body))) };
    });
    const waits = [];
    const r = await askAI(ENV, PROMPT, "en", NOW, { db, sleep: async (ms) => waits.push(ms) });
    assert.ok(r.answer);
    assert.deepEqual(r.calls.map((c) => [c.model, c.code ?? null, c.ok]), [["gemini-3.5-flash-lite", 503, 0], ["gemini-3.5-flash-lite", null, 1]]);
    assert.deepEqual(waits, [1500]);
  });

  test("every free option failing: the paid key answers, its cost and why go to ai_spend", async () => {
    const { db, sqlite } = fakeD1();
    fetchMock = chain(503);
    const r = await askAI(ENV, PROMPT, "en", NOW, { db, sleep: noWait });
    assert.ok(r.answer);
    const paid = r.calls.at(-1);
    assert.equal(paid.provider, "gemini_paid");
    assert.ok(paid.usd > 0 && paid.usd < 0.01);
    assert.match(paid.reason, /gemini-3.5-flash-lite: HTTP 503 x2/);
    assert.match(paid.reason, /openai\/gpt-oss-120b: HTTP 503/);
    await db.batch(aiCallStatements(r.calls));
    const row = sqlite.prepare("SELECT source, model, kind, usd, reason FROM ai_spend").get();
    assert.deepEqual([row.source, row.model, row.kind], ["worker", EM.model, "topic_check"]);
    assert.equal(fetchMock.calls.filter((c) => keyOf(c) === "paid-key").length, 1);
  });

  test("the cap stops paid use: no paid request at all, the refusal is logged", async () => {
    const { db, sqlite } = fakeD1();
    sqlite.prepare("INSERT INTO ai_spend (at, source, model, usd) VALUES (?, 'job', 'm', ?)").run(NOW - 60, Number(EM.daily_cap_usd) - 0.0001);
    fetchMock = chain(503);
    const r = await askAI(ENV, PROMPT, "en", NOW, { db, sleep: noWait });
    assert.equal(r.answer, null);
    assert.equal(fetchMock.calls.filter((c) => keyOf(c) === "paid-key").length, 0);
    assert.match(r.calls.at(-1).error, /emergency key not used: daily cap/);
  });

  test("without the database (no spend can be read) the paid key is never used", async () => {
    fetchMock = chain(503);
    const r = await askAI(ENV, PROMPT, "en", NOW, { sleep: noWait });
    assert.equal(r.answer, null);
    assert.equal(fetchMock.calls.filter((c) => keyOf(c) === "paid-key").length, 0);
  });

  test("why: the failed free calls, condensed", () => {
    assert.equal(freeFailures([{ ok: 0, provider: "gemini", model: "a", code: 503 }, { ok: 0, provider: "gemini", model: "a", code: 503 },
      { ok: 0, provider: "groq", model: "g", code: null, error: "groq: network error timeout" }]), "a: HTTP 503 x2; g: network error timeout");
  });
});

describe("Step 20: the alert and Admin", () => {
  test("one alert on a UTC day the paid key spent money, with the amount and why; none on a normal day", async () => {
    assert.equal(spendAlert([], [], NOW), null);
    const rows = [{ source: "job", model: EM.model, kind: "batch", usd: 0.012, reason: "gemini-3.5-flash-lite: HTTP 503 x3" },
                  { source: "worker", model: EM.model, kind: "topic_check", usd: 0.001, reason: "groq: HTTP 429" }];
    const a = spendAlert(rows, [], NOW);
    assert.match(a.text, /\$0\.0130 so far \(2 calls: batch 1, topic_check 1\)/);
    assert.match(a.text, /Why: gemini-3.5-flash-lite: HTTP 503 x3/);
    assert.match(a.text, /What to do:/);
    assert.doesNotMatch(a.text, /[\u2013\u2014]/);
    assert.equal(spendAlert(rows, [{ value: "2026-11-23" }], NOW), null);   // already sent today
  });

  test("the hourly tick sends it once (production) and never on staging", async () => {
    const { db, sqlite } = fakeD1();
    sqlite.prepare("INSERT INTO ai_spend (at, source, model, kind, usd, reason) VALUES (?, 'job', 'm', 'batch', 0.02, 'x')").run(NOW - 600);
    const sent = [];
    const io = { send: async () => ({}), alert: async (t) => sent.push(t), appUrl: "https://w.test/app/" };
    const hourTs = NOW - (NOW % 3600);
    await runTick(db, io, hourTs, { digests: false, guard: true, stats: false, health: true });
    await runTick(db, io, hourTs + 3600, { digests: false, guard: true, stats: false, health: true });
    assert.equal(sent.filter((t) => /emergency Gemini key/.test(t)).length, 1);
    const quiet = fakeD1();
    quiet.sqlite.prepare("INSERT INTO ai_spend (at, source, model, kind, usd) VALUES (?, 'job', 'm', 'batch', 0.02)").run(NOW - 600);
    const none = [];
    await runTick(quiet.db, { ...io, alert: async (t) => none.push(t) }, hourTs, { digests: false, guard: false, stats: true, health: false });
    assert.equal(none.length, 0);
  });

  test("Admin: spend today, this month, credits left, expiry, and the provider of each recent run", async () => {
    const { db, sqlite } = fakeD1();
    sqlite.prepare("INSERT INTO ai_spend (at, source, model, usd) VALUES (?, 'job', 'm', 0.03)").run(NOW - 600);
    sqlite.prepare("INSERT INTO ai_spend (at, source, model, usd) VALUES (?, 'job', 'm', 0.2)").run(NOW - 5 * 86400);
    sqlite.prepare("INSERT INTO job_runs (started_at, finished_at, status, provider, items_pending_in, items_left_pending, stories_created) VALUES (?, ?, 'ok', 'gemini-fallback+groq', 300, 0, 80)").run(NOW - 3000, NOW - 2800);
    const rows = await db.batch(adminStatements(NOW));
    const A = shapeAdmin(rows, NOW);
    assert.equal(A.emergency.today, 0.03);
    assert.equal(Math.round(A.emergency.month * 100) / 100, 0.23);
    assert.equal(Math.round(A.emergency.credits_left * 100) / 100, 9.77);
    assert.equal(A.emergency.expires, "2027-11-23");
    assert.deepEqual(A.runs.map((r) => [r.provider, r.duration_s, r.stories]), [["gemini-fallback+groq", 200, 80]]);
    const S = adminSummary({ ...A, custom: { guard: { level: 0, job_level: 0, models: [] } } }, NOW);
    assert.ok(S.issues.some((i) => /emergency key was used today/.test(i.text)));
  });

  test("a spend estimate in a shape", () => {
    const s = shapeSpend({ day: 0.01, month: 0.05, total: 0.05, day_calls: 2 }, NOW);
    assert.deepEqual([s.daily_cap, s.monthly_cap, s.credits, s.calls_today], [0.1, 1, 10, 2]);
  });
});
