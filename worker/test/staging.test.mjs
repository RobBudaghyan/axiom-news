// Step 16 Part 1: two copies of the Worker. Production (until launch) sends nothing to users and starts
// the hourly job; staging never starts the job, never alerts about it, and (SEND_STUB, load test) can
// count sends without calling Telegram. Admin says which copy it is. wrangler.toml holds both.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker, { HOURLY_CRON, envName, switches } from "../src/index.js";
import { signInitData } from "../src/auth.js";
import { OWNER, addStory, addUser, fakeD1, mockFetch } from "./helpers.mjs";

let fetchMock;
afterEach(() => fetchMock?.restore());
const TOML = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const base = (binding, vars) => ({ DB: binding, TELEGRAM_BOT_TOKEN: "TOKEN", TELEGRAM_WEBHOOK_SECRET: "s".repeat(40),
  OWNER_TELEGRAM_ID: String(OWNER), GITHUB_DISPATCH_TOKEN: "GH", GITHUB_REPO: "owner/axiom-news", GITHUB_WORKFLOW: "hourly.yml",
  GITHUB_REF: "main", APP_URL: "https://w.test/app/", ...vars });
const PROD = { ENV_NAME: "production", USER_SENDS: "off", JOB_DISPATCH: "on", SEND_STUB: "off", HEALTH_ALERTS: "on" };
const STAGING = { ENV_NAME: "staging", USER_SENDS: "on", JOB_DISPATCH: "off", SEND_STUB: "off", HEALTH_ALERTS: "off" };
const nowS = () => Math.floor(Date.now() / 1000);
function dueSetup() {
  const { binding, sqlite } = fakeD1();
  const now = nowS();
  addStory(sqlite, "Armenia and Azerbaijan sign border deal", ["armenia"], 9, now - 600, { final_score: 8, main_topic: "armenia", headline: "Border deal" });
  addUser(sqlite, { next_digest_at: now - 60 });
  return { binding, sqlite, now };
}
function withRun(x) {   // a recent good job run, so production has no reason to alert
  x.sqlite.prepare("INSERT INTO job_runs (started_at, finished_at, status) VALUES (?, ?, ?)").run(x.now - 600, x.now - 510, "ok");
  return x;
}
const tgSends = () => fetchMock.calls.filter((c) => /api\.telegram\.org.*\/send(Message|RichMessage)$/.test(c.url));
const ghCalls = () => fetchMock.calls.filter((c) => c.url.includes("api.github.com"));

