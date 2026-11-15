// Step 8: Telegram "Show more" fold test. Sends 5 clearly labelled messages of increasing length,
// in the real digest format built from real stories, to the owner on the TEST bot only. The owner
// then says which ones his phone folds. Writes nothing to D1.
//
//   node scripts/fold-test.mjs --dry      print the lengths, send nothing
//   node scripts/fold-test.mjs            send (refuses unless the bot is the TEST bot)
import { CONFIG, buildMessage, topicInfoFrom, visibleLength } from "../src/digest.js";
import { tgCall, sendHtml } from "../src/telegram.js";
import { d1Rest, loadEnv } from "./digest-cli.mjs";

const TEST_BOT = "justatia_bot";
const TARGETS = [1500, 2500, 3200, 3700, 4050];

const env = loadEnv();
const db = d1Rest(env);
const owner = Number(env.OWNER_TELEGRAM_ID);
const now = Math.floor(Date.now() / 1000);
const [stories, topics, users] = await db.batch([
  { sql: "SELECT id, summary, headline, description, emojis, main_topic, best_url, best_source, importance, final_score, " +
         "topics, updated_at FROM stories WHERE updated_at >= ?1 AND merged_into IS NULL AND headline IS NOT NULL " +
         "AND description IS NOT NULL ORDER BY final_score DESC, updated_at DESC LIMIT 60", params: [now - 86400] },
  { sql: "SELECT tag, label_en, emoji, sort FROM topics ORDER BY sort", params: [] },
  { sql: "SELECT first_name, timezone FROM users WHERE id = ?1", params: [owner] },
]);
const user = users[0] ?? {};
const topicInfo = topicInfoFrom(topics);
const pool = stories.map((s) => ({ ...s, primary: s.main_topic ?? JSON.parse(s.topics)[0] }));
const cfg = { ...CONFIG, message_char_budget: 4096 };

function build(list, n, target) {
  const label = `<i>Fold test ${n} of ${TARGETS.length}, about ${target.toLocaleString("en-US")} characters. ` +
    "Not a digest, nothing is recorded.</i>";
  return buildMessage(list, { now, tz: user.timezone || CONFIG.default_timezone, lastDigestAt: now - 5 * 3600,
    name: user.first_name, topicInfo, label }, cfg);
}

const messages = TARGETS.map((target, i) => {
  let list = [];
  for (const s of pool) {
    const next = build([...list, s], i + 1, target);
    if (next.parts.length > 1 || visibleLength(next.parts[0]) > target + 60) continue;
    list = [...list, s];
    if (visibleLength(next.parts[0]) >= target - 60) break;
  }
  const msg = build(list, i + 1, target);
  if (msg.parts.length !== 1) throw new Error("a test message would be split");
  // The label names the real length (same number of digits as the target, so the length holds).
  const real = visibleLength(msg.parts[0]).toLocaleString("en-US");
  const text = msg.parts[0].replace(`about ${target.toLocaleString("en-US")} characters`, `${real} characters`);
  return { target, text, chars: visibleLength(text), lines: text.split("\n").length, stories: list.length };
});

for (const m of messages) {
  console.log(`target ${m.target}: ${m.chars} visible characters, ${m.lines} lines, ${m.stories} stories`);
}
if (process.argv.includes("--dry")) {
  console.log("[dry run: nothing sent]");
} else {
  const me = await tgCall(env.TELEGRAM_BOT_TOKEN, "getMe", {});
  if (me.username !== TEST_BOT) throw new Error(`refusing: the bot in .env is @${me.username}, not the TEST bot`);
  for (const m of messages) {
    const r = await sendHtml(env.TELEGRAM_BOT_TOKEN, owner, m.text);
    console.log(`[sent: target ${m.target}, message_id ${r.message_id}]`);
    await new Promise((res) => setTimeout(res, 1500));
  }
}
