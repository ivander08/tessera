import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'bun:test';

import { extractFacts } from './extract';
import { encryptKey } from '../../../src/lib/crypto';

/**
 * Fact extraction.
 *
 * This is the pass that did not exist. Measured on a real 157-turn chat before it was
 * built: **zero** facts, including twelve turns phrased as direct instructions to
 * remember something, which meant the memory block's "Established facts" section could
 * never render and `facts_fts` was dead weight in the prompt path.
 *
 * What is worth pinning is not that a model returns facts — it is the two rules that keep
 * a wrong answer from becoming permanent:
 *
 *  - a supersede target that was not in the list is DROPPED, because retiring the wrong
 *    fact silently removes a true one from the prompt;
 *  - the retire and the insert commit together, so there is never a committed turn where
 *    two contradictory facts are both active — and `superseded_by` can name the
 *    replacement, which only has an id once it exists.
 */

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

  '0013_presets_authored.sql',

  '0014_provenance.sql',


  '0015_supersession_provenance.sql',
];

/** `bun-types` types the variadic form too narrowly; one seam keeps the cast out of call sites. */
function exec(db: Database, sql: string, ...params: unknown[]): void {
  db.run(sql, ...(params as never[]));
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replies with a fixed JSON body, so the test asserts on the WRITE not the model. */
function stubProvider(reply: string): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: reply } }], usage: {} }), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

