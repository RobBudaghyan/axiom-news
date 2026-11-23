// Step 19 Part 2: asks the real topic-check AI (the Worker's own prompt and providers, keys from
// ../.env) about names a reader might type, and prints what the Worker would do. No D1 reads or
// writes. Uses about one Gemini call a name.
//   node scripts/step19-topic-check.mjs [name ...]
import { readFileSync } from "node:fs";
import { askAI, checkPrompt, mainMatch, normName } from "../src/custom.js";
import { loadEnv } from "./digest-cli.mjs";
import CFG from "../../config/custom_topics.json" with { type: "json" };

const env = loadEnv();
const yaml = readFileSync(new URL("../../config/topics.yaml", import.meta.url), "utf8");
const mainTopics = [...yaml.matchAll(/\n  - tag: (\w+)\n    label: \{en: "([^"]+)"/g)].map((m) => ({ tag: m[1], label_en: m[2] }));
const names = process.argv.slice(2).length ? process.argv.slice(2) :
  ["Stocks", "Finance", "Crypto", "Oil", "AI startups", "AI", "Armenian diaspora", "Banking", "Business",
   "Economic news", "Tech news", "Новости технологий", "Russia", "World news"];
const now = Math.floor(Date.now() / 1000);
for (const name of names) {
  const code = mainMatch(normName(name), mainTopics);
  if (code) { console.log(`${name.padEnd(20)} -> main topic ${code.tag} (no AI call)`); continue; }
  const { answer, calls } = await askAI(env, checkPrompt({ input: name, lang: "en", mainTopics, existing: [], now }), "en", now);
  const partOnly = (CFG.not_main ?? []).some((x) => normName(x) === normName(name));
  const kind = !answer ? `failed (${calls.map((c) => c.error).join("; ")})` :
    answer.sameAs && !(partOnly && answer.names.en) ? `main topic ${answer.sameAs}` :
    answer.verdict === "reject" ? `rejected: ${answer.reasonCode}` : `added as "${answer.names.en}" ${answer.emoji} boost ${answer.boostMax}`;
  console.log(`${name.padEnd(20)} -> ${kind}  [${calls.map((c) => c.model).join(", ")}]`);
}
