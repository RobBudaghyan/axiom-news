// Step 17 (launch): deleting a reader and everything about them. Used by Admin ("Delete user", owner
// only) and by the reader themself (Help > "Delete my data"). One batch (one transaction), so a
// deletion is all or nothing. Afterwards the person is unknown to the bot: their next /start is a
// brand-new user (welcome, setup, sample digest), and nothing is ever sent to them before that.
//
// What goes, keyed to the user id: users, sent, digest_holds, custom_follows, feedback,
// announcement_sends, topic_checks, and the error notes that name them. What stays, without the id:
// tips (amount, date and Telegram's charge id for the totals; user_id 0, so a refund is no longer
// possible) and custom topics they created (created_by cleared). A custom topic nobody follows any
// more starts the normal 7-day clock (orphan_since), exactly as when its last follower removes it.

export const USER_TABLES = ["sent", "digest_holds", "custom_follows", "feedback", "announcement_sends", "topic_checks"];

export function deleteUserStatements(userId, now) {
  const id = Number(userId);
  return [
    // before the follows go: topics where this was the last follower start the 7-day clock
    { sql: "UPDATE custom_topics SET orphan_since = ?2 WHERE orphan_since IS NULL " +
           "AND id IN (SELECT topic_id FROM custom_follows WHERE user_id = ?1) " +
           "AND NOT EXISTS (SELECT 1 FROM custom_follows f WHERE f.topic_id = custom_topics.id AND f.user_id <> ?1)",
      params: [id, now] },
    ...USER_TABLES.map((table) => ({ sql: `DELETE FROM ${table} WHERE user_id = ?1`, params: [id] })),
    { sql: "UPDATE tips SET user_id = 0 WHERE user_id = ?1", params: [id] },
    { sql: "UPDATE custom_topics SET created_by = NULL WHERE created_by = ?1", params: [id] },
    // the Worker's error notes name a reader as "user <id>:", "for <id>:" or "to <id>:"
    { sql: "DELETE FROM errors WHERE message LIKE '%user ' || ?1 || ':%' OR message LIKE '% for ' || ?1 || ':%' " +
           "OR message LIKE '% to ' || ?1 || ':%'",
      params: [String(id)] },
    { sql: "DELETE FROM users WHERE id = ?1 RETURNING id", params: [id] },
  ];
}

// Returns true if a user row was deleted (false: there was no such user).
export async function deleteUser(db, userId, now) {
  const res = await db.batch(deleteUserStatements(userId, now));
  return (res[res.length - 1] ?? []).length > 0;
}
