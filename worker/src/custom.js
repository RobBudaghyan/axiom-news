// Custom topics ("My topics", Step 13): readers add up to 3 topics of their own ("Colombia",
// "Formula 1"). Topics are SHARED: two readers who add "Colombia" (or "Colombian news") follow one
// row of custom_topics. A new name is checked ONCE by AI here, in the Worker (owner's choice: the
// answer in a few seconds): a sensible news topic, not nonsense, offensive or about a private
// person; its normalised name in four languages, an emoji, a definition for the AI passes, 2-5
// Google News searches and a topic boost cap (0-2). The hourly job (job/custom.py) then searches it.
//
// Before any AI call: input checks, the 3-topic limit, 5 checks per reader per day (the owner is
// exempt), the block list, an exact match with an existing topic (joined with no AI call) or with a
// main topic (refused), and the AI budget guard (src/guard.js: level 1 or more = "try again in a few
// minutes"). Every AI call is logged in ai_calls (kind topic_check) so the guard and Admin count it.
import TOPICS_CFG from "../../config/custom_topics.json" with { type: "json" };
import { DICTS, FORBIDDEN, LANGS, t, topicLabel } from "./i18n.js";
import { BUDGET, countStatement, guardState } from "./guard.js";

export { TOPICS_CFG };
const DAY = 86400;
export const CUSTOM_TAG = /^c\d+$/;
export const NAME_LANGS = ["en", "ru", "hy", "fr"];
const REASON_CODES = ["ok", "nonsense", "offensive", "private_person", "no_news", "too_broad"];
const MAX_REASON = 160, MAX_NAME = 40, MAX_DEFINITION = 300, MAX_QUERY = 120;

// ------------------------------------------------------------------ SQL

// A reader's custom topics, in the order they were added, switched on or off (`enabled`, Step 13
// fixes): a switched-off topic keeps its place in the list and its slot (it counts toward the 3),
// but it is not in the reader's digests and not searched for them.
export const FOLLOWED_SQL = `SELECT t.id, t.tag, t.names, t.emoji, t.boost_max, f.enabled FROM custom_follows f
JOIN custom_topics t ON t.id = f.topic_id WHERE f.user_id = ?1 AND t.tag IS NOT NULL ORDER BY f.at, t.id`;
export const followedStatement = (userId) => ({ sql: FOLLOWED_SQL, params: [userId] });
// The followed topics that are switched on (the ones digests use).
export const enabledOnly = (rows) => (rows ?? []).filter((r) => Number(r.enabled ?? 1) === 1);

// ------------------------------------------------------------------ names

