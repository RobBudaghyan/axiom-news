// Axiom News Mini App: Settings for everyone, Admin for the owner. No framework.
// Every API call sends Telegram's initData; the Worker verifies it and takes the user id from it.
// Step 9: every Settings string comes from i18n.js (generated from config/i18n/<lang>.json by
// scripts/stamp-app.mjs) in the user's language, English for a missing key. The Admin tab stays
// English (owner only).
(() => {
  "use strict";
  const tg = window.Telegram && window.Telegram.WebApp;
  const L10N = window.AXIOM_I18N || { enabled: ["en"], default: "en", names: {}, locale: {}, dicts: { en: {} } };
  let LANG = "en";
  const look = (d, key) => key.split(".").reduce((v, k) => (v == null ? undefined : v[k]), d);
  const fill = (s, vars = {}) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  function tr(key, vars) {
    let v = look(L10N.dicts[LANG], key);
    if (v === undefined) v = look(L10N.dicts.en, key);
    return typeof v === "string" ? fill(v, vars) : key;
  }
  // Same plural rules as worker/src/i18n.js: Russian one/few/many, French and Armenian 0-1 singular.
  function pluralCat(n) {
    const i = Math.abs(Math.trunc(n));
    if (LANG === "ru") {
      const a = i % 10, b = i % 100;
      if (a === 1 && b !== 11) return "one";
      return a >= 2 && a <= 4 && (b < 12 || b > 14) ? "few" : "many";
    }
    if (LANG === "fr" || LANG === "hy") return i <= 1 ? "one" : "other";
    return i === 1 ? "one" : "other";
  }
  function trn(key, count, vars = {}) {
    const forms = look(L10N.dicts[LANG], key) || look(L10N.dicts.en, key) || {};
    const s = forms[pluralCat(count)] ?? forms.other ?? forms.many ?? forms.one ?? key;
    return fill(s, { count, ...vars });
  }
  function setLang(code) {
    const primary = String(code || "").toLowerCase().split(/[-_]/)[0];
    LANG = L10N.enabled.includes(primary) ? primary : L10N.default || "en";
    document.documentElement.lang = LANG;
  }
  const locale = () => (L10N.locale && L10N.locale[LANG]) || "en-GB";
  const zoneName = (tz) => { const c = city(tz); const v = look(L10N.dicts[LANG], `zones.${c}`); return typeof v === "string" ? v : c; };
  const cap = (s) => (s ? s.charAt(0).toLocaleUpperCase(locale()) + s.slice(1) : s);
  const app = document.getElementById("app");
  const toastEl = document.getElementById("toast");
  const S = { st: null, admin: null, adminErr: null, adminLoading: false, tab: "settings", range: "24h",
    allErrors: false, busy: {}, page: null, fbDraft: "" };
  const deviceTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } })();
  const nowS = () => Math.floor(Date.now() / 1000);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);
  const ver = (v) => !!(tg && tg.isVersionAtLeast && tg.isVersionAtLeast(v));

  // ---------------------------------------------------------------- icons (inline SVG, currentColor)
  const I = {
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1.3"/><rect x="13.5" y="5" width="4" height="14" rx="1.3"/></svg>',
    paper: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M5 4h11v15a1 1 0 0 0 1 1H6a1 1 0 0 1-1-1V4Z"/><path d="M16 9h3v10a1 1 0 0 1-2 0"/><path d="M8 8h5M8 12h5M8 16h3" stroke-linecap="round"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4"/></svg>',
    warn: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm0 4a1 1 0 0 0-1 1v4a1 1 0 1 0 2 0V7a1 1 0 0 0-1-1Zm0 7.2a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z"/></svg>',
    tick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5.5 12.5 4 4 9-9"/></svg>',
    bang: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M12 5.5v8M12 18.5v.01"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>',
    help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><g transform="translate(-0.1 -0.8)"><path d="M9.2 9a3 3 0 0 1 5.8 1c0 2-3 2.6-3 4.5"/><path d="M12 18.5v.01"/></g></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"><path transform="translate(0 -0.25)" d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4.5 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"/></svg>',
    chev: '<svg viewBox="0 0 8 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m1.5 1.5 5 5.5-5 5.5"/></svg>',
    okC: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm3.7 5.3a.9.9 0 0 0-1.3.1l-3.3 4-1.6-1.6a.9.9 0 1 0-1.3 1.3l2.3 2.3c.4.4 1 .3 1.3-.1l4-4.7a.9.9 0 0 0-.1-1.3Z"/></svg>',
  };

  // ---------------------------------------------------------------- Telegram helpers
  function haptic(kind, style) {
    const h = tg && tg.HapticFeedback;
    if (!h || !ver("6.1")) return;
    try {
      if (kind === "select") h.selectionChanged();
      else if (kind === "impact") h.impactOccurred(style || "light");
      else h.notificationOccurred(kind);
    } catch { /* not supported */ }
  }

  // Step 12: our own iOS palette, light or dark as Telegram is; Telegram's header, background and
  // bottom bar get the page colour itself, so the edges never show a different grey.
  function applyTheme() {
    let scheme = tg && tg.colorScheme;
    if (!scheme) { try { scheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; } catch { scheme = "light"; } }
    document.documentElement.dataset.scheme = scheme;
    if (!tg || !ver("6.1")) return;
    const bg = toHex(getComputedStyle(document.body).getPropertyValue("--bg")) ||
      (scheme === "dark" ? "#000000" : "#f2f2f7");
    try { tg.setHeaderColor(ver("6.9") ? bg : "secondary_bg_color"); } catch { /* old client */ }
    try { tg.setBackgroundColor(bg); } catch { /* old client */ }
    try { if (ver("7.10")) tg.setBottomBarColor(bg); } catch { /* old client */ }
  }
  function toHex(v) {
    v = String(v || "").trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
    return m ? "#" + m.slice(1, 4).map((x) => (+x).toString(16).padStart(2, "0")).join("") : "";
  }

  function confirmBox(text) {
    return new Promise((resolve) => {
      if (tg && ver("6.2")) { try { tg.showConfirm(text, (ok) => resolve(!!ok)); return; } catch { /* fall through */ } }
      resolve(window.confirm(text));
    });
  }

  let toastTimer = 0;
  function toast(text, kind = "ok", ms = 1600) {
    toastEl.className = `toast ${kind}`;
    toastEl.innerHTML = `${kind === "err" ? I.warn : I.okC}<span>${esc(text)}</span>`;
    requestAnimationFrame(() => toastEl.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  }

  // ---------------------------------------------------------------- API
  async function api(path, body) {
    const opt = { method: body === undefined ? "GET" : "POST", headers: { authorization: `tma ${tg ? tg.initData : ""}` } };
    if (body !== undefined) { opt.headers["content-type"] = "application/json"; opt.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(path, opt); } catch { throw Object.assign(new Error(tr("app.no_connection")), { status: 0 }); }
    let data = {};
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      // A Settings error carries a code: shown in the user's language (Step 9). Admin messages stay English.
      const known = data.code && look(L10N.dicts.en, `errors.${data.code}`) !== undefined;
      throw Object.assign(new Error(known ? tr(`errors.${data.code}`, data.vars) : data.error || data.message || tr("app.generic_error")),
        { status: res.status, data });
    }
    return data;
  }

  // ---------------------------------------------------------------- time helpers
  const fmts = new Map();
  function fmt(tz, opts, key) {
    const k = `${tz}|${key}`;
    if (!fmts.has(k)) fmts.set(k, new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...opts }));
    return fmts.get(k);
  }
  function parts(ts, tz) {
    const o = {};
    for (const p of fmt(tz, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }, "p")
      .formatToParts(new Date(ts * 1000))) o[p.type] = p.value;
    return o;
  }
  const hm = (ts, tz) => { const p = parts(ts, tz); return `${p.hour}:${p.minute}`; };
  function dayDiff(ts, tz) {
    const a = parts(nowS(), tz), b = parts(ts, tz);
    return Math.round((Date.UTC(+b.year, b.month - 1, +b.day) - Date.UTC(+a.year, a.month - 1, +a.day)) / 864e5);
  }
  function dayName(ts, tz) {
    const d = dayDiff(ts, tz);
    if (d === 0) return tr("app.today");
    if (d === 1) return tr("app.tomorrow");
    const k = `${tz}|w|${locale()}`;
    if (!fmts.has(k)) fmts.set(k, new Intl.DateTimeFormat(locale(), { timeZone: tz, weekday: "long" }));
    return cap(fmts.get(k).format(new Date(ts * 1000)));
  }
  function when(ts, tz) {
    if (!ts) return "Never";
    const d = dayDiff(ts, tz), t = hm(ts, tz);
    if (d === 0) return t;
    if (d === -1) return `Yesterday, ${t}`;
    return `${fmt(tz, { day: "numeric", month: "short" }, "dm").format(new Date(ts * 1000))}, ${t}`;
  }
  function ago(ts) {
    const s = Math.max(0, nowS() - ts);
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} days ago`;
  }
  const city = (tz) => tz.split("/").pop().replace(/_/g, " ");
  function offset(tz) {
    try {
      const p = fmt(tz, { timeZoneName: "shortOffset" }, "o").formatToParts(new Date()).find((x) => x.type === "timeZoneName");
      return p ? p.value : "";
    } catch { return ""; }
  }
  const n = (v) => Number(v || 0).toLocaleString("en-US");
  function compact(v) {
    v = Number(v || 0);
    if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
    if (v >= 1e4) return `${Math.round(v / 1e3)}k`;
    return n(v);
  }
  const plural = (k, one, many) => `${n(k)} ${k === 1 ? one : many}`;
  function allowedTimes(L) {
    const m = (s) => +s.slice(0, 2) * 60 + +s.slice(3);
    const out = [];
    for (let x = m(L.earliest); x <= m(L.latest); x += L.step_minutes) {
      out.push(`${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`);
    }
    return out;
  }

  // ---------------------------------------------------------------- building blocks
  const section = (head, body, foot, attrs = "") =>
    `<section class="section" ${attrs}>${head ? `<h2 class="section-head">${head}</h2>` : ""}<div class="group">${body}</div>${
      foot ? `<p class="section-foot">${foot}</p>` : ""}</section>`;
  function row({ icon = "", tile = false, title, sub = "", right = "", tag = "div", cls = "", attrs = "" }) {
    const ic = icon ? `<span class="row-icon${tile ? " tile" : ""}" aria-hidden="true">${icon}</span>` : "";
    return `<${tag} class="row${icon ? " has-icon" : ""} ${cls}" ${attrs}>${ic}<div class="row-main"><div class="row-title">${title}</div>${
      sub ? `<div class="row-sub">${sub}</div>` : ""}</div>${right ? `<div class="row-right">${right}</div>` : ""}</${tag}>`;
  }
  const switchEl = '<span class="switch" aria-hidden="true"><span class="knob"></span></span>';

  // ---------------------------------------------------------------- shell
  function renderShell() {
    const owner = S.st.is_owner && !S.page;   // Step 15: a page (Help, Feedback) has no tabs
    app.removeAttribute("aria-busy");
    app.innerHTML = `<header class="top"><h1 class="title" id="title"></h1>${owner ? `
      <div class="seg" role="tablist" id="tabs">
        <span class="seg-thumb" style="width:calc(50% - 2px)"></span>
        <button role="tab" data-action="tab" data-value="settings">${esc(tr("app.tab_settings"))}</button>
        <button role="tab" data-action="tab" data-value="admin">Admin</button>
      </div>` : ""}</header><main id="view" class="view"></main>`;
    syncTabs();
  }
  function syncTabs() {
    $("#title").textContent = S.page ? pageTitle() : S.tab === "admin" ? "Admin" : tr("app.title");
    const tabs = $("#tabs");
    if (!tabs) return;
    tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.value === S.tab)));
    tabs.querySelector(".seg-thumb").style.transform = S.tab === "admin" ? "translateX(100%)" : "none";
  }
  function renderView(animate = false) {
    const v = $("#view");
    if (!v) return;
    v.innerHTML = S.page ? PAGES[S.page]() : S.tab === "admin" ? adminHTML() : settingsHTML();
    if (animate) { v.classList.remove("view"); void v.offsetWidth; v.classList.add("view"); }
  }

  // ---------------------------------------------------------------- settings
  // Step 12: no helper texts, no "Saved" toast (a light haptic tap instead). One button component
  // (.b) on a 6-column grid: a time spans 1 column, a tip 2, a language 3, so every grid lines up.
  // Rows (topics, pause) carry a small coloured square and a red switch (the owner's design 1).
  function heroHTML() {
    const u = S.st.user;
    if (u.paused) {
      return `<div class="group hero paused" id="hero"><div class="hero-icon">${I.pause}</div><div>
        <div class="hero-label">${esc(tr("app.hero_paused_label"))}</div><div class="hero-value">${esc(tr("app.hero_paused"))}</div></div></div>`;
    }
    const ts = u.next_digest_at;
    const value = ts ? tr("app.day_at", { day: dayName(ts, u.timezone), time: hm(ts, u.timezone) }) : tr("app.not_scheduled");
    return `<div class="group hero" id="hero"><div class="hero-icon">${I.clock}</div><div>
      <div class="hero-label">${esc(tr("app.hero_label"))}</div><div class="hero-value tnum">${esc(value)}</div></div></div>`;
  }
  function updateHero() {
    const h = $("#hero");
    if (h) h.outerHTML = heroHTML();
  }

  const sec = (head, body, attrs = "") =>
    `<section class="section" ${attrs}>${head ? `<h2 class="section-head">${esc(head)}</h2>` : ""}${body}</section>`;
  const card = (rows) => `<div class="group">${rows}</div>`;
  const grid = (buttons) => `<div class="grid">${buttons}</div>`;
  // A soft colour per topic for its square (iOS system hues at low strength)
  const TINT = { politics_conflicts: "0, 122, 255", economy_markets: "48, 176, 199", armenia: "255, 149, 0", russia: "88, 86, 214",
    iran_war: "52, 199, 89", ukraine_war: "255, 204, 0" };
  const tint = (tag) => `--tint: rgba(${TINT[tag] || "142, 142, 147"}, 0.18)`;

  function topicsHTML() {
    const { user: u, topics } = S.st;
    const on = (t) => u.topics.includes(t.tag);
    const attrs = (t) => `role="switch" aria-checked="${on(t)}" data-action="topic" data-value="${esc(t.tag)}"`;
    return card(topics.map((t) => `<button class="row has-icon tap" ${attrs(t)}><span class="sq" style="${tint(t.tag)}" aria-hidden="true">${esc(t.emoji)}</span>` +
      `<span class="row-main row-title">${esc(t.label)}</span>${switchEl}</button>`).join(""));
  }

  // Step 13 fixes (owner, after his test): each custom topic row looks exactly like a main topic
  // row: the topic's own emoji from the AI check in a tinted square, its name in the reader's
  // language and a red switch (off keeps it in the list and its slot). "Edit" at the right of the
  // section title switches to iOS edit mode: a red minus on each row removes it, "Done" leaves.
  // The last row adds one: a solid red "+", the field and a red "Add" once something is typed
  // (Enter does the same); a spinner while the AI checks; the new row slides in and its switch
  // turns on with a light tap. At 3 topics (on or off) the add row is gone. No helper texts.

  // The square's tint comes from the emoji itself: it is drawn once on a small canvas, its strongly
  // coloured pixels are sorted into the iOS system hues the main topics use, and the most common
  // hue wins (🇯🇵 red, 🇨🇴 yellow, 🏎️ red, 🤖 grey). No strong colour, or no canvas: grey. (No pink: the
  // main topics do not use it, and crimson flags read as red.)
  const HUES = [["255, 59, 48", 4], ["255, 149, 0", 33], ["255, 204, 0", 50], ["52, 199, 89", 135], ["48, 176, 199", 190],
    ["0, 122, 255", 213], ["88, 86, 214", 243], ["175, 82, 222", 285]];
  const GREY = "142, 142, 147";
  const tints = new Map();
  function hueOf(px) {
    const count = new Array(HUES.length).fill(0);
    let opaque = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 160) continue;
      opaque++;
      const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      if (max < 0.35 || d / max < 0.45) continue;   // white, black, grey and pale pixels do not count
      let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
      let best = 0, bd = 999;
      HUES.forEach(([, at], k) => { const dist = Math.min(Math.abs(h - at), 360 - Math.abs(h - at)); if (dist < bd) { bd = dist; best = k; } });
      count[best]++;
    }
    if (!opaque) return null;   // nothing drawn yet (the emoji font is still loading)
    const top = count.indexOf(Math.max(...count));
    return count[top] >= opaque * 0.06 ? HUES[top][0] : GREY;
  }
  let retintTimer = 0;
  const tintTries = new Map();
  function emojiTint(emoji) {
    if (tints.has(emoji)) return tints.get(emoji);
    let rgb = null;
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 40;
      const x = c.getContext("2d", { willReadFrequently: true });
      x.textAlign = "center";
      x.textBaseline = "middle";
      x.font = `30px ${getComputedStyle(document.body).fontFamily}`;
      x.fillText(emoji, 20, 22);
      rgb = hueOf(x.getImageData(0, 0, 40, 40).data);
      // Step 15: a grey result may be the font's placeholder box (the emoji font not ready yet), so
      // a grey is tried again up to 3 times (300 ms apart) before it is kept; a grey emoji stays grey.
      const tries = tintTries.get(emoji) ?? 0;
      if (rgb === null || (rgb === GREY && tries < 3)) {   // try again once the font is there; grey meanwhile
        tintTries.set(emoji, tries + 1);
        clearTimeout(retintTimer);
        retintTimer = setTimeout(retint, 300);
        try { document.fonts.ready.then(() => setTimeout(retint, 50)); } catch { /* no font API */ }
        return GREY;
      }
    } catch { rgb = GREY; }   // no canvas: grey
    tints.set(emoji, rgb);
    return rgb;
  }
  function retint() {
    document.querySelectorAll("#my-topics .sq[data-e]").forEach((q) => { q.style.setProperty("--tint", `rgba(${emojiTint(q.dataset.e)}, 0.18)`); });
  }
  const customTint = (emoji) => `--tint: rgba(${emojiTint(emoji)}, 0.18)`;

  function myTopicsHTML() {
    const list = S.st.custom || [];
    const max = (S.st.limits && S.st.limits.max_custom) || 3;
    const editing = !!S.editTopics && list.length > 0;
    const sq = (c) => `<span class="sq" style="${customTint(c.emoji)}" data-e="${esc(c.emoji)}" aria-hidden="true">${esc(c.emoji)}</span>`;
    const name = (c) => `<span class="row-main row-title ellipsis">${esc(c.name)}</span>`;
    const rows = list.map((c) => editing
      ? `<div class="row has-icon ct editing" data-id="${c.id}"><button class="minus" data-action="remove-topic" data-value="${c.id}" ` +
        `aria-label="${esc(tr("app.remove_topic", { name: c.name }))}"><span class="mc" aria-hidden="true"></span></button>${sq(c)}${name(c)}</div>`
      : `<button class="row has-icon tap ct${S.justAdded === c.id ? " new" : ""}" role="switch" ` +
        `aria-checked="${S.justAdded === c.id ? false : !!c.on}" data-action="custom-switch" data-value="${c.id}"` +
        `${S.busy.addTopic ? " disabled" : ""}>${sq(c)}${name(c)}${switchEl}</button>`).join("");
    const busy = !!S.busy.addTopic;
    const draft = S.draft || "";
    const add = list.length < max && !editing ? `<form class="row has-icon add-row${draft.trim() ? " has-text" : ""}${busy ? " busy" : ""}" id="add-topic" novalidate>` +
      `<span class="sq add" aria-hidden="true">${I.plus}</span>` +
      `<input class="add-input" id="topic-input" type="text" enterkeyhint="done" autocomplete="off" autocapitalize="sentences" spellcheck="false" ` +
      `maxlength="${(S.st.limits && S.st.limits.custom_name_max) || 40}" placeholder="${esc(tr("app.add_topic"))}" aria-label="${esc(tr("app.add_topic"))}" ` +
      `value="${esc(draft)}"${busy ? " disabled" : ""}>` +
      (busy ? `<span class="add-spin"><span class="spinner spin-sm" role="status" aria-label="${esc(tr("app.checking"))}"></span></span>`
        : `<button type="submit" class="add-go" data-action="add-topic">${esc(tr("app.add"))}</button>`) + "</form>" : "";
    // the title with "Edit" (or "Done") at its right, only while there is something to edit
    const head = `<h2 class="section-head has-action"><span>${esc(tr("app.sec_my_topics"))}</span>` +
      (list.length ? `<button class="head-link" data-action="edit-topics" aria-pressed="${editing}">${esc(tr(editing ? "app.done" : "app.edit"))}</button>` : "") +
      "</h2>";
    return `<section class="section${editing ? " editing" : ""}" id="my-topics">${head}${card(rows + add)}</section>`;
  }
  function renderMyTopics(focus = false) {
    const el = $("#my-topics");
    if (!el) return;
    if (!(S.st.custom || []).length) S.editTopics = false;
    el.outerHTML = myTopicsHTML();
    // a new row slides in with its switch off, and the switch turns on as it lands
    const fresh = S.justAdded != null && $(`#my-topics .ct[data-value="${S.justAdded}"]`);
    S.justAdded = null;
    if (fresh) setTimeout(() => fresh.setAttribute("aria-checked", "true"), 260);
    const input = $("#topic-input");
    if (focus && input) { input.focus(); const n = input.value.length; try { input.setSelectionRange(n, n); } catch { /* not a text field */ } }
  }

  async function addTopic() {
    const input = $("#topic-input");
    const name = input ? input.value.trim() : "";
    if (!name || S.busy.addTopic) return;
    if (input) input.blur();
    S.busy.addTopic = true;
    S.draft = name;
    renderMyTopics();
    try {
      const r = await api("/api/topics/add", { name });
      const res = r.result || {};
      delete r.result;
      const before = new Set((S.st.custom || []).map((c) => c.id));
      S.st = r;
      S.busy.addTopic = false;
      if (res.kind === "added" || res.kind === "joined") {   // joined (someone had made it) looks the same
        S.draft = "";
        const fresh = (S.st.custom || []).find((c) => !before.has(c.id));
        S.justAdded = fresh ? fresh.id : null;
        renderMyTopics();
        haptic("impact", "light");
      } else {   // rejected, a main topic, or "try again in a few minutes": the text stays to edit
        renderMyTopics();
        haptic("error");
        toast(res.reason || tr("app.generic_error"), "err", 3600);
      }
    } catch (e) {
      S.busy.addTopic = false;
      renderMyTopics();
      haptic("error");
      toast(e.message, "err", 3200);
    }
  }

  // Is anything else switched on (a main topic or another custom topic)? The last one cannot go.
  const otherOn = (id) => S.st.user.topics.length > 0 || (S.st.custom || []).some((c) => c.on && c.id !== id);

  function toggleCustom(el) {
    const id = Number(el.dataset.value);
    const c = (S.st.custom || []).find((x) => x.id === id);
    if (!c) return;
    const on = !!c.on;
    if (on && !otherOn(id)) {
      haptic("warning");
      shake(el);
      toast(tr("app.keep_topic"), "err");
      return;
    }
    c.on = !on;
    el.setAttribute("aria-checked", String(!on));
    chain = chain.then(async () => {
      try {
        S.st = await api("/api/topics/switch", { id, on: !on });
        updateHero();
        haptic("impact", "light");
      } catch (e) {
        c.on = on;
        renderMyTopics();
        haptic("error");
        toast(e.message, "err", 3200);
      }
    });
  }

  function removeTopic(el) {
    const id = Number(el.dataset.value);
    const list = S.st.custom || [];
    const row = el.closest(".row");
    if (!otherOn(id)) {
      haptic("warning");
      shake(row);
      toast(tr("app.keep_topic"), "err");
      return;
    }
    const before = list;
    S.st.custom = list.filter((c) => c.id !== id);
    haptic("impact", "light");
    row.classList.add("gone");   // collapses, then the card is drawn again
    setTimeout(() => renderMyTopics(), 220);
    chain = chain.then(async () => {
      try {
        S.st = await api("/api/topics/remove", { id });
      } catch (e) {
        S.st.custom = before;
        renderMyTopics();
        haptic("error");
        toast(e.message, "err", 3200);
      }
    });
  }

  // 18 hours on 6 columns: one row each for morning, afternoon and evening.
  function timesHTML() {
    const u = S.st.user;
    return grid(allowedTimes(S.st.limits).map((t) => `<button class="b t tnum" data-action="time" data-value="${t}" aria-pressed="${u.digest_times.includes(t)}">${t}</button>`).join(""));
  }

  function languagesHTML() {
    const langs = S.st.languages || [];
    if (langs.length < 2) return "";
    const flags = L10N.flags || {};
    return sec(tr("app.sec_language"), grid(langs.map((l) => `<button class="b s3" role="radio" aria-checked="${l.code === S.st.user.lang}" data-action="lang" data-value="${esc(l.code)}">` +
      `${flags[l.code] ? `<span class="emo" aria-hidden="true">${esc(flags[l.code])}</span>` : ""}<span class="lbl" lang="${esc(l.code)}">${esc(l.name)}</span></button>`).join("")),
      'id="language" role="radiogroup"');
  }

  function pauseHTML() {
    const p = S.st.user.paused;
    const label = esc(tr("app.pause"));
    return sec("", card(`<button class="row has-icon tap" role="switch" aria-checked="${p}" data-action="pause" id="pause-row"><span class="sq solid" aria-hidden="true">${I.pause}</span>` +
      `<span class="row-main row-title">${label}</span>${switchEl}</button>`));
  }

  // "Yerevan · GMT+4": the phone's zone, saved on every open (Step 12: one quiet line, no row).
  const zoneLine = (u) => { const off = offset(u.timezone); return off ? tr("app.zone_line", { zone: zoneName(u.timezone), offset: off }) : zoneName(u.timezone); };

  function settingsHTML() {
    return `<section class="section">${heroHTML()}</section>
      ${sec(tr("app.sec_topics"), topicsHTML(), 'id="topics"')}
      ${myTopicsHTML()}
      ${sec(tr("app.sec_times"), timesHTML(), 'id="times"')}
      ${languagesHTML()}
      ${pauseHTML()}
      ${supportHTML()}
      ${moreHTML()}
      <p class="tzline tnum" id="tz-line">${esc(zoneLine(S.st.user))}</p>`;
  }

  // ---------------------------------------------------------------- Step 15: Help and Send feedback
  // Two rows near the bottom of Settings, each opening its own page with Telegram's back button.
  // Settings itself keeps no helper text; the help text lives on its page.
  const PAGE_TITLES = { help: "app.help", feedback: "app.feedback" };
  const PAGES = { help: () => helpHTML(), feedback: () => feedbackHTML(), setup: () => setupHTML() };
  const SETUP_TITLES = ["app.setup_topics", "app.setup_times", "app.setup_done"];
  const pageTitle = () => tr(S.page === "setup" ? SETUP_TITLES[(S.step || 1) - 1] : PAGE_TITLES[S.page]);

  // Step 15: the first open's 3-step setup (topics, times, done), skippable. Every choice saves at
  // once like in Settings; Done or Skip tells the server, which sends one sample digest.
  function setupHTML() {
    const step = S.step || 1;
    const head = tr("app.setup_step", { n: step });
    if (step === 1) return sec(head, topicsHTML(), 'id="topics"') + setupNav("skip", "next");
    if (step === 2) return sec(head, timesHTML(), 'id="times"') + setupNav("back", "next");
    return `<section class="section"><h2 class="section-head">${esc(head)}</h2>${heroHTML()}</section>` +
      sec("", card(`<p class="help-p">${esc(tr("app.setup_sample"))}</p>`)) + setupNav(null, "finish");
  }
  const setupNav = (left, right) => `<section class="section setup-nav">${grid(
    (left ? `<button class="b s2" data-action="setup-${left}" ${S.busy.setup ? "disabled" : ""}>${esc(tr(`app.setup_${left}`))}</button>` : "") +
    `<button class="b ${left ? "s4" : "s6"} primary" data-action="setup-${right}" ${S.busy.setup ? "disabled" : ""}>` +
    `${S.busy.setup && right === "finish" ? '<span class="spinner small"></span>' : esc(tr(`app.setup_${right}`))}</button>`)}</section>`;
  function setupStep(delta) {
    S.step = Math.min(3, Math.max(1, (S.step || 1) + delta));
    haptic("select");
    syncTabs();
    renderView(true);
    window.scrollTo({ top: 0 });
  }
  async function finishSetup(skipped) {
    if (S.busy.setup) return;
    S.busy.setup = true;
    renderView();
    try {
      await chain;   // the last topic or time tap is saved first, so the sample follows it
      S.st = await api("/api/onboard", { skipped });
      S.busy = {};
      haptic("success");
      S.page = null;
      renderShell();
      renderView(true);
      window.scrollTo({ top: 0 });
    } catch (e) {
      S.busy = {};
      renderView();
      haptic("error");
      toast(e.message, "err", 3200);
    }
  }
  const navRow = (action, icon, cls, label) => `<button class="row has-icon tap nav" data-action="${action}">` +
    `<span class="sq solid ${cls}" aria-hidden="true">${icon}</span><span class="row-main row-title">${esc(label)}</span>` +
    `<span class="chev" aria-hidden="true">${I.chev}</span></button>`;
  function moreHTML() {
    return sec("", card(navRow("open-help", I.help, "blue", tr("app.help")) + navRow("open-feedback", I.chat, "green", tr("app.feedback"))),
      'id="more"');
  }
  const HELP = ["what", "stories", "topics", "times", "lang", "pause", "support", "privacy"];
  function helpHTML() {
    return HELP.map((k) => sec(tr(`app.help_${k}_h`), card(`<p class="help-p">${esc(tr(`app.help_${k}`))}</p>`), `id="help-${k}"`)).join("");
  }
  function feedbackHTML() {
    const busy = !!S.busy.fb;
    return sec("", card(`<textarea id="fb-input" class="fb-input" maxlength="1000" rows="5" placeholder="${esc(tr("app.feedback_placeholder"))}" ${busy ? "disabled" : ""}>${esc(S.fbDraft)}</textarea>`)) +
      `<section class="section fb-actions">${grid(`<button class="b s6 primary" data-action="fb-send" ${busy || !S.fbDraft.trim() ? "disabled" : ""}>` +
        `${busy ? '<span class="spinner small"></span>' : esc(tr("app.feedback_send"))}</button>`)}</section>`;
  }
  function onBack() { closePage(); }
  function openPage(name) {
    S.page = name;
    haptic("select");
    renderShell();
    renderView(true);
    window.scrollTo({ top: 0 });
    try { if (tg && ver("6.1")) { tg.BackButton.onClick(onBack); tg.BackButton.show(); } } catch { /* old client */ }
  }
  function closePage() {
    if (!S.page) return;
    S.page = null;
    try { if (tg && ver("6.1")) { tg.BackButton.offClick(onBack); tg.BackButton.hide(); } } catch { /* old client */ }
    renderShell();
    renderView(true);
  }
  async function sendFeedback() {
    const input = $("#fb-input");
    const text = (input ? input.value : S.fbDraft).trim();
    if (!text) { haptic("warning"); return; }
    S.fbDraft = input ? input.value : S.fbDraft;
    S.busy.fb = true;
    renderView();
    try {
      await api("/api/feedback", { text });
      S.busy = {};
      S.fbDraft = "";
      haptic("success");
      closePage();
      toast(tr("app.feedback_thanks"), "ok", 1400);
    } catch (e) {
      S.busy = {};
      renderView();
      haptic("error");
      toast(e.message, "err", 3200);
    }
  }

  // "Support Axiom", a voluntary tip in Telegram Stars (Step 10). Step 12: the title and the three
  // amounts only; an amount opens Telegram's own payment sheet. /terms and /paysupport stay in the bot.
  function supportHTML() {
    const amounts = (S.st.tips && S.st.tips.amounts) || [];
    if (!amounts.length) return "";
    return sec(tr("app.sec_support"), grid(amounts.map((a) =>
      `<button class="b s2 tnum" data-action="tip" data-value="${a}" ${S.busy.tip ? "disabled" : ""}>${esc(tr("app.tip_amount", { amount: a }))}</button>`).join("")),
      'id="support"');
  }

  async function payTip(amount) {
    if (!tg || !ver("6.1") || typeof tg.openInvoice !== "function") { toast(tr("app.tip_unavailable"), "err", 3200); return; }
    S.busy.tip = true;
    renderView();
    try {
      const r = await api("/api/tip", { amount, lang: LANG });
      haptic("impact", "light");
      tg.openInvoice(r.link, (status) => {
        if (status === "paid") { haptic("success"); toast(tr("app.tip_thanks"), "ok", 3200); }
        else if (status === "failed") { haptic("error"); toast(tr("app.tip_failed"), "err", 3200); }
      });
    } catch (e) {
      haptic("error");
      toast(e.message, "err", 3200);
    }
    S.busy = {};
    renderView();
  }

  // Saves go one after another, so a quick series of taps arrives in order. A saved change is a
  // light haptic tap (Step 12, owner: never a "Saved" toast); an error still shows, briefly.
  let chain = Promise.resolve();
  function save(patch, revert) {
    chain = chain.then(async () => {
      try {
        S.st = await api("/api/settings", patch);
        if ("lang" in patch) { setLang(S.st.user.lang); renderShell(); renderView(); }   // topic names come back translated
        else updateHero();
        haptic("impact", "light");
      } catch (e) {
        if (revert) revert();
        haptic("error");
        renderView();
        toast(e.message, "err", 3200);
      }
    });
    return chain;
  }

  function shake(el) {
    el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake");
  }

  function toggleTopic(el) {
    const u = S.st.user;
    const tag = el.dataset.value;
    const on = u.topics.includes(tag);
    if (on && u.topics.length === 1 && !(S.st.custom || []).some((c) => c.on)) {   // Step 13: a custom topic switched on counts too
      haptic("warning");
      shake(el);
      toast(tr("app.keep_topic"), "err");
      return;
    }
    const before = [...u.topics];
    u.topics = on ? u.topics.filter((t) => t !== tag) : S.st.topics.map((t) => t.tag).filter((t) => t === tag || u.topics.includes(t));
    el.setAttribute("aria-checked", String(!on));
    save({ topics: u.topics }, () => { S.st.user.topics = before; });
  }

  // Tap an hour to choose it (red), tap again to remove it. 1 to max_times.
  function toggleTime(el) {
    const u = S.st.user, L = S.st.limits;
    const t = el.dataset.value;
    const on = u.digest_times.includes(t);
    if (on && u.digest_times.length === 1) {
      haptic("warning");
      shake(el);
      toast(tr("app.keep_time"), "err");
      return;
    }
    if (!on && u.digest_times.length >= L.max_times) {
      haptic("warning");
      shake(el);
      toast(tr("app.max_times", { max: L.max_times }), "err", 2600);
      return;
    }
    const before = [...u.digest_times];
    u.digest_times = on ? u.digest_times.filter((x) => x !== t) : [...u.digest_times, t].sort();
    el.setAttribute("aria-pressed", String(!on));
    save({ digest_times: u.digest_times }, () => { S.st.user.digest_times = before; });
  }

  function togglePause(el) {
    const u = S.st.user;
    u.paused = !u.paused;
    el.setAttribute("aria-checked", String(u.paused));
    updateHero();
    save({ paused: u.paused }, () => { S.st.user.paused = !S.st.user.paused; });
  }

  // Step 9: a new language applies to the whole page at once; saved instantly like every setting.
  function chooseLanguage(el) {
    const u = S.st.user;
    const code = el.dataset.value;
    if (!code || code === u.lang) return;
    const before = u.lang;
    u.lang = code;
    setLang(code);
    renderShell();
    renderView();
    save({ lang: code }, () => { S.st.user.lang = before; setLang(before); renderShell(); });
  }

  // ---------------------------------------------------------------- admin
  const PROVIDER = { gemini: "Gemini", "gemini-fallback": "Gemini backup", groq: "Groq" };
  const providerLabel = (p) => (p ? p.split("+").map((x) => PROVIDER[x] || x).join(" + ") : "No AI call");
  const STATUS = { ok: ["Done", ""], partial: ["Partly done", "warn"], ai_failed: ["AI failed", "bad"], error: ["Failed", "bad"], running: ["Running", "mute"] };
  function duration(s) {
    if (s == null) return "";
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  }
  // Feed errors in plain words; the technical code stays in brackets.
  const HTTP_WORDS = { 401: "Needs a login", 403: "Blocked by the site", 404: "Feed address not found",
    410: "Feed removed", 429: "Too many requests", 503: "Site unavailable" };
  function feedError(e) {
    const m = /^HTTP (\d+)/.exec(e || "");
    if (m) return `${HTTP_WORDS[m[1]] || "Site error"} (HTTP ${m[1]})`;
    if (/timeout/i.test(e)) return "Timed out";
    if (/^fetch error/i.test(e)) return `Could not connect (${e.replace(/^fetch error: /i, "")})`;
    if (/no usable entries/i.test(e)) return "The feed is empty";
    if (/^parse error/i.test(e)) return "The feed could not be read";
    return e;
  }
  const kindLabel = (k) => (k === "editor" ? "editor" : k === "topic_check" ? "topic check"
    : /^translate_/.test(k || "") ? `translation (${k.slice(10)})` : "first pass");
  const badge = (text, kind = "") => `<span class="badge ${kind}">${esc(text)}</span>`;
  const kv = (title, value, sub = "") => row({ title, sub, right: `<span class="kv-num">${value}</span>` });

  async function loadAdmin(quiet = false) {
    S.adminErr = null;
    S.adminLoading = true;
    if (!quiet && S.tab === "admin") renderView();
    try { S.admin = await api("/api/admin"); } catch (e) { S.adminErr = e.message; }
    S.adminLoading = false;
    if (S.tab === "admin") renderView();
  }

  function adminHTML() {
    const A = S.admin;
    if (!A) {
      if (S.adminErr) {
        return section("", row({ title: "Could not load", sub: esc(S.adminErr), right: '<button class="link" data-action="refresh">Retry</button>' }));
      }
      const sk = '<div class="skeleton"><i></i></div>';
      return `${section("", sk + sk)}${section("Today", sk + sk + sk)}${section("Feeds", sk)}`;
    }
    const tz = S.st.user.timezone;
    const h = A.health;
    const lr = h.last_run;
    const lvl = { ok: ["All systems normal", ""], warn: ["Needs a look", "warn"], bad: ["Something is wrong", "bad"] }[h.level];
    const status = `<div class="status ${lvl[1]}"><span class="dot" aria-hidden="true">${h.level === "ok" ? I.tick : I.bang}</span><div class="row-main"><div class="status-title">${lvl[0]}</div>
      <div class="status-sub">${h.problems.length ? esc(h.problems.join(" ")) : "The news job, digests and alerts are working."}</div></div></div>`;
    const st = lr ? STATUS[lr.status] || [lr.status, "mute"] : null;
    const runRow = lr ? row({ title: "Last news job", sub: esc([duration(lr.duration_s), providerLabel(lr.provider)].filter(Boolean).join(" · ")),
      right: `<span class="tnum">${esc(when(lr.started_at, tz))}</span>${badge(st[0], st[1])}` }) : row({ title: "Last news job", right: "None yet" });
    const okRow = row({ title: "Last successful run", sub: h.last_ok_at ? ago(h.last_ok_at) : "", right: `<span class="tnum">${esc(when(h.last_ok_at, tz))}</span>` });
    const trigRow = row({ title: "Hourly trigger", sub: h.trigger.on_time ? "Runs at about :07 every hour" : "No run started in the last 70 minutes",
      right: h.trigger.on_time ? badge("On time") : badge("Late", "warn") });
    const alertRow = row({ title: "Alerts, last 24 h", sub: h.alert ? `<span class="clamp">${esc(h.alert.text)}</span>` : "",
      right: h.alert ? `<span class="tnum">${esc(when(h.alert.at, tz))}</span>` : "None" });

    const actions = row({ icon: I.send, tile: true, title: "Send me a digest now", sub: "A real digest from the current pool", tag: "button",
      cls: "action tap", attrs: `data-action="digest-now" ${S.busy.digest ? "disabled" : ""}`, right: S.busy.digest ? '<span class="spinner spin-sm"></span>' : "" })
      + row({ icon: I.play, tile: true, title: "Run news job now", sub: "Collect feeds and run the AI pass", tag: "button",
        cls: "action tap", attrs: `data-action="run-job" ${S.busy.run ? "disabled" : ""}`, right: S.busy.run ? '<span class="spinner spin-sm"></span>' : "" });

    const s = A.stats[S.range];
    const seg = `<div class="seg small" role="tablist"><span class="seg-thumb" style="width:calc(50% - 2px);transform:${S.range === "7d" ? "translateX(100%)" : "none"}"></span>
      <button role="tab" aria-selected="${S.range === "24h"}" data-action="range" data-value="24h">Last 24 hours</button>
      <button role="tab" aria-selected="${S.range === "7d"}" data-action="range" data-value="7d">Last 7 days</button></div>`;
    const runsSub = [s.failed ? `${s.failed} failed` : "", s.partial ? `${s.partial} partly done` : ""].filter(Boolean).join(" · ") || "none failed";
    const stats = kv("News job runs", n(s.runs), runsSub) + kv("Articles collected", n(s.items_fetched), `${n(s.items_new)} new`)
      + kv("Stories created", n(s.stories_created), `${n(s.stories_merged)} merged into existing stories`)
      + kv("Dropped as not news", n(s.items_dropped))
      + kv("Editor pass", `${n(s.editor_ok)} of ${n(s.runs)}`, `runs edited the news${s.editor_failed ? ` · ${s.editor_failed} failed` : ""} · ${plural(s.editor_merged, "duplicate", "duplicates")} merged`)
      + kv("AI calls", n(s.ai_calls), s.fallback_runs ? `${plural(s.fallback_runs, "run", "runs")} needed a backup model` : "No backup model needed")
      + kv("AI tokens", `${compact(s.input_tokens)} in · ${compact(s.output_tokens)} out`);
    const models = A.stats.models.filter((m) => m[S.range].calls).map((m) => {
      const x = m[S.range];
      const failed = x.calls - x.ok;
      return row({ title: `<span class="ellipsis">${esc(m.model || m.provider)}</span>`, sub: `${esc(PROVIDER[m.provider] || m.provider)} · ${kindLabel(m.kind)} · ${compact(x.input_tokens)} in, ${compact(x.output_tokens)} out`,
        right: `<span class="kv-num">${plural(x.calls, "call", "calls")}</span>${failed ? badge(`${failed} failed`, "bad") : ""}` });
    }).join("") || row({ title: "No AI calls in this period" });

    const F = A.feeds;
    let feeds;
    if (!F.total) feeds = section("Feeds", row({ title: "No feed data yet", sub: "It appears after the next hourly run." }));
    else {
      const okCount = F.total - F.failing.length;
      const rows = [kv("Feeds working", `${n(okCount)} of ${n(F.total)}`, F.checked_at ? `Checked ${when(F.checked_at, tz)}` : "")]
        .concat(F.failing.map((f) => row({ icon: '<span class="sdot"></span>', title: esc(f.name),
          sub: esc(`${feedError(f.error)} · since ${when(f.since, tz)}${f.fails > 1 ? ` · ${f.fails} runs in a row` : ""}`) })))
        .concat(F.silent.map((f) => row({ icon: '<span class="sdot warn"></span>', title: esc(f.name),
          sub: f.last_item_at ? `Silent: newest item ${ago(f.last_item_at)}` : "Silent: no items seen yet" })));
      feeds = section("Feeds", rows.join(""), F.failing.length || F.silent.length
        ? `Red: the feed could not be read. Amber: no new items for ${F.silent_hours} hours.` : "Every feed answered and has recent items.");
    }

    const U = A.users;
    const tiles = `<div class="stats">${[["Total", U.count], ["Active", U.active], ["Paused", U.paused], ["Blocked", U.blocked]]
      .map(([k, v]) => `<div class="stat"><b>${n(v)}</b><span>${k}</span></div>`).join("")}</div>`;
    const userRows = U.list.map((x) => row({ icon: `<span class="avatar">${esc((x.name || "?").trim().charAt(0).toUpperCase())}</span>`,
      title: `${esc(x.name)} ${x.blocked ? badge("Blocked", "bad") : x.paused ? badge("Paused", "mute") : ""}`,
      sub: esc(`${(x.lang || "en").toUpperCase()} · ${city(x.timezone)} · ${x.times.join(", ")}` +
        (x.digests_24h ? ` · avg ${x.avg_stories_24h} stories (${x.digests_24h} ${x.digests_24h === 1 ? "digest" : "digests"}, 24 h)` : "")),
      right: `<span class="tnum" style="font-size:15px">${x.last_digest_at ? esc(ago(x.last_digest_at)) : "No digest yet"}</span>` })).join("");

    // Step 9: reader languages (Admin stays English).
    const langRowsA = (A.languages || []).map((l) => row({
      title: `${esc(l.name)} ${l.enabled ? "" : badge("Hidden", "mute")}`,
      sub: esc(l.code === "en" ? `${plural(l.active, "active reader", "active readers")} · no translation needed`
        : `${plural(l.active, "active reader", "active readers")} · ${plural(l.translated_24h, "story", "stories")} translated` +
          `${l.rejected_24h ? ` (${l.rejected_24h} rejected by checks)` : ""} · ${plural(l.calls_24h, "call", "calls")}, ` +
          `${compact(l.input_tokens_24h)} in, ${compact(l.output_tokens_24h)} out` +
          ` · ${plural(l.held_24h, "story", "stories")} held for translation` +
          `${l.held_holds_24h ? ` (${l.held_released_24h} of ${l.held_holds_24h} sent later)` : ""}`),
      right: l.code === "en" ? "" : l.fallbacks_24h ? badge(`${plural(l.fallbacks_24h, "digest", "digests")} fully in English`, "warn")
        : badge("No English fallback") })).join("");

    // Step 10: tips (Telegram Stars), the last 10 with a refund button each.
    const T = A.tips || { stars: 0, tips: 0, refunded: 0, last: [] };
    const tipRows = kv("Stars received", `${n(T.stars)} ⭐`, `${plural(T.tips, "tip", "tips")}` +
        (T.refunded ? ` · ${plural(T.refunded, "refund", "refunds")} (${n(T.refunded_stars)} ⭐) not counted` : ""))
      + T.last.map((x) => row({ title: `${esc(x.name)} · ${n(x.amount)} ⭐`, sub: esc(when(x.at, tz)),
        right: x.refunded_at ? badge("Refunded", "mute")
          : `<button class="link" data-action="refund" data-value="${x.id}" data-amount="${x.amount}" data-name="${esc(x.name)}" ${S.busy.refund ? "disabled" : ""}>Refund</button>` })).join("");

    // Step 15: the announcement tool (write in English, AI translates, edit, preview to yourself, send)
    const AN = A.announce || { recent: [], languages: ["en"], enabled: ["en"] };
    const LNAME = { en: "English", ru: "Russian", hy: "Armenian", fr: "French" };
    const cur = AN.recent.find((x) => x.status === "draft" || x.status === "previewed");
    const aud = S.annAudience || "all";
    let annBody;
    if (cur) {
      const edits = S.annEdit || {};
      annBody = card(Object.keys(cur.texts).map((l) => row({ title: `${esc(LNAME[l] || l)}${cur.audience !== "all" && l === "en" && cur.audience !== "en" ? " (fallback)" : ""}`,
          sub: cur.notes[l] ? esc(`The AI version was not used: ${cur.notes[l]}. Please write it.`) : "" }) +
        `<textarea class="fb-input ann-text" data-lang="${esc(l)}" rows="4">${esc(edits[l] ?? cur.texts[l])}</textarea>`).join("")) +
        `<div class="grid ann-actions">` +
        `<button class="b s2" data-action="ann-preview" data-value="${cur.id}" ${S.busy.ann ? "disabled" : ""}>Preview</button>` +
        `<button class="b s2 primary" data-action="ann-send" data-value="${cur.id}" ${S.busy.ann || cur.status !== "previewed" || S.annDirty ? "disabled" : ""}>Send</button>` +
        `<button class="b s2" data-action="ann-cancel" data-value="${cur.id}" ${S.busy.ann ? "disabled" : ""}>Cancel</button></div>`;
    } else {
      const choices = ["all", ...AN.enabled];
      annBody = card(`<textarea class="fb-input" id="ann-en" rows="5" maxlength="2000" placeholder="Write the announcement in English">${esc(S.annDraft || "")}</textarea>`) +
        `<div class="grid ann-actions">${choices.map((c) => `<button class="b ${choices.length > 3 ? "s2" : "s3"}" data-action="ann-audience" data-value="${c}" aria-pressed="${aud === c}">${c === "all" ? "All users" : esc(LNAME[c] || c)}</button>`).join("")}` +
        `<button class="b s6 primary" data-action="ann-translate" ${S.busy.ann ? "disabled" : ""}>${S.busy.ann ? '<span class="spinner small"></span>' : "Translate"}</button></div>`;
    }
    const annRows = AN.recent.filter((x) => x !== cur).map((x) => row({ title: `<span class="clamp">${esc(x.texts.en || "")}</span>`,
      sub: esc(`#${x.id} · ${x.audience === "all" ? "all users" : LNAME[x.audience] || x.audience} · ${when(x.created_at, tz)}` +
        (x.sent || x.failed ? ` · ${x.sent} sent${x.failed ? `, ${x.failed} failed` : ""}` : "")),
      right: badge(x.status, x.status === "done" ? "ok" : x.status === "sending" ? "warn" : "mute") })).join("");
    const annFoot = cur ? (cur.status === "previewed" && !S.annDirty ? "Previewed. Send goes to every user in their language, a batch every 5 minutes, never twice."
      : "Check or edit each version, then Preview (it comes to you first). Send unlocks after a preview of exactly this text.")
      : `Languages your users read: ${AN.languages.map((l) => LNAME[l] || l).join(", ")}. Translate makes one version for each.`;

    // Step 15: the latest feedback from readers (each is also forwarded to the owner's chat)
    const FB = A.feedback || { total: 0, recent: [] };
    const fbRows = FB.recent.map((x) => row({ title: `<span class="clamp">${esc(x.text)}</span>`,
      sub: esc(`${x.name || "Someone"} (id ${x.user_id}${x.lang ? `, ${x.lang}` : ""}) · ${when(x.at, tz)}`),
      right: x.forwarded ? "" : badge("Not forwarded", "warn") })).join("");

    // Step 13: custom topics and the AI budget guard (Admin stays English)
    const C = A.custom || { topics: [], checks_24h: {}, recent_checks: [], blocks: [], guard: { level: 0, reasons: [], models: [] } };
    const ctRows = C.topics.map((x) => row({ icon: `<span class="sq" aria-hidden="true">${esc(x.emoji && x.emoji !== "📌" ? x.emoji : "🗞️")}</span>`,
      title: `<span class="ellipsis">${esc(x.name)}</span> ${x.orphan_since ? badge("No followers", "mute") : ""}`,
      sub: esc(`${plural(x.followers, "follower", "followers")}${x.active !== x.followers ? ` (${x.active} active)` : ""} · ` +
        `${plural(x.queries.length, "search", "searches")}, +${x.boost_max} cap · today ${n(x.today.searches)} requests, ` +
        `${n(x.today.new_items)} new items (${n(x.today.dup_dropped)} already in the pool) · 24 h: ` +
        `${plural(x.stories_24h, "story", "stories")} (${x.main_24h} as main topic), ${n(x.sent_24h)} sent` +
        (x.orphan_since ? ` · deleted 7 days after ${when(x.orphan_since, tz)}` : "")),
      right: `<button class="link" data-action="topic-admin" data-act="keywords" data-value="${x.id}" data-name="${esc(x.name)}" ${S.busy.topicAdmin ? "disabled" : ""}>Keywords</button>` +
        `<button class="link" data-action="topic-admin" data-act="delete" data-value="${x.id}" data-name="${esc(x.name)}" ${S.busy.topicAdmin ? "disabled" : ""}>Delete</button>` +
        `<button class="link danger" data-action="topic-admin" data-act="block" data-value="${x.id}" data-name="${esc(x.name)}" ${S.busy.topicAdmin ? "disabled" : ""}>Block</button>` })).join("");
    const outcomes = Object.entries(C.checks_24h).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(", ");
    const checkRows = kv("Topic checks, 24 h", n(Object.values(C.checks_24h).reduce((a, b) => a + b, 0)), outcomes || "none")
      + C.recent_checks.map((c) => row({ title: `<span class="ellipsis">${esc(c.input)}</span> ${badge(c.outcome.replace("_", " "),
        c.outcome === "accepted" || c.outcome === "joined" ? "" : c.outcome === "delayed" || c.outcome === "failed" ? "warn" : "mute")}`,
        sub: esc(`${c.name || "?"} · ${when(c.at, tz)}${c.reason ? ` · ${c.reason}` : ""}`) })).join("")
      + (C.blocks.length ? row({ title: "Blocked names", sub: esc(C.blocks.map((b) => b.norm).join(", ")) }) : "");
    const G = C.guard;
    const glvl = [["Normal", ""], ["Topic checks delayed", "warn"], ["Topic checks and translations delayed", "bad"]][Math.max(G.level, G.job_level || 0)] || ["?", "mute"];
    const guardRows = row({ title: "AI budget", sub: esc(G.reasons.length ? G.reasons.join("; ") : "Calls are counted per model since midnight Pacific time."),
      right: badge(glvl[0], glvl[1]) })
      + G.models.map((m) => row({ title: `<span class="ellipsis">${esc(m.model)}</span>`,
        sub: esc(`${plural(m.r429, "answer", "answers")} 429 today${m.recent429 ? `, ${m.recent429} in the last hour` : ""}`),
        right: `<span class="kv-num">${n(m.calls)}${m.soft_limit ? ` of ${n(m.soft_limit)}` : ""}</span>` })).join("")
      + (G.translate_delayed ? row({ title: "Translations", right: badge("Delayed by the last run", "bad") }) : "")
      + (G.alerted_day ? row({ title: "Last AI budget alert", right: `<span class="tnum">${esc(G.alerted_day)}</span>` }) : "");

    const D = A.d1;
    const meter = (label, used, limit) => {
      const pct = Math.min(100, (used / limit) * 100);
      return `<div class="meter"><div class="meter-top"><span>${label}</span><span>${n(used)} of ${compact(limit)}</span></div>
        <div class="bar ${pct > 80 ? "bad" : pct > 50 ? "warn" : ""}"><i style="width:${pct.toFixed(2)}%"></i></div></div>`;
    };
    const d1 = meter("Rows read", D.rows_read, D.limits.rows_read) + meter("Rows written", D.rows_written, D.limits.rows_written);

    const errs = S.allErrors ? A.errors : A.errors.slice(0, 8);
    const errRows = errs.map((e) => row({ title: `<span class="clamp" style="font-size:15px;line-height:20px">${esc(e.message)}</span>`,
      sub: esc(`${when(e.at, tz)} · ${e.component === "job" ? "News job" : e.component === "worker" ? "Bot server" : e.component}`) })).join("")
      + (!S.allErrors && A.errors.length > 8 ? row({ title: `Show all ${A.errors.length}`, tag: "button", cls: "action tap", attrs: 'data-action="all-errors"' }) : "");

    return `<div class="updated"><span>Updated ${esc(hm(A.now, tz))}</span>${S.adminLoading ? '<span class="spinner spin-sm"></span>'
      : '<button class="link" data-action="refresh" style="font-size:13px">Refresh</button>'}</div>
      ${section("", status + runRow + okRow + trigRow + alertRow)}
      ${section("Actions", actions, "Both ask before they run.")}
      <section class="section"><h2 class="section-head">News pipeline</h2>${seg}<div class="group">${stats}</div></section>
      ${section("AI by model", models)}
      ${section("AI budget, today", guardRows, "Over 80% of a soft limit, or a 429 from Gemini in the last hour: new topic checks wait. Over the limit, or every Gemini model refusing: translations wait too. The first pass and the editor never wait.")}
      ${section("Custom topics", (ctRows || row({ title: "No custom topics yet" })) + checkRows, C.topics.length ? "Delete removes it from its followers. Block also stops anyone creating it again. Both ask first." : "")}
      ${feeds}
      ${section("Users", tiles + userRows)}
      <section class="section" id="announce"><h2 class="section-head">Announcement</h2>${annBody}<p class="section-foot">${esc(annFoot)}</p></section>
      ${annRows ? section("Recent announcements", annRows) : ""}
      ${section("Recent feedback", fbRows || row({ title: "No feedback yet" }), FB.total ? `${plural(FB.total, "message", "messages")} in all; the latest 20 here. Each one is also sent to your Telegram chat.` : "")}
      ${section("Tips", tipRows, T.last.length ? "Last 10 tips. Refund returns the Stars to the person (asks first)." : "No tips yet.")}
      ${section("Languages, last 24 h", langRowsA || row({ title: "No data" }), "A story with no translation yet is held: left out of the digest and sent in a later one once translated. A digest goes out fully in English only when none of its stories is translated; the badge counts those.")}
      ${section("Database today", d1, "Free limits per day, reset at 00:00 UTC. The news job's counts are exact; the bot server's are counted every 5 minutes and can be slightly low.")}
      ${section("Recent errors", errRows || row({ title: "No errors" }), A.errors.length ? "Newest first. Notes from the news job about skipped items are normal." : "")}`;
  }

  async function adminAction(kind) {
    const msg = kind === "digest"
      ? "Send yourself a digest now? It is a real digest from the current news pool: these stories will not be sent to you again."
      : "Start the news job now? It collects every feed and runs the AI pass. It takes about 1 to 2 minutes.";
    haptic("impact", "medium");
    if (!(await confirmBox(msg))) return;
    S.busy[kind === "digest" ? "digest" : "run"] = true;
    renderView();
    try {
      const r = await api(kind === "digest" ? "/api/admin/digest" : "/api/admin/run-job", {});
      haptic("success");
      toast(r.message, "ok", 3600);
    } catch (e) {
      haptic(e.status === 409 ? "warning" : "error");
      toast(e.message, "err", 4200);
    }
    S.busy = {};
    loadAdmin(true);
  }

  // Step 15: the announcement tool
  async function announceAction(act, el) {
    const id = el ? Number(el.dataset.value) : null;
    const texts = {};
    document.querySelectorAll(".ann-text").forEach((t) => { texts[t.dataset.lang] = t.value; });
    let body;
    if (act === "draft") {
      const text = ($("#ann-en") || {}).value || "";
      if (!text.trim()) { haptic("warning"); return; }
      body = { action: "draft", text, audience: S.annAudience || "all" };
    } else if (act === "send") {
      haptic("impact", "medium");
      if (!(await confirmBox("Send this announcement now? Every user in the audience gets it once, in their language. This cannot be undone."))) return;
      body = { action: "send", id, texts };
    } else if (act === "cancel") {
      if (!(await confirmBox("Cancel this announcement? Nothing more is sent."))) return;
      body = { action: "cancel", id };
    } else body = { action: "preview", id, texts };
    S.busy.ann = true;
    renderView();
    try {
      const r = await api("/api/admin/announce", body);
      haptic("success");
      toast(r.message, "ok", 3600);
      if (act === "draft") S.annDraft = "";
      if (act !== "draft") { S.annEdit = {}; S.annDirty = false; }
    } catch (e) {
      haptic("error");
      toast(e.message, "err", 4200);
    }
    S.busy = {};
    loadAdmin(true);
  }

  async function refundAction(el) {
    const name = el.dataset.name || "this person", amount = el.dataset.amount;
    haptic("impact", "medium");
    if (!(await confirmBox(`Refund ${amount} ⭐ to ${name}? Telegram returns the Stars to their balance. This cannot be undone.`))) return;
    S.busy.refund = true;
    renderView();
    try {
      const r = await api("/api/admin/refund", { id: Number(el.dataset.value) });
      haptic("success");
      toast(r.message, "ok", 3600);
    } catch (e) {
      haptic("error");
      toast(e.message, "err", 4200);
    }
    S.busy = {};
    loadAdmin(true);
  }

  // Step 13: delete or block a custom topic (owner only)
  async function topicAdminAction(el) {
    const act = el.dataset.act, name = el.dataset.name || "this topic";
    haptic("impact", "medium");
    const msg = act === "block"
      ? `Block "${name}"? It is deleted for every follower and nobody can create it again.`
      : `Delete "${name}"? Its followers lose it; anyone can add it again later.`;
    if (act !== "keywords" && !(await confirmBox(msg))) return;
    S.busy.topicAdmin = true;
    renderView();
    try {
      const r = await api("/api/admin/topic", { id: Number(el.dataset.value), action: act });
      haptic("success");
      toast(r.message, "ok", 3600);
    } catch (e) {
      haptic("error");
      toast(e.message, "err", 4200);
    }
    S.busy = {};
    loadAdmin(true);
  }

  // ---------------------------------------------------------------- events
  document.addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-action]");
    // the whole "Add a topic" row is tappable: a tap anywhere on it opens the field
    if (!el && ev.target.closest && ev.target.closest(".add-row") && ev.target.id !== "topic-input") {
      const input = $("#topic-input");
      if (input && !input.disabled) input.focus();
      return;
    }
    if (!el || el.disabled) return;
    const v = el.dataset.value;
    switch (el.dataset.action) {
      case "tab":
        if (S.tab === v) return;
        S.tab = v;
        haptic("select");
        syncTabs();
        renderView(true);
        if (v === "admin" && !S.admin && !S.adminLoading) loadAdmin();
        window.scrollTo({ top: 0 });
        break;
      case "topic": toggleTopic(el); break;
      case "time": toggleTime(el); break;
      case "pause": togglePause(el); break;
      case "lang": chooseLanguage(el); break;
      case "tip": payTip(Number(v)); break;
      case "add-topic": ev.preventDefault(); addTopic(); break;
      case "remove-topic": removeTopic(el); break;
      case "custom-switch": toggleCustom(el); break;
      case "edit-topics": S.editTopics = !S.editTopics; haptic("select"); renderMyTopics(); break;
      case "refund": refundAction(el); break;
      case "topic-admin": topicAdminAction(el); break;
      case "range": S.range = v; haptic("select"); renderView(); break;
      case "refresh": haptic("impact", "light"); loadAdmin(true); renderView(); break;
      case "all-errors": S.allErrors = true; renderView(); break;
      case "digest-now": adminAction("digest"); break;
      case "run-job": adminAction("run"); break;
      case "retry": boot(); break;
      case "open-help": openPage("help"); break;
      case "open-feedback": openPage("feedback"); break;
      case "fb-send": sendFeedback(); break;
      case "setup-next": setupStep(1); break;
      case "setup-back": setupStep(-1); break;
      case "setup-skip": finishSetup(true); break;
      case "setup-finish": finishSetup(false); break;
      case "ann-audience": S.annAudience = v; haptic("select"); renderView(); break;
      case "ann-translate": announceAction("draft"); break;
      case "ann-preview": announceAction("preview", el); break;
      case "ann-send": announceAction("send", el); break;
      case "ann-cancel": announceAction("cancel", el); break;
      default: break;
    }
  });

  // Step 13: the add-a-topic field. Enter submits (the form); "Add" shows only once something is typed.
  document.addEventListener("submit", (ev) => {
    if (ev.target && ev.target.id === "add-topic") { ev.preventDefault(); addTopic(); }
  });
  document.addEventListener("input", (ev) => {
    if (ev.target && ev.target.id === "ann-en") S.annDraft = ev.target.value;
    if (ev.target && ev.target.classList && ev.target.classList.contains("ann-text")) {
      S.annEdit = S.annEdit || {};
      S.annEdit[ev.target.dataset.lang] = ev.target.value;
      S.annDirty = true;
      const b = $('[data-action="ann-send"]');
      if (b) b.disabled = true;   // an edit needs a new preview first
    }
    if (ev.target && ev.target.id === "fb-input") {
      S.fbDraft = ev.target.value;
      const b = $('[data-action="fb-send"]');
      if (b && !S.busy.fb) b.disabled = !S.fbDraft.trim();
    }
    if (ev.target && ev.target.id === "topic-input") {
      S.draft = ev.target.value;
      ev.target.closest("form").classList.toggle("has-text", !!S.draft.trim());
    }
  });

  function fatal(title, text, retry) {
    app.removeAttribute("aria-busy");
    app.innerHTML = `<div class="empty"><div class="empty-icon">${I.paper}</div><h1>${esc(title)}</h1><p>${esc(text)}</p>
      ${retry ? `<button class="btn" data-action="retry">${esc(tr("app.try_again"))}</button>` : ""}</div>`;
  }

  async function boot() {
    // Until the server says which language the user chose: Telegram's app language, if we have it.
    setLang(tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.language_code);
    if (!tg || !tg.initData) {
      fatal(tr("app.open_in_telegram_title"), tr("app.open_in_telegram"));
      return;
    }
    app.innerHTML = `<div class="loading"><span class="spinner" aria-label="${esc(tr("app.loading"))}"></span></div>`;
    try {
      S.st = await api("/api/open", { tz: deviceTz });
    } catch (e) {
      if (e.status === 401) fatal(tr("app.reopen_title"), e.message, false);
      else fatal(tr("app.load_failed"), e.message, true);
      return;
    }
    setLang(S.st.user.lang);
    if (S.st.setup) { S.page = "setup"; S.step = 1; }   // Step 15: the first open
    renderShell();
    renderView();
  }

  if (tg) {
    tg.ready();
    try { tg.expand(); } catch { /* old client */ }
    try { if (ver("7.7")) tg.disableVerticalSwipes(); } catch { /* old client */ }
    applyTheme();
    tg.onEvent("themeChanged", () => { applyTheme(); });
  }
  boot();
})();