function makeEnv(): { env: Env; db: Database } {
  const db = new Database(':memory:');
  for (const name of MIGRATIONS) {
    db.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8'));
  }

  const now = Date.now();
  exec(db,
    `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                        session_id, created_at, updated_at)
     VALUES ('chat-1', NULL, NULL, 't', NULL, 0, 's', ?, ?)`,
    now,
    now,
  );
  exec(db,
    `INSERT INTO messages (id, chat_id, parent_id, role, content, created_at)
     VALUES ('m1', 'chat-1', NULL, 'user', 'I owe the innkeeper forty crowns.', ?)`,
    now,
  );

  const settings: Record<string, string> = { provider: 'openrouter', model: 'test/model' };
  const { promise: keyPromise, resolve: resolveKey } = Promise.withResolvers<{
    key_enc: Uint8Array;
    iv: Uint8Array;
  }>();
  void encryptKey('sk-test', 'token').then(({ enc, iv }) =>
    resolveKey({ key_enc: new Uint8Array(enc), iv: new Uint8Array(iv) }),
  );

  const DB = {
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      return out;
    },
    prepare(sql: string) {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async all() {
          if (trimmed.includes('FROM settings')) {
            return {
              results: Object.entries(settings).map(([key, value]) => ({ key, value })),
              success: true,
              meta: {},
            };
          }
          return { results: db.query(sql).all(...(params as never[])), success: true, meta: {} };
        },
        async first() {
          if (trimmed.includes('FROM provider_keys')) return await keyPromise;
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

  return {
    env: { DB, APP_NAME: 'Tessera', TESSERA_TOKEN: 'token' } as unknown as Env,
    db,
  };
}

function seedFact(db: Database, id: string, text: string): void {
  exec(db,
    `INSERT INTO facts (id, chat_id, text, subject, status, pinned, created_at)
     VALUES (?, 'chat-1', ?, NULL, 'active', 0, ?)`,
    id,
    text,
    Date.now(),
  );
}

const factsOf = (db: Database): Array<{ text: string; status: string }> =>
  db.query('SELECT text, status FROM facts ORDER BY created_at').all() as Array<{
    text: string;
    status: string;
  }>;

/** `superseded_by` per fact, keyed by text, which is what the Memory viewer renders. */
const supersededBy = (db: Database): Record<string, string | null> => {
  const rows = db
    .query('SELECT text, superseded_by FROM facts')
    .all() as Array<{ text: string; superseded_by: string | null }>;
  return Object.fromEntries(rows.map((row) => [row.text, row.superseded_by]));
};

describe('extractFacts', () => {
  test('writes the facts the model returns', async () => {
    const { env, db } = makeEnv();
    stubProvider(
      JSON.stringify({
        facts: [
          { text: 'The traveller owes the innkeeper forty crowns.', subject: 'innkeeper' },
          { text: 'The traveller is allergic to shellfish.', subject: 'traveller' },
        ],
        supersede: [],
      }),
    );

    const result = await extractFacts(env, 'chat-1', 0, 9999);
    expect(result).toEqual({ added: 2, superseded: 0 });
    expect(factsOf(db)).toEqual([
      { text: 'The traveller owes the innkeeper forty crowns.', status: 'active' },
      { text: 'The traveller is allergic to shellfish.', status: 'active' },
    ]);
  });

  test('supersedes the fact the model points at by NUMBER', async () => {
    // Numbered rather than id'd: reproducing a 36-character UUID was unreliable once the
    // list grew, and a wrong id silently retires a true fact.
    const { env, db } = makeEnv();
    seedFact(db, 'f1', 'The debt is forty crowns.');

    stubProvider(
      JSON.stringify({
        facts: [{ text: 'The debt is sixty crowns.', subject: 'innkeeper' }],
        supersede: [{ id: 1, reason: 'amount changed' }],
      }),
    );

    const result = await extractFacts(env, 'chat-1', 0, 9999);
    expect(result).toEqual({ added: 1, superseded: 1 });
    expect(factsOf(db)).toEqual([
      { text: 'The debt is forty crowns.', status: 'superseded' },
      { text: 'The debt is sixty crowns.', status: 'active' },
    ]);

    // The supersession carries the turn that did it, which is what makes the write
    // reversible: regenerating that turn away restores the fact it retired. Without this the
    // column is 0, read as a permanent supersession, and the fact can never come back.
    const retired = db
      .query(`SELECT superseded_at_seq FROM facts WHERE text = 'The debt is forty crowns.'`)
      .get() as { superseded_at_seq: number } | undefined;
    expect(retired?.superseded_at_seq).toBe(9999);
  });

  test('names the REPLACEMENT in superseded_by, never the superseded row itself', async () => {
    // The column is rendered as user-visible prose in the Memory viewer, so pointing it at
    // the superseded fact's own id showed the reader "superseded by <its own id>".
    const { env, db } = makeEnv();
    seedFact(db, 'f1', 'The debt is forty crowns.');
    stubProvider(
      JSON.stringify({
        facts: [{ text: 'The debt is sixty crowns.' }],
        supersede: [{ id: 1 }],
      }),
    );

    await extractFacts(env, 'chat-1', 0, 9999);
    const replacement = db
      .query("SELECT id FROM facts WHERE text = 'The debt is sixty crowns.'")
      .get() as { id: string };

    const by = supersededBy(db);
    expect(by['The debt is forty crowns.']).toBe(replacement.id);
    expect(by['The debt is forty crowns.']).not.toBe('f1');
  });

  test('leaves superseded_by null when there is no single replacement', async () => {
    // Two new facts were extracted, so naming one of them as "the replacement" would be a
    // guess; zero facts means there is nothing to name at all.
    const { env, db } = makeEnv();
    seedFact(db, 'f1', 'The debt is forty crowns.');
    stubProvider(
      JSON.stringify({
        facts: [{ text: 'The debt is sixty crowns.' }, { text: 'The debt was paid.' }],
        supersede: [{ id: 1 }],
      }),
    );

    await extractFacts(env, 'chat-1', 0, 9999);
    expect(supersededBy(db)['The debt is forty crowns.']).toBeNull();
  });

  test('accepts a numeric string for the supersede target', async () => {
    // Models quote numbers. `"1"` and `1` mean the same thing.
    const { env, db } = makeEnv();
    seedFact(db, 'f1', 'The debt is forty crowns.');
    stubProvider(JSON.stringify({ facts: [], supersede: [{ id: '1' }] }));

    expect((await extractFacts(env, 'chat-1', 0, 9999)).superseded).toBe(1);
    expect(factsOf(db)[0].status).toBe('superseded');
  });

  test('drops a supersede target that was not in the list', async () => {
    // The rule that matters most: an out-of-range number must not retire anything, or a
    // hallucination removes a true fact from the prompt.
    const { env, db } = makeEnv();
    seedFact(db, 'f1', 'The debt is forty crowns.');
    stubProvider(JSON.stringify({ facts: [], supersede: [{ id: 99 }, { id: 0 }, { id: -1 }] }));

    const result = await extractFacts(env, 'chat-1', 0, 9999);
    expect(result.superseded).toBe(0);
    expect(factsOf(db)[0].status).toBe('active');
  });

  test('deduplicates a fact that is already stored', async () => {
    // Compared ignoring case and punctuation, so a model that rephrases slightly does not
    // put the same sentence in the prompt twice.
    const { env, db } = makeEnv();
    seedFact(db, 'f1', 'The traveller is allergic to shellfish.');
    stubProvider(
      JSON.stringify({ facts: [{ text: 'the traveller is allergic to shellfish' }], supersede: [] }),
    );

    expect((await extractFacts(env, 'chat-1', 0, 9999)).added).toBe(0);
    expect(factsOf(db)).toHaveLength(1);
  });

  test('deduplicates within one reply', async () => {
    const { env, db } = makeEnv();
    stubProvider(
      JSON.stringify({
        facts: [{ text: 'Ada carries the key.' }, { text: 'ada carries the key' }],
        supersede: [],
      }),
    );

    expect((await extractFacts(env, 'chat-1', 0, 9999)).added).toBe(1);
    expect(factsOf(db)).toHaveLength(1);
  });

  test('a malformed reply adds nothing and does not throw', async () => {
    const { env, db } = makeEnv();
    stubProvider('I could not find any facts.');

    expect(await extractFacts(env, 'chat-1', 0, 9999)).toEqual({ added: 0, superseded: 0 });
    expect(factsOf(db)).toHaveLength(0);
  });

  test('a reply with an empty facts array adds nothing', async () => {
    // A legitimate answer: most scenes establish nothing new.
    const { env, db } = makeEnv();
    stubProvider(JSON.stringify({ facts: [], supersede: [] }));

    expect(await extractFacts(env, 'chat-1', 0, 9999)).toEqual({ added: 0, superseded: 0 });
    expect(factsOf(db)).toHaveLength(0);
  });

  test('an entry with no text is skipped rather than stored empty', async () => {
    const { env, db } = makeEnv();
    stubProvider(JSON.stringify({ facts: [{ text: '   ' }, { subject: 'x' }], supersede: [] }));

    expect((await extractFacts(env, 'chat-1', 0, 9999)).added).toBe(0);
    expect(factsOf(db)).toHaveLength(0);
  });

  test('a range with no messages is a no-op', async () => {
    const { env, db } = makeEnv();
    stubProvider(JSON.stringify({ facts: [{ text: 'should not land' }], supersede: [] }));

    expect(await extractFacts(env, 'chat-1', 5000, 6000)).toEqual({ added: 0, superseded: 0 });
    expect(factsOf(db)).toHaveLength(0);
  });

  test('a superseded fact is not offered again on the next run', async () => {
    // Only ACTIVE facts are listed to the model, so a retired one cannot be re-retired or
    // re-added by a later extraction over the same text.
    const { env, db } = makeEnv();
    seedFact(db, 'f1', 'The debt is forty crowns.');
    stubProvider(JSON.stringify({ facts: [], supersede: [{ id: 1 }] }));

    await extractFacts(env, 'chat-1', 0, 9999);
    const active = db.query("SELECT COUNT(*) n FROM facts WHERE status='active'").get() as { n: number };
    expect(active.n).toBe(0);

    stubProvider(JSON.stringify({ facts: [], supersede: [{ id: 1 }] }));
    const second = await extractFacts(env, 'chat-1', 0, 9999);
    expect(second.superseded).toBe(0);
  });
});
