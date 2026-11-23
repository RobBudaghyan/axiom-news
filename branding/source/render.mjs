// Renders the branding pages (HTML/SVG/CSS in headless Edge or Chrome over the DevTools protocol) to
// PNG stills and, frame by frame, to MP4. Each animated page defines window.frame(t) (t in seconds)
// that draws the exact state at t, so every frame is deterministic (no real-time CSS animation).
//
//   node branding/source/render.mjs <job> [...]          jobs: logo, anim, welcome, cards, shots-frame, all
//   FFMPEG=<path to ffmpeg> is needed for the videos (any ffmpeg; imageio-ffmpeg's bundled one works).
//
// Outputs go to branding/out/. Nothing here talks to Telegram or to either Worker.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const OUT = join(HERE, "..", "out");
const BROWSERS = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function browser(port = 9341) {
  const exe = BROWSERS.find(existsSync);
  if (!exe) throw new Error("no Edge or Chrome found");
  const profile = mkdtempSync(join(tmpdir(), "axiom-brand-"));
  const proc = spawn(exe, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--disable-extensions", "--hide-scrollbars", "--allow-file-access-from-files",
    "--force-color-profile=srgb", "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch { /* starting */ }
  }
  if (!target) { proc.kill(); throw new Error("browser did not start"); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } else events.push(msg);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  return {
    evaluate,
    // Opens a local file or URL at width x height CSS px, `scale` device pixels per px.
    async open(url, width, height, scale = 2, scheme = "light") {
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
      events.length = 0;
      await send("Page.navigate", { url: url.startsWith("http") || url.startsWith("file") ? url : pathToFileURL(url).href });
      for (let i = 0; i < 200 && !events.some((e) => e.method === "Page.loadEventFired"); i++) await sleep(50);
      await evaluate("document.fonts.ready.then(() => true)");
      await sleep(150);
    },
    async png() {
      return Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64");
    },
    errors: () => events.filter((e) => e.method === "Runtime.exceptionThrown").map((e) => e.params.exceptionDetails.exception?.description),
    async close() {
      try { ws.close(); } catch { /* closed */ }
      proc.kill();
      await sleep(400);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
    },
  };
}

export async function still(b, page, file, width, height, scale = 2, opts = {}) {
  await b.open(join(HERE, page) + (opts.query ? "" : ""), width, height, scale, opts.scheme);
  if (opts.query) await b.evaluate(`window.setup && window.setup(${JSON.stringify(opts.query)})`);
  if (opts.t != null) await b.evaluate(`window.frame(${opts.t})`);
  await sleep(100);
  const png = await b.png();
  mkdirSync(dirname(join(OUT, file)), { recursive: true });
  writeFileSync(join(OUT, file), png);
  return png;
}

// Renders `seconds` at `fps` from page.frame(t) and encodes an H.264 MP4 (no audio, yuv420p, faststart).
export async function video(b, page, file, { width, height, scale = 2, fps = 30, seconds, crf = 20, outW, outH, query }) {
  const ffmpeg = process.env.FFMPEG;
  if (!ffmpeg) throw new Error("set FFMPEG to an ffmpeg executable");
  await b.open(join(HERE, page), width, height, scale);
  if (query) await b.evaluate(`window.setup && window.setup(${JSON.stringify(query)})`);
  const dir = mkdtempSync(join(tmpdir(), "axiom-frames-"));
  const n = Math.round(seconds * fps);
  for (let i = 0; i < n; i++) {
    await b.evaluate(`window.frame(${i / fps})`);
    writeFileSync(join(dir, `f${String(i).padStart(4, "0")}.png`), await b.png());
  }
  const out = join(OUT, file);
  mkdirSync(dirname(out), { recursive: true });
  const W = outW ?? width * scale, H = outH ?? height * scale;
  await new Promise((ok, no) => {
    const p = spawn(ffmpeg, ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(dir, "f%04d.png"),
      "-vf", `scale=${W}:${H}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "veryslow", "-tune", "animation",
      "-crf", String(crf), "-movflags", "+faststart", "-an", out], { stdio: "inherit" });
    p.on("exit", (c) => (c === 0 ? ok() : no(new Error(`ffmpeg exit ${c}`))));
  });
  // keep the first and last frames and two middle ones for checking
  for (const i of [0, Math.floor(n * 0.33), Math.floor(n * 0.6), n - 1]) {
    writeFileSync(join(OUT, "frames", `${file.replace(/\W+/g, "-")}-${String(i).padStart(3, "0")}.png`),
      readFileSync(join(dir, `f${String(i).padStart(4, "0")}.png`)));
  }
  rmSync(dir, { recursive: true, force: true });
  return out;
}

const JOBS = {
  // the profile photo (640 and 1280) and the logo on its own; and a side by side with the original
  async logo(b) {
    await still(b, "logo.html", "profile-photo-1280.png", 640, 640, 2);
    await still(b, "logo.html", "profile-photo-640.png", 640, 640, 1);
    await still(b, "compare.html", "frames/logo-compare.png", 960, 320, 2);
    await still(b, "compare-sizes.html", "frames/logo-sizes.png", 600, 200, 2);
  },
  async anim(b) {
    await video(b, "anim.html", "description-640x360.mp4", { width: 640, height: 360, scale: 2, seconds: 3, outW: 640, outH: 360, crf: 18 });
    // BotFather sometimes asks for 320x180 for an animated description picture; and a still fallback
    await video(b, "anim.html", "description-320x180.mp4", { width: 640, height: 360, scale: 2, seconds: 3, outW: 320, outH: 180, crf: 18 });
    await still(b, "anim.html", "description-640x360.png", 640, 360, 1);
  },
  async welcome(b) {
    await video(b, "anim.html", "welcome-1280x720.mp4", { width: 640, height: 360, scale: 2, seconds: 2, crf: 20, query: { short: true } });
  },
  async cards(b) {
    for (const lang of ["en", "ru", "fr", "hy"]) {   // Step 19: four languages
      await still(b, "card.html", `share-${lang}-1080x1080.png`, 540, 540, 2, { query: { lang, shape: "square" } });
      await still(b, "card.html", `share-${lang}-1080x1920.png`, 540, 960, 2, { query: { lang, shape: "story" } });
    }
  },
  // the Mini App's loading screen (real markup and CSS), light and dark, for the report
  async loading(b) {
    for (const scheme of ["light", "dark"]) {
      await still(b, "loading.html", `frames/loading-${scheme}.png`, 390, 700, 2, { query: {}, scheme });
    }
  },
  async previews(b) {
    for (const lang of ["en", "ru", "fr", "hy"]) {   // Step 19: four languages
      for (const shot of ["setup", "settings", "digest"]) {
        await still(b, "preview.html", `preview-${lang}-${shot}.png`, 540, 960, 2, { query: { lang, shot } });
      }
    }
  },
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const want = process.argv.slice(2);
  const jobs = want.includes("all") ? Object.keys(JOBS) : want;
  mkdirSync(join(OUT, "frames"), { recursive: true });
  const b = await browser();
  try {
    for (const j of jobs) {
      if (!JOBS[j]) throw new Error(`unknown job ${j}`);
      await JOBS[j](b);
      const errs = b.errors();
      if (errs.length) throw new Error(`${j}: page errors: ${errs.join("; ")}`);
      console.log(`done: ${j}`);
    }
  } finally {
    await b.close();
  }
}
