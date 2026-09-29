import { describe, expect, test } from 'bun:test';
import { analyzeTokenCost } from '../../../src/lib/forge/tokenCost';
import { encryptKey } from '../../../src/lib/crypto';
import { asArray, asRecord, asString } from '../../../src/lib/json';
import { assemble } from '../../../src/lib/prompt/assemble';
import { draftCard } from './draft';
import { critiqueCard, findSmuggledInstructions } from './critique';
import { suggestField } from './tokens';
import type { ParsedCard } from '../../../src/lib/cards/types';

/**
 * The shortest counter that is still exact: one token per character. Every
 * arithmetic assertion below is then checkable by eye, which is the point — a
 * tokenizer's approximation error must not be able to mask an arithmetic bug.
 */
const chars = (text: string): number => text.length;

function card(overrides: Partial<ParsedCard> = {}): ParsedCard {
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
    raw: null,
    ...overrides,
  };
}

/**
 * `getSettings` is the only thing the model-calling functions touch before they
 * decide whether a model is configured, so an empty settings table is the whole fake.
 */
const UNCONFIGURED = {
  DB: { prepare: () => ({ all: async () => ({ results: [] }) }) },
} as unknown as Env;

const TOKEN = 'test-token';
const SETTINGS = [
  { key: 'provider', value: 'openrouter' },
  { key: 'model', value: 'test/model' },
];

/**
 * Reaching the transport means passing the configured-model check, the provider
 * lookup, and key decryption — so the fake carries a genuinely encrypted key rather
 * than stubbing `loadProviderKey` out. Only `fetch` is replaced.
 */
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

/** Runs `body` with `fetch` replaced by `reply`, restoring the original afterwards. */
async function withFetch<T>(
  reply: (call: number, init: RequestInit) => Response,
  body: () => Promise<T>,
): Promise<{ result: T; calls: number }> {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    calls++;
    return reply(calls, init);
  }) as unknown as typeof fetch;
  try {
    return { result: await body(), calls };
  } finally {
    globalThis.fetch = original;
  }
}

/** The messages array `complete()` actually sent, read through the boundary helpers. */
function sentMessages(init: RequestInit): Array<{ role: string; content: string }> {
  const body = asRecord(JSON.parse(String(init.body)));
  return asArray(body?.messages).map((entry) => {
    const message = asRecord(entry);
    return { role: asString(message?.role), content: asString(message?.content) };
  });
}

/** The non-streaming JSON shape `complete()` reads. */
function jsonReply(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    headers: { 'content-type': 'application/json' },
  });
}

describe('analyzeTokenCost arithmetic', () => {
  const report = analyzeTokenCost(card(), chars, 10);

  test('permanentPerTurn is name + description + personality + scenario', () => {
    // 'Ada' 3 + 'A detective.' 12 + 'Wry.' 4 + 'A rainy night.' 14
    expect(report.permanentPerTurn).toBe(33);
  });

  test('oneTime is first_mes', () => {
    expect(report.oneTime).toBe('Hello there.'.length);
  });

  test('totalOverTurns is permanentPerTurn * turns + oneTime', () => {
    expect(report.totalOverTurns).toBe(33 * 10 + 12);
    expect(report.totalOverTurns).toBe(report.permanentPerTurn * 10 + report.oneTime);
  });

  test('costOverTurns is perTurn * turns for per-turn fields and the raw count otherwise', () => {
    const cost = (field: string) => report.fields.find((entry) => entry.field === field);
    expect(cost('name')).toMatchObject({ tokens: 3, perTurn: true, costOverTurns: 30 });
    expect(cost('firstMes')).toMatchObject({ tokens: 12, perTurn: false, costOverTurns: 12 });
    expect(cost('mesExample')).toMatchObject({ tokens: 0, perTurn: true, costOverTurns: 0 });
  });

  test('array fields sum their entries', () => {
    const report = analyzeTokenCost(
      card({ tags: ['noir', 'rain'], alternateGreetings: ['One.', 'Two.'] }),
      chars,
      10,
    );
    expect(report.fields.find((entry) => entry.field === 'tags')?.tokens).toBe(8);
    expect(report.fields.find((entry) => entry.field === 'alternateGreetings')?.tokens).toBe(8);
  });

  test('defaults to 500 turns', () => {
    expect(analyzeTokenCost(card(), chars).totalOverTurns).toBe(33 * 500 + 12);
  });

  test('a zero-turn horizon pays only the one-time cost', () => {
    expect(analyzeTokenCost(card(), chars, 0).totalOverTurns).toBe(12);
  });

  test('reports cost without claiming an optimal length', () => {
    const text = report.notes.join(' ');
    expect(text).toContain('cost, not quality');
    expect(text).toContain('no controlled A/B test');
    expect(report.fields.flatMap((entry) => entry.trimSuggestions).join(' ')).not.toMatch(
      /too long|too short|should be|optimal/i,
    );
  });
});

