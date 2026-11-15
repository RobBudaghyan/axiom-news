// Admin tab data: one D1 batch, shaped in JS. Aggregates run inside D1 (SQL), so the Worker's
// CPU only shapes a few dozen rows. Only reached after the API checked the owner id.
import { CONFIG, parseList } from "./digest.js";
import { LANGS } from "./i18n.js";

const H = 3600, DAY = 86400;
export const D1_FREE = { rows_read: 5_000_000, rows_written: 100_000 };   // per day, reset 00:00 UTC
export const ON_TIME_S = 70 * 60;   // the job should start every hour at about :07
const STUCK_S = 30 * 60;
const NO_SUCCESS_S = 3 * H;

const RUN_STATS_SQL = `SELECT count(*) AS runs,
  sum(status IN ('error', 'ai_failed')) AS failed, sum(status = 'partial') AS partial,
  sum(provider IS NOT NULL AND provider <> 'gemini') AS fallback_runs,
  sum(items_fetched) AS items_fetched, sum(items_new) AS items_new,
  sum(stories_created) AS stories_created, sum(stories_merged) AS stories_merged,
  sum(items_dropped) AS items_dropped, sum(ai_calls) AS ai_calls,
  sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
  sum(editor_status = 'ok') AS editor_ok, sum(editor_status = 'failed') AS editor_failed,
  sum(editor_merged) AS editor_merged
FROM job_runs WHERE started_at >= ?1`;

const MODELS_SQL = `SELECT provider, model, coalesce(kind, 'batch') AS kind,
  sum(at >= ?1) AS calls_24h, sum(CASE WHEN at >= ?1 THEN ok ELSE 0 END) AS ok_24h,
  sum(CASE WHEN at >= ?1 THEN input_tokens ELSE 0 END) AS in_24h,
  sum(CASE WHEN at >= ?1 THEN output_tokens ELSE 0 END) AS out_24h,
  count(*) AS calls_7d, sum(ok) AS ok_7d, sum(input_tokens) AS in_7d, sum(output_tokens) AS out_7d
FROM ai_calls WHERE at >= ?2 GROUP BY provider, model, coalesce(kind, 'batch') ORDER BY calls_7d DESC`;

export function adminStatements(now) {
  const dayStart = Math.floor(now / DAY) * DAY;
  return [
    { sql: "SELECT id, started_at, finished_at, status, provider, error FROM job_runs ORDER BY id DESC LIMIT 1", params: [] },
    { sql: "SELECT started_at, finished_at FROM job_runs WHERE status IN ('ok', 'partial') ORDER BY id DESC LIMIT 1", params: [] },
    { sql: RUN_STATS_SQL, params: [now - DAY] },
    { sql: RUN_STATS_SQL, params: [now - 7 * DAY] },
    { sql: MODELS_SQL, params: [now - DAY, now - 7 * DAY] },
    { sql: "SELECT key, value FROM meta WHERE key IN ('feed_health', 'last_alert_at', 'last_alert_text', 'd1_worker')", params: [] },
    { sql: "SELECT id, first_name, timezone, digest_times, paused, blocked, last_digest_at, next_digest_at, created_at, lang " +
           "FROM users ORDER BY created_at, id LIMIT 200", params: [] },
    { sql: "SELECT at, component, message FROM errors ORDER BY at DESC, id DESC LIMIT 50", params: [] },
    { sql: "SELECT sum(d1_rows_read) AS r, sum(d1_rows_written) AS w, count(*) AS runs FROM job_runs WHERE started_at >= ?1",
      params: [dayStart] },
    // Step 8: digest sizes over the last 24 h from `sent` (no new table). All rows of one digest
    // share its sent_at. A merge copies a sent row to the kept story with the same sent_at, and
    // the merged-away story is skipped here, so each story counts once. Quiet notes write no rows.
    { sql: "SELECT x.user_id, count(*) AS stories, count(DISTINCT x.sent_at) AS digests FROM sent x " +
           "JOIN stories s ON s.id = x.story_id WHERE x.sent_at >= ?1 AND s.merged_into IS NULL GROUP BY x.user_id",
      params: [now - DAY] },
    // Step 9, per reader language over the last 24 h: readers, stories translated (and rejected by
    // the checks), the translation calls and tokens, and digests that went out in English instead.
    { sql: "SELECT lang, count(*) AS users, sum(paused = 0 AND blocked = 0) AS active FROM users GROUP BY lang", params: [] },
    { sql: "SELECT lang, sum(ok = 1) AS ok, sum(ok = 0) AS rejected FROM story_translations WHERE created_at >= ?1 " +
           "GROUP BY lang", params: [now - DAY] },
    { sql: "SELECT substr(kind, 11) AS lang, count(*) AS calls, sum(ok) AS ok, sum(input_tokens) AS input_tokens, " +
           "sum(output_tokens) AS output_tokens FROM ai_calls WHERE at >= ?1 AND kind LIKE 'translate\\_%' ESCAPE '\\' " +
           "GROUP BY kind", params: [now - DAY] },
    { sql: "SELECT message FROM errors WHERE component = 'digest' AND at >= ?1 AND message LIKE 'language fallback%'",
      params: [now - DAY] },
  ];
}

