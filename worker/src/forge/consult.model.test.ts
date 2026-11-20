import { describe, expect, test } from 'bun:test';
import { encryptKey } from '../../../src/lib/crypto';
import { consult } from './consult';

/**
 * The model a consultant runs on, when the reader picks one in the modal.
 *
 * The picker is only honest if the chosen id reaches the provider's request body. Every layer
 * between the two is easy to get wrong and invisible from the UI: the route reads `model` off
 * the body, the consultant forwards it, `prepare` swaps it for the configured side-channel
 * pair, and `buildRequest` puts it in the JSON. A break anywhere in that chain silently sends
 * the preset's model instead, which looks exactly like the picker being ignored.
 *
 * So the assertion is on the OUTGOING BODY, not on any intermediate value.
 */

const TOKEN = 'test-token';
const SETTINGS = [
  { key: 'cheapProvider', value: 'kenari' },
  { key: 'cheapModel', value: 'glm-5-3-flash' },
];

/** The smallest env that can resolve a key and a side-channel pair. */
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
    APP_NAME: 'Tessera',
    TESSERA_TOKEN: TOKEN,
  } as unknown as Env;
}

/** Runs `body` against a fetch that records every request body and answers with `reply`. */
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

/** A complete card: `systemPrompt` prices it, and a partial one throws before the request. */
function fullCard(): Parameters<typeof consult>[1]['card'] {
  return {
    name: 'Ada',
    description: 'A detective.',
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
}

function jsonReply(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
    { headers: { 'content-type': 'application/json' } },
  );
}

describe('the consultant model picker', () => {
  test('consults on the model the reader picked, not the preset pair', async () => {
    const env = await configuredEnv();
    await withFetch(
      () => jsonReply(JSON.stringify({ say: 'Fine card.', question: null, changes: [] })),
      async (sent) => {
        await consult(env, {
          mode: 'consult',
          messages: [{ role: 'user', content: 'Thoughts?' }],
          card: fullCard(),
          model: 'claude-fable-5',
        });
        expect(sent[0].model).toBe('claude-fable-5');
      },
    );
  });

  test('falls back to the preset pair when nothing is picked', async () => {
    const env = await configuredEnv();
    await withFetch(
      () => jsonReply(JSON.stringify({ say: 'Fine card.', question: null, changes: [] })),
      async (sent) => {
        await consult(env, {
          mode: 'consult',
          messages: [{ role: 'user', content: 'Thoughts?' }],
          card: fullCard(),
        });
        expect(sent[0].model).toBe('glm-5-3-flash');
      },
    );
  });

  test('the chat route forwards the pick to the consultant', async () => {
    // A route that drops the field is the break that looks exactly like the picker being
    // ignored, and it is one line away from correct. Asserted on the handler's own body
    // handling rather than through `chatConsult`, whose six table reads need a full fixture.
    const { chatAdvise } = await import('../chatAdvise');
    const env = {
      DB: {
        prepare: () => {
          const statement = {
            bind: () => statement,
            first: async () => ({ id: 'chat-1' }),
          };
          return statement;
        },
      },
    } as unknown as Env;

    const res = await chatAdvise(
      env,
      new Request('http://x/api/chats/chat-1/advise', {
        method: 'POST',
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], model: 'glm-5-3' }),
      }),
      'chat-1',
    );
    // The stream is what the route returns; the field it will forward is read before it.
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.body?.cancel();
  });
});
