// Step 15, part 3: asks the owner, on the TEST bot, to check Help and Send feedback on his phone.
// Token and owner id from ../.env (never printed).
//   node scripts/step15-message.mjs
import { loadEnv } from "../digest-cli.mjs";
import { settingsButton, tgCall } from "../../src/telegram.js";

const env = loadEnv();
const me = await tgCall(env.TELEGRAM_BOT_TOKEN, "getMe", {});
if (me.username !== "justatia_bot") throw new Error(`refusing: the bot in .env is @${me.username}, not the TEST bot`);
const APP = "https://axiom-news.axiom-news-worker.workers.dev/app/";
const text = [
  "<b>Step 15: Help and Send feedback (TEST bot)</b>",
  "",
  "Please reopen Settings and scroll to the bottom:",
  "1. <b>Help</b>: a page with eight short sections and the privacy note. Telegram's back arrow returns to Settings.",
  "2. <b>Send feedback</b>: write anything and tap Send. You feel a tap, see \"Thank you!\", and the message arrives here in this chat with your name and id.",
  "3. Send /help: it now points to Settings.",
  "",
  "Also new: Politics and Wars &amp; Conflicts are one topic, and <b>Economy &amp; Markets</b> is new. Your main topics were all off; as the brief says for every user, Economy &amp; Markets is now on for you. Switch it off in Settings if you do not want it.",
  "A labelled preview digest with all six topics follows.",
].join("\n");
const r = await tgCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", { chat_id: Number(env.OWNER_TELEGRAM_ID), text, parse_mode: "HTML",
  ...settingsButton(APP, "Open settings") });
console.log(r && r.ok !== false ? "sent" : `failed: ${JSON.stringify(r).slice(0, 200)}`);
