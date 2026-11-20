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
    { sql: "SELECT key, value FROM meta WHERE key IN ('feed_health', 'last_alert_at', 'last_alert_text', 'd1_worker', 'cf_usage', 'digest_day')", params: [] },
    { sql: "SELECT id, first_name, timezone, digest_times, blocked, last_digest_at, next_digest_at, created_at, lang, " +
           // Step 16: no Pause; "all off" = no main topic and no custom topic switched on
           "(coalesce(topics, '[]') = '[]' AND NOT EXISTS (SELECT 1 FROM custom_follows f WHERE f.user_id = users.id AND f.enabled = 1)) AS all_off " +
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
    { sql: "SELECT lang, count(*) AS users, sum(blocked = 0) AS active FROM users GROUP BY lang", params: [] },
    { sql: "SELECT lang, sum(ok = 1) AS ok, sum(ok = 0) AS rejected FROM story_translations WHERE created_at >= ?1 " +
           "GROUP BY lang", params: [now - DAY] },
    { sql: "SELECT substr(kind, 11) AS lang, count(*) AS calls, sum(ok) AS ok, sum(input_tokens) AS input_tokens, " +
           "sum(output_tokens) AS output_tokens FROM ai_calls WHERE at >= ?1 AND kind LIKE 'translate\\_%' ESCAPE '\\' " +
           "GROUP BY kind", params: [now - DAY] },
    { sql: "SELECT message FROM errors WHERE component = 'digest' AND at >= ?1 AND message LIKE 'language fallback%'",
      params: [now - DAY] },
    // Step 10: stories held back for want of a translation (one row per reader and story; `at` =
    // the last digest that held it), and how many of those holds were sent later.
    { sql: "SELECT h.lang, count(DISTINCT h.story_id) AS stories, count(*) AS holds, " +
           "sum(EXISTS (SELECT 1 FROM sent x WHERE x.user_id = h.user_id AND x.story_id = h.story_id)) AS released " +
           "FROM digest_holds h WHERE h.at >= ?1 GROUP BY h.lang", params: [now - DAY] },
    // Step 18: new stories since 00:00 UTC (created today means updated today: the updated_at index)
    { sql: "SELECT count(*) AS n, sum(final_score >= 7) AS strong FROM stories WHERE updated_at >= ?1 AND created_at >= ?1 AND merged_into IS NULL",
      params: [dayStart] },
  ];
}

