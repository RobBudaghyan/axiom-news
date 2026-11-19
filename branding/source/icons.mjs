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

// The single-path splash icon (build_splash.py): a PNG of it, and a check on the light and dark
// splash colours (#f2f2f7, #000000) side by side.
const splash = readFileSync(here("../out/splash-icon.svg"));
await sharp(splash, { density: 72 * 512 / 1024 * 4 }).resize(512, 512).png().toFile(here("../out/splash-icon-512.png"));
const icon = await sharp(splash, { density: 72 }).resize(240, 240).png().toBuffer();
const tile = (bg) => sharp({ create: { width: 400, height: 400, channels: 4, background: bg } })
  .composite([{ input: icon, top: 80, left: 80 }]).png().toBuffer();
await sharp({ create: { width: 800, height: 400, channels: 4, background: "#000000" } })
  .composite([{ input: await tile("#f2f2f7"), top: 0, left: 0 }, { input: await tile("#000000"), top: 0, left: 400 }])
  .png().toFile(here("../out/frames/splash-check.png"));
console.log("splash icon PNG and check written");
