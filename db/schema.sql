-- Axiom News D1 schema (SQLite). Safe to re-apply: every statement uses IF NOT EXISTS.
-- Applied with: venv/Scripts/python scripts/apply_schema.py
-- Times are INTEGER unix seconds (UTC). JSON lists are stored as TEXT.
-- Indexes are kept to a minimum: on D1 every index update counts as an extra row written.

-- One row per Telegram user. `sent` is the only other per-user table: deleting or resetting
-- a user must delete their `sent` rows too (docs/LESSONS.md, lesson 16).
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,               -- Telegram user id
  first_name     TEXT,
  language       TEXT NOT NULL DEFAULT 'en',
  timezone       TEXT NOT NULL DEFAULT 'Asia/Yerevan',
  tz_detected    INTEGER NOT NULL DEFAULT 0,        -- 0 default zone, 1 from the device (Mini App), 2 chosen by hand
  digest_times   TEXT NOT NULL DEFAULT '["09:00","14:00","20:00"]',
  max_stories    INTEGER NOT NULL DEFAULT 7,        -- unused since Step 5 (digests have no fixed count)
  topics         TEXT NOT NULL DEFAULT '[]',        -- JSON list of topic tags
  paused         INTEGER NOT NULL DEFAULT 0,
  blocked        INTEGER NOT NULL DEFAULT 0,        -- 1 after Telegram 403 (user blocked the bot)
  created_at     INTEGER NOT NULL,
  last_digest_at INTEGER,
  next_digest_at INTEGER,
  format         TEXT,                              -- unused since Step 5 (one format for everyone)
  lang           TEXT NOT NULL DEFAULT 'en'         -- Step 9: the reader's language (config/languages.json). `language`
                                                    -- above is Telegram's code, refreshed on every /start and open;
                                                    -- `lang` is set once on creation and then only by the Mini App
);
CREATE INDEX IF NOT EXISTS idx_users_next ON users(next_digest_at);

-- Synced from config/topics.yaml by the hourly job; read by the Worker.
CREATE TABLE IF NOT EXISTS topics (
  tag        TEXT PRIMARY KEY,
  label_en   TEXT NOT NULL,
  label_ru   TEXT,
  emoji      TEXT,
  sort       INTEGER NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 1
);

-- One row per article URL seen. status:
--   pending  waiting for the AI pass (kept up to 24 h, retried every run)
--   done     placed in a story (story_id set)
--   dropped  the AI judged it not news on our topics
--   expired  still pending after 24 h (both AI providers kept failing)
CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY,
  url_hash     TEXT NOT NULL UNIQUE,                -- sha256 of the normalized link
  source_key   TEXT NOT NULL,
  source_name  TEXT NOT NULL,
  tier         INTEGER NOT NULL,
  url          TEXT NOT NULL,
  title        TEXT NOT NULL,
  snippet      TEXT,
  published_at INTEGER,
  fetched_at   INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  story_id     INTEGER,
  -- Step 13: items found by a custom-topic Google News search (source_key 'gnews', tier 4)
  headline_only INTEGER NOT NULL DEFAULT 0,         -- 1 = Google gives the headline only, no snippet
  hint_topic   TEXT                                 -- the custom tag whose search found it
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);

