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

describe('post-history instruction precedence', () => {
  /**
   * CCv2/v3: the card's `post_history_instructions` MUST replace the user's global
   * setting, and `{{original}}` MUST be supported inside it. Getting this backwards
   * silently discards a card author's final directive — which is the field's whole
   * purpose, since it is sent after the user message and carries the most weight.
   */
  const applyOriginal = (cardValue: string, userValue: string): string => {
    if (cardValue.length === 0) return userValue;
    if (!cardValue.includes('{{original}}')) return cardValue;
    return cardValue.replaceAll('{{original}}', userValue);
  };

  test('the card value wins when it does not mention {{original}}', () => {
    expect(applyOriginal('Never speak for the user.', 'My global jailbreak')).toBe(
      'Never speak for the user.',
    );
  });

  test('the global value is used when the card says nothing', () => {
    expect(applyOriginal('', 'My global jailbreak')).toBe('My global jailbreak');
  });

  test('{{original}} expands to the global value, so a card can extend it', () => {
    expect(applyOriginal('Write in the style of Flannery O\\u2019Connor. {{original}}', 'Stay in character.')).toBe(
      'Write in the style of Flannery O\\u2019Connor. Stay in character.',
    );
  });

  test('expands every occurrence, not just the first', () => {
    expect(applyOriginal('{{original}} and again {{original}}', 'X')).toBe('X and again X');
  });
});
