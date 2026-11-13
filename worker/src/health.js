// Watching the hourly GitHub job from the Worker. Pure: decides whether to alert the owner.
import { hhmm, localParts, zoneLabel } from "./digest.js";

export const ALERT_EVERY_S = 3 * 3600;     // at most one alert per 3 hours
export const NO_SUCCESS_S = 3 * 3600;      // alert if no ok/partial run for 3 hours
export const STUCK_S = 30 * 60;            // a run still "running" after 30 min died

export const HEALTH_STATEMENTS = [
  { sql: "SELECT id, started_at, finished_at, status FROM job_runs ORDER BY id DESC LIMIT 5", params: [] },
  { sql: "SELECT started_at FROM job_runs WHERE status IN ('ok', 'partial') ORDER BY id DESC LIMIT 1", params: [] },
  { sql: "SELECT key, value FROM meta WHERE key IN ('last_alert_at', 'last_alerted_run_id')", params: [] },
];

// runs: newest first. lastOk: [{started_at}] or []. meta: [{key, value}].
// extra: problems found elsewhere this tick (e.g. the GitHub dispatch failed).
export function assessHealth({ runs, lastOk, meta, extra = [] }, now, tz) {
  const m = Object.fromEntries((meta ?? []).map((r) => [r.key, Number(r.value)]));
  const alerted = m.last_alerted_run_id || 0;
  const at = (ts) => hhmm(localParts(ts, tz));
  const problems = [...extra];
  let newestRunId = alerted;

  const finished = runs.find((r) => r.finished_at != null);
  if (finished && finished.id > alerted && (finished.status === "error" || finished.status === "ai_failed")) {
    problems.push(`the hourly news job failed (status ${finished.status}, started ${at(finished.started_at)})`);
    newestRunId = Math.max(newestRunId, finished.id);
  }
  const stuck = runs.find((r) => r.status === "running" && r.started_at < now - STUCK_S);
  if (stuck && stuck.id > alerted) {
    problems.push(`the hourly news job that started at ${at(stuck.started_at)} never finished`);
    newestRunId = Math.max(newestRunId, stuck.id);
  }
  const okAt = lastOk?.[0]?.started_at;
  if (!okAt || okAt < now - NO_SUCCESS_S) {
    problems.push(okAt ? `no successful hourly job run since ${at(okAt)}` : "no successful hourly job run yet");
  }

  if (!problems.length) return { problems, alert: null, writes: [] };
  const lastAlert = m.last_alert_at || 0;
  if (now - lastAlert < ALERT_EVERY_S) return { problems, alert: null, writes: [] };
  const alert = `Axiom News alert: ${problems.join("; ")} (${zoneLabel(tz)} time). ` +
    "Digests still go out from the stories already collected. Details are in the errors table " +
    "and on the GitHub Actions page. The next alert comes at most 3 hours from now.";
  const put = (key, value) => ({
    sql: "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    params: [key, String(value)],
  });
  return { problems, alert, writes: [put("last_alert_at", now), put("last_alerted_run_id", newestRunId)] };
}
