import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'bun:test';

import { loadState, seedOpeningState, updateState } from './update';
import { encryptKey } from '../../../src/lib/crypto';
import { DEFAULT_SCENE_SETUP } from '../../../src/lib/scene/setup';
import type { SceneSetup } from '../../../src/lib/scene/setup';

/**
 * The state engine's two calls: the per-turn patch, and the one-shot opening seed.
 *
 * Both are driven through a stubbed `fetch`, so what is asserted is what actually goes
 * on the wire — which system prompt, with which pace rule, and whether a call happens at
 * all. The rule that matters most is that a patch is accepted only if `validatePatch`
 * accepts it: the model's reply is untrusted input like any other.
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

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** `bun-types` types the variadic form too narrowly; one seam keeps the cast out of call sites. */
function exec(db: Database, sql: string, ...params: unknown[]): void {
  db.run(sql, ...(params as never[]));
}

/** Captures each request body so the test can read the system prompt and user text. */
interface Sent {
  system: string;
  user: string;
}

function makeEnv(): { env: Env; db: Database; sent: Sent[] } {
  const db = new Database(':memory:');
  for (const name of MIGRATIONS) {
    db.exec(readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8'));
  }

  const now = Date.now();
  // `bun-types` types the variadic form too narrowly; the same seam the other worker
  // tests use.
  exec(db,
    `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                        session_id, created_at, updated_at)
     VALUES ('chat-1', NULL, NULL, 't', NULL, 0, 's', ?, ?)`,
    now,
    now,
  );

  const settings: Record<string, string> = {
    provider: 'openrouter',
    model: 'test/model',
    systemPrompt: 'narrator',
  };

  const sent: Sent[] = [];

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

  return {
    env: { DB, APP_NAME: 'Tessera', TESSERA_TOKEN: 'token' } as unknown as Env,
    db,
    sent,
  };
}

/** Stubs the provider with a fixed JSON reply, recording what was asked. */
function stubProvider(sent: Sent[], reply: string): void {
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>;
      response_format?: unknown;
    };
    const system = body.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = body.messages.find((m) => m.role === 'user')?.content ?? '';
    sent.push({ system, user });

    // The JSON path, so the `response_format` request is exercised too.
    expect(body.response_format).toEqual({ type: 'json_object' });

    return new Response(
      JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 1 } }),
      { headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
}

const setupWith = (pace: SceneSetup['timePace']): SceneSetup => ({
  ...DEFAULT_SCENE_SETUP,
  timePace: pace,
});

