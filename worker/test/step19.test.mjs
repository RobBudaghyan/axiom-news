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
