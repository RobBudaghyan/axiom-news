// Step 14: the Worker's part of the custom-topic keyword rule. The topic check also writes 5-15
// match keywords in English and Russian (custom_topics.keywords); the hourly job uses them
// (job/custom.py KeywordRule). Cleaning is the same as the job's (tests/fixtures/keyword_cases.json).
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import worker from "../src/index.js";
import { signInitData } from "../src/auth.js";
import { CHECK_SCHEMA, KEYWORDS_INSTRUCTION, MIN_KEYWORDS, checkPrompt, cleanKeywords, validateAnswer } from "../src/custom.js";
import { OWNER, addUser, fakeD1, mockFetch } from "./helpers.mjs";
import { geminiResponse, isGemini, isGroq, promptOf, topicAnswer } from "./fake-ai.mjs";

const TOKEN = "123456:TEST-token-for-unit-tests";
const A = 701;
let fetchMock;
afterEach(() => fetchMock?.restore());
const nowS = () => Math.floor(Date.now() / 1000);
const initFor = (id) => signInitData({ query_id: "AAE1", auth_date: String(nowS()), signature: "sig",
  user: JSON.stringify({ id, first_name: `U${id}`, language_code: "en" }) }, TOKEN);
const env = (binding) => ({ DB: binding, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_WEBHOOK_SECRET: "s".repeat(40),
  OWNER_TELEGRAM_ID: String(OWNER), GITHUB_DISPATCH_TOKEN: "GH", GITHUB_REPO: "o/r", GITHUB_WORKFLOW: "hourly.yml",
  GEMINI_API_KEY: "test-key", GROQ_API_KEY: "test-groq" });
async function add(binding, id, name) {
  const res = await worker.fetch(new Request("https://w.test/api/topics/add", { method: "POST",
    headers: { authorization: `tma ${await initFor(id)}` }, body: JSON.stringify({ name }) }), env(binding));
  return { status: res.status, body: await res.json() };
}
function ai(edit = (x) => x) {
  return mockFetch((url, init, body) => {
    if (isGemini(url) || isGroq(url)) return { status: 200, body: geminiResponse(edit(topicAnswer(promptOf(body)))) };
    return undefined;
  });
}
const prompts = () => fetchMock.calls.filter((c) => isGemini(c.url) || isGroq(c.url)).map((c) => promptOf(JSON.parse(c.init.body)));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("Step 14: keywords from the topic check", () => {
  test("the check asks for 5-15 keywords in en and ru with the job's own words, and the schema requires them", async () => {
    const d = fakeD1();
    addUser(d.sqlite, { id: A, first_name: "U" });
    fetchMock = ai();
    await add(d.binding, A, "Japan");
    const p = prompts()[0];
    assert.ok(p.includes("5 to 15 match keywords in English (en) and 5 to 15 in Russian (ru)"));
    assert.ok(p.includes("Takaichi, BOJ, Yen;"));
    assert.ok(CHECK_SCHEMA.required.includes("keywords"));
    const py = readFileSync(`${ROOT}job/custom.py`, "utf8");
    const pyText = /KEYWORDS_INSTRUCTION = """([\s\S]*?)"""/.exec(py)[1];
    assert.equal(KEYWORDS_INSTRUCTION, pyText, "the Worker and the job's backfill ask the same thing");
  });

  test("an accepted topic is saved with its keywords, its own names first", async () => {
    const d = fakeD1();
    addUser(d.sqlite, { id: A, first_name: "U" });
    fetchMock = ai();
    const r = await add(d.binding, A, "Japan");
    assert.equal(r.status, 200);
    const kw = JSON.parse(d.sqlite.prepare("SELECT keywords FROM custom_topics").get().keywords);
    assert.deepEqual(kw.en.slice(0, 4), ["Japan", "Japanese", "Tokyo", "Takaichi"]);
    assert.deepEqual(kw.ru, ["Япония", "японский", "Токио"]);
  });

  test("too few keywords: saved as NULL so the hourly job asks again (one call)", async () => {
    const d = fakeD1();
    addUser(d.sqlite, { id: A, first_name: "U" });
    fetchMock = ai((x) => ({ ...x, keywords: { en: ["Tokyo", "Yen"], ru: [] } }));
    await add(d.binding, A, "Japan");
    assert.equal(d.sqlite.prepare("SELECT keywords FROM custom_topics").get().keywords, null);
    const a = validateAnswer({ ...topicAnswer('The reader typed: "Japan"\n'), keywords: undefined }, "en");
    assert.equal(a.keywords, null);
    assert.equal(MIN_KEYWORDS, 5);
  });

  test("cleaning agrees with the job on 300 shared cases (tests/fixtures/keyword_cases.json)", () => {
    const cases = JSON.parse(readFileSync(`${ROOT}tests/fixtures/keyword_cases.json`, "utf8"));
    assert.equal(cases.length, 300);
    for (const c of cases) assert.deepEqual(cleanKeywords(c.raw, c.names), c.want, JSON.stringify(c.raw));
  });

  test("no keyword ever has an em or en dash, and at most 15 a language", () => {
    const kw = cleanKeywords({ en: ["Japan — Tokyo", "Kyoto – Osaka", ...Array.from({ length: 30 }, (_, i) => `Word${i}`)], ru: ["Япония—"] },
                             { en: "Japan", ru: "Япония" });
    assert.ok(![...kw.en, ...kw.ru].some((w) => /[‒–—―]/.test(w)));
    assert.equal(kw.en.length, 15);
  });

  test("the prompt still lists keywords when the reader writes in Russian", () => {
    const p = checkPrompt({ input: "Япония", lang: "ru", mainTopics: [], existing: [], now: 1 });
    assert.ok(p.includes("keywords: 5 to 15"));
  });
});
