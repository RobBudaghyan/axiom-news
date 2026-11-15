// One cron tick: send the digests that are due, then check the hourly job's health.
// Subrequests per tick: 1 read batch + 1 candidate batch + 1 Telegram call per due user
// + 1 write batch (+ 1 alert): about 12 with the 8 users per tick that the 10 ms CPU limit allows
// (measured on Cloudflare, see reports/step-03-automation.md).
import { CONFIG, afterSendStatements, candidateStatement, nextSlot, parseList, planDigest } from "./digest.js";
import { HEALTH_STATEMENTS, assessHealth } from "./health.js";
import { errorStatement, takeUsage, usageStatement } from "./db.js";

const DUE_SQL = `SELECT * FROM users
WHERE next_digest_at IS NOT NULL AND next_digest_at <= ?1 AND paused = 0 AND blocked = 0
ORDER BY next_digest_at LIMIT ?2`;
const TOPICS_SQL = "SELECT tag, label_en, emoji, sort, is_default FROM topics ORDER BY sort";
const GIVE_UP_S = 3600;   // a slot that keeps failing for an hour is skipped

// Step 9: a digest that went out in English because some of its stories had no translation into
// the reader's language yet. Logged in `errors` (component "digest"); Admin counts them per language.
export const FALLBACK_PREFIX = "language fallback";
export function fallbackStatement(userId, fb, now) {
  return errorStatement(`${FALLBACK_PREFIX} (${fb.lang}): user ${userId} got English, ${fb.missing} of ${fb.of} ` +
    `stories have no ${fb.lang} translation yet`, now, "digest");
}

// Sends a digest: always ONE message since Step 8 (planDigest cuts it to fit). A failure is
// thrown (retried at the next tick). Returns the ids of the stories sent.
export async function sendDigest(io, chatId, plan) {
  await io.send(chatId, plan.text);
  return plan.storyIds;
}

// io: {send(chatId, html), alert(text)}. opts: {digests: bool, extraProblems: []}.
export async function runTick(db, io, now, opts = {}, cfg = CONFIG) {
  const digests = opts.digests !== false;
  const reads = [
    ...HEALTH_STATEMENTS,
    ...(digests ? [{ sql: DUE_SQL, params: [now, cfg.max_users_per_tick] }, { sql: TOPICS_SQL, params: [] }] : []),
  ];
  const [runs, lastOk, meta, due = [], topics = []] = await db.batch(reads);
  const writes = [];
  const out = { due: due.length, sent: 0, quiet: 0, blocked: 0, failed: 0, stories: 0, cut: 0, alert: false };

  if (due.length) {
    const cands = await db.batch(due.map((u) => candidateStatement(u, now, cfg)));
    for (let i = 0; i < due.length; i++) {
      const user = due[i];
      let plan, sentIds;
      try {
        plan = planDigest(user, cands[i], topics, now, cfg);
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
      if (plan.fallback) {                  // Step 9: never mixed; the whole digest went out in English
        out.lang_fallback = (out.lang_fallback ?? 0) + 1;
        writes.push(fallbackStatement(user.id, plan.fallback, now));
      }
      out.stories += sentIds.length;
      out.cut += plan.cut ?? 0;            // stories that qualified but did not fit (Step 8)
      writes.push(...afterSendStatements(user, sentIds, now, plan.nextAt));
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
  // D1 rows this isolate used so far (this tick's reads plus any Mini App calls it served), for the
  // Admin tab. Written every tick, about 288 rows a day; the write batch itself is counted next time.
  const used = takeUsage();
  if (used.r || used.w) writes.push(usageStatement(used, now));
  if (writes.length) await db.batch(writes);
  return out;
}
