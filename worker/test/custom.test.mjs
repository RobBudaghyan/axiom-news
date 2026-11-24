// Step 13: custom topics ("My topics") and the AI budget guard, Worker side: the add/remove API
// with the one AI check (a stand-in for Gemini, test/fake-ai.mjs), sharing and synonyms, the limits,
// the block list, Admin, digests with custom sections and the guard (twin of job/guard.py).
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";
import { signInitData } from "../src/auth.js";
import { CONFIG, candidateStatement, planDigest, qualifies, pickStories, fitToLength, topicInfoFrom } from "../src/digest.js";
import { runTick } from "../src/cron.js";
import { assess, pacificDay, guardState } from "../src/guard.js";
import { NEUTRAL_EMOJI, asTopicRows, cleanEmoji, guardAlert, normName, publicCustom, validateAnswer, withCustomTopics } from "../src/custom.js";
import { validatePatch } from "../src/settings.js";
import { ALL, OWNER, TZ, addStory, addUser, fakeD1, mockFetch, yerevan } from "./helpers.mjs";
import { geminiResponse, isGemini, isGroq, promptOf, topicAnswer } from "./fake-ai.mjs";

const TOKEN = "123456:TEST-token-for-unit-tests";
const A = 701, B = 702, C = 703;
let fetchMock;
afterEach(() => fetchMock?.restore());

const nowS = () => Math.floor(Date.now() / 1000);
const initFor = (id, lang = "en") => signInitData({ query_id: "AAE1", auth_date: String(nowS()), signature: "sig",
  user: JSON.stringify({ id, first_name: `U${id}`, language_code: lang }) }, TOKEN);
const env = (binding, extra = {}) => ({ DB: binding, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: "s".repeat(40),
  OWNER_TELEGRAM_ID: String(OWNER), GITHUB_DISPATCH_TOKEN: "GH", GITHUB_REPO: "o/r", GITHUB_WORKFLOW: "hourly.yml",
  GEMINI_API_KEY: "test-key", GROQ_API_KEY: "test-groq", ...extra });
