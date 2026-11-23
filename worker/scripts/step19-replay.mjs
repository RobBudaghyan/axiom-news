// Step 19: replays the last 48 h of stories (the real planDigest and length cut, no AI) for three
// readers at 09:00, 14:00 and 20:00 Yerevan: all six main topics, Armenia only, Technology & AI only.
// Reads D1, writes nothing there; writes reports/data/step-19/replay-<name>.{json,txt}.
// Run against staging (its pool is production's, re-tagged by migrate-step19.mjs, plus the tech
// backfill of scripts/step19_backfill.py):
//   AXIOM_ENV=staging node scripts/step19-replay.mjs [--hours 48] [--name staging]
import { mkdirSync, writeFileSync } from "node:fs";
import { CONFIG } from "../src/digest.js";
import { POOL_COLUMNS, STAGING, d1Rest, loadEnv, windows } from "./digest-cli.mjs";

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const hours = Number(arg("--hours", 48));
const name = arg("--name", STAGING ? "staging" : "run");
const db = d1Rest(loadEnv());
const now = Math.floor(Date.now() / 1000);
const topics = await db.query("SELECT tag, label_en, emoji, sort, is_default FROM topics ORDER BY sort");
const MAIN = topics.map((t) => t.tag);
const base = { id: 0, first_name: "Sam", timezone: "Asia/Yerevan", digest_times: JSON.stringify(["09:00", "14:00", "20:00"]), lang: "en" };
const READERS = {
  all_six: { ...base, topics: JSON.stringify(MAIN) },
  armenia_only: { ...base, topics: JSON.stringify(["armenia"]) },
  tech_only: { ...base, topics: JSON.stringify(["tech_ai"]) },
};
const pool = await db.query(`SELECT ${POOL_COLUMNS} FROM stories WHERE created_at >= ?1 AND merged_into IS NULL`,
  [now - hours * 3600 - 86400]);
// --simulate: stories tagged before Technology & AI existed have no tech_ai tag. In memory only (nothing
// is written), a story whose headline clearly names AI, chips, big tech or cybersecurity gets tech_ai, and
// becomes its main topic when that was Economy & Markets or Politics & Conflicts (its scores are kept; the
// digest caps the boost by the new main topic). An estimate of what the editor would have done.
const TECH_WORDS = /\b(AI|A\.I\.|artificial intelligence|OpenAI|Anthropic|ChatGPT|Nvidia|chips?|chipmakers?|semiconductors?|TSMC|cyber\w*|hack(s|ers|ed)?|ransomware|data breach|Google|Alphabet|Apple|Microsoft|Meta|Amazon|SpaceX|xAI|Grok|robots?|quantum|satellites?|deepfakes?|tech)\b/i;
const simulate = process.argv.includes("--simulate");
let simulated = 0;
if (simulate) {
  for (const s of pool) {
    const tags = JSON.parse(s.topics || "[]");
    if (tags.includes("tech_ai") || !TECH_WORDS.test(s.headline ?? s.summary ?? "")) continue;
    s.topics = JSON.stringify([...tags, "tech_ai"]);
    if (["economy_markets", "politics_conflicts"].includes(s.main_topic)) s.main_topic = "tech_ai";
    simulated++;
  }
}
const out = { at: new Date(now * 1000).toISOString(), hours, pool: pool.length, simulated, topics: MAIN, results: {} };
const lines = [];
for (const [who, user] of Object.entries(READERS)) {
  const w = await windows(db, user, topics, now, CONFIG, hours, pool);
  const all = w.flatMap((d) => d.list);
  const sizes = w.map((d) => d.stories);
  const byTopic = {};
  for (const s of all) byTopic[s.primary] = (byTopic[s.primary] ?? 0) + 1;
  out.results[who] = { digests: w.length, stories: all.length, per_digest: +(all.length / Math.max(1, w.length)).toFixed(1),
    min: Math.min(...sizes), max: Math.max(0, ...sizes), cut: w.reduce((a, d) => a + d.cut, 0), sizes, byTopic,
    chars_max: Math.max(0, ...w.map((d) => d.chars)), digests_detail: w.map((d) => ({ at: d.at, stories: d.stories, chars: d.chars, list: d.list })) };
  lines.push(`\n##### ${who}: ${all.length} stories in ${w.length} digests (${sizes.join(", ")}), ${out.results[who].cut} cut for length`);
  for (const d of w) {
    lines.push(`--- ${d.at}: ${d.stories} stories, ${d.chars} characters`);
    for (const s of d.list) lines.push(`  [${s.score}/t${s.topic ?? "-"}] ${s.primary} (main ${s.main ?? "none"}): ${s.headline}`);
  }
}
const dir = new URL("../../reports/data/step-19/", import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL(`replay-${name}.json`, dir), JSON.stringify(out, null, 1));
writeFileSync(new URL(`replay-${name}.txt`, dir), lines.join("\n") + "\n");
for (const [who, x] of Object.entries(out.results)) {
  console.log(`${who.padEnd(13)} ${x.per_digest}/digest (${x.min}-${x.max}, ${x.cut} cut, longest ${x.chars_max} chars) ${JSON.stringify(x.byTopic)}`);
}
console.log(`[pool ${pool.length} stories${simulate ? `, ${simulated} re-tagged tech_ai in memory` : ""}; reports/data/step-19/replay-${name}.{json,txt}]`);
