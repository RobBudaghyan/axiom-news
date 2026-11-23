// Step 19 (owner), run once after deploying: "Russia" is no longer a main topic and "Technology & AI"
// (tech_ai) is new.
//   - users.topics: russia removed; every existing user gets tech_ai (as with Economy & Markets in
//     Step 15); the list is put in the official order, custom tags kept at the end.
//   - stories.topics: russia removed (a story left with no tag gets politics_conflicts);
//     stories.main_topic russia -> the most specific main topic the story still has
//     (config/digest.json topic_specificity), else politics_conflicts. The topic score needs no
//     change: digests cap the boost by the new main topic (digest.js topicScore).
//   - the topics table: the six rows of config/topics.yaml (the hourly job's sync_topics does the
//     same on its next run; doing it here means the Mini App never sees a missing topic).
// Safe to run again: rows already migrated are skipped. Uses the live D1 (REST, credentials from
// ../.env, ../.env.staging on top with AXIOM_ENV=staging). Prints counts; never prints secrets.
//
//   AXIOM_ENV=staging node scripts/migrate-step19.mjs --dry    show what would change on staging
//   AXIOM_ENV=staging node scripts/migrate-step19.mjs          change staging
//   node scripts/migrate-step19.mjs                            production, after "ship it"
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import CONFIG from "../../config/digest.json" with { type: "json" };

export const REMOVED = "russia";
export const NEW_TOPIC = "tech_ai";
export const ORDER = ["politics_conflicts", "economy_markets", "tech_ai", "armenia", "iran_war", "ukraine_war"];
export const FALLBACK = "politics_conflicts";

const parse = (v) => {
  try {
    const x = JSON.parse(v ?? "[]");
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
};

// A user's main topics after Step 19: russia gone, tech_ai added, official order, custom tags last.
export function migrateUserTopics(list) {
  const out = new Set(list.filter((t) => t !== REMOVED));
  out.add(NEW_TOPIC);
  return [...ORDER.filter((t) => out.has(t)), ...[...out].filter((t) => !ORDER.includes(t))];
}

// A story's tags and main topic after Step 19 (order kept).
export function migrateStory(tags, main, specificity = CONFIG.topic_specificity) {
  let out = tags.filter((t, i) => t !== REMOVED && tags.indexOf(t) === i);
  if (!out.some((t) => ORDER.includes(t)) && (main === REMOVED || !out.length)) out = [FALLBACK, ...out];
  if (main !== REMOVED) return { tags: out, main };
  const best = specificity.find((t) => out.includes(t)) ?? FALLBACK;
  return { tags: out, main: best };
}

export function topicRows(yamlTopics) {
  return yamlTopics.map((t, n) => [t.tag, t.label.en, t.label.ru ?? null, t.emoji ?? null, n, t.default ? 1 : 0]);
}

// Reads the six topics from config/topics.yaml with no YAML library (the file's own simple layout).
export function readTopicsYaml(text) {
  const out = [];
  for (const block of text.split(/\n  - tag: /).slice(1)) {
    const tag = block.split("\n")[0].trim();
    const en = block.match(/en: "([^"]+)"/)?.[1];
    const ru = block.match(/ru: "([^"]+)"/)?.[1];
    const emoji = block.match(/emoji: "([^"]+)"/)?.[1];
    const def = /default: true/.test(block);
    out.push({ tag, label: { en, ru }, emoji, default: def });
  }
  return out;
}

async function main() {
  const { d1Rest, loadEnv, STAGING } = await import("./digest-cli.mjs");
  const dry = process.argv.includes("--dry");
  const db = d1Rest(loadEnv());
  console.log(`database: ${STAGING ? "STAGING" : "PRODUCTION"}`);
  const yaml = readTopicsYaml(readFileSync(new URL("../../config/topics.yaml", import.meta.url), "utf8"));
  if (JSON.stringify(yaml.map((t) => t.tag)) !== JSON.stringify(ORDER)) throw new Error("config/topics.yaml is not the Step 19 list");
  const writes = [];
  for (const r of topicRows(yaml)) {
    writes.push({ sql: "INSERT INTO topics (tag, label_en, label_ru, emoji, sort, is_default) VALUES (?1,?2,?3,?4,?5,?6) " +
      "ON CONFLICT(tag) DO UPDATE SET label_en=excluded.label_en, label_ru=excluded.label_ru, emoji=excluded.emoji, " +
      "sort=excluded.sort, is_default=excluded.is_default", params: r });
  }
  writes.push({ sql: `DELETE FROM topics WHERE tag NOT IN (${ORDER.map((_, i) => `?${i + 1}`).join(",")})`, params: ORDER });

  const users = await db.query("SELECT id, topics FROM users");
  let changedUsers = 0;
  for (const u of users) {
    const before = parse(u.topics);
    const after = migrateUserTopics(before);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    changedUsers++;
    writes.push({ sql: "UPDATE users SET topics = ?1 WHERE id = ?2", params: [JSON.stringify(after), u.id] });
  }

  const stories = await db.query("SELECT id, topics, main_topic FROM stories WHERE topics LIKE '%\"russia\"%' OR main_topic = 'russia'");
  const moved = {};
  for (const s of stories) {
    const m = migrateStory(parse(s.topics), s.main_topic);
    if (s.main_topic === REMOVED) moved[m.main] = (moved[m.main] ?? 0) + 1;
    writes.push({ sql: "UPDATE stories SET topics = ?1, main_topic = ?2 WHERE id = ?3", params: [JSON.stringify(m.tags), m.main, s.id] });
  }
  console.log(`${changedUsers} of ${users.length} users change; ${stories.length} stories re-tagged; ` +
    `former Russia main topic now: ${JSON.stringify(moved)}; topics table: ${ORDER.join(", ")}`);
  if (dry) {
    console.log("[dry run: nothing written]");
    return;
  }
  for (let i = 0; i < writes.length; i += 50) await db.batch(writes.slice(i, i + 50));
  const left = await db.query("SELECT count(*) AS n FROM stories WHERE topics LIKE '%\"russia\"%' OR main_topic = 'russia'");
  const leftUsers = await db.query("SELECT count(*) AS n FROM users WHERE topics LIKE '%\"russia\"%'");
  const tags = await db.query("SELECT tag FROM topics ORDER BY sort");
  console.log(`[written; stories still on russia: ${left[0]?.n}; users: ${leftUsers[0]?.n}; topics table: ${tags.map((t) => t.tag).join(", ")}]`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
