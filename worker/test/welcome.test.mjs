// Step 15: the welcome flow (new vs returning vs imported, the setup, the sample digest, the one
// reminder) and the owner's announcement tool (translation, checks, preview, batches, never twice).
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { signInitData } from "../src/auth.js";
import { runTick } from "../src/cron.js";
import { t } from "../src/i18n.js";
import { REMINDER, needsSetup, onboard, reminderText, runReminders, reminderStatement } from "../src/onboard.js";
import { ANNOUNCE, activeStatement, audienceLangs, cleanText, draftAnnouncement, previewAnnouncement, runAnnouncementBatch,
  startAnnouncement, versionProblem } from "../src/announce.js";
import { OWNER, addStory, addUser, fakeD1, mockFetch, yerevan } from "./helpers.mjs";

const TOKEN = "123456:TEST-token-for-unit-tests";
const SECRET = "s".repeat(40);
let fetchMock;
afterEach(() => fetchMock?.restore());
const env = (binding) => ({ DB: binding, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET,
  OWNER_TELEGRAM_ID: String(OWNER), APP_URL: "https://w.test/app/", GEMINI_API_KEY: "k" });
const nowS = () => Math.floor(Date.now() / 1000);
const initFor = (id, lang = "en", name = "Nora") => signInitData({ query_id: "q", user: JSON.stringify({ id, first_name: name, language_code: lang }),
  auth_date: String(nowS()) }, TOKEN);
