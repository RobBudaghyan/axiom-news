// Step 16 (load test): every cron tick runs in a fresh Worker, and V8 compiles a function the first
// time it runs, so the first digest of a tick paid for compiling all the digest code (a tick with 4
// readers used 15 ms of CPU against the 10 ms limit, one with nobody due 4 ms). Building one small
// made-up digest here, at the top level, does that work while the Worker starts (Cloudflare's
// separate start-up allowance) instead of inside the tick. Pure: no I/O, no clock, nothing sent or
// stored; any error is ignored, so it can never stop the Worker from starting.
import { CONFIG, candidateStatement, nextSlot, planDigest } from "./digest.js";
import { allTopicsOff, digestWrites } from "./cron.js";
import { asTopicRows, withCustomTopics } from "./custom.js";
import { assessHealth } from "./health.js";
import { errorStatement, usageStatement } from "./db.js";

const T = 1_800_000_000;
const TOPICS = [
  { tag: "armenia", label_en: "Armenia", emoji: "🇦🇲", sort: 1, is_default: 1 },
  { tag: "politics_conflicts", label_en: "Politics & Conflicts", emoji: "🏛️", sort: 2, is_default: 1 },
  { tag: "c1", label_en: "Japan", emoji: "🇯🇵", sort: 99, is_default: 0, custom: true, names: '{"en":"Japan","ru":"Япония"}' },
];
const story = (i, topic, extra = {}) => ({
  id: i, summary: `Warm-up story ${i}`, headline: `Warm-up headline number ${i} about talks`, description: `Text ${i}. More text.`,
  emojis: i % 2 ? "🇦🇲🤝" : null, best_url: `https://example.invalid/${i}`, best_source: "Outlet", importance: 7, final_score: 7,
  topic_score: 8, topics: JSON.stringify([topic]), main_topic: topic, updated_at: T - 600, scored_at: T - 600, dup_group: null,
  tr_headline: `Заголовок ${i}`, tr_description: `Текст ${i}.`, ...extra,
});

export function warmUp() {
  try {
    const user = { id: 1, first_name: "Warm", timezone: "Asia/Yerevan", topics: '["armenia","politics_conflicts","c1"]',
      digest_times: '["09:00","14:00","20:00"]', last_digest_at: T - 6 * 3600, next_digest_at: T, lang: "en" };
    const cands = [story(1, "armenia"), story(2, "politics_conflicts"), story(3, "c1"), story(4, "armenia", { emojis: null })];
    // the rest of a cron tick, in the same order: custom topics, the candidate query, the plan, the writes, health
    const follows = [{ user_id: 1, id: 1, tag: "c1", names: '{"en":"Japan","ru":"Япония"}', emoji: "🇯🇵", boost_max: 1, enabled: 1 }];
    const u = withCustomTopics(user, follows);
    allTopicsOff(user, follows);
    const topics = [...TOPICS.slice(0, 2), ...asTopicRows(follows)];
    for (const lang of ["en", "ru"]) {
      candidateStatement({ ...u, lang }, T, CONFIG);
      const plan = planDigest({ ...u, lang }, cands, topics, T, CONFIG);
      digestWrites(user, plan, plan.storyIds, T);
    }
    assessHealth({ runs: [{ id: 9, started_at: T - 600, finished_at: T - 500, status: "ok" }], lastOk: [{ started_at: T - 600 }], meta: [] }, T, "Asia/Yerevan");
    usageStatement({ r: 1, w: 1 }, T);
    errorStatement("warm-up", T);
    planDigest(user, [], TOPICS, T, CONFIG);   // the quiet note
    nextSlot(T, "Asia/Yerevan", ["09:00", "14:00", "20:00"]);
    return true;
  } catch {
    return false;
  }
}

warmUp();
