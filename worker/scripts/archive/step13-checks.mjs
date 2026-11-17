// Step 13: the real AI topic check on 20 realistic topics and 4 that must be refused, from this PC with
// the keys in ../.env (the same code the Worker runs: src/custom.js checkPrompt + askAI). Writes
// nothing to D1; the answers (verdict, names, searches, cap, tokens) go to
// reports/data/step-13/checks.json for the report and for scripts/custom_topics_measure.py.
//   node scripts/step13-checks.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { loadEnv } from "../digest-cli.mjs";
import { askAI, checkPrompt } from "../../src/custom.js";
import { TOPIC_ROWS } from "../../test/helpers.mjs";

const OUT = new URL("../../../reports/data/step-13/", import.meta.url);
const env = loadEnv();
if (!env.GEMINI_API_KEY) { console.error("GEMINI_API_KEY missing in .env"); process.exit(1); }
const mainTopics = TOPIC_ROWS.map(([tag, label_en]) => ({ tag, label_en }));
const TOPICS = ["Colombia", "AI regulation", "Formula 1", "Brazil", "Climate policy", "Elon Musk", "Champions League",
  "Space exploration", "Bitcoin", "Taiwan", "Nigeria", "EU enlargement", "Chess", "Japan", "Cybersecurity",
  "Mexico", "Oil prices", "Pope Leo", "Electric cars", "Georgia (country)"];
const REFUSE = ["asdfgh qwerty", "my neighbour Ashot", "Armenian news", "Colombian news"];
// --only "A,B": re-check a few names after a prompt change (writes checks-retest.json instead)
const onlyArg = process.argv.indexOf("--only");
const ONLY = onlyArg > 0 ? process.argv[onlyArg + 1].split(",").map((x) => x.trim()) : null;

const out = [];
const existing = [];
const now = Math.floor(Date.now() / 1000);
for (const input of ONLY ?? [...TOPICS, ...REFUSE]) {
  const lang = input === "my neighbour Ashot" ? "ru" : "en";
  const prompt = checkPrompt({ input, lang, mainTopics, existing, now });
  const t0 = Date.now();
  const { answer, calls } = await askAI(env, prompt, lang, now);
  const last = calls.at(-1) ?? {};
  out.push({ input, lang, ms: Date.now() - t0, model: last.model, calls: calls.length, input_tokens: last.input_tokens,
    output_tokens: last.output_tokens, errors: calls.filter((c) => c.error).map((c) => c.error),
    verdict: answer?.verdict, reason_code: answer?.reasonCode, reason: answer?.reason, same_as: answer?.sameAs,
    names: answer?.names, emoji: answer?.emoji, definition: answer?.definition, queries: answer?.queries, boost_max: answer?.boostMax });
  if (answer?.verdict === "accept" && !answer.sameAs && TOPICS.includes(input)) {
    existing.push({ tag: `c${existing.length + 1}`, names: JSON.stringify(answer.names) });
  }
  const r = out.at(-1);
  console.log(`${input}: ${r.verdict}${r.same_as ? ` same as ${r.same_as}` : ""} ${r.reason_code} | ${r.names?.en ?? ""} ${r.emoji ?? ""} ` +
    `| ${r.queries?.length ?? 0} searches ${JSON.stringify(r.queries?.map((q) => `${q.q} [${q.ed}]`))} | cap ${r.boost_max} | ` +
    `${r.input_tokens} in, ${r.output_tokens} out, ${r.ms} ms${r.errors.length ? ` | errors: ${r.errors.join("; ")}` : ""}`);
}
mkdirSync(OUT, { recursive: true });
writeFileSync(new URL(ONLY ? "checks-retest.json" : "checks.json", OUT), JSON.stringify(out, null, 1));
const ok = out.filter((r) => r.input_tokens);
const avg = (k) => Math.round(ok.reduce((a, r) => a + (r[k] ?? 0), 0) / ok.length);
console.log(`\n${out.length} checks, ${out.reduce((a, r) => a + r.calls, 0)} calls; average ${avg("input_tokens")} tokens in, ` +
  `${avg("output_tokens")} out, ${avg("ms")} ms`);