// Step 9: one row per language that is enabled or has any reader or activity in the last 24 h.
export function languageReport(readers = [], translated = [], calls = [], fallbacks = [], holds = []) {
  const by = (rows) => new Map(rows.map((r) => [r.lang, r]));
  const R = by(readers), T = by(translated), C = by(calls), HD = by(holds);
  const fb = new Map();
  for (const { message } of fallbacks) {
    const m = /^language fallback \(([a-z]+)\)/.exec(message ?? "");
    if (m) fb.set(m[1], (fb.get(m[1]) ?? 0) + 1);
  }
  const codes = [...new Set([...LANGS.enabled, ...R.keys(), ...T.keys(), ...C.keys(), ...fb.keys(), ...HD.keys()])];
  return codes.filter((c) => c).map((code) => ({
    code, name: LANGS.english_names?.[code] ?? code, enabled: LANGS.enabled.includes(code),
    users: num(R.get(code)?.users), active: num(R.get(code)?.active),
    translated_24h: num(T.get(code)?.ok), rejected_24h: num(T.get(code)?.rejected),
    calls_24h: num(C.get(code)?.calls), failed_calls_24h: num(C.get(code)?.calls) - num(C.get(code)?.ok),
    input_tokens_24h: num(C.get(code)?.input_tokens), output_tokens_24h: num(C.get(code)?.output_tokens),
    fallbacks_24h: fb.get(code) ?? 0,   // digests sent wholly in English (none of their stories translated)
    held_24h: num(HD.get(code)?.stories), held_holds_24h: num(HD.get(code)?.holds),
    held_released_24h: num(HD.get(code)?.released),
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
         readers = [], translated = [], trCalls = [], fallbacks = [], holds = [], [today0] = []] = rows;
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
    all_off: !!u.all_off, blocked: !!u.blocked, last_digest_at: u.last_digest_at ?? null, lang: u.lang ?? "en",
    next_digest_at: u.next_digest_at ?? null,
    ...(() => {   // Step 8: average digest size in the last 24 h (digests with stories)
      const z = sizeOf.get(u.id);
      const digests = num(z?.digests);
      return { digests_24h: digests, avg_stories_24h: digests ? Math.round((num(z.stories) / digests) * 10) / 10 : null };
    })(),
  }));

  const utcDay = new Date(now * 1000).toISOString().slice(0, 10);
  const dd = jsonOr(meta.digest_day, null);
  const deliveries = dd && dd.day === utcDay
    ? { sent: num(dd.sent), quiet: num(dd.quiet), failed: num(dd.failed), blocked: num(dd.blocked), stories: num(dd.stories) }
    : { sent: 0, quiet: 0, failed: 0, blocked: 0, stories: 0 };

  return {
    now,
    today: { day: utcDay, stories: num(today0?.n), strong: num(today0?.strong), deliveries },   // Step 18
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
      active: list.filter((u) => !u.all_off && !u.blocked).length,
      all_off: list.filter((u) => u.all_off && !u.blocked).length,
      blocked: list.filter((u) => u.blocked).length,
      list,
    },
    languages: languageReport(readers, translated, trCalls, fallbacks, holds),
    errors: errors.map((e) => ({ at: e.at, component: e.component, message: String(e.message).slice(0, 400) })),
    d1: {
      day_start: today * DAY, job, worker,
      rows_read: job.r + worker.r, rows_written: job.w + worker.w, limits: D1_FREE,
      // Step 17: Cloudflare's own numbers for the whole account (both copies), checked hourly
      account: (() => {
        const u = jsonOr(meta.cf_usage, null);
        return u && u.day === new Date(now * 1000).toISOString().slice(0, 10)
          ? { r: num(u.r), w: num(u.w), cpu: num(u.cpu), at: num(u.at),
              // Step 17c: yesterday's totals, for the summary line
              y: u.y && u.y.day === new Date((now - DAY) * 1000).toISOString().slice(0, 10) ? { r: num(u.y.r), w: num(u.y.w) } : null }
          : null;
      })(),
    },
  };
}

// ------------------------------------------------------------------ Step 18: the dashboard summary
// One health level (ok / warn / bad = green / amber / red) with the most serious reason in one line,
// the key numbers, and the free limits. Pure: built from what shapeAdmin and the other Admin parts
// already hold, after api.js attached them (custom, env).
export const LIMIT_WARN = 0.7, LIMIT_BAD = 0.9;
const JOB_MINUTE = 7;   // the hourly job starts at about :07 (src/index.js)
const pct = (x) => `${Math.round(x * 100)}%`;

export function adminLimits(A) {
  const L = A.d1.limits, acc = A.d1.account;
  const share = (r, w) => ({ reads: r / L.rows_read, writes: w / L.rows_written });
  return {
    source: acc ? "account" : "copy",   // Cloudflare's own numbers for the account, else this copy's counts
    today: acc ? share(acc.r, acc.w) : share(A.d1.rows_read, A.d1.rows_written),
    yesterday: acc?.y ? share(acc.y.r, acc.y.w) : null,
    counts: acc ? { r: acc.r, w: acc.w } : { r: A.d1.rows_read, w: A.d1.rows_written },
    cpu_over: acc ? Number(acc.cpu ?? 0) : 0,
    checked_at: acc?.at ?? null,
  };
}

