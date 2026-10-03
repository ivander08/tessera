import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

import worker from './index';
import { createCharacter, getCharacterDetail, updateCharacter } from './characters';
import type { CharacterCardJson, GreetingState } from '../../src/lib/cards/types';

/**
 * The scene a card gives each of its openings, end to end.
 *
 * Two properties matter and neither is visible from the type. A malformed value must not
 * take the whole card down with it — the field is decoration on a card whose prose is the
 * part that was edited — and a chat started from an opening that states a time must have
 * that time in `state` without a model call, because asking a model to infer what the
 * reader already typed spends a call to replace an answer with a guess.
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
];

function makeEnv(): { env: Env; db: Database } {
  const db = new Database(':memory:');
  for (const name of MIGRATIONS) {
    db.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
  }

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
    async batch(statements: Array<{ all(): Promise<unknown> }>) {
      const out = [];
      for (const statement of statements) out.push(await statement.all());
      return out;
    },
  };

  const env = { DB, TESSERA_TOKEN: 'test-token', APP_NAME: 'Tessera' } as unknown as Env;
  return { env, db };
}

function one<T>(db: Database, sql: string, ...params: unknown[]): T | null {
  return (db.query(sql).get(...(params as never[])) as T | undefined) ?? null;
}

/** A card payload with only the fields the tests vary; the rest is filler. */
function card(
  patch: Partial<CharacterCardJson> & { name: string },
): CharacterCardJson & { sourceFormat: 'ccv2' } {
  return {
    description: 'A cartographer.',
    personality: 'Dry.',
    scenario: 'A tavern.',
    firstMes: 'You are late.',
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    alternateGreetings: [],
    creatorNotes: '',
    tags: [],
    characterBook: null,
    // The row's `source_format` column is NOT NULL, so the payload carries one.
    sourceFormat: 'ccv2',
    ...patch,
  };
}