// Typed text, cleaned: one line, NFKC, no control characters, single spaces.
export function cleanInput(s) {
  return String(s ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

// The form names are compared in: lower case, ё = е, accents and punctuation gone, single spaces.
export function normName(s) {
  return cleanInput(s).toLowerCase().replace(/ё/g, "е").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function parseJson(v, fallback) {
  if (v && typeof v === "object") return v;
  try { const x = JSON.parse(v ?? "null"); return x ?? fallback; } catch { return fallback; }
}

// The name a reader sees: their language, else English.
export function customName(row, lang) {
  const names = parseJson(row.names, {});
  return names[lang] || names.en || row.tag;
}

// What the Mini App shows: the topic's own emoji from the AI check (a neutral one only if it has
// none), its name in the reader's language, and its switch.
export const NEUTRAL_EMOJI = "🗞️";
const shownEmoji = (e) => (e && e !== "📌" ? e : NEUTRAL_EMOJI);
export const publicCustom = (rows, lang) => (rows ?? []).map((r) => ({ id: r.id, tag: r.tag, name: customName(r, lang),
  emoji: shownEmoji(r.emoji), on: Number(r.enabled ?? 1) === 1 }));

// Rows of custom topics in the shape of the `topics` table rows that digest.js topicInfoFrom reads
// (custom ones carry `names`, so the heading is in the reader's language).
export const asTopicRows = (rows) => (rows ?? []).map((r) => ({ tag: r.tag, label_en: customName(r, "en"),
  names: r.names, emoji: shownEmoji(r.emoji), custom: true }));

// Step 13 fixes (owner): no boost cap for custom topics. The reader chose the subject, so the
// editor's topic score is used as it is (digest.js topicScore); the 6 main topics keep their caps.

// A user row whose `topics` also lists their switched-on custom tags (digest selection treats both
// alike). Switched-off ones are left out.
export function withCustomTopics(user, all) {
  const rows = enabledOnly(all);
  if (!rows.length) return user;
  const main = parseJson(user.topics, []);
  return { ...user, topics: JSON.stringify([...main, ...rows.map((r) => r.tag).filter((x) => !main.includes(x))]) };
}

// ------------------------------------------------------------------ the AI check

export function editionList(cfg = TOPICS_CFG) {
  return Object.entries(cfg.editions).map(([k, e]) => `${k} (${e.name})`).join(", ");
}

export function checkPrompt({ input, lang, mainTopics, existing, now }, cfg = TOPICS_CFG) {
  const language = LANGS.english_names?.[lang] ?? "English";
  const mains = mainTopics.map((m) => `   - ${m.tag}: ${m.label_en}`).join("\n");
  const others = existing.length ? existing.map((e) => `   - ${e.tag}: ${customName(e, "en")}`).join("\n") : "   (none yet)";
  const today = new Date((now ?? Math.floor(Date.now() / 1000)) * 1000).toISOString().slice(0, 10);
  return `You check a news topic that a reader of a small Telegram news digest wants to follow.
The reader typed: ${JSON.stringify(input)}
The reader's language: ${language}. Today is ${today}.
Your knowledge may be out of date: a person, office holder, team or event you do not know may be new
and in the news now. Never reject a topic only because you do not recognise it or think it is not
current; judge whether it is the kind of thing news covers.

1. VERDICT. "accept" if it is a sensible topic that news outlets report on: a country, region or city;
   a field or issue (AI regulation, climate policy); a sport, league or team (Formula 1); a company or
   industry; a public figure (a politician, leader, celebrity or athlete known to the public through a
   public role). Otherwise "reject" with one reason_code:
   - nonsense: random letters, a joke, a question or request, words with no news meaning
   - offensive: insults, slurs, hateful or discriminatory topics, sexual content, topics that target a
     group or promote violence or crime
   - private_person: a private individual, someone with no public role ("my neighbour", an unknown name)
   - no_news: a real thing that news almost never covers ("my cat", "breakfast recipes")
   - too_broad: everything at once ("news", "the world", "all events")
   For "accept" the reason_code is "ok".
2. REASON. One short, polite sentence in ${language} for the reader, at most 120 characters. For a
   rejection say why, without repeating anything offensive. Never use the em dash or en dash.
3. SAME AS. Readers share topics. If the topic means the same as one of the topics below (the same
   subject in other words, a synonym, a translation, "Colombian news" for "Colombia"), give that tag;
   otherwise "". Only a clear match: a narrower or wider topic is different ("Bogota" is not "Colombia").
   MAIN TOPICS:
${mains}
   READER TOPICS:
${others}
4. For an accepted topic (also fill these when SAME AS matches):
   - names: the short normalised name, 1 to 4 words, no quotes, no emoji, in English, Russian,
     Armenian and French ("Colombian news" gives Colombia, Колумбия, Կոլումբիա, Colombie).
   - emoji: one emoji for the topic (a country's flag, a sport, an object).
   - definition: one English sentence saying which news belongs to this topic and which does not, for
     an AI that sorts news articles into topics.
   - queries: 2 to 5 Google News searches that find news on this topic, in the languages in which that
     news is mostly published, each with an edition from this list: ${editionList(cfg)}.
     Use the local edition for a local topic (Colombia: es_co) and English (en) too. Plain search
     words; OR between alternatives and quotes for an exact phrase are allowed.
   - boost_max: 0, 1 or 2: how much more an event matters to followers of this topic than to a general
     world-news reader. 2 for a country, region or a niche field that general news rarely covers; 1 for
     a field or story general news already covers well; 0 for a very broad topic.
Return JSON only, matching the schema.`;
}

export const CHECK_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["accept", "reject"] },
    reason_code: { type: "string", enum: REASON_CODES },
    reason: { type: "string" },
    same_as: { type: "string" },
    names: { type: "object", properties: { en: { type: "string" }, ru: { type: "string" }, hy: { type: "string" }, fr: { type: "string" } },
             required: ["en", "ru", "hy", "fr"] },
    emoji: { type: "string" },
    definition: { type: "string" },
    queries: { type: "array", items: { type: "object", properties: { q: { type: "string" }, ed: { type: "string" } }, required: ["q", "ed"] } },
    boost_max: { type: "integer" },
  },
  required: ["verdict", "reason_code", "reason", "same_as", "names", "emoji", "definition", "queries", "boost_max"],
};

