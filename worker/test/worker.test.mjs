// The Worker itself: webhook secret, /start, help replies, the digest cron (send, never twice,
// blocked users, retries), the hourly GitHub trigger and the health alerts.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker, { HOURLY_CRON } from "../src/index.js";
import { runTick } from "../src/cron.js";
import { assessHealth } from "../src/health.js";
import { ALL, OWNER, TZ, addStory, addUser, fakeD1, mockFetch, yerevan } from "./helpers.mjs";

const SECRET = "s".repeat(40);
let fetchMock;
afterEach(() => fetchMock?.restore());

function env(binding) {
  return { DB: binding, TELEGRAM_BOT_TOKEN: "TOKEN", TELEGRAM_WEBHOOK_SECRET: SECRET, OWNER_TELEGRAM_ID: String(OWNER),
    GITHUB_DISPATCH_TOKEN: "GH", GITHUB_REPO: "owner/axiom-news", GITHUB_WORKFLOW: "hourly.yml", GITHUB_REF: "main" };
}
const update = (text, from = { id: OWNER, first_name: "Ruben", language_code: "en" }) =>
  ({ update_id: 1, message: { message_id: 5, from, chat: { id: from.id, type: "private" }, text } });
const post = (body, secret = SECRET) => new Request("https://w.test/telegram", {
  method: "POST", headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {}, body: JSON.stringify(body) });
const okRun = (sqlite, startedAt, status = "ok") =>
  sqlite.prepare("INSERT INTO job_runs (started_at, finished_at, status) VALUES (?, ?, ?)").run(startedAt, startedAt + 90, status);

describe("webhook", () => {
  test("rejects a request without the right secret header", async () => {
    const { binding } = fakeD1();
    fetchMock = mockFetch(() => undefined);
    assert.equal((await worker.fetch(post(update("/start"), null), env(binding))).status, 403);
    assert.equal((await worker.fetch(post(update("/start"), "wrong".repeat(8)), env(binding))).status, 403);
    assert.equal(fetchMock.calls.length, 0);
  });

  test("/start creates the user with defaults and sends a welcome naming the times", async () => {
    const { binding, sqlite } = fakeD1();
    fetchMock = mockFetch(() => undefined);
    const res = await worker.fetch(post(update("/start")), env(binding));
    assert.equal(res.status, 200);
    const u = sqlite.prepare("SELECT * FROM users WHERE id = ?").get(OWNER);
    assert.equal(u.first_name, "Ruben");
    assert.equal(u.timezone, "Asia/Yerevan");
    assert.equal(u.digest_times, '["09:00","14:00","20:00"]');
    assert.equal(u.max_stories, 7);
    assert.deepEqual(JSON.parse(u.topics), ALL);
    assert.ok(u.next_digest_at > Date.now() / 1000);
    const reply = fetchMock.calls[0];
    assert.match(reply.url, /\/sendMessage$/);
    assert.equal(reply.body.chat_id, OWNER);
    assert.match(reply.body.text, /^Welcome to Axiom News, Ruben!/);
    assert.match(reply.body.text, /09:00, 14:00 and 20:00 \(Yerevan time\)/);
    assert.doesNotMatch(reply.body.text, /[—–]/);
  });

  test("/start again keeps settings, unblocks, and says welcome back", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { max_stories: 5, topics: '["armenia"]', blocked: 1, digest_times: '["08:00"]' });
    fetchMock = mockFetch(() => undefined);
    await worker.fetch(post(update("/start")), env(binding));
    const u = sqlite.prepare("SELECT * FROM users WHERE id = ?").get(OWNER);
    assert.equal(u.max_stories, 5);
    assert.equal(u.topics, '["armenia"]');
    assert.equal(u.blocked, 0);
    assert.match(fetchMock.calls[0].body.text, /^Welcome back, Ruben!/);
    assert.match(fetchMock.calls[0].body.text, /at 08:00 \(Yerevan time\)/);
  });

  test("other messages get a short help reply; unknown users are told to /start", async () => {
    const { binding, sqlite } = fakeD1();
    fetchMock = mockFetch(() => undefined);
    await worker.fetch(post(update("hello?")), env(binding));
    assert.match(fetchMock.calls[0].body.text, /Send \/start/);
    addUser(sqlite, { next_digest_at: yerevan(20) });
    await worker.fetch(post(update("what is this")), env(binding));
    assert.match(fetchMock.calls[1].body.text, /^I send news digests at 09:00, 14:00 and 20:00/);
  });

  test("an error is logged and Telegram still gets 200", async () => {
    const { binding, sqlite } = fakeD1();
    fetchMock = mockFetch(() => ({ status: 500, body: { ok: false, description: "boom" } }));
    assert.equal((await worker.fetch(post(update("/start")), env(binding))).status, 200);
    assert.match(sqlite.prepare("SELECT message FROM errors").get().message, /webhook: Telegram sendMessage HTTP 500/);
  });
});

