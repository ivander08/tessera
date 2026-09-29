PRAGMA foreign_keys = ON;

CREATE TABLE characters (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  avatar        TEXT,
  card_json     TEXT NOT NULL,
  source_format TEXT NOT NULL,
  tokens        INTEGER,
  created_at    INTEGER NOT NULL
) STRICT;

CREATE TABLE personas (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  avatar      TEXT,
  created_at  INTEGER NOT NULL
) STRICT;

-- Avatar bytes live here, not in `characters.avatar`. A base64 data URL would push
-- a 1.5 MB card past D1's 2 MB row limit, and `characters` is read on every turn.
-- `characters.avatar` holds this table's public path, or NULL.
CREATE TABLE character_assets (
  character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  bytes        BLOB NOT NULL,
  created_at   INTEGER NOT NULL
) STRICT;

CREATE TABLE chats (
  id               TEXT PRIMARY KEY,
  character_id     TEXT REFERENCES characters(id),
  persona_id       TEXT REFERENCES personas(id),
  title            TEXT,
  preset_id        TEXT,
  window_start_seq INTEGER NOT NULL DEFAULT 0,
  -- Minted at chat creation and sent as OpenRouter's `session_id` on every request.
  -- Without it sticky routing only activates AFTER a first cache hit is observed.
  session_id       TEXT NOT NULL,
  -- Previous turn's prefix fingerprint. Lives here rather than in `settings` so the
  -- M3.3 prefix guard costs zero extra writes: `chats` is already updated each turn.
  last_prefix_hash TEXT,
  last_prefix_head TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
) STRICT;

-- Append-only. Never reordered, never spliced.
-- `seq` is per-chat monotonic and is the ONLY ordering authority.
--
-- Each token column has exactly ONE meaning. Overloading `tokens` to mean "content
-- tokens" for user rows and "prompt tokens" for assistant rows makes windowing sum
-- nonsense: prompt counts already include every earlier message, so the context
-- budget appears blown at ~900 real tokens and forces a spurious re-anchor.
CREATE TABLE messages (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  id                 TEXT NOT NULL UNIQUE,
  chat_id            TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  parent_id          TEXT,
  role               TEXT NOT NULL CHECK (role IN ('system','user','assistant')),
  content            TEXT NOT NULL,
  -- Tokens in THIS row's own content. The only column windowing may sum.
  content_tokens     INTEGER,
  -- Provider-reported prompt tokens for the turn that produced this row.
  -- Denominator of the cache meter: sum(cached_tokens) / sum(prompt_tokens).
  prompt_tokens      INTEGER,
  completion_tokens  INTEGER,
  cached_tokens      INTEGER,
  cache_write_tokens INTEGER,
  cost_usd           REAL,
  created_at         INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_messages_chat_seq ON messages(chat_id, seq);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE provider_keys (
  provider   TEXT PRIMARY KEY,
  key_enc    BLOB NOT NULL,
  iv         BLOB NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE token_calibration (
  model      TEXT PRIMARY KEY,
  factor     REAL NOT NULL DEFAULT 1.0,
  samples    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
) STRICT;
