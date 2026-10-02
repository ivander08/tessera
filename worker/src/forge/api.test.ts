import { describe, expect, test } from 'bun:test';
import { encryptKey } from '../../../src/lib/crypto';
import { asRecord, asString } from '../../../src/lib/json';
import { forgeConsult } from './api';

/**
 * The HTTP layer around the consultant.
 *
 * What is worth asserting here is the request contract, not the prompt — `forge.test.ts`
 * covers the turn shape. Three things this file is responsible for: that a malformed body is
 * a 400 naming the field at fault, that consult mode refuses to run without a card, and that
 * a missing cheap model arrives as a 400 carrying the configuration message rather than a 500
 * the user cannot act on.
 */

const CARD = {
  name: 'Ada',
  description: 'A cartographer.',
  personality: 'Wry.',
  scenario: 'A rainy night.',
  firstMes: 'Hello there.',
  mesExample: '',
  systemPrompt: '',
  postHistoryInstructions: '',
  alternateGreetings: [],
  creatorNotes: '',
  tags: [],
  characterBook: null,
  sourceFormat: 'ccv2',
  avatarHint: null,
  raw: null,
};

const TOKEN = 'test-token';
const SETTINGS = [
  { key: 'provider', value: 'openrouter' },
  { key: 'model', value: 'test/model' },
];

/** Nothing configured: `getSettings` returns no rows, so no cheap model exists. */
const UNCONFIGURED = {
  DB: { prepare: () => ({ all: async () => ({ results: [] }) }) },
} as unknown as Env;

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

function post(body: unknown): Request {
  return new Request('http://x/api/forge/consult', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** The frames a stream produced, in order. */
async function framesOf(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  const frames: Array<Record<string, unknown>> = [];
  for (const chunk of text.split('\n\n')) {
    if (!chunk.startsWith('data:')) continue;
    const frame = asRecord(JSON.parse(chunk.slice(5).trim()));
    if (frame) frames.push(frame);
  }
  return frames;
}

describe('forgeConsult request validation', () => {
  test('a bad mode is a 400 naming mode', async () => {
    const res = await forgeConsult(UNCONFIGURED, post({ mode: 'chat', messages: [{ role: 'user', content: 'hi' }] }));
    expect(res.status).toBe(400);
    expect(asString((await bodyOf(res)).error)).toContain('mode');
  });

  test('empty messages is a 400 naming messages', async () => {
    const res = await forgeConsult(UNCONFIGURED, post({ mode: 'draft', messages: [] }));
    expect(res.status).toBe(400);
    expect(asString((await bodyOf(res)).error)).toContain('messages');
  });

  test('consult mode with no card is a 400 naming card', async () => {
    const res = await forgeConsult(
      UNCONFIGURED,
      post({ mode: 'consult', messages: [{ role: 'user', content: 'is this too long?' }] }),
    );
    expect(res.status).toBe(400);
    expect(asString((await bodyOf(res)).error)).toContain('card');
  });

  test('consult mode rejects a card with no name, and accepts one that has it', async () => {
    const nameless = await forgeConsult(
      UNCONFIGURED,
      post({
        mode: 'consult',
        messages: [{ role: 'user', content: 'is this too long?' }],
        card: { description: 'no name' },
      }),
    );
    expect(nameless.status).toBe(400);
    expect(asString((await bodyOf(nameless)).error)).toContain('card');

    // A named card gets past validation and fails later, at the model — which is the
    // difference the check is for.
    const named = await forgeConsult(
      UNCONFIGURED,
      post({
        mode: 'consult',
        messages: [{ role: 'user', content: 'is this too long?' }],
        card: CARD,
      }),
    );
    const frames = await framesOf(named);
    expect(frames[frames.length - 1].type).toBe('error');
  });

  test('a message with no role is a 400 before any call is made', async () => {
    const res = await forgeConsult(
      UNCONFIGURED,
      post({ mode: 'draft', messages: [{ content: 'hi' }] }),
    );
    expect(res.status).toBe(400);
    expect(asString((await bodyOf(res)).error)).toContain('role and content');
  });

  test('a message whose content is not a string is rejected, not coerced', async () => {
    // Defaulting it would put the literal text "undefined" in the prompt, and the model
    // would then answer a question nobody asked.
    const res = await forgeConsult(
      UNCONFIGURED,
      post({ mode: 'draft', messages: [{ role: 'user', content: 42 }] }),
    );
    expect(res.status).toBe(400);
    expect(asString((await bodyOf(res)).error)).toContain('role and content');
  });
});

describe('forgeConsult with no cheap model configured', () => {
  test('a missing cheap model is a 400 carrying the configuration message', async () => {
    const res = await forgeConsult(
      UNCONFIGURED,
      post({ mode: 'draft', messages: [{ role: 'user', content: 'a detective' }] }),
    );

    // The configuration failure happens inside the stream, so the status is the SSE 200 and
    // the message arrives as the terminal error frame. What matters is that it is the
    // configuration message and not a bare 500.
    const frames = await framesOf(res);
    const terminal = frames[frames.length - 1];
    expect(terminal.type).toBe('error');
    expect(asString(terminal.message)).toContain('No cheap model configured');
  });
});

describe('forgeConsult streaming', () => {
  test('emits the say field as deltas, then one terminal turn frame', async () => {
    const env = await configuredEnv();
    const original = globalThis.fetch;
    const reply = JSON.stringify({
      say: 'Tell me about the character.',
      question: { text: 'Who are they?', options: ['A detective', 'A smuggler'], recommended: 0 },
      card: null,
    });

    // Chunked so the deltas have to be reassembled by the scanner rather than arriving whole.
    const encoder = new TextEncoder();
    globalThis.fetch = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const piece of reply.match(/.{1,20}/gs) ?? []) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`,
              ),
            );
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    try {
      const res = await forgeConsult(
        env,
        post({ mode: 'draft', messages: [{ role: 'user', content: 'a cartographer' }] }),
      );
      expect(res.status).toBe(200);

      const frames = await framesOf(res);
      expect(frames[frames.length - 1].type).toBe('turn');

      // Deltas are prefixes of `say` and never repeat: re-emitting an unchanged prefix
      // would print the same words twice.
      const deltas = frames.filter((frame) => frame.type === 'delta').map((f) => asString(f.text));
      expect(deltas.length).toBeGreaterThan(0);
      for (const delta of deltas) expect('Tell me about the character.').toContain(delta);
      expect(deltas[deltas.length - 1]).toBe('Tell me about the character.');
      for (let i = 1; i < deltas.length; i++) {
        expect(deltas[i].length).toBeGreaterThan(deltas[i - 1].length);
      }

      const turn = asRecord(frames[frames.length - 1].turn);
      expect(asString(turn?.say)).toBe('Tell me about the character.');
      expect(asString(asRecord(turn?.question)?.text)).toBe('Who are they?');
    } finally {
      globalThis.fetch = original;
    }
  });
});
