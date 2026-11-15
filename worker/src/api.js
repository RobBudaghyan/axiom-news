// Mini App API. Every request carries Telegram's initData in "Authorization: tma <initData>";
// it is verified server-side (src/auth.js) and the user id comes only from verified data.
// Admin routes re-check the verified id against OWNER_TELEGRAM_ID on every call: hiding the
// Admin tab in the app is cosmetic.
//
//   POST /api/open            {tz}      create the user if new, save the device time zone, return state
//   POST /api/settings        {...}     save changed settings, recompute next_digest_at, return state
//   GET  /api/admin                     health, stats, feeds, users, errors, D1 use (owner only)
//   POST /api/admin/digest              send the owner a real digest now (owner only)
//   POST /api/admin/run-job             start the hourly GitHub job, min-gap guard (owner only)
import { verifyInitData } from "./auth.js";
import { CONFIG, afterSendStatements, candidateStatement, hhmm, localParts, nextSlot, planDigest } from "./digest.js";
import { SettingsError, TZ_AUTO, TZ_DEFAULT, nextDigestAfterChange, publicUser, validZone, validatePatch } from "./settings.js";
import { adminStatements, shapeAdmin } from "./admin.js";
import { dispatchJob } from "./github.js";
import { fallbackStatement, sendDigest } from "./cron.js";
import { errorStatement } from "./db.js";
import { LANGS, chooseLang, effectiveLang, t, topicLabel } from "./i18n.js";
import { setChatLanguage } from "./bot.js";

const TOPICS_SQL = "SELECT tag, label_en, emoji, sort, is_default FROM topics ORDER BY sort";
const USER_SQL = "SELECT * FROM users WHERE id = ?1";

export function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
// Errors carry a `code` (config/i18n errors.<code>) that the Mini App shows in the user's
// language; `error` is the English text (Step 9).
const fail = (status, code, vars = {}) => json(status, { error: t("en", `errors.${code}`, vars), code, vars });

function state(user, topics, isOwner, cfg) {
  const L = cfg.settings_limits;
  const lang = effectiveLang(user);
  return {
    user: publicUser(user, cfg),
    topics: topics.map((x) => ({ tag: x.tag, label: topicLabel(lang, x.tag, x.label_en), emoji: x.emoji ?? "" })),
    languages: LANGS.enabled.map((code) => ({ code, name: LANGS.names[code] ?? code })),   // the picker (Step 9)
    limits: { ...L },
    is_owner: isOwner,
  };
}

async function readBody(request) {
  if (request.method !== "POST") return {};
  const text = await request.text();
  if (text.length > 4096) throw new SettingsError("too_large");
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new SettingsError("bad_request"); }
}

// ------------------------------------------------------------------ settings

async function open(db, tg, body, now, cfg, isOwner) {
  const [rows, topics] = await db.batch([{ sql: USER_SQL, params: [tg.id] }, { sql: TOPICS_SQL, params: [] }]);
  const deviceTz = validZone(body?.tz) ? body.tz : null;
  const firstName = String(tg.first_name ?? "").slice(0, 64);
  const language = String(tg.language_code ?? "en").slice(0, 8);
  let user = rows[0];
  if (!user) {   // opened the app before sending /start: same defaults as /start
    user = {
      id: tg.id, first_name: firstName, language, lang: chooseLang(language), timezone: deviceTz ?? cfg.default_timezone,
      tz_detected: deviceTz ? TZ_AUTO : TZ_DEFAULT, digest_times: JSON.stringify(cfg.default_times),
      topics: JSON.stringify(topics.filter((t) => t.is_default).map((t) => t.tag)),
      paused: 0, blocked: 0, created_at: now,
    };
    user.next_digest_at = nextSlot(now, user.timezone, cfg.default_times);
    await db.batch([{
      sql: "INSERT INTO users (id, first_name, language, lang, timezone, tz_detected, digest_times, topics, " +
           "created_at, next_digest_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) ON CONFLICT(id) DO NOTHING",
      params: [user.id, firstName, language, user.lang, user.timezone, user.tz_detected, user.digest_times,
               user.topics, now, user.next_digest_at],
    }]);
    return state(user, topics, isOwner, cfg);
  }
  const after = { ...user };
  if (firstName && firstName !== user.first_name) after.first_name = firstName;   // lesson 14
  if (language !== user.language) after.language = language;   // Telegram's code only; never users.lang
  // The zone always follows the phone (Step 5: there is no hand-picked zone any more), so it
  // follows the user when they travel.
  if (deviceTz && (deviceTz !== user.timezone || user.tz_detected !== TZ_AUTO)) {
    after.timezone = deviceTz;
    after.tz_detected = TZ_AUTO;
    if (deviceTz !== user.timezone) after.next_digest_at = nextDigestAfterChange(user, after, now, cfg);
  }
  const changed = ["first_name", "language", "timezone", "tz_detected", "next_digest_at"].filter((k) => after[k] !== user[k]);
  if (changed.length) {
    await db.batch([{
      sql: `UPDATE users SET ${changed.map((k, i) => `${k} = ?${i + 1}`).join(", ")} WHERE id = ?${changed.length + 1}`,
      params: [...changed.map((k) => after[k]), user.id],
    }]);
  }
  return state(after, topics, isOwner, cfg);
}

