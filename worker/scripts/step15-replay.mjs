// Step 15 one-off: replay the last 48 h of real stories for four readers, before (no off-means-off
// rule) and after (the rule on), with the real planDigest and length cut. Writes
// reports/data/step-15/replay.json and replay.txt; prints the totals. Reads D1, writes nothing.
//   node scripts/step15-replay.mjs [--hours 48]
import { mkdirSync, writeFileSync } from "node:fs";
import { CONFIG, parseList } from "../src/digest.js";
import { asTopicRows, enabledOnly, followedStatement, withCustomTopics } from "../src/custom.js";
import { POOL_COLUMNS, d1Rest, loadEnv, windows } from "./digest-cli.mjs";

const hours = Number(process.argv[process.argv.indexOf("--hours") + 1]) || 48;
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
  economy_off: { ...base, topics: JSON.stringify(MAIN.filter((t) => t !== "economy_markets")) },
};
const pool = await db.query(`SELECT ${POOL_COLUMNS} FROM stories WHERE created_at >= ?1 AND merged_into IS NULL`,
  [now - hours * 3600 - 86400]);
const out = { at: new Date(now * 1000).toISOString(), hours, pool: pool.length, readers: {} };
const lines = [];
for (const [name, user] of Object.entries(READERS)) {
  const on = parseList(user.topics);
  const off = MAIN.filter((t) => !on.includes(t));
  out.readers[name] = { topics: on, times: parseList(user.digest_times) };
  for (const [mode, cfg] of [["before", { ...CONFIG, main_tags: [] }], ["after", CONFIG]]) {
    const w = await windows(db, user, topics, now, cfg, hours, pool);
    const all = w.flatMap((d) => d.list);
    const fromOff = all.filter((s) => off.includes(s.main));
    const byMain = {};
    for (const s of all) byMain[s.main ?? "none"] = (byMain[s.main ?? "none"] ?? 0) + 1;
    out.readers[name][mode] = { digests: w.length, stories: all.length, per_digest: +(all.length / Math.max(1, w.length)).toFixed(1),
      max: Math.max(0, ...w.map((d) => d.stories)), cut: w.reduce((a, d) => a + d.cut, 0), from_switched_off_topics: fromOff.length,
      by_main_topic: byMain, digests_detail: w.map((d) => ({ at: d.at, stories: d.stories, chars: d.chars, list: d.list })) };
    lines.push(`\n##### ${name} (${on.join(", ")}) ${mode}: ${all.length} stories in ${w.length} digests, ` +
      `${fromOff.length} whose main topic is switched off`);
    for (const d of w) {
      lines.push(`--- ${d.at}: ${d.stories} stories, ${d.chars} characters`);
      for (const s of d.list) lines.push(`  [${s.score}/t${s.topic ?? "-"}] ${s.primary} (main ${s.main ?? "none"}): ${s.headline}`);
    }
  }
}
const dir = new URL("../../reports/data/step-15/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL("replay.json", dir), JSON.stringify(out, null, 1));
writeFileSync(new URL("replay.txt", dir), lines.join("\n") + "\n");
for (const [name, r] of Object.entries(out.readers)) {
  console.log(`${name.padEnd(13)} before ${r.before.stories} stories (${r.before.per_digest}/digest, ${r.before.from_switched_off_topics} from off topics)` +
    `  after ${r.after.stories} (${r.after.per_digest}/digest, ${r.after.from_switched_off_topics} from off topics)  by main after: ${JSON.stringify(r.after.by_main_topic)}`);
}
console.log(`[pool ${pool.length} stories; written reports/data/step-15/replay.json and replay.txt]`);
