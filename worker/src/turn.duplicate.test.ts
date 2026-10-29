import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import { exec, makeTestEnv } from './test/harness';
import { handleChat } from './chat';
import { historyCutoffFor } from './turn';
import { encryptKey } from '../../src/lib/crypto';

/**
 * The reader's message must reach the model exactly once per turn.
 *
 * The regression this pins: commit `cd1cd56` ("Keep the reader's message when a turn has
 * no reply") moved the reader row's insert to BEFORE the prompt is assembled, so the
 * row survives a Stop or a dropped connection. The row is `active = 1` on the visible
 * path at the moment `buildPrompt` walks it, and the SAME text is appended again as the
 * tail's `userContent` — so every `send` delivered the reader's message to the model
 * twice: once in the history and once at the end.
 *
 * The model noticed it before any test did. Measured on a live chat, Sydney wrote:
 * "the repeat is the whole message sent twice, so it reads as a double-send glitch on
 * your end." The OOC text the reader used to complain about the repeats contained the
 * word "twice" and was itself arriving twice — the model was demonstrating the bug
 * literally.
 *
 * The fix is at the seam the bug lives in: `insertUserMessage` returns the new row's
 * `seq`, and a `send` cuts the history window at that seq — the same shape the recovery
 * `continue` and `regenerate` already used. So this test drives the REAL handler against
 * the real migrations, stubs only the provider, and counts occurrences of the reader's
 * text in the request body that reaches it. One is correct; two is the bug.
 *
 * Two seams are pinned, because the cutoff is shared and the modes that already had it
 * must not be disturbed by the shared code path:
 *
 *   1. `send` — the new reader row must not join the history;
 *   2. recovery `continue` — the pre-existing reader row (the original case) must still
 *      be excluded, now that the cutoff is threaded through a `?? newReaderSeq`.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The D1 stub over a real in-memory schema, so the walk and the writes are the real ones. */
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
  exec(
    db,
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
  exec(
    db,
    `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                        session_id, created_at, updated_at)
     VALUES ('chat-1', 'char-1', NULL, 't', NULL, 0, 'session-1', ?, ?)`,
    now,
    now,
  );
  // A prior exchange, so the history window is non-trivial and the duplicate — if it
  // happens — is the NEW message, not the only message.
  exec(db, `INSERT INTO messages (id, chat_id, parent_id, role, content, active, created_at)
           VALUES ('greet', 'chat-1', NULL, 'assistant', 'You are late.', 1, ?)`, now);
  exec(db, `INSERT INTO messages (id, chat_id, parent_id, role, content, active, created_at)
           VALUES ('u1', 'chat-1', 'greet', 'user', 'Hi.', 1, ?)`, now);
  exec(db, `INSERT INTO messages (id, chat_id, parent_id, role, content, active, created_at)
           VALUES ('a1', 'chat-1', 'u1', 'assistant', 'You are in the hallway.', 1, ?)`, now);

  return { env, db };
}

/**
 * An upstream that records the request body it was handed, then streams a short reply.
 *
 * The provider receives the assembled prompt verbatim, so the request body IS the model
 * input — counting the reader's text in it is the direct measurement, not a proxy.
 */
