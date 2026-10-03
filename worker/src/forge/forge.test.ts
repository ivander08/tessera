import { describe, expect, test } from 'bun:test';
import { analyzeTokenCost } from '../../../src/lib/forge/tokenCost';
import { cardForPrompt, findSmuggledInstructions } from './smuggle';
import { parseConsultTurn, systemPrompt } from './consult';
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
    avatarHint: null,
    raw: null,
    ...overrides,
  };
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

describe('cardForPrompt', () => {
  // The consultant can only change a field it has been shown. These are the two that were
  // missing, and each one made a plain request unanswerable: "call her Syd" and "make the
  // second opening a morning scene".
  test('shows the model the shown name, so a rename is possible', () => {
    expect(cardForPrompt(card({ nickname: 'Syd' })).nickname).toBe('Syd');
  });

  test('omits the shown name when there is none, rather than sending an empty one', () => {
    expect('nickname' in cardForPrompt(card({ nickname: undefined }))).toBe(false);
  });

  test('shows the model the scene each opening starts in', () => {
    const prompt = cardForPrompt(
      card({
        alternateGreetings: ['Second.', 'Third.'],
        greetingStates: [
          { time: 'late evening', location: 'the tavern' },
          { time: 'dawn' },
          { location: 'the harbour' },
        ],
      }),
    );
    expect(prompt.greeting_states).toEqual([
      { time: 'late evening', location: 'the tavern' },
      { time: 'dawn' },
      { location: 'the harbour' },
    ]);
  });

  test('trims greeting states to the openings that exist', () => {
    // A stale extra entry would invite the model to write a scene for an opening that is not
    // in the card, and the reply would come back longer than the greetings it describes.
    const prompt = cardForPrompt(
      card({ alternateGreetings: [], greetingStates: [{ time: 'a' }, { time: 'b' }, { time: 'c' }] }),
    );
    expect(prompt.greeting_states).toEqual([{ time: 'a' }]);
  });
});
describe('parseConsultTurn', () => {
  test('reads a turn that asks a question', () => {
    const turn = parseConsultTurn(
      JSON.stringify({
        say: 'Good start. One thing I need:',
        question: {
          text: 'How do they speak?',
          options: ['Clipped and dry', 'Warm and long-winded'],
          recommended: 1,
        },
        card: null,
      }),
    );

    expect(turn.say).toBe('Good start. One thing I need:');
    expect(turn.question).toEqual({
      text: 'How do they speak?',
      options: ['Clipped and dry', 'Warm and long-winded'],
      recommended: 1,
    });
    expect(turn.card).toBeNull();
  });

  test('reads a turn that proposes a card and asks nothing', () => {
    const turn = parseConsultTurn(
      JSON.stringify({
        say: 'Here it is.',
        question: null,
        card: {
          name: 'Mira',
          description: 'A lighthouse keeper.',
          first_mes: 'The lamp needs oil.',
          alternate_greetings: ['Second opening.'],
          tags: ['coastal'],
        },
      }),
    );

    expect(turn.question).toBeNull();
    // Wire names map onto the stored shape, and an absent field defaults rather than
    // arriving as undefined — the same contract `toParsedCard` has always had.
    expect(turn.card).toMatchObject({
      name: 'Mira',
      description: 'A lighthouse keeper.',
      firstMes: 'The lamp needs oil.',
      alternateGreetings: ['Second opening.'],
      tags: ['coastal'],
      personality: '',
      characterBook: null,
    });
  });

  test('clamps recommended into the options it actually has', () => {
    // A model that counts from one, or names an index that does not exist, must not
    // produce a question whose "recommended" points at nothing.
    const turn = parseConsultTurn(
      JSON.stringify({
        say: 'Pick one.',
        question: { text: 'Which?', options: ['a', 'b'], recommended: 7 },
        card: null,
      }),
    );
    expect(turn.question?.recommended).toBe(1);

    const negative = parseConsultTurn(
      JSON.stringify({
        say: 'Pick one.',
        question: { text: 'Which?', options: ['a', 'b'], recommended: -3 },
        card: null,
      }),
    );
    expect(negative.question?.recommended).toBe(0);
  });

  test('defaults recommended to 0 when it is missing or not a number', () => {
    for (const recommended of [undefined, 'the first one', null]) {
      const turn = parseConsultTurn(
        JSON.stringify({
          say: 'Pick one.',
          question: { text: 'Which?', options: ['a', 'b'], recommended },
          card: null,
        }),
      );
      expect(turn.question?.recommended).toBe(0);
    }
  });

  test('a question with no options collapses to null rather than an unanswerable prompt', () => {
    const turn = parseConsultTurn(
      JSON.stringify({
        say: 'Hmm.',
        question: { text: 'Which?', options: ['', '  '], recommended: 0 },
        card: null,
      }),
    );
    expect(turn.question).toBeNull();
  });

  test('a turn with neither a question nor a card is legal — it is just talking', () => {
    const turn = parseConsultTurn(JSON.stringify({ say: 'Nothing to change here.', question: null, card: null }));
    expect(turn).toEqual({ say: 'Nothing to change here.', question: null, card: null });
  });

  test('a reply with no say throws', () => {
    expect(() => parseConsultTurn(JSON.stringify({ question: null, card: null }))).toThrow(
      /returned no reply/,
    );
  });

  test('a card that fails validation throws rather than arriving half-formed', () => {
    expect(() =>
      parseConsultTurn(
        JSON.stringify({ say: 'Here.', question: null, card: { description: 'no name' } }),
      ),
    ).toThrow(/no name/);
  });

  test('a fenced reply is still read', () => {
    const turn = parseConsultTurn('```json\n{"say":"Fenced.","question":null,"card":null}\n```');
    expect(turn.say).toBe('Fenced.');
  });

  // The bug from the report: the model ignored the JSON envelope and answered in prose, and
  // the turn was thrown away as "the model did not return a usable turn". The words are the
  // answer — they had already been streamed to the user's screen — so they are the turn.
  test('a prose reply is a turn, not a failure', () => {
    const turn = parseConsultTurn(
      "I'd love to help with that. Before I touch the card, what does she do when the wind dies?",
    );
    expect(turn.say).toBe(
      "I'd love to help with that. Before I touch the card, what does she do when the wind dies?",
    );
    expect(turn.question).toBeNull();
    expect(turn.card).toBeNull();
  });

  test('a prose reply wrapped in a fence loses the fence', () => {
    const turn = parseConsultTurn('```\nJust talking here.\n```');
    expect(turn.say).toBe('Just talking here.');
  });

  // The reported bug: the model wrapped the envelope in a sentence and the card was thrown
  // away with it, so the pane showed the announcement and no diff. The envelope is the
  // authority; the prose around it is formatting.
  test('a card survives a sentence BEFORE the envelope', () => {
    const turn = parseConsultTurn(
      'Sure — here it is:\n{"say":"Added it.","question":null,"card":{"name":"Ada","first_mes":"One."}}',
    );
    expect(turn.say).toBe('Added it.');
    expect(turn.card?.name).toBe('Ada');
  });

  test('a card survives a sign-off AFTER the envelope', () => {
    const turn = parseConsultTurn(
      '{"say":"Added it.","question":null,"card":{"name":"Ada","first_mes":"One."}}\n\nLet me know if that reads right.',
    );
    expect(turn.card?.name).toBe('Ada');
  });

  test('a brace inside the prose does not shadow the envelope', () => {
    const turn = parseConsultTurn(
      'Note: {this is not json} — anyway:\n{"say":"Done.","question":null,"card":{"name":"Ada","first_mes":"One."}}',
    );
    expect(turn.card?.name).toBe('Ada');
  });

  test('a brace inside a JSON string does not break the balance scan', () => {
    const turn = parseConsultTurn(
      '{"say":"Use the } glyph and the { glyph.","question":null,"card":{"name":"Ada","first_mes":"One."}}',
    );
    expect(turn.say).toBe('Use the } glyph and the { glyph.');
    expect(turn.card?.name).toBe('Ada');
  });

  // The other half of the reported bug: the reply announced a revision and could not be read,
  // and the user was told nothing — no diff, no Apply, no error. An unreadable CARD is a
  // failure, not a "just talking" turn.
  test('an envelope cut off while writing the card throws rather than silently dropping it', () => {
    expect(() =>
      parseConsultTurn('{"say":"Here it is: the whole card back.","question":null,"card":{"name":"Ada","desc'),
    ).toThrow(/writing the card/);
  });

  test('an envelope whose card is malformed throws rather than silently dropping it', () => {
    // A complete object, but the card inside is not a card: `toParsedCard` rejects it. That
    // must surface, not become a prose-only turn.
    expect(() =>
      parseConsultTurn(
        '{"say":"Here it is.","question":null,"card":{"description":"no name at all"}}',
      ),
    ).toThrow(/no name/);
  });

  test('a prose reply that merely mentions a card object is still prose', () => {
    // Not an envelope attempt — it does not open with `{` — so the existing fallback must keep
    // showing the words rather than turning a usable answer into an error box.
    const text = 'I would set "card": {"name": "Ada"} if I were proposing one, but I am not.';
    const turn = parseConsultTurn(text);
    expect(turn.say).toBe(text);
    expect(turn.card).toBeNull();
  });

  test('a reply cut off mid-envelope keeps the say text written so far', () => {
    // The token cap can land mid-object. Showing the user `{"say": "I'd love…` is worse than
    // showing them the words; the raw envelope must never reach the transcript. This is the
    // NO-CARD truncation: the prose is the whole answer, so there is nothing to lose by
    // keeping it. A truncation that was writing a CARD throws instead — see below.
    const turn = parseConsultTurn('{"say": "I\'d love to help with that. What does she want');
    expect(turn.say).toBe("I'd love to help with that. What does she want");
    expect(turn.question).toBeNull();
  });

  test('a bare JSON string is read as the reply', () => {
    const turn = parseConsultTurn('"Just the words, nothing else."');
    expect(turn.say).toBe('Just the words, nothing else.');
  });

  test('valid JSON that carries no reply still throws', () => {
    // `null`, a number and an array are parseable but say nothing, so they are a real
    // failure rather than an empty turn.
    for (const body of ['null', '42', '[1,2]']) {
      expect(() => parseConsultTurn(body)).toThrow(/returned no reply/);
    }
  });

  test('an empty reply throws', () => {
    expect(() => parseConsultTurn('   ')).toThrow(/returned no reply/);
  });

  // The forge now states the scene each opening begins in, so a chat created from a drafted
  // card starts with a time and place instead of inferring them from the opening paragraph.
  // The two lists are index-aligned everywhere they are read, so the mapping is the part
  // that has to be exact.
  test('maps greeting_states onto the openings, index-aligned', () => {
    const turn = parseConsultTurn(
      JSON.stringify({
        say: 'Here is the card.',
        question: null,
        card: {
          name: 'Ada',
          first_mes: 'Rain on the window.',
          alternate_greetings: ['A second opening.', 'A third.'],
          greeting_states: [
            { time: 'late evening', location: 'the Compass Rose', weather: 'heavy rain' },
            { time: '', location: 'a cold street', weather: '' },
            { time: 'dawn', location: '', weather: 'fog' },
          ],
        },
      }),
    );

    expect(turn.card?.greetingStates).toEqual([
      { time: 'late evening', location: 'the Compass Rose', weather: 'heavy rain' },
      { location: 'a cold street' },
      { time: 'dawn', weather: 'fog' },
    ]);
  });

  test('pads a short greeting_states list so no opening loses its slot', () => {
    // A model that states a scene for the first opening and stops would otherwise leave the
    // alternates with no entry at all, and chat creation reads by index.
    const turn = parseConsultTurn(
      JSON.stringify({
        say: 'Here.',
        question: null,
        card: {
          name: 'Ada',
          first_mes: 'One.',
          alternate_greetings: ['Two.', 'Three.'],
          greeting_states: [{ location: 'the tavern' }],
        },
      }),
    );

    expect(turn.card?.greetingStates).toEqual([{ location: 'the tavern' }, {}, {}]);
  });

  test('omits greeting_states entirely when the model sends none', () => {
    // `undefined`, NOT an empty array. The consultant returns only what it changed, so a reply
    // that omits the field must leave the card's existing scenes alone — collapsing it to `[]`
    // would wipe every opening's time and place on the next Apply.
    const turn = parseConsultTurn(
      JSON.stringify({
        say: 'Here.',
        question: null,
        card: { name: 'Ada', first_mes: 'One.', alternate_greetings: ['Two.'] },
      }),
    );

    expect(turn.card?.greetingStates).toBeUndefined();
  });

  test('an explicit empty greeting_states array means the scenes were cleared', () => {
    const turn = parseConsultTurn(
      JSON.stringify({
        say: 'Here.',
        question: null,
        card: { name: 'Ada', first_mes: 'One.', greeting_states: [] },
      }),
    );

    expect(turn.card?.greetingStates).toEqual([{}]);
  });

  test('omits nickname when the model does not mention it, so a rename is never lost', () => {
    const turn = parseConsultTurn(
      JSON.stringify({
        say: 'Here.',
        question: null,
        card: { name: 'Ada', first_mes: 'One.' },
      }),
    );
    expect(turn.card?.nickname).toBeUndefined();
  });

  test('reads a nickname the model proposes', () => {
    const turn = parseConsultTurn(
      JSON.stringify({
        say: 'Renamed.',
        question: null,
        card: { name: 'Sydney', nickname: 'Syd', first_mes: 'One.' },
      }),
    );
    expect(turn.card?.nickname).toBe('Syd');
  });

  test('an empty nickname clears it rather than reading as an omission', () => {
    const turn = parseConsultTurn(
      JSON.stringify({
        say: 'Cleared.',
        question: null,
        card: { name: 'Ada', nickname: '', first_mes: 'One.' },
      }),
    );
    expect(turn.card?.nickname).toBe('');
  });
});

