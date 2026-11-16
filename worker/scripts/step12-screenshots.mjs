// Step 12: screenshots of the final Settings tab (the owner's design 1), light and dark, English
// and Russian, and of the Admin tab, for the advisor's review. Headless Edge over the local
// preview (invented demo data). The three trial designs were shot with this script's first
// version (commit 4da55e5): reports/data/step-12/design{1,2,3}-*.png.
// Start the preview first (node scripts/dev-server.mjs), then:
//   node scripts/step12-screenshots.mjs [outDir] [--width=390] [--langs=en,ru]
// In the Settings shots the owner-only Settings/Admin tabs are hidden, so they show what a reader sees.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser, sleep } from "./dev/cdp.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || `=${d}`).split("=")[1];
const OUT = args.find((a) => !a.startsWith("--")) || fileURLToPath(new URL("../../reports/data/step-12/", import.meta.url));
const WIDTH = Number(opt("width", 390));
const LANGS = opt("langs", "en,ru").split(",");
const BASE = process.env.PREVIEW_URL || "http://localhost:8790";
const API = (body) => `await fetch('/api/settings', { method: 'POST', headers: { authorization: 'tma ' + Telegram.WebApp.initData,
  'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)}) });`;

const b = await openBrowser({ width: WIDTH });
async function shot(base) {
  await sleep(200);
  const { png, height } = await b.screenshot(true);
  const name = `${base}${WIDTH === 390 ? "" : `-${WIDTH}`}.png`;
  writeFileSync(join(OUT, name), png);
  const errs = b.consoleErrors();
  console.log(`${name}: ${WIDTH}x${height} css px${errs.length ? `, ${errs.length} console error(s)` : ""}`);
}
try {
  mkdirSync(OUT, { recursive: true });
  // A reader with 3 of 6 topics and 3 times, so both states of every control show.
  await b.open(`${BASE}/app/?theme=light&as=owner`);
  await b.run(API({ topics: ["politics", "armenia", "russia"], digest_times: ["09:00", "14:00", "20:00"], paused: false }));
  for (const lang of LANGS) {
    await b.open(`${BASE}/app/?theme=light&as=owner`);
    await b.run(API({ lang }));
    for (const scheme of ["light", "dark"]) {
      await b.open(`${BASE}/app/?theme=${scheme}&as=owner`, scheme);
      await b.run("document.querySelector('#tabs')?.remove(); await wait(450);");
      await shot(`final-settings-${scheme}-${lang}`);
      if (lang === "en") {   // Admin stays English
        await b.open(`${BASE}/app/?theme=${scheme}&as=owner`, scheme);
        await b.run("click('[data-value=admin]'); await until(() => document.querySelector('.status')); await wait(800);");
        await shot(`final-admin-${scheme}`);
      }
    }
  }
  await b.open(`${BASE}/app/?theme=light&as=owner`);
  await b.run(API({ lang: "en" }));
} finally {
  await b.close();
}
