"""Near-duplicate grouping (job/dupes.py) on real lines from the D1 pool, 2026-11-13."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from job import dupes  # noqa: E402
from tests.helpers import new_db  # noqa: E402

# Lines that are the same event worded differently (must be grouped) ...
SAME = [
    ("Yemeni military reported 943 strikes on Houthi positions as ballistic missiles targeted Aden.",
     "Yemeni military accused the Houthis of targeting Aden with ballistic missiles."),
    ("US Central Command denied Iran's claim of destroying a US radar system in Bahrain.",
     "US Central Command intercepted two Iranian suicide drones launched toward Bahrain, while Iran claims "
     "to have targeted a US radar system."),
    ("US Treasury Secretary Scott Bessent announced he received death threats from Iranian leaders and moved "
     "to a military base.",
     "US Treasury Secretary Scott Bessent confirmed he temporarily moved to a military base following threats "
     "from Iran."),
    ("The number of people injured in a Russian strike on Zaporizhzhia rose to 50, including eight children.",
     "Russian strikes on Nov 13 hit multiple Ukrainian cities, killing three and injuring many, with casualties "
     "rising in Zaporizhzhia"),
    ("Ukraine reports the loss of 400 locomotives in 2026 due to Russian attacks, bringing the total to 630",
     "Ukraine reports loss of 400 locomotives since start of year, 630 since invasion began"),
]
# ... and lines that share names or words but are different events (must stay apart).
DIFFERENT = [
    "Treasury Secretary Scott Bessent blamed the Commerce Department for failing to blacklist Megaspeed over "
    "Nvidia chip diversions.",
    "Rosatom plans to increase the number of Russian personnel at Iran's Bushehr nuclear power plant to 300.",
    "Reports indicate President Trump has removed Vice President Vance from managing negotiations regarding Iran.",
    "Senator John Kennedy criticized Vice President Vance for blaming midterm losses on the war in Iran.",
    "Armenia and Azerbaijan foreign ministers meet in Washington to finalise the peace treaty",
    "Russia's central bank cut its key rate to 15 percent",
]
FILLER = [  # more pool, so the word weights (IDF) behave as on a real day
    "Israeli strikes on Gaza killed twelve people overnight", "France's government survives a confidence vote",
    "Ukrainian drones hit an oil depot in Bryansk region", "Iran's foreign minister visits Moscow for talks",
    "Russian court jails a journalist for nine years", "Poland closes a border crossing with Belarus",
    "NATO ministers meet in Brussels on December 2", "Kremlin says peace talks will continue next week",
    "Armenia's parliament approves the 2027 budget", "Houthis claim a missile attack on a ship in the Red Sea",
]


def stories(lines):
    return [{"id": i + 1, "summary": s} for i, s in enumerate(lines)]


class Grouping(unittest.TestCase):
    def setUp(self):
        self.lines = [a for a, _ in SAME] + DIFFERENT + FILLER + [b for _, b in SAME]
        self.groups, self.pairs = dupes.group(stories(self.lines), threshold=0.45)

    def test_same_events_are_grouped_under_the_earlier_line(self):
        for a, b in SAME:
            ia, ib = self.lines.index(a) + 1, self.lines.index(b) + 1
            self.assertEqual(self.groups[ib], ia, f"not grouped: {b[:60]}")
            self.assertEqual(self.groups[ia], ia)

    def test_different_events_stay_apart(self):
        grouped = {dup for _, _, dup in self.pairs}
        for s in DIFFERENT + FILLER:
            self.assertNotIn(self.lines.index(s) + 1, grouped, f"wrongly grouped: {s[:60]}")

    def test_tokens(self):
        self.assertEqual(dupes.tokens("Strikes hit Zaporizhzhia's power"), {"strik": 1, "hit": 1, "zapor": 1, "power": 1})
        self.assertEqual(dupes.tokens("Erdoğan met the emir"), {"erdog": 1, "met": 1, "emir": 1})


class UpdateGroups(unittest.TestCase):
    def test_groups_in_digest_rank_order_and_writes_only_changes(self):
        db = new_db()
        now = 1_800_000_000

        def add(summary, imp, upd):
            return db.query(
                "INSERT INTO stories (summary, topics, importance, best_url, best_source, best_tier, created_at, "
                "updated_at) VALUES (?, '[\"iran_war\"]', ?, 'u', 's', 1, ?, ?) RETURNING id",
                [summary, imp, upd, upd])[0]["id"]

        low = add(SAME[1][1], 5, now - 600)         # less important copy, written first
        high = add(SAME[1][0], 7, now - 3600)       # more important: leads the group
        old = add(SAME[1][0], 7, now - 2 * 86400)   # outside 24 h: untouched
        cfg = {"max_lookback_hours": 24, "min_importance": 4, "dedupe_threshold": 0.45}
        self.assertEqual(dupes.update_groups(db, now, cfg), 2)
        g = {r["id"]: r["dup_group"] for r in db.query("SELECT id, dup_group FROM stories")}
        self.assertEqual((g[high], g[low], g[old]), (high, high, None))
        self.assertEqual(dupes.update_groups(db, now, cfg), 0)   # nothing changed, nothing written


if __name__ == "__main__":
    unittest.main()
