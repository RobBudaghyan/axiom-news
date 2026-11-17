// Step 10, part A (owner): a story with no translation into the reader's language is HELD, not
// sent in English. The rest of the digest stays in the reader's language, the held story is not
// marked sent and reaches a later digest once translated (still inside the 24 h window, even
// after its "since last digest" window passed), never twice; the length cut refills the room it
// leaves; the greeting counts what is actually sent; only a digest left with ZERO stories goes out
// wholly in English; nothing qualifying is the quiet note in the reader's language.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CONFIG, candidateStatement, planDigest, visibleLength } from "../src/digest.js";
import { runTick } from "../src/cron.js";
import { adminStatements, shapeAdmin } from "../src/admin.js";
import { ALL, OWNER, TOPIC_ROWS, TZ, addStory, addTranslation, addUser, fakeD1, yerevan } from "./helpers.mjs";

const TOPICS = TOPIC_ROWS.map(([tag, label_en, emoji, sort]) => ({ tag, label_en, emoji, sort, is_default: 1 }));
let nextId = 1000;
const story = (headline, topics, score, extra = {}) => ({
  id: nextId++, summary: headline, headline, description: `${headline}, details.`, topics: JSON.stringify(topics),
  importance: 6, final_score: score, best_url: "https://x.test/a", best_source: "Alpha Times", ...extra,
});
const ru = (s, h = `Перевод ${s.id}`, d = "Подробности.") => ({ ...s, tr_headline: h, tr_description: d });
const user = (extra = {}) => ({ id: OWNER, first_name: "Rob", topics: JSON.stringify(ALL), timezone: TZ,
  digest_times: '["09:00","14:00","20:00"]', last_digest_at: yerevan(14), lang: "ru", ...extra });
const io = (outbox) => ({ send: async (chat, text) => { outbox.push(text); return { message_id: outbox.length }; },
                          alert: async () => {} });
const sentIds = (sqlite) => sqlite.prepare("SELECT story_id FROM sent ORDER BY story_id").all().map((r) => r.story_id);
const holds = (sqlite) => sqlite.prepare("SELECT story_id, lang, at FROM digest_holds ORDER BY story_id").all().map((r) => ({ ...r }));
const CYR = /[А-Яа-яЁё]/;

