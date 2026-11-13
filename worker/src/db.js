// One small database interface used everywhere: query(sql, params) -> rows and
// batch([{sql, params}]) -> [rows...]. Adapters: the Worker's D1 binding (here), the D1 REST
// API (scripts/digest-cli.mjs) and node:sqlite (tests).

export function d1Binding(D1) {
  const prep = (s) => D1.prepare(s.sql).bind(...(s.params ?? []));
  return {
    async query(sql, params = []) {
      return (await prep({ sql, params }).all()).results ?? [];
    },
    async batch(stmts) {
      if (!stmts.length) return [];
      return (await D1.batch(stmts.map(prep))).map((r) => r.results ?? []);
    },
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
