// Step 16 (owner, after his phone test): no Pause, every topic may be off (then nothing at all),
// the setup's language step, red Help and Feedback squares, the hint under Add a topic, and short
// texts written one idea per line with emojis.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";
import { signInitData } from "../src/auth.js";
import { allTopicsOff, runTick } from "../src/cron.js";
import { SettingsError, validatePatch } from "../src/settings.js";
import { CONFIG, FIXED_OFFSETS, candidateStatement, localParts, nextSlot, qualifies } from "../src/digest.js";
import { validZone } from "../src/settings.js";
import { pauseStatements } from "../scripts/migrate-pause.mjs";
import { ALL, OWNER, addStory, addUser, fakeD1, mockFetch, yerevan } from "./helpers.mjs";

const DICTS = Object.fromEntries(["en", "ru", "hy", "fr"].map((l) =>
  [l, JSON.parse(readFileSync(fileURLToPath(new URL(`../../config/i18n/${l}.json`, import.meta.url)), "utf8"))]));
const read = (p) => readFileSync(fileURLToPath(new URL(`../public/${p}`, import.meta.url)), "utf8");
const TOKEN = "123456:TEST-token-for-unit-tests";
let fetchMock;
afterEach(() => fetchMock?.restore());
const env = (binding) => ({ DB: binding, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: "s".repeat(40),
  OWNER_TELEGRAM_ID: String(OWNER), APP_URL: "https://w.test/app/" });
const nowS = () => Math.floor(Date.now() / 1000);
async function api(binding, path, id, body) {
  const init = await signInitData({ query_id: "q", user: JSON.stringify({ id, first_name: "Nora", language_code: "en" }),
    auth_date: String(nowS()) }, TOKEN);
  const res = await worker.fetch(new Request(`https://w.test${path}`, { method: "POST",
    headers: { authorization: `tma ${init}` }, body: JSON.stringify(body) }), env(binding));
  return { status: res.status, body: await res.json() };
}
const COL = JSON.stringify({ en: "Colombia", ru: "Колумбия", hy: "Կոլումբիա", fr: "Colombie" });

