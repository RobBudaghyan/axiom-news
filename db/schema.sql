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
  max_stories    INTEGER NOT NULL DEFAULT 7,        -- 3..15
  topics         TEXT NOT NULL DEFAULT '[]',        -- JSON list of topic tags
  paused         INTEGER NOT NULL DEFAULT 0,
  blocked        INTEGER NOT NULL DEFAULT 0,        -- 1 after Telegram 403 (user blocked the bot)
  created_at     INTEGER NOT NULL,
  last_digest_at INTEGER,
  next_digest_at INTEGER,
  format         TEXT                               -- 'A' or 'B' (Mini App); NULL = config/digest.json default
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
  story_id     INTEGER
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
  dup_group         INTEGER                         -- near-duplicate group leader (job/dupes.py); NULL = not grouped yet
);
CREATE INDEX IF NOT EXISTS idx_stories_updated ON stories(updated_at);

-- "Never send the same story twice": one row per (user, story) delivered.
CREATE TABLE IF NOT EXISTS sent (
  user_id  INTEGER NOT NULL,
  story_id INTEGER NOT NULL,
  sent_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, story_id)
) WITHOUT ROWID;

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
  d1_rows_written    INTEGER
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
  error         TEXT
);

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
