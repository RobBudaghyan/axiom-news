// Step 16: the guard in front of a production deploy (npm run deploy:prod).
//   node scripts/ship-check.mjs record   after a staging deploy: remember what code staging has
//   node scripts/ship-check.mjs          before a production deploy: refuse unless
//     - SHIP_IT=yes is set (the owner said "ship it"; never set it on your own),
//     - the Worker code (src, public, config) is exactly what was last deployed to staging,
//     - nothing in it is uncommitted.
// The record lives in worker/.wrangler/ (git-ignored, this PC only).
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("../", import.meta.url));
const ROOT = join(WORKER, "..");
const RECORD = join(WORKER, ".wrangler", "last-staging.json");
const DIRS = [join(WORKER, "src"), join(WORKER, "public"), join(ROOT, "config")];

function files(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
export function codeHash() {
  const h = createHash("sha256");
  for (const f of DIRS.flatMap(files).sort()) {
    h.update(relative(ROOT, f).replace(/\\/g, "/"));
    h.update(readFileSync(f));
  }
  return h.digest("hex").slice(0, 16);
}

const mode = process.argv[2];
const hash = codeHash();
if (mode === "record") {
  mkdirSync(join(WORKER, ".wrangler"), { recursive: true });
  writeFileSync(RECORD, JSON.stringify({ hash, at: new Date().toISOString() }));
  console.log(`staging now has code ${hash}`);
} else {
  const problems = [];
  if (process.env.SHIP_IT !== "yes") problems.push('SHIP_IT=yes is not set (only after the owner says "ship it")');
  const last = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : null;
  if (!last) problems.push("nothing was deployed to staging from this PC yet (npm run deploy:staging)");
  else if (last.hash !== hash) problems.push(`this code (${hash}) is not what staging has (${last.hash}): deploy it to staging and try it first`);
  const dirty = execSync("git status --porcelain -- worker/src worker/public config", { cwd: ROOT, encoding: "utf8" }).trim();
  if (dirty) problems.push("uncommitted changes in worker/src, worker/public or config");
  if (problems.length) {
    console.error(`NOT deploying to production:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`ship check passed: production gets code ${hash}, the same as staging (${last.at})`);
}
