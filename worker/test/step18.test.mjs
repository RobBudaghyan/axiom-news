// Step 18: beta fixes. The digest times bug (the server refuses an empty list in the same statement
// that writes, and every answer, also a refusal, carries the saved state), the setup's topics step
// (Skip puts the six main topics back on), "we" instead of "the owner" in every language, and the
// visible command list. The Mini App side of the times bug (one request at a time, answers never
// overwrite newer taps, rollback on errors, never zero times on screen) is reproduced in headless
// Edge by scripts/ui-check.mjs ("Step 18" checks).
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { signInitData } from "../src/auth.js";
import { DICTS, commandList, t } from "../src/i18n.js";
import { ALL, OWNER, addUser, fakeD1, mockFetch } from "./helpers.mjs";

const TOKEN = "123456:TEST-token-for-unit-tests";
const READER = 555;
let fetchMock;
afterEach(() => fetchMock?.restore());
const nowS = () => Math.floor(Date.now() / 1000);
const initFor = (id) => signInitData({ query_id: "AAE1", user: JSON.stringify({ id, first_name: "Ani", language_code: "en" }),
  auth_date: String(nowS()) }, TOKEN);
const env = (binding) => ({ DB: binding, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: "s".repeat(40), OWNER_TELEGRAM_ID: String(OWNER) });
async function post(binding, path, id, body) {
  const res = await worker.fetch(new Request(`https://w.test${path}`, { method: "POST",
    headers: { authorization: `tma ${await initFor(id)}` }, body: JSON.stringify(body) }), env(binding));
  return { status: res.status, body: await res.json() };
}
const saved = (sqlite, id = READER) => JSON.parse(sqlite.prepare("SELECT digest_times FROM users WHERE id = ?").get(id).digest_times);

describe("Step 18: digest times, server side", () => {
  test("an empty list is refused; the answer carries the saved times, and nothing changes", async () => {
    fetchMock = mockFetch(() => undefined);
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: READER, digest_times: '["14:00"]' });
    const r = await post(binding, "/api/settings", READER, { digest_times: [] });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "keep_time");
    assert.deepEqual(r.body.state.user.digest_times, ["14:00"], "the refusal says what is saved");
    assert.deepEqual(saved(sqlite), ["14:00"]);
  });

  test("every refusal carries the saved state (too many times, a half hour, an unknown topic)", async () => {
    fetchMock = mockFetch(() => undefined);
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: READER, digest_times: '["09:00","20:00"]' });
    for (const body of [{ digest_times: ["06:00", "07:00", "08:00", "09:00", "10:00", "11:00"] }, { digest_times: ["09:30"] },
      { topics: ["nope"] }, { digest_times: "09:00" }]) {
      const r = await post(binding, "/api/settings", READER, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.deepEqual(r.body.state.user.digest_times, ["09:00", "20:00"], JSON.stringify(body));
    }
    assert.deepEqual(saved(sqlite), ["09:00", "20:00"]);
  });

  test("a save answers with the row as written (UPDATE ... RETURNING), and the database guards the list itself", async () => {
    fetchMock = mockFetch(() => undefined);
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: READER });
    const seen = [];
    const spy = { ...binding, batch: (list) => { seen.push(...list.map((s) => s.sql)); return binding.batch(list); } };
    const res = await worker.fetch(new Request("https://w.test/api/settings", { method: "POST",
      headers: { authorization: `tma ${await initFor(READER)}` }, body: JSON.stringify({ digest_times: ["20:00", "07:00"] }) }), env(spy));
    const body = await res.json();
    assert.deepEqual(body.user.digest_times, ["07:00", "20:00"]);
    assert.deepEqual(saved(sqlite), ["07:00", "20:00"]);
    const upd = seen.find((s) => s.startsWith("UPDATE users SET"));
    assert.match(upd, /json_array_length\(\?\d+\) BETWEEN 1 AND 5 RETURNING \*$/);
    assert.equal(body.user.next_digest_at, sqlite.prepare("SELECT next_digest_at FROM users WHERE id = ?").get(READER).next_digest_at);
  });

  test("the guard in SQL alone refuses an empty list (even if the check in code were skipped)", () => {
    const { sqlite } = fakeD1();
    addUser(sqlite, { id: READER, digest_times: '["09:00"]' });
    const rows = sqlite.prepare("UPDATE users SET digest_times = ?1 WHERE id = ?2 AND json_array_length(?1) BETWEEN 1 AND 5 RETURNING *")
      .all("[]", READER);
    assert.equal(rows.length, 0);
    assert.deepEqual(saved(sqlite), ["09:00"]);
  });

  test("rapid taps sent one after another (as the Mini App does): every answer is the saved state, never empty", async () => {
    fetchMock = mockFetch(() => undefined);
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: READER, digest_times: '["09:00","14:00","20:00"]' });
    const steps = [["09:00", "14:00", "20:00", "06:00"], ["14:00", "20:00", "06:00"], ["20:00", "06:00"], ["06:00"], [], ["06:00", "23:00"]];
    for (const times of steps) {
      const r = await post(binding, "/api/settings", READER, { digest_times: times });
      assert.deepEqual(r.body.user?.digest_times ?? r.body.state.user.digest_times, saved(sqlite), JSON.stringify(times));
      assert.ok(saved(sqlite).length >= 1);
    }
    assert.deepEqual(saved(sqlite), ["06:00", "23:00"]);
  });

  test("requests racing (two devices, any order): the saved list is never empty and each answer matches what it wrote", async () => {
    fetchMock = mockFetch(() => undefined);
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: READER, digest_times: '["09:00","14:00"]' });
    for (let round = 0; round < 5; round++) {
      const lists = [["09:00"], [], ["14:00"], [], ["20:00", "21:00"], []];
      const rs = await Promise.all(lists.map((times) => post(binding, "/api/settings", READER, { digest_times: times })));
      rs.forEach((r, i) => {
        if (!lists[i].length) assert.equal(r.status, 400);
        else assert.deepEqual(r.body.user.digest_times, lists[i]);
        const shown = r.body.user?.digest_times ?? r.body.state.user.digest_times;
        assert.ok(shown.length >= 1, "no answer ever shows zero times");
      });
      assert.ok(saved(sqlite).length >= 1);
    }
  });
});

