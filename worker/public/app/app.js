// Axiom News Mini App: Settings for everyone, Admin for the owner. No framework.
// Every API call sends Telegram's initData; the Worker verifies it and takes the user id from it.
(() => {
  "use strict";
  const tg = window.Telegram && window.Telegram.WebApp;
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
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z"/></svg>',
    paper: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M5 4h11v15a1 1 0 0 0 1 1H6a1 1 0 0 1-1-1V4Z"/><path d="M16 9h3v10a1 1 0 0 1-2 0"/><path d="M8 8h5M8 12h5M8 16h3" stroke-linecap="round"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4"/></svg>',
    warn: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16Zm0 4a1 1 0 0 0-1 1v4a1 1 0 1 0 2 0V7a1 1 0 0 0-1-1Zm0 7.2a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z"/></svg>',
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

  function applyTheme() {
    if (tg && tg.colorScheme) document.documentElement.dataset.scheme = tg.colorScheme;
    if (!tg || !ver("6.1")) return;
    try { tg.setHeaderColor("secondary_bg_color"); } catch { /* old client */ }
    try { tg.setBackgroundColor("secondary_bg_color"); } catch { /* old client */ }
    try { if (ver("7.10")) tg.setBottomBarColor("secondary_bg_color"); } catch { /* old client */ }
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
    try { res = await fetch(path, opt); } catch { throw Object.assign(new Error("No connection. Check your internet and try again."), { status: 0 }); }
    let data = {};
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      throw Object.assign(new Error(data.error || data.message || "Something went wrong. Please try again."),
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
    if (d === 0) return "Today";
    if (d === 1) return "Tomorrow";
    return fmt(tz, { weekday: "long" }, "w").format(new Date(ts * 1000));
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
  const period = (t) => { const h = +t.slice(0, 2); return h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening"; };
  const periodEmoji = (t) => ({ Morning: "🌅", Afternoon: "☀️", Evening: "🌙" }[period(t)]);
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
        <button role="tab" data-action="tab" data-value="settings">Settings</button>
        <button role="tab" data-action="tab" data-value="admin">Admin</button>
      </div>` : ""}</header><main id="view" class="view"></main>`;
    syncTabs();
  }
  function syncTabs() {
    $("#title").textContent = S.tab === "admin" ? "Admin" : "Settings";
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
  function heroHTML() {
    const u = S.st.user;
    if (u.paused) {
      return `<div class="group hero paused" id="hero"><div class="hero-icon">${I.pause}</div><div>
        <div class="hero-label">Digests</div><div class="hero-value">Paused</div>
        <div class="hero-sub">Turn off Pause at the bottom to start again.</div></div></div>`;
    }
    const ts = u.next_digest_at;
    const value = ts ? `${dayName(ts, u.timezone)} at ${hm(ts, u.timezone)}` : "Not scheduled";
    return `<div class="group hero" id="hero"><div class="hero-icon">${I.clock}</div><div>
      <div class="hero-label">Next digest</div><div class="hero-value tnum">${esc(value)}</div>
      <div class="hero-sub">${esc(city(u.timezone))} time</div></div></div>`;
  }
  function updateHero() {
    const h = $("#hero");
    if (h) h.outerHTML = heroHTML();
  }

  // "09:00, 14:00 and 20:00"
  const listTimes = (t) => (t.length < 2 ? t.join("") : `${t.slice(0, -1).join(", ")} and ${t[t.length - 1]}`);
  function timesFoot() {
    const u = S.st.user, L = S.st.limits;
    const n = u.digest_times.length;
    return `${n === 1 ? "One digest a day" : `${n} digests a day`}, at ${listTimes(u.digest_times)}. ` +
      `Tap a time to add or remove it, up to ${L.max_times}.`;
  }

  function timesHTML() {
    const u = S.st.user;
    const all = allowedTimes(S.st.limits);
    const block = (label, list) => list.length ? `<div class="times-block"><div class="times-label">${periodEmoji(list[0])} ${label}</div>
      <div class="chips">${list.map((t) => `<button class="chip-btn tnum" data-action="time" data-value="${t}" aria-pressed="${u.digest_times.includes(t)}"
        aria-label="${t}">${t}</button>`).join("")}</div></div>` : "";
    return block("Morning", all.filter((t) => period(t) === "Morning"))
      + block("Afternoon", all.filter((t) => period(t) === "Afternoon"))
      + block("Evening", all.filter((t) => period(t) === "Evening"));
  }

  function tzSub(u) {
    const off = offset(u.timezone);
    return u.tz_source === "device" ? `From your phone${off ? ` · ${off}` : ""}` : `Default${off ? ` · ${off}` : ""}`;
  }

  function settingsHTML() {
    const { user: u, topics } = S.st;
    const topicRows = topics.map((t) => {
      const on = u.topics.includes(t.tag);
      return row({ icon: esc(t.emoji), title: esc(t.label), right: switchEl, tag: "button", cls: "tap",
        attrs: `role="switch" aria-checked="${on}" data-action="topic" data-value="${esc(t.tag)}"` });
    }).join("");

    const tzRow = row({ icon: I.globe, tile: true, title: `${esc(city(u.timezone))} time`, sub: esc(tzSub(u)), attrs: 'id="tz-row"' });

    const pauseRow = row({ icon: I.pause, tile: true, title: "Pause digests", right: switchEl, tag: "button", cls: "tap",
      attrs: `role="switch" aria-checked="${u.paused}" data-action="pause" id="pause-row"` });

    return `<section class="section">${heroHTML()}</section>
      ${section("Topics", topicRows, "Your digest covers the topics you turn on.")}
      ${section("Digest times", timesHTML(), `<span id="times-foot">${esc(timesFoot())}</span>`, 'id="times"')}
      ${section("Time zone", tzRow, "Digest times follow your phone's time zone. It updates each time you open this.")}
      ${section("", pauseRow, "While paused you get no digests. Your settings are kept.")}
      <p class="fine">Changes are saved as soon as you make them.</p>`;
  }

  // Saves go one after another, so a quick series of taps arrives in order.
  let chain = Promise.resolve();
  function save(patch, revert) {
    chain = chain.then(async () => {
      try {
        S.st = await api("/api/settings", patch);
        updateHero();
        toast("Saved");
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
      toast("Keep at least one topic", "err");
      return;
    }
    const before = [...u.topics];
    u.topics = on ? u.topics.filter((t) => t !== tag) : S.st.topics.map((t) => t.tag).filter((t) => t === tag || u.topics.includes(t));
    el.setAttribute("aria-checked", String(!on));
    haptic("select");
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
      toast("Keep at least one digest time", "err");
      return;
    }
    if (!on && u.digest_times.length >= L.max_times) {
      haptic("warning");
      shake(el);
      toast(`Up to ${L.max_times} times a day. Remove one first.`, "err", 2600);
      return;
    }
    const before = [...u.digest_times];
    u.digest_times = on ? u.digest_times.filter((x) => x !== t) : [...u.digest_times, t].sort();
    el.setAttribute("aria-pressed", String(!on));
    $("#times-foot").textContent = timesFoot();
    haptic("select");
    save({ digest_times: u.digest_times }, () => { S.st.user.digest_times = before; });
  }

  function togglePause(el) {
    const u = S.st.user;
    u.paused = !u.paused;
    el.setAttribute("aria-checked", String(u.paused));
    haptic("impact", "light");
    updateHero();
    save({ paused: u.paused }, () => { S.st.user.paused = !S.st.user.paused; });
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
    const status = `<div class="status ${lvl[1]}"><span class="dot"></span><div class="row-main"><div class="status-title">${lvl[0]}</div>
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
      sub: esc(`${city(x.timezone)} · ${x.times.join(", ")}`),
      right: `<span class="tnum" style="font-size:15px">${x.last_digest_at ? esc(ago(x.last_digest_at)) : "No digest yet"}</span>` })).join("");

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
      ${retry ? '<button class="btn" data-action="retry">Try again</button>' : ""}</div>`;
  }

  async function boot() {
    if (!tg || !tg.initData) {
      fatal("Open this in Telegram", "These settings open from the Axiom News bot. Send /settings to the bot and tap Open settings.");
      return;
    }
    app.innerHTML = '<div class="loading"><span class="spinner" aria-label="Loading"></span></div>';
    try {
      S.st = await api("/api/open", { tz: deviceTz });
    } catch (e) {
      if (e.status === 401) fatal("Please reopen", e.message, false);
      else fatal("Could not load your settings", e.message, true);
      return;
    }
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
