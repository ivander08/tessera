import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { DEFAULT_KNOBS, loadChatSettings } from './db';
import { kenari } from './providers/kenari';
import { makeTestEnv } from './test/harness';

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
const makeEnv = (): { env: Env; db: Database } => {
  const { env, db } = makeTestEnv();
  return { env, db };
};

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
        disableReasoning: settings.disableReasoning,
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

describe('cheapContextBudget', () => {
  test('an install that has never set it gets no ceiling', async () => {
    const { env } = makeEnv();
    expect((await loadChatSettings(env)).cheapContextBudget).toBe(0);
  });

  test('zero is preserved as "no ceiling" rather than replaced by a default', async () => {
    // The bug a `|| DEFAULT` fallback would introduce: an explicit 0 becomes 16384, and the
    // reader who asked for no ceiling silently gets one.
    const { env, db } = makeEnv();
    setSetting(db, 'cheapContextBudget', '0');
    expect((await loadChatSettings(env)).cheapContextBudget).toBe(0);
  });

  test('a positive value is read as the ceiling', async () => {
    const { env, db } = makeEnv();
    setSetting(db, 'cheapContextBudget', '8192');
    expect((await loadChatSettings(env)).cheapContextBudget).toBe(8192);
  });

  test('a malformed or negative value falls back to no ceiling, not to a guessed one', async () => {
    const { env, db } = makeEnv();
    setSetting(db, 'cheapContextBudget', 'not a number');
    expect((await loadChatSettings(env)).cheapContextBudget).toBe(0);

    setSetting(db, 'cheapContextBudget', '-500');
    expect((await loadChatSettings(env)).cheapContextBudget).toBe(0);
  });

  test('the ceiling is independent of the narrator context budget', async () => {
    const { env, db } = makeEnv();
    setSetting(db, 'contextBudget', '32768');
    setSetting(db, 'cheapContextBudget', '4096');

    const settings = await loadChatSettings(env);
    expect(settings.contextBudget).toBe(32768);
    expect(settings.cheapContextBudget).toBe(4096);
  });
});
