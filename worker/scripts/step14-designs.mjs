// Step 14: digest design previews for the owner, on the TEST bot only (token from ../.env, never
// printed). The SAME 10 real recent stories (seven on the main topics, three on Japan, each with a
// checked Russian translation in D1) are built by the real planDigest with each layout, every
// message labelled and carrying the "⚙️ Settings" button. Records nothing.
//   Round 1 (A-D): four plain newsletter layouts (stories without emojis or quote boxes). The owner
//   answered: keep the stories exactly as they are, only the topic heading should change.
//   Round 2 (H1-H4, the default): today's design E5f with only the topic heading changed.
//   node scripts/step14-designs.mjs --dry      print the messages and their lengths, send nothing
//   node scripts/step14-designs.mjs            send round 2 (refuses unless the bot is the TEST bot)
//   node scripts/step14-designs.mjs --only A,B,C,D --ru B,D      round 1
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv, d1Rest } from "./digest-cli.mjs";
import { CONFIG, RICH, escapeHtml, planDigest, storyLink, visibleLength } from "../src/digest.js";
import { asTopicRows } from "../src/custom.js";
import { t } from "../src/i18n.js";
import { settingsButton, tgCall } from "../src/telegram.js";

const TEST_BOT = "justatia_bot";
// politics x2, iran_war, wars_conflicts, armenia, russia, ukraine_war; Japan x3 (all pass the keyword rule)
const IDS = [3782, 3364, 3006, 3777, 2959, 3602, 3830, 3667, 3220, 3195];

// ------------------------------------------------------------------ round 1 (sent, not chosen)
const countRich = (html) => visibleLength(html.replace(/<br\s*\/?>/g, "\n"));
const outlet = (s) => `<i>${storyLink(s, escapeHtml(s.best_source))}</i>`;
const flagged = (x) => `${x.emoji ? `${x.emoji} ` : ""}${escapeHtml(x.label)}`;
const firstSentence = (text) => String(text ?? "").split(/(?<=[.!?։])\s+(?=[\p{Lu}\p{N}"«])/u)[0];
const runIn = (h) => `${h}${/[.!?։]$/.test(h) ? "" : /[Ա-֏]/.test(h) ? "։" : "."}`;
const plain = { kind: "rich", gap: "", count: countRich, label: RICH.label, header: RICH.header, quiet: RICH.quiet };
const headlineThenText = (s, text) => `<p><b>${escapeHtml(s.headline)}</b>${text ? `<br>${escapeHtml(text)} ` : " "}${outlet(s)}</p>`;
const ROUND1 = {
  A: { ...plain, about: "Clean: plain bold heading with the flag, a thin line between sections, bold headline, plain text, the outlet in italics as the link",
       heading: (x, i) => `${i ? "<hr/>" : ""}<h3>${flagged(x)}</h3>`, story: (s) => headlineThenText(s, s.description) },
  B: { ...plain, about: "Editorial: section label in bold capitals, no emojis, bold headline, plain text, the outlet in italics",
       heading: (x) => `<p><b>${escapeHtml(x.label.toUpperCase())}</b></p>`, story: (s) => headlineThenText(s, s.description) },
  C: { ...plain, about: "Brief: bold heading with the flag, each story a bold headline and one sentence, tight",
       heading: (x) => `<p><b>${flagged(x)}</b></p>`, story: (s) => headlineThenText(s, firstSentence(s.description)) },
  D: { ...plain, about: "Briefing (my pick): like a newspaper's briefs column, the bold headline runs into the text in one paragraph, the outlet in italics",
       heading: (x, i) => `${i ? "<hr/>" : ""}<h3>${flagged(x)}</h3>`,
       story: (s) => `<p><b>${escapeHtml(runIn(s.headline))}</b> ${s.description ? `${escapeHtml(s.description)} ` : ""}${outlet(s)}</p>` },
};

// ------------------------------------------------------------------ round 2: only the topic heading
// Everything else is today's E5f (the greeting, the stories with their emojis, the outlet link, the
// description in a quote box, the line between topics, the quiet note, the Settings button).
const line = (i) => (i ? "<hr/>" : "");
const ROUND2 = {
  H1: { ...RICH, about: "today's stories; topic heading: plain bold text with the flag, left, no box",
        heading: (x, i) => `${line(i)}<p><b>${flagged(x)}</b></p>` },
  H2: { ...RICH, about: "today's stories; topic heading: a real heading with the flag, left, no box (my pick)",
        heading: (x, i) => `${line(i)}<h3>${flagged(x)}</h3>` },
  H3: { ...RICH, about: "today's stories; topic heading: bold capitals, no flag, left, no box",
        heading: (x, i) => `${line(i)}<p><b>${escapeHtml(x.label.toUpperCase())}</b></p>` },
  H4: { ...RICH, about: "today's stories; topic heading: small heading in capitals with the flag, left, no box",
        heading: (x, i) => `${line(i)}<h4>${x.emoji ? `${x.emoji} ` : ""}${escapeHtml(x.label.toUpperCase())}</h4>` },
};
const DESIGNS = { ...ROUND1, ...ROUND2 };
const FAVOURITE = "H2";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const APP_URL = /^APP_URL\s*=\s*"([^"]+)"/m.exec(readFileSync(`${ROOT}worker/wrangler.toml`, "utf8"))?.[1];
const env = loadEnv();
const db = d1Rest(env);
const owner = Number(env.OWNER_TELEGRAM_ID);
const dry = process.argv.includes("--dry");
const now = Math.floor(Date.now() / 1000);

const [[user], topics, custom] = await db.batch([
  { sql: "SELECT * FROM users WHERE id = ?1", params: [owner] },
  { sql: "SELECT tag, label_en, emoji, sort, is_default FROM topics ORDER BY sort", params: [] },
  { sql: "SELECT id, tag, names, emoji, boost_max FROM custom_topics WHERE tag = 'c2'", params: [] },
]);
const rows = await db.query(
  `SELECT s.id, s.summary, s.headline, s.description, s.emojis, s.best_url, s.best_source, s.importance, s.final_score,
          s.topic_score, s.topics, s.main_topic, s.updated_at, s.dup_group, tr.headline AS tr_headline, tr.description AS tr_description
   FROM stories s LEFT JOIN story_translations tr ON tr.story_id = s.id AND tr.lang = 'ru' AND tr.ok = 1
     AND tr.src = coalesce(s.headline, s.summary) || char(10) || coalesce(s.description, '')
   WHERE s.id IN (${IDS.map(() => "?").join(",")})`, IDS);
if (rows.length !== IDS.length || rows.some((r) => !r.tr_headline)) throw new Error("a story or its Russian translation is missing");
const allTopics = [...topics, ...asTopicRows(custom)];
// The owner as a reader of the six topics and Japan, last digest 6 hours ago.
const reader = { ...user, topics: JSON.stringify(allTopics.map((x) => x.tag)), last_digest_at: Math.floor((now - 6 * 3600) / 3600) * 3600 };

const pick = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1].split(","); };
const only = pick("--only"), ru = pick("--ru");
const runs = only || ru ? [...(only ?? []).map((k) => [k, "en"]), ...(ru ?? []).map((k) => [k, "ru"])]
  : [...Object.keys(ROUND2).map((k) => [k, "en"]), ["H3", "ru"], [FAVOURITE, "ru"]];
