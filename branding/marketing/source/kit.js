// Marketing kit: shared helpers for the scene pages. Easing (no bounce), the logo lockup as inline
// SVG from branding/source/logo-paths.js, the real digest loader and Twemoji images, the texts and
// the Mini App's components. Pages set window.KIT_BASE to the path of this folder ("" or "../source/").
const BASE = window.KIT_BASE || "";
const clamp = (x) => Math.max(0, Math.min(1, x));
const prog = (t, a, b) => clamp((t - a) / (b - a));
const outCubic = (x) => 1 - Math.pow(1 - x, 3);
const outQuart = (x) => 1 - Math.pow(1 - x, 4);
const inOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const inOutSine = (x) => -(Math.cos(Math.PI * x) - 1) / 2;
const mix = (a, b, k) => a + (b - a) * k;
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// The lockup (bar with AXIOM, NEWS below); colours come from the look's CSS variables.
function lockupSVG() {
  const L = window.LOGO;
  const [bx, by, bw, bh] = L.bar;
  const bottom = 220 * 1024 / 320;
  return `<svg viewBox="${bx} ${by} ${bw} ${(bottom - by).toFixed(1)}" xmlns="http://www.w3.org/2000/svg" style="display:block;width:100%;height:auto">` +
    `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="var(--logo-bar)"/>` +
    `<path d="${L.axiom.d}" transform="${L.axiom.transform}" fill="var(--logo-axiom)"/>` +
    `<path d="${L.news.d}" transform="${L.news.transform}" fill="var(--logo-news)"/></svg>`;
}

const emojiFile = (seq) => {
  const cps = [...seq].map((c) => c.codePointAt(0).toString(16));
  return (seq.includes("‍") ? cps : cps.filter((c) => c !== "fe0f")).join("-");
};
const emo = (e, cls = "emo") => `<img class="${cls}" alt="${e}" src="${BASE}emoji/${emojiFile(e)}.svg">`;
function emojify(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    if (!/\p{RGI_Emoji}/v.test(text)) continue;
    const span = document.createElement("span");
    span.innerHTML = text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))
      .replace(/\p{RGI_Emoji}/gv, (m) => emo(m));
    node.replaceWith(...span.childNodes);
  }
}
function imagesReady(root = document) {
  return Promise.all([...root.querySelectorAll("img")].map((i) => new Promise((r) => {
    if (i.complete && i.naturalWidth) return r();
    i.onload = r;
    i.onerror = () => { throw new Error("missing image " + i.src); };
  })));
}

// The real digest (data/digest-<lang>.html: a dry preview from staging, stories copied from
// production). Two edits only: the preview label line is removed and the reader's first name is
// left out of the greeting.
async function digestHTML(lang) {
  const html = await (await fetch(`${BASE}data/digest-${lang}.html`)).text();
  return html.replace(/^<p><i>[^<]*<\/i><\/p>/, "").replace(/(<p><b>[^<,]+), [^<]+<\/b>/, "$1</b>");
}
async function loadDigest(el, lang, maxStories = 99, quotes = true) {
  el.innerHTML = await digestHTML(lang);
  let n = 0;
  for (const node of [...el.children]) {
    if (node.tagName === "P" && node.querySelector("a")) n++;
    if (n > maxStories || (!quotes && node.tagName === "BLOCKQUOTE")) node.remove();
  }
  while (el.lastElementChild && ["HR", "TABLE"].includes(el.lastElementChild.tagName)) el.lastElementChild.remove();
  emojify(el);
}

// Step 19: the six main topics (Technology & AI in, Russia out), names as in config/i18n/<lang>.json:
// [emoji, tint, en, ru, fr, hy]; CUSTOM is a reader's own topic.
const TOPICS = [
  ["🏛️", "0, 122, 255", "Politics & Conflicts", "Политика и конфликты", "Politique et conflits", "Քաղաքականություն"],
  ["📈", "48, 176, 199", "Economy & Markets", "Экономика и рынки", "Économie et marchés", "Տնտեսություն և շուկաներ"],
  ["💻", "88, 86, 214", "Technology & AI", "Технологии и ИИ", "Technologie et IA", "Տեխնոլոգիաներ և ԱԲ"],
  ["🇦🇲", "255, 149, 0", "Armenia", "Армения", "Arménie", "Հայաստան"],
  ["🇮🇷", "52, 199, 89", "Iran War", "Война в Иране", "Guerre en Iran", "Իրանի պատերազմ"],
  ["🇺🇦", "255, 204, 0", "Ukraine War", "Война на Украине", "Guerre en Ukraine", "Ուկրաինայի պատերազմ"],
];
const CUSTOM = ["🏎️", "142, 142, 147", "Formula 1", "Формула-1", "Formule 1", "Ֆորմուլա 1"];
const TIMES = Array.from({ length: 18 }, (_, i) => `${String(i + 6).padStart(2, "0")}:00`);
const LANGS = [["🇬🇧", "English", "en"], ["🇷🇺", "Русский", "ru"], ["🇫🇷", "Français", "fr"], ["🇦🇲", "Հայերեն", "hy"]];
const TEXT = {
  en: { topics: "Your topics.", times: "Your times.", lang: "Your language.", free: "Free", mine: "My topics",
        next: "Next digest", today: "Today at", name: "Axiom News", link: "t.me/axiom_news_bot" },
  ru: { topics: "Ваши темы.", times: "Ваше время.", lang: "Ваш язык.", free: "Бесплатно", mine: "Мои темы",
        next: "Следующая сводка", today: "Сегодня в", name: "Axiom News", link: "t.me/axiom_news_bot" },
  fr: { topics: "Vos sujets.", times: "Vos heures.", lang: "Votre langue.", free: "Gratuit", mine: "Mes sujets",
        next: "Prochain résumé", today: "Aujourd'hui à", name: "Axiom News", link: "t.me/axiom_news_bot" },
  hy: { topics: "Ձեր թեմաները։", times: "Ձեր ժամերը։", lang: "Ձեր լեզուն։", free: "Անվճար", mine: "Իմ թեմաները",
        next: "Հաջորդ ամփոփումը", today: "Այսօր, ժամը", name: "Axiom News", link: "t.me/axiom_news_bot" },
};
const CLOCK = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.2v5l3.2 2"/></svg>`;

// The Mini App's components (same structure and proportions as worker/public/app).
const LANG_INDEX = { en: 2, ru: 3, fr: 4, hy: 5 };
function topicRow(t, lang) {
  const [e, tint] = t;
  return `<div class="row"><span class="sq" style="background: rgba(${tint}, 0.18)">${emo(e, "")}</span>` +
    `<span class="row-title">${t[LANG_INDEX[lang] ?? 2]}</span><span class="switch"><span class="knob"></span></span></div>`;
}
function setSwitch(row, k) {   // k: 0 off .. 1 on
  const sw = row.querySelector(".switch");
  sw.style.background = `color-mix(in srgb, var(--accent) ${(k * 100).toFixed(2)}%, var(--track))`;
  sw.querySelector(".knob").style.transform = `translateX(${(20 * k).toFixed(3)}px)`;
}
function btn(inner) { return `<div class="btn"><span class="fill"></span><span class="off">${inner}</span><span class="on">${inner}</span></div>`; }
function setBtn(b, k) {
  b.querySelector(".fill").style.opacity = k;
  b.querySelector(".on").style.opacity = k;
  b.querySelector(".off").style.opacity = 1 - k;
}
