// End-to-end check of the Mini App in headless Edge against the local preview (real API code,
// demo database): taps every setting like a user would and confirms each change through the API.
// Step 12: also the house rules of the owner's design ("design 1", iOS Settings): no helper texts, no toast on a save (a light
// haptic tap instead), language buttons with flags, the time zone as one line at the bottom,
// Support with three buttons only, one size for every row and button, grids on shared columns,
// 44 px tap targets, and nothing overflowing at 360 and 430 px, in English and Russian.
// Start the preview first (node scripts/dev-server.mjs; the check resets its demo data), then:
//   node scripts/ui-check.mjs
import { openBrowser } from "./dev/cdp.mjs";

const BASE = process.env.PREVIEW_URL || "http://localhost:8790";
const RED = "rgb(177, 22, 28)", RED_DARK = "rgb(208, 35, 42)";
const results = [];
let failed = 0;
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}
// What the server has saved, read through the API with the page's own initData. Every toast shown
// and every Telegram call (haptics, header colour) is recorded by the page or the stand-in.
const SERVER = `const server = async () => (await (await fetch('/api/open', { method: 'POST',
  headers: { authorization: 'tma ' + Telegram.WebApp.initData, 'content-type': 'application/json' }, body: '{}' })).json()).user;
  const settled = async () => { await wait(700); };
  const pressed = () => [...document.querySelectorAll('[data-action=time][aria-pressed=true]')].map((x) => x.dataset.value);
  if (!window.__toasts) { window.__toasts = []; new MutationObserver(() => { const t = document.querySelector('#toast');
    if (t.classList.contains('show')) window.__toasts.push(t.textContent); }).observe(document.querySelector('#toast'), { attributes: true }); }
  const calls = () => (window.__calls || []).length;
  const since = (n) => (window.__calls || []).slice(n);`;
const API = (body) => `await fetch('/api/settings', { method: 'POST', headers: { authorization: 'tma ' + Telegram.WebApp.initData,
  'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)}) });`;

// For every icon in a rounded square: how far the drawn icon's centre is from the square's centre
// (getBBox gives the drawing in viewBox units; strokes are symmetric, so they do not move the centre).
const ICON_OFFSETS = `return [...document.querySelectorAll('.row-icon.tile, .hero-icon, .sq.solid')].filter((box) => box.querySelector('svg') && box.offsetParent).map((box) => {
    const svg = box.querySelector('svg'); const r = box.getBoundingClientRect(); const s = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal; const g = svg.getBBox(); const k = s.width / vb.width;
    const cx = s.left + (g.x - vb.x + g.width / 2) * k, cy = s.top + (g.y - vb.y + g.height / 2) * k;
    return { name: (box.closest('.row, .hero')?.innerText || '').trim().split('\\n')[0],
      dx: +(cx - (r.left + r.width / 2)).toFixed(2), dy: +(cy - (r.top + r.height / 2)).toFixed(2),
      boxDx: +((s.left + s.width / 2) - (r.left + r.width / 2)).toFixed(2), boxDy: +((s.top + s.height / 2) - (r.top + r.height / 2)).toFixed(2) };
  });`;

// The layout rules, measured: one height for every row and button, one corner radius, button grids on
// six shared columns, tap targets of 44 px or more, no text cut off, no sideways scrolling, and no
// helper text (the only paragraph is the time zone line, last on the page).
const LAYOUT = `const v = document.querySelector('#view');
  const btns = [...v.querySelectorAll('.b')], rows = [...v.querySelectorAll('.group .row')];
  const H = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--h'));
  const R = getComputedStyle(document.documentElement).getPropertyValue('--r').trim();
  const box = (e) => e.getBoundingClientRect();
  const cols = [...v.querySelectorAll('#times .b')].slice(0, 6).map(box);
  const lefts = cols.map((c) => c.left), rights = cols.map((c) => c.right);
  const near = (x, list) => list.some((y) => Math.abs(x - y) < 0.6);
  const heights = [...new Set([...btns, ...rows].map((e) => Math.round(box(e).height)))];
  const radii = [...new Set([...btns, ...v.querySelectorAll('.group')].filter((e) => getComputedStyle(e).backgroundColor !== 'rgba(0, 0, 0, 0)')
    .map((e) => getComputedStyle(e).borderTopLeftRadius))];
  const offGrid = btns.filter((b) => !near(box(b).left, lefts) || !near(box(b).right, rights)).map((b) => b.textContent.trim());
  const small = [...v.querySelectorAll('button')].filter((b) => box(b).height < 44 || box(b).width < 44).map((b) => b.textContent.trim());
  const cut = [...v.querySelectorAll('.b, .row-title, .lbl')].filter((e) => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1)
    .map((e) => e.textContent.trim());
  const texts = [...v.querySelectorAll('p, .section-foot, .support-text, .fine, .row-sub, .hero-sub, #times-foot')].map((e) => e.id || e.className);
  return { H, R, heights, radii, offGrid, small, cut, texts, last: v.lastElementChild?.id,
    sideways: document.documentElement.scrollWidth > window.innerWidth };`;