describe("planDigest: untranslated stories are held", () => {
  test("one untranslated story is dropped; the rest stays Russian; the greeting counts what is sent", () => {
    const a = ru(story("Armenia and Turkey open the border", ["armenia"], 9, { main_topic: "armenia" }));
    const b = story("Ukraine and Russia swap prisoners", ["ukraine_war"], 8);   // no translation
    const c = ru(story("Iran talks resume in Oman", ["iran_war"], 7));
    const plan = planDigest(user(), [a, b, c], TOPICS, yerevan(20, 5), CONFIG);
    assert.equal(plan.lang, "ru");
    assert.equal(plan.fallback, null);
    assert.deepEqual(plan.heldIds, [b.id]);
    assert.deepEqual(plan.storyIds, [a.id, c.id]);
    assert.match(plan.text, /^<p><b>Добрый вечер, Rob<\/b> · 2 истории с 14:00<\/p>/);   // 2, not 3
    assert.doesNotMatch(plan.text, /Ukraine|prisoners|Good evening|stories/);
    assert.doesNotMatch(plan.text, /Война на Украине/);   // no empty heading for the held story's topic
    assert.equal((plan.text.match(/<b>Перевод/g) ?? []).length, 2);
  });

  test("the length cut runs after the drop: the room a held story leaves goes to translated stories", () => {
    const long = (n) => `${"Подробное описание событий дня. ".repeat(n)}`.trim();
    const top = story("Top story without a translation", ["politics_conflicts"], 10, { description: "x".repeat(560) });
    const rest = Array.from({ length: 6 }, (_, i) =>
      ru(story(`Translated story ${i}`, ["politics_conflicts"], 8 - (i % 2)), `Переведённая история ${i}`, long(17)));
    const all = [top, ...rest];
    const plan = planDigest(user(), all, TOPICS, yerevan(20, 5), CONFIG);
    assert.equal(plan.lang, "ru");
    assert.deepEqual(plan.heldIds, [top.id]);
    // with the held story in, the message would not fit: the drop must come before the cut
    const withTop = planDigest(user({ lang: "en" }), all.map((s) => ({ ...s, description: s.tr_description ?? s.description })),
      TOPICS, yerevan(20, 5), CONFIG);
    assert.ok(withTop.cut >= 1, "the test needs the English digest to be cut");
    assert.equal(plan.storyIds.length, 6);
    assert.equal(plan.cut, 0);
    assert.ok(visibleLength(plan.text) <= CONFIG.message_char_limit);
    assert.match(plan.text, /· 6 историй с 14:00</);
  });

  test("a translated story that still does not fit is cut, and only the held one is held", () => {
    const cfg = { ...CONFIG, message_char_limit: 300 };
    const a = ru(story("A", ["politics_conflicts"], 9), "Первая история", "Короткое описание первой истории.");
    const b = ru(story("B", ["politics_conflicts"], 8), "Вторая история", "Короткое описание второй истории, подлиннее чем первая.");
    const c = story("C", ["politics_conflicts"], 8);
    const plan = planDigest(user(), [a, b, c], TOPICS, yerevan(20, 5), cfg);
    assert.deepEqual(plan.heldIds, [c.id]);
    assert.ok(plan.storyIds.length >= 1 && plan.storyIds.length + plan.cut === 2);
  });

  test("ZERO stories left after the drop: the whole digest goes out in English, nothing held", () => {
    const a = story("Armenia and Turkey open the border", ["armenia"], 9);
    const b = story("Ukraine and Russia swap prisoners", ["ukraine_war"], 8);
    const plan = planDigest(user(), [a, b], TOPICS, yerevan(20, 5), CONFIG);
    assert.equal(plan.lang, "en");
    assert.deepEqual(plan.fallback, { lang: "ru", missing: 2, of: 2 });
    assert.deepEqual(plan.heldIds, []);
    assert.deepEqual(plan.storyIds.sort(), [a.id, b.id].sort());
    assert.match(plan.text, /^<p><b>Good evening, Rob<\/b> · 2 stories since 2 PM<\/p>/);
    assert.doesNotMatch(plan.text, CYR);   // never mixed
  });

  test("nothing qualifies: the quiet note in Russian; an English reader never holds anything", () => {
    const quiet = planDigest(user(), [], TOPICS, yerevan(20, 5), CONFIG);
    assert.equal(quiet.text, "<p><b>Добрый вечер, Rob</b> · Спокойный период: с 14:00 ничего важного по вашим темам.</p>");
    assert.equal(quiet.button, undefined);
    assert.equal(quiet.fallback, null);
    assert.deepEqual(quiet.heldIds, []);
    const weak = planDigest(user(), [story("Weak", ["politics_conflicts"], 4)], TOPICS, yerevan(20, 5), CONFIG);
    assert.match(weak.text, /^<p><b>Добрый вечер, Rob<\/b> · Спокойный период/);
    const en = planDigest(user({ lang: "en" }), [story("No tr", ["politics_conflicts"], 8)], TOPICS, yerevan(20, 5), CONFIG);
    assert.deepEqual(en.heldIds, []);
    assert.equal(en.storyIds.length, 1);
  });
});

