// One-time bot setup through the Bot API (token from ../.env, never printed):
//  - the chat menu button (next to the message box) opens the Mini App, for every user;
//  - the command list shows /start and /settings, in English by default and (Step 9) in every
//    other enabled language for people whose Telegram app is in that language
//    (setMyCommands with language_code; a language hidden from the picker gets its list removed).
// A user who picks a language in the Mini App also gets a per-chat menu label and command list
// (src/bot.js setChatLanguage). Then it reads everything back to confirm. Run again after
// switching to the real bot, and after enabling or hiding a language.
//   node scripts/setup-bot.mjs            set and verify
//   node scripts/setup-bot.mjs --check    only read back what is set
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./digest-cli.mjs";
import { tgCall } from "../src/telegram.js";
import { DICTS, LANGS, commandList, t } from "../src/i18n.js";

const toml = readFileSync(fileURLToPath(new URL("../wrangler.toml", import.meta.url)), "utf8");
const APP_URL = /^APP_URL\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
if (!APP_URL) throw new Error("APP_URL missing in wrangler.toml");
const token = loadEnv().TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing in .env");

const COMMANDS = commandList("en");
const others = Object.keys(DICTS).filter((l) => l !== "en");

if (!process.argv.includes("--check")) {
  await tgCall(token, "setChatMenuButton", { menu_button: { type: "web_app", text: t("en", "bot.menu_button"), web_app: { url: APP_URL } } });
  await tgCall(token, "setMyCommands", { commands: COMMANDS });
  for (const lang of others) {
    if (LANGS.enabled.includes(lang)) await tgCall(token, "setMyCommands", { commands: commandList(lang), language_code: lang });
    else await tgCall(token, "deleteMyCommands", { language_code: lang });
  }
  console.log(`set: menu button and commands (en, ${others.filter((l) => LANGS.enabled.includes(l)).join(", ") || "no other language"})`);
}
const me = await tgCall(token, "getMe", {});
const menu = await tgCall(token, "getChatMenuButton", {});
const cmds = await tgCall(token, "getMyCommands", {});
console.log(`bot: @${me.username}`);
console.log(`menu button: ${JSON.stringify(menu)}`);
console.log(`commands: ${cmds.map((c) => `/${c.command} (${c.description})`).join(", ")}`);
let ok = menu.type === "web_app" && menu.web_app?.url === APP_URL && cmds.length === COMMANDS.length;
for (const lang of others) {
  const list = await tgCall(token, "getMyCommands", { language_code: lang });
  console.log(`commands (${lang}): ${list.map((c) => `/${c.command} (${c.description})`).join(", ") || "none, falls back to English"}`);
  if (LANGS.enabled.includes(lang) ? list.length !== COMMANDS.length : list.length !== 0) ok = false;
}
console.log(ok ? "OK: the menu button opens the Mini App" : "NOT as expected");
process.exit(ok ? 0 : 1);