// One line, no dashes (owner rule), cut at a word.
export function cleanText(s, max) {
  let x = cleanInput(s).replace(/\s+[‒–—―]\s+/g, ", ").replace(/[‒–—―]/g, "-").replace(/["«»“”]/g, "").trim();
  if (x.length > max) x = `${x.slice(0, max).replace(/\s+\S*$/, "")}...`;
  return x;
}

const EMOJI = /^(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\u{FE0F}|\u{20E3}|[\u{1F3FB}-\u{1F3FF}]|\u{200D}\p{Extended_Pictographic}\u{FE0F}?)*)$/u;
export function cleanEmoji(s) {
  const x = String(s ?? "").replace(/\s+/g, "");
  return x && x.length <= 16 && EMOJI.test(x) ? x : NEUTRAL_EMOJI;
}

// The answer, checked in code. Returns {verdict, reasonCode, reason, sameAs, names, emoji,
// definition, queries, boostMax} or null if it is unusable.
export function validateAnswer(data, lang, cfg = TOPICS_CFG) {
  if (!data || typeof data !== "object") return null;
  const verdict = data.verdict === "accept" ? "accept" : data.verdict === "reject" ? "reject" : null;
  if (!verdict) return null;
  const reasonCode = REASON_CODES.includes(data.reason_code) ? data.reason_code : verdict === "accept" ? "ok" : "nonsense";
  let reason = cleanText(data.reason, MAX_REASON);
  if (!reason || FORBIDDEN.test(reason)) reason = t(lang, `errors.topic_reason_${reasonCode === "ok" ? "nonsense" : reasonCode}`);
  const names = {};
  const raw = data.names && typeof data.names === "object" ? data.names : {};
  for (const l of NAME_LANGS) names[l] = cleanText(raw[l], MAX_NAME);
  if (!names.en) names.en = "";
  for (const l of NAME_LANGS) if (!names[l]) names[l] = names.en;
  const editions = cfg.editions;
  const seen = new Set();
  const queries = [];
  for (const q of Array.isArray(data.queries) ? data.queries : []) {
    const text = cleanText(q?.q, MAX_QUERY);
    const ed = editions[q?.ed] ? q.ed : "en";
    const key = `${ed}|${text.toLowerCase()}`;
    if (!text || seen.has(key)) continue;
    seen.add(key);
    queries.push({ q: text, ed });
    if (queries.length === 5) break;
  }
  if (verdict === "accept" && names.en && queries.length < 2 && !seen.has(`en|${names.en.toLowerCase()}`)) {
    queries.push({ q: names.en, ed: "en" });   // at least two searches
  }
  const boost = Math.round(Number(data.boost_max));
  return {
    verdict, reasonCode, reason, sameAs: String(data.same_as ?? "").trim(), names,
    emoji: cleanEmoji(data.emoji), definition: cleanText(data.definition, MAX_DEFINITION) || `News about ${names.en}.`,
    queries, boostMax: Number.isFinite(boost) ? Math.max(0, Math.min(2, boost)) : 0,
  };
}

// ------------------------------------------------------------------ providers

const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models";
const GROQ = "https://api.groq.com/openai/v1/chat/completions";

// The providers this Worker can use, in order (the same chain as the hourly job). A provider
// without its key is skipped.
export function providers(env) {
  const out = [];
  if (env.GEMINI_API_KEY) {
    out.push({ name: "gemini", model: env.GEMINI_MODEL || "gemini-3.5-flash-lite" });
    out.push({ name: "gemini", model: env.GEMINI_FALLBACK_MODEL || "gemini-3.1-flash-lite" });
  }
  if (env.GROQ_API_KEY) out.push({ name: "groq", model: env.GROQ_MODEL || "openai/gpt-oss-120b" });
  return out;
}

async function post(url, headers, body, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body), signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// One call. Returns {ok, text, in, out, code, error}.
async function callOne(p, env, prompt, timeoutMs) {
  let res;
  try {
    res = p.name === "gemini"
      ? await post(`${GEMINI}/${p.model}:generateContent`, { "x-goog-api-key": env.GEMINI_API_KEY }, {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 2048, responseMimeType: "application/json",
            responseJsonSchema: CHECK_SCHEMA, thinkingConfig: { thinkingLevel: "low" } },
        }, timeoutMs)
      : await post(GROQ, { authorization: `Bearer ${env.GROQ_API_KEY}` }, {
          model: p.model, temperature: 0.2, max_completion_tokens: 2048, reasoning_effort: "low",
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_schema", json_schema: { name: "topic_check", schema: CHECK_SCHEMA } },
        }, timeoutMs);
  } catch (e) {
    return { ok: false, code: null, error: `${p.name}: network error ${e.name === "AbortError" ? "timeout" : e.name}` };
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (res.status !== 200) {
    const msg = String(data?.error?.message ?? data?.error ?? "").slice(0, 200);
    return { ok: false, code: res.status, error: `${p.name}: HTTP ${res.status}: ${msg}` };
  }
  if (p.name === "gemini") {
    const u = data?.usageMetadata ?? {};
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.filter((x) => !x.thought).map((x) => x.text ?? "").join("");
    return { ok: !!text.trim(), text, in: u.promptTokenCount ?? null,
             out: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), code: null,
             error: text.trim() ? null : `gemini: empty answer (${data?.candidates?.[0]?.finishReason ?? "no candidates"})` };
  }
  const text = data?.choices?.[0]?.message?.content ?? "";
  return { ok: !!text.trim(), text, in: data?.usage?.prompt_tokens ?? null, out: data?.usage?.completion_tokens ?? null,
           code: null, error: text.trim() ? null : "groq: empty answer" };
}