describe("cron: a held story waits for its translation", () => {
  function setup() {
    const { db, sqlite } = fakeD1();
    addUser(sqlite, { lang: "ru", next_digest_at: yerevan(14), last_digest_at: yerevan(9) });
    const t0 = yerevan(13);
    const a = addStory(sqlite, "A", ["armenia"], 6, t0, { final_score: 8, headline: "Armenia story" });
    const b = addStory(sqlite, "B", ["politics_conflicts"], 6, t0, { final_score: 8, headline: "Politics story" });
    addTranslation(sqlite, a, "ru", "История об Армении");
    return { db, sqlite, a, b };
  }

  test("not marked sent, held, sent in the next digest once translated (window passed), never resent", async () => {
    const { db, sqlite, a, b } = setup();
    const outbox = [];
    const out = await runTick(db, io(outbox), yerevan(14, 2));
    assert.equal(out.held, 1);
    assert.equal(out.lang_fallback, undefined);
    assert.match(outbox[0], /^<p><b>Добрый день, Owner<\/b> · 1 история с 09:00<\/p>/);
    assert.doesNotMatch(outbox[0], /Politics story/);
    assert.deepEqual(sentIds(sqlite), [a]);                           // the held story is NOT marked sent
    assert.deepEqual(holds(sqlite), [{ story_id: b, lang: "ru", at: yerevan(14, 2) }]);
    assert.equal(sqlite.prepare("SELECT last_digest_at FROM users").get().last_digest_at, yerevan(14));
    // B was updated at 13:00, before the last digest (14:00): only the hold keeps it a candidate.
    addTranslation(sqlite, b, "ru", "История о политике");
    await runTick(db, io(outbox), yerevan(20, 2));
    assert.match(outbox[1], /^<p><b>Добрый вечер, Owner<\/b> · 1 история с 14:00<\/p>/);
    assert.match(outbox[1], /История о политике/);
    assert.deepEqual(sentIds(sqlite), [a, b]);
    // never resent after that, even though its hold row stays (for Admin)
    sqlite.prepare("UPDATE users SET next_digest_at = ?").run(yerevan(20, 30));
    await runTick(db, io(outbox), yerevan(20, 32));
    assert.match(outbox[2], /Спокойный период/);
  });

  test("still untranslated at the next digest: held again (the hold moves on), not sent in English", async () => {
    const { db, sqlite, a, b } = setup();
    const outbox = [];
    await runTick(db, io(outbox), yerevan(14, 2));
    const c = addStory(sqlite, "C", ["russia"], 6, yerevan(19), { final_score: 8, headline: "Russia story" });
    addTranslation(sqlite, c, "ru", "История о России");
    const out = await runTick(db, io(outbox), yerevan(20, 2));
    assert.equal(out.held, 1);
    assert.match(outbox[1], /^<p><b>Добрый вечер, Owner<\/b> · 1 история с 14:00<\/p>[\s\S]*История о России/);
    assert.deepEqual(sentIds(sqlite), [a, c]);
    assert.deepEqual(holds(sqlite).map((h) => [h.story_id, h.at]), [[b, yerevan(20, 2)]]);
  });

  test("a held story is offered only inside the 24 h window", async () => {
    const { db, sqlite, b } = setup();
    await runTick(db, io([]), yerevan(14, 2));
    addTranslation(sqlite, b, "ru", "История о политике");
    const u = sqlite.prepare("SELECT * FROM users").get();
    const ids = async (now) => (await db.batch([candidateStatement(u, now)]))[0].map((r) => r.id);
    assert.deepEqual(await ids(yerevan(20)), [b]);
    assert.deepEqual(await ids(yerevan(13, 1) + 86400), []);           // 24 h after its last update: gone
    sqlite.prepare("DELETE FROM digest_holds").run();
    assert.deepEqual(await ids(yerevan(20)), []);                      // without the hold it would be lost
  });

  test("zero left: the cron sends English, marks everything sent, logs one full fallback; Admin counts holds", async () => {
    const { db, sqlite } = fakeD1();
    addUser(sqlite, { lang: "ru", next_digest_at: yerevan(14), last_digest_at: yerevan(9) });
    const a = addStory(sqlite, "A", ["armenia"], 6, yerevan(13), { final_score: 8, headline: "Armenia story" });
    const b = addStory(sqlite, "B", ["politics_conflicts"], 6, yerevan(13), { final_score: 8, headline: "Politics story" });
    const outbox = [];
    const out = await runTick(db, io(outbox), yerevan(14, 2));
    assert.equal(out.lang_fallback, 1);
    assert.equal(out.held, undefined);
    assert.match(outbox[0], /^<p><b>Good afternoon, Owner<\/b> · 2 stories since 9 AM<\/p>/);
    assert.doesNotMatch(outbox[0], CYR);
    assert.deepEqual(sentIds(sqlite), [a, b]);
    const err = sqlite.prepare("SELECT message FROM errors WHERE component = 'digest'").get();
    assert.match(err.message, /^language fallback \(ru\): user 42 got English, none of 2 stories has a ru translation yet$/);

    // a second reader whose digest holds one story: Admin shows 1 held, then 1 of 1 sent later
    addUser(sqlite, { id: 7, lang: "ru", next_digest_at: yerevan(14), last_digest_at: yerevan(9) });
    addTranslation(sqlite, a, "ru", "История об Армении");
    await runTick(db, io(outbox), yerevan(14, 5));
    let ruRow = shapeAdmin(await db.batch(adminStatements(yerevan(14, 6))), yerevan(14, 6)).languages.find((l) => l.code === "ru");
    assert.deepEqual([ruRow.held_24h, ruRow.held_holds_24h, ruRow.held_released_24h, ruRow.fallbacks_24h], [1, 1, 0, 1]);
    addTranslation(sqlite, b, "ru", "История о политике");
    sqlite.prepare("UPDATE users SET next_digest_at = ? WHERE id = 7").run(yerevan(20));
    await runTick(db, io(outbox), yerevan(20, 2));
    ruRow = shapeAdmin(await db.batch(adminStatements(yerevan(20, 3))), yerevan(20, 3)).languages.find((l) => l.code === "ru");
    assert.deepEqual([ruRow.held_24h, ruRow.held_released_24h], [1, 1]);
    assert.ok(shapeAdmin(await db.batch(adminStatements(yerevan(20, 3) + 86400)), yerevan(20, 3) + 86400)
      .languages.find((l) => l.code === "ru").held_24h === 0);   // only the last 24 h
  });
});
