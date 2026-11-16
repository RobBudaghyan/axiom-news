// Step 13: CPU of the custom-topic code on this PC (Node). The database, Telegram and the AI are
// stand-ins that answer at once with canned rows, so this is the Worker's own work (D1 and the AI
// run elsewhere and are not Worker CPU). Writes nothing anywhere.
//   node scripts/step13-cpu.mjs
import { CONFIG, planDigest } from "../src/digest.js";
import { runTick } from "../src/cron.js";
import { addTopic, asTopicRows, guardAlert, shapeCustomAdmin, validateAnswer, withCustomTopics } from "../src/custom.js";
import { TOPIC_ROWS } from "../test/helpers.mjs";

const NOW = 1_800_000_000 + 12 * 3600;
const TOPICS = TOPIC_ROWS.map(([tag, label_en, emoji, sort]) => ({ tag, label_en, emoji, sort, is_default: 1 }));
const names = (en, ru) => JSON.stringify({ en, ru, hy: en, fr: en });
const CUSTOM = [
  { id: 1, tag: "c1", names: names("Colombia", "Колумбия"), emoji: "🇨🇴", boost_max: 2 },
  { id: 2, tag: "c2", names: names("Formula 1", "Формула-1"), emoji: "🏎️", boost_max: 2 },
  { id: 3, tag: "c3", names: names("AI regulation", "Регулирование ИИ"), emoji: "🤖", boost_max: 1 },
];
const words = "talks vote strike budget court minister summit deal rates election protest ceasefire".split(" ");
function cands(n, withCustom) {
  return Array.from({ length: n }, (_, i) => {
    const tags = withCustom && i % 3 === 0 ? [CUSTOM[i % 3].tag] : [TOPICS[i % 6].tag];
    const main = tags[0];
    return { id: 1000 + i, summary: `Story ${i}`, headline: `${words[i % 12]} ${words[(i * 7) % 12]} headline number ${i} with some length to it`,
      description: `${words[i % 12]} description sentence number ${i}. Another sentence with more words in it for realism.`,
      emojis: "🗞️", best_url: `https://x.test/${i}`, best_source: "Outlet", importance: 6, final_score: 5 + (i % 4), topic_score: 7 + (i % 3),
      topics: JSON.stringify(tags), main_topic: main, updated_at: NOW - 600 - i, dup_group: null,
      tr_headline: `Заголовок ${i}`, tr_description: `Описание ${i}.` };
  });
}
async function measure(name, fn, n = 5000) {
  for (let i = 0; i < 200; i++) await fn();   // warm-up
  const t0 = process.cpuUsage();
  for (let i = 0; i < n; i++) await fn();
  const t = process.cpuUsage(t0);
  const us = ((t.user + t.system) / n);
  console.log(`${name}: ${us >= 1000 ? `${(us / 1000).toFixed(2)} ms` : `${us.toFixed(0)} microseconds`} each`);
  return us;
}

const user = { id: 7, first_name: "Sam", timezone: "Asia/Yerevan", topics: JSON.stringify(TOPICS.map((t) => t.tag)),
  digest_times: '["09:00","14:00","20:00"]', last_digest_at: NOW - 6 * 3600, next_digest_at: NOW, lang: "ru" };
const plain = cands(40, false), mixed = cands(40, true);
await measure("planDigest, 40 candidates, no custom topics (before Step 13)", async () => planDigest(user, plain, TOPICS, NOW, CONFIG), 2000);
await measure("planDigest, 40 candidates, 3 custom sections (Russian)", async () => {
  const u = withCustomTopics(user, CUSTOM);
  return planDigest(u, mixed, [...TOPICS, ...asTopicRows(CUSTOM)], NOW, CONFIG);
}, 2000);

