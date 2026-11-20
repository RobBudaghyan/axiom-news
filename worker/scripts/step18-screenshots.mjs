// Step 18: screenshots of the new Admin dashboard and the setup's topics step for the report, from
// the local preview (made-up demo data, no real users). Start the preview first (node scripts/dev-server.mjs).
//   node scripts/step18-screenshots.mjs [outDir]     default: ../reports/step-18
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser, sleep } from "./dev/cdp.mjs";

const OUT = process.argv[2] || fileURLToPath(new URL("../../reports/step-18/", import.meta.url));
const BASE = process.env.PREVIEW_URL || "http://localhost:8790";
const ADMIN = "click('[data-value=admin]'); await until(() => document.querySelector('#health')); await wait(700);";
const OPEN = (keys) => `${ADMIN} for (const k of ${JSON.stringify(keys)}) click('[data-action=adm-sec][data-value=' + k + ']'); await wait(500);`;
const SHOTS = [
  ["admin-top-light", "theme=light&as=owner", ADMIN, false],
  ["admin-top-dark", "theme=dark&as=owner", ADMIN, false],
  ["admin-closed-light", "theme=light&as=owner", ADMIN, true],
  ["admin-open-light", "theme=light&as=owner", OPEN(["feeds", "custom", "errors"]), true],
  ["admin-open-dark", "theme=dark&as=owner", OPEN(["pipeline", "users"]), true],
  ["setup-topics-light", "theme=light&as=new", "click('[data-action=setup-next]'); await wait(500);", false],
  ["help-delete-light", "theme=light&as=friend", "click('[data-action=open-help]'); await wait(400); click('#delete-me'); await wait(500);", false],
];

await fetch(`${BASE}/__reset`, { method: "POST" });
const b = await openBrowser();
try {
  mkdirSync(OUT, { recursive: true });
  for (const [name, query, steps, full] of SHOTS) {
    await b.open(`${BASE}/app/?${query}`, query.includes("dark") ? "dark" : "light");
    if (steps) await b.run(steps);
    await sleep(500);
    const { png, height } = await b.screenshot(full);
    writeFileSync(join(OUT, `${name}.png`), png);
    console.log(`${name}: 390x${height} css px`);
  }
} finally {
  await b.close();
}
