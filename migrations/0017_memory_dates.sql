-- In-world dates for memory.
--
-- The defect: memory stored WHAT and WHERE, never WHEN.
--
-- A fact is a timeless statement and a summary covers a `messages.seq` range, so both
-- answer "what happened" and neither answers "when". Measured on a real database: of 47
-- facts and 28 summaries, ZERO contained a date, while 792 messages carried a full in-world
-- clock in `messages.state_json` (`"Wednesday, 30 September 2026, 05:34"`). The date was on
-- disk the whole time; nothing read it.
--
-- The failure the reader reports: "the first time Ivander met Sydney was 14 April 2026, and
-- that fact is never kept." Extraction was handed `role: content` only — the clock lives
-- BESIDE the message, in its state snapshot, and was never in the transcript the model saw.
--
-- `facts.at` is the in-world clock reading when the fact became true. It is TEXT, not an
-- integer, and deliberately so: it stores the narrator's own reading verbatim ("late
-- evening" as readily as a full date), which the Memory panel can show unaltered and the
-- reader can check against the transcript. Ordering derives from it via `parseStateTime`
-- where ordering is needed, so there is no second, lossy numeric copy to keep in step.
--
-- `facts.kind` separates a FACT from a DATED EVENT, which live in the same table because
-- they are the same shape — one sentence, a subject, a date — and differ only in how they
-- age. A fact can be superseded ("the debt is forty crowns" becomes sixty); an event
-- cannot, because it happened. Keeping them in one table means one FTS index, one recall
-- path, one viewer, and one provenance rule (`learned_at_seq`); keeping them in one COLUMN
-- with a discriminator is what lets recall rank them together while the prompt renders
-- them under different headings.
--
-- `'fact'` is the default, so every existing row keeps exactly its current meaning.
ALTER TABLE facts ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact'
  CHECK (kind IN ('fact', 'event'));
--
-- `summaries.covers_date_from` / `covers_date_to` are the clock readings at the first and
-- last message of the covered range. They are what survives an ARC FOLD: `covers_from` /
-- `covers_to` are seqs, and a seq is a POSITION — folding ten scenes into one arc discards
-- the positions the fold consumed, so a fact or summary that outlives its fold has no
-- position left to be dated by. The date is carried forward instead.
--
-- NULL means "no clock was recorded for this range", which is the honest answer for a chat
-- whose state snapshots are empty or whose clock is free text. Nothing is guessed and no
-- existing row is rewritten: every column is nullable with no default, so the 47 existing
-- facts and 28 existing summaries keep exactly the behaviour they had.
ALTER TABLE facts ADD COLUMN at TEXT;
ALTER TABLE summaries ADD COLUMN covers_date_from TEXT;
ALTER TABLE summaries ADD COLUMN covers_date_to TEXT;

-- The Memory panel sorts and groups by date, and the timeline reads a chat's facts in
-- in-world order rather than insertion order.
CREATE INDEX idx_facts_at ON facts(chat_id, at);

-- Every recall and viewer read filters on the kind, so the index covers the common case.
CREATE INDEX idx_facts_kind ON facts(chat_id, kind);
