// Step 11: the digest design the owner chose ("E5f"), a Telegram rich message. Checks that the length
// cut counts what Telegram counts and never lets a digest pass the limit, in every language; that
// each language renders the same shape; no em/en dash; the editor's emojis, no story numbers, a line
// between topics; and the "⚙️ Settings" button under every digest and quiet note, sent the right way.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CONFIG, FORBIDDEN, LAYOUT, RICH, buildMessage, fitToLength, pickStories, planDigest, topicInfoFrom } from "../src/digest.js";
import { DICTS, LANGS, t } from "../src/i18n.js";
import { digestExtra, sendDigest } from "../src/cron.js";
import { sendDigestMessage } from "../src/telegram.js";
import { ALL, OWNER, TOPIC_ROWS, TZ, mockFetch, yerevan } from "./helpers.mjs";

const TOPICS = TOPIC_ROWS.map(([tag, label_en, emoji, sort]) => ({ tag, label_en, emoji, sort, is_default: 1 }));
const LANG_CODES = ["en", "ru", "hy", "fr"];
const CYR = /[А-Яа-яЁё]/, ARM = /[Ա-և]/;
let nextId = 1;
let fetchMock;
afterEach(() => fetchMock?.restore());

// A seeded random generator, so the fuzz tests are repeatable.
function rng(seed) {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const user = (lang, extra = {}) => ({ id: OWNER, first_name: "Sam", lang, topics: JSON.stringify(ALL), timezone: TZ,
  digest_times: '["09:00","14:00","20:00"]', last_digest_at: yerevan(9), ...extra });
// Text in each language, about as long as the real translations (Russian ~7% longer than English).
const WORD = { en: "word", ru: "слово", hy: "բառը", fr: "mot" };
const say = (lang, n, r) => Array.from({ length: n }, () => WORD[lang]).join(" ") + (r() < 0.3 ? " 1,200 & <b>" : "");

function pool(r, lang, n) {
  return Array.from({ length: n }, (_, i) => {
    const tag = ALL[Math.floor(r() * ALL.length)];
    const g = 7 + Math.floor(r() * 3);
    const headline = `Story ${i} ${say("en", 2 + Math.floor(r() * 25), r)}`;
    const description = r() < 0.85 ? `${say("en", 5 + Math.floor(r() * 70), r)}.` : null;
    return {
      id: nextId++, summary: headline, headline, description, topics: JSON.stringify([tag]), main_topic: tag,
      importance: 6, final_score: g, topic_score: g, updated_at: yerevan(13), best_url: `https://x.test/${i}?a=1&b=2`,
      best_source: `Outlet ${"x".repeat(Math.floor(r() * 25))}`, emojis: r() < 0.8 ? ["🇦🇲🇹🇷🤝", "🇺🇦🇷🇺💥", "🛢️"][i % 3] : null,
      tr_headline: lang === "en" ? null : `${say(lang, 2 + Math.floor(r() * 25), r)} ${i}`,
      tr_description: lang === "en" || !description ? null : `${say(lang, 5 + Math.floor(r() * 75), r)}.`,
    };
  });
}

describe("the length cut counts what Telegram counts (Step 11 rich message)", () => {
  test("200 random digests in en, ru, hy and fr: never over the limit, the estimate never under the real length", () => {
    const r = rng(11);
    for (let k = 0; k < 200; k++) {
      const lang = LANG_CODES[k % 4];
      const list = pool(r, lang, 1 + Math.floor(r() * 40));
      const limit = 600 + Math.floor(r() * 3300);
      const cfg = { ...CONFIG, message_char_limit: limit };
      const plan = planDigest(user(lang), list, TOPICS, yerevan(14, 5), cfg, { lang });
      assert.equal(plan.lang, lang);
      assert.ok(RICH.count(plan.text) <= limit, `digest ${k} (${lang}): ${RICH.count(plan.text)} > ${limit}`);
      assert.ok(RICH.count(plan.text) <= 4096);
      assert.ok(plan.storyIds.length >= 1);
    }
  });

  test("the estimate is exact up to the count placeholders: one character less and a story goes, a few more and all stay", () => {
    const r = rng(7);
    for (let k = 0; k < 120; k++) {
      const lang = LANG_CODES[k % 4];
      const picked = pickStories(pool(r, lang, 2 + Math.floor(r() * 6)), ALL, CONFIG)
        .map((s) => (lang === "en" ? s : { ...s, headline: s.tr_headline, summary: s.tr_headline, description: s.tr_description }));
      const opts = { now: yerevan(14, 5), tz: TZ, lastDigestAt: yerevan(9), name: "Sam", lang, topicInfo: topicInfoFrom(TOPICS, lang) };
      const real = RICH.count(buildMessage(picked, opts).text);
      const tight = fitToLength(picked, opts, { ...CONFIG, message_char_limit: real - 1 });
      assert.ok(tight.cut.length >= 1, `${lang} ${k}: the estimate was under the real length ${real}`);
      // "99" for the story count and the longest plural form: at most 3 characters more than real
      const loose = fitToLength(picked, opts, { ...CONFIG, message_char_limit: real + 3 });
      assert.equal(loose.cut.length, 0, `${lang} ${k}: the estimate is more than 3 over the real length ${real}`);
    }
  });

  test("Telegram stores the text of the blocks with no separators: tags and the URLs do not count, entities count as one", () => {
    const s = { id: 1, primary: "armenia", headline: "A & B", description: "C <D>", best_url: "https://x.test/?a=1&b=2",
      best_source: "Outlet", emojis: "🇦🇲" };
    const text = buildMessage([s], { now: yerevan(20, 5), tz: TZ, lastDigestAt: yerevan(14), name: "Sam",
      topicInfo: topicInfoFrom(TOPICS) }).text;
    assert.equal(RICH.count(text), "Good evening, Sam · 1 story since 2 PM🇦🇲 Armenia🇦🇲 A & B · OutletC <D>".length);
  });
});

describe("every language renders the same design", () => {
  for (const lang of LANG_CODES) {
    test(`${lang}: greeting line, a centred box per topic, a line between topics, the editor's emojis, outlet link, quote box`, () => {
      const r = rng(3);
      const list = pool(r, lang, 6).map((s, i) => ({ ...s, topics: JSON.stringify([ALL[i % 3]]), main_topic: ALL[i % 3],
        emojis: "🇦🇲🇹🇷🤝", description: s.description ?? "Text.", tr_description: lang === "en" ? null : (s.tr_description ?? "Текст.") }));
      const plan = planDigest(user(lang), list, TOPICS, yerevan(20, 5), CONFIG, { lang });
      const T = plan.text;
      assert.equal(plan.lang, lang);
      assert.equal(plan.kind, "rich");
      assert.equal(plan.button, t(lang, "digest.settings_button"));
      assert.match(plan.button, /^⚙️ /);
      const hello = t(lang, "digest.hello_name", { greeting: t(lang, "digest.greeting_evening"), name: "Sam" });
      assert.ok(T.startsWith(`<p><b>${hello}</b> · `), T.slice(0, 80));
      const sections = [...T.matchAll(/<table bordered><tr><th align="center">([^<]+)<\/th><\/tr><\/table>/g)].map((m) => m[1]);
      assert.equal(sections.length, 3);
      for (const [i, tag] of ALL.slice(0, 3).entries()) {
        const info = topicInfoFrom(TOPICS, lang)[tag];
        assert.ok(sections.includes(`${info.emoji} ${info.label.replace(/&/g, "&amp;")}`), `${lang} heading ${i}: ${sections}`);
      }
      assert.equal((T.match(/<hr\/>/g) ?? []).length, sections.length - 1);           // between topics only
      assert.ok(!T.includes("</p><hr/><table") || T.indexOf("<hr/>") > T.indexOf("</table>"));   // none before the first box
      const stories = [...T.matchAll(/<p>(🇦🇲🇹🇷🤝) <b>[^<]+<\/b> <i>· <a href="[^"]+">[^<]+<\/a><\/i><\/p><blockquote>[^<]+<\/blockquote>/g)];
      assert.equal(stories.length, plan.storyIds.length);                              // every story has the full shape
      assert.doesNotMatch(T, /<p>\d+\. /);                                             // no numbers
      if (lang === "ru") assert.match(T, CYR);
      if (lang === "hy") assert.match(T, ARM);
      if (lang !== "en") assert.doesNotMatch(T, /Good evening|stories since/);
    });
  }

  test("the quiet note has the same shape in every language (enabled or not)", () => {
    for (const lang of LANG_CODES) {
      const plan = planDigest(user(lang), [], TOPICS, yerevan(20, 5), CONFIG, { lang });
      const hello = t(lang, "digest.hello_name", { greeting: t(lang, "digest.greeting_evening"), name: "Sam" });
      assert.equal(plan.text, `<p><b>${hello}</b> · ${t(lang, "digest.quiet_line", { since: t(lang, "digest.since_mid", { time: lang === "en" ? "9 AM" : "09:00" }) })}</p>`);
      assert.equal(plan.kind, "rich");
      assert.equal(plan.button, t(lang, "digest.settings_button"));
    }
    assert.ok(LANGS.enabled.includes("ru"));
  });
});

describe("owner rules in the new format", () => {
  test("no em or en dash anywhere: not in any new text, not in a digest built from texts full of them", () => {
    for (const lang of LANG_CODES) {
      for (const k of ["count_line", "quiet_line", "settings_button"]) {
        assert.ok(DICTS[lang].digest[k], `${lang} digest.${k} missing`);
        assert.doesNotMatch(DICTS[lang].digest[k], FORBIDDEN, `${lang} digest.${k}`);
      }
      const dashy = [{ id: nextId++, summary: "x", headline: "Talks — day two", description: "Both sides – met — again.",
        topics: '["politics"]', main_topic: "politics", final_score: 8, best_url: "https://x.test/a", best_source: "Outlet — X",
        tr_headline: "Переговоры — второй день", tr_description: "Стороны – встретились." }];
      const plan = planDigest(user(lang), dashy, TOPICS, yerevan(20, 5), CONFIG, { lang });
      assert.doesNotMatch(plan.text, FORBIDDEN, lang);
    }
    assert.throws(() => buildMessage([], { now: yerevan(20), tz: TZ, label: "Preview — A", topicInfo: {} }), /dash/);
  });

  test("the editor's 2-3 emojis are shown in full; a story without them gets the dictionary emoji", () => {
    const a = { id: nextId++, summary: "x", headline: "Talks resume", topics: '["politics"]', main_topic: "politics", final_score: 8,
      best_url: "https://x.test/a", best_source: "O", emojis: "🇺🇸🇮🇷🕊️" };
    const b = { ...a, id: nextId++, headline: "Iran fires missiles at a tanker", emojis: null };
    const T = planDigest(user("en"), [a, b], TOPICS, yerevan(20, 5), CONFIG).text;
    assert.match(T, /<p>🇺🇸🇮🇷🕊️ <b>Talks resume<\/b>/);
    assert.match(T, /<p>🇮🇷 <b>Iran fires missiles at a tanker<\/b>/);
  });

  test("LAYOUT is the rich design; the Step 5 format is only used when asked for", () => {
    assert.equal(LAYOUT, RICH);
    assert.equal(RICH.kind, "rich");
  });
});

describe("the ⚙️ Settings button and how a digest is sent", () => {
  const APP = "https://w.test/app/";
  const plan = (lang) => planDigest(user(lang), [], TOPICS, yerevan(20, 5), CONFIG, { lang });

  test("digestExtra: the rich kind and one web_app button in the digest's language; none without the app's address", () => {
    assert.deepEqual(digestExtra(plan("ru"), APP),
      { kind: "rich", reply_markup: { inline_keyboard: [[{ text: "⚙️ Настройки", web_app: { url: APP } }]] } });
    assert.deepEqual(digestExtra(plan("en"), APP).reply_markup.inline_keyboard[0][0].text, "⚙️ Settings");
    assert.deepEqual(digestExtra(plan("en"), undefined), { kind: "rich" });
  });

  test("sendDigest passes the text, the kind and the button to io.send", async () => {
    const calls = [];
    const p = plan("en");
    await sendDigest({ send: async (...a) => calls.push(a), appUrl: APP }, 5, p);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 5);
    assert.equal(calls[0][1], p.text);
    assert.equal(calls[0][2].reply_markup.inline_keyboard[0][0].web_app.url, APP);
  });

  test("sendDigestMessage: rich goes to sendRichMessage (no automatic links), html to sendMessage (previews off)", async () => {
    fetchMock = mockFetch(() => ({ status: 200, body: { ok: true, result: { message_id: 1 } } }));
    const extra = digestExtra(plan("en"), APP);
    await sendDigestMessage("T", 7, "<p>x</p>", extra);
    await sendDigestMessage("T", 7, "<b>x</b>", { ...extra, kind: "html" });
    const [rich, html] = fetchMock.calls;
    assert.match(rich.url, /\/sendRichMessage$/);
    assert.deepEqual(rich.body, { chat_id: 7, rich_message: { html: "<p>x</p>", skip_entity_detection: true },
      reply_markup: extra.reply_markup });
    assert.match(html.url, /\/sendMessage$/);
    assert.equal(html.body.parse_mode, "HTML");
    assert.deepEqual(html.body.link_preview_options, { is_disabled: true });
    assert.deepEqual(html.body.reply_markup, extra.reply_markup);
    assert.equal(html.body.kind, undefined);   // "kind" is ours, never sent to Telegram
    assert.equal(rich.body.kind, undefined);
  });
});
