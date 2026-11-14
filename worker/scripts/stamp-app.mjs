// Writes a short content hash into public/app/index.html for app.css and app.js (?v=<hash>), so
// Telegram's WebView never shows stale files after a deploy (lesson 12). Runs before every deploy
// (npm run deploy); test/app.test.mjs fails if the stamp is out of date.
//   node scripts/stamp-app.mjs          update the stamps
//   node scripts/stamp-app.mjs --check  exit 1 if they are out of date
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../public/app/", import.meta.url));
export const hashOf = (file) => createHash("sha256").update(readFileSync(DIR + file)).digest("hex").slice(0, 10);

export function stamped() {
  let html = readFileSync(DIR + "index.html", "utf8");
  for (const f of ["app.css", "app.js"]) {
    const at = html.indexOf(`${f}?v=`);
    if (at < 0) throw new Error(`index.html does not load ${f}?v=...`);
    const end = html.indexOf('"', at);
    html = `${html.slice(0, at)}${f}?v=${hashOf(f)}${html.slice(end)}`;
  }
  return html;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const current = readFileSync(DIR + "index.html", "utf8");
  const next = stamped();
  if (process.argv.includes("--check")) {
    if (current !== next) { console.error("index.html stamps are out of date: run node scripts/stamp-app.mjs"); process.exit(1); }
    console.log("stamps up to date");
  } else {
    writeFileSync(DIR + "index.html", next);
    console.log(current === next ? "stamps already up to date" : "stamps updated");
  }
}
