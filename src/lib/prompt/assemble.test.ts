import { describe, expect, test } from 'bun:test';
import { countChatTokens } from '../tokenizer';
import { assemble } from './assemble';
import type { AssembleInput } from './input';
import { stableStringify } from './stable';

/** Tests use the exact tokenizer; the Worker injects a cheap estimator instead. */
const build = (input: AssembleInput) => assemble(input, countChatTokens);

const u1 = { role: 'user' as const, content: 'Hello there.' };
const a1 = { role: 'assistant' as const, content: 'Hello. I am Ada.' };
const u2 = { role: 'user' as const, content: 'Where are we?' };

const base: AssembleInput = {
  systemPrompt: 'You are a roleplay narrator.',
  character: {
    name: 'Ada',
    description: 'A cartographer.',
    personality: 'Dry.',
    scenario: 'A rain-soaked tavern.',
    mesExample: '<START>\n{{user}}: hi\n{{char}}: hello',
  },
  persona: { name: 'Ivan', description: 'A traveler.' },
  lorebook: [
    { id: 'b', content: 'Lore B' },
    { id: 'a', content: 'Lore A' },
  ],
  history: [],
  tail: { userMessage: 'x' },
};

describe('assemble', () => {
  test('emits head, body, tail in the fixed order', () => {
    const out = build({ ...base, history: [u1], tail: { userMessage: 'x' } });
    expect(out.messages.map((m) => m.role)).toEqual([
      'system', // systemPrompt
      'system', // character
      'system', // mesExample
      'system', // persona
      'system', // lorebook a
      'system', // lorebook b
      'user', // history u1
      'user', // tail userMessage
    ]);
    expect(out.messages[4].content).toBe('Lore A');
    expect(out.messages[5].content).toBe('Lore B');
    expect(out.tailStart).toBe(7);
  });

  test('prefix is stable across turns when only history and tail change', () => {
    const a = build({ ...base, history: [u1], tail: { userMessage: 'x', memoryBlock: 'M1' } });
    const b = build({
      ...base,
      history: [u1, a1, u2],
      tail: { userMessage: 'y', memoryBlock: 'M2' },
    });

    const aPrefix = a.messages.slice(0, a.tailStart);
    const bPrefix = b.messages.slice(0, b.tailStart);
    for (let i = 0; i < aPrefix.length; i++) {
      expect(bPrefix[i]).toEqual(aPrefix[i]);
    }
  });

  test('prefixHash is unchanged when only the tail changes', () => {
    const a = build({ ...base, history: [u1], tail: { userMessage: 'x', memoryBlock: 'M1' } });
    const b = build({ ...base, history: [u1], tail: { userMessage: 'z', memoryBlock: 'M2' } });
    expect(b.prefixHash).toBe(a.prefixHash);
  });

  test('a timestamp in the system prompt changes prefixHash — the meter can detect the anti-pattern', () => {
    const a = build({
      ...base,
      systemPrompt: `Current time: ${Date.now()}`,
      history: [u1],
      tail: { userMessage: 'x' },
    });
    const b = build({
      ...base,
      systemPrompt: `Current time: ${Date.now() + 1}`,
      history: [u1],
      tail: { userMessage: 'x' },
    });
    expect(b.prefixHash).not.toBe(a.prefixHash);
  });

  test('lorebook order does not depend on input order', () => {
    const reversed = build({
      ...base,
      lorebook: [...base.lorebook].reverse(),
      history: [u1],
      tail: { userMessage: 'x' },
    });
    const normal = build({ ...base, history: [u1], tail: { userMessage: 'x' } });
    expect(reversed.prefixHash).toBe(normal.prefixHash);
  });

  test('absent persona and empty segments are omitted', () => {
    const out = build({
      ...base,
      persona: null,
      character: { name: 'Ada', description: '', personality: '', scenario: '', mesExample: '' },
      lorebook: [],
      history: [],
      tail: { userMessage: 'x' },
    });
    expect(out.messages.map((m) => m.content)).toEqual(['You are a roleplay narrator.', 'Name: Ada', 'x']);
    expect(out.tailStart).toBe(2);
  });
});

describe('stableStringify', () => {
  test('sorts keys recursively', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test('is insensitive to construction order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  test('preserves array order', () => {
    expect(stableStringify([2, 1])).toBe('[2,1]');
  });
});

/**
 * A turn is not always "answer the reader". `continue` has no user text at all — the
 * last thing in the conversation is the assistant turn being carried forward — and
 * `impersonate` asks for the reader's own next line. Both used to send an empty user
 * message, which some providers reject outright and others read as a blank prompt.
 */
describe('assemble: mode instructions and empty tails', () => {
  test('omits the user message when there is none, rather than pushing it empty', () => {
    const out = build({ ...base, history: [u1, a1], tail: { userMessage: '' } });
    expect(out.messages.some((m) => m.role === 'user' && m.content === '')).toBe(false);
    // The history's own user turn is still there; only the tail's empty one is gone.
    expect(out.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  test('places the mode instruction after the author note and before the user message', () => {
    const out = build({
      ...base,
      history: [u1],
      tail: { authorsNote: 'NOTE', instruction: 'INSTRUCTION', userMessage: 'hello' },
    });
    const contents = out.messages.map((m) => m.content);
    expect(contents.indexOf('INSTRUCTION')).toBe(contents.indexOf('NOTE') + 1);
    expect(contents.indexOf('hello')).toBe(contents.indexOf('INSTRUCTION') + 1);
  });

  test('a turn with no user message keeps the instruction in the tail', () => {
    // The `continue` shape: instruction present, user text absent. The instruction must
    // survive on its own or the model has nothing telling it what was asked for.
    const out = build({ ...base, history: [u1, a1], tail: { instruction: 'INSTRUCTION', userMessage: '' } });
    expect(out.messages[out.messages.length - 1].content).toBe('INSTRUCTION');
  });
});
