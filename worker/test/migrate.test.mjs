// Step 15: the topic migration (worker/scripts/migrate-topics.mjs). No user loses a topic, every
// existing user gets Economy & Markets, stories move to the merged tag, and the topics table is
// the six rows of config/topics.yaml.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ORDER, migrateStory, migrateUserTopics, readTopicsYaml, topicRows } from "../scripts/migrate-topics.mjs";

const OLD6 = ["politics", "wars_conflicts", "armenia", "russia", "iran_war", "ukraine_war"];
const MAP = { politics: "politics_conflicts", wars_conflicts: "politics_conflicts" };

describe("Step 15 topic migration", () => {
  test("no user loses a topic: every old follow maps to a new follow, plus Economy & Markets (all 63 subsets)", () => {
    for (let mask = 1; mask < 64; mask++) {
      const before = OLD6.filter((_, i) => mask & (1 << i));
      const after = migrateUserTopics(before);
      for (const t of before) assert.ok(after.includes(MAP[t] ?? t), `${before} -> ${after}`);
      assert.ok(after.includes("economy_markets"));
      assert.ok(!after.includes("politics") && !after.includes("wars_conflicts"));
      assert.deepEqual(after, ORDER.filter((t) => after.includes(t)), "official order");
      assert.deepEqual(migrateUserTopics(after), after, "safe to run again");
    }
  });

  test("a reader with neither old topic does not get Politics & Conflicts", () => {
    assert.deepEqual(migrateUserTopics(["armenia"]), ["economy_markets", "armenia"]);
  });

  test("stories: tags merged without duplicates, main topic mapped, others untouched", () => {
    assert.deepEqual(migrateStory(["iran_war", "wars_conflicts", "politics"], "wars_conflicts"),
      { tags: ["iran_war", "politics_conflicts"], main: "politics_conflicts" });
    assert.deepEqual(migrateStory(["armenia", "c2"], "c2"), { tags: ["armenia", "c2"], main: "c2" });
    assert.deepEqual(migrateStory(["politics"], null), { tags: ["politics_conflicts"], main: null });
  });

  test("the new topics have a name in every language, the old ones are gone, no dash", () => {
    for (const lang of ["en", "ru", "hy", "fr"]) {
      const d = JSON.parse(readFileSync(new URL(`../../config/i18n/${lang}.json`, import.meta.url), "utf8"));
      assert.deepEqual(Object.keys(d.topics), ORDER, lang);
      for (const v of Object.values(d.topics)) assert.ok(v && !/[–—]/.test(v), `${lang}: ${v}`);
    }
    const ru = JSON.parse(readFileSync(new URL("../../config/i18n/ru.json", import.meta.url), "utf8")).topics;
    assert.equal(ru.politics_conflicts, "Политика и конфликты");
    assert.equal(ru.economy_markets, "Экономика и рынки");
    assert.equal(ru.ukraine_war, "Война на Украине");
  });

  test("the topics table rows come from config/topics.yaml, six topics, all on by default", () => {
    const yaml = readTopicsYaml(readFileSync(new URL("../../config/topics.yaml", import.meta.url), "utf8"));
    assert.deepEqual(yaml.map((t) => t.tag), ORDER);
    const rows = topicRows(yaml);
    assert.deepEqual(rows.map((r) => r[5]), [1, 1, 1, 1, 1, 1]);
    assert.equal(rows[0][1], "Politics & Conflicts");
    assert.equal(rows[0][2], "Политика и конфликты");
    assert.equal(rows[1][1], "Economy & Markets");
    assert.equal(rows[1][2], "Экономика и рынки");
    assert.equal(rows[4][2], "Война в Иране");
    assert.equal(rows[5][2], "Война на Украине");
  });
});
