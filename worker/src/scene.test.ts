import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'bun:test';

import { getSceneSetup, loadSceneSetup, maybeUpdateState, patchSceneSetup } from './scene';
import { DEFAULT_SCENE_SETUP, type SceneSetup } from '../../src/lib/scene/setup';
import { encryptKey } from '../../src/lib/crypto';

/**
 * The scene-setup endpoints, against the real migrations.
 *
 * The property worth pinning is that a missing row is the DEFAULT and not an error, and
 * that reading never writes. Every chat that existed before this table did, and every
 * chat created without going through the wizard, has no row — so a read that 404s or
 * creates one would break the ordinary case in a way that only shows up on real data.
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
  };

  return { env: { DB, APP_NAME: 'Tessera' } as unknown as Env, db };
}

/** `bun-types` types the variadic form too narrowly; one seam keeps the cast out of call sites. */
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

function patchRequest(body: unknown): Request {
  return new Request('http://tessera.test/api/chats/chat-1/scene', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

describe('scene setup: reading', () => {
  test('a chat with no row returns the defaults, not a 404', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);

    const res = await getSceneSetup(env, chatId);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { setup: unknown; updatedAt: number };
    expect(payload.setup).toEqual(DEFAULT_SCENE_SETUP);
    expect(payload.updatedAt).toBe(0);
  });

  test('reading writes nothing', async () => {
    // A GET that creates a row would make every read of an unconfigured chat a mutation,
    // and would make "has the reader configured this?" unanswerable.
    const { env, db } = makeEnv();
    const chatId = seedChat(db);

    await getSceneSetup(env, chatId);
    await loadSceneSetup(env, chatId);
    await getSceneSetup(env, chatId);

    expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM chat_scene_setup')).toEqual({ n: 0 });
  });

  test('an unknown chat is a 404', async () => {
    const { env } = makeEnv();
    expect((await getSceneSetup(env, 'nope')).status).toBe(404);
  });

  test('a malformed stored row degrades to the defaults rather than throwing', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    exec(
      db,
      'INSERT INTO chat_scene_setup (chat_id, json, updated_at) VALUES (?, ?, ?)',
      chatId,
      '{not json',
      Date.now(),
    );

    expect(await loadSceneSetup(env, chatId)).toEqual(DEFAULT_SCENE_SETUP);
  });
});

describe('scene setup: writing', () => {
  test('a partial patch merges over what is stored', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);

    await patchSceneSetup(env, chatId, patchRequest({ timePace: 'hour' }));
    const second = await patchSceneSetup(env, chatId, patchRequest({ stateMode: 'off' }));

    const payload = (await second.json()) as { setup: SceneSetup };
    // The pace from the first call survives: a patch that omits a field is not a request
    // to reset it.
    expect(payload.setup).toEqual({
      timePace: 'hour',
      stateMode: 'off',
      generateOpeningState: DEFAULT_SCENE_SETUP.generateOpeningState,
      craft: DEFAULT_SCENE_SETUP.craft,
    });
    expect(await loadSceneSetup(env, chatId)).toEqual(payload.setup);
  });

  test('an unknown enum member keeps the stored value rather than resetting to the default', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);

    await patchSceneSetup(env, chatId, patchRequest({ timePace: 'minute' }));
    await patchSceneSetup(env, chatId, patchRequest({ timePace: 'bogus' }));

    // `parseSceneSetup` falls back per field, and the merge means the fallback lands on
    // the STORED value here rather than the built-in default.
    expect((await loadSceneSetup(env, chatId)).timePace).toBe('minute');
  });

  test('rejects a body that is not an object', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    for (const body of [[], 'x', 3]) {
      expect((await patchSceneSetup(env, chatId, patchRequest(body))).status).toBe(400);
    }
    expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM chat_scene_setup')).toEqual({ n: 0 });
  });

  test('a patch on an unknown chat is a 404 and writes nothing', async () => {
    const { env, db } = makeEnv();
    expect((await patchSceneSetup(env, 'nope', patchRequest({ timePace: 'hour' }))).status).toBe(404);
    expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM chat_scene_setup')).toEqual({ n: 0 });
  });

  test('patching twice updates the row instead of inserting a second one', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);

    await patchSceneSetup(env, chatId, patchRequest({ timePace: 'hour' }));
    await patchSceneSetup(env, chatId, patchRequest({ timePace: 'minute' }));

    expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM chat_scene_setup')).toEqual({ n: 1 });
    expect((await loadSceneSetup(env, chatId)).timePace).toBe('minute');
  });

  test('deleting the chat deletes its setup', async () => {
    const { env, db } = makeEnv();
    const chatId = seedChat(db);
    await patchSceneSetup(env, chatId, patchRequest({ timePace: 'hour' }));

    exec(db, 'PRAGMA foreign_keys = ON');
    exec(db, 'DELETE FROM chats WHERE id = ?', chatId);
    expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM chat_scene_setup')).toEqual({ n: 0 });
  });
});

describe('scene setup: the state gate', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  /** Counts provider calls, so "off means no call" is provable rather than inferred. */
  function countingFetch(counter: { calls: number }): typeof fetch {
    return (async () => {
      counter.calls += 1;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"location":"somewhere"}' } }] }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
  }

  /** A settings + key read good enough for `complete` to reach the stubbed provider. */
  function providerEnv(db: Database): Env {
    const settings: Record<string, string> = { provider: 'openrouter', model: 'test/model' };
    const { promise: keyPromise, resolve: resolveKey } = Promise.withResolvers<{
      key_enc: Uint8Array;
      iv: Uint8Array;
    }>();
    void encryptKey('sk-test', 'token').then(({ enc, iv }) =>
      resolveKey({ key_enc: new Uint8Array(enc), iv: new Uint8Array(iv) }),
    );

    const DB = {
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
            if (trimmed.includes('FROM token_calibration')) return { factor: 1, samples: 0 };
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

    return { DB, APP_NAME: 'Tessera', TESSERA_TOKEN: 'token' } as unknown as Env;
  }

  test("mode 'off' makes no provider call and writes nothing", async () => {
    const { env: base, db } = makeEnv();
    const chatId = seedChat(db);
    await patchSceneSetup(base, chatId, patchRequest({ stateMode: 'off' }));

    const counter = { calls: 0 };
    globalThis.fetch = countingFetch(counter);

    const result = await maybeUpdateState(providerEnv(db), chatId, { user: 'u', assistant: 'a' });
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('off');
    // The point of the gate: no call at all, not a call whose answer is discarded.
    expect(counter.calls).toBe(0);
    expect(one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM state')).toEqual({ n: 0 });
  });

  test("mode 'manual' still runs, so time and place are maintained", async () => {
    const { env: base, db } = makeEnv();
    const chatId = seedChat(db);
    await patchSceneSetup(base, chatId, patchRequest({ stateMode: 'manual' }));

    const counter = { calls: 0 };
    globalThis.fetch = countingFetch(counter);

    const result = await maybeUpdateState(providerEnv(db), chatId, { user: 'u', assistant: 'a' });
    expect(result.applied).toBe(true);
    expect(counter.calls).toBe(1);
  });

  test('an unconfigured chat tracks automatically, which is the default', async () => {
    const { db } = makeEnv();
    const chatId = seedChat(db);

    const counter = { calls: 0 };
    globalThis.fetch = countingFetch(counter);

    const result = await maybeUpdateState(providerEnv(db), chatId, { user: 'u', assistant: 'a' });
    expect(result.applied).toBe(true);
    expect(counter.calls).toBe(1);
  });
});
