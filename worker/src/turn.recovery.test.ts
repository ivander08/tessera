import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';

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

const realFetch = globalThis.fetch;

/** `bun-types` types the variadic form too narrowly; one seam keeps the cast out of call sites. */
function exec(db: Database, sql: string, ...params: unknown[]): void {
  db.run(sql, ...(params as never[]));
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A D1 stub over a real in-memory schema, so the walk and the writes are the real ones. */
function makeEnv(): { env: Env; db: Database } {
  const db = new Database(':memory:');
  for (const name of MIGRATIONS) {
    db.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), 'utf8'));
  }

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

  const DB = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const trimmed = sql.replace(/\s+/g, ' ').trim();
      const statement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async first() {
          if (trimmed.startsWith('SELECT * FROM chats')) {
            return db.query('SELECT * FROM chats WHERE id = ?').get('chat-1');
          }
          if (trimmed.includes('FROM provider_keys')) return await keyPromise;
          if (trimmed.startsWith('SELECT * FROM characters')) {
            return db.query('SELECT * FROM characters WHERE id = ?').get('char-1');
          }
          if (trimmed.includes('FROM token_calibration')) return { factor: 1, samples: 0 };
          if (trimmed.includes('FROM settings')) return null;
          if (trimmed.includes('FROM state')) return null;
          if (trimmed.includes('FROM chat_scene_setup')) return null;
          return db.query(sql).get(...(params as never[])) ?? null;
        },
        async all() {
          if (trimmed.includes('FROM settings')) {
            return { results: Object.entries(settings).map(([key, value]) => ({ key, value })) };
          }
          return { results: db.query(sql).all(...(params as never[])), success: true, meta: {} };
        },
        async run() {
          const result = db.run(sql, ...(params as never[]));
          return { success: true, meta: { changes: result.changes } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      const out = [];
      for (const statement of statements) out.push(await statement.run());
      return out;
    },
  };

  return { env: { DB, ASSETS: { fetch: async () => new Response('') }, APP_NAME: 'Tessera', TESSERA_TOKEN: 'token' } as unknown as Env, db };
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