function parseAnswer(text) {
  let s = String(text ?? "").trim();
  if (s.startsWith("```")) s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  return JSON.parse(s);
}

// Asks each provider in turn until one gives a usable answer. Returns {answer, calls}: calls are
// ai_calls rows to write (every attempt, kind topic_check).
export async function askAI(env, prompt, lang, now, opts = {}) {
  const calls = [];
  const timeoutMs = opts.timeoutMs ?? 12000;
  for (const p of providers(env)) {
    const t0 = Date.now();
    const r = await callOne(p, env, prompt, timeoutMs);
    let answer = null, error = r.error;
    if (r.ok) {
      try { answer = validateAnswer(parseAnswer(r.text), lang); if (!answer) error = `${p.name}: unusable answer`; }
      catch { error = `${p.name}: invalid JSON`; }
    }
    calls.push({ at: now, provider: p.name, model: p.model, ok: answer ? 1 : 0, input_tokens: r.in ?? null,
                 output_tokens: r.out ?? null, ms: Date.now() - t0, error: answer ? null : error, code: r.code ?? null });
    if (answer) return { answer, calls };
  }
  return { answer: null, calls };
}

export function aiCallStatements(calls) {
  return calls.map((c) => ({
    sql: "INSERT INTO ai_calls (at, provider, model, ok, items, input_tokens, output_tokens, ms, error, kind, code) " +
         "VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8, 'topic_check', ?9)",
    params: [c.at, c.provider, c.model, c.ok, c.input_tokens, c.output_tokens, c.ms, c.error ? String(c.error).slice(0, 500) : null, c.code],
  }));
}

