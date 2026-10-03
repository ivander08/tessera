import { describe, expect, test } from 'bun:test';
import { chatConsultContext, parseChatConsultTurn } from './chatConsult';

/**
 * The chat consultant.
 *
 * Two things are worth asserting. The reply parser, because a model that ignores the
 * envelope is normal here and the reader must still get its words. And the assembled
 * context, because the load-bearing claim of this feature is that the advice is about the
 * scene that exists — six different tables feed it, and a block silently reading the wrong
 * one is invisible in every other test.
 */

describe('parseChatConsultTurn', () => {
  test('maps a well-formed envelope', () => {
    const turn = parseChatConsultTurn(
      JSON.stringify({
        say: 'She is testing you.',
        question: { text: 'How direct?', options: ['Bluntly', 'Gently'], recommended: 1 },
        options: [],
        recommended: -1,
      }),
    );

    expect(turn.say).toBe('She is testing you.');
    expect(turn.question).toEqual({
      text: 'How direct?',
      options: ['Bluntly', 'Gently'],
      recommended: 1,
    });
  });

  test('a bare prose reply is the say field', () => {
    // Measured behaviour on the cheap model: it answers the envelope most turns and ignores
    // it on others. The words are the answer either way.
    const turn = parseChatConsultTurn('Push back. She is waiting to see if you will.');
    expect(turn.say).toBe('Push back. She is waiting to see if you will.');
    expect(turn.question).toBeNull();
  });

  test('an envelope appended after prose is recovered, not shown as raw JSON', () => {
    // The measured failure this guards: asked for three ways to reply, the model wrote a
    // paragraph and then the envelope. A bare `JSON.parse` fails on that, and the fallback
    // then handed the reader the paragraph WITH the raw envelope still in it.
    const reply = [
      'Here are three lines you can send.',
      '',
      '{"say": "Ask him like he is one of them.", "question": null, "options": [], "recommended": -1}',
    ].join('\n');

    const turn = parseChatConsultTurn(reply);
    expect(turn.say).toBe('Ask him like he is one of them.');
    expect(turn.say).not.toContain('"say"');
    expect(turn.question).toBeNull();
  });

  test('a JSON string reply is the say field', () => {
    const turn = parseChatConsultTurn(JSON.stringify('Say nothing and let her fill the silence.'));
    expect(turn.say).toBe('Say nothing and let her fill the silence.');
    expect(turn.question).toBeNull();
  });

  test('a question with no options collapses to null', () => {
    const turn = parseChatConsultTurn(
      JSON.stringify({ say: 'Advice.', question: { text: 'Which?', options: [], recommended: 0 } }),
    );
    expect(turn.say).toBe('Advice.');
    expect(turn.question).toBeNull();
  });

  test('an out-of-range recommendation keeps the options and clears the pick', () => {
    // The options are the valuable part and the recommendation is a nicety, so a reply that
    // offers two usable lines and points nowhere keeps both. Clamping to the first would put
    // a "best" badge on a line the consultant never chose.
    const turn = parseChatConsultTurn(
      JSON.stringify({
        say: 'Advice.',
        question: { text: 'Which?', options: ['One', 'Two'], recommended: 7 },
      }),
    );
    expect(turn.question).toEqual({ text: 'Which?', options: ['One', 'Two'], recommended: -1 });
  });

  test('the contract\'s own -1 keeps every option', () => {
    const turn = parseChatConsultTurn(
      JSON.stringify({
        say: 'Advice.',
        question: { text: 'Which?', options: ['One', 'Two'], recommended: -1 },
      }),
    );
    expect(turn.question?.options).toEqual(['One', 'Two']);
    expect(turn.question?.recommended).toBe(-1);
  });

  test('an empty reply throws', () => {
    expect(() => parseChatConsultTurn('   ')).toThrow('nothing usable');
  });

  test('an envelope with no say throws', () => {
    expect(() => parseChatConsultTurn(JSON.stringify({ options: [] }))).toThrow('nothing usable');
  });
});

/**
 * A stub `env.DB` that answers each query the assembly makes, keyed on a fragment of its
 * SQL. The assembly reads six tables through five modules, so the stub answers by shape
 * rather than by call order — order would break the moment two of them are reordered.
 */
