// Step 13: asks the owner, on the TEST bot, to try "My topics" on his phone (add Colombia and one
// nonsense topic). Token and owner id from ../.env (never printed).
//   node scripts/step13-message.mjs
import { loadEnv } from "./digest-cli.mjs";
import { settingsButton, tgCall } from "../src/telegram.js";

const env = loadEnv();
const APP = "https://axiom-news.axiom-news-worker.workers.dev/app/";
const text = [
  "<b>Step 13: My topics is live (TEST bot)</b>",
  "",
  "Open Settings. Under Topics there is a new card, My topics. Please add:",
  "1. <b>Colombia</b> (type it, then Add or Enter).",
  "2. One nonsense topic, for example <b>asdfgh</b>, to see the rejection.",
  "",
  "Each new topic is checked once by AI; it takes a few seconds. After two hourly runs I will send you a labelled preview digest with a Colombia section.",
].join("\n");
const r = await tgCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", { chat_id: Number(env.OWNER_TELEGRAM_ID), text, parse_mode: "HTML",
  ...settingsButton(APP, "Open settings") });
console.log(r && r.ok !== false ? "sent" : `failed: ${JSON.stringify(r).slice(0, 200)}`);
