// Watching the hourly GitHub job from the Worker. Pure: decides which alerts are candidates.
// Step 19 (owner): one alert per kind per UTC day (watch.js dueAlerts), each with a "What to do:" line;
// "no news run" after 2 hours (was 3).
import { hhmm, localParts, zoneLabel } from "./digest.js";
import { ALERT_DAYS_KEY, alertText } from "./watch.js";

export const NO_SUCCESS_S = 2 * 3600;      // alert if no ok/partial run for 2 hours
export const STUCK_S = 30 * 60;            // a run still "running" after 30 min died

export const HEALTH_STATEMENTS = [
  { sql: "SELECT id, started_at, finished_at, status FROM job_runs ORDER BY id DESC LIMIT 5", params: [] },
  { sql: "SELECT started_at FROM job_runs WHERE status IN ('ok', 'partial') ORDER BY id DESC LIMIT 1", params: [] },
  { sql: "SELECT key, value FROM meta WHERE key IN ('last_alerted_run_id', ?1)", params: [ALERT_DAYS_KEY] },
];

const put = (key, value) => ({
  sql: "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  params: [key, String(value)],
});

// runs: newest first. lastOk: [{started_at}] or []. meta: [{key, value}].
// extra: problems found elsewhere this tick (e.g. the GitHub dispatch failed).
// Returns {problems, candidates: [{kind, text}], writes} (writes: remember the run already reported).
export function assessHealth({ runs, lastOk, meta, extra = [] }, now, tz) {
  const m = Object.fromEntries((meta ?? []).map((r) => [r.key, r.value]));
  const alerted = Number(m.last_alerted_run_id) || 0;
  const at = (ts) => `${hhmm(localParts(ts, tz))} ${zoneLabel(tz)} time`;
  const problems = [], candidates = [];
  let newestRunId = alerted;
  for (const p of extra) {
    problems.push(p);
    candidates.push({ kind: "dispatch", text: alertText(`${p}.`,
      "check the GitHub token (GITHUB_DISPATCH_TOKEN) is still valid; the backup schedule at :37 keeps the news running meanwhile.") });
  }

  const finished = runs.find((r) => r.finished_at != null);
  if (finished && finished.id > alerted && (finished.status === "error" || finished.status === "ai_failed")) {
    const p = `the hourly news job failed (status ${finished.status}, started ${at(finished.started_at)})`;
    problems.push(p);
    candidates.push({ kind: "job_failed", text: alertText(`${p}. Digests still go out from the stories already collected.`,
      "open GitHub Actions > hourly and read the failed run's log; one failure usually clears at the next run.") });
    newestRunId = Math.max(newestRunId, finished.id);
  }
  const stuck = runs.find((r) => r.status === "running" && r.started_at < now - STUCK_S);
  if (stuck && stuck.id > alerted) {
    const p = `the hourly news job that started at ${at(stuck.started_at)} never finished`;
    problems.push(p);
    candidates.push({ kind: "job_stuck", text: alertText(`${p}.`,
      "cancel it in GitHub Actions if it still shows as running; the next hourly run starts by itself.") });
    newestRunId = Math.max(newestRunId, stuck.id);
  }
  const okAt = lastOk?.[0]?.started_at;
  if (!okAt || okAt < now - NO_SUCCESS_S) {
    const p = okAt ? `no successful hourly job run since ${at(okAt)}` : "no successful hourly job run yet";
    problems.push(p);
    candidates.push({ kind: "no_run", text: alertText(`${p}. Digests still go out, with older stories.`,
      "check GitHub Actions for failed or missing runs, then press Run news job now in Admin.") });
  }
  return { problems, candidates, writes: newestRunId !== alerted ? [put("last_alerted_run_id", newestRunId)] : [] };
}
