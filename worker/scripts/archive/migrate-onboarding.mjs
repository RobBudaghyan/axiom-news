// Step 15, run once after deploying the welcome flow: every user who exists today has already set
// things up, so they are marked onboarded and opened (no setup, no reminder). Safe to run again.
//   node scripts/migrate-onboarding.mjs --dry
//   node scripts/migrate-onboarding.mjs
import { d1Rest, loadEnv } from "../digest-cli.mjs";

const dry = process.argv.includes("--dry");
const db = d1Rest(loadEnv());
const [n] = await db.query("SELECT count(*) AS n FROM users WHERE onboarded_at IS NULL OR opened_at IS NULL");
console.log(`${n.n} users to mark as onboarded and opened (their created_at)`);
if (!dry && n.n) {
  await db.batch([{ sql: "UPDATE users SET onboarded_at = coalesce(onboarded_at, created_at), opened_at = coalesce(opened_at, created_at) " +
    "WHERE onboarded_at IS NULL OR opened_at IS NULL", params: [] }]);
  const [left] = await db.query("SELECT count(*) AS n FROM users WHERE onboarded_at IS NULL OR opened_at IS NULL");
  console.log(`[done; left: ${left.n}]`);
} else console.log(dry ? "[dry run: nothing written]" : "[nothing to do]");
