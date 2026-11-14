// Minimal headless Edge/Chrome driver over the DevTools protocol (Node's built-in WebSocket), shared
// by scripts/screenshots.mjs and scripts/ui-check.mjs. Nothing extra to install.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BROWSERS = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium"];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Helpers available inside page scripts passed to run(): wait(ms), click(selector), until(fn), text(selector)
const PAGE_HELPERS = `const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (s) => { const el = typeof s === 'string' ? document.querySelector(s) : s; if (!el) throw new Error('missing ' + s); el.click(); };
  const until = (f, ms = 8000) => new Promise((ok, no) => { const t = Date.now(); (function g() { let v; try { v = f(); } catch {}
    if (v) return ok(v); if (Date.now() - t > ms) return no(new Error('timeout: ' + f)); setTimeout(g, 40); })(); });
  const text = (s) => (document.querySelector(s) || {}).textContent || '';`;

export async function openBrowser({ width = 390, height = 844, scale = 2, port = 9333 } = {}) {
  const exe = BROWSERS.find(existsSync);
  if (!exe) throw new Error("no Edge or Chrome found");
  const profile = mkdtempSync(join(tmpdir(), "axiom-cdp-"));
  const proc = spawn(exe, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--disable-extensions", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch { /* starting */ }
  }
  if (!target) { proc.kill(); throw new Error("browser did not start"); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } else events.push(msg);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  const metrics = (h) => send("Emulation.setDeviceMetricsOverride", { width, height: h, deviceScaleFactor: scale, mobile: true });

  return {
    events,
    evaluate,
    // Opens a URL in light or dark mode and waits until the app has rendered its first section.
    async open(url, scheme = "light") {
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
      await metrics(height);
      events.length = 0;
      await send("Page.navigate", { url });
      for (let i = 0; i < 100 && !events.some((e) => e.method === "Page.loadEventFired"); i++) await sleep(50);
      await evaluate(`(async () => { ${PAGE_HELPERS} await until(() => document.querySelector('#view .section, .empty')); })()`);
    },
    run: (body) => evaluate(`(async () => { ${PAGE_HELPERS} ${body} })()`),
    async screenshot(full) {
      let h = height;
      if (full) { h = await evaluate("Math.ceil(document.documentElement.scrollHeight)"); await metrics(h); await sleep(250); }
      const shot = await send("Page.captureScreenshot", { format: "png" });
      return { png: Buffer.from(shot.data, "base64"), height: h };
    },
    consoleErrors: () => events.filter((e) => e.method === "Runtime.exceptionThrown" ||
      (e.method === "Runtime.consoleAPICalled" && e.params.type === "error")),
    async close() {
      try { ws.close(); } catch { /* closed */ }
      proc.kill();
      await sleep(400);
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* still locked */ }
    },
  };
}
