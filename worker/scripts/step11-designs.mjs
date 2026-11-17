// Step 11: five digest designs for the owner, on the TEST bot only (token from ../.env, never
// printed). The SAME 10 real recent stories (all six topics, each with a checked Russian translation
// in D1) are built by the real planDigest with five layouts, each message labelled "Design A" ...
// "Design E" and carrying the "⚙️ Settings" button; then design B and my favourite again in
// Russian. Records nothing. After each send, Telegram's own count of the text (message.text) is
// compared with ours, and the formatting it kept (entities) with what we sent.
//   node scripts/step11-designs.mjs --dry      print the messages and their lengths, send nothing
//   node scripts/step11-designs.mjs            send (refuses unless the bot is the TEST bot)
//   node scripts/step11-designs.mjs --only E1,E2,E3,E4 --ru E3     round 2: rich-message variants
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv, d1Rest } from "./digest-cli.mjs";
import { CLASSIC, CONFIG, escapeHtml, planDigest, storyLink, visibleLength } from "../src/digest.js";
import { plural, t } from "../src/i18n.js";
import { settingsButton, tgCall } from "../src/telegram.js";

const TEST_BOT = "justatia_bot";
const IDS = [518, 2707, 2824, 2715, 3, 1531, 355, 2764, 2616, 2734];
const FAVOURITE = "C";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const APP_URL = /^APP_URL\s*=\s*"([^"]+)"/m.exec(readFileSync(`${ROOT}worker/wrangler.toml`, "utf8"))?.[1];
const env = loadEnv();
const db = d1Rest(env);
const owner = Number(env.OWNER_TELEGRAM_ID);
const dry = process.argv.includes("--dry");
const now = Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------ the designs

