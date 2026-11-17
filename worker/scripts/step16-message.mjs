// Step 16, part 0: asks the owner, on the TEST bot, to check items 1 to 6 on his phone, with four
// screenshots (his own setup is done, and he has 3 custom topics, so he cannot see the setup or the
// hint himself). Token and owner id from ../.env (never printed).
//   node scripts/step16-message.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./digest-cli.mjs";
import { settingsButton, tgCall } from "../src/telegram.js";

const env = loadEnv();
const me = await tgCall(env.TELEGRAM_BOT_TOKEN, "getMe", {});
if (me.username !== "justatia_bot") throw new Error(`refusing: the bot in .env is @${me.username}, not the TEST bot`);
const chat = Number(env.OWNER_TELEGRAM_ID);
const APP = "https://axiom-news.axiom-news-worker.workers.dev/app/";

const shots = [
  ["setup-1-language-en-light.png", "1️⃣ New first step of the setup: Language (your Telegram language is chosen)"],
  ["setup-1-language-tapped-ru-en-light.png", "1️⃣ Tap Русский: the whole setup switches at once"],
  ["settings-my-topics-hint-en-light.png", "4️⃣ The hint under Add a topic (you have 3 topics, so you will not see it)"],
  ["all-topics-off-en-light.png", "5️⃣ Every topic off: no digests at all"],
];
const form = new FormData();
form.append("chat_id", String(chat));
form.append("media", JSON.stringify(shots.map(([f, caption], i) => ({ type: "photo", media: `attach://p${i}`, caption }))));
shots.forEach(([f], i) => {
  const path = fileURLToPath(new URL(`../../reports/data/step-16/screenshots/${f}`, import.meta.url));
  form.append(`p${i}`, new Blob([readFileSync(path)], { type: "image/png" }), f);
});
const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMediaGroup`, { method: "POST", body: form });
console.log(`screenshots: ${res.status}`);

const text = [
  "🧪 <b>Step 16: please check on your phone (TEST bot)</b>",
  "",
  "Close Settings fully, then open it again.",
  "",
  "1️⃣ <b>Setup language step</b>: see the first two photos.",
  "2️⃣ <b>Texts</b>: open Help. Short lines, emojis. Also try /help and /support.",
  "3️⃣ <b>Red squares</b>: Help and Send feedback at the bottom.",
  "4️⃣ <b>Hint</b> under Add a topic: see the photo.",
  "5️⃣ <b>No Pause</b>: switch every topic off. The card says 😴 All topics are off. Then switch yours back on!",
  "6️⃣ <b>Emojis</b>: 🏛️ and 📈 stay, as you chose.",
  "",
  "7️⃣ <b>Digest length</b> (no need to check, just so you know):",
  "Main topics now need a topic score of 7 (was 6). Your own topics keep 6.",
  "48 hours, all six topics: 15.7 stories a digest before, 10.4 now.",
  "Armenia only: 13.6 before, 6.4 now.",
  "Today is a heavy news day: all six topics would have had 17, 14 and 15 stories at 09, 14 and 20.",
  "A labelled preview with all six topics (since 20:00) follows.",
  "",
  "Reply OK, or tell me what to change ✍️",
].join("\n");
const r = await tgCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", { chat_id: chat, text, parse_mode: "HTML", ...settingsButton(APP, "Open settings") });
console.log(r ? "message sent" : "message failed");
