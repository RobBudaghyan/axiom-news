// Step 8 one-off: send the owner the replay numbers as one short, labelled message (TEST bot only).
import { tgCall, sendHtml } from "../src/telegram.js";
import { loadEnv } from "./digest-cli.mjs";

const env = loadEnv();
const me = await tgCall(env.TELEGRAM_BOT_TOKEN, "getMe", {});
if (me.username !== "justatia_bot") throw new Error(`refusing: the bot in .env is @${me.username}, not the TEST bot`);
const text = [
  "<i>Step 8 numbers (not a digest). Replay of the last 48 hours on real stories, bars 7/6, one message of at most 3,900 characters.</i>",
  "",
  "<b>Stories per digest, before (old rules) and after</b>",
  "You: 2.3 and now 5.0 (max 12)",
  "Dad, all topics at 9/14/20: 5.7 and now 12.1 (max 16)",
  "Armenia only, every 3 h: 0.4 and now 3.0 (max 7)",
  "All topics, every 6 h: 5.0 and now 9.3 (max 15)",
  "",
  "<b>Armenia stories in 48 hours</b>",
  "You 5 and now 33, Dad 4 and now 29, Armenia only 4 and now 33",
  "",
  "<b>Other bars</b> (Armenia-only reader, stories per digest): topic bar 5: 3.2, topic bar 6: 3.0, topic bar 7: 0.9. Dad: 13.9, 12.1, 6.7.",
  "",
  "<b>AI</b>: still about one editor call per hour (now up to 90 stories each); after the first new run no story of the last 24 hours was left unscored. One-off today: 30 extra calls, all free.",
  "",
  "<b>Your fold test</b>: none of the 5 messages folded on your Android, so the limit is 3,900.",
  "",
  "Details: reports/step-08-dynamic-digest.md",
].join("\n");
const r = await sendHtml(env.TELEGRAM_BOT_TOKEN, Number(env.OWNER_TELEGRAM_ID), text);
console.log(`[sent: message_id ${r.message_id}, ${text.length} characters]`);
