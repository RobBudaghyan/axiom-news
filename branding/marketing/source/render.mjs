// Renders the marketing kit: HTML/SVG/CSS pages in headless Edge (or Chrome), frame by frame from the
// page's window.frame(t), piped as PNG into ffmpeg (H.264, no audio). Stills are screenshots.
//
//   FFMPEG=<ffmpeg.exe> node branding/marketing/source/render.mjs <job> [filters]
//   jobs: story (filters: 15s red en ...), bot, feed, whatsnew, checks
//   e.g.  node render.mjs story 15 en            all looks of the 15 s Story in English
//         node render.mjs story 05 red ru        one file
//   JOBS=3 runs three browsers at once (default 3).
//
// Outputs go to branding/marketing/. Check stills (0, 25, 50, 75, 100 %) go to CHECKS (default: a
// temp folder) for looking at, not to the repo. Nothing here talks to Telegram or to a Worker.
import { spawn } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browser } from "../../source/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const KIT = join(HERE, "..");
const CHECKS = process.env.CHECKS || join(tmpdir(), "axiom-marketing-checks");
mkdirSync(CHECKS, { recursive: true });

async function encode(b, file, { fps, seconds, crf, preset = "slow", outW, outH, tune, x264 = [] }) {
  const ffmpeg = process.env.FFMPEG;
  if (!ffmpeg) throw new Error("set FFMPEG to an ffmpeg executable");
  mkdirSync(dirname(file), { recursive: true });
  const n = Math.round(seconds * fps);
  const p = spawn(ffmpeg, ["-y", "-loglevel", "error", "-f", "image2pipe", "-c:v", "png", "-framerate", String(fps), "-i", "-",
    "-vf", `scale=${outW}:${outH}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-profile:v", "high", "-preset", preset,
    ...(tune ? ["-tune", tune] : []), "-crf", String(crf), ...x264, "-r", String(fps), "-movflags", "+faststart", "-an", file],
    { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((ok, no) => p.on("exit", (c) => (c === 0 ? ok() : no(new Error(`ffmpeg exit ${c} for ${file}`)))));
  const checkAt = new Set([0, Math.round((n - 1) * 0.25), Math.round((n - 1) * 0.5), Math.round((n - 1) * 0.75), n - 1]);
  const stills = {};
  for (let i = 0; i < n; i++) {
    await b.evaluate(`window.frame(${i / fps})`);
    const png = await b.png();
    if (checkAt.has(i)) stills[i] = png;
    if (!p.stdin.write(png)) await new Promise((r) => p.stdin.once("drain", r));
  }
  p.stdin.end();
  await done;
  return { stills, n };
}

function saveChecks(name, stills, n) {
  const pct = (i) => String(Math.round((i / (n - 1)) * 100)).padStart(3, "0");
  for (const [i, png] of Object.entries(stills)) writeFileSync(join(CHECKS, `${name}-p${pct(+i)}.png`), png);
}

// ---- Story videos
const LENGTHS = { "05": 5, "08": 8, "10": 10, "15": 15, "20": 20 };
function storyList(filters) {
  const list = [];
  for (const lang of ["en", "ru"]) for (const len of Object.keys(LENGTHS)) for (const look of ["red", "light", "dark"]) {
    const tags = [lang, len, `${len}s`, look];
    if (filters.every((f) => tags.includes(f))) list.push({ len, look, lang });
  }
  return list;
}
async function story(b, { len, look, lang }) {
  const name = `axiom-story-${len}s-${look}-${lang}`;
  const file = join(KIT, "story", `${len}s`, look, `${name}.mp4`);
  await b.open(join(HERE, "story.html"), 540, 960, 2);
  await b.evaluate(`window.setup(${JSON.stringify({ len, look, lang })})`);
  const { stills, n } = await encode(b, file, { fps: 60, seconds: LENGTHS[len], crf: 16, outW: 1080, outH: 1920,
    x264: ["-x264-params", "aq-mode=3"] });
  writeFileSync(file.replace(/\.mp4$/, ".png"), stills[0]);
  saveChecks(name, stills, n);
  return file;
}

// ---- the "how it works" clip for the bot (no text)
async function bot(b) {
  const file = join(KIT, "bot", "axiom-how-it-works-1280x720.mp4");
  await b.open(join(HERE, "howitworks.html"), 640, 360, 2);
  await b.evaluate("window.setup({})");
  const { stills, n } = await encode(b, file, { fps: 30, seconds: 8, crf: 25, preset: "veryslow", outW: 1280, outH: 720, tune: "animation" });
  writeFileSync(file.replace(/\.mp4$/, ".png"), stills[0]);
  saveChecks("bot-how-it-works", stills, n);
  return file;
}

// ---- stills
async function shot(b, page, query, file, w, h) {
  await b.open(join(HERE, page), w, h, 2);
  await b.evaluate(`window.setup(${JSON.stringify(query)})`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, await b.png());
  return file;
}
async function feed(b, filters) {
  const out = [];
  for (const lang of ["en", "ru"]) {
    if (filters.length && !filters.includes(lang)) continue;
    out.push(await shot(b, "feed.html", { lang, slide: "post" }, join(KIT, "feed", `axiom-post-${lang}-1080x1350.png`), 540, 675));
    for (const s of [1, 2, 3, 4]) {
      out.push(await shot(b, "feed.html", { lang, slide: s }, join(KIT, "feed", `axiom-carousel-${lang}-${s}-1080x1350.png`), 540, 675));
    }
  }
  return out;
}

async function pool(items, jobs, fn, port = 9361) {
  const queue = [...items];
  const results = [];
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async (_, w) => {
    const b = await browser(port + w);
    try {
      while (queue.length) {
        const item = queue.shift();
        const t0 = Date.now();
        const file = await fn(b, item);
        const errs = b.errors();
        if (errs.length) throw new Error(`page errors: ${errs.join("; ")}`);
        const files = [].concat(file);
        for (const f of files) console.log(`${f.slice(KIT.length + 1)}  ${(statSync(f).size / 1e6).toFixed(2)} MB  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
        results.push(...files);
      }
    } finally {
      await b.close();
    }
  }));
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [job, ...filters] = process.argv.slice(2);
  const jobs = Number(process.env.JOBS || 3);
  if (job === "story") await pool(storyList(filters), jobs, story);
  else if (job === "peek") {   // stills only: peek <page> <json setup> <t1> <t2> ...  (to CHECKS)
    const [page, q, ...ts] = filters;
    const [w, h] = page === "howitworks.html" ? [640, 360] : page === "story.html" ? [540, 960] : [540, 675];
    const b = await browser(9359 - Math.floor(Math.random() * 8));
    try {
      await b.open(join(HERE, page), w, h, 1);
      await b.evaluate(`window.setup(${q})`);
      for (const t of ts) {
        await b.evaluate(`window.frame(${t})`);
        writeFileSync(join(CHECKS, `peek-${t}.png`), await b.png());
      }
      const errs = b.errors();
      if (errs.length) throw new Error(errs.join("; "));
    } finally { await b.close(); }
  }
  else if (job === "bot") await pool([0], 1, (b) => bot(b), 9371);
  else if (job === "feed") await pool([0], 1, (b) => feed(b, filters), 9375);
  else throw new Error(`unknown job ${job}`);
  console.log(`checks: ${CHECKS}`);
}
