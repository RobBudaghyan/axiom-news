// Selection (Step 8: the two-score rule, no cap, no maximum), dup_group dedupe, the length cut to
// ONE message, message format, never twice, the quiet note, and time math (src/digest.js).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CLASSIC, CONFIG, buildMessage, candidateStatement, cleanHeadline, clock12, dedupe, digestSince, fitToLength, lineEmoji,
  nextSlot, pickStories, planDigest, primaryTopic, qualifies, storyScore, topicInfoFrom, topicScore, visibleLength,
  zonedToUtc,
} from "../src/digest.js";
import { ALL, OWNER, TOPIC_ROWS, TZ, addStory, fakeD1, yerevan } from "./helpers.mjs";

const TOPICS = TOPIC_ROWS.map(([tag, label_en, emoji, sort]) => ({ tag, label_en, emoji, sort, is_default: 1 }));
const INFO = topicInfoFrom(TOPICS);
let nextId = 1;
// A candidate row as CANDIDATE_SQL returns it. score = the editor's final_score; extra may set
// topic_score and main_topic.
const story = (summary, topics, score = 7, extra = {}) => ({
  id: nextId++, summary, topics: JSON.stringify(topics), importance: 6, final_score: score,
  best_url: "https://x.test/a", best_source: "Alpha Times", ...extra,
});
const ids = (list) => list.map((s) => s.id);
const CFG = { ...CONFIG, editorial_bar: 7, topic_bar: 6 };   // the tests pin the bars

describe("candidate SQL (real schema)", () => {
  async function setup() {
    const { db, sqlite } = fakeD1();
    const now = yerevan(14, 5);
    const t = now - 3600;
    const add = (name, topics, importance, extra, at = t) => addStory(sqlite, name, topics, importance, at, extra);
    const ids = {
      edited8: add("Edited 8", ["iran_war", "wars_conflicts"], 5, { final_score: 8 }),
      court: add("Armenian court case", ["armenia", "politics"], 4,
                 { final_score: 4, topic_score: 6, main_topic: "armenia" }),          // in only for Armenia followers
      routine: add("Routine Armenia visit", ["armenia"], 6, { final_score: 4, topic_score: 5, main_topic: "armenia" }),
      unedited9: add("Unedited 9", ["russia"], 9),                           // 9 - offset 2 = 7
      unedited8: add("Unedited 8", ["russia"], 8),                           // 6: unedited stories have no topic path
      edited5: add("Edited 5", ["politics"], 9, { final_score: 5 }),
      old: add("Old", ["politics"], 9, { final_score: 9 }, now - 25 * 3600),
      sent: add("Already sent", ["politics"], 9, { final_score: 9 }),
      merged: add("Merged away", ["politics"], 9, { final_score: 9, merged_into: 1 }),
      late: add("Scored late", ["iran_war"], 5, { final_score: 8, scored_at: now - 600 }, now - 3 * 3600),
    };
    sqlite.prepare("INSERT INTO sent (user_id, story_id, sent_at) VALUES (?, ?, ?)").run(OWNER, ids.sent, t);
    const run = async (user) => {
      const s = candidateStatement({ id: OWNER, topics: JSON.stringify(ALL), last_digest_at: null, ...user }, now, CFG);
      return (await db.query(s.sql, s.params)).map((r) => r.summary);
    };
    return { run, now, t, sqlite, ids };
  }

  test("two scores: editorial bar, or followed main topic at the topic bar; 24 h, never sent, not merged; best first", async () => {
    const { run } = await setup();
    assert.deepEqual(await run({}), ["Edited 8", "Scored late", "Unedited 9", "Armenian court case"]);
  });
  test("the topic path needs the main topic followed", async () => {
    const { run } = await setup();
    assert.deepEqual(await run({ topics: '["politics","russia"]' }), ["Unedited 9"]);   // the court case is tagged politics too
    assert.deepEqual(await run({ topics: '["armenia"]' }), ["Armenian court case"]);
  });
  test("since the last digest, counting a late first score (scored_at)", async () => {
    const { run, t } = await setup();
    assert.deepEqual(await run({ last_digest_at: t + 30 }), ["Scored late"]);
  });
  test("never twice: a sent story stays out, even when it is scored again later", async () => {
    const { run, sqlite, ids, now } = await setup();
    assert.ok((await run({ id: 7 })).includes("Already sent"));          // another user's sent row does not block
    sqlite.prepare("INSERT INTO sent (user_id, story_id, sent_at) VALUES (?, ?, ?)").run(OWNER, ids.late, now - 60);
    sqlite.prepare("UPDATE stories SET scored_at = ?, final_score = 9 WHERE id = ?").run(now - 30, ids.late);
    assert.ok(!(await run({ last_digest_at: now - 120 })).includes("Scored late"));
  });
  test("lookback is capped at 24 h", () => {
    const now = 1_800_000_000;
    assert.equal(digestSince(null, now), now - 86400);
    assert.equal(digestSince(now - 5 * 86400, now), now - 86400);
    assert.equal(digestSince(now - 3600, now), now - 3600);
  });
});

