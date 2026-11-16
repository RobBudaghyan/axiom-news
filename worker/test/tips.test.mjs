// Step 10, part B: voluntary tips in Telegram Stars. Invoice creation (Mini App link and /support
// buttons), pre_checkout_query (answered at once, only valid tips accepted; Step 11: 100, 500, 1000 for
// everyone, no test amount), successful_payment stored once (a repeated update does not count twice),
// the thank-you in the user's language, the refund path (owner only, Bot API, marked once), the
// Admin totals, /paysupport and /terms, the command list, and every dictionary key.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { signInitData } from "../src/auth.js";
import { DICTS, FORBIDDEN, commandList, own } from "../src/i18n.js";
import { TIP_AMOUNTS, checkPreCheckout, invoiceFields, shapeTips, tipsStatements } from "../src/tips.js";
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
const from = (id = FRIEND, lang = "en") => ({ id, first_name: id === OWNER ? "Rob" : "Ann", language_code: lang, username: "ann" });
const msg = (extra, id = FRIEND, lang = "en") => ({ message: { message_id: 5, from: from(id, lang), chat: { id, type: "private" }, ...extra } });
const paid = (amount, charge = "ch_1", id = FRIEND, lang = "en") => msg({ successful_payment: { currency: "XTR", total_amount: amount,
  invoice_payload: `tip:${amount}`, telegram_payment_charge_id: charge, provider_payment_charge_id: "" } }, id, lang);
const precheckout = (amount, extra = {}, id = FRIEND) => ({ pre_checkout_query: { id: "pcq1", from: from(id), currency: "XTR",
  total_amount: amount, invoice_payload: `tip:${amount}`, ...extra } });
const telegram = (result = true) => mockFetch(() => ({ status: 200, body: { ok: true, result } }));
const methodOf = (c) => c.url.split("/").pop();
const tipRows = (sqlite) => sqlite.prepare("SELECT user_id, amount, charge_id, refunded_at FROM tips ORDER BY id").all().map((r) => ({ ...r }));

