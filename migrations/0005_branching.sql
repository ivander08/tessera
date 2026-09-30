-- Branching: a chat is a tree, not a list.
--
-- `messages.parent_id` has existed since 0000 and was never written. It is now the
-- structure: every row records the row it answers, and the transcript is the active
-- chain that starts at the opening greeting.
--
-- That is what makes regenerating an OLD message behave the way a reader expects. The
-- new version is an alternative at that position with no continuation of its own, so
-- everything written after the old version leaves the visible path. None of it is
-- deleted — swiping back to the old version brings the whole continuation back with it.
--
-- The flat model could not express this. It marked one row per position active, but a
-- "position" was a `swipe_group` id that only existed once a message had been swiped,
-- and nothing tied the rows after a position to the version that produced them.
-- Rewriting them was the only option, which destroys text and cannot be undone.
--
-- `swipe_group` is now redundant — two rows are versions of the same position exactly
-- when they share a parent — and is left in place, unread, so this migration is additive
-- and rewrites no text. Dropping a column in SQLite means rebuilding the table, which
-- would risk the message history for no benefit.
--
-- ## The shape of the backfill
--
-- Every existing chat is linear, so each row's parent is the row at the PREVIOUS
-- POSITION. A position is a swipe group, identified by the group's lowest seq; a row
-- with no group is a position of its own.
--
-- Two details matter, and getting either wrong silently changes what the reader sees:
--
--  - Parent to the previous position, not to the previous row. An edited message's
--    replacement carries a late seq, so "the row just before me" would parent a turn to
--    a version that is no longer on screen, and the turn would vanish.
--
--  - Prefer the ACTIVE row at that position. A continuation was written against the
--    version the reader was looking at, so that is the version it belongs to. If the
--    position has no active row — it was deleted — the continuation is parented to the
--    inactive one anyway, which keeps it out of the transcript instead of making it a
--    second opening.
--
-- The subqueries read only `seq`, `active` and `swipe_group`, none of which this
-- migration writes, so the row-by-row update cannot observe a half-migrated table.

-- ---------------------------------------------------------------------------
-- 1. Backfill the chain
-- ---------------------------------------------------------------------------
UPDATE messages
SET parent_id = (
  SELECT p.id
  FROM messages AS p
  WHERE p.chat_id = messages.chat_id
    -- The candidate's position, defined exactly as this row's is below.
    AND COALESCE(
          (SELECT MIN(g.seq) FROM messages g
            WHERE g.chat_id = p.chat_id
              AND p.swipe_group IS NOT NULL
              AND g.swipe_group = p.swipe_group),
          p.seq
        )
        < COALESCE(
          (SELECT MIN(g.seq) FROM messages g
            WHERE g.chat_id = messages.chat_id
              AND messages.swipe_group IS NOT NULL
              AND g.swipe_group = messages.swipe_group),
          messages.seq
        )
  -- The active version of that position wins; then the newest.
  ORDER BY p.active DESC, p.seq DESC
  LIMIT 1
)
WHERE parent_id IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Exactly one active version per position
-- ---------------------------------------------------------------------------
--
-- The path walk takes the newest active child and stops, so two active rows sharing a
-- parent would be ambiguous. Where the old model left more than one, the newest wins — it
-- is the version the reader produced last, and the one the flat model displayed.
UPDATE messages
SET active = 0
WHERE active = 1
  AND EXISTS (
    SELECT 1 FROM messages AS newer
    WHERE newer.chat_id = messages.chat_id
      AND COALESCE(newer.parent_id, '') = COALESCE(messages.parent_id, '')
      AND newer.seq > messages.seq
      AND newer.active = 1
  );

-- The walk filters by chat and follows parents; this is the index it needs.
CREATE INDEX idx_messages_parent ON messages(chat_id, parent_id, seq);