-- The story pool. best_* is the link shown to users: lowest tier wins, then earliest.
CREATE TABLE IF NOT EXISTS stories (
  id                INTEGER PRIMARY KEY,
  summary           TEXT NOT NULL,
  topics            TEXT NOT NULL,                  -- JSON list of topic tags
  importance        INTEGER NOT NULL,               -- 1..10
  best_url          TEXT NOT NULL,
  best_source       TEXT NOT NULL,
  best_tier         INTEGER NOT NULL,
  best_published_at INTEGER,
  source_count      INTEGER NOT NULL DEFAULT 1,     -- items attached to this story
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  dup_group         INTEGER,                        -- near-duplicate group leader (job/dupes.py); NULL = not grouped yet
  -- Step 5, written by the editor pass (job/editor.py):
  headline          TEXT,                           -- one sentence for the digest; NULL = use summary
  description       TEXT,                           -- 1-3 sentences, only facts from the items
  emojis            TEXT,                           -- e.g. flags of the main actors + a subject emoji
  final_score       INTEGER,                        -- strict editorial score 1..10; NULL = not edited
  edited_at         INTEGER,                        -- NULL = not edited yet, or needs re-editing
  merged_into       INTEGER,                        -- the editor found this is a duplicate of that story
  main_topic        TEXT,                           -- the one topic it is mainly about (its digest section)
  -- Step 8:
  topic_score       INTEGER,                        -- 1..10 for readers who follow main_topic (>= final_score); NULL = use final_score
  scored_at         INTEGER,                        -- when the editor first scored it (digest window: a late score still counts)
  -- Step 13:
  link_state        INTEGER                         -- Google link: NULL not tried, 1 resolved to the outlet, 2 failed (Google link kept)
);
CREATE INDEX IF NOT EXISTS idx_stories_updated ON stories(updated_at);

-- Step 9: a story's headline and description in a reader language, written by the hourly job
-- (job/translate.py) for stories that could reach a digest, in the languages active users read.
-- A row counts only while `src` equals the story's current English text (compared in SQL by the
-- digest query), so a re-edited headline makes it stale at once. ok = 0: a guard rejected the
-- last attempt (note says why); it is redone next run.
CREATE TABLE IF NOT EXISTS story_translations (
  story_id    INTEGER NOT NULL,
  lang        TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  headline    TEXT,
  description TEXT,
  src         TEXT NOT NULL,                        -- coalesce(headline, summary) || char(10) || coalesce(description, '')
  note        TEXT,
  provider    TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (story_id, lang)
) WITHOUT ROWID;

-- "Never send the same story twice": one row per (user, story) delivered.
CREATE TABLE IF NOT EXISTS sent (
  user_id  INTEGER NOT NULL,
  story_id INTEGER NOT NULL,
  sent_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, story_id)
) WITHOUT ROWID;

-- Step 10: a story left out of a reader's digest because it had no translation into the reader's
-- language yet. It is NOT in `sent`, so it can still go out once translated: the digest query
-- also takes held stories that are older than the last digest (still inside the 24 h window).
-- One row per (user, story); `at` = the last digest that held it. Admin counts the last 24 h.
CREATE TABLE IF NOT EXISTS digest_holds (
  user_id  INTEGER NOT NULL,
  story_id INTEGER NOT NULL,
  lang     TEXT NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, story_id)
) WITHOUT ROWID;

-- Step 10: voluntary tips in Telegram Stars. Only who tipped, the amount, Telegram's charge id
-- (needed for a refund) and the time; refunded_at is set when the owner refunds it from Admin.
-- The UNIQUE charge id makes a repeated successful_payment update count once.
CREATE TABLE IF NOT EXISTS tips (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  amount      INTEGER NOT NULL,
  charge_id   TEXT NOT NULL UNIQUE,
  at          INTEGER NOT NULL,
  refunded_at INTEGER
);

-- One row per hourly job run (Admin tab stats).
CREATE TABLE IF NOT EXISTS job_runs (
  id                 INTEGER PRIMARY KEY,
  started_at         INTEGER NOT NULL,
  finished_at        INTEGER,
  status             TEXT NOT NULL,                 -- running, ok, partial, ai_failed, error
  feeds_ok           INTEGER,
  feeds_failed       INTEGER,
  items_fetched      INTEGER,                       -- entries inside the lookback window
  items_new          INTEGER,                       -- new URLs stored this run (after the cap)
  items_pending_in   INTEGER,                       -- pending items sent to the AI (new + retries)
  stories_created    INTEGER,
  stories_merged     INTEGER,                       -- existing stories that gained items
  items_dropped      INTEGER,
  items_expired      INTEGER,
  items_left_pending INTEGER,
  provider           TEXT,                          -- gemini, groq, gemini+groq, or NULL
  ai_calls           INTEGER,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  pruned             INTEGER,                       -- rows deleted by the daily prune, NULL if skipped
  error              TEXT,
  d1_rows_read       INTEGER,                       -- D1's own counts for this run (Admin tab: D1 use today)
  d1_rows_written    INTEGER,
  editor_status      TEXT,                          -- Step 5: ok, failed, skipped (no candidates)
  editor_candidates  INTEGER,
  editor_merged      INTEGER                        -- stories the editor merged into another
);

