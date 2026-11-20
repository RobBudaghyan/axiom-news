// End-to-end check of the Mini App in headless Edge against the local preview (real API code,
// demo database): taps every setting like a user would and confirms each change through the API.
// Step 12: also the house rules of the owner's design ("design 1", iOS Settings): no helper texts, no toast on a save (a light
// haptic tap instead), language buttons with flags, the time zone as one line at the bottom,
// Support with three buttons only, one size for every row and button, grids on shared columns,
// 44 px tap targets, and nothing overflowing at 360 and 430 px, in English and Russian.
// Step 13 fixes: the switch on each custom row, its own emoji and tint, Edit/Done with a red minus.
// Step 13: "My topics" (add with Enter or Add, checking, added, joined, rejected, main topic,
// delayed by the AI guard, remove, the limit of 3, a long name cut with "...") and the same layout
// rules on the new card at 360, 390 and 430 px, English and Russian, light and dark.
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
// Step 13: "My topics" helpers inside the page
const MY = `const addT = (name, how = 'enter') => { const i = document.querySelector('#topic-input'); i.value = name;
    i.dispatchEvent(new Event('input', { bubbles: true })); if (how === 'enter') i.form.requestSubmit(); else click('[data-action=add-topic]'); };
  const done = async () => { await wait(60); await until(() => !document.querySelector('#my-topics .add-spin'), 6000); await wait(200); };
  const mine = () => [...document.querySelectorAll('#my-topics .ct .row-title')].map((e) => e.textContent);
  const ct = (name) => [...document.querySelectorAll('#my-topics .ct')].find((e) => e.querySelector('.row-title').textContent === name);
  const serverOn = async () => (await (await fetch('/api/open', { method: 'POST', headers: { authorization: 'tma ' + Telegram.WebApp.initData,
    'content-type': 'application/json' }, body: '{}' })).json()).custom.map((c) => c.name + ':' + (c.on ? 'on' : 'off'));
  const serverMine = async () => (await (await fetch('/api/open', { method: 'POST', headers: { authorization: 'tma ' + Telegram.WebApp.initData,
    'content-type': 'application/json' }, body: '{}' })).json()).custom.map((c) => c.name);`;
const ADD = (name) => `await fetch('/api/topics/add', { method: 'POST', headers: { authorization: 'tma ' + Telegram.WebApp.initData,
  'content-type': 'application/json' }, body: JSON.stringify({ name: ${JSON.stringify(name)} }) });`;
