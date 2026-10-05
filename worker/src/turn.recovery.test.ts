import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import { exec, makeTestEnv } from './test/harness';
import { handleChat } from './chat';
import { loadPath } from './branch';
import { encryptKey } from '../../src/lib/crypto';

/**
 * Recovering a turn that was stopped before its reply arrived.
 *
 * The bug: the reader sends a message, presses Stop in the first second, and the chat is
 * then stuck. The reader's own row is the end of the visible path with nothing after it,
 * so "Continue" — an empty send — is refused by the server (`wrong_role`: the last message
 * is not one of mine to continue) and silently dropped by the client (its gate required
 * the tail to be an assistant row). Nothing in the UI says why. The only recovery was to
 * type a new message.
 *
 * The fix has two halves, and this test pins both at the seam that matters — the real
 * handler against the real migrations, driven exactly as the browser drives it:
 *
 *   1. the server treats a `continue` whose target is a USER row as "answer this message",
 *      reusing the row rather than writing a second copy of the reader's text;
 *   2. the resulting transcript is a normal one: greeting, the reader's line, the reply.
 *
 * The `wrong_role` assertion is the red-capable half — it fails against the old code with
 * the exact error the reader was hitting.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A D1 stub over a real in-memory schema, so the walk and the writes are the real ones. */
function makeEnv(): { env: Env; db: Database } {
  const { promise: keyPromise, resolve: resolveKey } = Promise.withResolvers<{
    key_enc: Uint8Array;
    iv: Uint8Array;
  }>();
  void encryptKey('sk-test', 'token').then(({ enc, iv }) =>
    resolveKey({ key_enc: new Uint8Array(enc), iv: new Uint8Array(iv) }),
  );

  const settings: Record<string, string> = {
    provider: 'openrouter',
    model: 'test/model',
    systemPrompt: 'You are a narrator.',
  };

  const { env, db } = makeTestEnv({
    extra: { ASSETS: { fetch: async () => new Response('') }, TESSERA_TOKEN: 'token' },
    stub: (sql) => {
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      if (trimmed.includes('FROM settings')) {
        return { row: null, rows: Object.entries(settings).map(([key, value]) => ({ key, value })) };
      }
      if (trimmed.includes('FROM provider_keys')) return { row: keyPromise };
      return undefined;
    },
  });

  const now = Date.now();
  exec(db,
    `INSERT INTO characters (id, name, avatar, card_json, source_format, tokens, created_at)
     VALUES ('char-1', 'Sydney', NULL, ?, 'ccv2', 10, ?)`,
    JSON.stringify({
      name: 'Sydney',
      description: 'A lecturer.',
      personality: 'Clipped.',
      scenario: 'A faculty hallway.',
      firstMes: 'You are late.',
      mesExample: '',
      systemPrompt: '',
      postHistoryInstructions: '',
      alternateGreetings: [],
      characterBook: null,
    }),
    now,
  );
  exec(db,
    `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                        session_id, created_at, updated_at)
     VALUES ('chat-1', 'char-1', NULL, 't', NULL, 0, 'session-1', ?, ?)`,
    now,
    now,
  );
  exec(db,
    `INSERT INTO messages (id, chat_id, parent_id, role, content, active, created_at)
     VALUES ('greet', 'chat-1', NULL, 'assistant', 'You are late.', 1, ?)`,
    now,
  );
  exec(db,
    `INSERT INTO messages (id, chat_id, parent_id, role, content, active, created_at)
     VALUES ('u1', 'chat-1', 'greet', 'user', 'Hi.', 1, ?)`,
    now,
  );

  return { env, db };
}

