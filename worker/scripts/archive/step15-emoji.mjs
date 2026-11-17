// Step 15, part 1: asks the owner, on the TEST bot, to pick the emoji of the two changed main topics.
// Token and owner id from ../.env (never printed).
//   node scripts/step15-emoji.mjs
import { loadEnv } from "../digest-cli.mjs";
import { tgCall } from "../../src/telegram.js";

const env = loadEnv();
const text = [
  "<b>Step 15: two new main topics (TEST bot)</b>",
  "",
  "Politics and Wars &amp; Conflicts become one topic, and Economy &amp; Markets is new. Please pick an emoji for each (reply e.g. \"A2 B1\"):",
  "",
  "<b>A. Politics &amp; Conflicts</b> (Политика и конфликты)",
  "A1 🏛️   A2 🌐   A3 ⚖️",
  "",
  "<b>B. Economy &amp; Markets</b> (Экономика и рынки)",
  "B1 📈   B2 💹   B3 🏦",
  "",
  "Until you answer, A1 and B1 are used. Armenia, Russia, Iran War and Ukraine War keep their flags.",
].join("\n");
const r = await tgCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", { chat_id: Number(env.OWNER_TELEGRAM_ID), text, parse_mode: "HTML" });
console.log(r && r.ok !== false ? "sent" : `failed: ${JSON.stringify(r).slice(0, 200)}`);
