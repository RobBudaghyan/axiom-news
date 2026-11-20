// Step 17 (launch): deleting a user (Admin "Delete user", Help "Delete my data") and a reader blocking
// the bot (my_chat_member). Full deletion, the new-user flow afterwards, the owner's protection, the
// confirm steps and the texts in every language.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";
import { signInitData } from "../src/auth.js";
import { runTick } from "../src/cron.js";
import { DICTS, t } from "../src/i18n.js";
import { USER_TABLES, deleteUserStatements } from "../src/account.js";
import { OWNER, addStory, addUser, fakeD1, mockFetch } from "./helpers.mjs";

const TOKEN = "123456:TEST-token-for-unit-tests";
const SECRET = "s".repeat(40);
let fetchMock;
afterEach(() => fetchMock?.restore());
const env = (binding) => ({ DB: binding, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET,
  OWNER_TELEGRAM_ID: String(OWNER), APP_URL: "https://w.test/app/", GEMINI_API_KEY: "k" });
const nowS = () => Math.floor(Date.now() / 1000);
const initFor = (id, lang = "en", name = "Ashot") => signInitData({ query_id: "q", user: JSON.stringify({ id, first_name: name, language_code: lang }),
  auth_date: String(nowS()) }, TOKEN);
async function api(binding, path, id, body, lang = "en") {
  const res = await worker.fetch(new Request(`https://w.test${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `tma ${await initFor(id, lang)}` }, body: body === undefined ? undefined : JSON.stringify(body) }), env(binding));
  return { status: res.status, body: await res.json() };
}
const update = (binding, upd) => worker.fetch(new Request("https://w.test/telegram", {
  method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify({ update_id: 1, ...upd }) }), env(binding));
const start = (binding, id, lang = "en") => update(binding, { message: { message_id: 5, from: { id, first_name: "Ashot", language_code: lang },
  chat: { id, type: "private" }, text: "/start" } });
const telegram = () => mockFetch((url) => (url.includes("api.telegram.org") ? { status: 200, body: { ok: true, result: { message_id: 1 } } } : undefined));
const sends = () => fetchMock.calls.filter((c) => /\/send(Message|RichMessage|Animation)$/.test(c.url));

const ASHOT = 501, OTHER = 502;

// Every row a reader can leave behind, for ASHOT and (to check nothing else goes) for OTHER.
function seed(sqlite) {
  const now = nowS();
  addUser(sqlite, { id: OWNER, first_name: "Rob" });
  addUser(sqlite, { id: ASHOT, first_name: "Ashot", lang: "ru" });
  addUser(sqlite, { id: OTHER, first_name: "Ani" });
  const s = addStory(sqlite, "Armenia and Turkey open the border", ["armenia"], 9, now - 3600, { final_score: 8, main_topic: "armenia", headline: "Armenia and Turkey open the border" });
  sqlite.exec(`INSERT INTO custom_topics (id, tag, names, definition, queries, created_by, created_at) VALUES
    (1, 'c1', '{"en":"Japan"}', 'Japan', '[]', ${ASHOT}, 1), (2, 'c2', '{"en":"Chess"}', 'Chess', '[]', ${OTHER}, 1)`);
  for (const id of [ASHOT, OTHER]) {
    sqlite.exec(`INSERT INTO sent (user_id, story_id, sent_at) VALUES (${id}, ${s}, ${now});
      INSERT INTO digest_holds (user_id, story_id, lang, at) VALUES (${id}, ${s}, 'ru', ${now});
      INSERT INTO feedback (user_id, at, text) VALUES (${id}, ${now}, 'hello');
      INSERT INTO topic_checks (user_id, at, input, outcome) VALUES (${id}, ${now}, 'Japan', 'accepted');
      INSERT INTO tips (user_id, amount, charge_id, at) VALUES (${id}, 100, 'ch-${id}', ${now});
      INSERT INTO errors (at, component, message) VALUES (${now}, 'worker', 'digest for user ${id}: Telegram 500');`);
  }
  sqlite.exec(`INSERT INTO announcements (id, created_at, texts) VALUES (1, ${now}, '{}');
    INSERT INTO announcement_sends (announcement_id, user_id, at, ok) VALUES (1, ${ASHOT}, ${now}, 1), (1, ${OTHER}, ${now}, 1);
    INSERT INTO custom_follows (user_id, topic_id, at) VALUES (${ASHOT}, 1, 1), (${ASHOT}, 2, 1), (${OTHER}, 2, 1);`);
}

// Every table with a user_id column (plus users.id): how many rows still name this user.
function rowsAbout(sqlite, id) {
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  const out = {};
  for (const tb of tables) {
    const cols = sqlite.prepare(`PRAGMA table_info(${tb})`).all().map((c) => c.name);
    const col = tb === "users" ? "id" : cols.includes("user_id") ? "user_id" : cols.includes("created_by") ? "created_by" : null;
    if (!col) continue;
    const n = sqlite.prepare(`SELECT count(*) AS n FROM ${tb} WHERE ${col} = ?`).get(id).n;
    if (n) out[tb] = n;
  }
  const errs = sqlite.prepare("SELECT count(*) AS n FROM errors WHERE message LIKE ?").get(`%${id}%`).n;
  if (errs) out.errors = errs;
  return out;
}

describe("Step 17: full deletion", () => {
  test("Delete my data removes every row about the reader, keeps tips anonymous, leaves the others alone", async () => {
    const { binding, sqlite } = fakeD1();
    seed(sqlite);
    const otherBefore = rowsAbout(sqlite, OTHER);
    const r = await api(binding, "/api/account/delete", ASHOT, { confirm: true }, "ru");
    assert.equal(r.status, 200);
    assert.deepEqual(rowsAbout(sqlite, ASHOT), {}, "no row names the deleted reader");
    assert.deepEqual(rowsAbout(sqlite, OTHER), otherBefore, "another reader keeps everything");
    // tips stay as anonymous totals (user_id 0)
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM tips WHERE user_id = 0 AND amount = 100").get().n, 1);
    // Japan had only Ashot: its 7-day clock starts; Chess still has Ani: no clock
    const orphan = Object.fromEntries(sqlite.prepare("SELECT id, orphan_since FROM custom_topics").all().map((x) => [x.id, x.orphan_since]));
    assert.ok(orphan[1] > 0);
    assert.equal(orphan[2], null);
    // the owner and Ani are still there
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM users").get().n, 2);
  });

  test("every table keyed to a user is in the delete list (a new table cannot be forgotten)", () => {
    const { sqlite } = fakeD1();
    const keyed = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name)
      .filter((tb) => sqlite.prepare(`PRAGMA table_info(${tb})`).all().some((c) => c.name === "user_id"));
    const handled = new Set([...USER_TABLES, "tips"]);
    assert.deepEqual(keyed.filter((tb) => !handled.has(tb)), []);
    const sql = deleteUserStatements(1, 1).map((s) => s.sql).join("\n");
    for (const tb of USER_TABLES) assert.ok(sql.includes(`DELETE FROM ${tb} WHERE user_id = ?1`), tb);
    assert.match(sql, /DELETE FROM users WHERE id = \?1/);
  });

  test("Admin Delete user removes the same data; the owner sees no Delete on his own row", async () => {
    const { binding, sqlite } = fakeD1();
    seed(sqlite);
    const admin = await api(binding, "/api/admin", OWNER);
    const list = admin.body.users.list;
    assert.equal(list.find((u) => u.id === OWNER).owner, true);
    assert.equal(list.find((u) => u.id === ASHOT).owner, false);
    const r = await api(binding, "/api/admin/user-delete", OWNER, { id: ASHOT });
    assert.equal(r.status, 200);
    assert.equal(r.body.message, "Deleted Ashot and all their data.");
    assert.deepEqual(rowsAbout(sqlite, ASHOT), {});
    assert.equal((await api(binding, "/api/admin/user-delete", OWNER, { id: ASHOT })).status, 404);   // already gone
  });
});

describe("Step 17: after deletion the person is brand new", () => {
  test("next /start: the new-user welcome; the first open: the setup; Done: one sample digest", async () => {
    const { binding, sqlite } = fakeD1();
    seed(sqlite);
    sqlite.exec(`UPDATE users SET onboarded_at = 5, opened_at = 5, reminded_at = 5, imported = 1 WHERE id = ${ASHOT}`);
    await api(binding, "/api/account/delete", ASHOT, { confirm: true });
    fetchMock = telegram();
    await runTick(binding && (await import("../src/db.js")).d1Binding(binding), { send: async () => assert.fail("nothing is sent"), alert: async () => {} },
      nowS(), { digests: true });
    await start(binding, ASHOT, "ru");
    const w = sends()[0];
    assert.match(w.url, /\/sendAnimation$/);
    assert.equal(w.body.caption, t("ru", "bot.welcome_setup"));
    const u = sqlite.prepare("SELECT * FROM users WHERE id = ?").get(ASHOT);
    assert.deepEqual([u.onboarded_at, u.opened_at, u.reminded_at, u.imported, u.blocked], [null, null, null, 0, 0]);
    const open = await api(binding, "/api/open", ASHOT, { tz: "Asia/Yerevan" }, "ru");
    assert.equal(open.body.setup, true);
    const done = await api(binding, "/api/onboard", ASHOT, { skipped: false }, "ru");
    assert.equal(done.body.sample.sample, true);
    assert.equal(done.body.sample.stories, 1, "the story he got before counts as new again");
  });
});

describe("Step 17: protection and confirm steps", () => {
  test("no confirm: nothing is deleted", async () => {
    const { binding, sqlite } = fakeD1();
    seed(sqlite);
    for (const body of [{}, { confirm: "yes" }, { confirm: 1 }]) {
      const r = await api(binding, "/api/account/delete", ASHOT, body);
      assert.equal(r.status, 400);
      assert.equal(r.body.code, "delete_confirm");
    }
    assert.ok(Object.keys(rowsAbout(sqlite, ASHOT)).length >= 8);
  });

  test("the owner: never from Admin; from Help only with the second confirm", async () => {
    const { binding, sqlite } = fakeD1();
    seed(sqlite);
    const a = await api(binding, "/api/admin/user-delete", OWNER, { id: OWNER });
    assert.equal(a.status, 400);
    assert.match(a.body.message, /your own account/);
    const b = await api(binding, "/api/account/delete", OWNER, { confirm: true });
    assert.equal(b.status, 400);
    assert.equal(b.body.code, "delete_owner_confirm");
    assert.ok(sqlite.prepare("SELECT 1 FROM users WHERE id = ?").get(OWNER), "the owner is still there");
    const c = await api(binding, "/api/account/delete", OWNER, { confirm: true, owner_confirm: true });
    assert.equal(c.status, 200);
    assert.equal(sqlite.prepare("SELECT 1 FROM users WHERE id = ?").get(OWNER), undefined);
  });

  test("Admin Delete is owner only", async () => {
    const { binding, sqlite } = fakeD1();
    seed(sqlite);
    const r = await api(binding, "/api/admin/user-delete", OTHER, { id: ASHOT });
    assert.equal(r.status, 403);
    assert.ok(sqlite.prepare("SELECT 1 FROM users WHERE id = ?").get(ASHOT));
  });

  test("the Mini App asks before it deletes (one confirm, a second for the owner) and then stops calling the API", () => {
    const src = readFileSync(new URL("../public/app/app.js", import.meta.url), "utf8");
    const me = src.slice(src.indexOf("async function deleteMe()"), src.indexOf("async function deleteMe()") + 1400);
    const first = me.indexOf('confirmBox(tr("app.delete_confirm"))'), second = me.indexOf('confirmBox(tr("app.delete_owner_confirm"))');
    const call = me.indexOf('api("/api/account/delete"');
    assert.ok(first > 0 && second > first && call > second, "confirm, owner confirm, then the call");
    assert.match(me, /S\.deleted = true/);
    assert.match(me, /tg\.close\(\)/);
    assert.match(src, /function renderView\(animate = false\) \{\n\s+if \(S\.deleted\) return;/);
    const adm = src.slice(src.indexOf("async function userDeleteAction("), src.indexOf("async function userDeleteAction(") + 700);
    assert.ok(adm.indexOf("confirmBox(") > 0 && adm.indexOf("confirmBox(") < adm.indexOf('api("/api/admin/user-delete"'));
    assert.match(adm, /Delete \$\{name\} and all their data\?/);
    assert.match(src, /x\.owner \? "" : `<button class="link danger user-del"/);
  });
});

