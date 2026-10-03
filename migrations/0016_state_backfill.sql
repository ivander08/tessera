-- Backfill: copy the live state document onto the newest snapshotless rows of the path.
--
-- `0011` added `state_json` but did not backfill, so every chat that existed before it has
-- a real live document in `state` and NULL snapshots along its whole path. The turn reader
-- (`loadStateForTurn`) walks the path rather than trusting the live row — that is what
-- makes a deleted turn un-advance the world with it — so those chats would read as EMPTY
-- and re-derive their scene from nothing.
--
-- The newest visible row per chat is the honest place for the copy: the live document is
-- the state as of the end of the visible path by definition. Older rows stay NULL, which
-- the reader already interprets as "most recent snapshot at or before" — a chat whose
-- history predates snapshots reads from its newest row, which is exactly "as of now",
-- and the next turns write real per-turn snapshots from there on.
--
-- The visible path is the active, undeleted walk from the active root. Approximated here
-- with the same predicates the walk applies (active = 1 AND deleted = 0 rooted at the
-- active root); the recursive ordering is not needed to pick "the newest such row", and a
-- flat MAX(seq) matches what the walk reaches in the only cases that matter — one active
-- child per position is the invariant the app maintains and heals.
UPDATE messages
   SET state_json = (
     SELECT s.json FROM state s WHERE s.chat_id = messages.chat_id
   )
 WHERE messages.rowid IN (
   SELECT m.rowid FROM messages m
    WHERE m.state_json IS NULL
      AND m.active = 1
      AND m.deleted = 0
      AND m.parent_id IS NOT NULL
      AND m.seq = (
        SELECT MAX(c.seq) FROM messages c
         WHERE c.chat_id = m.chat_id AND c.active = 1 AND c.deleted = 0
      )
      AND EXISTS (SELECT 1 FROM state s WHERE s.chat_id = m.chat_id)
);
