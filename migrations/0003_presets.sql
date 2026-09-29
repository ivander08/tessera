-- Imported sampler/prompt presets. `kind` records which namespace the preset came from,
-- because ST's two sampler namespaces are disjoint: DRY and XTC exist only in
-- text-completion, and a chat-completion preset never defines them. Re-importing a
-- preset through the wrong namespace's knob map invents knobs it never had.
--
-- `dropped` is deliberately not stored. It is derived at import time and shown to the
-- user doing the import, once; persisting it would mean re-deriving it on every read
-- to keep it honest.
CREATE TABLE presets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('textgen','chat','ff5')),
  knobs_json  TEXT NOT NULL,
  regex_json  TEXT,
  prompt_json TEXT,
  created_at  INTEGER NOT NULL
) STRICT;
