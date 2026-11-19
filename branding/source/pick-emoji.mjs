// Copies the Twemoji SVGs (CC BY 4.0, https://github.com/jdecked/twemoji) that the branding pages
// need into branding/source/emoji/, so only a few small files are committed. Chrome on Windows cannot
// paint a bitmap colour-emoji font, so the pages draw emoji as these images (digest.js).
//   npm pack @twemoji/svg@15.0.0 && tar xzf twemoji-svg-15.0.0.tgz   (in any scratch folder)
//   node branding/source/pick-emoji.mjs <that folder>/package
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const emojiFile = (seq) => {
  const cps = [...seq].map((c) => c.codePointAt(0).toString(16));
  // Twemoji names drop U+FE0F unless the sequence has a zero-width joiner
  return (seq.includes(String.fromCharCode(0x200d)) ? cps : cps.filter((c) => c !== "fe0f")).join("-");
};
export const EMOJI = /\p{RGI_Emoji}/gv;

const src = process.argv[2];
if (!src || !existsSync(src)) throw new Error("give the folder of @twemoji/svg");
const out = join(HERE, "emoji");
mkdirSync(out, { recursive: true });
const texts = [...readdirSync(join(HERE, "data")).map((f) => readFileSync(join(HERE, "data", f), "utf8")),
  readFileSync(join(HERE, "card.html"), "utf8"), readFileSync(join(HERE, "preview.html"), "utf8")].join("\n");
const want = new Set([...texts.matchAll(EMOJI)].map((m) => emojiFile(m[0])));
let n = 0;
for (const name of want) {
  const file = join(src, `${name}.svg`);
  if (existsSync(file)) { copyFileSync(file, join(out, `${name}.svg`)); n++; } else console.log("missing", name);
}
console.log(`copied ${n} of ${want.size} emoji to ${out}`);
