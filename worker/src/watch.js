// Step 19 (owner): alerts only when action is needed, and a small daily stats table.
//
// ALERTS. No regular reports. Every alert kind reaches the owner at most once a UTC day (meta
// `alert_days`: {kind: day}), and every text ends with one "What to do:" line. Kinds:
//   job_failed, job_stuck, no_run  (health.js: the hourly news job)
//   digests_failing, feeds_down, google_blocked  (here, checked on the hourly tick)
//   d1, cpu  (usage.js, its own daily state)   ai_guard  (custom.js guardAlert, its own daily key)
//
// DAILY STATS. One row per finished UTC day in `daily_stats`, never pruned. The first hourly tick
// after 00:00 UTC writes yesterday (meta `stats_day` remembers the last day written, so it is
// written once). Digest counts are added live (digestStatsStatement), deletions by account.js.
import { utcDay } from "./usage.js";

export const ALERT_DAYS_KEY = "alert_days";
export const STATS_DAY_KEY = "stats_day";

// Thresholds (Step 19)
export const DIGEST_FAIL_MIN = 3;          // failed digests today, and
export const DIGEST_FAIL_SHARE = 0.2;      // at least this share of today's attempts
export const FEED_DOWN_RUNS = 3;           // a feed counts as down after this many failed runs in a row
export const FEEDS_DOWN_MIN = 10;          // alert when this many are down at once
export const GOOGLE_SILENT_S = 24 * 3600;  // no custom-topic search answered for a whole day

const put = (key, value) => ({
  sql: "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  params: [key, typeof value === "string" ? value : JSON.stringify(value)],
});
const parse = (v, fb) => { try { return JSON.parse(v ?? "null") ?? fb; } catch { return fb; } };
export const alertText = (what, todo) => `Axiom News alert: ${what}\nWhat to do: ${todo}`;

// candidates: [{kind, text}]. metaRows: [{key, value}] holding alert_days. Keeps the kinds not sent today
// and returns the write that records them (the caller writes it only for alerts that really went out).
export function dueAlerts(candidates, metaRows, now) {
  const day = utcDay(now);
  const sent = parse((metaRows ?? []).find((r) => r.key === ALERT_DAYS_KEY)?.value, {});
  const due = candidates.filter((c) => sent[c.kind] !== day);
  return { due, record: (kinds) => put(ALERT_DAYS_KEY, { ...sent, ...Object.fromEntries(kinds.map((k) => [k, day])) }) };
}

// The hourly checks' reads (production's hourly tick).
export const WATCH_STATEMENTS = (now) => [
  { sql: "SELECT key, value FROM meta WHERE key IN ('digest_day', 'feed_health', ?1, ?2)", params: [ALERT_DAYS_KEY, STATS_DAY_KEY] },
  // custom topics with an active follower, and when Google last answered a search for any of them
  { sql: "SELECT count(*) AS topics, max(searched_at) AS last FROM custom_topics t WHERE t.tag IS NOT NULL AND EXISTS " +
         "(SELECT 1 FROM custom_follows f JOIN users u ON u.id = f.user_id WHERE f.topic_id = t.id AND f.enabled = 1 AND u.blocked = 0)",
    params: [] },
];

// Pure: the alert candidates from the hourly reads. got: [metaRows, [{topics, last}]].
export function watchCandidates([metaRows, [custom = {}] = []], now) {
  const M = Object.fromEntries((metaRows ?? []).map((r) => [r.key, r.value]));
  const out = [];
  const dd = parse(M.digest_day, null);
  if (dd && dd.day === utcDay(now)) {
    const failed = Number(dd.failed ?? 0), tried = failed + Number(dd.sent ?? 0);
    if (failed >= DIGEST_FAIL_MIN && failed >= DIGEST_FAIL_SHARE * tried) {
      out.push({ kind: "digests_failing", text: alertText(`${failed} of ${tried} digests failed to deliver today (UTC).`,
        "open Admin > Errors and read the \"digest for user\" lines; a Telegram outage clears by itself and the digests are retried, a bot token problem needs the token checked.") });
    }
  }
  const fh = parse(M.feed_health, null);
  const down = Object.entries(fh?.feeds ?? {}).filter(([, f]) => f.err && Number(f.fails ?? 0) >= FEED_DOWN_RUNS);
  if (down.length >= FEEDS_DOWN_MIN) {
    const names = down.slice(0, 6).map(([k]) => k).join(", ") + (down.length > 6 ? ` and ${down.length - 6} more` : "");
    out.push({ kind: "feeds_down", text: alertText(`${down.length} feeds have failed ${FEED_DOWN_RUNS} news runs in a row (${names}).`,
      "open Admin > Feeds; when many fail at once it is usually GitHub's network and clears by itself, otherwise switch the dead ones off in config/sources.yaml.") });
  }
  const topics = Number(custom.topics ?? 0), last = custom.last == null ? null : Number(custom.last);
  if (topics > 0 && last != null && now - last >= GOOGLE_SILENT_S) {
    out.push({ kind: "google_blocked", text: alertText(`Google News has answered no custom topic search for ${Math.floor((now - last) / 3600)} hours (${topics} active topics).`,
      "nothing urgent: custom topics still get stories from our own feeds; if it lasts several days, lower search_workers in config/custom_topics.json.") });
  }
  return out;
}