describe("Step 16: no Pause, every topic may be off", () => {
  test("allTopicsOff: no main topic and no custom topic switched on", () => {
    assert.equal(allTopicsOff({ topics: "[]" }, []), true);
    assert.equal(allTopicsOff({ topics: "[]" }, undefined), true);
    assert.equal(allTopicsOff({ topics: '["armenia"]' }, []), false);
    assert.equal(allTopicsOff({ topics: "[]" }, [{ enabled: 1 }]), false);
    assert.equal(allTopicsOff({ topics: "[]" }, [{ enabled: 0 }]), true);
  });

  test("settings: an empty topic list is accepted; paused is not a setting any more; times keep a minimum of 1", () => {
    assert.deepEqual(validatePatch({ topics: [] }, ALL), { topics: [] });
    assert.throws(() => validatePatch({ paused: true }, ALL), (e) => e instanceof SettingsError && e.code === "unknown_setting");
    assert.throws(() => validatePatch({ digest_times: [] }, ALL), (e) => e.code === "keep_time");
  });

  test("cron: a reader with every topic off gets no digest and no quiet note, and moves to the next slot", async () => {
    const { db, sqlite } = fakeD1();
    const now = yerevan(20, 2);
    addUser(sqlite, { id: 5, topics: "[]", next_digest_at: yerevan(20), last_digest_at: yerevan(14) });
    addUser(sqlite, { id: 6, topics: '["politics_conflicts"]', next_digest_at: yerevan(20), last_digest_at: yerevan(14) });
    // 7: main topics off, one custom topic on: still a reader
    addUser(sqlite, { id: 7, topics: "[]", next_digest_at: yerevan(20), last_digest_at: yerevan(14) });
    // 8: main topics off, the custom topic switched off: all off
    addUser(sqlite, { id: 8, topics: "[]", next_digest_at: yerevan(20), last_digest_at: yerevan(14) });
    sqlite.prepare("INSERT INTO custom_topics (id, tag, names, emoji, definition, queries, boost_max, created_at) VALUES (1, 'c1', ?, '🇨🇴', 'd', '[]', 2, 1)").run(COL);
    sqlite.prepare("INSERT INTO custom_follows (user_id, topic_id, at, enabled) VALUES (7, 1, 1, 1), (8, 1, 1, 0)").run();
    addStory(sqlite, "Big news", ["politics_conflicts"], 9, now - 600, { final_score: 8, main_topic: "politics_conflicts", headline: "Big news" });
    const outbox = [];
    const out = await runTick(db, { send: async (id, text) => { outbox.push({ id, text }); }, alert: async () => {} }, now, {}, { ...CONFIG, max_users_per_tick: 8 });
    assert.deepEqual(outbox.map((m) => m.id).sort(), [6, 7]);
    assert.equal(out.all_off, 2);
    const row = (id) => sqlite.prepare("SELECT next_digest_at, last_digest_at FROM users WHERE id = ?").get(id);
    for (const id of [5, 8]) {
      assert.ok(row(id).next_digest_at > now, `user ${id} moves to the next slot`);
      assert.equal(row(id).last_digest_at, yerevan(14), `user ${id}: nothing was sent`);
    }
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sent WHERE user_id IN (5, 8)").get().n, 0);
  });

  test("the sample digest after the setup sends nothing when every topic is off", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: 300, topics: "[]", onboarded_at: null });
    addStory(sqlite, "Big news", ["politics_conflicts"], 9, nowS() - 600, { final_score: 8, main_topic: "politics_conflicts", headline: "Big news" });
    fetchMock = mockFetch((url) => (url.includes("api.telegram.org") ? { status: 200, body: { ok: true, result: {} } } : undefined));
    const r = await api(binding, "/api/onboard", 300, { skipped: false });
    assert.equal(r.status, 200);
    assert.equal(fetchMock.calls.filter((c) => /\/send(Message|RichMessage)$/.test(c.url)).length, 0);
  });

  test("migration: a paused reader keeps their topics but all switched off, and is no longer paused", () => {
    const { sqlite } = fakeD1();
    addUser(sqlite, { id: 5, paused: 1 });
    addUser(sqlite, { id: 6 });
    sqlite.prepare("INSERT INTO custom_topics (id, tag, names, emoji, definition, queries, boost_max, created_at) VALUES (1, 'c1', ?, '🇨🇴', 'd', '[]', 2, 1)").run(COL);
    sqlite.prepare("INSERT INTO custom_follows (user_id, topic_id, at, enabled) VALUES (5, 1, 1, 1), (6, 1, 1, 1)").run();
    for (const s of pauseStatements(5)) sqlite.prepare(s.sql).run(...s.params);
    const u = sqlite.prepare("SELECT topics, paused FROM users WHERE id = 5").get();
    assert.deepEqual([u.topics, u.paused], ["[]", 0]);
    assert.equal(sqlite.prepare("SELECT enabled FROM custom_follows WHERE user_id = 5").get().enabled, 0);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM custom_follows WHERE user_id = 5").get().n, 1, "the topic stays in the list");
    assert.equal(sqlite.prepare("SELECT enabled FROM custom_follows WHERE user_id = 6").get().enabled, 1, "others untouched");
    assert.equal(sqlite.prepare("SELECT topics FROM users WHERE id = 6").get().topics, JSON.stringify(ALL));
  });
});

