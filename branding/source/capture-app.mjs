// Real screenshots of the Mini App for the profile previews and the share cards: the app's own code
// and styles, served by the local preview (node worker/scripts/dev-server.mjs, demo data, no network).
// 390 x 844 CSS px at 3x (1170 x 2532), light theme, English and Russian.
//
//   node branding/source/capture-app.mjs          writes branding/source/shots/*.png
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openBrowser, sleep } from "../../worker/scripts/dev/cdp.mjs";

const BASE = process.env.PREVIEW_URL || "http://localhost:8790";
const OUT = fileURLToPath(new URL("./shots/", import.meta.url));
const reset = () => fetch(`${BASE}/__reset`, { method: "POST" });

// name, query, steps in the page before the shot
// Step 19: all four languages
const LANGS = ["en", "ru", "fr", "hy"];
const SHOTS = LANGS.flatMap((l) => [
  [`setup-${l}`, `theme=light&as=new&tg_lang=${l}`, ""],
  [`topics-${l}`, `theme=light&as=new&tg_lang=${l}`, "click('[data-action=setup-next]'); await wait(500);"],
  [`settings-${l}`, "theme=light&as=friend", l === "en" ? "" : `click('[data-action=lang][data-value=${l}]'); await wait(900);`],
]);

mkdirSync(OUT, { recursive: true });
const b = await openBrowser({ width: 390, height: 844, scale: 3, port: 9345 });
try {
  for (const [name, query, steps] of SHOTS) {
    await reset();
    await b.open(`${BASE}/app/?${query}`, "light");
    if (steps) await b.run(steps);
    await b.run("window.scrollTo(0, 0); await wait(400);");
    const { png } = await b.screenshot(false);
    writeFileSync(`${OUT}${name}.png`, png);
    console.log("shot", name);
  }
  const errs = b.consoleErrors();
  if (errs.length) throw new Error(`console errors: ${JSON.stringify(errs).slice(0, 400)}`);
} finally {
  await reset();
  await b.close();
}
await sleep(10);
