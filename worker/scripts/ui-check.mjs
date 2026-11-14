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
  const settled = async () => { await wait(700); };`;

const b = await openBrowser();
try {
  await b.open(`${BASE}/app/?theme=light&as=friend`);
  const start = await b.run(`${SERVER} return await server();`);
  check("friend sees no Admin tab", await b.run("return !document.querySelector('#tabs');"));
  check("time zone saved from the device on open", start.tz_source === "device", start.timezone);

  let r = await b.run(`${SERVER} click('[data-value=wars_conflicts]'); await settled(); return { u: await server(), toast: text('#toast') };`);
  check("topic switched on is saved", r.u.topics.includes("wars_conflicts"), r.u.topics.join(","));
  check("a subtle 'Saved' confirmation appears", /Saved/.test(r.toast), r.toast);

  r = await b.run(`${SERVER} for (const t of ['politics', 'armenia', 'russia']) { click('[data-value=' + t + ']'); await wait(120); }
    await settled(); click('[data-value=wars_conflicts]'); await wait(300);
    return { u: await server(), toast: text('#toast'), on: document.querySelector('[data-value=wars_conflicts]').getAttribute('aria-checked') };`);
  check("the last topic cannot be switched off", r.u.topics.length === 1 && r.on === "true" && /at least one topic/.test(r.toast),
    `${r.u.topics.join(",")} / ${r.toast}`);

  const before = await b.run(`${SERVER} return await server();`);
  r = await b.run(`${SERVER} click('[data-action=add-time]'); await wait(450);
    const backShown = Telegram.WebApp.BackButton.isVisible;
    click('[data-value="18:30"]'); await wait(100);
    const mainText = Telegram.WebApp.MainButton.text;
    document.querySelector('[data-mock=main-button] button').click(); await settled();
    return { u: await server(), backShown, mainText, screenGone: !document.querySelector('#screen'), backAfter: Telegram.WebApp.BackButton.isVisible };`);
  check("Add a time: BackButton shown, MainButton says 'Add 18:30'", r.backShown && r.mainText === "Add 18:30", r.mainText);
  check("Add a time: 18:30 saved, screen closed, BackButton hidden", r.u.digest_times.includes("18:30") && r.screenGone && !r.backAfter,
    r.u.digest_times.join(","));
  check("next digest recomputed after a time change (18:30 comes before 19:00)", r.u.next_digest_at < before.next_digest_at,
    `${before.next_digest_at} -> ${r.u.next_digest_at}`);

  r = await b.run(`${SERVER} click('[data-action=remove-time][data-value="08:30"]'); await settled(); return await server();`);
  check("removing a time is saved", !r.digest_times.includes("08:30"), r.digest_times.join(","));

  r = await b.run(`${SERVER} const n = (await server()).max_stories; click('[data-action=step][data-value="1"]'); await wait(80);
    click('[data-action=step][data-value="1"]'); await wait(1000); return { n, u: await server(), shown: text('#stories-num') };`);
  check("stepper: two quick taps save +2 once", r.u.max_stories === r.n + 2 && r.shown === String(r.n + 2), `${r.n} -> ${r.u.max_stories}`);

  r = await b.run(`${SERVER} click('[data-action=format][data-value=A]'); await settled(); return await server();`);
  check("format A saved", r.format === "A");

  r = await b.run(`${SERVER} click('[data-action=open-tz]'); await wait(450);
    const pop = document.querySelectorAll('#tz-list [data-action=pick-tz]').length;
    const q = document.querySelector('#tz-q'); q.value = 'berl'; q.dispatchEvent(new Event('input', { bubbles: true })); await wait(50);
    const hits = [...document.querySelectorAll('#tz-list [data-action=pick-tz]')].map((x) => x.dataset.value);
    click('#tz-list [data-value="Europe/Berlin"]'); await settled();
    return { pop, hits, u: await server(), foot: document.body.innerText.includes('Use it') };`);
  check("time zone search finds Berlin", r.hits.includes("Europe/Berlin"), `${r.pop} popular, hits: ${r.hits.join(",")}`);
  check("picked zone saved as chosen by hand", r.u.timezone === "Europe/Berlin" && r.u.tz_source === "manual", `${r.u.timezone}/${r.u.tz_source}`);
  check("'Use it' offered to go back to the phone's zone", r.foot);
  r = await b.run(`${SERVER} click('[data-action=use-device-tz]'); await settled(); return await server();`);
  check("'Use it' restores the device zone", r.tz_source === "device", r.timezone);

  r = await b.run(`${SERVER} click('#pause-row'); await settled(); return { u: await server(), hero: text('#hero') };`);
  check("pause saved and shown", r.u.paused === true && /Paused/.test(r.hero), r.hero.trim().replace(/\s+/g, " "));
  r = await b.run(`${SERVER} click('#pause-row'); await settled(); return { u: await server(), hero: text('#hero') };`);
  check("resume saved, next digest shown", r.u.paused === false && /Next digest/.test(r.hero), r.hero.trim().replace(/\s+/g, " "));

  r = await b.run(`const res = await fetch('/api/admin', { headers: { authorization: 'tma ' + Telegram.WebApp.initData } }); return res.status;`);
  check("friend calling the admin API directly gets 403", r === 403, String(r));
  check("no console errors (friend)", b.consoleErrors().length === 0, JSON.stringify(b.consoleErrors()[0]?.params ?? "").slice(0, 200));

  await b.open(`${BASE}/app/?theme=dark&as=owner`, "dark");
  r = await b.run(`click('[data-value=admin]'); await until(() => document.querySelector('.status'));
    const calls0 = (window.__calls || []).length;
    click('[data-action=digest-now]'); await until(() => /Sent/.test(text('#toast')));
    const t1 = text('#toast');
    const confirmed = (window.__calls || []).slice(calls0).some((c) => c.startsWith('confirm'));
    click('[data-action=run-job]'); await until(() => /news job|Started/.test(text('#toast')));
    return { t1, t2: text('#toast'), confirmed };`);
  check("owner: Send me a digest now asks first, then sends", r.confirmed && /Sent: \d+ stor/.test(r.t1), r.t1);
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
