// Step 15: screenshots (headless Edge over the local preview, demo data and the stand-in AI):
//   - the first-open setup (steps 1, 2, 3) at 360, 390 and 430 px, English and Russian, light and dark;
//   - Settings with the Help and Send feedback rows, the Help page and the Feedback page (390 px,
//     English and Russian, light and dark);
//   - Admin's announcement tool (390 px, light): new, translated, previewed.
// Start the preview first (node scripts/dev-server.mjs), then:
//   node scripts/step15-screenshots.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser, sleep } from "../dev/cdp.mjs";

const OUT = fileURLToPath(new URL("../../../reports/data/step-15/screenshots/", import.meta.url));
const BASE = process.env.PREVIEW_URL || "http://localhost:8790";
mkdirSync(OUT, { recursive: true });
async function shot(b, name) {
  await sleep(200);
  const { png } = await b.screenshot(false);
  writeFileSync(join(OUT, name), png);
  const errs = b.consoleErrors();
  console.log(`${name}${errs.length ? `: ${errs.length} console error(s)` : ""}`);
}

for (const width of [360, 390, 430]) {
  const b = await openBrowser({ width, port: 9350 + width % 100 });
  try {
    for (const lang of ["en", "ru"]) {
      for (const scheme of ["light", "dark"]) {
        await fetch(`${BASE}/__reset`, { method: "POST" });
        await b.open(`${BASE}/app/?theme=${scheme}&as=new&tg_lang=${lang}`, scheme);
        for (const step of [1, 2, 3]) {
          await shot(b, `setup-${step}-${width}-${lang}-${scheme}.png`);
          if (step < 3) await b.run("click('[data-action=setup-next]'); await wait(400);");
        }
      }
    }
  } finally {
    await b.close();
  }
}

{
  const b = await openBrowser({ width: 390, port: 9361 });
  try {
    for (const lang of ["en", "ru"]) {
      for (const scheme of ["light", "dark"]) {
        await fetch(`${BASE}/__reset`, { method: "POST" });
        await b.open(`${BASE}/app/?theme=${scheme}&as=friend`, scheme);
        if (lang === "ru") {
          await b.run(`await fetch('/api/settings', { method: 'POST', headers: { authorization: 'tma ' + Telegram.WebApp.initData,
            'content-type': 'application/json' }, body: JSON.stringify({ lang: 'ru' }) });`);
          await b.open(`${BASE}/app/?theme=${scheme}&as=friend`, scheme);
        }
        await b.run("document.querySelector('#support').scrollIntoView(); await wait(300);");
        await shot(b, `settings-bottom-${lang}-${scheme}.png`);
        await b.run("click('[data-action=open-help]'); await wait(500);");
        await shot(b, `help-${lang}-${scheme}.png`);
        await b.run("window.scrollTo(0, document.body.scrollHeight); await wait(300);");
        await shot(b, `help-end-${lang}-${scheme}.png`);
        await b.run("Telegram.WebApp.__back(); await wait(300); click('[data-action=open-feedback]'); await wait(500);" +
          `const i = document.querySelector('#fb-input'); i.value = ${JSON.stringify(lang === "ru" ? "Очень удобно, спасибо! Хотелось бы больше новостей об Армении." : "Really useful, thank you! I would like more Armenia news.")};` +
          "i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); await wait(200);");
        await shot(b, `feedback-${lang}-${scheme}.png`);
      }
    }
    await fetch(`${BASE}/__reset`, { method: "POST" });
    await b.open(`${BASE}/app/?theme=light&as=owner`);
    await b.run("click('[data-action=tab][data-value=admin]'); await until(() => document.querySelector('#announce'), 6000); document.querySelector('#announce').scrollIntoView(); await wait(300);");
    await shot(b, "admin-announce-new.png");
    await b.run("const i = document.querySelector('#ann-en'); i.value = 'Axiom News has two new main topics: Politics & Conflicts and Economy & Markets. Open Settings to choose yours.';" +
      "i.dispatchEvent(new Event('input', { bubbles: true })); click('[data-action=ann-translate]'); await until(() => document.querySelector('.ann-text'), 8000);" +
      "await wait(400); document.querySelector('#announce').scrollIntoView(); await wait(300);");
    await shot(b, "admin-announce-translated.png");
    await b.run("click('[data-action=ann-preview]'); await until(() => !document.querySelector('[data-action=ann-send]').disabled, 8000); document.querySelector('#announce').scrollIntoView(); await wait(300);");
    await shot(b, "admin-announce-previewed.png");
  } finally {
    await b.close();
  }
}
console.log(`[written to ${OUT}]`);
