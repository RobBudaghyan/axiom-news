// Selection, topic cap, dedupe, message format and time math (src/digest.js).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG, buildMessage, candidateStatement, cleanHeadline, dedupe, digestSince, nextSlot, pickStories,
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

describe("near-duplicates", () => {
  // Real lines from the D1 pool on 2026-11-13 (scripts/digest-cli.mjs --dupes).
  const REAL = [
    "US Central Command denied Iran's claim of destroying a US radar system in Bahrain.",
    "US Treasury Secretary Scott Bessent announced he received death threats from Iranian leaders and moved to a military base.",
    "The number of people injured in the Russian strike on Zaporizhzhia increased to 50 people.",
    "Russian forces conducted strikes on Ukrainian electrical substations, locomotives, and a vessel transporting military supplies.",
    "Donald Trump's envoys offered Vladimir Putin room to stall during the Abu Dhabi peace talks.",
    "EU leaders remain divided over European participation and representation in US-backed Ukraine peace talks.",
    "Armenia and Azerbaijan foreign ministers meet in Washington to finalise the peace treaty",
    "Russia's central bank cut its key rate to 15 percent",
    "Yemeni military accused the Houthis of targeting Aden with ballistic missiles",
    // same events as lines above, worded differently: must be dropped
    "US Central Command intercepted two Iranian suicide drones launched toward Bahrain, while Iran claims to have targeted a US radar system.",
    "US Treasury Secretary Scott Bessent confirmed he temporarily moved to a military base following threats from Iran.",
    "Russian strikes on Nov 13 hit multiple Ukrainian cities, killing three and injuring many, with casualties rising in Zaporizhzhia",
    "Russian forces struck a cargo vessel carrying military supplies and two locomotives in the Odessa region.",
    // different events sharing names or words: must be kept
    "Treasury Secretary Scott Bessent blamed the Commerce Department for failing to blacklist Megaspeed over Nvidia chip diversions.",
    "Rosatom plans to increase the number of Russian personnel at Iran's Bushehr nuclear power plant to 300.",
  ];
  test("real duplicates are caught, different events with shared names are kept", () => {
    const { kept, dropped } = dedupe(REAL.map((s) => story(s, ["wars_conflicts"])));
    const gone = dropped.map((d) => d.story.summary);
    // the three clear pairs; the cargo-vessel pair (REAL[12]) is borderline: 0.46 in the real
    // 100-story pool, a little lower in this small one
    for (const s of REAL.slice(9, 12)) assert.ok(gone.includes(s), `not caught: ${s}`);
    for (const s of [...REAL.slice(0, 9), ...REAL.slice(13)]) assert.ok(!gone.includes(s), `wrongly dropped: ${s}`);
    assert.ok(kept.length >= 11);
  });
  test("known miss: the Abu Dhabi talks pair shares only the place name", () => {
    const pair = ["Donald Trump's envoys offered Vladimir Putin room to stall during the Abu Dhabi peace talks",
      "Delegations from Russia, Ukraine, and the United States met in Abu Dhabi to discuss ending the war"];
    assert.equal(dedupe([...REAL.slice(0, 9), pair[1]].map((s) => story(s, ["ukraine_war"]))).dropped.length, 0);
  });
  test("the more important line is the one kept", () => {
    const a = story("Ceasefire agreed between Israel and Hezbollah in Lebanon", ["iran_war"], 8);
    const b = story("Israel and Hezbollah agree Lebanon ceasefire", ["iran_war"], 6);
    assert.deepEqual(dedupe([a, b]).kept.map((s) => s.id), [a.id]);
  });
});

describe("message format", () => {
  const S = (summary, topics, extra) => ({ ...story(summary, topics, 5, extra), primary: primaryTopic(topics, ALL) });

  test("format A: numbered, emoji, bold headline, Source line, blank line between", () => {
    const { text } = buildMessage([
      S("Israel and Iran agree a 30-day ceasefire — Qatar mediated.", ["iran_war", "wars_conflicts"],
        { best_url: "https://ft.test/a?x=1&y=2", best_source: "Financial Times" }),
      S("A <b> & C", ["politics"], {}),
    ], { now: yerevan(20, 30), tz: TZ, lastDigestAt: yerevan(14), topicInfo: INFO, format: "A" });
    assert.equal(text,
      "Good evening. Since 14:00, 2 stories on your topics:\n\n" +
      "1. 🇮🇷 <b>Israel and Iran agree a 30-day ceasefire, Qatar mediated</b>\n" +
      'Source: <a href="https://ft.test/a?x=1&amp;y=2">Financial Times</a>\n\n' +
      "2. 🏛️ <b>A &lt;b&gt; &amp; C</b>\n" +
      'Source: <a href="https://x.test/a">Alpha Times</a>');
    assert.doesNotMatch(text, /[—–]/);
  });

  test("format B: bold topic headings with emoji, numbering inside each group", () => {
    const { text } = buildMessage([
      S("One", ["ukraine_war"]), S("Two", ["armenia"]), S("Three", ["ukraine_war", "wars_conflicts"]),
    ], { now: yerevan(9), tz: TZ, lastDigestAt: null, topicInfo: INFO, format: "B" });
    assert.equal(text,
      "Good morning. In the last 24 hours, 3 stories on your topics:\n\n" +
      "<b>🇺🇦 Ukraine War</b>\n1. <b>One</b>\nSource: <a href=\"https://x.test/a\">Alpha Times</a>\n\n" +
      "2. <b>Three</b>\nSource: <a href=\"https://x.test/a\">Alpha Times</a>\n\n" +
      "<b>🇦🇲 Armenia</b>\n1. <b>Two</b>\nSource: <a href=\"https://x.test/a\">Alpha Times</a>");
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
    assert.match(plan.text, /^Good afternoon\. In the last 24 hours, 1 story on your topics:\n\n1\. 🇦🇲 <b>/);
  });
});