describe("digest cron", () => {
  function setup() {
    const { db, sqlite } = fakeD1();
    const now = yerevan(14, 5);
    okRun(sqlite, now - 1800);
    addStory(sqlite, "Armenia and Azerbaijan sign border deal", ["armenia", "politics"], 7, now - 600);
    addStory(sqlite, "Iran fires missiles at a tanker in the Gulf", ["iran_war", "wars_conflicts"], 6, now - 300);
    const outbox = [];
    const io = { send: async (id, text) => { outbox.push({ id, text }); return { message_id: outbox.length }; },
      alert: async (t) => outbox.push({ alert: t }) };
    return { db, sqlite, now, outbox, io };
  }

  test("sends a due digest, records sent rows, moves to the next slot", async () => {
    const { db, sqlite, now, outbox, io } = setup();
    addUser(sqlite, { next_digest_at: yerevan(14), last_digest_at: yerevan(9) });
    const out = await runTick(db, io, now);
    assert.equal(out.sent, 1);
    assert.equal(outbox.length, 1);
    assert.match(outbox[0].text, /^Good afternoon\. Since 09:00, 2 stories on your topics:\n\n<b>🇦🇲 Armenia<\/b>\n1\. 🇦🇲 <b>Armenia/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sent").get().n, 2);
    const u = sqlite.prepare("SELECT * FROM users").get();
    assert.equal(u.last_digest_at, yerevan(14));   // the slot, so the next header says "Since 14:00"
    assert.equal(u.next_digest_at, yerevan(20));
  });

  test("never twice: the next due digest is a quiet note", async () => {
    const { db, sqlite, now, outbox, io } = setup();
    addUser(sqlite, { next_digest_at: yerevan(14) });
    await runTick(db, io, now);
    sqlite.prepare("UPDATE stories SET updated_at = ?").run(now + 60);
    sqlite.prepare("UPDATE users SET next_digest_at = ?").run(now + 100);
    await runTick(db, io, now + 300);
    assert.equal(outbox[1].text, "Good afternoon. Quiet period: nothing important on your topics since 14:00.");
  });

  test("at most max_users_per_tick users per tick, the earliest due first; the rest go next tick", async () => {
    const { db, sqlite, now, outbox, io } = setup();
    for (let id = 1; id <= 3; id++) addUser(sqlite, { id, next_digest_at: yerevan(14) + id });
    const cfg = { ...(await import("../src/digest.js")).CONFIG, max_users_per_tick: 2 };
    assert.equal((await runTick(db, io, now, {}, cfg)).sent, 2);
    assert.deepEqual(outbox.map((m) => m.id), [1, 2]);
    assert.equal((await runTick(db, io, now + 300, {}, cfg)).sent, 1);
    assert.equal(outbox[2].id, 3);
  });

  test("not due, paused or blocked users get nothing", async () => {
    const { db, sqlite, now, outbox, io } = setup();
    addUser(sqlite, { next_digest_at: yerevan(20) });
    addUser(sqlite, { id: 2, next_digest_at: yerevan(14), paused: 1 });
    addUser(sqlite, { id: 3, next_digest_at: yerevan(14), blocked: 1 });
    addUser(sqlite, { id: 4, next_digest_at: null });
    assert.equal((await runTick(db, io, now)).due, 0);
    assert.equal(outbox.length, 0);
  });

  test("Telegram 403 marks the user blocked and records nothing", async () => {
    const { db, sqlite, now, io } = setup();
    addUser(sqlite, { next_digest_at: yerevan(14) });
    io.send = async () => { const e = new Error("Telegram sendMessage HTTP 403: blocked"); e.status = 403; throw e; };
    await runTick(db, io, now);
    assert.equal(sqlite.prepare("SELECT blocked FROM users").get().blocked, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sent").get().n, 0);
  });

  test("a failed send is logged and retried next tick; after an hour the slot is skipped", async () => {
    const { db, sqlite, now, io } = setup();
    addUser(sqlite, { next_digest_at: yerevan(14) });
    io.send = async () => { const e = new Error("Telegram sendMessage HTTP 502: bad gateway"); e.status = 502; throw e; };
    await runTick(db, io, now);
    assert.equal(sqlite.prepare("SELECT next_digest_at FROM users").get().next_digest_at, yerevan(14));
    assert.match(sqlite.prepare("SELECT message FROM errors").get().message, /digest for user 42: .*502/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sent").get().n, 0);
    await runTick(db, io, yerevan(15, 5));
    assert.equal(sqlite.prepare("SELECT next_digest_at FROM users").get().next_digest_at, yerevan(20));
  });

  test("scheduled(): */5 sends digests; 7 * * * * dispatches the GitHub job", async () => {
    const { binding, sqlite } = fakeD1();
    const now = Math.floor(Date.now() / 1000);
    okRun(sqlite, now - 600);
    addStory(sqlite, "Armenia and Azerbaijan sign border deal", ["armenia"], 7, now - 600);
    addUser(sqlite, { next_digest_at: now - 60 });
    fetchMock = mockFetch((url) => (url.includes("api.github.com") ? { status: 204 } : undefined));
    await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: now * 1000 }, env(binding));
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0].body.parse_mode, "HTML");
    assert.deepEqual(fetchMock.calls[0].body.link_preview_options, { is_disabled: true });
    await worker.scheduled({ cron: HOURLY_CRON, scheduledTime: now * 1000 }, env(binding));
    const gh = fetchMock.calls[1];
    assert.equal(gh.url, "https://api.github.com/repos/owner/axiom-news/actions/workflows/hourly.yml/dispatches");
    assert.equal(gh.init.headers.authorization, "Bearer GH");
    assert.deepEqual(gh.body, { ref: "main", inputs: { min_gap_minutes: "20" } });
    assert.equal(fetchMock.calls.length, 2);   // no digest, no alert on the hourly tick
  });

  test("a failed dispatch is logged and alerted to the owner", async () => {
    const { binding, sqlite } = fakeD1();
    const now = Math.floor(Date.now() / 1000);
    okRun(sqlite, now - 600);
    fetchMock = mockFetch((url) => (url.includes("api.github.com") ? { status: 401, body: { message: "Bad credentials" } } : undefined));
    await worker.scheduled({ cron: HOURLY_CRON, scheduledTime: now * 1000 }, env(binding));
    assert.match(sqlite.prepare("SELECT message FROM errors").get().message, /GitHub HTTP 401: Bad credentials/);
    const alert = fetchMock.calls[1];
    assert.equal(alert.body.chat_id, OWNER);
    assert.match(alert.body.text, /^Axiom News alert: could not start the hourly job/);
  });
});

