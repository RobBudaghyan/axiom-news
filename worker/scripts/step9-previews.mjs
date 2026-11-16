// Step 9 owner review on the TEST bot (token from ../.env, never printed): sends the owner four
// clearly labelled previews and records nothing:
//  1-3. a digest in Russian, Armenian and French, built by the real planDigest from the 15 sample
//       stories of reports/data/step-09-samples.json (stories already sent to the owner, translated
//       by job/translate.py);
//  4.   the /start reply a new Russian-speaking user gets, with its button.
//   node scripts/step9-previews.mjs            send all four
//   node scripts/step9-previews.mjs --dry      print them, send nothing
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv, d1Rest } from "./digest-cli.mjs";
import { CONFIG, planDigest, visibleLength } from "../src/digest.js";
import { welcomeText } from "../src/bot.js";
import { LANGS, t } from "../src/i18n.js";
import { sendDigestMessage, sendPlain, settingsButton } from "../src/telegram.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const toml = readFileSync(`${ROOT}worker/wrangler.toml`, "utf8");
const APP_URL = /^APP_URL\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
const samples = JSON.parse(readFileSync(`${ROOT}reports/data/step-09-samples.json`, "utf8"));
const env = loadEnv();
const db = d1Rest(env);
const owner = Number(env.OWNER_TELEGRAM_ID);
const dry = process.argv.includes("--dry");
const now = Math.floor(Date.now() / 1000);

const [[user], topics] = await db.batch([
  { sql: "SELECT * FROM users WHERE id = ?1", params: [owner] },
  { sql: "SELECT tag, label_en, emoji, sort, is_default FROM topics ORDER BY sort", params: [] },
]);
const ids = samples.stories.map((s) => s.id);
const rows = await db.query(
  `SELECT id, summary, headline, description, emojis, best_url, best_source, importance, final_score, topic_score,
          topics, main_topic, updated_at, dup_group FROM stories WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
// As if it were a first digest over these stories: the owner's topics, nothing sent yet.
const reader = { ...user, id: 0, topics: JSON.stringify(topics.map((x) => x.tag)), last_digest_at: null };

async function send(text, extra) {
  if (dry) { console.log(`\n----- (${visibleLength(text)} characters)\n${text}`); return; }
  const r = extra ? await sendPlain(env.TELEGRAM_BOT_TOKEN, owner, text, extra) : await sendDigestMessage(env.TELEGRAM_BOT_TOKEN, owner, text, { kind: "rich" });
  console.log(`sent: message ${r.message_id} (${visibleLength(text)} characters)`);
}

for (const lang of ["ru", "hy", "fr"]) {
  const tr = samples.langs[lang].rows;
  const cands = rows.map((s) => {
    const x = tr[String(s.id)] ?? {};
    const ok = x.ok ? [x.headline, x.description] : x.retry_ok ? [x.retry_headline, x.retry_description] : [null, null];
    return { ...s, tr_headline: ok[0], tr_description: ok[1] };
  });
  const name = LANGS.english_names[lang];
  const label = `<i>TEST preview, Step 9: a digest in ${name}${LANGS.enabled.includes(lang) ? "" : " (not enabled yet)"}. ` +
    "Recent stories you already received, translated by the AI. Nothing is recorded.</i>";
  const plan = planDigest(reader, cands, topics, now, CONFIG, { lang, label });
  console.log(`${name}: ${plan.stories.length} stories, ${plan.cut} cut for length, language ${plan.lang}` +
    `${plan.fallback ? ` (FALLBACK: ${plan.fallback.missing} untranslated)` : ""}`);
  await send(plan.text);
}

const fresh = { ...user, first_name: user.first_name, lang: "ru" };
const start = "TEST preview, Step 9: the /start reply a new user whose Telegram is in Russian gets.\n\n" +
  welcomeText(fresh, topics, now, true, "ru");
await send(start, settingsButton(APP_URL, t("ru", "bot.button")));
