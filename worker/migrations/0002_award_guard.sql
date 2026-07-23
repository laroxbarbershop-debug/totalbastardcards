-- award cooldown + transaction guard
-- last_award_at: server-enforced minimum gap between card awards per user
ALTER TABLE users ADD COLUMN last_award_at INTEGER NOT NULL DEFAULT 0;

-- txguard: never holds rows. Inserting SELECT NULL into the NOT NULL column
-- only when a precondition FAILS turns "precondition failed" into a SQL error,
-- which rolls back the whole D1 batch — poor man's conditional transaction.
CREATE TABLE txguard (x INTEGER NOT NULL);