function post(path: string, body: unknown): Request {
  return new Request(`http://tessera.test${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Records what was deferred, which is how "was a model call queued?" is answered. */
function makeCtx(): { ctx: ExecutionContext; deferred: Promise<unknown>[] } {
  const deferred: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => deferred.push(promise),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { ctx, deferred };
}

/**
 * How many promises a request defers before it reaches the route.
 *
 * The fetch handler queues the job-recovery sweep and one memory job on every request, so
 * "did the opening seed also get queued?" is only answerable relative to that baseline —
 * measured here rather than hard-coded, so adding a hook does not break these tests.
 */
async function hookBaseline(env: Env): Promise<number> {
  const { ctx, deferred } = makeCtx();
  await worker.fetch(new Request('http://tessera.test/api/health'), env, ctx);
  return deferred.length;
}

async function store(env: Env, payload: CharacterCardJson): Promise<string> {
  const res = await createCharacter(env, post('/api/characters', { card: payload }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function readCardOf(env: Env, id: string): Promise<CharacterCardJson> {
  const res = await getCharacterDetail(env, id);
  const detail = (await res.json()) as { card: CharacterCardJson };
  return detail.card;
}

describe('greetingStates on a card', () => {
  test('round-trips through the write and the read', async () => {
    const { env } = makeEnv();
    const states: GreetingState[] = [
      { time: 'Friday, 27 February 2026, 05:35', location: 'The Compass Rose' },
      { location: 'The north road', weather: 'Cold, clear' },
    ];
    const id = await store(env, card({ name: 'Ada', greetingStates: states }));

    expect((await readCardOf(env, id)).greetingStates).toEqual(states);
  });

  test('a malformed value leaves the field alone instead of failing the save', async () => {
    const { env } = makeEnv();
    const id = await store(env, card({ name: 'Ada', greetingStates: [{ time: 'Noon' }] }));

    // `nonsense` is not an array of objects. The rest of the card is still the reader's
    // edit, so the write goes through and the field keeps what it had.
    const res = await updateCharacter(
      env,
      new Request('http://tessera.test/api/characters/x', {
        method: 'PATCH',
        body: JSON.stringify({
          id,
          card: { ...card({ name: 'Ada' }), greetingStates: 'nonsense', personality: 'Sharp.' },
        }),
      }),
    );
    expect(res.status).toBe(200);

    const stored = await readCardOf(env, id);
    expect(stored.personality).toBe('Sharp.');
    expect(stored.greetingStates).toEqual([{ time: 'Noon' }]);
  });

  test('an entry with a non-string field becomes an empty object rather than dropping the entry', async () => {
    const { env } = makeEnv();
    // Position is the only thing tying a scene to its opening, so an unreadable field
    // must not shift the entries after it.
    //
    // The cast is the point of the test: `time: 42` is not a `GreetingState`, and the
    // reader is what has to survive that. Typing the fixture honestly would mean not
    // testing the case at all.
    const malformed = [{ time: 42, location: 'The Compass Rose' }, { weather: 'Rain' }] as unknown as GreetingState[];
    const id = await store(env, card({ name: 'Ada', greetingStates: malformed }));

    expect((await readCardOf(env, id)).greetingStates).toEqual([
      { time: '', location: 'The Compass Rose' },
      { weather: 'Rain' },
    ]);
  });
});

describe('a chat started from an opening that states its scene', () => {
  test('takes the card at its word and attaches the scene to the greeting row', async () => {
    const { env, db } = makeEnv();
    const { ctx, deferred } = makeCtx();
    const id = await store(
      env,
      card({
        name: 'Ada',
        firstMes: 'You are late.',
        alternateGreetings: ['The door is already open.'],
        greetingStates: [{ time: 'Friday, 27 February 2026, 05:35' }, { location: 'The north road' }],
      }),
    );

    const res = await worker.fetch(post('/api/chats', { characterId: id, greetingIndex: 1 }), env, ctx);
    expect(res.status).toBe(201);
    const chatId = ((await res.json()) as { id: string }).id;

    const stored = one<{ json: string }>(db, 'SELECT json FROM state WHERE chat_id = ?', chatId);
    expect(JSON.parse(stored?.json ?? '{}')).toEqual({ location: 'The north road' });

    // On the greeting row, so the first turn has a scene line to render. The row is the
    // chat's only message and it must be the SECOND opening, whose scene this is.
    const greeting = one<{ content: string; state_json: string | null }>(
      db,
      'SELECT content, state_json FROM messages WHERE chat_id = ?',
      chatId,
    );
    expect(greeting?.content).toBe('The door is already open.');
    expect(JSON.parse(greeting?.state_json ?? '{}')).toEqual({ location: 'The north road' });

    // And no model call: the reader wrote the scene, so inferring it would spend a call to
    // overwrite an answer with a guess.
    expect(deferred).toHaveLength(await hookBaseline(env));
  });

  test('an opening with no scene writes no state and leaves the model seed to run', async () => {
    const { env, db } = makeEnv();
    const { ctx, deferred } = makeCtx();
    const id = await store(env, card({ name: 'Ada' }));

    const res = await worker.fetch(post('/api/chats', { characterId: id }), env, ctx);
    const chatId = ((await res.json()) as { id: string }).id;

    // Nothing invents a scene for a card that states none...
    expect(one(db, 'SELECT json FROM state WHERE chat_id = ?', chatId)).toBeNull();
    expect(
      one<{ state_json: string | null }>(db, 'SELECT state_json FROM messages WHERE chat_id = ?', chatId)
        ?.state_json,
    ).toBeNull();
    // ...and the ordinary path is untouched: `generateOpeningState` defaults on, so the
    // seed is queued in addition to the per-request hooks.
    expect(deferred).toHaveLength((await hookBaseline(env)) + 1);
  });

  test('an empty entry is not a stated scene, so it does not suppress the model seed', async () => {
    const { env, db } = makeEnv();
    const { ctx, deferred } = makeCtx();
    // The editor writes `{}` for an opening the reader gave no scene. Treating that as
    // stated would skip the seed and leave the chat with no scene at all.
    const id = await store(env, card({ name: 'Ada', greetingStates: [{}] }));

    const res = await worker.fetch(post('/api/chats', { characterId: id }), env, ctx);
    const chatId = ((await res.json()) as { id: string }).id;

    expect(one(db, 'SELECT json FROM state WHERE chat_id = ?', chatId)).toBeNull();
    expect(deferred).toHaveLength((await hookBaseline(env)) + 1);
  });
});
