// Step 9: reader languages. The dictionaries (missing and extra keys, placeholders), the em dash
// rule in every language, Russian plurals, greetings and 24-hour times, the never-mixed rule (one
// untranslated story makes the whole digest English, logged, counted in Admin), stale
// translations, language defaults on /start and on the first Mini App open, the language
// setting, and the eligibility rule shared with the hourly job.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";
import { DICTS, FORBIDDEN, LANGS, chooseLang, effectiveLang, plural, pluralCategory, t, topicLabel } from "../src/i18n.js";
import { CONFIG, buildMessage, candidateStatement, planDigest, primaryTopic, qualifies, topicInfoFrom } from "../src/digest.js";
import { helpText, settingsText, welcomeText } from "../src/bot.js";
import { runTick } from "../src/cron.js";
import { adminStatements, shapeAdmin } from "../src/admin.js";
import { signInitData } from "../src/auth.js";
import { i18nSource } from "../scripts/stamp-app.mjs";
import { ALL, OWNER, TOPIC_ROWS, TZ, addStory, addTranslation, addUser, fakeD1, mockFetch, yerevan } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (p) => readFileSync(`${ROOT}${p}`, "utf8");
const TOPICS = TOPIC_ROWS.map(([tag, label_en, emoji, sort]) => ({ tag, label_en, emoji, sort, is_default: 1 }));
const PLURAL_KEYS = new Set(["one", "few", "many", "other"]);
const TOKEN = "123456:TEST-token-for-unit-tests";
const SECRET = "s".repeat(40);
let fetchMock;
afterEach(() => fetchMock?.restore());

const env = (binding) => ({ DB: binding, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: SECRET,
  OWNER_TELEGRAM_ID: String(OWNER), APP_URL: "https://w.test/app/" });

// Every key path of a dictionary; a plural-forms object counts as one leaf.
function keys(d, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(d)) {
    if (k.startsWith("_")) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Object.keys(v).every((x) => PLURAL_KEYS.has(x))) out.push(...keys(v, path));
    else out.push(path);
  }
  return out;
}
const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
const placeholders = (v) => new Set(strings(v).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1])));
const get = (d, path) => path.split(".").reduce((v, k) => v?.[k], d);

let nextId = 1;
const story = (headline, topics, score = 7, extra = {}) => ({
  id: nextId++, summary: headline, headline, description: `${headline}, details.`, topics: JSON.stringify(topics),
  importance: 6, final_score: score, best_url: "https://x.test/a", best_source: "Alpha Times", ...extra,
});
const user = (lang, extra = {}) => ({ id: OWNER, first_name: "Rob", topics: JSON.stringify(ALL), timezone: TZ,
  digest_times: '["09:00","14:00","20:00"]', last_digest_at: yerevan(14), lang, ...extra });

describe("dictionaries", () => {
  test("every language has every English key and no key English lacks (the list is printed)", () => {
    const en = new Set(keys(DICTS.en));
    const report = [];
    for (const [lang, d] of Object.entries(DICTS)) {
      const mine = new Set(keys(d));
      const missing = [...en].filter((k) => !mine.has(k));
      const extra = [...mine].filter((k) => !en.has(k));
      if (missing.length || extra.length) report.push(`${lang}: missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"}`);
    }
    assert.deepEqual(report, [], report.join("\n"));
  });

  test("every translation keeps the English placeholders and plural forms fit the language", () => {
    const bad = [];
    for (const [lang, d] of Object.entries(DICTS)) {
      for (const k of keys(DICTS.en)) {
        const want = placeholders(get(DICTS.en, k)), have = placeholders(get(d, k));
        if ([...have].some((p) => !want.has(p)) || [...want].some((p) => !have.has(p) && p !== "count")) bad.push(`${lang} ${k}`);
        const v = get(d, k);
        if (v && typeof v === "object") {
          const need = lang === "ru" ? ["one", "few", "many"] : ["one", "other"];
          if (need.some((f) => typeof v[f] !== "string")) bad.push(`${lang} ${k}: plural forms ${Object.keys(v).join("/")}`);
        }
      }
    }
    assert.deepEqual(bad, []);
  });

  test("languages.json: every available language has a dictionary; enabled ones are available; English is the default", () => {
    assert.deepEqual(Object.keys(DICTS).sort(), [...LANGS.available].sort());
    assert.ok(LANGS.enabled.every((l) => LANGS.available.includes(l)));
    assert.equal(LANGS.default, "en");
    assert.ok(LANGS.enabled.includes("en"));
  });

  test("a missing key falls back to English", () => {
    const saved = DICTS.ru.bot.button;
    delete DICTS.ru.bot.button;
    try { assert.equal(t("ru", "bot.button"), "Open settings"); } finally { DICTS.ru.bot.button = saved; }
    assert.equal(t("ru", "bot.button"), "Открыть настройки");
  });

  test("the Mini App's i18n.js is generated from the dictionaries (run npm run stamp)", () => {
    assert.equal(readFileSync(fileURLToPath(new URL("../public/app/i18n.js", import.meta.url)), "utf8"), i18nSource());
  });
});

