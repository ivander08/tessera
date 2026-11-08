import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';

import { exec, makeTestEnv } from '../test/harness';
import { applyCompaction, parseClientOps, proposeCompaction } from './compact';
import { encryptKey } from '../../../src/lib/crypto';

/**
 * Fact compaction.
 *
 * The store grows because `extract.ts` can only supersede what it is shown, and it is shown
 * sixty facts. This proposes the cleanup the extractor cannot see, and — like every other
 * destructive action in the app — writes nothing until the reader applies it.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeEnv(): { env: Env; db: Database } {
  const settings: Record<string, string> = {
    provider: 'kenari',
    model: 'test/model',
  };
  const { promise: keyPromise, resolve: resolveKey } = Promise.withResolvers<{
    key_enc: Uint8Array;
    iv: Uint8Array;
  }>();
  void encryptKey('sk-test', 'token').then(({ enc, iv }) =>
    resolveKey({ key_enc: new Uint8Array(enc), iv: new Uint8Array(iv) }),
  );

  const { env, db } = makeTestEnv({
    extra: { TESSERA_TOKEN: 'token' },
    stub: (sql) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      if (trimmed.includes('FROM settings')) {
        return { rows: Object.entries(settings).map(([key, value]) => ({ key, value })) };
      }
      if (trimmed.includes('FROM provider_keys')) return { row: keyPromise };
      if (trimmed.includes('FROM token_calibration')) return { row: { factor: 1, samples: 0 } };
      return undefined;
    },
  });

  exec(
    db,
    `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                        session_id, created_at, updated_at)
     VALUES ('chat-1', NULL, NULL, 't', NULL, 0, 's', 0, 0)`,
  );

  return { env, db };
}

function fact(db: Database, id: string, text: string, createdAt = 0, status = 'active'): void {
  exec(
    db,
    `INSERT INTO facts (id, chat_id, text, status, pinned, created_at)
     VALUES (?, 'chat-1', ?, ?, 0, ?)`,
    id,
    text,
    status,
    createdAt,
  );
}

function stubProvider(reply: string): void {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 1 } }),
      { headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch;
}

describe('proposeCompaction', () => {
  test('maps line numbers back to the facts it was shown', async () => {
    const { env, db } = makeEnv();
    fact(db, 'f1', 'Sydney likes vinyl.', 1);
    fact(db, 'f2', 'She owns a crate of vinyl records.', 2);
    fact(db, 'f3', 'She works at a record store.', 3);

    stubProvider(
      JSON.stringify({
        ops: [
          { op: 'merge', ids: [1, 2], text: 'Sydney owns a crate of vinyl records.', reason: 'same fact' },
          { op: 'rewrite', ids: [3], text: 'She works at a record store on campus.', reason: 'specific' },
        ],
      }),
    );

    const proposal = await proposeCompaction(env, 'chat-1');
    expect(proposal.ops).toHaveLength(2);
    expect(proposal.ops[0]).toMatchObject({ op: 'merge', ids: ['f1', 'f2'] });
    expect(proposal.ops[1]).toMatchObject({ op: 'rewrite', ids: ['f3'] });
    expect(proposal.examined).toBe(3);
    expect(proposal.remaining).toBe(0);
  });

  test('drops an op that names a number outside the batch', async () => {
    // A hallucinated index is a claim about a fact the model was never shown. Dropping the
    // line keeps the rest of a usable proposal; rejecting the batch would throw it away.
    const { env, db } = makeEnv();
    fact(db, 'f1', 'One.', 1);

    stubProvider(
      JSON.stringify({
        ops: [
          { op: 'supersede', ids: [9], reason: 'invented' },
          { op: 'rewrite', ids: [1], text: 'One, sharpened.', reason: 'ok' },
        ],
      }),
    );

    const proposal = await proposeCompaction(env, 'chat-1');
    expect(proposal.ops).toHaveLength(1);
    expect(proposal.ops[0].ids).toEqual(['f1']);
  });

  test('reads only active, non-deleted facts, and reports what is left', async () => {
    const { env, db } = makeEnv();
    fact(db, 'f1', 'Active one.', 1);
    fact(db, 'f2', 'Active two.', 2);
    fact(db, 'f3', 'Already gone.', 3, 'superseded');

    stubProvider(JSON.stringify({ ops: [] }));
    const proposal = await proposeCompaction(env, 'chat-1', 1);

    expect(proposal.examined).toBe(1);
    expect(proposal.remaining).toBe(1);
  });

  test('a clean batch proposes nothing', async () => {
    const { env, db } = makeEnv();
    fact(db, 'f1', 'One.', 1);
    stubProvider(JSON.stringify({ ops: [] }));

    expect((await proposeCompaction(env, 'chat-1')).ops).toEqual([]);
  });
});

describe('applyCompaction', () => {
  test('a merge rewrites the kept fact and supersedes the rest', async () => {
    const { env, db } = makeEnv();
    fact(db, 'f1', 'Sydney likes vinyl.', 1);
    fact(db, 'f2', 'She owns a crate of vinyl records.', 2);

    const result = await applyCompaction(env, 'chat-1', [
      { op: 'merge', ids: ['f1', 'f2'], text: 'Sydney owns a crate of vinyl records.', reason: '' },
    ]);

    expect(result.applied).toBe(1);
    const rows = db
      .query("SELECT id, text, status, superseded_by, superseded_at_seq FROM facts ORDER BY id")
      .all() as Array<{ id: string; text: string; status: string; superseded_by: string | null; superseded_at_seq: number }>;
    expect(rows[0]).toMatchObject({
      id: 'f1',
      text: 'Sydney owns a crate of vinyl records.',
      status: 'active',
    });
    expect(rows[1]).toMatchObject({
      id: 'f2',
      status: 'superseded',
      superseded_by: 'f1',
      superseded_at_seq: 0,
    });
  });

  test('a supersede removes the fact from recall but keeps the row', async () => {
    const { env, db } = makeEnv();
    fact(db, 'f1', 'She is hiding the letter.', 1);

    await applyCompaction(env, 'chat-1', [
      { op: 'supersede', ids: ['f1'], text: '', reason: 'she burned it' },
    ]);

    const row = db
      .query("SELECT text, status, superseded_at_seq, deleted FROM facts WHERE id = 'f1'")
      .get() as { text: string; status: string; superseded_at_seq: number; deleted: number };
    expect(row.status).toBe('superseded');
    expect(row.superseded_at_seq).toBe(0);
    // Not a delete: history stays auditable, which is why this table has a status column.
    expect(row.deleted).toBe(0);
    expect(row.text).toBe('She is hiding the letter.');
  });

  test('an op whose facts changed since the proposal is skipped, not forced', async () => {
    // The proposal round-trips through the client. If the reader deleted a fact in the
    // panel while reading the diff, applying must not resurrect or rewrite it.
    const { env, db } = makeEnv();
    fact(db, 'f1', 'Still here.', 1);
    fact(db, 'f2', 'Removed meanwhile.', 2);
    exec(db, "UPDATE facts SET deleted = 1 WHERE id = 'f2'");

    const result = await applyCompaction(env, 'chat-1', [
      { op: 'merge', ids: ['f1', 'f2'], text: 'merged', reason: '' },
    ]);

    expect(result).toEqual({ applied: 0, skipped: 1 });
    const row = db.query("SELECT text FROM facts WHERE id = 'f1'").get() as { text: string };
    expect(row.text).toBe('Still here.');
  });

  test('an op naming another chat\'s fact is refused', async () => {
    const { env, db } = makeEnv();
    exec(
      db,
      `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                          session_id, created_at, updated_at)
       VALUES ('chat-2', NULL, NULL, 't', NULL, 0, 's2', 0, 0)`,
    );
    exec(
      db,
      `INSERT INTO facts (id, chat_id, text, status, pinned, created_at)
       VALUES ('other', 'chat-2', 'Not yours.', 'active', 0, 0)`,
    );

    const result = await applyCompaction(env, 'chat-1', [
      { op: 'supersede', ids: ['other'], text: '', reason: '' },
    ]);
    expect(result).toEqual({ applied: 0, skipped: 1 });
  });
});

describe('parseClientOps', () => {
  test('accepts the wire shape and rejects anything else', () => {
    expect(
      parseClientOps([{ op: 'rewrite', ids: ['a'], text: 'x', reason: 'y' }]),
    ).toHaveLength(1);
    // A merge of one is not a merge.
    expect(parseClientOps([{ op: 'merge', ids: ['a'], text: 'x' }])).toBeNull();
    // A rewrite with no text would blank the fact.
    expect(parseClientOps([{ op: 'rewrite', ids: ['a'], text: '' }])).toBeNull();
    expect(parseClientOps([{ op: 'nonsense', ids: ['a'] }])).toBeNull();
    expect(parseClientOps([{ op: 'merge', ids: [], text: 'x' }])).toBeNull();
    expect(parseClientOps('nope')).toBeNull();
    // A supersede carries no text, and that is legal.
    expect(parseClientOps([{ op: 'supersede', ids: ['a'], reason: 'gone' }])).toHaveLength(1);
  });
});
