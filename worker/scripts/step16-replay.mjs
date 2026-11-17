// Step 16 item 7 (advisor): digest length. Replays the last 48 h of real stories (the real planDigest
// and length cut, no AI) for three readers (all six topics, Armenia only, the owner's settings)
// under the current config ("before") and under candidate configs, and writes
// reports/data/step-16/replay-<name>.{json,txt}. Reads D1, writes nothing.
//   node scripts/step16-replay.mjs [--hours 48] [--name before]
import { mkdirSync, writeFileSync } from "node:fs";
import { CONFIG, parseList } from "../src/digest.js";
import { asTopicRows, enabledOnly, followedStatement, withCustomTopics } from "../src/custom.js";
import { POOL_COLUMNS, d1Rest, loadEnv, windows } from "./digest-cli.mjs";

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const hours = Number(arg("--hours", 48));
const name = arg("--name", "run");
const env = loadEnv();
const db = d1Rest(env);
const owner = Number(env.OWNER_TELEGRAM_ID);
const now = Math.floor(Date.now() / 1000);
const [users, mainTopics, custom] = await db.batch([
  { sql: "SELECT * FROM users WHERE id = ?1", params: [owner] },
  { sql: "SELECT tag, label_en, emoji, sort, is_default FROM topics ORDER BY sort", params: [] },
  followedStatement(owner),
]);
const me = withCustomTopics(users[0], custom);
const topics = [...mainTopics, ...asTopicRows(enabledOnly(custom))];
const MAIN = mainTopics.map((t) => t.tag);
const base = { ...me, id: 0, first_name: "Sam", timezone: "Asia/Yerevan", digest_times: JSON.stringify(["09:00", "14:00", "20:00"]), lang: "en" };
const READERS = {
  all_six: { ...base, topics: JSON.stringify(MAIN) },
  armenia_only: { ...base, topics: JSON.stringify(["armenia"]) },
  owner: { ...me, lang: "en" },
};
// Candidate configs (only the levers named in the brief: boost caps and bars).
const caps = (o) => ({ ...CONFIG, topic_boost_max: { ...CONFIG.topic_boost_max, ...o } });
const VARIANTS = {
  current: CONFIG,
  am_ru_cap1: caps({ armenia: 1, russia: 1 }),
  am_cap1: caps({ armenia: 1 }),
  all_caps0: caps({ armenia: 0, russia: 0, economy_markets: 0, iran_war: 0, ukraine_war: 0 }),
  editorial8: { ...CONFIG, editorial_bar: 8 },
  topic7: { ...CONFIG, topic_bar: 7 },
  am_ru_cap1_topic7: { ...caps({ armenia: 1, russia: 1 }), topic_bar: 7 },
  wars_econ0_amru1: caps({ armenia: 1, russia: 1, economy_markets: 0, iran_war: 0, ukraine_war: 0 }),
  wars_econ0: caps({ economy_markets: 0, iran_war: 0, ukraine_war: 0 }),
};
const pick = arg("--variants", Object.keys(VARIANTS).join(",")).split(",");
const pool = await db.query(`SELECT ${POOL_COLUMNS} FROM stories WHERE created_at >= ?1 AND merged_into IS NULL`,
  [now - hours * 3600 - 86400]);
const out = { at: new Date(now * 1000).toISOString(), hours, pool: pool.length, results: {} };
const lines = [];
for (const v of pick) {
  const cfg = VARIANTS[v];
  out.results[v] = {};
  for (const [who, user] of Object.entries(READERS)) {
    const w = await windows(db, user, topics, now, cfg, hours, pool);
    const all = w.flatMap((d) => d.list);
    const sizes = w.map((d) => d.stories);
    out.results[v][who] = { digests: w.length, stories: all.length, per_digest: +(all.length / Math.max(1, w.length)).toFixed(1),
      min: Math.min(...sizes), max: Math.max(0, ...sizes), cut: w.reduce((a, d) => a + d.cut, 0), sizes,
      digests_detail: w.map((d) => ({ at: d.at, stories: d.stories, chars: d.chars, list: d.list })) };
    lines.push(`\n##### ${v} / ${who}: ${all.length} stories in ${w.length} digests (${sizes.join(", ")}), ` +
      `${out.results[v][who].cut} cut for length`);
    for (const d of w) {
      lines.push(`--- ${d.at}: ${d.stories} stories, ${d.chars} characters`);
      for (const s of d.list) lines.push(`  [${s.score}/t${s.topic ?? "-"}] ${s.primary} (main ${s.main ?? "none"}): ${s.headline}`);
    }
  }
}
const dir = new URL("../../reports/data/step-16/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL(`replay-${name}.json`, dir), JSON.stringify(out, null, 1));
writeFileSync(new URL(`replay-${name}.txt`, dir), lines.join("\n") + "\n");
for (const [v, r] of Object.entries(out.results)) {
  console.log(v.padEnd(18) + Object.entries(r).map(([who, x]) =>
    `${who} ${x.per_digest}/digest (${x.min}-${x.max}, ${x.cut} cut)`).join("   "));
}
console.log(`[pool ${pool.length} stories; reports/data/step-16/replay-${name}.{json,txt}]`);
