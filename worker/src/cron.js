// One cron tick: send the digests that are due, then check the hourly job's health.
// Subrequests per tick: 1 read batch + 1 candidate batch + 1 Telegram call per due user
// + 1 write batch (+ 1 alert): about 12 with the 8 users per tick that the 10 ms CPU limit allows
// (measured on Cloudflare, see reports/step-03-automation.md).
import { CONFIG, afterSendStatements, candidateStatement, holdStatements, nextSlot, parseList, planDigest } from "./digest.js";
import { HEALTH_STATEMENTS, assessHealth } from "./health.js";
import { errorStatement, takeUsage, usageStatement } from "./db.js";
import { settingsButton } from "./telegram.js";
import { asTopicRows, guardAlert, withCustomTopics } from "./custom.js";
import { countStatement } from "./guard.js";

const DUE_WHERE = "next_digest_at IS NOT NULL AND next_digest_at <= ?1 AND paused = 0 AND blocked = 0";
const DUE_SQL = `SELECT * FROM users WHERE ${DUE_WHERE} ORDER BY next_digest_at LIMIT ?2`;
// Step 13: the custom topics the due users follow, in the same read batch (one transaction, so the
// same users as DUE_SQL).
const DUE_CUSTOM_SQL = `SELECT f.user_id, t.id, t.tag, t.names, t.emoji, t.boost_max, f.enabled FROM custom_follows f
JOIN custom_topics t ON t.id = f.topic_id
WHERE t.tag IS NOT NULL AND f.enabled = 1 AND f.user_id IN (SELECT id FROM users WHERE ${DUE_WHERE} ORDER BY next_digest_at LIMIT ?2)
ORDER BY f.at, t.id`;
const TOPICS_SQL = "SELECT tag, label_en, emoji, sort, is_default FROM topics ORDER BY sort";
const GIVE_UP_S = 3600;   // a slot that keeps failing for an hour is skipped

// A digest that went out wholly in English because NONE of its stories had a translation into the
// reader's language yet (Step 10; in Step 9 one missing story was enough). Logged in `errors`
// (component "digest"); Admin counts them per language.
export const FALLBACK_PREFIX = "language fallback";
export function fallbackStatement(userId, fb, now) {
  return errorStatement(`${FALLBACK_PREFIX} (${fb.lang}): user ${userId} got English, none of ${fb.of} ` +
    `stories has a ${fb.lang} translation yet`, now, "digest");
}

// Every D1 write after a digest was sent: never-twice rows for the stories in it, the digest time,
// the held stories (Step 10) and the English fallback note. Used by the cron and the Admin button.
export function digestWrites(user, plan, sentIds, now) {
  return [
    ...afterSendStatements(user, sentIds, now, plan.nextAt),
    ...holdStatements(user, plan.heldIds ?? [], plan.lang, now),
    ...(plan.fallback ? [fallbackStatement(user.id, plan.fallback, now)] : []),
  ];
}

// How a digest is sent (Step 11): its kind ("rich" or "html") and the "⚙️ Settings" button under it,
// which opens the Mini App (when the app's address is known), on every digest and quiet note.
export function digestExtra(plan, appUrl) {
  return { kind: plan.kind ?? "html", ...(appUrl ? settingsButton(appUrl, plan.button) : {}) };
}

// Sends a digest: always ONE message since Step 8 (planDigest cuts it to fit). A failure is
// thrown (retried at the next tick). Returns the ids of the stories sent.
export async function sendDigest(io, chatId, plan) {
  await io.send(chatId, plan.text, digestExtra(plan, io.appUrl));
  return plan.storyIds;
}

