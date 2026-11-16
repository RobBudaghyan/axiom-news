// Steps 4-5: the Mini App API. initData verification (valid, tampered, expired), admin gating
// (owner vs non-owner), settings validation, next_digest_at recompute, the two admin actions,
// the bot's "Open settings" button and the D1 usage counter.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { signInitData, verifyInitData, dataCheckString } from "../src/auth.js";
import { SettingsError, TZ_AUTO, TZ_MANUAL, allowedTimes, nextDigestAfterChange, roundTimes, validatePatch } from "../src/settings.js";
import { feedReport, shapeAdmin, adminStatements } from "../src/admin.js";
import { CONFIG, nextSlot } from "../src/digest.js";
import { takeUsage, usageStatement } from "../src/db.js";
import { runTick } from "../src/cron.js";
import { ALL, OWNER, TZ, addStory, addUser, fakeD1, mockFetch, yerevan } from "./helpers.mjs";

const TOKEN = "123456:TEST-token-for-unit-tests";
const FRIEND = 777;
let fetchMock;
afterEach(() => fetchMock?.restore());

const nowS = () => Math.floor(Date.now() / 1000);
const tgUser = (id, first = "Ruben") => JSON.stringify({ id, first_name: first, language_code: "en" });
const initFor = (id, authDate = nowS(), token = TOKEN) =>
  signInitData({ query_id: "AAE1", user: tgUser(id), auth_date: String(authDate), signature: "sig" }, token);

