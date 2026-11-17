// Step 15, part 4: simulates a new reader for the owner on the TEST bot, labelled, nothing recorded:
// the /start welcome (English and Russian) with the Set up button, the one reminder, the three setup
// screenshots (390 px, from step15-screenshots.mjs) and the sample digest a new reader would get
// right after the setup (all six topics, the last 24 hours, the real pool). Token and owner id from
// ../.env (never printed).
//   node scripts/step15-welcome.mjs
import { readFileSync } from "node:fs";
import { CONFIG, candidateStatement, escapeHtml, planDigest, visibleLength } from "../../src/digest.js";
import { sendDigestMessage, tgCall } from "../../src/telegram.js";
import { welcomeSetupText } from "../../src/bot.js";
import { reminderText, setupButton } from "../../src/onboard.js";
import { t } from "../../src/i18n.js";
import { d1Rest, loadEnv } from "../digest-cli.mjs";

const env = loadEnv();
const me = await tgCall(env.TELEGRAM_BOT_TOKEN, "getMe", {});
if (me.username !== "justatia_bot") throw new Error(`refusing: the bot in .env is @${me.username}, not the TEST bot`);
const owner = Number(env.OWNER_TELEGRAM_ID);
const APP = "https://axiom-news.axiom-news-worker.workers.dev/app/";
const say = (text, extra = {}) => tgCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", { chat_id: owner, text, parse_mode: "HTML", ...extra });
const label = (s) => `<i>${s}</i>`;

await say([
  "<b>Step 15: a new reader's first day (TEST bot simulation)</b>",
  "",
  "The next messages show what a brand-new reader gets. Nothing is recorded and no real user gets them.",
  "1. The /start welcome (English, then Russian) with the Set up button.",
  "2. The setup in the app: three screenshots.",
  "3. The sample digest right after Done or Skip.",
  "4. The one gentle reminder, the next day, only for someone who never opened the app.",
].join("\n"));

const nora = { first_name: "Nora", lang: "en", timezone: CONFIG.default_timezone, digest_times: JSON.stringify(CONFIG.default_times) };
await say(`${label("1a. Welcome (English):")}\n\n${escapeHtml(welcomeSetupText(nora, "en"))}`, setupButton(APP, "en"));
await say(`${label("1b. Welcome (Russian Telegram):")}\n\n${escapeHtml(welcomeSetupText({ ...nora, first_name: "Нора" }, "ru"))}`, setupButton(APP, "ru"));

// 2. the three setup screenshots as one album
const dir = new URL("../../../reports/data/step-15/screenshots/", import.meta.url);
const form = new FormData();
form.append("chat_id", String(owner));
const media = [1, 2, 3].map((n) => ({ type: "photo", media: `attach://s${n}`, ...(n === 1 ? { caption: "2. The setup: Your topics, Digest times, All set (390 px, light)" } : {}) }));
form.append("media", JSON.stringify(media));
for (const n of [1, 2, 3]) form.append(`s${n}`, new Blob([readFileSync(new URL(`setup-${n}-390-en-light.png`, dir))], { type: "image/png" }), `setup-${n}.png`);
const album = await (await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMediaGroup`, { method: "POST", body: form })).json();
console.log(album.ok ? "album sent" : `album failed: ${album.description}`);

// 3. the sample digest for a new reader: all six topics, the last 24 hours, never-sent (id 0)
const db = d1Rest(env);
const topics = await db.query("SELECT tag, label_en, emoji, sort, is_default FROM topics ORDER BY sort");
const now = Math.floor(Date.now() / 1000);
const user = { id: 0, first_name: "Nora", lang: "en", timezone: CONFIG.default_timezone, digest_times: JSON.stringify(CONFIG.default_times),
  topics: JSON.stringify(topics.filter((x) => x.is_default).map((x) => x.tag)), last_digest_at: null, next_digest_at: null };
const st = candidateStatement(user, now, CONFIG);
const cands = await db.query(st.sql, st.params);
const plan = planDigest(user, cands, topics, now, CONFIG,
  { label: `${label("3. Simulation, nothing recorded.")} <i>${escapeHtml(t("en", "digest.sample_label"))}</i>` });
const r = await sendDigestMessage(env.TELEGRAM_BOT_TOKEN, owner, plan.text, { kind: plan.kind });
console.log(`sample digest sent: ${plan.stories.length} stories, ${plan.cut} cut, ${visibleLength(plan.text)} characters, message ${r.message_id}`);

await say(`${label("4. The reminder (the next day, 10:00 to 20:00 their time, once):")}\n\n${escapeHtml(reminderText(nora, "en"))}`, setupButton(APP, "en"));
console.log("[done: nothing written to the database]");
