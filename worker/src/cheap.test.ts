import { describe, expect, test } from 'bun:test';
import { encryptKey } from '../../src/lib/crypto';
import { complete, parseJsonReply, streamCheap } from './cheap';

/**
 * The side-channel transport, and the two things about it that a caller cannot see by
 * reading the code: which fields the body actually carries, and what happens when a reply
 * runs out of budget before it says anything.
 *
 * The body assertion is the one that matters most. A reasoning model leaves `content` empty
 * until it finishes thinking, and the 2048-token side-channel budget is small enough that
 * thinking consumed all of it — which reached the user as "Unexpected end of JSON input"
 * from `JSON.parse("")`. `enable_thinking: false` is the fix, and it is invisible to every
 * other test in this repository.
 */

const TOKEN = 'test-token';
const SETTINGS = [
  { key: 'cheapProvider', value: 'kenari' },
  { key: 'cheapModel', value: 'deepseek-v4-flash' },
];

async function configuredEnv(): Promise<Env> {
  const { enc, iv } = await encryptKey('sk-test', TOKEN);
  const keyRow = { key_enc: new Uint8Array(enc), iv: new Uint8Array(iv) };

  return {
    DB: {
      prepare: (sql: string) => {
        const statement = {
          bind: () => statement,
          all: async () => ({ results: sql.includes('FROM settings') ? SETTINGS : [] }),
          first: async () => keyRow,
          run: async () => ({}),
        };
        return statement;
      },
    },
    TESSERA_TOKEN: TOKEN,
  } as unknown as Env;
}

/** Runs `body` with `fetch` replaced, returning what was sent and restoring afterwards. */
async function withFetch<T>(
  reply: () => Response,
  body: (sent: Array<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return reply();
  }) as unknown as typeof fetch;
  try {
    return await body(sent);
  } finally {
    globalThis.fetch = original;
  }
}

/** The buffered JSON shape a provider that ignored `stream: true` answers with. */
function bufferedReply(content: string, finishReason: string | null): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: finishReason }] }),
    { headers: { 'content-type': 'application/json' } },
  );
}

/** The SSE shape the streaming path reads. */
function streamedReply(pieces: string[], finishReason: string | null): Response {
  const encoder = new TextEncoder();
  const frames = pieces.map(
    (piece) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`,
  );
  frames.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`);
  frames.push('data: [DONE]\n\n');

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

describe('complete', () => {
  test('asks for the answer directly rather than the thinking', async () => {
    const env = await configuredEnv();
    const sent = await withFetch(
      () => bufferedReply('{"ok":true}', 'stop'),
      async (bodies) => {
        await complete(env, { system: 's', user: 'u', json: true });
        return bodies;
      },
    );

    // The whole fix for the reported bug: without this the reasoning model spends the
    // side-channel budget thinking and returns `content: ""`.
    expect(sent[0].enable_thinking).toBe(false);
    expect(sent[0].response_format).toEqual({ type: 'json_object' });
    expect(sent[0].stream).toBe(false);
    expect(sent[0].messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ]);
  });

  test('reports a budget-starved reply instead of leaving JSON.parse to blame the JSON', async () => {
    const env = await configuredEnv();
    await withFetch(
      () => bufferedReply('', 'length'),
      async () => {
        // This is exactly the production shape: empty content, finish_reason `length`.
        await expect(complete(env, { user: 'u', maxTokens: 2048 })).rejects.toThrow(
          /used all 2048 tokens without producing an answer/,
        );
      },
    );
  });

  test('names the model in that message, so the fix is obvious', async () => {
    const env = await configuredEnv();
    await withFetch(
      () => bufferedReply('', 'length'),
      async () => {
        await expect(complete(env, { user: 'u' })).rejects.toThrow(/deepseek-v4-flash/);
      },
    );
  });

  test('an empty reply that STOPPED is left alone — it is the model, not the budget', async () => {
    const env = await configuredEnv();
    const result = await withFetch(
      () => bufferedReply('', 'stop'),
      () => complete(env, { user: 'u' }),
    );
    expect(result.text).toBe('');
    expect(result.finishReason).toBe('stop');
  });

  test('a truncated reply with text in it is returned, not thrown away', async () => {
    // Half a card is the caller's problem to retry; discarding it here would hide the
    // partial answer from the retry loop that knows what to do with it.
    const env = await configuredEnv();
    const result = await withFetch(
      () => bufferedReply('{"name":"Mir', 'length'),
      () => complete(env, { user: 'u' }),
    );
    expect(result.text).toBe('{"name":"Mir');
    expect(result.finishReason).toBe('length');
  });
});