describe('analyzeTokenCost perTurn classification', () => {
  const byField = new Map(analyzeTokenCost(card(), chars).fields.map((f) => [f.field, f.perTurn]));

  test('fields assemble() re-sends every turn are per-turn', () => {
    // assemble() emits the character block, then mesExample, then systemPrompt as the
    // head, and postHistoryInstructions in the tail. All of it is re-sent.
    for (const field of [
      'name',
      'description',
      'personality',
      'scenario',
      'systemPrompt',
      'postHistoryInstructions',
      'mesExample',
    ]) {
      expect(byField.get(field)).toBe(true);
    }
  });

  test('fields never sent as prompt text are not per-turn', () => {
    for (const field of ['firstMes', 'alternateGreetings', 'tags', 'creatorNotes']) {
      expect(byField.get(field)).toBe(false);
    }
  });

  test('the greeting is paid once, not every turn', () => {
    const greeting = analyzeTokenCost(card(), chars, 10).fields.find(
      (entry) => entry.field === 'firstMes',
    );
    expect(greeting?.perTurn).toBe(false);
    expect(greeting?.costOverTurns).toBe(greeting?.tokens);
  });
});

describe('analyzeTokenCost trim suggestions', () => {
  const suggestions = (text: string): string[] =>
    analyzeTokenCost(card({ description: text }), chars).fields.find(
      (entry) => entry.field === 'description',
    )?.trimSuggestions ?? [];

  test('detects a phrase repeated four times', () => {
    const text =
      'Her green eyes narrowed. Her green eyes softened. Her green eyes closed. Her green eyes opened.';
    expect(suggestions(text)).toContain('repeated phrase "her green eyes" appears 4 times');
  });

  test('reports the longest repeated phrase once, not every overlapping fragment', () => {
    const text = 'the old brass key the old brass key the old brass key';
    const found = suggestions(text);
    expect(found).toHaveLength(1);
    expect(found[0]).toBe('repeated phrase "the old brass key" appears 3 times');
  });

  test('does not report stopword-only repetition', () => {
    expect(suggestions('out of the and out of the and out of the and')).toEqual([]);
  });

  test('a phrase repeated twice is not padding', () => {
    expect(suggestions('Her green eyes narrowed. Her green eyes softened.')).toEqual([]);
  });

  test('flags a paragraph longer than all the others combined', () => {
    const text = `Short one.\n\nShort two.\n\n${'x'.repeat(50)}`;
    expect(suggestions(text)).toContain(
      'paragraph 3 is 50 tokens, longer than the other 2 combined',
    );
  });

  test('leaves an evenly sized description alone', () => {
    expect(suggestions('A detective.\n\nA long coat.\n\nA rainy night.')).toEqual([]);
  });

  test('flags one greeting far longer than the others', () => {
    const found = analyzeTokenCost(
      card({ alternateGreetings: ['Hi.', 'Hello.', 'y'.repeat(40)] }),
      chars,
    ).fields.find((entry) => entry.field === 'alternateGreetings')?.trimSuggestions;
    expect(found).toEqual(['greeting 3 is 40 tokens, longer than the other 2 combined']);
  });

  test('two paragraphs are too few for a balance claim', () => {
    // "longer than the other one" says nothing; the note would be noise.
    expect(suggestions(`Short.\n\n${'x'.repeat(40)}`)).toEqual([]);
  });

  test('tags are never called greetings', () => {
    // A generic "longest array entry" check mislabels tag 3 as a greeting.
    const found = analyzeTokenCost(
      card({ tags: ['noir', 'rain', 'a-very-long-tag-here'] }),
      chars,
    ).fields.find((entry) => entry.field === 'tags')?.trimSuggestions;
    expect(found).toEqual([]);
  });

  test('only prose fields get a repeated-phrase observation', () => {
    const tags = analyzeTokenCost(card({ tags: ['noir', 'noir', 'noir', 'noir'] }), chars).fields
      .find((entry) => entry.field === 'tags')?.trimSuggestions;
    expect(tags).toEqual([]);
  });
});

