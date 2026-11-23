# Step 19, Part 1: Technology & AI in, Russia out (2026-11-23)

## What changed
- **Main topics, in this order:** Politics & Conflicts, Economy & Markets, **Technology & AI** (new,
  💻, tag `tech_ai`; ru "Технологии и ИИ", fr "Technologie et IA", hy "Տեխնոլոգիաներ և ԱԲ"), Armenia,
  Iran War, Ukraine War. All six are the defaults (setup still starts with all off; Skip applies them).
- **Russia removed** as a main topic: from `config/topics.yaml`, `config/digest.json`, the prompts,
  the dictionaries, the bot description, the Mini App tint and the source topic hints. The
  Russian-language feeds stay. Russia can now be a reader's own topic (a test checks it).
- **Migration** (`worker/scripts/migrate-step19.mjs`, safe to run again): every user loses `russia`
  and gets `tech_ai`; every story loses `russia`; a story whose main topic was Russia moves to its
  most specific remaining main topic (else Politics & Conflicts). On staging: 3 of 3 users, 1,481
  stories; former Russia stories went to Politics & Conflicts 426, Ukraine War 84, Economy & Markets
  38, Iran War 3, Armenia 2.
- **Definition:** AI (frontier models, AI companies and deals, AI rules), chips (export controls,
  supply, big chipmakers), big tech (major launches, antitrust, large deals, layoffs at scale),
  cybersecurity (major hacks and breaches), space, science and tech policy with wide impact. Not:
  gadget reviews, ordinary launches, app tips, games, small funding rounds, rumours, same-day outages.
- **Prompts:** pass 1 now keeps tech news with wide impact (it used to call "technology" not news);
  the editor has a tech_ai topic rule (a chip export ban is tech_ai; a tech company's deal, results or
  layoffs are tech_ai unless they move the whole market), a boost rule and examples at topic scores
  8, 8, 7, 7, 6, 4, 4, 3, 1; four tech emojis (🤖 💻 🔐 🛰️). "Russia's domestic news is
  politics_conflicts."

## topic_boost_max and topic_specificity
- `tech_ai: 1`, like Economy & Markets. Tech outlets publish many launches, deals and opinion pieces;
  +2 (Armenia's cap) would lift routine product news into the topic path. +1 lets a real development
  its followers care about more than the world does (a frontier model, a chip export rule, a big
  antitrust fine, a major breach) reach them at 7 when the world scale gives it 6.
- Specificity: ukraine_war, iran_war, armenia, **tech_ai**, economy_markets, politics_conflicts. A
  chip export ban tagged tech and politics goes under Technology; a war or Armenia story stays there.

## Feeds
15 candidates (`config/candidates/tech.yaml`) passed `check_feeds.py` from the PC and from GitHub's
runners (workflow run 45163965396): all 15 OK. Weekday volume from each feed's own history (the last
24 h were a weekend):

| Feed | Tier | Items a weekday | Taken |
|---|---|---|---|
| Financial Times, technology | 1 | about 15 | yes |
| Bloomberg, technology | 1 | about 40 | yes, capped at 4 a run |
| The Wall Street Journal, tech | 1 | about 13 | yes |
| The New York Times, technology | 1 | 6 to 15 | yes |
| The Guardian, technology | 1 | about 5 | yes |
| MIT Technology Review | 1 | 2 to 3 | yes |
| Ars Technica | 2 | 16 to 20 | yes |
| Wired, AI | 2 | 2 to 5 | yes |
| The Verge | 2 | about 25 | no: mostly reviews and deals |
| Wired, all | 2 | about 18 | no: mostly features; Wired AI kept |
| TechCrunch | 2 | 8 to 15 | no: start-up rounds |
| The Register | 2 | about 20 | no: noisy |
| CNBC, tech | 2 | about 18 | no: overlaps CNBC and Bloomberg |
| BBC, technology | 1 | 5 to 7 | no: overlaps BBC world |
| The Economist, science and technology | 1 | weekly | no: stale |

**Measured on staging** (the eight feeds, last 48 h, a weekend, through the real job,
`scripts/step19_backfill.py`): 64 new items, 27 kept in stories, the rest not news; 17 new stories,
5 scored 6 or more, 2 scored 7 (both Bloomberg). 266 D1 rows written (about 4 an item); 3 pass-1
calls (24.5k tokens in, 5.5k out, prompt included), 1 editor call.

**Cost estimate on a weekday:** about 100 to 120 new items (2,338 on the whole account on 22 Nov):
about 500 to 900 more D1 writes a day, under 1% of the free 100k. The busiest recent day was about
42k (42%), so about 43%: under the 50% line. AI: about 12k to 15k more input tokens a day in the
hourly calls (the prompt is shared), no extra calls expected; the editor sees a few more candidates.

**Normal job run on staging** (all 125 feeds, the new prompts): ok in 125 s, 125 feeds ok, 406 new
items, 94 stories created, editor ok (2 calls), 2,047 D1 rows written. Examples of what it tagged
tech_ai: "Oregon and Virginia attorneys general sue Elon Musk companies over Grok deepfakes" (6, topic
7), "Australia designates AI as a key foreign policy challenge" (6, 6), "BepiColombo reaches Mercury
orbit" (5, 5), "La Liga reports a cyberattack and data leak" (5, 5).

## 48 h replay (09:00, 14:00, 20:00 Yerevan; real digest code, no AI; staging pool of 2,092 stories)
`worker/scripts/step19-replay.mjs`, data in `reports/data/step-19/`.

| Reader | Stories a digest (min to max) | Cut for length | Longest |
|---|---|---|---|
| All six topics | 7.3 (4 to 11) | 0 | 2,897 characters |
| Armenia only | 1.0 (0 to 2) | 0 | 547 |
| Technology & AI only, as tagged | 0.1 (0 to 1) | 0 | 338 |
| Technology & AI only, simulated | 1.0 (0 to 3) | 0 | 782 |
| All six, simulated | 7.7 (4 to 11) | 0 | 2,897 |

"As tagged" is unfair to Technology & AI: 46 of the 48 hours were tagged before the topic existed.
"Simulated" re-tags older stories in memory only (a headline naming AI, chips, big tech, hacks:
176 stories) and moves their main topic from Economy or Politics to Technology & AI. So expect
**about 1 tech story a digest** on a weekend, likely 2 to 3 on weekdays. The weekend also explains the
low Armenia-only number (Step 16 measured 6.4 on weekdays). Levers if the owner wants more tech:
`topic_boost_max.tech_ai` 2, or easier editor examples.

## Tests
Worker 343 (the migration, config, dictionaries, Russia now addable as a custom topic); Python 185
(`tests/test_step19.py`: order, defaults, labels, boost cap, specificity, no `russia` in what the
job reads, the editor's 4/6/8 examples, the pass-1 text, the eight feeds, the rendered prompts).
