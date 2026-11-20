import { describe, expect, test } from 'bun:test';
import { decodeConsultChoice, encodeConsultChoice } from './consultChoice';

describe('consultant picker values', () => {
  test('round-trips a provider-qualified choice', () => {
    const value = encodeConsultChoice({ provider: 'opencode-go', model: 'hy4-flash-free' });
    expect(value).toBe('opencode-go|hy4-flash-free');
    expect(decodeConsultChoice(value)).toEqual({
      provider: 'opencode-go',
      model: 'hy4-flash-free',
    });
  });

  test('keeps a slash inside the model id', () => {
    // OpenRouter ids are `author/model`; only the FIRST separator is the provider's.
    expect(decodeConsultChoice('openrouter|anthropic/claude-sonnet-5')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-5',
    });
  });

  test('treats a bare model id as the configured provider', () => {
    // Saved before the picker knew about gateways; it must keep working unchanged.
    expect(decodeConsultChoice('deepseek-v4-flash')).toEqual({
      provider: null,
      model: 'deepseek-v4-flash',
    });
  });
});
