// The rounded logo as PNG icons with a transparent background (sharp, from the Worker's own
// dependencies): for BotFather's Mini App loading screen, if it asks for a picture, and the share
// sheets. node branding/source/icons.mjs
import { createRequire } from "node:module";
import { copyFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const require = createRequire(new URL("../../worker/package.json", import.meta.url));
const sharp = require("sharp");
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const svg = readFileSync(here("logo-icon.svg"));
for (const size of [512, 192]) {
  await sharp(svg, { density: 72 * size / 1024 * 4 }).resize(size, size).png().toFile(here(`../out/loading-icon-${size}.png`));
}
copyFileSync(here("logo-icon.svg"), here("../out/loading-icon.svg"));
console.log("icons written");
