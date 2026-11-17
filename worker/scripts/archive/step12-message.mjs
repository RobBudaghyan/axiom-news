// Step 12: tells the owner, on the TEST bot, that the three Settings designs are live and how to
// switch. Token and owner id from ../.env (never printed).
//   node scripts/step12-message.mjs
import { loadEnv } from "../digest-cli.mjs";
import { settingsButton, tgCall } from "../../src/telegram.js";

const env = loadEnv();
const APP = "https://axiom-news.axiom-news-worker.workers.dev/app/";
const text = [
  "<b>Step 12: three Settings designs are live</b>",
  "",
  "Open Settings and tap Design 1, 2 or 3 at the top. Only you see that switch, and your phone remembers the last one.",
  "",
  "1. iOS Settings: a coloured square on every row, red switches.",
  "2. Pure minimal: a white page, emoji, red check marks.",
  "3. All buttons: topics and pause are buttons too.",
  "",
  "A change now gives a light vibration instead of \"Saved\". Tell me which one you like, or which parts to mix.",
].join("\n");
const r = await tgCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", { chat_id: Number(env.OWNER_TELEGRAM_ID), text, parse_mode: "HTML",
  ...settingsButton(APP, "Open settings") });
console.log(r && r.ok !== false ? "sent" : `failed: ${JSON.stringify(r).slice(0, 200)}`);
