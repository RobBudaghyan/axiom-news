// Selection, topic cap, dup_group dedupe, message format and time math (src/digest.js).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG, buildMessage, candidateStatement, cleanHeadline, dedupe, digestSince, lineEmoji, nextSlot, pickStories,
  planDigest, primaryTopic, topicCap, topicInfoFrom, visibleLength, zonedToUtc,
} from "../src/digest.js";
import { ALL, OWNER, TOPIC_ROWS, TZ, addStory, addUser, fakeD1, yerevan } from "./helpers.mjs";

const TOPICS = TOPIC_ROWS.map(([tag, label_en, emoji, sort]) => ({ tag, label_en, emoji, sort, is_default: 1 }));
const INFO = topicInfoFrom(TOPICS);
let nextId = 1;
const story = (summary, topics, importance = 5, extra = {}) => ({
  id: nextId++, summary, topics: JSON.stringify(topics), importance, best_url: "https://x.test/a",
  best_source: "Alpha Times", ...extra,
});

describe("candidate SQL (real schema)", () => {
  async function setup() {
    const { db, sqlite } = fakeD1();
    const now = yerevan(14, 5);
    const t = now - 3600;
    const ids = {
      big: addStory(sqlite, "Big", ["iran_war", "wars_conflicts"], 8, t),
      midNew: addStory(sqlite, "Mid newer", ["armenia"], 5, t + 60),
      midOld: addStory(sqlite, "Mid older", ["russia"], 5, t),
      low: addStory(sqlite, "Low", ["politics"], 3, t),
      old: addStory(sqlite, "Old", ["politics"], 9, now - 25 * 3600),
      sent: addStory(sqlite, "Already sent", ["politics"], 9, t),
    };
    sqlite.prepare("INSERT INTO sent (user_id, story_id, sent_at) VALUES (?, ?, ?)").run(OWNER, ids.sent, t);
    const run = async (user) => {
      const s = candidateStatement({ id: OWNER, topics: JSON.stringify(ALL), last_digest_at: null, ...user }, now);
      return (await db.query(s.sql, s.params)).map((r) => r.summary);
    };
    return { run, now, t };
  }

  test("filters (importance, 24 h, never sent) and order", async () => {
    const { run } = await setup();
    assert.deepEqual(await run({}), ["Big", "Mid newer", "Mid older"]);
  });
  test("topic filter", async () => {
    const { run } = await setup();
    assert.deepEqual(await run({ topics: '["armenia","ukraine_war"]' }), ["Mid newer"]);
  });
  test("since the last digest", async () => {
    const { run, t } = await setup();
    assert.deepEqual(await run({ last_digest_at: t + 30 }), ["Mid newer"]);
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

describe("topic cap", () => {
  test("cap = ceil(0.4 x N), at least 1", () => {
    assert.equal(topicCap(7), 3);
    assert.equal(topicCap(5), 2);
    assert.equal(topicCap(15), 6);
    assert.equal(topicCap(10), 4);
    assert.equal(topicCap(1), 1);
    assert.equal(topicCap(3), 2);
  });
  test("counts a story against its most specific topic among the user's", () => {
    assert.equal(primaryTopic(["wars_conflicts", "ukraine_war"], ALL), "ukraine_war");
    assert.equal(primaryTopic(["politics", "russia"], ALL), "russia");
    assert.equal(primaryTopic(["wars_conflicts", "ukraine_war"], ["wars_conflicts"]), "wars_conflicts");
  });
  test("at most 3 of 7 from one topic; others move up", () => {
    const ua = UA.map((s, i) => story(s, ["wars_conflicts", "ukraine_war"], 9 - i * 0.1));
    const others = [story("Armenia parliament passes budget", ["politics", "armenia"], 5),
      story("Iran missile strike on tanker", ["iran_war", "wars_conflicts"], 4),
      story("French government survives confidence vote", ["politics"], 4),
      story("Kremlin replaces central bank chief", ["russia", "politics"], 4)];
    const picked = pickStories([...ua, ...others], ALL, 7);
    assert.equal(picked.length, 7);
    assert.equal(picked.filter((s) => s.primary === "ukraine_war").length, 3);
    assert.deepEqual(picked.slice(0, 3).map((s) => s.summary), ua.slice(0, 3).map((s) => s.summary));
  });
  test("empty slots are filled with the next most important when nothing else qualifies", () => {
    const ua = UA.map((s, i) => story(s, ["ukraine_war"], 9 - i));
    const picked = pickStories([...ua, story("Armenia election date set for June", ["armenia"], 4)], ALL, 7);
    assert.equal(picked.length, 7);
    // all 6 Ukraine stories are used (3 by the cap, 3 to fill), and rank order is kept
    assert.deepEqual(picked.map((s) => s.summary), [...UA, "Armenia election date set for June"]);
  });
  test("the share is a config value", () => {
    const ua = UA.map((s, i) => story(s, ["ukraine_war"], 9 - i));
    const rest = [...POL.map((s) => story(s, ["politics"], 4)),
      story("Armenia and Georgia sign a rail transit deal", ["armenia"], 4),
      story("Yerevan hosts EU monitoring mission talks", ["armenia"], 4),
      story("Kremlin replaces the head of the central bank", ["russia"], 4)];
    const cfg = { ...CONFIG, max_topic_share: 0.2 };   // cap 2 of 7
    const picked = pickStories([...ua, ...rest], ALL, 7, cfg);
    assert.equal(picked.filter((s) => s.primary === "ukraine_war").length, 2);
  });
});

describe("near-duplicates (groups come from the job, job/dupes.py)", () => {
  test("only the first story of each dup_group is used; the more important one wins", () => {
    const lead = story("Ceasefire agreed between Israel and Hezbollah in Lebanon", ["iran_war"], 8);
    const dup = story("Israel and Hezbollah agree Lebanon ceasefire", ["iran_war"], 6, { dup_group: lead.id });
    lead.dup_group = lead.id;
    const other = story("Armenia sets an election date", ["armenia"], 5);   // dup_group null: never grouped
    assert.deepEqual(dedupe([lead, dup, other]).kept.map((s) => s.id), [lead.id, other.id]);
    assert.deepEqual(pickStories([lead, dup, other], ALL, 7).map((s) => s.id), [lead.id, other.id]);
  });
  test("a duplicate is still dropped when its leader was held back by the topic cap", () => {
    const ua = UA.slice(0, 3).map((s, i) => story(s, ["ukraine_war"], 9 - i));
    const lead = story("Kyiv metro station hit by a missile", ["ukraine_war"], 5);
    const dup = story("Missile hits Kyiv metro station", ["ukraine_war"], 5, { dup_group: lead.id });
    lead.dup_group = lead.id;
    const picked = pickStories([...ua, lead, dup], ALL, 7);
    assert.equal(picked.length, 4);   // 3 by the cap, then the filler: the leader only
    assert.ok(!picked.some((s) => s.id === dup.id));
  });
});

describe("message format", () => {
  const S = (summary, topics, extra) => ({ ...story(summary, topics, 5, extra), primary: primaryTopic(topics, ALL) });

  test("format A: numbered, context emoji, bold headline, Source line, blank line between", () => {
    const { text } = buildMessage([
      S("Israel and Iran agree a 30-day ceasefire — Qatar mediated.", ["iran_war", "wars_conflicts"],
        { best_url: "https://ft.test/a?x=1&y=2", best_source: "Financial Times" }),
      S("A <b> & C", ["politics"], {}),
    ], { now: yerevan(20, 30), tz: TZ, lastDigestAt: yerevan(14), topicInfo: INFO, format: "A" });
    assert.equal(text,
      "Good evening. Since 14:00, 2 stories on your topics:\n\n" +
      "1. 🇮🇱 <b>Israel and Iran agree a 30-day ceasefire, Qatar mediated</b>\n" +   // first actor named
      'Source: <a href="https://ft.test/a?x=1&amp;y=2">Financial Times</a>\n\n' +
      "2. 🏛️ <b>A &lt;b&gt; &amp; C</b>\n" +
      'Source: <a href="https://x.test/a">Alpha Times</a>');
    assert.doesNotMatch(text, /[—–]/);
  });

  test("format B (default): bold topic headings, numbering inside each group, a context emoji per line", () => {
    const { text } = buildMessage([
      S("Russian drones hit a power plant in Kharkiv", ["ukraine_war"]),
      S("Pashinyan and Aliyev meet in Abu Dhabi", ["armenia"]),
      S("Zelensky asks Washington for more Patriots", ["ukraine_war", "wars_conflicts"]),
      S("Prisoner exchange returns 150 soldiers home", ["ukraine_war"]),
    ], { now: yerevan(9), tz: TZ, lastDigestAt: null, topicInfo: INFO });
    const src = '\nSource: <a href="https://x.test/a">Alpha Times</a>';
    assert.equal(text,
      "Good morning. In the last 24 hours, 4 stories on your topics:\n\n" +
      `<b>🇺🇦 Ukraine War</b>\n1. 🇷🇺 <b>Russian drones hit a power plant in Kharkiv</b>${src}\n\n` +
      `2. 🇺🇦 <b>Zelensky asks Washington for more Patriots</b>${src}\n\n` +
      `3. 🇺🇦 <b>Prisoner exchange returns 150 soldiers home</b>${src}\n\n` +   // no actor, no subject: topic emoji
      `<b>🇦🇲 Armenia</b>\n1. 🇦🇲 <b>Pashinyan and Aliyev meet in Abu Dhabi</b>${src}`);
  });

  test("line_emoji: false keeps format B plain and format A on topic emojis", () => {
    const cfg = { ...CONFIG, line_emoji: false };
    const list = [S("Russian drones hit Kharkiv", ["ukraine_war"])];
    const opts = { now: yerevan(9), tz: TZ, lastDigestAt: null, topicInfo: INFO };
    assert.match(buildMessage(list, { ...opts, format: "B" }, cfg).text, /\n1\. <b>Russian/);
    assert.match(buildMessage(list, { ...opts, format: "A" }, cfg).text, /\n1\. 🇺🇦 <b>Russian/);
  });

  test("greetings by local hour, first digest and quiet period", () => {
    for (const [h, word] of [[9, "Good morning"], [11, "Good morning"], [12, "Good afternoon"], [17, "Good afternoon"], [18, "Good evening"]]) {
      assert.ok(buildMessage([S("x", ["politics"])], { now: yerevan(h), tz: TZ, lastDigestAt: null, topicInfo: INFO })
        .text.startsWith(word), `${h}`);
    }
    assert.ok(buildMessage([S("x", ["politics"])], { now: yerevan(9), tz: TZ, lastDigestAt: null, topicInfo: INFO })
      .text.startsWith("Good morning. In the last 24 hours, 1 story on your topics:"));
    assert.equal(buildMessage([], { now: yerevan(14, 5), tz: TZ, lastDigestAt: yerevan(9), topicInfo: INFO }).text,
      "Good afternoon. Quiet period: nothing important on your topics since 09:00.");
  });

  test("15 long stories fit in 4,096 characters as Telegram counts them", () => {
    const long = "Russian and Ukrainian negotiators in Abu Dhabi agreed a framework for a prisoner exchange of 1,200 people and a partial energy ceasefire, officials said";
    const list = Array.from({ length: 15 }, (_, i) => S(`${long} ${i}`, ["ukraine_war"],
      { best_url: `https://www.example-news-site.test/world/europe/2026/11/13/very-long-slug-${i}-${"x".repeat(150)}`, best_source: "The New York Times" }));
    for (const format of ["A", "B"]) {
      const { text, stories } = buildMessage(list, { now: yerevan(20), tz: TZ, lastDigestAt: null, topicInfo: INFO, format });
      assert.equal(stories.length, 15);
      assert.ok(visibleLength(text) <= 4096, `${format}: ${visibleLength(text)}`);
    }
  });

  test("too long: lowest-ranked stories are dropped and the count follows", () => {
    const big = "word ".repeat(55).trim();   // ~275 chars per headline
    const list = Array.from({ length: 15 }, (_, i) => S(`${big} ${i}`, ["politics"]));
    const { text, stories } = buildMessage(list, { now: yerevan(20), tz: TZ, lastDigestAt: null, topicInfo: INFO },
      { ...CONFIG, message_char_budget: 2000 });
    assert.ok(stories.length < 15 && stories.length > 0);
    assert.ok(visibleLength(text) <= 2000);
    assert.ok(text.includes(`, ${stories.length} stories on your topics:`));
    assert.equal(stories[0].summary, list[0].summary);
  });

  test("one huge headline is cut at a word with ...", () => {
    const { text } = buildMessage([S("long ".repeat(400), ["politics"])],
      { now: yerevan(20), tz: TZ, lastDigestAt: null, topicInfo: INFO }, { ...CONFIG, message_char_budget: 500 });
    assert.ok(visibleLength(text) <= 500);
    assert.match(text, /long\.\.\.<\/b>/);
  });

  test("headline cleanup: dashes and trailing period", () => {
    assert.equal(cleanHeadline("A — B–C.  "), "A, B-C");
    assert.throws(() => buildMessage([S("x", ["politics"])], { now: yerevan(9), tz: TZ, topicInfo: INFO,
      label: "Preview — A" }), /dash/);
  });
});

describe("line emoji (config/line_emoji.json)", () => {
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
    assert.equal(nextSlot(now, tz, ["20:00", "07:30"]), zonedToUtc(2026, 11, 13, 20, 0, tz));
  });
});

describe("planDigest", () => {
  test("uses the user's count, topics and zone, and returns the next slot", async () => {
    const user = { id: OWNER, topics: JSON.stringify(["armenia"]), max_stories: 3, timezone: TZ,
      digest_times: '["09:00","14:00","20:00"]', last_digest_at: null };
    const plan = planDigest(user, [story("Armenia votes on budget", ["armenia"], 6)], TOPICS, yerevan(14, 5));
    assert.equal(plan.stories.length, 1);
    assert.equal(plan.nextAt, yerevan(20));
    assert.match(plan.text, /^Good afternoon\. In the last 24 hours, 1 story on your topics:\n\n<b>🇦🇲 Armenia<\/b>\n1\. 🇦🇲 <b>Armenia votes/);
  });
});