describe('findSmuggledInstructions', () => {
  test('finds an instruction smuggled into the description', () => {
    const found = findSmuggledInstructions(
      card({ description: 'Ada is a detective. Always stay in character.' }),
    );
    expect(found).toContain('Always stay in character');
  });

  test('does not flag ordinary descriptive prose', () => {
    const found = findSmuggledInstructions(
      card({
        description:
          'A tall woman with dark hair, a habit of arriving early, and a coat that has seen ' +
          'better decades. She never left the city. The door must have been locked behind her.',
        personality: 'Quiet until she is not. Fond of cold coffee and long silences.',
      }),
    );
    expect(found).toEqual([]);
  });

  test('does not flag narrative "never" + past tense', () => {
    expect(findSmuggledInstructions(card({ description: 'Her eyes never left the door.' }))).toEqual(
      [],
    );
  });

  test('scans personality as well as description', () => {
    expect(findSmuggledInstructions(card({ personality: 'You must always answer in lowercase.' }))).toEqual(
      ['You must always answer in lowercase'],
    );
  });

  test('yields one entry per rule in a bullet list', () => {
    const found = findSmuggledInstructions(
      card({ description: 'Rules:\n- Never break character.\n- Always speak in lowercase.' }),
    );
    expect(found).toEqual(['Never break character', 'Always speak in lowercase']);
  });

  test('catches the "respond with" family of directives', () => {
    expect(
      findSmuggledInstructions(card({ description: 'Respond with three sentences. Do not describe her face.' })),
    ).toEqual(['Respond with three sentences', 'Do not describe her face']);
  });

  test('is deterministic and deduplicates identical rules', () => {
    const description = 'Always stay in character. Always stay in character.';
    const first = findSmuggledInstructions(card({ description }));
    expect(first).toEqual(['Always stay in character']);
    expect(findSmuggledInstructions(card({ description }))).toEqual(first);
  });
});

