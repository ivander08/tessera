import { describe, expect, test } from 'bun:test';
import { decodeConsultChoice, encodeConsultChoice, resolveStoredChoice } from './consultChoice';

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

describe('a stored choice saved before providers were named', () => {
  const groups = [
    { provider: 'kenari', ids: ['glm-5-3-flash', 'deepseek-v4-1-flash'] },
    { provider: 'opencode-go', ids: ['glm-5.3-flash', 'mimo-v2.6-flash'] },
  ];

  test('upgrades a bare id the preferred provider carries', () => {
    expect(resolveStoredChoice('glm-5.3-flash', groups, 'opencode-go')).toBe(
      'opencode-go|glm-5.3-flash',
    );
  });

  test('moves a bare id to the gateway that actually has it', () => {
    // The reader's bug: a Kenari id left over while the preset names opencode-go.
    expect(resolveStoredChoice('glm-5-3-flash', groups, 'opencode-go')).toBe(
      'kenari|glm-5-3-flash',
    );
  });

  test('drops an id no gateway carries', () => {
    expect(resolveStoredChoice('deleted-model-9', groups, 'opencode-go')).toBeNull();
  });

  test('leaves a qualified value and an absent value alone', () => {
    expect(resolveStoredChoice('kenari|glm-5-3-flash', groups, 'opencode-go')).toBe(
      'kenari|glm-5-3-flash',
    );
    expect(resolveStoredChoice(null, groups, 'opencode-go')).toBeNull();
  });
});