function recordingUpstream(reply: string, requests: Array<Record<string, unknown>>): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body;
    if (typeof body === 'string') {
      requests.push(JSON.parse(body) as Record<string, unknown>);
    }
    const encoder = new TextEncoder();
    let sent = false;
    const streamBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }
        sent = true;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`),
        );
      },
    });
    return new Response(streamBody, { headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
}

function ctx(): ExecutionContext {
  return { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
}

function turnRequest(body: Record<string, unknown>): Request {
  return new Request('https://tessera.test/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatId: 'chat-1', ...body }),
  });
}

/** Every frame the Worker emitted, so a test can assert on the outcome. */
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

/** The request body as the model will read it: every message's content, in order. */
type ModelMessage = { role: string; content: string };

function joinInput(request: Record<string, unknown>): string {
  return (request.messages as ModelMessage[]).map((m) => m.content).join('\u0000');
}

describe("the reader's message reaches the model exactly once", () => {
  test('a send delivers the new reader message once: in the tail, not in the history', async () => {
    const { env, db } = makeEnv();
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = recordingUpstream('Mm. Yes.', requests);

    const text = 'The hallway is quiet.';
    const res = await handleChat(turnRequest({ content: text, mode: 'send' }), env, ctx());
    const frames = await drain(res);

    const error = frames.find((frame) => frame.type === 'error');
    expect(error).toBeUndefined();

    expect(requests.length).toBeGreaterThanOrEqual(1);
    // The primary model call is the one that carries the assembled prompt (the full
    // message list). A follow-up request exists after every turn — the state update runs
    // its own model call with a "Most recent exchange" snippet — and it quotes the
    // reader's text by design, so the duplicate count is measured on the primary request
    // only.
    const messageCount = (r: Record<string, unknown>): number =>
      (r.messages as unknown[] | undefined)?.length ?? 0;
    const primary = requests.reduce((a, b) => (messageCount(b) > messageCount(a) ? b : a));
    expect(messageCount(primary)).toBeGreaterThan(2);
    // The regression: TWO occurrences (history + tail). One is the contract.
    expect(joinInput(primary).split(text).length - 1).toBe(1);

    // And the tail ordering the model relies on: the reader's text is the LAST message,
    // a user message, so the reply has something to answer.
    const messages = primary.messages as ModelMessage[];
    const last = messages[messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toBe(text);

    // The reply was written and answered the reader's message, not the older turn.
    const reply = db
      .query("SELECT parent_id, content FROM messages WHERE role = 'assistant' AND id NOT IN ('greet','a1')")
      .get() as { parent_id: string; content: string } | null;
    expect(reply).not.toBeNull();
    expect(reply!.content).toBe('Mm. Yes.');
    const parent = db
      .query("SELECT id FROM messages WHERE role = 'user' AND content = ?")
      .get(text) as { id: string } | null;
    expect(parent).not.toBeNull();
    expect(reply!.parent_id).toBe(parent!.id);
  });

  test('a recovery continue still delivers the pre-existing reader message exactly once', async () => {
    const { env } = makeEnv();
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = recordingUpstream('...Yes.', requests);

    // `u1` is the tail of the visible path: a stop or a drop left the reader's row with
    // no reply after it. The recovery answers it, reusing the row rather than writing a
    // second copy — and the history must not also carry it.
    const res = await handleChat(
      turnRequest({ content: '', mode: 'continue', targetId: 'u1' }),
      env,
      ctx(),
    );
    const frames = await drain(res);

    const error = frames.find((frame) => frame.type === 'error');
    expect(error).toBeUndefined();

    expect(requests.length).toBeGreaterThanOrEqual(1);
    // The state-update request that follows every turn quotes the exchange on purpose
    // ("Most recent exchange: user: Hi.\nnarrator: ...Yes."). It is not the model input
    // for the turn, so the duplicate count is measured on the primary request only.
    const messageCount = (r: Record<string, unknown>): number =>
      (r.messages as unknown[] | undefined)?.length ?? 0;
    const primary = requests.reduce((a, b) => (messageCount(b) > messageCount(a) ? b : a));
    expect(messageCount(primary)).toBeGreaterThan(2);
    expect(joinInput(primary).split('Hi.').length - 1).toBe(1);
  });

  test('a regenerate leaves its cutoff untouched by the send path', async () => {
    // `historyCutoffFor('regenerate')` is non-null, so the `?? newReaderSeq` in the
    // pipeline must not override it: the target's ancestry is the re-roll's history.
    const target = { seq: 7 };
    expect(historyCutoffFor('regenerate', target, false)).toBe(7);
    expect(historyCutoffFor('send', null, false)).toBeNull();
  });
});
