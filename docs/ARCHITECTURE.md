# Architecture

Status: designed in Step 1, updated through Step 15 (2026-11-17). Running in the cloud since
Step 3, still on the TEST bot: the hourly job on GitHub Actions (public repo
`RobBudaghyan/axiom-news`), the D1 database, and the Worker `axiom-news` (webhook, digest cron,
hourly job trigger, alerts, the Mini App and its API, §4a). Every hourly run also makes an
**editor** AI call that merges, strictly scores and writes the stories digests show (§3, step 6).
Readers can add their own topics (§4c); Step 15 added the topics Politics & Conflicts and Economy
& Markets, "off means off", Help and Feedback, the welcome flow and the owner's announcements (§4d).

**For a newcomer, in one paragraph:** a Python job runs every hour on GitHub's servers. It reads
the news feeds, asks an AI to group and score the articles, asks a second "editor" AI call to
judge the best stories and write their text, translates what may be sent, and writes everything
to a Cloudflare D1 database. A Cloudflare Worker (JavaScript) is the bot: it answers Telegram,
serves the settings Mini App and, every 5 minutes, builds each due reader's digest with a database
query and no AI. The two halves share only data files (`config/`, `prompts/`, `db/schema.sql`) and
test fixtures (`tests/fixtures/`), so the job and the Worker apply the same rules.

## 1. Components

```
   Worker cron "7 * * * *" ──workflow_dispatch──┐   (backup: GitHub schedule at :37,
                                                ▼    skips if a run started < 45 min ago)
 ┌─────────────────────────────────────────────────────────┐
 │ HOURLY JOB  (Python, ~2 min, then the VM is gone)        │
 │ 1. fetch ~120 RSS feeds (config/sources.yaml) + Google   │
 │    News searches for readers' own topics (Step 13)       │
 │ 2. drop already-seen URLs, keep <= 8 newest per feed (*) │
 │ 3. AI pass, usually ONE call: group, tag, score, write   │
 │    (Gemini -> 2nd Gemini model -> Groq -> else pending)  │
 │ 4. write stories to D1, mark near-duplicates (dup_group) │
 │ 5. EDITOR pass, ONE more call: merge duplicates, strict  │
 │    score, main topic, headline, description, emojis      │
 │    (same fallback chain; if it fails, digests use step 3)│
 │ 6. prune old rows (daily)                                │
 └───────────────┬─────────────────────────────────────────┘
                 │ HTTPS: Cloudflare D1 REST API (scoped token)
                 ▼
        ┌─────────────────┐
        │   D1 database    │  story pool, users, sent log, stats
        └───────┬─────────┘
                │ D1 binding (inside Cloudflare)
 ┌──────────────┴──────────────────────────────────────────┐
 │ CLOUDFLARE WORKER  (JavaScript, one Worker)              │
 │ • POST /telegram   bot webhook (/start, /settings, /help)│
 │ • cron */5 min     send due digests (<= 8 users/tick),   │
 │                    one reminder, announcement batches,   │
 │                    check job health, alert the owner     │
 │ • cron 7 * * * *   start the hourly GitHub job           │
 │ • /app/            Mini App files (static assets, free)  │
 │ • /api/*           Mini App API (initData checked)       │
 └──────────────┬──────────────────────────────────────────┘
                │ HTTPS: Telegram Bot API (sendMessage)
                ▼
            Telegram users (~20)
```

There is no server running 24/7. GitHub provides a short-lived VM each hour, and Cloudflare runs
the Worker only when a request or cron tick arrives.

## 2. Languages and why

| Part | Language | Why |
|---|---|---|
| Hourly job (GitHub Actions) | **Python 3** | `feedparser` is the most forgiving RSS parser available. It handles broken XML and odd encodings such as windows-1251 in Russian feeds without extra code. Python is already on the owner's PC and is what the old project and advisor know. Heavy work like XML parsing for 116 feeds stays out of Cloudflare's 10 ms CPU budget. |
| Worker + Mini App | **JavaScript** (ES modules, no build step, no framework) | Cloudflare Workers run JS natively; Python Workers exist but start slower and use more of the CPU limit. The Mini App runs in Telegram's browser view, so it has to be HTML/CSS/JS anyway. |

The two halves share **data, not code**. Both read the D1 schema (`db/schema.sql`). The job reads
`config/*.yaml` and syncs the topic list into D1, and the Worker reads topics from D1. Each piece
of logic lives in exactly one language:
- **Digest selection, topic cap, format and time slots:** `worker/src/digest.js` only. The Worker
  and the local tool `worker/scripts/digest-cli.mjs` both import it, so they pick and format
  exactly the same way.
- **Near-duplicate grouping:** `job/dupes.py` only. It runs in the job because the job has no CPU
  limit (see §8); the Worker reads the result (`stories.dup_group`).
- **Shared settings:** `config/digest.json` is read by both (editorial and topic bars, the topic
  boost caps, the one-message length limit, dedupe threshold, users per tick, allowed digest times).

Tools: Node.js 26 LTS and `wrangler` (pinned in `worker/package.json`) deploy the Worker;
`gh` manages the GitHub repo and its secrets.

## 3. Data flow

1. **Collect.** The job fetches all feeds in parallel (10-15 s for 116 feeds). For each entry it
   computes `url_hash = sha256(normalized link)` (lower-case host, no `#fragment`, no `utm_*`
   and similar tracking parameters). Only entries published inside a **lookback window** count:
   back to the last run's start minus 1 h, clamped to 2-24 h (3 h on the very first run). URLs
   already in `items` are skipped, and at most **8 newest unseen entries per feed per run** are
   kept, unless the feed has its own `max_items` in `config/sources.yaml` ((*) Step 7: News.am
   Russian and 168.am 20, A1+ 12, Factor.am and Aravot 10). What a cap leaves out is lost; the
   run log prints it ("cap cut") and `meta.feed_health` keeps it per feed (`cut`). This stops the very high-volume Russian state agencies (TASS ~1,600/day, RIA ~1,200/day)
   from swamping the batch. Each kept entry becomes an `items` row with `status='pending'`, the
   title, and a snippet of about 200 characters with HTML stripped. Pending items left over from
   failed earlier runs are included again; after 24 h they become `expired`.
2. **AI pass (one call per hour for everyone, more only for a backlog).** Input: all pending
   items, plus the stories created or updated in the last 24 h (newest 250) so the model can
   attach a new item to an existing story. Existing stories are shown as `S<id>` and items as
   plain numbers, because with plain numbers for both the model once put item 46 into story 46.
   Prompt: `prompts/story_batch.md`. Output: a list of stories (each with `item_ids`, `topics`,
   `importance` 1-10, a one-line English `summary`, and an optional `existing_story_id`), plus
   `not_news_ids`. **Every item must be accounted for**, either in a story or in not-news.
   A normal hour (~230 items, about 23k tokens) fits one Gemini call. A bigger backlog is split
   into chunks of about 25k estimated tokens, and each chunk's stories are written before the
   next chunk, so later chunks can merge into them.
   **Answer checks** (lesson 2):
   - An error, or an empty, blocked or invalid answer, is a failure, never "no news".
   - An answer that covers none of its items, or puts fewer than 10% of 20+ items into stories,
     is retried once and then handed to the next provider. Step 2 saw one answer place 0 of 435.
   - A cut-off answer, or one that is too large for Groq, splits the chunk in two.
   - An answer that skips more than 10% of its items is kept, and only the skipped items are sent
     again (once, then to the next provider).
3. **Best link** is chosen in code rather than by the AI. Among a story's items:
   1. An item whose English title shares no word with the story summary ranks last. This catches
      an item the AI put in the wrong story (seen once: a DraftKings article in a strike story).
   2. Then the lowest `tier` (1 = most prestigious) wins.
   3. Then the earliest published.

   As a side effect, within one tier an English article beats Russian-language copies of the same
   news, because the non-English copies can't be checked against the summary. Paywalled outlets
   are fine.