describe("health alerts", () => {
  const now = yerevan(16, 0);
  const run = (id, startedAt, status, finished = true) => ({ id, started_at: startedAt, finished_at: finished ? startedAt + 90 : null, status });

  test("healthy: nothing", () => {
    const h = assessHealth({ runs: [run(5, now - 3000, "ok")], lastOk: [{ started_at: now - 3000 }], meta: [] }, now, TZ);
    assert.equal(h.alert, null);
    assert.deepEqual(h.problems, []);
  });
  test("a failed run alerts once, naming the status and time", () => {
    const h = assessHealth({ runs: [run(6, yerevan(15, 7), "ai_failed"), run(5, yerevan(14, 7), "ok")],
      lastOk: [{ started_at: yerevan(14, 7) }], meta: [] }, now, TZ);
    assert.match(h.alert, /the hourly news job failed \(status ai_failed, started 15:07\)/);
    assert.doesNotMatch(h.alert, /[—–]/);
    const meta = h.writes.map((w) => ({ key: w.params[0], value: w.params[1] }));
    const again = assessHealth({ runs: [run(6, yerevan(15, 7), "ai_failed")], lastOk: [{ started_at: yerevan(14, 7) }],
      meta: meta.map((m) => ({ ...m, value: m.key === "last_alert_at" ? String(now - 4 * 3600) : m.value })) }, now, TZ);
    assert.equal(again.alert, null, "the same failed run must not alert twice");
  });
  test("no successful run for 3 hours", () => {
    const h = assessHealth({ runs: [], lastOk: [{ started_at: now - 3 * 3600 - 60 }], meta: [] }, now, TZ);
    assert.match(h.alert, /no successful hourly job run since 12:59/);
  });
  test("a run stuck in running for 30+ minutes", () => {
    const h = assessHealth({ runs: [run(7, now - 40 * 60, "running", false)], lastOk: [{ started_at: now - 3600 }], meta: [] }, now, TZ);
    assert.match(h.alert, /started at 15:20 never finished/);
  });
  test("at most one alert per 3 hours", () => {
    const base = { runs: [], lastOk: [], meta: [{ key: "last_alert_at", value: String(now - 2 * 3600) }] };
    assert.equal(assessHealth(base, now, TZ).alert, null);
    assert.ok(assessHealth({ ...base, meta: [{ key: "last_alert_at", value: String(now - 3 * 3600) }] }, now, TZ).alert);
  });
  test("cron sends the alert to the owner and stores the throttle", async () => {
    const { db, sqlite } = fakeD1();
    const sent = [];
    const out = await runTick(db, { send: async () => ({}), alert: async (t) => sent.push(t) }, now);
    assert.equal(out.alert, true);
    assert.match(sent[0], /no successful hourly job run yet/);
    assert.equal(Number(sqlite.prepare("SELECT value FROM meta WHERE key='last_alert_at'").get().value), now);
    await runTick(db, { send: async () => ({}), alert: async (t) => sent.push(t) }, now + 300);
    assert.equal(sent.length, 1);
  });
});