const SWITCH = (name, on) => `{ const h = { authorization: 'tma ' + Telegram.WebApp.initData, 'content-type': 'application/json' };
  const st = await (await fetch('/api/open', { method: 'POST', headers: h, body: '{}' })).json();
  const id = st.custom.find((c) => c.name === ${JSON.stringify(name)}).id;
  await fetch('/api/topics/switch', { method: 'POST', headers: h, body: JSON.stringify({ id, on: ${on} }) }); }`;
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
  const small = [...v.querySelectorAll('button')].filter((b) => b.offsetParent)   // a hidden button is no tap target (Step 13: Add while empty)
    .filter((b) => box(b).height < 44 || box(b).width < 44).map((b) => b.textContent.trim());
  const cut = [...v.querySelectorAll('.b, .row-title, .lbl')].filter((e) => !e.closest('.ct'))   // a custom topic's long name ends in "..." on purpose
    .filter((e) => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1).map((e) => e.textContent.trim());
  const texts = [...v.querySelectorAll('p, .section-foot, .support-text, .fine, .row-sub, .hero-sub, #times-foot')].map((e) => e.id || e.className);
  return { H, R, heights, radii, offGrid, small, cut, texts, last: v.lastElementChild?.id,
    sideways: document.documentElement.scrollWidth > window.innerWidth };`;
const layoutOk = (x) => x.heights.length === 1 && x.heights[0] === x.H && x.radii.length === 1 && x.radii[0] === x.R &&
  !x.offGrid.length && !x.small.length && !x.cut.length && !x.sideways &&
  x.texts.filter((t) => t !== "topic-hint").join() === "tz-line" && x.last === "tz-line";   // Step 16: the hint is the owner's one exception

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
  check("no helper texts: only the hint under Add a topic and the time zone line (last on the page)",
    r.texts.join() === "topic-hint,tz-line" && r.last === "tz-line",
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
      last: s.nextElementSibling?.id === 'more' && s.nextElementSibling.nextElementSibling?.id === 'tz-line' };`);
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

  r = await b.run(`${SERVER} const n = calls(), t = window.__toasts.length; click('[data-value=economy_markets]'); await settled();
    return { u: await server(), toasts: window.__toasts.slice(t), haptics: since(n).filter((c) => c.startsWith('haptic')) };`);
  check("topic switched on is saved", r.u.topics.includes("economy_markets"), r.u.topics.join(","));
  check("a save gives one light haptic tap and no toast", !r.toasts.length && JSON.stringify(r.haptics) === '["haptic impact light"]',
    `${JSON.stringify(r.haptics)} / toasts ${JSON.stringify(r.toasts)}`);

  r = await b.run(`${SERVER} for (const t of ['politics_conflicts', 'armenia', 'russia']) { click('[data-value=' + t + ']'); await wait(120); }
    await settled(); const t0 = window.__toasts.length; click('[data-value=economy_markets]'); await wait(300);
    return { u: await server(), toast: window.__toasts.slice(t0).join(' | '), on: document.querySelector('[data-value=economy_markets]').getAttribute('aria-checked'),
      hero: text('#hero').trim().replace(/\\s+/g, ' ') };`);
  check("Step 16: the last topic can be switched off too (no error); the card says 😴 All topics are off",
    r.u.topics.length === 0 && r.on === "false" && !r.toast && /😴\s*All topics are off\s*Switch one on to get digests\./.test(r.hero), `${r.u.topics.join(",")} / ${r.toast} / ${r.hero}`);
  r = await b.run(`${SERVER} click('[data-value=economy_markets]'); await settled(); return { u: await server(), hero: text('#hero') };`);
  check("Step 16: switching one back on shows the next digest again", r.u.topics.join() === "economy_markets" && /Next digest/.test(r.hero),
    r.hero.trim().replace(/\s+/g, " "));

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
    /Keep at least one time/.test(r.toast), `${r.u.digest_times.join(",")} / ${r.toast}`);

  r = await b.run(`return { row: !!document.querySelector('#pause-row, [data-action=pause]'), text: /Pause/i.test(document.querySelector('#view').innerText) };`);
  check("Step 16: no Pause row and no Pause text anywhere in Settings", !r.row && !r.text, JSON.stringify(r));

  r = await b.run(`${SERVER} const n = calls(), t = window.__toasts.length; click('[data-action=lang][data-value=ru]'); await settled();
    const out = { u: await server(), title: text('#title'), on: document.querySelector('[data-action=lang][aria-checked=true]')?.dataset.value,
      line: text('#tz-line'), toasts: window.__toasts.slice(t), haptics: since(n).filter((c) => c.startsWith('haptic')) };
    click('[data-action=lang][data-value=en]'); await settled(); out.back = (await server()).lang; return out;`);
  check("language: Русский saved, the page switches at once, a haptic tap, no toast", r.u.lang === "ru" && r.title === "Настройки" &&
    r.on === "ru" && r.line.startsWith("Ереван · GMT") && !r.toasts.length && r.haptics.includes("haptic impact light") && r.back === "en",
    `${r.u.lang} / ${r.title} / ${r.line} / ${JSON.stringify(r.haptics)}`);

  // ------------------------------------------------------------ Step 13: My topics (friend, English, light)
  r = await b.run(`${SERVER} ${MY} const sec = document.querySelector('#my-topics'); const add = sec.querySelector('.add-row');
    const sq = getComputedStyle(add.querySelector('.sq')); const i = add.querySelector('input');
    return { after: document.querySelector('#topics').nextElementSibling?.id, head: text('#my-topics .section-head'), rows: mine(),
      edit: !!document.querySelector('#my-topics [data-action=edit-topics]'), phColor: getComputedStyle(i, '::placeholder').color,
      sq: sq.backgroundColor, plus: !!add.querySelector('.sq svg'), ph: i.placeholder, font: getComputedStyle(i).fontSize,
      go: getComputedStyle(add.querySelector('.add-go')).display, h: Math.round(add.getBoundingClientRect().height) };`);
  check("My topics: a card right under Topics, the add row with a red + and 'Add a topic' (17 px), Add hidden while empty, no Edit while empty",
    r.after === "my-topics" && r.head === "My topics" && !r.rows.length && r.sq === RED && r.plus && r.ph === "Add a topic" &&
    r.font === "17px" && r.go === "none" && r.h === 48 && !r.edit, JSON.stringify(r));
  r = await b.run(`click('#my-topics .add-row .sq'); await wait(80); return document.activeElement?.id;`);
  check("My topics: the whole add row is tappable (a tap on the + opens the field)", r === "topic-input", String(r));
  r = await b.run(`const h = document.querySelector('#my-topics #topic-hint'); const card = document.querySelector('#my-topics .group');
    return { text: h && h.textContent, after: h && h.previousElementSibling === card, font: h && getComputedStyle(h).fontSize,
      n: document.querySelectorAll('#topic-hint').length };`);
  check("Step 16: one small hint line under Add a topic: 'e.g. Formula 1, Japan, AI' (13 px)",
    r.text === "e.g. Formula 1, Japan, AI" && r.after && r.font === "13px" && r.n === 1, JSON.stringify(r));
  await b.run("document.activeElement.blur();");
  r = await b.run(`${MY} const i = document.querySelector('#topic-input'); i.value = 'Col'; i.dispatchEvent(new Event('input', { bubbles: true }));
    const shown = getComputedStyle(document.querySelector('.add-go')).display, word = text('.add-go');
    i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return { shown, word, hidden: getComputedStyle(document.querySelector('.add-go')).display };`);
  check("My topics: a red Add appears once something is typed", r.shown === "block" && r.word === "Add" && r.hidden === "none", JSON.stringify(r));
  r = await b.run(`${SERVER} ${MY} const n = calls(), t = window.__toasts.length; addT('Colombia'); await wait(120);
    const checking = { spin: !!document.querySelector('#my-topics .add-spin .spinner'), locked: document.querySelector('#topic-input').disabled,
      go: !!document.querySelector('.add-go') };
    await done(); return { checking, rows: mine(), server: await serverMine(), input: document.querySelector('#topic-input').value,
      toasts: window.__toasts.slice(t), haptics: since(n).filter((c) => c.startsWith('haptic')), slid: !!document.querySelector('.ct.new'),
      landing: ct('Colombia').getAttribute('aria-checked'), on: (await wait(350), ct('Colombia').getAttribute('aria-checked')) };`);
  check("My topics: while the AI checks, a spinner stands where Add was and the field is locked", r.checking.spin && r.checking.locked && !r.checking.go,
    JSON.stringify(r.checking));
  check("My topics: Enter adds it: the row slides in and its switch turns on, the field clears, one light haptic tap, no toast",
    JSON.stringify(r.rows) === '["Colombia"]' && JSON.stringify(r.server) === '["Colombia"]' && r.input === "" && !r.toasts.length &&
    JSON.stringify(r.haptics) === '["haptic impact light"]' && r.slid && r.on === "true", JSON.stringify(r));
  r = await b.run(`${MY} const row = ct('Colombia'), main = document.querySelector('[data-action=topic][data-value=armenia]');
    const look = (e) => { const q = e.querySelector('.sq'), sw = e.querySelector('.switch'); const a = q.getBoundingClientRect(), h = e.getBoundingClientRect();
      return { tag: e.tagName, role: e.getAttribute('role'), sq: [Math.round(a.width), Math.round(a.height), getComputedStyle(q).borderTopLeftRadius],
        h: Math.round(h.height), sw: sw ? getComputedStyle(sw).backgroundColor : null, title: getComputedStyle(e.querySelector('.row-title')).fontSize }; };
    return { emoji: row.querySelector('.sq').textContent, tint: getComputedStyle(row.querySelector('.sq')).backgroundColor, row: look(row), main: look(main),
      pins: document.querySelectorAll('#my-topics .sq').length && [...document.querySelectorAll('#my-topics .sq')].some((q) => q.textContent.includes('\u{1F4CC}')),
      x: !!document.querySelector('#my-topics .xbtn, #my-topics .minus'), edit: text('#my-topics [data-action=edit-topics]') };`);
  check("My topics: a custom row is a main-topic row: its own emoji 🇨🇴 (never 📌) in a tinted square, the name, a red switch; no x; Edit at the title's right",
    r.emoji === "🇨🇴" && r.tint === "rgba(255, 204, 0, 0.18)" && JSON.stringify({ ...r.row, sw: 0 }) === JSON.stringify({ ...r.main, sw: 0 }) && r.row.sw === RED &&
    !r.pins && !r.x && r.edit === "Edit", JSON.stringify(r));
  r = await b.run(`${SERVER} ${MY} const n = calls(), t = window.__toasts.length; ct('Colombia').click(); await settled();
    const off = { ui: ct('Colombia').getAttribute('aria-checked'), sw: getComputedStyle(ct('Colombia').querySelector('.switch')).backgroundColor,
      server: await serverOn(), rows: mine(), toasts: window.__toasts.slice(t), haptics: since(n).filter((c) => c.startsWith('haptic')) };
    ct('Colombia').click(); await settled(); return { off, back: await serverOn() };`);
  check("My topics: the switch turns it off (saved, still in the list, a light tap, no toast) and on again",
    r.off.ui === "false" && r.off.sw !== RED && JSON.stringify(r.off.server) === '["Colombia:off"]' && JSON.stringify(r.off.rows) === '["Colombia"]' &&
    !r.off.toasts.length && JSON.stringify(r.off.haptics) === '["haptic impact light"]' && JSON.stringify(r.back) === '["Colombia:on"]', JSON.stringify(r));
  r = await b.run(`${SERVER} ${MY} const t = window.__toasts.length; addT('F1', 'button'); await done();
    return { rows: mine(), server: await serverMine(), toasts: window.__toasts.slice(t) };`);
  check("My topics: the Add word works too; 'F1' joins the shared topic Formula 1 that someone else made, with no message (it just slides in)",
    JSON.stringify(r.rows) === '["Colombia","Formula 1"]' && JSON.stringify(r.server) === '["Colombia","Formula 1"]' &&
    !r.toasts.length, JSON.stringify(r));
  r = await b.run(`${SERVER} ${MY} const n = calls(), t = window.__toasts.length; addT('asdfgh'); await done();
    return { rows: mine(), toasts: window.__toasts.slice(t), input: document.querySelector('#topic-input').value,
      haptics: since(n).filter((c) => c.startsWith('haptic')) };`);
  check("My topics: nonsense is rejected with a short reason, an error haptic, the text stays to edit",
    r.rows.length === 2 && JSON.stringify(r.toasts) === '["This does not look like a news topic."]' && r.input === "asdfgh" &&
    r.haptics.includes("haptic error"), JSON.stringify(r));
  r = await b.run(`${SERVER} ${MY} const t = window.__toasts.length; addT('Armenian news'); await done();
    return { rows: mine(), toasts: window.__toasts.slice(t) };`);
  check("My topics: a main topic is refused with its name", r.rows.length === 2 &&
    JSON.stringify(r.toasts) === '["Armenia is a main topic. Switch it on above."]', JSON.stringify(r));
  r = await b.run(`${SERVER} ${MY} ct('Formula 1').click(); await settled(); addT('AI regulation'); await done();
    return { rows: mine(), add: !!document.querySelector('#my-topics .add-row'), hint: !!document.querySelector('#topic-hint'), server: await serverOn() };`);
  check("My topics: at 3 topics the add row (and its hint) disappears; a switched-off topic still counts",
    r.rows.length === 3 && !r.add && !r.hint && JSON.stringify(r.server) === '["Colombia:on","Formula 1:off","AI regulation:on"]', JSON.stringify(r));
  r = await b.run(`await wait(450); ${LAYOUT}`);   // after the new row's 0.34 s slide-in
  check("My topics: the layout rules hold with three topics (48 px rows, 44 px targets, no helper text)", layoutOk(r), JSON.stringify(r).slice(0, 500));
  r = await b.run(`${SERVER} ${MY} const n = calls(); click('[data-action=edit-topics]'); await wait(300);
    const m = document.querySelector('#my-topics .minus'), c = m.querySelector('.mc'); const a = m.getBoundingClientRect(), d = c.getBoundingClientRect();
    return { head: text('#my-topics [data-action=edit-topics]'), minus: document.querySelectorAll('#my-topics .minus').length,
      switches: document.querySelectorAll('#my-topics .switch').length, add: !!document.querySelector('#my-topics .add-row'),
      tap: [Math.round(a.width), Math.round(a.height)], drawn: [Math.round(d.width), Math.round(d.height)], round: getComputedStyle(c).borderTopLeftRadius,
      color: getComputedStyle(c).backgroundColor, label: m.getAttribute('aria-label'), left: Math.round(d.left - document.querySelector('#my-topics .group').getBoundingClientRect().left),
      h: [...document.querySelectorAll('#my-topics .ct')].map((e) => Math.round(e.getBoundingClientRect().height)), haptics: since(n).filter((c) => c.startsWith('haptic')) };`);
  check("My topics: Edit shows a red minus (drawn 22 px, 44 px tap area) on each row, hides the switches, says Done",
    r.head === "Done" && r.minus === 3 && r.switches === 0 && r.drawn.join() === "22,22" && r.tap.join() === "44,44" && r.round === "50%" &&
    r.color === RED && r.label === "Remove Colombia" && r.left === 16 && r.h.every((x) => x === 48), JSON.stringify(r));
  r = await b.run(LAYOUT);
  check("My topics: the layout rules hold in edit mode", layoutOk(r), JSON.stringify(r).slice(0, 500));
  r = await b.run(`${SERVER} ${MY} const n = calls(), t = window.__toasts.length; click('#my-topics .ct:nth-child(2) .minus'); await settled();
    const inEdit = { rows: mine(), server: await serverMine(), head: text('#my-topics [data-action=edit-topics]'),
      toasts: window.__toasts.slice(t), haptics: since(n).filter((c) => c.startsWith('haptic')),
      confirms: since(n).filter((c) => c.startsWith('confirm')).length };
    click('[data-action=edit-topics]'); await wait(300);
    return { inEdit, head: text('#my-topics [data-action=edit-topics]'), switches: document.querySelectorAll('#my-topics .switch').length,
      add: !!document.querySelector('#my-topics .add-row'), minus: document.querySelectorAll('#my-topics .minus').length };`);
  check("My topics: the minus removes it at once (no confirm, no toast, a light tap), edit mode stays; Done brings back the switches and the add row",
    JSON.stringify(r.inEdit.rows) === '["Colombia","AI regulation"]' && JSON.stringify(r.inEdit.server) === '["Colombia","AI regulation"]' &&
    r.inEdit.head === "Done" && !r.inEdit.toasts.length && !r.inEdit.confirms && JSON.stringify(r.inEdit.haptics) === '["haptic impact light"]' &&
    r.head === "Edit" && r.switches === 2 && r.add && !r.minus, JSON.stringify(r));
  r = await b.run(`${SERVER} ${MY} const t = window.__toasts.length; addT('Tennis'); await done();
    return { rows: mine(), toasts: window.__toasts.slice(t) };`);
  check("My topics: a sixth AI check in a day is refused before any AI call (5 a day per reader)",
    r.rows.length === 2 && JSON.stringify(r.toasts) === '["Up to 5 new topics a day. Try again tomorrow."]', JSON.stringify(r));
  r = await b.run(`${SERVER} for (const t of ['politics_conflicts', 'armenia', 'russia', 'economy_markets']) {
      const el = document.querySelector('[data-action=topic][data-value=' + t + ']'); if (el.getAttribute('aria-checked') === 'true') { el.click(); await wait(150); } }
    await settled(); return (await server()).topics;`);
  check("with a custom topic, every main topic may be off", Array.isArray(r) && r.length === 0, JSON.stringify(r));
  r = await b.run(`${SERVER} ${MY} ct('AI regulation').click(); await settled(); const n = calls(), t = window.__toasts.length;
    ct('Colombia').click(); await settled();
    return { ui: ct('Colombia').getAttribute('aria-checked'), server: await serverOn(), toasts: window.__toasts.slice(t),
      haptics: since(n).filter((c) => c.startsWith('haptic')), hero: text('#hero') };`);
  check("Step 16: the last topic switched on (all main topics off, one custom on) can go off too: no error, 😴 All topics are off",
    r.ui === "false" && JSON.stringify(r.server) === '["Colombia:off","AI regulation:off"]' && !r.toasts.length &&
    r.haptics.includes("haptic impact light") && /All topics are off/.test(r.hero), JSON.stringify(r));
  await fetch(`${BASE}/__reset`, { method: "POST" });
  await fetch(`${BASE}/__guard429`, { method: "POST" });
  await b.open(`${BASE}/app/?theme=light&as=friend`);
  r = await b.run(`${SERVER} ${MY} const t = window.__toasts.length; addT('Tennis'); await done();
    return { rows: mine(), toasts: window.__toasts.slice(t), input: document.querySelector('#topic-input').value };`);
  check("My topics: when Gemini refused lately (the AI guard), a new check waits: 'Try again in a few minutes'",
    r.rows.length === 0 && JSON.stringify(r.toasts) === '["⏳ Try again in a few minutes."]' && r.input === "Tennis", JSON.stringify(r));
  await fetch(`${BASE}/__reset`, { method: "POST" });
  await b.open(`${BASE}/app/?theme=light&as=friend`);

  // Step 15: Help and Send feedback, two rows near the bottom of Settings, each a page with Telegram's back button
  r = await b.run(`const more = document.querySelector('#more'); const next = more.nextElementSibling;
    const rows = [...more.querySelectorAll('.row')].map((x) => [x.dataset.action, x.innerText.trim(), Math.round(x.getBoundingClientRect().height),
      !!x.querySelector('.sq.solid svg'), !!x.querySelector('.chev'), getComputedStyle(x.querySelector('.sq.solid')).backgroundColor,
      getComputedStyle(x.querySelector('.sq.solid')).color]);
    return { rows, next: next && next.id, before: more.previousElementSibling && more.previousElementSibling.id };`);
  check("Settings: Help and Send feedback rows (48 px, brand-red square with a white glyph, chevron) right above the time zone line, under Support",
    JSON.stringify(r.rows) === JSON.stringify([["open-help", "Help", 48, true, true, RED, "rgb(255, 255, 255)"],
      ["open-feedback", "Send feedback", 48, true, true, RED, "rgb(255, 255, 255)"]]) &&
    r.next === "tz-line" && r.before === "support", JSON.stringify(r));
  r = await b.run(`${SERVER} const n = calls(); click('[data-action=open-help]'); await wait(400);
    const heads = [...document.querySelectorAll('#view .section-head')].map((x) => x.textContent);
    const paras = [...document.querySelectorAll('#view .help-p')].map((x) => x.textContent);
    const lines = [...document.querySelectorAll('#view .help-p')].map((x) => x.querySelectorAll('.line').length);
    const oneLine = [...document.querySelectorAll('#view .help-p .line')].every((l) => l.getClientRects().length >= 1);
    const out = { title: text('#title'), heads, paras: paras.length, privacy: paras[7] || '', lines, oneLine, back: since(n).filter((c) => c.startsWith('back')),
      sideways: document.documentElement.scrollWidth > window.innerWidth, tabs: !!document.querySelector('#tabs') };
    Telegram.WebApp.__back(); await wait(400);
    out.after = { title: text('#title'), settings: !!document.querySelector('#topics'), back: since(n).filter((c) => c.startsWith('back')) };
    return out;`);
  check("Help: its own page (title Help, 8 short sections, the privacy note), Telegram's back button shows and goes back to Settings",
    r.title === "Help" && r.heads.length === 8 && r.heads[0] === "📰 What Axiom is" && r.heads[7] === "🔒 Privacy" && r.paras === 8 &&
    r.heads.every((h) => /^\p{Extended_Pictographic}/u.test(h)) && r.lines.every((n) => n >= 2 && n <= 4) &&
    /Telegram id and name/.test(r.privacy) && !r.sideways && JSON.stringify(r.back) === '["back show"]' &&
    r.after.title === "Settings" && r.after.settings && r.after.back.join() === "back show,back hide", JSON.stringify(r));
  r = await b.run(`${SERVER} const n = calls(), t0 = window.__toasts.length; click('[data-action=open-feedback]'); await wait(400);
    const input = document.querySelector('#fb-input'), send = document.querySelector('[data-action=fb-send]');
    const before = { title: text('#title'), disabled: send.disabled, font: getComputedStyle(input).fontSize, h: Math.round(send.getBoundingClientRect().height),
      w: Math.round(send.getBoundingClientRect().width), page: Math.round(document.querySelector('#view .group').getBoundingClientRect().width), max: input.maxLength };
    input.value = 'Please add more Armenia stories'; input.dispatchEvent(new Event('input', { bubbles: true }));
    const enabled = !send.disabled; click('[data-action=fb-send]'); await wait(900);
    return { before, enabled, title: text('#title'), toasts: window.__toasts.slice(t0), haptics: since(n).filter((c) => c.startsWith('haptic')),
      back: since(n).filter((c) => c.startsWith('back')) };`);
  check("Send feedback: a text field (17 px, 1,000 characters) and a full-width 48 px Send, off until something is typed",
    r.before.title === "Send feedback" && r.before.disabled && r.before.font === "17px" && r.before.h === 48 && r.before.w === r.before.page &&
    r.before.max === 1000 && r.enabled, JSON.stringify(r.before));
  check("Send feedback: sent with a success haptic and a short Thank you, back to Settings",
    r.title === "Settings" && JSON.stringify(r.toasts) === '["✅ Sent. Thank you."]' && r.haptics.includes("haptic success") &&
    r.back.join() === "back show,back hide", JSON.stringify(r));
  r = await b.run(`const h = { authorization: 'tma ' + Telegram.WebApp.initData, 'content-type': 'application/json' };
    const out = [];
    for (let i = 0; i < 10; i++) out.push((await fetch('/api/feedback', { method: 'POST', headers: h, body: JSON.stringify({ text: 'n' + i }) })).status);
    const t0 = window.__toasts.length; click('[data-action=open-feedback]'); await wait(300);
    const input = document.querySelector('#fb-input'); input.value = 'eleventh'; input.dispatchEvent(new Event('input', { bubbles: true }));
    click('[data-action=fb-send]'); await wait(900);
    const res = { statuses: out, toasts: window.__toasts.slice(t0), title: text('#title'), kept: document.querySelector('#fb-input')?.value };
    Telegram.WebApp.__back(); await wait(300); return res;`);
  check("Send feedback: the 11th message in a day shows the limit and keeps the text",
    r.statuses.slice(0, 9).every((s) => s === 200) && r.statuses[9] === 400 && JSON.stringify(r.toasts) === '["Up to 10 messages a day. Try again tomorrow."]' &&
    r.title === "Send feedback" && r.kept === "eleventh", JSON.stringify(r));
  await fetch(`${BASE}/__reset`, { method: "POST" });
  await b.open(`${BASE}/app/?theme=light&as=friend`);

  r = await b.run(ICON_OFFSETS);
  const worst = Math.max(...r.flatMap((x) => [x.dx, x.dy, x.boxDx, x.boxDy].map(Math.abs)));
  check("every icon is centred in its rounded square (within 0.5 px)", r.length >= 2 && worst <= 0.5,
    r.map((x) => `${x.name}: ${x.dx},${x.dy}`).join("; "));

  r = await b.run(`const res = await fetch('/api/admin', { headers: { authorization: 'tma ' + Telegram.WebApp.initData } }); return res.status;`);
  check("friend calling the admin API directly gets 403", r === 403, String(r));
  r = await b.run(`const res = await fetch('/api/settings', { method: 'POST', headers: { authorization: 'tma ' + Telegram.WebApp.initData,
    'content-type': 'application/json' }, body: JSON.stringify({ digest_times: ['09:30'] }) }); return [res.status, (await res.json()).error];`);
  check("the server refuses a half-hour time too", r[0] === 400 && /full hour/.test(r[1]), r.join(" "));
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
    click('[data-action=adm-sec][data-value=pipeline]'); await wait(200);
    const bad = document.createElement('span'); bad.className = 'badge bad'; document.querySelector('#view').append(bad);
    const res = { editor: document.body.innerText.includes('Editor pass'), bad: getComputedStyle(bad).color };
    bad.remove();
    click('[data-action=adm-sec][data-value=pipeline]'); await wait(150);
    const lab = document.querySelector('#env-label');
    res.env = lab ? [lab.textContent, getComputedStyle(lab).backgroundColor, Math.round(lab.getBoundingClientRect().height), lab === document.querySelector('#view').firstElementChild] : null;
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
  check("Admin shows the editor pass (inside Pipeline)", r.editor);
  check("Step 16: Admin opens with a big STAGING label (amber, 48 px, first on the page)",
    JSON.stringify(r.env) === JSON.stringify(["STAGING", "rgb(199, 119, 0)", 48, true]), JSON.stringify(r.env));
  check("Admin in the Settings style: rows 48 px or more, 12 px cards, solid squares (green health, red actions)", r.style.ok, JSON.stringify(r.style));
  check("Step 18: Admin failure badges are the system red (the health colours), not the brand red", r.bad === "rgb(215, 0, 21)", String(r.bad));
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