// ------------------------------------------------------------------ the flow

const checkRow = (userId, now, input, outcome, topicId, reason, ai) => ({
  sql: "INSERT INTO topic_checks (user_id, at, input, outcome, topic_id, reason, ai) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  params: [userId, now, String(input).slice(0, 80), outcome, topicId ?? null, reason ? String(reason).slice(0, 300) : null, ai ? 1 : 0],
});

const followRows = (userId, topicId, now) => [
  { sql: "INSERT INTO custom_follows (user_id, topic_id, at) VALUES (?1, ?2, ?3) ON CONFLICT(user_id, topic_id) DO NOTHING",
    params: [userId, topicId, now] },
  { sql: "UPDATE custom_topics SET orphan_since = NULL WHERE id = ?1", params: [topicId] },
];

function addAlias(topic, norm) {
  const aliases = parseJson(topic.aliases, []);
  if (aliases.includes(norm) || aliases.length >= 30) return null;
  return { sql: "UPDATE custom_topics SET aliases = ?1 WHERE id = ?2", params: [JSON.stringify([...aliases, norm]), topic.id] };
}

// Every name a topic is known by, normalised.
export function topicNorms(topic) {
  const names = parseJson(topic.names, {});
  return new Set([...Object.values(names).map(normName), ...parseJson(topic.aliases, [])].filter(Boolean));
}

// The main topic whose label (in any language) is this name, or null.
export function mainMatch(norm, mainTopics) {
  for (const m of mainTopics) {
    const labels = [m.label_en, ...Object.keys(DICTS).map((l) => topicLabel(l, m.tag, m.label_en))];
    if (labels.some((x) => normName(x) === norm)) return m;
  }
  return null;
}

