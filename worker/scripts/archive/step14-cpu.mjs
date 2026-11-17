// Step 14: CPU of the digest build on this PC (Node): one digest (40 candidates) in English and
// Russian, and one cron tick with 8 due readers, with the live layout. Run it on the last commit
// (before) and on this one (after: no Settings button). Stand-in data only, no I/O.
//   node scripts/step14-cpu.mjs
import { CONFIG, LAYOUT, planDigest } from "../../src/digest.js";
import { runTick } from "../../src/cron.js";
import { TOPIC_ROWS } from "../../test/helpers.mjs";

const NOW = 1_800_000_000 + 12 * 3600;
const TOPICS = TOPIC_ROWS.map(([tag, label_en, emoji, sort]) => ({ tag, label_en, emoji, sort, is_default: 1 }));
const words = "talks vote strike budget court minister summit deal rates election protest ceasefire".split(" ");
const cands = (n) => Array.from({ length: n }, (_, i) => ({
  id: 1000 + i, summary: `Story ${i}`, headline: `${words[i % 12]} ${words[(i * 7) % 12]} headline number ${i} with some length to it`,
  description: `${words[i % 12]} description sentence number ${i}. Another sentence with more words in it for realism.`,
  emojis: i % 5 ? "🇺🇸🤝" : null, best_url: `https://x.test/${i}`, best_source: "Outlet", importance: 6, final_score: 5 + (i % 4),
  topic_score: 7 + (i % 3), topics: JSON.stringify([TOPICS[i % 6].tag]), main_topic: TOPICS[i % 6].tag, updated_at: NOW - 600 - i,
  dup_group: null, tr_headline: `Заголовок новости номер ${i} с некоторой длиной`, tr_description: `Описание ${i}. Второе предложение.` }));

async function measure(name, fn, n = 2000) {
  for (let i = 0; i < 200; i++) await fn();
  const t0 = process.cpuUsage();
  for (let i = 0; i < n; i++) await fn();
  const t = process.cpuUsage(t0);
  const us = (t.user + t.system) / n;
  console.log(`${name}: ${us >= 1000 ? `${(us / 1000).toFixed(2)} ms` : `${us.toFixed(0)} microseconds`}`);
  return us;
}
const user = { id: 7, first_name: "Sam", timezone: "Asia/Yerevan", topics: JSON.stringify(TOPICS.map((t) => t.tag)),
  digest_times: '["09:00","14:00","20:00"]', last_digest_at: NOW - 6 * 3600, next_digest_at: NOW };
const pool = cands(40);
console.log(`live layout: ${LAYOUT.name}`);
for (const lang of ["en", "ru"]) {
  await measure(`planDigest, 40 candidates, ${lang}`, async () => planDigest({ ...user, lang }, pool, TOPICS, NOW, CONFIG), 5000);
}
const due = Array.from({ length: 8 }, (_, i) => ({ ...user, id: 100 + i, lang: i % 2 ? "ru" : "en" }));
const tickDb = { batch: async (st) => st.map((s) => {
  if (/FROM job_runs ORDER BY id DESC LIMIT 5/.test(s.sql)) return [{ id: 9, started_at: NOW - 600, finished_at: NOW - 500, status: "ok" }];
  if (/status IN \('ok', 'partial'\)/.test(s.sql)) return [{ started_at: NOW - 600 }];
  if (/^SELECT \* FROM users/.test(s.sql)) return due;
  if (/FROM topics/.test(s.sql)) return TOPICS;
  if (/FROM stories s/.test(s.sql) || /^\nSELECT id, summary/.test(s.sql)) return pool;
  return [];
}) };
const io = { send: async () => ({}), alert: async () => {}, appUrl: "https://x.test/app/" };
await measure(`cron tick: 8 due readers (live layout ${LAYOUT.name})`, () => runTick(tickDb, io, NOW), 1000);