describe("Step 18: the setup's topics step", () => {
  const NEW = 900;
  const topicsOf = (sqlite) => JSON.parse(sqlite.prepare("SELECT topics FROM users WHERE id = ?").get(NEW).topics);
  test("Skip puts the six main topics back on, even after the reader switched some off", async () => {
    fetchMock = mockFetch(() => undefined);
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: NEW, onboarded_at: null, opened_at: null, topics: "[]" });
    const r = await post(binding, "/api/onboard", NEW, { skipped: true });
    assert.equal(r.status, 200);
    assert.deepEqual(topicsOf(sqlite), ALL);
    assert.deepEqual(r.body.user.topics, ALL);
  });
  test("Done keeps exactly what the reader picked", async () => {
    fetchMock = mockFetch(() => undefined);
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: NEW, onboarded_at: null, opened_at: null });
    await post(binding, "/api/settings", NEW, { topics: ["armenia"] });
    await post(binding, "/api/onboard", NEW, { skipped: false });
    assert.deepEqual(topicsOf(sqlite), ["armenia"]);
  });
  test("a second Skip (another device) changes nothing", async () => {
    fetchMock = mockFetch(() => undefined);
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: NEW, onboarded_at: null, opened_at: null });
    await post(binding, "/api/settings", NEW, { topics: ["tech_ai"] });
    await post(binding, "/api/onboard", NEW, { skipped: false });
    await post(binding, "/api/onboard", NEW, { skipped: true });
    assert.deepEqual(topicsOf(sqlite), ["tech_ai"]);
  });
  test("the hint and the Next rule exist in every language, short, no long dash", () => {
    for (const lang of Object.keys(DICTS)) {
      const s = t(lang, "app.setup_pick_topic");
      assert.ok(s && s !== "app.setup_pick_topic" && s.length <= 40 && !/[\u2013\u2014]/.test(s), lang);
    }
    const js = readFileSync(new URL("../public/app/app.js", import.meta.url), "utf8");
    assert.ok(js.includes("setupNav(first, \"next\", none)"), "Next is disabled while no topic is on");
  });
});

