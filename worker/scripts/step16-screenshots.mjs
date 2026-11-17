// Step 16 Part 0: screenshots for the owner's phone check (headless Edge over the local preview, demo
// data). 390 px, English and Russian, light and dark:
//   - the setup's new Language step (1 of 4), and the same step after tapping the other language;
//   - Settings top (Topics, My topics with the hint) and bottom (red Help and Send feedback squares);
//   - the "All topics are off" card;
//   - the Help page (emoji titles, short lines).
// Plus the setup steps at 360 and 430 px (English light, Russian dark).
// Start the preview first (node scripts/dev-server.mjs), then:
//   node scripts/step16-screenshots.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser, sleep } from "./dev/cdp.mjs";

const OUT = fileURLToPath(new URL("../../reports/data/step-16/screenshots/", import.meta.url));
const BASE = process.env.PREVIEW_URL || "http://localhost:8790";
mkdirSync(OUT, { recursive: true });
async function shot(b, name, full = false) {
  await sleep(250);
  const { png } = await b.screenshot(full);
  writeFileSync(join(OUT, name), png);
  const errs = b.consoleErrors();
  console.log(`${name}${errs.length ? `: ${errs.length} console error(s)` : ""}`);
}
const POST = (path, body) => `await fetch('${path}', { method: 'POST', headers: { authorization: 'tma ' + Telegram.WebApp.initData,
  'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)}) });`;

{
  const b = await openBrowser({ width: 390, port: 9371 });
  try {
    for (const lang of ["en", "ru"]) {
      for (const scheme of ["light", "dark"]) {
        const tag = `${lang}-${scheme}`;
        await fetch(`${BASE}/__reset`, { method: "POST" });
        await b.open(`${BASE}/app/?theme=${scheme}&as=new&tg_lang=${lang}`, scheme);
        await shot(b, `setup-1-language-${tag}.png`);
        const other = lang === "en" ? "ru" : "en";
        await b.run(`click('[data-action=lang][data-value=${other}]'); await wait(700);`);
        await shot(b, `setup-1-language-tapped-${other}-${tag}.png`);
        await b.run(`click('[data-action=lang][data-value=${lang}]'); await wait(700);`);
        for (const step of [2, 3, 4]) {
          await b.run("click('[data-action=setup-next]'); await wait(400);");
          await shot(b, `setup-${step}-${tag}.png`);
        }

        await fetch(`${BASE}/__reset`, { method: "POST" });
        await b.open(`${BASE}/app/?theme=${scheme}&as=friend`, scheme);
        if (lang === "ru") {
          await b.run(POST("/api/settings", { lang: "ru" }));
          await b.open(`${BASE}/app/?theme=${scheme}&as=friend`, scheme);
        }
        await shot(b, `settings-top-${tag}.png`);
        await b.run("document.querySelector('#my-topics').scrollIntoView(); window.scrollBy(0, -20); await wait(300);");
        await shot(b, `settings-my-topics-hint-${tag}.png`);
        await b.run("document.querySelector('#support').scrollIntoView(); await wait(300);");
        await shot(b, `settings-bottom-red-icons-${tag}.png`);
        await b.run("window.scrollTo(0, 0); click('[data-action=open-help]'); await wait(500);");
        await shot(b, `help-${tag}.png`, true);
        await b.run("Telegram.WebApp.__back(); await wait(300);");
        await b.run(POST("/api/settings", { topics: [] }));
        await b.open(`${BASE}/app/?theme=${scheme}&as=friend`, scheme);
        await shot(b, `all-topics-off-${tag}.png`);
      }
    }
  } finally {
    await b.close();
  }
}

for (const [width, lang, scheme] of [[360, "en", "light"], [430, "ru", "dark"]]) {
  const b = await openBrowser({ width, port: 9372 + width % 10 });
  try {
    await fetch(`${BASE}/__reset`, { method: "POST" });
    await b.open(`${BASE}/app/?theme=${scheme}&as=new&tg_lang=${lang}`, scheme);
    for (const step of [1, 2, 3, 4]) {
      await shot(b, `setup-${step}-${width}-${lang}-${scheme}.png`);
      if (step < 4) await b.run("click('[data-action=setup-next]'); await wait(400);");
    }
  } finally {
    await b.close();
  }
}
