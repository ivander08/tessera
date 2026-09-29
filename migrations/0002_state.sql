PRAGMA foreign_keys = ON;

-- M5 — world state.
--
-- One small JSON document per chat describing where the scene is and what has
-- changed. It is rendered into the prompt TAIL by `src/lib/prompt/stateBlock.ts` and
-- is NEVER part of the cached prefix: a state block in the head would rewrite the
-- prefix on every turn and destroy the cache for every later turn.
--
-- The document is written only by `worker/src/state/update.ts`, only from a patch the
-- cheap model proposed and `validatePatch` accepted whole. There is no column-level
-- schema because the shape is owned by `src/lib/state/schema.ts`, which is the single
-- place that decides what may enter the record.
CREATE TABLE state (
  chat_id    TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  json       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