describe("never an em dash, in any language", () => {
  test("no dictionary string, prompt or config file has one", () => {
    for (const [lang, d] of Object.entries(DICTS)) for (const s of strings(d)) assert.doesNotMatch(s, FORBIDDEN, `${lang}: ${s}`);
    for (const f of ["prompts/translate.md", "config/glossary.yaml", "config/languages.json",
                     "worker/public/app/i18n.js", "worker/public/app/app.js"]) assert.doesNotMatch(read(f), FORBIDDEN, f);
  });

  test("no outgoing text has one: digests, quiet notes and bot replies in every language", () => {
    const now = yerevan(20, 5);
    for (const lang of Object.keys(DICTS)) {
      const u = user(lang, { next_digest_at: yerevan(9) + 86400, paused: 0 });
      const s = story("Armenia and Turkey agree to open the border", ["armenia"], 8, { emojis: "🇦🇲🇹🇷" });
      const tr = { ...s, tr_headline: "Перевод заголовка", tr_description: "Перевод описания." };
      const texts = [
        planDigest(u, [tr], TOPICS, now, CONFIG, { lang }).text,
        planDigest(u, [], TOPICS, now, CONFIG, { lang }).text,
        planDigest({ ...u, last_digest_at: null }, [tr], TOPICS, now, CONFIG, { lang }).text,
        welcomeText(u, TOPICS, now, true, lang), welcomeText(u, TOPICS, now, false, lang),
        helpText(u, now, lang), helpText(null, now, lang), helpText({ ...u, paused: 1 }, now, lang), settingsText(lang),
      ];
      for (const x of texts) assert.doesNotMatch(x, FORBIDDEN, `${lang}: ${x}`);
    }
  });

  test("a story text with a dash is cleaned before it is sent; the message builder refuses one", () => {
    const s = { ...story("Moscow — the capital", ["russia"], 8), primary: "russia" };
    const msg = buildMessage([s], { now: yerevan(20), tz: TZ, name: "Rob", lang: "ru", topicInfo: topicInfoFrom(TOPICS, "ru") });
    assert.doesNotMatch(msg.text, FORBIDDEN);
    assert.throws(() => buildMessage([], { now: yerevan(20), tz: TZ, name: "Rob", label: "a — b" }), /dash/);
  });
});

describe("owner rule: in Russian, digest is always сводка", () => {
  test("no Russian dictionary string and no Russian outgoing text says дайджест", () => {
    const bad = /дайджест/i;
    for (const s of strings({ ...DICTS.ru, _comment: "" })) assert.doesNotMatch(s, bad, s);
    const now = yerevan(20, 5);
    const u = user("ru", { next_digest_at: yerevan(9) + 86400, paused: 0 });
    const s = { ...story("Big news", ["politics"], 8), tr_headline: "Большая новость", tr_description: "Текст." };
    for (const x of [planDigest(u, [s], TOPICS, now, CONFIG).text, planDigest(u, [], TOPICS, now, CONFIG).text,
      welcomeText(u, TOPICS, now, true, "ru"), welcomeText(u, TOPICS, now, false, "ru"), helpText(u, now, "ru"),
      helpText(null, now, "ru"), helpText({ ...u, paused: 1 }, now, "ru"), settingsText("ru")]) assert.doesNotMatch(x, bad, x);
    assert.doesNotMatch(JSON.stringify(JSON.parse(i18nSource().split(" = ")[1].replace(/;\s*$/, "")).dicts.ru), bad);
    assert.equal(t("ru", "app.hero_label"), "Следующая сводка");
    assert.equal(t("ru", "app.hero_paused_label"), "Сводки");
    assert.equal(t("ru", "app.sec_times"), "Время сводок");
    assert.match(welcomeText(u, TOPICS, now, true, "ru"), /Я присылаю короткую сводку самых важных новостей/);
  });
});