describe("Step 17: texts in every language", () => {
  test("row, confirm, owner confirm, done and both errors exist in every language, short, no long dash", () => {
    for (const lang of Object.keys(DICTS)) {
      for (const k of ["app.delete_row", "app.delete_confirm", "app.delete_owner_confirm", "app.delete_done",
                       "errors.delete_confirm", "errors.delete_owner_confirm"]) {
        const s = t(lang, k);
        assert.ok(s && s !== k, `${lang} ${k}`);
        assert.doesNotMatch(s, /[–—]/, `${lang} ${k}`);
        assert.ok(s.length <= 160, `${lang} ${k} is short`);
      }
      assert.ok(t(lang, "app.delete_row").startsWith("🗑 "), lang);
      assert.ok(t(lang, "app.delete_done").startsWith("✅ ") && t(lang, "app.delete_done").includes("/start"), lang);
      assert.notEqual(t(lang, "app.delete_confirm"), t("en", "app.delete_confirm").replace(/./, "") );
    }
    assert.notEqual(t("ru", "app.delete_confirm"), t("en", "app.delete_confirm"), "translated, not English");
  });
});

describe("Step 17: a reader blocks the bot", () => {
  test("my_chat_member kicked marks them blocked; no digest is tried; /start brings them back", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: ASHOT, first_name: "Ashot", next_digest_at: nowS() - 60 });
    await update(binding, { my_chat_member: { chat: { id: ASHOT, type: "private" }, from: { id: ASHOT, first_name: "Ashot" }, date: nowS(),
      old_chat_member: { status: "member", user: { id: 1 } }, new_chat_member: { status: "kicked", user: { id: 1 } } } });
    assert.equal(sqlite.prepare("SELECT blocked FROM users WHERE id = ?").get(ASHOT).blocked, 1);
    const { d1Binding } = await import("../src/db.js");
    const res = await runTick(d1Binding(binding), { send: async () => assert.fail("no digest to a blocked reader"), alert: async () => {} }, nowS(), {});
    assert.equal(res.due ?? 0, 0);
    fetchMock = telegram();
    await start(binding, ASHOT);
    assert.equal(sqlite.prepare("SELECT blocked FROM users WHERE id = ?").get(ASHOT).blocked, 0);
  });

  test("a group's chat-member update changes nothing", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { id: ASHOT });
    await update(binding, { my_chat_member: { chat: { id: -100, type: "group" }, from: { id: ASHOT }, date: 1,
      new_chat_member: { status: "kicked", user: { id: 1 } } } });
    assert.equal(sqlite.prepare("SELECT blocked FROM users WHERE id = ?").get(ASHOT).blocked, 0);
  });
});
