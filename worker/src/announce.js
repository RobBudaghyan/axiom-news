// Step 15: the owner's announcement tool (Admin, English only for the owner).
//   draft    the owner writes in English and picks the audience (all users or one language); the AI
//            chain (the same as the topic check) translates it into every language that audience
//            reads, in one call; each version is checked (no em or en dash, the same numbers, the
//            right alphabet, Russian "сводка" and "на Украине"). A version that fails is left empty
//            with a note, for the owner to write.
//   preview  the owner's (edited) versions are saved and each is sent to the owner first.
//   send     only after a preview of exactly these texts; the cron sends in batches.
//   cron     each tick (every minute since Step 16) claims up to `per_tick` users (a row in announcement_sends written
//            BEFORE the message goes out, so a retried tick never sends twice), sends each user
//            their language (English if theirs has no version), and marks the result.
import { askAI, aiCallStatements } from "./custom.js";
import { escapeHtml } from "./digest.js";
import { LANGS } from "./i18n.js";
import { errorStatement } from "./db.js";

export const ANNOUNCE = { max_chars: 2000, per_tick: 25 };
const DASH = /[‒–—―]/g;
const LANG_NAMES = { en: "English", ru: "Russian", hy: "Armenian", fr: "French" };

// One line of cleaning for every version: no em or en dash (owner rule), no control characters,
// at most two line breaks in a row.
export function cleanText(raw) {
  return String(raw ?? "").replace(/\r\n?/g, "\n").replace(/\s+[‒–—―]\s+/g, ", ").replace(DASH, "-")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

const numbers = (s) => (String(s).match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,/g, "")).sort().join(" ");
const ALPHABET = { ru: /[Ѐ-ӿ]/, hy: /[԰-֏]/, fr: /[a-zà-ÿ]/i, en: /[a-z]/i };

// Why a version cannot be used as it is, or null.
export function versionProblem(lang, text, english) {
  if (!text) return "empty";
  if (DASH.test(text)) { DASH.lastIndex = 0; return "has an em or en dash"; }
  if (english && numbers(text) !== numbers(english)) return "the numbers differ from the English";
  if (ALPHABET[lang] && !ALPHABET[lang].test(text)) return "wrong alphabet";
  if (lang === "ru" && /дайджест/i.test(text)) return "says дайджест, not сводка";
  if (lang === "ru" && /(^|[^\p{L}])во?\s+Украин/iu.test(text)) return "says в Украине, not на Украине";   // \b does not work with Cyrillic
  if ([...text].length > ANNOUNCE.max_chars * 1.6) return "too long";
  return null;
}

export function translatePrompt(english, langs) {
  return `You translate a short announcement from the Axiom News Telegram bot (a news digest) for its readers.
Translate the English text below into: ${langs.map((l) => `${LANG_NAMES[l] ?? l} (${l})`).join(", ")}.
Keep the meaning, the tone (friendly, brief) and the line breaks. Keep every number exactly. Keep names
such as "Axiom News", "Telegram" and any @username as they are. Never use the em dash or the en dash
characters; use a comma, a colon or a plain hyphen. In Russian, "digest" is always "сводка" (never
"дайджест") and Ukraine always takes "на" ("на Украине"). Write natural text a native speaker would write.

ENGLISH TEXT:
${english}

Return JSON only: {"translations": {${langs.map((l) => `"${l}": "..."`).join(", ")}}}`;
}

export const translateSchema = (langs) => ({
  type: "object",
  properties: { translations: { type: "object", properties: Object.fromEntries(langs.map((l) => [l, { type: "string" }])), required: langs } },
  required: ["translations"],
});

// The languages an audience reads: every language an active (not blocked) user reads, or the one
// chosen; English always (the fallback for a user whose language has no version).
export const audienceLangsStatement = () => ({ sql: "SELECT DISTINCT lang FROM users WHERE blocked = 0", params: [] });
export function audienceLangs(rows, audience) {
  const used = new Set((rows ?? []).map((r) => r.lang).filter((l) => LANGS.enabled.includes(l) || l === "en"));
  const langs = audience === "all" ? [...used] : [audience];
  return [...new Set(["en", ...langs])];
}

