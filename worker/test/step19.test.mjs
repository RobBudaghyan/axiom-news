// Step 19: four reader languages (English, Russian, French, Armenian, in that order), bot texts in each,
// and the Mini App's topic names fitted on one line.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DICTS, LANGS, commandList, t } from "../src/i18n.js";

const ORDER = ["en", "ru", "fr", "hy"];

describe("Step 19: languages", () => {
  test("all four are on, in the order English, Russian, French, Armenian, with their flags", () => {
    assert.deepEqual(LANGS.enabled, ORDER);
    assert.deepEqual(LANGS.available, ORDER);
    assert.deepEqual(Object.keys(LANGS.flags), ORDER);
    assert.deepEqual(ORDER.map((l) => LANGS.flags[l]), ["🇬🇧", "🇷🇺", "🇫🇷", "🇦🇲"]);
    assert.deepEqual(Object.keys(LANGS.names), ORDER);
  });

  test("every language has its own commands, menu label, description (512 max) and about (120 max), no dash", () => {
    for (const lang of ORDER) {
      assert.ok(DICTS[lang], lang);
      assert.equal(commandList(lang).length, commandList("en").length, lang);
      for (const key of ["bot.menu_button", "bot.description", "bot.short_description"]) {
        const v = t(lang, key);
        assert.ok(v && !/[–—]/.test(v), `${lang} ${key}`);
        if (lang !== "en") assert.notEqual(v, t("en", key), `${lang} ${key} is translated`);
      }
      assert.ok(t(lang, "bot.description").length <= 512, lang);
      assert.ok(t(lang, "bot.short_description").length <= 120, lang);
    }
  });

  test("the language buttons span 3 of 6 columns: two a row, so four make a 2x2 grid", () => {
    const js = readFileSync(new URL("../public/app/app.js", import.meta.url), "utf8");
    assert.match(js, /<button class="b s3" role="radio"[^`]*data-action="lang"/);
  });

  test("main topic names shrink to fit one line (13 px at least), never wrap", () => {
    const js = readFileSync(new URL("../public/app/app.js", import.meta.url), "utf8");
    const css = readFileSync(new URL("../public/app/app.css", import.meta.url), "utf8");
    assert.match(js, /row-main row-title fit/);
    assert.match(js, /s > 13;\) \{ s -= 0\.5;/);
    assert.match(css, /\.row-title\.fit \{ white-space: nowrap;/);
  });
});

describe("Step 19: the welcome video", () => {
  test("is the how-it-works clip: same file, H.264 1280x720, small (under 400 KB)", () => {
    const a = readFileSync(new URL("../public/media/welcome.mp4", import.meta.url));
    const b = readFileSync(new URL("../../branding/marketing/bot/axiom-how-it-works-1280x720.mp4", import.meta.url));
    assert.ok(a.equals(b), "welcome.mp4 is the rebuilt clip");
    assert.ok(a.length < 400_000, `${a.length} bytes`);
    assert.ok(a.includes(Buffer.from("avc1")), "H.264");
  });
});

// ---------------------------------------------------------------- Part 5: alerts and daily stats
import { DIGEST_FAIL_MIN, FEEDS_DOWN_MIN, GOOGLE_SILENT_S, digestStatsStatement, statsDayDue, watchCandidates } from "../src/watch.js";
import { deleteUser } from "../src/account.js";
import { runTick } from "../src/cron.js";
import { addStory, addUser, fakeD1 } from "./helpers.mjs";

describe("Step 19: alerts only when action is needed", () => {
  const now = Math.floor(Date.parse("2026-11-24T12:00:00Z") / 1000);
  const meta = (o) => Object.entries(o).map(([key, v]) => ({ key, value: JSON.stringify(v) }));
  const kinds = (got) => watchCandidates(got, now).map((c) => c.kind);

  test("digests failing: 3+ failed today and at least 20% of the tries", () => {
    const dd = (sent, failed) => meta({ digest_day: { day: "2026-11-24", sent, failed } });
    assert.deepEqual(kinds([dd(40, DIGEST_FAIL_MIN), []]), [], "3 of 43 is under 20%");
    assert.deepEqual(kinds([dd(8, 2), []]), [], "2 is under the minimum");
    assert.deepEqual(kinds([dd(5, 3), []]), ["digests_failing"]);
    assert.deepEqual(kinds([meta({ digest_day: { day: "2026-11-23", sent: 0, failed: 9 } }), []]), [], "yesterday's counts do not alert");
  });

  test("many feeds down: 10+ feeds failing 3 runs in a row", () => {
    const feeds = (n, fails) => meta({ feed_health: { feeds: Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, { err: "HTTP 403", fails }])) } });
    assert.deepEqual(kinds([feeds(FEEDS_DOWN_MIN - 1, 5), []]), []);
    assert.deepEqual(kinds([feeds(FEEDS_DOWN_MIN, 2), []]), [], "two failed runs are not down yet");
    const c = watchCandidates([feeds(12, 3), []], now);
    assert.deepEqual(c.map((x) => x.kind), ["feeds_down"]);
    assert.match(c[0].text, /12 feeds have failed 3 news runs in a row \(f0, .* and 6 more\)/);
  });

  test("Google silent for a whole day with active custom topics; none when no topic is active", () => {
    assert.deepEqual(kinds([[], [{ topics: 2, last: now - GOOGLE_SILENT_S + 60 }]]), []);
    assert.deepEqual(kinds([[], [{ topics: 2, last: now - GOOGLE_SILENT_S }]]), ["google_blocked"]);
    assert.deepEqual(kinds([[], [{ topics: 0, last: now - 3 * 86400 }]]), []);
  });

  test("every alert text: one 'What to do:' line at the end, no dash", () => {
    const all = watchCandidates([meta({ digest_day: { day: "2026-11-24", sent: 1, failed: 5 },
      feed_health: { feeds: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, { err: "x", fails: 3 }])) } }),
      [{ topics: 1, last: now - 2 * 86400 }]], now);
    assert.equal(all.length, 3);
    for (const a of all) {
      const lines = a.text.split("\n");
      assert.equal(lines.length, 2, a.kind);
      assert.match(lines[1], /^What to do: \S/);
      assert.doesNotMatch(a.text, /[—–]/);
    }
  });

  test("the hourly tick sends a kind once a day; staging (health off) never", async () => {
    const { db, sqlite } = fakeD1();
    sqlite.prepare("INSERT INTO job_runs (started_at, finished_at, status) VALUES (?, ?, 'ok')").run(now - 600, now - 500);
    sqlite.prepare("INSERT INTO meta (key, value) VALUES ('digest_day', ?)").run(JSON.stringify({ day: "2026-11-24", sent: 1, failed: 6 }));
    const sent = [];
    const io = { send: async () => ({}), alert: async (t) => sent.push(t) };
    await runTick(db, io, now, { digests: false, guard: true, stats: true });
    await runTick(db, io, now + 3600, { digests: false, guard: true, stats: true });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /6 of 7 digests failed/);
    const s2 = [];
    const st = fakeD1();
    st.sqlite.prepare("INSERT INTO meta (key, value) VALUES ('digest_day', ?)").run(JSON.stringify({ day: "2026-11-24", sent: 1, failed: 6 }));
    await runTick(st.db, { send: async () => ({}), alert: async (t) => s2.push(t) }, now, { digests: false, stats: true, health: false });
    assert.equal(s2.length, 0);
  });
});

describe("Step 19: daily stats", () => {
  const now = Math.floor(Date.parse("2026-11-24T00:07:00Z") / 1000);
  const Y = Math.floor(Date.parse("2026-11-23T10:00:00Z") / 1000);

  test("the first hourly tick after midnight writes yesterday's row once, with every column", async () => {
    const { db, sqlite } = fakeD1();
    addUser(sqlite, { id: 1, created_at: Y, lang: "en" });
    addUser(sqlite, { id: 2, created_at: Y - 86400 * 3, lang: "fr" });
    addUser(sqlite, { id: 3, created_at: Y, lang: "hy", topics: "[]" });
    for (const [name, tag] of [["a", "tech_ai"], ["b", "armenia"]]) {
      const id = addStory(sqlite, name, [tag], 5, Y);
      sqlite.prepare("UPDATE stories SET main_topic = ? WHERE id = ?").run(tag, id);
    }
    sqlite.prepare("INSERT INTO feedback (user_id, at, text) VALUES (1, ?, 'hi')").run(Y);
    const check = sqlite.prepare("INSERT INTO topic_checks (user_id, at, input, outcome) VALUES (1, ?, ?, ?)");
    check.run(Y, "Stocks", "accepted"); check.run(Y, "asdf", "rejected"); check.run(Y, "Economy", "main_topic");
    const call = sqlite.prepare("INSERT INTO ai_calls (at, provider, ok, kind) VALUES (?, 'gemini', ?, 'batch')");
    call.run(Y, 1); call.run(Y, 0);
    sqlite.prepare("INSERT INTO meta (key, value) VALUES ('cf_usage', ?)").run(JSON.stringify({ day: "2026-11-24", r: 5, w: 1, y: { day: "2026-11-23", r: 900000, w: 31000 } }));
    await db.batch([digestStatsStatement({ sent: 7, failed: 2, blocked: 1 }, Y)]);
    const out = await runTick(db, { send: async () => ({}), alert: async () => {} }, now, { digests: false, stats: true, health: false });
    assert.equal(out.stats_day, "2026-11-23");
    const r = sqlite.prepare("SELECT * FROM daily_stats WHERE day = '2026-11-23'").get();
    assert.equal(r.users, 3);
    assert.equal(r.active, 2, "user 3 has every topic off");
    assert.equal(r.new_users, 2);
    assert.deepEqual(JSON.parse(r.stories), { tech_ai: 1, armenia: 1 });
    assert.deepEqual(JSON.parse(r.languages), { en: 1, fr: 1, hy: 1 });
    assert.deepEqual([r.custom_added, r.custom_rejected, r.feedback, r.ai_calls, r.ai_errors], [1, 2, 1, 2, 1]);
    assert.deepEqual([r.d1_rows_read, r.d1_rows_written], [900000, 31000]);
    assert.deepEqual([r.digests_sent, r.digests_failed, r.digests_blocked], [7, 1, 1], "the live counters are kept");
    const again = await runTick(db, { send: async () => ({}), alert: async () => {} }, now + 3600, { digests: false, stats: true, health: false });
    assert.equal(again.stats_day, undefined, "written once");
    assert.equal(statsDayDue([{ key: "stats_day", value: "2026-11-23" }], now), null);
  });

  test("a deletion counts in today's row; a user who does not exist does not", async () => {
    const { db, sqlite } = fakeD1();
    addUser(sqlite, { id: 5 });
    assert.equal(await deleteUser(db, 5, now), true);
    assert.equal(await deleteUser(db, 5, now), false);
    assert.equal(sqlite.prepare("SELECT deleted FROM daily_stats WHERE day = '2026-11-24'").get().deleted, 1);
  });

  test("never pruned: neither daily_stats nor feedback is in the job's daily prune", () => {
    const py = readFileSync(new URL("../../job/run.py", import.meta.url), "utf8");
    const prune = py.slice(py.indexOf("def prune_daily"), py.indexOf("def run(self)"));
    assert.ok(prune.includes("DELETE FROM stories"));
    assert.doesNotMatch(prune, /daily_stats|feedback/);
  });
});