// Step 9: one row per language that is enabled or has any reader or activity in the last 24 h.
export function languageReport(readers = [], translated = [], calls = [], fallbacks = []) {
  const by = (rows) => new Map(rows.map((r) => [r.lang, r]));
  const R = by(readers), T = by(translated), C = by(calls);
  const fb = new Map();
  for (const { message } of fallbacks) {
    const m = /^language fallback \(([a-z]+)\)/.exec(message ?? "");
    if (m) fb.set(m[1], (fb.get(m[1]) ?? 0) + 1);
  }
  const codes = [...new Set([...LANGS.enabled, ...R.keys(), ...T.keys(), ...C.keys(), ...fb.keys()])];
  return codes.filter((c) => c).map((code) => ({
    code, name: LANGS.english_names?.[code] ?? code, enabled: LANGS.enabled.includes(code),
    users: num(R.get(code)?.users), active: num(R.get(code)?.active),
    translated_24h: num(T.get(code)?.ok), rejected_24h: num(T.get(code)?.rejected),
    calls_24h: num(C.get(code)?.calls), failed_calls_24h: num(C.get(code)?.calls) - num(C.get(code)?.ok),
    input_tokens_24h: num(C.get(code)?.input_tokens), output_tokens_24h: num(C.get(code)?.output_tokens),
    fallbacks_24h: fb.get(code) ?? 0,
  }));
}

const num = (v) => Number(v ?? 0);

function statsRow(r) {
  const out = {};
  for (const k of ["runs", "failed", "partial", "fallback_runs", "items_fetched", "items_new", "stories_created",
    "stories_merged", "items_dropped", "ai_calls", "input_tokens", "output_tokens", "editor_ok", "editor_failed",
    "editor_merged"]) out[k] = num(r?.[k]);
  return out;
}

function jsonOr(value, fallback) {
  try { return JSON.parse(value ?? "null") ?? fallback; } catch { return fallback; }
}

export function feedReport(health, now, cfg = CONFIG) {
  const feeds = health?.feeds ?? {};
  const silentBefore = now - (cfg.silent_feed_hours ?? 48) * H;
  const failing = [], silent = [];
  for (const [key, f] of Object.entries(feeds)) {
    if (f.err) failing.push({ key, name: f.n ?? key, error: f.err, since: f.since ?? null, fails: f.fails ?? 1 });
    else if (!f.item || f.item < silentBefore) silent.push({ key, name: f.n ?? key, last_item_at: f.item ?? null });
  }
  failing.sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
  silent.sort((a, b) => (a.last_item_at ?? 0) - (b.last_item_at ?? 0));
  return { checked_at: health?.at ?? null, total: Object.keys(feeds).length, failing, silent,
           silent_hours: cfg.silent_feed_hours ?? 48 };
}

