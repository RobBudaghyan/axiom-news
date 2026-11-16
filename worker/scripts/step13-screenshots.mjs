// Step 13 (redone in the fixes after the owner's test): screenshots of "My topics" (headless Edge
// over the local preview, demo data and the stand-in AI): at 360, 390 and 430 px, English and
// Russian, light and dark, normal and edit mode, with Japan (on), Colombia (switched off) and one
// long name; plus the states at 390 px: empty, typed, checking, added (the switch on), switched
// off, edit mode, rejected, main topic, full (3 topics), full in dark, and Admin's custom topics.
// Start the preview first (node scripts/dev-server.mjs), then:
//   node scripts/step13-screenshots.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser, sleep } from "./dev/cdp.mjs";

const OUT = fileURLToPath(new URL("../../reports/data/step-13/", import.meta.url));
const BASE = process.env.PREVIEW_URL || "http://localhost:8790";
const H = "{ authorization: 'tma ' + Telegram.WebApp.initData, 'content-type': 'application/json' }";
const API = (path, body) => `await fetch('${path}', { method: 'POST', headers: ${H}, body: JSON.stringify(${JSON.stringify(body)}) });`;
const SWITCH = (name, on) => `{ const st = await (await fetch('/api/open', { method: 'POST', headers: ${H}, body: '{}' })).json();
  ${API("/api/topics/switch", {}).replace("JSON.stringify({})", `JSON.stringify({ id: st.custom.find((c) => c.name === ${JSON.stringify(name)}).id, on: ${on} })`)} }`;
const ADD = (name, how = "enter") => `const i = document.querySelector('#topic-input'); i.value = ${JSON.stringify(name)};
  i.dispatchEvent(new Event('input', { bubbles: true })); ${how === "enter" ? "i.form.requestSubmit();" : ""}`;
const DONE = "await until(() => !document.querySelector('#my-topics .add-spin'), 8000);";
// Scroll so the Topics and My topics cards fill the screen, and hide the owner-only tabs.
const FRAME = "document.querySelector('#tabs')?.remove(); document.querySelector('#topics').scrollIntoView(); window.scrollBy(0, -12); await wait(600);";
const EDIT = "click('[data-action=edit-topics]'); await wait(400);";

mkdirSync(OUT, { recursive: true });
async function shot(b, name) {
  await sleep(150);
  const { png } = await b.screenshot(false);
  writeFileSync(join(OUT, name), png);
  const errs = b.consoleErrors();
  console.log(`${name}${errs.length ? `: ${errs.length} console error(s)` : ""}`);
}

await fetch(`${BASE}/__reset`, { method: "POST" });
for (const width of [360, 390, 430]) {
  const b = await openBrowser({ width, port: 9340 + width % 100 });
  try {
    await b.open(`${BASE}/app/?theme=light&as=owner`);
    if (width === 360) {
      await b.run(`${API("/api/topics/add", { name: "Japan" })} ${API("/api/topics/add", { name: "Colombia" })}
        ${API("/api/topics/add", { name: "International Space Station research" })} ${SWITCH("Colombia", false)}`);
    }
    for (const lang of ["en", "ru"]) {
      await b.open(`${BASE}/app/?theme=light&as=owner`);
      await b.run(API("/api/settings", { lang }));
      for (const scheme of ["light", "dark"]) {
        await b.open(`${BASE}/app/?theme=${scheme}&as=owner`, scheme);
        await b.run(FRAME);
        await shot(b, `my-topics-${width}-${lang}-${scheme}.png`);
        await b.run(EDIT);
        await shot(b, `my-topics-${width}-${lang}-${scheme}-edit.png`);
      }
    }
    await b.open(`${BASE}/app/?theme=light&as=owner`);
    await b.run(API("/api/settings", { lang: "en" }));
  } finally {
    await b.close();
  }
}

// the states, 390 px, English, light (a reader: Ani)
await fetch(`${BASE}/__reset`, { method: "POST" });
const b = await openBrowser({ width: 390, port: 9351 });
try {
  await b.open(`${BASE}/app/?theme=light&as=friend`);
  await b.run(FRAME);
  await shot(b, "state-empty.png");
  await b.run(`${ADD("Japan", "type")}`);
  await shot(b, "state-typed.png");
  await b.run("document.querySelector('#topic-input').form.requestSubmit(); await wait(250);");
  await shot(b, "state-checking.png");
  await b.run(DONE + " await wait(120);");
  await shot(b, "state-added-sliding.png");
  await b.run("await wait(700);");
  await shot(b, "state-added.png");
  await b.run(`${ADD("Colombia")} ${DONE} await wait(900); [...document.querySelectorAll('#my-topics .ct')].find((e) => /Colombia/.test(e.textContent)).click(); await wait(700);`);
  await shot(b, "state-switched-off.png");
  await b.run(EDIT);
  await shot(b, "state-edit.png");
  await b.run(EDIT);
  await b.run(`${ADD("asdfgh")} ${DONE} await wait(250);`);
  await shot(b, "state-rejected.png");
  await b.run(`${ADD("Armenian news")} ${DONE} await wait(250);`);
  await shot(b, "state-main-topic.png");
  await b.run(`await wait(3000); ${ADD("F1")} ${DONE} await wait(1200);`);
  await shot(b, "state-full.png");
  await b.open(`${BASE}/app/?theme=dark&as=friend`, "dark");
  await b.run(FRAME);
  await shot(b, "state-full-dark.png");
  await b.run(EDIT);
  await shot(b, "state-edit-dark.png");
  await b.open(`${BASE}/app/?theme=light&as=owner`);
  await b.run("click('[data-value=admin]'); await until(() => document.querySelector('.status')); await wait(800); " +
    "[...document.querySelectorAll('.section-head')].find((h) => /AI budget/.test(h.textContent)).scrollIntoView(); await wait(300);");
  await shot(b, "admin-custom-topics.png");
} finally {
  await b.close();
}
