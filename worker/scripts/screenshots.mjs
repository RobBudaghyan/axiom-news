// Renders the Mini App in headless Edge (or Chrome) at phone width (390 px), light and dark, user
// and admin view, and saves the screenshots. Start the preview first: node scripts/dev-server.mjs
//
//   node scripts/screenshots.mjs [outDir]          default outDir: ../docs/screenshots
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser, sleep } from "./dev/cdp.mjs";

const OUT = process.argv[2] || fileURLToPath(new URL("../../docs/screenshots/", import.meta.url));
const BASE = process.env.PREVIEW_URL || "http://localhost:8790";
const ADMIN = "click('[data-value=admin]'); await until(() => document.querySelector('.status')); await wait(700);";

// name, query, steps run in the page first, full page (true) or one phone screen (false)
const SHOTS = [
  ["settings-light", "theme=light&as=friend", "", true],
  ["settings-dark", "theme=dark&as=friend", "", true],
  ["add-time-light", "theme=light&as=friend", "click('[data-action=add-time]'); await wait(450); click('[data-value=\"18:30\"]'); await wait(250);", false],
  ["add-time-dark", "theme=dark&as=friend", "click('[data-action=add-time]'); await wait(450); click('[data-value=\"18:30\"]'); await wait(250);", false],
  ["timezone-light", "theme=light&as=friend", "click('[data-action=open-tz]'); await wait(450);", false],
  ["timezone-dark", "theme=dark&as=friend", "click('[data-action=open-tz]'); await wait(450);", false],
  ["admin-light", "theme=light&as=owner", ADMIN, true],
  ["admin-dark", "theme=dark&as=owner", ADMIN, true],
];

const b = await openBrowser();
try {
  mkdirSync(OUT, { recursive: true });
  for (const [name, query, steps, full] of SHOTS) {
    await b.open(`${BASE}/app/?${query}`, query.includes("dark") ? "dark" : "light");
    if (steps) await b.run(steps);
    await sleep(400);   // let transitions finish
    const { png, height } = await b.screenshot(full);
    writeFileSync(join(OUT, `${name}.png`), png);
    const errs = b.consoleErrors();
    console.log(`${name}: 390x${height} css px${errs.length ? `, ${errs.length} console error(s): ${JSON.stringify(errs[0].params).slice(0, 200)}` : ""}`);
  }
} finally {
  await b.close();
}
