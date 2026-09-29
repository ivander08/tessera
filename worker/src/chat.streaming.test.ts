import { afterEach, describe, expect, test } from 'bun:test';
import { encryptKey } from '../../src/lib/crypto';
import { handleChat } from './chat';

/**
 * Pins the property that our pipeline does not buffer.
 *
 * This matters more than it looks. The configured provider (Kenari) buffers SSE at its
 * own gateway — verified directly against five models across four vendors, every one of
 * them delivers the whole completion in a single burst after generation finishes. So if
 * OUR code started buffering, the app would look exactly the same, and the regression
 * would be invisible until someone switched to a provider that streams properly.
 *
 * The test therefore stubs `fetch` with an upstream that emits frames with real delays,
 * and asserts that the frames come back out of `handleChat` spread over time rather than
 * in one lump. It fails the moment someone introduces an `await res.text()`,
 * a body-wide `.buffer()`, or an await-everything-then-write loop.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A D1 stub good enough for the handful of statements a turn issues. */
function stubEnv(): Env {
  const chat = {
    id: 'chat-1',
    character_id: 'char-1',
    persona_id: null,
    title: 'Test',
    preset_id: null,
    window_start_seq: 0,
    session_id: 'session-1',
    last_prefix_hash: null,
    last_prefix_head: null,
    created_at: 0,
    updated_at: 0,
  };
  const character = {
    id: 'char-1',
    name: 'Ada',
    avatar: null,
    source_format: 'ccv2',
    tokens: 10,
    created_at: 0,
    card_json: JSON.stringify({
      name: 'Ada',
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
    }),
  };

  const settings: Record<string, string> = {
    provider: 'openrouter',
    model: 'test/model',
    systemPrompt: 'You are a narrator.',
  };

  // A real encrypted key row, so the test exercises settings read -> provider lookup ->
  // AES-GCM decrypt rather than stubbing the key loader out.
  const { promise: keyPromise, resolve: resolveKey } = Promise.withResolvers<{
    key_enc: Uint8Array;
    iv: Uint8Array;
  }>();
  void encryptKey('sk-test', 'token').then(({ enc, iv }) =>
    resolveKey({ key_enc: new Uint8Array(enc), iv: new Uint8Array(iv) }),
  );

  function statement(sql: string) {
    const trimmed = sql.replace(/\s+/g, ' ').trim();
    const api = {
      bind: (..._args: unknown[]) => api,
      first: async () => {
        if (trimmed.startsWith('SELECT * FROM chats')) return chat;
        if (trimmed.includes('FROM provider_keys')) return await keyPromise;
        if (trimmed.startsWith('SELECT * FROM characters')) return character;
        if (trimmed.includes('FROM token_calibration')) return { factor: 1, samples: 0 };
        if (trimmed.includes('FROM settings')) return null;
        if (trimmed.includes('RETURNING seq')) return { seq: 2 };
        return null;
      },
      all: async () => {
        // `loadChatSettings` reads the whole settings table, not one row.
        if (trimmed.includes('FROM settings')) {
          return {
            results: Object.entries(settings).map(([key, value]) => ({ key, value })),
          };
        }
        return { results: [] };
      },
      run: async () => ({ success: true }),
    };
    return api;
  }

  return {
    DB: {
      prepare: (sql: string) => statement(sql),
      exec: async () => ({ count: 0, duration: 0 }),
      batch: async () => [],
      dump: async () => new ArrayBuffer(0),
    },
    ASSETS: { fetch: async () => new Response('') },
    APP_NAME: 'Tessera',
    TESSERA_TOKEN: 'token',
  } as unknown as Env;
}

/**
 * Upstream SSE that emits `count` frames, each after `gapMs`.
 *
 * Real wall-clock delays are the exception the timer rule allows, and they are
 * unavoidable here: the property under test IS the arrival schedule of bytes. Fake
 * timers would collapse the gap to zero, which is precisely the buffered behaviour this
 * test exists to distinguish from streaming, so a fake-timer version would pass against
 * a buffering implementation and prove nothing. Six frames at 60 ms keeps the whole
 * test under half a second.
 */
function slowUpstream(count: number, gapMs: number): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent >= count) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, gapMs);
        await promise;
        sent++;
        const frame = JSON.stringify({
          choices: [{ delta: { content: `w${sent} ` } }],
        });
        controller.enqueue(encoder.encode(`data: ${frame}\n\n`));
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
}

/** Reads the Worker's normalized frames, recording when each arrived. */
async function drainTimed(res: Response): Promise<{ stamps: number[]; frames: string[] }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const stamps: number[] = [];
  const frames: string[] = [];
  const start = performance.now();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      if (part.startsWith('data:')) {
        stamps.push(Math.round(performance.now() - start));
        frames.push(part.slice(5));
      }
    }
  }
  return { stamps, frames };
}

/** The Worker passes an ExecutionContext; background work is scheduled on it. */
function stubCtx(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

function chatRequest(): Request {
  return new Request('https://tessera.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: 'chat-1', content: 'hello' }),
  });
}

describe('chat streaming', () => {
  test('emits frames as the upstream produces them, not in one burst', async () => {
    const GAP = 60;
    const COUNT = 6;
    globalThis.fetch = slowUpstream(COUNT, GAP);

    const res = await handleChat(chatRequest(), stubEnv(), stubCtx());
    const { stamps, frames } = await drainTimed(res);

    if (stamps.length !== COUNT + 1) {
      throw new Error(`expected ${COUNT + 1} frames, got ${stamps.length}:\n${frames.join('\n')}`);
    }

    // 6 deltas plus the terminal `done` frame.
    expect(stamps.length).toBe(COUNT + 1);

    const spread = stamps[stamps.length - 1] - stamps[0];
    // Buffered output would put every frame within a few ms of the last one. The
    // upstream deliberately takes COUNT*GAP ms, so a streaming pipeline must show a
    // spread of the same order. The floor is well below that and well above the noise
    // of a buffered run.
    expect(spread).toBeGreaterThan(GAP * (COUNT - 2));

    // And the first frame must arrive long before the upstream has finished, which is
    // the property the user actually feels.
    expect(stamps[0]).toBeLessThan(GAP * COUNT);
  });

  test('the terminal frame is exactly one done', async () => {
    globalThis.fetch = slowUpstream(3, 5);
    const res = await handleChat(chatRequest(), stubEnv(), stubCtx());
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const frames: Array<{ type: string }> = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        if (part.startsWith('data:')) frames.push(JSON.parse(part.slice(5)) as { type: string });
      }
    }

    expect(frames.filter((f) => f.type === 'done')).toHaveLength(1);
    expect(frames.filter((f) => f.type === 'delta').length).toBe(3);
    expect(frames[frames.length - 1].type).toBe('done');
  });
});
