// Local dev tool for the owner's digest. Uses the SAME code as the Worker (src/digest.js)
// against the real D1 database (REST API, credentials from ../.env). Only ever use it with the
// TEST bot token in .env (docs/LESSONS.md, lesson 11). Never prints secrets.
//
//   node scripts/digest-cli.mjs                    dry run: print the owner's next digest, write nothing
//   node scripts/digest-cli.mjs --preview          send a labelled preview (last 24 h) to the owner, write nothing
//                                                   (add --dry to print it without sending; --since-last: the
//                                                   digest the Worker would send now, since the last one;
//                                                   --since-hours 9: a 9-hour window as if nothing was sent)
//   node scripts/digest-cli.mjs --send             send for real and record it (as the Worker does)
//   node scripts/digest-cli.mjs --windows          replay digests of the last 24 h (tuning the bars):
//        --profile owner|dad|armenia3h|all6h|all, --hours 48, --bars "7,5;7,6", --limit 3500,
//        --verbose lists every story, --show prints the messages
//   (near-duplicate pairs: venv/Scripts/python -m job.dupes, from the project folder)
//   node scripts/digest-cli.mjs --cpu 8            CPU time to build 8 digests (the four profiles) from full pools
//        --lang ru: the same in Russian (Step 9), every story with a stand-in Cyrillic translation 20% longer
//   --bars and --limit work with every mode; --label "..." changes the preview's label
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CONFIG, candidateStatement, hhmm, localParts, parseList, planDigest, storyScore, topicScore,
  visibleLength,
} from "../src/digest.js";
import { sendDigestMessage } from "../src/telegram.js";
import { digestExtra, digestWrites } from "../src/cron.js";
import { asTopicRows, enabledOnly, followedStatement, withCustomTopics } from "../src/custom.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Step 16: with AXIOM_ENV=staging, ../.env.staging (the staging D1 id and webhook secret) is read
// on top of ../.env, so every script can run against the staging copy.
function readEnvFile(path) {
  const env = {};
  for (const line of readFileSync(path, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if (v.length >= 2 && v[0] === v[v.length - 1] && `"'`.includes(v[0])) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}
export const STAGING = process.env.AXIOM_ENV === "staging";
export function loadEnv(path = `${ROOT}.env`) {
  const env = { ...readEnvFile(path), ...(STAGING ? readEnvFile(path.replace(/\.env$/, ".env.staging")) : {}) };
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
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : fallback;
}

export const POOL_COLUMNS = "id, summary, headline, description, emojis, main_topic, best_url, best_source, importance, final_score, " +
  "topic_score, scored_at, topics, created_at, updated_at, dup_group";

// Test profiles for the replay and the CPU check (Step 8). The owner is read from D1.
function profiles(user, topics) {
  const allTags = JSON.stringify(topics.map((t) => t.tag));
  const yerevan = "Asia/Yerevan";
  return {
    owner: user,
    dad: { ...user, id: 0, first_name: "Dad", topics: allTags, timezone: yerevan,
           digest_times: JSON.stringify(["09:00", "14:00", "20:00"]) },
    armenia3h: { ...user, id: 0, first_name: "Ani", topics: JSON.stringify(["armenia"]), timezone: yerevan,
                 digest_times: JSON.stringify(["09:00", "12:00", "15:00", "18:00", "21:00"]) },
    all6h: { ...user, id: 0, first_name: "Sam", topics: allTags, timezone: yerevan,
             digest_times: JSON.stringify(["06:00", "12:00", "18:00"]) },
  };
}

// A user's digests of the last `hours`, replayed on the stories as they are now: each story is
// placed in the window where it first appeared (created_at), and none is shown twice. Uses the
// real planDigest (two-score rule and length cut). For tuning the bars:
//   --windows [--profile owner|dad|armenia3h|all6h|all] [--hours 48] [--bars "7,5;7,6"] [--show]
export async function windows(db, user, topics, now, cfg, hours = 24, pool = null) {
  const tz = user.timezone || cfg.default_timezone;
  const times = parseList(user.digest_times, cfg.default_times);
  const slots = [];   // every digest time of the user in the last `hours` (zones have 15-minute offsets at most)
  for (let t = Math.ceil((now - hours * 3600) / 900) * 900; t <= now; t += 900) {
    const p = localParts(t, tz);
    if (p.minute === 0 && times.includes(hhmm(p))) slots.push(t);
  }
  const partial = now - slots[slots.length - 1] > 3600;
  if (partial) slots.push(now);   // the window that is still open: "so far"
  pool ??= await db.query(`SELECT ${POOL_COLUMNS} FROM stories WHERE created_at >= ?1 AND merged_into IS NULL`,
    [slots[0] - 86400]);
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
    const tag = (s) => `[${storyScore(s, cfg)}${s.final_score != null ? `/t${topicScore(s, cfg)}` : " unedited"}]`;
    summary.push({ at: label, stories: plan.stories.length, cut: plan.cut, byTopic, chars: visibleLength(plan.text),
      armenia: plan.stories.filter((s) => parseList(s.topics).includes("armenia")).map((s) => `${tag(s)} ${s.headline}`),
      list: plan.stories.map((s) => ({ id: s.id, primary: s.primary, main: s.main_topic, tags: parseList(s.topics),
        score: storyScore(s, cfg), topic: topicScore(s, cfg), headline: s.headline ?? s.summary })) });
    if (process.argv.includes("--verbose") || process.argv.includes("--show")) {
      console.log(`\n=== digest at ${label} (${tz}), window from ${hhmm(localParts(from, tz))}: ` +
        `${plan.stories.length} stories (${plan.cut} cut for length), ${visibleLength(plan.text)} characters`);
      for (const s of plan.stories) console.log(`  ${tag(s)} ${s.primary}: ${s.emojis ?? ""} ${s.headline}`);
    }
    if (process.argv.includes("--show")) console.log(`\n${plan.text}`);
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
  const [users, mainTopics, custom] = await db.batch([
    { sql: "SELECT * FROM users WHERE id = ?1", params: [owner] },
    { sql: "SELECT tag, label_en, emoji, sort, is_default FROM topics ORDER BY sort", params: [] },
    followedStatement(owner),   // Step 13: the owner's custom topics, as the Worker cron adds them
  ]);
  const base = users[0] ?? {
    id: owner, topics: JSON.stringify(mainTopics.map((t) => t.tag)), first_name: "",
    timezone: CONFIG.default_timezone, digest_times: JSON.stringify(CONFIG.default_times), last_digest_at: null,
  };
  const user = withCustomTopics(base, custom);
  const topics = [...mainTopics, ...asTopicRows(enabledOnly(custom))];
  if (custom.length) console.log(`[custom topics: ${custom.map((c) => `${c.tag} ${JSON.parse(c.names).en}${Number(c.enabled ?? 1) ? "" : " (off)"}`).join(", ")}]`);
  // --bars 7,6 or several: --bars "7,5;7,6;7,7" (editorial,topic)
  const barSets = (arg("--bars") ?? `${CONFIG.editorial_bar},${CONFIG.topic_bar}`).split(";")
    .map((b) => ({ ...CONFIG, editorial_bar: Number(b.split(",")[0]), topic_bar: Number(b.split(",")[1]),
      ...(b.split(",")[2] === "noboost" ? { topic_needs_boost: false } : {}) }));
  const limit = arg("--limit");
  if (limit) for (const c of barSets) c.message_char_limit = Number(limit);
  const cfg = barSets[0];
  const PROFILES = profiles(user, topics);

  if (process.argv.includes("--windows")) {
    const want = arg("--profile", "owner");
    const names = want === "all" ? Object.keys(PROFILES) : [want];
    const hours = Number(arg("--hours", "24"));
    const pool = await db.query(`SELECT ${POOL_COLUMNS} FROM stories WHERE created_at >= ?1 AND merged_into IS NULL`,
      [now - (hours + 24) * 3600]);
    const lines = [];
    for (const name of names) {
      for (const c of barSets) {
        const s = await windows(db, PROFILES[name], topics, now, c, hours, pool);
        const sizes = s.map((w) => w.stories);
        const arm = s.reduce((n, w) => n + w.armenia.length, 0);
        const cut = s.reduce((n, w) => n + w.cut, 0);
        lines.push(`\n## ${name}, bars ${c.editorial_bar}/${c.topic_bar}${c.topic_needs_boost ? "" : " WITHOUT the boost rule"}, limit ${c.message_char_limit}, last ${hours} h: ` +
          `${s.length} digests, sizes ${sizes.join(" ")} (avg ${(sizes.reduce((a, b) => a + b, 0) / (sizes.length || 1)).toFixed(1)}, ` +
          `max ${Math.max(0, ...sizes)}), cut for length ${cut}, Armenia stories ${arm}, chars ${s.map((w) => w.chars).join(" ")}`);
        for (const w of s) {
          lines.push(`  ${w.at}: ${w.stories}${w.cut ? ` (+${w.cut} cut)` : ""} (${Object.entries(w.byTopic).map(([k, v]) => `${k} ${v}`).join(", ")})`);
          for (const a of w.armenia) lines.push(`      AM ${a}`);
        }
      }
    }
    console.log(`\n# SUMMARY\n${lines.join("\n")}`);
    return;
  }

  if (process.argv.includes("--cpu")) {
    // Worst case for one tick: --cpu 8 builds 8 digests (the four profiles in turn), each from a
    // full candidate list of the last 24 h (ignoring "sent"), as candidate SQL would return it.
    const n = Number(arg("--cpu", "8"));
    const list = Object.values(PROFILES);
    const pools = [];
    for (const u of list) {
      const st = candidateStatement({ ...u, id: 0, last_digest_at: null }, now, cfg);
      pools.push(await db.query(st.sql, st.params));
    }
    const lang = arg("--lang", "en");
    if (lang !== "en") {   // Step 9: stand-in translations, about 20% longer, Cyrillic, same numbers
      const fake = (s) => (s ? `${s} ${"перевод ".repeat(Math.ceil(s.length / 40))}`.replace(/[A-Za-z]/g, "ж") : s);
      // Step 10: --held 0.3 leaves 30% of the stories untranslated (held), so the drop and the second length cut run
      const heldShare = Number(arg("--held", "0"));
      for (const p of pools) p.forEach((s, k) => {
        if (heldShare && (k % 10) < heldShare * 10) return;
        s.tr_headline = fake(s.headline || s.summary); s.tr_description = fake(s.description);
      });
    }
    const opts = { lang };
    for (let i = 0; i < list.length; i++) planDigest(list[i], pools[i], topics, now, cfg, opts);   // warm-up (JIT), not counted
    const t0 = process.cpuUsage();
    let langs = new Set();
    for (let i = 0; i < n; i++) langs.add(planDigest(list[i % list.length], pools[i % list.length], topics, now, cfg, opts).lang);
    const t = process.cpuUsage(t0);
    console.log(`${n} digests (${[...langs].join("/")}) from ${pools.map((p) => p.length).join("/")} candidates: ${((t.user + t.system) / 1000).toFixed(1)} ms CPU ` +
      `(${((t.user + t.system) / 1000 / n).toFixed(2)} ms each, Node on this PC)`);
    return;
  }

  // A preview shows the last 24 h as if nothing had been sent yet (id 0 has no `sent` rows); it is
  // labelled as a preview and writes nothing. With --since-last (Step 13 fixes) it is exactly the
  // digest the Worker would send the owner now (since his last digest, never twice), still labelled
  // and still not recorded. With --since-hours N: a digest window of the last N hours, as if nothing
  // had been sent.
  const previewing = process.argv.includes("--preview");
  const sinceLast = previewing && process.argv.includes("--since-last");
  const sinceHours = previewing ? Number(arg("--since-hours", "0")) : 0;
  let who = !previewing || sinceLast ? user
    : { ...user, id: 0, last_digest_at: sinceHours > 0 ? now - Math.round(sinceHours * 3600) : null };
  // Step 15, previews only: --topics all (every main topic on, plus the owner's own topics),
  // --lang en|ru (the digest language).
  if (previewing && ["all", "main"].includes(arg("--topics"))) {   // Step 16: --topics main = the six main topics only
    const own = arg("--topics") === "all" ? parseList(user.topics).filter((t) => /^c\d+$/.test(t)) : [];
    who = { ...who, topics: JSON.stringify([...mainTopics.map((t) => t.tag), ...own]) };
  }
  if (previewing && arg("--lang")) who = { ...who, lang: arg("--lang") };
  const st = candidateStatement(who, now, cfg);
  const cands = await db.query(st.sql, st.params);
  const label = previewing ? `<i>${arg("--label", "Preview of the digest (last 24 hours). Nothing is recorded.")}</i>` : undefined;
  const plan = planDigest(who, cands, topics, now, cfg, { label });
  console.log(plan.text);
  console.log(`\n[${plan.stories.length} stories from ${cands.length} candidates, ${plan.cut} cut for length, ` +
    `${plan.kind} message, length ${visibleLength(plan.text)} of ${cfg.message_char_limit} (as Telegram counts)]`);
  if ((process.argv.includes("--send") || previewing) && !process.argv.includes("--dry")) {
    // the same message the Worker sends (Step 11: a rich message; Step 14: no button under it)
    const appUrl = /^APP_URL\s*=\s*"([^"]+)"/m.exec(readFileSync(`${ROOT}worker/wrangler.toml`, "utf8"))?.[1];
    const result = await sendDigestMessage(env.TELEGRAM_BOT_TOKEN, owner, plan.text, digestExtra(plan, appUrl));
    console.log(`[sent: Telegram message_id ${result.message_id}]`);
    if (!previewing) {
      await db.batch(digestWrites(user, plan, plan.storyIds, now));
      console.log("[recorded: sent rows, held stories, last_digest_at, next_digest_at]");
    } else console.log("[preview: nothing written]");
  } else console.log("[dry run: nothing sent, nothing written]");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
}