async function api(binding, path, id, body, lang = "en") {
  const res = await worker.fetch(new Request(`https://w.test${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `tma ${await initFor(id, lang)}` }, body: body === undefined ? undefined : JSON.stringify(body) }), env(binding));
  return { status: res.status, body: await res.json() };
}
const hook = (binding, text, id, lang = "en") => worker.fetch(new Request("https://w.test/telegram", {
  method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET },
  body: JSON.stringify({ update_id: 1, message: { message_id: 5, from: { id, first_name: "Nora", language_code: lang }, chat: { id, type: "private" }, text } }) }), env(binding));
const telegram = () => mockFetch((url) => (url.includes("api.telegram.org") ? { status: 200, body: { ok: true, result: { message_id: 1 } } } : undefined));
const sends = () => fetchMock.calls.filter((c) => /\/send(Message|RichMessage|Animation)$/.test(c.url));
const userRow = (sqlite, id) => ({ ...sqlite.prepare("SELECT * FROM users WHERE id = ?").get(id) });
const NEW = 300;

describe("Step 15: welcome, new vs returning vs imported", () => {
  test("a new user: short welcome in their Telegram language with Set up; the setup shows on the first open", async () => {
    const { binding, sqlite } = fakeD1();
    fetchMock = telegram();
    await hook(binding, "/start", NEW, "ru");
    const m = sends()[0].body;
    // Step 17b: one message, the logo animation with the welcome as its HTML caption and the button
    assert.match(sends()[0].url, /\/sendAnimation$/);
    assert.equal(m.animation, "https://w.test/media/welcome.mp4?v=19");
    assert.equal(m.duration, 11);
    assert.equal(m.caption, t("ru", "bot.welcome_setup"));
    assert.equal(m.parse_mode, "HTML");
    assert.equal(m.reply_markup.inline_keyboard[0][0].text, "⚙️ Настроить");
    assert.equal(userRow(sqlite, NEW).opened_at, null);
    const r = await api(binding, "/api/open", NEW, { tz: "Asia/Yerevan" }, "ru");
    assert.equal(r.body.setup, true);
    assert.ok(userRow(sqlite, NEW).opened_at > 0, "the first open is recorded");
  });

  test("a returning, onboarded user: welcome back, no setup", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: NEW, first_name: "Nora" });
    fetchMock = telegram();
    await hook(binding, "/start", NEW);
    assert.match(sends()[0].body.text, /^👋 Welcome back, Nora\./);
    assert.equal((await api(binding, "/api/open", NEW, {})).body.setup, false);
  });

  test("an imported user from the old bot: no welcome, no setup, no reminder", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: NEW, first_name: "Nora", imported: 1, onboarded_at: null, opened_at: null, created_at: 1 });
    fetchMock = telegram();
    await hook(binding, "/start", NEW);
    assert.match(sends()[0].body.text, /^👋 Welcome back, Nora\./);
    assert.notEqual(sends()[0].body.reply_markup.inline_keyboard[0][0].text, "⚙️ Set up");
    assert.equal(needsSetup(userRow(sqlite, NEW)), false);
    const [due] = await (fakeD1Like(binding)).batch([reminderStatement(yerevan(12, 0, 20))]);
    assert.equal(due.length, 0);
  });

  test("/start again before the setup is done: the Set up welcome again", async () => {
    const { binding } = fakeD1();
    fetchMock = telegram();
    await hook(binding, "/start", NEW);
    await hook(binding, "/start", NEW);
    assert.equal(sends()[1].body.reply_markup.inline_keyboard[0][0].text, "⚙️ Set up");
  });

  test("Step 17b: if Telegram refuses the animation, the same welcome goes as text, and the failure is logged", async () => {
    const { binding, sqlite } = fakeD1();
    fetchMock = mockFetch((url) => (url.endsWith("/sendAnimation") ? { status: 400, body: { ok: false, description: "Bad Request: wrong file" } }
      : url.includes("api.telegram.org") ? { status: 200, body: { ok: true, result: { message_id: 1 } } } : undefined));
    await hook(binding, "/start", NEW);
    const [anim, text] = sends();
    assert.match(anim.url, /\/sendAnimation$/);
    assert.match(text.url, /\/sendMessage$/);
    assert.equal(text.body.text, t("en", "bot.welcome_setup"));
    assert.equal(text.body.parse_mode, "HTML");
    assert.equal(text.body.reply_markup.inline_keyboard[0][0].text, "⚙️ Set up");
    assert.match(sqlite.prepare("SELECT message FROM errors").all().map((r) => r.message).join(), /welcome animation for 300: Telegram sendAnimation HTTP 400/);
  });

  test("Step 17b: a reader who blocked the bot gets no second try", async () => {
    const { binding } = fakeD1();
    fetchMock = mockFetch((url) => (url.endsWith("/sendAnimation") ? { status: 403, body: { ok: false, description: "Forbidden: bot was blocked by the user" } }
      : url.includes("api.telegram.org") ? { status: 200, body: { ok: true, result: { message_id: 1 } } } : undefined));
    await hook(binding, "/start", NEW);
    assert.deepEqual(sends().map((c) => c.url.split("/").pop()), ["sendAnimation"]);
  });
});

// a db over the same binding (the reminder statement is plain SQL)
function fakeD1Like(binding) {
  return { batch: async (list) => (await binding.batch(list.map((s) => ({ sql: s.sql, params: s.params })))).map((r) => r.results) };
}

describe("Step 15: the setup and the sample digest", () => {
  test("Done sends ONE sample digest of the last 24 h, labelled, marked sent; a second call sends nothing; never repeated", async () => {
    const { binding, sqlite } = fakeD1();
    const now = nowS();
    const a = addStory(sqlite, "Armenia and Turkey open the border", ["armenia"], 9, now - 3600, { final_score: 8, main_topic: "armenia", headline: "Armenia and Turkey open the border" });
    addStory(sqlite, "Old news", ["armenia"], 9, now - 30 * 3600, { final_score: 8, main_topic: "armenia", headline: "Old news" });
    fetchMock = telegram();
    await api(binding, "/api/open", NEW, {});
    const r = await api(binding, "/api/onboard", NEW, { skipped: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.setup, false);
    assert.deepEqual([r.body.sample.sample, r.body.sample.stories], [true, 1]);
    const digest = sends().filter((c) => c.body.chat_id === NEW);
    assert.equal(digest.length, 1);
    const html = digest[0].body.rich_message?.html ?? digest[0].body.text;
    // Step 17 (owner): no label; the greeting says what it is
    assert.match(html, /^<p><b>Good (morning|afternoon|evening), Nora<\/b> · here is what happened in the last 24 hours<\/p>/);
    assert.doesNotMatch(html, /🧪|Sample/);
    assert.match(html, /Armenia and Turkey open the border/);
    assert.doesNotMatch(html, /Old news/);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sent WHERE user_id = ? AND story_id = ?").get(NEW, a).n, 1);
    // a double tap: nothing more
    const again = await api(binding, "/api/onboard", NEW, { skipped: false });
    assert.equal(again.body.sample.sample, false);
    assert.equal(sends().filter((c) => c.body.chat_id === NEW).length, 1);
    // the next real digest does not repeat it
    const u = userRow(sqlite, NEW);
    sqlite.prepare("UPDATE users SET next_digest_at = ? WHERE id = ?").run(now - 60, NEW);
    const outbox = [];
    await runTick(fakeD1Like2(binding), { send: async (id, text) => { outbox.push({ id, text }); }, alert: async () => {} }, now);
    assert.ok(u.last_digest_at > 0);
    assert.doesNotMatch(outbox.filter((m) => m.id === NEW).map((m) => m.text).join(" "), /Armenia and Turkey open the border/);
  });

  test("Skip also ends the setup (defaults kept) and sends the sample once", async () => {
    const { binding, sqlite } = fakeD1();
    fetchMock = telegram();
    await api(binding, "/api/open", NEW, {});
    const r = await api(binding, "/api/onboard", NEW, { skipped: true });
    assert.equal(r.body.sample.sample, true);
    assert.equal(r.body.sample.skipped, true);
    assert.ok(userRow(sqlite, NEW).onboarded_at > 0);
    assert.equal(JSON.parse(userRow(sqlite, NEW).topics).length, 6, "all six main topics on by default");
    assert.equal(userRow(sqlite, NEW).digest_times, '["09:00","14:00","20:00"]');
  });

  test("an imported user cannot trigger a sample (the claim needs imported = 0)", async () => {
    const { db, sqlite } = fakeD1();
    addUser(sqlite, { id: NEW, imported: 1, onboarded_at: null });
    const out = [];
    const r = await onboard(db, NEW, {}, nowS(), undefined, { send: async (...a) => out.push(a) });
    assert.deepEqual([r.sample, out.length], [false, 0]);
  });
});

function fakeD1Like2(binding) {
  // runTick wants the d1Binding-style db (db.batch returns arrays of rows)
  return fakeD1Like(binding);
}

describe("Step 15: importing the old bot's readers", () => {
  test("new ids get the defaults and the imported flag; an existing user is untouched; nothing is sent", async () => {
    const { importStatements } = await import("../scripts/import-users.mjs");
    const { db, sqlite } = fakeD1();
    addUser(sqlite, { id: 5, topics: '["armenia"]' });
    const topics = sqlite.prepare("SELECT tag, is_default FROM topics ORDER BY sort").all();
    const now = nowS();
    const { statements, skipped } = importStatements([{ id: 5 }, { id: 6, first_name: "Old", lang: "ru" }, { id: 6 }, { id: "x" }, { id: 7 }], topics, now);
    assert.equal(skipped.length, 2);
    const res = await db.batch(statements);
    assert.deepEqual(res.map((r) => r.length), [0, 1, 1]);
    assert.equal(userRow(sqlite, 5).topics, '["armenia"]');
    const six = userRow(sqlite, 6);
    assert.deepEqual([six.imported, six.lang, six.first_name, six.onboarded_at, six.opened_at], [1, "ru", "Old", now, null]);
    assert.equal(JSON.parse(six.topics).length, 6);
    assert.equal(needsSetup(six), false);
    const [due] = await db.batch([reminderStatement(now + 3 * 86400)]);
    assert.ok(!due.some((u) => u.id === 6 || u.id === 7), "no reminder for imported readers");
  });
});

describe("Step 15: exactly one reminder", () => {
  const base = { first_name: "Nora", onboarded_at: null, opened_at: null };
  test("a day after /start, never opened: one reminder with Set up, in their language, between 10:00 and 20:00", async () => {
    const { db, sqlite } = fakeD1();
    addUser(sqlite, { ...base, id: NEW, lang: "ru", created_at: yerevan(6, 0, 13) });
    addUser(sqlite, { ...base, id: 301, created_at: yerevan(9, 0, 13), opened_at: yerevan(9, 30, 13) });   // opened: no reminder
    addUser(sqlite, { ...base, id: 302, created_at: yerevan(9, 0, 13), imported: 1 });                      // imported: none
    addUser(sqlite, { ...base, id: 303, created_at: yerevan(11, 0, 14) });                                  // too new
    addUser(sqlite, { id: 304, created_at: yerevan(9, 0, 13) });                                            // onboarded long ago
    const outbox = [];
    const io = { send: async (id, text, extra) => { outbox.push({ id, text, extra }); }, alert: async () => {}, appUrl: "https://w.test/app/" };
    await runTick(db, io, yerevan(8, 0, 14));   // 26 h after /start, but 08:00: too early
    await runTick(db, io, yerevan(21, 0, 13));  // 15 h: not a day yet
    assert.equal(outbox.filter((m) => m.text.includes("Настроить") || m.text.includes("Set up")).length, 0);
    await runTick(db, io, yerevan(12, 0, 14));
    const rem = outbox.filter((m) => /Нажмите <b>Настроить<\/b>|Tap <b>Set up<\/b>/.test(m.text));
    assert.deepEqual(rem.map((m) => m.id), [NEW]);
    assert.equal(rem[0].text, reminderText({ first_name: "Nora", lang: "ru" }));
    assert.equal(rem[0].text, "👋 Ваша сводка ещё не настроена.\n⚙️ Это займёт около 20 секунд.\n👇 Нажмите <b>Настроить</b>, чтобы начать.");
    assert.equal(rem[0].extra.reply_markup.inline_keyboard[0][0].text, "⚙️ Настроить");
    await runTick(db, io, yerevan(13, 0, 14));
    await runTick(db, io, yerevan(12, 0, 16));
    assert.equal(outbox.filter((m) => /Нажмите <b>Настроить<\/b>/.test(m.text)).length, 1, "never a second one");
  });

  test("the reminder is claimed before it is sent: a failed send is not repeated, two overlapping ticks send once", async () => {
    const { db, sqlite } = fakeD1();
    addUser(sqlite, { ...base, id: NEW, created_at: yerevan(9, 0, 13) });
    const [rows] = await db.batch([reminderStatement(yerevan(12, 0, 14))]);
    let n = 0;
    const failing = { send: async () => { n++; throw new Error("network"); } };
    await runReminders(db, failing, rows, yerevan(12, 0, 14));
    await runReminders(db, failing, rows, yerevan(12, 5, 14));
    assert.equal(n, 1);
    assert.ok(userRow(sqlite, NEW).reminded_at > 0);
    assert.equal(REMINDER.per_tick, 8);
  });
});

describe("Step 17: the sample digest is a taste", () => {
  test("at most 2 stories a topic and 8 in all, best first; the rest is not marked sent", async () => {
    const { binding, sqlite } = fakeD1();
    const now = nowS();
    const topics = ["politics_conflicts", "economy_markets", "tech_ai", "armenia", "iran_war", "ukraine_war"];
    const ids = [];
    for (const [ti, tag] of topics.entries()) {
      for (let k = 0; k < 3; k++) {
        ids.push(addStory(sqlite, `Story ${tag} ${k}`, [tag], 9, now - 3600 - k * 60 - ti,
          { final_score: 9 - k, main_topic: tag, headline: `Story ${tag} ${k}` }));
      }
    }
    fetchMock = telegram();
    await api(binding, "/api/open", NEW, {});
    const r = await api(binding, "/api/onboard", NEW, { skipped: true });
    assert.equal(r.body.sample.stories, 8);
    const html = sends().filter((c) => c.body.chat_id === NEW)[0].body.rich_message?.html;
    for (const tag of topics) assert.ok((html.match(new RegExp(`Story ${tag} \\d`, "g")) ?? []).length <= 2, tag);
    assert.doesNotMatch(html, /Story \w+ 2</, "never the third of a topic");
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sent WHERE user_id = ?").get(NEW).n, 8);
  });

  test("sampleCut keeps the order and the limits from config", async () => {
    const { sampleCut } = await import("../src/digest.js");
    const s = (id, primary) => ({ id, primary });
    const list = [s(1, "a"), s(2, "a"), s(3, "a"), s(4, "b"), s(5, "c"), s(6, "b"), s(7, "b")];
    assert.deepEqual(sampleCut(list, { sample_max_stories: 4, sample_per_topic: 2 }).map((x) => x.id), [1, 2, 4, 5]);
    assert.deepEqual(sampleCut(list, { sample_max_stories: 8, sample_per_topic: 1 }).map((x) => x.id), [1, 4, 5]);
  });
});

describe("Step 15: setup texts and the first open", () => {
  test("the setup and welcome texts in Russian, Armenian and French; no dash anywhere", () => {
    assert.deepEqual(["setup_topics", "setup_times", "setup_done", "setup_next", "setup_back", "setup_skip", "setup_finish"].map((k) => t("ru", `app.${k}`)),
      ["📰 Ваши темы", "🕘 Время сводок", "✅ Всё готово", "Далее", "Назад", "Пропустить", "Готово"]);
    assert.equal(t("ru", "app.setup_step", { n: 2, of: 4 }), "2 из 4");
    assert.equal(t("ru", "bot.setup_button"), "⚙️ Настроить");
    assert.equal(t("ru", "digest.sample_line"), "вот что произошло за последние 24 часа");
    for (const lang of ["en", "ru", "hy", "fr"]) {
      for (const k of ["bot.welcome_setup", "bot.setup_button", "bot.reminder", "digest.sample_line", "app.setup_topics", "app.setup_times",
        "app.setup_done", "app.setup_step", "app.setup_next", "app.setup_back", "app.setup_skip", "app.setup_finish", "app.setup_sample"]) {
        const v = t(lang, k, { name: "X", n: 1, times: "09:00", zone: "Z" });
        assert.ok(v && v !== k && !/[–—]/.test(v), `${lang} ${k}`);
        if (lang !== "en") assert.notEqual(v, t("en", k, { name: "X", n: 1, times: "09:00", zone: "Z" }), `${lang} ${k} is translated`);
      }
    }
  });

  test("the Mini App opens the setup when the server says so, and only then", async () => {
    const { readFileSync } = await import("node:fs");
    const js = readFileSync(new URL("../public/app/app.js", import.meta.url), "utf8");
    // Step 18: the setup starts with every topic off on screen (nothing is saved until a tap)
    assert.ok(js.includes('setLang(S.st.user.lang);\n    if (S.st.setup) { S.page = "setup"; S.step = 1; S.setupTouched = false; S.st.user.topics = []; }'));
    assert.match(js, /await chain;[^\n]*\n\s*const r = await api\("\/api\/onboard", \{ skipped \}\);/);
  });
});

describe("Step 15: announcements", () => {
  const ai = (translations) => mockFetch((url, init, body) => {
    if (url.includes("generativelanguage")) {
      return { status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify({ translations }) }] } }],
        usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 120 } } };
    }
    return { status: 200, body: { ok: true, result: { message_id: 1 } } };
  });

  test("checks on every version: no dash, same numbers, alphabet, сводка, на Украине", () => {
    assert.equal(cleanText("New topics — Economy & Markets– more"), "New topics, Economy & Markets- more");
    assert.equal(versionProblem("ru", "Новые темы с 5 декабря", "New topics from 5 December"), null);
    assert.equal(versionProblem("ru", "Новые темы с 6 декабря", "New topics from 5 December"), "the numbers differ from the English");
    assert.equal(versionProblem("ru", "New topics", "New topics"), "wrong alphabet");
    assert.equal(versionProblem("ru", "Новый дайджест", "New digest"), "says дайджест, not сводка");
    assert.equal(versionProblem("ru", "Новости в Украине", "News"), "says в Украине, not на Украине");
    assert.equal(versionProblem("hy", "Նոր թեմաներ", "New topics"), null);
    assert.equal(versionProblem("fr", "Nouveaux sujets — bien", "New topics"), "has an em or en dash");
    assert.deepEqual(audienceLangs([{ lang: "ru" }, { lang: "en" }, { lang: "xx" }], "all").sort(), ["en", "ru"]);
    assert.deepEqual(audienceLangs([{ lang: "ru" }], "ru"), ["en", "ru"]);
  });

  test("draft: one AI call for every language users read, logged; a bad version is left for the owner with a note", async () => {
    const { db, sqlite } = fakeD1();
    addUser(sqlite, { id: OWNER, lang: "en" });
    addUser(sqlite, { id: 2, lang: "ru" });
    fetchMock = ai({ ru: "Новое: тема «Экономика и рынки» — с 5 декабря." });
    const r = await draftAnnouncement(db, env({}), { text: "New: Economy & Markets from 5 December.", audience: "all" }, nowS());
    assert.equal(fetchMock.calls.filter((c) => c.url.includes("generativelanguage")).length, 1);
    assert.equal(r.texts.ru, "Новое: тема «Экономика и рынки», с 5 декабря.", "the dash is replaced");
    assert.deepEqual(r.notes, {});
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM ai_calls WHERE kind = 'announce_translate'").get().n, 1);
    fetchMock.restore();
    fetchMock = ai({ ru: "Новое с 6 декабря." });
    const bad = await draftAnnouncement(db, env({}), { text: "New from 5 December.", audience: "all" }, nowS());
    assert.equal(bad.texts.ru, "");
    assert.equal(bad.notes.ru, "the numbers differ from the English");
  });

  test("preview goes to the owner only; send needs a preview of exactly that text; batches across ticks; never twice", async () => {
    const { db, sqlite } = fakeD1();
    addUser(sqlite, { id: OWNER, lang: "en" });
    for (let i = 1; i <= 5; i++) addUser(sqlite, { id: 1000 + i, lang: i % 2 ? "ru" : "en" });
    addUser(sqlite, { id: 2000, lang: "ru", blocked: 1 });
    fetchMock = ai({ ru: "Привет! Новые темы." });
    const d = await draftAnnouncement(db, env({}), { text: "Hello! New topics.", audience: "all" }, nowS());
    assert.equal((await startAnnouncement(db, { id: d.id }, nowS())).error, "Send yourself a preview first.");
    const owner = [];
    const io = { send: async (id, text) => { owner.push({ id, text }); } };
    const p = await previewAnnouncement(db, { id: d.id, texts: { en: "Hello! New topics.", ru: "Привет! Новые темы." } }, nowS(), io, OWNER);
    assert.equal(p.previews, 2);
    assert.ok(owner.every((m) => m.id === OWNER) && /Announcement preview \(Russian\)/.test(owner[1].text));
    assert.equal((await startAnnouncement(db, { id: d.id, texts: { en: "Hello! Changed.", ru: "Привет! Новые темы." } }, nowS())).error,
      "The text changed after the preview. Send yourself a preview again.");
    assert.equal((await startAnnouncement(db, { id: d.id }, nowS())).status, "sending");
    const got = [];
    const out = { send: async (id, text) => { got.push({ id, text }); }, alert: async () => {} };
    let [act] = await db.batch([activeStatement()]);
    assert.deepEqual(await runAnnouncementBatch(db, out, act, nowS(), 4), { sent: 4, failed: 0, done: false });
    [act] = await db.batch([activeStatement()]);
    assert.deepEqual(await runAnnouncementBatch(db, out, act, nowS(), 4), { sent: 2, failed: 0, done: false });
    [act] = await db.batch([activeStatement()]);
    assert.deepEqual(await runAnnouncementBatch(db, out, act, nowS(), 4), { sent: 0, failed: 0, done: true });
    assert.equal(got.length, 6, "the owner and five users, not the blocked one");
    assert.equal(new Set(got.map((m) => m.id)).size, 6, "never twice");
    assert.equal(got.find((m) => m.id === 1001).text, "Привет! Новые темы.");
    assert.equal(got.find((m) => m.id === 1002).text, "Hello! New topics.");
    assert.equal(sqlite.prepare("SELECT status FROM announcements WHERE id = ?").get(d.id).status, "done");
    // a retried tick after done sends nothing
    [act] = await db.batch([activeStatement()]);
    assert.deepEqual(await runAnnouncementBatch(db, out, act, nowS(), 4), { sent: 0, failed: 0, done: false });
  });

  test("two overlapping ticks never send twice: only the tick that claimed a user sends to them", async () => {
    const { db, sqlite } = fakeD1();
    addUser(sqlite, { id: OWNER, lang: "en" });
    for (let i = 1; i <= 4; i++) addUser(sqlite, { id: 1000 + i, lang: "en" });
    sqlite.prepare("INSERT INTO announcements (id, created_at, status, audience, texts) VALUES (1, 1, 'sending', 'all', ?)").run(JSON.stringify({ en: "Hi" }));
    const got = [];
    const io = { send: async (id) => { got.push(id); } };
    const [act] = await db.batch([activeStatement()]);
    await Promise.all([runAnnouncementBatch(db, io, act, nowS()), runAnnouncementBatch(db, io, act, nowS())]);
    assert.equal(got.length, 5);
    assert.equal(new Set(got).size, 5, "each user once");
  });

  test("a crash after the claim never resends: the user's row exists, the next tick skips them", async () => {
    const { db, sqlite } = fakeD1();
    addUser(sqlite, { id: OWNER, lang: "en" });
    addUser(sqlite, { id: 1001, lang: "en" });
    sqlite.prepare("INSERT INTO announcements (id, created_at, status, audience, texts) VALUES (1, 1, 'sending', 'all', ?)").run(JSON.stringify({ en: "Hi" }));
    sqlite.prepare("INSERT INTO announcement_sends (announcement_id, user_id, at, ok) VALUES (1, 1001, 1, NULL)").run();   // claimed, then the tick died
    const got = [];
    const [act] = await db.batch([activeStatement()]);
    await runAnnouncementBatch(db, { send: async (id) => { got.push(id); } }, act, nowS());
    assert.deepEqual(got, [OWNER]);
  });

  test("one language only: only those readers; a 403 marks the user blocked; the cron runs it", async () => {
    const { db, sqlite } = fakeD1();
    addUser(sqlite, { id: OWNER, lang: "en" });
    addUser(sqlite, { id: 1001, lang: "ru" });
    addUser(sqlite, { id: 1002, lang: "ru" });
    sqlite.prepare("INSERT INTO announcements (id, created_at, status, audience, texts) VALUES (1, 1, 'sending', 'ru', ?)")
      .run(JSON.stringify({ en: "Hi", ru: "Привет" }));
    const got = [];
    const io = { send: async (id, text) => { if (id === 1002) throw Object.assign(new Error("blocked"), { status: 403 }); got.push({ id, text }); },
      alert: async () => {}, appUrl: "https://w.test/app/" };
    const out = await runTick(db, io, yerevan(3, 0, 20));
    assert.deepEqual(got, [{ id: 1001, text: "Привет" }]);
    assert.deepEqual(out.announcement, { sent: 1, failed: 1, done: false });
    assert.equal(userRow(sqlite, 1002).blocked, 1);
    assert.equal(ANNOUNCE.per_tick, 25);
  });

  test("Admin: owner only; draft, preview and send through the API", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: OWNER, lang: "en" });
    addUser(sqlite, { id: 1001, lang: "ru" });
    fetchMock = ai({ ru: "Привет" });
    assert.equal((await api(binding, "/api/admin/announce", 1001, { action: "draft", text: "Hi", audience: "all" })).status, 403);
    const d = await api(binding, "/api/admin/announce", OWNER, { action: "draft", text: "Hi", audience: "all" });
    assert.equal(d.status, 200);
    const id = d.body.announcement.id;
    const p = await api(binding, "/api/admin/announce", OWNER, { action: "preview", id, texts: { en: "Hi", ru: "Привет" } });
    assert.equal(p.body.message, "Preview sent to you: 2 versions.");
    const s = await api(binding, "/api/admin/announce", OWNER, { action: "send", id });
    assert.equal(s.body.announcement.status, "sending");
    const a = await api(binding, "/api/admin", OWNER);
    assert.equal(a.body.announce.recent[0].status, "sending");
  });
});
