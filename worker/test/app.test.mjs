// The Mini App's static files: cache rules (lesson 12) and the house text rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stamped } from "../scripts/stamp-app.mjs";

const read = (p) => readFileSync(fileURLToPath(new URL(`../public/${p}`, import.meta.url)), "utf8");

test("index.html carries the current content hashes of app.css and app.js (run npm run stamp)", () => {
  assert.equal(read("app/index.html"), stamped());
  assert.match(read("app/index.html"), /app\.css\?v=[0-9a-f]{10}"/);
  assert.match(read("app/index.html"), /app\.js\?v=[0-9a-f]{10}"/);
});

test("_headers: the page is never cached; hashed files may be", () => {
  const h = read("_headers");
  for (const path of ["/app/", "/app/index.html"]) {
    const block = h.split(/\n(?=\/)/).find((b) => b.startsWith(`${path}\n`));
    assert.ok(block, `no rule for ${path}`);
    assert.match(block, /Cache-Control: no-store/);
  }
  assert.doesNotMatch(h, /\/app\/\*/);   // a wildcard would merge its Cache-Control into the page's
});

test("no em or en dash anywhere in the Mini App (owner rule)", () => {
  for (const f of ["app/index.html", "app/app.js", "app/app.css"]) assert.doesNotMatch(read(f), /[—–]/, f);
});

test("the accent is fixed, not taken from Telegram's button or link colour (lesson 13)", () => {
  const css = read("app/app.css");
  assert.doesNotMatch(css, /--tg-theme-(button|link)-color/);
  assert.match(css, /--accent: #b1161c;/);                     // the brand red (Step 5)
  assert.doesNotMatch(`${css}${read("app/app.js")}`, /2f7bf6/i);   // no trace of the old blue
});
