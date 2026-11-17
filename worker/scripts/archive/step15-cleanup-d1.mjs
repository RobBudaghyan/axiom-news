// Step 15, part 5, run once: removes test data and the Step 6 shadow tables from the live D1.
// Kept: real users, their settings and custom topics (the owner's Australia, TRIPP Armenia, Finance),
// the owner's own feedback, all news data. Deleted:
//   - custom topics nobody follows any more (Japan, the owner's test topic) and their day counts;
//   - topic-check rows for topics that no longer exist (the owner's Japan and Georgia trials);
//   - tips, `sent` and holds of users that do not exist (previews and test rows; none expected);
//   - the tables shadow_items and shadow_runs (DROP).
//   node scripts/step15-cleanup-d1.mjs --dry    list what would go
//   node scripts/step15-cleanup-d1.mjs          delete it
import { d1Rest, loadEnv } from "../digest-cli.mjs";

const dry = process.argv.includes("--dry");
const db = d1Rest(loadEnv());
const LIST = [
  ["custom topics with no follower", "SELECT id, tag, json_extract(names, '$.en') AS name FROM custom_topics WHERE id NOT IN (SELECT topic_id FROM custom_follows)",
    ["DELETE FROM custom_topic_days WHERE topic_id NOT IN (SELECT topic_id FROM custom_follows)",
     "DELETE FROM custom_topics WHERE id NOT IN (SELECT topic_id FROM custom_follows)"]],
  ["topic checks of topics that no longer exist", "SELECT input, outcome FROM topic_checks WHERE topic_id IS NOT NULL AND topic_id NOT IN (SELECT id FROM custom_topics) " +
    "OR (topic_id IS NULL AND outcome IN ('accepted', 'joined'))",
    ["DELETE FROM topic_checks WHERE (topic_id IS NOT NULL AND topic_id NOT IN (SELECT id FROM custom_topics)) OR (topic_id IS NULL AND outcome IN ('accepted', 'joined'))"]],
  ["tips of unknown users", "SELECT id, amount FROM tips WHERE user_id NOT IN (SELECT id FROM users)", ["DELETE FROM tips WHERE user_id NOT IN (SELECT id FROM users)"]],
  ["sent rows of unknown users (previews)", "SELECT user_id, count(*) AS n FROM sent WHERE user_id NOT IN (SELECT id FROM users) GROUP BY user_id",
    ["DELETE FROM sent WHERE user_id NOT IN (SELECT id FROM users)"]],
  ["holds of unknown users", "SELECT user_id, count(*) AS n FROM digest_holds WHERE user_id NOT IN (SELECT id FROM users) GROUP BY user_id",
    ["DELETE FROM digest_holds WHERE user_id NOT IN (SELECT id FROM users)"]],
  ["shadow_items (Step 6)", "SELECT count(*) AS n FROM shadow_items", ["DROP TABLE IF EXISTS shadow_items"]],
  ["shadow_runs (Step 6)", "SELECT count(*) AS n FROM shadow_runs", ["DROP TABLE IF EXISTS shadow_runs"]],
];
const writes = [];
for (const [label, sql, del] of LIST) {
  let rows;
  try { rows = await db.query(sql); } catch (e) { console.log(`${label}: ${e.message.slice(0, 80)}`); continue; }
  console.log(`${label}: ${JSON.stringify(rows)}`);
  writes.push(...del.map((s) => ({ sql: s, params: [] })));
}
if (dry) console.log("[dry run: nothing deleted]");
else {
  await db.batch(writes);
  console.log("[deleted]");
}
