// Step 15, run once after deploying: "Politics" and "Wars & Conflicts" become one main topic,
// "Politics & Conflicts" (politics_conflicts), and "Economy & Markets" (economy_markets) is new.
//   - users.topics: politics or wars_conflicts -> politics_conflicts; every existing user also gets
//     economy_markets (owner); the list is put in the official order.
//   - stories.topics and stories.main_topic: the two old tags -> politics_conflicts.
//   - the topics table: the six rows of config/topics.yaml (the hourly job's sync_topics does the
//     same on its next run; doing it here means the Mini App never sees a missing topic).
// Safe to run again: rows already migrated are skipped. Uses the live D1 (REST, credentials from
// ../.env). Prints what it changed; never prints secrets.
//
//   node scripts/migrate-topics.mjs --dry     show what would change
//   node scripts/migrate-topics.mjs           change it
import { pathToFileURL } from "node:url";

export const OLD = { politics: "politics_conflicts", wars_conflicts: "politics_conflicts" };
export const ORDER = ["politics_conflicts", "economy_markets", "armenia", "russia", "iran_war", "ukraine_war"];
export const NEW_TOPIC = "economy_markets";

const parse = (v) => {
  try {
    const x = JSON.parse(v ?? "[]");
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
};

// A user's main topics after the merge: every old follow maps to a new one (nobody loses a topic),
// plus Economy & Markets; other tags (none today) are kept at the end.
export function migrateUserTopics(list) {
  const out = new Set(list.map((t) => OLD[t] ?? t));
  out.add(NEW_TOPIC);
  return [...ORDER.filter((t) => out.has(t)), ...[...out].filter((t) => !ORDER.includes(t))];
}

// A story's tags after the merge (order kept, duplicates dropped) and its main topic.
export function migrateStory(tags, main) {
  const out = [];
  for (const t of tags) {
    const n = OLD[t] ?? t;
    if (!out.includes(n)) out.push(n);
  }
  return { tags: out, main: main == null ? main : OLD[main] ?? main };
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
  const { readFileSync } = await import("node:fs");
  const { d1Rest, loadEnv } = await import("./digest-cli.mjs");
  const dry = process.argv.includes("--dry");
  const db = d1Rest(loadEnv());
  const yaml = readTopicsYaml(readFileSync(new URL("../../config/topics.yaml", import.meta.url), "utf8"));
  if (JSON.stringify(yaml.map((t) => t.tag)) !== JSON.stringify(ORDER)) throw new Error("config/topics.yaml is not the Step 15 list");
  const writes = [];
  const rows = topicRows(yaml);
  for (const r of rows) {
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
    console.log(`user ${u.id}: ${before.join(", ") || "(none)"} -> ${after.join(", ")}`);
    writes.push({ sql: "UPDATE users SET topics = ?1 WHERE id = ?2", params: [JSON.stringify(after), u.id] });
  }

  const stories = await db.query("SELECT id, topics, main_topic FROM stories WHERE topics LIKE '%politics\"%' " +
    "OR topics LIKE '%wars_conflicts%' OR main_topic IN ('politics', 'wars_conflicts')");
  for (const s of stories) {
    const m = migrateStory(parse(s.topics), s.main_topic);
    writes.push({ sql: "UPDATE stories SET topics = ?1, main_topic = ?2 WHERE id = ?3", params: [JSON.stringify(m.tags), m.main, s.id] });
  }
  console.log(`${changedUsers} of ${users.length} users change; ${stories.length} stories re-tagged; topics table: ${ORDER.join(", ")}`);
  if (dry) {
    console.log("[dry run: nothing written]");
    return;
  }
  for (let i = 0; i < writes.length; i += 50) await db.batch(writes.slice(i, i + 50));
  const left = await db.query("SELECT count(*) AS n FROM stories WHERE topics LIKE '%wars_conflicts%' OR topics LIKE '%\"politics\"%' " +
    "OR main_topic IN ('politics', 'wars_conflicts')");
  const tags = await db.query("SELECT tag FROM topics ORDER BY sort");
  console.log(`[written; stories still on old tags: ${left[0]?.n}; topics table: ${tags.map((t) => t.tag).join(", ")}]`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
