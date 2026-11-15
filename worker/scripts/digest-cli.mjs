// Local dev tool for the owner's digest. Uses the SAME code as the Worker (src/digest.js)
// against the real D1 database (REST API, credentials from ../.env). Only ever use it with the
// TEST bot token in .env (docs/LESSONS.md, lesson 11). Never prints secrets.
//
//   node scripts/digest-cli.mjs                    dry run: print the owner's next digest, write nothing
//   node scripts/digest-cli.mjs --preview          send a labelled preview (last 24 h) to the owner, write nothing
//                                                   (add --dry to print it without sending)
//   node scripts/digest-cli.mjs --send             send for real and record it (as the Worker does)
//   node scripts/digest-cli.mjs --windows          replay the owner's digests of the last 24 h (tuning the bars;
//                                                   --bars 7,6 tries other bars, --show prints the messages)
//   (near-duplicate pairs: venv/Scripts/python -m job.dupes, from the project folder)
//   node scripts/digest-cli.mjs --length           the 12 longest real stories in one digest: length and split
//   node scripts/digest-cli.mjs --cpu 20           CPU time to build 20 digests from the real pool
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONFIG, afterSendStatements, buildMessage, candidateStatement, hhmm, localParts, parseList, planDigest, storyScore,
  topicInfoFrom, visibleLength,
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

const POOL_COLUMNS = "id, summary, headline, description, emojis, main_topic, best_url, best_source, importance, final_score, " +
  "topics, created_at, updated_at, dup_group";

// The owner's digests of the last 24 h, replayed on the stories as they are now: each story is
// placed in the window where it first appeared (created_at), and none is shown twice. For tuning
// the bars:  --windows [--bars 7,6] [--show]
async function windows(db, user, topics, now, cfg, hours = 24) {
  const tz = user.timezone || cfg.default_timezone;
  const times = parseList(user.digest_times, cfg.default_times);
  const slots = [];   // every digest time of the user in the last `hours` (zones have 15-minute offsets at most)
  for (let t = Math.ceil((now - hours * 3600) / 900) * 900; t <= now; t += 900) {
    const p = localParts(t, tz);
    if (p.minute === 0 && times.includes(hhmm(p))) slots.push(t);
  }
  const partial = now - slots[slots.length - 1] > 3600;
  if (partial) slots.push(now);   // the window that is still open: "so far"
  const pool = await db.query(`SELECT ${POOL_COLUMNS} FROM stories WHERE created_at >= ?1 AND merged_into IS NULL ` +
    "AND coalesce(final_score, importance - ?2) >= ?3", [slots[0] - 86400, cfg.unedited_offset, cfg.topic_bar]);
  const sent = new Set();
  const userTopics = parseList(user.topics);
  const summary = [];
  for (let i = 0; i < slots.length; i++) {
    const end = slots[i];
    const from = i ? slots[i - 1] : end - prevGap(end, tz, times);
    const cands = pool.filter((s) => s.created_at >= from && s.created_at < end && !sent.has(s.id) &&
      parseList(s.topics).some((t) => userTopics.includes(t)))
      .sort((a, b) => storyScore(b, cfg) - storyScore(a, cfg) || b.updated_at - a.updated_at);
    const plan = planDigest({ ...user, last_digest_at: from }, cands, topics, end, cfg);
    for (const s of plan.stories) sent.add(s.id);
    const byTopic = {};
    for (const s of plan.stories) byTopic[s.primary] = (byTopic[s.primary] ?? 0) + 1;
    const label = partial && i === slots.length - 1 ? `now ${hhmm(localParts(end, tz))} (window still open)` : hhmm(localParts(end, tz));
    summary.push({ at: label, candidates: cands.length, stories: plan.stories.length, byTopic,
      parts: plan.parts.length, chars: plan.parts.map(visibleLength),
      armenia: plan.stories.filter((s) => parseList(s.topics).includes("armenia"))
        .map((s) => `[${storyScore(s, cfg)}${s.topic_score != null ? `/t${s.topic_score}` : ""}] ${s.headline || s.summary}`) });
    console.log(`\n=== digest at ${label} (${tz}), window from ${hhmm(localParts(from, tz))}: ` +
      `${plan.stories.length} stories from ${cands.length} candidates >= topic bar, ${plan.parts.length} message(s)`);
    for (const s of plan.stories) {
      console.log(`  [${storyScore(s, cfg)}${s.final_score == null ? " unedited" : ""}${s.guaranteed ? ", topic's best" : ""}] ` +
        `${s.primary}: ${s.emojis ?? ""} ${s.headline || s.summary}`);
    }
    if (process.argv.includes("--show")) console.log(`\n${plan.parts.join("\n\n----- next message -----\n\n")}`);
  }
  return summary;
}

