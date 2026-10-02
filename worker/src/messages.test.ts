import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

import { deleteMessage, editMessage } from './messages';
import { loadPath } from './branch';

/**
 * The row-scoped half of the message lifecycle, against the real migrations.
 *
 * These drive the real walk and the real tail query, because the property that matters is
 * structural: which rows end up on the visible path, and what the next turn attaches to.
 * A handler that reports `ok: true` while leaving the tree in a shape the walk cannot
 * traverse is exactly the class of bug this file exists to catch.
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

/** A JSON POST body, the shape every handler in this module takes. */
function post(body: unknown): Request {
  return new Request('http://x/api/message', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

function activeOf(db: Database, id: string): number {
  return one<{ active: number }>(db, 'SELECT active FROM messages WHERE id = ?', id)?.active ?? -1;
}

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

  test('deleting the active version promotes a survivor, and the survivor brings its own continuation', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const opening = seedRow(db, chatId, null, 'assistant', 'Opening.');
    const user = seedRow(db, chatId, opening.id, 'user', 'Hmm. Alright.');
    const versions = seedVersions(db, chatId, user.id, 3);
    // The turns written under the version that is about to leave, and the ones the
    // promoted version answers for itself.
    const after = seedRow(db, chatId, versions[2].id, 'user', 'Later, at 8.30.');
    const last = seedRow(db, chatId, after.id, 'assistant', 'The court lights were on.');
    const earlierTurn = seedRow(db, chatId, versions[1].id, 'user', 'Or maybe not.');

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
    // The version that leaves takes the turns written in answer to IT. The promoted
    // version's own continuation is what comes back — not the departed version's prose
    // grafted onto it, which is what re-parenting did.
    const path = (await loadPath(env, chatId)).map((row) => row.id);
    expect(path).toEqual([opening.id, user.id, versions[1].id, earlierTurn.id]);
    // Nothing was removed from the table: the departed version's turns are still there,
    // they are simply not reachable from the visible path any more.
    expect(
      one<{ n: number }>(
        db,
        'SELECT COUNT(*) AS n FROM messages WHERE id IN (?, ?) AND deleted = 0',
        after.id,
        last.id,
      )?.n,
    ).toBe(2);
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

/**
 * An edit rewrites its row. It must not create a version, and it must not move anything.
 *
 * This is the difference between "fix a typo" and "branch the conversation", and getting it
 * wrong made a corrected word silently turn the message swipeable ("2/2" on a turn that had
 * one text) while reparenting everything below it.
 */
describe('editMessage', () => {
  test('rewrites the row in place — same id, same parent, no sibling', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const opening = seedRow(db, chatId, null, 'assistant', 'Opening.');
    const mine = seedRow(db, chatId, opening.id, 'user', 'teh typo');

    const res = await editMessage(env, post({ chatId, id: mine.id, content: 'the typo' }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean; id: string }).toEqual({ ok: true, id: mine.id });

    const row = one<{ content: string; parent_id: string; active: number }>(
      db,
      'SELECT content, parent_id, active FROM messages WHERE id = ?',
      mine.id,
    );
    expect(row?.content).toBe('the typo');
    expect(row?.parent_id).toBe(opening.id);
    expect(row?.active).toBe(1);

    // The whole point: no second row at this position.
    const siblings = one<{ n: number }>(
      db,
      'SELECT COUNT(*) AS n FROM messages WHERE parent_id = ?',
      opening.id,
    );
    expect(siblings?.n).toBe(1);
  });

  test('the children stay attached to the row that was edited', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const opening = seedRow(db, chatId, null, 'assistant', 'Opening.');
    const mine = seedRow(db, chatId, opening.id, 'user', 'teh typo');
    const reply = seedRow(db, chatId, mine.id, 'assistant', 'A reply.');

    await editMessage(env, post({ chatId, id: mine.id, content: 'the typo' }));

    // Editing used to reparent this, and a reparent is what made the reply vanish when the
    // edit landed on a row the walk could no longer reach.
    const child = one<{ parent_id: string }>(
      db,
      'SELECT parent_id FROM messages WHERE id = ?',
      reply.id,
    );
    expect(child?.parent_id).toBe(mine.id);

    const path = await loadPath(env, chatId);
    expect(path.map((row) => row.content)).toEqual(['Opening.', 'the typo', 'A reply.']);
  });

  test('rejects an empty edit rather than blanking the message', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    const opening = seedRow(db, chatId, null, 'assistant', 'Opening.');
    const mine = seedRow(db, chatId, opening.id, 'user', 'text');

    const res = await editMessage(env, post({ chatId, id: mine.id, content: '   ' }));
    expect(res.status).toBe(400);

    const row = one<{ content: string }>(db, 'SELECT content FROM messages WHERE id = ?', mine.id);
    expect(row?.content).toBe('text');
  });
});
