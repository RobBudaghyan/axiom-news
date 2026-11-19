// Step 17: the Cloudflare account's free limits, checked once an hour (production's hourly tick).
// D1's limits are per ACCOUNT (both copies together): 5M rows read and 100k rows written a UTC day.
// One GraphQL call to Cloudflare's analytics API (token: Account Analytics Read, secret
// CLOUDFLARE_ANALYTICS_TOKEN; no token = no check) gives today's D1 rows for every database and the
// Worker invocations that ended over a limit (status exceededCpu, also exceededMemory) since the last
// check, for both Workers. The owner gets at most one alert a UTC day for D1 and one for CPU.
// Waiting for the API is not CPU time; the answer is a few hundred bytes.

export const D1_LIMITS = { rows_read: 5_000_000, rows_written: 100_000 };
export const ALERT_SHARE = 0.8;
export const STATE_KEY = "cf_usage";

// Step 17c: also yesterday's totals (d1y), for the daily summary line in Admin.
export const USAGE_QUERY = `query Usage($account: String!, $day: Date!, $yday: Date!, $since: Time!) {
  viewer { accounts(filter: {accountTag: $account}) {
    d1: d1AnalyticsAdaptiveGroups(limit: 50, filter: {date: $day}) {
      sum { rowsRead rowsWritten } dimensions { databaseId }
    }
    d1y: d1AnalyticsAdaptiveGroups(limit: 50, filter: {date: $yday}) {
      sum { rowsRead rowsWritten } dimensions { databaseId }
    }
    workers: workersInvocationsAdaptive(limit: 50, filter: {datetime_geq: $since}) {
      sum { requests } dimensions { scriptName status }
    }
  } }
}`;

export const utcDay = (now) => new Date(now * 1000).toISOString().slice(0, 10);
export const yesterday = (now) => utcDay(now - 86400);

// The analytics answer -> {r, w, yr, yw, over: [{script, status, n}]} (yr, yw: yesterday, null if the
// answer has no d1y part). Throws on an API error.
export function readAnswer(body) {
  if (body?.errors?.length) throw new Error(`analytics: ${body.errors.map((e) => e.message).join("; ").slice(0, 200)}`);
  const acc = body?.data?.viewer?.accounts?.[0];
  if (!acc) throw new Error("analytics: no account in the answer");
  let r = 0, w = 0;
  for (const g of acc.d1 ?? []) { r += Number(g.sum?.rowsRead ?? 0); w += Number(g.sum?.rowsWritten ?? 0); }
  let yr = null, yw = null;
  if (Array.isArray(acc.d1y)) {
    yr = 0; yw = 0;
    for (const g of acc.d1y) { yr += Number(g.sum?.rowsRead ?? 0); yw += Number(g.sum?.rowsWritten ?? 0); }
  }
  const over = [];
  for (const g of acc.workers ?? []) {
    const status = String(g.dimensions?.status ?? "");
    if (/^exceeded/i.test(status)) over.push({ script: g.dimensions?.scriptName ?? "?", status, n: Number(g.sum?.requests ?? 0) });
  }
  return { r, w, yr, yw, over };
}

const pct = (x, limit) => Math.round((100 * x) / limit);
const n = (x) => x.toLocaleString("en-US");

// Pure. prev: the stored state ({day, r, w, cpu, d1_alert_day, cpu_alert_day, checked_at}) or null.
// Returns {state, alerts: [{kind: "d1" | "cpu", text}]}.
export function assessUsage(got, prev, now, limits = D1_LIMITS, share = ALERT_SHARE) {
  const day = utcDay(now);
  const p = prev ?? {};
  const cpuToday = (p.day === day ? Number(p.cpu ?? 0) : 0) + got.over.reduce((a, o) => a + o.n, 0);
  const state = { day, at: now, r: got.r, w: got.w, cpu: cpuToday, checked_at: now,
                  d1_alert_day: p.d1_alert_day ?? null, cpu_alert_day: p.cpu_alert_day ?? null };
  if (got.yr != null) state.y = { day: utcDay(now - 86400), r: got.yr, w: got.yw };
  else if (p.day && p.day === utcDay(now - 86400)) state.y = { day: p.day, r: Number(p.r ?? 0), w: Number(p.w ?? 0) };
  else if (p.y) state.y = p.y;
  const alerts = [];
  const high = [];
  if (got.r >= share * limits.rows_read) high.push(`rows read ${n(got.r)} (${pct(got.r, limits.rows_read)}% of ${n(limits.rows_read)})`);
  if (got.w >= share * limits.rows_written) high.push(`rows written ${n(got.w)} (${pct(got.w, limits.rows_written)}% of ${n(limits.rows_written)})`);
  if (high.length && state.d1_alert_day !== day) {
    alerts.push({ kind: "d1", text: `Axiom News alert: the database is near its free daily limit: ${high.join(", ")}, both copies together, ` +
      "today (UTC). Over the limit, database calls fail until 00:00 UTC: no new stories and no digests until then. " +
      "Check Admin > Database today. Next alert of this kind tomorrow at the earliest." });
    state.d1_alert_day = day;
  }
  if (got.over.length && state.cpu_alert_day !== day) {
    const what = got.over.map((o) => `${o.script}: ${o.n} ${o.status}`).join(", ");
    alerts.push({ kind: "cpu", text: `Axiom News alert: Cloudflare stopped Worker runs over the free CPU limit (10 ms): ${what}, ` +
      "in the last hour. A stopped digest tick is retried at the next minute. If this repeats, see plan B in OWNER_GUIDE.md. " +
      "Next alert of this kind tomorrow at the earliest." });
    state.cpu_alert_day = day;
  }
  return { state, alerts };
}

export const stateStatement = () => ({ sql: "SELECT value FROM meta WHERE key = ?1", params: [STATE_KEY] });
export const saveStatement = (state) => ({
  sql: "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  params: [STATE_KEY, JSON.stringify(state)],
});

// The hourly check. io: {fetch, alert(text)}. Returns a short summary for the tick log.
export async function checkUsage(db, env, now, io) {
  if (!env.CLOUDFLARE_ANALYTICS_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) return { usage: "no token" };
  const [rows] = await db.batch([stateStatement()]);
  let prev = null;
  try { prev = JSON.parse(rows?.[0]?.value ?? "null"); } catch { prev = null; }
  // since the last check (every tick in between is covered), at most 2 hours back
  const since = Math.max(Number(prev?.checked_at ?? 0), now - 2 * 3600);
  const res = await io.fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ query: USAGE_QUERY, variables: {
      account: env.CLOUDFLARE_ACCOUNT_ID, day: utcDay(now), yday: yesterday(now), since: new Date(since * 1000).toISOString() } }),
  });
  const got = readAnswer(await res.json());
  const { state, alerts } = assessUsage(got, prev, now);
  for (const a of alerts) {
    try { await io.alert(a.text); }
    catch { state[`${a.kind}_alert_day`] = prev?.[`${a.kind}_alert_day`] ?? null; }   // tried again next hour
  }
  await db.batch([saveStatement(state)]);
  return { usage: { r: state.r, w: state.w, cpu: state.cpu, alerts: alerts.length } };
}