4. **Write.** Stories and item updates go to D1 in batched REST calls; a D1 batch is
   all-or-nothing (checked 2026-11-13). Old rows are deleted **once a day**, not every hour, to
   save D1 rows read: items and stories after 7 days, and log rows after 30 days.
5. **Near-duplicates (job, Step 3).** After the AI pass, `job/dupes.py` groups near-duplicate
   stories of the last 24 h (importance >= 4) without AI. Each summary becomes a set of content
   words (lower case, no accents, no stop words, 5-letter stems), weighted by rarity (IDF) over
   the pool. Similarity is the shared weight over the smaller line's weight. Walking in digest
   rank order, a story scoring >= 0.45 against an earlier group leader joins its group, so the
   more important line is the one shown. Only changed rows are written. Tuned on 365 real
   stories on 2026-11-13: catches about 16 of 23 hand-labelled duplicates and wrongly merged
   2 of 24 hard look-alikes. Giving names extra weight was tried and rejected, because it merged
   different stories about the same person.
6. **Editor pass (job, Step 5, `job/editor.py`, prompt `prompts/editor.md`).** One more AI call
   per run, after the near-duplicate grouping. Why: the first pass scores generously (in 24 h,
   364 of 424 politics stories scored 4 or more) and word-based grouping misses about 30% of
   duplicates, so ranking by its score buried small topics such as Armenia.
   - **Candidates:** stories updated in the last 24 h, first-pass score >= 4 (>= 3 for Armenia,
     `editor_topic_floor`, Step 8), not merged away. First the best 3 not-yet-edited stories of
     every topic (so Armenia is always seen), then the strongest not-yet-edited ones, up to **90**
     (45 before Step 8; a sandbox call with 90 covered 89); then up to 15 already-edited stories
     with their current score, topic score, main topic and headline, for comparison and merging.
     **A second call in the same run** (`editor_max_calls` 2) only while unscored candidates remain
     (a busy hour, or ids the answer left out), and not after a fall back to Groq. Each candidate shows its first-pass
     summary and its best 3 articles (`source, tier | title :: snippet`). **The first-pass score is
     not shown:** with it, the editor copied it for almost every story (lesson 27).
   - **Output** (JSON schema): events, each with the candidate ids it covers (several ids = a
     merge), a strict `score` 1-10, the main `topic`, a `topic_score` (Step 8: for followers of
     that topic, the score plus a boost: +0 for most events and for the broad topics, at most +1
     for the two wars, +1/+2 for real Armenia and Russia news; never below the score), a `headline` (present tense, at most 14
     words), a 1-3 sentence `description` (only facts from the given articles) and 2-4 `emojis`
     (flags of the main actors, then a subject emoji). The prompt anchors every score level with
     real examples and says that about 15-25 stories a day worldwide reach 7.
   - **Checks** (`validate_events`): unknown or repeated ids dropped; an event with more than 6
     stories is a "roundup" and ignored (seen once: 44 unrelated stories in one event); fewer than
     half of the candidates covered = a failed answer (one retry, then the next model); score
     clamped; text cleaned (no em or en dash). **Fact guard:** every number, and (for Latin-script
     articles) every capitalised name in a headline or description must appear in the articles or
     the first-pass summary, with acronyms (APEC = Asia-Pacific Economic Cooperation), first names
     before a known surname and demonyms (Iranian for Iran, Polish for Poland) allowed. A failing
     description is dropped, a failing headline falls back to the summary. Replayed on 452 real
     answers: 5 texts dropped. Emojis must be emoji only, at most 4.
   - **Writes:** a merged group keeps its **oldest** story (the one most likely already sent); the
     others get `merged_into` and disappear from digests and from the next runs. Users who received
     a merged-away story get a `sent` row for the kept one, so the event never comes twice. The kept
     story takes the group's best link (lowest tier), the union of topics and the newest
     `updated_at`. Each field (headline, description, emojis) keeps its old value unless the answer
     gives a new valid one (lesson 28). A first-pass merge that changes an edited story's summary
     sets `edited_at` back to NULL, so the editor looks at it again in the same run.
   - **Fallback:** the same chain as the first pass. Groq gets a smaller set (10 new stories, 2
     articles each) to fit its 8k tokens/minute. If every model fails, `job_runs.editor_status` is
     `failed`, an error row is written, the run itself still counts as ok, and digests use the
     first-pass data (below).
   - **Measured** (2026-11-14, Gemini `gemini-3.5-flash-lite`): 45-60 candidates, 6.5-12.5k input
     and 2.5-6.2k output tokens per call, 10-30 s. On GitHub: 60 candidates, 10.1k in, 4.9k out.
     Step 8 sandbox (2026-11-15, with the topic score): 45 candidates 11.0k in / 4.4k out, 90
     candidates 19.2k in / 8.4k out. `stories.scored_at` keeps the time of the first score.
7. **Digests.** The Worker cron runs every 5 minutes and takes up to 8 users whose
   `next_digest_at <= now` (earliest first; the rest go at the next tick). For each user:
   1. **Candidates (SQL, the two-score rule, Step 8):** on one of their topics, not merged away,
      **not in `sent`**, new since the last digest (at most 24 h back; "new" also counts
      `scored_at`, so a story the editor scored after a digest went out reaches the next one), and
      - its global score g >= the **editorial bar** (7), or
      - its main topic is one the user follows, and its topic score t >= the **topic bar** (6) and
        t > g (`topic_needs_boost`: the story matters more to followers than to everyone).

      g is the editor's `final_score`; a story the editor has not scored uses its first-pass
      importance minus `unedited_offset` (2) and has no topic path, so an editor outage cannot
      flood digests. t is g plus the editor's boost, **capped per main topic in code**
      (`topic_boost_max`: politics 0, wars_conflicts 0, iran_war 1, ukraine_war 1, armenia 2,
      russia 2), because the model still lifted statements and routine war news. Best relevance
      first (t if the main topic is followed, else g); at most 60. The same rule is in
      `topicScore`/`qualifies` in JS, and a test checks both agree on random pools.
   2. **Pick and cut (JS, `pickStories`, `fitToLength`), no fixed count, no topic cap:** every
      qualifying story, near-duplicates (`dup_group`) once. Then the **length cut**: the digest is
      ONE message of at most `message_char_limit` (3,900) visible characters. Each followed topic's
      best story is kept while any other can go; otherwise the lowest relevance goes first (ties:
      from the section with the most stories, then the lower g, then the older). Pieces are measured
      once, numbers as two digits, so the estimate is never short. Cut stories are not marked sent
      and do not come back (their window has passed). Nothing qualifies: the quiet note.
      A story is shown under the editor's **main topic** if the user follows it, otherwise its
      most specific topic among the user's (order in `config/digest.json`: ukraine_war, iran_war,
      armenia, russia, wars_conflicts, politics).
   3. Send the one message, then write `sent` rows, `last_digest_at` (the slot time) and the next
      `next_digest_at`.

   **Tuning (2026-11-15, 48 h replay, `node scripts/digest-cli.mjs --windows --profile all
   --hours 48 --bars "7,5;7,6;7,7"`, `reports/data/step-08-after.txt`).** Bars 7/6 with the boost
   rule: the owner's digests average 5.0 stories (2.3 under the Step 5 rules), a reader of all
   topics at 09/14/20 12.1, an Armenia-only reader every 3 h 3.0 (0.4 before), and Armenia stories
   in 48 h rose from 4 to 29-33. Without the boost rule, every global-6 story reached the followers
   of its topic and readers of all topics got full digests every time. 7/7 lets almost no medium
   Armenia news through (0.9 per digest for the Armenia-only reader). The **40% topic cap was
   removed:** with no fixed size it held a one-topic reader to 2 stories, and the length is now the
   real limit; its purpose survives as the tie rule of the cut. Building a digest makes no AI call.

### Digest message format (Step 5, the same for everyone)

