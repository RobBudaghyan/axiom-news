"""Step 19: break each new rule once and check that a test catches it. Restores every file.

    venv/Scripts/python scripts/step19_mutations.py [part ...]      parts 1 to 6
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = [str(ROOT / "venv" / "Scripts" / "python"), "-m", "unittest", "discover", "-s", "tests", "-t", "."]
NODE = ["node", "--test", "test/"]
STAMP = "node scripts/stamp-app.mjs"

# (name, file, old text, new text, which tests: "node", "py" or "app" = re-stamp the Mini App, then node)
MUTATIONS = {
    "1": [
        ("tech_ai boost cap 2 instead of 1", "config/digest.json", '"tech_ai": 1, "iran_war"', '"tech_ai": 2, "iran_war"', "node"),
        ("russia back in topic_specificity", "config/digest.json",
         '"topic_specificity": ["ukraine_war", "iran_war", "armenia", "tech_ai",',
         '"topic_specificity": ["ukraine_war", "iran_war", "armenia", "russia", "tech_ai",', "py"),
        ("tech_ai less specific than economy", "config/digest.json",
         '"armenia", "tech_ai", "economy_markets", "politics_conflicts"]', '"armenia", "economy_markets", "tech_ai", "politics_conflicts"]', "node"),
        ("migration keeps russia for users", "worker/scripts/migrate-step19.mjs",
         "const out = new Set(list.filter((t) => t !== REMOVED));", "const out = new Set(list);", "node"),
        ("migration forgets tech_ai for users", "worker/scripts/migrate-step19.mjs", "  out.add(NEW_TOPIC);\n", "", "node"),
        ("a Russia story always goes to Politics", "worker/scripts/migrate-step19.mjs",
         "const best = specificity.find((t) => out.includes(t)) ?? FALLBACK;", "const best = FALLBACK;", "node"),
        ("editor prompt loses the tech 8 example", "prompts/editor.md",
         '"The US bans exports of advanced AI chips to China" 8, 8;', '"The US bans exports of advanced AI chips to China" 7, 7;', "py"),
        ("pass 1 calls technology not news again", "prompts/story_batch.md",
         "Technology with wide impact IS\n   news (tech_ai)", "Technology is not news", "py"),
        ("Bloomberg tech cap removed", "config/sources.yaml", "state_owned: false, tier: 1, max_items: 4}", "state_owned: false, tier: 1}", "py"),
        ("Technology & AI not a default topic", "config/topics.yaml",
         '  - tag: tech_ai\n    label: {en: "Technology & AI", ru: "Технологии и ИИ"}\n    emoji: "💻"\n    default: true',
         '  - tag: tech_ai\n    label: {en: "Technology & AI", ru: "Технологии и ИИ"}\n    emoji: "💻"\n    default: false', "py"),
    ],
    "2": [
        ("whole-topic aliases ignored", "worker/src/custom.js", ", ...(aliases[m.tag] ?? [])];", "];", "node"),
        ("'AI' redirected to Technology & AI again", "worker/src/custom.js",
         "if (m && !(partOnly && a.names.en)) return refuseMain", "if (m) return refuseMain", "node"),
        ("check prompt loses the WHOLE main topic rule", "worker/src/custom.js",
         "A MAIN TOPIC tag only when the topic means that WHOLE main topic", "A MAIN TOPIC tag when the topic is about a main topic", "node"),
    ],
    "3": [
        ("French and Armenian hidden again", "config/languages.json", '"enabled": ["en", "ru", "fr", "hy"],', '"enabled": ["en", "ru"],', "app"),
        ("Armenian before French", "config/languages.json", '"enabled": ["en", "ru", "fr", "hy"],', '"enabled": ["en", "ru", "hy", "fr"],', "app"),
        ("language buttons one a row", "worker/public/app/app.js", '<button class="b s3" role="radio"', '<button class="b s6" role="radio"', "app"),
        ("topic names may wrap (no fit)", "worker/public/app/app.js", '<span class="row-main row-title fit">', '<span class="row-main row-title">', "app"),
        ("topic names shrink below 13 px", "worker/public/app/app.js", "s > 13;) { s -= 0.5;", "s > 9;) { s -= 0.5;", "app"),
    ],
    "4": [
        ("welcome says 2 s again", "worker/src/bot.js", "width: 1280, height: 720, duration: 11,", "width: 1280, height: 720, duration: 2,", "node"),
        ("welcome URL without the version mark", "worker/src/index.js",
         "`../media/welcome.mp4?v=${WELCOME_VERSION}`", '"../media/welcome.mp4"', "node"),
    ],
    "5": [
        ("no-run alert after 3 hours again", "worker/src/health.js", "export const NO_SUCCESS_S = 2 * 3600;", "export const NO_SUCCESS_S = 3 * 3600;", "node"),
        ("an alert kind may repeat the same day", "worker/src/watch.js",
         "const due = candidates.filter((c) => sent[c.kind] !== day);", "const due = candidates;", "node"),
        ("digests-failing alert on any failure", "worker/src/watch.js", "export const DIGEST_FAIL_MIN = 3;", "export const DIGEST_FAIL_MIN = 1;", "node"),
        ("feeds-down after one failed run", "worker/src/watch.js", "export const FEED_DOWN_RUNS = 3;", "export const FEED_DOWN_RUNS = 1;", "node"),
        ("Google alert after 2 hours", "worker/src/watch.js", "export const GOOGLE_SILENT_S = 24 * 3600;", "export const GOOGLE_SILENT_S = 2 * 3600;", "node"),
        ("alert without its What to do line", "worker/src/watch.js",
         "export const alertText = (what, todo) => `Axiom News alert: ${what}\\nWhat to do: ${todo}`;",
         "export const alertText = (what, todo) => `Axiom News alert: ${what}`;", "node"),
        ("yesterday's stats never written", "worker/src/watch.js", "return last === yday ? null : yday;", "return null;", "node"),
        ("the final write wipes the live digest counts", "worker/src/watch.js",
         'const STATS_COLS = ["users",', 'const STATS_COLS = ["digests_sent", "users",', "node"),
        ("a deletion is not counted", "worker/src/account.js", "    deletedStatsStatement(id, now),   // Step 19", "    // Step 19", "node"),
        ("daily_stats pruned", "job/run.py",
         '("DELETE FROM errors WHERE at < ? RETURNING id", [log_cut]),',
         '("DELETE FROM errors WHERE at < ? RETURNING id", [log_cut]),\n            ("DELETE FROM daily_stats WHERE day < ? RETURNING day", [log_cut]),', "node"),
    ],
    "6": [
        ("description names Russia again", "config/i18n/en.json",
         "Politics, Economy, Technology & AI, Armenia, Iran, Ukraine,", "Politics, Economy, Technology & AI, Armenia, Russia, Iran, Ukraine,", "py"),
        ("Help line too long for a phone", "config/i18n/fr.json",
         '"help_topics": "Six sujets principaux, chacun activable.', '"help_topics": "Six sujets principaux, chacun peut être activé ou désactivé.', "app"),
        ("French description not translated", "config/i18n/fr.json",
         '"short_description": "📰 De courts résumés', '"short_description": "📰 Short digests', "node"),
    ],
}


def stamp() -> None:
    subprocess.run(STAMP, cwd=ROOT / "worker", capture_output=True, shell=True)


def run(kind: str) -> bool:
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
                print(f"  SKIP (text not found): part {part}: {name}")
                total += 1
                continue
            path.write_text(text.replace(old, new, 1), encoding="utf-8", newline="\n")
            try:
                ok = run(kind)
            finally:
                path.write_text(text, encoding="utf-8", newline="\n")
                if kind == "app":
                    stamp()
            total += 1
            caught += not ok
            print(f"  {'caught' if not ok else 'MISSED'}: part {part}: {name}")
    print(f"{caught} of {total} caught")
    return 0 if caught == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