describe("owner rule: in Russian, Ukraine takes на (Step 11)", () => {
  test("the topic is Война на Украине everywhere, and no Russian text says в Украине", () => {
    const bad = /(^|[^\p{L}-])[вВ]о?\s+Украин[еу]/u;
    assert.equal(DICTS.ru.topics.ukraine_war, "Война на Украине");
    assert.equal(topicLabel("ru", "ukraine_war", "Ukraine War"), "Война на Украине");
    for (const s of strings({ ...DICTS.ru, _comment: "" })) assert.doesNotMatch(s, bad, s);
    const app = JSON.parse(i18nSource().split(" = ")[1].replace(/;\s*$/, "")).dicts.ru;
    assert.equal(app.topics.ukraine_war, "Война на Украине");
    const topicsYaml = readFileSync(new URL("../../config/topics.yaml", import.meta.url), "utf8");
    assert.match(topicsYaml, /ru: "Война на Украине"/);
    const prompt = readFileSync(new URL("../../prompts/translate.md", import.meta.url), "utf8");
    assert.match(prompt, /на Украине/);
  });
});

describe("Russian grammar", () => {
  test("plural forms: 1 история, 2 истории, 5 историй, 11-14 историй, 21 история, 22 истории, 111 историй", () => {
    const cases = { 1: "история", 2: "истории", 4: "истории", 5: "историй", 11: "историй", 12: "историй", 14: "историй",
      20: "историй", 21: "история", 22: "истории", 25: "историй", 101: "история", 111: "историй", 0: "историй" };
    for (const [n, word] of Object.entries(cases)) assert.equal(plural("ru", Number(n), "digest.stories"), word, n);
    assert.equal(pluralCategory("en", 1), "one");
    assert.equal(pluralCategory("en", 0), "other");
    assert.equal(pluralCategory("fr", 0), "one");
    assert.equal(pluralCategory("fr", 2), "other");
  });

  test("the Mini App uses the same plural rule (its copy of the function is checked here)", () => {
    const src = readFileSync(fileURLToPath(new URL("../public/app/app.js", import.meta.url)), "utf8");
    const body = /function pluralCat\(n\) \{([\s\S]*?)\n  \}\n/.exec(src)[1];
    const appRule = new Function("LANG", "n", body);
    for (const lang of ["en", "ru", "fr", "hy"]) {
      for (let n = 0; n <= 130; n++) assert.equal(appRule(lang, n), pluralCategory(lang, n), `${lang} ${n}`);
    }
  });

  test("greeting by time of day, 24-hour time, the first name unchanged", () => {
    const u = user("ru", { first_name: "Rob" });
    const s = story("Big news", ["politics"], 8);
    const tr = { ...s, tr_headline: "Большая новость", tr_description: "Подробности." };
    const first = (text) => text.split("</p>")[0] + "</p>";
    const at = (h) => first(planDigest(u, [tr], TOPICS, yerevan(h, 5), CONFIG).text);
    assert.equal(at(9), "<p><b>Доброе утро, Rob</b> · 1 история с 14:00</p>");
    assert.equal(at(14), "<p><b>Добрый день, Rob</b> · 1 история с 14:00</p>");
    assert.equal(at(20), "<p><b>Добрый вечер, Rob</b> · 1 история с 14:00</p>");
    const five = Array.from({ length: 5 }, (_, i) => ({ ...story(`News ${i}`, ["politics"], 8), tr_headline: `Новость ${i}`, tr_description: "Текст." }));
    assert.equal(first(planDigest({ ...u, last_digest_at: null }, five, TOPICS, yerevan(20, 5), CONFIG).text),
      "<p><b>Добрый вечер, Rob</b> · 5 историй за последние 24 часа</p>");
    assert.equal(planDigest({ ...u, last_digest_at: yerevan(9, 30) }, [], TOPICS, yerevan(20, 5), CONFIG).text,
      "<p><b>Добрый вечер, Rob</b> · Спокойный период: с 09:30 ничего важного по вашим темам.</p>");
  });

  test("Armenian and French headers", () => {
    const s = { ...story("Big news", ["armenia"], 8), tr_headline: "Նորություն", tr_description: "Մանրամասներ։" };
    const first = (text) => text.split("</p>")[0] + "</p>";
    const hy = planDigest(user("hy"), [s, { ...s, id: nextId++ }], TOPICS, yerevan(20, 5), CONFIG, { lang: "hy" });
    assert.equal(first(hy.text), "<p><b>Բարի երեկո, Rob</b> · 14:00-ից ի վեր 2 նորություն</p>");
    assert.equal(hy.button, "⚙️ Կարգավորումներ");
    const fr = planDigest(user("fr"), [s], TOPICS, yerevan(9, 5), CONFIG, { lang: "fr" });
    assert.equal(first(fr.text), "<p><b>Bonjour, Rob</b> · 1 actualité depuis 14:00</p>");
    assert.equal(fr.button, "⚙️ Réglages");
  });
});

