// Writes branding/marketing/review.html: every asset of the kit on one page (videos play, file sizes
// shown), the Story videos as a grid (rows = lengths, columns = looks) with an English/Russian switch.
//   node branding/marketing/source/make-review.mjs        (run again after re-rendering)
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KIT } from "./paths.mjs";

const size = (rel) => {
  const f = join(KIT, rel);
  if (!existsSync(f)) return null;
  const b = statSync(f).size;
  return b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`;
};
const LENGTHS = ["05", "08", "10", "15", "20"], LOOKS = ["red", "light", "dark"];
const cell = (rel, kind, label) => {
  const s = size(rel);
  if (!s) return `<figure class="missing"><div class="ph">not rendered</div><figcaption>${label}</figcaption></figure>`;
  const media = kind === "video"
    ? `<video src="${rel}" poster="${rel.replace(/\.mp4$/, ".png")}" muted loop playsinline preload="metadata"></video>`
    : `<img src="${rel}" loading="lazy" alt="">`;
  return `<figure><a href="${rel}">${media}</a><figcaption><span>${label}</span><span class="size">${s}</span></figcaption></figure>`;
};

let story = "";
for (const lang of ["en", "ru"]) {
  story += `<div class="lang-${lang}"><div class="sgrid"><div></div>${LOOKS.map((l) => `<div class="colh">${l}</div>`).join("")}`;
  for (const len of LENGTHS) {
    story += `<div class="rowh">${Number(len)} s</div>`;
    for (const look of LOOKS) {
      const rel = `story/${len}s/${look}/axiom-story-${len}s-${look}-${lang}.mp4`;
      story += cell(rel, "video", `${len}s ${look} ${lang}`);
    }
  }
  story += "</div></div>";
}
const feed = (lang) => [cell(`feed/axiom-post-${lang}-1080x1350.png`, "img", "post"),
  ...[1, 2, 3, 4].map((n) => cell(`feed/axiom-carousel-${lang}-${n}-1080x1350.png`, "img", `carousel ${n}`))].join("");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Axiom News marketing kit</title>
<style>
  @font-face { font-family: Inter; font-weight: 400; src: url(../source/fonts/inter-latin-400-normal.woff2) format("woff2"); }
  @font-face { font-family: Inter; font-weight: 600; src: url(../source/fonts/inter-latin-600-normal.woff2) format("woff2"); }
  :root { --bg: #f2f2f7; --card: #fff; --text: #000; --text-2: #6e6e73; --red: #b1161c; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg: #000; --card: #1c1c1e; --text: #fff; --text-2: #98989f; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 24px 80px; background: var(--bg); color: var(--text); font: 15px/1.45 Inter, system-ui, sans-serif; }
  main { max-width: 1180px; margin: 0 auto; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 8px; }
  h1 { margin: 0; font-size: 30px; letter-spacing: -0.03em; }
  h2 { margin: 44px 0 6px; font-size: 21px; letter-spacing: -0.02em; }
  p.note { margin: 0 0 16px; color: var(--text-2); max-width: 760px; }
  .switch { display: inline-flex; background: var(--card); border-radius: 12px; padding: 4px; gap: 4px; }
  .switch button { border: 0; font: inherit; font-weight: 600; padding: 8px 16px; border-radius: 9px; background: none; color: var(--text); cursor: pointer; }
  .switch button.on { background: var(--red); color: #fff; }
  body.en .lang-ru, body.ru .lang-en { display: none; }
  .sgrid { display: grid; grid-template-columns: 56px repeat(3, minmax(0, 1fr)); gap: 14px; align-items: start; }
  .colh { font-weight: 600; text-transform: capitalize; text-align: center; color: var(--text-2); }
  .rowh { font-weight: 600; padding-top: 40%; color: var(--text-2); }
  .row { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 14px; }
  figure { margin: 0; background: var(--card); border-radius: 16px; padding: 8px; }
  figure video, figure img { display: block; width: 100%; border-radius: 10px; background: #000; }
  figcaption { display: flex; justify-content: space-between; gap: 8px; padding: 7px 4px 1px; font-size: 13px; color: var(--text-2); }
  .size { font-variant-numeric: tabular-nums; }
  .ph { aspect-ratio: 9 / 16; display: grid; place-items: center; color: var(--text-2); }
  .wide { max-width: 640px; }
  @media (max-width: 640px) { .sgrid { grid-template-columns: 34px repeat(3, minmax(0, 1fr)); gap: 6px; } figure { padding: 4px; } figcaption { font-size: 11px; flex-direction: column; } }
</style>
</head>
<body class="en">
<main>
<header><h1>Axiom News marketing kit</h1>
<div class="switch"><button data-l="en" class="on">English</button><button data-l="ru">Русский</button></div></header>
<p class="note">Everything here is rendered from code in <code>source/</code>. Videos play while on screen; click any item to open the file itself. Details and captions: README.md.</p>

<h2>Instagram Story videos</h2>
<p class="note">1080 x 1920, 60 fps, silent. No text in the top 250 px or the bottom 340 px.</p>
${story}

<h2>Instagram feed</h2>
<p class="note">1080 x 1350. The single post, then the 4-slide carousel.</p>
<div class="lang-en"><div class="row">${feed("en")}</div></div>
<div class="lang-ru"><div class="row">${feed("ru")}</div></div>

<h2>How it works (for the bot)</h2>
<p class="note">1280 x 720, 8 s, loops, no words (one file for every language).</p>
<div class="wide">${cell("bot/axiom-how-it-works-1280x720.mp4", "video", "how it works")}</div>

<h2>What's new card</h2>
<p class="note">Edit three lines in whats-new/whats-new.html, then run node branding/marketing/whats-new/render.mjs.</p>
<div class="row" style="max-width:640px">${cell("whats-new/whats-new-1080x1350.png", "img", "feed 1080 x 1350")}${cell("whats-new/whats-new-1080x1920.png", "img", "Story 1080 x 1920")}</div>
</main>
<script>
  const set = (l) => { document.body.className = l; document.querySelectorAll(".switch button").forEach((b) => b.classList.toggle("on", b.dataset.l === l));
    try { localStorage.setItem("axiom-kit-lang", l); } catch {} };
  document.querySelectorAll(".switch button").forEach((b) => b.onclick = () => set(b.dataset.l));
  try { const l = localStorage.getItem("axiom-kit-lang"); if (l) set(l); } catch {}
  // play a video only while it is on screen, so the page stays light
  const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting ? e.target.play().catch(() => {}) : e.target.pause()), { threshold: 0.4 });
  document.querySelectorAll("video").forEach((v) => io.observe(v));
</script>
</body>
</html>
`;
writeFileSync(join(KIT, "review.html"), html);
console.log("wrote", join(KIT, "review.html"));