const UA = [
  "Russian drones hit a power plant in Kharkiv overnight",
  "Ukraine received the first batch of Patriot interceptors from Germany",
  "Prisoner exchange returns 150 soldiers to Kyiv",
  "Odesa port attacked by naval drones, two ships damaged",
  "Zelensky dismissed the commander of the eastern front",
  "Sumy region evacuates children from border villages",
];

describe("selection: the two-score rule", () => {
  test("global bar for everyone on the story's topics; topic bar only for followers of its main topic", () => {
    const pol8 = story("Big politics story", ["politics"], 8);
    const court = story("Armenian judges suspended", ["armenia", "politics"], 4, { topic_score: 6, main_topic: "armenia" });
    const visit = story("Pashinyan visits Dublin", ["armenia"], 5, { topic_score: 5, main_topic: "armenia" });
    const pol6 = story("Smaller politics story", ["politics"], 6, { topic_score: 6, main_topic: "politics" });
    assert.deepEqual(ids(pickStories([pol8, court, visit, pol6], ["politics", "armenia"], CFG)), [pol8.id, court.id]);
    // pol6: a global 6 with no boost does not come in through the topic path (topic_needs_boost)
    assert.deepEqual(ids(pickStories([pol6], ["politics"], { ...CFG, topic_needs_boost: false })), [pol6.id]);
    assert.deepEqual(ids(pickStories([pol8, court, pol6], ["armenia"], CFG)), [court.id]);   // pol8: not on the topic
    assert.deepEqual(ids(pickStories([court], ["politics"], CFG)), []);           // main topic not followed
    assert.deepEqual(ids(pickStories([visit], ["armenia"], CFG)), []);            // below the topic bar
    assert.equal(pickStories([court], ["armenia"], CFG)[0].primary, "armenia");
  });
  test("the topic score is never below the global score; unedited stories have none", () => {
    assert.equal(topicScore({ final_score: 7, topic_score: 5 }), 7);
    assert.equal(topicScore({ final_score: 4, topic_score: 6 }), 6);
    assert.equal(topicScore({ final_score: 5 }), 5);
    assert.equal(topicScore({ final_score: null, importance: 9 }), null);
    // a story whose stored topic score is low still qualifies globally
    assert.ok(qualifies(story("x", ["politics"], 8, { topic_score: 3, main_topic: "politics" }), ["politics"], CFG));
  });
  test("the editor's boost is capped per main topic: 0 for broad topics, 1 for the wars, 2 for Armenia and Russia", () => {
    const t = (main, g, ts) => topicScore({ final_score: g, topic_score: ts, main_topic: main }, CFG);
    assert.equal(t("politics", 5, 8), 5);
    assert.equal(t("wars_conflicts", 6, 7), 6);
    assert.equal(t("ukraine_war", 4, 8), 5);
    assert.equal(t("iran_war", 6, 7), 7);
    assert.equal(t("armenia", 4, 9), 6);
    assert.equal(t("russia", 5, 6), 6);
    assert.equal(topicScore({ final_score: 4, topic_score: 9, main_topic: "armenia" }, { ...CFG, topic_boost_max: {} }), 9);
    // a capped story drops out: the Ukraine report the editor lifted from 4 to 8 is a 5 for followers
    assert.deepEqual(pickStories([story("Ukraine report", ["ukraine_war"], 4, { topic_score: 8, main_topic: "ukraine_war" })],
      ["ukraine_war"], CFG), []);
  });
  test("the SQL and the code agree on who qualifies (random pools, real schema)", async () => {
    const { db, sqlite } = fakeD1();
    const now = yerevan(14, 5);
    const r = rng(7);
    const tags = ["politics", "wars_conflicts", "armenia", "russia", "iran_war", "ukraine_war"];
    for (let i = 0; i < 300; i++) {
      const main = tags[Math.floor(r() * tags.length)];
      const edited = r() < 0.85;
      const g = 2 + Math.floor(r() * 8);
      addStory(sqlite, `S${i}`, [main, ...(r() < 0.4 ? ["politics"] : [])], 2 + Math.floor(r() * 8), now - 3600,
        edited ? { final_score: g, topic_score: r() < 0.8 ? g + Math.floor(r() * 4) : undefined, main_topic: r() < 0.9 ? main : undefined }
               : {});
    }
    for (const userTopics of [["armenia"], ["politics"], ALL, ["ukraine_war", "russia"]]) {
      for (const cfg of [CFG, { ...CFG, topic_bar: 5 }, { ...CFG, topic_needs_boost: false }, { ...CFG, topic_boost_max: {} }]) {
        const st = candidateStatement({ id: OWNER, topics: JSON.stringify(userTopics), last_digest_at: null }, now,
          { ...cfg, candidate_limit: 1000 });
        const rows = await db.query(st.sql, st.params);
        const all = await db.query("SELECT * FROM stories");
        assert.deepEqual(rows.map((x) => x.id).sort((a, b) => a - b),
          all.filter((x) => qualifies(x, userTopics, cfg)).map((x) => x.id).sort((a, b) => a - b),
          `${userTopics} ${JSON.stringify([cfg.topic_bar, cfg.topic_needs_boost, cfg.topic_boost_max])}`);
        assert.deepEqual(rows.map((x) => x.id), ids(pickStories(rows, userTopics, cfg)));   // same order too
      }
    }
  });
  test("a story the editor did not score: first-pass importance minus the offset, editorial bar only", () => {
    assert.equal(storyScore({ final_score: null, importance: 9 }), 7);
    assert.equal(storyScore({ final_score: 4, importance: 9 }), 4);
    const big = story("Unedited big story", ["politics"], null, { importance: 9 });
    const mid = story("Unedited mid story", ["russia"], null, { importance: 8, main_topic: "russia" });
    assert.deepEqual(ids(pickStories([big, mid], ALL, CFG)), [big.id]);
  });
  test("bars are config values", () => {
    const court = story("Armenian judges suspended", ["armenia"], 4, { topic_score: 5, main_topic: "armenia" });
    assert.equal(pickStories([court], ["armenia"], CFG).length, 0);
    assert.equal(pickStories([court], ["armenia"], { ...CFG, topic_bar: 5 }).length, 1);
    assert.equal(pickStories([story("x", ["politics"], 6)], ALL, { ...CFG, editorial_bar: 6 }).length, 1);
  });
  test("no fixed count and no topic cap: every qualifying story, best relevance first", () => {
    const ua = UA.map((s, i) => story(s, ["ukraine_war"], 9 - i * 0.1));
    const arm = Array.from({ length: 5 }, (_, i) => story(`Armenia ${i}`, ["armenia"], 4, { topic_score: 6, main_topic: "armenia" }));
    assert.equal(pickStories(ua, ALL, CFG).length, 6);
    assert.equal(pickStories(arm, ["armenia"], CFG).length, 5);                  // an Armenia-only reader gets all five
    const mixed = pickStories([arm[0], ua[0]], ALL, CFG);
    assert.deepEqual(ids(mixed), [ua[0].id, arm[0].id]);                          // rank 9 before rank 6
    assert.equal(mixed[1].rank, 6);
  });
  test("near-duplicates: only the first story of each dup_group", () => {
    const lead = story("Ceasefire agreed between Israel and Hezbollah", ["iran_war"], 8);
    lead.dup_group = lead.id;
    const dup = story("Israel and Hezbollah agree Lebanon ceasefire", ["iran_war"], 8, { dup_group: lead.id });
    const other = story("Armenia sets an election date", ["armenia"], 7);
    assert.deepEqual(ids(dedupe([lead, dup, other]).kept), [lead.id, other.id]);
    assert.deepEqual(ids(pickStories([lead, dup, other], ALL, CFG)), [lead.id, other.id]);
  });
  test("section: the editor's main topic when followed, else the most specific followed tag", () => {
    assert.equal(primaryTopic(["wars_conflicts", "ukraine_war"], ALL), "ukraine_war");
    assert.equal(primaryTopic(["politics", "russia"], ALL), "russia");
    assert.equal(primaryTopic(["wars_conflicts", "ukraine_war"], ["wars_conflicts"]), "wars_conflicts");
    const tags = ["politics", "russia", "iran_war"];
    assert.equal(primaryTopic(tags, ALL, CONFIG.topic_specificity, "politics"), "politics");
    assert.equal(primaryTopic(tags, ["russia", "iran_war"], CONFIG.topic_specificity, "politics"), "iran_war");
    const summit = story("Trump, Putin and Xi to meet", tags, 8, { main_topic: "politics" });
    assert.equal(pickStories([summit], ALL, CFG)[0].primary, "politics");
  });
});

