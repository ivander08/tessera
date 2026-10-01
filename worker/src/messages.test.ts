import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

import { abandonMessage, deleteMessage, loadMessage } from './messages';
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
  '0012_message_deleted.sql',
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
    // The lifecycle runs its multi-row updates through `batch`, the same way production
    // does. Sequential here: the property under test is which rows end up active, not
    // atomicity, which is D1's guarantee rather than this module's.
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
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

/**
 * `deleteMessage` removes ONE version, not the position.
 *
 * The bug these guard against: X on a swipe alternative deactivated every version at that
 * position, so the turn AND its whole continuation left the transcript. A reader hit it on
 * a real chat and described it as "the only text left is the swipe counter" — because the
 * two turns they were reading were gone and the counter was the last thing standing.
 */
describe('deleteMessage', () => {
  /** A turn with `count` versions at one position, the last one active. */
  function seedVersions(db: Database, chatId: string, parentId: string | null, count: number) {
    const versions = [];
    for (let index = 0; index < count; index += 1) {
      versions.push(seedRow(db, chatId, parentId, 'assistant', `Version ${index + 1}.`));
    }
    for (const version of versions.slice(0, -1)) {
      exec(db, 'UPDATE messages SET active = 0 WHERE id = ?', version.id);
    }
    return versions;
  }

  test('deleting the active version promotes a survivor and keeps the continuation', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const opening = seedRow(db, chatId, null, 'assistant', 'Opening.');
    const user = seedRow(db, chatId, opening.id, 'user', 'Hmm. Alright.');
    const versions = seedVersions(db, chatId, user.id, 3);
    const after = seedRow(db, chatId, versions[2].id, 'user', 'Later, at 8.30.');
    const last = seedRow(db, chatId, after.id, 'assistant', 'The court lights were on.');

    const res = await deleteMessage(
      env,
      new Request('http://x/api/message/delete', {
        method: 'POST',
        body: JSON.stringify({ chatId, id: versions[2].id }),
      }),
    );

    expect(await res.json()).toMatchObject({ ok: true, groupEmpty: false });
    expect(activeOf(db, versions[2].id)).toBe(0);
    expect(activeOf(db, versions[1].id)).toBe(1);
    // The whole point: the turns after the deleted version are still on the path.
    const path = (await loadPath(env, chatId)).map((row) => row.id);
    expect(path).toEqual([opening.id, user.id, versions[1].id, after.id, last.id]);
  });

  test('deleting the last version empties the position and takes the continuation with it', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const opening = seedRow(db, chatId, null, 'assistant', 'Opening.');
    const user = seedRow(db, chatId, opening.id, 'user', 'Hmm. Alright.');
    const version = seedRow(db, chatId, user.id, 'assistant', 'Only reply.');
    seedRow(db, chatId, version.id, 'user', 'And then.');

    const res = await deleteMessage(
      env,
      new Request('http://x/api/message/delete', {
        method: 'POST',
        body: JSON.stringify({ chatId, id: version.id }),
      }),
    );

    expect(await res.json()).toMatchObject({ ok: true, groupEmpty: true });
    expect((await loadPath(env, chatId)).map((row) => row.id)).toEqual([opening.id, user.id]);
  });

  test('deleting an inactive version leaves the active one and the path untouched', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const opening = seedRow(db, chatId, null, 'assistant', 'Opening.');
    const user = seedRow(db, chatId, opening.id, 'user', 'Hmm. Alright.');
    const versions = seedVersions(db, chatId, user.id, 3);
    const after = seedRow(db, chatId, versions[2].id, 'user', 'Later.');
    const last = seedRow(db, chatId, after.id, 'assistant', 'Then.');

    await deleteMessage(
      env,
      new Request('http://x/api/message/delete', {
        method: 'POST',
        body: JSON.stringify({ chatId, id: versions[0].id }),
      }),
    );

    expect(activeOf(db, versions[0].id)).toBe(0);
    expect(activeOf(db, versions[2].id)).toBe(1);
    // No promotion happened, so there is still exactly one active child of `user`.
    expect((await loadPath(env, chatId)).map((row) => row.id)).toEqual([
      opening.id,
      user.id,
      versions[2].id,
      after.id,
      last.id,
    ]);
  });

  test('deleting a version twice does not resurrect it', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const opening = seedRow(db, chatId, null, 'assistant', 'Opening.');
    const user = seedRow(db, chatId, opening.id, 'user', 'Hmm. Alright.');
    const versions = seedVersions(db, chatId, user.id, 3);

    const remove = (id: string) =>
      deleteMessage(
        env,
        new Request('http://x/api/message/delete', {
          method: 'POST',
          body: JSON.stringify({ chatId, id }),
        }),
      );

    // Remove the first version, then delete through the two that remain.
    await remove(versions[0].id);
    await remove(versions[2].id);
    await remove(versions[1].id);

    // Every version is gone, so the position is empty and the turn leaves the transcript.
    // Before the tombstone, removing version 1 promoted version 0 straight back — the
    // reader's first deletion undid itself.
    expect((await loadPath(env, chatId)).map((row) => row.id)).toEqual([opening.id, user.id]);
    for (const version of versions) expect(activeOf(db, version.id)).toBe(0);
  });
});