describe("never a mixed-language digest", () => {
  const two = () => {
    const a = story("Armenia and Turkey agree to open the border", ["armenia"], 8, { emojis: "🇦🇲🇹🇷", main_topic: "armenia" });
    const b = story("Ukraine and Russia swap prisoners", ["ukraine_war"], 7);
    return [{ ...a, tr_headline: "Армения и Турция договорились открыть границу", tr_description: "Подробности." },
            { ...b, tr_headline: "Украина и Россия обменялись пленными", tr_description: "Подробности." }];
  };

  test("every story translated: the whole digest is Russian, topic headings too; emojis and outlet unchanged", () => {
    const plan = planDigest(user("ru"), two(), TOPICS, yerevan(20, 5), CONFIG);
    assert.equal(plan.lang, "ru");
    assert.equal(plan.fallback, null);
    assert.match(plan.text, /^<p><b>Добрый вечер, Rob<\/b> · 2 истории с 14:00<\/p>/);
    assert.match(plan.text, /<th align="center">🇦🇲 Армения<\/th><\/tr><\/table><p>🇦🇲🇹🇷 <b>Армения и Турция договорились открыть границу<\/b>/);
    assert.match(plan.text, /<th align="center">🇺🇦 Война на Украине<\/th>/);
    assert.match(plan.text, />Alpha Times<\/a>/);
    assert.equal(plan.button, "⚙️ Настройки");
    assert.doesNotMatch(plan.text, /Armenia and Turkey|Good evening|stories/);
  });

  test("one story without a translation is held (Step 10): the digest stays wholly Russian", () => {
    const [a, b] = two();
    const plan = planDigest(user("ru"), [a, { ...b, tr_headline: null, tr_description: null }], TOPICS, yerevan(20, 5), CONFIG);
    assert.equal(plan.lang, "ru");
    assert.equal(plan.fallback, null);
    assert.deepEqual(plan.heldIds, [b.id]);
    assert.match(plan.text, /^<p><b>Добрый вечер, Rob<\/b> · 1 история с 14:00<\/p>/);
    assert.doesNotMatch(plan.text, /Ukraine and Russia|Good evening|stories/);
  });

  test("no story translated: the WHOLE digest is English, and the fallback is reported", () => {
    const [a, b] = two().map((s) => ({ ...s, tr_headline: null, tr_description: null }));
    const plan = planDigest(user("ru"), [a, b], TOPICS, yerevan(20, 5), CONFIG);
    assert.equal(plan.lang, "en");
    assert.deepEqual(plan.fallback, { lang: "ru", missing: 2, of: 2 });
    assert.match(plan.text, /^<p><b>Good evening, Rob<\/b> · 2 stories since 2 PM<\/p>/);
    assert.match(plan.text, /<th align="center">🇦🇲 Armenia<\/th>/);
    assert.equal(plan.button, "⚙️ Settings");
    assert.doesNotMatch(plan.text, /[А-Яа-яЁё]/);   // not one Russian letter
  });

  test("a quiet note is always in the reader's language; a hidden language means English with no fallback", () => {
    assert.match(planDigest(user("ru"), [], TOPICS, yerevan(20, 5), CONFIG).text, /^<p><b>Добрый вечер, Rob<\/b> · Спокойный период/);
    const hidden = LANGS.enabled.includes("hy") ? null : planDigest(user("hy"), two(), TOPICS, yerevan(20, 5), CONFIG);
    if (hidden) {
      assert.equal(hidden.lang, "en");
      assert.equal(hidden.fallback, null);
    }
  });

  test("candidate SQL: a translation counts only while it was made from the current English text", async () => {
    const { db, sqlite } = fakeD1();
    const now = yerevan(20, 5);
    const id = addStory(sqlite, "Summary", ["politics"], 6, now - 3600, { final_score: 8, headline: "Old headline", description: "Desc." });
    addTranslation(sqlite, id, "ru", "Старый заголовок", "Описание.");
    addTranslation(sqlite, id, "fr", "Mauvais", null, { ok: 0 });
    const u = { ...user("ru"), last_digest_at: null };
    const q = async (lang) => (await db.batch([candidateStatement(u, now, CONFIG, lang)]))[0][0];
    assert.equal((await q("ru")).tr_headline, "Старый заголовок");
    assert.equal((await q("fr")).tr_headline, null);          // a rejected attempt (ok = 0) is never used
    assert.equal((await q("en")).tr_headline, null);
    sqlite.prepare("UPDATE stories SET headline = 'Rewritten headline' WHERE id = ?").run(id);
    assert.equal((await q("ru")).tr_headline, null);          // stale: the editor rewrote the English
    assert.equal(candidateStatement(u, now).params[9], "ru");
  });

  test("no story translated: the cron sends the English digest, logs the fallback, and Admin counts it per language", async () => {
    const { db, sqlite } = fakeD1();
    const now = yerevan(14, 2);
    addUser(sqlite, { lang: "ru", next_digest_at: yerevan(14), last_digest_at: yerevan(9) });
    const a = addStory(sqlite, "A", ["armenia"], 6, now - 600, { final_score: 8, headline: "Armenia story" });
    addStory(sqlite, "B", ["politics"], 6, now - 600, { final_score: 8, headline: "Politics story" });
    assert.ok(a);
    const outbox = [];
    const io = { send: async (chat, text) => outbox.push(text), alert: async () => {} };
    const out = await runTick(db, io, now);
    assert.equal(out.lang_fallback, 1);
    assert.match(outbox[0], /^<p><b>Good afternoon, Owner<\/b> · 2 stories since 9 AM<\/p>/);
    const err = sqlite.prepare("SELECT component, message FROM errors WHERE component = 'digest'").get();
    assert.match(err.message, /^language fallback \(ru\): user 42 got English, none of 2 stories has a ru translation/);
    const admin = shapeAdmin(await db.batch(adminStatements(now)), now);
    const ru = admin.languages.find((l) => l.code === "ru");
    assert.equal(ru.fallbacks_24h, 1);
    assert.equal(ru.active, 1);
    assert.equal(admin.users.list[0].lang, "ru");
  });

  test("a fully translated digest from the cron is Russian and logs nothing", async () => {
    const { db, sqlite } = fakeD1();
    const now = yerevan(14, 2);
    addUser(sqlite, { lang: "ru", next_digest_at: yerevan(14), last_digest_at: yerevan(9) });
    const a = addStory(sqlite, "A", ["armenia"], 6, now - 600, { final_score: 8, headline: "Armenia story" });
    addTranslation(sqlite, a, "ru", "История об Армении");
    const outbox = [];
    const out = await runTick(db, { send: async (c, text) => outbox.push(text), alert: async () => {} }, now);
    assert.equal(out.lang_fallback, undefined);
    assert.match(outbox[0], /^<p><b>Добрый день, Owner<\/b> · 1 история с 09:00<\/p><table bordered><tr><th align="center">🇦🇲 Армения<\/th><\/tr><\/table><p>.*История об Армении/);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM errors").get().n, 0);
  });
});