CREATE TABLE IF NOT EXISTS ai_calls (
  id            INTEGER PRIMARY KEY,
  run_id        INTEGER,
  at            INTEGER NOT NULL,
  provider      TEXT NOT NULL,
  model         TEXT,
  ok            INTEGER NOT NULL,
  items         INTEGER,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  ms            INTEGER,
  error         TEXT,
  kind          TEXT,                               -- Step 5: 'batch' (pass 1) or 'editor'; NULL = batch. Step 13: 'topic_check' (Worker)
  code          INTEGER                             -- Step 13: HTTP status of a failed call (429 = rate limit), NULL if none
);
-- Step 13: the AI budget guard counts today's calls (since midnight Pacific time).
CREATE INDEX IF NOT EXISTS idx_ai_calls_at ON ai_calls(at);

-- Step 13: custom topics ("My topics"). Shared: two readers who add "Colombia" follow one row.
-- Created by the Worker after one AI check (worker/src/topiccheck.js); searched hourly by the job
-- (job/custom.py) while at least one active, unpaused reader follows it with the switch on; deleted by
-- the job 7 days after its last follower left (orphan_since: no follow row at all, on or off).
CREATE TABLE IF NOT EXISTS custom_topics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,    -- never reused: old stories keep a deleted topic's tag
  tag          TEXT UNIQUE,                          -- 'c' || id, set right after the insert
  names        TEXT NOT NULL,                        -- JSON {en, ru, hy, fr}
  emoji        TEXT,
  definition   TEXT NOT NULL,                        -- one English sentence for the AI passes
  queries      TEXT NOT NULL,                        -- JSON [{q, ed}] (ed: a key of config/custom_topics.json editions)
  boost_max    INTEGER NOT NULL DEFAULT 0,           -- 0..2, like topic_boost_max
  keywords     TEXT,                                 -- Step 14: JSON {en: [...], ru: [...]}, 5-15 each; a story keeps this tag only if one is in its English headline or description
  keywords_at  INTEGER,                              -- Step 15: when the keywords were written; the job refreshes them after 7 days (0 = refresh now, Admin)
  aliases      TEXT NOT NULL DEFAULT '[]',           -- JSON: normalised inputs that mapped here
  created_by   INTEGER,
  created_at   INTEGER NOT NULL,
  searched_at  INTEGER,                              -- last Google search
  orphan_since INTEGER                               -- set when the last follower left
);

CREATE TABLE IF NOT EXISTS custom_follows (
  user_id  INTEGER NOT NULL,
  topic_id INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  enabled  INTEGER NOT NULL DEFAULT 1,              -- Step 13 fixes: the reader's switch; off = kept (counts toward the 3), not searched or sent for them
  PRIMARY KEY (user_id, topic_id)
) WITHOUT ROWID;

-- Names the owner blocked in Admin: they cannot be created again (normalised form).
CREATE TABLE IF NOT EXISTS topic_blocks (
  norm TEXT PRIMARY KEY,
  name TEXT,
  at   INTEGER NOT NULL
) WITHOUT ROWID;

