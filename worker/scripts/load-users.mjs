// Step 16 Part 2: the load test, STAGING ONLY. 25 fake readers (ids -1001 to -1025: Telegram ids are
// positive, so none can ever be a real person), all due in the same cron tick, mixed languages and
// topics, some with custom topics. Run with SEND_STUB on (Telegram is never called).
//   AXIOM_ENV=staging node scripts/load-users.mjs add        create them, due now
//   AXIOM_ENV=staging node scripts/load-users.mjs status     how many are still due / served
//   AXIOM_ENV=staging node scripts/load-users.mjs open       25 Mini App opens at once (signed initData)
//   AXIOM_ENV=staging node scripts/load-users.mjs remove     delete them and every row they made
import { readFileSync } from "node:fs";
import { STAGING, d1Rest, loadEnv } from "./digest-cli.mjs";
import { signInitData } from "../src/auth.js";

if (!STAGING) throw new Error("staging only: run with AXIOM_ENV=staging");
const env = loadEnv();
if (env.D1_DATABASE_ID === "2a1eb212-95b8-4715-b628-2967cbcb0367") throw new Error("refusing: that is the production D1");
const db = d1Rest(env);
const IDS = Array.from({ length: 25 }, (_, i) => -1001 - i);
const ALL = ["politics_conflicts", "economy_markets", "tech_ai", "armenia", "iran_war", "ukraine_war"];
const TOPIC_SETS = [ALL, ["armenia"], ["armenia", "tech_ai"], ["ukraine_war", "iran_war", "politics_conflicts"], ["economy_markets", "armenia"]];
const now = Math.floor(Date.now() / 1000);
const cmd = process.argv[2];
const inList = IDS.join(",");

if (cmd === "add") {
  const custom = (await db.query("SELECT id FROM custom_topics WHERE tag IS NOT NULL ORDER BY id")).map((r) => r.id);
  const st = [];
  IDS.forEach((id, i) => {
    st.push({ sql: "INSERT OR REPLACE INTO users (id, first_name, timezone, tz_detected, digest_times, topics, paused, blocked, created_at, " +
      "last_digest_at, next_digest_at, lang, onboarded_at, opened_at, imported) VALUES (?1, ?2, 'Asia/Yerevan', 1, '[\"09:00\",\"14:00\",\"20:00\"]', ?3, 0, 0, ?4, ?5, ?6, ?7, ?4, ?4, 0)",
      params: [id, `Load ${String(i + 1).padStart(2, "0")}`, JSON.stringify(TOPIC_SETS[i % TOPIC_SETS.length]), now - 86400,
        now - 6 * 3600, now - 60, i % 2 ? "ru" : "en"] });
    if (i % 3 === 0) for (const t of custom.slice(0, 1 + (i % 2))) {
      st.push({ sql: "INSERT OR REPLACE INTO custom_follows (user_id, topic_id, at, enabled) VALUES (?1, ?2, ?3, 1)", params: [id, t, now] });
    }
  });
  await db.batch(st);
  console.log(`added ${IDS.length} fake readers (13 en, 12 ru, ${st.length - IDS.length} custom follows), due now`);
} else if (cmd === "status") {
  const r = await db.query(`SELECT count(*) AS n, sum(next_digest_at <= ?1) AS due, sum(last_digest_at >= ?2) AS served, min(last_digest_at) AS first, max(last_digest_at) AS last FROM users WHERE id IN (${inList})`, [now, now - 3600]);
  const sent = await db.query(`SELECT count(*) AS n, count(DISTINCT user_id) AS u FROM sent WHERE user_id IN (${inList})`);
  console.log(JSON.stringify({ ...r[0], sent_rows: sent[0].n, readers_with_stories: sent[0].u }));
} else if (cmd === "open") {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const base = new URL(/^APP_URL\s*=\s*"([^"]+)"/m.exec(toml.split("[env.staging]")[1])[1]).origin;
  // The Worker refuses user ids <= 0 (good), so the 25 opens are signed as the owner on staging, with his
  // stored name and zone: an open reads his settings and saves the same zone again, nothing changes.
  const owner = Number(env.OWNER_TELEGRAM_ID);
  const [me] = await db.query("SELECT first_name, timezone, lang FROM users WHERE id = ?1", [owner]);
  if (!me) throw new Error("the owner has no row on staging");
  const inits = await Promise.all(IDS.map((_, i) => signInitData({ query_id: `load${i}`,
    user: JSON.stringify({ id: owner, first_name: me.first_name, language_code: me.lang || "en" }), auth_date: String(now) }, env.TELEGRAM_BOT_TOKEN)));
  const t0 = Date.now();
  const res = await Promise.all(inits.map(async (init) => {
    const s = Date.now();
    const r = await fetch(`${base}/api/open`, { method: "POST", headers: { authorization: `tma ${init}`, "content-type": "application/json" },
      body: JSON.stringify({ tz: me.timezone }) });
    return { status: r.status, ms: Date.now() - s };
  }));
  const ms = res.map((r) => r.ms).sort((a, b) => a - b);
  console.log(JSON.stringify({ opens: res.length, ok: res.filter((r) => r.status === 200).length, statuses: [...new Set(res.map((r) => r.status))],
    wall_ms: Date.now() - t0, median_ms: ms[12], max_ms: ms[24] }));
} else if (cmd === "remove") {
  await db.batch([
    { sql: `DELETE FROM sent WHERE user_id IN (${inList})`, params: [] },
    { sql: `DELETE FROM digest_holds WHERE user_id IN (${inList})`, params: [] },
    { sql: `DELETE FROM custom_follows WHERE user_id IN (${inList})`, params: [] },
    { sql: `DELETE FROM users WHERE id IN (${inList})`, params: [] },
  ]);
  const left = await db.query(`SELECT count(*) AS n FROM users WHERE id < 0`);
  console.log(`removed; fake readers left: ${left[0].n}`);
} else {
  console.log("use: add | status | open | remove");
}