function env(binding) {
  return { DB: binding, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: "s".repeat(40),
    OWNER_TELEGRAM_ID: String(OWNER), GITHUB_DISPATCH_TOKEN: "GH", GITHUB_REPO: "o/r", GITHUB_WORKFLOW: "hourly.yml" };
}
async function call(binding, path, { init, body, method = body === undefined ? "GET" : "POST" } = {}) {
  const headers = init === null ? {} : { authorization: `tma ${init}` };
  const res = await worker.fetch(new Request(`https://w.test${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env(binding));
  return { status: res.status, body: await res.json(), cache: res.headers.get("cache-control") };
}

describe("initData verification", () => {
  test("valid data passes and gives the user", async () => {
    const now = nowS();
    const v = await verifyInitData(await initFor(OWNER, now), TOKEN, now);
    assert.equal(v.ok, true);
    assert.equal(v.user.id, OWNER);
    assert.equal(v.user.first_name, "Ruben");
  });

  test("matches Telegram's documented check: every field except hash, sorted, joined by newlines", () => {
    const p = new URLSearchParams("user=%7B%7D&auth_date=5&hash=abc&query_id=q&signature=s");
    assert.equal(dataCheckString(p), "auth_date=5\nquery_id=q\nsignature=s\nuser={}");
  });

  test("tampered data is refused: changed user id, changed field, wrong token, missing hash", async () => {
    const now = nowS();
    const good = await initFor(FRIEND, now);
    const forged = good.replace(encodeURIComponent(`"id":${FRIEND}`), encodeURIComponent(`"id":${OWNER}`));
    assert.notEqual(forged, good);
    assert.deepEqual(await verifyInitData(forged, TOKEN, now), { ok: false, reason: "bad hash" });
    const p = new URLSearchParams(good); p.set("auth_date", String(now - 1));
    assert.equal((await verifyInitData(p.toString(), TOKEN, now)).reason, "bad hash");
    assert.equal((await verifyInitData(good, "999:other-bot", now)).reason, "bad hash");
    const noHash = new URLSearchParams(good); noHash.delete("hash");
    assert.equal((await verifyInitData(noHash.toString(), TOKEN, now)).reason, "no hash");
    assert.equal((await verifyInitData("", TOKEN, now)).reason, "missing");
  });

  test("expired data (older than 24 h) and future dates are refused", async () => {
    const now = nowS();
    assert.equal((await verifyInitData(await initFor(OWNER, now - 86401), TOKEN, now)).reason, "expired");
    assert.equal((await verifyInitData(await initFor(OWNER, now - 86000), TOKEN, now)).ok, true);
    assert.equal((await verifyInitData(await initFor(OWNER, now + 3600), TOKEN, now)).reason, "auth_date in the future");
  });

  test("the API answers 401 without valid initData, and never trusts an id in the body", async () => {
    const { binding, sqlite } = fakeD1();
    assert.equal((await call(binding, "/api/open", { init: null, body: {} })).status, 401);
    assert.equal((await call(binding, "/api/open", { init: "user=x&hash=00", body: {} })).status, 401);
    const expired = await initFor(OWNER, nowS() - 2 * 86400);
    assert.equal((await call(binding, "/api/admin", { init: expired })).status, 401);
    const r = await call(binding, "/api/settings", { init: await initFor(FRIEND), body: { id: OWNER, paused: true } });
    assert.equal(r.status, 404);   // the friend has no row yet; the body's id is not a setting
    assert.equal(sqlite.prepare("SELECT count(*) n FROM users").get().n, 0);
  });
});

describe("admin gating", () => {
  for (const [method, path] of [["GET", "/api/admin"], ["POST", "/api/admin/digest"], ["POST", "/api/admin/run-job"]]) {
    test(`${method} ${path}: non-owner gets 403 and nothing happens; owner is allowed`, async () => {
      const { binding, sqlite } = fakeD1();
      addUser(sqlite);                          // the owner
      addUser(sqlite, { id: FRIEND, first_name: "Friend" });
      addStory(sqlite, "IRAN: strike reported", ["iran_war"], 8, nowS() - 600);
      fetchMock = mockFetch(() => undefined);
      const body = method === "POST" ? {} : undefined;
      const denied = await call(binding, path, { init: await initFor(FRIEND), body, method });
      assert.equal(denied.status, 403);
      assert.match(denied.body.error, /only for the bot's owner/);
      assert.equal(fetchMock.calls.length, 0);  // no Telegram message, no GitHub dispatch
      const allowed = await call(binding, path, { init: await initFor(OWNER), body, method });
      assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    });
  }

  test("is_owner is true only for the owner (it only hides the tab; the API checks anyway)", async () => {
    const { binding } = fakeD1();
    assert.equal((await call(binding, "/api/open", { init: await initFor(OWNER), body: {} })).body.is_owner, true);
    assert.equal((await call(binding, "/api/open", { init: await initFor(FRIEND), body: {} })).body.is_owner, false);
  });
});

describe("settings validation", () => {
  const tags = ALL;
  test("accepts good values and normalises them", () => {
    assert.deepEqual(validatePatch({ topics: ["armenia", "politics", "armenia"] }, tags), { topics: ["politics", "armenia"] });
    assert.deepEqual(validatePatch({ digest_times: ["20:00", "06:00", "23:00"] }, tags), { digest_times: ["06:00", "20:00", "23:00"] });
    assert.deepEqual(validatePatch({ paused: true }, tags), { paused: 1 });
  });

  test("allowed times are 06:00 to 23:00 on the hour", () => {
    const t = allowedTimes();
    assert.equal(t.length, 18);
    assert.equal(t[0], "06:00");
    assert.equal(t[1], "07:00");
    assert.equal(t.at(-1), "23:00");
  });

  const bad = [
    [{ topics: [] }, /at least one topic/],
    [{ topics: ["sports"] }, /does not exist/],
    [{ topics: "politics" }, /must be a list/],
    [{ digest_times: [] }, /at least one digest time/],
    [{ digest_times: ["05:00"] }, /between 06:00 and 23:00/],
    [{ digest_times: ["09:30"] }, /on the hour/],
    [{ digest_times: ["23:30"] }, /on the hour/],
    [{ digest_times: ["9:00"] }, /on the hour/],
    [{ digest_times: ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00"] }, /up to 5/],
    [{ max_stories: 7 }, /Unknown setting: max_stories/],          // removed in Step 5
    [{ format: "B" }, /Unknown setting: format/],
    [{ timezone: "Europe/Berlin" }, /Unknown setting: timezone/],   // the zone follows the phone
    [{ paused: "yes" }, /on or off/],
    [{ blocked: 0 }, /Unknown setting: blocked/],
    [{ next_digest_at: 1 }, /Unknown setting/],
    [{}, /Nothing to save/],
    [null, /Nothing to save/],
  ];
  for (const [patch, msg] of bad) {
    test(`refuses ${JSON.stringify(patch)}`, () => {
      assert.throws(() => validatePatch(patch, tags), (e) => e instanceof SettingsError && msg.test(e.message));
    });
  }

  test("five times are allowed; duplicates do not count twice", () => {
    assert.equal(validatePatch({ digest_times: ["08:00", "09:00", "10:00", "11:00", "12:00", "12:00"] }, tags)
      .digest_times.length, 5);
  });

  test("a bad value through the API is a 400 with a friendly message, and nothing is written", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { next_digest_at: yerevan(20) });
    const r = await call(binding, "/api/settings", { init: await initFor(OWNER), body: { digest_times: ["09:30"] } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /on the hour, between 06:00 and 23:00/);
    assert.equal(sqlite.prepare("SELECT digest_times FROM users").get().digest_times, '["09:00","14:00","20:00"]');
  });

  test("old half-hour times move to the nearest hour (a half hour rounds up), within 06:00-23:00", () => {
    assert.deepEqual(roundTimes(["08:30", "14:00", "20:00"]), ["09:00", "14:00", "20:00"]);
    assert.deepEqual(roundTimes(["07:30", "08:00", "22:30"]), ["08:00", "23:00"]);       // 07:30 and 08:00 merge
    assert.deepEqual(roundTimes(["05:00", "23:30", "08:15", "12:45"]), ["06:00", "08:00", "13:00", "23:00"]);
    assert.deepEqual(roundTimes(["07:00"]), ["07:00"]);                                  // unchanged
    assert.deepEqual(roundTimes([]), CONFIG.default_times);
  });
});

describe("next_digest_at recompute", () => {
  const base = { timezone: TZ, digest_times: '["09:00","14:00","20:00"]', paused: 0 };

  test("new times: the first new slot after now", () => {
    const now = yerevan(10, 0);
    const before = { ...base, next_digest_at: yerevan(14) };
    assert.equal(nextDigestAfterChange(before, { ...before, digest_times: '["11:00","21:00"]' }, now), yerevan(11));
    assert.equal(nextDigestAfterChange(before, { ...before, digest_times: '["07:00"]' }, now), yerevan(7, 0, 14));
  });

  test("a new time zone moves the slot to that zone's local time", () => {
    const now = yerevan(10, 0);   // 06:00 UTC, 07:00 in Berlin
    const before = { ...base, next_digest_at: yerevan(14) };
    const after = { ...before, timezone: "Europe/Berlin" };
    assert.equal(nextDigestAfterChange(before, after, now), nextSlot(now, "Europe/Berlin", ["09:00", "14:00", "20:00"]));
    assert.equal(nextDigestAfterChange(before, after, now), yerevan(12, 0));   // 09:00 Berlin = 12:00 Yerevan
  });

  test("a digest already due (slot passed < 15 min ago) is kept, not swallowed", () => {
    const now = yerevan(14, 3);
    const before = { ...base, next_digest_at: yerevan(14) };
    assert.equal(nextDigestAfterChange(before, { ...before, topics: '["armenia"]' }, now), yerevan(14));
    assert.equal(nextDigestAfterChange(before, { ...before, paused: 1 }, now), yerevan(20));   // pausing drops it
  });

  test("resuming after a pause starts at the next slot, not a stale one", () => {
    const now = yerevan(14, 3);
    const before = { ...base, paused: 1, next_digest_at: yerevan(14) };
    assert.equal(nextDigestAfterChange(before, { ...before, paused: 0 }, now), yerevan(20));
  });

  test("saving through the API writes the setting and the new next_digest_at", async () => {
    const { binding, sqlite } = fakeD1();
    const now = nowS();
    addUser(sqlite, { next_digest_at: now + 3 * 3600 });
    const r = await call(binding, "/api/settings", { init: await initFor(OWNER),
      body: { digest_times: ["07:00", "23:00"], topics: ["armenia"] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.cache, "no-store");
    const u = sqlite.prepare("SELECT * FROM users WHERE id = ?").get(OWNER);
    assert.equal(u.digest_times, '["07:00","23:00"]');
    assert.equal(u.topics, '["armenia"]');
    assert.equal(u.next_digest_at, nextSlot(now, TZ, ["07:00", "23:00"]));
    assert.equal(r.body.user.next_digest_at, u.next_digest_at);
    assert.deepEqual(r.body.user.digest_times, ["07:00", "23:00"]);
    assert.equal("max_stories" in r.body.user || "format" in r.body.user, false);
  });
});

describe("open: new users and the device time zone", () => {
  test("first open creates the user with defaults and the device zone", async () => {
    const { binding, sqlite } = fakeD1();
    const r = await call(binding, "/api/open", { init: await initFor(FRIEND), body: { tz: "Europe/Berlin" } });
    assert.equal(r.status, 200);
    const u = sqlite.prepare("SELECT * FROM users WHERE id = ?").get(FRIEND);
    assert.equal(u.timezone, "Europe/Berlin");
    assert.equal(u.tz_detected, TZ_AUTO);
    assert.deepEqual(JSON.parse(u.topics), ALL);
    assert.equal(r.body.user.tz_source, "device");
    assert.equal(r.body.topics.length, 6);
    assert.deepEqual(r.body.limits, CONFIG.settings_limits);
  });

  test("the zone always follows the phone, also one chosen by hand before Step 5", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { next_digest_at: nowS() + 3600 });
    await call(binding, "/api/open", { init: await initFor(OWNER), body: { tz: "Asia/Tbilisi" } });
    let u = sqlite.prepare("SELECT * FROM users").get();
    assert.equal(u.timezone, "Asia/Tbilisi");
    assert.equal(u.tz_detected, TZ_AUTO);
    assert.equal(u.next_digest_at, nextSlot(nowS(), "Asia/Tbilisi", ["09:00", "14:00", "20:00"]));
    sqlite.prepare("UPDATE users SET timezone = 'Europe/Paris', tz_detected = ?").run(TZ_MANUAL);
    const r = await call(binding, "/api/open", { init: await initFor(OWNER), body: { tz: "Asia/Tbilisi" } });
    u = sqlite.prepare("SELECT * FROM users").get();
    assert.equal(u.timezone, "Asia/Tbilisi");
    assert.equal(u.tz_detected, TZ_AUTO);
    assert.equal(r.body.user.tz_source, "device");
  });

  test("a junk device zone is ignored", async () => {
    const { binding, sqlite } = fakeD1();
    const r = await call(binding, "/api/open", { init: await initFor(FRIEND), body: { tz: "Not/AZone" } });
    assert.equal(sqlite.prepare("SELECT timezone FROM users").get().timezone, CONFIG.default_timezone);
    assert.equal(r.body.user.tz_source, "default");
  });
});

describe("admin data and actions", () => {
  test("shapeAdmin: health, stats, users, feeds, D1 use", async () => {
    const { db, sqlite } = fakeD1();
    const now = nowS();
    addUser(sqlite, { last_digest_at: now - 3600 });
    addUser(sqlite, { id: FRIEND, first_name: "Ani", paused: 1 });
    // two digests in the last day (3 + 1 stories, one of them merged away later and copied to its
    // kept story: still 4), one older digest that does not count
    const st = [1, 2, 3, 4, 5, 6].map((i) => addStory(sqlite, `S${i}`, ["politics"], 7, now - 7200));
    sqlite.prepare("UPDATE stories SET merged_into = ? WHERE id = ?").run(st[5], st[2]);
    const sent = sqlite.prepare("INSERT INTO sent (user_id, story_id, sent_at) VALUES (?, ?, ?)");
    for (const s of [st[0], st[1], st[2], st[5]]) sent.run(OWNER, s, now - 5000);   // st[5]: the copy of st[2]
    sent.run(OWNER, st[3], now - 1000);
    sent.run(OWNER, st[4], now - 2 * 86400);
    addUser(sqlite, { id: 8, first_name: "Gone", blocked: 1 });
    const run = sqlite.prepare("INSERT INTO job_runs (started_at, finished_at, status, provider, items_fetched, items_new, " +
      "stories_created, stories_merged, items_dropped, ai_calls, input_tokens, output_tokens, d1_rows_read, d1_rows_written) " +
      "VALUES (?, ?, ?, ?, 100, 80, 20, 5, 30, 2, 1000, 500, 4000, 900)");
    run.run(now - 3 * 86400, now - 3 * 86400 + 60, "ok", "gemini");
    run.run(now - 1800, now - 1740, "ok", "gemini+gemini-fallback");
    sqlite.prepare("INSERT INTO ai_calls (at, provider, model, ok, input_tokens, output_tokens) VALUES (?, 'gemini', 'm1', ?, 10, 5)")
      .run(now - 1800, 1);
    sqlite.prepare("INSERT INTO ai_calls (at, provider, model, ok, input_tokens, output_tokens) VALUES (?, 'gemini', 'm1', ?, 10, 5)")
      .run(now - 2 * 86400, 0);
    sqlite.prepare("INSERT INTO errors (at, component, message) VALUES (?, 'job', 'boom')").run(now - 60);
    sqlite.prepare("INSERT INTO meta (key, value) VALUES ('feed_health', ?)").run(JSON.stringify({ at: now, feeds: {
      a: { n: "Alpha", ok: now, item: now - 600, err: null }, b: { n: "Beta", ok: now - 7200, item: now - 9000, err: "HTTP 403", since: now - 7200, fails: 2 },
      c: { n: "Gamma", ok: now, item: now - 3 * 86400, err: null } } }));
    const a = shapeAdmin(await db.batch(adminStatements(now)), now);
    assert.equal(a.health.level, "ok");
    assert.equal(a.health.last_run.duration_s, 60);
    assert.equal(a.health.last_run.provider, "gemini+gemini-fallback");
    assert.equal(a.health.trigger.on_time, true);
    assert.equal(a.stats["24h"].runs, 1);
    assert.equal(a.stats["7d"].runs, 2);
    assert.equal(a.stats["24h"].fallback_runs, 1);
    assert.equal(a.stats["7d"].stories_created, 40);
    assert.deepEqual(a.stats.models[0]["24h"], { calls: 1, ok: 1, input_tokens: 10, output_tokens: 5 });
    assert.equal(a.stats.models[0]["7d"].calls, 2);
    assert.deepEqual([a.users.count, a.users.active, a.users.paused, a.users.blocked], [3, 1, 1, 1]);
    const me = a.users.list.find((u) => u.id === OWNER);
    assert.deepEqual([me.digests_24h, me.avg_stories_24h], [2, 2]);            // (3 + 1) / 2
    assert.deepEqual([a.users.list.find((u) => u.id === FRIEND).digests_24h, a.users.list.find((u) => u.id === FRIEND).avg_stories_24h], [0, null]);
    assert.deepEqual(a.feeds.failing.map((f) => [f.name, f.error, f.fails]), [["Beta", "HTTP 403", 2]]);
    assert.deepEqual(a.feeds.silent.map((f) => f.name), ["Gamma"]);
    assert.equal(a.errors[0].message, "boom");
    assert.equal(a.d1.job.r, now % 86400 >= 1800 ? 4000 : a.d1.job.r);
    assert.equal(a.d1.limits.rows_written, 100000);
  });

  test("health: a late hourly job and a recent alert are flagged", async () => {
    const { db, sqlite } = fakeD1();
    const now = nowS();
    sqlite.prepare("INSERT INTO job_runs (started_at, finished_at, status) VALUES (?, ?, 'ok')").run(now - 2 * 3600, now - 2 * 3600 + 60);
    sqlite.prepare("INSERT INTO meta (key, value) VALUES ('last_alert_at', ?), ('last_alert_text', 'no run')").run(String(now - 600));
    const a = shapeAdmin(await db.batch(adminStatements(now)), now);
    assert.equal(a.health.trigger.on_time, false);
    assert.equal(a.health.level, "warn");
    assert.deepEqual(a.health.alert, { at: now - 600, text: "no run" });
  });

  test("feedReport: no data yet is not an error", () => {
    assert.deepEqual(feedReport(null, 1000), { checked_at: null, total: 0, failing: [], silent: [], silent_hours: 48 });
  });

  test("Send me a digest now: a real digest to the owner only, stories marked as sent", async () => {
    const { binding, sqlite } = fakeD1();
    const now = nowS();
    addUser(sqlite, { next_digest_at: now + 4 * 3600 });
    const a = addStory(sqlite, "IRAN: strike reported", ["iran_war"], 9, now - 600);   // unedited: 9 - 2 = 7
    fetchMock = mockFetch(() => undefined);
    const r = await call(binding, "/api/admin/digest", { init: await initFor(OWNER), body: {} });
    assert.equal(r.status, 200);
    assert.match(r.body.message, /Sent: 1 story/);
    assert.equal(fetchMock.calls.length, 1);
    assert.equal(fetchMock.calls[0].body.chat_id, OWNER);
    assert.match(fetchMock.calls[0].url, /\/sendRichMessage$/);   // Step 11: the same rich message as the cron's
    assert.match(fetchMock.calls[0].body.rich_message.html, /strike reported/);
    assert.equal(fetchMock.calls[0].body.reply_markup.inline_keyboard[0][0].text, "⚙️ Settings");
    assert.deepEqual(sqlite.prepare("SELECT story_id FROM sent").all().map((x) => x.story_id), [a]);
    const again = await call(binding, "/api/admin/digest", { init: await initFor(OWNER), body: {} });
    assert.match(again.body.message, /nothing new/);   // never twice
  });

  test("Run news job now: dispatches, but respects the 20-minute gap and a running job", async () => {
    const { binding, sqlite } = fakeD1();
    const now = nowS();
    fetchMock = mockFetch(() => ({ status: 204 }));
    const ins = sqlite.prepare("INSERT INTO job_runs (started_at, finished_at, status) VALUES (?, ?, ?)");
    ins.run(now - 25 * 60, now - 24 * 60, "ok");
    let r = await call(binding, "/api/admin/run-job", { init: await initFor(OWNER), body: {} });
    assert.equal(r.status, 200);
    assert.match(fetchMock.calls[0].url, /actions\/workflows\/hourly\.yml\/dispatches$/);
    ins.run(now - 5 * 60, null, "running");
    r = await call(binding, "/api/admin/run-job", { init: await initFor(OWNER), body: {} });
    assert.equal(r.status, 409);
    assert.match(r.body.message, /running right now/);
    sqlite.prepare("UPDATE job_runs SET status = 'ok', finished_at = ? WHERE status = 'running'").run(now - 4 * 60);
    r = await call(binding, "/api/admin/run-job", { init: await initFor(OWNER), body: {} });
    assert.equal(r.status, 409);
    assert.match(r.body.message, /You can start it again from \d\d:\d\d/);
    assert.equal(fetchMock.calls.length, 1);
  });

  test("a failed GitHub dispatch is reported and logged", async () => {
    const { binding, sqlite } = fakeD1();
    fetchMock = mockFetch(() => ({ status: 401, body: { message: "Bad credentials" } }));
    const r = await call(binding, "/api/admin/run-job", { init: await initFor(OWNER), body: {} });
    assert.equal(r.status, 502);
    assert.match(sqlite.prepare("SELECT message FROM errors").get().message, /Bad credentials/);
  });
});

describe("bot: Open settings button", () => {
  const post = (text) => new Request("https://w.test/telegram", {
    method: "POST", headers: { "x-telegram-bot-api-secret-token": "s".repeat(40) },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, from: { id: OWNER, first_name: "Ruben" },
      chat: { id: OWNER, type: "private" }, text } }) });

  test("/start and /settings carry a web_app button to the Mini App", async () => {
    const { binding } = fakeD1();
    fetchMock = mockFetch(() => undefined);
    await worker.fetch(post("/start"), { ...env(binding), APP_URL: "https://w.test/app/" });
    await worker.fetch(post("/settings"), { ...env(binding), APP_URL: "https://w.test/app/" });
    for (const c of fetchMock.calls) {
      assert.deepEqual(c.body.reply_markup, { inline_keyboard: [[{ text: "Open settings", web_app: { url: "https://w.test/app/" } }]] });
    }
    assert.match(fetchMock.calls[0].body.text, /Tap Open settings/);
    assert.match(fetchMock.calls[1].body.text, /^Choose your topics, language and when your digests arrive/);
    assert.doesNotMatch(fetchMock.calls.map((c) => c.body.text).join(), /[—–]/);
  });

  test("without APP_URL the button points at this Worker's /app/", async () => {
    const { binding } = fakeD1();
    fetchMock = mockFetch(() => undefined);
    await worker.fetch(post("/settings"), env(binding));
    assert.equal(fetchMock.calls[0].body.reply_markup.inline_keyboard[0][0].web_app.url, "https://w.test/app/");
  });
});

describe("D1 usage counter", () => {
  test("every cron tick records the rows D1 reported, even in a fresh isolate", async () => {
    const { binding, sqlite } = fakeD1();
    const withMeta = { ...binding, batch: async (list) => (await binding.batch(list)).map((r) => ({ ...r, meta: { rows_read: 4, rows_written: 1 } })) };
    const { d1Binding } = await import("../src/db.js");
    takeUsage();
    const now = 20000 * 86400 + 600;
    await runTick(d1Binding(withMeta), { send: async () => {}, alert: async () => {} }, now, { digests: false });
    const v = JSON.parse(sqlite.prepare("SELECT value FROM meta WHERE key = 'd1_worker'").get().value);
    assert.equal(v.day, 20000);
    assert.ok(v.r >= 12, `rows read ${v.r}`);   // three health reads reported 4 each
  });

  test("the cron tick flushes the isolate's D1 rows into meta, per UTC day", async () => {
    const { db, sqlite } = fakeD1();
    takeUsage();
    const day = 20000 * 86400;
    sqlite.exec(`INSERT INTO meta (key, value) VALUES ('x', '1')`);
    await db.batch([usageStatement({ r: 10, w: 2 }, day + 5)]);
    await db.batch([usageStatement({ r: 5, w: 1 }, day + 50)]);
    assert.deepEqual(JSON.parse(sqlite.prepare("SELECT value FROM meta WHERE key = 'd1_worker'").get().value),
      { day: 20000, r: 15, w: 3 });
    await db.batch([usageStatement({ r: 7, w: 0 }, day + 86400)]);   // next UTC day: starts over
    assert.deepEqual(JSON.parse(sqlite.prepare("SELECT value FROM meta WHERE key = 'd1_worker'").get().value),
      { day: 20001, r: 7, w: 0 });
  });
});