// ------------------------------------------------------------ 360, 390 and 430 px, English and Russian, light and dark
// Step 13: the owner first gets two custom topics, one with a long name (cut with "..." in its row).
// Step 13 fixes: Japan (its flag on a red tint) and the long one switched off; each size is also
// checked in edit mode.
await fetch(`${BASE}/__reset`, { method: "POST" });
for (const [width, port] of [[360, 9334], [390, 9336], [430, 9335]]) {
  const w = await openBrowser({ width, port });
  try {
    await w.open(`${BASE}/app/?theme=light&as=owner`);
    await w.run(`${ADD("Japan")} ${ADD("International Space Station research")} ${SWITCH("International Space Station research", false)}`);
    for (const lang of ["ru", "en"]) {
      await w.open(`${BASE}/app/?theme=light&as=owner`);
      await w.run(API({ lang }));
      for (const scheme of ["light", "dark"]) {
        await w.open(`${BASE}/app/?theme=${scheme}&as=owner`, scheme);
        const L = await w.run(LAYOUT);
        check(`${width} px, ${lang === "ru" ? "Russian" : "English"}, ${scheme}: the layout rules hold (My topics too)`, layoutOk(L), JSON.stringify(L).slice(0, 600));
        // the emoji tint is sampled from a canvas; if the emoji font is not ready yet the app retries (300 ms, fonts.ready)
        const M = await w.run(`await until(() => getComputedStyle(document.querySelector('#my-topics .ct .sq')).backgroundColor !== 'rgba(142, 142, 147, 0.18)', 2000).catch(() => {});
          const t = [...document.querySelectorAll('#my-topics .ct .row-title')];
          return { n: t.length, head: text('#my-topics .section-head span'), edit: text('#my-topics [data-action=edit-topics]'),
            ph: document.querySelector('#topic-input')?.placeholder, names: t.map((e) => e.textContent),
            flag: document.querySelector('#my-topics .ct .sq').textContent, tint: getComputedStyle(document.querySelector('#my-topics .ct .sq')).backgroundColor,
            on: [...document.querySelectorAll('#my-topics .ct')].map((e) => e.getAttribute('aria-checked')),
            long: t.map((e) => [e.scrollWidth > e.clientWidth, getComputedStyle(e).textOverflow, Math.round(e.closest('.row').getBoundingClientRect().height)]) };`);
        const ru = lang === "ru";
        check(`${width} px, ${ru ? "Russian" : "English"}, ${scheme}: My topics in the reader's language (Edit too), 🇯🇵 on a red tint, on and off; a long name ends in "..." on one 48 px row`,
          M.n === 2 && M.head === (ru ? "Мои темы" : "My topics") && M.edit === (ru ? "Изменить" : "Edit") && M.ph === (ru ? "Добавить тему" : "Add a topic") &&
          M.names[0] === (ru ? "Япония" : "Japan") && M.flag === "🇯🇵" && M.tint === "rgba(255, 59, 48, 0.18)" && M.on.join() === "true,false" &&
          M.long.every((x) => x[1] === "ellipsis" && x[2] === 48) && (width > 400 || M.long[1][0]), JSON.stringify(M));
        const E = await w.run(`click('[data-action=edit-topics]'); await wait(300); const L = (() => { ${LAYOUT} })();
          const done = text('#my-topics [data-action=edit-topics]'); click('[data-action=edit-topics]'); await wait(200); return { L, done };`);
        check(`${width} px, ${ru ? "Russian" : "English"}, ${scheme}: edit mode keeps the layout rules ("${ru ? "Готово" : "Done"}")`,
          layoutOk(E.L) && E.done === (ru ? "Готово" : "Done"), JSON.stringify(E).slice(0, 600));
        // Step 15: the Help and Send feedback pages at this size
        const P = await w.run(`click('[data-action=open-help]'); await wait(350);
          const v = document.querySelector('#view');
          const help = { title: text('#title'), n: v.querySelectorAll('.help-p').length, first: text('#view .section-head'),
            sideways: document.documentElement.scrollWidth > window.innerWidth,
            out: [...v.querySelectorAll('.group')].filter((g) => g.getBoundingClientRect().right > window.innerWidth + 0.5).length };
          Telegram.WebApp.__back(); await wait(300); click('[data-action=open-feedback]'); await wait(350);
          const s = document.querySelector('[data-action=fb-send]');
          const fb = { title: text('#title'), send: s.textContent, h: Math.round(s.getBoundingClientRect().height), r: getComputedStyle(s).borderTopLeftRadius,
            sideways: document.documentElement.scrollWidth > window.innerWidth };
          Telegram.WebApp.__back(); await wait(300);
          const rows = [...document.querySelectorAll('#more .row')].map((x) => [x.innerText.trim(), Math.round(x.getBoundingClientRect().height)]);
          return { help, fb, rows };`);
        check(`${width} px, ${ru ? "Russian" : "English"}, ${scheme}: Help and Send feedback in the reader's language, 48 px rows, nothing wider than the screen`,
          P.help.title === (ru ? "Помощь" : "Help") && P.help.n === 8 && P.help.first === (ru ? "📰 Что такое Axiom" : "📰 What Axiom is") && !P.help.sideways &&
          !P.help.out && P.fb.title === (ru ? "Написать отзыв" : "Send feedback") && P.fb.send === (ru ? "Отправить" : "Send") && P.fb.h === 48 &&
          P.fb.r === "12px" && !P.fb.sideways && P.rows.every((x) => x[1] === 48) && P.rows[0][0] === (ru ? "Помощь" : "Help"), JSON.stringify(P));
      }
    }
    await w.run(API({ lang: "en" }));
  } catch (e) {
    check(`${width} px ran to the end`, false, e.message);
  } finally {
    await w.close();
  }
}
// ------------------------------------------------------------ Step 15: the first open's setup
// A new reader (as=new, no row yet) sees (Step 16) "Language" (1 of 4, Telegram's language chosen),
// "Your topics" (2 of 4), "Digest times" (3 of 4), "All set" (4 of 4); Skip or Done ends it once and
// the server sends the sample digest. Every size, both
// languages, both themes: 48 px rows and buttons, the buttons on the six columns, nothing wider.
const SETUP_LAYOUT = `const v = document.querySelector('#view');
  const box = (e) => e.getBoundingClientRect();
  const items = [...v.querySelectorAll('.b, .group .row')].filter((e) => e.offsetParent);
  const heights = [...new Set(items.map((e) => Math.round(box(e).height)))];
  const card = v.querySelector('.section .group, .section .grid'), nav = v.querySelector('.setup-nav .grid');   // step 2: the times grid
  const navOk = nav ? Math.abs(box(nav).left - box(card).left) < 0.6 && Math.abs(box(nav).right - box(card).right) < 0.6 : false;
  const cut = [...v.querySelectorAll('.b, .row-title')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent.trim());
  return { title: text('#title'), head: text('#view .section-head'), heights, navOk, cut, tabs: !!document.querySelector('#tabs'),
    sideways: document.documentElement.scrollWidth > window.innerWidth,
    nav: [...v.querySelectorAll('.setup-nav .b')].map((b) => b.textContent.trim()) };`;
{
  await fetch(`${BASE}/__reset`, { method: "POST" });
  const n = await openBrowser();
  try {
    await n.open(`${BASE}/app/?theme=light&as=new`);
    let r = await n.run(`${SERVER} const a = (() => { ${SETUP_LAYOUT} })();
      const langs = [...document.querySelectorAll('[data-action=lang]')].map((x) => x.innerText.trim().replace(/\\s+/g, ' ') + ':' + x.getAttribute('aria-checked'));
      return { ...a, langs };`);
    check("Step 16 setup step 1: '🌍 Language', 1 of 4, the flag buttons of Settings with Telegram's language chosen, Skip and Next",
      r.title === "🌍 Language" && r.head === "1 of 4" && r.langs.join() === "🇬🇧 English:true,🇷🇺 Русский:false" && r.nav.join() === "Skip,Next" &&
      !r.tabs && r.heights.join() === "48" && r.navOk && !r.cut.length && !r.sideways, JSON.stringify(r));
    r = await n.run(`${SERVER} const k = calls(); click('[data-action=lang][data-value=ru]'); await settled();
      const a = (() => { ${SETUP_LAYOUT} })(); const u = await server();
      click('[data-action=lang][data-value=en]'); await settled(); const b = (() => { ${SETUP_LAYOUT} })(); const u2 = await server();
      return { a, lang: u.lang, b, lang2: u2.lang, haptic: since(k).filter((c) => c.startsWith('haptic')) };`);
    check("Step 16 setup: a language tap saves at once and the whole flow switches language instantly (and back)",
      r.lang === "ru" && r.a.title === "🌍 Язык" && r.a.head === "1 из 4" && r.a.nav.join() === "Пропустить,Далее" &&
      r.lang2 === "en" && r.b.title === "🌍 Language" && r.b.head === "1 of 4" && r.haptic.includes("haptic impact light"), JSON.stringify(r));
    r = await n.run(`${SERVER} click('[data-action=setup-next]'); await wait(300); const a = (() => { ${SETUP_LAYOUT} })();
      const next = document.querySelector('[data-action=setup-next]'), hint = document.querySelector('#setup-hint');
      const on = [...document.querySelectorAll('[data-action=topic][aria-checked=true]')].length, u = await server();
      click('[data-action=setup-next]'); await wait(250);
      return { ...a, on, saved: u.topics.length, nextOff: next.disabled, hint: hint && !hint.hidden ? hint.textContent : null,
        hintPx: hint ? getComputedStyle(hint).fontSize : null, stayed: text('#title') };`);
    check("Step 18 setup step 2: '📰 Your topics', 2 of 4, every topic OFF, Next disabled with one hint line 'Pick at least one topic' (nothing saved yet)",
      r.title === "📰 Your topics" && r.head === "2 of 4" && r.nav.join() === "Back,Next" && !r.tabs && r.heights.join() === "48" && r.navOk &&
      !r.cut.length && !r.sideways && r.on === 0 && r.saved === 6 && r.nextOff && r.hint === "Pick at least one topic" && r.hintPx === "13px" &&
      r.stayed === "📰 Your topics", JSON.stringify(r));
    r = await n.run(`${SERVER} click('[data-value=armenia]'); await settled(); const u = await server();
      const next = document.querySelector('[data-action=setup-next]'), hint = document.querySelector('#setup-hint');
      const after1 = { saved: u.topics, nextOff: next.disabled, hintHidden: hint.hidden };
      click('[data-value=armenia]'); await settled(); const u2 = await server();
      const after0 = { saved: u2.topics, nextOff: document.querySelector('[data-action=setup-next]').disabled, hintHidden: document.querySelector('#setup-hint').hidden };
      for (const t of ['politics_conflicts', 'economy_markets', 'armenia', 'russia', 'iran_war']) { click('[data-value=' + t + ']'); await wait(60); }
      await settled(); return { after1, after0, u3: (await server()).topics, nextOff: document.querySelector('[data-action=setup-next]').disabled };`);
    check("Step 18 setup: one topic on enables Next and hides the hint (saved at once); switching it off again disables Next",
      r.after1.saved.join() === "armenia" && !r.after1.nextOff && r.after1.hintHidden && r.after0.saved.length === 0 && r.after0.nextOff &&
      !r.after0.hintHidden && r.u3.length === 5 && !r.nextOff, JSON.stringify(r));
    r = await n.run(`${SERVER} const on = 6 - [...document.querySelectorAll('[data-action=topic][aria-checked=true]')].length === 1 ? 6 : -1;
      const u = await server();
      click('[data-action=setup-next]'); await wait(300); const s2 = (() => { ${SETUP_LAYOUT} })();
      const times = [...document.querySelectorAll('[data-action=time]')].length, on2 = [...document.querySelectorAll('[data-action=time][aria-pressed=true]')].map((x) => x.dataset.value);
      click('[data-value="20:00"]'); await settled(); const u2 = await server();
      click('[data-action=setup-back]'); await wait(300); const back = text('#title');
      click('[data-action=setup-next]'); await wait(200); click('[data-action=setup-next]'); await wait(300); const s3 = (() => { ${SETUP_LAYOUT} })();
      const hero = !!document.querySelector('#hero'), sample = text('#view .help-p');
      return { on, saved: u.topics, s2, times, on2, savedTimes: u2.digest_times, back, s3, hero, sample };`);
    check("setup: the picks are saved (no Ukraine War); step 3 '🕘 Digest times', 3 of 4, 18 hours with 09, 14, 20 on, Back and Next on the grid",
      r.on === 6 && !r.saved.includes("ukraine_war") && r.s2.title === "🕘 Digest times" && r.s2.head === "3 of 4" && r.times === 18 &&
      r.on2.join() === "09:00,14:00,20:00" && r.s2.nav.join() === "Back,Next" && r.s2.navOk && r.s2.heights.join() === "48" &&
      r.savedTimes.join() === "09:00,14:00" && r.back === "📰 Your topics", JSON.stringify(r).slice(0, 700));
    check("setup step 4: '✅ All set', 4 of 4, the next digest and two short lines about the sample, one Done button",
      r.s3.title === "✅ All set" && r.s3.head === "4 of 4" && r.hero && /sample digest will arrive shortly\.It covers the important news of the last 24 hours/.test(r.sample) && r.s3.nav.join() === "Done" &&
      r.s3.navOk && !r.s3.sideways, JSON.stringify(r.s3));
    r = await n.run(`${SERVER} const k = calls(); click('[data-action=setup-finish]'); await until(() => text('#title') === 'Settings', 6000); await wait(300);
      const st = await (await fetch('/api/open', { method: 'POST', headers: { authorization: 'tma ' + Telegram.WebApp.initData, 'content-type': 'application/json' }, body: '{}' })).json();
      return { title: text('#title'), topics: !!document.querySelector('#topics .group, #topics'), haptic: since(k).filter((c) => c.startsWith('haptic')), setup: st.setup,
        more: !!document.querySelector('#more') };`);
    check("setup Done: Settings opens, a success haptic, the server ends the setup (it never shows again)",
      r.title === "Settings" && r.topics && r.more && r.haptic.includes("haptic success") && r.setup === false, JSON.stringify(r));
    await n.open(`${BASE}/app/?theme=light&as=new`);
    r = await n.run(`return { title: text('#title') };`);
    check("setup: reopening the app goes straight to Settings", r.title === "Settings", JSON.stringify(r));
    await fetch(`${BASE}/__reset`, { method: "POST" });
    await n.open(`${BASE}/app/?theme=dark&as=new&tg_lang=ru`, "dark");
    r = await n.run(`${SERVER} const a = (() => { ${SETUP_LAYOUT} })(); click('[data-action=setup-skip]'); await until(() => text('#title') === 'Настройки', 6000);
      const u = await server(); return { a, title: text('#title'), lang: u.lang, topics: u.topics.length, times: u.digest_times };`);
    check("setup in Russian, dark: '🌍 Язык' with Русский preselected (Telegram's language), '1 из 4', Пропустить and Далее; Skip keeps the defaults",
      r.a.title === "🌍 Язык" && r.a.head === "1 из 4" && r.a.nav.join() === "Пропустить,Далее" && r.title === "Настройки" && r.lang === "ru" &&
      r.topics === 6 && r.times.join() === "09:00,14:00,20:00", JSON.stringify(r));
    check("no console errors (setup)", n.consoleErrors().length === 0, JSON.stringify(n.consoleErrors()[0]?.params ?? "").slice(0, 200));
  } catch (e) {
    check("setup checks ran to the end", false, e.message);
  } finally {
    await n.close();
  }
}
for (const [width, port] of [[360, 9334], [390, 9336], [430, 9335]]) {
  const w = await openBrowser({ width, port });
  try {
    for (const lang of ["en", "ru"]) {
      for (const scheme of ["light", "dark"]) {
        await fetch(`${BASE}/__reset`, { method: "POST" });
        await w.open(`${BASE}/app/?theme=${scheme}&as=new&tg_lang=${lang}`, scheme);
        const S = await w.run(`const out = []; for (let i = 0; i < 4; i++) { out.push((() => { ${SETUP_LAYOUT} })());
          if (i === 1) { click('[data-value=russia]'); await wait(250); }   // Step 18: Next waits for one topic
          if (i < 3) { click('[data-action=setup-next]'); await wait(250); } } return out;`);
        const ru = lang === "ru";
        check(`${width} px, ${ru ? "Russian" : "English"}, ${scheme}: the four setup steps (language first) keep the layout rules`,
          S.every((x) => x.heights.join() === "48" && x.navOk && !x.cut.length && !x.sideways && !x.tabs) &&
          S.map((x) => x.head).join() === (ru ? "1 из 4,2 из 4,3 из 4,4 из 4" : "1 of 4,2 of 4,3 of 4,4 of 4"), JSON.stringify(S).slice(0, 600));
      }
    }
  } catch (e) {
    check(`${width} px setup ran to the end`, false, e.message);
  } finally {
    await w.close();
  }
}

