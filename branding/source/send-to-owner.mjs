// Step 17b: sends the owner, on the TEST bot only, the branding to check on his phone: the new
// welcome and reminder exactly as a new reader gets them (English and Russian), the description
// animation, and the files for BotFather and for sharing. Token and owner id from .env (never printed).
//   node branding/source/send-to-owner.mjs
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../../worker/scripts/digest-cli.mjs";
import { sendHtml, tgCall } from "../../worker/src/telegram.js";
import { welcomeSetupText } from "../../worker/src/bot.js";
import { reminderText, setupButton } from "../../worker/src/onboard.js";

const env = loadEnv();
const token = env.TELEGRAM_BOT_TOKEN;
const me = await tgCall(token, "getMe", {});
if (me.username !== "justatia_bot") throw new Error(`refusing: the bot in .env is @${me.username}, not the TEST bot`);
const chat = Number(env.OWNER_TELEGRAM_ID);
const STAGING = "https://axiom-news-staging.axiom-news-worker.workers.dev";
const APP = `${STAGING}/app/`;
const out = (f) => fileURLToPath(new URL(`../out/${f}`, import.meta.url));
const label = (s) => sendHtml(token, chat, `<i>${s}</i>`);

async function upload(method, field, file, extra = {}) {
  const form = new FormData();
  form.append("chat_id", String(chat));
  for (const [k, v] of Object.entries(extra)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
  form.append(field, new Blob([readFileSync(out(file))]), basename(file));
  const r = await (await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", body: form })).json();
  if (!r.ok) throw new Error(`${method} ${file}: ${r.description}`);
}
async function documents(files, caption) {
  const form = new FormData();
  form.append("chat_id", String(chat));
  form.append("media", JSON.stringify(files.map((f, i) => ({ type: "document", media: `attach://d${i}`,
    ...(i === files.length - 1 && caption ? { caption, parse_mode: "HTML" } : {}) }))));
  files.forEach((f, i) => form.append(`d${i}`, new Blob([readFileSync(out(f))]), f));
  const r = await (await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, { method: "POST", body: form })).json();
  if (!r.ok) throw new Error(`sendMediaGroup: ${r.description}`);
}

await sendHtml(token, chat, [
  "🧪 <b>Step 17b: branding, on the TEST bot</b>",
  "",
  "📰 New texts, the welcome animation and the Settings loading screen are live on the TEST bot.",
  "👇 Below: previews of the welcome and the reminder, then the files.",
  "",
  "Please check on your phone:",
  "1️⃣ <b>Empty chat</b>: open @justatia_bot from another account, or delete this chat and open it again. You see the new description before Start.",
  "2️⃣ <b>Welcome</b>: the animation, the text and ⚙️ Set up (previews below; a new reader gets exactly these).",
  "3️⃣ <b>Reminder</b>: preview below.",
  "4️⃣ <b>Loading screen</b>: close Settings fully and open it again. The logo fades in instead of a spinner.",
  "5️⃣ <b>Texts</b>: Help in Settings, /support, /help. Calmer, no exclamation marks.",
  "6️⃣ <b>Share cards</b> and the <b>BotFather files</b>: further down, with the taps.",
  "",
  "✍️ Reply OK, or tell me what to change.",
].join("\n"));

for (const lang of ["en", "ru"]) {
  await label(`Preview: the welcome a new reader gets (${lang === "en" ? "English" : "Russian"})`);
  await tgCall(token, "sendAnimation", { chat_id: chat, animation: `${STAGING}/media/welcome.mp4`, caption: welcomeSetupText({}, lang),
    parse_mode: "HTML", width: 1280, height: 720, duration: 2, ...setupButton(APP, lang) });
}
for (const lang of ["en", "ru"]) {
  await label(`Preview: the reminder, once, the next day (${lang === "en" ? "English" : "Russian"})`);
  await sendHtml(token, chat, reminderText({}, lang), setupButton(APP, lang));
}

await label("The description animation (empty chat, before Start), 3 s, 640x360, no text so it fits every language");
await upload("sendAnimation", "animation", "description-640x360.mp4", { width: "640", height: "360", duration: "3" });
await label("The profile photo, re-made from vector (the current one is a soft 320 px JPEG)");
await upload("sendPhoto", "photo", "profile-photo-1280.png");

await documents(["share-en-1080x1080.png", "share-ru-1080x1080.png", "share-en-1080x1920.png", "share-ru-1080x1920.png"],
  "📤 <b>Share cards</b>: square for chats, tall for stories. Each has the logo, one line, the bot address and the top of a real digest.");
await documents(["preview-en-setup.png", "preview-en-settings.png", "preview-en-digest.png",
  "preview-ru-setup.png", "preview-ru-settings.png", "preview-ru-digest.png"],
  "🖼 <b>Mini App previews</b> for the bot profile: 3 in English, 3 in Russian, 1080x1920, real screens.");
await documents(["description-640x360.mp4", "description-320x180.mp4", "description-640x360.png", "profile-photo-1280.png",
  "loading-icon-512.png", "loading-icon.svg"], "🧰 <b>Files for BotFather</b> (steps in the next message).");

await sendHtml(token, chat, [
  "🧰 <b>BotFather steps for the TEST bot</b> (the same for @axiom_news_bot at launch)",
  "",
  "<b>A. Description animation</b>",
  "1. @BotFather: /mybots, choose @justatia_bot, Edit Bot, Edit Description Picture.",
  "2. Forward the description animation from this chat (or send description-640x360.mp4).",
  "3. If it asks for 320x180, send description-320x180.mp4. If it only takes a picture, send description-640x360.png.",
  "",
  "<b>B. Profile photo</b>",
  "1. /mybots, @justatia_bot, Edit Bot, Edit Botpic.",
  "2. Send the profile photo above as a photo (not as a file).",
  "",
  "<b>C. Main Mini App and loading screen</b>",
  "1. /mybots, @justatia_bot, Bot Settings, Configure Mini App, Enable Mini App.",
  `2. Send the address: ${APP}`,
  "3. If it offers a loading screen: icon loading-icon.svg (or loading-icon-512.png); light colour #f2f2f7, dark colour #000000.",
  "",
  "<b>D. Previews in the profile</b>",
  "1. Save the six preview pictures to your phone (open each file, ⋮, Save to Downloads).",
  "2. Open the bot's profile (tap its name at the top of the chat). Under Launch app (Open), tap Add preview.",
  "3. Add the three English ones in order: setup, settings, digest.",
  "4. In the same place choose a language (Russian) and add the three Russian ones.",
  "",
  "ℹ️ Telegram may name some buttons slightly differently. If a step does not match, tell me what you see.",
].join("\n"));
console.log("sent to the owner on the TEST bot");
