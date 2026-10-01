-- Presets become authored documents.
--
-- A preset is now the thing its author writes: a system prompt, pre- and post-history
-- instructions, an assistant prefill, stop strings, and the sampler values and model it
-- was tuned for. Three columns existed only to carry an IMPORTED preset's internals —
-- which namespace its file came from, the prompt list it produced, and the regex pack
-- that cleaned up after it — and all three of their readers are gone with the importers.
--
-- The rows that carried one are deleted rather than migrated. Every such row came from a
-- SillyTavern or Freaky Frankenstein file, the user will not import one again, and the
-- techniques from that preset family worth keeping were ported into Tessera's own craft
-- blocks (`src/lib/prompt/craftBlock.ts`) before this ran. A row with a prompt list and
-- no reader is not a preset that still works — it is a preset whose behaviour would
-- silently change from "its 46 prompts" to "its eight sampler values", which is worse
-- than its absence.
DELETE FROM presets WHERE prompt_json IS NOT NULL OR regex_json IS NOT NULL;

-- SQLite cannot drop a column's CHECK in place, so the table is rebuilt. `kind`,
-- `prompt_json` and `regex_json` are gone; `config_json` and `updated_at` (added by
-- 0004) are carried forward.
--
-- The rebuild is safe on the remaining rows: `id`, `name`, `knobs_json` and `created_at`
-- are NOT NULL in the old table so every row has them, and `config_json`/`updated_at` may
-- be NULL, which the new table permits.
CREATE TABLE presets_new (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  knobs_json  TEXT NOT NULL,
  config_json TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER
) STRICT;

INSERT INTO presets_new (id, name, knobs_json, config_json, created_at, updated_at)
  SELECT id, name, knobs_json, config_json, created_at, updated_at FROM presets;

DROP TABLE presets;
ALTER TABLE presets_new RENAME TO presets;
