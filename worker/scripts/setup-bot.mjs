// One-time bot setup through the Bot API (token from ../.env, never printed):
//  - the chat menu button (next to the message box) opens the Mini App, for every user;
//  - the command list shows /start, /settings and /terms (Step 18: /support and /paysupport left the menu
//    but still work when typed, Telegram's rule for bots that take Stars), in English by default and (Step 9) in every
//    other enabled language for people whose Telegram app is in that language
//    (setMyCommands with language_code; a language hidden from the picker gets its list removed);
//  - Step 17: the description (the empty chat, before Start) and the short description (the bot's
//    profile and shared links), the same way per language (bot.description, bot.short_description).
// A user who picks a language in the Mini App also gets a per-chat menu label and command list
// (src/bot.js setChatLanguage); Step 18: every such per-chat list is replaced by the current one too
// (read from the copy's D1). Then it reads everything back to confirm. Run again after
// switching to the real bot, and after enabling or hiding a language.
//   node scripts/setup-bot.mjs            set and verify
//   node scripts/setup-bot.mjs --check    only read back what is set
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STAGING, d1Rest, loadEnv } from "./digest-cli.mjs";
import { tgCall } from "../src/telegram.js";
import { DICTS, LANGS, commandList, t } from "../src/i18n.js";

const toml = readFileSync(fileURLToPath(new URL("../wrangler.toml", import.meta.url)), "utf8");
// Step 16: AXIOM_ENV=staging takes the staging copy's address ([env.staging] in wrangler.toml)
const APP_URL = /^APP_URL\s*=\s*"([^"]+)"/m.exec(toml.split("[env.staging]")[STAGING ? 1 : 0])?.[1];
if (!APP_URL) throw new Error("APP_URL missing in wrangler.toml");
const ENV = loadEnv();
const token = ENV.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing in .env");
// Step 17 launch: each copy has its own bot (staging the TEST bot, production the real one).
const who = (await tgCall(token, "getMe", {})).username;
if (STAGING && who !== "justatia_bot") throw new Error(`refusing: staging is for the TEST bot, not @${who}`);
if (!STAGING && who === "justatia_bot") throw new Error("refusing: production is not for the TEST bot (put the real bot's token in .env)");

const COMMANDS = commandList("en");
const others = Object.keys(DICTS).filter((l) => l !== "en");

if (!process.argv.includes("--check")) {
  await tgCall(token, "setChatMenuButton", { menu_button: { type: "web_app", text: t("en", "bot.menu_button"), web_app: { url: APP_URL } } });
  await tgCall(token, "setMyCommands", { commands: COMMANDS });
  for (const lang of others) {
    if (LANGS.enabled.includes(lang)) await tgCall(token, "setMyCommands", { commands: commandList(lang), language_code: lang });
    else await tgCall(token, "deleteMyCommands", { language_code: lang });
  }
  await tgCall(token, "setMyDescription", { description: t("en", "bot.description") });
  await tgCall(token, "setMyShortDescription", { short_description: t("en", "bot.short_description") });
  for (const lang of others) {
    const on = LANGS.enabled.includes(lang);   // "" removes a hidden language's own text (English shows)
    await tgCall(token, "setMyDescription", { description: on ? t(lang, "bot.description") : "", language_code: lang });
    await tgCall(token, "setMyShortDescription", { short_description: on ? t(lang, "bot.short_description") : "", language_code: lang });
  }
  // Step 18: chats with their own command list (a language chosen in the Mini App, a non-English /start)
  const users = await d1Rest(ENV).query("SELECT id, lang FROM users WHERE blocked = 0");
  let chats = 0;
  for (const u of users) {
    const scope = { type: "chat", chat_id: Number(u.id) };
    try {
      const have = await tgCall(token, "getMyCommands", { scope });
      if (!have.length) continue;
      await tgCall(token, "setMyCommands", { commands: commandList(LANGS.enabled.includes(u.lang) ? u.lang : "en"), scope });
      chats++;
    } catch { /* a chat the bot cannot reach */ }
  }
  console.log(`per-chat command lists replaced: ${chats} of ${users.length} readers`);
  console.log(`set: menu button, descriptions and commands (en, ${others.filter((l) => LANGS.enabled.includes(l)).join(", ") || "no other language"})`);
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
for (const lang of ["en", ...others]) {
  const code = lang === "en" ? {} : { language_code: lang };
  const d = (await tgCall(token, "getMyDescription", code)).description;
  const sd = (await tgCall(token, "getMyShortDescription", code)).short_description;
  const want = lang === "en" || LANGS.enabled.includes(lang);
  console.log(`description (${lang}): ${d ? d.split("\n")[0] : "none, falls back to English"}`);
  if (want ? d !== t(lang, "bot.description") || sd !== t(lang, "bot.short_description") : d || sd) ok = false;
}
console.log(ok ? "OK: the menu button opens the Mini App" : "NOT as expected");
process.exit(ok ? 0 : 1);
