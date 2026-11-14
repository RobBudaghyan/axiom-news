// Local preview of the Mini App with the REAL Worker API code over an in-memory database filled
// with made-up demo data (no real users, no network: Telegram and GitHub calls are faked).
// Telegram itself is replaced by scripts/dev/mock-telegram.js. Used for the screenshots.
//
//   node scripts/dev-server.mjs            then open http://localhost:8790/app/?theme=dark&as=owner
//   query: theme=light|dark, as=owner|friend, confirm=0 (the confirm popup answers Cancel)
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";
import { signInitData } from "../src/auth.js";
import { nextSlot } from "../src/digest.js";
import { ALL, addStory, fakeD1 } from "../test/helpers.mjs";

const PORT = Number(process.env.PORT || 8790);
const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PUBLIC = join(ROOT, "public");
const TOKEN = "100000:local-preview-token";   // not a real bot token
const OWNER = 42, FRIEND = 101;   // FRIEND = the demo user "Ani"
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

// ------------------------------------------------------------------ demo data (all invented)
function seed() {
  const { binding, sqlite } = fakeD1();
  const now = Math.floor(Date.now() / 1000);
  const H = 3600;
  const user = sqlite.prepare("INSERT INTO users (id, first_name, timezone, tz_detected, digest_times, max_stories, topics, " +
    "paused, blocked, created_at, last_digest_at, next_digest_at, format) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const people = [
    [OWNER, "Sam", "Asia/Yerevan", 1, ["09:00", "14:00", "20:00"], 7, ALL, 0, 0, null],
    [101, "Ani", "Asia/Yerevan", 1, ["08:30", "19:00"], 5, ["armenia", "politics", "russia"], 0, 0, null],
    [102, "David", "Europe/Berlin", 1, ["07:30", "13:00", "21:00"], 10, ALL, 0, 0, "A"],
    [103, "Mariam", "America/Los_Angeles", 2, ["09:00"], 7, ["iran_war", "wars_conflicts"], 1, 0, null],
    [104, "Narek", "Asia/Yerevan", 0, ["09:00", "14:00", "20:00"], 7, ALL, 0, 1, null],
    [105, "Lilit", "Europe/London", 1, ["08:00", "12:30", "18:00", "22:00"], 12, ALL, 0, 0, null],
  ];
  for (const [id, name, tz, det, times, n, topics, paused, blocked, format] of people) {
    user.run(id, name, tz, det, JSON.stringify(times), n, JSON.stringify(topics), paused, blocked, now - 9 * 86400,
      blocked ? now - 5 * 86400 : now - (2 + id % 5) * H, nextSlot(now, tz, times), format);
  }
  // 7 days of hourly runs at about :07
  const run = sqlite.prepare("INSERT INTO job_runs (started_at, finished_at, status, feeds_ok, feeds_failed, items_fetched, " +
    "items_new, items_pending_in, stories_created, stories_merged, items_dropped, items_expired, items_left_pending, provider, " +
    "ai_calls, input_tokens, output_tokens, d1_rows_read, d1_rows_written, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?)");
  const call = sqlite.prepare("INSERT INTO ai_calls (run_id, at, provider, model, ok, items, input_tokens, output_tokens, ms, error) " +
    "VALUES (?,?,?,?,?,?,?,?,?,?)");
  const hourStart = Math.floor(now / H) * H;
  let rnd = 7;
  const r = (a, b) => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return a + (rnd % (b - a + 1)); };
  for (let k = 168; k >= 0; k--) {
    const start = hourStart - k * H + 7 * 60 + r(0, 50);
    if (start > now) continue;
    const kind = k === 70 ? "ai_failed" : k % 23 === 5 ? "partial" : "ok";
    const provider = kind === "ai_failed" ? null : k % 9 === 0 ? "gemini+gemini-fallback+groq" : k % 4 === 0 ? "gemini+gemini-fallback" : "gemini";
    const fetched = r(150, 260), fresh = fetched - r(10, 40), created = kind === "ai_failed" ? 0 : r(28, 62);
    const calls = provider ? provider.split("+").length + (k % 3 === 0 ? 1 : 0) : 2;
    const tin = provider ? r(21000, 27000) * calls : 0, tout = provider ? r(9000, 16000) * Math.min(calls, 2) : 0;
    const info = run.run(start, start + r(42, 130), kind, 114, 1, fetched, fresh, fresh, created, kind === "ai_failed" ? 0 : r(9, 26),
      kind === "ai_failed" ? 0 : r(60, 130), kind === "ai_failed" ? fresh : kind === "partial" ? r(5, 30) : 0, provider, calls,
      tin, tout, r(2600, 4800), r(700, 1300), kind === "ai_failed" ? "every AI provider failed; items wait for the next run" : null);
    const id = Number(info.lastInsertRowid);
    const models = provider ? provider.split("+") : ["gemini", "gemini-fallback"];
    for (const [i, p] of models.entries()) {
      const model = p === "gemini" ? "gemini-3.5-flash-lite" : p === "gemini-fallback" ? "gemini-3.1-flash-lite" : "openai/gpt-oss-120b";
      const ok = kind === "ai_failed" ? 0 : i === models.length - 1 ? 1 : (k % 4 === 0 ? 0 : 1);
      call.run(id, start + 20 + i * 40, p === "gemini-fallback" ? "gemini" : p, model, ok, fresh, ok ? r(20000, 26000) : null,
        ok ? r(9000, 15000) : null, r(6000, 80000), ok ? null : "HTTP 503: This model is currently experiencing high demand");
    }
  }
  const err = sqlite.prepare("INSERT INTO errors (at, component, message) VALUES (?, ?, ?)");
  err.run(now - 70 * H, "job", "every AI provider failed; items wait for the next run");
  err.run(now - 26 * H, "worker", "digest for user 104: Telegram sendMessage HTTP 403: Forbidden: bot was blocked by the user");
  for (let k = 9; k >= 0; k--) {
    err.run(now - k * 3 * H - 1200, "job", `gemini: answer skipped ${r(4, 25)} of ${r(120, 230)} items; resending them`);
  }
  err.run(now - 2 * H, "job", "gemini: HTTP 503: This model is currently experiencing high demand");
  // feed health: invented failing and silent examples on top of real outlet names
  const names = ["BBC News", "The Guardian", "Al Jazeera", "France 24", "Deutsche Welle", "Kyiv Independent", "Meduza", "TASS",
    "Times of Israel", "CivilNet", "Azatutyun", "OC Media", "Politico Europe", "NPR", "Euronews", "Iran International"];
  const feeds = {};
  for (let i = 0; i < 115; i++) {
    const name = names[i % names.length];
    feeds[`feed_${i}`] = { n: name, ok: now - 1200, item: now - r(300, 9000), err: null, since: null, fails: 0 };
  }
  feeds.feed_8 = { n: "Times of Israel", ok: now - 4 * 86400, item: now - 4 * 86400, err: "HTTP 403", since: now - 4 * 86400, fails: 96 };
  feeds.feed_20 = { n: "Azatutyun", ok: now - 3 * H, item: now - 3 * H, err: "fetch error: ReadTimeout", since: now - 2 * H - 1200, fails: 2 };
  feeds.feed_42 = { n: "Iran International", ok: now - 1200, item: now - 3 * 86400, err: null, since: null, fails: 0 };
  sqlite.prepare("INSERT INTO meta (key, value) VALUES ('feed_health', ?), ('d1_worker', ?)")
    .run(JSON.stringify({ at: now - 1200, feeds }), JSON.stringify({ day: Math.floor(now / 86400), r: 6120, w: 214 }));
  // a few stories, so "Send me a digest now" has something to send
  const S = [["Ukraine and Russia agree to a new prisoner exchange", ["ukraine_war", "wars_conflicts"], 8],
    ["Armenian parliament passes the 2027 budget", ["armenia", "politics"], 6],
    ["Iran says talks with the US will resume next week", ["iran_war", "politics"], 7]];
  for (const [s, t, imp] of S) addStory(sqlite, s, t, imp, now - 1800);
  return binding;
}

