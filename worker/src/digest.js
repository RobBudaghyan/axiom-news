// Digest building: the ONE place for selection, topic cap, near-duplicate removal, message
// format and time-slot math. Used by the Worker cron (src/cron.js) and by the local tool
// (scripts/digest-cli.mjs), so both behave identically. Pure functions only: no I/O.
// Settings live in config/digest.json.
import CONFIG from "../../config/digest.json" with { type: "json" };

export { CONFIG };

const DAY = 86400;

// ------------------------------------------------------------------ selection (SQL)

// Candidates for one user: on one of the user's topics, importance >= min, created or updated
// since the last digest (at most 24 h back), never sent to this user. Most important first,
// then most recent. The topic cap and dedupe are applied afterwards in JS (pickStories).
export const CANDIDATE_SQL = `
SELECT s.id, s.summary, s.best_url, s.best_source, s.importance, s.topics, s.updated_at
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

// ------------------------------------------------------------------ near-duplicates (no AI)

const STOP = new Set((
  "the a an and or but of to in on at for from by with as is are was were be been being has have had " +
  "its it this that these those their his her they them he she we you who whom which what when where " +
  "after before over under amid against about into onto than then there here also not no new more most " +
  "says said say will would could should may might can just one two three four five six first last " +
  "year years day days week weeks month months people some all any other such while during between " +
  "since until within without per via told according report reports reported including made make " +
  "number increase increased increases rose rise rising percent"
).split(" "));

// Content words, lower-case, accents removed, cut to a 5-letter stem ("strikes" = "strike",
// "Ukrainian" = "Ukraine"). Capitalised words that are not the first word count double:
// they are names and places, which say most about which event a line is about.
export function tokens(text) {
  const words = String(text ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .match(/[A-Za-z0-9']+/g) ?? [];
  const out = new Map();
  words.forEach((raw, i) => {
    const w = raw.toLowerCase().replace(/'s$|'/g, "");
    if (w.length < 3 || STOP.has(w)) return;
    const stem = w.slice(0, 5);
    const weight = i > 0 && /^[A-Z]/.test(raw) ? 2 : 1;
    out.set(stem, Math.max(out.get(stem) ?? 0, weight));
  });
  return out;
}

// Inverse document frequency over the candidate pool: a word in every line ("Ukraine") says
// little, a rare one ("Zaporizhzhia", "Abu Dhabi") says a lot.
export function idfTable(tokenMaps) {
  const df = new Map();
  for (const m of tokenMaps) for (const w of m.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const n = tokenMaps.length;
  const idf = new Map();
  for (const [w, d] of df) idf.set(w, Math.log(1 + n / d));
  return idf;
}

// Weighted overlap: shared weight divided by the smaller line's total weight (0..1).
export function similarity(a, b, idf) {
  return overlap({ map: a, total: totalWeight(a, idf) }, { map: b, total: totalWeight(b, idf) }, idf);
}

function totalWeight(map, idf) {
  let t = 0;
  for (const [w, x] of map) t += x * (idf.get(w) ?? 1);
  return t;
}

function overlap(a, b, idf) {
  const [small, big] = a.map.size <= b.map.size ? [a, b] : [b, a];
  let shared = 0;
  for (const [w, x] of small.map) {
    const y = big.map.get(w);
    if (y) shared += Math.min(x, y) * (idf.get(w) ?? 1);
  }
  const lo = Math.min(a.total, b.total);
  return lo > 0 ? shared / lo : 0;
}

// Word lists are cached by text: in one cron tick several users share most candidates.
const tokenCache = new Map();
function cachedTokens(text) {
  let m = tokenCache.get(text);
  if (!m) {
    if (tokenCache.size > 3000) tokenCache.clear();
    m = tokens(text);
    tokenCache.set(text, m);
  }
  return m;
}

// Walks candidates in rank order and checks each against the ones accepted so far (rank
// order means the more important line of a pair is the one kept). IDF comes from the whole
// candidate list. `onAccept(c)` returns true to stop early (the digest is full), so a normal
// digest compares a few dozen pairs instead of all ~5,000.
function walk(candidates, threshold, onAccept, onDrop) {
  const maps = candidates.map((c) => cachedTokens(c.summary));
  const idf = idfTable(maps);
  const accepted = [];
  for (let i = 0; i < candidates.length; i++) {
    const me = { map: maps[i], total: totalWeight(maps[i], idf) };
    let best = 0, of = null;
    for (const a of accepted) {
      const s = overlap(me, a, idf);
      if (s > best) { best = s; of = a.c; }
    }
    if (best >= threshold) { onDrop?.({ story: candidates[i], of, score: best }); continue; }
    accepted.push({ ...me, c: candidates[i] });
    if (onAccept(candidates[i], accepted.length - 1)) return;
  }
}

// Keeps candidates in order and drops any that is too similar to one already kept.
// Returns {kept, dropped: [{story, of, score}]}.
export function dedupe(candidates, threshold = CONFIG.dedupe_threshold) {
  const kept = [], dropped = [];
  walk(candidates, threshold, (c) => { kept.push(c); return false; }, (d) => dropped.push(d));
  return { kept, dropped };
}

// ------------------------------------------------------------------ the pick

// candidates: rows from CANDIDATE_SQL in rank order. Returns up to n stories in rank order,
// each with `primary` (the topic it counts against).
export function pickStories(candidates, userTopics, n, cfg = CONFIG) {
  const cap = topicCap(n, cfg.max_topic_share);
  const counts = new Map();
  const chosen = [], overflow = [];
  walk(candidates, cfg.dedupe_threshold, (c, rank) => {
    const s = { ...c, rank, primary: primaryTopic(parseList(c.topics), userTopics, cfg.topic_specificity) };
    const k = counts.get(s.primary) ?? 0;
    if (k < cap) { chosen.push(s); counts.set(s.primary, k + 1); } else overflow.push(s);
    return chosen.length >= n;
  });
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

function storyBlock(n, s, emoji) {
  const head = `${n}. ${emoji ? `${emoji} ` : ""}<b>${escapeHtml(s.headline)}</b>`;
  return `${head}\nSource: <a href="${escapeAttr(s.best_url)}">${escapeHtml(s.best_source)}</a>`;
}

function render(stories, topicInfo, format, head) {
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
      parts.push(`${title}\n${list.map((s, i) => storyBlock(i + 1, s, "")).join("\n\n")}`);
    }
    return parts.join("\n\n");
  }
  return [head, ...stories.map((s, i) => storyBlock(i + 1, s, topicInfo[s.primary]?.emoji))].join("\n\n");
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
    text = h.quiet ?? render(list, topicInfo, format, h.head);
    if (visibleLength(text) <= budget) break;
    if (list.length > 1) { list = list.slice(0, -1); continue; }
    const over = visibleLength(text) - budget;
    const s = list[0];
    const cut = s.headline.slice(0, Math.max(20, s.headline.length - over - 3));
    list = [{ ...s, headline: `${cut.replace(/\s+\S*$/, "")}...` }];
    const h2 = header(1, opts, cfg);
    text = render(list, topicInfo, format, h2.head);
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
// gap comes out one hour later, which is fine for digests).
export function zonedToUtc(year, month, day, hour, minute, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute) / 1000;
  let t = guess - offsetAt(guess, tz);
  const o2 = offsetAt(t, tz);
  if (guess - o2 !== t) t = guess - o2;
  return t;
}

// The first digest slot strictly after `now` in the user's zone.
export function nextSlot(now, tz, times) {
  const sorted = [...times].sort();
  const today = localParts(now, tz);
  for (let d = 0; d < 3; d++) {
    const base = new Date(Date.UTC(today.year, today.month - 1, today.day + d));
    for (const t of sorted) {
      const [h, m] = t.split(":").map(Number);
      const ts = zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), h, m, tz);
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
