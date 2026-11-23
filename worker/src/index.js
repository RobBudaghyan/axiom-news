// Axiom News Worker: Telegram webhook, Mini App API (/api/*), digest cron (every minute since Step 16), hourly
// GitHub job trigger and job health alerts. The Mini App files (public/app/) are static assets,
// served by Cloudflare before this code runs (wrangler.toml [assets]).
import { CONFIG } from "./digest.js";
import { d1Binding, logError } from "./db.js";
import { handleUpdate } from "./bot.js";
import { runTick } from "./cron.js";
import { checkUsage } from "./usage.js";
import { dispatchJob } from "./github.js";
import { sendDigestMessage, sendPlain, tgCall } from "./telegram.js";
import { handleApi, json } from "./api.js";
import { t } from "./i18n.js";
import "./warmup.js";   // Step 16: compiles the digest code while the Worker starts, not inside a cron tick

export const HOURLY_CRON = "7 * * * *";

// Step 16: two copies of this Worker (wrangler.toml): production and staging. Switches (vars):
//   ENV_NAME       "production" or "staging" (Admin shows it in big letters)
//   USER_SENDS     "off": no digests, reminders or announcements go out (production until launch)
//   JOB_DISPATCH   "off": never start the hourly GitHub job (staging: the job runs for production only)
//   SEND_STUB      "on": for the load test's fake readers (negative ids) Telegram is never called and the
//                  message counts as delivered; real readers are always sent for real
//   HEALTH_ALERTS  "off": no job-health or AI-guard alerts to the owner (staging)
export const envName = (env) => (env.ENV_NAME === "staging" ? "staging" : "production");
const on = (v, dflt = true) => (v == null ? dflt : String(v) !== "off");
export const switches = (env) => ({
  userSends: on(env.USER_SENDS), dispatch: on(env.JOB_DISPATCH), stub: env.SEND_STUB === "on", alerts: on(env.HEALTH_ALERTS),
});
let stubId = 0;
// The function that sends one user message: the real one, or (SEND_STUB) a stand-in that never
// calls Telegram and answers like a delivered message. The stand-in only ever answers for a fake
// reader (a negative id; Telegram user ids are positive): in Step 16 the stub was left on overnight
// and swallowed five real TEST-bot digests, so a forgotten stub can no longer touch a real reader.
export const isFakeReader = (chatId) => Number(chatId) < 0;
export function userSender(env, real) {
  if (!switches(env).stub) return real;
  return (chatId, ...rest) => (isFakeReader(chatId) ? Promise.resolve({ message_id: ++stubId, stub: true }) : real(chatId, ...rest));
}

function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const nowS = () => Math.floor(Date.now() / 1000);
export const appUrl = (env, url) => env.APP_URL || `${url.origin}/app/`;
// Step 17b: the welcome animation, a static file next to the Mini App (public/media/welcome.mp4).
// Step 19: a new video; the ?v= mark makes Telegram fetch it again instead of a copy it kept of the old one.
export const WELCOME_VERSION = "19";
export const welcomeAnimationUrl = (env, url) => new URL(`../media/welcome.mp4?v=${WELCOME_VERSION}`, appUrl(env, url)).href;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/telegram") {
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      if (!sameSecret(request.headers.get("x-telegram-bot-api-secret-token"), env.TELEGRAM_WEBHOOK_SECRET)) {
        return new Response("forbidden", { status: 403 });
      }
      let update;
      try { update = await request.json(); } catch { return new Response("bad request", { status: 400 }); }
      const db = d1Binding(env.DB);
      const now = nowS();
      try {
        await handleUpdate(update, {
          db, now, cfg: CONFIG, appUrl: appUrl(env, url), ownerId: env.OWNER_TELEGRAM_ID,
          welcomeAnimation: welcomeAnimationUrl(env, url),
          reply: (chatId, text, extra) => sendPlain(env.TELEGRAM_BOT_TOKEN, chatId, text, extra),
          tg: (method, body) => tgCall(env.TELEGRAM_BOT_TOKEN, method, body),
        });
      } catch (e) {
        await logError(db, `webhook: ${e.message}`, now);
      }
      return new Response("ok");   // always 200, or Telegram retries the same update
    }
    if (url.pathname.startsWith("/api/")) {
      const db = d1Binding(env.DB);
      const now = nowS();
      try {
        return await handleApi(request, env, db, now, {
          send: userSender(env, (chatId, text, extra) => sendDigestMessage(env.TELEGRAM_BOT_TOKEN, chatId, text, extra)),
          dispatch: (e) => dispatchJob(e),
          tg: (method, body) => tgCall(env.TELEGRAM_BOT_TOKEN, method, body),
          appUrl: appUrl(env, url),
        });
      } catch (e) {
        await logError(db, `api ${url.pathname}: ${e.message}`, now);
        return json(500, { error: t("en", "errors.server"), code: "server" });
      }
    }
    if (url.pathname === "/") return new Response("Axiom News bot\n");
    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env) {
    const db = d1Binding(env.DB);
    const now = Math.floor((event.scheduledTime ?? Date.now()) / 1000);
    const hourly = event.cron === HOURLY_CRON;
    const sw = switches(env);
    const extraProblems = [];
    try {
      if (hourly && sw.dispatch) {
        const r = await dispatchJob(env);
        if (!r.ok) extraProblems.push(r.problem);
      }
      const out = await runTick(db, {
        send: userSender(env, (chatId, text, extra) => sendDigestMessage(env.TELEGRAM_BOT_TOKEN, chatId, text, extra)),
        appUrl: env.APP_URL,
        alert: (text) => sendPlain(env.TELEGRAM_BOT_TOKEN, Number(env.OWNER_TELEGRAM_ID), text),
      }, now, { digests: !hourly && sw.userSends, guard: hourly && sw.alerts, health: sw.alerts, extraProblems });
      // Step 17: the account's free limits (D1 rows, Worker CPU), production only, once an hour
      let usage = {};
      if (hourly && sw.alerts) {
        try {
          usage = await checkUsage(db, env, now, {
            fetch: (u, o) => fetch(u, o),
            alert: (text) => sendPlain(env.TELEGRAM_BOT_TOKEN, Number(env.OWNER_TELEGRAM_ID), text),
          });
        } catch (e) {
          await logError(db, `usage check: ${e.message}`, now);
        }
      }
      console.log(JSON.stringify({ tick: event.cron, env: envName(env), hourly, ...out, ...usage }));
    } catch (e) {
      await logError(db, `cron ${event.cron}: ${e.message}`, now);
      throw e;
    }
  },
};