```
Good evening, Sam. Since 2 PM, 6 stories for you:

🇦🇲 <b><u>Armenia</u></b>

1. 🇦🇲🇹🇷🤝 <b>Armenia and Turkey near a deal to open the border</b>

Pashinyan said the two countries are close to full normalisation.
<a href="...">Interfax</a>

2. ...
```
- **Greeting:** good morning (before 12:00), afternoon (until 18:00) or evening, then the user's
  first name from Telegram (left out if unknown), then "Since 2 PM" (12-hour clock: "2 PM",
  "2:30 PM", "12 PM") or, for a first digest or one after more than 24 h, "In the last 24 hours".
- **Topic headings:** the topic emoji, then the name in bold and underlined. Groups appear in the
  order of their best story; **numbering runs on across groups.**
- **Each story:** number, emojis, the headline in bold; a blank line and the description; then the
  outlet's name alone on its line as the link (no "Source:"). A blank line between stories. A story
  without editor text uses its first-pass summary and the dictionary emoji (`lineEmoji`,
  `config/line_emoji.json`: the flag of the first actor named, else a subject icon, else the topic
  emoji). HTML parse mode, link previews off.
- **Length (Step 8):** always ONE message, never long enough for Telegram to fold it behind
  "Show more". Telegram counts the text after HTML parsing, in UTF-16 units. Per Telegram's June
  2026 update only the new bot *rich messages* fold ("Show More" after about 8,000 characters);
  plain `sendMessage` text stays capped at 4,096. The owner's phone test (2026-11-15, Android, 5
  labelled messages of 1,400 to 3,993 characters, `worker/scripts/archive/fold-test.mjs`): none folded. The limit
  is **3,900**, under the 4,096 cap; iPhone and desktop were not checked. Too long: stories are cut
  (see Digests above), the two-message split is gone.
- **The quiet note:** "Good afternoon, Sam. Quiet period: nothing important on your topics since
  9 AM."
- **No em dash anywhere.** The job cleans what the AI writes, the digest code cleans again, and it
  refuses to send a message that still contains an em or en dash.

**Never twice:** `sent` has primary key `(user_id, story_id)`, and stories are filtered against it. If
a story gains new sources after it was sent, it is still never sent again; an editor merge copies
`sent` rows to the story it keeps.

## 3a. Google News searches (Step 6 experiment, Step 13 custom topics)

Step 6 tried Google News RSS searches for the main topics in a "shadow" step that measured
without changing anything; Step 7 paused it (the gap was our own feeds). Step 13 reused the
parser for readers' own topics (`job/gnews.py`, §4c). Step 15 removed the shadow leftovers:
`job/shadow.py`, its tests, the probe workflow and scripts, `config/gnews_queries.yaml`, and the
D1 tables `shadow_items` (1,494 rows) and `shadow_runs` (3). The parser tests are in
`tests/test_gnews.py`. Google's feed notice limits use to "a personal feed reader for personal,
non-commercial use" (Step 6 report); the owner accepted that risk for custom topics.

## 4. Time zones and scheduling

- Each user has `timezone` (IANA name, e.g. `Asia/Yerevan`) and `digest_times`, a list of 1 to 5
  local `"HH:00"` values **on the hour between 06:00 and 23:00** (Step 5; half hours before that
  were moved to the nearest hour, 08:30 -> 09:00, by `worker/scripts/archive/migrate-times.mjs`). The
  defaults are 09:00, 14:00 and 20:00.
- **Auto-detection:** every time the user opens the Mini App, it sends
  `Intl.DateTimeFormat().resolvedOptions().timeZone` from their device (`POST /api/open`).
  Telegram's user data does not include a time zone; the official Mini App docs list only id,
  name, username, language, premium and photo. `users.tz_detected` says where the zone came from:
  0 = the default (`Asia/Yerevan`, before the first open), 1 = the device. Since Step 5 the device
  zone is saved on **every** open, so the zone always follows the phone (a zone "chosen by hand",
  the old value 2, is replaced the next time the app opens). The app shows it read-only.
  `/start` creates the user with the defaults (all default topics, 09:00/14:00/20:00,
  `Asia/Yerevan`) and replies with a plain-English welcome naming the times, the next
  digest and an "Open settings" button. Opening the app before `/start` creates the same row.
  `/settings` replies with the same button. Any other message gets a short reply with the times
  and the next digest.
- `next_digest_at` is stored as a UTC timestamp. After each send, or after a settings change, the Worker
  computes the next local slot in the user's zone and converts it to UTC with `Intl`. This handles
  daylight-saving changes automatically. One exception on a settings change
  (`nextDigestAfterChange`, `src/settings.js`): a digest whose slot passed less than 15 minutes
  ago and that the 5-minute tick has not sent yet is kept, so saving a setting at 14:02 does not
  swallow the 14:00 digest. Pausing drops it; resuming starts at the next slot.
- **Why the Worker cron sends digests instead of GitHub:** GitHub documents that scheduled runs
  "can be delayed during periods of high loads" and that at high load "some queued jobs may
  be dropped", and the start of every hour is a known peak. Cloudflare cron is a separate, cheap
  trigger, and 288 runs a day is nothing against the request limit.
- **Expected delay:** a digest goes out at the first 5-minute tick at or after the chosen time, so
  0-5 minutes late. Cloudflare does not publish an accuracy figure, so add a little more for
  that. **At most 8 users per tick** (CPU limit, see §8): with ~20 users all at 09:00, the
  first 8 get it at about 09:00, the next 8 at 09:05 and the rest at 09:10.
- **A failing send** (not a block) is logged to `errors` and retried at the next tick; if the
  slot is more than an hour old it is skipped to the next slot. Telegram 403 (user blocked the
  bot) sets `blocked = 1`; `/start` clears it.
- **The hourly job is started by the Worker** (cron `7 * * * *`, GitHub `workflow_dispatch`
  with a fine-grained token limited to this repo, Actions read/write). A backup GitHub schedule
  at :37 (`backup-schedule.yml`) calls the same workflow with `--min-gap-minutes 45`, so it does
  nothing when the :07 run happened. Only one run at a time (job-level concurrency group
  `hourly-job`); a dispatched run also skips if another started in the last 20 minutes. The
  backup lives in its own file because GitHub disables scheduled workflows in a public repo after
  60 days without commits, and that must never disable `hourly.yml` itself.
- **Content freshness:** the pool updates once an hour, at about :07-:09. A story is typically
  in the pool 10-70 minutes after the outlet publishes it.
- **Health alerts** (every 5-minute tick, `src/health.js`): the owner gets a short Telegram
  message if the newest finished run is `error`/`ai_failed`, a run is stuck in `running` for
  30+ minutes, there was no `ok`/`partial` run in 3 hours, or the GitHub dispatch failed. At most
  one alert per 3 hours, and the same failed run is never reported twice (`meta` table).
- Pause: removed in Step 16 (owner). A reader with every topic off (main and custom) gets no digest and no quiet note; the cron only moves their `next_digest_at` to the next slot (`allTopicsOff` in `src/cron.js`).

## 4a. The Mini App (Steps 4-5)

**Files.** `worker/public/app/` holds `index.html`, `app.css` and `app.js`: plain HTML, CSS and
JavaScript, no framework, about 50 KB before compression since Step 5. Cloudflare serves them
as static assets (free and unlimited) before the Worker code runs, at
`https://axiom-news.axiom-news-worker.workers.dev/app/`. Cache rules (lesson 12):
`public/_headers` sends `Cache-Control: no-store` for the page, and the page loads
`app.css?v=<hash>` / `app.js?v=<hash>`. `npm run stamp` (`scripts/stamp-app.mjs`, also run by
`npm run deploy`) writes the content hash; a test fails if it is stale. No wildcard rule under
`/app/`, because Cloudflare merges every matching rule and would mix two Cache-Control values.
The page also gets a Content-Security-Policy: scripts only from itself and telegram.org, API
calls only to itself.