// POST /api/topics/add {name}. ctx: {db, env, user (users row), lang, now, isOwner, mainTopics,
// cfg, budget}. Returns {status, result: {kind, name?, reason?}} or throws a code (400) for bad input.
// kind: added, joined, rejected, main_topic, delayed, failed. The caller returns the new state.
export async function addTopic(ctx, body) {
  const { db, env, user, lang, now, isOwner, mainTopics } = ctx;
  const cfg = ctx.cfg ?? TOPICS_CFG;
  const input = cleanInput(body?.name);
  const tooLong = [...input].length > cfg.name_max;
  if (!input || [...input].length < cfg.name_min || tooLong || !/\p{L}/u.test(input)) {
    return { error: tooLong ? "topic_long" : "topic_short", vars: { max: cfg.name_max } };
  }
  const norm = normName(input);
  const [followed, [{ n: checks } = { n: 0 }], blocked, existing] = await db.batch([
    followedStatement(user.id),
    { sql: "SELECT count(*) AS n FROM topic_checks WHERE user_id = ?1 AND at >= ?2 AND ai = 1", params: [user.id, now - DAY] },
    { sql: "SELECT norm FROM topic_blocks", params: [] },
    { sql: "SELECT id, tag, names, aliases, emoji, boost_max FROM custom_topics WHERE tag IS NOT NULL ORDER BY id", params: [] },
  ]);
  if (followed.length >= cfg.max_per_user) return { error: "topic_limit", vars: { max: cfg.max_per_user } };
  const blocks = new Set(blocked.map((b) => b.norm));
  const result = async (kind, extra, writes = []) => {
    await db.batch(writes);
    return { result: { kind, ...extra } };
  };
  if (blocks.has(norm)) {
    const reason = t(lang, "errors.topic_reason_blocked");
    return result("rejected", { reason }, [checkRow(user.id, now, input, "blocked", null, reason, false)]);
  }
  // 1. the same name as an existing custom topic: join it, no AI call
  const same = existing.find((e) => topicNorms(e).has(norm));
  if (same) return join(ctx, same, input, norm, followed, false, result);
  // 2. a main topic: refused (owner)
  const main = mainMatch(norm, mainTopics);
  if (main) return refuseMain(ctx, main, input, false, result);
  // 3. the daily limit (owner exempt) and the AI guard
  if (!isOwner && checks >= cfg.checks_per_day) return { error: "topic_checks_limit", vars: { max: cfg.checks_per_day } };
  const [rows] = await db.batch([countStatement(now, ctx.budget ?? BUDGET)]);
  const g = guardState(rows, now, ctx.budget ?? BUDGET);
  if (g.level >= 1) {
    const reason = t(lang, "errors.topic_later");
    return result("delayed", { reason }, [checkRow(user.id, now, input, "delayed", null, g.reasons.join("; "), false)]);
  }
  // 4. one AI call (Gemini, its second model, then Groq)
  const prompt = checkPrompt({ input, lang, mainTopics, existing, now }, cfg);
  const { answer, calls } = await (ctx.ask ?? askAI)(env, prompt, lang, now);
  const logs = aiCallStatements(calls);
  if (!answer) {
    const reason = t(lang, "errors.topic_later");
    return result("failed", { reason }, [...logs, checkRow(user.id, now, input, "failed", null, calls.map((c) => c.error).join("; "), true)]);
  }
  const a = answer;
  if (a.sameAs) {
    const m = mainTopics.find((x) => x.tag === a.sameAs);
    if (m) return refuseMain(ctx, m, input, true, result, logs);
    const c = existing.find((x) => x.tag === a.sameAs);
    if (c) return join(ctx, c, input, norm, followed, true, result, logs);
  }
  if (a.verdict === "reject" || !a.names.en) {
    return result("rejected", { reason: a.reason }, [...logs, checkRow(user.id, now, input, "rejected", null, `${a.reasonCode}: ${a.reason}`, true)]);
  }
  const norms = new Set([norm, ...Object.values(a.names).map(normName)]);
  if ([...norms].some((x) => blocks.has(x))) {
    const reason = t(lang, "errors.topic_reason_blocked");
    return result("rejected", { reason }, [...logs, checkRow(user.id, now, input, "blocked", null, reason, true)]);
  }
  // the normalised name may be an existing topic the AI did not name (or one made a moment ago)
  const byName = existing.find((e) => [...norms].some((x) => topicNorms(e).has(x)));
  if (byName) return join(ctx, byName, input, norm, followed, true, result, logs);
  const m2 = [...norms].map((x) => mainMatch(x, mainTopics)).find(Boolean);
  if (m2) return refuseMain(ctx, m2, input, true, result, logs);
  // 5. a new shared topic
  const aliases = [...new Set([norm].filter((x) => !Object.values(a.names).map(normName).includes(x)))];
  await db.batch([
    ...logs,
    { sql: "INSERT INTO custom_topics (names, emoji, definition, queries, boost_max, aliases, created_by, created_at) " +
           "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      params: [JSON.stringify(a.names), a.emoji, a.definition, JSON.stringify(a.queries), a.boostMax,
               JSON.stringify(aliases), user.id, now] },
    { sql: "UPDATE custom_topics SET tag = 'c' || id WHERE id = last_insert_rowid()", params: [] },
    { sql: "INSERT INTO custom_follows (user_id, topic_id, at) VALUES (?1, last_insert_rowid(), ?2)", params: [user.id, now] },
    { sql: "INSERT INTO topic_checks (user_id, at, input, outcome, topic_id, reason, ai) " +
           "VALUES (?1, ?2, ?3, 'accepted', last_insert_rowid(), ?4, 1)", params: [user.id, now, input.slice(0, 80), a.reason] },
  ]);
  return { result: { kind: "added", name: a.names[lang] || a.names.en } };
}

async function join(ctx, topic, input, norm, followed, ai, result, logs = []) {
  const { user, lang, now } = ctx;
  const name = customName(topic, lang);
  if (followed.some((f) => f.id === topic.id)) return { error: "topic_have", vars: { name } };
  const alias = addAlias(topic, norm);
  return result("joined", { name }, [...logs, ...followRows(user.id, topic.id, now), ...(alias ? [alias] : []),
    checkRow(user.id, now, input, "joined", topic.id, null, ai)]);
}

