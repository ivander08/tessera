import { describe, expect, test } from 'bun:test';
import { assemble } from './assemble';
import { countChatTokens } from '../tokenizer';
import type { AssembleInput } from './input';

const base: AssembleInput = {
  systemPrompt: 'You are a narrator.',
  character: {
    name: 'Ada',
    description: 'A cartographer.',
    personality: 'Dry.',
    scenario: 'A tavern.',
    mesExample: '',
  },
  persona: null,
  lorebook: [],
  history: [{ role: 'user', content: 'Hello.' }],
  tail: { userMessage: 'Where are we?' },
};

describe('assistant prefill', () => {
  test('a trailing assistant message does not disturb the cached prefix', () => {
    const plain = assemble(base, countChatTokens);
    const prefilled = assemble(base, countChatTokens);

    // This is what the prompt builder does for a preset with a prefill: push an assistant
    // turn on the end. `tailStart` must not move, or the prefill would be inside the
    // cacheable prefix and every turn would rewrite it.
    prefilled.messages.push({ role: 'assistant', content: '*She looks up.*' });

    expect(prefilled.tailStart).toBe(plain.tailStart);
    expect(prefilled.prefixHash).toBe(plain.prefixHash);
    expect(prefilled.messages[prefilled.messages.length - 1].role).toBe('assistant');
  });
});
