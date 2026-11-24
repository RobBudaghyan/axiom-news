// One cron tick: send the digests that are due, then check the hourly job's health.
// Subrequests per tick: 1 read batch + 1 candidate batch + 1 Telegram call per due user
// + 1 write batch (+ 1 alert): about 12 with the 8 users per tick that the 10 ms CPU limit allows
// (measured on Cloudflare, see reports/step-03-automation.md).
import { CONFIG, afterSendStatements, candidateStatement, holdStatements, nextSlot, parseList, planDigest } from "./digest.js";
import { HEALTH_STATEMENTS, assessHealth } from "./health.js";
import { errorStatement, shouldFlushUsage, takeUsage, usageStatement } from "./db.js";
import { asTopicRows, guardAlert, withCustomTopics } from "./custom.js";
import { spendAlert, spendAlertStatements } from "./spend.js";
import { countStatement } from "./guard.js";
import { reminderStatement, runReminders } from "./onboard.js";
import { activeStatement, runAnnouncementBatch } from "./announce.js";
import { WATCH_STATEMENTS, digestStatsStatement, dueAlerts, statsDayDue, statsDoneWrite, statsRow, statsStatements,
  statsWrite, watchCandidates } from "./watch.js";

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

// Step 18: today's deliveries for Admin (digests and quiet notes sent, failed tries, readers who blocked
// the bot), one meta row, added to in SQL (two ticks never lose a count), started again each UTC day.
// Written only by a tick that tried to send something.
export const DIGEST_DAY_KEY = "digest_day";
export function digestDayStatement(out, now) {
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const add = (k) => `coalesce(json_extract(value, '$.${k}'), 0) + json_extract(excluded.value, '$.${k}')`;
  return {
    sql: "INSERT INTO meta (key, value) VALUES (?1, json_object('day', ?2, 'sent', ?3, 'quiet', ?4, 'failed', ?5, 'blocked', ?6, 'stories', ?7)) " +
         "ON CONFLICT(key) DO UPDATE SET value = CASE WHEN json_extract(value, '$.day') = ?2 THEN json_object('day', ?2, " +
         `'sent', ${add("sent")}, 'quiet', ${add("quiet")}, 'failed', ${add("failed")}, 'blocked', ${add("blocked")}, 'stories', ${add("stories")}) ` +
         "ELSE excluded.value END",
    params: [DIGEST_DAY_KEY, day, out.sent, out.quiet, out.failed - out.blocked, out.blocked, out.stories],
  };
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

// How a digest is sent (Step 11): its kind ("rich" or "html"). Step 14 (owner): no button under
// digests and quiet notes any more; the chat's menu button and /settings still open the Mini App.
// appUrl is unused now (kept so callers need not change).
export function digestExtra(plan, appUrl) {   // eslint-disable-line no-unused-vars
  return { kind: plan.kind ?? "html" };
}

// Sends a digest: always ONE message since Step 8 (planDigest cuts it to fit). A failure is
// thrown (retried at the next tick). Returns the ids of the stories sent.
export async function sendDigest(io, chatId, plan) {
  await io.send(chatId, plan.text, digestExtra(plan, io.appUrl));
  return plan.storyIds;
}

// io: {send(chatId, text, {kind, reply_markup}), alert(text), appUrl}. opts: {digests: bool, extraProblems: [],
// guard: production's hourly alert checks, stats: the hourly tick (both copies keep daily_stats)}.
export async function runTick(db, io, now, opts = {}, cfg = CONFIG) {
  const digests = opts.digests !== false;
  // Step 13: the AI budget guard is checked on the hourly tick (once an hour is enough for one alert a day)
  const guard = !!opts.guard;
  const watch = guard || !!opts.stats;   // Step 19: the hourly watch reads (alerts, daily stats)
  const reads = [
    ...HEALTH_STATEMENTS,
    ...(digests ? [{ sql: DUE_SQL, params: [now, cfg.max_users_per_tick] }, { sql: TOPICS_SQL, params: [] },
                   { sql: DUE_CUSTOM_SQL, params: [now, cfg.max_users_per_tick] },
                   reminderStatement(now), activeStatement()] : []),   // Step 15: one reminder, announcements
    ...(guard ? [countStatement(now),
                 { sql: "SELECT key, value FROM meta WHERE key IN ('ai_guard', 'ai_guard_alert_day')", params: [] },
                 ...spendAlertStatements(now)] : []),   // Step 20: the emergency key's spend today
    ...(watch ? WATCH_STATEMENTS(now) : []),
  ];
  const got = await db.batch(reads);
  const [runs, lastOk, meta] = got;
  let [due = [], topics = [], custom = [], reminders = [], announcing = []] = digests ? got.slice(3, 8) : [];
  const after = digests ? 8 : 3;
  const [guardCounts, guardMeta, spendRows, spendMeta] = guard ? got.slice(after, after + 4) : [];
  const watchGot = watch ? got.slice(after + (guard ? 4 : 0), after + (guard ? 4 : 0) + 2) : null;
  const writes = [];
  const out = { due: due.length, sent: 0, quiet: 0, blocked: 0, failed: 0, stories: 0, cut: 0, alert: false };

  const mine = new Map();
  for (const r of custom) {
    if (!mine.has(r.user_id)) mine.set(r.user_id, []);
    mine.get(r.user_id).push(r);
  }
  // Step 16 (owner): no Pause; a reader with every topic off (main and custom) gets no digest and no
  // quiet note. Their slot just moves on, so switching a topic back on starts at the next slot.
  const off = due.filter((u) => allTopicsOff(u, mine.get(u.id)));
  if (off.length) {
    due = due.filter((u) => !off.includes(u));
    out.due = due.length;
    out.all_off = off.length;
    for (const u of off) {
      writes.push({ sql: "UPDATE users SET next_digest_at = ?1 WHERE id = ?2",
                    params: [nextSlot(now, u.timezone || cfg.default_timezone, parseList(u.digest_times, cfg.default_times)), u.id] });
    }
  }
  if (due.length) {
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
    if (out.sent || out.failed) writes.push(digestDayStatement(out, now), digestStatsStatement(out, now));
  }

  // Step 15: after the digests, the one reminder (users who never opened the app) and a batch of
  // the owner's announcement; each claims its rows before sending, so nothing goes out twice.
  if (reminders.length) {
    try { out.reminders = (await runReminders(db, io, reminders, now)).sent; }
    catch (e) { writes.push(errorStatement(`reminders: ${e.message}`, now)); }
  }
  if (announcing.length) {
    try { out.announcement = await runAnnouncementBatch(db, io, announcing, now); }
    catch (e) { writes.push(errorStatement(`announcement: ${e.message}`, now)); }
  }

  const health = assessHealth({ runs, lastOk, meta, extra: opts.extraProblems ?? [] }, now, cfg.default_timezone);
  out.problems = health.problems;
  for (const p of opts.extraProblems ?? []) writes.push(errorStatement(p, now));
  // Step 19: every alert kind at most once a UTC day, each with a "What to do" line (watch.js).
  // Step 16: staging (opts.health false) never alerts the owner: the job runs for production only.
  if (opts.health !== false) {
    writes.push(...health.writes);
    const candidates = [...health.candidates, ...(guard && watchGot ? watchCandidates(watchGot, now) : [])];
    const { due, record } = dueAlerts(candidates, watchGot?.[0] ?? meta, now);
    const sentKinds = [];
    for (const a of due) {
      try {
        await io.alert(a.text);
        sentKinds.push(a.kind);
      } catch (e) {
        writes.push(errorStatement(`alert to owner failed: ${e.message}`, now));
      }
    }
    if (sentKinds.length) {
      out.alert = true;
      out.alerts = sentKinds;
      writes.push(record(sentKinds),   // Admin shows the last alert
        { sql: "INSERT INTO meta (key, value) VALUES ('last_alert_at', ?1), ('last_alert_text', ?2) " +
               "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          params: [String(now), due.filter((a) => sentKinds.includes(a.kind)).map((a) => a.text.split("\n")[0].replace(/^Axiom News alert: /, "")).join("; ")] });
    }
  }
  // Step 19: yesterday's daily_stats row, once (the first hourly tick after 00:00 UTC)
  const statsDay = watchGot ? statsDayDue(watchGot[0], now) : null;
  if (statsDay) {
    try {
      const rows = await db.batch(statsStatements(statsDay));
      writes.push(statsWrite(statsRow(statsDay, rows, now)), statsDoneWrite(statsDay));
      out.stats_day = statsDay;
    } catch (e) {
      writes.push(errorStatement(`daily stats ${statsDay}: ${e.message}`, now));
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
    // Step 20: one alert on any UTC day the paid emergency key spent money (amount and why)
    const sp = spendAlert(spendRows, spendMeta, now);
    if (sp) {
      try {
        await io.alert(sp.text);
        writes.push(...sp.writes);
        out.spend_alert = true;
      } catch (e) {
        writes.push(errorStatement(`emergency spend alert to owner failed: ${e.message}`, now));
      }
    }
  }
  // D1 rows this isolate used so far (this tick's reads plus any Mini App calls it served), for the
  // Admin tab. Step 17c: written once an hour (the tick at minute 0), not every tick: 24 rows a day
  // instead of 1,440 per copy. The isolate keeps counting in between; counts of an isolate that is
  // evicted before minute 0 are lost (Admin's account numbers come from Cloudflare's analytics anyway).
  if (shouldFlushUsage(now)) {
    const used = takeUsage();
    if (used.r || used.w) writes.push(usageStatement(used, now));
  }
  if (writes.length) await db.batch(writes);
  return out;
}

// Step 16: every main topic off and no custom topic switched on (customRows: the user's switched-on
// custom follows, as DUE_CUSTOM_SQL reads them).
export function allTopicsOff(user, customRows = []) {
  return !parseList(user.topics).length && !(customRows ?? []).some((r) => r.enabled !== 0);
}
