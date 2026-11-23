// Step 19 (owner asked): one short note to the OWNER ONLY on the real bot @axiom_news_bot, saying what to
// check after the ship. Token and owner id from ../.env (never printed). Sends nothing to anyone else.
//   node scripts/step19-note.mjs --dry     print the note
//   node scripts/step19-note.mjs           send it
import { loadEnv } from "./digest-cli.mjs";
import { tgCall } from "../src/telegram.js";

export const NOTE = [
  "✅ Axiom News, Step 19 is live.",
  "",
  "💻 New main topic: Technology & AI. Russia is no longer a main topic (you can add it as your own).",
  "📈 Own topics like Stocks, Finance or Crypto are accepted now.",
  "🌍 Four languages: English, Russian, French, Armenian.",
  "🎬 New welcome video. Alerts come only when something needs you.",
  "",
  "👉 To check, as a new reader:",
  "1. Settings > Help > Delete my data, then send /start.",
  "2. The welcome should show the new video.",
  "3. Setup: four languages in a 2x2 grid, six topics with Technology & AI.",
  "4. After Done, a sample digest arrives.",
  "5. In Settings, add the topic Stocks.",
  "",
  "🗂 By hand: new Mini App previews in BotFather (four languages), files in branding/out/preview-*.png.",
  "🇦🇲 Please confirm the Armenian name of Politics: now just Քաղաքականություն.",
].join("\n");

const env = loadEnv();
if (process.argv.includes("--dry")) {
  console.log(NOTE);
} else {
  const me = await tgCall(env.TELEGRAM_BOT_TOKEN, "getMe", {});
  if (me.username !== "axiom_news_bot") throw new Error(`refusing: the bot in .env is @${me.username}, not @axiom_news_bot`);
  await tgCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", { chat_id: Number(env.OWNER_TELEGRAM_ID), text: NOTE });
  console.log("sent the Step 19 note to the owner on @axiom_news_bot");
}