**Look.** iOS-Settings style: grouped rounded sections on Telegram's `secondary_bg_color`, rows on
`section_bg_color`, text and hints from the theme, so light and dark both follow Telegram.
The brand red **`#b1161c`** (Step 5, replacing the blue) for switches, chosen times, buttons,
icons and links; never Telegram's `button_color`/`link_color` (lesson 13). Contrast (WCAG,
computed): white on `#b1161c` 7.0:1 and `#b1161c` on white 7.0:1, but only 2.4:1 against a dark
cell, so dark mode uses a brighter fill `#d0232a` (3.2:1 against the cell, white text 5.3:1) and a
light red `#ff6b6b` for text and icons (6.1:1). Admin warnings are amber and failures orange
(badge text 5.0-7.7:1), so they never look like the brand. System font, 17 px rows, safe-area insets
(`--tg-safe-area-inset-*`, `--tg-content-safe-area-inset-*`), subtle 0.25-0.35 s transitions,
honouring "reduce motion". Telegram haptics on taps (selection on toggles, light impact on
buttons, success/warning/error on results). There are no sub-screens any more (Step 5), so the
BackButton and MainButton are not used. The header and background are set
to the theme's secondary colour, and vertical swipes are disabled so scrolling never closes it.

**Settings tab (everyone, Step 5).** Next digest card ("Today at 14:00", or since Step 16 "😴 All topics are off"); topics
(switches with emoji, at least one); **digest times as a grid of 18 hourly buttons** 06:00-23:00
under Morning / Afternoon / Evening: tap to choose (red), tap again to remove; a 6th time is refused
("Up to 5 times a day. Remove one first.") and so is removing the last one ("Keep at least one
digest time"), with a small shake; the server checks the same rules. **Time zone, read-only**:
"Yerevan time, From your phone, GMT+4", updated from the phone on every open. (Pause removed in Step 16.) (Stories per
digest, the format choice and the time zone picker were removed in Step 5.) Every change is saved at
once (`POST /api/settings`, one request at a time) and confirmed with a small "Saved" toast; on an
error the change is undone and the reason shown.

**Icons** in the rounded squares are block-level SVGs, centred by grid. Until Step 5 they sat 6 px
low: the Admin stat boxes and the icon squares shared the class name `tile`, so the icons got the
stat boxes' padding (lesson 30). `ui-check.mjs` now measures every icon's drawn centre against its
square (0.0 px off, light and dark).

**Admin tab (owner only).** Visible only when the API says `is_owner`; every admin call is
checked again on the server (403 otherwise). One D1 batch (`src/admin.js`, aggregates done in
SQL) gives:
- health: last run (time, status, duration, providers), last successful run, whether the hourly
  trigger is on time (a run started in the last 70 minutes), the last alert in 24 h
  (`meta.last_alert_text`, new);
- pipeline for 24 h / 7 days: runs, articles, new items, stories created/merged, dropped, the
  **editor pass** (runs that edited, failed runs, duplicates merged; Step 5), AI calls, tokens,
  failed runs, runs that needed a backup model; and AI calls per model, split into first pass and
  editor;
- feeds: failing feeds (with the reason in plain words and since when) and silent feeds (no new
  item for 48 h), from `meta.feed_health`, which the job writes each run (one row: per feed the
  last success, newest entry date, current error and how many runs in a row);
- users: total/active/all off (Step 16)/blocked and a list (name, zone, times, last digest);
- the last 50 errors; D1 rows today against the free limits: the job's exact counts
  (`job_runs.d1_rows_read/_written`, from D1's own per-query meta) plus the Worker's, which the
  binding adds up and every cron tick writes to `meta.d1_worker` (instances that end between
  ticks lose their count, so this part can be slightly low);
- two buttons, each behind a Telegram confirm popup: "Send me a digest now" (a real digest from
  the current pool, recorded in `sent` like a scheduled one) and "Run news job now" (GitHub
  dispatch; refused with the time it becomes possible if a run started less than 20 minutes ago,
  or one is still running).

**API** (`src/api.js`; every request `Authorization: tma <initData>`):

| Route | What | CPU on Cloudflare (2026-11-14) |
|---|---|---|
| `POST /api/open` `{tz}` | create the user if new, save the device zone, return settings | 3-6 ms (Step 4); 5 and 7 ms after the Step 5 deploy |
| `POST /api/settings` | validate (`src/settings.js`: topics (may be empty since Step 16), digest_times, lang), save, recompute `next_digest_at` | 1-5 ms; Step 5: 2-5 ms, refusals 1-2 ms |
| `GET /api/admin` | owner only: everything above | 0-3 ms; Step 5 (with editor stats): 3 ms |
| `POST /api/admin/digest`, `/run-job` | owner only: the two buttons | not run against production by me |

**Bot.** `/start` and `/settings` carry an inline "Open settings" `web_app` button. The chat menu
button (next to the message box) opens the app for every user; it and the command list are set
once with `node scripts/setup-bot.mjs` (run again after switching to the real bot).

**Local preview and checks** (no Telegram, no real data): `node scripts/dev-server.mjs` runs the
real API code over an in-memory database with invented demo users and a stand-in for Telegram's
script (`scripts/dev/mock-telegram.js`). `node scripts/screenshots.mjs` renders it in headless
Edge at 390 px, light and dark, user and admin (`docs/screenshots/`). `node scripts/ui-check.mjs`
taps through every setting and both admin buttons and checks the saved values, the colours and
the icon centring (28 checks since Step 5).
`node scripts/api-check.mjs` checks the LIVE API with initData signed by the bot token from
`.env`.

## 4b. Reader languages (Step 9)

- **Which languages:** `config/languages.json`. `enabled` languages are in the Mini App picker, are
  chosen from Telegram's `language_code` on a user's first /start (or first Mini App open), and
  are translated by the job; `available` ones have a dictionary but are hidden. Today: English and
  Russian on, Armenian and French hidden (owner, to save Gemini calls). A user whose `lang` is not
  enabled gets English everywhere.
- **Texts:** one dictionary per language, `config/i18n/<lang>.json` (sections `digest`, `topics`,
  `bot`, `commands`, `zones`, `errors`, `app`). The Worker imports them (`src/i18n.js`: lookup with
  English fallback, plural rules and times by hand, no Intl); the Mini App gets the `app`,
  `errors`, `topics` and `zones` sections from `public/app/i18n.js`, generated by
  `scripts/stamp-app.mjs` at deploy. API errors carry a `code` the app shows in the user's
  language. The Admin tab and owner alerts stay English.
- **Two columns:** `users.language` is Telegram's code (refreshed on every /start and open);
  `users.lang` is the reader's choice (set once, then only by the picker). A language change
  also sets that chat's menu button label and command list (`setChatMenuButton`,
  `setMyCommands` with a chat scope); `setup-bot.mjs` sets the bot-wide lists per `language_code`.
- **Translation** (`job/translate.py`, after the editor, never fails the run): the languages
  that active users read; the stories that could reach a digest (the Worker's rule for a reader of
  every topic; `tests/fixtures/eligible_cases.json` is checked by both test suites); one call per
  language per run (Groq in chunks of 12). Checks: the same numbers both ways (an English number
  word may become digits), glossary names (`config/glossary.yaml`, with a stem for declined
  forms), the alphabet, French accents and apostrophes, no дайджест in Russian, length, dashes.
  A rejected story gets an `ok = 0` row with the reason and is redone next hour with it; an
  answer that is mostly rejected is asked again at once.
- **The digest:** `CANDIDATE_SQL` joins `story_translations` for the reader's language, only
  rows with `ok = 1` and `src` equal to the story's current English text. `planDigest` builds the
  digest in that language only if every picked story has a translation; otherwise everything is
  English, and the fallback is logged (`errors`, component `digest`) and counted in Admin.

## 4c. Custom topics and the AI budget guard (Step 13)

- **What a reader does:** in the Mini App's "My topics" card (under Topics) they type a topic and
  tap Add (or Enter). Up to 3 per reader (`config/custom_topics.json`). A row per topic with a
  round "x" removes it at once.
- **The one AI check** (`worker/src/custom.js`, in the Worker, owner's choice): input checks, the
  limit of 3, 5 AI checks per reader a day (the owner has none), the block list, an exact match with
  an existing custom topic's name or alias (joined, no AI call), a main topic's label in any language
  (refused: "Armenia is already a main topic"), then the AI budget guard (level 1 or more: "try again
  in a few minutes"). Then ONE call (Gemini, its second model, then Groq; each about 12 s at most):
  a verdict with a reason code and a short reason in the reader's language (nonsense, offensive,
  private person, no news, too broad), `same_as` (an existing custom topic or a main topic), the
  normalised name in en/ru/hy/fr, an emoji, a one-sentence definition, 2-5 Google News searches with
  an edition from the allowlist, and a boost cap 0-2. Code checks it all (no dashes, caps clamped,
  editions allowlisted, at least two searches). Every call is an `ai_calls` row (kind `topic_check`,
  with the HTTP `code`), every request a `topic_checks` row.
- **Shared:** a topic is one `custom_topics` row (`tag` = `c<id>`, ids never reused); readers are
  `custom_follows` rows. A synonym ("Colombian news") joins through `same_as` or a matching name, and
  the typed text becomes an alias, so the next reader typing it joins with no AI call.
- **Hourly job** (`job/custom.py`, every step wrapped so a failure only logs to `errors`, component
  `custom`): topics with at least one active, unpaused follower join the topic list of pass 1 and
  the editor (`READER TOPICS` blocks; empty, and the prompts unchanged, when there are none). Their
  Google News searches run after the RSS feeds: the topic searched longest ago first, at most 40
  requests a run, `when:Nh` since its last search (2-12 h), 8 at a time in a 20 s budget; a 429 or
  503 from Google stops the rest of that run. Each result is compared without AI with the pool's
  titles of the last 24 h (Step 6 similarity, 0.5); at most 8 new items per topic. They are normal
  pending `items` (`source_key` gnews, tier 4 so a curated outlet always gives the link,
  `headline_only` = 1, shown to the AI as "[headline only]", `hint_topic`). Pass 1 may tag any item,
  also from our RSS feeds, with a custom tag; the editor may pick it as the main topic and give a
  topic score; its candidate floor is 3 (like Armenia). After the editor, stories that could reach a
  digest and still link to news.google.com get the outlet's URL (`gnews.resolve`, 10 a run); a
  failure keeps the Google link (`stories.link_state` 1 or 2, one try each). A topic that no
  reader has in their list (on or off) for 7 days is deleted with its searches and stats
  (`orphan_since`).
- **The keyword rule (Step 14, owner):** every custom topic has 5-15 match keywords in English and
  Russian (`custom_topics.keywords`, JSON). The Worker's topic check writes them; a topic saved with
  fewer than 5 gets them from the job (`custom.backfill_keywords`, one AI call, with the topic's
  latest Google headlines so the model sees today's names). A story keeps a custom tag, and may
  have it as its main topic, only if one keyword is in its English headline (the first-pass summary
  while there is none) or description: whole word, any case, a plural s allowed. Otherwise the tag
  goes, the main topic falls back to the most specific main topic left (or none) and the topic
  score to the score (no boost). Applied in pass 1 (`run.py apply`), in the editor's writes
  (`editor.write_statements`) and once a run over the last 26 h (`custom.enforce`, after the
  editor). The Worker does not check keywords: a digest only sees tags the job kept.
- **Glossary spellings (Step 14):** the first English form of a `config/glossary.yaml` entry is ours;
  another form ("Takaiti", the Russian spelling read back into English) in a Google headline, a
  pass-1 summary or the editor's text becomes the first ("Takaichi") (`custom.spell_names`, after
  the fact guard).
- **The switch (Step 13 fixes):** `custom_follows.enabled`. Off keeps the topic in the reader's list
  and its slot (it counts toward the 3); only followers with the switch on make a topic searched and
  get it in digests (`POST /api/topics/switch`). Edit mode in the Mini App removes a follow.
- **Digests:** the cron adds each due reader's switched-on custom tags to their topics
  (`withCustomTopics`), so the length cut and "never twice" are the same as for the main topics. The
  rule differs (Step 13 fixes, owner): for a custom main topic (c<id>) the editor's topic score
  counts as it is against `custom_topic_bar` (6; main topics use `topic_bar`, 7 since Step 16), with no boost cap and no "above the score" rule
  (`digest.js` CANDIDATE_SQL/topicScore/qualifies, twin in `job/translate.py`, checked on
  `tests/fixtures/eligible_cases.json`). The editor scores it as "how important for someone who
  chose this topic" (`job/editor.py` READER_BOOST). A custom topic is the most specific section; its
  heading is the AI's emoji and the name in the reader's language.
- **AI budget guard** (`job/guard.py`, `worker/src/guard.js`, kept identical by
  `tests/fixtures/guard_cases.json`; settings in `config/ai_budget.json`): `ai_calls` per model since
  midnight Pacific time (Gemini's free day; the US daylight rule, no tz database), and 429 answers
  (`code`). Level 1 (a Gemini 429 in the last hour, or 80% of a model's soft limit): new topic checks
  wait. Level 2 (every Gemini model 429 in the last hour, or the soft limit reached): translations
  wait too (the job skips them; readers' stories are held, Step 10). Pass 1 and the editor never
  ask the guard. The job writes `meta.ai_guard` each run; the hourly Worker tick alerts the owner
  once per Pacific day when the level is above 0. Admin shows calls, 429s, the level and what waits.
- **Admin:** a "Custom topics" section (followers, searches, items, stories and sent stories per
  topic, recent checks, blocked names) with Delete and Block (Block also puts every name and alias on
  `topic_blocks`), and an "AI budget, today" section.

## 4d. Step 15: topics, off means off, Help and Feedback, welcome, announcements

- **Main topics.** `politics_conflicts` (Politics & Conflicts) replaced `politics` and
  `wars_conflicts`; `economy_markets` (Economy & Markets) is new; Armenia, Russia, Iran War and
  Ukraine War are unchanged. Tags are never renamed, so the merge was a migration
  (`worker/scripts/migrate-topics.mjs`: every follower of either old topic follows the new one,
  every user got Economy & Markets, stories re-tagged). Boost caps: 0 for Politics & Conflicts, 1
  for Economy & Markets (`config/digest.json`). Pass 1 no longer calls economy news "not news";
  the editor has 4/6/8 examples for it and a rule that culture and sport stay below 6 on the main
  topics.
- **Off means off.** A story whose main topic is one of the six main topics and switched off for
  the reader never reaches them, even through another tag they have on; otherwise one tag they
  have on is enough. The six tags are `topic_specificity` in `config/digest.json`. The rule is in
  three places that must agree: `CANDIDATE_SQL` and `qualifies()` in `worker/src/digest.js`, and
  `ELIGIBLE_SQL` and `qualifies()` in `job/translate.py`; `tests/fixtures/eligible_cases.json`
  (five readers with topics off) checks all of them and the SQL on sqlite.
- **Fact guard.** A capitalised word at the start of a sentence passes if it is an ordinary word
  (`config/common_words.txt`, words the pool writes in lower case); party names pass anywhere;
  real names and numbers are still checked. Custom topic keywords are refreshed after 7 days
  (`custom_topics.keywords_at`) and on Admin's "Keywords" button.
- **Help and Send feedback.** Two rows at the bottom of Settings open their own pages with
  Telegram's back button. Feedback (`feedback` table, `worker/src/feedback.js`): 1,000 characters,
  10 a reader in 24 h, forwarded to the owner with the reader's name and id; Admin lists the
  latest 20. `/help` points to Settings.
- **Welcome flow** (`worker/src/onboard.js`). /start from a new user: a short welcome in their
  Telegram language with "Set up". The first Mini App open shows a setup (Step 16: language first, then topics, times,
  done), skippable; Done or Skip calls `POST /api/onboard` once (`users.onboarded_at`, claimed with
  `UPDATE ... WHERE onboarded_at IS NULL RETURNING`), which sends a labelled sample digest of the
  last 24 hours by the normal rules (its stories are marked sent). A user who never opened the app
  gets one reminder after 24 h, between 10:00 and 20:00 their time (`reminded_at`, claimed before
  sending). Users imported from the old bot (`worker/scripts/import-users.mjs`, `imported = 1`)
  get none of this.
- **Announcements** (`worker/src/announce.js`, Admin, owner only). The owner writes in English
  and picks all users or one language; one AI call (the Worker's topic-check chain) translates it
  into every language the audience reads, and each version is checked (no dash, the same numbers,
  the alphabet, сводка, на Украине). The owner edits, previews (every version comes to him), then
  sends; Send needs a preview of exactly that text. The 5-minute cron sends 25 a tick; each user
  is claimed in `announcement_sends` before the message goes out, so a retry or two overlapping
  ticks never send twice.

## 5. Database (Cloudflare D1, SQLite)

| Table | Key columns | Notes |
|---|---|---|
| `users` | `id` (Telegram user id) PK, `first_name`, `language` (Telegram's code), `lang` (the reader's language, Step 9), `timezone`, `tz_detected` 0/1 (2 = hand-picked before Step 5), `digest_times` JSON (on the hour, 06:00-23:00), `topics` JSON, `paused` (unused since Step 16), `blocked`, `created_at`, `last_digest_at`, `next_digest_at`; Step 15: `onboarded_at`, `opened_at`, `reminded_at`, `imported`; `max_stories` and `format` are unused since Step 5 (kept so no old code can break on them) | index on `next_digest_at`. `blocked=1` when Telegram returns 403 because the user blocked the bot. `tz_detected`: 0 default, 1 device (§4) |
| `topics` | `tag` PK, `label_en`, `emoji`, `sort`, `is_default` | synced from `config/topics.yaml` by the job, read by the Worker; other languages' labels are in `config/i18n` (Step 9) |
| `story_translations` | (`story_id`, `lang`) PK, `ok`, `headline`, `description`, `src` (the English text it was made from), `note` (why a check rejected it), `provider`, `created_at` | Step 9 (§4b); written by the job, read with the digest candidates; pruned with stories |
| `items` | `id` PK, `url_hash` UNIQUE, `source_key`, `source_name`, `tier`, `url`, `title`, `snippet`, `published_at`, `fetched_at`, `status` (pending/done/expired; dropped only for an old pending item), `story_id` | partial indexes: pending items, items with a story; written once, after the AI pass (Step 17c); pruned after 7 days |
| `items_seen` | `url_hash` PK, `source_key`, `at` (WITHOUT ROWID) | Step 17c: the URL hash of an item judged not news, so it is never fetched again (1 row written); pruned after 7 days |
| `stories` | `id` PK, `summary`, `topics` JSON, `importance`, `best_url`, `best_source`, `best_tier`, `best_published_at`, `source_count`, `created_at`, `updated_at`, `dup_group` | index on `updated_at`; pruned after 7 days. `best_tier`/`best_published_at` let a merge update the link without re-reading items. `dup_group` (Step 3) = id of the near-duplicate group's leader, written by the job. Step 5, written by the editor: `headline`, `description`, `emojis`, `final_score` (1-10, what digests measure), `main_topic`, `edited_at` (NULL = not edited yet or needs it again), `merged_into` (a duplicate of that story; hidden from digests) |
| `meta` | `key` PK, `value` | Worker: `last_alert_at`, `last_alerted_run_id` (Step 3), `last_alert_text`, `d1_worker` (its D1 rows today, Step 4). Job: `feed_health` (Step 4, one JSON row) |
| `sent` | (`user_id`, `story_id`) PK, `sent_at` | the "never twice" guarantee; pruned with stories |
| `job_runs` | `id`, `started_at`, `finished_at`, `status` (running/ok/partial/ai_failed/error), counts, `provider`, tokens (both AI calls), `pruned`, `error`, `d1_rows_read`, `d1_rows_written` (Step 4), `editor_status` (ok/failed/skipped), `editor_candidates`, `editor_merged` (Step 5) | Admin tab |
| `ai_calls` | `id`, `at`, `provider`, `model`, `ok`, `input_tokens`, `output_tokens`, `ms`, `error`, `kind` (Step 5: `batch` or `editor`; Step 9: `translate_<lang>`; Step 13: `topic_check`, written by the Worker), `code` (Step 13: HTTP status of a failed call) | Admin tab: AI usage, per language; index on `at` for the AI budget guard (Step 13) |
| `custom_topics`, `custom_follows`, `topic_blocks`, `topic_checks`, `custom_topic_days` | Step 13 (§4c): shared custom topics (`tag` c<id>, names in four languages, emoji, definition, searches, boost cap, aliases, `searched_at`, `orphan_since`), who follows what, blocked names, every add request (outcome, whether the AI was called), and per topic per day what the searches did | `custom_topics.id` is AUTOINCREMENT (a deleted topic's tag is never reused); `items.headline_only`/`hint_topic` and `stories.link_state` were added too |
| `errors` | `id`, `at`, `component` (job/worker), `message` | Admin tab: recent errors |
| `feedback` | `id`, `user_id`, `at`, `text`, `forwarded` | Step 15: readers' feedback (§4d); kept until the user is deleted |
| `announcements`, `announcement_sends` | Step 15 (§4d): one row per announcement (`status` draft/previewed/sending/done/cancelled, `audience`, `texts` JSON per language, `notes`); one row per announcement and user (`ok` NULL while sending, 1 sent, 0 failed) | the send row is written before the message, so nothing goes out twice |

Deleting a user must also delete their rows in the other per-user tables: `sent` (lesson 16 in
LESSONS.md), `digest_holds`, `custom_follows`, `feedback` and `announcement_sends`. Indexes are kept to a minimum because every index update counts as
an extra "row written" on D1. Times are INTEGER unix seconds. The schema is `db/schema.sql`,
applied with `scripts/apply_schema.py` through the REST API; columns added to existing tables
are listed in that script's `MIGRATIONS` (an `ALTER TABLE` whose "duplicate column" error is
ignored). The owner created the database (`axiom-d1`) in the dashboard. Note that the REST API
passes numbers as REAL, so INTEGER columns convert them back.

## 6. Security: how the parts talk

| Link | Protection |
|---|---|
| GitHub job → D1 | Cloudflare D1 REST API `POST /accounts/{id}/d1/database/{id}/query`, using an API token limited to **D1 Edit** permission only. Stored as a GitHub Actions secret. The job only connects outward; nothing can call into it. |
| Telegram → Worker webhook | registered with a `secret_token`. The Worker rejects any request whose `X-Telegram-Bot-Api-Secret-Token` header doesn't match `TELEGRAM_WEBHOOK_SECRET`. |
| Mini App → Worker API | every request carries Telegram's `initData` (`Authorization: tma ...`). The Worker checks it the official way (`src/auth.js`: secret key = HMAC-SHA256 of the bot token with key `"WebAppData"`; the hash must equal the HMAC of every other field, sorted, as `key=value` lines), compares in constant time, and rejects data older than 24 h or dated in the future (`auth_date`). The user id comes only from verified data; the body can never name a user. Wrong data gets 401 "Please close and reopen the settings from the bot." |
| Admin tab / admin API | shown only when the verified user id equals `OWNER_TELEGRAM_ID`. Hiding the tab is cosmetic; the API checks the id on every admin call and answers 403 to anyone else (tested for all three admin routes, and against the live Worker). |
| Mini App page | served with a Content-Security-Policy (scripts from itself and telegram.org only, API calls to itself only), `nosniff`, no referrer. All text from the database is HTML-escaped before display. |
| Worker → GitHub | fine-grained personal access token: only `RobBudaghyan/axiom-news`, only "Actions: read and write", no expiration (owner's choice, 2026-11-13). It can start workflows; it cannot read or change code or secrets. A Worker secret. |
| Secrets | `.env` locally (gitignored). In production: GitHub Actions secrets (`GEMINI_API_KEY`, `GROQ_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `CLOUDFLARE_D1_TOKEN`) and Cloudflare Worker secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `OWNER_TELEGRAM_ID`, `GITHUB_DISPATCH_TOKEN`, and since Step 13 `GEMINI_API_KEY`, `GROQ_API_KEY` for the custom-topic check). Each side holds only what it needs. The job never sees the Telegram token. Values are copied from `.env` by `scripts/set_secrets.py` through stdin, never printed. |
| Public repo | `scripts/scan_secrets.py` checks every `.env` value and common token shapes against the whole git history and every file before a push (run on its own, never piped). GitHub push protection is on. Commits use the owner's GitHub noreply address. The D1 database id is committed on purpose in `worker/wrangler.toml` (wrangler needs it; it grants nothing without the D1 token). |
| Data sent to AI | public news titles and snippets; since Step 13 also the text a reader types as a new custom topic (never their name or id; a rejected one is not kept beyond `topic_checks`). No other user data goes to an AI provider. This matters because Gemini's free tier states content is "used to improve our products". |

## 7. AI design, budget and fallback

**Primary: Gemini free tier**, using a key from a Google project with no billing account. Model:
`gemini-3.5-flash-lite`, listed as Stable and "Free of charge" on the official pricing page
(checked 2026-11-13). `gemini-2.5-flash` is deprecated and gets re-routed on 2026-12-01, so we avoid
it. The model is set by `GEMINI_MODEL` so it can be swapped without a code change (lesson 1).
**Second Gemini model:** `gemini-3.1-flash-lite` (`GEMINI_FALLBACK_MODEL`) is tried before Groq.
On 2026-11-13 the primary model returned HTTP 503 "high demand" on about half of all calls, and
an overload like that is per model.

**Measured on 2026-11-13 (real calls with the owner's key):**
- **Model check.** `gemini-3.5-flash-lite` is in the model list (version `3.5-flash-lite-07-2026`)
  and answered a small real call. `thinkingLevel: low` is accepted, and no thought tokens were
  reported.
- **A real hourly batch fits in one call.** 230-233 new items plus 250 existing-story stand-ins
  came to 87-90k characters and **23.1-23.6k input tokens** by `countTokens`, close to the Step 1
  estimate of ~26k. The free tier accepted it in one call; size never caused a 429. The first
  run's 435 items (29.1k tokens) were also accepted.
- **Output is much bigger than planned:** **11-18k tokens** instead of 3-4k, because the model
  writes 120-200 stories plus the not-news list. One call takes **45-85 s**.
- **Failures seen, all now handled:**
  - HTTP 503 "This model is currently experiencing high demand" on about half of ~20 calls,
    sometimes several in a row.
  - One degenerate answer: 0 of 435 items placed.
  - Answers to 500+ item chunks that covered only 30-40% of the items.
- **Limits are still not published.** Google shows per-model TPM/RPD only in AI Studio. A
  29k-token call, and about 10 calls within one hour, went through without a rate-limit error.

**Budget math (measured volume):**
- Raw volume across the 116 feeds is about **8,900 items/day**. Most of it comes from TASS, RIA,
  Rossiyskaya Gazeta, Izvestia, RBC, Interfax, Trend and Anadolu.
- With the 8-per-feed-per-run cap, a normal hour brings about **70-230 new items**. The first
  run, looking back 3 h, brought 435.
- Normal operation is **48 calls/day** since Step 5: per hour one first-pass call and one editor
  call, regardless of user count. First pass: about 0.55M input and 0.35M output tokens/day (the
  first GitHub run with the editor: 13k in, 1.5k out for 44 new items). Editor, measured
  2026-11-14: 6.5-12.5k input and 2.5-6.2k output tokens per call, so about 0.25M input and 0.12M
  output tokens/day. Only a backlog makes 2-4 first-pass calls in one run, in chunks of about 25k
  estimated tokens.
- If the cap proves too low or too high, it is one number in config (plus `max_items` per feed
  since Step 7). Armenian script costs about 164 Gemini tokens per item with its snippet, Russian
  89, English 70 (measured on News.am, 2026-11-14); `ai.estimate_tokens` counts Armenian at 1.6
  characters per token. Lowering it to 5 per feed
  gives about 3,800 items/day.

**Fallback: Groq free plan** (`openai/gpt-oss-120b`).
- **Limits read from Groq's response headers on 2026-11-13:** **1,000 requests/day and 8,000
  tokens/minute.** The other chat models on the account (`openai/gpt-oss-20b`,
  `qwen/qwen3.8-27b`) have the same 8,000 TPM. Tokens per day is not in the headers; the docs
  say 200,000.
- **The 8,000 counts the prompt plus the reserved reply room** (`max_completion_tokens`):
  - A full batch was refused with HTTP 413 ("Requested 22239").
  - Chunks of 5k estimated tokens plus 3k reply room were refused at 8,162-8,277.
  - Chunks of 5k plus 3k reply room got cut off.
- **Chunks now:** about 3.5k estimated prompt tokens (~30 items plus the newest 30 existing
  stories) and 3.5k reply room. A chunk takes ~6 s, of which ~1.4k tokens are the model's own
  reasoning. The next chunk must wait for the per-minute window, so the pace is **about one chunk
  per minute**.
  - A short 429 is waited out.
  - A 413 or a cut-off answer splits the chunk.
  - Each chunk's stories are written before the next one, so duplicates across chunks still
    merge.
- **At most 8 Groq chunks per run** (~240 items, ~8 minutes). A normal hour fits; a bigger
  backlog leaves the rest pending for the next run. 200k tokens/day is about 28 chunks, or 3-4
  full fallback hours a day.
- **Calls per day:** normally 48 (24 + 24 editor). On a day when Gemini is overloaded, the
  retries, the second model and Groq chunks can bring this to roughly 80-110 calls, above the
  spec's target.
  All of these are free calls.
- **If every provider fails**, items stay `pending` and go into the next run (they are kept up to
  24 h, then `expired`). An empty or safety-blocked response counts as a failure, never as "no
  news" (lesson 2).

Other free options checked and **rejected** (2026-11-13):
- **Cerebras:** only a one-time $5 credit that "expires 30 days after activation" and requires a
  payment method.
- **Mistral:** the current docs say API use needs billing activation.
- **OpenRouter `:free` models:** they need no card and allow 20 RPM, but only **50 requests/day**
  without buying credits, and free-model availability changes often. This is a possible third fallback
  later, but it is not in v1.

## 8. Free-tier limits we rely on (verified 2026-11-13 from official docs)

| Service | Limit | Our expected use | Source |
|---|---|---|---|
| Workers Free | 100,000 requests/day | < 1,000/day (288 cron ticks, plus webhook and Mini App calls) | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Workers Free | **10 ms CPU** per HTTP request and per Cron Trigger. Waiting on D1/fetch does not count. "Each isolate has some built-in flexibility" for infrequent overruns; consistent overruns are terminated (error 1102, `exceededCpu`) | **measured on Cloudflare 2026-11-13** (`wrangler tail` cpuTime): idle tick 4 ms; tick with 1 due user 6 ms; 20 users 10-27 ms; 40 users 46 ms. Hence **8 users per tick** (≈6-12 ms) and dedupe moved into the job. **Mini App API, measured 2026-11-14:** open 3-6 ms, save 1-5 ms, admin data 0-3 ms, 2 ms with all 115 feeds' health (see §4a). **Step 5** (editor text, two-message split): idle tick 3-6 ms; the first real 1-user digest tick 11 ms, then the fallback emoji dictionary was made lazy (see the Step 5 report) | same |
| Workers Free | 50 subrequests per invocation (D1 calls and `fetch` count) | per cron tick: 1 batched read, 1 batched candidate read, 1 Telegram call per user, 1 batched write (+1 alert): about 12 with 8 users | same; [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) ("a `db.batch()` call counts as one query") |
| Workers Free | 5 Cron Triggers per account | 2 (`*/5 * * * *`, `7 * * * *`) | Workers limits |
| Workers static assets | "Requests to static assets are free and unlimited" | Mini App files | [Static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) |
| D1 Free | 5M rows read/day, 100k rows written/day, 5 GB total, 500 MB per DB; resets 00:00 UTC; when a limit is hit, queries fail until reset | writes about 35k/day (items ~4.6k × ~3 including index rows, stories, sent, plus deletes from pruning); reads well under 0.5M/day with indexes; DB < 50 MB with 7-day pruning | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 | 100 bound parameters per query, 100 KB per SQL statement | the job batches inserts to stay under both | D1 limits |
| Cloudflare API | 1,200 requests per 5 min per user | about 10-20 REST calls per hourly run | [API limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/) |
| GitHub Actions | **public repo: standard runners free and unlimited** (our case since Step 3). Private repos: ≈2,000 included min, blocked (never billed) when used up | first run on GitHub: 2 min 0 s (job 114 s, a 2.5 h backlog of 342 items). About 24-25 runs/day | [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) |
| GitHub Actions schedule | minimum every 5 min; can be delayed or dropped under load; runs on the default branch only; **public repos: schedules auto-disabled after 60 days without repo activity** | backup only, at :37, in its own workflow file; the main trigger is the Worker | [Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows) |
| Gemini free tier | per-model limits shown in AI Studio only; RPD resets at midnight Pacific; free-tier content is used to improve Google's products. Measured 2026-11-13: 29k-token calls accepted, frequent 503 "high demand" | 48 calls/day: 24 first-pass calls (about 23k input + 15k output tokens each) and 24 editor calls (about 11k input + 5k output) | [Rate limits](https://aistudio.google.com/docs/rate-limits), [Pricing](https://aistudio.google.com/docs/pricing), [Models](https://aistudio.google.com/docs/models) |
| Groq free | gpt-oss-120b: 1K RPD and 8K TPM read from response headers 2026-11-13 (TPM counts prompt + reserved reply); 200K TPD per docs | fallback only, ~1 chunk/min | [Groq rate limits](https://console.groq.com/docs/rate-limits) |
| Telegram Bot API | ≤ 1 message/sec per chat; about 30 messages/sec bulk; 4,096 characters per message | ≤ 20 users per tick, 1 message each | [Bots FAQ](https://core.telegram.org/bots/faq) |

Repo visibility: **public** (owner's decision in Step 3, changed from private), for unlimited free
Actions minutes. The 60-day schedule auto-disable no longer matters for the main trigger, because
the Worker starts the job through the API; only the backup schedule can be disabled, and the
Worker's health alert would report missing runs.

## 9. Repository layout

```
config/topics.yaml, config/sources.yaml   the six main topics; the feeds
config/digest.json                        digest rules read by the Worker and the job (bars, caps, topic order)
config/custom_topics.json, ai_budget.json readers' own topics; the AI budget guard
config/languages.json, i18n/, glossary.yaml   reader languages, every text a reader sees, name spellings
config/common_words.txt                   ordinary English words for the fact guard (Step 15)
config/line_emoji.json, candidates/       fallback line emojis; tested feeds not added
prompts/story_batch.md, editor.md, translate.md   the AI prompts
db/schema.sql                             D1 tables (applied via REST: scripts/apply_schema.py)
job/                                      the hourly job: run, fetch, ai, d1, dupes, editor, translate, custom, gnews, guard, config
tests/, tests/fixtures/                   job tests; fixtures shared with the Worker tests
scripts/                                  apply_schema, set_secrets, scan_secrets, check_feeds, make_*_cases (fixtures),
                                          make_common_words, ai_probe, discover_feeds, source_dry_run, armenia_* (dev tools)
scripts/archive/                          one-off scripts of past steps (measurements, replays, mutation checks)
worker/src/                               the Worker: index, bot, api, auth, settings, digest, cron, custom, guard, onboard,
                                          announce, feedback, tips, admin, health, github, telegram, i18n, db
worker/public/app/                        the Mini App: index.html, app.css, app.js, i18n.js (generated); _headers
worker/test/                              node:test suite (node:sqlite with the real schema)
worker/scripts/                           digest-cli (previews, replays), stamp-app, setup-bot, dev-server + dev/,
                                          ui-check, screenshots, api-check, migrate-topics, import-users
worker/scripts/archive/                   one-off scripts of past steps (previews, CPU checks, migrations that ran)
worker/wrangler.toml                      Worker config: D1 binding, crons, assets, vars (no secrets)
docs/screenshots/                         the Mini App at 390 px, light and dark (demo data)
.github/workflows/                        hourly.yml, backup-schedule.yml, check-feeds.yml
reports/, reports/data/                   one report per step, with its numbers and screenshots
```

## 10. Known design risks

- **Feeds from GitHub's runners:** checked in Step 3. 115 of 116 work; The Times of Israel returns
  403 there and is disabled with a note. Re-run the "check feeds" workflow if many feeds start
  failing.
- **Worker 10 ms CPU** is the tightest limit. Measured: 6 ms for one due user, 10-27 ms for 20.
  Mitigated by doing dedupe in the job, 40 candidates per user and 8 users per tick; with ~20
  users at the same time some get their digest up to 10 minutes late. The per-tick log line
  (Workers Logs) shows counts; watch Metrics > Errors for `exceededCpu`.
- **The GitHub token** has no expiration, but it can be revoked or the owner's account settings
  can change. A failed dispatch is logged and alerted, and the backup schedule keeps the pool
  updating in the meantime.
- **Duplicate check is word-based.** It misses duplicates worded very differently (two lines on
  the same Abu Dhabi talks share only the place name) and sometimes merges two different stories
  about the same thing (two separate "undesirable organisation" rulings).
- **The per-feed cap drops some items** from the biggest Russian state feeds. Major stories still
  arrive through other outlets; minor TASS/RIA items are the main loss, and that is intended.
- **Gemini overload (HTTP 503)** was frequent on 2026-11-13. A second Gemini model and then Groq
  take over, but Groq is slow (about 1 chunk per minute). A long overload makes runs take several
  minutes and can leave items pending.
- **AI grouping errors.** Seen in Step 2:
  - Over-merged "roundup" stories, where several events were folded into one summary.
  - One item placed in the wrong story.

  The prompt and code now guard against both, but grouping stays the weakest part of the
  quality. Watch the first days of real digests.
- **Topic balance.** Many feeds are Russian and Ukrainian. Steps 3-7 capped a topic at 40% of a
  digest; Step 8 removed the cap (digests have no fixed size). What is left: the topic boost caps
  (the wars get at most +1), each followed topic's best story survives the length cut, and ties
  in the cut go from the most crowded section first. A heavy war day can still fill much of a
  digest.
- **Topic scores (Step 8)** are the model's judgement, capped in code. It still lifts some
  statements and ceremonies on Armenia and Russia by 1-2 points (a gala concert, "X says..."),
  and its main topic differs from the stored one for about 1 in 8 stories.
- **The editor pass (Step 5)** decides what users see, so its mistakes matter more:
  - it can merge two different events, or miss a duplicate (the roundup guard and the
    "keep apart when unsure" rule help; the 30% word-based miss rate was the reason to add it);
  - its scores cluster at 5-6 and are whole numbers, so one point moves a digest from 4 to 12
    stories (§3, tuning); the bars may need a nudge after a week of real digests;
  - a description can still be wrong in ways the fact guard cannot see (a wrong verb, a mixed-up
    actor); numbers and names are checked;
  - it sometimes rates big stories outside our topics higher than the prompt asks (the US flight
    ground stop got a 7 although the prompt puts flight disruptions at 1-2).