describe("Step 16: digest length (main topics bar 7, custom topics keep 6)", () => {
  const st = (main, final, topic, tags = [main]) => ({ topics: JSON.stringify(tags), final_score: final, topic_score: topic, main_topic: main, importance: 5 });
  test("config: topic_bar 7, custom_topic_bar 6, editorial bar 7", () => {
    assert.deepEqual([CONFIG.editorial_bar, CONFIG.topic_bar, CONFIG.custom_topic_bar], [7, 7, 6]);
  });
  test("a main topic needs a topic score of 7 (and a boost); a custom topic still 6", () => {
    assert.equal(qualifies(st("armenia", 5, 7), ["armenia"]), true);
    assert.equal(qualifies(st("armenia", 4, 6), ["armenia"]), false, "routine Armenia news at 6 no longer goes out");
    assert.equal(qualifies(st("armenia", 4, 8), ["armenia"]), false, "capped at +2: 6");
    assert.equal(qualifies(st("ukraine_war", 6, 7), ["ukraine_war"]), true);
    assert.equal(qualifies(st("c1", 2, 6), ["c1"]), true, "custom topics keep the owner's bar of 6");
    assert.equal(qualifies(st("c1", 2, 5), ["c1"]), false);
    assert.equal(qualifies(st("politics_conflicts", 7, 7), ["politics_conflicts"]), true, "the editorial bar is unchanged");
  });
  test("the candidate SQL agrees: main 6 out, main 7 in, custom 6 in", async () => {
    const { db, sqlite } = fakeD1();
    const now = yerevan(20, 2);
    addUser(sqlite, { id: 5, topics: '["armenia","c1"]', last_digest_at: yerevan(14) });
    const a6 = addStory(sqlite, "a6", ["armenia"], 6, now - 600, { final_score: 4, topic_score: 6, main_topic: "armenia", headline: "a6" });
    const a7 = addStory(sqlite, "a7", ["armenia"], 6, now - 600, { final_score: 5, topic_score: 7, main_topic: "armenia", headline: "a7" });
    const c6 = addStory(sqlite, "c6", ["c1"], 6, now - 600, { final_score: 2, topic_score: 6, main_topic: "c1", headline: "c6" });
    const [rows] = await db.batch([candidateStatement({ id: 5, topics: '["armenia","c1"]', last_digest_at: yerevan(14) }, now)]);
    const ids = new Set(rows.map((r) => r.id));
    assert.deepEqual([ids.has(a6), ids.has(a7), ids.has(c6)], [false, true, true]);
  });
});

