// Step 16 Part 2: reads a `wrangler tail --format json` capture and prints, per event, its kind
// (cron tick or request), the CPU and wall time Cloudflare measured, the outcome and (for a tick)
// the tick's own summary log. Writes nothing.
//   node scripts/tail-cpu.mjs <capture file>
import { readFileSync } from "node:fs";

const text = readFileSync(process.argv[2], "utf8");
const events = [];
let depth = 0, start = -1, inStr = false, esc = false;
for (let i = 0; i < text.length; i++) {   // the capture is a stream of (pretty-printed) JSON objects
  const c = text[i];
  if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
  if (c === '"') inStr = true;
  else if (c === "{") { if (depth++ === 0) start = i; }
  else if (c === "}" && --depth === 0) { try { events.push(JSON.parse(text.slice(start, i + 1))); } catch { /* partial line */ } }
}
const rows = events.map((e) => {
  const tick = e.event?.cron;
  const summary = (e.logs ?? []).map((l) => l.message?.[0]).find((m) => typeof m === "string" && m.startsWith("{\"tick\""));
  return {
    at: new Date(e.eventTimestamp).toISOString().slice(11, 19),
    kind: tick ? `cron ${tick}` : `${e.event?.request?.method ?? "?"} ${new URL(e.event?.request?.url ?? "http://x/").pathname}`,
    cpu_ms: e.cpuTime ?? null, wall_ms: e.wallTime ?? null, outcome: e.outcome,
    tick: summary ? JSON.parse(summary) : undefined,
  };
});
for (const r of rows) {
  const t = r.tick ? ` due ${r.tick.due} sent ${r.tick.sent} stories ${r.tick.stories} cut ${r.tick.cut}${r.tick.all_off ? ` all_off ${r.tick.all_off}` : ""}` : "";
  console.log(`${r.at}  ${r.kind.padEnd(22)} cpu ${String(r.cpu_ms).padStart(4)} ms  wall ${String(r.wall_ms).padStart(5)} ms  ${r.outcome}${t}`);
}
const cpus = (f) => rows.filter(f).map((r) => r.cpu_ms).filter((x) => x != null);
const sum = (name, list) => list.length && console.log(`${name}: ${list.length} events, CPU min ${Math.min(...list)} ms, median ${[...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]} ms, max ${Math.max(...list)} ms`);
sum("cron ticks with digests", cpus((r) => r.tick && r.tick.sent > 0));
sum("POST /api/open", cpus((r) => r.kind === "POST /api/open"));
console.log(`exceeded CPU: ${rows.filter((r) => /exceeded/i.test(r.outcome)).length}`);
