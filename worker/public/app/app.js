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
    allErrors: false, busy: {} };
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
    const owner = S.st.is_owner;
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
    $("#title").textContent = S.tab === "admin" ? "Admin" : tr("app.title");
    const tabs = $("#tabs");
    if (!tabs) return;
    tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.value === S.tab)));
    tabs.querySelector(".seg-thumb").style.transform = S.tab === "admin" ? "translateX(100%)" : "none";
  }
  function renderView(animate = false) {
    const v = $("#view");
    if (!v) return;
    v.innerHTML = S.tab === "admin" ? adminHTML() : settingsHTML();
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
  const TINT = { politics: "0, 122, 255", wars_conflicts: "142, 142, 147", armenia: "255, 149, 0", russia: "88, 86, 214",
    iran_war: "52, 199, 89", ukraine_war: "255, 204, 0" };
  const tint = (tag) => `--tint: rgba(${TINT[tag] || "142, 142, 147"}, 0.18)`;

  function topicsHTML() {
    const { user: u, topics } = S.st;
    const on = (t) => u.topics.includes(t.tag);
    const attrs = (t) => `role="switch" aria-checked="${on(t)}" data-action="topic" data-value="${esc(t.tag)}"`;
    return card(topics.map((t) => `<button class="row has-icon tap" ${attrs(t)}><span class="sq" style="${tint(t.tag)}" aria-hidden="true">${esc(t.emoji)}</span>` +
      `<span class="row-main row-title">${esc(t.label)}</span>${switchEl}</button>`).join(""));
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
      ${sec(tr("app.sec_times"), timesHTML(), 'id="times"')}
      ${languagesHTML()}
      ${pauseHTML()}
      ${supportHTML()}
      <p class="tzline tnum" id="tz-line">${esc(zoneLine(S.st.user))}</p>`;
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
    if (on && u.topics.length === 1) {
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
      return row({ title: `<span class="ellipsis">${esc(m.model || m.provider)}</span>`, sub: `${esc(PROVIDER[m.provider] || m.provider)} · ${m.kind === "editor" ? "editor" : "first pass"} · ${compact(x.input_tokens)} in, ${compact(x.output_tokens)} out`,
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
      ${feeds}
      ${section("Users", tiles + userRows)}
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

  // ---------------------------------------------------------------- events
  document.addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-action]");
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
      case "refund": refundAction(el); break;
      case "range": S.range = v; haptic("select"); renderView(); break;
      case "refresh": haptic("impact", "light"); loadAdmin(true); renderView(); break;
      case "all-errors": S.allErrors = true; renderView(); break;
      case "digest-now": adminAction("digest"); break;
      case "run-job": adminAction("run"); break;
      case "retry": boot(); break;
      default: break;
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
