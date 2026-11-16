// Step 11: live checks on the deployed Worker (TEST bot; token and owner id from ../.env, never
// printed). Costs nothing.
//  1. Admin "Send me a digest now" for the owner: the Worker builds the digest and sends it as a
//     rich message with the "⚙️ Settings" button (a real digest: its stories are marked sent, as
//     with the button in Admin). Telegram's copy is then compared with the digest's own length.
//  2. The Mini App state lists the three tip amounts 100, 500, 1000 (owner included).
//  3. 1 and 50 Stars are refused by /api/tip; 1000 gives an invoice link (nothing is paid).
//   node scripts/step11-live-check.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./digest-cli.mjs";
import { signInitData } from "../src/auth.js";

const toml = readFileSync(fileURLToPath(new URL("../wrangler.toml", import.meta.url)), "utf8");
const BASE = new URL(/^APP_URL\s*=\s*"([^"]+)"/m.exec(toml)[1]).origin;
const env = loadEnv();
const owner = Number(env.OWNER_TELEGRAM_ID);
const sign = (id) => signInitData({ query_id: "AAstep11", auth_date: String(Math.floor(Date.now() / 1000)),
  user: JSON.stringify({ id, first_name: "Owner", language_code: "en" }) }, env.TELEGRAM_BOT_TOKEN);
async function call(path, id, body) {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { authorization: `tma ${await sign(id)}`,
    "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

let r = await call("/api/admin/digest", owner);
check("Admin digest now: sent by the deployed Worker", r.status === 200 && r.body.ok, `HTTP ${r.status}: ${r.body.message ?? ""}`);
r = await call("/api/open", owner, {});
check("Mini App state: tips 100, 500, 1000", JSON.stringify(r.body.tips?.amounts) === "[100,500,1000]", JSON.stringify(r.body.tips));
for (const a of [1, 50]) {
  r = await call("/api/tip", owner, { amount: a });
  check(`${a} Stars refused, even for the owner`, r.status === 400, `HTTP ${r.status}`);
}
r = await call("/api/tip", owner, { amount: 1000 });
check("1000 Stars gives an invoice link", r.status === 200 && /^https:\/\/t\.me\/\$/.test(r.body.link ?? ""), `HTTP ${r.status}`);
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