/** An upstream that streams a short reply, so a turn completes normally. */
function upstream(text: string): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }
        sent = true;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`),
        );
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
}

/**
 * An upstream that emits one delta and then goes quiet forever.
 *
 * This is the case the whole Stop fix is about: the provider is not slow, it is SILENT, so
 * nothing throws and the per-frame abort check never runs. Only a signal wired into the
 * request itself can cut it off.
 *
 * Runtime note: on Workers `fetch(url, { signal })` tears the response body down when the
 * signal aborts. Bun's `AbortSignal` does not reach an in-process Response that way, so the
 * stub does what the runtime does — cancels its own stream on abort — and the test then
 * pins the thing under test: that `runTurn` actually WIRES the signal into the fetch.
 * Without Step 2 the signal never reaches here, the stub never cancels, and the read hangs.
 */
function stalledUpstream(text: string, signal?: AbortSignal): typeof fetch {
  return (async () => {
    if (!signal) throw new Error('runTurn did not pass the client signal to fetch');
    const encoder = new TextEncoder();
    let sent = false;
    let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`),
          );
          return;
        }
        return new Promise<void>(() => {});
      },
    });
    signal.addEventListener('abort', () => {
      try {
        stream?.close();
      } catch {
        // already closed
      }
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
}

/** An upstream that dies before any content arrives: the dropped-connection case. */
function brokenUpstream(): typeof fetch {
  return (async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('connection reset'));
        return new Promise<void>(() => {});
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
}

/** Reads frames until the first `delta` arrives, so an abort can land mid-stream. */
async function firstDelta(res: Response): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; text: string }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error(`stream ended before any delta: ${buffer}`);
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      if (!part.startsWith('data:')) continue;
      const frame = JSON.parse(part.slice(5)) as { type: string; text?: string };
      if (frame.type === 'delta') return { reader, text: frame.text ?? '' };
    }
  }
}

/** Drains the rest of a stream, discarding frames. */
async function drainFrom(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

function ctx(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

function turnRequest(body: Record<string, unknown>, signal?: AbortSignal): Request {
  return new Request('https://tessera.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: 'chat-1', ...body }),
    signal,
  });
}

/** Every frame the Worker emitted, so a test can assert on the error code. */
async function drain(res: Response): Promise<Array<Record<string, unknown>>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Array<Record<string, unknown>> = [];
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      if (part.startsWith('data:')) frames.push(JSON.parse(part.slice(5)) as Record<string, unknown>);
    }
  }
  return frames;
}

describe('recovering a turn stopped before its reply', () => {
  test('an empty continue answers the reader’s own row instead of refusing', async () => {
    const { env, db } = makeEnv();
    globalThis.fetch = upstream('"Fast forward," she says.');

    // The state the bug leaves behind: the reader's row is the tail, with nothing after it.
    const res = await handleChat(turnRequest({ content: '', mode: 'continue', targetId: 'u1' }), env, ctx());
    const frames = await drain(res);

    const error = frames.find((frame) => frame.type === 'error');
    expect(error).toBeUndefined();

    // The reply exists, and it answers the reader's message rather than the greeting.
    const reply = db
      .query("SELECT parent_id, role FROM messages WHERE role = 'assistant' AND id != 'greet'")
      .get() as { parent_id: string; role: string } | null;
    expect(reply).not.toBeNull();
    expect(reply!.parent_id).toBe('u1');

    // And the reader's text was not written twice.
    const users = db.query("SELECT COUNT(*) AS n FROM messages WHERE role = 'user'").get() as { n: number };
    expect(users.n).toBe(1);

    // The visible transcript is greeting, reader, reply — in that order.
    const path = await loadPath(env, 'chat-1');
    expect(path.map((row) => row.role)).toEqual(['assistant', 'user', 'assistant']);
  });

  test('the old refusal is what a continue on a user row used to produce', async () => {
    // The red-capable half: this is the exact error the reader hit. `regenerate` on a user
    // row must still be refused — only `continue` recovers a stopped turn, because only
    // `continue` means "carry on from here".
    const { env } = makeEnv();
    globalThis.fetch = upstream('should not be called');

    const res = await handleChat(turnRequest({ content: '', mode: 'regenerate', targetId: 'u1' }), env, ctx());
    const frames = await drain(res);
    const error = frames.find((frame) => frame.type === 'error') as { code?: string } | undefined;

    expect(error?.code).toBe('wrong_role');
  });

  test('a normal send still answers the reader’s new message', async () => {
    // The regression guard for the ordinary path: the recovery branch must not capture it.
    const { env, db } = makeEnv();
    globalThis.fetch = upstream('A reply.');

    const res = await handleChat(turnRequest({ content: 'Hello again.', mode: 'send' }), env, ctx());
    await drain(res);

    const users = db
      .query("SELECT content FROM messages WHERE role = 'user' ORDER BY seq")
      .all() as Array<{ content: string }>;
    expect(users.map((row) => row.content)).toEqual(['Hi.', 'Hello again.']);

    const path = await loadPath(env, 'chat-1');
    expect(path.map((row) => row.role)).toEqual(['assistant', 'user', 'user', 'assistant']);
  });
});

