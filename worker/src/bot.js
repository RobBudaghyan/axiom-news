// Telegram webhook: /start creates the user with default settings, /settings opens the Mini App;
// anything else gets a short helpful reply. Replies are plain text (no HTML), never with an em
// dash, in the user's language (Step 9: config/i18n/<lang>.json). /start and /settings carry an
// "Open settings" button (web_app).
//
// Language (Step 9): a NEW user starts in Telegram's language_code if we support it, else English
// (chooseLang). After that only the Mini App changes users.lang: /start never does.
import { CONFIG, describeSlot, nextSlot, parseList } from "./digest.js";
import { chooseLang, commandList, effectiveLang, listJoin, t, topicLabel, zoneName } from "./i18n.js";
import { settingsButton } from "./telegram.js";
import { errorStatement } from "./db.js";
import { needsSetup, setupButton } from "./onboard.js";
import { TIP_AMOUNTS, amountOf, allowedAmount, answerPreCheckout, invoiceFields, recordPayment } from "./tips.js";

export function settingsText(lang = "en") {
  return t(lang, "bot.settings");
}

function topicNames(tags, topics, lang) {
  return listJoin(lang, tags.map((tag) => topicLabel(lang, tag, topics.find((x) => x.tag === tag)?.label_en ?? tag)));
}

const zoneText = (lang, tz) => t(lang, "bot.zone", { zone: zoneName(lang, tz) });

export function welcomeText(user, topics, now, isNew, lang = effectiveLang(user)) {
  const tz = user.timezone;
  const name = user.first_name || t(lang, "bot.friend");
  const hello = t(lang, isNew ? "bot.welcome_new" : "bot.welcome_back", { name });
  return `${hello}\n\n` +
    `${t(lang, "bot.welcome_times", { times: listJoin(lang, parseList(user.digest_times)), zone: zoneText(lang, tz) })}\n` +
    `${t(lang, "bot.welcome_topics", { topics: topicNames(parseList(user.topics), topics, lang) })}\n` +
    t(lang, "bot.welcome_next", { when: describeSlot(user.next_digest_at, now, tz, lang), button: t(lang, "bot.button") });
}

// Step 17b: the welcome for a new reader (HTML: "Set up" in bold), the same for everyone.
export const welcomeSetupText = (user, lang = effectiveLang(user)) => t(lang, "bot.welcome_setup");

// Step 17b: the welcome is ONE message: the welcome video (public/media/welcome.mp4, sent by URL;
// Step 19: the logo animation, then how it works, 11 s, no words, loops) with the text as its caption and the Set up button. If Telegram refuses the animation, the
// same text and button go as a plain message, so a new reader always gets the welcome.
export async function sendWelcome(ctx, chatId, user, lang) {
  const text = welcomeSetupText(user, lang);
  const extra = { parse_mode: "HTML", ...setupButton(ctx.appUrl, lang) };
  if (ctx.tg && ctx.welcomeAnimation) {
    try {
      await ctx.tg("sendAnimation", { chat_id: chatId, animation: ctx.welcomeAnimation, caption: text,
        width: 1280, height: 720, duration: 11, ...extra });
      return "animation";
    } catch (e) {
      if (e.status === 403) throw e;   // blocked: nothing else would arrive either
      await ctx.db.batch([errorStatement(`welcome animation for ${chatId}: ${e.message}`, ctx.now)]);
    }
  }
  await ctx.reply(chatId, text, extra);
  return "text";
}

export function helpText(user, now, lang = effectiveLang(user)) {
  if (!user) return t(lang, "bot.help_new");
  return t(lang, "bot.help", {
    times: listJoin(lang, parseList(user.digest_times)), zone: zoneText(lang, user.timezone),
    when: describeSlot(user.next_digest_at, now, user.timezone, lang),
  });
}

const button = (ctx, lang) => (ctx.appUrl ? settingsButton(ctx.appUrl, t(lang, "bot.button")) : undefined);

