// Step 15: the welcome flow.
//   - /start from a new user: a short welcome in their Telegram language and a "Set up" button
//     (bot.js). Users imported from the old bot (users.imported = 1) get no welcome.
//   - The first Mini App open shows a setup (Step 16: language, topics, times, done), skippable (app.js).
//   - Done or skipped: POST /api/onboard marks the user onboarded ONCE and sends a sample digest of
//     the last 24 hours, following every normal rule (topics, never twice: its stories are marked
//     sent, the translation hold).
//   - A user who never opened the Mini App gets exactly one gentle reminder the next day, between
//     10:00 and 20:00 their time; defaults (Asia/Yerevan, 09/14/20, all main topics) apply meanwhile.
import { CONFIG, candidateStatement, escapeHtml, localParts, planDigest } from "./digest.js";
import { allTopicsOff, digestWrites, sendDigest } from "./cron.js";
import { asTopicRows, enabledOnly, followedStatement, withCustomTopics } from "./custom.js";
import { effectiveLang, t } from "./i18n.js";
import { errorStatement } from "./db.js";

const DAY = 86400;
export const REMINDER = { after_s: DAY, from_hour: 10, to_hour: 20, per_tick: 8 };

const TOPICS_SQL = "SELECT tag, label_en, emoji, sort, is_default FROM topics ORDER BY sort";

// The "Set up" button: opens the Mini App (the setup shows there while the user is not onboarded).
export const setupButton = (appUrl, lang) =>
  (appUrl ? { reply_markup: { inline_keyboard: [[{ text: t(lang, "bot.setup_button"), web_app: { url: appUrl } }]] } } : {});

// Builds and sends one digest to one user now, exactly as the cron does, and records it (sent rows,
// held stories, last and next digest). opts.labelKey: a line above the greeting; opts.sample: the sample digest (Step 17: no label, its own greeting line, at most 8 stories, 2 a topic).
// Used by Admin's "Send me a digest now" and by the sample digest after the setup.
export async function sendDigestNow(db, userId, now, cfg, io, opts = {}) {
  const [rows, topics, custom] = await db.batch([{ sql: "SELECT * FROM users WHERE id = ?1", params: [userId] },
    { sql: TOPICS_SQL, params: [] }, followedStatement(userId)]);
  const user = rows[0];
  if (!user) return null;
  // Step 16: every topic off means nothing at all, not even a quiet note
  if (allTopicsOff(user, enabledOnly(custom))) return { user, plan: null, ids: [], off: true };
  const u = withCustomTopics(user, custom);
  const [cands] = await db.batch([candidateStatement(u, now, cfg)]);
  const lang = effectiveLang(user);
  const label = opts.labelKey ? `<i>${escapeHtml(t(lang, opts.labelKey))}</i>` : undefined;
  const popts = { ...(label ? { label } : {}), ...(opts.sample ? { sample: true } : {}) };   // Step 17: the sample digest
  const plan = planDigest(u, cands, [...topics, ...asTopicRows(enabledOnly(custom))], now, cfg, popts);
  const ids = await sendDigest(io, user.id, plan);
  await db.batch(digestWrites(user, plan, ids, now));
  return { user, plan, ids };
}

// Does this user still need the setup? Not once done or skipped, never for an imported user.
export const needsSetup = (user) => !!user && !user.onboarded_at && !Number(user.imported ?? 0);

// POST /api/onboard {skipped}: the first call marks the user onboarded and sends the sample digest;
// a repeated call (a double tap, a second device) changes nothing and sends nothing.
// Step 18 (owner): the setup's topics step starts with every topic off, so Skip puts the defaults (the
// six main topics) back on, in the same statement that ends the setup.
export async function onboard(db, userId, body, now, cfg, io) {
  const [claimed] = await db.batch([{
    sql: "UPDATE users SET onboarded_at = ?2, topics = CASE WHEN ?3 = 1 THEN " +
         "(SELECT json_group_array(tag) FROM (SELECT tag FROM topics WHERE is_default = 1 ORDER BY sort)) ELSE topics END " +
         "WHERE id = ?1 AND onboarded_at IS NULL AND imported = 0 RETURNING id",
    params: [userId, now, body?.skipped === true ? 1 : 0] }]);
  if (!claimed.length) return { sample: false };
  try {
    const r = await sendDigestNow(db, userId, now, cfg, io, { sample: true });
    return { sample: !!r && !r.off, stories: r ? r.ids.length : 0, skipped: !!body?.skipped };
  } catch (e) {
    await db.batch([errorStatement(`sample digest for user ${userId}: ${e.message}`, now)]);
    return { sample: false, error: true };
  }
}

// ------------------------------------------------------------------ the one reminder

// Users who never opened the Mini App, a day after /start, not imported, not reminded yet. A few
// more than a tick sends, because some are outside 10:00-20:00 their time.
export const reminderStatement = (now) => ({
  sql: "SELECT id, first_name, lang, timezone, digest_times FROM users WHERE opened_at IS NULL AND onboarded_at IS NULL " +
       "AND imported = 0 AND reminded_at IS NULL AND blocked = 0 AND created_at <= ?1 ORDER BY created_at LIMIT ?2",
  params: [now - REMINDER.after_s, REMINDER.per_tick * 3],
});

// Step 17b: the same short HTML text for everyone ("Set up" in bold), no name or times.
export function reminderText(user, lang = effectiveLang(user)) {
  return t(lang, "bot.reminder");
}

export const inReminderHours = (user, now) => {
  const h = localParts(now, user.timezone || CONFIG.default_timezone).hour;
  return h >= REMINDER.from_hour && h < REMINDER.to_hour;
};

// Claims the reminders first (reminded_at, only where still NULL), then sends: at most one reminder
// per user ever, even if a send fails or two ticks overlap. Returns {sent, failed, blocked}.
export async function runReminders(db, io, rows, now) {
  const due = (rows ?? []).filter((u) => inReminderHours(u, now)).slice(0, REMINDER.per_tick);
  const out = { sent: 0, failed: 0, blocked: 0 };
  if (!due.length) return out;
  const claims = await db.batch(due.map((u) => ({
    sql: "UPDATE users SET reminded_at = ?2 WHERE id = ?1 AND reminded_at IS NULL RETURNING id", params: [u.id, now] })));
  const writes = [];
  for (let i = 0; i < due.length; i++) {
    if (!claims[i]?.length) continue;   // another tick took it
    const u = due[i];
    const lang = effectiveLang(u);
    try {
      await io.send(u.id, reminderText(u, lang), setupButton(io.appUrl, lang));
      out.sent++;
    } catch (e) {
      out.failed++;
      if (e.status === 403) {
        out.blocked++;
        writes.push({ sql: "UPDATE users SET blocked = 1 WHERE id = ?1", params: [u.id] });
      } else writes.push(errorStatement(`reminder for user ${u.id}: ${e.message}`, now));
    }
  }
  if (writes.length) await db.batch(writes);
  return out;
}
