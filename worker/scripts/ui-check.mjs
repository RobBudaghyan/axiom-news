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
    JSON.stringify(r.toasts) === '["Armenia is already a main topic. Switch it on above."]', JSON.stringify(r));
  r = await b.run(`${SERVER} ${MY} ct('Formula 1').click(); await settled(); addT('AI regulation'); await done();
    return { rows: mine(), add: !!document.querySelector('#my-topics .add-row'), server: await serverOn() };`);
  check("My topics: at 3 topics the add row disappears; a switched-off topic still counts",
    r.rows.length === 3 && !r.add && JSON.stringify(r.server) === '["Colombia:on","Formula 1:off","AI regulation:on"]', JSON.stringify(r));
  r = await b.run(LAYOUT);
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
  r = await b.run(`${SERVER} for (const t of ['politics', 'armenia', 'russia', 'wars_conflicts']) {
      const el = document.querySelector('[data-action=topic][data-value=' + t + ']'); if (el.getAttribute('aria-checked') === 'true') { el.click(); await wait(150); } }
    await settled(); return (await server()).topics;`);
  check("with a custom topic, every main topic may be off", Array.isArray(r) && r.length === 0, JSON.stringify(r));
  r = await b.run(`${SERVER} ${MY} ct('AI regulation').click(); await settled(); const n = calls(), t = window.__toasts.length;
    ct('Colombia').click(); await settled();
    return { ui: ct('Colombia').getAttribute('aria-checked'), server: await serverOn(), toasts: window.__toasts.slice(t),
      haptics: since(n).filter((c) => c.startsWith('haptic')) };`);
  check("the last topic switched on (all main topics off, one custom on) cannot be switched off",
    r.ui === "true" && JSON.stringify(r.server) === '["Colombia:on","AI regulation:off"]' && JSON.stringify(r.toasts) === '["Keep at least one topic"]' &&
    r.haptics.includes("haptic warning"), JSON.stringify(r));
  await fetch(`${BASE}/__reset`, { method: "POST" });
  await fetch(`${BASE}/__guard429`, { method: "POST" });
  await b.open(`${BASE}/app/?theme=light&as=friend`);
  r = await b.run(`${SERVER} ${MY} const t = window.__toasts.length; addT('Tennis'); await done();
    return { rows: mine(), toasts: window.__toasts.slice(t), input: document.querySelector('#topic-input').value };`);
  check("My topics: when Gemini refused lately (the AI guard), a new check waits: 'Try again in a few minutes'",
    r.rows.length === 0 && JSON.stringify(r.toasts) === '["Try again in a few minutes."]' && r.input === "Tennis", JSON.stringify(r));
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
        const M = await w.run(`const t = [...document.querySelectorAll('#my-topics .ct .row-title')];
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