function makeEnv(rows: {
  chat: Record<string, unknown>;
  character: Record<string, unknown>;
  persona: Record<string, unknown>;
  state: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
}): Env {
  return {
    DB: {
      prepare: (sql: string) => {
        const statement = {
          bind: () => statement,
          first: async () => {
            if (sql.includes('FROM chats')) return rows.chat;
            if (sql.includes('FROM characters')) return rows.character;
            if (sql.includes('FROM personas')) return rows.persona;
            if (sql.includes('FROM state')) return rows.state;
            return null;
          },
          all: async () => {
            // The recursive path walk is the only query that returns transcript rows.
            if (sql.includes('RECURSIVE')) return { results: rows.messages };
            return { results: [] };
          },
          run: async () => ({}),
        };
        return statement;
      },
    },
  } as unknown as Env;
}

const CHAT = {
  id: 'chat-1',
  character_id: 'char-1',
  persona_id: 'persona-1',
  title: null,
  preset_id: null,
  window_start_seq: 0,
  session_id: 's',
  last_prefix_hash: null,
  last_prefix_head: null,
  created_at: 0,
  updated_at: 0,
};

const CHARACTER = {
  id: 'char-1',
  name: 'Ada',
  avatar: null,
  card_json: JSON.stringify({
    name: 'Ada',
    description: 'A cartographer who refuses to admit the maps are wrong.',
    personality: 'Wry.',
    scenario: 'A rainy night in the archive.',
    mesExample: '',
  }),
  source_format: 'ccv2',
  tokens: null,
  created_at: 0,
};

const PERSONA = {
  id: 'persona-1',
  name: 'Rook',
  description: 'A patient archivist.',
  avatar: null,
  created_at: 0,
};

const STATE = {
  json: JSON.stringify({ location: 'the map room', time: 'late evening', present: ['Ada'] }),
};

function message(seq: number, role: string, content: string): Record<string, unknown> {
  return {
    seq,
    id: `m${seq}`,
    parent_id: seq === 1 ? null : `m${seq - 1}`,
    role,
    content,
    content_tokens: null,
    prompt_tokens: null,
    completion_tokens: null,
    cached_tokens: null,
    cost_usd: null,
    active: 1,
    speaker: null,
    state_json: null,
    deleted: 0,
    created_at: 0,
  };
}

describe('chatConsultContext', () => {
  test('carries the character, the persona, the state location and the last line', async () => {
    const env = makeEnv({
      chat: CHAT,
      character: CHARACTER,
      persona: PERSONA,
      state: STATE,
      messages: [message(1, 'user', 'Where am I?'), message(2, 'assistant', 'Still in the archive.')],
    });

    const { system, blocks } = await chatConsultContext(env, 'chat-1');
    const context = blocks.join('\n');

    expect(context).toContain('Ada');
    expect(context).toContain('Rook');
    expect(context).toContain('the map room');
    expect(context).toContain('Still in the archive.');

    // The last line is the newest, and the reader's own row carries the persona's name — the
    // narrator's own prefix rule, which the consultant has to share or it reads a different
    // scene from the one being written.
    expect(context).toContain('Rook: Where am I?');
    expect(context).toContain('Ada: Still in the archive.');

    // And the prompt is told what it was given, so it does not ask for what it already has.
    expect(system).toContain('the world state');
    expect(system).toContain('NEVER include a "card" key');
  });

  test('a chat with no persona omits the persona block', async () => {
    const env = makeEnv({
      chat: { ...CHAT, persona_id: null },
      character: CHARACTER,
      persona: PERSONA,
      state: STATE,
      messages: [message(1, 'user', 'Hello.')],
    });

    const { blocks } = await chatConsultContext(env, 'chat-1');
    expect(blocks.join('\n')).not.toContain('Rook');
    // Without a persona the reader's row falls back to the same label the narrator uses.
    expect(blocks.join('\n')).toContain('User: Hello.');
  });

  test('an unknown chat throws rather than sending an empty scene', async () => {
    const env = makeEnv({
      chat: undefined as unknown as Record<string, unknown>,
      character: CHARACTER,
      persona: PERSONA,
      state: STATE,
      messages: [],
    });

    await expect(chatConsultContext(env, 'missing')).rejects.toThrow('chat not found');
  });
});
