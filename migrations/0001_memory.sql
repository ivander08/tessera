PRAGMA foreign_keys = ON;

-- M4 — long-term memory.
--
-- Nothing here is ever spliced into the message history. Recall results and summary
-- text are rendered into the prompt TAIL by the caller; anything inserted into the
-- head would rewrite the cached prefix and destroy the cache for every later turn.
-- That is the whole reason these live in side tables instead of in `messages`.

-- `covers_from`/`covers_to` are inclusive `messages.seq` ranges. They are also the
-- consumption ledger for consolidation: there is no `consumed_by` column, so an
-- `arc` claims the scenes it folded by covering their range. A scene is consumed
-- once some arc's `covers_to` reaches it.
CREATE TABLE summaries (
  id          TEXT PRIMARY KEY,
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  tier        TEXT NOT NULL CHECK (tier IN ('scene','arc')),
  covers_from INTEGER NOT NULL,
  covers_to   INTEGER NOT NULL,
  content     TEXT NOT NULL,
  tokens      INTEGER,
  created_at  INTEGER NOT NULL
) STRICT;

-- Facts change status; they are never rewritten in place. `superseded` keeps the
-- history auditable, and `pinned` facts are recalled regardless of the query.
CREATE TABLE facts (
  id            TEXT PRIMARY KEY,
  chat_id       TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  text          TEXT NOT NULL,
  subject       TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
  superseded_by TEXT,
  pinned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
) STRICT;

-- Durable job queue. See worker/src/jobs.ts for why the lease exists: Horde Studio
-- lost user messages by consuming a pending reply before the model call finished,
-- and a crash mid-generation must be recoverable rather than a lost turn.
-- `idempotency_key` is UNIQUE so a retried enqueue cannot produce a second job.
CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,
  chat_id         TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('queued','claimed','generating','ready','delivered','failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  lease_until     INTEGER,
  payload         TEXT,
  result          TEXT,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

-- External-content FTS5. The index stores no copy of the text; it reads the base
-- table, so `content='messages'` / `content_rowid='seq'` must match exactly or the
-- delete/update triggers corrupt the index.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content, content='messages', content_rowid='seq', tokenize='unicode61'
);
CREATE VIRTUAL TABLE facts_fts USING fts5(
  text, content='facts', content_rowid='rowid', tokenize='unicode61'
);

-- SQLite's documented external-content trigger pattern. `'delete'` must be fed the
-- OLD values before any insert, or the index accumulates stale terms.

CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.seq, new.content);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.seq, old.content);
END;
CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.seq, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.seq, new.content);
END;
CREATE TRIGGER facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO facts_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE INDEX idx_summaries_chat ON summaries(chat_id, covers_to);
CREATE INDEX idx_facts_chat ON facts(chat_id, status);
CREATE INDEX idx_jobs_chat ON jobs(chat_id, status);

-- Backfill the index for rows that already existed when this migration ran.
--
-- Without this, `messages_fts` contains only rows inserted AFTER the triggers were
-- created, so every message from before the migration is invisible to recall forever.
-- The failure is silent and confusing: `SELECT COUNT(*) FROM messages_fts` reads the
-- CONTENT table for an external-content table, so it reports the full count and looks
-- healthy while the index is empty. `rebuild` is the documented way to populate an
-- external-content FTS5 index from its source table.
INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
INSERT INTO facts_fts(facts_fts) VALUES('rebuild');