// one cron tick: 8 due users, each with 3 custom topics (stand-in database)
const due = Array.from({ length: 8 }, (_, i) => ({ ...user, id: 100 + i }));
const tickDb = { batch: async (st) => st.map((s) => {
  if (/FROM job_runs ORDER BY id DESC LIMIT 5/.test(s.sql)) return [{ id: 9, started_at: NOW - 600, finished_at: NOW - 500, status: "ok" }];
  if (/status IN \('ok', 'partial'\)/.test(s.sql)) return [{ started_at: NOW - 600 }];
  if (/^SELECT \* FROM users/.test(s.sql)) return due;
  if (/FROM topics/.test(s.sql)) return TOPICS;
  if (/FROM custom_follows f\nJOIN custom_topics/.test(s.sql)) return due.flatMap((u) => CUSTOM.map((c) => ({ ...c, user_id: u.id })));
  if (/FROM stories s/.test(s.sql) || /^\nSELECT id, summary/.test(s.sql)) return mixed;
  return [];
}) };
const io = { send: async () => ({}), alert: async () => {}, appUrl: "https://x.test/app/" };
await measure("cron tick: 8 due readers with 3 custom topics each (plan + format)", () => runTick(tickDb, io, NOW), 300);
await measure("cron tick: 8 due readers, no custom topics", () => runTick({ batch: async (st) => (await tickDb.batch(st))
  .map((rows, i) => (/custom_follows/.test(st[i].sql) ? [] : /FROM stories s/.test(st[i].sql) ? plain : rows)) }, io, NOW), 300);

// adding a topic: everything except the network wait for the AI (stand-in answer)
const existing = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, tag: `c${i + 1}`, names: names(`Topic ${i}`, `Тема ${i}`), aliases: "[]" }));
const addDb = { batch: async (st) => st.map((s) => (/FROM custom_follows f/.test(s.sql) ? [] : /count\(\*\) AS n FROM topic_checks/.test(s.sql) ? [{ n: 1 }]
  : /FROM custom_topics WHERE tag IS NOT NULL/.test(s.sql) ? existing : /FROM ai_calls WHERE at/.test(s.sql) ? [{ model: "gemini-3.5-flash-lite", calls: 90, r429: 0, recent429: 0 }] : [])) };
const answer = validateAnswer({ verdict: "accept", reason_code: "ok", reason: "A good topic.", same_as: "",
  names: { en: "Colombia", ru: "Колумбия", hy: "Կոլումբիա", fr: "Colombie" }, emoji: "🇨🇴", definition: "News about Colombia.",
  queries: [{ q: "Colombia", ed: "en" }, { q: "Colombia Petro", ed: "es_co" }], boost_max: 2 }, "en");
const ask = async () => ({ answer, calls: [{ at: NOW, provider: "gemini", model: "m", ok: 1, input_tokens: 900, output_tokens: 150, ms: 1, error: null, code: null }] });
await measure("add a topic (60 existing topics, prompt, checks, writes; no AI wait)", () =>
  addTopic({ db: addDb, env: {}, user, lang: "en", now: NOW, isOwner: false, mainTopics: TOPICS, ask }, { name: "Colombia" }), 3000);
await measure("add a topic that joins an existing one (no AI call)", () =>
  addTopic({ db: addDb, env: {}, user, lang: "en", now: NOW, isOwner: false, mainTopics: TOPICS, ask }, { name: "Topic 59" }), 3000);

// Admin: 60 custom topics
const adminRows = [existing.map((e) => ({ ...e, queries: '[{"q":"a","ed":"en"},{"q":"b","ed":"en"}]', followers: 2, active: 2, searches: 12, fetched: 300 })),
  existing.map((e) => ({ tag: e.tag, stories: 5, main: 2 })), existing.map((e) => ({ tag: e.tag, sent: 3 })), [{ outcome: "accepted", n: 4 }],
  Array.from({ length: 10 }, () => ({ at: NOW, input: "x", outcome: "rejected", reason: "r", first_name: "A" })), [],
  [{ model: "gemini-3.5-flash-lite", calls: 120, r429: 0, recent429: 0 }], []];
await measure("Admin shaping, 60 custom topics", async () => shapeCustomAdmin(adminRows, NOW), 3000);
await measure("AI guard alert check (hourly tick)", async () => guardAlert([{ model: "gemini-3.5-flash-lite", calls: 120, r429: 0, recent429: 0 }], [], NOW), 20000);
