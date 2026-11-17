// Step 5, run once after deploying: digest times are now on the hour (06:00-23:00), so every user's
// older half-hour times move to the nearest hour (08:30 -> 09:00; roundTimes in src/settings.js),
// and their next digest is recomputed. Safe to run again: users already on the hour are skipped.
// Uses the live D1 (REST, credentials from ../.env). Prints what it changed; never prints secrets.
//
//   node scripts/migrate-times.mjs --dry     show what would change
//   node scripts/migrate-times.mjs           change it
import { CONFIG, nextSlot, parseList } from "../../src/digest.js";
import { roundTimes } from "../../src/settings.js";
import { d1Rest, loadEnv } from "../digest-cli.mjs";

const dry = process.argv.includes("--dry");
const db = d1Rest(loadEnv());
const now = Math.floor(Date.now() / 1000);
const users = await db.query("SELECT id, timezone, digest_times, next_digest_at FROM users");
const writes = [];
for (const u of users) {
  const before = parseList(u.digest_times, CONFIG.default_times);
  const after = roundTimes(before);
  if (JSON.stringify(before) === JSON.stringify(after)) continue;
  const next = nextSlot(now, u.timezone || CONFIG.default_timezone, after);
  console.log(`user ${u.id}: ${before.join(", ")} -> ${after.join(", ")}; next digest ${new Date(next * 1000).toISOString()}`);
  writes.push({ sql: "UPDATE users SET digest_times = ?1, next_digest_at = ?2 WHERE id = ?3",
                params: [JSON.stringify(after), next, u.id] });
}
if (!writes.length) console.log(`${users.length} users checked: all times already on the hour, nothing to do`);
else if (dry) console.log(`[dry run: ${writes.length} of ${users.length} users would change]`);
else {
  await db.batch(writes);
  console.log(`[updated ${writes.length} of ${users.length} users]`);
}
