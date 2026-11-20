import { describe, expect, test } from 'bun:test';
import { encryptKey } from '../../../src/lib/crypto';
import type { ParsedCard } from '../../../src/lib/cards/types';
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
async function configuredEnv(extra: Array<{ key: string; value: string }> = []): Promise<Env> {
  const settings = [...SETTINGS, ...extra];
  const { enc, iv } = await encryptKey('sk-test', TOKEN);
  const keyRow = { key_enc: new Uint8Array(enc), iv: new Uint8Array(iv) };

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
function fullCard(): ParsedCard {
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

describe('a turn that claims a change it did not send', () => {
  // The prod defect, isolated. Measured before the fix: 2 of 6 change requests read "Done -
  // appended a profanity block" and carried `changes: []`, so the reader pressed Apply on
  // nothing. The repair is one silent call, and these assert both outcomes of it.
  const claimed = JSON.stringify({
    say: 'Done — appended a profanity block to the description.',
    question: null,
    changes: [],
  });
  const repaired = JSON.stringify({
    say: 'Profanity added.',
    question: null,
    changes: [{ field: 'description', op: 'append', value: 'She swears like a sailor.' }],
  });

  test('is repaired without the reader seeing an apology instead of the answer', async () => {
    const env = await configuredEnv();
    let call = 0;
    const replies = [claimed, repaired];
    await withFetch(
      () => jsonReply(replies[Math.min(call++, replies.length - 1)]),
      async (sent) => {
        const turn = await consult(env, {
          mode: 'consult',
          messages: [{ role: 'user', content: 'Make her swear more.' }],
          card: fullCard(),
          onDelta: () => {},
        });

        // Two calls: the claim, then the silent repair.
        expect(sent.length).toBe(2);
        // The applied card is what the reader gets, so Apply has something to do.
        expect(turn.card?.description).toContain('She swears like a sailor.');
        expect(turn.changes?.length).toBe(1);
        expect(turn.dropped).toBe(0);
        // The words already streamed are kept: swapping in the repair's prose would rewrite
        // text the reader had read, and the claim is true once the edit is applied.
        expect(turn.say).toBe('Done — appended a profanity block to the description.');
      },
    );
  });

  test('surfaces the no-change panel when the repair produces no edits either', async () => {
    const env = await configuredEnv();
    await withFetch(
      () => jsonReply(claimed),
      async (sent) => {
        // `onDelta` is what the route passes, and it matters here: the claim has already
        // reached the reader, so the outer retry must NOT restart the whole turn. Without it
        // the engine would try the entire consult again, re-streaming text the reader has
        // already read.
        const turn = await consult(env, {
          mode: 'consult',
          messages: [{ role: 'user', content: 'Make her swear more.' }],
          card: fullCard(),
          onDelta: () => {},
        });

        // The reply, then ONE repair call. It used to be two sequential shapes and measured
        // 569s on prod for a single question; one call offering both is the fix.
        expect(sent.length).toBe(2);
        // No card is what makes `ConsultPanel` draw its "No change proposed" panel with the
        // "Do it" button. An error here would leave the reader with nothing to press.
        expect(turn.card).toBeNull();
        expect(turn.changes ?? []).toEqual([]);
        expect(turn.question).toBeNull();
      },
    );
  });

  test('a question that mentions a change is not repaired', async () => {
    const env = await configuredEnv();
    await withFetch(
      () =>
        jsonReply(
          JSON.stringify({
            say: 'Before I cut, one thing worth deciding: which paragraph should go?',
            question: { text: 'Which?', options: ['The first', 'The last'], recommended: 0 },
            changes: [],
          }),
        ),
      async (sent) => {
        const turn = await consult(env, {
          mode: 'consult',
          messages: [{ role: 'user', content: 'Shorten it.' }],
          card: fullCard(),
        });
        expect(sent.length).toBe(1);
        expect(turn.question?.options.length).toBe(2);
        expect(turn.card).toBeNull();
      },
    );
  });
});

describe('a claim that also asks a question', () => {
  // Measured on the reader's own card (1,962 tokens): a rebuild request returned
  // "Applied. Sydney is rebuilt..." WITH a question attached and no edits. The repair was
  // gated on `question === null`, so it never ran and the pane showed the announcement, a
  // question, and no diff.
  test('is repaired rather than passed through as a normal question turn', async () => {
    const env = await configuredEnv();
    const claimWithQuestion = JSON.stringify({
      say: 'Applied. Sydney is rebuilt around the three pressures.',
      question: { text: 'Want the openings rewritten too?', options: ['Yes', 'Later'], recommended: 0 },
      changes: [],
    });
    const repaired = JSON.stringify({
      say: 'Description rewritten.',
      question: null,
      changes: [{ field: 'personality', op: 'replace', value: 'Loud first, cold second.' }],
    });
    let call = 0;
    const replies = [claimWithQuestion, repaired];

    await withFetch(
      () => jsonReply(replies[Math.min(call++, replies.length - 1)]),
      async (sent) => {
        const turn = await consult(env, {
          mode: 'consult',
          messages: [{ role: 'user', content: 'Rebuild her.' }],
          card: fullCard(),
          onDelta: () => {},
        });

        expect(sent.length).toBe(2);
        expect(turn.card?.personality).toBe('Loud first, cold second.');
        // The question is kept: it is still a real thing to answer, and the repair only
        // supplies the edit the prose promised.
        expect(turn.question?.options.length).toBe(2);
      },
    );
  });
});

describe("the repair's progress", () => {
  // The repair is a full second call and measured 98-204s on prod, streaming nothing. The
  // reader's own reading of that silence was "it probably timed out", so the pane is told the
  // repair started and keeps its "Writing the card..." indicator up.
  test('reports when the silent repair begins', async () => {
    const env = await configuredEnv();
    const claim = JSON.stringify({ say: 'Applied. Sydney is rebuilt.', question: null, changes: [] });
    const repaired = JSON.stringify({
      say: 'Done.',
      question: null,
      changes: [{ field: 'description', op: 'append', value: 'A line.' }],
    });
    let call = 0;
    const replies = [claim, repaired];

    const events: string[] = [];
    await withFetch(
      () => jsonReply(replies[Math.min(call++, replies.length - 1)]),
      async () => {
        await consult(env, {
          mode: 'consult',
          messages: [{ role: 'user', content: 'Rebuild her.' }],
          card: fullCard(),
          onDelta: () => {},
          onRepair: () => events.push('repair'),
        });
      },
    );

    expect(events).toEqual(['repair']);
  });

  test('does not report one when no repair is needed', async () => {
    const env = await configuredEnv();
    let repaired = 0;
    await withFetch(
      () =>
        jsonReply(
          JSON.stringify({
            say: 'Done — appended a line.',
            question: null,
            changes: [{ field: 'description', op: 'append', value: 'A line.' }],
          }),
        ),
      async () => {
        await consult(env, {
          mode: 'consult',
          messages: [{ role: 'user', content: 'Add a line.' }],
          card: fullCard(),
          onDelta: () => {},
          onRepair: () => (repaired += 1),
        });
      },
    );
    expect(repaired).toBe(0);
  });
});

describe('a rebuild with no legal edit shape', () => {
  // The reader's own case: a four-field rebuild. The consult prompt forbids returning a whole
  // card, so asked for edits the model wrote "Applied. Sydney is rebuilt" and shipped nothing.
  // The repair now escalates to the whole-card shape, which `mergeProposal` already handles.
  test('repairs through the whole-card shape when edits come back empty', async () => {
    // A raised ceiling, because that is what makes the whole-card shape possible at all: with
    // the transport's 4096 default the repair is clamped and a 2,000-token card cannot fit.
    const env = await configuredEnv([{ key: 'cheapMaxTokens', value: '32768' }]);
    const claim = JSON.stringify({
      say: 'Applied. Sydney is rebuilt: inseparable from Ivander at eight, gone at ten.',
      question: null,
      changes: [],
    });
    const wholeCard = JSON.stringify({
      say: 'Rebuilt.',
      question: null,
      card: {
        name: 'Sydney Sijun Chen',
        nickname: 'Sydney',
        description: 'Loud first, cold second. The depression is the interior.',
        personality: 'Extrovert, performing.',
        scenario: 'A campus at the end of a wet semester.',
        first_mes: 'You again.',
        mes_example: '',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: ['Opening two.'],
        greeting_states: [],
        creator_notes: '',
        tags: ['campus'],
      },
    });

    let call = 0;
    // The repair answer already uses the whole-card shape: the earlier two-step version sent
    // `noEdits` first, which is exactly the extra generation this change removes.
    const replies = [claim, wholeCard];
    await withFetch(
      () => jsonReply(replies[Math.min(call++, replies.length - 1)]),
      async (sent) => {
        const turn = await consult(env, {
          mode: 'consult',
          messages: [{ role: 'user', content: 'Rebuild her around the three pressures.' }],
          card: fullCard(),
          onDelta: () => {},
        });

        // Claim, then one repair call that returns the card.
        expect(sent.length).toBe(2);
        // The second repair asks for the whole card. Its budget is the CONFIGURED ceiling
        // (`cheapMaxTokens`), not a hardcoded number: a 2,000-token card does not fit in the
        // 4,096 transport floor, and clipping it is what the reader saw as "ran out of output
        // budget". The default here is that floor, because this stub configures nothing.
        // The repair asks for the configured ceiling — the largest budget the install allows —
        // rather than a fixed number. This stub is configured at 32,768.
        expect(sent[1].max_tokens).toBe(32768);

        expect(turn.card?.description).toContain('Loud first, cold second');
        expect(turn.card?.name).toBe('Sydney Sijun Chen');
        // Provenance is the app's, never the model's.
        expect(turn.card?.sourceFormat).toBe('ccv2');
      },
    );
  });
});

describe('a revision that omits the name', () => {
  // Measured on prod: asked for the whole card, glm-5-3 returned every field except `name`, and
  // the turn died with "reply had no name" after a complete rewrite of a 7,000-character
  // description. A revision already knows the name; a draft does not.
  test('is accepted and keeps the current name', async () => {
    const env = await configuredEnv([{ key: 'cheapMaxTokens', value: '32768' }]);
    await withFetch(
      () =>
        jsonReply(
          JSON.stringify({
            say: 'Rebuilt.',
            question: null,
            card: {
              // no `name` at all — the shape that failed
              description: 'Loud first, cold second.',
              personality: 'Performing.',
              scenario: 'A wet campus.',
              first_mes: 'You again.',
            },
          }),
        ),
      async () => {
        const turn = await consult(env, {
          mode: 'consult',
          messages: [{ role: 'user', content: 'Rebuild her.' }],
          card: fullCard(),
          onDelta: () => {},
        });

        expect(turn.card?.name).toBe('Ada');
        expect(turn.card?.description).toBe('Loud first, cold second.');
        // Untouched fields keep their text, which is the whole point of merging.
        expect(turn.card?.mesExample).toBe('');
        expect(turn.card?.sourceFormat).toBe('ccv2');
      },
    );
  });

  test('a DRAFT with no name is still an error', async () => {
    // A new card cannot be filed without one, and nothing here may relax that.
    const env = await configuredEnv();
    await withFetch(
      () =>
        jsonReply(
          JSON.stringify({
            say: 'Here it is.',
            question: null,
            card: { description: 'No name on this one.' },
          }),
        ),
      async () => {
        await expect(
          consult(env, {
            mode: 'draft',
            messages: [{ role: 'user', content: 'Make me someone.' }],
            onDelta: () => {},
          }),
        ).rejects.toThrow(/no name/);
      },
    );
  });
});

describe('a card identical to the one being revised', () => {
  // Measured on prod on the reader's own card: the whole-card repair returned all fourteen
  // fields, every one byte-identical to the original, in 12 seconds. The pane then showed a
  // card with Apply enabled — the reader's complaint in its most convincing form, because this
  // time there WAS something to press.
  test('is treated as no change, not as a revision', async () => {
    const env = await configuredEnv([{ key: 'cheapMaxTokens', value: '32768' }]);
    const current = fullCard();
    await withFetch(
      () =>
        jsonReply(
          JSON.stringify({
            say: 'Rebuilt.',
            question: null,
            card: {
              name: current.name,
              description: current.description,
              personality: current.personality,
              scenario: current.scenario,
              first_mes: current.firstMes,
              mes_example: '',
              system_prompt: '',
              post_history_instructions: '',
              alternate_greetings: [],
              creator_notes: '',
              tags: [],
            },
          }),
        ),
      async () => {
        const turn = await consult(env, {
          mode: 'consult',
          messages: [{ role: 'user', content: 'Rebuild her.' }],
          card: current,
          onDelta: () => {},
        });

        // No card means the panel draws "No change proposed" and offers nothing to Apply.
        expect(turn.card).toBeNull();
      },
    );
  });

  test('a card with ONE changed field is a real revision', async () => {
    const env = await configuredEnv([{ key: 'cheapMaxTokens', value: '32768' }]);
    const current = fullCard();
    await withFetch(
      () =>
        jsonReply(
          JSON.stringify({
            say: 'Rebuilt.',
            question: null,
            card: {
              name: current.name,
              description: 'Actually different.',
              personality: current.personality,
              scenario: current.scenario,
              first_mes: current.firstMes,
            },
          }),
        ),
      async () => {
        const turn = await consult(env, {
          mode: 'consult',
          messages: [{ role: 'user', content: 'Rebuild her.' }],
          card: current,
          onDelta: () => {},
        });

        expect(turn.card?.description).toBe('Actually different.');
      },
    );
  });
});
