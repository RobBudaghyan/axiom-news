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
  // Step 17b: the loading screen from index.html (the logo with a slow fade), reused on a retry
  const LOADER = (app.querySelector(".loading") || {}).outerHTML || '<div class="loading" role="status"></div>';
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
    if (S.deleted) return;   // Step 17: after "Delete my data" only the one line stays
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
    if (S.deleted) return;
    const v = $("#view");
    if (!v) return;
    v.innerHTML = S.page ? PAGES[S.page]() : S.tab === "admin" ? adminHTML() : settingsHTML();
    if (animate) { v.classList.remove("view"); void v.offsetWidth; v.classList.add("view"); }
  }

  // ---------------------------------------------------------------- settings
  // Step 12: no helper texts, no "Saved" toast (a light haptic tap instead). One button component
  // (.b) on a 6-column grid: a time spans 1 column, a tip 2, a language 3, so every grid lines up.
  // Rows (topics) carry a small coloured square and a red switch (the owner's design 1).
  // Step 16 (owner): no Pause; a reader may switch every topic off, and then gets nothing at all.
  const allOff = () => !S.st.user.topics.length && !(S.st.custom || []).some((c) => c.on);
  function heroHTML() {
    const u = S.st.user;
    if (allOff()) {
      return `<div class="group hero off" id="hero"><div class="hero-icon emo" aria-hidden="true">😴</div><div>
        <div class="hero-value">${esc(tr("app.all_off"))}</div><div class="hero-label">${esc(tr("app.all_off_hint"))}</div></div></div>`;
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
  const TINT = { politics_conflicts: "0, 122, 255", economy_markets: "48, 176, 199", tech_ai: "88, 86, 214", armenia: "255, 149, 0",
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
    // Step 16 (owner exception to "no helper texts"): one small hint line under the add row
    const hint = add ? `<p class="section-foot hint" id="topic-hint">${esc(tr("app.add_topic_hint"))}</p>` : "";
    return `<section class="section${editing ? " editing" : ""}" id="my-topics">${head}${card(rows + add)}${hint}</section>`;
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
      // Step 18: this answer is not in the save queue (the AI check takes seconds), so only its topic
      // list is taken; the settings stay as the queue has them.
      S.st.custom = r.custom;
      if (r.limits) S.st.limits = r.limits;
      if (S.server) S.server.custom = copy(r.custom);
      for (const c of S.st.custom || []) if (pendingCustom.has(c.id)) c.on = pendingCustom.get(c.id);
      S.busy.addTopic = false;
      if (res.kind === "added" || res.kind === "joined") {   // joined (someone had made it) looks the same
        S.draft = "";
        const fresh = (S.st.custom || []).find((c) => !before.has(c.id));
        S.justAdded = fresh ? fresh.id : null;
        renderMyTopics();
        updateHero();
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

  function toggleCustom(el) {
    const id = Number(el.dataset.value);
    const c = (S.st.custom || []).find((x) => x.id === id);
    if (!c) return;
    c.on = !c.on;
    pendingCustom.set(id, c.on);
    syncControls();
    queue(async () => {   // Step 18: one request at a time, the latest wish, rolled back on an error
      if (!pendingCustom.has(id)) return;
      const on = pendingCustom.get(id);
      pendingCustom.delete(id);
      try {
        adopt(await api("/api/topics/switch", { id, on }));
        syncControls();
        haptic("impact", "light");
      } catch (e) {
        rollback(e);
      }
    });
  }

  function removeTopic(el) {
    const id = Number(el.dataset.value);
    const list = S.st.custom || [];
    const row = el.closest(".row");
    S.st.custom = list.filter((c) => c.id !== id);
    pendingCustom.delete(id);
    haptic("impact", "light");
    row.classList.add("gone");   // collapses, then the card is drawn again
    setTimeout(() => renderMyTopics(), 220);
    queue(async () => {
      try {
        adopt(await api("/api/topics/remove", { id }));
        setTimeout(() => syncControls(), 240);   // after the row has closed
      } catch (e) {
        rollback(e);
      }
    });
  }

  // 18 hours on 6 columns: one row each for morning, afternoon and evening.
  function timesHTML() {
    const u = S.st.user;
    return grid(allowedTimes(S.st.limits).map((t) => `<button class="b t tnum" data-action="time" data-value="${t}" aria-pressed="${u.digest_times.includes(t)}">${t}</button>`).join(""));
  }

  const hasLangs = () => (S.st.languages || []).length >= 2;
  function langGrid() {
    const flags = L10N.flags || {};
    return grid((S.st.languages || []).map((l) => `<button class="b s3" role="radio" aria-checked="${l.code === S.st.user.lang}" data-action="lang" data-value="${esc(l.code)}">` +
      `${flags[l.code] ? `<span class="emo" aria-hidden="true">${esc(flags[l.code])}</span>` : ""}<span class="lbl" lang="${esc(l.code)}">${esc(l.name)}</span></button>`).join(""));
  }
  function languagesHTML() {
    return hasLangs() ? sec(tr("app.sec_language"), langGrid(), 'id="language" role="radiogroup"') : "";
  }

  // "Yerevan · GMT+4": the phone's zone, saved on every open (Step 12: one quiet line, no row).
  const zoneLine = (u) => { const off = offset(u.timezone); return off ? tr("app.zone_line", { zone: zoneName(u.timezone), offset: off }) : zoneName(u.timezone); };

  function settingsHTML() {
    return `<section class="section">${heroHTML()}</section>
      ${sec(tr("app.sec_topics"), topicsHTML(), 'id="topics"')}
      ${myTopicsHTML()}
      ${sec(tr("app.sec_times"), timesHTML(), 'id="times"')}
      ${languagesHTML()}
      ${supportHTML()}
      ${moreHTML()}
      <p class="tzline tnum" id="tz-line">${esc(zoneLine(S.st.user))}</p>`;
  }

  // ---------------------------------------------------------------- Step 15: Help and Send feedback
  // Two rows near the bottom of Settings, each opening its own page with Telegram's back button.
  // Settings itself keeps no helper text; the help text lives on its page.
  const PAGE_TITLES = { help: "app.help", feedback: "app.feedback" };
  const PAGES = { help: () => helpHTML(), feedback: () => feedbackHTML(), setup: () => setupHTML() };
  // Step 16 (owner): a Language step first (only while more than one language is on).
  const setupSteps = () => (hasLangs() ? ["lang", "topics", "times", "done"] : ["topics", "times", "done"]);
  const SETUP_TITLES = { lang: "app.setup_lang", topics: "app.setup_topics", times: "app.setup_times", done: "app.setup_done" };
  const pageTitle = () => tr(S.page === "setup" ? SETUP_TITLES[setupSteps()[Math.min(S.step || 1, setupSteps().length) - 1]] : PAGE_TITLES[S.page]);

  // Step 15: the first open's setup (Step 16: language, topics, times, done), skippable. Every choice
  // saves at once like in Settings; Done or Skip tells the server, which sends one sample digest.
  function setupHTML() {
    const steps = setupSteps();
    const step = Math.min(S.step || 1, steps.length);
    const kind = steps[step - 1];
    const head = tr("app.setup_step", { n: step, of: steps.length });
    const first = step === 1 ? "skip" : "back";
    if (kind === "lang") return sec(head, langGrid(), 'id="language" role="radiogroup"') + setupNav(first, "next");
    // Step 18 (owner): every topic starts off here; Next waits for one, with one short hint line
    if (kind === "topics") {
      const none = !S.st.user.topics.length;
      return sec(head, topicsHTML() + `<p class="section-foot hint" id="setup-hint"${none ? "" : " hidden"}>${esc(tr("app.setup_pick_topic"))}</p>`, 'id="topics"') +
        setupNav(first, "next", none);
    }
    if (kind === "times") return sec(head, timesHTML(), 'id="times"') + setupNav(first, "next");
    return `<section class="section"><h2 class="section-head">${esc(head)}</h2>${heroHTML()}</section>` +
      sec("", card(`<p class="help-p lines">${lines(tr("app.setup_sample"))}</p>`)) + setupNav(null, "finish");
  }
  const setupNav = (left, right, blocked = false) => `<section class="section setup-nav">${grid(
    (left ? `<button class="b s2" data-action="setup-${left}" ${S.busy.setup ? "disabled" : ""}>${esc(tr(`app.setup_${left}`))}</button>` : "") +
    `<button class="b ${left ? "s4" : "s6"} primary" data-action="setup-${right}" ${S.busy.setup || blocked ? "disabled" : ""}>` +
    `${S.busy.setup && right === "finish" ? '<span class="spinner small"></span>' : esc(tr(`app.setup_${right}`))}</button>`)}</section>`;
  // The topics step: Next and the hint follow the switches at once
  function updateSetupNav() {
    if (S.page !== "setup" || setupSteps()[(S.step || 1) - 1] !== "topics") return;
    const none = !S.st.user.topics.length;
    const next = $('[data-action="setup-next"]'), hint = $("#setup-hint");
    if (next) next.disabled = none || !!S.busy.setup;
    if (hint) hint.hidden = !none;
  }
  function setupStep(delta) {
    const steps = setupSteps();
    if (delta > 0 && steps[(S.step || 1) - 1] === "topics" && !S.st.user.topics.length) { haptic("warning"); return; }
    S.step = Math.min(steps.length, Math.max(1, (S.step || 1) + delta));
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
      const r = await api("/api/onboard", { skipped });   // Skip: the server puts the six main topics back on
      S.busy = {};
      haptic("success");
      S.page = null;
      adopt(r);
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
    return sec("", card(navRow("open-help", I.help, "red", tr("app.help")) + navRow("open-feedback", I.chat, "red", tr("app.feedback"))),
      'id="more"');
  }
  // Step 16 (owner): each section is a title with an emoji and 2-4 short lines (one idea a line).
  const HELP = ["what", "stories", "topics", "times", "lang", "support", "feedback", "privacy"];
  const lines = (s) => String(s).split("\n").map((l) => `<span class="line">${esc(l)}</span>`).join("");
  function helpHTML() {
    return HELP.map((k) => sec(tr(`app.help_${k}_h`), card(`<p class="help-p lines">${lines(tr(`app.help_${k}`))}</p>`), `id="help-${k}"`)).join("")
      // Step 17: under the privacy section, one small row (confirm step, then everything about the reader goes)
      + sec("", deleteHTML(), 'id="help-delete"');
  }
  // Step 18 (owner): the row and its confirm button in the brand red (never the orange of Admin's
  // failures). The question shows in place, under the row: the text, Cancel and a solid red Delete.
  function deleteHTML() {
    const row = `<button class="row action danger tap" data-action="delete-me" id="delete-me" ${S.busy.del || S.delAsk ? "disabled" : ""}>` +
      `<span class="row-main row-title">${esc(tr("app.delete_row"))}</span></button>`;
    if (!S.delAsk) return card(row);
    const text = tr(S.delAsk === 2 ? "app.delete_owner_confirm" : "app.delete_confirm");
    return card(row + `<p class="help-p del-q" id="delete-q">${esc(text)}</p>`) +
      `<div class="grid del-actions"><button class="b s2" data-action="delete-cancel" ${S.busy.del ? "disabled" : ""}>${esc(tr("app.delete_cancel"))}</button>` +
      `<button class="b s4 primary" data-action="delete-yes" id="delete-yes" ${S.busy.del ? "disabled" : ""}>` +
      `${S.busy.del ? '<span class="spinner small"></span>' : esc(tr("app.delete_yes"))}</button></div>`;
  }
  function deleteAsk() {
    haptic("impact", "medium");
    S.delAsk = 1;
    renderView();
    const q = $("#help-delete");
    if (q) q.scrollIntoView({ block: "end", behavior: "smooth" });
  }
  function deleteCancel() { S.delAsk = 0; haptic("select"); renderView(); }
  // Step 17: "Delete my data". One confirm (tr("app.delete_confirm")), a second for the owner
  // (tr("app.delete_owner_confirm")); afterwards one short line, then the app closes and nothing more is
  // called (an /api/open would create the reader again).
  async function deleteMe() {
    if (S.busy.del) return;
    const owner = !!S.st.is_owner;
    if (owner && S.delAsk === 1) { S.delAsk = 2; haptic("impact", "medium"); renderView(); return; }
    S.busy.del = true;
    renderView();
    try {
      await api("/api/account/delete", owner ? { confirm: true, owner_confirm: true } : { confirm: true });
    } catch (e) {
      S.busy = {};
      S.delAsk = 0;
      renderView();
      haptic("error");
      toast(e.message, "err", 4200);
      return;
    }
    S.deleted = true;
    haptic("success");
    try { if (tg && ver("6.1")) { tg.BackButton.offClick(onBack); tg.BackButton.hide(); } } catch { /* old client */ }
    app.innerHTML = `<main class="deleted" id="deleted"><p class="deleted-line">${esc(tr("app.delete_done"))}</p></main>`;
    setTimeout(() => { try { if (tg) tg.close(); } catch { /* old client */ } }, 2600);
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
    S.delAsk = 0;
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

  // Step 18 (the digest times bug): one request at a time. Taps made while a request is on its way
  // are merged into the next one (pending), and an answer never overwrites a tap the server has not
  // seen yet. The controls are always drawn from S.st (syncControls), so the screen and the data
  // cannot part (before, an older answer replaced the data while the buttons kept the newer taps, and
  // a later tap could switch off the last time on screen). Any error rolls back to the server's own
  // state (sent with the error, else its last answer) and drops the unsent taps. A saved change is a
  // light haptic tap (Step 12, owner: never a "Saved" toast); an error still shows, briefly.
  let chain = Promise.resolve();
  let pending = {};                   // settings taps not sent yet (topics, digest_times, lang)
  const pendingCustom = new Map();    // custom topic switches not sent yet: id -> on
  const copy = (x) => JSON.parse(JSON.stringify(x));
  function queue(job) {
    chain = chain.then(job).catch(() => { /* every job handles its own errors */ });
    return chain;
  }
  // The setup's topics step starts with every topic off (Step 18), until the reader taps one there.
  const setupBlank = () => S.page === "setup" && !S.setupTouched;
  function adopt(r) {
    const keep = {};
    for (const k of Object.keys(pending)) keep[k] = S.st.user[k];
    const customKeep = new Map(pendingCustom);
    S.server = copy(r);
    S.st = r;
    Object.assign(S.st.user, keep);
    for (const c of S.st.custom || []) if (customKeep.has(c.id)) c.on = customKeep.get(c.id);
    if (setupBlank()) S.st.user.topics = [];
  }
  function rollback(e) {
    pending = {};
    pendingCustom.clear();
    const st = e && e.data && e.data.state && e.data.state.user ? e.data.state : S.server;
    if (st) {
      const langBefore = LANG;
      S.server = copy(st);
      S.st = copy(st);
      if (setupBlank()) S.st.user.topics = [];
      if (S.st.user.lang !== langBefore) { setLang(S.st.user.lang); renderShell(); }
    }
    haptic("error");
    renderView();
    toast(e.message, "err", 3200);
  }
  // Every control from the data, in place (so a switch still slides): times, topics, custom switches,
  // the next digest card and the setup's Next.
  function syncControls() {
    const u = S.st.user;
    document.querySelectorAll("[data-action=time]").forEach((b) => b.setAttribute("aria-pressed", String(u.digest_times.includes(b.dataset.value))));
    document.querySelectorAll("[data-action=topic]").forEach((b) => b.setAttribute("aria-checked", String(u.topics.includes(b.dataset.value))));
    const custom = S.st.custom || [];
    const rows = [...document.querySelectorAll("#my-topics .ct")];
    if (rows.length !== custom.length || rows.some((r, i) => Number(r.dataset.value || r.dataset.id) !== custom[i].id)) renderMyTopics();
    else document.querySelectorAll("[data-action=custom-switch]").forEach((b) => {
      const c = custom.find((x) => x.id === Number(b.dataset.value));
      if (c) b.setAttribute("aria-checked", String(!!c.on));
    });
    updateHero();
    updateSetupNav();
  }
  function save(patch) {
    Object.assign(pending, patch);
    return queue(async () => {
      if (!Object.keys(pending).length) return;   // already sent with an earlier request, or rolled back
      const send = pending;
      pending = {};
      try {
        const r = await api("/api/settings", send);
        adopt(r);
        if ("lang" in send) { setLang(S.st.user.lang); renderShell(); renderView(); }   // topic names come back translated
        else syncControls();
        haptic("impact", "light");
      } catch (e) {
        rollback(e);
      }
    });
  }

  function shake(el) {
    el.classList.remove("shake"); void el.offsetWidth; el.classList.add("shake");
  }

  function toggleTopic(el) {
    const u = S.st.user;
    const tag = el.dataset.value;
    const on = u.topics.includes(tag);
    if (S.page === "setup") S.setupTouched = true;   // from now on the setup shows the saved topics
    u.topics = on ? u.topics.filter((t) => t !== tag) : S.st.topics.map((t) => t.tag).filter((t) => t === tag || u.topics.includes(t));
    syncControls();
    save({ topics: [...u.topics] });
  }

  // Tap an hour to choose it (red), tap again to remove it. 1 to max_times. The checks use the data the
  // buttons are drawn from, so the last time can never go (Step 18).
  function toggleTime(el) {
    const u = S.st.user, L = S.st.limits;
    const t = el.dataset.value;
    const on = u.digest_times.includes(t);
    if (on && u.digest_times.length <= 1) {
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
    u.digest_times = on ? u.digest_times.filter((x) => x !== t) : [...u.digest_times, t].sort();
    syncControls();
    save({ digest_times: [...u.digest_times] });
  }

  // Step 9: a new language applies to the whole page at once; saved instantly like every setting.
  function chooseLanguage(el) {
    const u = S.st.user;
    const code = el.dataset.value;
    if (!code || code === u.lang) return;
    u.lang = code;
    setLang(code);
    renderShell();
    renderView();
    save({ lang: code });
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

  // Step 18 (owner): a dashboard that is easy to oversee on a phone. On top: one health line (green,
  // amber or red) with the reason, the key numbers, the actions and the free limits. Below: sections
  // that open with a tap (closed by default), each a 48 px row with its emoji square and a short
  // summary; colour only where something needs attention.
  const ADM = [["pipeline", "⚙️", "Pipeline", "88, 86, 214"], ["ai", "🤖", "AI", "0, 122, 255"], ["feeds", "📡", "Feeds", "48, 176, 199"],
    ["users", "👥", "Users", "52, 199, 89"], ["custom", "🗂️", "Custom topics", "255, 149, 0"], ["announce", "📣", "Announcement", "255, 204, 0"],
    ["feedback", "💬", "Feedback", "175, 82, 222"], ["tips", "⭐", "Tips", "255, 204, 0"], ["errors", "⚠️", "Errors", "142, 142, 147"]];
  // Notes the job writes on a normal day (a skipped item is resent, an overloaded model falls back):
  // hidden behind "Show all" in Errors.
  const ROUTINE = /answer skipped|answer left out|fact guard dropped|rejected by the checks|^language fallback|^warm-up|HTTP 503|high demand|resending/i;
  const pctTxt = (x) => `${Math.round(x * 100)}%`;
  const lvlOf = (x, warn = 0.7, bad = 0.9) => (x >= bad ? "bad" : x >= warn ? "warn" : "");
  function errorGroups(list) {
    const by = new Map();
    for (const e of list) {
      const key = `${e.component}|${String(e.message).replace(/\d+/g, "#")}`;
      const g = by.get(key);
      if (g) { g.count++; g.first = Math.min(g.first, e.at); } else by.set(key, { ...e, count: 1, first: e.at, routine: ROUTINE.test(e.message) });
    }
    return [...by.values()].sort((a, b) => b.at - a.at);   // newest first
  }
  function admSection(key, summary, body) {
    const [, emoji, title, rgb] = ADM.find((x) => x[0] === key);
    const open = !!(S.admOpen && S.admOpen[key]);
    return `<section class="section adm-sec" id="adm-${key}"><div class="group"><button class="row has-icon tap adm-head" data-action="adm-sec" ` +
      `data-value="${key}" aria-expanded="${open}"><span class="sq" style="--tint: rgba(${rgb}, 0.18)" aria-hidden="true">${emoji}</span>` +
      `<span class="row-main row-title">${esc(title)}</span><span class="row-right adm-sum">${summary}</span>` +
      `<span class="chev" aria-hidden="true">${I.chev}</span></button></div>${open ? `<div class="adm-body">${body()}</div>` : ""}</section>`;
  }
  const sub = (head, body, foot) => `<div class="adm-part">${head ? `<h3 class="section-head">${head}</h3>` : ""}<div class="group">${body}</div>${
    foot ? `<p class="section-foot">${foot}</p>` : ""}</div>`;
  const mute = (t) => `<span class="adm-mute">${esc(t)}</span>`;

  function adminHTML() {
    const A = S.admin;
    if (!A) {
      if (S.adminErr) {
        return section("", row({ title: "Could not load", sub: esc(S.adminErr), right: '<button class="link" data-action="refresh">Retry</button>' }));
      }
      const sk = '<div class="skeleton"><i></i></div>';
      return `${section("", sk + sk)}${section("", sk + sk + sk)}${section("", sk)}`;
    }
    const tz = S.st.user.timezone;
    const h = A.health, Z = A.summary;
    const lr = h.last_run;
    const N = Z.numbers;

    // ---------------------------------------------------------- the health line and the key numbers
    const lvl = { ok: ["All good", ""], warn: ["Needs a look", "warn"], bad: ["Something is wrong", "bad"] }[Z.level];
    const status = `<div class="status ${lvl[1]}" id="health"><span class="dot" aria-hidden="true">${Z.level === "ok" ? I.tick : I.bang}</span>` +
      `<div class="row-main"><div class="status-title">${lvl[0]}</div><div class="status-sub">${esc(Z.reason)}</div></div></div>`;
    const st = lr ? STATUS[lr.status] || [lr.status, "mute"] : null;
    const kpi = (value, label, cls = "") => `<div class="kpi ${cls}"><b class="tnum">${esc(value)}</b><span>${esc(label)}</span></div>`;
    const tries = N.digests_today + N.failed_today;
    const kpis = `<div class="kpis" id="kpis">${
      kpi(n(N.active_users), "Active users") +
      kpi(n(N.digests_today), "Digests today") +
      kpi(tries ? pctTxt(N.delivery) : "None yet", "Delivered", tries && N.failed_today ? (N.delivery < 0.8 ? "bad" : "warn") : "") +
      kpi(n(N.stories_today), "Stories today") +
      kpi(N.last_run ? hm(N.last_run.at, tz) : "None", N.last_run ? `Last run · ${st[0]}` : "Last run", N.last_run && st[1] !== "mute" ? st[1] : "") +
      kpi(N.next_run_at ? `~${hm(N.next_run_at, tz)}` : A.env === "staging" ? "No job" : "None", "Next run")}</div>`;
    const top = `<section class="section"><div class="group">${status}${kpis}</div></section>`;

    const actions = row({ icon: I.send, tile: true, title: "Send me a digest now", sub: "A real digest from the current pool", tag: "button",
      cls: "action tap", attrs: `data-action="digest-now" ${S.busy.digest ? "disabled" : ""}`, right: S.busy.digest ? '<span class="spinner spin-sm"></span>' : "" })
      + row({ icon: I.play, tile: true, title: "Run news job now", sub: "Collect feeds and run the AI pass", tag: "button",
        cls: "action tap", attrs: `data-action="run-job" ${S.busy.run ? "disabled" : ""}`, right: S.busy.run ? '<span class="spinner spin-sm"></span>' : "" });

    // ---------------------------------------------------------- free limits
    const Lm = Z.limits;
    const D = A.d1;
    const limRow = (title, key, count, limit) => {
      const v = Lm.today[key], y = Lm.yesterday ? Lm.yesterday[key] : null, l = lvlOf(v);
      return row({ title, sub: esc(`${compact(count)} of ${compact(limit)}${y != null ? ` · yesterday ${pctTxt(y)}` : ""}`),
        right: l ? badge(pctTxt(v), l) : `<span class="kv-num">${pctTxt(v)}</span>`, cls: `lim${l ? ` ${l}` : ""}`, attrs: `data-lim="${key}"` });
    };
    const cpuRow = row({ title: "Worker CPU", sub: "Runs over the 10 ms limit today", cls: "lim", attrs: 'data-lim="cpu"',
      right: Lm.cpu_over ? badge(n(Lm.cpu_over), "bad") : '<span class="kv-num">None</span>' });
    const aiRows = Z.ai.map((m) => {
      const bad = m.calls >= 4 && m.failed / m.calls >= 0.5;
      const kinds = (m.kinds || []).map(kindLabel).join(", ");
      return row({ title: `<span class="ellipsis">${esc(m.model)}</span>`, cls: "lim", attrs: 'data-lim="ai"',
        sub: esc([PROVIDER[m.provider] || m.provider, kinds, m.soft_limit ? `today ${n(m.today)} of ${n(m.soft_limit)}` : ""].filter(Boolean).join(" · ")),
        right: `<span class="kv-num">${plural(m.calls, "call", "calls")}</span>` +
          (m.failed ? (bad ? badge(`${m.failed} errors`, "warn") : mute(`${m.failed} ${m.failed === 1 ? "error" : "errors"}`)) : "") });
    }).join("");
    const limits = section("Free limits, today", limRow("D1 reads", "reads", Lm.counts.r, D.limits.rows_read) +
      limRow("D1 writes", "writes", Lm.counts.w, D.limits.rows_written) + cpuRow + (aiRows || row({ title: "No AI calls in 24 hours" })),
      (Lm.source === "account" ? `D1 and CPU: Cloudflare's own count for the whole account (both copies), checked ${hm(Lm.checked_at, tz)}. `
        : "D1: this copy's count (Cloudflare's account numbers are not in yet). ") + "AI: calls in the last 24 hours. Limits reset at 00:00 UTC.",
      'id="limits"');

    // ---------------------------------------------------------- sections
    const s = A.stats[S.range];
    const seg = `<div class="seg small" role="tablist"><span class="seg-thumb" style="width:calc(50% - 2px);transform:${S.range === "7d" ? "translateX(100%)" : "none"}"></span>
      <button role="tab" aria-selected="${S.range === "24h"}" data-action="range" data-value="24h">Last 24 hours</button>
      <button role="tab" aria-selected="${S.range === "7d"}" data-action="range" data-value="7d">Last 7 days</button></div>`;
    const s24 = A.stats["24h"];

    const pipeline = () => {
      const runRow = lr ? row({ title: "Last news job", sub: esc([duration(lr.duration_s), providerLabel(lr.provider)].filter(Boolean).join(" · ")),
        right: `<span class="tnum">${esc(when(lr.started_at, tz))}</span>${st[1] && st[1] !== "mute" ? badge(st[0], st[1]) : mute(st[0])}` })
        : row({ title: "Last news job", right: "None yet" });
      const okRow = row({ title: "Last successful run", sub: h.last_ok_at ? ago(h.last_ok_at) : "", right: `<span class="tnum">${esc(when(h.last_ok_at, tz))}</span>` });
      const trigRow = row({ title: "Hourly trigger", sub: h.trigger.on_time ? "Runs at about :07 every hour" : "No run started in the last 70 minutes",
        right: h.trigger.on_time ? mute("On time") : badge("Late", "warn") });
      const alertRow = row({ title: "Alerts, last 24 h", sub: h.alert ? `<span class="clamp">${esc(h.alert.text)}</span>` : "",
        right: h.alert ? `<span class="tnum">${esc(when(h.alert.at, tz))}</span>` : "None" });
      const runsSub = [s.failed ? `${s.failed} failed` : "", s.partial ? `${s.partial} partly done` : ""].filter(Boolean).join(" · ") || "none failed";
      const stats = kv("News job runs", n(s.runs), runsSub) + kv("Articles collected", n(s.items_fetched), `${n(s.items_new)} new`)
        + kv("Stories created", n(s.stories_created), `${n(s.stories_merged)} merged into existing stories`)
        + kv("Dropped as not news", n(s.items_dropped))
        + kv("Editor pass", `${n(s.editor_ok)} of ${n(s.runs)}`, `runs edited the news${s.editor_failed ? ` · ${s.editor_failed} failed` : ""} · ${plural(s.editor_merged, "duplicate", "duplicates")} merged`)
        + kv("AI tokens", `${compact(s.input_tokens)} in · ${compact(s.output_tokens)} out`);
      const dl = A.today.deliveries;
      const deliv = kv("Digests sent", n(dl.sent), `${plural(dl.stories, "story", "stories")} · ${plural(dl.quiet, "quiet note", "quiet notes")}`)
        + kv("Failed tries", n(dl.failed), "Retried at the next tick, for up to an hour") + kv("Readers who blocked the bot", n(dl.blocked));
      const db = kv("News job", `${compact(D.job.r)} read · ${compact(D.job.w)} written`, plural(D.job.runs, "run", "runs"))
        + kv("Bot server", `${compact(D.worker.r)} read · ${compact(D.worker.w)} written`, "Digests, settings, Admin");
      return sub("", runRow + okRow + trigRow + alertRow) + `<div class="adm-part">${seg}<div class="group">${stats}</div></div>` +
        sub("Deliveries today (UTC)", deliv) + sub("Database rows today, this copy", db);
    };

    const C = A.custom;
    const ai = () => {
      const models = A.stats.models.filter((m) => m[S.range].calls).map((m) => {
        const x = m[S.range];
        const failed = x.calls - x.ok;
        return row({ title: `<span class="ellipsis">${esc(m.model || m.provider)}</span>`, sub: `${esc(PROVIDER[m.provider] || m.provider)} · ${kindLabel(m.kind)} · ${compact(x.input_tokens)} in, ${compact(x.output_tokens)} out`,
          right: `<span class="kv-num">${plural(x.calls, "call", "calls")}</span>${failed ? mute(`${failed} failed`) : ""}` });
      }).join("") || row({ title: "No AI calls in this period" });
      const G = C.guard;
      const glvl = [["Normal", ""], ["Topic checks delayed", "warn"], ["Topic checks and translations delayed", "bad"]][Math.max(G.level, G.job_level || 0)] || ["?", "mute"];
      const guardRows = row({ title: "AI budget", sub: esc(G.reasons.length ? G.reasons.join("; ") : "Calls are counted per model since midnight Pacific time."),
        right: glvl[1] ? badge(glvl[0], glvl[1]) : mute(glvl[0]) })
        + G.models.map((m) => row({ title: `<span class="ellipsis">${esc(m.model)}</span>`,
          sub: esc(`${plural(m.r429, "answer", "answers")} 429 today${m.recent429 ? `, ${m.recent429} in the last hour` : ""}`),
          right: `<span class="kv-num">${n(m.calls)}${m.soft_limit ? ` of ${n(m.soft_limit)}` : ""}</span>` })).join("")
        + (G.translate_delayed ? row({ title: "Translations", right: badge("Delayed by the last run", "bad") }) : "")
        + (G.alerted_day ? row({ title: "Last AI budget alert", right: `<span class="tnum">${esc(G.alerted_day)}</span>` }) : "");
      const langRows = (A.languages || []).map((l) => row({
        title: `${esc(l.name)} ${l.enabled ? "" : badge("Hidden", "mute")}`,
        sub: esc(l.code === "en" ? `${plural(l.active, "active reader", "active readers")} · no translation needed`
          : `${plural(l.active, "active reader", "active readers")} · ${plural(l.translated_24h, "story", "stories")} translated` +
            `${l.rejected_24h ? ` (${l.rejected_24h} rejected by checks)` : ""} · ${plural(l.calls_24h, "call", "calls")}` +
            ` · ${plural(l.held_24h, "story", "stories")} held` + `${l.held_holds_24h ? ` (${l.held_released_24h} of ${l.held_holds_24h} sent later)` : ""}`),
        right: l.code === "en" ? "" : l.fallbacks_24h ? badge(`${l.fallbacks_24h} in English`, "warn") : "" })).join("");
      return `<div class="adm-part">${seg}<div class="group">${models}</div></div>` +
        sub("AI budget, today", guardRows, "Over 80% of a soft limit, or a 429 from Gemini in the last hour: new topic checks wait. Over the limit: translations wait too. The first pass and the editor never wait.") +
        sub("Languages, last 24 h", langRows || row({ title: "No data" }), "A story with no translation yet is held and sent later; a digest goes out in English only when none of its stories is translated.");
    };
    const aiLook = Z.ai.some((m) => m.calls >= 4 && m.failed / m.calls >= 0.5) || Math.max(C.guard.level, C.guard.job_level || 0) > 0;

    const F = A.feeds;
    const feeds = () => {
      if (!F.total) return sub("", row({ title: "No feed data yet", sub: "It appears after the next hourly run." }));
      const okCount = F.total - F.failing.length - F.silent.length;
      const rows = [kv("Working", `${n(okCount)} of ${n(F.total)}`, F.checked_at ? `Checked ${when(F.checked_at, tz)}` : "")]
        .concat(F.failing.map((f) => row({ icon: '<span class="sdot"></span>', title: esc(f.name),
          sub: esc(`${feedError(f.error)} · since ${when(f.since, tz)}${f.fails > 1 ? ` · ${f.fails} runs in a row` : ""}`) })))
        .concat(F.silent.map((f) => row({ icon: '<span class="sdot warn"></span>', title: esc(f.name),
          sub: f.last_item_at ? `Silent: newest item ${ago(f.last_item_at)}` : "Silent: no items seen yet" })));
      return sub("", rows.join(""), F.failing.length || F.silent.length
        ? `Only the feeds that need a look are listed. Red: could not be read. Amber: no new items for ${F.silent_hours} hours.` : "Every feed answered and has recent items.");
    };
    const feedSum = !F.total ? "" : F.failing.length ? (F.failing.length / F.total >= 0.1 ? badge(`${F.failing.length} failing`, "warn") : mute(`${F.failing.length} failing`))
      : F.silent.length ? mute(`${F.silent.length} silent`) : mute("All working");

    const U = A.users;
    const users = () => {
      const tiles = `<div class="stats">${[["Total", U.count], ["Active", U.active], ["All off", U.all_off], ["Blocked", U.blocked]]
        .map(([k, v]) => `<div class="stat"><b>${n(v)}</b><span>${k}</span></div>`).join("")}</div>`;
      const userRows = U.list.map((x) => row({ icon: `<span class="avatar">${esc((x.name || "?").trim().charAt(0).toUpperCase())}</span>`,
        title: `${esc(x.name)} ${x.blocked ? badge("Blocked", "mute") : x.all_off ? badge("All off", "mute") : ""}`,
        sub: esc(`${(x.lang || "en").toUpperCase()} · ${city(x.timezone)} · ${x.times.join(", ")}` +
          (x.last_digest_at ? ` · last digest ${ago(x.last_digest_at)}` : " · no digest yet") +
          (x.digests_24h ? ` · avg ${x.avg_stories_24h} stories (${x.digests_24h} ${x.digests_24h === 1 ? "digest" : "digests"}, 24 h)` : "")),
        // Step 17: Delete (asks first); never on the owner's own row
        right: x.owner ? "" : `<button class="link danger user-del" data-action="user-delete" data-value="${x.id}" data-name="${esc(x.name)}" ${S.busy.userDel ? "disabled" : ""}>Delete</button>` })).join("");
      return sub("", tiles + userRows, "Delete asks first and removes everything about the person.");
    };

    const custom = () => {
      const ctRows = C.topics.map((x) => row({ icon: `<span class="sq" aria-hidden="true">${esc(x.emoji && x.emoji !== "📌" ? x.emoji : "🗞️")}</span>`,
        title: `<span class="ellipsis">${esc(x.name)}</span>`,
        sub: esc(`${plural(x.active, "active follower", "active followers")} · today ${n(x.today.searches)} searches, ${n(x.today.new_items)} new items · 24 h: ` +
          `${plural(x.stories_24h, "story", "stories")}, ${n(x.sent_24h)} sent`),
        right: `<button class="link" data-action="topic-admin" data-act="keywords" data-value="${x.id}" data-name="${esc(x.name)}" ${S.busy.topicAdmin ? "disabled" : ""}>Keywords</button>` +
          `<button class="link" data-action="topic-admin" data-act="delete" data-value="${x.id}" data-name="${esc(x.name)}" ${S.busy.topicAdmin ? "disabled" : ""}>Delete</button>` +
          `<button class="link danger" data-action="topic-admin" data-act="block" data-value="${x.id}" data-name="${esc(x.name)}" ${S.busy.topicAdmin ? "disabled" : ""}>Block</button>` })).join("");
      const outcomes = Object.entries(C.checks_24h).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(", ");
      const checkRows = kv("Topic checks, 24 h", n(Object.values(C.checks_24h).reduce((a, b) => a + b, 0)), outcomes || "none")
        + C.recent_checks.slice(0, 5).map((c) => row({ title: `<span class="ellipsis">${esc(c.input)}</span> ${badge(c.outcome.replace("_", " "),
          c.outcome === "delayed" || c.outcome === "failed" ? "warn" : "mute")}`,
          sub: esc(`${c.name || "?"} · ${when(c.at, tz)}${c.reason ? ` · ${c.reason}` : ""}`) })).join("")
        + (C.blocks.length ? row({ title: "Blocked names", sub: esc(C.blocks.map((b) => b.norm).join(", ")) }) : "");
      const foot = [C.topics.length ? "Keywords refreshes the match words. Delete removes it from its followers; Block also stops anyone creating it again. Both ask first." : "",
        C.hidden ? `<span id="custom-hidden">${n(C.hidden)} hidden (no follower has it switched on).</span>` : ""].filter(Boolean).join(" ");
      return sub("", ctRows || row({ title: "No active custom topics" }), foot) + sub("Topic checks", checkRows);
    };

    // Step 15: the announcement tool (write in English, AI translates, edit, preview to yourself, send)
    const AN = A.announce || { recent: [], languages: ["en"], enabled: ["en"] };
    const LNAME = { en: "English", ru: "Russian", hy: "Armenian", fr: "French" };
    const cur = AN.recent.find((x) => x.status === "draft" || x.status === "previewed");
    const announce = () => {
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
        right: x.status === "sending" ? badge(x.status, "warn") : mute(x.status) })).join("");
      const annFoot = cur ? (cur.status === "previewed" && !S.annDirty ? "Previewed. Send goes to every user in their language, a batch every 5 minutes, never twice."
        : "Check or edit each version, then Preview (it comes to you first). Send unlocks after a preview of exactly this text.")
        : `Languages your users read: ${AN.languages.map((l) => LNAME[l] || l).join(", ")}. Translate makes one version for each.`;
      return `<div class="adm-part" id="announce">${annBody}<p class="section-foot">${esc(annFoot)}</p></div>` + (annRows ? sub("Recent", annRows) : "");
    };
    const annSum = cur ? badge(cur.status === "previewed" ? "Previewed" : "Draft", "warn") : AN.recent.some((x) => x.status === "sending") ? badge("Sending", "warn") : "";

    const FB = A.feedback || { total: 0, recent: [] };
    const feedback = () => sub("", FB.recent.map((x) => row({ title: `<span class="clamp">${esc(x.text)}</span>`,
      sub: esc(`${x.name || "Someone"} (id ${x.user_id}${x.lang ? `, ${x.lang}` : ""}) · ${when(x.at, tz)}`),
      right: x.forwarded ? "" : badge("Not forwarded", "warn") })).join("") || row({ title: "No feedback yet" }),
      FB.total ? `${plural(FB.total, "message", "messages")} in all; the latest 20 here. Each one is also sent to your Telegram chat.` : "");
    const fbNew = FB.recent.filter((x) => A.now - x.at < 86400).length;

    const T = A.tips || { stars: 0, tips: 0, refunded: 0, last: [] };
    const tips = () => sub("", kv("Stars received", `${n(T.stars)} ⭐`, `${plural(T.tips, "tip", "tips")}` +
        (T.refunded ? ` · ${plural(T.refunded, "refund", "refunds")} (${n(T.refunded_stars)} ⭐) not counted` : ""))
      + T.last.map((x) => row({ title: `${esc(x.name)} · ${n(x.amount)} ⭐`, sub: esc(when(x.at, tz)),
        right: x.refunded_at ? mute("Refunded")
          : `<button class="link" data-action="refund" data-value="${x.id}" data-amount="${x.amount}" data-name="${esc(x.name)}" ${S.busy.refund ? "disabled" : ""}>Refund</button>` })).join(""),
      T.last.length ? "Last 10 tips. Refund returns the Stars to the person (asks first)." : "No tips yet.");

    const groups = errorGroups(A.errors);
    const real = groups.filter((g) => !g.routine);
    const real24 = real.filter((g) => A.now - g.at < 86400).length;
    const errors = () => {
      const shown = S.allErrors ? groups : real;
      const hidden = groups.length - real.length;
      const rows = shown.map((g) => row({ title: `<span class="clamp adm-err">${esc(g.message)}</span>`,
        sub: esc(`${g.count > 1 ? `${g.count} times, last ` : ""}${when(g.at, tz)} · ${g.component === "job" ? "News job" : g.component === "worker" ? "Bot server" : g.component}` +
          (g.routine ? " · routine" : "")), cls: `err${g.routine ? " routine" : ""}` })).join("")
        + (!S.allErrors && hidden ? row({ title: `Show all (${n(hidden)} routine ${hidden === 1 ? "note" : "notes"})`, tag: "button", cls: "action tap", attrs: 'data-action="all-errors"' }) : "");
      return sub("", rows || row({ title: "No errors" }),
        "Newest first; the same message is grouped. Routine notes (a skipped item resent, a busy model that fell back) are hidden until Show all.");
    };

    // Step 16: which copy this is, in big letters (staging amber, production red)
    const envBadge = `<div class="env-label ${A.env === "staging" ? "staging" : "production"}" id="env-label">${A.env === "staging" ? "STAGING" : "PRODUCTION"}</div>`;
    return `${envBadge}<div class="updated"><span>Updated ${esc(hm(A.now, tz))}</span>${S.adminLoading ? '<span class="spinner spin-sm"></span>'
      : '<button class="link" data-action="refresh" style="font-size:13px">Refresh</button>'}</div>
      ${top}
      ${section("Actions", actions, "Both ask before they run.", 'id="actions"')}
      ${limits}
      <div class="adm-list" id="adm-list">
      ${admSection("pipeline", s24.failed ? badge(`${s24.failed} failed`, "warn") : mute(`${n(s24.runs)} runs, 24 h`), pipeline)}
      ${admSection("ai", aiLook ? badge("Needs a look", "warn") : mute(`${n(Z.ai.reduce((a, m) => a + m.calls, 0))} calls`), ai)}
      ${admSection("feeds", feedSum, feeds)}
      ${admSection("users", mute(`${n(U.active)} active`), users)}
      ${admSection("custom", mute(`${n(C.topics.length)} active`), custom)}
      ${admSection("announce", annSum, announce)}
      ${admSection("feedback", fbNew ? badge(`${fbNew} new`, "warn") : mute(n(FB.total)), feedback)}
      ${admSection("tips", mute(`${n(T.stars)} ⭐`), tips)}
      ${admSection("errors", real24 ? badge(`${real24} in 24 h`, "warn") : mute("None new"), errors)}
      </div>`;
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

  // Step 17: Admin "Delete user" (owner only; the server refuses the owner's own account too)
  async function userDeleteAction(el) {
    const name = el.dataset.name || "this user";
    haptic("impact", "medium");
    if (!(await confirmBox(`Delete ${name} and all their data? Their settings, topics, history and feedback are removed. This cannot be undone.`))) return;
    S.busy.userDel = true;
    renderView();
    try {
      const r = await api("/api/admin/user-delete", { id: Number(el.dataset.value) });
      haptic("success");
      toast(r.message, "ok", 3000);
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
    if (S.deleted) return;
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
      case "lang": chooseLanguage(el); break;
      case "tip": payTip(Number(v)); break;
      case "add-topic": ev.preventDefault(); addTopic(); break;
      case "remove-topic": removeTopic(el); break;
      case "custom-switch": toggleCustom(el); break;
      case "edit-topics": S.editTopics = !S.editTopics; haptic("select"); renderMyTopics(); break;
      case "refund": refundAction(el); break;
      case "user-delete": userDeleteAction(el); break;
      case "delete-me": deleteAsk(); break;
      case "delete-yes": deleteMe(); break;
      case "delete-cancel": deleteCancel(); break;
      case "topic-admin": topicAdminAction(el); break;
      case "range": S.range = v; haptic("select"); renderView(); break;
      case "refresh": haptic("impact", "light"); loadAdmin(true); renderView(); break;
      case "all-errors": S.allErrors = true; renderView(); break;
      case "adm-sec":   // Step 18: a section opens or closes with a tap (all closed at first)
        S.admOpen = S.admOpen || {};
        S.admOpen[v] = !S.admOpen[v];
        haptic("select");
        renderView();
        break;
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
    app.innerHTML = `<div class="empty"><div class="empty-icon">${I.paper}</div><h1>${esc(title)}</h1><p class="lines">${lines(text)}</p>
      ${retry ? `<button class="btn" data-action="retry">${esc(tr("app.try_again"))}</button>` : ""}</div>`;
  }

  async function boot() {
    // Until the server says which language the user chose: Telegram's app language, if we have it.
    setLang(tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.language_code);
    if (!tg || !tg.initData) {
      fatal(tr("app.open_in_telegram_title"), tr("app.open_in_telegram"));
      return;
    }
    if (!app.querySelector(".loading")) app.innerHTML = LOADER;
    app.setAttribute("aria-busy", "true");
    app.querySelector(".loading").setAttribute("aria-label", tr("app.loading"));
    try {
      S.st = await api("/api/open", { tz: deviceTz });
    } catch (e) {
      if (e.status === 401) fatal(tr("app.reopen_title"), e.message, false);
      else fatal(tr("app.load_failed"), e.message, true);
      return;
    }
    S.server = copy(S.st);
    setLang(S.st.user.lang);
    if (S.st.setup) { S.page = "setup"; S.step = 1; S.setupTouched = false; S.st.user.topics = []; }   // Step 15: the first open; Step 18: topics start off
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