// The chat menu button label and the command list for ONE chat, in its language (Step 9). The
// bot-wide defaults (setup-bot.mjs) follow Telegram's app language; a per-chat setting follows
// the language the user chose. A Telegram failure is logged and never fails the caller.
export async function setChatLanguage(tg, chatId, lang, appUrl) {
  if (!tg) return [];
  const problems = [];
  const calls = [
    ["setMyCommands", { commands: commandList(lang), scope: { type: "chat", chat_id: chatId } }],
    ...(appUrl ? [["setChatMenuButton", { chat_id: chatId,
      menu_button: { type: "web_app", text: t(lang, "bot.menu_button"), web_app: { url: appUrl } } }]] : []),
  ];
  for (const [method, body] of calls) {
    try { await tg(method, body); } catch (e) { problems.push(`${method} for ${chatId}: ${e.message}`); }
  }
  return problems;
}

// The /support reply's amount buttons (callback "tip:<n>"): one row of three, the same for everyone
// (Step 11).
export function supportKeyboard(lang) {
  const btn = (a) => ({ text: t(lang, "bot.support_amount", { amount: a }), callback_data: `tip:${a}` });
  return { reply_markup: { inline_keyboard: [TIP_AMOUNTS.map(btn)] } };
}

const userLang = async (db, id, code) => {
  const [rows] = await db.batch([{ sql: "SELECT lang FROM users WHERE id = ?1", params: [id] }]);
  return effectiveLang(rows[0] ?? { lang: chooseLang(code) });
};