describe("Step 16: production and staging switches", () => {
  test("wrangler.toml: production axiom-news on axiom-d1; staging axiom-news-staging on its own D1, no hourly cron", () => {
    const [prod, staging] = TOML.split("[env.staging]");
    assert.match(prod, /^name = "axiom-news"$/m);
    assert.match(prod, /database_id = "2a1eb212-95b8-4715-b628-2967cbcb0367"/);
    assert.match(prod, /ENV_NAME = "production"/);
    assert.match(prod, /crons = \["\* \* \* \* \*", "7 \* \* \* \*"\]/);   // Step 16: every minute, 3 readers a tick
    assert.match(staging, /^name = "axiom-news-staging"$/m);
    assert.match(staging, /database_name = "axiom-d1-staging"/);
    assert.doesNotMatch(staging, /2a1eb212-95b8-4715-b628-2967cbcb0367/, "staging never touches the production D1");
    assert.match(staging, /ENV_NAME = "staging"/);
    assert.match(staging, /JOB_DISPATCH = "off"/);
    assert.match(staging, /HEALTH_ALERTS = "off"/);
    assert.match(staging, /crons = \["\* \* \* \* \*"\]/);
    assert.match(staging, /APP_URL = "https:\/\/axiom-news-staging\./);
  });

  test("switch defaults: missing vars mean everything on, production name", () => {
    assert.deepEqual(switches({}), { userSends: true, dispatch: true, stub: false, alerts: true });
    assert.equal(envName({}), "production");
    assert.equal(envName({ ENV_NAME: "staging" }), "staging");
  });

  test("production until launch (USER_SENDS off): a due digest is NOT sent and not marked; the hourly job still starts", async () => {
    const { binding, sqlite, now } = withRun(dueSetup());
    fetchMock = mockFetch((url) => (url.includes("api.github.com") ? { status: 204 } : undefined));
    await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: now * 1000 }, base(binding, PROD));
    assert.equal(tgSends().length, 0);
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sent").get().n, 0);
    await worker.scheduled({ cron: HOURLY_CRON, scheduledTime: now * 1000 }, base(binding, PROD));
    assert.equal(ghCalls().length, 1, "production starts the hourly job");
  });

  test("staging: digests go out, the hourly job is never started, no job alert to the owner", async () => {
    const { binding, sqlite, now } = dueSetup();   // no job run at all: production would alert "no successful run"
    fetchMock = mockFetch((url) => (url.includes("api.telegram.org") ? { status: 200, body: { ok: true, result: { message_id: 1 } } }
      : url.includes("api.github.com") ? { status: 204 } : undefined));
    await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: now * 1000 }, base(binding, STAGING));
    assert.equal(tgSends().length, 1, "only the digest; no health alert");
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sent").get().n, 1);
    await worker.scheduled({ cron: HOURLY_CRON, scheduledTime: now * 1000 }, base(binding, STAGING));
    assert.equal(ghCalls().length, 0, "staging never starts the job");
    assert.equal(tgSends().length, 1, "no AI-guard or dispatch alert either");
  });

  test("the same missing job run DOES alert the owner on production", async () => {
    const { binding, now } = dueSetup();
    fetchMock = mockFetch((url) => (url.includes("api.telegram.org") ? { status: 200, body: { ok: true, result: { message_id: 1 } } } : undefined));
    await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: now * 1000 }, base(binding, PROD));
    const alerts = fetchMock.calls.filter((c) => /sendMessage$/.test(c.url) && c.body.chat_id === OWNER && /^Axiom News alert/.test(c.body.text));
    assert.equal(alerts.length, 1);
  });

  test("SEND_STUB on (load test): a fake reader's digest is recorded but Telegram is never called; a real reader is still sent for real", async () => {
    const { binding, sqlite, now } = dueSetup();   // the owner (a real, positive id) is due
    addUser(sqlite, { id: -1001, first_name: "Load 01", next_digest_at: now - 60 });
    fetchMock = mockFetch((url) => (url.includes("api.telegram.org") ? { status: 200, body: { ok: true, result: { message_id: 1 } } } : undefined));
    await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: now * 1000 }, base(binding, { ...STAGING, SEND_STUB: "on" }));
    const tg = tgSends();
    assert.deepEqual(tg.map((c) => c.body.chat_id), [OWNER], "only the real reader reaches Telegram");
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sent WHERE user_id = -1001").get().n, 1, "the fake reader's digest counts as delivered");
    assert.ok(sqlite.prepare("SELECT last_digest_at FROM users WHERE id = -1001").get().last_digest_at != null);
  });

  test("Admin says which copy it is", async () => {
    for (const [vars, want] of [[STAGING, "staging"], [PROD, "production"]]) {
      const { binding, sqlite } = fakeD1();
      addUser(sqlite, {});
      const init = await signInitData({ query_id: "q", user: JSON.stringify({ id: OWNER, first_name: "Owner" }), auth_date: String(nowS()) }, "TOKEN");
      const res = await worker.fetch(new Request("https://w.test/api/admin", { headers: { authorization: `tma ${init}` } }), base(binding, vars));
      assert.equal((await res.json()).env, want);
    }
    const js = readFileSync(new URL("../public/app/app.js", import.meta.url), "utf8");
    assert.match(js, /A\.env === "staging" \? "STAGING" : "PRODUCTION"/);
  });
});