// draft: translate and store. Returns the announcement {id, status, audience, texts, notes}.
export async function draftAnnouncement(db, env, body, now) {
  const english = cleanText(body?.text);
  const audience = body?.audience === "all" || LANGS.enabled.includes(body?.audience) ? body.audience : null;
  if (!english) return { error: "Write the announcement in English first." };
  if ([...english].length > ANNOUNCE.max_chars) return { error: `Up to ${ANNOUNCE.max_chars} characters.` };
  if (!audience) return { error: "Choose all users or one language." };
  const [langRows] = await db.batch([audienceLangsStatement()]);
  const langs = audienceLangs(langRows, audience);
  const others = langs.filter((l) => l !== "en");
  const texts = { en: english }, notes = {};
  let calls = [];
  if (others.length) {
    const r = await askAI(env, translatePrompt(english, others), "en", now, { db,
      schema: translateSchema(others), schemaName: "announcement", maxTokens: 4096, timeoutMs: 20000,
      validate: (data) => (data && typeof data.translations === "object" ? data.translations : null) });
    calls = r.calls;
    for (const l of others) {
      const v = cleanText(r.answer?.[l]);
      const problem = r.answer ? versionProblem(l, v, english) : "the AI did not answer";
      if (problem) { texts[l] = ""; notes[l] = problem; } else texts[l] = v;
    }
  }
  const [ins] = await db.batch([
    ...aiCallStatements(calls, "announce_translate"),
    { sql: "INSERT INTO announcements (created_at, status, audience, texts, notes) VALUES (?1, 'draft', ?2, ?3, ?4) RETURNING id",
      params: [now, audience, JSON.stringify(texts), JSON.stringify(notes)] },
  ]).then((rows) => rows.slice(-1));
  return { id: ins[0].id, status: "draft", audience, texts, notes };
}

async function load(db, id) {
  const [[a]] = await db.batch([{ sql: "SELECT * FROM announcements WHERE id = ?1", params: [Number(id) || 0] }]);
  return a ? { ...a, texts: JSON.parse(a.texts || "{}"), notes: JSON.parse(a.notes || "{}") } : null;
}

// The owner's edited versions: cleaned and checked; every version the audience needs must be usable.
function checkTexts(a, incoming, langRows) {
  const langs = audienceLangs(langRows, a.audience);
  const texts = {};
  for (const l of langs) texts[l] = cleanText(incoming?.[l] ?? a.texts[l]);
  for (const l of langs) {
    const p = versionProblem(l, texts[l], texts.en);
    if (p) return { error: `${LANG_NAMES[l] ?? l}: ${p}.` };
  }
  return { texts };
}

// preview: save the versions and send each to the owner, labelled.
export async function previewAnnouncement(db, body, now, io, ownerId) {
  const a = await load(db, body?.id);
  if (!a) return { error: "That announcement is gone." };
  if (!["draft", "previewed"].includes(a.status)) return { error: `It is already ${a.status}.` };
  const [langRows] = await db.batch([audienceLangsStatement()]);
  const c = checkTexts(a, body?.texts, langRows);
  if (c.error) return c;
  for (const [l, text] of Object.entries(c.texts)) {
    await io.send(Number(ownerId), `<i>Announcement preview (${LANG_NAMES[l] ?? l}). Not sent to anyone yet.</i>\n\n${escapeHtml(text)}`);
  }
  await db.batch([{ sql: "UPDATE announcements SET texts = ?2, status = 'previewed', previewed_at = ?3 WHERE id = ?1",
    params: [a.id, JSON.stringify(c.texts), now] }]);
  return { id: a.id, status: "previewed", texts: c.texts, previews: Object.keys(c.texts).length };
}

// send: only the previewed texts (an edit after the preview needs a new preview).
export async function startAnnouncement(db, body, now) {
  const a = await load(db, body?.id);
  if (!a) return { error: "That announcement is gone." };
  if (a.status !== "previewed") return { error: "Send yourself a preview first." };
  if (body?.texts && JSON.stringify(Object.fromEntries(Object.entries(body.texts).map(([k, v]) => [k, cleanText(v)])))
      !== JSON.stringify(Object.fromEntries(Object.keys(body.texts).map((k) => [k, a.texts[k] ?? ""])))) {
    return { error: "The text changed after the preview. Send yourself a preview again." };
  }
  const [rows] = await db.batch([{ sql: "UPDATE announcements SET status = 'sending', started_at = ?2 WHERE id = ?1 AND status = 'previewed' RETURNING id",
    params: [a.id, now] }]);
  if (!rows.length) return { error: "It is already being sent." };
  return { id: a.id, status: "sending" };
}

