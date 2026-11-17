// Step 15: Help and Send feedback (Settings), /help, and Admin's "Recent feedback".
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { signInitData } from "../src/auth.js";
import { DICTS, t } from "../src/i18n.js";
import { FEEDBACK, cleanFeedback, ownerMessage } from "../src/feedback.js";
import { OWNER, addUser, fakeD1, mockFetch } from "./helpers.mjs";

const TOKEN = "123456:TEST-token-for-unit-tests";
const SECRET = "s".repeat(40);
const FRIEND = 777;
let fetchMock;
afterEach(() => fetchMock?.restore());

const env = (binding) => ({ DB: binding, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET,
  OWNER_TELEGRAM_ID: String(OWNER), APP_URL: "https://w.test/app/" });
const nowS = () => Math.floor(Date.now() / 1000);
const initFor = (id, lang = "en") => signInitData({ query_id: "q", user: JSON.stringify({ id, first_name: "Ann", language_code: lang }),
  auth_date: String(nowS()) }, TOKEN);
async function api(binding, path, id, body) {
  const res = await worker.fetch(new Request(`https://w.test${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `tma ${await initFor(id)}` }, body: body === undefined ? undefined : JSON.stringify(body) }), env(binding));
  return { status: res.status, body: await res.json() };
}
const hook = (binding, update) => worker.fetch(new Request("https://w.test/telegram", {
  method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify({ update_id: 1, ...update }) }), env(binding));
const msg = (text, id = FRIEND, lang = "en") => ({ message: { message_id: 5, from: { id, first_name: "Ann", language_code: lang },
  chat: { id, type: "private" }, text } });
const telegram = () => mockFetch(() => ({ status: 200, body: { ok: true, result: { message_id: 1 } } }));
const rows = (sqlite) => sqlite.prepare("SELECT user_id, text, forwarded FROM feedback ORDER BY id").all().map((r) => ({ ...r }));

describe("Step 15: Send feedback", () => {
  test("stored and forwarded to the owner with the reader's first name and id, HTML escaped", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: FRIEND, first_name: "Ani <3" });
    fetchMock = telegram();
    const r = await api(binding, "/api/feedback", FRIEND, { text: "  Love it! But <b>more</b> Armenia please.\r\n\r\n\r\nThanks  " });
    assert.deepEqual([r.status, r.body.ok], [200, true]);
    assert.deepEqual(rows(sqlite), [{ user_id: FRIEND, text: "Love it! But <b>more</b> Armenia please.\n\nThanks", forwarded: 1 }]);
    const send = fetchMock.calls.find((c) => c.url.endsWith("/sendMessage"));
    assert.equal(send.body.chat_id, OWNER);
    assert.match(send.body.text, /^💬 <b>Feedback from Ani &lt;3<\/b> \(id 777\)\n\nLove it! But &lt;b&gt;more&lt;\/b&gt; Armenia please\./);
  });

  test("at most 10 in 24 hours per reader; another reader is not affected", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: FRIEND });
    addUser(sqlite, { id: 778 });
    fetchMock = telegram();
    for (let i = 0; i < FEEDBACK.per_day; i++) assert.equal((await api(binding, "/api/feedback", FRIEND, { text: `note ${i}` })).status, 200);
    const r = await api(binding, "/api/feedback", FRIEND, { text: "one more" });
    assert.deepEqual([r.status, r.body.code], [400, "feedback_limit"]);
    assert.equal(r.body.error, "Up to 10 messages a day. Try again tomorrow.");
    assert.equal((await api(binding, "/api/feedback", 778, { text: "hi" })).status, 200);
    // a day later it works again
    sqlite.prepare("UPDATE feedback SET at = at - 86401 WHERE user_id = ?").run(FRIEND);
    assert.equal((await api(binding, "/api/feedback", FRIEND, { text: "next day" })).status, 200);
  });

  test("1,000 characters at most (counted as a reader counts, Armenian too); empty is refused", async () => {
    assert.equal(cleanFeedback("ա".repeat(1000)).length, 1000);
    assert.throws(() => cleanFeedback("a".repeat(1001)), (e) => e.code === "feedback_long");
    assert.throws(() => cleanFeedback("   \n "), (e) => e.code === "feedback_empty");
    assert.throws(() => cleanFeedback(42), (e) => e.code === "feedback_empty");
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: FRIEND });
    fetchMock = telegram();
    const r = await api(binding, "/api/feedback", FRIEND, { text: "😀".repeat(1001) });
    assert.deepEqual([r.status, r.body.code], [400, "feedback_long"]);
    assert.equal(rows(sqlite).length, 0);
  });

  test("a failed forward still stores it (forwarded 0) and thanks the reader", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: FRIEND });
    fetchMock = mockFetch(() => ({ status: 500, body: { ok: false, description: "down" } }));
    const r = await api(binding, "/api/feedback", FRIEND, { text: "hello" });
    assert.equal(r.status, 200);
    assert.deepEqual(rows(sqlite), [{ user_id: FRIEND, text: "hello", forwarded: 0 }]);
  });

  test("Admin shows the latest feedback to the owner only", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: OWNER });
    addUser(sqlite, { id: FRIEND, first_name: "Ani", lang: "ru" });
    fetchMock = telegram();
    await api(binding, "/api/feedback", FRIEND, { text: "Спасибо" });
    assert.equal((await api(binding, "/api/admin", FRIEND)).status, 403);
    const a = await api(binding, "/api/admin", OWNER);
    assert.equal(a.status, 200);
    assert.equal(a.body.feedback.total, 1);
    assert.deepEqual(Object.fromEntries(Object.entries(a.body.feedback.recent[0]).filter(([k]) => ["name", "lang", "text", "forwarded"].includes(k))),
      { text: "Спасибо", forwarded: true, name: "Ani", lang: "ru" });
    assert.ok(a.body.tips && a.body.custom, "the other Admin blocks are still there");
  });

  test("the owner message has no dash and names the reader", () => {
    const m = ownerMessage({ first_name: "Ani" }, { id: 5 }, "x");
    assert.ok(!/[–—]/.test(m) && m.includes("Ani") && m.includes("id 5"));
  });
});

describe("Step 15: Help", () => {
  const KEYS = ["what", "stories", "topics", "times", "lang", "support", "feedback", "privacy"];
  test("every help section and the feedback texts exist in every language, short, no dash", () => {
    for (const lang of ["en", "ru", "hy", "fr"]) {
      for (const k of KEYS) {
        for (const key of [`app.help_${k}_h`, `app.help_${k}`]) {
          const v = DICTS[lang].app[key.slice(4)];
          assert.ok(typeof v === "string" && v.length > 2, `${lang} ${key}`);
          assert.ok(!/[–—]/.test(v), `${lang} ${key}: dash`);
          assert.ok(v.length < 330, `${lang} ${key}: brief`);
        }
      }
      for (const key of ["help", "feedback", "feedback_send", "feedback_thanks", "feedback_placeholder"]) assert.ok(DICTS[lang].app[key], `${lang} ${key}`);
      for (const key of ["feedback_empty", "feedback_long", "feedback_limit"]) assert.ok(DICTS[lang].errors[key], `${lang} ${key}`);
    }
    assert.match(t("en", "app.help_privacy"), /Telegram id and name.*settings.*AI checks.*Nothing is sold or shared/s);
    assert.match(t("ru", "app.help_privacy"), /[Нн]ичего не продаём/);
    assert.ok(!/дайджест/i.test(KEYS.map((k) => t("ru", `app.help_${k}`)).join(" ")), "сводка, never дайджест");
    assert.match(t("ru", "app.help_what"), /сводка/);
  });

  test("/help points to Settings with the Settings button, in the reader's language", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: FRIEND, lang: "ru" });
    fetchMock = telegram();
    const r = await hook(binding, msg("/help", FRIEND, "ru"));
    assert.equal(r.status, 200);
    const send = fetchMock.calls.find((c) => c.url.endsWith("/sendMessage"));
    assert.equal(send.body.text, t("ru", "bot.help_cmd"));
    assert.match(send.body.text, /«Помощь»/);
    assert.equal(send.body.reply_markup.inline_keyboard[0][0].web_app.url, "https://w.test/app/");
  });

  test("the Mini App has the two rows near the bottom of Settings, each opening its own page with the back button", () => {
    const js = readFileSync(new URL("../public/app/app.js", import.meta.url), "utf8");
    assert.match(js, /\$\{supportHTML\(\)\}\s*\$\{moreHTML\(\)\}\s*<p class="tzline/);
    assert.match(js, /tg\.BackButton\.onClick\(onBack\); tg\.BackButton\.show\(\)/);
    assert.match(js, /tg\.BackButton\.offClick\(onBack\); tg\.BackButton\.hide\(\)/);
    assert.match(js, /haptic\("success"\);\s*closePage\(\);\s*toast\(tr\("app\.feedback_thanks"\)/);
  });
});