describe("invoices", () => {
  test("the Mini App gets a Stars invoice link: XTR, empty provider token, one price, the amount in the payload", async () => {
    const { binding } = fakeD1();
    fetchMock = telegram("https://t.me/$invoice123");
    const r = await api(binding, "/api/tip", FRIEND, { amount: 100, lang: "ru" });
    assert.equal(r.status, 200);
    assert.equal(r.body.link, "https://t.me/$invoice123");
    const c = fetchMock.calls[0];
    assert.equal(methodOf(c), "createInvoiceLink");
    assert.equal(c.body.currency, "XTR");
    assert.equal(c.body.provider_token, "");
    assert.deepEqual(c.body.prices, [{ label: "Чаевые", amount: 100 }]);
    assert.equal(c.body.payload, "tip:100");
    assert.equal(c.body.title, "Чаевые для Axiom News");
    assert.ok(c.body.title.length <= 32 && c.body.description.length <= 255);
  });

  test("only 100, 500 and 1000, for everyone: the old amounts and the 1-Star test amount are refused, the owner too", async () => {
    assert.deepEqual(TIP_AMOUNTS, [100, 500, 1000]);
    const { binding } = fakeD1();
    fetchMock = telegram("https://t.me/$x");
    for (const id of [FRIEND, OWNER]) {
      for (const bad of [0, 1, 50, 75, 250, 2000, -100, "100abc", null]) {
        const r = await api(binding, "/api/tip", id, { amount: bad });
        assert.equal(r.status, 400, `${id} ${bad}`);
        assert.equal(r.body.code, "tip_amount");
      }
    }
    for (const a of TIP_AMOUNTS) assert.equal((await api(binding, "/api/tip", FRIEND, { amount: a })).status, 200);
    assert.equal(fetchMock.calls.length, TIP_AMOUNTS.length);   // refused amounts never reach Telegram
  });

  test("the settings state lists the same three amounts for everyone, the owner included", async () => {
    const { binding } = fakeD1();
    fetchMock = telegram();
    assert.deepEqual((await api(binding, "/api/open", FRIEND, { tz: "Asia/Yerevan" })).body.tips.amounts, [100, 500, 1000]);
    assert.deepEqual((await api(binding, "/api/open", OWNER, { tz: "Asia/Yerevan" })).body.tips.amounts, [100, 500, 1000]);
  });

  test("/support: the short text and one row of three amount buttons (the owner too); a tap sends an invoice", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: FRIEND, lang: "ru" });
    fetchMock = telegram();
    await hook(binding, msg({ text: "/support" }));
    const reply = fetchMock.calls[0].body;
    assert.match(reply.text, /^Axiom News бесплатен/);
    assert.match(reply.text, /\/terms$/);
    assert.deepEqual(reply.reply_markup.inline_keyboard.map((r) => r.map((b) => b.callback_data)), [["tip:100", "tip:500", "tip:1000"]]);
    assert.deepEqual(reply.reply_markup.inline_keyboard[0].map((b) => b.text), ["100 ⭐", "500 ⭐", "1000 ⭐"]);
    await hook(binding, msg({ text: "/support" }, OWNER));
    assert.deepEqual(fetchMock.calls[1].body.reply_markup, reply.reply_markup);

    const tap = (data, id = FRIEND) => hook(binding, { callback_query: { id: "cb1", from: from(id), data,
      message: { message_id: 9, chat: { id, type: "private" } } } });
    fetchMock.calls.length = 0;
    await tap("tip:500");
    assert.deepEqual(fetchMock.calls.map(methodOf), ["answerCallbackQuery", "sendInvoice"]);
    assert.equal(fetchMock.calls[1].body.chat_id, FRIEND);
    assert.deepEqual(fetchMock.calls[1].body.prices, [{ label: "Чаевые", amount: 500 }]);
    assert.equal(fetchMock.calls[1].body.currency, "XTR");
    fetchMock.calls.length = 0;
    for (const [data, id] of [["tip:1", FRIEND], ["tip:1", OWNER], ["tip:50", FRIEND], ["tip:250", OWNER]]) {
      fetchMock.calls.length = 0;
      await tap(data, id);                                     // old or test amounts: refused for everyone
      assert.deepEqual(fetchMock.calls.map(methodOf), ["answerCallbackQuery", "sendMessage"], `${data} ${id}`);
      assert.match(fetchMock.calls[1].body.text, /^(Такая сумма недоступна|This tip amount is not available)/);
    }
  });
});

describe("pre_checkout_query", () => {
  test("a valid tip is accepted at once, without touching the database", async () => {
    fetchMock = telegram();
    const noDb = { prepare() { throw new Error("no database read allowed"); }, batch() { throw new Error("no database read allowed"); } };
    await hook(noDb, precheckout(100));
    assert.deepEqual(fetchMock.calls.map((c) => [methodOf(c), c.body]),
      [["answerPreCheckoutQuery", { pre_checkout_query_id: "pcq1", ok: true }]]);
  });

  test("refused with a reason: wrong currency, amount not matching the payload, unknown or old amount, the old test amount", async () => {
    const q = (amount, extra = {}, id = FRIEND) => precheckout(amount, extra, id).pre_checkout_query;
    for (const a of [100, 500, 1000]) assert.equal(checkPreCheckout(q(a)), true, String(a));
    assert.equal(checkPreCheckout(q(100, { currency: "USD" })), false);
    assert.equal(checkPreCheckout(q(100, { total_amount: 5 })), false);
    assert.equal(checkPreCheckout(q(100, { invoice_payload: "other" })), false);
    for (const a of [75, 50, 250, 1]) {
      assert.equal(checkPreCheckout(q(a)), false, String(a));
      assert.equal(checkPreCheckout(q(a, {}, OWNER)), false, `owner ${a}`);   // no test amount for the owner any more
    }
    fetchMock = telegram();
    await hook(fakeD1().binding, precheckout(75));
    assert.equal(fetchMock.calls[0].body.ok, false);
    assert.match(fetchMock.calls[0].body.error_message, /not available/);
  });
});

