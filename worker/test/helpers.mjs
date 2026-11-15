// Test doubles: a D1 binding backed by node:sqlite with the real db/schema.sql, a fake
// Telegram/GitHub fetch, and helpers to add stories and users.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { d1Binding } from "../src/db.js";
import { zonedToUtc } from "../src/digest.js";

const SCHEMA = readFileSync(fileURLToPath(new URL("../../db/schema.sql", import.meta.url)), "utf8");
export const TZ = "Asia/Yerevan";
export const ALL = ["politics", "wars_conflicts", "armenia", "russia", "iran_war", "ukraine_war"];
export const OWNER = 42;
export const TOPIC_ROWS = [
  ["politics", "Politics", "🏛️", 1], ["wars_conflicts", "Wars & Conflicts", "⚔️", 2],
  ["armenia", "Armenia", "🇦🇲", 3], ["russia", "Russia", "🇷🇺", 4],
  ["iran_war", "Iran War", "🇮🇷", 5], ["ukraine_war", "Ukraine War", "🇺🇦", 6],
];

// A minimal D1 binding (prepare/bind/all/batch) over sqlite, so src/db.js is exercised too.
export function fakeD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  const stmt = (sql, params = []) => ({
    sql, params,
    bind: (...p) => stmt(sql, p),
    all: async () => ({ results: sqlite.prepare(sql).all(...params).map((r) => ({ ...r })) }),
  });
  const binding = {
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      sqlite.exec("BEGIN");
      try {
        const out = list.map((s) => ({ results: sqlite.prepare(s.sql).all(...s.params).map((r) => ({ ...r })) }));
        sqlite.exec("COMMIT");
        return out;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const db = d1Binding(binding);
  const ins = sqlite.prepare("INSERT INTO topics (tag, label_en, emoji, sort, is_default) VALUES (?, ?, ?, ?, 1)");
  for (const t of TOPIC_ROWS) ins.run(...t);
  return { binding, db, sqlite };
}

export function yerevan(h, m = 0, day = 13, month = 11) {
  return zonedToUtc(2026, month, day, h, m, TZ);
}

// extra: url, source, and the editor's fields (final_score, headline, description, emojis,
// merged_into, dup_group).
export function addStory(sqlite, summary, topics, importance, updatedAt, extra = {}) {
  const r = sqlite.prepare(
    "INSERT INTO stories (summary, topics, importance, best_url, best_source, best_tier, best_published_at, " +
    "source_count, created_at, updated_at, final_score, headline, description, emojis, merged_into, dup_group, " +
    "edited_at) VALUES (?, ?, ?, ?, ?, 1, NULL, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
  ).get(summary, JSON.stringify(topics), importance, extra.url ?? "https://a.test/x",
    extra.source ?? "Alpha Times", updatedAt, updatedAt, extra.final_score ?? null, extra.headline ?? null,
    extra.description ?? null, extra.emojis ?? null, extra.merged_into ?? null, extra.dup_group ?? null,
    extra.final_score != null ? updatedAt : null);
  if (extra.topic_score != null || extra.main_topic != null || extra.scored_at != null) {   // Step 8
    sqlite.prepare("UPDATE stories SET topic_score = ?, main_topic = ?, scored_at = ? WHERE id = ?")
      .run(extra.topic_score ?? null, extra.main_topic ?? null, extra.scored_at ?? null, r.id);
  }
  return r.id;
}

export function addUser(sqlite, fields = {}) {
  const u = {
    id: OWNER, first_name: "Owner", timezone: TZ, digest_times: '["09:00","14:00","20:00"]',
    topics: JSON.stringify(ALL), created_at: 1, last_digest_at: null, next_digest_at: null, paused: 0, blocked: 0,
    ...fields,
  };
  sqlite.prepare("INSERT INTO users (id, first_name, timezone, digest_times, topics, created_at, " +
    "last_digest_at, next_digest_at, paused, blocked, lang) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(u.id, u.first_name, u.timezone, u.digest_times, u.topics, u.created_at,
      u.last_digest_at, u.next_digest_at, u.paused, u.blocked, u.lang ?? "en");
  return u;
}

// Step 9: a translation row as the hourly job writes it (src = the story's English text now).
export function addTranslation(sqlite, storyId, lang, headline, description = null, { ok = 1, src } = {}) {
  const s = sqlite.prepare("SELECT coalesce(headline, summary) || char(10) || coalesce(description, '') AS src FROM stories WHERE id = ?")
    .get(storyId);
  sqlite.prepare("INSERT INTO story_translations (story_id, lang, ok, headline, description, src, created_at) " +
    "VALUES (?,?,?,?,?,?,1)").run(storyId, lang, ok, headline, description, src ?? s.src);
}

// Replaces global fetch. handler(url, init) returns {status, body}. Records every call.
export function mockFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), init, body });
    const r = (await handler(String(url), init, body)) ?? { status: 200, body: { ok: true, result: { message_id: calls.length } } };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
