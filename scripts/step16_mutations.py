"""Step 16: break each new rule once and check that a test catches it. Restores every file.

    venv/Scripts/python scripts/step16_mutations.py [part]
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = [str(ROOT / "venv" / "Scripts" / "python"), "-m", "unittest", "discover", "-s", "tests", "-t", "."]
NODE = ["node", "--test", "test/"]
STAMP = "node scripts/stamp-app.mjs"

MUTATIONS = {
    "0": [
        ("all-off reader still gets a digest (cron)", "worker/src/cron.js",
         "  const off = due.filter((u) => allTopicsOff(u, mine.get(u.id)));", "  const off = [];", "node"),
        ("all-off check ignores custom topics", "worker/src/cron.js",
         "!(customRows ?? []).some((r) => r.enabled !== 0)", "true", "node"),
        ("all-off reader gets a sample digest", "worker/src/onboard.js",
         "  if (allTopicsOff(user, enabledOnly(custom))) return { user, plan: null, ids: [], off: true };\n", "", "node"),
        ("keep-one-topic rule back in settings", "worker/src/settings.js",
         "    const bad = uniq.find((x) => !topicTags.includes(x));",
         '    if (!uniq.length) throw new SettingsError("keep_topic");\n    const bad = uniq.find((x) => !topicTags.includes(x));', "node"),
        ("paused accepted as a setting again", "worker/src/settings.js",
         'const KEYS = new Set(["topics", "digest_times", "lang"]);', 'const KEYS = new Set(["topics", "digest_times", "lang", "paused"]);', "node"),
        ("migration keeps paused readers' topics on", "worker/scripts/migrate-pause.mjs",
         "UPDATE users SET topics = '[]', paused = 0", "UPDATE users SET paused = 0", "node"),
        ("migration leaves custom topics on", "worker/scripts/migrate-pause.mjs",
         "UPDATE custom_follows SET enabled = 0 WHERE user_id = ?1", "UPDATE custom_follows SET enabled = enabled WHERE user_id = ?1", "node"),
        ("app: sleeping card gone", "worker/public/app/app.js", "    if (allOff()) {", "    if (false) {", "app"),
        ("app: language step gone from setup", "worker/public/app/app.js",
         '(hasLangs() ? ["lang", "topics", "times", "done"]', '(hasLangs() ? ["topics", "times", "done"]', "app"),
        ("app: Help square blue again", "worker/public/app/app.js", 'navRow("open-help", I.help, "red"', 'navRow("open-help", I.help, "blue"', "app"),
        ("app: red square not red", "worker/public/app/app.css", ".sq.solid.red { background: var(--accent); }", ".sq.solid.red { background: #007aff; }", "app"),
        ("app: hint gone", "worker/public/app/app.js", 'id="topic-hint">${esc(tr("app.add_topic_hint"))}', 'id="topic-hint">', "app"),
        ("Help section written as one paragraph", "config/i18n/en.json",
         '"help_times": "Pick 1 to 5 times a day.\\nThey follow your phone\'s time zone."',
         '"help_times": "Pick 1 to 5 times a day; they follow your phone\'s time zone."', "app"),
        ("Help title without an emoji", "config/i18n/ru.json", '"help_lang_h": "🌍 Язык"', '"help_lang_h": "Язык"', "app"),
        ("bot reply as one long line", "config/i18n/en.json",
         '"help_cmd": "❓ Everything is in Settings: tap Help.\\n💬 You can send us feedback there too."',
         '"help_cmd": "Everything is in Settings: tap Help, and you can send us feedback there too."', "app"),
        ("an em dash in a Russian text", "config/i18n/ru.json", '"all_off": "Все темы выключены"', '"all_off": "Все темы \u2014 выключены"', "app"),
        ("дайджест in Russian", "config/i18n/ru.json", '"setup_times": "🕘 Время сводок"', '"setup_times": "🕘 Время дайджеста"', "app"),
    ],
    "7": [
        ("main topics bar back to 6 (config)", "config/digest.json", '"topic_bar": 7,', '"topic_bar": 6,', "node"),
        ("custom topics bar raised to 7", "config/digest.json", '"custom_topic_bar": 6,', '"custom_topic_bar": 7,', "node"),
        ("Worker SQL uses the custom bar for main topics", "worker/src/digest.js",
         "THEN ?13 ELSE ?7 END", "THEN ?13 ELSE ?13 END", "node"),
        ("Worker qualifies() uses one bar", "worker/src/digest.js",
         "const bar = isCustomTag(s.main_topic) ? customBar(cfg) : cfg.topic_bar;", "const bar = cfg.topic_bar;", "node"),
        ("job SQL uses one bar", "job/translate.py", "THEN ?9 ELSE ?5 END", "THEN ?5 ELSE ?5 END", "py"),
        ("job qualifies() custom bar is the main bar", "job/translate.py", "        return t >= custom_bar(cfg)\n", '        return t >= cfg["topic_bar"]\n', "py"),
    ],
}


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
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
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
