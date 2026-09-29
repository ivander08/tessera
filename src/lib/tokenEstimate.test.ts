import { describe, expect, test } from 'bun:test';
import { countTokens } from './tokenizer';
import { applyCalibration, estimateChatTokens, estimateTokens } from './tokenEstimate';

/**
 * The estimator's whole reason for existing is that the Worker cannot afford the real
 * vocabulary. These tests pin the accuracy band so a future "simplification" cannot
 * quietly make it much worse, and pin the boundaries that differ from the tokenizer.
 */
const ENGLISH = [
  `*Ada dips her pen, not looking up.* The rain has made the roads unreadable, and the ink on my map has bled a little in the damp.`,
  'Say hello in exactly five words.',
  `"Where are you going?" she asked. "Nowhere," I said.`,
  `A cartographer with ink-stained fingers. Dry, precise, patient.`,
  `You are a skilled collaborative fiction writer. Write in the present tense, in prose, staying in character.`,
];

describe('estimateTokens', () => {
  test('returns zero for empty text and one for any non-empty text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('.')).toBe(1);
  });

  test('stays within 25% of the real tokenizer on English prose', () => {
    for (const text of ENGLISH) {
      const exact = countTokens(text);
      const estimate = estimateTokens(text);
      const error = Math.abs(exact - estimate) / exact;
      expect(error).toBeLessThan(0.25);
    }
  });

  test('scales monotonically with length', () => {
    const short = estimateTokens('A short line.');
    const long = estimateTokens('A short line. '.repeat(20));
    expect(long).toBeGreaterThan(short);
  });

  test('charges CJK characters far more than Latin ones of the same count', () => {
    const latin = estimateTokens('abcdefghij');
    const cjk = estimateTokens('日本語のテキストです');
    expect(cjk).toBeGreaterThan(latin);
  });

  test('is deterministic', () => {
    const text = 'The tavern was called The Compass Rose.';
    expect(estimateTokens(text)).toBe(estimateTokens(text));
  });
});

describe('estimateChatTokens', () => {
  test('adds per-message overhead and reply priming', () => {
    const messages = [{ role: 'user', content: 'Hi there.' }];
    const contentOnly = estimateTokens('user') + estimateTokens('Hi there.');
    expect(estimateChatTokens(messages)).toBe(contentOnly + 4 + 2);
  });

  test('an empty conversation still costs the priming tokens', () => {
    expect(estimateChatTokens([])).toBe(2);
  });
});

describe('applyCalibration', () => {
  test('scales the estimate and never returns zero', () => {
    expect(applyCalibration(100, 0.64)).toBe(64);
    expect(applyCalibration(1, 0.01)).toBe(1);
  });
});
