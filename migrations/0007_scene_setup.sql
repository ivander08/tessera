-- Per-chat scene setup: how fast time moves, and how the world state is maintained.
--
-- A JSON document rather than columns because this is an open set — the wizard will grow
-- more options, and a column per option would mean a migration per option. Same reasoning
-- as `state.json` and `presets.config_json`, both already in this schema.
--
-- A row exists only once the reader has actually chosen something. An absent row means
-- the defaults, which is the normal case for every chat created before this migration and
-- for any chat created without going through the wizard — so the read path must not
-- require a row to exist, and must not create one.
CREATE TABLE chat_scene_setup (
  chat_id    TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  json       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