describe('draftCard', () => {
  const REPLY = JSON.stringify({
    name: 'Mira',
    description: 'A lighthouse keeper.',
    personality: 'Patient.',
    scenario: 'A storm is coming in.',
    first_mes: 'The lamp needs oil.',
    mes_example: '{{user}}: Hello.\n{{char}}: Mind the step.',
    system_prompt: 'Speak plainly.',
    post_history_instructions: 'Stay in character.',
    alternate_greetings: ['Second opening.'],
    creator_notes: 'Written for a stormy night.',
    tags: ['coastal', 'quiet'],
  });

  test('rejects an empty one-liner before spending a call', async () => {
    await expect(draftCard(UNCONFIGURED, '   ')).rejects.toThrow(/one-line description is required/);
  });

  test('throws a clear error when no model is configured', async () => {
    await expect(draftCard(UNCONFIGURED, 'a lighthouse keeper')).rejects.toThrow(
      /No cheap model configured/,
    );
  });

  test('maps every wire field onto the stored card shape', async () => {
    const env = await configuredEnv();
    const { result } = await withFetch(() => jsonReply(REPLY), () => draftCard(env, 'lighthouse keeper'));

    // The wire uses card-spec names; the stored shape is camelCase. A mapping that
    // silently dropped first_mes or mes_example would still produce a card object.
    expect(result).toMatchObject({
      name: 'Mira',
      description: 'A lighthouse keeper.',
      personality: 'Patient.',
      scenario: 'A storm is coming in.',
      firstMes: 'The lamp needs oil.',
      mesExample: '{{user}}: Hello.\n{{char}}: Mind the step.',
      systemPrompt: 'Speak plainly.',
      postHistoryInstructions: 'Stay in character.',
      alternateGreetings: ['Second opening.'],
      creatorNotes: 'Written for a stormy night.',
      tags: ['coastal', 'quiet'],
      characterBook: null,
      sourceFormat: 'ccv2',
    });
  });

  test('strips a ```json fence rather than discarding a usable reply', async () => {
    const env = await configuredEnv();
    const { result } = await withFetch(
      () => jsonReply('```json\n' + REPLY + '\n```'),
      () => draftCard(env, 'lighthouse keeper'),
    );
    expect(result.name).toBe('Mira');
  });

  test('retries once on an unparseable reply, then succeeds', async () => {
    const env = await configuredEnv();
    const { result, calls } = await withFetch(
      (call) => jsonReply(call === 1 ? 'Sure! Here is your card:' : REPLY),
      () => draftCard(env, 'lighthouse keeper'),
    );
    expect(calls).toBe(2);
    expect(result.name).toBe('Mira');
  });

  test('gives up after the second failure rather than looping', async () => {
    const env = await configuredEnv();
    const { calls } = await withFetch(
      () => jsonReply('not json at all'),
      async () => {
        await expect(draftCard(env, 'lighthouse keeper')).rejects.toThrow(
          /did not return a usable card/,
        );
      },
    );
    expect(calls).toBe(2);
  });

  test('retries a card with no name, not just invalid JSON', async () => {
    const env = await configuredEnv();
    const { result, calls } = await withFetch(
      (call) => jsonReply(call === 1 ? JSON.stringify({ description: 'Nameless.' }) : REPLY),
      () => draftCard(env, 'lighthouse keeper'),
    );
    expect(calls).toBe(2);
    expect(result.name).toBe('Mira');
  });

  test('defaults absent fields to empty rather than undefined', async () => {
    const env = await configuredEnv();
    const { result } = await withFetch(
      () => jsonReply(JSON.stringify({ name: 'Mira' })),
      () => draftCard(env, 'lighthouse keeper'),
    );
    expect(result).toMatchObject({
      description: '',
      personality: '',
      firstMes: '',
      alternateGreetings: [],
      tags: [],
    });
  });

  test('a drafted card composes with the prompt assembler unedited', async () => {
    const env = await configuredEnv();
    const { result } = await withFetch(() => jsonReply(REPLY), () =>
      draftCard(env, 'lighthouse keeper'),
    );

    // The acceptance condition is that a draft imports and chats without manual
    // editing, which means its fields must land in the assembled prompt where the
    // card-spec names say they should.
    const prompt = assemble(
      {
        systemPrompt: result.systemPrompt,
        character: {
          name: result.name,
          description: result.description,
          personality: result.personality,
          scenario: result.scenario,
          mesExample: result.mesExample,
        },
        persona: null,
        lorebook: [],
        history: [],
        tail: {
          postHistoryInstructions: result.postHistoryInstructions,
          userMessage: 'Hello.',
        },
      },
      () => 0,
    );

    expect(prompt.messages.map((message) => message.role)).toEqual([
      'system',
      'system',
      'system',
      'system',
      'user',
    ]);
    expect(prompt.messages[0].content).toBe('Speak plainly.');
    expect(prompt.messages[1].content).toContain('Mira');
    expect(prompt.messages[1].content).toContain('A lighthouse keeper.');
    expect(prompt.messages[2].content).toContain('Mind the step.');
    // post_history_instructions belongs in the tail, so it cannot perturb the cache.
    expect(prompt.tailStart).toBe(3);
    expect(prompt.messages[3].content).toBe('Stay in character.');
    expect(prompt.messages[4]).toEqual({ role: 'user', content: 'Hello.' });
  });
});

