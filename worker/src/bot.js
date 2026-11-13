// Telegram webhook: /start creates the user with default settings; anything else gets a short
// helpful reply. Replies are plain text (no HTML), never with an em dash.
import { CONFIG, describeSlot, nextSlot, parseList, zoneLabel } from "./digest.js";

function listTimes(times) {
  if (times.length === 1) return times[0];
  return `${times.slice(0, -1).join(", ")} and ${times[times.length - 1]}`;
}

function topicNames(tags, topics) {
  const names = tags.map((t) => topics.find((x) => x.tag === t)?.label_en ?? t);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function welcomeText(user, topics, now, isNew) {
  const tz = user.timezone;
  const times = parseList(user.digest_times);
  const when = describeSlot(user.next_digest_at, now, tz);
  const hello = isNew ? `Welcome to Axiom News, ${user.first_name || "friend"}!` :
    `Welcome back, ${user.first_name || "friend"}!`;
  return `${hello}\n\n` +
    `I send you a short digest of the most important news at ${listTimes(times)} (${zoneLabel(tz)} time). ` +
    `Topics: ${topicNames(parseList(user.topics), topics)}.\n\n` +
    `Your next digest comes ${when}. A settings page to change topics and times is coming soon.`;
}

export function helpText(user, now) {
  if (!user) return "Hi! Send /start and I will send you short news digests three times a day.";
  if (user.paused) return "Your digests are paused. Send /start to turn them back on.";
  const when = describeSlot(user.next_digest_at, now, user.timezone);
  return `I send news digests at ${listTimes(parseList(user.digest_times))} (${zoneLabel(user.timezone)} time). ` +
    `Your next one comes ${when}. I can't answer questions yet; the digest is all I do.`;
}

// ctx: {db, now, reply(chatId, text), cfg}
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
      const defaults = topics.filter((t) => t.is_default).map((t) => t.tag);
      user = {
        id, first_name: firstName, language, timezone: cfg.default_timezone,
        digest_times: JSON.stringify(cfg.default_times), max_stories: cfg.default_stories,
        topics: JSON.stringify(defaults), paused: 0, created_at: now,
      };
      user.next_digest_at = nextSlot(now, user.timezone, cfg.default_times);
      await db.batch([{
        sql: "INSERT INTO users (id, first_name, language, timezone, digest_times, max_stories, topics, " +
             "created_at, next_digest_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(id) DO NOTHING",
        params: [id, firstName, language, user.timezone, user.digest_times, user.max_stories, user.topics, now,
                 user.next_digest_at],
      }]);
    } else {
      user = { ...user, first_name: firstName || user.first_name, language, paused: 0, blocked: 0 };
      user.next_digest_at = nextSlot(now, user.timezone, parseList(user.digest_times, cfg.default_times));
      await db.batch([{
        sql: "UPDATE users SET first_name = ?1, language = ?2, paused = 0, blocked = 0, next_digest_at = ?3 WHERE id = ?4",
        params: [user.first_name, language, user.next_digest_at, id],
      }]);
    }
    await ctx.reply(id, welcomeText(user, topics, now, isNew));
    return { handled: true, command: "start", isNew };
  }

  await ctx.reply(id, helpText(user, now));
  return { handled: true, command: "help" };
}