// ------------------------------------------------------------ Step 15: the announcement tool (Admin)
{
  await fetch(`${BASE}/__reset`, { method: "POST" });
  const a = await openBrowser();
  try {
    await a.open(`${BASE}/app/?theme=light&as=owner&confirm=1`);
    let r = await a.run(`${SERVER} click('[data-action=tab][data-value=admin]'); await until(() => document.querySelector('#adm-announce'), 6000);
      click('[data-action=adm-sec][data-value=announce]'); await until(() => document.querySelector('#announce'), 3000);
      const sec = document.querySelector('#announce');
      return { head: text('#adm-announce .adm-head .row-title'), aud: [...sec.querySelectorAll('[data-action=ann-audience]')].map((b) => b.textContent + ':' + b.getAttribute('aria-pressed')),
        foot: text('#announce .section-foot') };`);
    check("Admin: Announcement section with the English field and the audience (All users, English, Russian)",
      r.head === "Announcement" && r.aud.join() === "All users:true,English:false,Russian:false" && /English, Russian/.test(r.foot), JSON.stringify(r));
    r = await a.run(`${SERVER} const t0 = window.__toasts.length; const i = document.querySelector('#ann-en'); i.value = 'New: Economy & Markets from 5 December.';
      i.dispatchEvent(new Event('input', { bubbles: true })); click('[data-action=ann-translate]');
      await until(() => document.querySelectorAll('.ann-text').length, 8000); await wait(300);
      const versions = [...document.querySelectorAll('.ann-text')].map((x) => x.dataset.lang + '=' + x.value);
      const send = document.querySelector('[data-action=ann-send]');
      return { versions, sendOff: send.disabled, toasts: window.__toasts.slice(t0) };`);
    check("Translate: one version per language users read (English and Russian), Send locked until a preview",
      r.versions.length === 2 && r.versions[0] === "en=New: Economy & Markets from 5 December." && /^ru=Новости Axiom: 5\.$/.test(r.versions[1]) && r.sendOff,
      JSON.stringify(r));
    r = await a.run(`${SERVER} const t0 = window.__toasts.length; click('[data-action=ann-preview]'); await until(() => window.__toasts.length > t0, 6000);
      await until(() => !document.querySelector('[data-action=ann-send]').disabled, 6000).catch(() => {});
      const sendOn = !document.querySelector('[data-action=ann-send]').disabled; const t1 = window.__toasts.slice(t0);
      const ta = document.querySelector('.ann-text[data-lang=ru]'); ta.value = ta.value + ' Ура'; ta.dispatchEvent(new Event('input', { bubbles: true }));
      const st = (await (await fetch('/api/admin', { headers: { authorization: 'tma ' + Telegram.WebApp.initData } })).json()).announce.recent.map((x) => x.id + ':' + x.status);
      return { t1, sendOn, locked: document.querySelector('[data-action=ann-send]').disabled, st };`);
    check("Preview to me: sent to the owner; Send unlocks; an edit locks it again until a new preview",
      r.t1.join() === "Preview sent to you: 2 versions." && r.sendOn && r.locked, JSON.stringify(r));
    r = await a.run(`${SERVER} const t0 = window.__toasts.length; click('[data-action=ann-preview]'); await until(() => window.__toasts.length > t0, 6000);
      await until(() => !document.querySelector('[data-action=ann-send]').disabled, 6000).catch(() => {});
      const t1 = window.__toasts.length; click('[data-action=ann-send]'); await until(() => window.__toasts.length > t1, 6000); await wait(600);
      return { toast: window.__toasts.slice(t1).join(), badge: [...document.querySelectorAll('.badge')].map((b) => b.textContent).filter((x) => /sending|done/.test(x)),
        fresh: !!document.querySelector('#ann-en') };`);
    check("Send (after a confirm): sending in batches, listed under Recent announcements; the field is free for the next one",
      /Sending now/.test(r.toast) && r.badge.includes("sending") && r.fresh, JSON.stringify(r));
    r = await a.run(`const res = await fetch('/api/admin/announce', { method: 'POST', headers: { authorization: 'tma ' + Telegram.WebApp.initData, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'draft', text: 'x', audience: 'all' }) }); return res.status;`);
    check("the owner's API works (200)", r === 200, String(r));
    await a.open(`${BASE}/app/?theme=light&as=friend`);
    r = await a.run(`const res = await fetch('/api/admin/announce', { method: 'POST', headers: { authorization: 'tma ' + Telegram.WebApp.initData, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'draft', text: 'x', audience: 'all' }) }); return res.status;`);
    check("a reader calling the announcement API gets 403", r === 403, String(r));
  } catch (e) {
    check("announcement checks ran to the end", false, e.message);
  } finally {
    await a.close();
  }
}

