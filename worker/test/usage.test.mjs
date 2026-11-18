// Step 17: the hourly check of the account's free limits (D1 rows, Worker CPU) and its owner alerts.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fakeD1 } from "./helpers.mjs";
import { d1Binding } from "../src/db.js";
import { STATE_KEY, assessUsage, checkUsage, readAnswer, utcDay } from "../src/usage.js";

const NOW = 1_800_000_000;   // 2027-01-15 08:00 UTC
const answer = ({ d1 = [[1000, 10]], workers = [] } = {}) => ({
  data: { viewer: { accounts: [{
    d1: d1.map(([r, w], i) => ({ sum: { rowsRead: r, rowsWritten: w }, dimensions: { databaseId: `db${i}` } })),
    workers: workers.map(([script, status, n]) => ({ sum: { requests: n }, dimensions: { scriptName: script, status } })),
  }] } },
});

describe("readAnswer", () => {
  test("adds every database and keeps only runs that ended over a limit", () => {
    const got = readAnswer(answer({ d1: [[3_000_000, 50_000], [1_200_000, 40_000]],
      workers: [["axiom-news", "success", 1440], ["axiom-news", "exceededCpu", 2], ["axiom-news-staging", "exceededMemory", 1]] }));
    assert.equal(got.r, 4_200_000);
    assert.equal(got.w, 90_000);
    assert.deepEqual(got.over.map((o) => [o.script, o.status, o.n]),
      [["axiom-news", "exceededCpu", 2], ["axiom-news-staging", "exceededMemory", 1]]);
  });
  test("an API error is an error, not zero use", () => {
    assert.throws(() => readAnswer({ errors: [{ message: "not authorized for that account" }] }), /not authorized/);
    assert.throws(() => readAnswer({ data: { viewer: { accounts: [] } } }), /no account/);
  });
});

describe("assessUsage", () => {
  test("under 80%: no alert", () => {
    const { alerts, state } = assessUsage({ r: 3_999_999, w: 79_999, over: [] }, null, NOW);
    assert.equal(alerts.length, 0);
    assert.equal(state.day, utcDay(NOW));
  });
  test("reads at 80%: one D1 alert, then none again the same UTC day", () => {
    const a = assessUsage({ r: 4_000_000, w: 10, over: [] }, null, NOW);
    assert.equal(a.alerts.length, 1);
    assert.equal(a.alerts[0].kind, "d1");
    assert.match(a.alerts[0].text, /rows read 4,000,000 \(80% of 5,000,000\)/);
    assert.doesNotMatch(a.alerts[0].text, /[20132014]/);
    const b = assessUsage({ r: 4_500_000, w: 90_000, over: [] }, a.state, NOW + 3600);
    assert.equal(b.alerts.length, 0);
    const c = assessUsage({ r: 4_500_000, w: 90_000, over: [] }, b.state, NOW + 86400);   // next UTC day
    assert.equal(c.alerts.length, 1);
    assert.match(c.alerts[0].text, /rows written 90,000 \(90% of 100,000\)/);
  });
  test("writes at 80% alert too", () => {
    assert.equal(assessUsage({ r: 0, w: 80_000, over: [] }, null, NOW).alerts.length, 1);
  });
  test("any run over the CPU limit: one CPU alert a day, its own from the D1 one; the day's count adds up", () => {
    const over = [{ script: "axiom-news", status: "exceededCpu", n: 1 }];
    const a = assessUsage({ r: 4_100_000, w: 0, over }, null, NOW);
    assert.deepEqual(a.alerts.map((x) => x.kind), ["d1", "cpu"]);
    assert.match(a.alerts[1].text, /axiom-news: 1 exceededCpu/);
    const b = assessUsage({ r: 4_100_000, w: 0, over: [{ ...over[0], n: 2 }] }, a.state, NOW + 3600);
    assert.equal(b.alerts.length, 0);
    assert.equal(b.state.cpu, 3);
  });
});

describe("checkUsage", () => {
  const env = { CLOUDFLARE_ANALYTICS_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "acc" };
  const run = async (db, body, now, alert = async () => {}) => {
    const calls = [];
    const out = await checkUsage(db, env, now, {
      fetch: async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { json: async () => body }; },
      alert,
    });
    return { out, calls };
  };

  test("no token: no call, nothing stored", async () => {
    const { binding, sqlite } = fakeD1();
    const out = await checkUsage(d1Binding(binding), {}, NOW, { fetch: () => assert.fail("no fetch") });
    assert.equal(out.usage, "no token");
    assert.equal(sqlite.prepare("SELECT count(*) n FROM meta").get().n, 0);
  });

  test("stores the numbers, alerts once, asks only since the last check", async () => {
    const { binding, sqlite } = fakeD1();
    const db = d1Binding(binding);
    const sent = [];
    const first = await run(db, answer({ d1: [[4_200_000, 1]] }), NOW, async (t) => sent.push(t));
    assert.equal(first.calls[0].body.variables.day, "2027-01-15");
    assert.equal(first.calls[0].body.variables.since, new Date((NOW - 7200) * 1000).toISOString());
    assert.equal(sent.length, 1);
    const stored = JSON.parse(sqlite.prepare("SELECT value FROM meta WHERE key = ?").get(STATE_KEY).value);
    assert.equal(stored.r, 4_200_000);
    assert.equal(stored.d1_alert_day, "2027-01-15");
    const second = await run(db, answer({ d1: [[4_300_000, 1]] }), NOW + 3600, async (t) => sent.push(t));
    assert.equal(second.calls[0].body.variables.since, new Date(NOW * 1000).toISOString());
    assert.equal(sent.length, 1);
  });

  test("an alert that failed to send is tried again next hour", async () => {
    const { binding } = fakeD1();
    const db = d1Binding(binding);
    await run(db, answer({ d1: [[4_200_000, 1]] }), NOW, async () => { throw new Error("telegram down"); });
    const sent = [];
    await run(db, answer({ d1: [[4_300_000, 1]] }), NOW + 3600, async (t) => sent.push(t));
    assert.equal(sent.length, 1);
  });
});