describe("successful_payment", () => {
  test("stored once with only user, amount, charge id and time; a repeated update counts once; one thank-you", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: FRIEND, lang: "ru" });
    const before = sqlite.prepare("SELECT * FROM users WHERE id = ?").get(FRIEND);
    fetchMock = telegram();
    await hook(binding, paid(250, "ch_A"));
    await hook(binding, paid(250, "ch_A"));                  // Telegram resends the same update
    assert.deepEqual(tipRows(sqlite), [{ user_id: FRIEND, amount: 250, charge_id: "ch_A", refunded_at: null }]);
    assert.deepEqual(sqlite.prepare("PRAGMA table_info(tips)").all().map((c) => c.name),
      ["id", "user_id", "amount", "charge_id", "at", "refunded_at"]);
    const thanks = fetchMock.calls.filter((c) => methodOf(c) === "sendMessage");
    assert.equal(thanks.length, 1);
    assert.equal(thanks[0].body.text, "Спасибо за чаевые, 250 ⭐! Они помогают поддерживать работу Axiom. Ваши сводки остаются такими же.");
    // a tip changes nothing else for the user
    assert.deepEqual(sqlite.prepare("SELECT * FROM users WHERE id = ?").get(FRIEND), before);
    await hook(binding, paid(50, "ch_B"));
    assert.equal(tipRows(sqlite).length, 2);
  });

  test("Telegram's refunded_payment note marks the tip refunded", async () => {
    const { binding, sqlite } = fakeD1();
    fetchMock = telegram();
    await hook(binding, paid(100, "ch_R"));
    await hook(binding, msg({ refunded_payment: { currency: "XTR", total_amount: 100, invoice_payload: "tip:100",
      telegram_payment_charge_id: "ch_R" } }));
    assert.ok(tipRows(sqlite)[0].refunded_at > 0);
  });
});

describe("refunds and the Admin tab (owner only)", () => {
  async function withTips() {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: FRIEND, first_name: "Ann", lang: "en" });
    addUser(sqlite, { id: OWNER, first_name: "Rob" });
    fetchMock = telegram();
    await hook(binding, paid(500, "ch_1"));
    await hook(binding, paid(100, "ch_2", OWNER));
    fetchMock.calls.length = 0;
    return { binding, sqlite };
  }

  test("a non-owner can neither refund nor see tips", async () => {
    const { binding, sqlite } = await withTips();
    assert.equal((await api(binding, "/api/admin/refund", FRIEND, { id: 1 })).status, 403);
    assert.equal((await api(binding, "/api/admin", FRIEND)).status, 403);
    assert.equal(fetchMock.calls.length, 0);
    assert.equal(tipRows(sqlite)[0].refunded_at, null);
  });

  test("Admin shows total Stars, the count and the last tips; the owner refunds one through the Bot API", async () => {
    const { binding, sqlite } = await withTips();
    let a = (await api(binding, "/api/admin", OWNER)).body.tips;
    assert.deepEqual([a.stars, a.tips, a.refunded], [600, 2, 0]);
    assert.deepEqual(a.last.map((x) => [x.name, x.amount]).sort(), [["Ann", 500], ["Rob", 100]]);
    assert.ok(a.last.every((x) => x.at > 0 && x.refunded_at === null));
    const ann = a.last.find((x) => x.name === "Ann");
    const r = await api(binding, "/api/admin/refund", OWNER, { id: ann.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.message, "Refunded 500 ⭐.");
    assert.deepEqual(fetchMock.calls.map((c) => [methodOf(c), c.body]), [
      ["refundStarPayment", { user_id: FRIEND, telegram_payment_charge_id: "ch_1" }],
      ["sendMessage", { chat_id: FRIEND, text: "Your tip of 500 ⭐ was refunded." }],
    ]);
    assert.ok(tipRows(sqlite)[0].refunded_at > 0);
    a = (await api(binding, "/api/admin", OWNER)).body.tips;
    assert.deepEqual([a.stars, a.tips, a.refunded, a.refunded_stars], [100, 1, 1, 500]);
    // a second tap: refused, Telegram not called again
    fetchMock.calls.length = 0;
    assert.equal((await api(binding, "/api/admin/refund", OWNER, { id: ann.id })).status, 409);
    assert.equal(fetchMock.calls.length, 0);
    assert.equal((await api(binding, "/api/admin/refund", OWNER, { id: 999 })).status, 404);
  });

  test("Telegram refuses the refund: nothing is marked; already refunded at Telegram: marked", async () => {
    const { binding, sqlite } = await withTips();
    fetchMock.restore();
    fetchMock = mockFetch(() => ({ status: 400, body: { ok: false, description: "Bad Request: BALANCE_TOO_LOW" } }));
    const r = await api(binding, "/api/admin/refund", OWNER, { id: 1 });
    assert.equal(r.status, 502);
    assert.match(r.body.message, /BALANCE_TOO_LOW/);
    assert.equal(tipRows(sqlite)[0].refunded_at, null);
    fetchMock.restore();
    fetchMock = mockFetch((url) => (url.endsWith("/refundStarPayment")
      ? { status: 400, body: { ok: false, description: "Bad Request: CHARGE_ALREADY_REFUNDED" } } : undefined));
    assert.equal((await api(binding, "/api/admin/refund", OWNER, { id: 1 })).status, 200);
    assert.ok(tipRows(sqlite)[0].refunded_at > 0);
  });

  test("shapeTips keeps only the last 10 rows the SQL returns", () => {
    assert.match(tipsStatements()[1].sql, /LIMIT 10$/);
    assert.deepEqual(shapeTips([{ tips: 0, stars: 0, refunded: 0, refunded_stars: 0 }], []), { stars: 0, tips: 0, refunded: 0, refunded_stars: 0, last: [] });
  });
});