// ---------------------------------------------------------------- daily stats
const dayStart = (day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);

// The finished day still to write, or null. metaRows from WATCH_STATEMENTS.
export function statsDayDue(metaRows, now) {
  const yday = utcDay(now - 86400);
  const last = (metaRows ?? []).find((r) => r.key === STATS_DAY_KEY)?.value;
  return last === yday ? null : yday;
}

export function statsStatements(day) {
  const a = dayStart(day), b = a + 86400;
  return [
    { sql: "SELECT count(*) AS users, sum(blocked = 0 AND (topics <> '[]' OR EXISTS (SELECT 1 FROM custom_follows f " +
           "WHERE f.user_id = users.id AND f.enabled = 1))) AS active, sum(created_at >= ?1 AND created_at < ?2) AS new_users FROM users",
      params: [a, b] },
    { sql: "SELECT coalesce(main_topic, 'unedited') AS t, count(*) AS n FROM stories WHERE created_at >= ?1 AND created_at < ?2 " +
           "AND merged_into IS NULL GROUP BY t ORDER BY n DESC", params: [a, b] },
    { sql: "SELECT lang, count(*) AS n FROM users WHERE blocked = 0 GROUP BY lang ORDER BY n DESC", params: [] },
    { sql: "SELECT sum(outcome IN ('accepted', 'joined')) AS added, sum(outcome IN ('rejected', 'blocked', 'main_topic')) AS rejected " +
           "FROM topic_checks WHERE at >= ?1 AND at < ?2", params: [a, b] },
    { sql: "SELECT count(*) AS n FROM feedback WHERE at >= ?1 AND at < ?2", params: [a, b] },
    { sql: "SELECT count(*) AS calls, sum(ok = 0) AS errors FROM ai_calls WHERE at >= ?1 AND at < ?2", params: [a, b] },
    { sql: "SELECT value FROM meta WHERE key = 'cf_usage'", params: [] },
  ];
}

// Pure: the row for `day` from statsStatements' answers.
export function statsRow(day, [u = [], st = [], langs = [], checks = [], fb = [], ai = [], usage = []], now) {
  const num = (x) => Number(x ?? 0);
  const cf = parse(usage[0]?.value, {});
  const d1 = cf.day === day ? cf : cf.y?.day === day ? cf.y : null;   // the account's D1 rows for that day
  return {
    day, users: num(u[0]?.users), active: num(u[0]?.active), new_users: num(u[0]?.new_users),
    stories: JSON.stringify(Object.fromEntries(st.map((r) => [r.t, num(r.n)]))),
    languages: JSON.stringify(Object.fromEntries(langs.map((r) => [r.lang, num(r.n)]))),
    custom_added: num(checks[0]?.added), custom_rejected: num(checks[0]?.rejected), feedback: num(fb[0]?.n),
    ai_calls: num(ai[0]?.calls), ai_errors: num(ai[0]?.errors),
    d1_rows_read: d1 ? num(d1.r) : null, d1_rows_written: d1 ? num(d1.w) : null, written_at: now,
  };
}

const STATS_COLS = ["users", "active", "new_users", "stories", "languages", "custom_added", "custom_rejected", "feedback",
  "ai_calls", "ai_errors", "d1_rows_read", "d1_rows_written", "written_at"];
// The day's final write: every column except the live counters (digests_*, deleted).
export function statsWrite(row) {
  return {
    sql: `INSERT INTO daily_stats (day, ${STATS_COLS.join(", ")}) VALUES (?1, ${STATS_COLS.map((_, i) => `?${i + 2}`).join(", ")}) ` +
         `ON CONFLICT(day) DO UPDATE SET ${STATS_COLS.map((c) => `${c} = excluded.${c}`).join(", ")}`,
    params: [row.day, ...STATS_COLS.map((c) => row[c])],
  };
}
export const statsDoneWrite = (day) => put(STATS_DAY_KEY, day);

// Live: a digest tick's delivered and failed counts, added to today's row.
export function digestStatsStatement(out, now) {
  return {
    sql: "INSERT INTO daily_stats (day, digests_sent, digests_failed, digests_blocked) VALUES (?1, ?2, ?3, ?4) " +
         "ON CONFLICT(day) DO UPDATE SET digests_sent = digests_sent + excluded.digests_sent, " +
         "digests_failed = digests_failed + excluded.digests_failed, digests_blocked = digests_blocked + excluded.digests_blocked",
    params: [utcDay(now), out.sent, out.failed - out.blocked, out.blocked],
  };
}

// Live: one account deletion (account.js), only when the user exists.
export const deletedStatsStatement = (userId, now) => ({
  sql: "INSERT INTO daily_stats (day, deleted) SELECT ?2, 1 FROM users WHERE id = ?1 " +
       "ON CONFLICT(day) DO UPDATE SET deleted = deleted + 1",
  params: [Number(userId), utcDay(now)],
});