export async function cancelAnnouncement(db, body, now) {
  const [rows] = await db.batch([{ sql: "UPDATE announcements SET status = 'cancelled', finished_at = ?2 WHERE id = ?1 " +
    "AND status IN ('draft', 'previewed', 'sending') RETURNING id", params: [Number(body?.id) || 0, now] }]);
  return rows.length ? { id: rows[0].id, status: "cancelled" } : { error: "Nothing to cancel." };
}

// ------------------------------------------------------------------ the cron batches

export const activeStatement = () =>
  ({ sql: "SELECT id, audience, texts FROM announcements WHERE status = 'sending' ORDER BY id LIMIT 1", params: [] });

// One batch of one announcement. rows: the activeStatement result. Returns {sent, failed, done}.
export async function runAnnouncementBatch(db, io, rows, now, perTick = ANNOUNCE.per_tick) {
  const a = rows?.[0];
  const out = { sent: 0, failed: 0, done: false };
  if (!a) return out;
  const texts = JSON.parse(a.texts || "{}");
  const [targets] = await db.batch([{
    sql: "SELECT u.id, u.lang FROM users u WHERE u.blocked = 0 AND (?2 = 'all' OR u.lang = ?2) " +
         "AND NOT EXISTS (SELECT 1 FROM announcement_sends s WHERE s.announcement_id = ?1 AND s.user_id = u.id) ORDER BY u.id LIMIT ?3",
    params: [a.id, a.audience, perTick] }]);
  if (!targets.length) {
    await db.batch([{ sql: "UPDATE announcements SET status = 'done', finished_at = ?2 WHERE id = ?1 AND status = 'sending'", params: [a.id, now] }]);
    out.done = true;
    return out;
  }
  // claim first: only the users this tick inserted a row for get the message
  const claims = await db.batch(targets.map((u) => ({
    sql: "INSERT INTO announcement_sends (announcement_id, user_id, at, ok) VALUES (?1, ?2, ?3, NULL) " +
         "ON CONFLICT(announcement_id, user_id) DO NOTHING RETURNING user_id", params: [a.id, u.id, now] })));
  const writes = [];
  for (let i = 0; i < targets.length; i++) {
    if (!claims[i]?.length) continue;
    const u = targets[i];
    const text = texts[u.lang] || texts.en;
    try {
      await io.send(u.id, escapeHtml(text));
      out.sent++;
      writes.push({ sql: "UPDATE announcement_sends SET ok = 1 WHERE announcement_id = ?1 AND user_id = ?2", params: [a.id, u.id] });
    } catch (e) {
      out.failed++;
      writes.push({ sql: "UPDATE announcement_sends SET ok = 0, error = ?3 WHERE announcement_id = ?1 AND user_id = ?2",
        params: [a.id, u.id, String(e.message).slice(0, 200)] });
      if (e.status === 403) writes.push({ sql: "UPDATE users SET blocked = 1 WHERE id = ?1", params: [u.id] });
      else writes.push(errorStatement(`announcement ${a.id} for user ${u.id}: ${e.message}`, now));
    }
  }
  if (writes.length) await db.batch(writes);
  return out;
}

// ------------------------------------------------------------------ Admin

export function announceAdminStatements() {
  return [
    { sql: "SELECT a.id, a.created_at, a.status, a.audience, a.texts, a.notes, a.previewed_at, a.started_at, a.finished_at, " +
           "(SELECT count(*) FROM announcement_sends s WHERE s.announcement_id = a.id AND s.ok = 1) AS sent, " +
           "(SELECT count(*) FROM announcement_sends s WHERE s.announcement_id = a.id AND s.ok = 0) AS failed " +
           "FROM announcements a ORDER BY a.id DESC LIMIT 5", params: [] },
    audienceLangsStatement(),
  ];
}
export const ANNOUNCE_ADMIN_COUNT = 2;
export function shapeAnnounce(rows, langRows) {
  return {
    languages: audienceLangs(langRows, "all"),
    enabled: [...LANGS.enabled],
    recent: (rows ?? []).map((r) => ({ id: r.id, created_at: r.created_at, status: r.status, audience: r.audience,
      texts: JSON.parse(r.texts || "{}"), notes: JSON.parse(r.notes || "{}"), sent: Number(r.sent ?? 0), failed: Number(r.failed ?? 0),
      previewed_at: r.previewed_at, started_at: r.started_at, finished_at: r.finished_at })),
  };
}