describe("/paysupport, /terms, commands and texts", () => {
  test("/paysupport explains; with a note it goes to the owner and the user gets a confirmation", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: FRIEND, lang: "en" });
    fetchMock = telegram();
    await hook(binding, msg({ text: "/paysupport" }));
    assert.match(fetchMock.calls[0].body.text, /^A problem with a tip\? Send \/paysupport/);
    assert.match(fetchMock.calls[0].body.text, /Telegram support cannot help/);
    fetchMock.calls.length = 0;
    await hook(binding, msg({ text: "/paysupport I sent 500 by mistake" }));
    assert.deepEqual(fetchMock.calls.map((c) => c.body.chat_id), [OWNER, FRIEND]);
    assert.match(fetchMock.calls[0].body.text, /^Payment support request from Ann \(id 777, @ann\):\nI sent 500 by mistake/);
    assert.match(fetchMock.calls[1].body.text, /^Thank you, your note was sent/);
    fetchMock.calls.length = 0;
    await hook(binding, msg({ text: "/terms" }));
    assert.match(fetchMock.calls[0].body.text, /^Terms for tips\./);
  });

  test("the command list has /support, /paysupport and /terms in every language", () => {
    for (const lang of Object.keys(DICTS)) {
      const list = commandList(lang);
      assert.deepEqual(list.map((c) => c.command), ["start", "settings", "support", "paysupport", "terms"]);
      for (const c of list) assert.ok(c.description.length >= 3 && c.description.length <= 256 && !FORBIDDEN.test(c.description));
    }
  });

  test("every new text exists in every language (en, ru, hy, fr), with no em dash, and Russian never says дайджест", () => {
    const keys = ["bot.support", "bot.support_amount", "bot.tip_title", "bot.tip_description", "bot.tip_label",
      "bot.tip_thanks", "bot.tip_refunded", "bot.tip_bad", "bot.paysupport", "bot.paysupport_sent", "bot.terms",
      "commands.support", "commands.paysupport", "commands.terms", "errors.tip_amount", "app.sec_support",
      "app.support_text", "app.tip_amount", "app.tip_thanks", "app.tip_failed", "app.tip_unavailable"];
    const missing = [];
    for (const lang of ["en", "ru", "hy", "fr"]) {
      for (const k of keys) {
        const v = own(lang, k);
        if (typeof v !== "string" || !v.trim()) missing.push(`${lang} ${k}`);
        else assert.doesNotMatch(v, FORBIDDEN, `${lang} ${k}`);
      }
    }
    assert.deepEqual(missing, []);
    for (const k of keys) assert.doesNotMatch(own("ru", k), /дайджест/i);
    for (const lang of ["en", "ru", "hy", "fr"]) {
      const f = invoiceFields(lang, 50);
      assert.ok(f.title.length <= 32 && f.description.length <= 255 && f.title === own(lang, "bot.tip_title"), lang);
    }
  });
});
