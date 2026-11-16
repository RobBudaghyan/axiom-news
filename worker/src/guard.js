// AI budget guard (Step 13), the Worker's twin of job/guard.py (tests/fixtures/guard_cases.json keeps
// them identical). Calls per model since midnight Pacific time (Gemini's free day), and 429 answers.
//   level 1: new custom-topic checks wait ("try again in a few minutes")
//   level 2: translations wait too (the job skips them; stories are held, Step 10 rule)
//   never:   pass 1 and the editor
// Pure functions plus one SQL statement; no Intl (the Pacific day is computed by the US rule).
import BUDGET from "../../config/ai_budget.json" with { type: "json" };

export { BUDGET };
const DAY = 86400;

export const COUNT_SQL = `
SELECT model, count(*) AS calls,
       sum(CASE WHEN code = 429 OR (code IS NULL AND error LIKE '%HTTP 429%') THEN 1 ELSE 0 END) AS r429,
       sum(CASE WHEN at >= ?2 AND (code = 429 OR (code IS NULL AND error LIKE '%HTTP 429%')) THEN 1 ELSE 0 END) AS recent429
FROM ai_calls WHERE at >= ?1 GROUP BY model`;

function nthSundayUtc(year, month, n, hourUtc) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const toSunday = (7 - first.getUTCDay()) % 7;
  return Date.UTC(year, month - 1, 1 + toSunday + 7 * (n - 1), hourUtc) / 1000;
}

// -7 from the second Sunday of March 10:00 UTC to the first Sunday of November 09:00 UTC, else -8.
export function pacificOffset(ts) {
  const year = new Date(ts * 1000).getUTCFullYear();
  return ts >= nthSundayUtc(year, 3, 2, 10) && ts < nthSundayUtc(year, 11, 1, 9) ? -7 : -8;
}

// {day: "YYYY-MM-DD", start: unix time of that Pacific midnight}
export function pacificDay(ts) {
  const off = pacificOffset(ts);
  const day = Math.floor((ts + off * 3600) / DAY);
  let start = day * DAY - off * 3600;
  start = day * DAY - pacificOffset(start) * 3600;
  return { day: new Date(day * DAY * 1000).toISOString().slice(0, 10), start };
}

// counts: {model: {calls, r429, recent429}} -> {level, reasons}. Same rule as job/guard.py assess().
export function assess(counts, cfg = BUDGET) {
  let level = 0;
  const reasons = [];
  const gem = cfg.gemini_models ?? [];
  const limits = cfg.soft_limits ?? {};
  const ratio = cfg.check_ratio ?? 0.8;
  for (const model of gem) {
    const calls = Number(counts[model]?.calls ?? 0);
    const limit = limits[model];
    if (!limit) continue;
    if (calls >= limit) {
      level = Math.max(level, 2);
      reasons.push(`${model}: ${calls} calls today, soft limit ${limit}`);
    } else if (calls >= ratio * limit) {
      level = Math.max(level, 1);
      reasons.push(`${model}: ${calls} calls today, ${Math.round((100 * calls) / limit)}% of the soft limit ${limit}`);
    }
  }
  const refusing = gem.filter((m) => Number(counts[m]?.recent429 ?? 0) > 0);
  if (gem.length && refusing.length === gem.length) {
    level = Math.max(level, 2);
    reasons.push("every Gemini model answered 429 in the last hour");
  } else if (refusing.length) {
    level = Math.max(level, 1);
    reasons.push(`${refusing.join(", ")} answered 429 in the last hour`);
  }
  return { level, reasons };
}

export function countStatement(now, cfg = BUDGET) {
  const { start } = pacificDay(now);
  return { sql: COUNT_SQL, params: [start, now - (cfg.recent_429_minutes ?? 60) * 60] };
}

export function countsFrom(rows) {
  const out = {};
  for (const r of rows ?? []) {
    out[r.model ?? "?"] = { calls: Number(r.calls ?? 0), r429: Number(r.r429 ?? 0), recent429: Number(r.recent429 ?? 0) };
  }
  return out;
}

// The guard right now from the count rows: {level, reasons, day, counts}.
export function guardState(rows, now, cfg = BUDGET) {
  const counts = countsFrom(rows);
  return { ...assess(counts, cfg), day: pacificDay(now).day, at: now, counts };
}