// ------------------------------------------------------------ Step 18: beta fixes
// The digest times bug, reproduced: answers held 300 ms (so taps land while a request is on its way),
// rapid random taps, and a failing request. The screen must never show zero times, must send one
// request at a time, and must end equal to what the server saved.
const SLOW = `if (!window.__slow) { window.__slow = true; const real = window.fetch; window.__net = { inflight: 0, max: 0, n: 0 }; window.__failNext = false;
    window.fetch = async (u, o) => { if (!String(u).includes('/api/settings')) return real(u, o);
      const N = window.__net; N.n++; N.inflight++; N.max = Math.max(N.max, N.inflight);
      try { if (window.__failNext) { window.__failNext = false; await wait(200);
          return new Response(JSON.stringify({ error: 'Network trouble' }), { status: 500 }); }
        const r = await real(u, o); await wait(300); return r; } finally { N.inflight--; } }; }
  window.__minOn = 99; if (!window.__mo) { window.__mo = new MutationObserver(() => { window.__minOn = Math.min(window.__minOn, pressed().length); });
    window.__mo.observe(document.querySelector('#times'), { attributes: true, subtree: true, attributeFilter: ['aria-pressed'] }); }`;
{
  await fetch(`${BASE}/__reset`, { method: "POST" });
  const q = await openBrowser({ width: 390, port: 9337 });
  try {
    await q.open(`${BASE}/app/?theme=light&as=friend`);
    await q.run(API({ digest_times: ["09:00", "14:00"] }));
    await q.open(`${BASE}/app/?theme=light&as=friend`);
    // the owner's case: add one, remove one, then the rest while answers are still on their way
    let r = await q.run(`${SERVER} ${SLOW} const t0 = window.__toasts.length;
      click('[data-value="20:00"]'); await wait(30); click('[data-value="09:00"]'); await wait(350);
      click('[data-value="14:00"]'); await wait(300); click('[data-value="20:00"]'); await wait(1600);
      return { on: pressed(), u: (await server()).digest_times, min: window.__minOn, max: window.__net.max, n: window.__net.n, toast: window.__toasts.slice(t0).join(' | ') };`);
    check("Step 18 times bug: taps while answers are on their way never leave zero times on screen; the last one is refused; screen = server",
      r.min >= 1 && r.on.length >= 1 && JSON.stringify(r.on) === JSON.stringify(r.u) && r.u.join() === "20:00" && r.max === 1 &&
      /Keep at least one time/.test(r.toast), JSON.stringify(r));
    r = await q.run(`${SERVER} ${SLOW} window.__minOn = 99; const hours = [...document.querySelectorAll('[data-action=time]')].map((x) => x.dataset.value);
      let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed; };
      for (let i = 0; i < 40; i++) { click('[data-value="' + hours[rnd() % 6] + '"]'); await wait(20 + rnd() % 60); }
      await wait(2500); const n0 = window.__net.n;
      return { on: pressed(), u: (await server()).digest_times, min: window.__minOn, max: window.__net.max, n: n0 };`);
    check("Step 18 times bug: 40 rapid random taps: one request at a time (taps merged), never zero on screen, at most 5, screen = server",
      r.min >= 1 && r.on.length >= 1 && r.on.length <= 5 && JSON.stringify(r.on) === JSON.stringify(r.u) && r.max === 1 && r.n < 40, JSON.stringify(r));
    r = await q.run(`${SERVER} ${SLOW} const before = (await server()).digest_times; const t0 = window.__toasts.length; window.__failNext = true;
      const pick = ['06:00', '07:00', '08:00'].find((x) => !pressed().includes(x)); click('[data-value="' + pick + '"]');
      await wait(60); const mid = pressed(); await wait(1200);
      return { before, mid, pick, on: pressed(), u: (await server()).digest_times, toast: window.__toasts.slice(t0).join(' | ') };`);
    check("Step 18 times bug: a failed save rolls the screen back to the server's state, with a short error",
      r.mid.includes(r.pick) && !r.on.includes(r.pick) && JSON.stringify(r.on) === JSON.stringify(r.u) && JSON.stringify(r.u) === JSON.stringify(r.before) &&
      /Network trouble/.test(r.toast), JSON.stringify(r));
    r = await q.run(`const res = await fetch('/api/settings', { method: 'POST', headers: { authorization: 'tma ' + Telegram.WebApp.initData,
      'content-type': 'application/json' }, body: JSON.stringify({ digest_times: [] }) }); const j = await res.json();
      return { status: res.status, code: j.code, saved: j.state && j.state.user.digest_times };`);
    check("Step 18 times bug: the server refuses an empty list and answers with the saved times", r.status === 400 && r.code === "keep_time" &&
      Array.isArray(r.saved) && r.saved.length >= 1, JSON.stringify(r));

    // Help: "we", never "the owner"; Delete my data in the brand red, its question in place
    for (const scheme of ["light", "dark"]) {
      await fetch(`${BASE}/__reset`, { method: "POST" });
      await q.open(`${BASE}/app/?theme=${scheme}&as=friend`, scheme);
      r = await q.run(`click('[data-action=open-help]'); await wait(350);
        const v = document.querySelector('#view'); const row = document.querySelector('#delete-me .row-title');
        const out = { fb: text('#help-feedback .help-p'), owner: /owner/i.test(v.innerText), rowColor: getComputedStyle(row).color };
        click('#delete-me'); await wait(250);
        const yes = document.querySelector('#delete-yes');
        out.q = text('#delete-q'); out.yesBg = yes && getComputedStyle(yes).backgroundColor; out.yesText = yes && yes.textContent;
        out.yesH = yes && Math.round(yes.getBoundingClientRect().height); out.cancel = text('[data-action=delete-cancel]');
        out.rowColor2 = getComputedStyle(document.querySelector('#delete-me .row-title')).color;
        click('[data-action=delete-cancel]'); await wait(250); out.gone = !document.querySelector('#delete-q');
        click('#delete-me'); await wait(200); click('#delete-yes'); await until(() => document.querySelector('#deleted'), 4000);
        out.done = text('#deleted'); return out;`);
      const dark = scheme === "dark";
      check(`Step 18 (${scheme}): Help says "We read every message" (no "owner"); Delete my data is brand red (${dark ? "#ff6b6b text, #d0232a fill" : "#b1161c"}), not orange; its question shows in place with a red Delete and Cancel`,
        /We read every message/.test(r.fb) && !r.owner && r.rowColor === (dark ? "rgb(255, 107, 107)" : RED) && r.rowColor2 === r.rowColor &&
        /^Delete all your data\?/.test(r.q) && r.yesBg === (dark ? RED_DARK : RED) && r.yesText === "Delete" && r.yesH === 48 && r.cancel === "Cancel" &&
        r.gone && /Your data is deleted/.test(r.done), JSON.stringify(r));
    }
    await fetch(`${BASE}/__reset`, { method: "POST" });
    await q.open(`${BASE}/app/?theme=light&as=owner`);
    r = await q.run(`click('[data-action=open-help]'); await wait(350); click('#delete-me'); await wait(200); const q1 = text('#delete-q');
      click('#delete-yes'); await wait(250); const q2 = text('#delete-q'); const still = !document.querySelector('#deleted');
      click('[data-action=delete-cancel]'); await wait(200); return { q1, q2, still, gone: !document.querySelector('#delete-q') };`);
    check("Step 18: the owner gets a second question ('This is your Admin account...') before anything is deleted; Cancel stops it",
      /^Delete all your data\?/.test(r.q1) && /^This is your Admin account/.test(r.q2) && r.still && r.gone, JSON.stringify(r));
    await q.open(`${BASE}/app/?theme=light&as=friend`);
    await q.run(`${API({ lang: "ru" })} return 1;`);
    await q.open(`${BASE}/app/?theme=light&as=friend`);
    r = await q.run(`click('[data-action=open-help]'); await wait(350); return { fb: text('#help-feedback .help-p'), owner: /владел/i.test(document.querySelector('#view').innerText) };`);
    check("Step 18: Russian Help says 'Мы читаем каждое сообщение' (no 'владелец')", /Мы читаем каждое сообщение/.test(r.fb) && !r.owner, JSON.stringify(r));
    await q.run(API({ lang: "en" }));
    check("no console errors (Step 18 checks)", q.consoleErrors().length === 0, JSON.stringify(q.consoleErrors()[0]?.params ?? "").slice(0, 200));
  } catch (e) {
    check("Step 18 checks ran to the end", false, e.message);
  } finally {
    await q.close();
  }
}