export function shapeAdmin(rows, now, cfg = CONFIG) {
  const [[last], [lastOk], [s24], [s7], models, metaRows, users, errors, [jobD1], sizes = [],
         readers = [], translated = [], trCalls = [], fallbacks = []] = rows;
  const sizeOf = new Map(sizes.map((r) => [r.user_id, r]));
  const meta = Object.fromEntries(metaRows.map((r) => [r.key, r.value]));

  const alertAt = Number(meta.last_alert_at ?? 0);
  const alert = alertAt && now - alertAt <= DAY ? { at: alertAt, text: meta.last_alert_text ?? "" } : null;
  const stuck = last?.status === "running" && now - last.started_at > STUCK_S;
  const failed = last && last.finished_at != null && (last.status === "error" || last.status === "ai_failed");
  const noSuccess = !lastOk || now - lastOk.started_at > NO_SUCCESS_S;
  const onTime = !!last && now - last.started_at <= ON_TIME_S;
  const problems = [];
  if (failed) problems.push("The last news job failed.");
  if (stuck) problems.push("The last news job never finished.");
  if (noSuccess) problems.push("No successful news job in the last 3 hours.");
  if (!onTime) problems.push("The hourly news job is late.");
  const level = failed || stuck || noSuccess ? "bad" : (!onTime || alert || last?.status === "partial") ? "warn" : "ok";

  const d1w = jsonOr(meta.d1_worker, null);
  const today = Math.floor(now / DAY);
  const worker = d1w && d1w.day === today ? { r: num(d1w.r), w: num(d1w.w) } : { r: 0, w: 0 };
  const job = { r: num(jobD1?.r), w: num(jobD1?.w), runs: num(jobD1?.runs) };

  const list = users.map((u) => ({
    id: u.id, name: u.first_name || "(no name)", timezone: u.timezone, times: parseList(u.digest_times),
    paused: !!u.paused, blocked: !!u.blocked, last_digest_at: u.last_digest_at ?? null, lang: u.lang ?? "en",
    next_digest_at: u.next_digest_at ?? null,
    ...(() => {   // Step 8: average digest size in the last 24 h (digests with stories)
      const z = sizeOf.get(u.id);
      const digests = num(z?.digests);
      return { digests_24h: digests, avg_stories_24h: digests ? Math.round((num(z.stories) / digests) * 10) / 10 : null };
    })(),
  }));

  return {
    now,
    health: {
      level, problems,
      last_run: last ? {
        started_at: last.started_at, finished_at: last.finished_at ?? null, status: last.status,
        duration_s: last.finished_at ? last.finished_at - last.started_at : null,
        provider: last.provider ?? null, error: last.error ? String(last.error).slice(0, 300) : null,
      } : null,
      last_ok_at: lastOk?.started_at ?? null,
      trigger: { on_time: onTime, last_started_at: last?.started_at ?? null },
      alert,
    },
    stats: {
      "24h": statsRow(s24), "7d": statsRow(s7),
      models: models.map((m) => ({
        provider: m.provider, model: m.model, kind: m.kind,
        "24h": { calls: num(m.calls_24h), ok: num(m.ok_24h), input_tokens: num(m.in_24h), output_tokens: num(m.out_24h) },
        "7d": { calls: num(m.calls_7d), ok: num(m.ok_7d), input_tokens: num(m.in_7d), output_tokens: num(m.out_7d) },
      })),
    },
    feeds: feedReport(jsonOr(meta.feed_health, null), now, cfg),
    users: {
      count: list.length,
      active: list.filter((u) => !u.paused && !u.blocked).length,
      paused: list.filter((u) => u.paused).length,
      blocked: list.filter((u) => u.blocked).length,
      list,
    },
    languages: languageReport(readers, translated, trCalls, fallbacks),
    errors: errors.map((e) => ({ at: e.at, component: e.component, message: String(e.message).slice(0, 400) })),
    d1: {
      day_start: today * DAY, job, worker,
      rows_read: job.r + worker.r, rows_written: job.w + worker.w, limits: D1_FREE,
    },
  };
}
