-- Who is in a scene.
--
-- A cast is a list of SPEAKERS, not a list of characters. A `character_id` is set only
-- once a cast member has been promoted to a real card; until then `name` is all there is,
-- which is what lets the narrator introduce someone mid-scene without blocking on the
-- reader creating a card first.
--
-- `color` is the speaker's voice colour, as a `--voice-N` slot index. Null means "assign
-- from the palette on first write". Storing the SLOT rather than a hex value is what
-- makes it theme-correct: the dark and light palettes define the same six slots with
-- different values, so a stored hex would be unreadable in the other mode.
--
-- `id` is a cast-local id rather than the character id, because a cast member can exist
-- with no character at all — and because promoting one must not change its identity in
-- the transcript.
CREATE TABLE chat_cast (
  chat_id      TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  id           TEXT NOT NULL,
  character_id TEXT REFERENCES characters(id),
  name         TEXT NOT NULL,
  color        TEXT,
  is_primary   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (chat_id, id)
) STRICT;

CREATE INDEX idx_chat_cast_chat ON chat_cast(chat_id, created_at);
