// Checks the LIVE Mini App API the way the app on a phone uses it. It signs Telegram initData
// itself with the bot token from ../.env (only possible for whoever holds the token; never
// printed), then:
//   1. opens the app as the owner (device time zone sent, like the app does),
//   2. adds a digest time (or removes one), confirms the new value and next_digest_at in D1 through
//      the REST API, then restores the old times; a half-hour time and a removed setting are refused,
//   3. loads the Admin data as the owner (200) and as a different, validly signed user (403),
//   4. sends a request with a tampered signature (401).
// It does not press "Send me a digest now" or "Run news job now" (those are for the owner to try).
//   node scripts/api-check.mjs                     production
//   AXIOM_ENV=staging node scripts/api-check.mjs   staging (Step 16: its own Worker and D1)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STAGING, loadEnv, d1Rest } from "./digest-cli.mjs";
import { signInitData } from "../src/auth.js";

const toml = readFileSync(fileURLToPath(new URL("../wrangler.toml", import.meta.url)), "utf8");
const BASE = new URL(/^APP_URL\s*=\s*"([^"]+)"/m.exec(toml.split("[env.staging]")[STAGING ? 1 : 0])[1]).origin;
console.log(`checking ${BASE}`);
const env = loadEnv();
const owner = Number(env.OWNER_TELEGRAM_ID);
const db = d1Rest(env);
const now = () => String(Math.floor(Date.now() / 1000));
const sign = (id, name) => signInitData({ query_id: "AAcheck", auth_date: now(),
  user: JSON.stringify({ id, first_name: name, language_code: "en" }) }, env.TELEGRAM_BOT_TOKEN);

let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };
async function api(path, init, body) {
  const t = Date.now();
  const res = await fetch(BASE + path, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `tma ${init}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json(), ms: Date.now() - t };
}
const row = async () => (await db.query("SELECT first_name, timezone, tz_detected, digest_times, next_digest_at FROM users WHERE id = ?1", [owner]))[0];

// Sign as the owner with the name already stored: opening the app saves the Telegram first name
// (lesson 14), so a made-up name here would overwrite the real one (happened once in Step 5).
const before = await row();
const ownerInit = await sign(owner, before?.first_name || "Owner");
// Step 16: send the zone already stored, so the check never moves the owner to another zone
const opened = await api("/api/open", ownerInit, { tz: before?.timezone || "Asia/Yerevan" });
check("open as owner", opened.status === 200 && opened.body.is_owner === true, `${opened.status}, ${opened.ms} ms, is_owner ${opened.body.is_owner}`);

const old = opened.body.user.digest_times;
const extra = ["23:00", "06:00", "12:00"].find((t) => !old.includes(t));
const next = old.length < 5 ? [...old, extra].sort() : old.slice(0, -1);
const saved = await api("/api/settings", ownerInit, { digest_times: next });
const after = await row();
check("settings change saved in D1", saved.status === 200 && after.digest_times === JSON.stringify(next),
  `${old.join(",")} -> ${after.digest_times}, ${saved.ms} ms`);
check("next_digest_at returned matches D1", saved.body.user?.next_digest_at === after.next_digest_at,
  new Date(after.next_digest_at * 1000).toISOString());
const restored = await api("/api/settings", ownerInit, { digest_times: old });
check("old value restored", restored.status === 200 && (await row()).digest_times === JSON.stringify(old), `back to ${old.join(",")}`);
const bad = await api("/api/settings", ownerInit, { digest_times: ["09:30"] });
check("a half-hour time is refused with a friendly message", bad.status === 400, bad.body.error);
// Step 18: an empty list is refused, and the refusal says what is saved (nothing changes)
const empty = await api("/api/settings", ownerInit, { digest_times: [] });
check("an empty times list is refused with the saved state", empty.status === 400 && empty.body.code === "keep_time" &&
  JSON.stringify(empty.body.state?.user?.digest_times) === JSON.stringify(old) && (await row()).digest_times === JSON.stringify(old), empty.body.error);
const gone = await api("/api/settings", ownerInit, { max_stories: 7 });
check("a removed setting is refused", gone.status === 400, gone.body.error);

const admin = await api("/api/admin", ownerInit);
check("admin data for the owner", admin.status === 200 && !!admin.body.health, `${admin.ms} ms, level ${admin.body.health?.level}, ` +
  `${admin.body.users?.count} users, ${admin.body.feeds?.total} feeds, D1 today ${admin.body.d1?.rows_read} read / ${admin.body.d1?.rows_written} written`);
// Step 18: the dashboard summary (one health level and reason, key numbers, limits)
const Z = admin.body.summary;
check("admin dashboard summary", !!Z && ["ok", "warn", "bad"].includes(Z.level) && !!Z.reason && !!Z.numbers && !!Z.limits,
  `${Z?.level}: ${Z?.reason}; ${Z?.numbers?.active_users} active, ${Z?.numbers?.digests_today} digests today, ${Z?.numbers?.stories_today} stories today`);
const stranger = await api("/api/admin", await sign(owner + 1, "Someone"));
check("admin data for anyone else: 403", stranger.status === 403, stranger.body.error);
const tampered = await api("/api/admin", ownerInit.replace(/hash=[0-9a-f]/, (m) => m.slice(0, -1) + (m.endsWith("0") ? "1" : "0")));
check("tampered signature: 401", tampered.status === 401);
console.log(`owner row before: tz ${before.timezone} (detected ${before.tz_detected}); now: tz ${(await row()).timezone} (detected ${(await row()).tz_detected})`);
process.exit(failed ? 1 : 0);
