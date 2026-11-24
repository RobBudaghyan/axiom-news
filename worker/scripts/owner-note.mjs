// Step 20: one short note to the OWNER ONLY on the TEST bot @justatia_bot (staging). Text from a file.
// Token and owner id from ../.env with ../.env.staging on top (never printed). Sends nothing to anyone else.
//   AXIOM_ENV=staging node scripts/owner-note.mjs note.txt --dry
//   AXIOM_ENV=staging node scripts/owner-note.mjs note.txt
import { readFileSync } from "node:fs";
import { loadEnv } from "./digest-cli.mjs";
import { tgCall } from "../src/telegram.js";

const file = process.argv[2];
if (!file) throw new Error("usage: owner-note.mjs <text file> [--dry]");
const text = readFileSync(file, "utf8").trim();
if (/[\u2013\u2014]/.test(text)) throw new Error("refusing: the note has an em or en dash");
if (process.argv.includes("--dry")) {
  console.log(text);
} else {
  const env = loadEnv();
  const me = await tgCall(env.TELEGRAM_BOT_TOKEN, "getMe", {});
  if (me.username !== "justatia_bot") throw new Error(`refusing: the bot is @${me.username}, not the TEST bot @justatia_bot`);
  await tgCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", { chat_id: Number(env.OWNER_TELEGRAM_ID), text });
  console.log("sent the note to the owner on @justatia_bot");
}
