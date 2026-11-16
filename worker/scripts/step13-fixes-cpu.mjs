// Step 13 fixes: CPU of the Mini App endpoints with custom topics (open, the new switch, remove,
// a settings save) and of a digest build with custom sections under the new custom-topic rule, on
// this PC (Node). The whole Worker request is run (initData check, routing, SQL building, state),
// but the database is a stand-in that answers at once with canned rows: D1 runs outside the Worker
// and is not Worker CPU. Writes nothing anywhere.
//   node scripts/step13-fixes-cpu.mjs
import worker from "../src/index.js";
import { signInitData } from "../src/auth.js";
import { CONFIG, planDigest } from "../src/digest.js";
import { asTopicRows, withCustomTopics } from "../src/custom.js";
import { TOPIC_ROWS } from "../test/helpers.mjs";

const TOKEN = "123456:TEST-token-for-the-cpu-check";
const NOW = Math.floor(Date.now() / 1000);
const TOPICS = TOPIC_ROWS.map(([tag, label_en, emoji, sort]) => ({ tag, label_en, emoji, sort, is_default: 1 }));
const names = (en, ru) => JSON.stringify({ en, ru, hy: en, fr: en });
const CUSTOM = [
  { id: 1, tag: "c1", names: names("Japan", "Япония"), emoji: "🇯🇵", boost_max: 2, enabled: 1 },
  { id: 2, tag: "c2", names: names("Colombia", "Колумбия"), emoji: "🇨🇴", boost_max: 2, enabled: 0 },
  { id: 3, tag: "c3", names: names("Formula 1", "Формула-1"), emoji: "🏎️", boost_max: 2, enabled: 1 },
];
const USER = { id: 7, first_name: "Sam", language: "ru", lang: "ru", timezone: "Asia/Yerevan", tz_detected: 1,
  topics: JSON.stringify(["politics", "armenia"]), digest_times: '["09:00","14:00","20:00"]', paused: 0, blocked: 0,
  created_at: NOW - 86400, last_digest_at: NOW - 6 * 3600, next_digest_at: NOW + 3600 };
const rowsFor = (sql) => (/^SELECT \* FROM users WHERE id/.test(sql) ? [USER] : /FROM topics/.test(sql) ? TOPICS
  : /FROM custom_follows f\nJOIN custom_topics/.test(sql) ? CUSTOM : []);
const stmt = (sql, params = []) => ({ sql, params, bind: (...p) => stmt(sql, p), all: async () => ({ results: rowsFor(sql), meta: {} }) });
const DB = { prepare: (sql) => stmt(sql), batch: async (list) => list.map((s) => ({ results: rowsFor(s.sql), meta: {} })) };
const env = { DB, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: "s".repeat(40), OWNER_TELEGRAM_ID: "42" };
const init = await signInitData({ query_id: "AAE1", auth_date: String(NOW), signature: "sig",
  user: JSON.stringify({ id: 7, first_name: "Sam", language_code: "ru" }) }, TOKEN);
const req = (path, body) => new Request(`https://w.test${path}`, { method: "POST", headers: { authorization: `tma ${init}`,
  "content-type": "application/json" }, body: JSON.stringify(body) });

async function measure(name, fn, n = 3000) {
  for (let i = 0; i < 200; i++) await fn();   // warm-up
  const t0 = process.cpuUsage();
  for (let i = 0; i < n; i++) await fn();
  const t = process.cpuUsage(t0);
  const us = (t.user + t.system) / n;
  console.log(`${name}: ${us >= 1000 ? `${(us / 1000).toFixed(2)} ms` : `${us.toFixed(0)} microseconds`} each`);
}
const ok = async (path, body) => { const r = await worker.fetch(req(path, body), env); if (r.status !== 200) throw new Error(`${path} ${r.status}`); await r.text(); };

await measure("POST /api/open (3 custom topics, one off; Russian)", () => ok("/api/open", { tz: "Asia/Yerevan" }));
await measure("POST /api/topics/switch (off)", () => ok("/api/topics/switch", { id: 1, on: false }));
await measure("POST /api/topics/switch (on)", () => ok("/api/topics/switch", { id: 2, on: true }));
await measure("POST /api/topics/remove (edit mode)", () => ok("/api/topics/remove", { id: 3 }));
await measure("POST /api/settings (a time)", () => ok("/api/settings", { digest_times: ["09:00", "20:00"] }));

// a digest with custom sections under the Step 13 fixes rule (no cap, topic score as it is)
const words = "talks vote strike budget court minister summit deal rates election protest ceasefire".split(" ");
const cands = Array.from({ length: 40 }, (_, i) => {
  const tag = i % 3 === 0 ? CUSTOM[i % 2 ? 2 : 0].tag : TOPICS[i % 6].tag;
  return { id: 1000 + i, summary: `Story ${i}`, headline: `${words[i % 12]} ${words[(i * 7) % 12]} headline number ${i} with some length`,
    description: `${words[i % 12]} description ${i}. Another sentence with more words in it.`, emojis: "🗞️", best_url: `https://x.test/${i}`,
    best_source: "Outlet", importance: 6, final_score: tag.startsWith("c") ? 1 + (i % 4) : 5 + (i % 4), topic_score: 6 + (i % 3),
    topics: JSON.stringify([tag]), main_topic: tag, updated_at: NOW - 600 - i, dup_group: null, tr_headline: `Заголовок ${i}`, tr_description: `Описание ${i}.` };
});
const u = withCustomTopics({ ...USER, topics: JSON.stringify(TOPICS.map((t) => t.tag)) }, CUSTOM);
const plan = planDigest(u, cands, [...TOPICS, ...asTopicRows(CUSTOM.filter((c) => c.enabled))], NOW, CONFIG);
console.log(`(digest: ${plan.storyIds.length} stories, ${plan.text.length} characters)`);
await measure("planDigest, 40 candidates, 2 custom sections (Russian, new rule)", async () =>
  planDigest(u, cands, [...TOPICS, ...asTopicRows(CUSTOM.filter((c) => c.enabled))], NOW, CONFIG), 3000);