async function refuseMain(ctx, main, input, ai, result, logs = []) {
  const { user, lang, now } = ctx;
  const reason = t(lang, "errors.topic_main", { name: topicLabel(lang, main.tag, main.label_en) });
  return result("main_topic", { reason }, [...logs, checkRow(user.id, now, input, "main_topic", null, main.tag, ai)]);
}

// POST /api/topics/switch {id, on}: switch a followed topic on or off. It stays in the list, so it
// keeps its slot, and the topic is never orphaned by this (the 7-day clock counts follow rows, on
// or off).
export function switchStatement(userId, topicId, on) {
  return { sql: "UPDATE custom_follows SET enabled = ?3 WHERE user_id = ?1 AND topic_id = ?2", params: [userId, topicId, on ? 1 : 0] };
}

// POST /api/topics/remove {id}: stop following (edit mode). The last follower leaving (no follow
// row at all, on or off) starts the 7-day clock (orphan_since); the hourly job deletes the topic
// after that.
export function removeStatements(userId, topicId, now) {
  return [
    { sql: "DELETE FROM custom_follows WHERE user_id = ?1 AND topic_id = ?2", params: [userId, topicId] },
    { sql: "UPDATE custom_topics SET orphan_since = ?2 WHERE id = ?1 AND orphan_since IS NULL AND " +
           "NOT EXISTS (SELECT 1 FROM custom_follows f WHERE f.topic_id = ?1)", params: [topicId, now] },
  ];
}

// ------------------------------------------------------------------ Admin (owner only)

export function customAdminStatements(now) {
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  return [
    { sql: `SELECT t.id, t.tag, t.names, t.emoji, t.queries, t.boost_max, t.created_at, t.searched_at, t.orphan_since,
  (SELECT count(*) FROM custom_follows f WHERE f.topic_id = t.id) AS followers,
  (SELECT count(*) FROM custom_follows f JOIN users u ON u.id = f.user_id WHERE f.topic_id = t.id AND f.enabled = 1 AND u.paused = 0 AND u.blocked = 0) AS active,
  d.searches, d.fetched, d.dup_dropped, d.new_items
FROM custom_topics t LEFT JOIN custom_topic_days d ON d.topic_id = t.id AND d.day = ?1 ORDER BY t.id`, params: [day] },
    { sql: "SELECT x.value AS tag, count(*) AS stories, sum(s.main_topic = x.value) AS main FROM stories s, json_each(s.topics) x " +
           "WHERE s.created_at >= ?1 AND s.merged_into IS NULL AND x.value GLOB 'c[0-9]*' GROUP BY x.value", params: [now - DAY] },
    { sql: "SELECT j.value AS tag, count(*) AS sent FROM sent x JOIN stories s ON s.id = x.story_id, json_each(s.topics) j " +
           "WHERE x.sent_at >= ?1 AND j.value GLOB 'c[0-9]*' GROUP BY j.value", params: [now - DAY] },
    { sql: "SELECT outcome, count(*) AS n FROM topic_checks WHERE at >= ?1 GROUP BY outcome", params: [now - DAY] },
    { sql: "SELECT c.at, c.input, c.outcome, c.reason, u.first_name FROM topic_checks c LEFT JOIN users u ON u.id = c.user_id " +
           "ORDER BY c.id DESC LIMIT 10", params: [] },
    { sql: "SELECT norm, name, at FROM topic_blocks ORDER BY at DESC LIMIT 30", params: [] },
    countStatement(now),
    { sql: "SELECT key, value FROM meta WHERE key IN ('ai_guard', 'ai_guard_alert_day')", params: [] },
  ];
}
export const CUSTOM_ADMIN_COUNT = 8;