describe("Step 16: the Mini App", () => {
  const js = read("app/app.js"), css = read("app/app.css");
  test("no Pause row, switch or text left", () => {
    assert.doesNotMatch(js, /data-action="pause"|togglePause|pauseHTML|hero_paused/);
    for (const l of Object.keys(DICTS)) {
      assert.equal(DICTS[l].app.pause, undefined, l);
      assert.equal(DICTS[l].app.help_pause, undefined, l);
      assert.equal(DICTS[l].bot.help_paused, undefined, l);
    }
  });
  test("no 'keep at least one topic' rule in the app", () => {
    assert.doesNotMatch(js, /keep_topic/);
    for (const l of Object.keys(DICTS)) assert.equal(DICTS[l].errors.keep_topic, undefined, l);
  });
  test("all off: the Next digest card shows the sleeping card", () => {
    assert.match(js, /if \(allOff\(\)\)[\s\S]{0,200}😴[\s\S]{0,200}app\.all_off[\s\S]{0,120}app\.all_off_hint/);
  });
  test("setup: Language is the first step while more than one language is on", () => {
    assert.match(js, /hasLangs\(\) \? \["lang", "topics", "times", "done"\]/);
    assert.match(js, /kind === "lang"\) return sec\(head, langGrid\(\)/);
    for (const l of Object.keys(DICTS)) {
      assert.ok(DICTS[l].app.setup_lang, l);
      assert.match(DICTS[l].app.setup_step, /\{n\}.*\{of\}/, l);
    }
  });
  test("Help and Send feedback squares are brand red with a white glyph", () => {
    assert.match(js, /navRow\("open-help", I\.help, "red"/);
    assert.match(js, /navRow\("open-feedback", I\.chat, "red"/);
    assert.match(css, /\.sq\.solid\.red \{ background: var\(--accent\); \}/);
    assert.match(css, /\.sq\.solid \{[^}]*color: #fff/);
    assert.doesNotMatch(css, /\.sq\.solid\.(blue|green)/);
  });
  test("one hint line under Add a topic, in every language", () => {
    assert.match(js, /id="topic-hint">\$\{esc\(tr\("app\.add_topic_hint"\)\)\}/);
    for (const l of Object.keys(DICTS)) assert.match(DICTS[l].app.add_topic_hint, /1/, l);
  });
});

describe("Step 16: texts are short, one idea a line, with emojis", () => {
  const HELP = ["what", "stories", "topics", "times", "lang", "support", "feedback", "privacy"];
  const EMOJI = /^\p{Extended_Pictographic}/u;
  for (const l of ["en", "ru", "hy", "fr"]) {
    test(`${l}: each Help section is an emoji title and 2 to 4 short lines`, () => {
      for (const k of HELP) {
        const h = DICTS[l].app[`help_${k}_h`], body = DICTS[l].app[`help_${k}`];
        assert.match(h, EMOJI, `${l} ${k} title`);
        const lines = body.split("\n");
        assert.ok(lines.length >= 2 && lines.length <= 4, `${l} ${k}: ${lines.length} lines`);
        for (const line of lines) assert.ok(line.length <= 40, `${l} ${k}: "${line}" is long (one line on a 360 px phone)`);
      }
    });
    test(`${l}: bot replies are written one idea per line, each line short and starting with an emoji`, () => {
      for (const k of ["welcome_setup", "reminder", "help", "help_new", "help_cmd", "settings", "support", "tip_thanks", "paysupport_sent"]) {
        const lines = DICTS[l].bot[k].split("\n");
        assert.ok(lines.length >= 2, `${l} bot.${k} has one line`);
        assert.match(lines[0], EMOJI, `${l} bot.${k}`);
        // Step 17b: 90, the owner's approved English welcome has an 83-character line
        for (const line of lines) assert.ok(line.length <= 90, `${l} bot.${k}: "${line}" is long`);
      }
    });
    test(`${l}: no em or en dash in any string`, () => {
      assert.doesNotMatch(JSON.stringify(DICTS[l]), /[–—]/);
    });
  }
  test("Russian keeps сводка and на Украине", () => {
    const s = JSON.stringify({ ...DICTS.ru, _comment: "" });
    assert.doesNotMatch(s, /дайджест/i);
    assert.doesNotMatch(s, /(^|[^\p{L}])во? Украин/u);
    assert.match(DICTS.ru.app.help_what, /сводка/);
  });
});

describe("Step 16: fixed-offset zones need no Intl (about 10 ms of CPU in a fresh Worker)", () => {
  test("every fixed zone matches Intl every 6 hours over two years (no daylight saving hides in the list)", () => {
    const start = Date.UTC(2026, 0, 1) / 1000;
    for (const tz of Object.keys(FIXED_OFFSETS)) {
      const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit",
        day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      for (let ts = start; ts < start + 2 * 365 * 86400; ts += 6 * 3600) {
        const p = {};
        for (const { type, value } of f.formatToParts(new Date(ts * 1000))) p[type] = value;
        const want = { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second };
        assert.deepEqual(localParts(ts, tz), want, `${tz} at ${new Date(ts * 1000).toISOString()}`);
      }
    }
  });
  test("a Yerevan reader's next slot and a zone check use no Intl at all; other zones still work", () => {
    const real = Intl.DateTimeFormat;
    let calls = 0;
    Intl.DateTimeFormat = function (...a) { calls++; return new real(...a); };
    try {
      const now = Date.UTC(2026, 10, 18, 9, 0) / 1000;   // 13:00 in Yerevan
      assert.equal(nextSlot(now, "Asia/Yerevan", ["09:00", "14:00", "20:00"]), Date.UTC(2026, 10, 18, 10, 0) / 1000);
      assert.equal(validZone("Asia/Yerevan"), true);
      assert.equal(calls, 0);
      assert.equal(validZone("toString"), false, "only real table entries, never the object's own methods");
      assert.equal(nextSlot(now, "Europe/Paris", ["14:00"]), Date.UTC(2026, 10, 18, 13, 0) / 1000);
      assert.ok(calls > 0, "a zone with daylight saving still goes through Intl");
    } finally {
      Intl.DateTimeFormat = real;
    }
  });
});
