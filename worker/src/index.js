// Axiom News Worker: Telegram webhook, digest cron (every 5 min), hourly GitHub job trigger
// and job health alerts. No Mini App yet.
import { CONFIG } from "./digest.js";
import { d1Binding, logError } from "./db.js";
import { handleUpdate } from "./bot.js";
import { runTick } from "./cron.js";
import { dispatchJob } from "./github.js";
import { sendHtml, sendPlain } from "./telegram.js";

export const HOURLY_CRON = "7 * * * *";

function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const nowS = () => Math.floor(Date.now() / 1000);

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
          db, now, cfg: CONFIG, reply: (chatId, text) => sendPlain(env.TELEGRAM_BOT_TOKEN, chatId, text),
        });
      } catch (e) {
        await logError(db, `webhook: ${e.message}`, now);
      }
      return new Response("ok");   // always 200, or Telegram retries the same update
    }
    if (url.pathname === "/") return new Response("Axiom News bot\n");
    return new Response("not found", { status: 404 });
  },

  async scheduled(event, env) {
    const db = d1Binding(env.DB);
    const now = Math.floor((event.scheduledTime ?? Date.now()) / 1000);
    const hourly = event.cron === HOURLY_CRON;
    const extraProblems = [];
    try {
      if (hourly) {
        const r = await dispatchJob(env);
        if (!r.ok) extraProblems.push(r.problem);
      }
      const out = await runTick(db, {
        send: (chatId, html) => sendHtml(env.TELEGRAM_BOT_TOKEN, chatId, html),
        alert: (text) => sendPlain(env.TELEGRAM_BOT_TOKEN, Number(env.OWNER_TELEGRAM_ID), text),
      }, now, { digests: !hourly, extraProblems });
      console.log(JSON.stringify({ tick: event.cron, hourly, ...out }));
    } catch (e) {
      await logError(db, `cron ${event.cron}: ${e.message}`, now);
      throw e;
    }
  },
};