const out = [];
for (const [key, lang] of runs) {
  const L = DESIGNS[key];
  const label = `Topic heading ${key}${lang === "ru" ? " (in Russian)" : ""}: ${L.about}. A preview, nothing is recorded.`;
  const plan = planDigest(reader, rows, allTopics, now, CONFIG, { lang, layout: L, label });
  const chars = L.count(plan.text);
  console.log(`${key} ${lang}: ${plan.stories.length} stories, ${plan.cut} cut, ${chars} characters (limit ${CONFIG.message_char_limit})`);
  if (plan.stories.length !== IDS.length) console.log(`  NOTE: not all ${IDS.length} stories fit`);
  out.push({ key, lang, plan, chars });
}

if (dry) {
  for (const m of out) console.log(`\n----- ${m.key} ${m.lang} (${m.chars})\n${m.plan.text}`);
  process.exit(0);
}
const me = await tgCall(env.TELEGRAM_BOT_TOKEN, "getMe", {});
if (me.username !== TEST_BOT) throw new Error(`refusing: the bot in .env is @${me.username}, not the TEST bot`);
for (const m of out) {
  // the button the digests had when these previews were sent (removed in Step 14, owner)
  const markup = settingsButton(APP_URL, m.lang === "ru" ? "⚙️ Настройки" : "⚙️ Settings").reply_markup;
  try {
    const r = await tgCall(env.TELEGRAM_BOT_TOKEN, "sendRichMessage", { chat_id: owner,
      rich_message: { html: m.plan.text, skip_entity_detection: true }, reply_markup: markup });
    console.log(`sent ${m.key} ${m.lang} as a rich message: id ${r.message_id}, ${(r.rich_message?.blocks ?? []).length} blocks back`);
  } catch (e) {
    console.log(`FAILED ${m.key} ${m.lang}: ${e.message}`);
  }
  await new Promise((res) => setTimeout(res, 1200));
}
