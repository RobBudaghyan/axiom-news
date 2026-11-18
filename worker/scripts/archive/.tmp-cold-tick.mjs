// Step 15: CPU of the new Worker paths on this PC (Node), stand-in data only, no I/O:
// the digest build and a normal cron tick (as Step 14), /start for a new user (the welcome), the
// setup's sample digest (POST /api/onboard), a feedback message, a tick with 8 reminders, and a
// tick with an announcement batch of 25.
//   node scripts/step15-cpu.mjs
import { CONFIG, LAYOUT, planDigest } from "../../src/digest.js";
import { runTick } from "../../src/cron.js";
import { handleUpdate } from "../../src/bot.js";
import { onboard } from "../../src/onboard.js";
import { sendFeedback } from "../../src/feedback.js";
import { runAnnouncementBatch } from "../../src/announce.js";
import { TOPIC_ROWS } from "../../test/helpers.mjs";

const NOW = 1_800_000_000 + 12 * 3600;   // 12:00 UTC = 16:00 in Yerevan (reminder hours)
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
  digest_times: '["09:00","14:00","20:00"]', last_digest_at: NOW - 6 * 3600, next_digest_at: NOW, lang: "en" };
const pool = cands(40);
const due = Array.from({ length: 8 }, (_, i) => ({ ...user, id: 100 + i, lang: i % 2 ? "ru" : "en" }));
const reminders = Array.from({ length: 8 }, (_, i) => ({ id: 200 + i, first_name: "Nora", lang: i % 2 ? "ru" : "en", timezone: "Asia/Yerevan",
  digest_times: '["09:00","14:00","20:00"]' }));
const targets = Array.from({ length: 25 }, (_, i) => ({ id: 300 + i, lang: i % 2 ? "ru" : "en" }));
const ann = [{ id: 1, audience: "all", texts: JSON.stringify({ en: "New: Economy & Markets. ".repeat(10), ru: "Новое: Экономика и рынки. ".repeat(10) }) }];

const stubDb = (opts = {}) => ({ batch: async (st) => st.map((s) => {
  if (/FROM job_runs ORDER BY id DESC LIMIT 5/.test(s.sql)) return [{ id: 9, started_at: NOW - 600, finished_at: NOW - 500, status: "ok" }];
  if (/status IN \('ok', 'partial'\)/.test(s.sql)) return [{ started_at: NOW - 600 }];
  if (/WHERE opened_at IS NULL/.test(s.sql)) return opts.reminders ?? [];
  if (/FROM announcements WHERE status = 'sending'/.test(s.sql)) return opts.ann ?? [];
  if (/FROM users u WHERE u.blocked = 0/.test(s.sql)) return targets;
  if (/RETURNING/.test(s.sql)) return [{ id: s.params[0], user_id: s.params[1] }];
  if (/^SELECT \* FROM users WHERE id/.test(s.sql)) return opts.one ? [opts.one] : [];
  if (/^SELECT \* FROM users/.test(s.sql)) return opts.due ?? due;
  if (/FROM topics/.test(s.sql)) return TOPICS;
  if (/FROM stories s/.test(s.sql) || /^\nSELECT id, summary/.test(s.sql)) return pool;
  if (/count\(\*\) AS n FROM feedback/.test(s.sql)) return [{ n: 2 }];
  if (/SELECT first_name FROM users/.test(s.sql)) return [{ first_name: "Ani" }];
  return [];
}) });
const io = { send: async () => ({}), alert: async () => {}, appUrl: "https://x.test/app/" };


const N = Number(process.argv[2] ?? 8);
const dueN = Array.from({ length: N }, (_, i) => ({ ...user, id: 100 + i, lang: i % 2 ? "ru" : "en" }));
const h0 = process.hrtime.bigint();
await runTick(stubDb({ due: dueN }), io, NOW);
const c1 = Number(process.hrtime.bigint() - h0) / 1e6;
const h2 = process.hrtime.bigint();
await runTick(stubDb({ due: dueN }), io, NOW);
const c2 = Number(process.hrtime.bigint() - h2) / 1e6;
console.log(JSON.stringify({ readers: N, first_tick_ms: c1.toFixed(1), second_tick_ms: c2.toFixed(1) }));
