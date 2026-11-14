// End-to-end check of the Mini App in headless Edge against the local preview (real API code,
// demo database): taps every setting like a user would and confirms each change through the API.
// Start the preview first (node scripts/dev-server.mjs, fresh: it keeps state in memory), then:
//   node scripts/ui-check.mjs
import { openBrowser } from "./dev/cdp.mjs";

const BASE = process.env.PREVIEW_URL || "http://localhost:8790";
const results = [];
let failed = 0;
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}
// What the server has saved, read through the API with the page's own initData.
const SERVER = `const server = async () => (await (await fetch('/api/open', { method: 'POST',
  headers: { authorization: 'tma ' + Telegram.WebApp.initData, 'content-type': 'application/json' }, body: '{}' })).json()).user;
  const settled = async () => { await wait(700); };
  const pressed = () => [...document.querySelectorAll('[data-action=time][aria-pressed=true]')].map((x) => x.dataset.value);`;

// For every icon in a rounded square: how far the drawn icon's centre is from the square's centre
// (getBBox gives the drawing in viewBox units; strokes are symmetric, so they do not move the centre).
const ICON_OFFSETS = `return [...document.querySelectorAll('.row-icon.tile, .hero-icon')].map((box) => {
    const svg = box.querySelector('svg'); const r = box.getBoundingClientRect(); const s = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal; const g = svg.getBBox(); const k = s.width / vb.width;
    const cx = s.left + (g.x - vb.x + g.width / 2) * k, cy = s.top + (g.y - vb.y + g.height / 2) * k;
    return { name: (box.closest('.row, .hero')?.innerText || '').trim().split('\\n')[0],
      dx: +(cx - (r.left + r.width / 2)).toFixed(2), dy: +(cy - (r.top + r.height / 2)).toFixed(2),
      boxDx: +((s.left + s.width / 2) - (r.left + r.width / 2)).toFixed(2), boxDy: +((s.top + s.height / 2) - (r.top + r.height / 2)).toFixed(2) };
  });`;

