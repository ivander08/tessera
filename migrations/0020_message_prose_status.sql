-- The prose guard's state, on the reply it inspected.
--
-- The repaired version is a sibling row, but the state belongs to the ORIGINAL: that is
-- the row that was checked, that stays on screen in auto mode, and that a retry re-runs.
-- One-to-one, so no table, no join, no cleanup — a deleted reply takes its state with it.
--
-- NULL is every reply written before this existed, and every reply the guard never
-- inspected (guard off, continue, impersonation). The client treats NULL as "no claim".
ALTER TABLE messages ADD COLUMN prose_status TEXT;      -- clean|issues|queued|repairing|done|failed
ALTER TABLE messages ADD COLUMN prose_violations TEXT;  -- JSON array: kind, detail, snippet
ALTER TABLE messages ADD COLUMN prose_error TEXT;       -- why the last repair failed
ALTER TABLE messages ADD COLUMN prose_updated_at INTEGER;
