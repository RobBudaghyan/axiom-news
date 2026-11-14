// Digest building: the ONE place for selection, topic cap, near-duplicate removal, message
// format and time-slot math. Used by the Worker cron (src/cron.js), the Admin "digest now" button
// (src/api.js) and the local tool (scripts/digest-cli.mjs), so all behave identically. Pure
// functions only: no I/O. Settings live in config/digest.json.
//
// Scores (Step 5): the editor pass (job/editor.py) gives each story a strict `final_score`. A
// story it has not scored (its call failed, or the story is weak) uses its first-pass importance
// minus `unedited_offset`, so digests still work, just less well, when the editor is down.
import CONFIG from "../../config/digest.json" with { type: "json" };
import LINE_EMOJI from "../../config/line_emoji.json" with { type: "json" };

export { CONFIG };

const DAY = 86400;

// ------------------------------------------------------------------ selection (SQL)

// Candidates for one user: on one of the user's topics, scoring at least the topic bar (the lower
// of the two bars), created or updated since the last digest (at most 24 h back), not merged into
// another story by the editor, never sent to this user. Best score first, then most recent.
// Near-duplicates (dup_group), the bars, the topic guarantee and the cap follow in pickStories.
export const CANDIDATE_SQL = `
SELECT s.id, s.summary, s.headline, s.description, s.emojis, s.best_url, s.best_source, s.importance,
       s.final_score, s.topics, s.main_topic, s.updated_at, s.dup_group
FROM stories s
WHERE s.updated_at >= ?3
  AND s.merged_into IS NULL
  AND coalesce(s.final_score, s.importance - ?6) >= ?5
  AND EXISTS (SELECT 1 FROM json_each(s.topics) t
              WHERE t.value IN (SELECT u.value FROM json_each(?2) u))
  AND NOT EXISTS (SELECT 1 FROM sent x WHERE x.user_id = ?1 AND x.story_id = s.id)
ORDER BY coalesce(s.final_score, s.importance - ?6) DESC, s.updated_at DESC, s.id DESC
LIMIT ?4`;

export function digestSince(lastDigestAt, now, cfg = CONFIG) {
  const floor = now - cfg.max_lookback_hours * 3600;
  return lastDigestAt ? Math.max(lastDigestAt, floor) : floor;
}

