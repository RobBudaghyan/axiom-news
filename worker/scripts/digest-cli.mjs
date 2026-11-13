// Local dev tool for the owner's digest. Uses the SAME code as the Worker (src/digest.js)
// against the real D1 database (REST API, credentials from ../.env). Only ever use it with the
// TEST bot token in .env (docs/LESSONS.md, lesson 11). Never prints secrets.
//
//   node scripts/digest-cli.mjs                    dry run: print the owner's next digest, write nothing
//   node scripts/digest-cli.mjs --format B         dry run in format B
//   node scripts/digest-cli.mjs --preview A        send a labelled preview to the owner, write nothing
//   node scripts/digest-cli.mjs --send             send for real and record it (as the Worker does)
//   node scripts/digest-cli.mjs --dupes            list near-duplicate pairs in the current pool
//   node scripts/digest-cli.mjs --length 15        longest-headline 15-story digest: length check
//   node scripts/digest-cli.mjs --cpu 20           CPU time to build 20 digests from the real pool
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONFIG, afterSendStatements, buildMessage, candidateStatement, dedupe, idfTable, planDigest, similarity,
  tokens, topicInfoFrom, visibleLength,
} from "../src/digest.js";
import { sendHtml } from "../src/telegram.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export function loadEnv(path = `${ROOT}.env`) {
  const env = {};
  for (const line of readFileSync(path, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if (v.length >= 2 && v[0] === v[v.length - 1] && `"'`.includes(v[0])) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return { ...env, ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k in env && v)) };
}

// Same interface as src/db.js, over the D1 REST API.
export function d1Rest(env) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.D1_DATABASE_ID}/query`;
  const post = async (body) => {
    const resp = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${env.CLOUDFLARE_D1_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!data.success) throw new Error(`D1 HTTP ${resp.status}: ${(data.errors ?? []).map((e) => e.message).join("; ")}`);
    return data.result;
  };
  return {
    async query(sql, params = []) {
      const r = await post({ sql, params });
      return r[r.length - 1]?.results ?? [];
    },
    async batch(stmts) {
      if (!stmts.length) return [];
      const r = await post({ batch: stmts.map((s) => ({ sql: s.sql, params: s.params ?? [] })) });
      return r.map((x) => x.results ?? []);
    },
  };
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}

async function main() {
  const env = loadEnv();
  const db = d1Rest(env);
  const owner = Number(env.OWNER_TELEGRAM_ID);
  const now = Math.floor(Date.now() / 1000);
  const [users, topics] = await db.batch([
    { sql: "SELECT * FROM users WHERE id = ?1", params: [owner] },
    { sql: "SELECT tag, label_en, emoji, sort, is_default FROM topics ORDER BY sort", params: [] },
  ]);
  const user = users[0] ?? {
    id: owner, topics: JSON.stringify(topics.map((t) => t.tag)), max_stories: CONFIG.default_stories,
    timezone: CONFIG.default_timezone, digest_times: JSON.stringify(CONFIG.default_times), last_digest_at: null,
  };
  const st = candidateStatement(user, now);
  const cands = await db.query(st.sql, st.params);

  if (process.argv.includes("--dupes")) {
    // Pool for this check: everything recent, ignoring "sent", so there is enough to look at.
    const pool = await db.query("SELECT id, summary, importance, topics FROM stories WHERE updated_at >= ?1 " +
      "AND importance >= ?2 ORDER BY importance DESC, updated_at DESC, id DESC LIMIT ?3",
      [now - 86400, CONFIG.min_importance, CONFIG.candidate_limit]);
    const maps = pool.map((s) => tokens(s.summary));
    const idf = idfTable(maps);
    const pairs = [];
    for (let i = 0; i < pool.length; i++) for (let j = 0; j < i; j++) {
      const s = similarity(maps[i], maps[j], idf);
      if (s >= Number(arg("--min", "0.3"))) pairs.push([s, pool[j], pool[i]]);
    }
    pairs.sort((a, b) => b[0] - a[0]);
    console.log(`pool ${pool.length} stories; pairs with score >= ${arg("--min", "0.3")}: ${pairs.length}`);
    for (const [s, a, b] of pairs) console.log(`${s.toFixed(2)}  [${a.id}] ${a.summary}\n      [${b.id}] ${b.summary}`);
    const { dropped } = dedupe(pool);
    console.log(`\nat threshold ${CONFIG.dedupe_threshold}: ${dropped.length} of ${pool.length} dropped`);
    return;
  }

  if (process.argv.includes("--length")) {
    const n = Number(arg("--length", "15"));
    const longest = await db.query("SELECT id, summary, best_url, best_source, topics, importance FROM stories " +
      "ORDER BY length(summary) + length(best_source) DESC LIMIT ?1", [n]);
    for (const format of ["A", "B"]) {
      const msg = buildMessage(longest.map((s) => ({ ...s, primary: JSON.parse(s.topics)[0] })),
        { now, tz: user.timezone, lastDigestAt: null, topicInfo: topicInfoFrom(topics), format });
      console.log(`format ${format}: ${msg.stories.length} of ${n} longest stories, visible length ` +
        `${visibleLength(msg.text)} (limit 4096), raw HTML ${msg.text.length}`);
    }
    return;
  }

  if (process.argv.includes("--cpu")) {
    const n = Number(arg("--cpu", "20"));
    const t0 = process.cpuUsage();
    for (let i = 0; i < n; i++) planDigest({ ...user, max_stories: 15 }, cands, topics, now);
    const t = process.cpuUsage(t0);
    console.log(`${n} digests from ${cands.length} candidates: ${((t.user + t.system) / 1000).toFixed(1)} ms CPU ` +
      `(${((t.user + t.system) / 1000 / n).toFixed(2)} ms each, Node on this PC)`);
    return;
  }

  const preview = arg("--preview", "A");
  const format = preview ?? arg("--format", CONFIG.format);
  const label = preview ? `<i>Preview ${preview}: ${preview === "A" ? "flat list (default)" : "grouped by topic"}</i>` : undefined;
  const plan = planDigest(user, cands, topics, now, CONFIG, { format, label });
  console.log(plan.text);
  console.log(`\n[${plan.stories.length} stories from ${cands.length} candidates, visible length ${visibleLength(plan.text)}]`);
  if (process.argv.includes("--send") || preview) {
    const result = await sendHtml(env.TELEGRAM_BOT_TOKEN, owner, plan.text);
    console.log(`[sent: Telegram message_id ${result.message_id}]`);
    if (!preview) {
      await db.batch(afterSendStatements(user, plan.stories.map((s) => s.id), now, plan.nextAt));
      console.log("[recorded: sent rows, last_digest_at, next_digest_at]");
    } else console.log("[preview: nothing written]");
  } else console.log("[dry run: nothing sent, nothing written]");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
}