async function call(binding, path, id, body, extraEnv) {
  const res = await worker.fetch(new Request(`https://w.test${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `tma ${await initFor(id)}` }, body: body === undefined ? undefined : JSON.stringify(body) }),
  env(binding, extraEnv));
  return { status: res.status, body: await res.json() };
}
// Gemini answers like the real model (test/fake-ai.mjs); `fail` makes it answer an HTTP error instead.
function ai({ fail = null } = {}) {
  return mockFetch((url, init, body) => {
    if (isGemini(url) || isGroq(url)) {
      if (fail) return { status: fail, body: { error: { message: "quota or overload" } } };
      return { status: 200, body: geminiResponse(topicAnswer(promptOf(body))) };
    }
    return undefined;
  });
}
const aiCalls = () => fetchMock.calls.filter((c) => isGemini(c.url) || isGroq(c.url));
function setup(users = [A, B, C]) {
  const d = fakeD1();
  for (const id of users) addUser(d.sqlite, { id, first_name: `U${id}` });
  addUser(d.sqlite, { id: OWNER });
  return d;
}
const add = (binding, id, name, extraEnv) => call(binding, "/api/topics/add", id, { name }, extraEnv);
const followers = (sqlite, tag) => sqlite.prepare("SELECT count(*) AS n FROM custom_follows f JOIN custom_topics t ON t.id = f.topic_id WHERE t.tag = ?").get(tag).n;

describe("Step 13: adding a custom topic", () => {
  test("accepted: one AI call makes a shared topic with names, emoji, searches and a cap; logged twice", async () => {
    const { binding, sqlite } = setup();
    fetchMock = ai();
    const r = await add(binding, A, "  Colombia ");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.result, { kind: "added", name: "Colombia" });
    assert.deepEqual(r.body.custom.map((c) => c.name), ["Colombia"]);
    const t = sqlite.prepare("SELECT * FROM custom_topics").get();
    assert.equal(t.tag, `c${t.id}`);
    assert.deepEqual(JSON.parse(t.names), { en: "Colombia", ru: "Колумбия", hy: "Կոլումբիա", fr: "Colombie" });
    assert.equal(t.emoji, "🇨🇴");
    assert.equal(t.boost_max, 2);
    assert.ok(JSON.parse(t.queries).some((q) => q.ed === "es_co"));
    assert.equal(followers(sqlite, t.tag), 1);
    assert.equal(aiCalls().length, 1);
    const calls = sqlite.prepare("SELECT kind, ok, model FROM ai_calls").all();
    assert.deepEqual(calls.map((c) => [c.kind, c.ok]), [["topic_check", 1]]);
    const check = sqlite.prepare("SELECT outcome, ai, topic_id FROM topic_checks").get();
    assert.deepEqual([check.outcome, check.ai, check.topic_id], ["accepted", 1, t.id]);
  });

  test("rejected: a short reason in the reader's language, nothing created", async () => {
    const { binding, sqlite } = setup();
    sqlite.prepare("UPDATE users SET lang = 'ru' WHERE id = ?").run(A);
    fetchMock = ai();
    const r = await add(binding, A, "asdfgh");
    assert.equal(r.body.result.kind, "rejected");
    assert.equal(r.body.result.reason, "Это не похоже на тему новостей.");
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM custom_topics").get().n, 0);
    const p = await add(binding, A, "my neighbour Vasya");
    assert.equal(p.body.result.kind, "rejected");
    assert.match(sqlite.prepare("SELECT reason FROM topic_checks ORDER BY id DESC").get().reason, /^private_person/);
  });

  test("a synonym joins the existing topic (the AI's same_as), an exact repeat joins with no AI call", async () => {
    const { binding, sqlite } = setup();
    fetchMock = ai();
    await add(binding, A, "Colombia");
    const r = await add(binding, B, "Colombian news");
    assert.deepEqual(r.body.result, { kind: "joined", name: "Colombia" });
    assert.equal(aiCalls().length, 2);
    assert.match(promptOf(aiCalls()[1].body), /- c1: Colombia/);   // the AI saw the existing topic
    const c = await add(binding, C, "COLOMBIAN  news!");
    assert.deepEqual(c.body.result, { kind: "joined", name: "Colombia" });
    assert.equal(aiCalls().length, 2, "an alias match needs no AI call");
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM custom_topics").get().n, 1);
    assert.equal(followers(sqlite, "c1"), 3);
  });

  test("same_as alone decides a join even when the AI's own names differ; a rejection with names creates nothing", async () => {
    const { binding, sqlite } = setup();
    fetchMock = ai();
    await add(binding, A, "Colombia");
    fetchMock.restore();
    const answers = [
      { verdict: "accept", reason_code: "ok", reason: "ok", same_as: "c1", names: { en: "Colombian politics", ru: "", hy: "", fr: "" },
        emoji: "🇨🇴", definition: "d", queries: [{ q: "Colombia politics", ed: "en" }, { q: "Petro", ed: "es_co" }], boost_max: 2 },
      { verdict: "reject", reason_code: "offensive", reason: "This topic cannot be added.", same_as: "",
        names: { en: "Some slur", ru: "x", hy: "x", fr: "x" }, emoji: "📌", definition: "d", queries: [{ q: "a", ed: "en" }, { q: "b", ed: "en" }], boost_max: 1 },
    ];
    fetchMock = mockFetch((url) => (isGemini(url) ? { status: 200, body: geminiResponse(answers.shift()) } : undefined));
    const j = await add(binding, B, "Colombian political news");
    assert.deepEqual(j.body.result, { kind: "joined", name: "Colombia" });
    const r = await add(binding, C, "something hateful");
    assert.equal(r.body.result.kind, "rejected");
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM custom_topics").get().n, 1);
  });

  test("shared: two readers, one topic; it is orphaned only when the last one leaves", async () => {
    const { binding, sqlite } = setup();
    fetchMock = ai();
    await add(binding, A, "Formula 1");
    await add(binding, B, "Formula 1");
    assert.equal(followers(sqlite, "c1"), 2);
    let r = await call(binding, "/api/topics/remove", A, { id: 1 });
    assert.deepEqual(r.body.custom, []);
    assert.equal(sqlite.prepare("SELECT orphan_since FROM custom_topics").get().orphan_since, null);
    r = await call(binding, "/api/topics/remove", B, { id: 1 });
    assert.ok(sqlite.prepare("SELECT orphan_since FROM custom_topics").get().orphan_since > 0);
    await add(binding, C, "Formula 1");   // a new follower stops the clock
    assert.equal(sqlite.prepare("SELECT orphan_since FROM custom_topics").get().orphan_since, null);
  });

  test("at most 3 per reader: the 4th is refused before any AI call", async () => {
    const { binding } = setup();
    fetchMock = ai();
    for (const n of ["Colombia", "Formula 1", "AI regulation"]) assert.equal((await add(binding, A, n)).status, 200);
    const before = aiCalls().length;
    const r = await add(binding, A, "Brazil");
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "topic_limit");
    assert.equal(aiCalls().length, before);
  });

  test("empty, letterless or over-long input is refused before any AI call", async () => {
    const { binding } = setup();
    fetchMock = ai();
    for (const [name, code] of [["", "topic_short"], ["  ", "topic_short"], ["x", "topic_short"], ["12345", "topic_short"],
      ["a".repeat(41), "topic_long"]]) {
      const r = await add(binding, A, name);
      assert.equal(r.status, 400, name);
      assert.equal(r.body.code, code, name);
    }
    assert.equal(aiCalls().length, 0);
  });

  test("a main topic is refused with its name: exactly typed (no AI call) or recognised by the AI", async () => {
    const { binding, sqlite } = setup();
    fetchMock = ai();
    let r = await add(binding, A, "Armenia");
    assert.deepEqual(r.body.result, { kind: "main_topic", reason: "Armenia is a main topic. Switch it on above." });
    r = await add(binding, A, "Технологии и ИИ");
    assert.equal(r.body.result.kind, "main_topic");
    assert.equal(aiCalls().length, 0);
    r = await add(binding, A, "Latest Armenian news");
    assert.equal(r.body.result.kind, "main_topic");
    assert.equal(aiCalls().length, 1);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM custom_follows").get().n, 0);
  });

  test("Step 19: a name for a WHOLE main topic is refused with no AI call, in any language", async () => {
    const { binding, sqlite } = setup();
    fetchMock = ai();
    const cases = [["Economy", "Economy & Markets"], ["Markets", "Economy & Markets"], ["economy and markets", "Economy & Markets"],
      ["Tech", "Technology & AI"], ["Technology", "Technology & AI"], ["Технологии", "Technology & AI"],
      ["Armenian news", "Armenia"], ["Новости Армении", "Armenia"], ["Politics", "Politics & Conflicts"], ["War in Ukraine", "Ukraine War"]];
    for (const [name, label] of cases) {
      const r = await add(binding, A, name);
      assert.deepEqual(r.body.result, { kind: "main_topic", reason: `${label} is a main topic. Switch it on above.` }, name);
    }
    assert.equal(aiCalls().length, 0);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM custom_follows").get().n, 0);
  });

  test("Step 19: a topic narrower than a main topic is a normal custom topic (Stocks, Finance, Crypto, Oil, AI startups)", async () => {
    // "AI": the real model calls it Technology & AI; config not_main makes it a custom topic anyway
    for (const name of ["Stocks", "Finance", "Crypto", "Oil", "AI startups", "Armenian diaspora", "AI", "ИИ"]) {
      const { binding } = setup();
      fetchMock = ai();
      const r = await add(binding, A, name);
      assert.equal(r.body.result.kind, "added", name);
      assert.equal(aiCalls().length, 1, name);
      fetchMock.restore();
    }
  });

  test("Step 19: the check prompt says only a WHOLE main topic is the same, with narrower examples", async () => {
    const { binding } = setup();
    fetchMock = ai();
    await add(binding, A, "Stocks");
    const p = promptOf(JSON.parse(aiCalls()[0].init.body));
    assert.match(p, /A MAIN TOPIC tag only when the topic means that WHOLE main topic/);
    assert.match(p, /"Stocks", "Finance", "Banking", "Crypto", "Oil", "Gold",\n {5}"AI startups"/);
    assert.match(p, /   - tech_ai: Technology & AI/);
    assert.doesNotMatch(p, /russia/);
  });

  test("Step 19: Russia is no longer a main topic, so it can be a reader's own topic", async () => {
    const { binding } = setup();
    fetchMock = ai();
    const r = await add(binding, A, "Russia");
    assert.notEqual(r.body.result.kind, "main_topic");
    assert.equal(aiCalls().length, 1);
  });

  test("5 AI checks a day per reader; the owner has no limit", async () => {
    const { binding } = setup();
    fetchMock = ai();
    for (let i = 0; i < 5; i++) await add(binding, A, `qwerty${i}`);
    const r = await add(binding, A, "Brazil");
    assert.equal(r.body.code, "topic_checks_limit");
    assert.equal(aiCalls().length, 5);
    for (let i = 0; i < 6; i++) await add(binding, OWNER, `qwerty${i}`);
    assert.equal(aiCalls().length, 11);
  });

  test("the AI guard: a recent Gemini 429 delays the check (no AI call), in the reader's language", async () => {
    const { binding, sqlite } = setup();
    sqlite.prepare("UPDATE users SET lang = 'ru' WHERE id = ?").run(A);
    sqlite.prepare("INSERT INTO ai_calls (at, provider, model, ok, error, kind, code) VALUES (?, 'gemini', 'gemini-3.5-flash-lite', 0, 'x', 'batch', 429)")
      .run(nowS() - 120);
    fetchMock = ai();
    const r = await add(binding, A, "Colombia");
    assert.deepEqual(r.body.result, { kind: "delayed", reason: "⏳ Попробуйте через несколько минут." });
    assert.equal(aiCalls().length, 0);
    assert.equal(sqlite.prepare("SELECT outcome FROM topic_checks").get().outcome, "delayed");
  });

  test("every provider failing: 'try again later', and every attempt logged with its HTTP code", async () => {
    const { binding, sqlite } = setup();
    fetchMock = ai({ fail: 503 });
    const r = await add(binding, A, "Colombia");
    assert.equal(r.body.result.kind, "failed");
    const rows = sqlite.prepare("SELECT provider, model, ok, code, kind FROM ai_calls ORDER BY id").all();
    // Step 20: each free Gemini model once more after a short wait, then Groq's three models in turn
    assert.deepEqual(rows.map((x) => `${x.provider}/${x.ok}/${x.code}/${x.kind}`),
      ["gemini/0/503/topic_check", "gemini/0/503/topic_check", "gemini/0/503/topic_check", "gemini/0/503/topic_check",
       "groq/0/503/topic_check", "groq/0/503/topic_check", "groq/0/503/topic_check"]);
    assert.equal(rows[0].model, rows[1].model);
    assert.notEqual(rows[1].model, rows[2].model);
    assert.equal(new Set(rows.slice(4).map((x) => x.model)).size, 3);
  });

  test("Gemini's 429 then the backup model: logged as 429, the guard counts it", async () => {
    const { binding, sqlite } = setup();
    let n = 0;
    fetchMock = mockFetch((url, init, body) => {
      if (!isGemini(url) && !isGroq(url)) return undefined;
      return n++ === 0 ? { status: 429, body: { error: { message: "quota" } } } : { status: 200, body: geminiResponse(topicAnswer(promptOf(body))) };
    });
    const r = await add(binding, A, "Colombia");
    assert.equal(r.body.result.kind, "added");
    const rows = sqlite.prepare("SELECT ok, code FROM ai_calls ORDER BY id").all();
    assert.deepEqual(rows.map((x) => [x.ok, x.code]), [[0, 429], [1, null]]);
    const g = guardState(sqlite.prepare("SELECT model, count(*) AS calls, sum(code = 429) AS r429, sum(code = 429) AS recent429 FROM ai_calls GROUP BY model").all(), nowS());
    assert.equal(g.level, 1);
  });

  test("Step 15: Admin's Keywords button asks the next run for fresh keywords; owner only; the old ones stay", async () => {
    const { binding, sqlite } = setup();
    fetchMock = ai();
    await add(binding, A, "Colombia");
    const before = sqlite.prepare("SELECT keywords, keywords_at FROM custom_topics WHERE id = 1").get();
    assert.ok(before.keywords && before.keywords_at > 0, "the check writes keywords and their time");
    assert.equal((await call(binding, "/api/admin/topic", A, { id: 1, action: "keywords" })).status, 403);
    const r = await call(binding, "/api/admin/topic", OWNER, { id: 1, action: "keywords" });
    assert.equal(r.status, 200);
    assert.match(r.body.message, /refreshed by the next hourly run/);
    const after = sqlite.prepare("SELECT keywords, keywords_at FROM custom_topics WHERE id = 1").get();
    assert.deepEqual([after.keywords, after.keywords_at], [before.keywords, 0]);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM custom_follows").get().n, 1, "nothing deleted");
  });

  test("block list: Admin blocks a topic; nobody can create it again (no AI call); only the owner may", async () => {
    const { binding, sqlite } = setup();
    fetchMock = ai();
    await add(binding, A, "Colombia");
    await add(binding, B, "Colombian news");
    assert.equal((await call(binding, "/api/admin/topic", A, { id: 1, action: "block" })).status, 403);
    const r = await call(binding, "/api/admin/topic", OWNER, { id: 1, action: "block" });
    assert.equal(r.status, 200);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM custom_topics").get().n, 0);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM custom_follows").get().n, 0);
    const blocked = sqlite.prepare("SELECT norm FROM topic_blocks ORDER BY norm").all().map((x) => x.norm);
    assert.ok(blocked.includes("colombia") && blocked.includes("колумбия") && blocked.includes("colombian news"), blocked.join());
    const before = aiCalls().length;
    const again = await add(binding, C, "Колумбия");
    assert.deepEqual(again.body.result, { kind: "rejected", reason: "This topic cannot be added." });
    assert.equal(aiCalls().length, before);
    // Delete (not block): gone, but can be made again
    await add(binding, C, "Formula 1");
    const f1 = sqlite.prepare("SELECT id FROM custom_topics").get().id;
    assert.equal((await call(binding, "/api/admin/topic", OWNER, { id: f1, action: "delete" })).status, 200);
    const again2 = await add(binding, C, "Formula 1");
    assert.equal(again2.body.result?.kind, "added", JSON.stringify(again2.body));
    // a deleted topic's id and tag are never reused (old stories still carry its tag)
    const tags = sqlite.prepare("SELECT tag FROM custom_topics").all().map((x) => x.tag);
    assert.deepEqual(tags, [`c${f1 + 1}`]);
    assert.equal(f1, 2);
  });

  test("names in the reader's language (state and the digest heading)", async () => {
    const { binding, sqlite } = setup();
    sqlite.prepare("UPDATE users SET lang = 'ru' WHERE id = ?").run(A);
    fetchMock = ai();
    const r = await add(binding, A, "Colombia");
    assert.deepEqual(r.body.custom.map((c) => c.name), ["Колумбия"]);
    const open = await call(binding, "/api/open", B, {});
    assert.deepEqual(open.body.custom, []);
    const rows = sqlite.prepare("SELECT * FROM custom_topics").all();
    assert.equal(topicInfoFrom(asTopicRows(rows), "fr").c1.label, "Colombie");
    assert.equal(topicInfoFrom(asTopicRows(rows), "hy").c1.label, "Կոլումբիա");
  });

  test("Step 16: every main topic may be off, and the very last custom topic may go too", async () => {
    const { binding } = setup();
    fetchMock = ai();
    assert.deepEqual(validatePatch({ topics: [] }, ALL, CONFIG), { topics: [] });
    await add(binding, A, "Colombia");
    const s = await call(binding, "/api/settings", A, { topics: [] });
    assert.equal(s.status, 200);
    const r = await call(binding, "/api/topics/remove", A, { id: 1 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.custom, []);
    assert.deepEqual(r.body.user.topics, []);
  });

  test("the answer is checked in code: dashes, boost cap, editions, emoji, at least two searches", () => {
    const a = validateAnswer({ verdict: "accept", reason_code: "ok", reason: "Fine — really", same_as: "",
      names: { en: "Ice – hockey", ru: "", hy: "", fr: "" }, emoji: "not an emoji", definition: "x",
      queries: [{ q: "ice hockey", ed: "xx" }], boost_max: 7 }, "en");
    assert.equal(a.reason, "Fine, really");
    assert.equal(a.names.en, "Ice, hockey");
    assert.equal(a.names.ru, "Ice, hockey");
    assert.equal(a.boostMax, 2);
    assert.equal(a.emoji, NEUTRAL_EMOJI, "never the 📌 placeholder; a neutral emoji only when the answer has none");
    assert.deepEqual(a.queries, [{ q: "ice hockey", ed: "en" }, { q: "Ice, hockey", ed: "en" }]);
    assert.equal(cleanEmoji("🇨🇴"), "🇨🇴");
    assert.equal(cleanEmoji("🏎️"), "🏎️");
    assert.equal(normName("  Colombián  NEWS!! "), "colombian news");
    assert.equal(normName("Ёлка"), "елка");
    assert.equal(validateAnswer({ verdict: "maybe" }, "en"), null);
  });

  test("Admin lists custom topics with followers, searches, items, stories and sent stories", async () => {
    const { binding, sqlite } = setup();
    fetchMock = ai();
    await add(binding, A, "Colombia");
    await add(binding, B, "Colombia");
    await add(binding, C, "asdfgh");
    const now = nowS();
    sqlite.prepare("INSERT INTO custom_topic_days (topic_id, day, searches, fetched, dup_dropped, new_items) VALUES (1, ?, 6, 140, 20, 31)")
      .run(new Date(now * 1000).toISOString().slice(0, 10));
    const sid = addStory(sqlite, "Colombia election", ["politics_conflicts", "c1"], 6, now - 600, { final_score: 6, main_topic: "c1", topic_score: 8 });
    sqlite.prepare("INSERT INTO sent (user_id, story_id, sent_at) VALUES (?, ?, ?)").run(A, sid, now - 300);
    const r = await call(binding, "/api/admin", OWNER);
    const t = r.body.custom.topics[0];
    assert.equal(t.name, "Colombia");
    assert.equal(t.followers, 2);
    assert.deepEqual(t.today, { searches: 6, fetched: 140, dup_dropped: 20, new_items: 31 });
    assert.equal(t.stories_24h, 1);
    assert.equal(t.main_24h, 1);
    assert.equal(t.sent_24h, 1);
    assert.deepEqual(r.body.custom.checks_24h, { accepted: 1, joined: 1, rejected: 1 });
    assert.equal(r.body.custom.guard.level, 0);
    assert.ok(r.body.custom.guard.models.some((m) => m.model === "gemini-3.5-flash-lite" && m.calls === 2));
  });
});

// ------------------------------------------------------------------ the switch and edit mode (Step 13 fixes)

describe("Step 13 fixes: the switch, edit-mode delete and the emoji", () => {
  const sw = (binding, id, topic, on) => call(binding, "/api/topics/switch", id, { id: topic, on });
  const row = (sqlite, user, topic) => sqlite.prepare("SELECT enabled FROM custom_follows WHERE user_id = ? AND topic_id = ?").get(user, topic);

  test("the state carries the topic's own emoji and its switch; never the 📌 placeholder", async () => {
    const { binding, sqlite } = setup();
    fetchMock = ai();
    const r = await add(binding, A, "Colombia");
    assert.deepEqual(r.body.custom.map((c) => [c.name, c.emoji, c.on]), [["Colombia", "🇨🇴", true]]);
    // an old row stored with the placeholder, or none, shows the neutral emoji instead
    sqlite.prepare("UPDATE custom_topics SET emoji = '📌'").run();
    assert.equal((await call(binding, "/api/open", A, {})).body.custom[0].emoji, NEUTRAL_EMOJI);
    assert.equal(publicCustom([{ id: 1, tag: "c1", names: '{"en":"X"}', emoji: null }], "en")[0].emoji, NEUTRAL_EMOJI);
    assert.equal(publicCustom([{ id: 1, tag: "c1", names: '{"en":"Japan"}', emoji: "🇯🇵", enabled: 0 }], "en")[0].on, false);
    assert.equal(asTopicRows([{ tag: "c1", names: '{"en":"X"}', emoji: "📌" }])[0].emoji, NEUTRAL_EMOJI, "nor in digests");
  });

  test("off and on are saved; an off topic stays in the list and keeps its slot (still counts toward 3)", async () => {
    const { binding, sqlite } = setup();
    fetchMock = ai();
    await add(binding, A, "Colombia");
    const off = await sw(binding, A, 1, false);
    assert.equal(off.status, 200);
    assert.deepEqual(off.body.custom.map((c) => [c.name, c.on]), [["Colombia", false]]);
    assert.equal(row(sqlite, A, 1).enabled, 0);
    assert.equal(sqlite.prepare("SELECT orphan_since FROM custom_topics WHERE id = 1").get().orphan_since, null, "never orphaned by a switch");
    assert.deepEqual((await call(binding, "/api/open", A, {})).body.custom.map((c) => c.on), [false], "saved");
    await add(binding, A, "Formula 1");
    await add(binding, A, "Japan");
    const before = aiCalls().length;
    const fourth = await add(binding, A, "Brazil");
    assert.equal(fourth.body.code, "topic_limit", "the off topic still takes a slot");
    assert.equal(aiCalls().length, before);
    const on = await sw(binding, A, 1, true);
    assert.deepEqual(on.body.custom.map((c) => c.on), [true, true, true]);
    assert.equal(row(sqlite, A, 1).enabled, 1);
  });

  test("off means not in that reader's digest topics; another follower with it on is unaffected", async () => {
    const { binding, sqlite } = setup();
    fetchMock = ai();
    await add(binding, A, "Colombia");
    await add(binding, B, "Colombia");
    await sw(binding, A, 1, false);
    const rows = (u) => sqlite.prepare("SELECT t.*, f.enabled FROM custom_follows f JOIN custom_topics t ON t.id = f.topic_id WHERE f.user_id = ?").all(u);
    assert.deepEqual(JSON.parse(withCustomTopics({ topics: "[\"politics_conflicts\"]" }, rows(A)).topics), ["politics_conflicts"]);
    assert.deepEqual(JSON.parse(withCustomTopics({ topics: "[\"politics_conflicts\"]" }, rows(B)).topics), ["politics_conflicts", "c1"]);
  });

  test("Step 16: the last topic switched on may go off too (all off); bad input refused", async () => {
    const { binding } = setup();
    fetchMock = ai();
    await add(binding, A, "Colombia");
    assert.equal((await call(binding, "/api/settings", A, { topics: [] })).status, 200);
    const r = await sw(binding, A, 1, false);
    assert.equal(r.status, 200);
    assert.equal(r.body.custom[0].on, false);
    assert.equal((await sw(binding, A, 1, true)).status, 200);
    assert.equal((await sw(binding, A, 1, "no")).status, 400);
    assert.equal((await sw(binding, A, 0, true)).status, 400);
    assert.equal((await sw(binding, A, 99, true)).status, 200, "a topic not followed: nothing changes");
  });

  test("edit mode delete: removes it, frees the slot; the 7-day clock starts only when nobody has it, on or off", async () => {
    const { binding, sqlite } = setup();
    fetchMock = ai();
    await add(binding, A, "Colombia");
    await add(binding, B, "Colombia");
    await sw(binding, B, 1, false);
    const r = await call(binding, "/api/topics/remove", A, { id: 1 });
    assert.deepEqual(r.body.custom, []);
    assert.equal(sqlite.prepare("SELECT orphan_since FROM custom_topics WHERE id = 1").get().orphan_since, null,
      "B still has it in their list (switched off): no clock");
    await call(binding, "/api/topics/remove", B, { id: 1 });
    assert.ok(sqlite.prepare("SELECT orphan_since FROM custom_topics WHERE id = 1").get().orphan_since > 0);
    const again = await add(binding, A, "Colombia");
    assert.equal(again.body.result.kind, "joined");
    assert.deepEqual(again.body.custom.map((c) => c.on), [true], "re-added: switched on");
    assert.equal(sqlite.prepare("SELECT orphan_since FROM custom_topics WHERE id = 1").get().orphan_since, null);
  });

  test("removing a topic that is switched off is allowed even when it is the only custom one (others are on)", async () => {
    const { binding } = setup();
    fetchMock = ai();
    await add(binding, A, "Colombia");
    await sw(binding, A, 1, false);
    const r = await call(binding, "/api/topics/remove", A, { id: 1 });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.custom, []);
  });
});

// ------------------------------------------------------------------ digests

const T_NOW = yerevan(20, 2);
function custRow(tag, names, boost = 2) {
  return { id: Number(tag.slice(1)), tag, names: JSON.stringify(names), emoji: "🇨🇴", boost_max: boost };
}
const COL = custRow("c1", { en: "Colombia", ru: "Колумбия", hy: "Կոլումբիա", fr: "Colombie" });

describe("Step 13: custom topics in digests", () => {
  const story = (id, topics, final, topic, main, extra = {}) => ({ id, summary: `S${id}`, headline: `Headline ${id}`, description: "",
    emojis: "🗞️", best_url: `https://x.test/${id}`, best_source: "Outlet", importance: final, final_score: final, topic_score: topic,
    topics: JSON.stringify(topics), main_topic: main, updated_at: T_NOW - 600, dup_group: null, ...extra });

  test("Step 13 fixes: the topic score counts as it is for a custom topic (no cap, no 'above the score' rule)", () => {
    const user = withCustomTopics({ id: 1, topics: JSON.stringify(["politics_conflicts"]) }, [COL]);
    const mine = JSON.parse(user.topics);
    assert.equal(qualifies(story(1, ["c1"], 1, 8, "c1"), mine, CONFIG), true, "a Grand Prix result: global 1, topic 8");
    assert.equal(qualifies(story(2, ["c1"], 6, 6, "c1"), mine, CONFIG), true, "topic 6 equal to the score is enough");
    assert.equal(qualifies(story(3, ["c1"], 4, 5, "c1"), mine, CONFIG), false, "below the topic bar of 6");
    assert.equal(qualifies(story(4, ["c1"], 1, 8, "c1"), ["politics_conflicts"], CONFIG), false, "not followed: not in");
    assert.equal(qualifies(story(5, ["c1"], 1, 8, "c1"), mine, { ...CONFIG, topic_boost_max: { ...CONFIG.topic_boost_max, c1: 0 } }), true,
      "a cap in the settings does not apply to a custom topic");
    // the 6 main topics keep the Step 8 rule
    assert.equal(qualifies(story(6, ["armenia"], 6, 6, "armenia"), ["armenia"], CONFIG), false, "main topic: needs a boost");
    assert.equal(qualifies(story(7, ["armenia"], 3, 8, "armenia"), ["armenia"], CONFIG), false, "main topic: capped at +2");
    assert.equal(qualifies(story(8, ["c1"], null, null, "c1", { importance: 9 }), mine, CONFIG), true, "unedited: the editorial bar only");
    assert.equal(qualifies(story(9, ["c1"], null, null, "c1", { importance: 6 }), mine, CONFIG), false);
  });

  test("Step 13 fixes: the SQL agrees with qualifies() on the shared fixture, custom cases included", async () => {
    const data = JSON.parse(readFileSync(fileURLToPath(new URL("../../tests/fixtures/eligible_cases.json", import.meta.url)), "utf8"));
    const cfg = { ...CONFIG, ...data.cfg };
    assert.ok(data.cases.some((c) => /^c\d+$/.test(c.main_topic ?? "") && c.eligible && c.final_score < cfg.editorial_bar));
    const { db, sqlite } = fakeD1();
    addUser(sqlite, { id: 9, topics: JSON.stringify(data.tags) });
    for (const c of data.cases) {
      sqlite.prepare("INSERT INTO stories (id, summary, topics, importance, best_url, best_source, best_tier, created_at, updated_at, " +
        "final_score, topic_score, main_topic) VALUES (?, 's', ?, ?, 'u', 'src', 1, ?, ?, ?, ?, ?)")
        .run(c.id, JSON.stringify(c.topics), c.importance, T_NOW - 600, T_NOW - 600, c.final_score, c.topic_score, c.main_topic);
    }
    const [rows] = await db.batch([candidateStatement({ id: 9, topics: JSON.stringify(data.tags), last_digest_at: null }, T_NOW,
      { ...cfg, candidate_limit: 1000 })]);
    assert.deepEqual(rows.map((r) => r.id).sort((a, b) => a - b), data.cases.filter((c) => c.eligible).map((c) => c.id));
    // a cap written for a custom tag in the settings changes nothing: custom topics have no cap
    const capped = { ...cfg, candidate_limit: 1000, topic_boost_max: { ...cfg.topic_boost_max, c1: 0, c2: 0 } };
    const [again] = await db.batch([candidateStatement({ id: 9, topics: JSON.stringify(data.tags), last_digest_at: null }, T_NOW, capped)]);
    assert.deepEqual(again.map((r) => r.id).sort((a, b) => a - b), data.cases.filter((c) => c.eligible).map((c) => c.id));
    // Step 15: off means off, per reader with topics switched off
    let uid = 20;
    for (const [name, tags] of Object.entries(data.readers)) {
      addUser(sqlite, { id: ++uid, topics: JSON.stringify(tags) });
      const [got] = await db.batch([candidateStatement({ id: uid, topics: JSON.stringify(tags), last_digest_at: null }, T_NOW,
        { ...cfg, candidate_limit: 1000 })]);
      assert.deepEqual(got.map((r) => r.id).sort((a, b) => a - b), data.cases.filter((c) => c.eligible_for[name]).map((c) => c.id), name);
    }
  });

  test("its own section, in the reader's language, before broader sections; SQL agrees", async () => {
    const { db, sqlite } = fakeD1();
    const u = addUser(sqlite, { id: 5, topics: JSON.stringify(["politics_conflicts"]), lang: "ru" });
    const sid = addStory(sqlite, "Colombia vote", ["politics_conflicts", "c1"], 6, T_NOW - 600, { final_score: 5, topic_score: 7, main_topic: "c1",
      headline: "Colombia votes" });
    sqlite.prepare("INSERT INTO story_translations (story_id, lang, ok, headline, description, src, created_at) VALUES (?, 'ru', 1, 'Колумбия голосует', '', ?, 1)")
      .run(sid, "Colombia votes\n");
    const user = withCustomTopics({ ...u, lang: "ru" }, [COL]);
    const cfg = CONFIG;
    const [rows] = await db.batch([candidateStatement(user, T_NOW, cfg)]);
    assert.equal(rows.length, 1, "the SQL picks it via the topic path");
    const plan = planDigest(user, rows, [{ tag: "politics_conflicts", label_en: "Politics", emoji: "🏛️" }, ...asTopicRows([COL])], T_NOW, cfg);
    assert.deepEqual(plan.storyIds, [sid]);
    assert.match(plan.text, /🇨🇴 Колумбия<\/th>/);
    assert.match(plan.text, /Колумбия голосует/);
  });

  test("a story tagged with a custom topic and a main topic goes under the custom one (most specific)", () => {
    const user = withCustomTopics({ id: 1, topics: JSON.stringify(["politics_conflicts"]) }, [COL]);
    const picked = pickStories([story(1, ["politics_conflicts", "c1"], 7, 7, null)], JSON.parse(user.topics), CONFIG);
    assert.equal(picked[0].primary, "c1");
  });

  test("the length cut keeps the custom section's best story", () => {
    const user = withCustomTopics({ id: 1, topics: JSON.stringify(["politics_conflicts"]) }, [COL]);
    const long = "word ".repeat(110);
    const list = [...Array.from({ length: 12 }, (_, i) => story(10 + i, ["politics_conflicts"], 8, 8, "politics_conflicts", { description: long })),
      story(99, ["c1"], 5, 7, "c1", { description: long })];
    const cfg = CONFIG;
    const picked = pickStories(list, JSON.parse(user.topics), cfg);
    const fit = fitToLength(picked, { now: T_NOW, tz: TZ, lang: "en", topicInfo: topicInfoFrom(asTopicRows([COL])), name: "A" }, cfg);
    assert.ok(fit.cut.length > 0);
    assert.ok(fit.kept.some((s) => s.id === 99), "the custom section survives");
  });

  test("cron: a due reader gets the custom section; never twice; a reader who does not follow it does not", async () => {
    const { db, sqlite } = fakeD1();
    const now = yerevan(20, 2);
    addUser(sqlite, { id: 5, topics: JSON.stringify(["politics_conflicts"]), next_digest_at: yerevan(20), last_digest_at: yerevan(14) });
    addUser(sqlite, { id: 6, topics: JSON.stringify(["politics_conflicts"]), next_digest_at: yerevan(20), last_digest_at: yerevan(14) });
    sqlite.prepare("INSERT INTO custom_topics (id, tag, names, emoji, definition, queries, boost_max, created_at) VALUES (1, 'c1', ?, '🇨🇴', 'd', '[]', 2, 1)")
      .run(COL.names);
    sqlite.prepare("INSERT INTO custom_follows (user_id, topic_id, at) VALUES (5, 1, 1)").run();
    const sid = addStory(sqlite, "Colombia vote", ["c1"], 6, now - 600, { final_score: 5, topic_score: 7, main_topic: "c1", headline: "Colombia votes" });
    const outbox = [];
    const io = { send: async (id, text, extra) => { outbox.push({ id, text }); }, alert: async () => {} };
    await runTick(db, io, now);
    const five = outbox.find((m) => m.id === 5), six = outbox.find((m) => m.id === 6);
    assert.match(five.text, /🇨🇴 Colombia<\/th>/);
    assert.doesNotMatch(six.text, /Colombia/);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sent WHERE user_id = 5 AND story_id = ?").get(sid).n, 1);
    sqlite.prepare("UPDATE users SET next_digest_at = ? WHERE id = 5").run(yerevan(20, 30));
    outbox.length = 0;
    await runTick(db, io, yerevan(20, 32));
    assert.doesNotMatch(outbox.find((m) => m.id === 5).text, /Colombia votes/);
  });

  test("Step 13 fixes: cron leaves out a custom topic its reader switched off", async () => {
    const { db, sqlite } = fakeD1();
    const now = yerevan(20, 2);
    addUser(sqlite, { id: 5, topics: JSON.stringify(["politics_conflicts"]), next_digest_at: yerevan(20), last_digest_at: yerevan(14) });
    sqlite.prepare("INSERT INTO custom_topics (id, tag, names, emoji, definition, queries, boost_max, created_at) VALUES (1, 'c1', ?, '🇨🇴', 'd', '[]', 2, 1)")
      .run(COL.names);
    sqlite.prepare("INSERT INTO custom_follows (user_id, topic_id, at, enabled) VALUES (5, 1, 1, 0)").run();
    const sid = addStory(sqlite, "Colombia vote", ["c1"], 6, now - 600, { final_score: 2, topic_score: 8, main_topic: "c1", headline: "Colombia votes" });
    const outbox = [];
    await runTick(db, { send: async (id, text) => { outbox.push({ id, text }); }, alert: async () => {} }, now);
    assert.doesNotMatch(outbox.find((m) => m.id === 5).text, /Colombia/);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sent WHERE story_id = ?").get(sid).n, 0, "not marked sent: it can come later");
    sqlite.prepare("UPDATE custom_follows SET enabled = 1").run();
    addStory(sqlite, "Colombia result", ["c1"], 6, yerevan(20, 10), { final_score: 1, topic_score: 7, main_topic: "c1", headline: "Colombia votes again" });
    sqlite.prepare("UPDATE users SET next_digest_at = ? WHERE id = 5").run(yerevan(20, 30));
    outbox.length = 0;
    await runTick(db, { send: async (id, text) => { outbox.push({ id, text }); }, alert: async () => {} }, yerevan(20, 32));
    assert.match(outbox.find((m) => m.id === 5).text, /Colombia votes again/, "switched back on: new stories come (global 1, topic 7)");
  });
});

