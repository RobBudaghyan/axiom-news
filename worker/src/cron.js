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

// Sends a digest's messages in order (usually one; a long digest is split at a topic). A failure
// of the first message is thrown (retried at the next tick, as before). A failure of a later one is
// reported with `logError`: the stories already sent are recorded and the slot moves on, while the
// stories of the unsent part stay eligible for the next digest. Returns the ids of stories sent.
export async function sendParts(io, chatId, plan, logError) {
  const ids = [];
  for (let p = 0; p < plan.parts.length; p++) {
    try {
      await io.send(chatId, plan.parts[p]);
    } catch (e) {
      if (p === 0) throw e;
      logError(`digest for user ${chatId}: part ${p + 1} of ${plan.parts.length} not sent: ${e.message}`);
      break;
    }
    ids.push(...plan.partStories[p]);
  }
  return ids;
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
  const out = { due: due.length, sent: 0, quiet: 0, blocked: 0, failed: 0, stories: 0, alert: false };

  if (due.length) {
    const cands = await db.batch(due.map((u) => candidateStatement(u, now, cfg)));
    for (let i = 0; i < due.length; i++) {
      const user = due[i];
      let plan, sentIds;
      try {
        plan = planDigest(user, cands[i], topics, now, cfg);
        sentIds = await sendParts(io, user.id, plan, (msg) => writes.push(errorStatement(msg, now)));
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
      out.stories += sentIds.length;
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