const b = await openBrowser();
try {
  await b.open(`${BASE}/app/?theme=light&as=friend`);
  const start = await b.run(`${SERVER} return await server();`);
  check("friend sees no Admin tab", await b.run("return !document.querySelector('#tabs');"));
  check("time zone saved from the device on open, shown read-only", start.tz_source === "device" &&
    await b.run("return /time/.test(text('#tz-row')) && /From your phone/.test(text('#tz-row')) && !document.querySelector('#tz-row[data-action]');"),
    await b.run("return text('#tz-row').replace(/\\s+/g, ' ');"));
  check("no stories stepper, format choice or time zone picker any more",
    await b.run("return !document.querySelector('[data-action=step], [data-action=format], [data-action=open-tz], .stepper, .fmt');"));

  let r = await b.run(`${SERVER} click('[data-value=wars_conflicts]'); await settled(); return { u: await server(), toast: text('#toast') };`);
  check("topic switched on is saved", r.u.topics.includes("wars_conflicts"), r.u.topics.join(","));
  check("a subtle 'Saved' confirmation appears", /Saved/.test(r.toast), r.toast);

  r = await b.run(`${SERVER} for (const t of ['politics', 'armenia', 'russia']) { click('[data-value=' + t + ']'); await wait(120); }
    await settled(); click('[data-value=wars_conflicts]'); await wait(300);
    return { u: await server(), toast: text('#toast'), on: document.querySelector('[data-value=wars_conflicts]').getAttribute('aria-checked') };`);
  check("the last topic cannot be switched off", r.u.topics.length === 1 && r.on === "true" && /at least one topic/.test(r.toast),
    `${r.u.topics.join(",")} / ${r.toast}`);

  r = await b.run(`${SERVER} return { all: [...document.querySelectorAll('[data-action=time]')].map((x) => x.dataset.value), on: pressed(), u: await server() };`);
  check("time grid: 18 hourly buttons, 06:00 to 23:00, no half hours", r.all.length === 18 && r.all[0] === "06:00" &&
    r.all.at(-1) === "23:00" && r.all.every((t) => t.endsWith(":00")), `${r.all[0]}..${r.all.at(-1)}`);
  check("time grid shows the saved times as chosen", JSON.stringify(r.on) === JSON.stringify(r.u.digest_times), r.on.join(","));

  const before = await b.run(`${SERVER} return await server();`);
  r = await b.run(`${SERVER} click('[data-value="06:00"]'); await settled();
    return { u: await server(), on: pressed(), bg: getComputedStyle(document.querySelector('[data-value="06:00"]')).backgroundColor,
      foot: text('#times-foot') };`);
  check("tap a time: chosen (red) and saved", r.u.digest_times.includes("06:00") && r.on.includes("06:00") && r.bg === "rgb(177, 22, 28)",
    `${r.u.digest_times.join(",")} / ${r.bg}`);
  check("the footnote lists the chosen times", r.foot.includes("06:00"), r.foot);
  check("next digest recomputed after a time change", r.u.next_digest_at !== before.next_digest_at || r.u.digest_times.length > before.digest_times.length,
    `${before.next_digest_at} -> ${r.u.next_digest_at}`);
  r = await b.run(`${SERVER} click('[data-value="06:00"]'); await settled(); return { u: await server(), on: pressed() };`);
  check("tap it again: unchosen and saved", !r.u.digest_times.includes("06:00") && !r.on.includes("06:00"), r.u.digest_times.join(","));

  r = await b.run(`${SERVER} for (const t of ['07:00', '10:00', '12:00', '16:00', '21:00', '22:00']) {
      if (!pressed().includes(t)) { click('[data-value="' + t + '"]'); await wait(150); } }
    await settled(); return { u: await server(), on: pressed(), toast: text('#toast') };`);
  check("at most 5 times: the 6th tap is refused with a friendly message", r.u.digest_times.length === 5 && r.on.length === 5 &&
    /Up to 5 times a day/.test(r.toast), `${r.u.digest_times.join(",")} / ${r.toast}`);

  r = await b.run(`${SERVER} for (const t of pressed()) { click('[data-value="' + t + '"]'); await wait(150); }
    await settled(); return { u: await server(), on: pressed(), toast: text('#toast') };`);
  check("at least 1 time: removing the last one is refused", r.u.digest_times.length === 1 && r.on.length === 1 &&
    /at least one digest time/.test(r.toast), `${r.u.digest_times.join(",")} / ${r.toast}`);

  r = await b.run(`${SERVER} click('#pause-row'); await settled(); return { u: await server(), hero: text('#hero') };`);
  check("pause saved and shown", r.u.paused === true && /Paused/.test(r.hero), r.hero.trim().replace(/\s+/g, " "));
  r = await b.run(`${SERVER} click('#pause-row'); await settled(); return { u: await server(), hero: text('#hero') };`);
  check("resume saved, next digest shown", r.u.paused === false && /Next digest/.test(r.hero), r.hero.trim().replace(/\s+/g, " "));

  r = await b.run(ICON_OFFSETS);
  const worst = Math.max(...r.flatMap((x) => [x.dx, x.dy, x.boxDx, x.boxDy].map(Math.abs)));
  check("every icon is centred in its rounded square (within 0.5 px)", r.length >= 3 && worst <= 0.5,
    r.map((x) => `${x.name}: ${x.dx},${x.dy}`).join("; "));

  r = await b.run(`const res = await fetch('/api/admin', { headers: { authorization: 'tma ' + Telegram.WebApp.initData } }); return res.status;`);
  check("friend calling the admin API directly gets 403", r === 403, String(r));
  r = await b.run(`const res = await fetch('/api/settings', { method: 'POST', headers: { authorization: 'tma ' + Telegram.WebApp.initData,
    'content-type': 'application/json' }, body: JSON.stringify({ digest_times: ['09:30'] }) }); return [res.status, (await res.json()).error];`);
  check("the server refuses a half-hour time too", r[0] === 400 && /on the hour/.test(r[1]), r.join(" "));
  check("no console errors (friend)", b.consoleErrors().length === 0, JSON.stringify(b.consoleErrors()[0]?.params ?? "").slice(0, 200));

  await b.open(`${BASE}/app/?theme=dark&as=owner`, "dark");
  r = await b.run(`return { chip: getComputedStyle(document.querySelector('[data-action=time][aria-pressed=true]')).backgroundColor,
    icon: getComputedStyle(document.querySelector('.row-icon.tile')).color };`);
  check("dark mode: brighter red fill and light red icons", r.chip === "rgb(208, 35, 42)" && r.icon === "rgb(255, 107, 107)", `${r.chip} / ${r.icon}`);
  r = await b.run(ICON_OFFSETS);
  check("dark mode: icons centred too", Math.max(...r.flatMap((x) => [x.dx, x.dy].map(Math.abs))) <= 0.5, r.map((x) => `${x.dx},${x.dy}`).join("; "));
  r = await b.run(`click('[data-value=admin]'); await until(() => document.querySelector('.status'));
    const bad = document.querySelector('.badge.bad');
    const res = { editor: document.body.innerText.includes('Editor pass'), bad: bad ? getComputedStyle(bad).color : null };
    const calls0 = (window.__calls || []).length;
    click('[data-action=digest-now]'); await until(() => /Sent/.test(text('#toast')));
    res.t1 = text('#toast');
    res.confirmed = (window.__calls || []).slice(calls0).some((c) => c.startsWith('confirm'));
    click('[data-action=run-job]'); await until(() => /news job|Started/.test(text('#toast')));
    res.t2 = text('#toast');
    return res;`);
  check("Admin shows the editor pass", r.editor);
  check("Admin failure badges are orange, not red", r.bad === "rgb(255, 154, 92)", String(r.bad));
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
console.log(results.join("\n"));
console.log(failed ? `${failed} check(s) failed` : `all ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