describe("language defaults and the language setting", () => {
  const post = (text, from) => new Request("https://w.test/telegram", {
    method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, from, chat: { id: from.id, type: "private" }, text } }) });
  const langOf = (sqlite, id = OWNER) => sqlite.prepare("SELECT lang FROM users WHERE id = ?").get(id).lang;

  test("chooseLang: Telegram's code if enabled, its primary subtag, otherwise English", () => {
    assert.equal(chooseLang("ru"), "ru");
    assert.equal(chooseLang("ru-RU"), "ru");
    assert.equal(chooseLang("RU"), "ru");
    assert.equal(chooseLang("de"), "en");
    assert.equal(chooseLang(undefined), "en");
    assert.equal(chooseLang("hy"), LANGS.enabled.includes("hy") ? "hy" : "en");
    assert.equal(effectiveLang({ lang: "xx" }), "en");
  });

  test("first /start from a Russian Telegram: Russian user, Russian reply and button, per-chat menu and commands", async () => {
    const { binding, sqlite } = fakeD1();
    fetchMock = mockFetch(() => undefined);
    await worker.fetch(post("/start", { id: OWNER, first_name: "Rob", language_code: "ru" }), env(binding));
    assert.equal(langOf(sqlite), "ru");
    const [reply, ...setup] = fetchMock.calls;
    assert.match(reply.body.text, /^Добро пожаловать в Axiom News, Rob!/);
    assert.match(reply.body.text, /в 09:00, 14:00 и 20:00 \(часовой пояс: Ереван\)/);
    assert.match(reply.body.text, /Темы: Политика, Войны и конфликты, Армения, Россия, Война в Иране и Война на Украине\./);
    assert.equal(reply.body.reply_markup.inline_keyboard[0][0].text, "Открыть настройки");
    const cmd = setup.find((c) => c.url.endsWith("/setMyCommands")).body;
    assert.deepEqual(cmd.scope, { type: "chat", chat_id: OWNER });
    assert.equal(cmd.commands[1].description, "Открыть настройки");
    assert.equal(setup.find((c) => c.url.endsWith("/setChatMenuButton")).body.menu_button.text, "Настройки");
  });

  test("first /start from other Telegram languages: ru-RU is Russian; a hidden or unknown one is English", async () => {
    for (const [code, want] of [["ru-RU", "ru"], ["de", "en"], [undefined, "en"], ["hy", LANGS.enabled.includes("hy") ? "hy" : "en"]]) {
      const { binding, sqlite } = fakeD1();
      fetchMock = mockFetch(() => undefined);
      await worker.fetch(post("/start", { id: OWNER, first_name: "Rob", language_code: code }), env(binding));
      assert.equal(langOf(sqlite), want, String(code));
      if (want === "en") assert.equal(fetchMock.calls.length, 1, "an English user needs no per-chat setup");
      fetchMock.restore();
    }
  });

  test("a later /start never changes the language (only the Mini App does)", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { lang: "en" });
    fetchMock = mockFetch(() => undefined);
    await worker.fetch(post("/start", { id: OWNER, first_name: "Rob", language_code: "ru" }), env(binding));
    assert.equal(langOf(sqlite), "en");
    assert.match(fetchMock.calls[0].body.text, /^Welcome back, Rob!/);
    sqlite.prepare("UPDATE users SET lang = 'ru'").run();
    await worker.fetch(post("/start", { id: OWNER, first_name: "Rob", language_code: "en" }), env(binding));
    assert.equal(langOf(sqlite), "ru");
    assert.match(fetchMock.calls[1].body.text, /^С возвращением, Rob!/);
    await worker.fetch(post("hello", { id: OWNER, first_name: "Rob", language_code: "en" }), env(binding));
    assert.match(fetchMock.calls[2].body.text, /^Я присылаю сводки новостей в 09:00, 14:00 и 20:00/);
  });

  const nowS = () => Math.floor(Date.now() / 1000);
  const initFor = (id, code) => signInitData({ query_id: "AAE1", auth_date: String(nowS()), signature: "sig",
    user: JSON.stringify({ id, first_name: "Rob", language_code: code }) }, TOKEN);
  async function call(binding, path, init, body) {
    const res = await worker.fetch(new Request(`https://w.test${path}`, { method: "POST",
      headers: { authorization: `tma ${init}` }, body: JSON.stringify(body) }), env(binding));
    return { status: res.status, body: await res.json() };
  }

  test("first Mini App open (before /start) uses the same default; later opens never change it", async () => {
    const { binding, sqlite } = fakeD1();
    fetchMock = mockFetch(() => undefined);
    const r = await call(binding, "/api/open", await initFor(OWNER, "ru"), { tz: TZ });
    assert.equal(langOf(sqlite), "ru");
    assert.equal(r.body.user.lang, "ru");
    assert.equal(r.body.topics.find((x) => x.tag === "armenia").label, "Армения");
    assert.deepEqual(r.body.languages.map((l) => l.code), LANGS.enabled);
    await call(binding, "/api/open", await initFor(OWNER, "en"), { tz: TZ });
    assert.equal(langOf(sqlite), "ru");
  });

  test("the language setting: saved instantly, enabled languages only, the chat menu and commands follow", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { lang: "en" });
    fetchMock = mockFetch(() => undefined);
    const init = await initFor(OWNER, "en");
    const ok = await call(binding, "/api/settings", init, { lang: "ru" });
    assert.equal(ok.status, 200);
    assert.equal(langOf(sqlite), "ru");
    assert.equal(ok.body.user.lang, "ru");
    assert.equal(ok.body.topics[0].label, "Политика");
    assert.deepEqual(fetchMock.calls.map((c) => c.url.split("/").pop()).sort(), ["setChatMenuButton", "setMyCommands"]);
    for (const bad of ["xx", 5, ...(LANGS.enabled.includes("fr") ? [] : ["fr"])]) {
      const r = await call(binding, "/api/settings", init, { lang: bad });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, "lang_bad");
      assert.equal(r.body.error, "That language is not available.");
    }
    assert.equal(langOf(sqlite), "ru");
  });

  test("a Telegram failure while setting the chat language is logged; the setting is still saved", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { lang: "en" });
    fetchMock = mockFetch(() => ({ status: 400, body: { ok: false, description: "Bad Request" } }));
    const r = await call(binding, "/api/settings", await initFor(OWNER, "en"), { lang: "ru" });
    assert.equal(r.status, 200);
    assert.equal(langOf(sqlite), "ru");
    assert.match(sqlite.prepare("SELECT message FROM errors").get().message, /setMyCommands for 42/);
  });

  test("errors carry a code the Mini App translates", async () => {
    const { binding, sqlite } = fakeD1();
    addUser(sqlite, { lang: "ru" });
    fetchMock = mockFetch(() => undefined);
    const r = await call(binding, "/api/settings", await initFor(OWNER, "ru"), { topics: [] });
    assert.deepEqual([r.status, r.body.code], [400, "keep_topic"]);
    assert.equal(t("ru", `errors.${r.body.code}`), "Оставьте хотя бы одну тему.");
  });
});

describe("the stories the job translates = the stories digests can pick", () => {
  test("worker qualifies() agrees with tests/fixtures/eligible_cases.json (also checked by the Python job tests)", () => {
    const data = JSON.parse(read("tests/fixtures/eligible_cases.json"));
    const cfg = { ...CONFIG, ...data.cfg };
    const wrong = data.cases.filter((c) => qualifies({ ...c, topics: JSON.stringify(c.topics) }, data.tags, cfg) !== c.eligible);
    assert.deepEqual(wrong.map((c) => c.id), []);
    assert.ok(data.cases.some((c) => c.eligible) && data.cases.some((c) => !c.eligible));
  });

  test("primaryTopic is unchanged by language (sections follow the English tags)", () => {
    assert.equal(primaryTopic(["armenia", "politics"], ALL, CONFIG.topic_specificity, "armenia"), "armenia");
  });
});