-- Every "add a topic" request: the 5-a-day limit and Admin's outcome counts.
-- outcome: accepted, joined, rejected, main_topic, delayed, blocked, failed
CREATE TABLE IF NOT EXISTS topic_checks (
  id       INTEGER PRIMARY KEY,
  user_id  INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  input    TEXT NOT NULL,
  outcome  TEXT NOT NULL,
  topic_id INTEGER,
  reason   TEXT,
  ai       INTEGER NOT NULL DEFAULT 0                -- 1 = an AI call was made (counts toward the 5 a day)
);

-- Per custom topic per UTC day: what the hourly searches did (Admin).
CREATE TABLE IF NOT EXISTS custom_topic_days (
  topic_id    INTEGER NOT NULL,
  day         TEXT NOT NULL,                         -- YYYY-MM-DD (UTC)
  searches    INTEGER NOT NULL DEFAULT 0,
  fetched     INTEGER NOT NULL DEFAULT 0,
  dup_dropped INTEGER NOT NULL DEFAULT 0,
  new_items   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (topic_id, day)
) WITHOUT ROWID;

-- Small key/value state. Worker: last_alert_at, last_alerted_run_id, last_alert_text, d1_worker
-- (its D1 rows today). Job: feed_health (JSON per feed: last ok, newest entry, last error).
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS errors (
  id        INTEGER PRIMARY KEY,
  at        INTEGER NOT NULL,
  component TEXT NOT NULL,                          -- job or worker
  message   TEXT NOT NULL
);

-- Step 6 coverage experiment (SHADOW MODE, job/shadow.py): Google News search results.
-- Nothing reads these tables except the experiment's own scripts: not the real job steps, not
-- the Worker, not digests. Pruned after 3 days by the shadow step itself.
CREATE TABLE IF NOT EXISTS shadow_items (
  id            INTEGER PRIMARY KEY,
  guid          TEXT NOT NULL UNIQUE,               -- Google's article id
  run_id        INTEGER,                            -- shadow_runs.id of the run that first saw it
  topic         TEXT NOT NULL,                      -- topic of the first query that found it
  topics        TEXT NOT NULL,                      -- JSON list: topics of every query that found it
  query_key     TEXT NOT NULL,                      -- e.g. armenia:ru:4 (topic:edition:index in the config)
  hits          INTEGER NOT NULL DEFAULT 1,         -- queries that returned it in that run
  edition       TEXT NOT NULL,                      -- en, ru, ...
  title         TEXT NOT NULL,                      -- headline without the " - Outlet" suffix
  source        TEXT,                               -- outlet name
  source_domain TEXT,                               -- outlet site
  curated_outlet INTEGER,                           -- 1 = an outlet we already read through RSS
  link          TEXT NOT NULL,                      -- news.google.com/rss/articles/... (not resolved)
  published_at  INTEGER,
  fetched_at    INTEGER NOT NULL,
  live_sim      REAL,                               -- best title similarity to a live item (last 24 h)
  live_item_id  INTEGER,                            -- that item
  shadow_sim    REAL,                               -- best title similarity to an earlier shadow item
  shadow_dup_of INTEGER,                            -- that shadow item
  dup           TEXT                                -- NULL unique; 'live' or 'shadow' = title duplicate
);

CREATE TABLE IF NOT EXISTS shadow_runs (
  id             INTEGER PRIMARY KEY,
  at             INTEGER NOT NULL,
  ms             INTEGER,
  queries        INTEGER,
  queries_failed INTEGER,
  codes          TEXT,                              -- JSON: HTTP status (or error) -> count
  fetched        INTEGER,                           -- items returned, with repeats across queries
  distinct_items INTEGER,
  seen_before    INTEGER,                           -- already stored by an earlier shadow run
  new_items      INTEGER,
  dup_live       INTEGER,
  dup_shadow     INTEGER,
  unique_items   INTEGER,
  per_topic      TEXT,                              -- JSON per topic: fetched, new, dup_live, dup_shadow, unique
  error          TEXT,
  pruned         INTEGER,
  first_id       INTEGER,                           -- lowest shadow_items.id written by this run
  d1_rows_read   INTEGER,
  d1_rows_written INTEGER
);
