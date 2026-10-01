import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

import { DEFAULT_KNOBS, loadChatSettings } from './db';
import { kenari } from './providers/kenari';

/**
 * The sampler defaults, and the fact that they reach the provider's request body.
 *
 * The defect these pin: the harness sent no sampler settings at all. `settings.knobs` was
 * `{}` on every install that had never opened the knob editor — and the stored row for such
 * an install holds the two characters `{}`, a truthy STRING, so a truthiness check on the
 * column read the empty map straight through. `kenari.buildRequest` then spread that empty
 * map over nothing and no `temperature` or `top_p` reached the provider, while the preset
 * family the craft rules are tuned against ships `temperature 0.7 / top_p 0.8`. A model at
 * an unset temperature follows its own distribution rather than the prompt.
 *
 * Both halves are asserted, because either one alone passes while the feature is dead: a
 * default that is computed but never spread, and a spread of a map that is still empty.
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

function setSetting(db: Database, key: string, value: string): void {
  db.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ...([key, value, Date.now()] as never[]),
  );
}

describe('the sampler defaults', () => {
  test('an install that has never set knobs gets the preset family defaults', async () => {
    const { env, db } = makeEnv();
    // The shape a real install has: the column holds the literal `{}`, not NULL. This is
    // what made the old truthiness check read the empty map through.
    setSetting(db, 'knobs', '{}');

    const settings = await loadChatSettings(env);
    expect(settings.knobs).toEqual(DEFAULT_KNOBS);
    expect(settings.knobs.temperature).toBe(0.7);
    expect(settings.knobs.top_p).toBe(0.8);
  });

  test('a missing knobs row also gets the defaults', async () => {
    const { env } = makeEnv();
    expect((await loadChatSettings(env)).knobs).toEqual(DEFAULT_KNOBS);
  });

  test('an install that HAS set knobs keeps them verbatim', async () => {
    const { env, db } = makeEnv();
    setSetting(db, 'knobs', JSON.stringify({ temperature: 0.2 }));

    const settings = await loadChatSettings(env);
    // Verbatim, and NOT merged with the defaults: an install that chose 0.2 meant 0.2, and
    // adding a `top_p` beside it would be a second opinion nobody asked for.
    expect(settings.knobs).toEqual({ temperature: 0.2 });
  });

  test('a malformed knobs row falls back rather than breaking every turn', async () => {
    const { env, db } = makeEnv();
    setSetting(db, 'knobs', 'not json');

    expect((await loadChatSettings(env)).knobs).toEqual(DEFAULT_KNOBS);
  });

  test('the defaults reach the provider request body, not just the settings object', async () => {
    const { env, db } = makeEnv();
    setSetting(db, 'knobs', '{}');

    const settings = await loadChatSettings(env);
    const built = kenari.buildRequest(
      {
        model: 'deepseek-v4-1-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        maxTokens: 4096,
        knobs: settings.knobs,
        sessionId: 'session-1',
      },
      'key',
    );
    const body = JSON.parse(String(built.init.body)) as Record<string, unknown>;

    // The whole point: without this the app ran at the provider's own default temperature
    // while the prompt was tuned against 0.7.
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.8);
  });
});