describe('updateState: the pace rule', () => {
  test('the managed pace tells the model to write the clock on every reply', async () => {
    const { env, sent } = makeEnv();
    stubProvider(sent, '{}');

    await updateState(env, 'chat-1', { user: 'u', assistant: 'a' }, setupWith('auto'));

    expect(sent).toHaveLength(1);
    const system = sent[0].system;
    expect(system).toContain('ALWAYS emit this key');
    // The vague-time-of-day case, which is what a free-text stored clock needs.
    expect(system).toContain('late evening');
    // And the schema is unchanged by the pace rule: the same allowed keys are described.
    expect(system).toContain('"outfits"');
    expect(system).toContain('"conditions"');
    expect(system).not.toContain('"elapsed"');
  });

  test('the manual prompt never tells the model to record or advance a clock', async () => {
    // The defect this replaces: two unconditional instructions inside `SYSTEM` — the key
    // description said "advance it as the scene moves", a Rules bullet said "record it in
    // full" — overrode the appended pace rule, so `manual` advanced the clock (measured
    // 04:00 -> 09:30). The instructions now come from one place, and this is the assertion
    // that they agree.
    const { env, sent } = makeEnv();
    stubProvider(sent, '{}');

    await updateState(env, 'chat-1', { user: 'u', assistant: 'a' }, setupWith('manual'));

    const system = sent[0].system;
    expect(system).toContain('Never change');
    expect(system).not.toContain('"elapsed"');
    expect(system).not.toContain('record it in full');
    expect(system).not.toContain('advance it as the');
  });

  test('no pace leaves a placeholder in the prompt', async () => {
    for (const pace of ['auto', 'manual'] as const) {
      const { env, sent } = makeEnv();
      stubProvider(sent, '{}');
      await updateState(env, 'chat-1', { user: 'u', assistant: 'a' }, setupWith(pace));

      expect(sent[0].system).not.toContain('{{TIME_KEY}}');
      expect(sent[0].system).not.toContain('{{TIME_BULLET}}');
      expect(sent[0].system).not.toContain('{{BONDS_KEY}}');
      expect(sent[0].system).not.toContain('{{THREADS_KEY}}');
      // The key is described exactly once, by the entry that replaced the placeholder.
      expect(sent[0].system.match(/"time" {7}string/g)).toHaveLength(1);
    }
  });

  test('the bonds and threads keys appear only when the craft toggle asks for them', async () => {
    // An instruction the model is not being asked to follow must not be in the prompt.
    const off = makeEnv();
    stubProvider(off.sent, '{}');
    await updateState(off.env, 'chat-1', { user: 'u', assistant: 'a' }, setupWith('auto'));
    expect(off.sent[0].system).not.toContain('"bonds"');
    expect(off.sent[0].system).not.toContain('"threads"');

    const on = makeEnv();
    stubProvider(on.sent, '{}');
    await updateState(
      on.env,
      'chat-1',
      { user: 'u', assistant: 'a' },
      { ...setupWith('auto'), craft: { ...setupWith('auto').craft, bonds: true, threads: true } },
    );
    expect(on.sent[0].system).toContain('"bonds"');
    expect(on.sent[0].system).toContain('"threads"');
    // And the description is the one the renderer understands.
    expect(on.sent[0].system).toContain('SORTED alphabetically');
  });

  test('stores a valid patch', async () => {
    const { env, db, sent } = makeEnv();
    stubProvider(sent, '{"location":"the lantern room","outfits":{"Quill":"oilskin coat"}}');

    const result = await updateState(env, 'chat-1', { user: 'u', assistant: 'a' }, setupWith('auto'));
    expect(result.applied).toBe(true);
    expect(await loadState(env, 'chat-1')).toEqual({
      location: 'the lantern room',
      outfits: { Quill: 'oilskin coat' },
    });
    expect(db).toBeDefined();
  });

  test('an invalid patch changes nothing', async () => {
    // The model is untrusted input. A hallucinated key must not reach the document.
    const { env, sent } = makeEnv();
    stubProvider(sent, '{"location":"the lantern room","nonsense":true}');

    const result = await updateState(env, 'chat-1', { user: 'u', assistant: 'a' }, setupWith('auto'));
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('nonsense');
    expect(await loadState(env, 'chat-1')).toEqual({});
  });

  test('a non-JSON reply is not applied and does not throw', async () => {
    const { env, sent } = makeEnv();
    stubProvider(sent, 'I think nothing changed.');

    const result = await updateState(env, 'chat-1', { user: 'u', assistant: 'a' }, setupWith('auto'));
    expect(result.applied).toBe(false);
    expect(await loadState(env, 'chat-1')).toEqual({});
  });
});

/**
 * The reported bug: the clock did not move. The model now writes the whole clock itself
 * and is told to emit `time` on EVERY reply, so a quiet exchange and a vague stored value
 * both advance. These pin what the reader sees.
 */
describe('updateState: the clock advances', () => {
  test('a stated duration moves the clock, and it is stored', async () => {
    const { env, sent } = makeEnv();
    stubProvider(sent, '{"time":"Friday, April 11, 2025, 22:12"}');

    await updateState(env, 'chat-1', { user: 'u', assistant: 'a' }, setupWith('auto'));

    expect((await loadState(env, 'chat-1')).time).toBe('Friday, April 11, 2025, 22:12');
  });

  test('a quiet exchange still moves the clock', async () => {
    // The measured defect: "You good now?" / "Both." left the clock unchanged for eight
    // messages, so a whole conversation took a minute.
    const { env, sent } = makeEnv();
    stubProvider(sent, '{"time":"Friday, April 11, 2025, 22:05"}');

    await updateState(env, 'chat-1', { user: 'u', assistant: 'a' }, setupWith('auto'));

    expect((await loadState(env, 'chat-1')).time).toBe('Friday, April 11, 2025, 22:05');
  });

  test('a free-text stored clock is normalised, not left stuck', async () => {
    // The edge that made the earlier design wrong: a stored value with no clock in it
    // ("late evening") had nothing for the arithmetic to add to, so it stayed un-advanceable
    // forever. The model reads it and writes a concrete reading instead.
    const { env, db, sent } = makeEnv();
    db.run(
      `INSERT INTO state (chat_id, json, updated_at) VALUES ('chat-1', ?, 0)
       ON CONFLICT(chat_id) DO UPDATE SET json = excluded.json`,
      [JSON.stringify({ time: 'late evening' })] as never[],
    );
    stubProvider(sent, '{"time":"Friday, April 11, 2025, 21:00"}');

    await updateState(env, 'chat-1', { user: 'u', assistant: 'a' }, setupWith('auto'));

    expect((await loadState(env, 'chat-1')).time).toBe('Friday, April 11, 2025, 21:00');
  });

  test('manual never advances the clock', async () => {
    // The reader owning the clock is the one thing the pace setting promises, so the
    // manual prompt forbids moving it.
    const { env, sent } = makeEnv();
    stubProvider(sent, '{}');

    await updateState(env, 'chat-1', { user: 'u', assistant: 'a' }, setupWith('manual'));

    expect(sent[0].system).toContain('Never change');
    expect((await loadState(env, 'chat-1')).time).toBeUndefined();
  });

  test('the token budget leaves room for a reasoning model to answer', async () => {
    // The bug that actually froze the clock on prod, and that a prompt fix alone would not
    // have caught: the configured cheap model (gpt-oss-120b) spends its allowance thinking,
    // so at 400 tokens `content` came back EMPTY with finish_reason "length" and the whole
    // state update failed — silently, since a failed update is only a warning. The clock
    // then never moved no matter what the prompt said.
    const { env } = makeEnv();
    let maxTokens = 0;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { max_tokens?: number };
      maxTokens = body.max_tokens ?? 0;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1 } }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await updateState(env, 'chat-1', { user: 'u', assistant: 'a' }, setupWith('auto'));

    // Comfortably above what a reasoning model needs to think and still emit the patch.
    expect(maxTokens).toBeGreaterThanOrEqual(1024);
  });
});

