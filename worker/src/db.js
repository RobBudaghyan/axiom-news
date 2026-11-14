// One small database interface used everywhere: query(sql, params) -> rows and
// batch([{sql, params}]) -> [rows...]. Adapters: the Worker's D1 binding (here), the D1 REST
// API (scripts/digest-cli.mjs) and node:sqlite (tests).
//
// The binding also adds up D1's own rows_read / rows_written (what the free limits count) for
// this isolate. The cron tick flushes the sum into `meta` (key d1_worker), so the Admin tab can
// show the Worker's D1 use today next to the hourly job's exact numbers. Counts of an isolate
// that is evicted before the next tick are lost, so the figure is a slight undercount.

const usage = { r: 0, w: 0 };

export function takeUsage() {
  const out = { ...usage };
  usage.r = 0; usage.w = 0;
  return out;
}

function count(res) {
  usage.r += res?.meta?.rows_read ?? 0;
  usage.w += res?.meta?.rows_written ?? 0;
  return res?.results ?? [];
}

export function d1Binding(D1) {
  const prep = (s) => D1.prepare(s.sql).bind(...(s.params ?? []));
  return {
    async query(sql, params = []) {
      return count(await prep({ sql, params }).all());
    },
    async batch(stmts) {
      if (!stmts.length) return [];
      return (await D1.batch(stmts.map(prep))).map(count);
    },
  };
}

// Adds a usage flush to a batch: meta.d1_worker = {"day": <UTC day number>, "r": rows, "w": rows},
// reset when the UTC day changes (D1's limits reset at 00:00 UTC).
export function usageStatement(u, now) {
  const day = Math.floor(now / 86400);
  return {
    sql: `INSERT INTO meta (key, value) VALUES ('d1_worker', json_object('day', ?1, 'r', ?2, 'w', ?3))
ON CONFLICT(key) DO UPDATE SET value = CASE WHEN json_extract(meta.value, '$.day') = ?1
  THEN json_object('day', ?1, 'r', json_extract(meta.value, '$.r') + ?2, 'w', json_extract(meta.value, '$.w') + ?3)
  ELSE json_object('day', ?1, 'r', ?2, 'w', ?3) END`,
    params: [day, u.r, u.w],
  };
}

export function errorStatement(message, now, component = "worker") {
  return {
    sql: "INSERT INTO errors (at, component, message) VALUES (?1, ?2, ?3)",
    params: [now, component, String(message).slice(0, 1000)],
  };
}

export async function logError(db, message, now) {
  try {
    await db.batch([errorStatement(message, now)]);
  } catch (e) {
    console.error("could not log error", String(e), String(message));
  }
}
