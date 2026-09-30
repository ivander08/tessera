import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

import { abandonMessage, loadMessage } from './messages';
import { loadPath, tailId } from './branch';
import { persistUserMessage } from './persist';

/**
 * The row-scoped half of the message lifecycle, against the real migrations.
 *
 * `abandonMessage` exists for one situation: a turn failed after the reader's message was
 * already written. The text must survive — it is theirs — but an unreplied row on the
 * visible path becomes the parent of the next turn, and the prompt then carries two `user`
 * messages in a row. These tests drive the real walk and the real tail query, because the
 * property that matters is structural: what the NEXT turn attaches to.
 */

function migrationSql(name: string): string {
  return readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
}

const MIGRATIONS = [
  '0000_init.sql',
  '0001_memory.sql',
  '0002_state.sql',
  '0003_presets.sql',
  '0004_swipes_presets.sql',
  '0005_branching.sql',
  '0006_walk_index.sql',
  '0007_scene_setup.sql',
  '0008_cast.sql',
  '0009_message_speaker.sql',
  '0011_message_state.sql',
];

function makeEnv(): { env: Env; db: Database } {
  const db = new Database(':memory:');
  for (const name of MIGRATIONS) db.exec(migrationSql(name));

  const DB = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async all() {
          return { results: db.query(sql).all(...(params as never[])), success: true, meta: {} };
        },
        async first() {
          return db.query(sql).get(...(params as never[])) ?? null;
        },
        async run() {
          const result = db.run(sql, ...(params as never[]));
          return { success: true, meta: { changes: result.changes } };
        },
      };
      return statement;
    },
  };

  const env = { DB, TESSERA_TOKEN: 'test-token', APP_NAME: 'Tessera' } as unknown as Env;
  return { env, db };
}

function exec(db: Database, sql: string, ...params: unknown[]): void {
  db.run(sql, ...(params as never[]));
}

function one<T>(db: Database, sql: string, ...params: unknown[]): T | null {
  return (db.query(sql).get(...(params as never[])) as T | undefined) ?? null;
}

function seedChat(db: Database, id = 'chat-1'): string {
  const now = Date.now();
  exec(
    db,
    `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                        session_id, created_at, updated_at)
     VALUES (?, NULL, NULL, 't', NULL, 0, ?, ?, ?)`,
    id,
    `session-${id}`,
    now,
    now,
  );
  return id;
}

/** Appends one active row answering `parentId`, returning its id and seq. */
function seedRow(
  db: Database,
  chatId: string,
  parentId: string | null,
  role: 'user' | 'assistant',
  content: string,
): { id: string; seq: number } {
  const id = crypto.randomUUID();
  const row = one<{ seq: number }>(
    db,
    `INSERT INTO messages (id, chat_id, parent_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING seq`,
    id,
    chatId,
    parentId,
    role,
    content,
    Date.now(),
  );
  return { id, seq: row?.seq ?? 0 };
}

function activeOf(db: Database, id: string): number {
  return one<{ active: number }>(db, 'SELECT active FROM messages WHERE id = ?', id)?.active ?? -1;
}

describe('abandonMessage', () => {
  test('deactivates exactly the named row and leaves the rest of the chain alone', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const opening = seedRow(db, chatId, null, 'assistant', 'Hello.');
    const orphan = seedRow(db, chatId, opening.id, 'user', 'Are you there?');

    await abandonMessage(env, chatId, orphan.id);

    expect(activeOf(db, orphan.id)).toBe(0);
    expect(activeOf(db, opening.id)).toBe(1);
    // Deactivated, not deleted: the reader's words are still in the table.
    expect(await loadMessage(env, chatId, orphan.id)).not.toBeNull();
  });

  test('takes the row off the path, so the tail falls back to the row before it', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const opening = seedRow(db, chatId, null, 'assistant', 'Hello.');
    const reply = seedRow(db, chatId, opening.id, 'assistant', 'You were saying?');
    const orphan = seedRow(db, chatId, reply.id, 'user', 'Never mind.');

    await abandonMessage(env, chatId, orphan.id);

    const path = await loadPath(env, chatId);
    expect(path.map((row) => row.id)).toEqual([opening.id, reply.id]);
    expect(await tailId(env, chatId)).toBe(reply.id);
  });

  test('the next user message lands after the last real turn, not after the orphan', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const opening = seedRow(db, chatId, null, 'assistant', 'Hello.');
    const reply = seedRow(db, chatId, opening.id, 'assistant', 'You were saying?');
    const orphan = seedRow(db, chatId, reply.id, 'user', 'Never mind.');

    await abandonMessage(env, chatId, orphan.id);
    await persistUserMessage(env, chatId, 'Try again.', await tailId(env, chatId));

    const roles = (await loadPath(env, chatId)).map((row) => row.role);
    // The failure this guards: without the abandon, the new row parents to the orphan and
    // the walk carries two adjacent `user` messages into the prompt.
    expect(roles.slice(-2)).toEqual(['assistant', 'user']);
  });

  test('an unknown id is a no-op rather than an error', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const opening = seedRow(db, chatId, null, 'assistant', 'Hello.');

    await abandonMessage(env, chatId, 'no-such-row');

    expect(activeOf(db, opening.id)).toBe(1);
    expect((await loadPath(env, chatId)).length).toBe(1);
  });

  test('does not reach into another chat', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db, 'chat-1');
    const otherId = seedChat(db, 'chat-2');
    const row = seedRow(db, chatId, null, 'assistant', 'Hello.');
    seedRow(db, otherId, null, 'assistant', 'Elsewhere.');

    await abandonMessage(env, otherId, row.id);

    expect(activeOf(db, row.id)).toBe(1);
  });
});