// The Admin dashboard: what it shows and that every action is still there (390 px, light), then the
// layout rules at 360, 390 and 430 px, light and dark, with every section open.
const ADMIN_LAYOUT = `const v = document.querySelector('#view'); const box = (e) => e.getBoundingClientRect();
  const rows = [...v.querySelectorAll('.group .row')].filter((e) => e.offsetParent);
  return { short: rows.filter((e) => box(e).height < 47.5).map((e) => e.innerText.slice(0, 40)),
    radii: [...new Set([...v.querySelectorAll('.group')].map((e) => getComputedStyle(e).borderTopLeftRadius))],
    wide: [...v.querySelectorAll('.group, .b, .row')].filter((e) => e.offsetParent && box(e).right > window.innerWidth + 0.5).length,
    kpiCut: [...v.querySelectorAll('.kpi b, .kpi span')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent),
    sideways: document.documentElement.scrollWidth > window.innerWidth };`;
const adminLayoutOk = (x) => !x.short.length && x.radii.join() === "12px" && !x.wide && !x.kpiCut.length && !x.sideways;
{
  await fetch(`${BASE}/__reset`, { method: "POST" });
  const d = await openBrowser({ width: 390, port: 9338 });
  try {
    await d.open(`${BASE}/app/?theme=light&as=owner`);
    let r = await d.run(`click('[data-value=admin]'); await until(() => document.querySelector('#health'), 6000);
      const v = document.querySelector('#view'); const kids = [...v.children].map((e) => e.id || e.className);
      const heads = [...document.querySelectorAll('.adm-head')].map((h) => h.querySelector('.row-title').textContent + ':' + h.getAttribute('aria-expanded'));
      return { kids: kids.slice(0, 5), title: text('#health .status-title'), reason: text('#health .status-sub'),
        dot: getComputedStyle(document.querySelector('#health .dot')).backgroundColor,
        kpis: [...document.querySelectorAll('.kpi')].map((k) => k.querySelector('span').textContent + '=' + k.querySelector('b').textContent),
        heads, bodies: document.querySelectorAll('.adm-body').length,
        lim: [...document.querySelectorAll('#limits [data-lim]')].map((x) => x.dataset.lim + (x.querySelector('.badge') ? '!' : '')),
        actions: [...document.querySelectorAll('#actions [data-action]')].map((x) => x.dataset.action) };`);
    check("Step 18 Admin: STAGING, then one health line (green 'All good' with its reason) and six key numbers",
      r.kids[0] === "env-label" && r.title === "All good" && /fine/.test(r.reason) && r.dot === "rgb(52, 199, 89)" &&
      r.kpis.map((k) => k.split("=")[0]).join() === "Active users,Digests today,Delivered,Stories today,Last run · Done,Next run" &&
      r.kpis[1] === "Digests today=14" && r.kpis[2] === "Delivered=100%", JSON.stringify(r));
    check("Step 18 Admin: Actions (Send me a digest now, Run news job now) and the free limits (D1 reads, writes, Worker CPU, AI per model), no colour while fine",
      r.actions.join() === "digest-now,run-job" && r.lim.slice(0, 3).join() === "reads,writes,cpu" && r.lim.filter((x) => x.startsWith("ai")).length >= 2 &&
      !r.lim.some((x) => x.endsWith("!")), JSON.stringify(r));
    check("Step 18 Admin: nine sections, all closed at first (Pipeline, AI, Feeds, Users, Custom topics, Announcement, Feedback, Tips, Errors)",
      r.heads.join() === "Pipeline:false,AI:false,Feeds:false,Users:false,Custom topics:false,Announcement:false,Feedback:false,Tips:false,Errors:false" &&
      r.bodies === 0, JSON.stringify(r.heads));
    r = await d.run(`const open = (k) => { click('[data-action=adm-sec][data-value=' + k + ']'); };
      open('feeds'); await wait(150); const feeds = { rows: [...document.querySelectorAll('#adm-feeds .adm-body .row')].map((x) => x.innerText.split('\\n')[0]),
        working: text('#adm-feeds .kv-num') };
      open('feeds'); await wait(150); const closed = !document.querySelector('#adm-feeds .adm-body');
      open('custom'); await wait(150); const custom = { names: [...document.querySelectorAll('#adm-custom .adm-body .adm-part:first-child .row .row-title .ellipsis')].map((x) => x.textContent),
        hidden: text('#custom-hidden'), acts: [...document.querySelectorAll('#adm-custom [data-action=topic-admin]')].map((x) => x.dataset.act) };
      open('errors'); await wait(150); const e1 = [...document.querySelectorAll('#adm-errors .row.err')].map((x) => x.className.includes('routine'));
      const more = text('#adm-errors [data-action=all-errors]'); click('#adm-errors [data-action=all-errors]'); await wait(150);
      const e2 = [...document.querySelectorAll('#adm-errors .row.err')].map((x) => [x.className.includes('routine'), x.querySelector('.row-sub').textContent]);
      open('users'); open('tips'); open('announce'); open('pipeline'); open('ai'); open('feedback'); open('feeds'); await wait(200);
      const acts = [...new Set([...document.querySelectorAll('#view [data-action]')].map((x) => x.dataset.action))];
      return { feeds, closed, custom, e1, more, e2, acts, open: [...document.querySelectorAll('.adm-head[aria-expanded=true]')].length };`);
    check("Step 18 Admin: Feeds lists only the failing and silent feeds, the rest as one count; a second tap closes it",
      r.feeds.working === "112 of 115" && r.feeds.rows.join() === "Working,Times of Israel,Azatutyun,Iran International" && r.closed, JSON.stringify(r.feeds));
    check("Step 18 Admin: Custom topics shows only active ones (Formula 1) with Keywords, Delete, Block; the switched-off one is '1 hidden'",
      r.custom.names.join() === "Formula 1" && /^1 hidden/.test(r.custom.hidden) && r.custom.acts.join() === "keywords,delete,block", JSON.stringify(r.custom));
    check("Step 18 Admin: Errors grouped, newest first, routine notes hidden behind 'Show all'",
      r.e1.length >= 2 && r.e1.every((x) => !x) && /^Show all \(2 routine notes\)$/.test(r.more) && r.e2.length === r.e1.length + 2 &&
      r.e2.some((x) => x[0] && /^10 times, last/.test(x[1])), JSON.stringify({ e1: r.e1, more: r.more, e2: r.e2 }));
    check("Step 18 Admin: every action is still there (digest, news job, Delete user, Refund, Keywords/Delete/Block, announcement, Refresh)",
      ["digest-now", "run-job", "user-delete", "refund", "topic-admin", "ann-translate", "ann-audience", "refresh", "range"].every((a) => r.acts.includes(a)) && r.open === 9,
      r.acts.join(","));
    check("no console errors (Step 18 Admin)", d.consoleErrors().length === 0, JSON.stringify(d.consoleErrors()[0]?.params ?? "").slice(0, 200));
  } catch (e) {
    check("Step 18 Admin checks ran to the end", false, e.message);
  } finally {
    await d.close();
  }
}
for (const [width, port] of [[360, 9334], [390, 9336], [430, 9335]]) {
  const w = await openBrowser({ width, port });
  try {
    for (const scheme of ["light", "dark"]) {
      await w.open(`${BASE}/app/?theme=${scheme}&as=owner`, scheme);
      const r = await w.run(`click('[data-value=admin]'); await until(() => document.querySelector('#health'), 6000);
        const closed = (() => { ${ADMIN_LAYOUT} })();
        for (const k of ['pipeline', 'ai', 'feeds', 'users', 'custom', 'announce', 'feedback', 'tips', 'errors']) click('[data-action=adm-sec][data-value=' + k + ']');
        await wait(300); const open = (() => { ${ADMIN_LAYOUT} })();
        return { closed, open, red: getComputedStyle(document.querySelector('[data-action=digest-now] .row-icon')).backgroundColor };`);
      check(`${width} px, ${scheme}: the Admin dashboard keeps the design (rows 48 px or more, 12 px cards, nothing wider, numbers not cut), closed and open`,
        adminLayoutOk(r.closed) && adminLayoutOk(r.open) && r.red === (scheme === "dark" ? RED_DARK : RED), JSON.stringify(r).slice(0, 600));
    }
  } catch (e) {
    check(`${width} px Admin ran to the end`, false, e.message);
  } finally {
    await w.close();
  }
}

console.log(results.join("\n"));
console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
