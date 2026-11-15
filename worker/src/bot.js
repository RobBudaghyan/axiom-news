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
    `${t(lang, "bot.welcome_times", { times: listJoin(lang, parseList(user.digest_times)), zone: zoneText(lang, tz) })} ` +
    `${t(lang, "bot.welcome_topics", { topics: topicNames(parseList(user.topics), topics, lang) })}\n\n` +
    t(lang, "bot.welcome_next", { when: describeSlot(user.next_digest_at, now, tz, lang), button: t(lang, "bot.button") });
}

export function helpText(user, now, lang = effectiveLang(user)) {
  if (!user) return t(lang, "bot.help_new");
  if (user.paused) return t(lang, "bot.help_paused");
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

// ctx: {db, now, reply(chatId, text, extra), tg(method, body)?, cfg, appUrl}
export async function handleUpdate(update, ctx) {
  const msg = update.message;
  if (!msg?.from || msg.chat?.type !== "private") return { handled: false };
  const cfg = ctx.cfg ?? CONFIG;
  const { db, now } = ctx;
  const id = msg.from.id;
  const text = (msg.text ?? "").trim();
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
    await ctx.reply(id, welcomeText(user, topics, now, isNew, lang), button(ctx, lang));
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

  await ctx.reply(id, helpText(user, now, lang));
  return { handled: true, command: "help", lang };
}
