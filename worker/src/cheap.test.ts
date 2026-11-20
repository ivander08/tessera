import { describe, expect, test } from 'bun:test';
import { encryptKey } from '../../src/lib/crypto';
import { complete, parseJsonReply, streamCheap } from './cheap';
import { estimateTokens } from '../../src/lib/tokenEstimate';

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

async function configuredEnv(extra: Array<{ key: string; value: string }> = []): Promise<Env> {
  const { enc, iv } = await encryptKey('sk-test', TOKEN);
  const keyRow = { key_enc: new Uint8Array(enc), iv: new Uint8Array(iv) };
  const settings = [...SETTINGS, ...extra];

  return {
    DB: {
      prepare: (sql: string) => {
        const statement = {
          bind: () => statement,
          all: async () => ({ results: sql.includes('FROM settings') ? settings : [] }),
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

  test('retries once with a doubled budget before giving up on a starved reply', async () => {
    // Measured on prod: deepseek-v4-pro ignores `enable_thinking: false`, spends all 1400
    // tokens on reasoning, and returns nothing. One retry with more room is the difference
    // between a failed memory job and a working one.
    const env = await configuredEnv();
    const budgets: number[] = [];
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      budgets.push((JSON.parse(String(init.body)) as { max_tokens: number }).max_tokens);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await expect(complete(env, { user: 'u', maxTokens: 2048 })).rejects.toThrow(
      /used all 4096 tokens without producing an answer/,
    );
    expect(budgets).toEqual([2048, 4096]);
  });

  test('a starved first attempt that then answers is a success, not an error', async () => {
    const env = await configuredEnv();
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      const content = call === 1 ? '' : '{"ok":true}';
      return new Response(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason: call === 1 ? 'length' : 'stop' }],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const result = await complete(env, { user: 'u', maxTokens: 1024, json: true });
    expect(result.text).toBe('{"ok":true}');
    expect(call).toBe(2);
  });

  test('an empty reply that stopped for another reason is not retried', async () => {
    // Only the length-capped shape is a reasoning model eating the budget. An empty reply
    // that stopped normally is a real failure, and retrying it just spends twice.
    const env = await configuredEnv();
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const result = await complete(env, { user: 'u', maxTokens: 1024 });
    expect(result.text).toBe('');
    expect(call).toBe(1);
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

  test('a budget-starved stream escalates and names the final budget', async () => {
    const env = await configuredEnv();
    await withFetch(
      () => streamedReply([], 'length'),
      async () => {
        await expect(
          streamCheap(env, { messages: [{ role: 'user', content: 'u' }], maxTokens: 512 }),
        // 512 -> 1024 -> 2048 -> 4096 (the default ceiling), and it names where it stopped.
        ).rejects.toThrow(/used all 4096 tokens without producing an answer/);
      },
    );
  });
});

describe('the side-channel output ceiling', () => {
  // The reader's question was "why not increase the max tokens … so we can use any model".
  // The transport used to cap escalation at 4096 with no control anywhere, so a call that
  // asked for 8,192 got 4,096 and a whole-card rewrite returned nothing.
  test('cheapMaxTokens raises what a call may actually ask for', async () => {
    const env = await configuredEnv([{ key: 'cheapMaxTokens', value: '65536' }]);
    await withFetch(
      () => bufferedReply('{"ok":true}', 'stop'),
      async (sent) => {
        await complete(env, { user: 'u', json: true, maxTokens: 8192 });
        // Asked for 8,192 and configured for 65,536: the request carries 8,192, not the
        // transport's old 4,096 floor.
        expect(sent[0].max_tokens).toBe(8192);
      },
    );
  });

  test('escalation climbs to the configured ceiling, not to 4096', async () => {
    const env = await configuredEnv([{ key: 'cheapMaxTokens', value: '16384' }]);
    const budgets: number[] = [];
    let call = 0;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      budgets.push((JSON.parse(String(init.body)) as { max_tokens: number }).max_tokens);
      call += 1;
      // First attempt starves, second answers: the point is what it was allowed to become.
      const content = call === 1 ? '' : '{"ok":true}';
      return new Response(
        JSON.stringify({
          choices: [{ message: { content }, finish_reason: call === 1 ? 'length' : 'stop' }],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await complete(env, { user: 'u', json: true, maxTokens: 4096 });
    expect(budgets).toEqual([4096, 8192]);
  });

  test('a configured ceiling below the request wins, unchanged behaviour without one', async () => {
    const env = await configuredEnv([{ key: 'cheapMaxTokens', value: '2048' }]);
    await withFetch(
      () => bufferedReply('{"ok":true}', 'stop'),
      async (sent) => {
        await complete(env, { user: 'u', json: true, maxTokens: 8192 });
        expect(sent[0].max_tokens).toBe(2048);
      },
    );
  });
});

describe('a caller-chosen model', () => {
  // The picker in the consultant modals sends `model`, and the choice must reach the request
  // body while the provider, key and knobs still come from the configured pair — a picker
  // that could name a provider with no key would be a 401 the reader cannot act on.
  test('overrides the side-channel model in the body', async () => {
    const env = await configuredEnv();
    await withFetch(
      () => bufferedReply('{"ok":true}', 'stop'),
      async (sent) => {
        await complete(env, { user: 'u', json: true, model: 'claude-fable-5' });
        expect(sent[0].model).toBe('claude-fable-5');
      },
    );
  });

  test('an absent model leaves the configured cheap pair alone', async () => {
    const env = await configuredEnv();
    await withFetch(
      () => bufferedReply('{"ok":true}', 'stop'),
      async (sent) => {
        await complete(env, { user: 'u', json: true });
        expect(sent[0].model).toBe('deepseek-v4-flash');
      },
    );
  });

  test('streamCheap carries it too', async () => {
    const env = await configuredEnv();
    await withFetch(
      () => streamedReply(['{"say":"hi"}'], 'stop'),
      async (sent) => {
        await streamCheap(env, {
          messages: [{ role: 'user', content: 'u' }],
          json: true,
          model: 'glm-5-3-flash',
        });
        expect(sent[0].model).toBe('glm-5-3-flash');
      },
    );
  });
});

describe('cheapContextBudget', () => {
  const filler = 'word '.repeat(50);

  test('drops the oldest conversation turns, keeping the instruction and the last message', async () => {
    const env = await configuredEnv([{ key: 'cheapContextBudget', value: '60' }]);
    const sent = await withFetch(
      () => bufferedReply('{"ok":true}', 'stop'),
      async (bodies) => {
        await streamCheap(env, {
          system: 'SYS',
          messages: [
            { role: 'user', content: `old1 ${filler}` },
            { role: 'assistant', content: `old2 ${filler}` },
            { role: 'user', content: `old3 ${filler}` },
            { role: 'user', content: 'newest question' },
          ],
        });
        return bodies;
      },
    );

    const messages = sent[0].messages as Array<{ role: string; content: string }>;
    expect(messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'newest question' },
    ]);
  });

  test('keeps a context block in preference to an old conversation turn', async () => {
    // The precedence that matters: the transcript is disposable, the scene is not. A guard
    // that dropped the character card while keeping four old questions would be the wrong
    // trade in exactly the case it exists for.
    const ctx = 'c '.repeat(40);
    const turn = 't '.repeat(40);
    const full =
      estimateTokens('SYS') + estimateTokens(ctx) + estimateTokens(turn) + estimateTokens('n');
    const env = await configuredEnv([
      { key: 'cheapContextBudget', value: String(full - estimateTokens(turn)) },
    ]);

    const sent = await withFetch(
      () => bufferedReply('{"ok":true}', 'stop'),
      async (bodies) => {
        await streamCheap(env, {
          system: 'SYS',
          messages: [
            { role: 'system', content: ctx },
            { role: 'user', content: turn },
            { role: 'user', content: 'n' },
          ],
        });
        return bodies;
      },
    );

    const messages = sent[0].messages as Array<{ role: string; content: string }>;
    expect(messages.map((message) => message.content)).toEqual(['SYS', ctx, 'n']);
  });

  test('sends an over-budget one-shot unsplit rather than dropping the instruction', async () => {
    // With only an instruction and a payload there is nothing disposable. Refusing to
    // answer is not better than answering a slightly large prompt, so it goes as-is.
    const env = await configuredEnv([{ key: 'cheapContextBudget', value: '10' }]);
    const sent = await withFetch(
      () => bufferedReply('{"ok":true}', 'stop'),
      async (bodies) => {
        await complete(env, { system: 'SYS', user: filler });
        return bodies;
      },
    );

    const messages = sent[0].messages as Array<{ role: string; content: string }>;
    expect(messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: filler },
    ]);
  });

  test('zero means no ceiling, not "drop everything"', async () => {
    // A falsy fallback would have turned this into a real cap, which is why the setting is
    // parsed without one.
    const env = await configuredEnv([{ key: 'cheapContextBudget', value: '0' }]);
    const sent = await withFetch(
      () => bufferedReply('{"ok":true}', 'stop'),
      async (bodies) => {
        await streamCheap(env, {
          system: 'SYS',
          messages: [
            { role: 'user', content: `a ${filler}` },
            { role: 'user', content: `b ${filler}` },
            { role: 'user', content: 'newest' },
          ],
        });
        return bodies;
      },
    );

    const messages = sent[0].messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(4);
  });

  test('a prompt inside the budget is left byte-identical', async () => {
    const env = await configuredEnv([{ key: 'cheapContextBudget', value: '100000' }]);
    const sent = await withFetch(
      () => bufferedReply('{"ok":true}', 'stop'),
      async (bodies) => {
        await streamCheap(env, {
          system: 'SYS',
          messages: [
            { role: 'user', content: 'one' },
            { role: 'assistant', content: 'two' },
            { role: 'user', content: 'three' },
          ],
        });
        return bodies;
      },
    );

    const messages = sent[0].messages as Array<{ role: string; content: string }>;
    expect(messages.map((message) => message.content)).toEqual(['SYS', 'one', 'two', 'three']);
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

describe('a reply clipped mid-document', () => {
  // Measured on the reader's own card: the repair wrote 16,384 tokens, was clipped halfway
  // through the card's JSON, and died there — "ran out of output budget before it finished".
  // `spentTheBudget` only matches EMPTY content, so a truncated reply never escalated and the
  // whole allowance had already been paid for nothing.
  test('escalates when nothing was streamed but the reply was truncated', async () => {
    const env = await configuredEnv([{ key: 'cheapMaxTokens', value: '65536' }]);
    const budgets: number[] = [];
    let call = 0;
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      budgets.push((JSON.parse(String(init.body)) as { max_tokens: number }).max_tokens);
      call += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"say":"starting","card":{"name":' }, finish_reason: 'length' }],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    // No `onDelta`, which is the "nothing reached the reader" case by definition.
    const result = await streamCheap(env, {
      messages: [{ role: 'user', content: 'u' }],
      json: true,
      maxTokens: 4096,
    });

    // It keeps climbing for as long as nothing reached the reader, up to the ceiling.
    expect(budgets).toEqual([4096, 8192, 16384, 32768, 65536]);
    expect(result.finishReason).toBe('length');
  });

  test('does NOT escalate once text has reached the reader', async () => {
    // Restarting a half-read answer is worse than a truncated one: the reader watches the same
    // words begin again. This is why the guard is on streamed output, not on content length.
    const env = await configuredEnv([{ key: 'cheapMaxTokens', value: '65536' }]);
    const budgets: number[] = [];
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      budgets.push((JSON.parse(String(init.body)) as { max_tokens: number }).max_tokens);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"say":"a long answer that was cut' }, finish_reason: 'length' }],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const seen: string[] = [];
    await streamCheap(
      env,
      { messages: [{ role: 'user', content: 'u' }], json: true, maxTokens: 4096 },
      (text) => seen.push(text),
    );

    expect(budgets).toEqual([4096]);
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe('climbing to the configured ceiling', () => {
  // Measured on prod after the ceiling became configurable: the call started at 4,096, emptied,
  // doubled to 8,192, emptied again, and then FAILED at 8,192 while the preset allowed 32,768.
  // The retry was gated on `attempt === 0`, so raising the setting did nothing past the first
  // doubling — the reader's exact complaint.
  test('keeps doubling until the ceiling is reached', async () => {
    const env = await configuredEnv([{ key: 'cheapMaxTokens', value: '32768' }]);
    const budgets: number[] = [];
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      budgets.push((JSON.parse(String(init.body)) as { max_tokens: number }).max_tokens);
      // Always starved: the point is how far it is allowed to climb, not that it succeeds.
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await complete(env, { user: 'u', json: true, maxTokens: 4096 }).catch(() => {});

    // 4096 -> 8192 -> 16384 -> 32768, then it stops at the ceiling instead of looping forever.
    expect(budgets).toEqual([4096, 8192, 16384, 32768]);
    // Nothing beyond the ceiling, however many attempts the refusal takes.
    expect(Math.max(...budgets)).toBe(32768);
  });

  test('still stops at the first retry when the ceiling is the old default', async () => {
    const env = await configuredEnv();
    const budgets: number[] = [];
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      budgets.push((JSON.parse(String(init.body)) as { max_tokens: number }).max_tokens);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await complete(env, { user: 'u', json: true, maxTokens: 2048 }).catch(() => {});
    expect(budgets).toEqual([2048, 4096]);
  });
});
