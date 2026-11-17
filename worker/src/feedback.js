// Step 15: "Send feedback" in Settings. A reader writes up to 1,000 characters; the Worker stores
// it (table feedback) and forwards it to the owner on Telegram with the reader's first name and id.
// At most 10 a reader in any 24 hours (rolling, like the topic checks). Admin lists the latest 20.
import { SettingsError } from "./settings.js";

export const FEEDBACK = { max_chars: 1000, per_day: 10, admin_rows: 20 };
const DAY = 86400;

const escHtml = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const chars = (s) => [...s].length;   // code points, as a reader counts them

// The text to store: one string, trimmed, control characters out (new lines kept), never empty or
// too long. Throws SettingsError with a code the Mini App shows in the reader's language.
export function cleanFeedback(raw) {
  if (typeof raw !== "string") throw new SettingsError("feedback_empty");
  const text = raw.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new SettingsError("feedback_empty");
  if (chars(text) > FEEDBACK.max_chars) throw new SettingsError("feedback_long", { max: FEEDBACK.max_chars });
  return text;
}

export function ownerMessage(user, tgUser, text) {
  const name = user?.first_name || tgUser?.first_name || "";
  return `💬 <b>Feedback from ${escHtml(name) || "a reader"}</b> (id ${Number(tgUser.id)})\n\n${escHtml(text)}`;
}

export const countStatement = (userId, now) =>
  ({ sql: "SELECT count(*) AS n FROM feedback WHERE user_id = ?1 AND at >= ?2", params: [userId, now - DAY] });

// POST /api/feedback {text}. Stored first, then forwarded; a failed forward is kept and logged
// (forwarded = 0), the reader still gets their "Thank you".
export async function sendFeedback(db, tgUser, body, now, io, ownerId) {
  const text = cleanFeedback(body?.text);
  const [[count], [user]] = await db.batch([countStatement(tgUser.id, now),
    { sql: "SELECT first_name FROM users WHERE id = ?1", params: [tgUser.id] }]);
  if (Number(count?.n ?? 0) >= FEEDBACK.per_day) throw new SettingsError("feedback_limit", { max: FEEDBACK.per_day });
  let forwarded = 0;
  try {
    if (ownerId) {
      await io.send(Number(ownerId), ownerMessage(user, tgUser, text));
      forwarded = 1;
    }
  } catch { /* stored anyway; Admin shows it as not forwarded */ }
  await db.batch([{ sql: "INSERT INTO feedback (user_id, at, text, forwarded) VALUES (?1, ?2, ?3, ?4)",
    params: [tgUser.id, now, text, forwarded] }]);
  return { ok: true };
}

// Admin: the latest messages with the reader's first name and language.
export function feedbackStatements() {
  return [
    { sql: "SELECT f.id, f.user_id, f.at, f.text, f.forwarded, u.first_name, u.lang FROM feedback f LEFT JOIN users u ON u.id = f.user_id " +
           "ORDER BY f.at DESC, f.id DESC LIMIT ?1", params: [FEEDBACK.admin_rows] },
    { sql: "SELECT count(*) AS n FROM feedback WHERE at >= ?1", params: [0] },
  ];
}
export const FEEDBACK_ADMIN_COUNT = 2;

export function shapeFeedback(rows, total) {
  return { total: Number(total?.[0]?.n ?? 0), recent: (rows ?? []).map((r) => ({ id: r.id, user_id: r.user_id, at: r.at, text: r.text,
    forwarded: !!r.forwarded, name: r.first_name ?? "", lang: r.lang ?? "" })) };
}
