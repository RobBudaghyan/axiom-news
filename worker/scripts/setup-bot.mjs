// One-time bot setup through the Bot API (token from ../.env, never printed):
//  - the chat menu button (next to the message box) opens the Mini App, for every user;
//  - the command list shows /start and /settings.
// Then it reads both back to confirm. Run again after switching to the real bot.
//   node scripts/setup-bot.mjs            set and verify
//   node scripts/setup-bot.mjs --check    only read back what is set
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./digest-cli.mjs";
import { tgCall } from "../src/telegram.js";

const toml = readFileSync(fileURLToPath(new URL("../wrangler.toml", import.meta.url)), "utf8");
const APP_URL = /^APP_URL\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
if (!APP_URL) throw new Error("APP_URL missing in wrangler.toml");
const token = loadEnv().TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN missing in .env");

const COMMANDS = [
  { command: "start", description: "Start (or restart) your news digests" },
  { command: "settings", description: "Open your settings" },
];

if (!process.argv.includes("--check")) {
  await tgCall(token, "setChatMenuButton", { menu_button: { type: "web_app", text: "Settings", web_app: { url: APP_URL } } });
  await tgCall(token, "setMyCommands", { commands: COMMANDS });
  console.log("set: menu button and commands");
}
const me = await tgCall(token, "getMe", {});
const menu = await tgCall(token, "getChatMenuButton", {});
const cmds = await tgCall(token, "getMyCommands", {});
console.log(`bot: @${me.username}`);
console.log(`menu button: ${JSON.stringify(menu)}`);
console.log(`commands: ${cmds.map((c) => `/${c.command} (${c.description})`).join(", ")}`);
const ok = menu.type === "web_app" && menu.web_app?.url === APP_URL && cmds.length === COMMANDS.length;
console.log(ok ? "OK: the menu button opens the Mini App" : "NOT as expected");
process.exit(ok ? 0 : 1);