// One emoji per story: the first of the editor's 2-3. A flag (two regional letters), a keycap, a
// sequence joined by ZWJ and a skin tone each count as ONE emoji. A regex, no Intl.Segmenter
// (Intl is the costly part of a cold Worker).
const EMOJI_RE = /\p{Regional_Indicator}{2}|[#*0-9]️?⃣|\p{Extended_Pictographic}(?:️|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}])*(?:‍\p{Extended_Pictographic}(?:️|[\u{1F3FB}-\u{1F3FF}])*)*/u;
function firstEmoji(text) {
  return EMOJI_RE.exec(String(text ?? ""))?.[0] ?? "";
}


const emojiOf = (s) => firstEmoji(s.emojis || s.fallbackEmoji);
const lead = (s) => (emojiOf(s) ? `${emojiOf(s)} ` : "");
// B-E share: a one-line header ("<b>Good evening, Rob</b> · 10 stories since 2 PM"), the quiet note in
// the same shape, and topic titles as quiet section labels (capitals, normal weight, no emoji).
const shared = {
  label: (x) => `<i>${x}</i>`,
  header: ({ hello, since, lang }, count) =>
    `<b>${hello}</b> · ${t(lang, "digest.count_line", { count, stories: plural(lang, count, "digest.stories"), since })}`,
  quiet: ({ hello, since, lang }) => `<b>${hello}</b> · ${t(lang, "digest.quiet_line", { since })}`,
  heading: (x) => escapeHtml(x.label.toUpperCase()),
};
const html = { kind: "html", gap: "\n\n", count: visibleLength };

const DESIGNS = {
  A: { ...CLASSIC, label: (x) => `<i>${x}</i>`, about: "today's format, for comparison" },
  B: { ...html, ...shared, about: "clean list: the headline is the link, the outlet in italics after it",
    story: (s) => `${lead(s)}${storyLink(s, `<b>${escapeHtml(s.headline)}</b>`)} <i>· ${escapeHtml(s.best_source)}</i>` +
      (s.description ? `\n${escapeHtml(s.description)}` : "") },
  C: { ...html, ...shared, about: "cards: the description and the outlet link inside a quote",
    story: (s) => `${lead(s)}<b>${escapeHtml(s.headline)}</b>\n<blockquote>` +
      `${s.description ? `${escapeHtml(s.description)}\n` : ""}${storyLink(s, escapeHtml(s.best_source))}</blockquote>` },
  D: { ...html, ...shared, about: "headlines first: tap a quote to open the description",
    story: (s) => `${lead(s)}${storyLink(s, `<b>${escapeHtml(s.headline)}</b>`)}\n<blockquote expandable>` +
      `${s.description ? `${escapeHtml(s.description)}\n` : ""}<i>${escapeHtml(s.best_source)}</i></blockquote>` },
  E: { kind: "rich", gap: "", count: visibleLength, about: "a Telegram rich message (new in 2026): real section headings and dividers",
    label: (x) => `<p><i>${x}</i></p>`,
    header: (p, count) => `<p>${shared.header(p, count)}</p>`,
    quiet: (p) => `<p>${shared.quiet(p)}</p>`,
    heading: (x) => `<hr/><h4>${escapeHtml(x.label)}</h4>`,
    story: (s) => `<p>${lead(s)}${storyLink(s, `<b>${escapeHtml(s.headline)}</b>`)}</p>` +
      `<p>${s.description ? `${escapeHtml(s.description)} ` : ""}<i>${escapeHtml(s.best_source)}</i></p>` },
};

// Round 2 (owner chose E): rich-message variants. Topic titles with their emoji and more weight, the
// editor's 2-3 emojis per story again, the outlet on its own last line or right after the title.
const allEmojis = (s) => { const e = s.emojis || s.fallbackEmoji; return e ? `${e} ` : ""; };
const rich = { kind: "rich", gap: "", count: visibleLength, label: DESIGNS.E.label, header: DESIGNS.E.header, quiet: DESIGNS.E.quiet };
const topicTitle = (x) => `${x.emoji ? `${x.emoji} ` : ""}${escapeHtml(x.label)}`;
Object.assign(DESIGNS, {
  E1: { ...rich, about: "big heading with the topic emoji; the outlet on its own last line",
    heading: (x) => `<h3>${topicTitle(x)}</h3>`,
    story: (s) => `<p>${allEmojis(s)}${storyLink(s, `<b>${escapeHtml(s.headline)}</b>`)}</p>` +
      `<p>${s.description ? `${escapeHtml(s.description)}<br>` : ""}<i>${escapeHtml(s.best_source)}</i></p>` },
  E2: { ...rich, about: "divider and a larger heading; the outlet right after the title",
    heading: (x) => `<hr/><h2>${topicTitle(x)}</h2>`,
    story: (s) => `<p>${allEmojis(s)}${storyLink(s, `<b>${escapeHtml(s.headline)}</b>`)} <i>· ${escapeHtml(s.best_source)}</i></p>` +
      (s.description ? `<p>${escapeHtml(s.description)}</p>` : "") },
  E3: { ...rich, about: "heading in capitals with the emoji; the description in a quote, the outlet signed under it",
    heading: (x) => `<h3>${x.emoji ? `${x.emoji} ` : ""}${escapeHtml(x.label.toUpperCase())}</h3>`,
    story: (s) => `<p>${allEmojis(s)}${storyLink(s, `<b>${escapeHtml(s.headline)}</b>`)}</p>` +
      `<blockquote>${s.description ? escapeHtml(s.description) : ""}<cite>${escapeHtml(s.best_source)}</cite></blockquote>` },
  E4: { ...rich, about: "highlighted heading; the outlet as a link on its own last line",
    heading: (x) => `<h3><mark>${topicTitle(x)}</mark></h3>`,
    story: (s) => `<p>${allEmojis(s)}<b>${escapeHtml(s.headline)}</b></p>` +
      `<p>${s.description ? `${escapeHtml(s.description)}<br>` : ""}${storyLink(s, `${escapeHtml(s.best_source)} ↗`)}</p>` },
  // Round 3 (owner): E2 exactly, but the description inside E3's quote box.
  E5: { ...rich, about: "E2 with the description in a quote box",
    heading: (x) => `<hr/><h2>${topicTitle(x)}</h2>`,
    story: (s) => `<p>${allEmojis(s)}${storyLink(s, `<b>${escapeHtml(s.headline)}</b>`)} <i>· ${escapeHtml(s.best_source)}</i></p>` +
      (s.description ? `<blockquote>${escapeHtml(s.description)}</blockquote>` : "") },
});
// Round 4 (owner chose E5): the same, only the topic title shown differently (centred or otherwise).
Object.assign(DESIGNS, {
  E5a: { ...DESIGNS.E5, about: "E5, topic as a centred pull quote", heading: (x) => `<aside>${topicTitle(x)}</aside>` },
  E5b: { ...DESIGNS.E5, about: "E5, topic in a centred one-cell table",
    heading: (x) => `<table bordered><tr><th align="center">${topicTitle(x)}</th></tr></table>` },
  E5c: { ...DESIGNS.E5, about: "E5, topic as the largest heading", heading: (x) => `<hr/><h1>${topicTitle(x)}</h1>` },
  E5d: { ...DESIGNS.E5, about: "E5, topic between two dividers", heading: (x) => `<hr/><h2>${topicTitle(x)}</h2><hr/>` },
});
// Round 5 (owner): E5b, but the headline is plain bold text and the outlet is the link.
DESIGNS.E5e = { ...DESIGNS.E5b, about: "E5b, the headline as plain text and the outlet as the link",
  story: (s) => `<p>${allEmojis(s)}<b>${escapeHtml(s.headline)}</b> <i>· ${storyLink(s, escapeHtml(s.best_source))}</i></p>` +
    (s.description ? `<blockquote>${escapeHtml(s.description)}</blockquote>` : "") };
// Round 6 (owner's final choice): E5e with a divider line where one topic ends and the next begins.
DESIGNS.E5f = { ...DESIGNS.E5e, about: "E5e with a line between topics",
  heading: (x, i) => `${i ? "<hr/>" : ""}${DESIGNS.E5e.heading(x)}` };

// ------------------------------------------------------------------ the stories

const [[user], topics] = await db.batch([
  { sql: "SELECT * FROM users WHERE id = ?1", params: [owner] },
  { sql: "SELECT tag, label_en, emoji, sort, is_default FROM topics ORDER BY sort", params: [] },
]);
const rows = await db.query(
  `SELECT s.id, s.summary, s.headline, s.description, s.emojis, s.best_url, s.best_source, s.importance, s.final_score,
          s.topic_score, s.topics, s.main_topic, s.updated_at, s.dup_group, tr.headline AS tr_headline, tr.description AS tr_description
   FROM stories s LEFT JOIN story_translations tr ON tr.story_id = s.id AND tr.lang = 'ru' AND tr.ok = 1
     AND tr.src = coalesce(s.headline, s.summary) || char(10) || coalesce(s.description, '')
   WHERE s.id IN (${IDS.map(() => "?").join(",")})`, IDS);
if (rows.length !== IDS.length || rows.some((r) => !r.tr_headline)) throw new Error("a story or its Russian translation is missing");
// The owner as a reader of all six topics, last digest 6 hours ago.
const reader = { ...user, topics: JSON.stringify(topics.map((x) => x.tag)), last_digest_at: Math.floor((now - 6 * 3600) / 3600) * 3600 };

const tags = (text) => (text.match(/<(b|i|u|a|blockquote)[\s>]/g) ?? []).length;
const out = [];
// --only E1,E2 (English) and --ru E3 (Russian) pick what is sent; the default is round 1.
const pick = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1].split(","); };
const only = pick("--only"), ru = pick("--ru");
const runs = only || ru ? [...(only ?? []).map((k) => [k, "en"]), ...(ru ?? []).map((k) => [k, "ru"])]
  : [...["A", "B", "C", "D", "E"].map((k) => [k, "en"]), ["B", "ru"], [FAVOURITE, "ru"]];