const DB = seed();
const env = { DB, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: "x".repeat(40), OWNER_TELEGRAM_ID: String(OWNER),
  GITHUB_DISPATCH_TOKEN: "none", GITHUB_REPO: "demo/demo", GITHUB_WORKFLOW: "hourly.yml", GITHUB_REF: "main" };

// No real network: Telegram and GitHub answer "ok".
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("https://api.telegram.org/")) return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  if (u.startsWith("https://api.github.com/")) return new Response(null, { status: 204 });
  return realFetch(url, init);
};

async function page(query) {
  const as = query.get("as") === "friend" ? FRIEND : OWNER;
  const name = as === OWNER ? "Sam" : "Ani";
  const initData = await signInitData({ query_id: "AAHdev", auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: as, first_name: name, language_code: "en" }) }, TOKEN);
  const mock = { initData, theme: query.get("theme") === "dark" ? "dark" : "light", confirm: query.get("confirm") !== "0" };
  return readFileSync(join(PUBLIC, "app", "index.html"), "utf8").replace(
    /<script src="https:\/\/telegram\.org\/js\/telegram-web-app\.js[^"]*"><\/script>/,
    `<script>window.__MOCK=${JSON.stringify(mock)}</script><script src="/__mock/telegram.js"></script>`);
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const r = await worker.fetch(new Request(url, { method: req.method, headers: req.headers, body }), env);
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    if (url.pathname === "/" || url.pathname === "/app") { res.writeHead(302, { location: "/app/" }); res.end(); return; }
    if (url.pathname === "/app/" || url.pathname === "/app/index.html") {
      res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
      res.end(await page(url.searchParams));
      return;
    }
    if (url.pathname === "/__mock/telegram.js") {
      res.writeHead(200, { "content-type": TYPES[".js"] });
      res.end(readFileSync(join(ROOT, "scripts", "dev", "mock-telegram.js")));
      return;
    }
    const file = normalize(join(PUBLIC, url.pathname));
    if (file.startsWith(PUBLIC) && existsSync(file) && !file.endsWith("_headers")) {
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(readFileSync(file));
      return;
    }
    res.writeHead(404); res.end("not found");
  } catch (e) {
    res.writeHead(500); res.end(String(e.stack || e));
  }
}).listen(PORT, () => console.log(`Mini App preview: http://localhost:${PORT}/app/?theme=light&as=owner`));
