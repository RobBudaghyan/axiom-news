// Step 17: delete users and all their data from the command line, with the same statements as Admin's
// "Delete user" (src/account.js). Never the owner. Prints names only.
//   node scripts/delete-user.mjs --all-but-owner [--dry]     production (.env)
//   AXIOM_ENV=staging node scripts/delete-user.mjs <id> ...  staging
import { STAGING, d1Rest, loadEnv } from "./digest-cli.mjs";
import { deleteUserStatements } from "../src/account.js";

const env = loadEnv();
const db = d1Rest(env);
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const owner = String(env.OWNER_TELEGRAM_ID ?? "");
if (!owner) throw new Error("OWNER_TELEGRAM_ID missing");
const users = await db.query("SELECT id, first_name FROM users");
const ids = args.includes("--all-but-owner") ? users.map((u) => String(u.id)).filter((id) => id !== owner)
  : args.filter((a) => /^\d+$/.test(a));
if (ids.includes(owner)) throw new Error("refusing: never the owner");
const now = Math.floor(Date.now() / 1000);
for (const id of ids) {
  const u = users.find((x) => String(x.id) === id);
  if (!u) { console.log(`no user with that id`); continue; }
  if (!dry) await db.batch(deleteUserStatements(Number(id), now));
  console.log(`${dry ? "would delete" : "deleted"}: ${u.first_name || "(no name)"} (${STAGING ? "staging" : "production"})`);
}
const left = await db.query("SELECT first_name FROM users");
console.log(`users left: ${left.map((u) => u.first_name).join(", ")}`);
