-- Stories for one user's digest (a database filter, no AI). Shared on purpose: used by
-- scripts/send_test_digest.py now and by the Worker's digest cron in Step 3, so both pick
-- exactly the same stories.
-- Parameters: ?1 user id, ?2 the user's topic tags as a JSON list, ?3 since (unix seconds:
-- the last digest, at most 24 h back), ?4 max stories.
-- Rules: on one of the user's topics, importance >= 4, created or updated since the last
-- digest, never sent to this user before. Most important first, then most recent.
SELECT s.id, s.summary, s.best_url, s.best_source, s.importance, s.topics, s.updated_at
FROM stories s
WHERE s.updated_at >= ?3
  AND s.importance >= 4
  AND EXISTS (SELECT 1 FROM json_each(s.topics) t
              WHERE t.value IN (SELECT u.value FROM json_each(?2) u))
  AND NOT EXISTS (SELECT 1 FROM sent x WHERE x.user_id = ?1 AND x.story_id = s.id)
ORDER BY s.importance DESC, s.updated_at DESC, s.id DESC
LIMIT ?4
