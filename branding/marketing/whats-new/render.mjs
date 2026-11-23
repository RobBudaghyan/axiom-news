// Renders the What's new card from whats-new.html (edit its three CARD lines first):
//   node branding/marketing/whats-new/render.mjs
// Writes whats-new-1080x1350.png (feed) and whats-new-1080x1920.png (Story) next to this file.
// Needs Edge or Chrome (already on Windows). An emoji in the text needs its Twemoji file in
// ../source/emoji (node ../source/pick-emoji.mjs adds the ones the kit uses).
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browser } from "../../source/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const b = await browser(9381);
try {
  for (const [shape, w, h] of [["feed", 540, 675], ["story", 540, 960]]) {
    await b.open(join(HERE, "whats-new.html"), w, h, 2);
    await b.evaluate(`window.setup({ shape: "${shape}" })`);
    const file = join(HERE, `whats-new-${w * 2}x${h * 2}.png`);
    writeFileSync(file, await b.png());
    console.log("wrote", file);
  }
  const errs = b.errors();
  if (errs.length) throw new Error(errs.join("; "));
} finally {
  await b.close();
}