// AI calls and errors per model over 24 h (all kinds together), with today's count against the soft
// limit of the AI budget guard where it has one.
export function aiModels(A) {
  const by = new Map();
  for (const m of A.stats.models) {
    const k = m.model || m.provider;
    const x = by.get(k) ?? { model: k, provider: m.provider, calls: 0, failed: 0, kinds: [] };
    x.calls += m["24h"].calls;
    x.failed += m["24h"].calls - m["24h"].ok;
    if (m["24h"].calls && !x.kinds.includes(m.kind)) x.kinds.push(m.kind);
    by.set(k, x);
  }
  for (const g of A.custom?.guard?.models ?? []) {
    const x = by.get(g.model) ?? { model: g.model, provider: "gemini", calls: 0, failed: 0, kinds: [] };
    x.today = Number(g.calls ?? 0);
    x.soft_limit = g.soft_limit ?? null;
    x.r429 = Number(g.r429 ?? 0);
    by.set(g.model, x);
  }
  return [...by.values()].filter((x) => x.calls || x.today).sort((a, b) => b.calls - a.calls);
}

export function nextRunAt(now, env) {
  if (env === "staging") return null;   // staging never runs the job (it copies production's stories)
  const t = Math.floor(now / H) * H + JOB_MINUTE * 60;
  return t > now ? t : t + H;
}

export function adminSummary(A, now) {
  const issues = [];
  const add = (level, text) => issues.push({ level, text });
  const h = A.health;
  for (const p of h.problems) add(/failed|never finished|No successful/.test(p) ? 2 : 1, p);
  if (h.last_run?.status === "partial") add(1, "The last news job was only partly done.");
  if (h.alert) add(1, "An alert was sent in the last 24 hours.");

  const lim = adminLimits(A);
  for (const [k, name] of [["writes", "D1 writes"], ["reads", "D1 reads"]]) {
    const v = lim.today[k];
    if (v >= LIMIT_BAD) add(2, `${name} at ${pct(v)} of the free limit today.`);
    else if (v >= LIMIT_WARN) add(1, `${name} at ${pct(v)} of the free limit today.`);
  }
  if (lim.cpu_over) add(1, `${lim.cpu_over} Worker ${lim.cpu_over === 1 ? "run" : "runs"} over the CPU limit today.`);

  const d = A.today?.deliveries ?? { sent: 0, failed: 0, blocked: 0 };
  const tries = d.sent + d.failed;
  const rate = tries ? d.sent / tries : null;
  if (d.failed && rate < 0.8 && d.failed >= 3) add(2, `${d.failed} digest deliveries failed today (${pct(rate)} delivered).`);
  else if (d.failed) add(1, `${d.failed} digest ${d.failed === 1 ? "delivery" : "deliveries"} failed today.`);

  const ai = aiModels(A);
  for (const m of ai) if (m.calls >= 4 && m.failed / m.calls >= 0.5) add(1, `${m.model}: ${m.failed} of ${m.calls} AI calls failed (24 h).`);
  const g = A.custom?.guard;
  if (g && Math.max(g.level ?? 0, g.job_level ?? 0) >= 2) add(1, "AI budget: topic checks and translations wait.");
  else if (g && Math.max(g.level ?? 0, g.job_level ?? 0) === 1) add(1, "AI budget: new topic checks wait.");
  const F = A.feeds;
  if (F.total && F.failing.length / F.total >= 0.1) add(1, `${F.failing.length} of ${F.total} feeds failing.`);

  issues.sort((a, b) => b.level - a.level);
  const top = issues.length ? issues[0].level : 0;
  const more = issues.length - 1;
  return {
    level: ["ok", "warn", "bad"][top],
    reason: issues.length ? `${issues[0].text}${more > 0 ? ` (+${more} more)` : ""}` : "The news job, digests and limits are fine.",
    issues,
    numbers: {
      active_users: A.users.active, users: A.users.count,
      digests_today: d.sent, failed_today: d.failed, blocked_today: d.blocked ?? 0, delivery: rate,
      stories_today: A.today?.stories ?? 0, strong_today: A.today?.strong ?? 0,
      last_run: h.last_run ? { at: h.last_run.started_at, status: h.last_run.status } : null,
      next_run_at: nextRunAt(now, A.env),
    },
    limits: lim,
    ai,
  };
}