// Gap before a slot: back to the previous digest time of the day (or yesterday's last one).
function prevGap(end, tz, times) {
  for (let back = 3600; back <= 86400; back += 3600) {
    if (times.includes(hhmm(localParts(end - back, tz)))) return back;
  }
  return 86400;
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
    id: owner, topics: JSON.stringify(topics.map((t) => t.tag)), first_name: "",
    timezone: CONFIG.default_timezone, digest_times: JSON.stringify(CONFIG.default_times), last_digest_at: null,
  };
  // --bars 7,6 or several: --bars "7,5;7,6;7,7" (editorial,topic)
  const barSets = (arg("--bars") ?? `${CONFIG.editorial_bar},${CONFIG.topic_bar}`).split(";")
    .map((b) => ({ ...CONFIG, editorial_bar: Number(b.split(",")[0]), topic_bar: Number(b.split(",")[1]) }));
  const cfg = barSets[0];

  if (process.argv.includes("--windows")) {
    // --profile owner|dad|armenia3h|all6h|all (default owner); --hours 48 (default 24)
    const allTags = JSON.stringify(topics.map((t) => t.tag));
    const yerevan = "Asia/Yerevan";
    const PROFILES = {
      owner: user,
      dad: { ...user, id: 0, first_name: "Dad", topics: allTags, timezone: yerevan,
             digest_times: JSON.stringify(["09:00", "14:00", "20:00"]) },
      armenia3h: { ...user, id: 0, first_name: "Ani", topics: JSON.stringify(["armenia"]), timezone: yerevan,
                   digest_times: JSON.stringify(["09:00", "12:00", "15:00", "18:00", "21:00"]) },
      all6h: { ...user, id: 0, first_name: "Sam", topics: allTags, timezone: yerevan,
               digest_times: JSON.stringify(["06:00", "12:00", "18:00"]) },
    };
    const want = arg("--profile", "owner");
    const names = want === "all" ? Object.keys(PROFILES) : [want];
    const hours = Number(arg("--hours", "24"));
    const lines = [];
    for (const name of names) {
      for (const c of barSets) {
        const s = await windows(db, PROFILES[name], topics, now, c, hours);
        const sizes = s.map((w) => w.stories);
        const arm = s.reduce((n, w) => n + w.armenia.length, 0);
        lines.push(`\n## ${name}, bars ${c.editorial_bar}/${c.topic_bar}, last ${hours} h: ${s.length} digests, sizes ` +
          `${sizes.join(" ")} (avg ${(sizes.reduce((a, b) => a + b, 0) / (sizes.length || 1)).toFixed(1)}, max ${Math.max(0, ...sizes)}), ` +
          `Armenia stories ${arm}, messages ${s.map((w) => w.parts).join(" ")}, chars ${s.map((w) => w.chars.join("+")).join(" ")}`);
        for (const w of s) {
          lines.push(`  ${w.at}: ${w.stories} (${Object.entries(w.byTopic).map(([k, v]) => `${k} ${v}`).join(", ")})`);
          for (const a of w.armenia) lines.push(`      AM ${a}`);
        }
      }
    }
    console.log(`\n# SUMMARY\n${lines.join("\n")}`);
    return;
  }

  // A preview shows the last 24 h as if nothing had been sent yet (id 0 has no `sent` rows); it is
  // labelled as a preview and writes nothing.
  const previewing = process.argv.includes("--preview");
  const st = candidateStatement(previewing ? { ...user, id: 0, last_digest_at: null } : user, now, cfg);
  const cands = await db.query(st.sql, st.params);

  if (process.argv.includes("--length")) {
    // The 12 longest real headlines and descriptions in one digest: how many messages, how long.
    const longest = await db.query(`SELECT ${POOL_COLUMNS} FROM stories WHERE final_score IS NOT NULL ` +
      "ORDER BY length(coalesce(headline, summary)) + length(coalesce(description, '')) DESC LIMIT ?1", [cfg.max_stories]);
    const msg = buildMessage(longest.map((s) => ({ ...s, primary: JSON.parse(s.topics)[0] })),
      { now, tz: user.timezone, lastDigestAt: null, name: user.first_name, topicInfo: topicInfoFrom(topics) }, cfg);
    console.log(`${msg.stories.length} longest stories: ${msg.parts.length} message(s), visible lengths ` +
      `${msg.parts.map(visibleLength).join(" + ")} (limit 4096 each), raw HTML ${msg.parts.map((p) => p.length).join(" + ")}`);
    return;
  }

  if (process.argv.includes("--cpu")) {
    // Worst case: a full candidate list (the last 24 h, ignoring "sent").
    const n = Number(arg("--cpu", "20"));
    const pool = await db.query(`SELECT ${POOL_COLUMNS} FROM stories WHERE updated_at >= ?1 AND merged_into IS NULL ` +
      "ORDER BY coalesce(final_score, importance - ?2) DESC LIMIT ?3", [now - 86400, cfg.unedited_offset, cfg.candidate_limit]);
    planDigest(user, pool, topics, now, cfg);   // warm-up (JIT), not counted
    const t0 = process.cpuUsage();
    for (let i = 0; i < n; i++) planDigest(user, pool, topics, now, cfg);
    const t = process.cpuUsage(t0);
    console.log(`${n} digests from ${pool.length} candidates: ${((t.user + t.system) / 1000).toFixed(1)} ms CPU ` +
      `(${((t.user + t.system) / 1000 / n).toFixed(2)} ms each, Node on this PC)`);
    return;
  }

  const label = previewing ? "<i>Preview of the new digest (last 24 hours). Nothing is recorded.</i>" : undefined;
  const plan = planDigest(previewing ? { ...user, last_digest_at: null } : user, cands, topics, now, cfg, { label });
  console.log(plan.parts.join("\n\n----- next message -----\n\n"));
  console.log(`\n[${plan.stories.length} stories from ${cands.length} candidates, ${plan.parts.length} message(s), ` +
    `visible length ${plan.parts.map(visibleLength).join(" + ")}]`);
  if ((process.argv.includes("--send") || previewing) && !process.argv.includes("--dry")) {
    const ids = [];
    for (let p = 0; p < plan.parts.length; p++) {
      const result = await sendHtml(env.TELEGRAM_BOT_TOKEN, owner, plan.parts[p]);
      console.log(`[sent: Telegram message_id ${result.message_id}]`);
      ids.push(...plan.partStories[p]);
    }
    if (!previewing) {
      await db.batch(afterSendStatements(user, ids, now, plan.nextAt));
      console.log("[recorded: sent rows, last_digest_at, next_digest_at]");
    } else console.log("[preview: nothing written]");
  } else console.log("[dry run: nothing sent, nothing written]");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
}
