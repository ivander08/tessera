-- Provenance for supersession.
--
-- The remaining asymmetry: creating a fact was reversible, deleting one was not.
--
-- `learned_at_seq` (0014) made a fact invisible when its producing turn left the visible
-- path — the row is untouched, so swiping back restores it. Supersession is a one-way
-- WRITE: `extractFacts` sets `status = 'superseded'` and nothing ever sets it back. So a
-- turn that superseded a fact, then left the transcript, kept the fact suppressed forever.
--
-- The worked case: turn 10 records "Ada holds the brass key", turn 20 records "Bram holds
-- the brass key" and supersedes the first. Regenerating turn 20 to "Ada keeps the key"
-- hides the Bram fact correctly, but leaves the Ada fact suppressed by a turn that no
-- longer exists — and the prompt then knows nothing about the key at all.
--
-- `superseded_at_seq` is the coordinate that makes the write reversible: the turn that did
-- the superseding. A read treats a fact as superseded only when that turn is still on the
-- visible path. When it is not, the supersession is ignored and the fact is active again,
-- exactly as it was before the discarded turn ran.
--
-- 0 means "not attributable to a turn" and is treated as a permanent supersession, which is
-- what a backfilled row gets: the write happened, there is no record of when, and inventing
-- one would resurrect facts the reader already watched disappear.
ALTER TABLE facts ADD COLUMN superseded_at_seq INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_facts_superseded ON facts(chat_id, superseded_at_seq);
