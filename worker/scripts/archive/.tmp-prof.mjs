import { planDigest, CONFIG } from "../../src/digest.js";
import { TOPIC_ROWS } from "../../test/helpers.mjs";
const NOW = 1_800_000_000 + 12 * 3600;
const TOPICS = TOPIC_ROWS.map(([tag, label_en, emoji, sort]) => ({ tag, label_en, emoji, sort, is_default: 1 }));
const words = "talks vote strike budget court minister summit deal rates election protest ceasefire".split(" ");
const cands = Array.from({ length: 60 }, (_, i) => ({
  id: 1000 + i, summary: `Story ${i}`, headline: `${words[i % 12]} ${words[(i * 7) % 12]} headline number ${i} with some length to it and more words`,
  description: `${words[i % 12]} description sentence number ${i}. Another sentence with more words in it for realism, about the same length as the real ones.`,
  emojis: "🇺🇸🤝", best_url: `https://x.test/${i}`, best_source: "Outlet", importance: 6, final_score: 5 + (i % 4),
  topic_score: 7 + (i % 3), topics: JSON.stringify([TOPICS[i % 6].tag]), main_topic: TOPICS[i % 6].tag, updated_at: NOW - 600 - i,
  dup_group: null, tr_headline: `Заголовок новости номер ${i} с некоторой длиной и ещё словами`, tr_description: `Описание ${i}. Второе предложение примерно такой же длины, как настоящие.` }));
const user = { id: 7, first_name: "Sam", timezone: "Asia/Yerevan", topics: JSON.stringify(TOPICS.map((t) => t.tag)),
  digest_times: '["09:00","14:00","20:00"]', last_digest_at: NOW - 6 * 3600, next_digest_at: NOW, lang: "ru" };
for (let i = 0; i < 3000; i++) planDigest(user, cands, TOPICS, NOW, CONFIG);
const t0 = process.hrtime.bigint(); for (let i = 0; i < 1000; i++) planDigest(user, cands, TOPICS, NOW, CONFIG);
console.log("warm planDigest, 60 candidates, ru:", (Number(process.hrtime.bigint() - t0) / 1e6 / 1000).toFixed(3), "ms");
