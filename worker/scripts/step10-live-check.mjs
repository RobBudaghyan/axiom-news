// Step 10: live checks of the tips path that cost nothing (no Stars are paid). Token and owner id
// come from ../.env and are never printed. Writes nothing to the database.
//  1. a stranger cannot use the refund route or see Admin (403);
//  2. the owner's refund of a tip id that does not exist stops at 404, before Telegram;
//  3. Admin answers with the Tips section;
//  4. Telegram's refundStarPayment answers a made-up charge id with an error (the method and
//     parameters are right; no real charge exists to refund);
//  5. Step 11: the old 1-Star test amount is refused for everyone, the owner too; 100 gives an
//     invoice link (invoice links only, nothing is paid).
//   node scripts/step10-live-check.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./digest-cli.mjs";
import { signInitData } from "../src/auth.js";
import { tgCall } from "../src/telegram.js";

const toml = readFileSync(fileURLToPath(new URL("../wrangler.toml", import.meta.url)), "utf8");
const BASE = new URL(/^APP_URL\s*=\s*"([^"]+)"/m.exec(toml)[1]).origin;
const env = loadEnv();
const owner = Number(env.OWNER_TELEGRAM_ID);
const STRANGER = 1000001;   // not a real user of the bot
const sign = (id) => signInitData({ query_id: "AAstep10", auth_date: String(Math.floor(Date.now() / 1000)),
  user: JSON.stringify({ id, first_name: "Check", language_code: "en" }) }, env.TELEGRAM_BOT_TOKEN);
async function call(path, id, body) {
  const res = await fetch(BASE + path, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `tma ${await sign(id)}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };

let r = await call("/api/admin/refund", STRANGER, { id: 1 });
check("a stranger cannot refund", r.status === 403, `HTTP ${r.status}`);
r = await call("/api/admin", STRANGER);
check("a stranger cannot open Admin", r.status === 403, `HTTP ${r.status}`);
r = await call("/api/admin/refund", owner, { id: 999999 });
check("owner: refund of an unknown tip stops before Telegram", r.status === 404, `HTTP ${r.status}: ${r.body.message}`);
r = await call("/api/admin", owner);
check("owner: Admin has the Tips section", r.status === 200 && r.body.tips && Array.isArray(r.body.tips.last),
  r.body.tips ? `${r.body.tips.stars} Stars, ${r.body.tips.tips} tips` : "missing");
check("owner: Admin languages show held stories", Array.isArray(r.body.languages) && r.body.languages.every((l) => "held_24h" in l));
try {
  await tgCall(env.TELEGRAM_BOT_TOKEN, "refundStarPayment", { user_id: owner, telegram_payment_charge_id: "step10-no-such-charge" });
  check("Telegram refuses to refund a made-up charge", false, "it said ok");
} catch (e) {
  check("Telegram knows refundStarPayment and refuses a made-up charge", e.status === 400, e.message);
}
r = await call("/api/tip", STRANGER, { amount: 1 });
check("1-Star test amount refused for a stranger", r.status === 400, `HTTP ${r.status}`);
r = await call("/api/tip", owner, { amount: 1 });
check("1-Star test amount refused for the owner too (Step 11)", r.status === 400, `HTTP ${r.status}`);
r = await call("/api/tip", owner, { amount: 100 });
check("100 Stars gives the owner an invoice link", r.status === 200 && /^https:\/\/t\.me\/\$/.test(r.body.link ?? ""), `HTTP ${r.status}`);
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
