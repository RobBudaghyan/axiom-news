// Step 13 (and its fixes): asks the owner, on the TEST bot, to try "My topics" on his phone: the
// flags and switches, adding Colombia, off and on, Edit to remove and re-add, one nonsense topic.
// Token and owner id from ../.env (never printed).
//   node scripts/step13-message.mjs
import { loadEnv } from "./digest-cli.mjs";
import { settingsButton, tgCall } from "../src/telegram.js";

const env = loadEnv();
const APP = "https://axiom-news.axiom-news-worker.workers.dev/app/";
const text = [
  "<b>Step 13 fixes: My topics redesigned (TEST bot)</b>",
  "(Ignore the message just before this one: it was the old Step 13 text.)",
  "",
  "Please reopen Settings and check:",
  "1. Japan and Australia show their flags, each with a red switch.",
  "2. Add <b>Colombia</b>: the row slides in with its switch on.",
  "3. Turn Japan off and on again.",
  "4. Tap <b>Edit</b> (right of My topics), remove one topic with the red minus, tap Done, then add it again.",
  "5. Try one nonsense topic, for example <b>asdfgh</b>.",
  "",
  "A switched-off topic stays in your list and keeps its slot, but you get no stories from it. A labelled preview digest follows after the next hourly run.",
].join("\n");
const r = await tgCall(env.TELEGRAM_BOT_TOKEN, "sendMessage", { chat_id: Number(env.OWNER_TELEGRAM_ID), text, parse_mode: "HTML",
  ...settingsButton(APP, "Open settings") });
console.log(r && r.ok !== false ? "sent" : `failed: ${JSON.stringify(r).slice(0, 200)}`);