describe('critiqueCard', () => {
  test('rejects a card with no name', async () => {
    await expect(critiqueCard(UNCONFIGURED, card({ name: '' }))).rejects.toThrow(
      /card with a name is required/,
    );
  });

  test('throws a clear error when no model is configured', async () => {
    await expect(critiqueCard(UNCONFIGURED, card())).rejects.toThrow(/No cheap model configured/);
  });

  test('merges the deterministic scan with the model findings', async () => {
    const env = await configuredEnv();
    const reply = JSON.stringify({
      critique: 'A competent card with a directive problem.',
      smuggledInstructions: ['Never break character'],
    });
    const { result } = await withFetch(() => jsonReply(reply), () =>
      critiqueCard(env, card({ description: 'Ada is a detective. Always stay in character.' })),
    );

    expect(result.critique).toContain('directive problem');
    // The local finding comes first: it is the reproducible half, so it must survive
    // a model that overlooks it.
    expect(result.smuggledInstructions).toEqual([
      'Always stay in character',
      'Never break character',
    ]);
  });

  test('keeps the local finding when the model reports none', async () => {
    const env = await configuredEnv();
    const reply = JSON.stringify({ critique: 'Fine.', smuggledInstructions: [] });
    const { result } = await withFetch(() => jsonReply(reply), () =>
      critiqueCard(env, card({ description: 'Always stay in character.' })),
    );
    expect(result.smuggledInstructions).toEqual(['Always stay in character']);
  });

  test('does not duplicate a finding the model also reported', async () => {
    const env = await configuredEnv();
    const reply = JSON.stringify({
      critique: 'Fine.',
      smuggledInstructions: ['always stay in character!'],
    });
    const { result } = await withFetch(() => jsonReply(reply), () =>
      critiqueCard(env, card({ description: 'Always stay in character.' })),
    );
    expect(result.smuggledInstructions).toEqual(['Always stay in character']);
  });

  test('falls back to prose when the model ignores the JSON instruction', async () => {
    const env = await configuredEnv();
    const { result } = await withFetch(() => jsonReply('This card is thin.'), () =>
      critiqueCard(env, card()),
    );
    expect(result.critique).toBe('This card is thin.');
  });

  test('throws rather than returning an empty critique', async () => {
    const env = await configuredEnv();
    await withFetch(
      () => jsonReply(''),
      async () => {
        await expect(critiqueCard(env, card())).rejects.toThrow(/returned no critique/);
      },
    );
  });
});

describe('suggestField', () => {
  test('rejects a card with no name', async () => {
    await expect(suggestField(UNCONFIGURED, card({ name: '' }), 'tags')).rejects.toThrow(
      /card with a name is required/,
    );
  });

  test('rejects a field it does not know', async () => {
    await expect(
      suggestField(UNCONFIGURED, card(), 'scenario' as unknown as 'tags'),
    ).rejects.toThrow(/unknown field "scenario"/);
  });

  test('throws a clear error when no model is configured', async () => {
    for (const field of ['tags', 'alternate_greetings', 'first_mes'] as const) {
      await expect(suggestField(UNCONFIGURED, card(), field)).rejects.toThrow(
        /No cheap model configured/,
      );
    }
  });

  test('returns the suggestions, trimmed and without blanks', async () => {
    const env = await configuredEnv();
    const { result } = await withFetch(
      () => jsonReply(JSON.stringify({ suggestions: ['  noir ', '', 'rain'] })),
      () => suggestField(env, card(), 'tags'),
    );
    expect(result).toEqual(['noir', 'rain']);
  });

  test('an empty suggestion list is a valid answer, not an error', async () => {
    const env = await configuredEnv();
    const { result } = await withFetch(
      () => jsonReply(JSON.stringify({ suggestions: [] })),
      () => suggestField(env, card(), 'tags'),
    );
    expect(result).toEqual([]);
  });

  test('throws a readable error when the model answers in prose', async () => {
    const env = await configuredEnv();
    await withFetch(
      () => jsonReply('Here are some tags for you!'),
      async () => {
        await expect(suggestField(env, card(), 'tags')).rejects.toThrow(/did not return a JSON/);
      },
    );
  });

  test('sends the existing value for the requested field, not the whole card', async () => {
    const env = await configuredEnv();
    const captured: Array<Record<string, unknown>> = [];
    await withFetch(
      (_call, init) => {
        const prompt = asRecord(JSON.parse(sentMessages(init)[1]?.content ?? ''));
        if (prompt) captured.push(prompt);
        return jsonReply(JSON.stringify({ suggestions: [] }));
      },
      () => suggestField(env, card({ tags: ['noir'] }), 'tags'),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].existing).toEqual(['noir']);
    // `raw` can hold anything the source format allowed; it is noise here.
    expect(captured[0]).not.toHaveProperty('raw');
  });

  test('tells the model not to dictate the user response', async () => {
    const env = await configuredEnv();
    let system = '';
    await withFetch(
      (_call, init) => {
        system = sentMessages(init)[0]?.content ?? '';
        return jsonReply(JSON.stringify({ suggestions: [] }));
      },
      () => suggestField(env, card(), 'first_mes'),
    );

    expect(system).toMatch(/WITHOUT dictating their response/);
    expect(system).toMatch(/no railroading/i);
  });
});