// Real-looking long stories for the length tests.
const DESC = "Russian and Ukrainian negotiators in Abu Dhabi agreed a framework for a prisoner exchange of 1,200 people. " +
  "Officials said a partial energy ceasefire could follow next week if both sides keep to the terms.";
const long = (summary, topics, score, extra = {}) => story(summary, topics, score, {
  headline: `${summary}: negotiators agree a framework for a prisoner exchange`, description: DESC, emojis: "🇷🇺🇺🇦🤝",
  best_url: `https://www.example-news-site.test/world/2026/11/13/very-long-slug-${nextId}`, best_source: "The New York Times",
  ...extra });
const user = (topics, extra = {}) => ({ id: OWNER, first_name: "Sam", topics: JSON.stringify(topics), timezone: TZ,
  digest_times: '["09:00","14:00","20:00"]', last_digest_at: yerevan(9), ...extra });
const OPTS = { now: yerevan(14, 5), tz: TZ, lastDigestAt: yerevan(9), topicInfo: INFO, name: "Sam" };

// A small seeded random generator, so the "never over the limit" test is repeatable.
function rng(seed) {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("length cut: ONE message under the fold limit", () => {
  test("never over the limit, on 300 random pools and limits", () => {
    const r = rng(42);
    for (let k = 0; k < 300; k++) {
      const n = Math.floor(r() * 40);
      const list = Array.from({ length: n }, (_, i) => {
        const tags = [ALL[Math.floor(r() * ALL.length)]];
        const g = 3 + Math.floor(r() * 6);
        return story(`Story ${i} ${"word ".repeat(Math.floor(r() * 25))}`, tags, g, {
          topic_score: g + Math.floor(r() * 3), main_topic: tags[0],
          headline: `Headline ${i} ${"long ".repeat(Math.floor(r() * 20))}`,
          description: r() < 0.8 ? "A sentence of description. ".repeat(1 + Math.floor(r() * 12)) : null,
          emojis: r() < 0.7 ? "🇦🇲🤝" : null, best_source: `Outlet ${"x".repeat(Math.floor(r() * 30))}` });
      });
      const limit = 900 + Math.floor(r() * 3196);
      const cfg = { ...CFG, message_char_limit: limit };
      const plan = planDigest(user(ALL), list, TOPICS, yerevan(14, 5), cfg);
      const picked = pickStories(list, ALL, cfg).length;
      assert.ok(visibleLength(plan.text) <= limit, `pool ${k}: ${visibleLength(plan.text)} > ${limit}`);
      assert.equal(plan.storyIds.length + plan.cut, picked);
      if (picked) assert.ok(plan.storyIds.length >= 1);
    }
  });
  test("each followed topic keeps its best story; the lowest-ranked other stories go first", () => {
    const ua = UA.map((s, i) => long(s, ["ukraine_war"], 9 - i * 0.1));
    const arm = long("Armenian judges suspended", ["armenia"], 4, { topic_score: 6, main_topic: "armenia" });
    const ir = long("Iran tanker hit", ["iran_war"], 7);
    const picked = pickStories([...ua, arm, ir], ALL, CFG);
    const full = visibleLength(buildMessage(picked, OPTS, CFG).text);
    const { kept, cut } = fitToLength(picked, OPTS, { ...CFG, message_char_limit: Math.floor(full * 0.55) });
    assert.ok(kept.some((s) => s.id === arm.id), "Armenia's best story is kept although its rank is lowest");
    assert.ok(kept.some((s) => s.id === ir.id));
    assert.ok(kept.some((s) => s.id === ua[0].id));
    assert.ok(cut.length >= 2);
    assert.deepEqual(ids(cut), ids(ua).slice(-cut.length));                       // the weakest Ukraine stories
  });
  test("on equal relevance, the story from the most crowded section goes first (the old cap's job)", () => {
    const ua = [0, 1, 2].map((i) => long(`Ukraine ${i}`, ["ukraine_war"], 7));
    const ru = [0, 1].map((i) => long(`Russia ${i}`, ["russia"], 7));
    const picked = pickStories([...ua, ...ru], ALL, CFG);
    const full = visibleLength(buildMessage(picked, OPTS, CFG).text);
    const { cut } = fitToLength(picked, OPTS, { ...CFG, message_char_limit: full - 50 });
    assert.equal(cut.length, 1);
    assert.equal(JSON.parse(cut[0].topics)[0], "ukraine_war");
  });
  test("if only each topic's best story is left and it is still too long, the lowest-ranked of them goes", () => {
    const a = long("Ukraine", ["ukraine_war"], 9);
    const b = long("Iran", ["iran_war"], 8);
    const c = long("Armenia", ["armenia"], 4, { topic_score: 6, main_topic: "armenia" });
    const picked = pickStories([a, b, c], ALL, CFG);
    const two = visibleLength(buildMessage(picked.slice(0, 2), OPTS, CFG).text);
    const { kept, cut } = fitToLength(picked, OPTS, { ...CFG, message_char_limit: two + 30 });
    assert.deepEqual(ids(kept), [a.id, b.id]);
    assert.deepEqual(ids(cut), [c.id]);
  });
  test("a digest that fits is not cut, and 30 stories still make one message", () => {
    const list = Array.from({ length: 30 }, (_, i) => long(`Story ${i}`, [ALL[i % ALL.length]], 8));
    const plan = planDigest(user(ALL), list, TOPICS, yerevan(14, 5), CFG);
    assert.equal(typeof plan.text, "string");
    assert.ok(visibleLength(plan.text) <= CFG.message_char_limit);
    assert.ok(plan.cut > 0);
    const small = planDigest(user(ALL), list.slice(0, 2), TOPICS, yerevan(14, 5), CFG);
    assert.equal(small.cut, 0);
    assert.equal(small.storyIds.length, 2);
    assert.match(small.text, /^<p><b>Good afternoon, Sam<\/b> · 2 stories since 9 AM<\/p>/);
  });
});

describe("quiet note", () => {
  test("nothing qualifies: the quiet-period note, no stories", () => {
    const weak = [story("Routine", ["politics"], 5), story("Armenia routine", ["armenia"], 4, { topic_score: 5, main_topic: "armenia" })];
    for (const cands of [[], weak]) {
      const plan = planDigest(user(ALL), cands, TOPICS, yerevan(14, 5), CFG);
      assert.equal(plan.text, "<p><b>Good afternoon, Sam</b> · Quiet period: nothing important on your topics since 9 AM.</p>");
      assert.equal(plan.kind, "rich");
      assert.deepEqual(plan.storyIds, []);
      assert.equal(plan.cut, 0);
    }
  });
});

describe("message format", () => {
  const S = (summary, topics, extra = {}) => ({ ...story(summary, topics, 7, extra), primary: primaryTopic(topics, ALL) });
  const opts = (o = {}) => ({ now: yerevan(20, 30), tz: TZ, lastDigestAt: yerevan(14), topicInfo: INFO, name: "Sam", ...o });

  const THREE = () => [
    S("x", ["armenia", "politics"], { headline: "Armenia and Turkey agree to open the border.", emojis: "🇦🇲🇹🇷🤝",
      description: "Pashinyan said the border opens in March — after talks.", best_url: "https://ft.test/a?x=1&y=2",
      best_source: "Financial Times" }),
    S("Iran fires missiles at a tanker", ["iran_war", "wars_conflicts"]),
    S("y", ["armenia"], { headline: "A <b> & C", emojis: "🇦🇲" }),
  ];

  test("Step 11 rich message: one-line greeting, a centred box per topic with a line between topics, the editor's " +
       "emojis, bold headline, the outlet as the link, the description in a quote box, no numbers", () => {
    const { text, storyIds, kind } = buildMessage(THREE(), opts());
    assert.equal(kind, "rich");
    assert.equal(text,
      "<p><b>Good evening, Sam</b> · 3 stories since 2 PM</p>" +
      '<table bordered><tr><th align="center">🇦🇲 Armenia</th></tr></table>' +
      '<p>🇦🇲🇹🇷🤝 <b>Armenia and Turkey agree to open the border</b> <i>· <a href="https://ft.test/a?x=1&amp;y=2">Financial Times</a></i></p>' +
      "<blockquote>Pashinyan said the border opens in March, after talks.</blockquote>" +
      '<p>🇦🇲 <b>A &lt;b&gt; &amp; C</b> <i>· <a href="https://x.test/a">Alpha Times</a></i></p>' +          // no description: no quote
      "<hr/>" +                                                                                             // a line between topics
      '<table bordered><tr><th align="center">🇮🇷 Iran War</th></tr></table>' +
      '<p>🇮🇷 <b>Iran fires missiles at a tanker</b> <i>· <a href="https://x.test/a">Alpha Times</a></i></p>');  // dictionary emoji
    assert.equal(storyIds.length, 3);
    assert.doesNotMatch(text, /[—–]/);
    assert.doesNotMatch(text, /<p>d+./);
    // what Telegram stores: the text of the blocks, no separators (checked on a real rich message)
    assert.equal(visibleLength(text), ("Good evening, Sam · 3 stories since 2 PM" + "🇦🇲 Armenia" +
      "🇦🇲🇹🇷🤝 Armenia and Turkey agree to open the border · Financial Times" +
      "Pashinyan said the border opens in March, after talks." + "🇦🇲 A <b> & C · Alpha Times" +
      "🇮🇷 Iran War" + "🇮🇷 Iran fires missiles at a tanker · Alpha Times").length);
  });

  test("the Step 5 layout (CLASSIC) still renders as before, for the fold test and design A", () => {
    const { text, storyIds, kind } = buildMessage(THREE(), opts({ layout: CLASSIC }));
    assert.equal(kind, "html");
    assert.equal(text,
      "Good evening, Sam. Since 2 PM, 3 stories for you:\n\n" +
      "🇦🇲 <b><u>Armenia</u></b>\n\n" +
      "1. 🇦🇲🇹🇷🤝 <b>Armenia and Turkey agree to open the border</b>\n\n" +
      "Pashinyan said the border opens in March, after talks.\n" +
      '<a href="https://ft.test/a?x=1&amp;y=2">Financial Times</a>\n\n' +
      "2. 🇦🇲 <b>A &lt;b&gt; &amp; C</b>\n" +
      '<a href="https://x.test/a">Alpha Times</a>\n\n' +
      "🇮🇷 <b><u>Iran War</u></b>\n\n" +
      "3. 🇮🇷 <b>Iran fires missiles at a tanker</b>\n" +          // no editor text: summary + dictionary emoji
      '<a href="https://x.test/a">Alpha Times</a>');
    assert.equal(storyIds.length, 3);
    assert.doesNotMatch(text, /[—–]/);
  });

  test("12-hour times, no name when unknown, first digest, one story, quiet note", () => {
    assert.equal(clock12({ hour: 14, minute: 0 }), "2 PM");
    assert.equal(clock12({ hour: 14, minute: 30 }), "2:30 PM");
    assert.equal(clock12({ hour: 12, minute: 0 }), "12 PM");
    assert.equal(clock12({ hour: 0, minute: 5 }), "12:05 AM");
    assert.equal(clock12({ hour: 9, minute: 0 }), "9 AM");
    const one = [S("x", ["politics"])];
    assert.match(buildMessage(one, opts({ name: "" })).text, /^<p><b>Good evening<\/b> · 1 story since 2 PM<\/p>/);
    assert.match(buildMessage(one, opts({ now: yerevan(9), lastDigestAt: null })).text,
      /^<p><b>Good morning, Sam<\/b> · 1 story in the last 24 hours<\/p>/);
    assert.match(buildMessage(one, opts({ now: yerevan(9), lastDigestAt: yerevan(9, 0, 11) })).text,
      /^<p><b>Good morning, Sam<\/b> · 1 story in the last 24 hours/);                // more than 24 h ago
    for (const [h, word] of [[11, "Good morning"], [12, "Good afternoon"], [17, "Good afternoon"], [18, "Good evening"]]) {
      assert.ok(buildMessage(one, opts({ now: yerevan(h), lastDigestAt: null })).text.startsWith(`<p><b>${word}`), `${h}`);
    }
    assert.equal(buildMessage([], opts({ now: yerevan(14, 5), lastDigestAt: yerevan(9) })).text,
      "<p><b>Good afternoon, Sam</b> · Quiet period: nothing important on your topics since 9 AM.</p>");
    assert.match(buildMessage(one, opts({ name: "<Ann>" })).text, /^<p><b>Good evening, &lt;Ann&gt;<\/b>/);
  });

  test("dashes are cleaned; a dash in a label is refused", () => {
    assert.equal(cleanHeadline("A — B–C.  "), "A, B-C");
    assert.throws(() => buildMessage([S("x", ["politics"])], { ...opts(), label: "Preview — A" }), /dash/);
  });
});

describe("fallback line emoji (config/line_emoji.json)", () => {
  const cases = [
    ["Donald Trump's envoys offered Vladimir Putin room to stall", "🇺🇸"],          // first actor named
    ["Delegations from Russia, Ukraine, and the United States met", "🇷🇺"],
    ["The US Supreme Court agreed to hear the appeal", "🇺🇸"],
    ["The U.S. Treasury announced new sanctions", "🇺🇸"],
    ["IEA analysts warned after the US-Iran war", "🛢️"],                               // hyphen splits
    ["Iran's foreign minister Abbas Araghchi said", "🇮🇷"],                            // possessive
    ["Talks continue in St. Petersburg", "🇷🇺"],                                       // multi-word name
    ["Houthis claim a missile attack on a ship", "🇾🇪"],
    ["Israeli strikes on Gaza's Nasser Hospital killed six", "🇮🇱"],
    ["Pashinyan meets Aliyev", "🇦🇲"],
    ["The International Criminal Court closed its investigation", "⚖️"],
    ["Ceasefire holds for a third day", "🕊️"],                                         // no actor: subject
    ["Voters back the pension referendum", "🗳️"],
    ["Let us know what the court decides", "⚖️"],                                      // lowercase "us" is not the US
    ["A rescue worker died after a slab collapsed", "·"],                              // nothing: fallback
  ];
  for (const [headline, emoji] of cases) {
    test(`${emoji}  ${headline}`, () => assert.equal(lineEmoji(headline, "·"), emoji));
  }
});

describe("time slots", () => {
  test("next slot in Yerevan", () => {
    const times = ["09:00", "14:00", "20:00"];
    assert.equal(nextSlot(yerevan(8, 59), TZ, times), yerevan(9));
    assert.equal(nextSlot(yerevan(9), TZ, times), yerevan(14));
    assert.equal(nextSlot(yerevan(14, 5), TZ, times), yerevan(20));
    assert.equal(nextSlot(yerevan(21), TZ, times), yerevan(9, 0, 14));
  });
  test("daylight saving: Berlin 09:00 stays 09:00 local across the change", () => {
    const tz = "Europe/Berlin";
    const before = zonedToUtc(2026, 10, 24, 21, 0, tz);   // Sat 24 Oct, CEST (UTC+2)
    const slot = nextSlot(before, tz, ["09:00"]);
    assert.equal(slot, Date.UTC(2026, 9, 25, 8, 0) / 1000);   // Sun 25 Oct, CET (UTC+1)
    const spring = nextSlot(zonedToUtc(2026, 3, 28, 21, 0, tz), tz, ["09:00"]);
    assert.equal(spring, Date.UTC(2026, 2, 29, 7, 0) / 1000);
  });
  test("New York and a list given out of order", () => {
    const tz = "America/New_York";
    const now = zonedToUtc(2026, 11, 13, 10, 0, tz);
    assert.equal(nextSlot(now, tz, ["20:00", "07:00"]), zonedToUtc(2026, 11, 13, 20, 0, tz));
  });
});

describe("planDigest", () => {
  test("uses the user's topics, name and zone, and returns the next slot", () => {
    const user = { id: OWNER, first_name: "Sam", topics: JSON.stringify(["armenia"]), timezone: TZ,
      digest_times: '["09:00","14:00","20:00"]', last_digest_at: null };
    const plan = planDigest(user, [story("Armenia votes on budget", ["armenia"], 7, { headline: "Armenia passes its budget" })],
      TOPICS, yerevan(14, 5));
    assert.equal(plan.stories.length, 1);
    assert.equal(plan.nextAt, yerevan(20));
    assert.match(plan.text, /^<p><b>Good afternoon, Sam<\/b> · 1 story in the last 24 hours<\/p><table bordered><tr><th align="center">🇦🇲 Armenia<\/th><\/tr><\/table><p>🇦🇲 <b>Armenia passes/);
    assert.equal(plan.button, undefined);
  });
});