// ------------------------------------------------------------------ the AI budget guard

describe("Step 13: the AI budget guard", () => {
  const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../../tests/fixtures/guard_cases.json", import.meta.url)), "utf8"));

  test("worker assess() agrees with tests/fixtures/guard_cases.json (also checked by the Python job tests)", () => {
    for (const c of fixture.cases) {
      const g = assess(c.counts, fixture.cfg);
      assert.equal(g.level, c.level, JSON.stringify(c.counts));
      assert.deepEqual(g.reasons, c.reasons);
    }
  });

  test("the Pacific day (Gemini's reset) agrees with the job, around both clock changes too", () => {
    for (const d of fixture.days) assert.deepEqual(pacificDay(d.ts), { day: d.day, start: d.start }, String(d.ts));
  });

  test("the order: 80% of a soft limit delays topic checks only; the limit delays translations too", () => {
    const cfg = fixture.cfg;
    assert.equal(assess({ "gemini-3.5-flash-lite": { calls: 199 } }, cfg).level, 0);
    assert.equal(assess({ "gemini-3.5-flash-lite": { calls: 200 } }, cfg).level, 1);
    assert.equal(assess({ "gemini-3.5-flash-lite": { calls: 250 } }, cfg).level, 2);
    assert.equal(assess({ "gemini-3.5-flash-lite": { recent429: 1 } }, cfg).level, 1);
    assert.equal(assess({ "gemini-3.5-flash-lite": { recent429: 1 }, "gemini-3.1-flash-lite": { recent429: 2 } }, cfg).level, 2);
    assert.equal(assess({ "openai/gpt-oss-120b": { calls: 9999, recent429: 5 } }, cfg).level, 0, "Groq is not Gemini's budget");
  });

  test("the owner is alerted once per Pacific day, on the hourly tick", async () => {
    const { db, sqlite } = fakeD1();
    const now = nowS();
    sqlite.prepare("INSERT INTO ai_calls (at, provider, model, ok, error, kind, code) VALUES (?, 'gemini', 'gemini-3.5-flash-lite', 0, 'x', 'batch', 429)").run(now - 60);
    const alerts = [];
    const io = { send: async () => {}, alert: async (t) => { alerts.push(t); } };
    await runTick(db, io, now, { digests: false, guard: true });
    await runTick(db, io, now + 600, { digests: false, guard: true });   // still level 1, the same day
    const mine = alerts.filter((t) => /AI budget/.test(t));
    assert.equal(mine.length, 1);
    assert.match(mine[0], /level 1: new topic checks are delayed/);
    assert.ok(!/[‒–—―]/.test(mine[0]));
    assert.equal(guardAlert([], [{ key: "ai_guard", value: JSON.stringify({ day: pacificDay(now).day, level: 2, reasons: ["x"] }) }], now).text
      .includes("translations are delayed"), true);
  });
});
