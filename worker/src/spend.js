// Step 20: the paid emergency Gemini key (GEMINI_EMERGENCY_API_KEY), the Worker's twin of job/chain.py.
// Used ONLY when every free option failed for a call. Hard caps per UTC day and month and the credits
// left (config/ai_budget.json "emergency"), checked BEFORE a call against its worst case: the prompt
// and the whole answer size at the price. Every paid call is a row in ai_spend (the job writes its own).
// Pure functions and SQL; no Intl.
import BUDGET from "../../config/ai_budget.json" with { type: "json" };

const DAY = 86400;
export const EM = BUDGET.emergency ?? {};

export const SPEND_SQL = "SELECT coalesce(sum(CASE WHEN at >= ?1 THEN usd END), 0) AS day, " +
  "coalesce(sum(CASE WHEN at >= ?2 THEN usd END), 0) AS month, coalesce(sum(usd), 0) AS total, " +
  "count(CASE WHEN at >= ?1 THEN 1 END) AS day_calls, max(at) AS last_at FROM ai_spend";

export const utcDayStart = (ts) => ts - (ts % DAY);
export function utcMonthStart(ts) {
  const d = new Date(ts * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
}
const isoDay = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

export function spendStatement(now) {
  return { sql: SPEND_SQL, params: [utcDayStart(now), utcMonthStart(now)] };
}

// USD per million [input, output] tokens; a later prices_from entry wins from its date (same as job/chain.py).
export function modelPrice(model, now, cfg = EM) {
  const prices = { ...(cfg.prices_per_million ?? {}) };
  const day = isoDay(now);
  for (const start of Object.keys(cfg.prices_from ?? {}).sort()) if (day >= start) Object.assign(prices, cfg.prices_from[start]);
  const p = prices[model] ?? cfg.unknown_price ?? [3, 15];
  return [Number(p[0]), Number(p[1])];
}

export function callCost(model, inTok, outTok, now, cfg = EM) {
  const [pin, pout] = modelPrice(model, now, cfg);
  return ((Number(inTok ?? 0) * pin) + (Number(outTok ?? 0) * pout)) / 1e6;
}

// Same estimate as job/ai.py estimate_tokens, with the job's 1.2x margin.
export function estimateTokens(text) {
  let arm = 0, non = 0;
  for (const ch of String(text ?? "")) {
    const c = ch.codePointAt(0);
    if (c >= 0x530 && c <= 0x58f) arm++;
    else if (c > 0x24f) non++;
  }
  const n = [...String(text ?? "")].length;
  return Math.floor((n - non - arm) / 4 + non / 2.5 + arm / 1.6) + 1;
}

export function worstCost(model, prompt, maxTokens, now, cfg = EM) {
  return callCost(model, Math.floor(estimateTokens(prompt) * 1.2) + 50, maxTokens, now, cfg);
}

// sums: {day, month, total} or null (unreadable). null = allowed, else why not (fail closed).
export function whyNot(sums, worst, now, cfg = EM) {
  if (!sums) return "the spend ledger could not be read";
  if (cfg.credits_expire && isoDay(now) >= cfg.credits_expire) return `the credits expired on ${cfg.credits_expire}`;
  if (Number(sums.day) + worst > Number(cfg.daily_cap_usd ?? 0)) return `daily cap $${Number(cfg.daily_cap_usd ?? 0).toFixed(2)} (spent $${Number(sums.day).toFixed(4)} today)`;
  if (Number(sums.month) + worst > Number(cfg.monthly_cap_usd ?? 0)) return `monthly cap $${Number(cfg.monthly_cap_usd ?? 0).toFixed(2)} (spent $${Number(sums.month).toFixed(4)} this month)`;
  if (Number(sums.total) + worst > Number(cfg.credits_usd ?? 0)) return `credits used up ($${Number(sums.total).toFixed(2)} of $${Number(cfg.credits_usd ?? 0).toFixed(2)})`;
  return null;
}

export function spendInsert({ at, model, kind, input_tokens, output_tokens, usd, reason }, source = "worker") {
  return {
    sql: "INSERT INTO ai_spend (at, source, model, kind, input_tokens, output_tokens, usd, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    params: [at, source, model, kind ?? null, input_tokens ?? null, output_tokens ?? null, Math.round(Number(usd) * 1e6) / 1e6,
             reason ? String(reason).slice(0, 300) : null],
  };
}

// For Admin: today, this month, the credits left (an estimate: $10 minus everything logged) and the expiry.
export function shapeSpend(row, now, cfg = EM) {
  const r = row ?? {};
  const total = Number(r.total ?? 0);
  return {
    today: Number(r.day ?? 0), month: Number(r.month ?? 0), total, calls_today: Number(r.day_calls ?? 0),
    last_at: r.last_at ?? null,
    daily_cap: Number(cfg.daily_cap_usd ?? 0), monthly_cap: Number(cfg.monthly_cap_usd ?? 0),
    credits: Number(cfg.credits_usd ?? 0), credits_left: Math.max(0, Number(cfg.credits_usd ?? 0) - total),
    bought: cfg.credits_bought ?? null, expires: cfg.credits_expire ?? null, model: cfg.model ?? null,
    translate_models: cfg.translate_models ?? [],
  };
}

// The hourly tick's reads for the alert: today's paid calls, and the day of the last alert.
export function spendAlertStatements(now) {
  return [
    { sql: "SELECT source, model, kind, usd, reason FROM ai_spend WHERE at >= ?1 ORDER BY at", params: [utcDayStart(now)] },
    { sql: "SELECT value FROM meta WHERE key = 'emergency_alert_day'", params: [] },
  ];
}

// One alert to the owner on any UTC day the emergency key spent money: the amount and why.
export function spendAlert(rows, metaRows, now, cfg = EM) {
  const day = isoDay(now);
  if (!rows?.length || metaRows?.[0]?.value === day) return null;
  const usd = rows.reduce((s, r) => s + Number(r.usd ?? 0), 0);
  const kinds = {};
  for (const r of rows) kinds[r.kind ?? "?"] = (kinds[r.kind ?? "?"] ?? 0) + 1;
  const why = [...new Set(rows.map((r) => r.reason).filter(Boolean))].slice(0, 2).join(" | ") || "every free option failed";
  const what = Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(", ");
  return {
    text: `Axiom News alert: the paid emergency Gemini key was used today: $${usd.toFixed(4)} so far (${rows.length} ` +
      `${rows.length === 1 ? "call" : "calls"}: ${what}). Caps: $${Number(cfg.daily_cap_usd ?? 0).toFixed(2)} a day, ` +
      `$${Number(cfg.monthly_cap_usd ?? 0).toFixed(2)} a month.\nWhy: ${why}.\n` +
      "What to do: nothing if it is one bad day (readers were served). If it repeats, check Admin > AI (which free models fail) " +
      "and that the main Gemini key is on the free tier. This is the only such alert today.",
    writes: [{ sql: "INSERT INTO meta (key, value) VALUES ('emergency_alert_day', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
               params: [day] }],
  };
}
