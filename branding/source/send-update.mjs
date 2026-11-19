// Step 17b, round 2: sends the owner, on the TEST bot only, the updated welcome, the single-path
// splash icon and the re-rendered previews and share cards. Token and owner id from .env (never printed).
//   node branding/source/send-update.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../../worker/scripts/digest-cli.mjs";
import { sendHtml, tgCall } from "../../worker/src/telegram.js";
import { welcomeSetupText } from "../../worker/src/bot.js";
import { setupButton } from "../../worker/src/onboard.js";

const env = loadEnv();
const token = env.TELEGRAM_BOT_TOKEN;
const me = await tgCall(token, "getMe", {});
if (me.username !== "justatia_bot") throw new Error(`refusing: the bot in .env is @${me.username}, not the TEST bot`);
const chat = Number(env.OWNER_TELEGRAM_ID);
const STAGING = "https://axiom-news-staging.axiom-news-worker.workers.dev";
const out = (f) => fileURLToPath(new URL(`../out/${f}`, import.meta.url));

async function documents(files, caption) {
  const form = new FormData();
  form.append("chat_id", String(chat));
  form.append("media", JSON.stringify(files.map((f, i) => ({ type: "document", media: `attach://d${i}`,
    ...(i === files.length - 1 ? { caption, parse_mode: "HTML" } : {}) }))));
  files.forEach((f, i) => form.append(`d${i}`, new Blob([readFileSync(out(f))]), f));
  const r = await (await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, { method: "POST", body: form })).json();
  if (!r.ok) throw new Error(`sendMediaGroup: ${r.description}`);
}

await sendHtml(token, chat, [
  "🧪 <b>Step 17b, round 2: your remarks are on the TEST bot</b>",
  "",
  "📰 New description and about (open the bot's profile, or the empty chat from another account).",
  "📰 Welcome: the new second line (previews below).",
  "🗑 \"A few times a day\", \"English or Russian\", News.am and RFE/RL are gone from every text.",
  "🖼 Previews and share cards re-made with the new line.",
  "🧩 New splash icon: one single path, for BotFather's loading screen.",
].join("\n"));
for (const lang of ["en", "ru"]) {
  await sendHtml(token, chat, `<i>Preview: the welcome (${lang === "en" ? "English" : "Russian"})</i>`);
  await tgCall(token, "sendAnimation", { chat_id: chat, animation: `${STAGING}/media/welcome.mp4`, caption: welcomeSetupText({}, lang),
    parse_mode: "HTML", width: 1280, height: 720, duration: 2, ...setupButton(`${STAGING}/app/`, lang) });
}
await documents(["splash-icon.svg", "splash-icon-512.png"], [
  "🧩 <b>Splash icon</b> (splash-icon.svg): one path, one colour, 1.8 KB.",
  "BotFather: Configure Mini App, loading screen: send splash-icon.svg; light background #f2f2f7, dark #000000.",
  "ℹ️ The white parts of the logo are holes, so they take the background colour: on the dark splash the bar and NEWS look black.",
].join("\n"));
await documents(["share-en-1080x1080.png", "share-ru-1080x1080.png", "share-en-1080x1920.png", "share-ru-1080x1920.png"],
  "📤 <b>Share cards</b>, with \"at the times you choose\".");
await documents(["preview-en-setup.png", "preview-en-settings.png", "preview-en-digest.png",
  "preview-ru-setup.png", "preview-ru-settings.png", "preview-ru-digest.png"], "🖼 <b>Mini App previews</b>, updated.");
await sendHtml(token, chat, "✍️ Reply OK, or tell me what to change.");
console.log("sent to the owner on the TEST bot");