describe('streamCheap', () => {
  test('carries the system prompt AND the conversation', async () => {
    // Dropping the system message when a message list is present sends a bare conversation,
    // and the model answers as if it had never been told what it is. Measured live: the
    // consultant returned prose instead of its JSON contract.
    const env = await configuredEnv();
    const sent = await withFetch(
      () => bufferedReply('{"say":"ok"}', 'stop'),
      async (bodies) => {
        await streamCheap(env, {
          system: 'SYSTEM',
          messages: [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'second' },
            { role: 'user', content: 'third' },
          ],
        });
        return bodies;
      },
    );

    expect(sent[0].messages).toEqual([
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ]);
    expect(sent[0].stream).toBe(true);
    expect(sent[0].enable_thinking).toBe(false);
  });

  test('reports each fragment as it arrives, and the whole text at the end', async () => {
    const env = await configuredEnv();
    const seen: string[] = [];
    const result = await withFetch(
      () => streamedReply(['{"say":', '"hello"', '}'], 'stop'),
      () => streamCheap(env, { messages: [{ role: 'user', content: 'u' }] }, (t) => seen.push(t)),
    );

    expect(seen).toEqual(['{"say":', '"hello"', '}']);
    expect(result.text).toBe('{"say":"hello"}');
    expect(result.finishReason).toBe('stop');
  });

  test('a provider that ignored stream:true still reports its text as one delta', async () => {
    // Otherwise a caller that renders deltas would show nothing at all until the end.
    const env = await configuredEnv();
    const seen: string[] = [];
    const result = await withFetch(
      () => bufferedReply('{"say":"whole"}', 'stop'),
      () => streamCheap(env, { messages: [{ role: 'user', content: 'u' }] }, (t) => seen.push(t)),
    );

    expect(seen).toEqual(['{"say":"whole"}']);
    expect(result.text).toBe('{"say":"whole"}');
  });

  test('carries finish_reason out of the terminal frame', async () => {
    const env = await configuredEnv();
    const result = await withFetch(
      () => streamedReply(['partial'], 'length'),
      () => streamCheap(env, { messages: [{ role: 'user', content: 'u' }] }),
    );
    expect(result.finishReason).toBe('length');
  });

  test('a budget-starved stream throws the same message the buffered path does', async () => {
    const env = await configuredEnv();
    await withFetch(
      () => streamedReply([], 'length'),
      async () => {
        await expect(
          streamCheap(env, { messages: [{ role: 'user', content: 'u' }], maxTokens: 512 }),
        ).rejects.toThrow(/used all 512 tokens without producing an answer/);
      },
    );
  });
});

describe('parseJsonReply control-character repair', () => {
  test('parses a reply whose say contains a raw newline', () => {
    // Measured live: a model writing a multi-line `say` emits a real newline inside the
    // string literal, which killed a complete consult turn with
    // "Bad control character in string literal".
    const reply = '{"say": "Line one.\nLine two.", "question": null, "card": null}';
    const parsed = parseJsonReply<{ say: string }>(reply);
    expect(parsed.say).toBe('Line one.\nLine two.');
  });

  test('repairs a raw tab and carriage return too', () => {
    const reply = '{"say": "a\tb\rc"}';
    expect(parseJsonReply<{ say: string }>(reply).say).toBe('a\tb\rc');
  });

  test('leaves the whitespace BETWEEN keys alone', () => {
    // A newline outside a string is legal JSON and must survive: rewriting it would change
    // the document for no reason.
    const reply = '{\n  "say": "one",\n  "question": null\n}';
    const parsed = parseJsonReply<{ say: string }>(reply);
    expect(parsed.say).toBe('one');
  });

  test('does not mistake an escaped quote for the end of the string', () => {
    // The scan tracks string state, so a `"` that is escaped must not flip it and cause the
    // following newline to be left raw.
    const reply = '{"say": "She said \\"stop\\".\nThen left.", "question": null}';
    expect(parseJsonReply<{ say: string }>(reply).say).toBe('She said "stop".\nThen left.');
  });

  test('does not mistake a brace inside a string for structure', () => {
    const reply = '{"say": "a } b\nc", "question": null}';
    expect(parseJsonReply<{ say: string }>(reply).say).toBe('a } b\nc');
  });

  test('a reply that already parses is returned untouched', () => {
    const reply = '{"say": "fine\\nand escaped"}';
    expect(parseJsonReply<{ say: string }>(reply).say).toBe('fine\nand escaped');
  });

  test('still throws for a reply that is genuinely broken', () => {
    // The repair is narrow on purpose: truncation is a different failure and must not be
    // silently half-parsed.
    expect(() => parseJsonReply('{"say": "unterminated')).toThrow();
  });
});
