// Selection (bars, topic guarantee, cap, max), dup_group dedupe, message format and split, and
// time math (src/digest.js).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG, buildMessage, candidateStatement, cleanHeadline, clock12, dedupe, digestSince, lineEmoji, nextSlot,
  pickStories, planDigest, primaryTopic, storyScore, topicCap, topicInfoFrom, visibleLength, zonedToUtc,
} from "../src/digest.js";
import { ALL, OWNER, TOPIC_ROWS, TZ, addStory, fakeD1, yerevan } from "./helpers.mjs";

const TOPICS = TOPIC_ROWS.map(([tag, label_en, emoji, sort]) => ({ tag, label_en, emoji, sort, is_default: 1 }));
const INFO = topicInfoFrom(TOPICS);
let nextId = 1;
// A candidate row as CANDIDATE_SQL returns it. score = the editor's final_score.
const story = (summary, topics, score = 7, extra = {}) => ({
  id: nextId++, summary, topics: JSON.stringify(topics), importance: 6, final_score: score,
  best_url: "https://x.test/a", best_source: "Alpha Times", ...extra,
});
const ids = (list) => list.map((s) => s.id);

describe("candidate SQL (real schema)", () => {
  async function setup() {
    const { db, sqlite } = fakeD1();
    const now = yerevan(14, 5);
    const t = now - 3600;
    const add = (name, topics, importance, extra, at = t) => addStory(sqlite, name, topics, importance, at, extra);
    const ids = {
      edited8: add("Edited 8", ["iran_war", "wars_conflicts"], 5, { final_score: 8 }),
      edited6: add("Edited 6", ["armenia"], 9, { final_score: 6 }),          // the editor's score wins
      unedited9: add("Unedited 9", ["russia"], 9),                           // 9 - offset 2 = 7
      unedited7: add("Unedited 7", ["russia"], 7),                           // 5: below the topic bar
      edited5: add("Edited 5", ["politics"], 9, { final_score: 5 }),
      old: add("Old", ["politics"], 9, { final_score: 9 }, now - 25 * 3600),
      sent: add("Already sent", ["politics"], 9, { final_score: 9 }),
      merged: add("Merged away", ["politics"], 9, { final_score: 9, merged_into: 1 }),
    };
    sqlite.prepare("INSERT INTO sent (user_id, story_id, sent_at) VALUES (?, ?, ?)").run(OWNER, ids.sent, t);
    const run = async (user) => {
      const s = candidateStatement({ id: OWNER, topics: JSON.stringify(ALL), last_digest_at: null, ...user }, now);
      return (await db.query(s.sql, s.params)).map((r) => r.summary);
    };
    return { run, now, t };
  }

  test("topic bar on the editor's score (or importance minus the offset), 24 h, never sent, not merged; best first", async () => {
    const { run } = await setup();
    assert.deepEqual(await run({}), ["Edited 8", "Unedited 9", "Edited 6"]);
  });
  test("topic filter and since the last digest", async () => {
    const { run, t } = await setup();
    assert.deepEqual(await run({ topics: '["armenia","ukraine_war"]' }), ["Edited 6"]);
    assert.deepEqual(await run({ last_digest_at: t + 30 }), []);
  });
  test("a story sent to another user does not block", async () => {
    const { run } = await setup();
    assert.ok((await run({ id: 7 })).includes("Already sent"));
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
const POL = [
  "French government survives a confidence vote", "Japan's parliament elects a new prime minister",
  "Brazil's Supreme Court upholds the election law", "Canada announces tariffs on steel imports",
  "Poland's president vetoes the media bill", "South Korea calls a snap general election",
];

describe("selection", () => {
  test("only stories that clear the editorial bar, best first; a quiet digest when none does", () => {
    const list = [story("A", ["politics"], 8), story("B", ["russia"], 7), story("C", ["politics"], 6.9)];
    assert.deepEqual(pickStories(list, ["politics", "russia"]).map((s) => s.summary), ["A", "B"]);
    assert.deepEqual(pickStories([story("D", ["politics"], 6, { topics: '["politics"]' })], ["russia"]), []);
    assert.deepEqual(pickStories([], ALL), []);
  });

  test("each followed topic gets its best story if it clears the lower topic bar", () => {
    const arm6 = story("CSTO strips Armenia of voting rights", ["armenia", "politics"], 6);
    const arm5 = story("Pashinyan visits Dublin", ["armenia"], 5);
    const pol8 = story("Big politics story", ["politics"], 8);
    const pol6 = story("Smaller politics story", ["politics"], 6);
    const picked = pickStories([pol8, arm6, pol6, arm5], ["politics", "armenia"]);
    assert.deepEqual(ids(picked), [pol8.id, arm6.id]);            // pol6: not the topic's best, below 7
    assert.equal(picked[1].primary, "armenia");
    assert.deepEqual(pickStories([pol8, arm6], ["politics"]).map((s) => s.id), [pol8.id]);   // not followed
    assert.deepEqual(ids(pickStories([arm5], ["armenia"])), []);                              // below the topic bar
  });

  test("a guaranteed story is shown under the topic it is guaranteed for", () => {
    const ua = story("Strike on Kharkiv", ["ukraine_war", "wars_conflicts"], 8);
    const both = story("Armenia sends aid to Ukraine", ["ukraine_war", "armenia"], 6);
    const picked = pickStories([ua, both], ["ukraine_war", "armenia", "wars_conflicts"]);
    assert.deepEqual(picked.map((s) => [s.summary, s.primary]),
      [["Strike on Kharkiv", "ukraine_war"], ["Armenia sends aid to Ukraine", "armenia"]]);
  });

  test("a topic whose best story is shown under another topic still gets its own section", () => {
    const summit = story("Trump, Putin and Xi to meet in China", ["politics", "wars_conflicts", "russia", "iran_war"], 8);
    const pol = story("Germany widens spy agency powers", ["politics"], 6);
    const rus = story("Russian court jails a lawyer for 12 years", ["russia", "politics"], 6);
    const picked = pickStories([summit, pol, rus], ["politics", "russia", "iran_war"]);
    assert.deepEqual(picked.map((s) => [s.summary, s.primary]), [
      ["Trump, Putin and Xi to meet in China", "iran_war"],          // its most specific topic
      ["Germany widens spy agency powers", "politics"],
      ["Russian court jails a lawyer for 12 years", "russia"]]);
    const two = story("Kremlin reshuffles ministers", ["russia"], 7);   // russia covered by a strong story
    assert.deepEqual(ids(pickStories([summit, two, rus], ["russia", "iran_war"])), [summit.id, two.id]);
  });

  test("a story the editor did not score uses its first-pass importance minus the offset", () => {
    assert.equal(storyScore({ final_score: null, importance: 9 }), 7);
    assert.equal(storyScore({ final_score: 4, importance: 9 }), 4);
    const unedited = story("Unedited big story", ["politics"], null, { importance: 9 });
    const weak = story("Unedited mid story", ["russia"], null, { importance: 7 });
    assert.deepEqual(ids(pickStories([unedited, weak], ALL)), [unedited.id]);
  });

  test("hard maximum of 12", () => {
    const list = [...UA.map((s) => story(s, ["ukraine_war"], 9)), ...POL.map((s) => story(s, ["politics"], 8)),
      story("Armenia 1", ["armenia"], 8), story("Armenia 2", ["armenia"], 8), story("Russia 1", ["russia"], 8),
      story("Russia 2", ["russia"], 8), story("Iran 1", ["iran_war"], 8), story("Iran 2", ["iran_war"], 8)];
    const picked = pickStories(list, ALL);
    assert.equal(picked.length, 12);
    for (const t of ALL) assert.ok(picked.filter((s) => s.primary === t).length <= topicCap(12));
  });

  test("cap = max(2, ceil(0.4 x N)), recomputed for the size actually picked", () => {
    assert.equal(topicCap(12), 5);
    assert.equal(topicCap(10), 4);
    assert.equal(topicCap(7), 3);
    assert.equal(topicCap(5), 2);
    assert.equal(topicCap(3), 2);
    assert.equal(topicCap(1), 2);
    // 6 strong Ukraine stories and 2 politics ones: 8 wanted, cap 4 -> 6 picked, cap 3 -> 5,
    // cap 2 -> 4: two of each. No topic exceeds 40% (or 2) of the digest it ends up in.
    const ua = UA.map((s, i) => story(s, ["ukraine_war"], 9 - i * 0.1));
    const pol = POL.slice(0, 2).map((s) => story(s, ["politics"], 7));
    const picked = pickStories([...ua, ...pol], ALL);
    assert.equal(picked.length, 4);
    assert.deepEqual(picked.map((s) => s.summary), [UA[0], UA[1], POL[0], POL[1]]);
    const three = pickStories([...ua.slice(0, 2), story("One more", ["russia"], 7)], ALL);
    assert.equal(three.length, 3);                          // 2 of 3 from one topic: the minimum cap
  });

  test("the share is a config value", () => {
    const list = [...UA.map((s) => story(s, ["ukraine_war"], 9)), ...POL.map((s) => story(s, ["politics"], 8))];
    const picked = pickStories(list, ALL, { ...CONFIG, max_topic_share: 0.5 });
    assert.equal(picked.length, 12);
    assert.equal(picked.filter((s) => s.primary === "ukraine_war").length, 6);
  });

  test("near-duplicates: only the first story of each dup_group", () => {
    const lead = story("Ceasefire agreed between Israel and Hezbollah", ["iran_war"], 8);
    lead.dup_group = lead.id;
    const dup = story("Israel and Hezbollah agree Lebanon ceasefire", ["iran_war"], 8, { dup_group: lead.id });
    const other = story("Armenia sets an election date", ["armenia"], 7);
    assert.deepEqual(ids(dedupe([lead, dup, other]).kept), [lead.id, other.id]);
    assert.deepEqual(ids(pickStories([lead, dup, other], ALL)), [lead.id, other.id]);
  });

  test("counts a story against its most specific topic among the user's", () => {
    assert.equal(primaryTopic(["wars_conflicts", "ukraine_war"], ALL), "ukraine_war");
    assert.equal(primaryTopic(["politics", "russia"], ALL), "russia");
    assert.equal(primaryTopic(["wars_conflicts", "ukraine_war"], ["wars_conflicts"]), "wars_conflicts");
  });

  test("the editor's main topic wins when the user follows it", () => {
    const tags = ["politics", "russia", "iran_war"];
    assert.equal(primaryTopic(tags, ALL, CONFIG.topic_specificity, "politics"), "politics");
    assert.equal(primaryTopic(tags, ["russia", "iran_war"], CONFIG.topic_specificity, "politics"), "iran_war");
    const summit = story("Trump, Putin and Xi to meet", JSON.parse(JSON.stringify(tags)), 8, { main_topic: "politics" });
    assert.equal(pickStories([summit], ALL)[0].primary, "politics");
  });
});

describe("message format", () => {
  const S = (summary, topics, extra = {}) => ({ ...story(summary, topics, 7, extra), primary: primaryTopic(topics, ALL) });
  const opts = (o = {}) => ({ now: yerevan(20, 30), tz: TZ, lastDigestAt: yerevan(14), topicInfo: INFO, name: "Sam", ...o });

  test("greeting, underlined topic headings, numbered stories with emojis, description and the outlet link", () => {
    const { parts, partStories } = buildMessage([
      S("x", ["armenia", "politics"], { headline: "Armenia and Turkey agree to open the border.", emojis: "🇦🇲🇹🇷🤝",
        description: "Pashinyan said the border opens in March — after talks.", best_url: "https://ft.test/a?x=1&y=2",
        best_source: "Financial Times" }),
      S("Iran fires missiles at a tanker", ["iran_war", "wars_conflicts"]),
      S("y", ["armenia"], { headline: "A <b> & C", emojis: "🇦🇲" }),
    ], opts());
    assert.equal(parts.length, 1);
    assert.equal(parts[0],
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
    assert.deepEqual(partStories[0].length, 3);
    assert.doesNotMatch(parts[0], /[—–]/);
  });

  test("12-hour times, no name when unknown, first digest, one story, quiet note", () => {
    assert.equal(clock12({ hour: 14, minute: 0 }), "2 PM");
    assert.equal(clock12({ hour: 14, minute: 30 }), "2:30 PM");
    assert.equal(clock12({ hour: 12, minute: 0 }), "12 PM");
    assert.equal(clock12({ hour: 0, minute: 5 }), "12:05 AM");
    assert.equal(clock12({ hour: 9, minute: 0 }), "9 AM");
    const one = [S("x", ["politics"])];
    assert.match(buildMessage(one, opts({ name: "" })).parts[0], /^Good evening\. Since 2 PM, 1 story for you:/);
    assert.match(buildMessage(one, opts({ now: yerevan(9), lastDigestAt: null })).parts[0],
      /^Good morning, Sam\. In the last 24 hours, 1 story for you:/);
    assert.match(buildMessage(one, opts({ now: yerevan(9), lastDigestAt: yerevan(9, 0, 11) })).parts[0],
      /^Good morning, Sam\. In the last 24 hours/);                // more than 24 h ago
    for (const [h, word] of [[11, "Good morning"], [12, "Good afternoon"], [17, "Good afternoon"], [18, "Good evening"]]) {
      assert.ok(buildMessage(one, opts({ now: yerevan(h), lastDigestAt: null })).parts[0].startsWith(word), `${h}`);
    }
    assert.deepEqual(buildMessage([], opts({ now: yerevan(14, 5), lastDigestAt: yerevan(9) })).parts,
      ["Good afternoon, Sam. Quiet period: nothing important on your topics since 9 AM."]);
    assert.match(buildMessage(one, opts({ name: "<Ann>" })).parts[0], /^Good evening, &lt;Ann&gt;\./);
  });

  test("12 long stories fit, split into 2 messages at a topic heading, none dropped, numbering runs on", () => {
    const desc = "Russian and Ukrainian negotiators in Abu Dhabi agreed a framework for a prisoner exchange of 1,200 people. " +
      "Officials said a partial energy ceasefire could follow next week if both sides keep to the terms. " +
      "The talks are due to resume on Monday in the same format with US mediators present throughout.";
    const head = "Russian and Ukrainian negotiators agree a framework for a prisoner exchange and a partial energy ceasefire";
    const topics = [["ukraine_war"], ["politics"], ["russia"], ["armenia"]];
    const list = Array.from({ length: 12 }, (_, i) => S("x", topics[i % 4], {
      headline: `${head} ${i}`, description: desc, emojis: "🇷🇺🇺🇦🤝",
      best_url: `https://www.example-news-site.test/world/europe/2026/11/13/very-long-slug-${i}`, best_source: "The New York Times" }))
      .sort((a, b) => topics.findIndex((t) => t[0] === a.primary) - topics.findIndex((t) => t[0] === b.primary));
    const { parts, partStories } = buildMessage(list, opts());
    assert.equal(parts.length, 2);
    assert.deepEqual(partStories.flat().sort((a, b) => a - b), ids(list).sort((a, b) => a - b));
    for (const p of parts) assert.ok(visibleLength(p) <= CONFIG.message_char_budget, `${visibleLength(p)}`);
    assert.match(parts[1], /^(🏛️|🇷🇺|🇦🇲|🇺🇦) <b><u>/);           // the second message starts at a topic
    const k = partStories[0].length;
    assert.ok(parts[1].includes(`\n\n${k + 1}. 🇷🇺🇺🇦🤝`) || parts[1].includes(`\n${k + 1}. `));
    assert.match(parts[0], /^Good evening, Sam\. Since 2 PM, 12 stories for you:/);
  });

  test("one topic too long for one message: split between two stories", () => {
    const list = Array.from({ length: 6 }, (_, i) => S("x", ["politics"], { headline: `Headline ${i} ${"word ".repeat(30)}`,
      description: "A sentence. ".repeat(30) }));
    const { parts, partStories } = buildMessage(list, opts(), { ...CONFIG, message_char_budget: 1500 });
    assert.ok(parts.length >= 2);
    assert.equal(partStories.flat().length, 6);
    assert.match(parts[1], /^\d+\. /);
    for (const p of parts) assert.ok(visibleLength(p) <= 1500);
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
    assert.match(plan.parts[0], /^Good afternoon, Sam\. In the last 24 hours, 1 story for you:\n\n🇦🇲 <b><u>Armenia<\/u><\/b>\n\n1\. 🇦🇲 <b>Armenia passes/);
  });
});
