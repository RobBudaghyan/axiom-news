"""Step 15: break each new rule once and check that a test catches it. Restores every file.

    venv/Scripts/python scripts/step15_mutations.py [part]
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
PY = [str(ROOT / "venv" / "Scripts" / "python"), "-m", "unittest", "discover", "-s", "tests", "-t", "."]
NODE = ["node", "--test", "test/"]

MUTATIONS = {
    "1": [
        ("off rule gone from the digest SQL", "worker/src/digest.js",
         "    AND NOT (coalesce(s.main_topic, '') IN (SELECT m.value FROM json_each(?12) m)\n"
         "             AND coalesce(s.main_topic, '') NOT IN (SELECT u.value FROM json_each(?2) u))\n", "", "node"),
        ("off rule gone from the Worker's qualifies()", "worker/src/digest.js",
         "  if (s.main_topic && mainTags(cfg).includes(s.main_topic) && !userTopics.includes(s.main_topic)) return false;\n",
         "", "node"),
        ("off rule gone from the job's qualifies()", "job/translate.py",
         "    if main and main in main_tags(cfg) and main not in tags:\n        return False", "    pass", "py"),
        ("off rule gone from the job's SQL", "job/translate.py",
         "    AND NOT (coalesce(s.main_topic, '') IN (SELECT m.value FROM json_each(?8) m)\n"
         "             AND coalesce(s.main_topic, '') NOT IN (SELECT u.value FROM json_each(?7) u))\n", "", "py"),
        ("migration forgets Economy & Markets", "worker/scripts/migrate-topics.mjs", "  out.add(NEW_TOPIC);\n", "", "node"),
        ("migration drops Wars & Conflicts followers", "worker/scripts/migrate-topics.mjs",
         'wars_conflicts: "politics_conflicts"', 'wars_conflicts: "wars_conflicts"', "node"),
        ("war stories no longer get the broad tag", "job/ai.py", "            tags.add(BROAD_TAG)", "            pass", "py"),
        ("Russian topic name wrong", "config/i18n/ru.json", '"economy_markets": "Экономика и рынки"',
         '"economy_markets": "Экономика"', "app"),
        ("Economy & Markets boost cap lifted", "config/digest.json", '"economy_markets": 1,', '"economy_markets": 3,', "node"),
    ],
    "2": [
        ("fact guard ignores the common words", "job/editor.py",
         "\n                       or m.group(0).lower() in COMMON_WORDS):", "):", "py"),
        ("fact guard takes any opener as ordinary (names pass too)", "job/editor.py",
         "        if opener and (m.group(0) in SENTENCE_OPENERS", "        if opener or (m.group(0) in SENTENCE_OPENERS", "py"),
        ("party names no longer accepted", "job/editor.py",
         "Republican Republicans Democrat Democrats", "Democrats", "py"),
        ("West/Western rule gone", "job/editor.py",
         "\n                    and not (len(low) >= 4 and any(w.startswith(low) for w in roots))):", "):", "py"),
        ("common word list emptied", "config/common_words.txt", "\nsevere\n", "\n", "py"),
        ("keywords never refreshed", "job/custom.py",
         '"(keywords IS NULL OR keywords_at IS NULL OR keywords_at <= ?) "', '"(keywords IS NULL OR 0 = ?) "', "py"),
        ("a weak refresh overwrites good keywords", "job/custom.py",
         'if r.get("keywords") and len(kw["en"]) < MIN_REFRESH_KEYWORDS:', "if False:", "py"),
        ("refresh every day instead of weekly", "job/custom.py", "KEYWORDS_REFRESH_DAYS = 7", "KEYWORDS_REFRESH_DAYS = 0", "py"),
        ("Admin Keywords button does nothing", "worker/src/custom.js",
         'if (action === "keywords") return [{ sql: "UPDATE custom_topics SET keywords_at = 0 WHERE id = ?1", params: [topic.id] }];',
         'if (action === "keywords") return [];', "node"),
        ("the topic check stores no keywords time", "worker/src/custom.js", "a.keywords ? now : null] },", "null] },", "node"),
        ("culture line gone from the editor prompt", "prompts/editor.md", "   CULTURE AND SPORT stay below 6", "   CULTURE stays low", "py"),
        ("economy examples gone", "prompts/editor.md", '"Global stocks plunge as a major bank collapses" 8, 8;', "", "py"),
        ("pass 1 calls economy news not news again", "prompts/story_batch.md",
         "Economy\n   news with wide impact IS news (economy_markets)", "Economy\n   news is not news (economy_markets)", "py"),
    ],
    "3": [
        ("feedback limit lifted", "worker/src/feedback.js", "per_day: 10", "per_day: 1000", "node"),
        ("feedback length not checked", "worker/src/feedback.js",
         "  if (chars(text) > FEEDBACK.max_chars) throw new SettingsError(\"feedback_long\", { max: FEEDBACK.max_chars });\n", "", "node"),
        ("feedback not forwarded to the owner", "worker/src/feedback.js",
         "      await io.send(Number(ownerId), ownerMessage(user, tgUser, text));\n", "", "node"),
        ("feedback not escaped for the owner", "worker/src/feedback.js",
         "\\n\\n${escHtml(text)}`;", "\\n\\n${text}`;", "node"),
        ("feedback not stored", "worker/src/feedback.js",
         "  await db.batch([{ sql: \"INSERT INTO feedback (user_id, at, text, forwarded) VALUES (?1, ?2, ?3, ?4)\",\n"
         "    params: [tgUser.id, now, text, forwarded] }]);\n", "", "node"),
        ("/help no longer points to Settings", "worker/src/bot.js", '    await ctx.reply(id, t(lang, "bot.help_cmd"), button(ctx, lang));',
         '    await ctx.reply(id, helpText(user, now, lang));', "node"),
        ("privacy note gone from Russian help", "config/i18n/ru.json", "Мы ничего не продаём и никому не передаём.", "", "app"),
        ("help rows moved above Support", "worker/public/app/app.js", "      ${supportHTML()}\n      ${moreHTML()}", "      ${moreHTML()}\n      ${supportHTML()}", "app"),
        ("back button never hides", "worker/public/app/app.js", "tg.BackButton.offClick(onBack); tg.BackButton.hide();", "tg.BackButton.offClick(onBack);", "app"),
        ("an em dash in a help text", "config/i18n/en.json", "It is free.", "It is free — always.", "app"),
    ],
    "4": [
        ("welcome: a new user gets the old long welcome", "worker/src/bot.js", "    if (isNew || needsSetup(user)) {", "    if (false) {", "node"),
        ("imported users get the setup", "worker/src/onboard.js",
         "export const needsSetup = (user) => !!user && !user.onboarded_at && !Number(user.imported ?? 0);",
         "export const needsSetup = (user) => !!user && !user.onboarded_at;", "node"),
        ("the sample digest can be sent twice", "worker/src/onboard.js",
         "WHERE id = ?1 AND onboarded_at IS NULL AND imported = 0 RETURNING id", "WHERE id = ?1 RETURNING id", "node"),
        ("the sample digest is not labelled", "worker/src/onboard.js", '{ labelKey: "digest.sample_label" }', "{}", "node"),
        ("the sample digest does not mark its stories sent", "worker/src/onboard.js",
         "  await db.batch(digestWrites(user, plan, ids, now));\n  return { user, plan, ids };", "  return { user, plan, ids };", "node"),
        ("reminders for imported users", "worker/src/onboard.js",
         '"AND imported = 0 AND reminded_at IS NULL', '"AND reminded_at IS NULL', "node"),
        ("reminders every day (no claim)", "worker/src/onboard.js",
         "WHERE id = ?1 AND reminded_at IS NULL RETURNING id\", params: [u.id, now] })));",
         "WHERE id = ?1 RETURNING id\", params: [u.id, now] })));", "node"),
        ("reminders at night", "worker/src/onboard.js", "return h >= REMINDER.from_hour && h < REMINDER.to_hour;", "return true;", "node"),
        ("the first open is not recorded", "worker/src/api.js", "  if (!user.opened_at) after.opened_at = now;", "", "node"),
        ("announcement: no claim before sending (double send on retry)", "worker/src/announce.js",
         "    if (!claims[i]?.length) continue;\n", "", "node"),
        ("announcement: send without a preview", "worker/src/announce.js",
         '  if (a.status !== "previewed") return { error: "Send yourself a preview first." };\n', "", "node"),
        ("announcement: dashes allowed", "worker/src/announce.js",
         '  if (DASH.test(text)) { DASH.lastIndex = 0; return "has an em or en dash"; }\n', "", "node"),
        ("announcement: numbers not checked", "worker/src/announce.js",
         '  if (english && numbers(text) !== numbers(english)) return "the numbers differ from the English";\n', "", "node"),
        ("announcement: blocked users get it", "worker/src/announce.js", "FROM users u WHERE u.blocked = 0 AND", "FROM users u WHERE", "node"),
        ("announcement: one-language audience ignored", "worker/src/announce.js", "(?2 = 'all' OR u.lang = ?2)", "(?2 = ?2)", "node"),
        ("announcement: open to everyone", "worker/src/api.js",
         '      case "POST /api/admin/topic":\n      case "POST /api/admin/announce": {',
         '      case "POST /api/admin/announce": return await announce(db, env, body, now, io);\n      case "POST /api/admin/topic": {', "node"),
        ("import: existing users overwritten", "worker/scripts/import-users.mjs", "ON CONFLICT(id) DO NOTHING RETURNING id",
         "ON CONFLICT(id) DO UPDATE SET topics = excluded.topics RETURNING id", "node"),
        ("import: not flagged as imported", "worker/scripts/import-users.mjs", "imported, onboarded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?8)",
         "imported, onboarded_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, NULL)", "node"),
        ("setup: a Russian label wrong", "config/i18n/ru.json", '"setup_skip": "Пропустить"', '"setup_skip": "Skip"', "app"),
        ("setup: the first open skips the setup", "worker/public/app/app.js",
         '    if (S.st.setup) { S.page = "setup"; S.step = 1; }', "", "app"),
    ],
}

STAMP = ["node", "scripts/stamp-app.mjs"]


def stamp() -> None:
    subprocess.run(STAMP, cwd=ROOT / "worker", capture_output=True, shell=True)


def run(kind: str) -> bool:
    """kind "app": a Mini App or dictionary change; re-stamp first, so only the intended test can catch it."""
    if kind == "app":
        stamp()
        kind = "node"
    if kind == "py":
        r = subprocess.run(PY, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    else:
        r = subprocess.run(NODE, cwd=ROOT / "worker", capture_output=True, text=True, encoding="utf-8", errors="replace", shell=True)
    return r.returncode == 0


def main() -> int:
    parts = sys.argv[1:] or sorted(MUTATIONS)
    caught = total = 0
    for part in parts:
        for name, rel, old, new, kind in MUTATIONS[part]:
            path = ROOT / rel
            text = path.read_text(encoding="utf-8")
            if old not in text:
                print(f"SKIP  {name}: pattern not found")
                continue
            total += 1
            path.write_text(text.replace(old, new, 1), encoding="utf-8", newline="")
            try:
                ok = run(kind)
            finally:
                path.write_text(text, encoding="utf-8", newline="")
                if kind == "app":
                    stamp()
            caught += not ok
            print(f"{'CAUGHT' if not ok else 'MISSED'}  {name}")
    print(f"{caught} of {total} caught")
    return 0 if caught == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