describe("Step 18: wording and the command menu", () => {
  test("Help and every Mini App text say \"we\", never \"the owner\", in every language", () => {
    const OWNER_WORDS = /\bowner\b|владел|propriétaire|սեփականատեր|\bՏեր/i;
    for (const [lang, d] of Object.entries(DICTS)) {
      for (const [k, v] of Object.entries(d.app ?? {})) assert.doesNotMatch(String(v), OWNER_WORDS, `${lang} app.${k}`);
      for (const [k, v] of Object.entries(d.errors ?? {})) assert.doesNotMatch(String(v), OWNER_WORDS, `${lang} errors.${k}`);
      assert.match(t(lang, "app.help_feedback"), /We read|Мы читаем|Nous lisons|Մենք կարդում/, lang);
    }
  });
  test("no em or en dash in any text", () => {
    for (const [lang, d] of Object.entries(DICTS)) assert.doesNotMatch(JSON.stringify(d), /[\u2013\u2014]/, lang);
  });
  test("/support and /paysupport are not in the menu but still answer when typed", () => {
    for (const lang of Object.keys(DICTS)) {
      const cmds = commandList(lang).map((c) => c.command);
      assert.ok(!cmds.includes("support") && !cmds.includes("paysupport"), lang);
    }
    const bot = readFileSync(new URL("../src/bot.js", import.meta.url), "utf8");
    assert.ok(bot.includes("/^\\/support(@\\w+)?(\\s|$)/") && bot.includes("/^\\/paysupport(@\\w+)?"), "both commands are still handled");
  });
  test("Delete my data and its Delete button use the brand red, not the orange", () => {
    const css = readFileSync(new URL("../public/app/app.css", import.meta.url), "utf8");
    assert.match(css, /\.row\.action\.danger \.row-title, \.row\.action\.danger:disabled \.row-title \{ color: var\(--accent-text\);/);
    const js = readFileSync(new URL("../public/app/app.js", import.meta.url), "utf8");
    assert.ok(js.includes('<button class="b s4 primary" data-action="delete-yes"'));
  });
});

describe("Step 18: the Admin dashboard data", () => {
  const H = 3600;
  // A minimal Admin object as api.js builds it (shapeAdmin + custom + env)
  function base(now, over = {}) {
    return {
      env: "production",
      health: { level: "ok", problems: [], last_run: { started_at: now - 1200, status: "ok" }, alert: null, trigger: { on_time: true } },
      stats: { models: [{ provider: "gemini", model: "gemini-x", kind: "batch", "24h": { calls: 40, ok: 38 }, "7d": { calls: 280, ok: 270 } }] },
      feeds: { total: 100, failing: [{}, {}], silent: [] },
      users: { active: 7, count: 9 },
      d1: { limits: { rows_read: 5_000_000, rows_written: 100_000 }, rows_read: 1000, rows_written: 100, job: { r: 0, w: 0, runs: 0 }, worker: { r: 0, w: 0 },
        account: { r: 1_000_000, w: 30_000, cpu: 0, at: now - 600, y: { r: 2_000_000, w: 60_000 } } },
      custom: { guard: { level: 0, job_level: 0, models: [{ model: "gemini-x", calls: 12, soft_limit: 250, r429: 0 }] } },
      today: { stories: 42, strong: 9, deliveries: { sent: 20, quiet: 2, failed: 0, blocked: 0, stories: 80 } },
      ...over,
    };
  }
  test("green when all is fine, with the key numbers and the limits (today and yesterday)", async () => {
    const { adminSummary } = await import("../src/admin.js");
    const now = Math.floor(Date.UTC(2026, 10, 20, 12, 30) / 1000);
    const s = adminSummary(base(now), now);
    assert.equal(s.level, "ok");
    assert.equal(s.reason, "The news job, digests and limits are fine.");
    assert.deepEqual([s.numbers.active_users, s.numbers.digests_today, s.numbers.delivery, s.numbers.stories_today], [7, 20, 1, 42]);
    assert.equal(s.numbers.next_run_at, Math.floor(Date.UTC(2026, 10, 20, 13, 7) / 1000));
    assert.deepEqual(s.limits.today, { reads: 0.2, writes: 0.3 });
    assert.deepEqual(s.limits.yesterday, { reads: 0.4, writes: 0.6 });
    assert.deepEqual(s.ai.map((m) => [m.model, m.calls, m.failed, m.today, m.soft_limit]), [["gemini-x", 40, 2, 12, 250]]);
  });
  test("amber and red with the most serious reason first, and how many more", async () => {
    const { adminSummary } = await import("../src/admin.js");
    const now = Math.floor(Date.UTC(2026, 10, 20, 12, 30) / 1000);
    let A = base(now);
    A.d1.account.w = 75_000;
    assert.deepEqual([adminSummary(A, now).level, adminSummary(A, now).reason], ["warn", "D1 writes at 75% of the free limit today."]);
    A.d1.account.cpu = 2;
    assert.equal(adminSummary(A, now).reason, "D1 writes at 75% of the free limit today. (+1 more)");
    A.d1.account.w = 93_000;
    assert.deepEqual([adminSummary(A, now).level, adminSummary(A, now).reason], ["bad", "D1 writes at 93% of the free limit today. (+1 more)"]);
    A = base(now, { health: { level: "bad", problems: ["The last news job failed."], last_run: { started_at: now - 600, status: "error" }, alert: null, trigger: { on_time: true } } });
    assert.deepEqual([adminSummary(A, now).level, adminSummary(A, now).reason], ["bad", "The last news job failed."]);
    A = base(now); A.today.deliveries.failed = 1;
    assert.deepEqual([adminSummary(A, now).level, adminSummary(A, now).reason], ["warn", "1 digest delivery failed today."]);
    A.today.deliveries = { sent: 4, failed: 6, blocked: 0, quiet: 0, stories: 0 };
    assert.equal(adminSummary(A, now).level, "bad");
    A = base(now); A.stats.models[0]["24h"] = { calls: 10, ok: 3 };
    assert.match(adminSummary(A, now).reason, /^gemini-x: 7 of 10 AI calls failed/);
    A = base(now); A.feeds.failing = new Array(12).fill({});
    assert.equal(adminSummary(A, now).reason, "12 of 100 feeds failing.");
    A = base(now, { env: "staging" });
    assert.equal(adminSummary(A, now).numbers.next_run_at, null, "staging never runs the job");
  });
  test("deliveries today: one meta row, added up in SQL across ticks, started again the next UTC day", async () => {
    const { digestDayStatement } = await import("../src/cron.js");
    const { sqlite, db } = fakeD1();
    const day1 = Math.floor(Date.UTC(2026, 10, 20, 9) / 1000);
    await db.batch([digestDayStatement({ sent: 3, quiet: 1, failed: 1, blocked: 0, stories: 9 }, day1)]);
    await db.batch([digestDayStatement({ sent: 2, quiet: 0, failed: 2, blocked: 1, stories: 5 }, day1 + 600)]);
    const read = () => JSON.parse(sqlite.prepare("SELECT value FROM meta WHERE key = 'digest_day'").get().value);
    assert.deepEqual(read(), { day: "2026-11-20", sent: 5, quiet: 1, failed: 2, blocked: 1, stories: 14 });
    await db.batch([digestDayStatement({ sent: 1, quiet: 0, failed: 0, blocked: 0, stories: 2 }, day1 + 20 * H)]);
    assert.deepEqual(read(), { day: "2026-11-21", sent: 1, quiet: 0, failed: 0, blocked: 0, stories: 2 });
  });
  test("a cron tick that sends writes the counter; Admin reads it with today's new stories", async () => {
    fetchMock = mockFetch(() => undefined);
    const { runTick } = await import("../src/cron.js");
    const { sqlite, db, binding } = fakeD1();
    const now = nowS();
    addUser(sqlite, { id: OWNER, next_digest_at: now - 60 });
    const io = { send: async () => ({ message_id: 1 }), alert: async () => {}, appUrl: "https://w.test/app/" };
    const out = await runTick(db, io, now);
    assert.equal(out.sent, 1);
    const res = await worker.fetch(new Request("https://w.test/api/admin", { headers: { authorization: `tma ${await initFor(OWNER)}` } }), env(binding));
    const A = await res.json();
    assert.equal(A.today.deliveries.sent, 1);
    assert.equal(A.summary.numbers.digests_today, 1);
    assert.ok(["ok", "warn", "bad"].includes(A.summary.level) && A.summary.reason.length > 5);
  });
  test("Custom topics in Admin: only active ones; switched-off, unfollowed ones are a count", async () => {
    fetchMock = mockFetch(() => undefined);
    const { sqlite, binding } = fakeD1();
    addUser(sqlite, { id: OWNER });
    addUser(sqlite, { id: READER });
    const topic = sqlite.prepare("INSERT INTO custom_topics (id, tag, names, definition, queries, created_at) VALUES (?, ?, ?, 'x', '[]', 1)");
    topic.run(1, "c1", JSON.stringify({ en: "Japan" }));
    topic.run(2, "c2", JSON.stringify({ en: "Cricket" }));
    topic.run(3, "c3", JSON.stringify({ en: "Chess" }));
    sqlite.prepare("INSERT INTO custom_follows (user_id, topic_id, at, enabled) VALUES (?, 1, 1, 1), (?, 2, 1, 0)").run(READER, OWNER);
    const res = await worker.fetch(new Request("https://w.test/api/admin", { headers: { authorization: `tma ${await initFor(OWNER)}` } }), env(binding));
    const A = await res.json();
    assert.deepEqual(A.custom.topics.map((x) => x.name), ["Japan"]);
    assert.equal(A.custom.hidden, 2);
  });
});
