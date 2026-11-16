// Digest building: the ONE place for selection (the two-score rule), near-duplicate removal, the
// length cut, message format and time-slot math. Used by the Worker cron (src/cron.js), the Admin "digest now" button
// (src/api.js) and the local tool (scripts/digest-cli.mjs), so all behave identically. Pure
// functions only: no I/O. Settings live in config/digest.json.
//
// Scores: the editor pass (job/editor.py) gives each story a strict `final_score` (Step 5) and a
// `topic_score` for readers who follow its main topic (Step 8). A story it has not scored (its
// call failed, or the story is weak) uses its first-pass importance minus `unedited_offset`, so
// digests still work, just less well, when the editor is down.
import CONFIG from "../../config/digest.json" with { type: "json" };
import LINE_EMOJI from "../../config/line_emoji.json" with { type: "json" };
import { FORBIDDEN, effectiveLang, plural, t, timeText, topicLabel } from "./i18n.js";

export { CONFIG };

const DAY = 86400;

// ------------------------------------------------------------------ selection (SQL)

// Step 8, the two-score rule. A story qualifies for a user if it is on one of the user's topics,
// not merged away, never sent to this user, new since the last digest (at most 24 h back) and
//   its global score g >= editorial_bar, OR
//   its main topic (named by the editor) is one the user follows AND its topic score t >= topic_bar
//   (and, with topic_needs_boost, t > g: the story matters more to followers than to everyone).
// g = final_score, or first-pass importance minus unedited_offset when the editor has not scored
// it yet; such a story has no topic score, so it qualifies only through the editorial bar (an
// editor outage must not flood digests with first-pass scores). t = g plus the editor's boost,
// capped per main topic (topic_boost_max, ?8). "New since the last digest" also counts the
// editor's first score time (scored_at): a story scored after a digest went out still reaches the
// next one. Best relevance first: t if the main topic is followed, otherwise g. The same rule is
// in topicScore/qualifies below (the tests check both agree).
// Step 9: each row also carries its translation into the reader's language ?10 (NULL if none, or if
// it was made from an older English text: `src` must equal the current one, compared here in SQL).
// Step 10: a story held back from an earlier digest for want of a translation (digest_holds) stays
// a candidate after its window passed, while it is inside the 24 h floor ?11.
export const CANDIDATE_SQL = `
SELECT id, summary, headline, description, emojis, best_url, best_source, importance, final_score, topic_score,
       topics, main_topic, updated_at, dup_group, tr_headline, tr_description
FROM (
  SELECT s.*, coalesce(s.final_score, s.importance - ?6) AS g,
         s.final_score + min(max(coalesce(s.topic_score, s.final_score) - s.final_score, 0),
                             coalesce(json_extract(?8, '$.' || s.main_topic), 10)) AS t,
         s.main_topic IN (SELECT u.value FROM json_each(?2) u) AS followed,
         tr.headline AS tr_headline, tr.description AS tr_description
  FROM stories s
  LEFT JOIN story_translations tr ON tr.story_id = s.id AND tr.lang = ?10 AND tr.ok = 1
       AND tr.src = coalesce(s.headline, s.summary) || char(10) || coalesce(s.description, '')
  WHERE (max(s.updated_at, coalesce(s.scored_at, 0)) >= ?3
         OR (max(s.updated_at, coalesce(s.scored_at, 0)) >= ?11
             AND EXISTS (SELECT 1 FROM digest_holds h WHERE h.user_id = ?1 AND h.story_id = s.id)))
    AND s.merged_into IS NULL
    AND EXISTS (SELECT 1 FROM json_each(s.topics) x WHERE x.value IN (SELECT u.value FROM json_each(?2) u))
    AND NOT EXISTS (SELECT 1 FROM sent x WHERE x.user_id = ?1 AND x.story_id = s.id)
)
WHERE g >= ?5 OR (followed AND t >= ?7 AND (?9 = 0 OR t > final_score))
ORDER BY max(g, CASE WHEN followed THEN coalesce(t, 0) ELSE 0 END) DESC, g DESC, updated_at DESC, id DESC
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

export function candidateStatement(user, now, cfg = CONFIG, lang = effectiveLang(user)) {
  return {
    sql: CANDIDATE_SQL,
    params: [user.id, JSON.stringify(parseList(user.topics)), digestSince(user.last_digest_at, now, cfg),
             cfg.candidate_limit, cfg.editorial_bar, cfg.unedited_offset, cfg.topic_bar,
             JSON.stringify(cfg.topic_boost_max ?? {}), cfg.topic_needs_boost ? 1 : 0, lang,
             now - cfg.max_lookback_hours * 3600],
  };
}

// The global score g.
export function storyScore(s, cfg = CONFIG) {
  return s.final_score ?? (s.importance ?? 0) - cfg.unedited_offset;
}

// The topic score: for readers who follow the story's main topic. Never below the global score;
// a story the editor has not scored has none. The editor's boost (topic score minus score) is
// capped per main topic in code (cfg.topic_boost_max: 0 for the broad topics, 1 for the two wars,
// 2 for Armenia and Russia), because the model still lifts statements and routine war news.
export function topicScore(s, cfg = CONFIG) {
  if (s.final_score == null) return null;
  const boost = Math.max(0, (s.topic_score ?? s.final_score) - s.final_score);
  const cap = cfg.topic_boost_max?.[s.main_topic] ?? boost;
  return s.final_score + Math.min(boost, cap);
}

const rankOf = (specificity) => (t) => {
  const i = specificity.indexOf(t);
  return i < 0 ? specificity.length : i;
};

// The topic a story is shown under: the one the editor says it is mainly about, if the user
// follows it; otherwise its most specific topic among the user's topics.
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

// Does a story qualify for a user who follows userTopics (the two-score rule)? With
// cfg.topic_needs_boost the topic path is only for stories that matter MORE to followers than to
// everyone (topic score above the global score); otherwise every global-6 story would reach the
// followers of its topic, and a reader of all topics would get them all.
export function qualifies(s, userTopics, cfg = CONFIG) {
  const tags = parseList(s.topics);
  if (!tags.some((t) => userTopics.includes(t))) return false;
  if (storyScore(s, cfg) >= cfg.editorial_bar) return true;
  const t = topicScore(s, cfg);
  return t != null && !!s.main_topic && userTopics.includes(s.main_topic) && t >= cfg.topic_bar &&
    (!cfg.topic_needs_boost || t > s.final_score);
}

// candidates: rows from CANDIDATE_SQL. Returns every story that qualifies (no fixed count, no
// topic cap since Step 8: the message length is the limit, see fitToLength), best first, each
// with `primary` (its section), `score` (g), `topicScore` and `rank` (relevance).
export function pickStories(candidates, userTopics, cfg = CONFIG) {
  return dedupe(candidates).kept
    .filter((c) => qualifies(c, userTopics, cfg))
    .map((c, i) => {
      const tags = parseList(c.topics);
      const score = storyScore(c, cfg);
      const ts = topicScore(c, cfg);
      const followedMain = !!c.main_topic && userTopics.includes(c.main_topic);
      return { ...c, i, score, topicScore: ts, rank: followedMain && ts != null ? Math.max(score, ts) : score,
               primary: primaryTopic(tags, userTopics, cfg.topic_specificity, c.main_topic) };
    })
    .sort(byRank);
}

const byRank = (a, b) => b.rank - a.rank || b.score - a.score || (b.updated_at ?? 0) - (a.updated_at ?? 0) || a.i - b.i;

// ------------------------------------------------------------------ message

export { FORBIDDEN };   // owner rule: never the em dash (nor the en dash), in any language (src/i18n.js)
// Room for translations (Russian runs about 20% longer); English headlines and descriptions are
// already capped lower by the editor (job/editor.py: 200 and 420).
const MAX_HEADLINE = 300, MAX_DESCRIPTION = 600;

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
    .replace(/\s+[‒–—―]\s+/g, ", ")
    .replace(/[‒–—―]/g, "-")
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

export function greeting(hour, lang = "en") {
  return t(lang, hour < 12 ? "digest.greeting_morning" : hour < 18 ? "digest.greeting_afternoon" : "digest.greeting_evening");
}

// "2 PM", "2:30 PM", "12 PM" (noon), "12 AM" (midnight).
export function clock12(p) {
  return timeText("en", p);
}

// "Good evening, Sam. Since 2 PM, 6 stories for you:" (no name if Telegram gave none). The first
// digest, or one after more than 24 h, says "In the last 24 hours". In the digest's language
// (Step 9: "Добрый вечер, Sam. С 14:00 для вас 6 историй:"); the first name is never changed.
// The parts that need Intl (costly on a cold Worker) are computed once per digest.
function greetingParts(opts, cfg) {
  if (opts.greeting) return opts.greeting;
  const { now, tz, lastDigestAt, name } = opts;
  const lang = opts.lang ?? "en";
  const first = String(name ?? "").trim().slice(0, 32);
  const g = greeting(localParts(now, tz).hour, lang);
  const hello = first ? t(lang, "digest.hello_name", { greeting: g, name: escapeHtml(first) }) : g;
  const recent = lastDigestAt && now - lastDigestAt <= cfg.max_lookback_hours * 3600;
  const time = recent ? timeText(lang, localParts(lastDigestAt, tz)) : null;
  const since = recent ? t(lang, "digest.since_mid", { time }) : t(lang, "digest.last24_mid");
  const sinceStart = recent ? t(lang, "digest.since_start", { time }) : t(lang, "digest.last24_start");
  return { hello, since, sinceStart, lang };
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

// ------------------------------------------------------------------ layouts (Step 11)

export const storyLink = (s, inner) => `<a href="${escapeAttr(s.best_url)}">${inner}</a>`;

// A layout is how a digest looks. Every piece of the message comes from it, and the length cut
// (fitToLength) measures those same pieces, so the cut always counts the format that is sent:
//   header(parts, count)    the first line when there are stories; quiet(parts) the note when none
//   heading({label, emoji}, i) the title of the i-th topic section (0 = the first);
//                           story(s, n) one story (n: its number)
//   label(text)             an optional preview label above everything
//   gap                     what joins the pieces; count(text) the length the way Telegram counts it
//   kind                    "html" (sendMessage, HTML parse mode) or "rich" (sendRichMessage)
// CLASSIC is the Step 5 format (format B): numbered stories with the editor's emojis, an
// underlined heading with the topic emoji, the outlet alone on the last line.
export const CLASSIC = {
  name: "classic", kind: "html", gap: "\n\n", count: visibleLength, label: (x) => x,
  header: ({ hello, sinceStart, lang }, count) =>
    t(lang, "digest.header", { hello, since: sinceStart, count, stories: plural(lang, count, "digest.stories") }),
  quiet: ({ hello, since, lang }) => t(lang, "digest.quiet", { hello, since }),
  heading: (x) => `${x.emoji ? `${x.emoji} ` : ""}<b><u>${escapeHtml(x.label)}</u></b>`,
  story: (s, n) => {
    const emojis = s.emojis || s.fallbackEmoji;
    const head = `${n}. ${emojis ? `${emojis} ` : ""}<b>${escapeHtml(s.headline)}</b>`;
    const desc = s.description ? `\n\n${escapeHtml(s.description)}` : "";
    return `${head}${desc}\n${storyLink(s, escapeHtml(s.best_source))}`;
  },
};

// Step 11 (owner's choice, design "E5f" of reports/step-11-design.md): a Telegram rich message
// (sendRichMessage, Bot API 10.1+). A one-line greeting; each topic in a centred, bordered box
// with its emoji, a divider line between topics; each story: the editor's emojis, the headline in
// bold, " · Outlet" in italics as the link, then the description in a quote box. No numbers.
// Telegram stores the text of these blocks with no separators, so its count is visibleLength
// (UTF-16; Telegram's own limit is in Unicode characters, never more than this).
export const RICH = {
  name: "rich", kind: "rich", gap: "", count: visibleLength,
  label: (x) => `<p>${x}</p>`,
  header: ({ hello, since, lang }, count) =>
    `<p><b>${hello}</b> · ${t(lang, "digest.count_line", { count, stories: plural(lang, count, "digest.stories"), since })}</p>`,
  quiet: ({ hello, since, lang }) => `<p><b>${hello}</b> · ${t(lang, "digest.quiet_line", { since })}</p>`,
  heading: (x, i) => `${i ? "<hr/>" : ""}<table bordered><tr><th align="center">${x.emoji ? `${x.emoji} ` : ""}` +
    `${escapeHtml(x.label)}</th></tr></table>`,
  story: (s) => {
    const emojis = s.emojis || s.fallbackEmoji;
    return `<p>${emojis ? `${emojis} ` : ""}<b>${escapeHtml(s.headline)}</b> <i>· ${storyLink(s, escapeHtml(s.best_source))}</i></p>` +
      (s.description ? `<blockquote>${escapeHtml(s.description)}</blockquote>` : "");
  },
};

// The layout every digest uses (the Worker cron, Admin "digest now", digest-cli). opts.layout
// overrides it (design previews, the Step 8 fold test).
export const LAYOUT = RICH;
const layoutOf = (opts) => opts.layout ?? LAYOUT;

// topics: rows of the D1 `topics` table. Returns {tag: {label, emoji}}, labels in `lang` (Step 9).
export function topicInfoFrom(topics, lang = "en") {
  const out = {};
  for (const x of topics ?? []) {
    out[x.tag] = { label: topicLabel(lang, x.tag, x.label_en ?? x.label ?? x.tag), emoji: x.emoji ?? "" };
  }
  return out;
}
const infoOf = (topicInfo, tag) => topicInfo[tag] ?? { label: tag, emoji: "" };

// Topic groups in the order of their best story; the numbering runs on across groups.
function groupsOf(stories, topicInfo, L) {
  const groups = new Map();
  for (const s of stories) {
    if (!groups.has(s.primary)) groups.set(s.primary, []);
    groups.get(s.primary).push(s);
  }
  let n = 0;
  return [...groups].map(([tag, list], i) => ({
    heading: L.heading(infoOf(topicInfo, tag), i),
    blocks: list.map((s) => ({ id: s.id, text: L.story(s, ++n) })),
  }));
}

// Headline, description and fallback emoji cleaned once per story (fitToLength and buildMessage
// both need them; the fallback dictionary costs CPU, so it runs only for stories without editor
// emojis, and only once).
function prepare(stories, topicInfo) {
  return stories.map((s) => {
    if (s.prepared) return s;
    const headline = cleanHeadline(s.headline || s.summary);
    return {
      ...s, headline, prepared: true,
      description: s.description ? cut(cleanText(s.description), MAX_DESCRIPTION) : "",
      best_source: cleanText(s.best_source),   // an outlet name with a long dash would stop the digest (Step 11)
      // from the English headline, so a translated digest shows the same emojis (Step 9)
      fallbackEmoji: s.emojis ? "" : lineEmoji(s.en_headline ? cleanHeadline(s.en_headline) : headline,
                                                topicInfo[s.primary]?.emoji),
    };
  });
}

// Step 8: a digest is ONE message, never so long that Telegram folds it ("Show more"). The
// stories (best first, from pickStories) are cut until the message fits in
// cfg.message_char_limit characters, counted the way Telegram counts them (layout.count):
//  - the best story of each section (each followed topic in the digest) is kept while any other
//    story can go;
//  - otherwise the lowest relevance goes first; on a tie, from the section with the most stories
//    (what the old 40% topic cap was for), then the lower global score, then the older story.
// Each piece is measured once with the layout that sends it (Step 11); story numbers and the story
// count in the greeting are measured as "99", so the estimate is never shorter than the real
// message. Returns {kept, cut}, both in the input order.
export function fitToLength(stories, opts, cfg = CONFIG) {
  const topicInfo = opts.topicInfo ?? {};
  const L = layoutOf(opts);
  const list = prepare(stories, topicInfo);
  const limit = cfg.message_char_limit;
  const gap = L.count(L.gap);
  const fixed = (opts.label ? L.count(L.label(opts.label)) + gap : 0) + L.count(L.header(greetingParts(opts, cfg), 99));
  const blockLen = new Map(list.map((s) => [s.id, L.count(L.story(s, 99))]));
  const headLen = new Map();
  for (const s of list) {
    if (!headLen.has(s.primary)) headLen.set(s.primary, L.count(L.heading(infoOf(topicInfo, s.primary), 1)));
  }
  const size = (keep) => {
    let n = fixed;
    const seen = new Set();
    for (const s of keep) {
      if (!seen.has(s.primary)) { seen.add(s.primary); n += gap + headLen.get(s.primary); }
      n += gap + blockLen.get(s.id);
    }
    return n;
  };
  const best = new Set();
  const firstOf = new Set();
  for (const s of list) if (!firstOf.has(s.primary)) { firstOf.add(s.primary); best.add(s.id); }

  let keep = [...list];
  while (keep.length > 1 && size(keep) > limit) {
    const count = new Map();
    for (const s of keep) count.set(s.primary, (count.get(s.primary) ?? 0) + 1);
    const open = keep.filter((s) => !best.has(s.id));
    const pool = open.length ? open : keep;
    let victim = pool[0];
    for (const s of pool) {
      const d = s.rank - victim.rank || count.get(victim.primary) - count.get(s.primary) ||
        s.score - victim.score || (s.updated_at ?? 0) - (victim.updated_at ?? 0) || (victim.i ?? 0) - (s.i ?? 0);
      if (d < 0) victim = s;
    }
    keep = keep.filter((s) => s !== victim);
  }
  const kept = new Set(keep.map((s) => s.id));
  return { kept: keep, cut: list.filter((s) => !kept.has(s.id)) };
}

// Builds the digest message from stories in display order: the header (or the quiet note), then
// topic sections in the order of their best story, numbering running on across sections. Returns
// {text, storyIds, stories, kind}. Refuses an em/en dash and anything over Telegram's 4,096
// characters; planDigest keeps it under the (lower) fold limit.
export function buildMessage(stories, opts, cfg = CONFIG) {
  const topicInfo = opts.topicInfo ?? {};
  const L = layoutOf(opts);
  const list = prepare(stories, topicInfo);
  const parts = greetingParts(opts, cfg);
  const pieces = [...(opts.label ? [L.label(opts.label)] : []), list.length ? L.header(parts, list.length) : L.quiet(parts)];
  const storyIds = [];
  for (const g of groupsOf(list, topicInfo, L)) {
    pieces.push(g.heading, ...g.blocks.map((b) => b.text));
    storyIds.push(...g.blocks.map((b) => b.id));
  }
  const text = pieces.join(L.gap);
  if (FORBIDDEN.test(text)) throw new Error("em/en dash in user-facing text");
  if (L.count(text) > 4096) throw new Error(`message too long (${L.count(text)})`);
  return { text, storyIds, stories: list, kind: L.kind };
}

// Never a mixed-language digest. Step 10 (owner): a picked story with no translation into the
// reader's language (tr_headline from CANDIDATE_SQL, made from the current English text) is HELD:
// left out of this digest, not marked sent, and offered again by the next digests while it is
// inside the 24 h window (digest_holds). The rest goes out in the reader's language. Only if every
// picked story is held does the digest go out wholly in English (e.g. right after a language
// switch), and `fallback` says why. A quiet note has no stories, so it is always in the reader's
// language. Returns {stories, lang, fallback, held}.
export function chooseDigestLanguage(picked, want) {
  if (want === "en") return { stories: picked, lang: "en", fallback: null, held: [] };
  const held = picked.filter((s) => !s.tr_headline);
  if (picked.length && held.length === picked.length) {
    return { stories: picked, lang: "en", fallback: { lang: want, missing: held.length, of: picked.length }, held: [] };
  }
  return {
    stories: picked.filter((s) => s.tr_headline)
      .map((s) => ({ ...s, en_headline: s.headline || s.summary, headline: s.tr_headline,
                     summary: s.tr_headline, description: s.tr_description ?? "" })),
    lang: want, fallback: null, held,
  };
}

// One user's whole digest from candidate rows: pick (two-score rule), choose the language (holding
// untranslated stories), then cut to one unfolded message (measured on the text actually sent, so
// the room a held story leaves goes to the next translated story), format. No I/O.
// Returns {text, kind, storyIds, stories, cut, nextAt, lang, fallback, heldIds, button}: kind says how it
// is sent ("rich" or "html"), button is the label of the "⚙️ Settings" button under it (Step 11).
export function planDigest(user, candidates, topics, now, cfg = CONFIG, opts = {}) {
  const chosen = chooseDigestLanguage(pickStories(candidates, parseList(user.topics), cfg),
                                      opts.lang ?? effectiveLang(user));
  const picked = chosen.stories;
  const tz = user.timezone || cfg.default_timezone;
  const mopts = { now, tz, lastDigestAt: user.last_digest_at, name: user.first_name, lang: chosen.lang,
                  topicInfo: topicInfoFrom(topics, chosen.lang), label: opts.label, layout: opts.layout };
  mopts.greeting = greetingParts(mopts, cfg);
  let { kept, cut } = fitToLength(picked, mopts, cfg);
  let msg = buildMessage(kept, mopts, cfg);
  while (layoutOf(mopts).count(msg.text) > cfg.message_char_limit && kept.length > 1) {   // cannot happen (the estimate is high); a guard
    cut = [...cut, kept[kept.length - 1]];
    kept = kept.slice(0, -1);
    msg = buildMessage(kept, mopts, cfg);
  }
  const times = parseList(user.digest_times, cfg.default_times);
  return { ...msg, cut: cut.length, nextAt: nextSlot(now, tz, times), lang: chosen.lang, fallback: chosen.fallback,
           heldIds: chosen.held.map((s) => s.id), button: t(chosen.lang, "digest.settings_button") };
}

// Step 10: one digest_holds row per held story (the last digest that held it wins).
export function holdStatements(user, heldIds, lang, now) {
  return heldIds.map((sid) => ({
    sql: "INSERT INTO digest_holds (user_id, story_id, lang, at) VALUES (?1, ?2, ?3, ?4) " +
         "ON CONFLICT(user_id, story_id) DO UPDATE SET lang = excluded.lang, at = excluded.at",
    params: [user.id, sid, lang, now],
  }));
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

// "today at 20:00" / "tomorrow at 09:00" for bot replies, in the reader's language.
export function describeSlot(ts, now, tz, lang = "en") {
  const a = localParts(now, tz), b = localParts(ts, tz);
  const same = a.year === b.year && a.month === b.month && a.day === b.day;
  return t(lang, same ? "bot.today_at" : "bot.tomorrow_at", { time: hhmm(b) });
}

export function zoneLabel(tz) {
  return tz.split("/").pop().replace(/_/g, " ");
}
