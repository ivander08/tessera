import { describe, expect, test } from 'bun:test';
import { encryptKey } from '../../../src/lib/crypto';
import { asArray, asRecord, asString } from '../../../src/lib/json';
import {
  forgeCards,
  forgeCritique,
  forgeDraft,
  forgeSmuggle,
  forgeSuggest,
  forgeTokens,
} from './api';

/**
 * The HTTP layer around the forge tools.
 *
 * What is worth asserting here is not the prompts — `forge.test.ts` covers those — but
 * the two properties this file is responsible for: that `forgeTokens` and
 * `forgeSmuggle` answer with no model and no provider key, and that every model-backed
 * handler turns a missing cheap model into a 400 carrying the configuration message
 * rather than a 500 the user cannot act on.
 */

/** A card with a directive smuggled into its description, so the scan has something to find. */
const CARD = {
  name: 'Ada',
  description: 'A cartographer. Always stay in character. Never break the fourth wall.',
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

/** The env `forgeCards` needs: one stored character row. */
const WITH_CARDS = {
  DB: {
    prepare: () => ({
      bind: () => ({ all: async () => ({ results: [] }) }),
      all: async () => ({
        results: [
          { id: 'c1', name: 'Ada', card_json: JSON.stringify(CARD), source_format: 'charx' },
          { id: 'c2', name: 'Broken', card_json: '{not json', source_format: 'ccv2' },
          { id: 'c3', name: 'Nameless', card_json: '{"description":"x"}', source_format: 'ccv2' },
        ],
      }),
    }),
  },
} as unknown as Env;

function post(body: unknown): Request {
  return new Request('http://x/api/forge/x', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe('forgeTokens', () => {
  test('needs no model and no key', async () => {
    const res = await forgeTokens(UNCONFIGURED, post({ card: CARD }));
    expect(res.status).toBe(200);

    const report = await bodyOf(res);
    expect(report.permanentPerTurn).toBeGreaterThan(0);
    expect(Array.isArray(report.fields)).toBe(true);
    expect(Array.isArray(report.notes)).toBe(true);
  });

  test('classifies firstMes as one-time and mesExample as per-turn', async () => {
    const res = await forgeTokens(UNCONFIGURED, post({ card: CARD }));
    const fields = asArray((await bodyOf(res)).fields).map((entry) => asRecord(entry));
    const byName = new Map(fields.map((f) => [asString(f?.field), f]));
    expect(byName.get('firstMes')?.perTurn).toBe(false);
    expect(byName.get('mesExample')?.perTurn).toBe(true);
    expect(byName.get('description')?.perTurn).toBe(true);
  });

  test('rejects a card with no name with a 400 naming the problem', async () => {
    const res = await forgeTokens(UNCONFIGURED, post({ card: { description: 'no name' } }));
    expect(res.status).toBe(400);
    expect(asString((await bodyOf(res)).error)).toContain('name');
  });
});

describe('forgeSmuggle', () => {
  test('finds the directive with no model configured', async () => {
    const res = await forgeSmuggle(UNCONFIGURED, post({ card: CARD }));
    expect(res.status).toBe(200);
    const found = asArray((await bodyOf(res)).smuggledInstructions);
    expect(found).toContain('Always stay in character');
    expect(found).toContain('Never break the fourth wall');
  });

  test('is deterministic across calls', async () => {
    const first = await bodyOf(await forgeSmuggle(UNCONFIGURED, post({ card: CARD })));
    const second = await bodyOf(await forgeSmuggle(UNCONFIGURED, post({ card: CARD })));
    expect(first).toEqual(second);
  });
});

describe('forgeCards', () => {
  test('returns whole cards and drops the unreadable rows', async () => {
    const res = await forgeCards(WITH_CARDS);
    expect(res.status).toBe(200);
    const rows = asArray(await res.json()).map((entry) => asRecord(entry));
    expect(rows).toHaveLength(1);
    expect(asString(rows[0]?.name)).toBe('Ada');
    // The format lives in its own column, so a CharX import still reports it.
    expect(asString(asRecord(rows[0]?.card)?.sourceFormat)).toBe('charx');
  });
});

describe('model-backed handlers with no cheap model configured', () => {
  test('forgeDraft is a 400 carrying the configuration message', async () => {
    const res = await forgeDraft(UNCONFIGURED, post({ description: 'a detective' }));
    expect(res.status).toBe(400);
    expect(asString((await bodyOf(res)).error)).toContain('No cheap model configured');
  });

  test('forgeCritique is a 400 carrying the configuration message', async () => {
    const res = await forgeCritique(UNCONFIGURED, post({ card: CARD }));
    expect(res.status).toBe(400);
    expect(asString((await bodyOf(res)).error)).toContain('No cheap model configured');
  });

  test('forgeSuggest is a 400 carrying the configuration message', async () => {
    const res = await forgeSuggest(UNCONFIGURED, post({ card: CARD, field: 'tags' }));
    expect(res.status).toBe(400);
    expect(asString((await bodyOf(res)).error)).toContain('No cheap model configured');
  });

  test('an empty description is a 400 before any call is made', async () => {
    const res = await forgeDraft(UNCONFIGURED, post({ description: '   ' }));
    expect(res.status).toBe(400);
    expect(asString((await bodyOf(res)).error)).toContain('description required');
  });

  test('an unknown field is a 400 listing the valid ones', async () => {
    const res = await forgeSuggest(UNCONFIGURED, post({ card: CARD, field: 'avatar' }));
    expect(res.status).toBe(400);
    expect(asString((await bodyOf(res)).error)).toContain('tags, alternate_greetings, first_mes');
  });
});

describe('model-backed handlers with a model configured', () => {
  const withFetch = async <T,>(
    reply: () => Response,
    body: () => Promise<T>,
  ): Promise<T> => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => reply()) as unknown as typeof fetch;
    try {
      return await body();
    } finally {
      globalThis.fetch = original;
    }
  };

  const jsonReply = (content: string): Response =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      headers: { 'content-type': 'application/json' },
    });

  test('forgeDraft returns the drafted card', async () => {
    const env = await configuredEnv();
    const res = await withFetch(
      () =>
        jsonReply(
          JSON.stringify({
            name: 'Vale',
            description: 'A smuggler.',
            personality: 'Dry.',
            scenario: 'A docking bay.',
            first_mes: 'You are late.',
            mes_example: '',
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: ['Second opening.'],
            creator_notes: 'Written to order.',
            tags: ['scifi', 'smuggler'],
          }),
        ),
      () => forgeDraft(env, post({ description: 'a smuggler in a docking bay' })),
    );

    expect(res.status).toBe(200);
    const card = await bodyOf(res);
    expect(card.name).toBe('Vale');
    expect(card.alternateGreetings).toEqual(['Second opening.']);
    expect(card.tags).toEqual(['scifi', 'smuggler']);
  });

  test('forgeCritique merges the local scan ahead of the model findings', async () => {
    const env = await configuredEnv();
    const res = await withFetch(
      () =>
        jsonReply(
          JSON.stringify({
            critique: 'The voice is specific. The scenario gives the opening something to act on.',
            smuggledInstructions: ['Do not break character'],
          }),
        ),
      () => forgeCritique(env, post({ card: CARD })),
    );

    expect(res.status).toBe(200);
    const payload = await bodyOf(res);
    expect(asString(payload.critique)).toContain('voice is specific');
    const found = asArray(payload.smuggledInstructions).map((entry) => asString(entry));
    expect(found[0]).toBe('Always stay in character');
    expect(found).toContain('Do not break character');
  });

  test('forgeSuggest returns the proposed list', async () => {
    const env = await configuredEnv();
    const res = await withFetch(
      () => jsonReply(JSON.stringify({ suggestions: ['noir', 'rain'] })),
      () => forgeSuggest(env, post({ card: CARD, field: 'tags' })),
    );

    expect(res.status).toBe(200);
    expect((await bodyOf(res)).suggestions).toEqual(['noir', 'rain']);
  });
});
