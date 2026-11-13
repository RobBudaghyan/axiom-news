// Digest building: the ONE place for selection, topic cap, near-duplicate removal, message
// format and time-slot math. Used by the Worker cron (src/cron.js) and by the local tool
// (scripts/digest-cli.mjs), so both behave identically. Pure functions only: no I/O.
// Settings live in config/digest.json.
import CONFIG from "../../config/digest.json" with { type: "json" };
import LINE_EMOJI from "../../config/line_emoji.json" with { type: "json" };

export { CONFIG };

const DAY = 86400;

// ------------------------------------------------------------------ selection (SQL)

// Candidates for one user: on one of the user's topics, importance >= min, created or updated
// since the last digest (at most 24 h back), never sent to this user. Most important first,
// then most recent. Near-duplicate removal (by dup_group) and the topic cap follow in pickStories.
export const CANDIDATE_SQL = `
SELECT s.id, s.summary, s.best_url, s.best_source, s.importance, s.topics, s.updated_at, s.dup_group
FROM stories s
WHERE s.updated_at >= ?3
  AND s.importance >= ?5
  AND EXISTS (SELECT 1 FROM json_each(s.topics) t
              WHERE t.value IN (SELECT u.value FROM json_each(?2) u))
  AND NOT EXISTS (SELECT 1 FROM sent x WHERE x.user_id = ?1 AND x.story_id = s.id)
ORDER BY s.importance DESC, s.updated_at DESC, s.id DESC
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
             cfg.candidate_limit, cfg.min_importance],
  };
}

// ------------------------------------------------------------------ topic cap

export function topicCap(n, share = CONFIG.max_topic_share) {
  return Math.max(1, Math.ceil(share * n - 1e-9));   // 0.4 * 15 is 6.000000000000001 in floats
}

// The topic a story counts against: its most specific topic among the user's topics.
export function primaryTopic(storyTopics, userTopics, specificity = CONFIG.topic_specificity) {
  const mine = storyTopics.filter((t) => userTopics.includes(t));
  const pool = mine.length ? mine : storyTopics;
  const rank = (t) => {
    const i = specificity.indexOf(t);
    return i < 0 ? specificity.length : i;
  };
  return [...pool].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

// ------------------------------------------------------------------ the pick

// Near-duplicates are found by the hourly job (job/dupes.py, no AI, no CPU limit there) and
// stored as stories.dup_group = the id of the group's most important story. Here we only keep
// the first candidate of each group, which costs almost no CPU in the Worker cron.
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

// candidates: rows from CANDIDATE_SQL in rank order. Returns up to n stories in rank order,
// each with `primary` (the topic it counts against).
export function pickStories(candidates, userTopics, n, cfg = CONFIG) {
  const cap = topicCap(n, cfg.max_topic_share);
  const counts = new Map();
  const seen = new Set();
  const chosen = [], overflow = [];
  for (let rank = 0; rank < candidates.length && chosen.length < n; rank++) {
    const c = candidates[rank];
    const g = c.dup_group ?? `own:${c.id}`;
    if (seen.has(g)) continue;          // a near-duplicate of a story already taken
    seen.add(g);
    const s = { ...c, rank, primary: primaryTopic(parseList(c.topics), userTopics, cfg.topic_specificity) };
    const k = counts.get(s.primary) ?? 0;
    if (k < cap) { chosen.push(s); counts.set(s.primary, k + 1); } else overflow.push(s);
  }
  // The cap left empty slots and nothing else qualifies: fill with the next most important.
  for (const s of overflow) {
    if (chosen.length >= n) break;
    chosen.push(s);
  }
  return chosen.sort((a, b) => a.rank - b.rank);
}

// ------------------------------------------------------------------ message

export const FORBIDDEN = /[—–]/;   // owner rule: never the em dash (nor the en dash)

export function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

// Same rules as job/ai.py clean_summary: one line, no em/en dash, then no trailing period.
export function cleanHeadline(text) {
  return String(text ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+[—–]\s+/g, ", ")
    .replace(/[—–]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim()
    .replace(/[.\s]+$/, "");
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

function header(count, { now, tz, lastDigestAt }, cfg) {
  const local = localParts(now, tz);
  const hello = greeting(local.hour);
  const recent = lastDigestAt && now - lastDigestAt <= cfg.max_lookback_hours * 3600;
  const when = recent ? `since ${hhmm(localParts(lastDigestAt, tz))}` : "in the last 24 hours";
  if (!count) return { quiet: `${hello}. Quiet period: nothing important on your topics ${when}.` };
  const n = `${count} ${count === 1 ? "story" : "stories"}`;
  return { head: `${hello}. ${when[0].toUpperCase()}${when.slice(1)}, ${n} on your topics:` };
}

// ------------------------------------------------------------------ line emoji

// The emoji at the start of a line (config/line_emoji.json): the flag of the FIRST country,
// leader, capital or group the headline names ("Donald Trump's envoys..." gets the US flag); if
// none, the first subject icon (ceasefire, strike, election, court, ...); if none, the topic's
// emoji. A dictionary lookup of 1-4 word phrases (a 660-word regex cost 3.6 ms just to build,
// a third of the Worker's CPU budget); at each word the longest phrase wins.
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

function storyBlock(n, s, emoji) {
  const head = `${n}. ${emoji ? `${emoji} ` : ""}<b>${escapeHtml(s.headline)}</b>`;
  return `${head}\nSource: <a href="${escapeAttr(s.best_url)}">${escapeHtml(s.best_source)}</a>`;
}

function render(stories, topicInfo, format, head, perLine = true) {
  const emojiFor = (s) => (perLine ? lineEmoji(s.headline, topicInfo[s.primary]?.emoji) : topicInfo[s.primary]?.emoji);
  if (format === "B") {
    const groups = new Map();
    for (const s of stories) {
      if (!groups.has(s.primary)) groups.set(s.primary, []);
      groups.get(s.primary).push(s);
    }
    const parts = [head];
    for (const [tag, list] of groups) {
      const t = topicInfo[tag] ?? { label: tag, emoji: "" };
      const title = `<b>${t.emoji ? `${t.emoji} ` : ""}${escapeHtml(t.label)}</b>`;
      parts.push(`${title}\n${list.map((s, i) => storyBlock(i + 1, s, perLine ? emojiFor(s) : "")).join("\n\n")}`);
    }
    return parts.join("\n\n");
  }
  return [head, ...stories.map((s, i) => storyBlock(i + 1, s, emojiFor(s)))].join("\n\n");
}

// topics: rows of the D1 `topics` table. Returns {tag: {label, emoji}}.
export function topicInfoFrom(topics) {
  const out = {};
  for (const t of topics ?? []) out[t.tag] = { label: t.label_en ?? t.label ?? t.tag, emoji: t.emoji ?? "" };
  return out;
}

// Builds the message. If it is too long for Telegram, the lowest-ranked stories are dropped
// (the header count follows); a single over-long headline is cut at a word with "...".
// Returns {text, stories} where stories are the ones actually in the text.
export function buildMessage(stories, opts, cfg = CONFIG) {
  const format = opts.format ?? cfg.format;
  const topicInfo = opts.topicInfo ?? {};
  const budget = cfg.message_char_budget - (opts.label ? visibleLength(opts.label) + 2 : 0);
  let list = stories.map((s) => ({ ...s, headline: cleanHeadline(s.summary) }));
  let text;
  for (;;) {
    const h = header(list.length, opts, cfg);
    text = h.quiet ?? render(list, topicInfo, format, h.head, cfg.line_emoji !== false);
    if (visibleLength(text) <= budget) break;
    if (list.length > 1) { list = list.slice(0, -1); continue; }
    const over = visibleLength(text) - budget;
    const s = list[0];
    const cut = s.headline.slice(0, Math.max(20, s.headline.length - over - 3));
    list = [{ ...s, headline: `${cut.replace(/\s+\S*$/, "")}...` }];
    const h2 = header(1, opts, cfg);
    text = render(list, topicInfo, format, h2.head, cfg.line_emoji !== false);
    break;
  }
  if (opts.label) text = `${opts.label}\n\n${text}`;
  if (FORBIDDEN.test(text)) throw new Error("em/en dash in user-facing text");
  if (visibleLength(text) > 4096) throw new Error(`message too long (${visibleLength(text)})`);
  return { text, stories: list };
}

// One user's whole digest from candidate rows: pick, then format. No I/O.
export function planDigest(user, candidates, topics, now, cfg = CONFIG, opts = {}) {
  const userTopics = parseList(user.topics);
  const n = user.max_stories || cfg.default_stories;
  const picked = pickStories(candidates, userTopics, n, cfg);
  const tz = user.timezone || cfg.default_timezone;
  const msg = buildMessage(picked, {
    now, tz, lastDigestAt: user.last_digest_at, topicInfo: topicInfoFrom(topics),
    format: opts.format, label: opts.label,
  }, cfg);
  const times = parseList(user.digest_times, cfg.default_times);
  return { text: msg.text, stories: msg.stories, nextAt: nextSlot(now, tz, times) };
}

// D1 writes after a successful send: never-twice rows, the digest time, the next slot.
// last_digest_at is the slot time (so the next header reads "Since 14:00", not "14:03").
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
