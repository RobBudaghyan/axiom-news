// Fresh screenshots of the real Mini App (its own code and styles) for the marketing kit, from the
// local preview server with demo data (no network, nothing touches staging or production):
//   PORT=8797 node worker/scripts/dev-server.mjs      (another terminal)
//   PREVIEW_URL=http://localhost:8797 node branding/marketing/source/capture-app.mjs
// Writes branding/marketing/source/shots/<name>-<theme>.png at 390 x 844 CSS px, 3x.
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openBrowser, sleep } from "../../../worker/scripts/dev/cdp.mjs";

const BASE = process.env.PREVIEW_URL || "http://localhost:8797";
const OUT = fileURLToPath(new URL("./shots/", import.meta.url));
const reset = () => fetch(`${BASE}/__reset`, { method: "POST" });
const ONLY = process.argv[2];
const SHOTS = [];
for (const theme of ["light", "dark"]) {
  SHOTS.push([`settings-en-${theme}`, `theme=${theme}&as=friend`, ""]);
  SHOTS.push([`settings-ru-${theme}`, `theme=${theme}&as=friend`, "click('[data-action=lang][data-value=ru]'); await wait(900);"]);
  SHOTS.push([`setup-en-${theme}`, `theme=${theme}&as=new&tg_lang=en`, ""]);
  SHOTS.push([`setup-ru-${theme}`, `theme=${theme}&as=new&tg_lang=ru`, ""]);
}
mkdirSync(OUT, { recursive: true });
const b = await openBrowser({ width: 390, height: 844, scale: 3, port: 9347 });
try {
  for (const [name, query, steps] of SHOTS) {
    if (ONLY && !name.includes(ONLY)) continue;
    await reset();
    await b.open(`${BASE}/app/?${query}`, name.endsWith("dark") ? "dark" : "light");
    if (steps) await b.run(steps);
    await b.run("window.scrollTo(0, 0); await document.fonts.ready; await wait(1200);");
    const { png } = await b.screenshot(true);
    writeFileSync(`${OUT}${name}.png`, png);
    console.log("shot", name);
  }
} finally {
  await reset();
  await b.close();
}
await sleep(10);
