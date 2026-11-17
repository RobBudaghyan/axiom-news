// Step 16: compares the tables and columns of the production and staging D1 (names only, no data).
//   node scripts/schema-diff.mjs
import { readFileSync } from "node:fs";
import { d1Rest, loadEnv } from "./digest-cli.mjs";

const prod = loadEnv();
const stagingId = /D1_DATABASE_ID=(\S+)/.exec(readFileSync(new URL("../../.env.staging", import.meta.url), "utf8"))[1];
const cols = async (env) => {
  const db = d1Rest(env);
  const t = await db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite%' AND name NOT LIKE '_cf%' ORDER BY name");
  const out = {};
  for (const { name } of t) out[name] = (await db.query(`SELECT name FROM pragma_table_info('${name}') ORDER BY name`)).map((c) => c.name).join(",");
  return out;
};
const a = await cols(prod), b = await cols({ ...prod, D1_DATABASE_ID: stagingId });
const diff = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
console.log(diff.length ? diff.map((k) => `${k}: prod [${a[k] ?? "missing"}] staging [${b[k] ?? "missing"}]`).join("\n") : `same ${Object.keys(a).length} tables and columns`);