describe('seedOpeningState', () => {
  test('writes the state the greeting implies', async () => {
    const { env, sent } = makeEnv();
    stubProvider(
      sent,
      '{"time":"Friday, 27 February 2026, 05:35","location":"the lantern room",' +
        '"weather":"warm, clear morning","outfits":{"Quill":"oilskin coat, salt-stained"}}',
    );

    const result = await seedOpeningState(
      env,
      'chat-1',
      'Quill looks up. You are late.',
      {
        name: 'Quill',
        description: 'A lighthouse keeper.',
      },
      setupWith('auto'),
    );

    expect(result.applied).toBe(true);
    expect(await loadState(env, 'chat-1')).toEqual({
      time: 'Friday, 27 February 2026, 05:35',
      location: 'the lantern room',
      weather: 'warm, clear morning',
      outfits: { Quill: 'oilskin coat, salt-stained' },
    });
  });

  test('asks only for the opening facts, and says to omit what is not established', async () => {
    const { env, sent } = makeEnv();
    stubProvider(sent, '{}');

    await seedOpeningState(
      env,
      'chat-1',
      'The room is empty and quiet.',
      {
        name: 'Quill',
        description: 'A lighthouse keeper.',
      },
      setupWith('auto'),
    );

    const system = sent[0].system;
    expect(system).toContain('OPENING');
    expect(system).toContain('leave everything else');
    expect(system).toContain('omit it rather than inventing it');
    // The card is context for the greeting, not a licence to invent.
    expect(sent[0].user).toContain('The room is empty and quiet.');
    expect(sent[0].user).toContain('A lighthouse keeper.');
  });

  test('a manual chat is told not to seed a clock at all', async () => {
    // Under `manual` the reader owns `time`, so a greeting that implies a time must not
    // hand them one they did not choose.
    const { env, sent } = makeEnv();
    stubProvider(sent, '{}');

    await seedOpeningState(
      env,
      'chat-1',
      'It is nearly dawn when the door opens.',
      { name: 'Quill', description: '' },
      setupWith('manual'),
    );

    expect(sent[0].system).toContain('When the pace is manual, omit "time" entirely.');
    expect(sent[0].system).toContain('belongs to the reader');
  });

  test('an empty patch writes no row at all', async () => {
    // A greeting that establishes nothing is a legitimate outcome, and a row holding `{}`
    // is a write with no information in it.
    const { env, db, sent } = makeEnv();
    stubProvider(sent, '{}');

    const result = await seedOpeningState(
      env,
      'chat-1',
      'The room is empty and quiet.',
      {
        name: 'Quill',
        description: '',
      },
      setupWith('auto'),
    );

    expect(result.applied).toBe(false);
    expect(db.query('SELECT COUNT(*) AS n FROM state').get()).toEqual({ n: 0 });
  });

  test('a blank greeting does not call the model', async () => {
    const { env, sent } = makeEnv();
    stubProvider(sent, '{}');

    const result = await seedOpeningState(env, 'chat-1', '   ', { name: 'Q', description: '' }, setupWith('auto'));
    expect(result.applied).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test('a provider failure is reported, not thrown', async () => {
    // This runs behind a response; a scene with no opening state must still work.
    const { env } = makeEnv();
    globalThis.fetch = (async () => {
      throw new Error('provider down');
    }) as unknown as typeof fetch;

    const result = await seedOpeningState(
      env,
      'chat-1',
      'Some greeting.',
      {
        name: 'Q',
        description: '',
      },
      setupWith('auto'),
    );
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('provider down');
  });
});
