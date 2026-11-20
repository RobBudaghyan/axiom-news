// Step 16: points a bot's webhook at one copy of the Worker (token and webhook secret from ../.env, with
// ../.env.staging on top for staging; nothing is printed but the result).
//   AXIOM_ENV=staging node scripts/point-bot.mjs     the TEST bot -> axiom-news-staging
//   node scripts/point-bot.mjs                        the bot in .env -> axiom-news (production)
//   ... --check                                       only show where it points
// Then run setup-bot.mjs the same way, so the chat menu button opens that copy's Mini App.
import { readFileSync } from "node:fs";
import { STAGING, d1Rest, loadEnv } from "./digest-cli.mjs";
import { tgCall } from "../src/telegram.js";
import { setChatLanguage } from "../src/bot.js";
import { effectiveLang } from "../src/i18n.js";

const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const part = STAGING ? toml.split("[env.staging]")[1] : toml.split("[env.staging]")[0];
const app = /^APP_URL\s*=\s*"([^"]+)"/m.exec(part)?.[1];
if (!app) throw new Error("APP_URL missing in wrangler.toml");
const url = app.replace(/\/app\/$/, "/telegram");
const env = loadEnv();
const me = await tgCall(env.TELEGRAM_BOT_TOKEN, "getMe", {});
if (STAGING && me.username !== "justatia_bot") throw new Error(`refusing: staging is for the TEST bot, not @${me.username}`);
if (!STAGING && me.username === "justatia_bot") throw new Error("refusing: production is not for the TEST bot (put the real bot's token in .env)");
if (!process.argv.includes("--check")) {
  // callback_query: the /support amount buttons; pre_checkout_query: Telegram asks before a Stars tip
  // goes through (Step 10). Before Step 16 the TEST bot had only "message", so both were never delivered.
  // my_chat_member (Step 17): a reader blocked the bot (marked blocked at once).
  await tgCall(env.TELEGRAM_BOT_TOKEN, "setWebhook", { url, secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query", "pre_checkout_query", "my_chat_member"], max_connections: 40, drop_pending_updates: false });
  // every reader's own chat menu (set when they pick a language) must open this copy's Mini App too
  const users = await d1Rest(env).query("SELECT id, lang, language FROM users WHERE blocked = 0");
  let fixed = 0;
  for (const u of users) {
    const problems = await setChatLanguage((m, b) => tgCall(env.TELEGRAM_BOT_TOKEN, m, b), u.id, effectiveLang(u), app);
    if (!problems.length) fixed++;
  }
  console.log(`chat menus pointed at ${app}: ${fixed} of ${users.length} users`);
}
const w = await tgCall(env.TELEGRAM_BOT_TOKEN, "getWebhookInfo", {});
console.log(`@${me.username} -> ${w.url} (updates: ${(w.allowed_updates ?? ["default"]).join(", ")}; pending ${w.pending_update_count})`);
if (w.url !== url) process.exit(1);