export function shapeCustomAdmin(rows, now, budget = BUDGET) {
  const [topics, stories, sent, outcomes, recent, blocks, counts, meta] = rows;
  const S = new Map(stories.map((r) => [r.tag, r]));
  const X = new Map(sent.map((r) => [r.tag, r]));
  const M = Object.fromEntries(meta.map((r) => [r.key, r.value]));
  const live = guardState(counts, now, budget);
  const job = parseJson(M.ai_guard, null);
  return {
    topics: topics.map((r) => ({
      id: r.id, tag: r.tag, name: customName(r, "en"), emoji: r.emoji || "", boost_max: Number(r.boost_max ?? 0),
      queries: parseJson(r.queries, []), followers: Number(r.followers ?? 0), active: Number(r.active ?? 0),
      created_at: r.created_at, searched_at: r.searched_at ?? null, orphan_since: r.orphan_since ?? null,
      today: { searches: Number(r.searches ?? 0), fetched: Number(r.fetched ?? 0), dup_dropped: Number(r.dup_dropped ?? 0),
               new_items: Number(r.new_items ?? 0) },
      stories_24h: Number(S.get(r.tag)?.stories ?? 0), main_24h: Number(S.get(r.tag)?.main ?? 0),
      sent_24h: Number(X.get(r.tag)?.sent ?? 0),
    })),
    checks_24h: Object.fromEntries(outcomes.map((r) => [r.outcome, Number(r.n)])),
    recent_checks: recent.map((r) => ({ at: r.at, input: r.input, outcome: r.outcome, reason: r.reason ?? "", name: r.first_name ?? "" })),
    blocks: blocks.map((b) => ({ norm: b.norm, name: b.name ?? b.norm, at: b.at })),
    guard: {
      level: live.level, reasons: live.reasons, day: live.day,
      models: Object.entries(live.counts).map(([model, c]) => ({ model, ...c, soft_limit: budget.soft_limits?.[model] ?? null })),
      translate_delayed: !!(job && job.day === live.day && job.translate_delayed),
      job_level: job && job.day === live.day ? Number(job.level ?? 0) : 0,
      job_at: job?.at ?? null,
      alerted_day: M.ai_guard_alert_day ?? null,
    },
  };
}

// POST /api/admin/topic {id, action: "delete" | "block"}. Block also puts every name and alias of
// the topic on the block list, so it cannot be created again.
export function adminTopicStatements(topic, action, now) {
  const out = [];
  if (action === "block") {
    for (const norm of topicNorms(topic)) {
      out.push({ sql: "INSERT INTO topic_blocks (norm, name, at) VALUES (?1, ?2, ?3) ON CONFLICT(norm) DO NOTHING",
                 params: [norm, customName(topic, "en"), now] });
    }
  }
  out.push(
    { sql: "DELETE FROM custom_follows WHERE topic_id = ?1", params: [topic.id] },
    { sql: "DELETE FROM custom_topic_days WHERE topic_id = ?1", params: [topic.id] },
    { sql: "DELETE FROM custom_topics WHERE id = ?1", params: [topic.id] },
  );
  return out;
}

// ------------------------------------------------------------------ the guard alert (hourly tick)

// Once per Pacific day, if the guard is above level 0 (live counts or the job's last state).
export function guardAlert(countRows, metaRows, now, budget = BUDGET) {
  const live = guardState(countRows, now, budget);
  const M = Object.fromEntries((metaRows ?? []).map((r) => [r.key, r.value]));
  const job = parseJson(M.ai_guard, null);
  const jobLevel = job && job.day === live.day ? Number(job.level ?? 0) : 0;
  const level = Math.max(live.level, jobLevel);
  if (!level || M.ai_guard_alert_day === live.day) return null;
  const what = level >= 2 ? "new topic checks and translations are delayed (pass 1 and the editor still run)"
    : "new topic checks are delayed (translations, pass 1 and the editor still run)";
  const reasons = [...new Set([...live.reasons, ...(jobLevel ? job.reasons ?? [] : [])])].join("; ");
  return {
    text: `Axiom News AI budget: level ${level}: ${what}. Why: ${reasons || "see Admin"}. ` +
      "Gemini's free day resets at midnight Pacific time. Details in Admin under AI budget. This is the only such alert today.",
    writes: [{ sql: "INSERT INTO meta (key, value) VALUES ('ai_guard_alert_day', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
               params: [live.day] }],
  };
}
