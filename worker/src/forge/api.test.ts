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
  /**
   * Stubs the provider with a chunked SSE reply, so the scanner has to reassemble the
   * document rather than being handed it whole. Shared by the tests below because the
   * framing is the same and only the reply differs.
   */
  function stubReply(reply: string): () => void {
    const original = globalThis.fetch;
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
    return () => {
      globalThis.fetch = original;
    };
  }

  const phasesOf = (frames: Array<Record<string, unknown>>): string[] =>
    frames.filter((frame) => frame.type === 'phase').map((f) => asString(f.phase));

  test('emits the say field as deltas, then one terminal turn frame', async () => {
    const env = await configuredEnv();
    const reply = JSON.stringify({
      say: 'Tell me about the character.',
      question: { text: 'Who are they?', options: ['A detective', 'A smuggler'], recommended: 0 },
      card: null,
    });

    const restore = stubReply(reply);
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
      restore();
    }
  });

  test('reports the phase so a card still being written does not read as finished', async () => {
    // The reported bug: the prose lands in seconds, the card in the same reply can take
    // twenty more, and the pane looked done the whole time. The phase is the only signal
    // the client has for that second half.
    const env = await configuredEnv();
    const reply = JSON.stringify({
      say: 'Here is the card.',
      question: null,
      card: { name: 'Ada', first_mes: 'The door is open.' },
    });

    const restore = stubReply(reply);
    try {
      const res = await forgeConsult(
        env,
        post({ mode: 'draft', messages: [{ role: 'user', content: 'a cartographer' }] }),
      );
      const frames = await framesOf(res);

      // `say` is the implicit start and is never sent; the two later keys are announced once
      // each, in the order they appear in the reply.
      expect(phasesOf(frames)).toEqual(['card']);
      // A phase is progress, not content: it must never be mistaken for text to render.
      expect(frames.filter((frame) => frame.type === 'delta').every((f) => asString(f.text).length > 0)).toBe(true);
    } finally {
      restore();
    }
  });

  test('a say that mentions a card does not fake a phase', async () => {
    // The scanner reads the raw half-written document, so the one thing it must not do is
    // match a key the model only *talked* about. A quote inside a JSON string is escaped,
    // which is what makes the naive-looking regex safe — this is the test that pins it.
    const env = await configuredEnv();
    const reply = JSON.stringify({
      say: 'I would set "card": {"name": "Ada"} if I were proposing one, but I am not.',
      question: { text: 'Shall I?', options: ['Yes', 'No'], recommended: 0 },
      card: null,
    });

    const restore = stubReply(reply);
    try {
      const res = await forgeConsult(
        env,
        post({ mode: 'draft', messages: [{ role: 'user', content: 'a cartographer' }] }),
      );
      const frames = await framesOf(res);

      // The question is announced; the card the model merely described is not.
      expect(phasesOf(frames)).toEqual(['question']);
    } finally {
      restore();
    }
  });

  // The reported bug end to end: the reply was cut off mid-card, the terminal turn carried
  // `card: null`, and the user got no diff, no Apply button and no error — while the model's
  // own prose said it had shipped the change. A card that cannot be read is now a named
  // failure, and it reaches the client as an error frame.
  test('a reply cut off mid-card is an error frame, not a silent card-less turn', async () => {
    const env = await configuredEnv();
    const reply =
      '{"say":"Here it is: the whole card back.","question":null,"card":{"name":"Ada","description":"A cartographer';

    const restore = stubReply(reply);
    try {
      const res = await forgeConsult(
        env,
        post({ mode: 'consult', messages: [{ role: 'user', content: 'add a line' }], card: CARD }),
      );
      const frames = await framesOf(res);
      const terminal = frames[frames.length - 1];

      // The card phase still fires — the model did start writing one. What must not happen is
      // the stream ending on a `turn` whose card is null.
      expect(phasesOf(frames)).toEqual(['card']);
      expect(terminal.type).toBe('error');
      expect(asString(terminal.message)).toContain('writing the card');
    } finally {
      restore();
    }
  });

  test('an envelope wrapped in a sentence still delivers its card', async () => {
    // The other half of the same report: a leading sentence or a trailing sign-off is a
    // formatting habit, and the card inside must not be thrown away with it.
    const env = await configuredEnv();
    const reply =
      'Sure — here it is:\n{"say":"Added it.","question":null,"card":{"name":"Ada","first_mes":"One."}}\n\nLet me know.';

    const restore = stubReply(reply);
    try {
      const res = await forgeConsult(
        env,
        post({ mode: 'consult', messages: [{ role: 'user', content: 'add a line' }], card: CARD }),
      );
      const frames = await framesOf(res);
      const terminal = frames[frames.length - 1];

      expect(terminal.type).toBe('turn');
      const turn = asRecord(terminal.turn);
      expect(asRecord(turn?.card)?.name).toBe('Ada');
    } finally {
      restore();
    }
  });
});