for (const [key, lang] of runs) {
  const L = DESIGNS[key];
  const label = `Design ${key}${lang === "ru" ? " (in Russian)" : ""}: ${L.about}. A preview, nothing is recorded.`;
  const plan = planDigest(reader, rows, topics, now, CONFIG, { lang, layout: L, label });
  const chars = L.count(plan.text);
  console.log(`Design ${key} ${lang}: ${plan.stories.length} stories, ${plan.cut} cut, ${chars} characters (limit ${CONFIG.message_char_limit})`);
  if (plan.stories.length !== IDS.length) console.log(`  NOTE: not all ${IDS.length} stories fit`);
  out.push({ key, lang, plan, chars });
}

if (dry) {
  for (const m of out) console.log(`\n----- Design ${m.key} ${m.lang} (${m.chars})\n${m.plan.text}`);
  process.exit(0);
}
const me = await tgCall(env.TELEGRAM_BOT_TOKEN, "getMe", {});
if (me.username !== TEST_BOT) throw new Error(`refusing: the bot in .env is @${me.username}, not the TEST bot`);
for (const m of out) {
  // the button the digests had when these previews were sent (removed in Step 14, owner)
  const markup = settingsButton(APP_URL, m.lang === "ru" ? "⚙️ Настройки" : "⚙️ Settings").reply_markup;
  try {
    if (m.plan.kind === "rich") {
      const r = await tgCall(env.TELEGRAM_BOT_TOKEN, "sendRichMessage", { chat_id: owner,
        rich_message: { html: m.plan.text, skip_entity_detection: true }, reply_markup: markup });
      console.log(`sent Design ${m.key} ${m.lang} as a rich message: id ${r.message_id}, ${(r.rich_message?.blocks ?? []).length} blocks back`);
      if (process.argv.includes("--blocks")) writeFileSync(`${process.env.BLOCKS_DIR ?? "."}/blocks-${m.key}-${m.lang}.json`, JSON.stringify(r.rich_message, null, 1));
    } else {
      const r = await tgCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", { chat_id: owner, text: m.plan.text, parse_mode: "HTML",
        link_preview_options: { is_disabled: true }, reply_markup: markup });
      const tg = r.text?.length ?? 0;
      console.log(`sent Design ${m.key} ${m.lang}: id ${r.message_id}; Telegram counts ${tg}, we count ${m.chars}` +
        `${tg === m.chars ? " (same)" : ` (DIFFERENT by ${m.chars - tg})`}; formatting: ${tags(m.plan.text)} sent, ${(r.entities ?? []).length} kept`);
    }
  } catch (e) {
    console.log(`FAILED Design ${m.key} ${m.lang}: ${e.message}`);
  }
  await new Promise((res) => setTimeout(res, 1200));
}