/**
 * What the consultant is told. These are behavioural contracts, not prose checks: each one
 * names a failure the prompt is there to prevent, and the assertions are the load-bearing
 * sentences rather than the whole block, so the wording can be tightened without re-pinning
 * every test.
 */
describe('systemPrompt', () => {
  const prompt = systemPrompt('consult', card());

  test('states the app is unrestricted adult fiction, so the consultant does not hedge', () => {
    // The reported problem: cards for this app are explicit, and a consultant that does not
    // know that asks euphemistic questions and softens explicit requests.
    expect(prompt).toContain('unrestricted adult-fiction');
    expect(prompt).toContain('Do not soften it');
    expect(prompt).toContain('Never hedge');
  });

  test('tells it to ask about intimacy directly, in the user\'s register', () => {
    // The other reported problem: the interview stayed vague. "What is she like in bed" is the
    // question that produces an explicit card; "is she affectionate" produces nothing.
    expect(prompt).toContain('ask what the character');
    expect(prompt).toContain('like in bed');
    expect(prompt).toContain('explicit back');
  });

  test('tells it to probe a thin answer rather than move on', () => {
    expect(prompt).toContain('Probe.');
    expect(prompt).toContain('keep asking while the answers are');
  });

  test('forbids announcing a change without shipping the card', () => {
    // The reported bug: the prose said "here it is" and the card was null, so no diff and no
    // Apply button appeared while the model insisted it had made the change.
    expect(prompt).toContain('you MUST set "card"');
    expect(prompt).toContain('ships nothing');
  });

  test('carries the card craft and this app\'s format in both modes', () => {
    for (const mode of ['draft', 'consult'] as const) {
      const text = systemPrompt(mode, card());
      expect(text).toContain('# How a card works');
      expect(text).toContain("# This app's card format");
    }
  });

  test('the card report and the known findings appear only when there is a card', () => {
    const without = systemPrompt('draft', null);
    expect(without).not.toContain('# What this card costs');
    expect(systemPrompt('consult', card())).toContain('# What this card costs');
  });
});
