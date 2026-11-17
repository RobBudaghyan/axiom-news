// Step 16, run once after deploying: Pause is gone (owner). A user who is paused today keeps their
// topics in the list but with every one switched off, so nothing changes for them: no digests and no
// quiet notes (the cron skips a user with every topic off).
//   - users.topics -> [] (main topics off), every custom_follows row of theirs -> enabled = 0,
//     users.paused -> 0 (the column stays, unused, like max_stories).
// Safe to run again: only rows with paused = 1 are touched. Uses the D1 named in ../.env (REST);
// prints what it changed, never secrets.
//
//   node scripts/migrate-pause.mjs --dry     show what would change
//   node scripts/migrate-pause.mjs           change it
import { pathToFileURL } from "node:url";

// The writes for one paused user.
export function pauseStatements(userId) {
  return [
    { sql: "UPDATE users SET topics = '[]', paused = 0 WHERE id = ?1 AND paused = 1", params: [userId] },
    { sql: "UPDATE custom_follows SET enabled = 0 WHERE user_id = ?1", params: [userId] },
  ];
}

async function main() {
  const { d1Rest, loadEnv } = await import("./digest-cli.mjs");
  const dry = process.argv.includes("--dry");
  const db = d1Rest(loadEnv());
  const users = await db.query("SELECT id, topics FROM users WHERE paused = 1");
  const writes = [];
  for (const u of users) {
    const custom = await db.query("SELECT count(*) AS n FROM custom_follows WHERE user_id = ?1 AND enabled = 1", [u.id]);
    console.log(`user ${u.id}: paused; main topics ${u.topics} -> [], ${custom[0]?.n ?? 0} custom switched off`);
    writes.push(...pauseStatements(u.id));
  }
  console.log(`${users.length} paused users`);
  if (dry || !writes.length) {
    if (dry) console.log("[dry run: nothing written]");
    return;
  }
  await db.batch(writes);
  const left = await db.query("SELECT count(*) AS n FROM users WHERE paused = 1");
  console.log(`[written; users still paused: ${left[0]?.n}]`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