export function parseList(value, fallback = []) {
  if (Array.isArray(value)) return value;
  try {
    const v = JSON.parse(value ?? "null");
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function candidateStatement(user, now, cfg = CONFIG) {
  return {
    sql: CANDIDATE_SQL,
    params: [user.id, JSON.stringify(parseList(user.topics)), digestSince(user.last_digest_at, now, cfg),
             cfg.candidate_limit, cfg.topic_bar, cfg.unedited_offset],
  };
}

export function storyScore(s, cfg = CONFIG) {
  return s.final_score ?? (s.importance ?? 0) - cfg.unedited_offset;
}

// ------------------------------------------------------------------ topic cap

// At most this many stories from one topic in a digest of n stories (40%, at least 2).
export function topicCap(n, cfg = CONFIG) {
  return Math.max(cfg.min_topic_cap ?? 2, Math.ceil(cfg.max_topic_share * n - 1e-9));   // 0.4 * 15 = 6.000000000000001
}

const rankOf = (specificity) => (t) => {
  const i = specificity.indexOf(t);
  return i < 0 ? specificity.length : i;
};

// The topic a story is shown under and counted against: the one the editor says it is mainly
// about, if the user follows it; otherwise its most specific topic among the user's topics.
export function primaryTopic(storyTopics, userTopics, specificity = CONFIG.topic_specificity, main = null) {
  if (main && userTopics.includes(main) && storyTopics.includes(main)) return main;
  const mine = storyTopics.filter((t) => userTopics.includes(t));
  const pool = mine.length ? mine : storyTopics;
  const rank = rankOf(specificity);
  return [...pool].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

// ------------------------------------------------------------------ the pick

// Near-duplicates are found by the hourly job (job/dupes.py, no AI, no CPU limit there) and
// stored as stories.dup_group = the id of the group's most important story; the editor's merges
// are already gone in SQL (merged_into). Here we only keep the first candidate of each group.
export function dedupe(candidates) {
  const seen = new Set();
  const kept = [], dropped = [];
  for (const c of candidates) {
    const g = c.dup_group ?? `own:${c.id}`;
    if (seen.has(g)) dropped.push(c);
    else { seen.add(g); kept.push(c); }
  }
  return { kept, dropped };
}

// candidates: rows from CANDIDATE_SQL. Returns the digest's stories, best first, each with
// `primary` (the topic it is shown under and counted against) and `score`. No fixed count:
//  1. every story that clears the editorial bar, best first;
//  2. every topic the user follows gets its own section: if no story above is shown under it,
//     its best remaining story is added if it clears the (lower) topic bar. "Remaining" matters:
//     one strong story is often tagged with four topics (a Trump-Putin-Xi summit: politics,
//     Russia, Iran war, wars) but is shown under only one of them;
//  3. at most max_stories, the guaranteed ones first; no topic may have more than topicCap(N)
//     stories, N being the size actually picked;
//  4. nothing qualifies: an empty list (the quiet note).
export function pickStories(candidates, userTopics, cfg = CONFIG) {
  const rank = rankOf(cfg.topic_specificity);
  const pool = dedupe(candidates).kept
    .map((c, i) => {
      const tags = parseList(c.topics);
      return { ...c, i, tags, score: storyScore(c, cfg),
               primary: primaryTopic(tags, userTopics, cfg.topic_specificity, c.main_topic) };
    })
    .filter((s) => s.score >= cfg.topic_bar)
    .sort((a, b) => b.score - a.score || a.i - b.i);

  const strong = pool.filter((s) => s.score >= cfg.editorial_bar);
  const used = new Set(strong.map((s) => s.id));
  const covered = new Set(strong.map((s) => s.primary));
  const guaranteed = [];
  for (const t of [...userTopics].sort((a, b) => rank(a) - rank(b))) {
    if (covered.has(t)) continue;
    const best = pool.find((s) => s.tags.includes(t) && !used.has(s.id));
    if (!best) continue;
    used.add(best.id);
    covered.add(t);
    guaranteed.push({ ...best, primary: t, guaranteed: true });
  }
  // A strong story whose own topic is covered anyway stays in the normal fill; the strong stories
  // that alone give a topic its section are guaranteed too.
  const firstOfTopic = new Map();
  for (const s of strong) if (!firstOfTopic.has(s.primary)) firstOfTopic.set(s.primary, s.id);
  const topStrong = strong.filter((s) => firstOfTopic.get(s.primary) === s.id && userTopics.includes(s.primary))
    .map((s) => ({ ...s, guaranteed: true }));
  const rest = strong.filter((s) => !topStrong.some((x) => x.id === s.id));
  guaranteed.unshift(...topStrong);

  // 2-3. fill up to max_stories under the cap. A smaller digest has a smaller cap, so the target
  //      shrinks until the cap for the size actually picked holds.
  let n = Math.min(cfg.max_stories, guaranteed.length + rest.length);
  let chosen;
  for (;;) {
    const cap = topicCap(n, cfg);
    const counts = new Map();
    chosen = [];
    for (const s of [...guaranteed, ...rest]) {
      if (chosen.length >= n) break;
      const k = counts.get(s.primary) ?? 0;
      if (k >= cap) continue;
      chosen.push(s);
      counts.set(s.primary, k + 1);
    }
    if (chosen.length >= n) break;
    n = chosen.length;
  }
  return chosen.sort((a, b) => b.score - a.score || a.i - b.i);
}

// ------------------------------------------------------------------ message

export const FORBIDDEN = /[—–]/;   // owner rule: never the em dash (nor the en dash)
const MAX_HEADLINE = 250, MAX_DESCRIPTION = 450;

export function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function cut(text, max) {
  return text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, "")}...`;
}

// Same rules as job/ai.py clean_summary: one line, no em/en dash.
export function cleanText(text) {
  return String(text ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+[—–]\s+/g, ", ")
    .replace(/[—–]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}
// Headlines also lose a trailing period.
export function cleanHeadline(text) {
  return cut(cleanText(text).replace(/[.\s]+$/, ""), MAX_HEADLINE);
}

// Length the way Telegram counts it: text after entity parsing (tags removed, entities
// decoded), in UTF-16 units, which is what JS string length measures.
export function visibleLength(html) {
  return html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&").length;
}

export function greeting(hour) {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

// "2 PM", "2:30 PM", "12 PM" (noon), "12 AM" (midnight).
export function clock12(p) {
  const h = p.hour % 12 || 12;
  const ap = p.hour < 12 ? "AM" : "PM";
  return p.minute ? `${h}:${String(p.minute).padStart(2, "0")} ${ap}` : `${h} ${ap}`;
}

// "Good evening, Sam. Since 2 PM, 6 stories for you:" (no name if Telegram gave none). The first
// digest, or one after more than 24 h, says "In the last 24 hours".
function header(count, { now, tz, lastDigestAt, name }, cfg) {
  const first = String(name ?? "").trim().slice(0, 32);
  const hello = `${greeting(localParts(now, tz).hour)}${first ? `, ${escapeHtml(first)}` : ""}`;
  const recent = lastDigestAt && now - lastDigestAt <= cfg.max_lookback_hours * 3600;
  const since = recent ? `since ${clock12(localParts(lastDigestAt, tz))}` : "in the last 24 hours";
  if (!count) return `${hello}. Quiet period: nothing important on your topics ${since}.`;
  return `${hello}. ${since[0].toUpperCase()}${since.slice(1)}, ${count} ${count === 1 ? "story" : "stories"} for you:`;
}

// ------------------------------------------------------------------ fallback line emoji

// Used only when the editor gave a story no emojis (its call failed, or it was not edited):
// the flag of the FIRST country, leader, capital or group the headline names
// (config/line_emoji.json; "Donald Trump's envoys..." gets the US flag); if none, the first
// subject icon (ceasefire, strike, election, court, ...); if none, the topic's emoji. A
// dictionary lookup of 1-4 word phrases (a 660-word regex cost 3.6 ms just to build, a third of
// the Worker's CPU budget); at each word the longest phrase wins.
const WORDS_RE = /[\p{L}\p{N}][\p{L}\p{N}.'’+]*/gu;   // hyphens split ("US-Iran" -> US, Iran)
const MAX_PHRASE = 4;

const keyOf = (phrase) => phrase.replace(/-/g, " ");

function buildList(groups, ci) {
  const map = new Map();
  for (const g of groups) {
    for (const w of g.words) {
      const k = keyOf(ci ? w.toLowerCase() : w);
      if (!map.has(k)) map.set(k, g.emoji);
    }
  }
  return { map, ci };
}

// "Russia's" -> "Russia", "U.S." stays (it is in the list), "Russia." -> "Russia", "OPEC+" -> "OPEC"
function variants(token) {
  const out = [token];
  const noPoss = token.replace(/['’]s$/, "");
  if (noPoss !== token) out.push(noPoss);
  const trimmed = noPoss.replace(/[.'’+]+$/, "");
  if (trimmed !== noPoss) out.push(trimmed);
  return out;
}

function firstMatch(tokens, list) {
  for (let i = 0; i < tokens.length; i++) {
    for (let n = Math.min(MAX_PHRASE, tokens.length - i); n >= 1; n--) {
      const head = tokens.slice(i, i + n - 1).join(" ");
      for (const last of variants(tokens[i + n - 1])) {
        const phrase = head ? `${head} ${last}` : last;
        const hit = list.map.get(list.ci ? phrase.toLowerCase() : phrase);
        if (hit) return hit;
      }
    }
  }
  return null;
}

let lists = null;

export function lineEmoji(headline, fallback = "") {
  lists ??= [buildList(LINE_EMOJI.actors, false), buildList(LINE_EMOJI.subjects, true)];
  const tokens = String(headline ?? "").match(WORDS_RE) ?? [];
  for (const l of lists) {
    const hit = firstMatch(tokens, l);
    if (hit) return hit;
  }
  return fallback;
}

// ------------------------------------------------------------------ building the messages

// "<n>. <emojis> <b>headline</b>", a blank line, the description, then the outlet as a link.
function storyBlock(n, s) {
  const emojis = s.emojis || s.fallbackEmoji;
  const head = `${n}. ${emojis ? `${emojis} ` : ""}<b>${escapeHtml(s.headline)}</b>`;
  const desc = s.description ? `\n\n${escapeHtml(s.description)}` : "";
  return `${head}${desc}\n<a href="${escapeAttr(s.best_url)}">${escapeHtml(s.best_source)}</a>`;
}

const headingOf = (t) => `${t.emoji ? `${t.emoji} ` : ""}<b><u>${escapeHtml(t.label)}</u></b>`;

// topics: rows of the D1 `topics` table. Returns {tag: {label, emoji}}.
export function topicInfoFrom(topics) {
  const out = {};
  for (const t of topics ?? []) out[t.tag] = { label: t.label_en ?? t.label ?? t.tag, emoji: t.emoji ?? "" };
  return out;
}

// Topic groups in the order of their best story; the numbering runs on across groups.
function groupsOf(stories, topicInfo) {
  const groups = new Map();
  for (const s of stories) {
    if (!groups.has(s.primary)) groups.set(s.primary, []);
    groups.get(s.primary).push(s);
  }
  let n = 0;
  return [...groups].map(([tag, list]) => ({
    heading: headingOf(topicInfo[tag] ?? { label: tag, emoji: "" }),
    blocks: list.map((s) => ({ id: s.id, text: storyBlock(++n, s) })),
  }));
}

// Builds the digest as one or more Telegram messages. One over the budget (Telegram allows 4,096
// characters as it counts them) is split at a topic heading, or between two stories when one
// topic alone is too long; no story is dropped for length.
// Returns {parts: [html], partStories: [[story id]], stories}.
export function buildMessage(stories, opts, cfg = CONFIG) {
  const topicInfo = opts.topicInfo ?? {};
  const budget = cfg.message_char_budget;
  const list = stories.map((s) => {
    const headline = cleanHeadline(s.headline || s.summary);
    return {
      ...s, headline,
      description: s.description ? cut(cleanText(s.description), MAX_DESCRIPTION) : "",
      fallbackEmoji: lineEmoji(headline, topicInfo[s.primary]?.emoji),
    };
  });
  const parts = [], partStories = [];
  let text = (opts.label ? `${opts.label}\n\n` : "") + header(list.length, opts, cfg);
  let ids = [];
  const add = (piece) => { text = text ? `${text}\n\n${piece}` : piece; };
  const fits = (piece) => visibleLength(text ? `${text}\n\n${piece}` : piece) <= budget;
  const flush = () => { parts.push(text); partStories.push(ids); text = ""; ids = []; };
  for (const g of groupsOf(list, topicInfo)) {
    const whole = [g.heading, ...g.blocks.map((b) => b.text)].join("\n\n");
    if (!fits(whole) && ids.length) flush();        // start a new message at this topic
    if (fits(whole)) {
      add(whole);
      ids.push(...g.blocks.map((b) => b.id));
      continue;
    }
    add(g.heading);                                 // this topic alone is too long
    for (const b of g.blocks) {
      if (!fits(b.text) && ids.length) flush();
      add(b.text);
      ids.push(b.id);
    }
  }
  flush();
  for (const p of parts) {
    if (FORBIDDEN.test(p)) throw new Error("em/en dash in user-facing text");
    if (visibleLength(p) > 4096) throw new Error(`message too long (${visibleLength(p)})`);
  }
  return { parts, partStories, stories: list };
}

// One user's whole digest from candidate rows: pick, then format. No I/O.
export function planDigest(user, candidates, topics, now, cfg = CONFIG, opts = {}) {
  const picked = pickStories(candidates, parseList(user.topics), cfg);
  const tz = user.timezone || cfg.default_timezone;
  const msg = buildMessage(picked, {
    now, tz, lastDigestAt: user.last_digest_at, name: user.first_name, topicInfo: topicInfoFrom(topics),
    label: opts.label,
  }, cfg);
  const times = parseList(user.digest_times, cfg.default_times);
  return { ...msg, nextAt: nextSlot(now, tz, times) };
}

// D1 writes after a successful send: never-twice rows, the digest time, the next slot.
// last_digest_at is the slot time (so the next header reads "Since 2 PM", not "2:03 PM").
export function afterSendStatements(user, storyIds, now, nextAt) {
  const slot = user.next_digest_at && user.next_digest_at <= now ? user.next_digest_at : now;
  return [
    ...storyIds.map((sid) => ({
      sql: "INSERT INTO sent (user_id, story_id, sent_at) VALUES (?1, ?2, ?3) ON CONFLICT(user_id, story_id) DO NOTHING",
      params: [user.id, sid, now],
    })),
    { sql: "UPDATE users SET last_digest_at = ?1, next_digest_at = ?2 WHERE id = ?3", params: [slot, nextAt, user.id] },
  ];
}

// ------------------------------------------------------------------ time zones

const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }));
  }
  return fmtCache.get(tz);
}

export function localParts(ts, tz) {
  const p = {};
  for (const { type, value } of fmt(tz).formatToParts(new Date(ts * 1000))) p[type] = value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, second: +p.second };
}

export function hhmm(p) {
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

function offsetAt(ts, tz) {
  const p = localParts(ts, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000 - ts;
}

// Local wall-clock time in `tz` to a unix timestamp (DST-safe; a time inside a spring-forward
// gap comes out one hour later, which is fine for digests). `hint` is an offset already known
// for that day, which saves an Intl call (Intl is the costly part on a cold Worker).
export function zonedToUtc(year, month, day, hour, minute, tz, hint) {
  const guess = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  const o1 = hint ?? offsetAt(guess, tz);
  let t = guess - o1;
  const o2 = offsetAt(t, tz);
  if (o2 !== o1) t = guess - o2;
  return t;
}

// The first digest slot strictly after `now` in the user's zone.
export function nextSlot(now, tz, times) {
  const sorted = [...times].sort();
  const today = localParts(now, tz);
  const hint = Date.UTC(today.year, today.month - 1, today.day, today.hour, today.minute, today.second) / 1000 - now;
  for (let d = 0; d < 3; d++) {
    const base = new Date(Date.UTC(today.year, today.month - 1, today.day + d));
    for (const t of sorted) {
      const [h, m] = t.split(":").map(Number);
      const approx = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h, m) / 1000 - hint;
      if (approx + 3 * 3600 <= now) continue;   // clearly past even with a DST change: no Intl call
      const ts = zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), h, m, tz, hint);
      if (ts > now) return ts;
    }
  }
  return now + DAY;
}

// "today at 20:00" / "tomorrow at 09:00" for bot replies.
export function describeSlot(ts, now, tz) {
  const a = localParts(now, tz), b = localParts(ts, tz);
  const same = a.year === b.year && a.month === b.month && a.day === b.day;
  return `${same ? "today" : "tomorrow"} at ${hhmm(b)}`;
}

export function zoneLabel(tz) {
  return tz.split("/").pop().replace(/_/g, " ");
}