describe('a turn that never delivers a reply', () => {
  test('Stop keeps the reader’s line and writes no reply', async () => {
    // The reported bug: the reader sends `Test`, presses Stop while the "…" placeholder is
    // up, and their own message disappears from the transcript. It disappeared because the
    // row was only ever written on the success path — so a stopped turn had nothing stored
    // to refetch, and the scene fell back to the previous assistant message.
    const { env, db } = makeEnv();
    // The stub receives `init.signal` from `runTurn`'s fetch — which is the contract under
    // test — and closes its own stream when it aborts, the way the Workers runtime tears a
    // fetch body down. `stalledUpstream` throws if no signal arrived at all.
    globalThis.fetch = ((url: string, init?: RequestInit) =>
      stalledUpstream('"Partway through," she says.', init?.signal ?? undefined)(
        url,
        init,
      )) as unknown as typeof fetch;

    const controller = new AbortController();
    const res = await handleChat(
      turnRequest({ content: 'Test', mode: 'send' }, controller.signal),
      env,
      ctx(),
    );

    // Mid-stream, exactly where Stop lands: one delta has arrived, the provider has gone
    // quiet, and the abort is the only thing that can end it.
    const { reader, text } = await firstDelta(res);
    expect(text).toBe('"Partway through," she says.');
    controller.abort();
    await drainFrom(reader);

    // The reader's own line outlived the turn.
    const mine = db
      .query("SELECT id FROM messages WHERE role = 'user' AND content = 'Test'")
      .get() as { id: string } | null;
    expect(mine).not.toBeNull();

    // And no reply was written: the partial text the server had already streamed is
    // discarded, because Stop means "I withdraw this".
    const replies = db
      .query("SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND id != 'greet'")
      .get() as { n: number };
    expect(replies.n).toBe(0);

    // The visible path is greeting, the reader's line, and nothing after it — which is the
    // state a recovery `continue` answers.
    const path = await loadPath(env, 'chat-1');
    expect(path.map((row) => row.role)).toEqual(['assistant', 'user', 'user']);
    expect(path[path.length - 1].content).toBe('Test');
  });

  test('a dropped connection keeps the reader’s line and leaves no half-reply', async () => {
    // The second report: the connection dies mid-reply and a long message goes with it.
    // No abort here — the upstream itself errors before any content, which is the shape a
    // network drop takes by the time it reaches `pipeStream`.
    const { env, db } = makeEnv();
    globalThis.fetch = brokenUpstream();

    const res = await handleChat(
      turnRequest({ content: 'A long message I do not want to retype.', mode: 'send' }),
      env,
      ctx(),
    );
    await drain(res);

    const mine = db
      .query("SELECT id FROM messages WHERE role = 'user' AND content = 'A long message I do not want to retype.'")
      .get() as { id: string } | null;
    expect(mine).not.toBeNull();

    // An empty partial is dropped rather than persisted as an empty reply.
    const replies = db
      .query("SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND id != 'greet'")
      .get() as { n: number };
    expect(replies.n).toBe(0);

    const path = await loadPath(env, 'chat-1');
    expect(path.map((row) => row.role)).toEqual(['assistant', 'user', 'user']);
  });
});
