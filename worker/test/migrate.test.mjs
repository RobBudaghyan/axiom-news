// Step 19: the topic migration (worker/scripts/migrate-step19.mjs). Russia is gone from every user and
// story, every existing user gets Technology & AI, a former Russia story moves to its best remaining
// main topic, and the topics table is the six rows of config/topics.yaml.
// (The Step 15 migration is archived in scripts/archive/migrate-topics.mjs.)
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ORDER, migrateStory, migrateUserTopics, readTopicsYaml, topicRows } from "../scripts/migrate-step19.mjs";
import CONFIG from "../../config/digest.json" with { type: "json" };

const OLD6 = ["politics_conflicts", "economy_markets", "armenia", "russia", "iran_war", "ukraine_war"];

describe("Step 19 topic migration", () => {
  test("every old follow except Russia is kept, Technology & AI added (all 63 subsets)", () => {
    for (let mask = 1; mask < 64; mask++) {
      const before = OLD6.filter((_, i) => mask & (1 << i));
      const after = migrateUserTopics(before);
      for (const t of before) if (t !== "russia") assert.ok(after.includes(t), `${before} -> ${after}`);
      assert.ok(after.includes("tech_ai"));
      assert.ok(!after.includes("russia"));
      assert.deepEqual(after, ORDER.filter((t) => after.includes(t)), "official order");
      assert.deepEqual(migrateUserTopics(after), after, "safe to run again");
    }
  });

  test("custom tags stay, at the end", () => {
    assert.deepEqual(migrateUserTopics(["c3", "russia", "armenia"]), ["tech_ai", "armenia", "c3"]);
    assert.deepEqual(migrateUserTopics([]), ["tech_ai"]);
  });

  test("stories: Russia dropped, main topic moved to the most specific remaining main topic", () => {
    assert.deepEqual(migrateStory(["russia", "ukraine_war", "politics_conflicts"], "russia"),
      { tags: ["ukraine_war", "politics_conflicts"], main: "ukraine_war" });
    assert.deepEqual(migrateStory(["politics_conflicts", "russia", "economy_markets"], "russia"),
      { tags: ["politics_conflicts", "economy_markets"], main: "economy_markets" });
    assert.deepEqual(migrateStory(["russia"], "russia"), { tags: ["politics_conflicts"], main: "politics_conflicts" });
    assert.deepEqual(migrateStory(["russia", "c2"], "russia"), { tags: ["politics_conflicts", "c2"], main: "politics_conflicts" });
    assert.deepEqual(migrateStory(["russia"], null), { tags: ["politics_conflicts"], main: null });
    assert.deepEqual(migrateStory(["armenia", "russia"], "armenia"), { tags: ["armenia"], main: "armenia" });
    assert.deepEqual(migrateStory(["armenia", "c2"], "c2"), { tags: ["armenia", "c2"], main: "c2" }, "untouched");
  });

  test("config: Russia gone, Technology & AI with boost cap 1, more specific than economy", () => {
    assert.deepEqual([...CONFIG.topic_specificity].sort(), [...ORDER].sort());
    assert.ok(!("russia" in CONFIG.topic_boost_max));
    assert.equal(CONFIG.topic_boost_max.tech_ai, 1);
    const s = CONFIG.topic_specificity;
    assert.ok(s.indexOf("tech_ai") < s.indexOf("economy_markets") && s.indexOf("armenia") < s.indexOf("tech_ai"));
  });

  test("the topics have a name in every language, Russia is gone, no dash", () => {
    const want = { en: "Technology & AI", ru: "Технологии и ИИ", fr: "Technologie et IA", hy: "Տեխնոլոգիաներ և ԱԲ" };
    for (const lang of ["en", "ru", "hy", "fr"]) {
      const d = JSON.parse(readFileSync(new URL(`../../config/i18n/${lang}.json`, import.meta.url), "utf8"));
      assert.deepEqual(Object.keys(d.topics), ORDER, lang);
      assert.equal(d.topics.tech_ai, want[lang]);
      for (const v of Object.values(d.topics)) assert.ok(v && !/[–—]/.test(v), `${lang}: ${v}`);
    }
    const ru = JSON.parse(readFileSync(new URL("../../config/i18n/ru.json", import.meta.url), "utf8")).topics;
    assert.equal(ru.ukraine_war, "Война на Украине");
  });

  test("the topics table rows come from config/topics.yaml, six topics, all on by default", () => {
    const yaml = readTopicsYaml(readFileSync(new URL("../../config/topics.yaml", import.meta.url), "utf8"));
    assert.deepEqual(yaml.map((t) => t.tag), ORDER);
    const rows = topicRows(yaml);
    assert.deepEqual(rows.map((r) => r[5]), [1, 1, 1, 1, 1, 1]);
    assert.deepEqual(rows[2].slice(0, 4), ["tech_ai", "Technology & AI", "Технологии и ИИ", "💻"]);
    assert.equal(rows[0][2], "Политика и конфликты");
    assert.equal(rows[4][2], "Война в Иране");
    assert.equal(rows[5][2], "Война на Украине");
  });
});
