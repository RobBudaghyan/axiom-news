// Copies the Twemoji SVGs (CC BY 4.0) the marketing pages need into emoji/: every emoji in the two
// digests plus the fixed ones the scenes use (topic icons, flags, stars).
//   npm pack @twemoji/svg@15.0.0 (in any scratch folder), then
//   node branding/marketing/source/pick-emoji.mjs <that folder>/package
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = process.argv[2];
if (!SRC) throw new Error("usage: pick-emoji.mjs <twemoji package folder>");
const FIXED = "🏛️📈🇦🇲🇷🇺🇮🇷🇺🇦🇬🇧🏎️⭐🗞️📰🌍🕘";
const text = FIXED + ["en", "ru"].map((l) => readFileSync(join(HERE, "data", `digest-${l}.html`), "utf8")).join("");
const file = (seq) => {
  const cps = [...seq].map((c) => c.codePointAt(0).toString(16));
  return (seq.includes("‍") ? cps : cps.filter((c) => c !== "fe0f")).join("-");
};
mkdirSync(join(HERE, "emoji"), { recursive: true });
let n = 0;
for (const m of new Set([...text.matchAll(/\p{RGI_Emoji}/gv)].map((x) => x[0]))) {
  const f = `${file(m)}.svg`;
  if (!existsSync(join(SRC, f))) { console.warn("missing", m, f); continue; }
  copyFileSync(join(SRC, f), join(HERE, "emoji", f));
  n++;
}
console.log(`${n} emoji copied`);