async function saveSettings(db, tg, body, now, cfg, isOwner, io) {
  const [rows, topics] = await db.batch([{ sql: USER_SQL, params: [tg.id] }, { sql: TOPICS_SQL, params: [] }]);
  const user = rows[0];
  if (!user) return fail(404, "reopen_simple");
  const clean = validatePatch(body, topics.map((t) => t.tag), cfg);
  const cols = {};
  for (const [k, v] of Object.entries(clean)) cols[k] = Array.isArray(v) ? JSON.stringify(v) : v;
  const after = { ...user, ...cols };
  cols.next_digest_at = nextDigestAfterChange(user, after, now, cfg);
  after.next_digest_at = cols.next_digest_at;
  const keys = Object.keys(cols);
  await db.batch([{
    sql: `UPDATE users SET ${keys.map((k, i) => `${k} = ?${i + 1}`).join(", ")} WHERE id = ?${keys.length + 1}`,
    params: [...keys.map((k) => cols[k]), user.id],
  }]);
  // Step 9: the chat's menu button and command list follow the new language.
  if (clean.lang && clean.lang !== user.lang) {
    const problems = await setChatLanguage(io?.tg, user.id, clean.lang, io?.appUrl);
    if (problems.length) await db.batch(problems.map((p) => errorStatement(p, now)));
  }
  return json(200, state(after, topics, isOwner, cfg));
}

// ------------------------------------------------------------------ admin actions

async function digestNow(db, ownerId, now, cfg, io) {
  const [rows, topics] = await db.batch([{ sql: USER_SQL, params: [ownerId] }, { sql: TOPICS_SQL, params: [] }]);
  const user = rows[0];
  if (!user) return fail(404, "no_user");
  const [cands] = await db.batch([candidateStatement(user, now, cfg)]);
  const plan = planDigest(user, cands, topics, now, cfg);
  const ids = await sendDigest(io, user.id, plan);
  await db.batch([...afterSendStatements(user, ids, now, plan.nextAt),
                  ...(plan.fallback ? [fallbackStatement(user.id, plan.fallback, now)] : [])]);
  const n = ids.length;
  return json(200, {
    ok: true, stories: n,
    message: n ? `Sent: ${n} ${n === 1 ? "story" : "stories"}. Check your chat with the bot.`
      : "Sent: a short note, because there is nothing new on your topics right now.",
  });
}

async function runJobNow(db, env, now, cfg, io) {
  const [[last]] = await db.batch([{ sql: "SELECT started_at, status FROM job_runs ORDER BY id DESC LIMIT 1", params: [] }]);
  const tz = cfg.default_timezone;
  const at = (ts) => hhmm(localParts(ts, tz));
  const gap = cfg.job_min_gap_minutes * 60;
  if (last && last.status === "running" && now - last.started_at < 30 * 60) {
    return json(409, { ok: false, message: `A news job is running right now (started ${at(last.started_at)}).` });
  }
  if (last && now - last.started_at < gap) {
    return json(409, { ok: false,
      message: `The news job last ran at ${at(last.started_at)}. You can start it again from ${at(last.started_at + gap)}.` });
  }
  const r = await io.dispatch(env);
  if (!r.ok) {
    await db.batch([errorStatement(r.problem, now)]);
    return json(502, { ok: false, message: "GitHub did not accept the request. Details are in Recent errors." });
  }
  return json(200, { ok: true, message: "Started. New stories usually arrive within 2 minutes." });
}

// ------------------------------------------------------------------ router

// io (tests replace it): {send(chatId, html), dispatch(env), tg(method, body)?, appUrl?}
export async function handleApi(request, env, db, now, io, cfg = CONFIG) {
  const path = new URL(request.url).pathname;
  const auth = request.headers.get("authorization") ?? "";
  const initData = auth.startsWith("tma ") ? auth.slice(4) : "";
  const v = await verifyInitData(initData, env.TELEGRAM_BOT_TOKEN, now);
  if (!v.ok) return fail(401, "reopen");
  const tg = v.user;
  const isOwner = String(tg.id) === String(env.OWNER_TELEGRAM_ID ?? "");

  const route = `${request.method} ${path}`;
  try {
    const body = await readBody(request);
    switch (route) {
      case "POST /api/open": return json(200, await open(db, tg, body, now, cfg, isOwner));
      case "POST /api/settings": return await saveSettings(db, tg, body, now, cfg, isOwner, io);
      case "GET /api/admin":
      case "POST /api/admin/digest":
      case "POST /api/admin/run-job": {
        if (!isOwner) return fail(403, "owner_only");
        if (route === "GET /api/admin") return json(200, shapeAdmin(await db.batch(adminStatements(now)), now, cfg));
        if (route === "POST /api/admin/digest") return await digestNow(db, tg.id, now, cfg, io);
        return await runJobNow(db, env, now, cfg, io);
      }
      default: return fail(404, "not_found");
    }
  } catch (e) {
    if (e instanceof SettingsError) return fail(400, e.code, e.vars);
    throw e;
  }
}
