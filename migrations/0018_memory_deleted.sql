-- "This memory was removed", instead of destroying the row.
--
-- `DELETE /api/memory/facts/:id` was a real `DELETE`. That contradicted the rule the rest of
-- the table lives by: a fact is superseded, never rewritten, so the history stays auditable
-- and the reader can see what the story used to believe. Removing one was the single
-- irreversible action in the panel, with no undo and no record that it had ever existed —
-- and `DESIGN-AUDIT.md` H5 logged it as an agency failure, because the same misclick that
-- costs nothing anywhere else in the app permanently destroyed a memory here.
--
-- `messages.deleted` (0012) is the same mechanism for the same reasons, and its comment
-- applies unchanged: the row is kept rather than removed, and a hard DELETE would fire the
-- FTS delete trigger and drop the text out of the index, so restoring would need a rebuild.
--
-- Reads filter `deleted = 0` everywhere the row would reach the narrator or a ranking:
--   - `prompt.ts`      the summary block
--   - `recall.ts`      facts, pinned facts, summaries
--   - `extract.ts`     the existing-fact list and the deduplication set
--   - `schedule.ts`    the coverage cursor
--   - `consolidate.ts` the scenes waiting to fold
--
-- The Memory viewer deliberately does NOT filter: a removed memory is listed, marked, and
-- restorable, which is what makes the delete reversible.
--
-- Default 0 makes this a pure addition: every existing row is a memory nobody removed.
ALTER TABLE facts ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE summaries ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;

-- Every read above filters per chat, and the viewer reads per chat too.
CREATE INDEX idx_facts_deleted ON facts(chat_id, deleted);
CREATE INDEX idx_summaries_deleted ON summaries(chat_id, deleted);
