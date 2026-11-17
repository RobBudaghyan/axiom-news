// Step 15: imports the readers of the old bot, so they keep getting news without the welcome flow.
// Input: a JSON file, a list of {id, first_name?, lang?} (Telegram user id; lang en|ru|hy|fr, else
// English). Each new id gets the defaults (all main topics on, 09:00/14:00/20:00, Asia/Yerevan),
// imported = 1 and onboarded_at = now: no welcome, no setup, no reminder; they get the owner's
// announcement instead. An id that is already a user is left exactly as it is. Nothing is sent.
// Uses the live D1 (REST, credentials from ../.env).
//
//   node scripts/import-users.mjs users.json --dry    show what would be imported
//   node scripts/import-users.mjs users.json          import
import { pathToFileURL } from "node:url";
import { CONFIG, nextSlot } from "../src/digest.js";
import { chooseLang } from "../src/i18n.js";

// The rows to insert: valid, unique ids only. topics: rows of the D1 topics table.
export function importStatements(list, topics, now, cfg = CONFIG) {
  const seen = new Set(), out = [], skipped = [];
  const defaults = JSON.stringify(topics.filter((t) => t.is_default).map((t) => t.tag));
  for (const x of Array.isArray(list) ? list : []) {
    const id = Number(x?.id);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) { skipped.push(x); continue; }
    seen.add(id);
    const lang = chooseLang(String(x.lang ?? "en"));
    out.push({
      sql: "INSERT INTO users (id, first_name, language, lang, timezone, digest_times, topics, created_at, next_digest_at, " +
           "imported, onboarded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?8) ON CONFLICT(id) DO NOTHING RETURNING id",
      params: [id, String(x.first_name ?? "").slice(0, 64) || null, lang, lang, cfg.default_timezone, JSON.stringify(cfg.default_times),
               defaults, now, nextSlot(now, cfg.default_timezone, cfg.default_times)],
    });
  }
  return { statements: out, skipped };
}

async function main() {
  const { readFileSync } = await import("node:fs");
  const { d1Rest, loadEnv } = await import("./digest-cli.mjs");
  const file = process.argv[2];
  if (!file || file.startsWith("--")) throw new Error("usage: node scripts/import-users.mjs users.json [--dry]");
  const dry = process.argv.includes("--dry");
  const db = d1Rest(loadEnv());
  const list = JSON.parse(readFileSync(file, "utf8"));
  const topics = await db.query("SELECT tag, is_default FROM topics ORDER BY sort");
  const now = Math.floor(Date.now() / 1000);
  const { statements, skipped } = importStatements(list, topics, now);
  const existing = new Set((await db.query("SELECT id FROM users")).map((r) => r.id));
  const fresh = statements.filter((s) => !existing.has(s.params[0]));
  console.log(`${list.length} in the file: ${fresh.length} new, ${statements.length - fresh.length} already users (left as they are), ${skipped.length} invalid or repeated`);
  if (dry) { console.log("[dry run: nothing written, nothing sent]"); return; }
  let added = 0;
  for (let i = 0; i < fresh.length; i += 50) added += (await db.batch(fresh.slice(i, i + 50))).filter((r) => r.length).length;
  console.log(`[imported ${added}; nothing was sent to anyone]`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
