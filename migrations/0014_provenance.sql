-- Provenance for facts and cast members.
--
-- The defect: a fact or a cast member was global to the chat. Turn 9 could record "Ivan
-- died", and if turn 9 later left the visible transcript — regenerated away, or deleted —
-- the fact stayed `active` and kept being injected. Writing turn 3 then produced a scene
-- where a character who had not died yet was already dead.
--
-- Summaries already solved this by covering a `messages.seq` range that the read checks
-- against the visible path. These two tables had no equivalent coordinate, so there was
-- nothing to check: a fact is a timeless statement ("Ivan died") and carries no indication
-- of WHEN it became true.
--
-- `learned_at_seq` / `joined_seq` are that coordinate: the seq of the turn that produced
-- the row. A read then requires the turn to still be on the visible path, and to be before
-- the point being written — the same two bounds the summary read uses.
--
-- 0 means "not attributable to a turn", and is always visible:
--   - the primary character's cast row is written when the chat is created, before any
--     message exists, and is the character rather than a participant who joined a scene;
--   - a backfilled row has no recorded origin, and hiding it would delete the reader's
--     existing memories to satisfy a rule written after they were made.
--
-- NOT NULL with a DEFAULT so the backfill is part of the ALTER: existing rows take 0 and
-- keep exactly the behaviour they had, and no data is rewritten or guessed at.
ALTER TABLE facts ADD COLUMN learned_at_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chat_cast ADD COLUMN joined_seq INTEGER NOT NULL DEFAULT 0;

-- The reads filter on both columns per chat, so the index covers the common case.
CREATE INDEX idx_facts_learned ON facts(chat_id, learned_at_seq);
CREATE INDEX idx_cast_joined ON chat_cast(chat_id, joined_seq);