// io: {send(chatId, text, {kind, reply_markup}), alert(text), appUrl}. opts: {digests: bool, extraProblems: []}.
export async function runTick(db, io, now, opts = {}, cfg = CONFIG) {
  const digests = opts.digests !== false;
  // Step 13: the AI budget guard is checked on the hourly tick (once an hour is enough for one alert a day)
  const guard = !!opts.guard;
  const reads = [
    ...HEALTH_STATEMENTS,
    ...(digests ? [{ sql: DUE_SQL, params: [now, cfg.max_users_per_tick] }, { sql: TOPICS_SQL, params: [] },
                   { sql: DUE_CUSTOM_SQL, params: [now, cfg.max_users_per_tick] }] : []),
    ...(guard ? [countStatement(now),
                 { sql: "SELECT key, value FROM meta WHERE key IN ('ai_guard', 'ai_guard_alert_day')", params: [] }] : []),
  ];
  const got = await db.batch(reads);
  const [runs, lastOk, meta] = got;
  const [due = [], topics = [], custom = []] = digests ? got.slice(3, 6) : [];
  const [guardCounts, guardMeta] = guard ? got.slice(digests ? 6 : 3) : [];
  const writes = [];
  const out = { due: due.length, sent: 0, quiet: 0, blocked: 0, failed: 0, stories: 0, cut: 0, alert: false };

  if (due.length) {
    const mine = new Map();
    for (const r of custom) {
      if (!mine.has(r.user_id)) mine.set(r.user_id, []);
      mine.get(r.user_id).push(r);
    }
    // each user's switched-on custom topics join their topic list and their section names (Step 13
    // fixes: no boost cap for them; digest.js uses the editor's topic score as it is)
    const plans = due.map((u) => {
      const rows = mine.get(u.id) ?? [];
      return { user: withCustomTopics(u, rows), cfg, topics: rows.length ? [...topics, ...asTopicRows(rows)] : topics };
    });
    const cands = await db.batch(plans.map((p) => candidateStatement(p.user, now, p.cfg)));
    for (let i = 0; i < due.length; i++) {
      const user = due[i];
      let plan, sentIds;
      try {
        plan = planDigest(plans[i].user, cands[i], plans[i].topics, now, plans[i].cfg);
        sentIds = await sendDigest(io, user.id, plan);
      } catch (e) {
        out.failed++;
        if (e.status === 403) {   // the user blocked the bot
          out.blocked++;
          writes.push({ sql: "UPDATE users SET blocked = 1 WHERE id = ?1", params: [user.id] });
          continue;
        }
        writes.push(errorStatement(`digest for user ${user.id}: ${e.message}`, now));
        if (now - user.next_digest_at > GIVE_UP_S) {
          const times = parseList(user.digest_times, cfg.default_times);
          writes.push({ sql: "UPDATE users SET next_digest_at = ?1 WHERE id = ?2",
                        params: [nextSlot(now, user.timezone || cfg.default_timezone, times), user.id] });
        }
        continue;   // otherwise retried at the next tick
      }
      out.sent++;
      if (!plan.stories.length) out.quiet++;
      if (plan.fallback) out.lang_fallback = (out.lang_fallback ?? 0) + 1;   // never mixed: wholly English
      if (plan.heldIds?.length) out.held = (out.held ?? 0) + plan.heldIds.length;   // Step 10
      out.stories += sentIds.length;
      out.cut += plan.cut ?? 0;            // stories that qualified but did not fit (Step 8)
      writes.push(...digestWrites(user, plan, sentIds, now));
    }
  }

  const health = assessHealth({ runs, lastOk, meta, extra: opts.extraProblems ?? [] }, now, cfg.default_timezone);
  out.problems = health.problems;
  for (const p of opts.extraProblems ?? []) writes.push(errorStatement(p, now));
  if (health.alert) {
    try {
      await io.alert(health.alert);
      writes.push(...health.writes);
      out.alert = true;
    } catch (e) {
      writes.push(errorStatement(`alert to owner failed: ${e.message}`, now));
    }
  }
  if (guard) {
    const g = guardAlert(guardCounts, guardMeta, now);
    if (g) {
      try {
        await io.alert(g.text);
        writes.push(...g.writes);
        out.guard_alert = true;
      } catch (e) {
        writes.push(errorStatement(`AI budget alert to owner failed: ${e.message}`, now));
      }
    }
  }
  // D1 rows this isolate used so far (this tick's reads plus any Mini App calls it served), for the
  // Admin tab. Written every tick, about 288 rows a day; the write batch itself is counted next time.
  const used = takeUsage();
  if (used.r || used.w) writes.push(usageStatement(used, now));
  if (writes.length) await db.batch(writes);
  return out;
}