// ctx: {db, now, reply(chatId, text, extra), tg(method, body)?, cfg, appUrl, ownerId}
export async function handleUpdate(update, ctx) {
  // Step 10: Telegram cancels a payment that is not confirmed within 10 seconds, so this is
  // answered first and without any database read.
  if (update.pre_checkout_query) {
    const q = update.pre_checkout_query;
    const ok = await answerPreCheckout(q, ctx.tg, chooseLang(q.from?.language_code));
    return { handled: true, command: "pre_checkout", ok };
  }
  if (update.callback_query) return handleCallback(update.callback_query, ctx);
  // Step 17: Telegram tells us when a reader blocks the bot (my_chat_member, status "kicked"): mark them
  // blocked at once, so no digest, reminder or announcement is even tried. Unblocking needs no step here:
  // the reader presses Start, and /start clears blocked and plans the next digest.
  if (update.my_chat_member) {
    const m = update.my_chat_member;
    if (m.chat?.type !== "private" || !m.from?.id) return { handled: false };
    if (m.new_chat_member?.status === "kicked") {
      await ctx.db.batch([{ sql: "UPDATE users SET blocked = 1 WHERE id = ?1", params: [m.from.id] }]);
      return { handled: true, command: "blocked" };
    }
    return { handled: true, command: "chat_member" };
  }
  const msg = update.message;
  if (!msg?.from || msg.chat?.type !== "private") return { handled: false };
  const cfg = ctx.cfg ?? CONFIG;
  const { db, now } = ctx;
  const id = msg.from.id;
  const text = (msg.text ?? "").trim();
  if (msg.refunded_payment) {   // Telegram's note of a refund (ours from Admin, already marked)
    await db.batch([{ sql: "UPDATE tips SET refunded_at = ?1 WHERE charge_id = ?2 AND refunded_at IS NULL",
                      params: [now, String(msg.refunded_payment.telegram_payment_charge_id)] }]);
    return { handled: true, command: "refunded_payment" };
  }
  if (msg.successful_payment) {
    const r = await recordPayment(db, id, msg.successful_payment, now);
    if (r.stored) await ctx.reply(id, t(await userLang(db, id, msg.from.language_code), "bot.tip_thanks", { amount: r.amount }));
    return { handled: true, command: "successful_payment", stored: r.stored };
  }
  const [rows, topics] = await db.batch([
    { sql: "SELECT * FROM users WHERE id = ?1", params: [id] },
    { sql: "SELECT tag, label_en, emoji, sort, is_default FROM topics ORDER BY sort", params: [] },
  ]);
  let user = rows[0];

  if (/^\/start(@\w+)?(\s|$)/.test(text)) {
    const isNew = !user;
    const firstName = (msg.from.first_name ?? "").slice(0, 64);
    const language = (msg.from.language_code ?? "en").slice(0, 8);
    if (isNew) {
      const defaults = topics.filter((x) => x.is_default).map((x) => x.tag);
      user = {
        id, first_name: firstName, language, lang: chooseLang(language), timezone: cfg.default_timezone,
        digest_times: JSON.stringify(cfg.default_times),
        topics: JSON.stringify(defaults), paused: 0, created_at: now,
      };
      user.next_digest_at = nextSlot(now, user.timezone, cfg.default_times);
      await db.batch([{
        sql: "INSERT INTO users (id, first_name, language, lang, timezone, digest_times, topics, " +
             "created_at, next_digest_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(id) DO NOTHING",
        params: [id, firstName, language, user.lang, user.timezone, user.digest_times, user.topics, now,
                 user.next_digest_at],
      }]);
    } else {
      // `language` (Telegram's) is refreshed; `lang` (the user's choice) is left alone.
      user = { ...user, first_name: firstName || user.first_name, language, paused: 0, blocked: 0 };
      user.next_digest_at = nextSlot(now, user.timezone, parseList(user.digest_times, cfg.default_times));
      await db.batch([{
        sql: "UPDATE users SET first_name = ?1, language = ?2, paused = 0, blocked = 0, next_digest_at = ?3 WHERE id = ?4",
        params: [user.first_name, language, user.next_digest_at, id],
      }]);
    }
    const lang = effectiveLang(user);
    // Step 15: a new user (or one who has not finished the setup yet) gets a short welcome and the
    // "Set up" button; a returning or imported user gets the usual "welcome back" with settings.
    if (isNew || needsSetup(user)) {
      await sendWelcome(ctx, id, user, lang);
    } else {
      await ctx.reply(id, welcomeText(user, topics, now, false, lang), button(ctx, lang));
    }
    if (isNew && lang !== "en") {
      const problems = await setChatLanguage(ctx.tg, id, lang, ctx.appUrl);
      if (problems.length) await db.batch(problems.map((p) => errorStatement(p, now)));
    }
    return { handled: true, command: "start", isNew, lang };
  }

  const lang = effectiveLang(user ?? { lang: chooseLang(msg.from.language_code) });
  if (/^\/settings(@\w+)?(\s|$)/.test(text)) {
    await ctx.reply(id, settingsText(lang), button(ctx, lang));
    return { handled: true, command: "settings", lang };
  }
  // Step 15: help lives in Settings (Help and Send feedback); /help only points there.
  if (/^\/help(@\w+)?(\s|$)/.test(text)) {
    await ctx.reply(id, t(lang, "bot.help_cmd"), button(ctx, lang));
    return { handled: true, command: "help", lang };
  }
  if (/^\/support(@\w+)?(\s|$)/.test(text)) {
    await ctx.reply(id, t(lang, "bot.support"), supportKeyboard(lang));
    return { handled: true, command: "support", lang };
  }
  if (/^\/terms(@\w+)?(\s|$)/.test(text)) {
    await ctx.reply(id, t(lang, "bot.terms"));
    return { handled: true, command: "terms", lang };
  }
  const ps = /^\/paysupport(@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  if (ps) {
    const note = (ps[2] ?? "").trim().slice(0, 800);
    if (!note) {
      await ctx.reply(id, t(lang, "bot.paysupport"));
      return { handled: true, command: "paysupport", lang };
    }
    // To the owner (English, like every owner message): who asked, and the note as written.
    if (ctx.ownerId) await ctx.reply(Number(ctx.ownerId), `Payment support request from ${msg.from.first_name || "a user"} ` +
      `(id ${id}${msg.from.username ? `, @${msg.from.username}` : ""}):
${note}

Their tips are in Admin, under Tips.`);
    await ctx.reply(id, t(lang, "bot.paysupport_sent"));
    return { handled: true, command: "paysupport", lang, forwarded: true };
  }

  await ctx.reply(id, helpText(user, now, lang));
  return { handled: true, command: "help", lang };
}

// A tap on an amount under /support: an invoice in the chat (sendInvoice). Other buttons: ignored.
async function handleCallback(cq, ctx) {
  const amount = amountOf(cq.data);
  const chatId = cq.message?.chat?.id ?? cq.from?.id;
  try { await ctx.tg("answerCallbackQuery", { callback_query_id: cq.id }); } catch { /* the button just stops spinning later */ }
  if (amount == null || cq.message?.chat?.type !== "private") return { handled: false };
  const lang = await userLang(ctx.db, cq.from.id, cq.from.language_code);
  if (!allowedAmount(amount)) {
    await ctx.reply(chatId, t(lang, "bot.tip_bad"));
    return { handled: true, command: "tip", ok: false };
  }
  await ctx.tg("sendInvoice", { chat_id: chatId, ...invoiceFields(lang, amount) });
  return { handled: true, command: "tip", ok: true, amount };
}