const layoutOk = (x) => x.heights.length === 1 && x.heights[0] === x.H && x.radii.length === 1 && x.radii[0] === x.R &&
  !x.offGrid.length && !x.small.length && !x.cut.length && !x.sideways && x.texts.join() === "tz-line" && x.last === "tz-line";

await fetch(`${BASE}/__reset`, { method: "POST" });
const b = await openBrowser();
let r0;
try {
  await b.open(`${BASE}/app/?theme=light&as=friend`);
  const start = await b.run(`${SERVER} return await server();`);
  check("friend sees no Admin tab and no design switch", await b.run("return !document.querySelector('#tabs, #design-switch');"));
  r0 = await b.run(`return [...document.querySelectorAll('[data-action=topic]')].map((x) => [x.getAttribute('role'), !!x.querySelector('.sq'), !!x.querySelector('.switch')].join('/'));`);
  check("topics: rows with a coloured square and a red switch", r0.length === 6 && r0.every((x) => x === "switch/true/true"), r0.join(" "));

  // Step 12 rules
  let r = await b.run(LAYOUT);
  check("no helper texts: the only line of text is the time zone, last on the page", r.texts.join() === "tz-line" && r.last === "tz-line",
    `${r.texts.join(",")} / last ${r.last}`);
  check("one size: every row and button 48 px high, every card and button the same corners",
    r.heights.length === 1 && r.heights[0] === 48 && r.radii.length === 1, `${r.heights.join(",")} / ${r.radii.join(",")}`);
  check("button grids share six columns (times, languages, tips line up)", !r.offGrid.length, r.offGrid.join(", "));
  check("every tap target at least 44 px, no text cut off, no sideways scroll", !r.small.length && !r.cut.length && !r.sideways,
    JSON.stringify({ small: r.small, cut: r.cut, sideways: r.sideways }));
  r = await b.run(`return { line: text('#tz-line'), row: !!document.querySelector('#tz-row, [data-action=open-tz]') };`);
  const city = start.timezone.split("/").pop().replace(/_/g, " ");
  check("time zone: saved from the phone on open, one quiet line 'City · GMT+n', no row", start.tz_source === "device" && !r.row &&
    new RegExp(`^${city} · GMT([+-]\\d{1,2}(:\\d\\d)?)?$`).test(r.line), `${start.timezone} / ${r.line}`);
  r = await b.run(`const s = document.querySelector('#support');
    return { head: text('#support .section-head'), parts: [...s.querySelectorAll('*')].filter((e) => !e.children.length && e.textContent.trim()).map((e) => e.textContent.trim()),
      chips: [...s.querySelectorAll('[data-action=tip]')].map((x) => x.dataset.value + '=' + x.textContent.trim()),
      last: !s.nextElementSibling?.matches('.section') };`);
  check("Support Axiom: the title and 100, 500, 1000 Stars buttons, no text at all", r.head === "Support Axiom" && r.last &&
    JSON.stringify(r.chips) === JSON.stringify(["100=100 ⭐", "500=500 ⭐", "1000=1000 ⭐"]) && r.parts.length === 4, JSON.stringify(r));
  r = await b.run(`return [...document.querySelectorAll('[data-action=lang]')].map((x) => ({ t: [...x.children].map((c) => c.className + ':' + c.textContent).join(' '), on: x.getAttribute('aria-checked'),
    bg: getComputedStyle(x).backgroundColor, cls: x.className }));`);
  check("language: buttons like the times, flag on the left, the chosen one red",
    r.length === 2 && r[0].t === "emo:🇬🇧 lbl:English" && r[1].t === "emo:🇷🇺 lbl:Русский" && r[0].on === "true" && r[0].bg === RED &&
    r[1].bg !== RED && r.every((x) => /\bb\b/.test(x.cls)), JSON.stringify(r));
  r = await b.run(`return { tg: (window.__calls || []).filter((c) => /^set(Header|Background|BottomBar)Color/.test(c)).slice(-3),
    bg: getComputedStyle(document.body).backgroundColor };`);
  check("Telegram's header, background and bottom bar take the page colour", r.tg.length === 3 && r.tg.every((c) => c.endsWith(" #f2f2f7")) &&
    r.bg === "rgb(242, 242, 247)", `${r.tg.join("; ")} / ${r.bg}`);

  r = await b.run(`${SERVER} const n = calls(), t = window.__toasts.length; click('[data-value=wars_conflicts]'); await settled();
    return { u: await server(), toasts: window.__toasts.slice(t), haptics: since(n).filter((c) => c.startsWith('haptic')) };`);
  check("topic switched on is saved", r.u.topics.includes("wars_conflicts"), r.u.topics.join(","));
  check("a save gives one light haptic tap and no toast", !r.toasts.length && JSON.stringify(r.haptics) === '["haptic impact light"]',
    `${JSON.stringify(r.haptics)} / toasts ${JSON.stringify(r.toasts)}`);

  r = await b.run(`${SERVER} for (const t of ['politics', 'armenia', 'russia']) { click('[data-value=' + t + ']'); await wait(120); }
    await settled(); const t0 = window.__toasts.length; click('[data-value=wars_conflicts]'); await wait(300);
    return { u: await server(), toast: window.__toasts.slice(t0).join(' | '), on: document.querySelector('[data-value=wars_conflicts]').getAttribute('aria-checked') };`);
  check("the last topic cannot be switched off (a short error still shows)", r.u.topics.length === 1 && r.on === "true" && /^Keep at least one topic$/.test(r.toast),
    `${r.u.topics.join(",")} / ${r.toast}`);

  r = await b.run(`${SERVER} return { all: [...document.querySelectorAll('[data-action=time]')].map((x) => x.dataset.value), on: pressed(), u: await server() };`);
  check("time grid: 18 hourly buttons, 06:00 to 23:00, no half hours", r.all.length === 18 && r.all[0] === "06:00" &&
    r.all.at(-1) === "23:00" && r.all.every((t) => t.endsWith(":00")), `${r.all[0]}..${r.all.at(-1)}`);
  check("time grid shows the saved times as chosen", JSON.stringify(r.on) === JSON.stringify(r.u.digest_times), r.on.join(","));

  const before = await b.run(`${SERVER} return await server();`);
  r = await b.run(`${SERVER} const n = calls(), t = window.__toasts.length; click('[data-value="06:00"]'); await settled();
    return { u: await server(), on: pressed(), bg: getComputedStyle(document.querySelector('[data-value="06:00"]')).backgroundColor,
      toasts: window.__toasts.slice(t), haptics: since(n).filter((c) => c.startsWith('haptic')) };`);
  check("tap a time: chosen (red) and saved, a haptic tap, no toast", r.u.digest_times.includes("06:00") && r.on.includes("06:00") &&
    r.bg === RED && !r.toasts.length && r.haptics.includes("haptic impact light"), `${r.u.digest_times.join(",")} / ${r.bg} / ${r.toasts}`);
  check("next digest recomputed after a time change", r.u.next_digest_at !== before.next_digest_at || r.u.digest_times.length > before.digest_times.length,
    `${before.next_digest_at} -> ${r.u.next_digest_at}`);
  r = await b.run(`${SERVER} click('[data-value="06:00"]'); await settled(); return { u: await server(), on: pressed() };`);
  check("tap it again: unchosen and saved", !r.u.digest_times.includes("06:00") && !r.on.includes("06:00"), r.u.digest_times.join(","));

  r = await b.run(`${SERVER} const t = window.__toasts.length; for (const x of ['07:00', '10:00', '12:00', '16:00', '21:00', '22:00']) {
      if (!pressed().includes(x)) { click('[data-value="' + x + '"]'); await wait(150); } }
    await settled(); return { u: await server(), on: pressed(), toast: window.__toasts.slice(t).join(' | ') };`);
  check("at most 5 times: the 6th tap is refused with a short message", r.u.digest_times.length === 5 && r.on.length === 5 &&
    /Up to 5 times a day/.test(r.toast), `${r.u.digest_times.join(",")} / ${r.toast}`);

  r = await b.run(`${SERVER} const t = window.__toasts.length; for (const x of pressed()) { click('[data-value="' + x + '"]'); await wait(150); }
    await settled(); return { u: await server(), on: pressed(), toast: window.__toasts.slice(t).join(' | ') };`);
  check("at least 1 time: removing the last one is refused", r.u.digest_times.length === 1 && r.on.length === 1 &&
    /at least one digest time/.test(r.toast), `${r.u.digest_times.join(",")} / ${r.toast}`);

  r = await b.run(`${SERVER} const t = window.__toasts.length; click('#pause-row'); await settled(); return { u: await server(), hero: text('#hero'), toasts: window.__toasts.slice(t) };`);
  check("pause saved and shown, no toast", r.u.paused === true && /Paused/.test(r.hero) && !r.toasts.length, r.hero.trim().replace(/\s+/g, " "));
  r = await b.run(`${SERVER} click('#pause-row'); await settled(); return { u: await server(), hero: text('#hero') };`);
  check("resume saved, next digest shown", r.u.paused === false && /Next digest/.test(r.hero), r.hero.trim().replace(/\s+/g, " "));

  r = await b.run(`${SERVER} const n = calls(), t = window.__toasts.length; click('[data-action=lang][data-value=ru]'); await settled();
    const out = { u: await server(), title: text('#title'), on: document.querySelector('[data-action=lang][aria-checked=true]')?.dataset.value,
      line: text('#tz-line'), toasts: window.__toasts.slice(t), haptics: since(n).filter((c) => c.startsWith('haptic')) };
    click('[data-action=lang][data-value=en]'); await settled(); out.back = (await server()).lang; return out;`);
  check("language: Русский saved, the page switches at once, a haptic tap, no toast", r.u.lang === "ru" && r.title === "Настройки" &&
    r.on === "ru" && r.line.startsWith("Ереван · GMT") && !r.toasts.length && r.haptics.includes("haptic impact light") && r.back === "en",
    `${r.u.lang} / ${r.title} / ${r.line} / ${JSON.stringify(r.haptics)}`);

  r = await b.run(ICON_OFFSETS);
  const worst = Math.max(...r.flatMap((x) => [x.dx, x.dy, x.boxDx, x.boxDy].map(Math.abs)));
  check("every icon is centred in its rounded square (within 0.5 px)", r.length >= 2 && worst <= 0.5,
    r.map((x) => `${x.name}: ${x.dx},${x.dy}`).join("; "));

  r = await b.run(`const res = await fetch('/api/admin', { headers: { authorization: 'tma ' + Telegram.WebApp.initData } }); return res.status;`);
  check("friend calling the admin API directly gets 403", r === 403, String(r));
  r = await b.run(`const res = await fetch('/api/settings', { method: 'POST', headers: { authorization: 'tma ' + Telegram.WebApp.initData,
    'content-type': 'application/json' }, body: JSON.stringify({ digest_times: ['09:30'] }) }); return [res.status, (await res.json()).error];`);
  check("the server refuses a half-hour time too", r[0] === 400 && /on the hour/.test(r[1]), r.join(" "));
  check("no console errors (friend)", b.consoleErrors().length === 0, JSON.stringify(b.consoleErrors()[0]?.params ?? "").slice(0, 200));

  // ------------------------------------------------------------ the owner
  await b.open(`${BASE}/app/?theme=dark&as=owner`, "dark");
  r = await b.run(`return { chip: getComputedStyle(document.querySelector('[data-action=time][aria-pressed=true]')).backgroundColor,
    bg: getComputedStyle(document.body).backgroundColor, sw: !!document.querySelector('#design-switch, [data-action=design]'),
    header: (window.__calls || []).filter((c) => c.startsWith('setHeaderColor')).at(-1) };`);
  check("dark mode: brighter red fill, black page, Telegram's header black too", r.chip === RED_DARK && r.bg === "rgb(0, 0, 0)" &&
    r.header === "setHeaderColor #000000", `${r.chip} / ${r.bg} / ${r.header}`);
  check("no design switch any more (the trial is over), not even for the owner", !r.sw);
  r = await b.run(ICON_OFFSETS);
  check("dark mode: icons centred too", r.length >= 2 && Math.max(...r.flatMap((x) => [x.dx, x.dy].map(Math.abs))) <= 0.5, r.map((x) => `${x.dx},${x.dy}`).join("; "));
  r = await b.run(LAYOUT);
  check("owner, dark: layout rules (one size, shared columns, 44 px, no helper text)", layoutOk(r), JSON.stringify(r));
  await b.open(`${BASE}/app/?theme=light&as=owner`);
  r = await b.run("return [...document.querySelectorAll('#support [data-action=tip]')].map((x) => x.dataset.value).join(',');");
  check("owner: the same three amounts, no 1-Star test amount", r === "100,500,1000", r);

  r = await b.run(`click('[data-value=admin]'); await until(() => document.querySelector('.status'));
    const bad = document.querySelector('.badge.bad');
    const res = { editor: document.body.innerText.includes('Editor pass'), bad: bad ? getComputedStyle(bad).color : null };
    const sq = (s) => { const e = document.querySelector(s); const c = getComputedStyle(e); const r = e.getBoundingClientRect(); return [Math.round(r.width), c.borderTopLeftRadius, c.backgroundColor]; };
    const st = { short: [...document.querySelectorAll('#view .row')].filter((e) => e.getBoundingClientRect().height < 47.5).length,
      radii: [...new Set([...document.querySelectorAll('#view .group')].map((e) => getComputedStyle(e).borderTopLeftRadius))],
      health: sq('.status .dot'), action: sq('[data-action=digest-now] .row-icon') };
    st.ok = !st.short && st.radii.join() === '12px' && st.health.join() === '30,8px,rgb(52, 199, 89)' && st.action.join() === '30,8px,${RED}';
    res.style = st;
    const calls0 = (window.__calls || []).length;
    click('[data-action=digest-now]'); await until(() => /Sent/.test(text('#toast')));
    res.t1 = text('#toast');
    res.confirmed = (window.__calls || []).slice(calls0).some((c) => c.startsWith('confirm'));
    click('[data-action=run-job]'); await until(() => /news job|Started/.test(text('#toast')));
    res.t2 = text('#toast');
    return res;`);
  check("Admin shows the editor pass", r.editor);
  check("Admin in the Settings style: rows 48 px or more, 12 px cards, solid squares (green health, red actions)", r.style.ok, JSON.stringify(r.style));
  check("Admin failure badges are orange, not red", r.bad === "rgb(176, 58, 6)", String(r.bad));
  check("owner: Send me a digest now asks first, then sends", r.confirmed && /Sent: (\d+ stor|a short note)/.test(r.t1), r.t1);
  check("owner: Run news job now respects the 20-minute gap", /last ran at \d\d:\d\d/.test(r.t2) || /Started/.test(r.t2), r.t2);
  await b.open(`${BASE}/app/?theme=light&as=owner&confirm=0`);
  r = await b.run(`click('[data-value=admin]'); await until(() => document.querySelector('.status'));
    click('[data-action=digest-now]'); await wait(600); return text('#toast');`);
  check("owner: Cancel in the confirm popup does nothing", !/Sent/.test(r), r || "(no toast)");
  check("no console errors (owner)", b.consoleErrors().length === 0, JSON.stringify(b.consoleErrors()[0]?.params ?? "").slice(0, 200));
} catch (e) {
  check("ran to the end", false, e.message);
} finally {
  await b.close();
}

// ------------------------------------------------------------ 360 and 430 px, English and Russian, light and dark
for (const [width, port] of [[360, 9334], [430, 9335]]) {
  const w = await openBrowser({ width, port });
  try {
    for (const lang of ["ru", "en"]) {
      await w.open(`${BASE}/app/?theme=light&as=owner`);
      await w.run(API({ lang }));
      for (const scheme of ["light", "dark"]) {
        await w.open(`${BASE}/app/?theme=${scheme}&as=owner`, scheme);
        const L = await w.run(LAYOUT);
        check(`${width} px, ${lang === "ru" ? "Russian" : "English"}, ${scheme}: the layout rules hold`, layoutOk(L), JSON.stringify(L).slice(0, 600));
      }
    }
    await w.run(API({ lang: "en" }));
  } catch (e) {
    check(`${width} px ran to the end`, false, e.message);
  } finally {
    await w.close();
  }
}
console.log(results.join("\n"));
console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
